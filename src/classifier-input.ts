import type { Message } from './domain.js';

export const CLASSIFIER_CONTEXT_LIMIT = 5;
export interface FollowupSignal { replyId: string; ageMs: number }
const bounded = (text: string, bytes: number): string => {
  let result = text.slice(0, bytes);
  while (Buffer.byteLength(JSON.stringify(result)) > bytes) result = result.slice(0, Math.floor(result.length * 0.8));
  return result;
};

/** Only conversational cues belong in the per-message classification payload. */
export function classifierInput(message: Message, context: readonly Message[], followup?: FollowupSignal) {
  const preceding = context.filter(item => item.server === message.server && item.channel === message.channel && item.id !== message.id).slice(-CLASSIFIER_CONTEXT_LIMIT);
  const compact = (item: Message, textLimit: number) => ({
    id: bounded(item.id, 100), author: bounded(item.author, 100), authorName: item.authorName === undefined ? undefined : bounded(item.authorName, 80),
    isBot: item.isBot === true, text: bounded(item.text, textLimit), timestamp: item.timestamp,
    replyTo: item.replyTo === undefined ? undefined : bounded(item.replyTo, 100),
    attachments: item.attachments?.slice(0, 2).map(file => ({ name: bounded(file.name, 80), contentType: file.contentType === undefined ? undefined : bounded(file.contentType, 60) })),
  });
  const serialize = () => JSON.stringify({ preceding: preceding.map(item => compact(item, 400)), CURRENT: compact(message, 1200), recentAssistantReply: followup });
  let state = serialize();
  while (Buffer.byteLength(state) > 8192 && preceding.length) { preceding.shift(); state = serialize(); }
  return { preceding, state };
}
