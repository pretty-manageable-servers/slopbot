import { RequestError } from "./errors.js";
import type { Json, Message, PromptItem } from "./domain.js";
import { contextBlock, evidenceLine, personLine, type ContextPerson } from "./context-block.js";
import type { Store } from "./ports.js";
import type { Recall } from "./memory.js";
import type { TokenCounter } from "./context.js";
import type { ProfileStore } from "./profiles.js";
import type { ToolExecutor } from "./tools.js";
import { expandReplySubject, shouldRecall, personResponses, suggestRequestTool } from "./request-routing.js";
import { isPrivateChannel } from "./private-chat.js";
import { VOICE_RULE } from "./voice-rules.js";

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
    let request: PromptItem = { role: "user", content: message.text, author: message.author, sourceIds: [message.id], ...(message.modelImages?.length ? { images: message.modelImages } : {}) };
    // A private chat has no task threads, so the thread rule in the tool instructions does not apply to it. Only this request says so.
    const privateChat = isPrivateChannel(message.channel) ? { private_web_chat: true, private_chat_rule: privateChatRule } : {};
    const voice = message.source === "voice" ? { voice_channel: true, voice_rule: VOICE_RULE } : {};
    const requestContext: Record<string, Json> = this.options.tools ? { server_id: message.server, channel_id: message.channel, requester_id: message.author, task_id: message.taskId ?? null, is_task: Boolean(message.taskId), ...privateChat, ...voice } : {};
    // Request fields only, to reserve their budget. The full context block is built after the rows are chosen.
    const metadata: PromptItem[] = this.options.tools ? [contextBlock({ request: requestContext, people: [], evidence: [] })] : [];
    let budget = this.options.inputLimit - schemaBudget - this.options.counter.count([...prefix, ...metadata, request]);
    if (budget < 0) throw new RequestError("CONTEXT_BUDGET", `Request exceeds context budget: request and schemas are ${-budget} estimated input units over the limit.`, "Reduce the request or increase CONTEXT_TOKENS while leaving room for OUTPUT_TOKENS.", { inputLimit: this.options.inputLimit, schemaBudget });
    const referencedContext = message.replyTo ? await this.options.store.context(message, recentMessages) : undefined;
    const target = referencedContext?.find(item => item.id === message.replyTo);
    const expanded = await expandReplySubject(this.options.profiles, message, target, request);
    budget -= this.options.counter.count([expanded]) - this.options.counter.count([request]);
    if (budget < 0) throw new RequestError("CONTEXT_BUDGET", "Request and reply subject exceed the context budget.", "Reduce the request or increase CONTEXT_TOKENS.", { inputLimit: this.options.inputLimit, schemaBudget });
    request = expanded;
    const targetReserve = target ? this.options.counter.count([{ role: "user", content: JSON.stringify({ ...target, context_role: "reply_target" }), contextOnly: true }]) : 0;
    // Reserve working space before history selection, not after it has filled the budget.
    const toolReserve = tools ? Math.floor(Math.max(0, budget - targetReserve) / 2) : 0;
    budget -= toolReserve;
    let history = taskKey ? await boundedHistory(message, taskKey, budget - targetReserve) : [];
    budget -= this.options.counter.count(history);
    const inputs: PromptItem[] = [];
    const sources = new Set([message.id]);
    if (!taskKey || message.replyTo) {
      const available = referencedContext ?? await this.options.store.context(message, recentMessages);
      const referenceIds = new Set<string>();
      let reference = message.replyTo;
      while (reference && !referenceIds.has(reference)) {
        referenceIds.add(reference);
        reference = available.find(item => item.id === reference)?.replyTo;
      }
      const context = message.replyTo ? available.filter(item => referenceIds.has(item.id)) : available;
      const selected = new Map<string, PromptItem>();
      for (const item of [...context.filter(item => item.id === message.replyTo), ...context.filter(item => item.id !== message.replyTo).reverse()]) {
        const entry: PromptItem = { role: "user", content: JSON.stringify({ ...item, context_role: item.id === message.replyTo ? "reply_target" : "background" }), contextOnly: true };
        const size = this.options.counter.count([entry]);
        if (item.id === message.replyTo && size > budget) throw new Error("Referenced message exceeds context budget; reply context was not discarded");
        if (size <= budget) { selected.set(item.id, entry); budget -= size; sources.add(item.id); }
      }
      for (const item of context.filter(item => item.id !== message.replyTo)) if (selected.has(item.id)) inputs.push(selected.get(item.id)!);
      if (message.replyTo && selected.has(message.replyTo)) inputs.push(selected.get(message.replyTo)!);
    }
    const needsRecall = shouldRecall(message);
    const recalled = needsRecall ? await this.options.recall?.retrieve(message, 8) ?? [] : [];
    const personScope = recalled.find(item => item.kind === "retrieval");
    if (personScope && !taskKey) { budget += this.options.counter.count(inputs); inputs.splice(0); } // Person evidence must not borrow other speakers' background text.
    const { quotes, quoteAnswer, clarificationAnswer } = personResponses(message, recalled, personScope);
    // Evidence stays in inputs for the author and mention scans below; its rows move into the context block at the end.
    const evidenceRows = new Map<PromptItem, Json>();
    for (const evidence of recalled) {
      const entry: PromptItem = { role: "user", content: JSON.stringify({ evidence }), contextOnly: true };
      const size = this.options.counter.count([{ role: "user", content: evidenceLine(evidence as unknown as Json), contextOnly: true }]);
      if (size <= budget) { inputs.push(entry); evidenceRows.set(entry, evidence as unknown as Json); budget -= size; for (const id of evidence.sourceIds) sources.add(id); }
    }
    const people: ContextPerson[] = [];
    if (this.options.profiles) {
      const authors = new Set([message.author, ...recalled.map(item => item.author)]);
      for (const item of inputs) {
        try { const value = JSON.parse(item.content) as {author?: string}; if (value.author) authors.add(value.author); } catch { /* Only canonical context exposes author IDs. */ }
      }
      for (const item of [request, ...inputs]) for (const match of item.content.matchAll(/<@!?(\d{17,20})>/g)) authors.add(match[1]!);
      for (const author of [...authors].slice(0, 12)) {
        const profile = await this.options.profiles.profile(message.server, author);
        const person: ContextPerson = { user_id: author, display_name: profile.name, discord: profile.identity, fields: profile.fields.map(field => ({ field: field.field, value: field.value, self_reported: field.editor === author, source_ids: field.sourceIds })) };
        const size = this.options.counter.count([{ role: "user", content: personLine(person), contextOnly: true }]);
        if (size <= budget) { people.push(person); budget -= size; for (const field of profile.fields) for (const id of field.sourceIds) sources.add(id); }
      }
    }
    const evidenceItems = [...evidenceRows.values()];
    const block = this.options.tools || people.length || evidenceItems.length ? [contextBlock({ request: requestContext, people, evidence: evidenceItems })] : [];
    inputs.splice(0, inputs.length, ...inputs.filter(item => !evidenceRows.has(item)), ...block, request);
    const suggested = suggestRequestTool(tools, message, target);
    return { sourceVersion, history, inputs, sources, quoteAnswer, clarificationAnswer, suggested, metadata: block, quotes };
  }
}
