import { contextChangedError } from "./source-context.js";
import { errorReply, logError } from "./errors.js";
import { replySubject, type ProfileStore } from "./profiles.js";
import { requestTimings } from "./request-timing.js";
import { Application } from "./application.js";
import type { Message } from "./domain.js";
import type { Store } from "./ports.js";
import type { Knowledge } from "./memory.js";
import type { TaskWorker, QueueStore } from "./queue.js";
import { ToolError, discordOnlyMessage, type ToolCall, type ToolRegistry, type ToolResult } from "./tools.js";
import type { ParticipationGate } from "./participation.js";
import { UserLimitError, limitReply } from "./user-limiter.js";
import { isPrivateChannel } from "./private-chat.js";

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

const BOT_REPLY_LIMIT = 3;
const BOT_REPLY_WINDOW_MS = 10 * 60 * 1000;

export class Bot {
  private readonly tasks = new Set<string>();
  /** Times of recent replies to other bots, per channel. Stops bot-to-bot loops. */
  private readonly botReplies = new Map<string, number[]>();
  private readonly replies = new Map<string, Promise<void>>();
  // Open private chats of this server. A chat is added when its web chat row exists, and removed when it is deleted.
  private readonly privateChats = new Set<string>();

  constructor(
    private readonly app: Application,
    private readonly store: Store,
    private readonly registry: TaskRegistry,
    private readonly gateway: ChatGateway,
    private readonly server: string,
    private channels: readonly string[],
    private readonly options: { knowledge?: Knowledge; participation?: ParticipationGate; worker?: TaskWorker; tools?: ToolRegistry; queueStore?: QueueStore; profiles?: ProfileStore } = {},
  ) {
    for (const task of registry.taskThreads(server)) {
      if (channels.includes(task.parent)) {
        this.tasks.add(task.thread);
        app.allowChannel(server, task.thread);
      }
    }
  }

  accepts(server: string, channel: string): boolean {
    return server === this.server && (this.channels.includes(channel) || this.tasks.has(channel) || this.privateChats.has(channel));
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
  async receive(message: Incoming, options: { ingested?: boolean } = {}): Promise<void> {
    if (!this.accepts(message.server, message.channel)) return;
    if (message.botAuthor) message = { ...message, isBot: true };
    requestTimings.begin(message);
    try { await requestTimings.withScope(message, () => this.receiveScoped(message, options.ingested === true)); }
    catch (error) {
      if (!(error instanceof UserLimitError)) throw error;
      // Only a direct request gets the notice. Unsolicited replies stay silent.
      if (message.mentionsBot || message.repliesToBot || message.addressed === true || this.tasks.has(message.channel)) await this.send(message, limitReply(error.resetAt));
    }
  }
  private async receiveScoped(message: Incoming, alreadyIngested: boolean): Promise<void> {
    const task = this.tasks.has(message.channel);
    const privateChat = isPrivateChannel(message.channel);
    // A web reply arrives with addressed=true, so it always gets an answer and skips JEV. A private chat always does, even without that flag.
    let addressed = task && !message.botAuthor || privateChat || message.mentionsBot || message.repliesToBot || message.addressed === true;
    let ingested = alreadyIngested;
    // Another bot can mention or reply to Slopbot without end. Past the cap, its messages are saved but get no reply.
    if (addressed && message.botAuthor && !this.allowBotReply(message.channel)) {
      if (!ingested) await this.store.ingest({ ...message, addressed: false });
      requestTimings.finish(message);
      return;
    }
    if (!addressed) {
      if (!await this.store.ingest({ ...message, addressed: false })) return;
      ingested = true;
      // Other bots' status/error commentary is evidence, not an automatic task
      // request. Explicit mentions and replies still support collaboration.
      if (message.botAuthor) { requestTimings.finish(message); return; }
      const gate = this.options.participation;
      if (!gate) return;
      const context = await requestTimings.measure(message, "participation context", () => this.store.context(message, gate.options.contextMessages));
      const decision = await requestTimings.measure(message, "participation", () => gate.decide(message, context));
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
    const request: Message = { ...message, text: text || "Hello", addressed: true, ...(task ? { taskId: message.channel } : {}) };
    if (this.options.worker) {
      await this.options.worker.enqueue(request);
    } else if (task) {
      await this.enqueue(request);
    } else { await this.process(request, ingested); }
  }

  /**
   * Stops the responses in a channel: cancels queued jobs and interrupts running ones.
   * An admin stops all of them. Other users stop only the responses that their own messages started.
   * Returns the number of stopped responses.
   */
  async stop(server: string, channel: string, user: string, admin: boolean): Promise<number> {
    const store = this.options.queueStore;
    if (server !== this.server || !store) return 0;
    let stopped = 0;
    for (const job of await store.jobs(server, channel)) {
      if (!["pending", "ready", "running", "sending"].includes(job.status)) continue;
      if (!admin && job.message.author !== user) continue;
      if (!await store.cancelJob(job.id)) continue;
      await this.app.interrupt(server, job.message.id).catch(error => logError("stop_interrupt_failed", error, { server, jobId: job.id }));
      stopped++;
    }
    return stopped;
  }

  /** True when Slopbot may answer one more bot message in this channel: at most BOT_REPLY_LIMIT in BOT_REPLY_WINDOW_MS. */
  private allowBotReply(channel: string): boolean {
    const now = Date.now();
    const recent = (this.botReplies.get(channel) ?? []).filter(at => now - at < BOT_REPLY_WINDOW_MS);
    if (recent.length >= BOT_REPLY_LIMIT) { this.botReplies.set(channel, recent); return false; }
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
    const contextText = JSON.stringify(context.map(item => ({ ...item, context_role: item.id === message.replyTo ? "reply_target" : "background" })));
    const subject = message.replyTo ? await replySubject(this.options.profiles, message.server, context.find(item => item.id === message.replyTo)?.text ?? "") : undefined;
    const resolvedGoal = subject && /\b(his|her|their|he|she|they|him|them)\b/i.test(goal) ? `About ${subject.name} (<@${subject.id}>): ${goal}` : goal;
    const seed: Message = {
      id: `task-seed:${message.id}`, server: message.server, channel: thread,
      author: message.author, text: `Task goal: ${resolvedGoal}\nSource-channel context: ${contextText}`,
      taskId: thread, addressed: true,
    };
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
    if (!this.accepts(message.server, message.channel) || reply.contextVersion !== await this.store.contextVersion(message.server, message.channel)) throw contextChangedError(message, await this.store.lastContextChange?.(message.server, message.channel), { expectedVersion: reply.contextVersion ?? "unknown", actualVersion: await this.store.contextVersion(message.server, message.channel) });
    await this.send(message, reply.text || "The AI returned no answer.", reply.runId, deliveryId, reply.toolActivity, reply.ui);
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
      if (reply && reply.contextVersion !== await this.store.contextVersion(message.server, message.channel)) {
        throw contextChangedError(message, await this.store.lastContextChange?.(message.server, message.channel), { expectedVersion: reply.contextVersion ?? "unknown", actualVersion: await this.store.contextVersion(message.server, message.channel) });
      }
      if (reply) await this.send(message, reply.text || "The AI returned no answer. Please try again.", reply.runId, undefined, reply.toolActivity, reply.ui);
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
