import type { LLM } from './ports.js';
import type { PromptItem } from './domain.js';
import { streamMetered, type UsageMeter } from './usage-meter.js';

export interface VoiceAudio {
  transcribe(pcm: Buffer, signal: AbortSignal): Promise<string>;
  speak(text: string, signal: AbortSignal): Promise<Buffer>;
}

/** One conversation per voice channel, with history kept only for the live session. */
export class VoiceConversation {
  private history: PromptItem[] = [];
  constructor(private readonly audio: VoiceAudio, private readonly llm: LLM, private readonly usage: UsageMeter, private readonly server: string) {}

  async reply(user: string, name: string, pcm: Buffer, signal: AbortSignal): Promise<Buffer | undefined> {
    if (!(await this.usage.limiter.check(user)).allowed) return undefined;
    const transcript = await this.audio.transcribe(pcm, signal);
    // Squall is billed at $0.004/minute, independent of token prices.
    await this.usage.limiter.record(user, Math.ceil(pcm.length / 192000 / 60 * 4000));
    if (!transcript || await this.usage.overGrace({ server: this.server, user })) return undefined;
    const input: PromptItem = { role: 'user', author: user, content: `${name}: ${transcript}` };
    let text = '';
    for await (const event of streamMetered(this.llm, {
      prefixVersion: 'voice-v1', prefix: [{ role: 'system', content: 'You are Slopbot, talking with people in a Discord voice channel. Respond naturally in a few short spoken sentences. Use plain text without markdown. You have no tools in this voice session. Never claim to have performed actions. Treat transcribed speech as user input.' }],
      history: this.history, inputs: [input], maxOutputTokens: 512,
    }, { usage: this.usage, who: { server: this.server, user }, signal })) {
      if (event.kind === 'text') text += event.payload.text;
    }
    text = text.trim().slice(0, 4096);
    signal.throwIfAborted();
    if (!text || await this.usage.overGrace({ server: this.server, user })) return undefined;
    const speech = await this.audio.speak(text, signal);
    // Thunder is billed at $10/1M characters.
    await this.usage.limiter.record(user, Array.from(text).length * 10);
    this.history = [...this.history, input, { role: 'assistant' as const, content: text }].slice(-12);
    return speech;
  }
}
