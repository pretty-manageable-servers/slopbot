import { RequestError } from "./errors.js";
import type { Message, PromptItem } from "./domain.js";
import type { Store } from "./ports.js";
import type { Recall } from "./memory.js";
import type { TokenCounter } from "./context.js";
import type { ProfileStore } from "./profiles.js";
import type { ToolExecutor } from "./tools.js";
import { expandReplySubject, shouldRecall, personResponses, suggestRequestTool } from "./request-routing.js";
import { isPrivateChannel } from "./private-chat.js";
import { VOICE_RULE } from "./voice-rules.js";
import { renderTranscript, requestLine } from "./transcript.js";
import { slopbotId, type ConversationEventStore } from "./run-events.js";

const privateChatRule = "This is a private web chat. It has no task threads. Do writes directly in this chat. Never call task_start. This replaces the task thread rule in the tool instructions for this chat.";

interface ContextOptions {
  store: Store; recall?: Recall; profiles?: ProfileStore; tools?: ToolExecutor;
  counter: TokenCounter; inputLimit: number; outputLimit: number; prefix: readonly PromptItem[];
}
export class ContextBuilder {
  constructor(private readonly options: ContextOptions) {}
  async build(message: Message, taskKey: string | undefined, recentMessages: number,
    boundedHistory: (message: Message, taskKey: string, limit: number) => Promise<readonly PromptItem[]>,
    prefix = this.options.prefix, tools = this.options.tools, schemaBudget = 0) {
    const sourceVersion = await this.options.store.contextVersion(message.server, message.channel);
    let request: PromptItem = { role: "user", content: requestLine(message), author: message.author, sourceIds: [message.id], ...(message.modelImages?.length ? { images: message.modelImages } : {}) };
    // A private chat has no task threads, so the thread rule in the tool instructions does not apply to it. Only this request says so.
    const privateChat = isPrivateChannel(message.channel) ? { private_web_chat: true, private_chat_rule: privateChatRule } : {};
    const voice = message.source === "voice" ? { voice_channel: true, voice_rule: VOICE_RULE } : {};
    const metadata: PromptItem[] = this.options.tools ? [{ role: "user", contextOnly: true, content: JSON.stringify({ request_context: { server_id: message.server, channel_id: message.channel, requester_id: message.author, task_id: message.taskId ?? null, is_task: Boolean(message.taskId), ...privateChat, ...voice } }) }] : [];
    let budget = this.options.inputLimit - schemaBudget - this.options.counter.count([...prefix, ...metadata, request]);
    if (budget < 0) throw new RequestError("CONTEXT_BUDGET", `Request exceeds context budget: request and schemas are ${-budget} estimated input units over the limit.`, "Reduce the request or increase CONTEXT_TOKENS while leaving room for OUTPUT_TOKENS.", { inputLimit: this.options.inputLimit, schemaBudget });
    const referencedContext = message.replyTo ? await this.options.store.context(message, recentMessages) : undefined;
    const target = referencedContext?.find(item => item.id === message.replyTo);
    const expanded = await expandReplySubject(this.options.profiles, message, target, request);
    // expandReplySubject returns the same object when it adds nothing. Otherwise the header goes back on, around the subject text.
    const headed: PromptItem = expanded === request ? request : { ...expanded, content: requestLine(message, expanded.content) };
    budget -= this.options.counter.count([headed]) - this.options.counter.count([request]);
    if (budget < 0) throw new RequestError("CONTEXT_BUDGET", "Request and reply subject exceed the context budget.", "Reduce the request or increase CONTEXT_TOKENS.", { inputLimit: this.options.inputLimit, schemaBudget });
    request = headed;
    // Slopbot's own ID comes from the store setting. Without a setting store, no message counts as Slopbot's own.
    const selfId = "setting" in this.options.store && typeof this.options.store.setting === "function" ? slopbotId(this.options.store as Pick<ConversationEventStore, "setting">, message.server) : undefined;
    const targetReplies = (target ? await this.options.store.modelReplies?.(message.server, [target.id]) : undefined) ?? new Map<string, { runId: string; text: string }>();
    const targetReserve = target ? this.options.counter.count(renderTranscript([target], selfId, targetReplies, message.replyTo).items) : 0;
    // Reserve working space before history selection, not after it has filled the budget.
    const toolReserve = tools ? Math.floor(Math.max(0, budget - targetReserve) / 2) : 0;
    budget -= toolReserve;
    let history = taskKey ? await boundedHistory(message, taskKey, budget - targetReserve) : [];
    budget -= this.options.counter.count(history);
    const inputs: PromptItem[] = [];
    const sources = new Set([message.id]);
    let historyMessages: readonly Message[] = [];
    let historyItems: PromptItem[] = [];
    let refs = new Map<string, string>();
    if (!taskKey || message.replyTo) {
      const available = referencedContext ?? await this.options.store.context(message, recentMessages);
      const referenceIds = new Set<string>();
      let reference = message.replyTo;
      while (reference && !referenceIds.has(reference)) {
        referenceIds.add(reference);
        reference = available.find(item => item.id === reference)?.replyTo;
      }
      const context = message.replyTo ? available.filter(item => referenceIds.has(item.id)) : available;
      const replies = (await this.options.store.modelReplies?.(message.server, context.map(item => item.id))) ?? new Map<string, { runId: string; text: string }>();
      // Newest first, reply target first. The estimate renders each message alone with its real text.
      const allowance = budget;
      let spent = 0;
      const chosen = new Set<string>();
      for (const item of [...context.filter(item => item.id === message.replyTo), ...context.filter(item => item.id !== message.replyTo).reverse()]) {
        const size = this.options.counter.count(renderTranscript([item], selfId, replies, message.replyTo).items);
        if (item.id === message.replyTo && size > allowance) throw new Error("Referenced message exceeds context budget; reply context was not discarded");
        if (size <= allowance - spent) { chosen.add(item.id); spent += size; }
      }
      // Render in chronological order. The final render can cost more than the estimates, so drop the oldest background until it fits.
      let kept = context.filter(item => chosen.has(item.id));
      let rendered = renderTranscript(kept, selfId, replies, message.replyTo);
      while (this.options.counter.count(rendered.items) > allowance) {
        const oldest = kept.findIndex(item => item.id !== message.replyTo);
        if (oldest === -1) throw new Error("Referenced message exceeds context budget; reply context was not discarded");
        kept = kept.filter((_, index) => index !== oldest);
        rendered = renderTranscript(kept, selfId, replies, message.replyTo);
      }
      budget = allowance - this.options.counter.count(rendered.items);
      for (const item of kept) sources.add(item.id);
      historyMessages = kept;
      historyItems = rendered.items;
      refs = rendered.refs;
      inputs.push(...rendered.items);
    }
    const needsRecall = shouldRecall(message);
    const recalled = needsRecall ? await this.options.recall?.retrieve(message, 8) ?? [] : [];
    const personScope = recalled.find(item => item.kind === "retrieval");
    if (personScope && !taskKey) { budget += this.options.counter.count(inputs); inputs.splice(0); } // Person evidence must not borrow other speakers' background text.
    const { quotes, quoteAnswer, clarificationAnswer } = personResponses(message, recalled, personScope);
    for (const evidence of recalled) {
      const entry: PromptItem = { role: "user", content: JSON.stringify({ evidence }), contextOnly: true };
      const size = this.options.counter.count([entry]);
      if (size <= budget) { inputs.push(entry); budget -= size; for (const id of evidence.sourceIds) sources.add(id); }
    }
    if (this.options.profiles) {
      const authors = new Set([message.author, ...recalled.map(item => item.author)]);
      // History is still in inputs only when person evidence did not drop it (see above).
      if (historyItems.length && inputs.includes(historyItems[0]!)) for (const item of historyMessages) authors.add(item.author);
      for (const item of [request, ...inputs]) for (const match of item.content.matchAll(/<@!?(\d{17,20})>/g)) authors.add(match[1]!);
      for (const author of [...authors].slice(0, 12)) {
        const profile = await this.options.profiles.profile(message.server, author);
        const entry: PromptItem = { role: "user", contextOnly: true, content: JSON.stringify({ public_profile: { user_id: author, display_name: profile.name, discord: profile.identity, fields: profile.fields.map(field => ({ field: field.field, value: field.value, editor: field.editor, self_reported: field.editor === author, source_ids: field.sourceIds })) } }) };
        const size = this.options.counter.count([entry]);
        if (size <= budget) { inputs.push(entry); budget -= size; for (const field of profile.fields) for (const id of field.sourceIds) sources.add(id); }
      }
    }
    inputs.push(...metadata, request);
    const suggested = suggestRequestTool(tools, message, target);
    return { sourceVersion, history, inputs, sources, quoteAnswer, clarificationAnswer, suggested, metadata, quotes, refs };
  }
}
