// Keep error reporting independent of adapters so every boundary uses the same format.
export { DEFAULT_MAX_TOOL_ROUNDS } from './generation-policy.js';
export class RequestError extends Error {
  override name = 'RequestError';
  constructor(readonly code: string, message: string, readonly recovery: string, readonly details: Record<string, string | number> = {}, options?: ErrorOptions) { super(message, options); }
}
export class ToolError extends Error {
  override name = 'ToolError';
  constructor(message: string, readonly status: 'rejected' | 'failed' = 'rejected', options?: ErrorOptions) { super(message, options); }
}
export class UncertainActionError extends Error { override name = 'UncertainActionError'; }
export class ProviderError extends Error {
  override name = 'ProviderError';
  constructor(readonly status: number, options?: ErrorOptions, readonly providerCode?: string) { super(`AI provider returned HTTP ${status}`, options); }
}
export interface ErrorContext { stage?: string; server?: string; channel?: string; messageId?: string; jobId?: string; runId?: string; tool?: string; operationId?: string; round?: number }
const contexts = new WeakMap<Error, ErrorContext>();
export function errorContext(error: unknown, context: ErrorContext): Error {
  const value = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Non-Error exception');
  contexts.set(value, { ...context, ...contexts.get(value) });
  return value;
}
export function redactErrorText(text: string): string {
  let clean = text;
  for (const [key, value] of Object.entries(process.env)) {
    if (/(TOKEN|SECRET|PASSWORD|API_KEY|DATABASE_URL)/i.test(key) && value && value.length >= 6) clean = clean.split(value).join('[redacted]');
  }
  return clean
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:token|key|api_key|access_token|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/((?:["']?)(?:[\w-]*(?:token|secret|password|api[_-]?key)|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|pms_(?:sk_)?[A-Za-z0-9_-]{20,})\b/g, '[redacted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ');
}
export function describeError(error: unknown) {
  const value = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Non-Error exception');
  const causes: string[] = [], seen = new Set<unknown>([value]);
  let cause: unknown = value.cause;
  while (cause instanceof Error && !seen.has(cause) && causes.length < 4) {
    seen.add(cause); const code = (cause as Error & { code?: unknown }).code;
    causes.push(redactErrorText(`${cause.name}${code !== undefined ? ` (${String(code)})` : ''}: ${cause.message}`).slice(0, 400)); cause = cause.cause;
  }
  const nativeCode = (value as Error & { code?: unknown }).code;
  const code = value instanceof RequestError ? value.code : value instanceof UncertainActionError ? 'ACTION_UNCERTAIN'
    : value instanceof ToolError ? value.status === 'failed' ? 'TOOL_FAILED' : 'TOOL_BLOCKED'
    : value instanceof ProviderError ? value.providerCode ? `PROVIDER_${value.providerCode.toUpperCase()}` : `PROVIDER_HTTP_${value.status}`
    : value.name === 'HarnessInterrupted' ? 'REQUEST_INTERRUPTED'
    : value.name === 'TimeoutError' ? 'REQUEST_TIMEOUT' : value.name === 'AbortError' ? 'REQUEST_ABORTED' : nativeCode !== undefined ? String(nativeCode) : 'UNEXPECTED_ERROR';
  const recovery = value instanceof RequestError ? value.recovery : value instanceof UncertainActionError ? 'Inspect the recorded action before retrying; it may already have happened.'
    : value instanceof ProviderError ? value.status === 402 ? 'The key or account budget is spent. Check the budget; retrying without a budget change will not help.' : value.status === 413 ? 'Reduce the request size before retrying.' : value.status === 401 || value.status === 403 ? 'Check the AI key and model access.' : value.status === 400 || value.status === 404 ? 'Check the provider endpoint and model configuration.' : value.status === 429 ? 'Wait for the provider rate limit to reset, then retry.' : 'Check provider availability, then retry.'
    : value instanceof ToolError ? value.status === 'rejected' ? 'Correct the arguments, permissions, or configuration described above.' : 'Check the tool or service, then retry.'
    : value.name === 'HarnessInterrupted' ? 'Send a new message to continue from recorded progress.' : 'Use the error code and request ID to inspect the logs before retrying.';
  return { ...(value instanceof ProviderError ? { httpStatus: value.status } : {}), code: redactErrorText(code).slice(0, 100), name: redactErrorText(value.name), message: redactErrorText(value.message).slice(0, 600), recovery: redactErrorText(recovery),
    causes, context: Object.fromEntries(Object.entries(contexts.get(value) ?? {}).map(([key, val]) => [key, typeof val === "string" ? redactErrorText(val) : val])) as ErrorContext, ...(value instanceof RequestError ? { details: Object.fromEntries(Object.entries(value.details).map(([key, val]) => [key, typeof val === 'string' ? redactErrorText(val) : val])) } : {}),
    frames: value.stack?.split('\n').slice(1, 9).map(line => redactErrorText(line.trim())) ?? [] };
}
export function errorSummary(error: unknown): string {
  const info = describeError(error);
  return `[${info.code}] ${info.context.stage ? `${info.context.stage}: ` : ''}${info.message}${info.causes.length ? ` Caused by ${info.causes.join(' -> ')}` : ''}`.slice(0, 1000);
}
export function errorReply(error: unknown, jobId?: string): string {
  const info = describeError(error);
  const escape = (text: string) => text.replace(/[\\`*_~<>|\[\]]/g, '\\$&');
  return `${escape(errorSummary(error))}\n${escape(info.recovery)}${jobId ? `\nJob ID: ${escape(jobId)}` : ''}`;
}
export function logError(event: string, error: unknown, context: ErrorContext = {}, warning = false): void {
  const info = describeError(error);
  const line = JSON.stringify({ type: 'error', event: redactErrorText(event), ...info, context: Object.fromEntries(Object.entries({ ...context, ...info.context }).map(([key, val]) => [key, typeof val === "string" ? redactErrorText(val) : val])) });
  if (warning) console.warn(line); else console.error(line);
}

export async function providerError(response: Response): Promise<ProviderError> {
  let code: string | undefined, message: string | undefined;
  if (response.headers.get('content-type')?.includes('application/json') && response.body && !response.bodyUsed) {
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (size <= 16000) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; chunks.push(chunk.value); }
      if (size <= 16000) {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: { code?: unknown; message?: unknown } };
        if (typeof data.error?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(data.error.code)) code = data.error.code;
        if (typeof data.error?.message === 'string') message = redactErrorText(data.error.message).slice(0, 600);
      }
    } catch { /* An invalid error envelope must still retain its HTTP status. */ }
    finally { await reader.cancel().catch(error => logError('provider_error_body_cleanup_failed', error, {}, true)); }
  } else await response.body?.cancel().catch(error => logError('provider_error_body_cleanup_failed', error, {}, true));
  return new ProviderError(response.status, message ? { cause: new Error(message) } : undefined, code);
}
