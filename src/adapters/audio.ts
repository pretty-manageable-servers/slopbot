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
  const pcm = Buffer.alloc(data.length * 4);
  for (let index = 0; index < data.length / 2; index++) {
    const sample = data.readInt16LE(index * 2);
    for (let copy = 0; copy < 4; copy++) pcm.writeInt16LE(sample, index * 8 + copy * 2);
  }
  return pcm;
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
}
