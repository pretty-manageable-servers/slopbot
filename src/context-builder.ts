import { RequestError } from "./errors.js";
import type { Json, Message, PromptItem } from "./domain.js";
import { contextBlock, evidenceLine, personLine, type ContextPerson } from "./context-block.js";
import type { Store } from "./ports.js";
import type { ImageSource } from "./model-images.js";
import type { Recall } from "./memory.js";
import type { TokenCounter } from "./context.js";
import type { ProfileStore } from "./profiles.js";
import { globalProfiles } from './global-profiles.js';
import type { ToolExecutor } from "./tools.js";
import { expandReplySubject, shouldRecall, personResponses, suggestRequestTool } from "./request-routing.js";
import { isPrivateChannel, isDirectMessageChannel } from "./private-chat.js";
import { VOICE_RULE } from "./voice-rules.js";
import { renderTranscript, requestLine } from "./transcript.js";
import { slopbotId, type ConversationEventStore } from "./run-events.js";
import { selectRunImages } from "./run-images.js";

const privateChatRule = "This is a private conversation. It has no task threads. Do writes directly in this chat. Never call task_start. This replaces the task thread rule in the tool instructions for this chat.";
const webMathRule = "The web view renders LaTeX math: use $…$ inline and $$…$$ for display.";

interface ContextOptions {
  store: Store; recall?: Recall; profiles?: ProfileStore; tools?: ToolExecutor;
  /** Fresh links for stored images. Without it, a run gets only the request's own web chat images. */
  images?: ImageSource;
  counter: TokenCounter; inputLimit: number; outputLimit: number; prefix: readonly PromptItem[];
}
/** One person of the People section, with the fields of their profile. The requester is marked. */
async function personFor(profiles: ProfileStore, message: Message, author: string): Promise<ContextPerson> {
  const profile = await profiles.profile(message.server, author);
  const global = await globalProfiles(profiles)?.get(author);
  const globalNames = new Set(global?.fields.map(field => field.field));
  return { user_id: author, display_name: profile.name, ...(author === message.author ? { requester: true as const } : {}), discord: profile.identity, fields: [...profile.fields.filter(field => !globalNames.has(field.field)).map(field => ({ field: field.field, value: field.value, self_reported: field.editor === author, source_ids: field.sourceIds })), ...(global?.fields ?? []).map(field => ({ field: field.field, value: field.value, self_reported: true, source_ids: [], scope: 'global' as const }))] };
}
export class ContextBuilder {
  constructor(private readonly options: ContextOptions) {}
  async build(message: Message, taskKey: string | undefined, recentMessages: number,
    boundedHistory: (message: Message, taskKey: string, limit: number) => Promise<readonly PromptItem[]>,
    prefix = this.options.prefix, tools = this.options.tools, schemaBudget = 0) {
    const sourceVersion = await this.options.store.contextVersion(message.server, message.channel);
    const referencedContext = message.replyTo ? await this.options.store.context(message, recentMessages) : undefined;
    const target = referencedContext?.find(item => item.id === message.replyTo);
    // Images as image input: the request's own, the reply target's, and the same author's messages just before the request.
    const recent = this.options.images ? await this.options.store.context(message, 20) : [];
    const images = await selectRunImages({ request: message, target, recent, source: this.options.images });
    let request: PromptItem = { role: "user", content: requestLine(message), author: message.author, sourceIds: [message.id], ...(images.length ? { images } : {}) };
    // A private chat has no task threads, so the thread rule in the tool instructions does not apply to it. Only this request says so.
    const privateChat = isPrivateChannel(message.channel) ? { ...(isDirectMessageChannel(message.channel) ? { private_direct_message: true } : { private_web_chat: true }), private_chat_rule: privateChatRule } : {};
    const voice = message.source === "voice" ? { voice_channel: true, voice_rule: VOICE_RULE } : {};
    const web = message.source === "web" ? { web_math_rule: webMathRule } : {};
    // Files that the worker copied to the sandbox before this run. The model reads them with read or shell.
    const uploads = message.uploads ? { uploaded_files: [...message.uploads.files], upload_failed: [...message.uploads.failed] } : {};
    const requestContext: Record<string, Json> = this.options.tools ? { channel_id: message.channel, task_id: message.taskId ?? null, is_task: Boolean(message.taskId), ...privateChat, ...voice, ...web, ...uploads } : {};
    // Request fields only, to reserve their budget. The full context block is built after the rows are chosen.
    const metadata: PromptItem[] = this.options.tools ? [contextBlock({ request: requestContext, people: [], evidence: [] })] : [];
    let budget = this.options.inputLimit - schemaBudget - this.options.counter.count([...prefix, ...metadata, request]);
    if (budget < 0) throw new RequestError("CONTEXT_BUDGET", `Request exceeds context budget: request and schemas are ${-budget} estimated input units over the limit.`, "Reduce the request or increase CONTEXT_TOKENS while leaving room for OUTPUT_TOKENS.", { inputLimit: this.options.inputLimit, schemaBudget });
    const expanded = await expandReplySubject(this.options.profiles, message, target, request);
    // expandReplySubject returns the same object when it adds nothing. Otherwise the header goes back on, around the subject text.
    const headed: PromptItem = expanded === request ? request : { ...expanded, content: requestLine(message, expanded.content) };
    budget -= this.options.counter.count([headed]) - this.options.counter.count([request]);
    if (budget < 0) throw new RequestError("CONTEXT_BUDGET", "Request and reply subject exceed the context budget.", "Reduce the request or increase CONTEXT_TOKENS.", { inputLimit: this.options.inputLimit, schemaBudget });
    request = headed;
    // Slopbot's own ID comes from the store setting. Without a setting store, no message counts as Slopbot's own.
    const selfId = "setting" in this.options.store && typeof this.options.store.setting === "function" ? slopbotId(this.options.store as Pick<ConversationEventStore, "setting">, message.server) : undefined;
    // The requester is always in People. Its line is counted here, before history, evidence and other people use the budget.
    let requester: ContextPerson | undefined;
    if (this.options.profiles && message.author !== selfId) {
      const full = await personFor(this.options.profiles, message, message.author);
      // When the full line does not fit, its fields are dropped. The ID and the name always stay.
      requester = this.options.counter.count([{ role: "user", content: personLine(full), contextOnly: true }]) <= budget ? full : { user_id: full.user_id, display_name: full.display_name, requester: true, fields: [] };
      budget -= this.options.counter.count([{ role: "user", content: personLine(requester), contextOnly: true }]);
      if (budget < 0) throw new RequestError("CONTEXT_BUDGET", "Request and requester exceed the context budget.", "Reduce the request or increase CONTEXT_TOKENS.", { inputLimit: this.options.inputLimit, schemaBudget });
    }
    const targetReplies = (target ? await this.options.store.modelReplies?.(message.server, [target.id]) : undefined) ?? new Map<string, { runId: string; text: string }>();
    const targetReserve = target ? this.options.counter.count(renderTranscript([target], selfId, targetReplies, message.replyTo).items) : 0;
    // Reserve working space before history selection, not after it has filled the budget.
    const toolReserve = tools ? Math.floor(Math.max(0, budget - targetReserve) / 2) : 0;
    budget -= toolReserve;
    let history = taskKey ? await boundedHistory(message, taskKey, budget - targetReserve) : [];
    budget -= this.options.counter.count(history);
    const inputs: PromptItem[] = [];
    const sources = new Set([message.id]);
    for (const field of requester?.fields ?? []) for (const id of field.source_ids) sources.add(id);
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
    // Evidence stays in inputs for the author and mention scans below; its rows move into the context block at the end.
    const evidenceRows = new Map<PromptItem, Json>();
    for (const evidence of recalled) {
      const entry: PromptItem = { role: "user", content: JSON.stringify({ evidence }), contextOnly: true };
      const size = this.options.counter.count([{ role: "user", content: evidenceLine(evidence as unknown as Json), contextOnly: true }]);
      if (size <= budget) { inputs.push(entry); evidenceRows.set(entry, evidence as unknown as Json); budget -= size; for (const id of evidence.sourceIds) sources.add(id); }
    }
    const people: ContextPerson[] = requester ? [requester] : [];
    if (this.options.profiles) {
      const profiles = this.options.profiles;
      const authors = new Set([message.author, ...recalled.map(item => item.author)]);
      // History is still in inputs only when person evidence did not drop it (see above).
      if (historyItems.length && inputs.includes(historyItems[0]!)) for (const item of historyMessages) authors.add(item.author);
      for (const item of [request, ...inputs]) for (const match of item.content.matchAll(/<@!?(\d{17,20})>/g)) authors.add(match[1]!);
      // Slopbot is not a person in the People section. Its messages are assistant turns or notices. The requester is already in people.
      for (const author of [...authors].filter(author => author !== selfId && author !== message.author).slice(0, 12 - people.length)) {
        const person = await personFor(profiles, message, author);
        const size = this.options.counter.count([{ role: "user", content: personLine(person), contextOnly: true }]);
        if (size <= budget) { people.push(person); budget -= size; for (const field of person.fields) for (const id of field.source_ids) sources.add(id); }
      }
    }
    const evidenceItems = [...evidenceRows.values()];
    const block = this.options.tools || people.length || evidenceItems.length ? [contextBlock({ request: requestContext, people, evidence: evidenceItems })] : [];
    inputs.splice(0, inputs.length, ...inputs.filter(item => !evidenceRows.has(item)), ...block, request);
    const suggested = suggestRequestTool(tools, message, target);
    const knownUsers = new Set(people.map(person => person.user_id));
    return { sourceVersion, history, inputs, sources, quoteAnswer, clarificationAnswer, suggested, metadata: block, quotes, refs, knownUsers };
  }
}
