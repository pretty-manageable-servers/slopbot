import { createHash } from 'node:crypto';
import type { Message } from './domain.js';
import { RequestError } from './errors.js';

export const toolProgressFooter = 'Live tool status';
export function legacyToolProgress(message: Pick<Message, 'text' | 'isBot'>): boolean {
  return message.isBot === true && /^\*\*Working\*\*\r?\n(?:Earlier steps: \d+\r?\n)?\d+\. `[a-z][a-z0-9_]{0,31}`: (?:running|completed|blocked|failed|delegated)(?:[ ,|:\n]|$)/.test(message.text);
}

// Discord signatures authorize transport; the asset path identifies the source.
export function stableAttachmentUrl(value: string): string {
  try {
    const url = new URL(value);
    if (['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)) {
      for (const key of ['ex', 'is', 'hm']) url.searchParams.delete(key);
    }
    return url.href;
  } catch { return value; }
}

// Normalization appends media descriptions; they are not authored instructions.
export function authoredSourceText(message: Message): string {
  for (const stable of [false, true]) {
    const labels = (message.attachments ?? []).map(item => `[Attachment ${item.name}, type ${item.contentType ?? 'unknown'}: ${stable ? stableAttachmentUrl(item.url) : item.url}; content not inspected]`).join('\n');
    if (labels && message.text === labels) return '';
    if (labels && message.text.endsWith('\n' + labels)) return message.text.slice(0, -labels.length - 1);
  }
  return message.text;
}
export function sourceFingerprint(message: Message, includePreviews = false): string {
  const parts: unknown[] = [authoredSourceText(message), message.author, message.timestamp];
  if (message.isBot === true) parts.push({ isBot: true });
  if (message.replyTo) parts.push({ replyTo: message.replyTo });
  const attachments = message.attachments?.filter(item => includePreviews || !item.preview);
  if (attachments?.length) parts.push(attachments.map(attachment => ({ ...attachment, url: stableAttachmentUrl(attachment.url) })));
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export interface ContextChange { reason: string; sourceId?: string; originChannel?: string }
export function contextChangedError(message: Message, lastChange: unknown = {}, extra: Record<string, string | number> = {}): RequestError {
  const change = lastChange && typeof lastChange === 'object' ? lastChange as Record<string, unknown> : {};
  const reason = typeof change.reason === 'string' ? change.reason : 'source_or_scope_changed';
  const sourceId = typeof change.sourceId === 'string' ? change.sourceId : 'unknown';
  const originChannel = typeof change.originChannel === 'string' ? change.originChannel : message.channel;
  return new RequestError('CONTEXT_CHANGED', `Saved tool context is stale (${reason}${sourceId !== 'unknown' ? `, source ${sourceId}` : ''}). The remaining plan cannot use the previous evidence.`,
    'Submit a fresh request using current sources. Completed tool results and original logs are retained; review completed actions before repeating them.',
    { server: message.server, channel: message.channel, messageId: message.id, reason, sourceId, originChannel, ...extra });
}
