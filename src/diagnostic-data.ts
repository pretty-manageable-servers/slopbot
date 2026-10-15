import type { Json } from './domain.js';
import { redactErrorText } from './errors.js';

// Preserve line breaks while redacting credentials on every line.
export const diagnosticText = (text: string, max = 16000) => text.replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/g, '[redacted]').split('\n').map(line => redactErrorText(line).replace(/@(everyone|here)/gi, '@\u200b$1')).join('\n').slice(0, max);
export function safeDiagnosticData(value: Json): Json {
  if (typeof value === 'string') return diagnosticText(value);
  if (Array.isArray(value)) return value.map(safeDiagnosticData);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /token|secret|password|authorization|cookie|api[_-]?key|private[_-]?key/i.test(key) ? '[redacted]' : safeDiagnosticData(item)]));
  return value;
}
export function diagnosticArgs(value: Json): Json {
  const safe = safeDiagnosticData(value), serialized = JSON.stringify(safe);
  if (Buffer.byteLength(serialized) <= 2048) return safe;
  let excerpt = serialized.slice(0, 1900);
  while (Buffer.byteLength(JSON.stringify({ excerpt, truncated: true })) > 2048) excerpt = excerpt.slice(0, Math.floor(excerpt.length * 0.8));
  return { excerpt, truncated: true };
}
