import type { Message, PromptItem } from './domain.js';
import type { Evidence } from './memory.js';
import { replySubject, type ProfileStore } from './profiles.js';
import type { ToolExecutor } from './tools.js';
import { authoredSourceText } from './source-context.js';

// These are deterministic shortcuts. The model handles requests without a match.
// Both texts are authored text: attachment labels with CDN URLs never reach the model.
export async function expandReplySubject(profiles: ProfileStore | undefined, message: Message, target: Message | undefined, request: PromptItem): Promise<PromptItem> {
  const text = authoredSourceText(message);
  if (!target || !/\b(his|her|their|he|she|they|him|them)\b/i.test(text)) return request;
  const subject = await replySubject(profiles, message.server, authoredSourceText(target));
  return subject ? { ...request, content: `About ${subject.name} (<@${subject.id}>), the person in your reply target:\n${text}` } : request;
}
export function shouldRecall(message: Message): boolean {
  return !message.replyTo || /\b(history|remember|said|say|quotes?)\b/i.test(message.text);
}
export function personResponses(message: Message, recalled: readonly Evidence[], scope: Evidence | undefined) {
  const quotes = recalled.filter(item => item.kind === 'message' && item.author === scope?.targetAuthor);
  const name = quotes[0]?.authorName ?? (scope?.targetAuthor ? `<@${scope.targetAuthor}>` : undefined);
  const quoteAnswer = /\b(list|give|show)\b.*\bquotes?\b/i.test(message.text) && scope?.targetAuthor
    ? quotes.length ? `Quotes from ${name}:\n\n` + quotes.map((item, index) => `${index + 1}. ${JSON.stringify(item.content)}${item.sourceUrl ? ` — [source](${item.sourceUrl})` : ''}`).join('\n') : 'I could not find stored messages from that member in this channel.'
    : undefined;
  const clarificationAnswer = /^I meant\b/i.test(message.text) && scope?.targetAuthor ? `Got it—you mean ${name}.` : undefined;
  return { quotes, quoteAnswer, clarificationAnswer };
}
export function suggestRequestTool(tools: ToolExecutor | undefined, message: Message, target: Message | undefined) {
  const fileReference = target?.attachments?.length && /\b(image|gif|file|attachment|picture|document|spreadsheet|photo|analy[sz]e|summari[sz]e)\b/i.test(message.text);
  return tools?.suggest?.(fileReference ? { ...message, attachments: target.attachments } : message);
}
