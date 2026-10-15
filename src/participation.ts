import { errorSummary, logError, ProviderError } from "./errors.js";
import { participationPrompt, reactionEmoji } from "./participation-prompts.js";
import { randomUUID } from "node:crypto";
import { EventJournal } from "./event-journal.js";
import { requestTimings } from "./request-timing.js";
import type { Json, Message, Prompt } from "./domain.js";
import type { LLM, Store } from "./ports.js";
import { attribution, streamMetered, type UsageMeter } from "./usage-meter.js";
import { decisionThresholds, scoredDecision, type DecisionScores, type DecisionThresholds, type ParticipationRecord } from './participation-history.js';
import type { RecordStore } from './records.js';
import { classifierInput, type FollowupSignal } from './classifier-input.js';

export interface ParticipationDecision {
  scores?: DecisionScores;
  emoji?: string | undefined;
  respond: boolean;
  addressed: boolean;
  reason: string;
  retryable?: boolean;
}

export const transientClassifierError = (error: unknown): boolean => error instanceof ProviderError
  ? [408, 429, 500, 502, 503, 504].includes(error.status)
  : error instanceof TypeError || error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);

export interface Classifier {
  classify(message: Message, context: readonly Message[], followup?: FollowupSignal): Promise<ParticipationDecision>;
}

export class LLMClassifier implements Classifier {
  constructor(private readonly llm: LLM, private readonly store: Store, private readonly usage?: UsageMeter) {}

  async classify(message: Message, context: readonly Message[], followup?: FollowupSignal): Promise<ParticipationDecision> {
    const { state, preceding } = classifierInput(message, context, followup);
    const prompt: Prompt = {
      prefixVersion: "participation-v3",
      prefix: [{ role: "system", content: participationPrompt }],
      history: [], inputs: [{ role: "user", content: state }],
    };
    const runId = randomUUID();
    await this.store.startRun(runId, message, prompt);
    await this.store.recordSources(runId, message.server, [message.id, ...preceding.map(item => item.id)]);
    const text: string[] = [];
    const journal = new EventJournal(this.store, runId, message, "participation");
    try {
      // Every human message is classified, so each one is charged to its author.
      for await (const event of streamMetered(this.llm, prompt, { usage: this.usage, who: attribution(message) })) {
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
  thresholds?: DecisionThresholds;
  reactionFrequency?: number;
  enabled: boolean;
  contextMessages: number;
  cooldownMs: number;
  maxUnsolicitedPerHour: number;
}

export class ParticipationGate {
  private readonly channelTails = new Map<string, Promise<void>>();
  private readonly replies = new Map<string, number[]>();
  private readonly recentReplies = new Map<string, { author: string; replyId: string; at: number }>();
  readonly diagnostics = new Map<string, string>();

  constructor(private readonly classifier: Classifier, readonly options: ParticipationOptions, private readonly random: () => number = Math.random, private readonly store?: RecordStore,
    private readonly wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {}

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
      const thresholds = decisionThresholds(this.options.thresholds);
      const finish = (decision: ParticipationDecision, detail: string) => this.finish(key, decision, message, thresholds, detail);
      if (!this.options.enabled) return finish({ respond: false, addressed: false, reason: "monitoring_disabled" }, 'Monitoring is disabled.');
      let decision: ParticipationDecision;
      const recent = this.recentReplies.get(key);
      const age = recent ? Date.now() - recent.at : Infinity;
      const followup = recent && recent.author === message.author && age >= 0 && age < 30000 ? { replyId: recent.replyId, ageMs: age } : undefined;
      if (!followup) this.recentReplies.delete(key);
      const failures: string[] = [];
      try {
        for (let attempt = 0; ; attempt++) {
          try { decision = await requestTimings.measure(message, "decision classifier", () => this.classifier.classify(message, context, followup)); break; }
          catch (error) {
            failures.push(errorSummary(error));
            if (!transientClassifierError(error) || attempt === 2) throw error;
            await this.wait(250 * 2 ** attempt);
          }
        }
        await this.health(message, 'healthy', failures.length);
      } catch (error) {
        logError("participation_classifier_outage", error, { stage: "participation classification", server: message.server, channel: message.channel, messageId: message.id }, true);
        await this.health(message, 'unavailable', failures.length);
        return finish({ respond: false, addressed: false, reason: "classifier_failed", retryable: transientClassifierError(error) }, `Classifier failed after ${failures.length} attempt(s): ${failures.join('; ')}`);
      }
      const retryDetail = failures.length ? `Recovered after ${failures.length} retry attempt(s): ${failures.join('; ')}. ` : '';
      let followupDetail = '';
      if (decision.scores) {
        const boost = followup && decision.scores.addressed >= 0.3 && decision.scores.respond >= thresholds.respond ? 0.25 * (1 - followup.ageMs / 30000) : 0;
        if (boost) followupDetail = `Recent assistant reply ${followup!.replyId}: raw addressed=${decision.scores.addressed.toFixed(3)}, boost=${boost.toFixed(3)}. `;
        decision = scoredDecision({ ...decision.scores, addressed: Math.min(1, decision.scores.addressed + boost) }, thresholds);
      }
      const emoji = reactionEmoji(decision.emoji);
      const frequency = Math.max(0, Math.min(100, this.options.reactionFrequency ?? 60));
      const allowReaction = emoji && frequency > 0 && (frequency === 100 || this.random() < frequency / 100);
      decision = { ...decision, emoji: allowReaction ? emoji : undefined };
      const reaction = retryDetail + followupDetail + (emoji ? allowReaction ? 'Reaction selected.' : `Reaction skipped by frequency setting (${frequency}%).` : 'No reaction selected.');
      if (!decision.respond) return finish({ ...decision, reason: "classifier_silent" }, reaction);
      if (!decision.addressed) {
        const now = Date.now();
        const recent = (this.replies.get(key) ?? []).filter(time => now - time < 3_600_000);
        if (recent.length >= this.options.maxUnsolicitedPerHour) return finish({ ...decision, respond: false, reason: "hourly_limit" }, reaction);
        if (recent.length && now - recent.at(-1)! < this.options.cooldownMs) return finish({ ...decision, respond: false, reason: "cooldown" }, reaction);
        this.replies.set(key, [...recent, now]);
      }
      return finish({ ...decision, reason: decision.addressed ? "name_request" : "unsolicited_allowed" }, `${reaction} Reply allowed by participation; delivery is a separate step.`);
    } finally {
      release();
      if (this.channelTails.get(key) === tail) this.channelTails.delete(key);
    }
  }

  async recordBypass(message: Message, reason: string): Promise<void> {
    const key = JSON.stringify([message.server, message.channel]);
    if (this.recentReplies.get(key)?.author !== message.author) this.recentReplies.delete(key);
    await this.finish(JSON.stringify([message.server, message.channel]), { respond: true, addressed: true, reason }, message, decisionThresholds(this.options.thresholds), 'Classifier bypassed. Reply delivery is a separate step.');
  }
  recordReply(request: Message, reply: Message): void {
    if (request.isBot || reply.channel !== request.channel || reply.server !== request.server) return;
    this.recentReplies.set(JSON.stringify([request.server, request.channel]), { author: request.author, replyId: reply.id, at: reply.timestamp ?? Date.now() });
  }
  async recordBlocked(message: Message, reason: string): Promise<void> {
    await this.finish(JSON.stringify([message.server, message.channel]), { respond: false, addressed: false, reason }, message, decisionThresholds(this.options.thresholds), 'Participation blocked before classification.');
  }
  async recordLimit(message: Message): Promise<void> {
    if (!this.store) return;
    try {
      const saved = await this.store.record(message.server, 'participation_decision', message.id);
      if (!saved) return;
      const record = saved.value as unknown as ParticipationRecord;
      await this.store.putRecord(message.server, 'participation_decision', message.id, { ...record, decision: { ...record.decision, respond: false, reason: 'usage_limit' }, detail: `${record.detail} Reply blocked by the user's usage limit.` } as unknown as Json, saved.revision);
    } catch (error) { logError('participation_diagnostic_save_failed', error, { server: message.server, channel: message.channel }, true); }
  }
  private async health(message: Message, status: string, retries: number): Promise<void> {
    if (!this.store) return;
    try {
      const old = await this.store.record(message.server, 'classifier_health', 'provider');
      await this.store.putRecord(message.server, 'classifier_health', 'provider', { status, retries, at: Date.now(), messageId: message.id }, old?.revision ?? 0);
    } catch (error) { logError('classifier_health_save_failed', error, { server: message.server }, true); }
  }
  private async finish(key: string, decision: ParticipationDecision, message: Message, thresholds: DecisionThresholds, detail: string): Promise<ParticipationDecision> {
    this.diagnostics.set(key, decision.reason);
    if (this.store) {
      const record: ParticipationRecord = { messageId: message.id, channel: message.channel, author: message.author, text: message.text.slice(0, 240), timestamp: message.timestamp ?? Date.now(), decision, thresholds, detail };
      try {
        const old = await this.store.record(message.server, 'participation_decision', message.id);
        const previous = old?.value as unknown as ParticipationRecord | undefined;
        if (previous?.decision.reason === 'classifier_failed') record.detail = `${previous.detail} Recovery check: ${detail}`.slice(-4000);
        await this.store.putRecord(message.server, 'participation_decision', message.id, record as unknown as Json, old?.revision ?? 0);
      }
      catch (error) { logError('participation_diagnostic_save_failed', error, { server: message.server, channel: message.channel }, true); }
    }
    return decision;
  }
}
