import { providerError, RequestError } from "../errors.js";
import { ModelAliases } from "./model-aliases.js";
import { requestTimings } from "../request-timing.js";
import {PromptCacheDiagnostics} from '../prompt-cache.js';
import { promptItems, type Json, type ModelEvent, type Prompt } from "../domain.js";
import type { LLM } from "../ports.js";

export interface ProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

export { ProviderError } from "../errors.js";

export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}
export function wireMessages(prompt: Prompt): WireMessage[] {
  const items = promptItems(prompt), messages: WireMessage[] = [];
  const ordinary = (item: typeof items[number]): WireMessage => {
    const text = item.author || item.sourceIds ? JSON.stringify({ ...(item.author ? { author_id: item.author } : {}), ...(item.sourceIds ? { source_ids: item.sourceIds } : {}), text: item.content }) : item.content;
    return { role: item.role, content: item.images?.length ? [{ type: 'text', text }, ...item.images.map(image => ({ type: 'image_url' as const, image_url: { url: image.url } }))] : text };
  };
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    if (item.role === 'assistant' && item.toolCalls?.length) {
      const results = items.slice(index + 1, index + 1 + item.toolCalls.length);
      const expected = new Set(item.toolCalls.map(call => call.id));
      const actual = new Set(results.map(result => result.toolCallId));
      if (results.length === expected.size && actual.size === expected.size && results.every(result => result.role === 'tool' && result.toolCallId && expected.has(result.toolCallId))) {
        messages.push({ role: 'assistant', content: item.content || null, tool_calls: item.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) });
        for (const result of results) messages.push({ role: 'tool', tool_call_id: result.toolCallId!, content: result.content });
        index += results.length;
      } else {
        // Checkpoint/source invalidation may split an old pair. Keep the surviving
        // evidence without emitting an invalid assistant/tool protocol sequence.
        messages.push({ role: 'user', content: JSON.stringify({ recorded_tool_activity: item }) });
      }
    } else if (item.role === 'tool') messages.push({ role: 'user', content: JSON.stringify({ recorded_tool_result: item }) });
    else messages.push(ordinary(item));
  }
  return messages;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid provider response");
  return value as Record<string, unknown>;
}

export async function* sseData(body: ReadableStream<Uint8Array>, waitLabel = "model stream read"): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let lines: string[] = [];
  function consume(line: string): string | undefined {
    if (line === "") {
      const data = lines.length ? lines.join("\n") : undefined;
      lines = [];
      return data;
    }
    if (line.startsWith("data:")) lines.push(line.slice(5).replace(/^ /, ""));
    return undefined;
  }
  try {
    while (true) {
      const { done, value } = await requestTimings.wait(waitLabel, () => reader.read());
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (pending.length > 2_000_000) throw new Error("Provider event exceeds stream limit");
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        const data = consume(line);
        if (data !== undefined) yield data;
      }
      if (done) {
        if (pending) consume(pending.replace(/\r$/, ""));
        const data = consume("");
        if (data !== undefined) yield data;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class ChatCompletionsLLM implements LLM {
  private readonly aliases: ModelAliases;
  private readonly cacheDiagnostics = new PromptCacheDiagnostics();
  constructor(private readonly options: ProviderOptions, private readonly fetcher: typeof fetch = fetch) { this.aliases = new ModelAliases(options.baseUrl); }

  async *stream(prompt: Prompt, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    const phase = prompt.prefixVersion.startsWith("participation") ? "decision model" : prompt.purpose === "checkpoint" ? "checkpoint model" : prompt.purpose === "inspection" ? "inspection model" : "reply model";
    const messages = wireMessages(prompt);
    yield { kind: "opaque", payload: this.cacheDiagnostics.compare(prompt, messages) };
    const response = await this.aliases.request(this.options.model, model => requestTimings.wait(`${phase} response headers`, () => this.fetcher(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify({ model, messages, ...(prompt.tools?.length ? { tools: prompt.tools, tool_choice: "auto" } : {}), stream: true, stream_options: { include_usage: true }, ...(prompt.maxOutputTokens ? { max_tokens: prompt.maxOutputTokens } : {}) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? 120_000)]) : AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
    })));
    if (!response.ok) { throw await providerError(response); }
    if (!response.body) throw new Error("Provider returned an empty stream");
    let completed = false;
    let fullText = "";
    const nativeCalls = new Map<number, { id?: string; name: string; arguments: string }>();
    for await (const data of sseData(response.body, `${phase} stream read`)) {
      if (data === "[DONE]") { completed = true; break; }
      const chunk = record(JSON.parse(data));
      // Preserve the complete original provider chunk, including unknown reasoning formats.
      yield { kind: "opaque", payload: chunk as Json };
      if (chunk.error) {
        const detail = typeof chunk.error === "object" ? chunk.error as { code?: unknown; message?: unknown } : {};
        throw new RequestError("PROVIDER_STREAM_ERROR", `Provider reported a stream error${typeof detail.code === "string" ? ` (${detail.code})` : ""}.`, "Inspect provider availability and the recorded stream before retrying.", {}, typeof detail.message === "string" ? { cause: new Error(detail.message) } : undefined);
      }
      if (chunk.usage) yield { kind: "usage", payload: chunk.usage as Json };
      if (!Array.isArray(chunk.choices)) throw new Error("Provider response is missing choices");
      for (const choiceValue of chunk.choices) {
        const choice = record(choiceValue);
        if (choice.index !== 0) continue;
        const delta = record(choice.delta ?? {});
        if (delta.tool_calls !== undefined) {
          if (!Array.isArray(delta.tool_calls)) throw new Error("Invalid native tool calls");
          for (const value of delta.tool_calls) {
            const call = record(value), index = call.index;
            if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= 8) throw new Error("Invalid tool call index");
            const parts: { id?: string; name: string; arguments: string } = nativeCalls.get(index) ?? { name: "", arguments: "" };
            if (call.id !== undefined) {
              if (typeof call.id !== "string" || !call.id || call.id.length > 256 || parts.id && parts.id !== call.id) throw new RequestError("PROVIDER_TOOL_PROTOCOL", "Provider returned an invalid or changing tool call ID.", "Inspect the provider stream before retrying.");
              parts.id = call.id;
            }
            const fn = record(call.function ?? {});
            if (fn.name !== undefined) { if (typeof fn.name !== "string") throw new Error("Invalid tool name"); parts.name += fn.name; }
            if (fn.arguments !== undefined) { if (typeof fn.arguments !== "string") throw new Error("Invalid tool arguments"); parts.arguments += fn.arguments; }
            if (parts.arguments.length > 64000) throw new Error("Tool arguments exceed limit");
            nativeCalls.set(index, parts);
          }
        }
        if (delta.reasoning_content !== undefined || delta.reasoning !== undefined) {
          yield { kind: "reasoning", payload: delta as Json };
        }
        if (delta.content !== undefined && delta.content !== null) {
          if (typeof delta.content !== "string") throw new Error("Provider content must be text");
          fullText += delta.content;
          yield { kind: "text", payload: { text: delta.content } };
        }
        if (choice.finish_reason === "length") throw new RequestError("MODEL_OUTPUT_LIMIT", `Provider reached its output limit of ${prompt.maxOutputTokens ?? "the provider default"} tokens; response is incomplete.`, "Increase OUTPUT_TOKENS or request a shorter response. Partial output and completed tools are retained.", { maxOutputTokens: prompt.maxOutputTokens ?? "provider default", purpose: prompt.purpose ?? "reply" });
      }
    }
    if (!completed) throw new Error("Provider stream ended before completion");
    if (nativeCalls.size) {
      const calls = [...nativeCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => {
        const args = record(JSON.parse(call.arguments));
        if (!/^[a-z][a-z0-9_]{0,31}$/.test(call.name)) throw new Error("Invalid tool name");
        if (prompt.tools?.length && !call.id) throw new RequestError("PROVIDER_TOOL_PROTOCOL", "Provider returned a tool call without its ID.", "Inspect the provider stream before retrying.");
        return { name: call.name, arguments: args as Json, ...(call.id ? { id: call.id } : {}) };
      });
      const ids = calls.flatMap(call => call.id ? [call.id] : []);
      if (new Set(ids).size !== ids.length) throw new RequestError("PROVIDER_TOOL_PROTOCOL", "Provider returned duplicate tool call IDs.", "Inspect the provider stream before retrying.");
      yield { kind: "tool_call", payload: calls };
    } else {
      // Raw text has already been journaled. Malformed template calls must reach
      // the runner's protocol repair path, never terminate generation here.
      let calls: ReturnType<typeof gemmaToolCalls>;
      try { calls = gemmaToolCalls(fullText); } catch { calls = undefined; }
      if (calls) yield { kind: "tool_call", payload: calls };
    }
  }
}

// Some llama.cpp Gemma templates emit these markers as ordinary text.
// Accept only a complete tool-call response, never markers quoted inside prose.
export function gemmaToolCalls(text: string): { name: string; arguments: Json }[] | undefined {
  if (!text.trim().startsWith("<|tool_call>")) return undefined;
  const calls: { name: string; arguments: Json }[] = [];
  let pending = text.trim();
  while (pending) {
    const match = /^<\|tool_call>call:([a-z][a-z0-9_]{0,31})([\s\S]*?)<tool_call\|>/.exec(pending);
    if (!match || calls.length >= 8) throw new Error("Malformed Gemma tool call");
    calls.push({ name: match[1]!, arguments: record(JSON.parse(match[2]!)) as Json });
    pending = pending.slice(match[0].length).trim();
  }
  return calls;
}
