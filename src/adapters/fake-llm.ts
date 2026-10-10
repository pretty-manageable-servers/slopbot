import type { ModelEvent, Prompt } from "../domain.js";
import type { LLM } from "../ports.js";

export class FakeLLM implements LLM {
  readonly prompts: Prompt[] = [];

  async *stream(prompt: Prompt): AsyncIterable<ModelEvent> {
    this.prompts.push(prompt);
    yield { kind: "reasoning", payload: { delta: "local simulation", provider: "fake" } };
    yield { kind: "text", payload: { text: `Local reply: ${prompt.inputs.at(-1)?.content ?? ""}` } };
  }
}
