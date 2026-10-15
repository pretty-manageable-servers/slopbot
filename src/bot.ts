import { contextChangedError } from "./source-context.js";
import { errorReply, logError } from "./errors.js";
import { replySubject, type ProfileStore } from "./profiles.js";
import { requestTimings } from "./request-timing.js";
import { Application } from "./application.js";
import type { Message } from "./domain.js";
import type { Store } from "./ports.js";
import type { Knowledge } from "./memory.js";
import type { TaskWorker, QueueStore } from "./queue.js";
import { DEFAULT_BOT_REPLY_LIMIT, type BotReplyLimit } from "./bot-reply-limit.js";
import { ToolError, discordOnlyMessage, type ToolCall, type ToolRegistry, type ToolResult } from "./tools.js";
import type { ParticipationGate } from "./participation.js";
import { UserLimitError, limitReply } from "./user-limiter.js";
import { isPrivateChannel } from "./private-chat.js";
import { renderTranscript, saveTaskRefs, type SettingsPort } from "./transcript.js";
import { slopbotId, type ConversationEventStore } from "./run-events.js";

export interface Incoming extends Message {
  readonly botAuthor: boolean;
  readonly mentionsBot: boolean;
  readonly repliesToBot: boolean;
}

export interface ChatGateway {
  react?(message: Message, emoji: string): Promise<void>;
  reply(message: Message, text: string, deliveryId?: string, activity?: readonly import("./tool-activity.js").ToolActivity[], ui?: import("./ui/schema.js").UiDocument): Promise<readonly Message[]>;
  createTaskThread(message: Message, name: string): Promise<string>;
  typing(channel: string): () => void;
}

export interface TaskRegistry {
  registerTask(server: string, thread: string, parent: string, sourceId?: string): void | Promise<void>;
  taskForSource(server: string, sourceId: string): string | undefined | Promise<string | undefined>;
  taskThreads(server: string): { thread: string; parent: string }[];
}

export class Bot {
  private readonly tasks = new Set<string>();
  /** Voice channels with a live voice session. */
  private readonly voiceChannels = new Set<string>();
  /** Times of recent replies to other bots, per channel. Stops bot-to-bot loops. */
  private readonly botReplies = new Map<string, number[]>();
  private readonly replies = new Map<string, Promise<void>>();
  private readonly classificationRetries = new Map<string, ReturnType<typeof setTimeout>>();
  // Open private chats of this server. A chat is added when its web chat row exists, and removed when it is deleted.
  private readonly privateChats = new Set<string>();

  constructor(
    private readonly app: Application,
    private readonly store: Store,
    private readonly registry: TaskRegistry,
    private readonly gateway: ChatGateway,
    private readonly server: string,
    private channels: readonly string[],
    private readonly options: { knowledge?: Knowledge; participation?: ParticipationGate; worker?: TaskWorker; tools?: ToolRegistry; queueStore?: QueueStore; profiles?: ProfileStore; botReplyLimit?: () => BotReplyLimit; mutedUntil?: (user: string) => number | undefined; classificationRetryMs?: number } = {},
  ) {
    for (const task of registry.taskThreads(server)) {
      if (channels.includes(task.parent)) {
        this.tasks.add(task.thread);
        app.allowChannel(server, task.thread);
      }
    }
  }

  accepts(server: string, channel: string): boolean {
    return server === this.server && (this.channels.includes(channel) || this.tasks.has(channel) || this.privateChats.has(channel) || this.voiceChannels.has(channel));
  }

  /** Lets the bot answer in the text chat of a voice channel while a voice session is live there. */
  openVoiceChannel(server: string, channel: string): void {
    if (server !== this.server) return;
    this.voiceChannels.add(channel);
    this.app.allowChannel(server, channel);
  }
  closeVoiceChannel(channel: string): void {
    this.voiceChannels.delete(channel);
    if (!this.channels.includes(channel)) this.app.disallowChannel(this.server, channel);
  }

  /** Lets the bot answer in a private chat. Its messages are always addressed to the bot. */
  openPrivateChat(server: string, channel: string): void {
    if (server !== this.server || !isPrivateChannel(channel)) throw new Error("Not a private chat channel");
    this.privateChats.add(channel);
    this.app.allowChannel(server, channel);
  }

  closePrivateChat(server: string, channel: string): void {
    if (server !== this.server) return;
    this.privateChats.delete(channel);
    this.app.disallowChannel(server, channel);
  }

  /** `ingested` is true when the caller already saved the message, so it is not saved twice. */
  async receive(message: Incoming, options: { ingested?: boolean; classificationAttempt?: number } = {}): Promise<void> {
    if (!this.accepts(message.server, message.channel)) return;
    if (message.botAuthor) message = { ...message, isBot: true };
    requestTimings.begin(message);
    try { await requestTimings.withScope(message, () => this.receiveScoped(message, options.ingested === true, options.classificationAttempt ?? 0)); }
    catch (error) {
      if (!(error instanceof UserLimitError)) throw error;
      // Only a direct request gets the notice. Unsolicited replies stay silent.
      if (message.mentionsBot || message.repliesToBot || message.addressed === true || this.tasks.has(message.channel)) await this.send(message, limitReply(error.resetAt));
    }
  }
  private async receiveScoped(message: Incoming, alreadyIngested: boolean, classificationAttempt: number): Promise<void> {
    const task = this.tasks.has(message.channel);
    const privateChat = isPrivateChannel(message.channel);
    // A web reply arrives with addressed=true, so it always gets an answer and skips JEV. A private chat always does, even without that flag.
    let addressed = task && !message.botAuthor || privateChat || message.mentionsBot || message.repliesToBot || message.addressed === true;
    let ingested = alreadyIngested;
    // The Slopbot team muted this user. The message is saved but gets no reply.
    const muted = this.options.mutedUntil?.(message.author);
    if (muted !== undefined && muted > Date.now()) {
      if (!ingested) await this.store.ingest({ ...message, addressed: false });
      await this.options.participation?.recordBlocked?.(message, 'muted');
      requestTimings.finish(message);
      return;
    }
    if (addressed && !message.botAuthor) await this.options.participation?.recordBypass?.(message,
      privateChat ? 'private_chat' : task ? 'task_thread' : message.mentionsBot ? 'mention' : message.repliesToBot ? 'reply_to_bot' : 'explicit_request');
    // Another bot can mention or reply to Slopbot without end. Past the cap, its messages are saved but get no reply.
    if (addressed && message.botAuthor && !this.allowBotReply(message.channel)) {
      if (!ingested) await this.store.ingest({ ...message, addressed: false });
      requestTimings.finish(message);
      return;
    }
    if (!addressed) {
      if (!ingested && !await this.store.ingest({ ...message, addressed: false })) return;
      ingested = true;
      // Other bots' status/error commentary is evidence, not an automatic task
      // request. Explicit mentions and replies still support collaboration.
      if (message.botAuthor) { requestTimings.finish(message); return; }
      const gate = this.options.participation;
      if (!gate) return;
      const context = await requestTimings.measure(message, "participation context", () => this.store.context(message, gate.options.contextMessages));
      const decision = await requestTimings.measure(message, "participation", () => gate.decide(message, context));
      if (decision.reason === 'classifier_failed' && decision.retryable) this.retryClassification(message, classificationAttempt);
      if (decision.emoji && this.gateway.react) {
        try { await requestTimings.measure(message, "reaction", () => this.gateway.react!(message, decision.emoji!)); }
        catch (error) { logError("discord_reaction_failed", error, { stage: "Discord reaction", server: message.server, channel: message.channel, messageId: message.id }, true); }
      }
      if (!decision.respond) { requestTimings.finish(message); return; }
      addressed = decision.addressed;
    }
    const text = message.text.trim();
    if (this.options.knowledge && addressed && /^!(remember|memory|forget)(?:\s|$)/i.test(text)) {
      if (!ingested && !await this.store.ingest({ ...message, addressed: false })) return;
      const command = text.match(/^!(remember|memory|forget)(?:\s+([\s\S]*))?$/i)!;
      const kind = command[1]!.toLowerCase(), value = command[2]?.trim() ?? "";
      if (this.options.tools) {
        const name = kind === "remember" ? "memory_remember" : kind === "forget" ? "memory_forget" : "memory";
        const args = kind === "remember" ? { text: value } : kind === "forget" ? { id: value } : {};
        try {
          const result = await this.options.tools.invoke(message, name, args, `legacy:${message.server}:${message.id}`, "command");
          await this.send(message, result, undefined, `legacy:${message.id}:result`);
        } catch (error) { if (!(error instanceof ToolError)) throw error; await this.send(message, error.message); }
        return;
      }
      if (kind === "remember") {
        if (!value || value.length > 2000) { await this.send(message, "Use !remember followed by 1–2000 characters."); return; }
        const note = await this.options.knowledge.remember(message, value);
        await this.send(message, `Saved as your statement, not a group agreement. Memory ID: ${note.id}`);
      } else if (kind === "forget") {
        const forgotten = await this.options.knowledge.forget(message.server, message.channel, value, message.author);
        await this.send(message, forgotten ? "Memory forgotten." : "No active memory with that ID owned by you in this channel.");
      } else {
        const notes = await this.options.knowledge.memories(message.server, message.channel);
        await this.send(message, notes.length ? notes.slice(0, 20).map(note => `${note.id} | author ${note.author} | ${note.content}`).join("\n") : "No active saved memories in this channel.");
      }
      return;
    }
    if (!task && /^!task(?:\s|$)/i.test(text)) {
      if (privateChat) { if (!ingested && !await this.store.ingest({ ...message, addressed: false })) return; await this.send(message, discordOnlyMessage); return; }
      if (this.options.worker) { await this.options.worker.enqueue({ ...message, addressed: true }); return; }
      if (!ingested && !await this.store.ingest({ ...message, addressed: false })) return;
      const goal = text.replace(/^!task\s*/i, "");
      if (!goal) { await this.send(message, "Use @Slopbot !task followed by the task goal."); return; }
      await this.startTask(message, goal);
      return;
    }
    // A request the bot answers (mention, reply, private chat, task thread or a name request) uploads its non-image files first.
    const request: Message = { ...message, text: text || "Hello", addressed: true, ...(task ? { taskId: message.channel } : {}), ...(addressed && !message.botAuthor ? { uploadFiles: true as const } : {}) };
    if (this.options.worker) {
      try { await this.options.worker.enqueue(request); }
      catch (error) {
        if (!(error instanceof UserLimitError)) throw error;
        await this.options.participation?.recordLimit(message);
        if (addressed) await this.send(request, limitReply(error.resetAt));
      }
    } else if (task) {
      await this.enqueue(request);
    } else { await this.process(request, ingested); }
  }
  private retryClassification(message: Incoming, attempt: number): void {
    const key = JSON.stringify([message.server, message.channel, message.id]);
    if (attempt >= 2 || this.classificationRetries.has(key) || this.classificationRetries.size >= 100 || Date.now() - (message.timestamp ?? Date.now()) > 60000) return;
    const timer = setTimeout(() => {
      this.classificationRetries.delete(key);
      const recover = async () => {
        const lookup = (this.store as { canonicalMessage?(server: string, id: string): Message | undefined | Promise<Message | undefined> }).canonicalMessage;
        if (!lookup || !this.accepts(message.server, message.channel) || Date.now() - (message.timestamp ?? Date.now()) > 60000) return;
        const current = await lookup.call(this.store, message.server, message.id);
        if (!current || JSON.stringify([current.text, current.attachments, current.replyTo]) !== JSON.stringify([message.text, message.attachments, message.replyTo])) return;
        await this.receive(message, { ingested: true, classificationAttempt: attempt + 1 });
      };
      void recover().catch(error => logError('classifier_recovery_failed', error, { server: message.server, channel: message.channel, messageId: message.id }, true));
    }, this.options.classificationRetryMs ?? 10000);
    timer.unref();
    this.classificationRetries.set(key, timer);
  }

  /**
   * Stops the responses in a channel: cancels queued jobs and interrupts running ones.
   * An admin stops all of them. Other users stop only the responses that their own messages started.
   * Returns the IDs of the stopped jobs.
   */
  async stop(server: string, channel: string, user: string, admin: boolean): Promise<string[]> {
    const store = this.options.queueStore;
    if (server !== this.server || !store) return [];
    const stopped: string[] = [];
    for (const job of await store.jobs(server, channel)) {
      if (!["pending", "ready", "running", "sending"].includes(job.status)) continue;
      if (!admin && job.message.author !== user) continue;
      if (!await store.cancelJob(job.id)) continue;
      await this.app.interrupt(server, job.message.id).catch(error => logError("stop_interrupt_failed", error, { server, jobId: job.id }));
      stopped.push(job.id);
    }
    return stopped;
  }

  /** Continues a stopped job from its recorded progress. The same rule as stop: an admin, or the author of the message that started it. */
  async resume(server: string, channel: string, jobId: string, user: string, admin: boolean): Promise<boolean> {
    const store = this.options.queueStore;
    if (server !== this.server || !store) return false;
    const job = (await store.jobs(server, channel)).find(item => item.id === jobId);
    if (!job || job.status !== "cancelled" || (!admin && job.message.author !== user)) return false;
    if (!await store.resumeJob(job.id)) return false;
    this.options.worker?.wake();
    return true;
  }

  /** True when Slopbot may answer one more bot message in this channel. The team sets the limit in Bot admin. */
  private allowBotReply(channel: string): boolean {
    const limit = this.options.botReplyLimit?.() ?? DEFAULT_BOT_REPLY_LIMIT;
    const now = Date.now();
    const recent = (this.botReplies.get(channel) ?? []).filter(at => now - at < limit.minutes * 60_000);
    if (recent.length >= limit.replies) { this.botReplies.set(channel, recent); return false; }
    recent.push(now); this.botReplies.set(channel, recent);
    return true;
  }

  setChannels(channels: readonly string[]): void {
    for (const channel of [...this.channels, ...this.tasks]) this.app.disallowChannel(this.server, channel);
    this.channels = [...channels]; this.tasks.clear();
    for (const channel of channels) this.app.allowChannel(this.server, channel);
    for (const task of this.registry.taskThreads(this.server)) if (channels.includes(task.parent)) {
      this.tasks.add(task.thread); this.app.allowChannel(this.server, task.thread);
    }
  }
  async startTask(message: Message, goal: string): Promise<string> {
    if (!this.accepts(message.server, message.channel)) throw new ToolError("Channel is not configured");
    if (this.tasks.has(message.channel)) return message.channel;
    const existing = await this.registry.taskForSource(message.server, message.id);
    const thread = existing ?? await this.gateway.createTaskThread(message, `Slopbot: ${goal.slice(0, 70)}`);
    await this.registry.registerTask(message.server, thread, message.channel, message.id);
    this.tasks.add(thread); this.app.allowChannel(message.server, thread);
    const available = await this.store.context(message, 8);
    const referenceIds = new Set<string>();
    let reference = message.replyTo;
    while (reference && !referenceIds.has(reference)) {
      referenceIds.add(reference);
      reference = available.find(item => item.id === reference)?.replyTo;
    }
    const context = message.replyTo ? available.filter(item => referenceIds.has(item.id)) : available;
    const selfId = "setting" in this.store ? slopbotId(this.store as Pick<ConversationEventStore, "setting">, message.server) : undefined;
    const replies = (await this.store.modelReplies?.(message.server, context.map(item => item.id))) ?? new Map<string, { runId: string; text: string }>();
    const { items, refs: seedRefs } = renderTranscript(context, selfId, replies, message.replyTo, "s");
    // Model text is a labelled quote here. The seed is one user message, so an assistant turn cannot be sent as a real role.
    const contextText = items.map(item => item.role === "assistant" ? `Slopbot: ${item.content}` : item.content).join("\n");
    const subject = message.replyTo ? await replySubject(this.options.profiles, message.server, context.find(item => item.id === message.replyTo)?.text ?? "") : undefined;
    const resolvedGoal = subject && /\b(his|her|their|he|she|they|him|them)\b/i.test(goal) ? `About ${subject.name} (<@${subject.id}>): ${goal}` : goal;
    const seed: Message = {
      id: `task-seed:${message.id}`, server: message.server, channel: thread,
      author: message.author, text: `Task goal: ${resolvedGoal}\nSource-channel context:\n${contextText}`,
      taskId: thread, addressed: true,
    };
    // Task runs resolve these "s" refs, and link them to the source channel. Saved before the seed is queued.
    await saveTaskRefs(this.store as SettingsPort, message.server, thread, seedRefs, message.channel);
    await this.store.linkOutput(seed, undefined, message.id);
    for (const source of context) await this.store.linkOutput(seed, undefined, source.id);
    if (this.options.worker) await this.options.worker.enqueue(seed);
    else await this.enqueue(seed);
    return thread;
  }
  async executeTool(message: Message, call: ToolCall, operationId: string, expectedVersion?: number, invocation?: import('./tools.js').ToolInvocation): Promise<ToolResult> {
    const registry = this.options.tools;
    if (!registry || !this.accepts(message.server, message.channel)) throw new ToolError("Tools are unavailable in this channel");
    registry.validate(call.name, call.arguments);
    await registry.checkAccess(message, call.name);
    // Checked before the thread rule. A private chat has no task threads, so its writes run in the chat itself.
    const privateChat = isPrivateChannel(message.channel);
    if (privateChat && registry.scopeOf(call.name) === "discord") throw new ToolError(discordOnlyMessage);
    if (!privateChat && registry.requiresThread(call.name, call.arguments) && !this.tasks.has(message.channel) && call.name !== "task_start") {
      const thread = await this.startTask(message, message.text);
      return { text: `Task started in <#${thread}>. Updates will appear there.`, handoff: { threadId: thread } };
    }
    if (registry.effect(call.name, call.arguments) === "write" && call.name !== "task_retry" && (await this.options.queueStore?.hasBlocked(message.server, message.channel))) throw new ToolError("This task has an uncertain action. Reconcile that job before new writes.");
    if (registry.effect(call.name, call.arguments) === "write" && call.name !== "task_retry" && (await this.options.queueStore?.hasPendingOther(message.server, message.channel, message.id))) throw new ToolError("New contributions are queued. Pause actions so the next contribution can be reviewed before proceeding.");
    const result = await registry.invokeResult(message, call.name, call.arguments, operationId, "agent", expectedVersion, invocation);
    return result;
  }
  async deliver(message: Message, reply: import("./domain.js").Reply, deliveryId: string): Promise<void> {
    if (!this.accepts(message.server, message.channel)) throw contextChangedError(message, await this.store.lastContextChange?.(message.server, message.channel));
    if (await this.requestDeleted(message)) return;
    await this.send(message, reply.text || "The AI returned no answer.", reply.runId, deliveryId, reply.toolActivity, reply.ui);
  }
  /** A deleted request gets no answer. A changed chat still gets its answer. */
  private async requestDeleted(message: Message): Promise<boolean> {
    const lookup = (this.store as { canonicalMessage?(server: string, id: string): unknown }).canonicalMessage;
    if (!lookup || await lookup.call(this.store, message.server, message.id)) return false;
    console.log(JSON.stringify({ type: "reply_dropped_request_deleted", server: message.server, channel: message.channel, messageId: message.id }));
    return true;
  }

  private async enqueue(message: Message): Promise<void> {
    requestTimings.start(message, "queue");
    // Includes sending, so slow Discord writes cannot reorder task answers.
    const previous = this.replies.get(message.channel) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.process(message));
    this.replies.set(message.channel, next);
    try { await next; } finally {
      if (this.replies.get(message.channel) === next) this.replies.delete(message.channel);
    }
  }

  private async process(message: Message, ingested = false): Promise<void> {
    requestTimings.end(message, "queue");
    const stopTyping = this.gateway.typing(message.channel);
    try {
      const reply = await this.app.handle(message, ingested);
      if (reply && !(await this.requestDeleted(message))) await this.send(message, reply.text || "The AI returned no answer. Please try again.", reply.runId, undefined, reply.toolActivity, reply.ui);
    } catch (error) {
      logError("request_failed", error, { server: message.server, channel: message.channel, messageId: message.id });
      const explanation = errorReply(error);
      await this.send(message, explanation);
    } finally { stopTyping(); }
  }

  private async send(message: Message, text: string, runId?: string, deliveryId?: string, activity?: readonly import("./tool-activity.js").ToolActivity[], ui?: import("./ui/schema.js").UiDocument): Promise<void> {
    for (const sent of await this.gateway.reply(message, text, deliveryId, activity, ui)) {
      // Link first: the web console checks which messages a run used when the saved reply shows up.
      await this.store.linkOutput(sent, runId, message.id);
      await this.store.ingest({ ...sent, addressed: false });
    }
  }
}

export function splitReply(text: string, limit = 1900): string[] {
  const chunks: string[] = [];
  let chunk = "", fence = "";
  const flush = () => {
    chunks.push(chunk + (fence ? "\n```" : ""));
    chunk = fence;
  };
  // Treat fence lines atomically so each Discord message can close and reopen them.
  const tokens = text.split(/(^```[^\n]*\n|^```$)/gm).filter(Boolean);
  for (const token of tokens) {
    if (/^```[^\n]*(?:\n|$)$/.test(token) && token.length + 4 < limit) {
      const nextFence = fence ? "" : token.endsWith("\n") ? token : token + "\n";
      if (chunk.length + token.length + (nextFence ? 4 : 0) > limit) flush();
      chunk += token;
      fence = nextFence;
      continue;
    }
    for (const character of token) {
      if (chunk.length + character.length + (fence ? 4 : 0) > limit) flush();
      chunk += character;
    }
  }
  if (chunk) chunks.push(chunk + (fence ? "\n```" : ""));
  return chunks;
}
