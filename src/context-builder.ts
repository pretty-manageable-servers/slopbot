import type { Message, PromptItem } from "./domain.js";
import type { Store } from "./ports.js";
import type { Recall } from "./memory.js";
import type { TokenCounter } from "./context.js";
import type { ProfileStore } from "./profiles.js";
import type { ToolExecutor } from "./tools.js";
import { expandReplySubject, shouldRecall, personResponses, suggestRequestTool } from "./request-routing.js";

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
    let request: PromptItem = { role: "user", content: message.text, author: message.author, sourceIds: [message.id] };
    const metadata: PromptItem[] = this.options.tools ? [{ role: "user", contextOnly: true, content: JSON.stringify({ request_context: { server_id: message.server, channel_id: message.channel, requester_id: message.author, task_id: message.taskId ?? null, is_task: Boolean(message.taskId) } }) }] : [];
    let budget = this.options.inputLimit - schemaBudget - this.options.counter.count([...prefix, ...metadata, request]);
    if (budget < 0) throw new Error("Request exceeds context budget");
    const referencedContext = message.replyTo ? await this.options.store.context(message, recentMessages) : undefined;
    const target = referencedContext?.find(item => item.id === message.replyTo);
    const expanded = await expandReplySubject(this.options.profiles, message, target, request);
    budget -= this.options.counter.count([expanded]) - this.options.counter.count([request]);
    if (budget < 0) throw new Error("Request and reply subject exceed context budget");
    request = expanded;
    const targetReserve = target ? this.options.counter.count([{ role: "user", content: JSON.stringify({ ...target, context_role: "reply_target" }), contextOnly: true }]) : 0;
    let history = taskKey ? await boundedHistory(message, taskKey, budget - targetReserve * (this.options.tools ? 2 : 1)) : [];
    budget -= this.options.counter.count(history);
    if (this.options.tools) budget = Math.floor(budget / 2);
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
    for (const evidence of recalled) {
      const entry: PromptItem = { role: "user", content: JSON.stringify({ evidence }), contextOnly: true };
      const size = this.options.counter.count([entry]);
      if (size <= budget) { inputs.push(entry); budget -= size; for (const id of evidence.sourceIds) sources.add(id); }
    }
    if (this.options.profiles) {
      const authors = new Set([message.author, ...recalled.map(item => item.author)]);
      for (const item of inputs) {
        try { const value = JSON.parse(item.content) as {author?: string}; if (value.author) authors.add(value.author); } catch { /* Only canonical context exposes author IDs. */ }
      }
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
    return { sourceVersion, history, inputs, sources, quoteAnswer, clarificationAnswer, suggested, metadata, quotes };
  }
}
