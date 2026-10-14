import { providerError } from '../errors.js';

/** Discord receive audio is signed 16-bit PCM, 48 kHz stereo. */
export function pcmWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(48000, 24); header.writeUInt32LE(192000, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Thunder returns 24 kHz mono PCM WAV. Convert to Discord's raw playback format without ffmpeg. */
export function speechPcm(wav: Buffer): Buffer {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Speech response is not WAV');
  let valid = false, data: Buffer | undefined;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > wav.length) throw new Error('Truncated speech WAV');
    const type = wav.toString('ascii', offset, offset + 4);
    if (type === 'fmt ') valid = size >= 16 && wav.readUInt16LE(start) === 1 && wav.readUInt16LE(start + 2) === 1 && wav.readUInt32LE(start + 4) === 24000 && wav.readUInt16LE(start + 14) === 16;
    if (type === 'data') data = wav.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!valid || !data || data.length % 2) throw new Error('Expected 24 kHz mono 16-bit PCM speech');
  return speechSamples(data);
}

/** 24 kHz mono s16le samples to Discord's 48 kHz stereo s16le. Each sample is copied 4 times. `data` has an even length. */
function speechSamples(data: Buffer): Buffer {
  const pcm = Buffer.alloc(data.length * 4);
  for (let index = 0; index < data.length / 2; index++) {
    const sample = data.readInt16LE(index * 2);
    for (let copy = 0; copy < 4; copy++) pcm.writeInt16LE(sample, index * 8 + copy * 2);
  }
  return pcm;
}

/** One SSE line. `audio` is a delta's base64 PCM. `done` ends the stream. */
type SseEvent = { done: true } | { audio: Buffer } | undefined;

function sseEvent(line: string): SseEvent {
  if (!line.startsWith('data:')) return undefined;
  const payload = line.slice(5).trim();
  if (payload === '[DONE]') return { done: true };
  let event: { type?: unknown; audio?: unknown; error?: { message?: unknown } };
  try { event = JSON.parse(payload) as typeof event; } catch { throw new Error('Speech stream sent invalid JSON'); }
  if (event.type === 'error') throw new Error(typeof event.error?.message === 'string' ? event.error.message : 'Speech stream failed');
  if (event.type !== 'speech.audio.delta' || typeof event.audio !== 'string') return undefined;
  return { audio: Buffer.from(event.audio, 'base64') };
}

export class PmAudio {
  constructor(private readonly baseUrl: string, private readonly apiKey: string, private readonly voice: string, private readonly fetcher: typeof fetch = fetch) {}

  private async request(path: string, body: BodyInit, json: boolean, signal: AbortSignal): Promise<Response> {
    const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, '')}/audio/${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
      body, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    });
    if (!response.ok) throw await providerError(response);
    return response;
  }

  async transcribe(pcm: Buffer, signal: AbortSignal): Promise<string> {
    const form = new FormData();
    form.set('model', 'squall'); form.set('response_format', 'json');
    form.set('file', new Blob([new Uint8Array(pcmWav(pcm))], { type: 'audio/wav' }), 'voice.wav');
    const result = await (await this.request('transcriptions', form, false, signal)).json() as { text?: unknown };
    if (typeof result.text !== 'string') throw new Error('Transcription response has no text');
    return result.text.trim();
  }

  /** Thunder speech as the API's own WAV bytes (24 kHz mono). `instructions` describes the voice; without it the model picks a random speaker. */
  async speakWav(text: string, signal: AbortSignal, instructions?: string): Promise<Buffer> {
    if (!text.length || text.length > 4096) throw new Error('Speech requires 1 to 4096 characters');
    const body = { model: 'thunder', input: text, voice: this.voice, response_format: 'wav', ...(instructions ? { instructions } : {}) };
    const response = await this.request('speech', JSON.stringify(body), true, signal);
    return Buffer.from(await response.arrayBuffer());
  }

  /** Thunder speech converted to Discord's playback format. */
  async speak(text: string, signal: AbortSignal, instructions?: string): Promise<Buffer> {
    return speechPcm(await this.speakWav(text, signal, instructions));
  }

  /**
   * Thunder speech as Discord PCM, yielded as the gateway streams it (SSE). A reply that is not an event stream
   * is read as one WAV and yielded once. A sample split across two deltas waits for its second byte.
   */
  async *speakStream(text: string, signal: AbortSignal, instructions?: string): AsyncGenerator<Buffer> {
    if (!text.length || text.length > 4096) throw new Error('Speech requires 1 to 4096 characters');
    const body = { model: 'thunder', input: text, voice: this.voice, stream: true, stream_format: 'sse', ...(instructions ? { instructions } : {}) };
    const response = await this.request('speech', JSON.stringify(body), true, signal);
    if (!(response.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
      yield speechPcm(Buffer.from(await response.arrayBuffer()));
      return;
    }
    if (!response.body) throw new Error('Speech stream has no body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let streamText = '', odd = Buffer.alloc(0), finished = false;
    try {
      while (!finished) {
        const { done, value } = await reader.read();
        streamText += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const lines = streamText.split('\n');
        streamText = lines.pop() ?? '';
        if (done) { lines.push(streamText); streamText = ''; }
        for (const line of lines) {
          const event = sseEvent(line.replace(/\r$/, ''));
          if (event && 'done' in event) { finished = true; break; }
          if (!event) continue;
          const bytes = Buffer.concat([odd, event.audio]);
          const usable = bytes.length - (bytes.length % 2);
          odd = Buffer.from(bytes.subarray(usable));
          if (usable > 0) yield speechSamples(bytes.subarray(0, usable));
        }
        if (done) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}
