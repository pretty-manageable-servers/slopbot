import { errorSummary, logError } from "./errors.js";
import { participationPrompt, reactionEmoji } from "./participation-prompts.js";
import { randomUUID } from "node:crypto";
import { EventJournal } from "./event-journal.js";
import { requestTimings } from "./request-timing.js";
import type { Message, Prompt } from "./domain.js";
import type { LLM, Store } from "./ports.js";

export interface ParticipationDecision {
  emoji?: string | undefined;
  respond: boolean;
  addressed: boolean;
  reason: string;
}

export interface Classifier {
  classify(message: Message, context: readonly Message[]): Promise<ParticipationDecision>;
}

export class LLMClassifier implements Classifier {
  constructor(private readonly llm: LLM, private readonly store: Store) {}

  async classify(message: Message, context: readonly Message[]): Promise<ParticipationDecision> {
    const prompt: Prompt = {
      prefixVersion: "participation-v2",
      prefix: [{ role: "system", content: participationPrompt }],
      history: [], inputs: [{ role: "user", content: JSON.stringify({ recent: context, current: message }) }],
    };
    const runId = randomUUID();
    await this.store.startRun(runId, message, prompt);
    await this.store.recordSources(runId, message.server, [message.id, ...context.map(item => item.id)]);
    const text: string[] = [];
    const journal = new EventJournal(this.store, runId, message, "participation");
    try {
      for await (const event of this.llm.stream(prompt)) {
        await journal.append(event);
        if (event.kind === "text") text.push(event.payload.text);
      }
      await journal.close();
      const output = text.join("").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      const value = JSON.parse(output) as Record<string, unknown>;
      if (typeof value.respond !== "boolean" || typeof value.addressed !== "boolean" || typeof value.reason !== "string") {
        throw new Error("Invalid classifier output");
      }
      await this.store.complete(runId, undefined, [], output);
      return { ...(reactionEmoji(value.emoji) ? { emoji: reactionEmoji(value.emoji) } : {}), respond: value.respond, addressed: value.addressed, reason: value.reason.slice(0, 200) };
    } catch (error) {
      try { await journal.close(); } finally { await this.store.fail(runId, errorSummary(error)); }
      throw error;
    }
  }
}

export interface ParticipationOptions {
  reactionFrequency?: number;
  enabled: boolean;
  contextMessages: number;
  cooldownMs: number;
  maxUnsolicitedPerHour: number;
}

export class ParticipationGate {
  private readonly channelTails = new Map<string, Promise<void>>();
  private readonly replies = new Map<string, number[]>();
  readonly diagnostics = new Map<string, string>();

  constructor(private readonly classifier: Classifier, readonly options: ParticipationOptions, private readonly random: () => number = Math.random) {}

  async decide(message: Message, context: readonly Message[]): Promise<ParticipationDecision> {
    const key = JSON.stringify([message.server, message.channel]);
    const previous = this.channelTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    this.channelTails.set(key, tail);
    requestTimings.start(message, "participation queue");
    await requestTimings.wait("participation queue", () => previous);
    requestTimings.end(message, "participation queue");
    try {
      if (!this.options.enabled) return this.finish(key, { respond: false, addressed: false, reason: "monitoring_disabled" });
      let decision: ParticipationDecision;
      try { decision = await requestTimings.measure(message, "decision classifier", () => this.classifier.classify(message, context)); }
      catch (error) { logError("participation_classifier_failed_staying_silent", error, { stage: "participation classification", server: message.server, channel: message.channel, messageId: message.id }, true); return this.finish(key, { respond: false, addressed: false, reason: "classifier_failed" }); }
      const emoji = reactionEmoji(decision.emoji);
      const frequency = Math.max(0, Math.min(100, this.options.reactionFrequency ?? 60));
      const allowReaction = emoji && frequency > 0 && (frequency === 100 || this.random() < frequency / 100);
      decision = { ...decision, emoji: allowReaction ? emoji : undefined };
      if (!decision.respond) return this.finish(key, { ...decision, reason: "classifier_silent" });
      if (!decision.addressed) {
        const now = Date.now();
        const recent = (this.replies.get(key) ?? []).filter(time => now - time < 3_600_000);
        if (recent.length >= this.options.maxUnsolicitedPerHour) return this.finish(key, { ...decision, respond: false, reason: "hourly_limit" });
        if (recent.length && now - recent.at(-1)! < this.options.cooldownMs) return this.finish(key, { ...decision, respond: false, reason: "cooldown" });
        this.replies.set(key, [...recent, now]);
      }
      return this.finish(key, { ...decision, reason: decision.addressed ? "name_request" : "unsolicited_allowed" });
    } finally {
      release();
      if (this.channelTails.get(key) === tail) this.channelTails.delete(key);
    }
  }

  private finish(key: string, decision: ParticipationDecision): ParticipationDecision {
    this.diagnostics.set(key, decision.reason);
    return decision;
  }
}
