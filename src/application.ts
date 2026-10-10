import type { HarnessJournal } from "./harness-state.js";
import { parseMessage, type Reply } from "./domain.js";
import type { LLM, Store } from "./ports.js";
import type { Recall } from "./memory.js";
import type { ProfileStore } from "./profiles.js";
import type { ToolExecutor } from "./tools.js";
import type { TokenCounter } from "./context.js";
import { AgentRunner } from "./agent-runner.js";
export type { Policy } from "./agent-runner.js";
import type { Policy } from "./agent-runner.js";

export class Application {
  private readonly taskTails = new Map<string, Promise<void>>();
  private readonly runner: AgentRunner;
  constructor(private readonly store: Store, llm: LLM, policy: Policy, recall?: Recall,
    services: { profiles?: ProfileStore; tools?: ToolExecutor; counter?: TokenCounter; harness?: HarnessJournal } = {}) {
    this.runner = new AgentRunner(store, llm, policy, recall, services);
  }
  interrupt(server: string, messageId: string): Promise<boolean> { return this.runner.interrupt(server, messageId); }
  setRecentMessages(count: number): void { this.runner.setRecentMessages(count); }
  allowChannel(server: string, channel: string): void { this.runner.allowChannel(server, channel); }
  disallowChannel(server: string, channel: string): void { this.runner.disallowChannel(server, channel); }
  async handle(input: unknown, alreadyIngested = false): Promise<Reply | undefined> {
    const message = parseMessage(input);
    if (!this.runner.accepts(message)) return undefined;
    if (message.taskId && message.addressed !== false) {
      const key = JSON.stringify([message.server, message.channel, message.taskId]);
      const previous = this.taskTails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const tail = new Promise<void>(resolve => { release = resolve; });
      this.taskTails.set(key, tail);
      const accepted = (alreadyIngested ? Promise.resolve(true) : this.store.ingest(message)).then(value => ({ value }), error => ({ error }));
      await previous;
      try {
        const result = await accepted;
        if ("error" in result) throw result.error;
        if (!result.value) return undefined;
        return await this.runner.run(message, key);
      } finally { release(); if (this.taskTails.get(key) === tail) this.taskTails.delete(key); }
    }
    if ((!alreadyIngested && !await this.store.ingest(message)) || message.addressed === false) return undefined;
    return this.runner.run(message);
  }

}
