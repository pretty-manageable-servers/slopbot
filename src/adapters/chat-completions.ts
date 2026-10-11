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

export class ProviderError extends Error {
  constructor(readonly status: number) {
    super(`AI provider returned HTTP ${status}`);
    this.name = "ProviderError";
  }
}

export function wireMessages(prompt: Prompt): { role: string; content: string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[] }[] {
  return promptItems(prompt).map(item => {
    const text = item.author || item.sourceIds ? JSON.stringify({ ...(item.author ? { author_id: item.author } : {}), ...(item.sourceIds ? { source_ids: item.sourceIds } : {}), text: item.content }) : item.content;
    return { role: item.role, content: item.images?.length ? [{ type: "text" as const, text }, ...item.images.map(image => ({ type: "image_url" as const, image_url: { url: image.url } }))] : text };
  });
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
  private readonly cacheDiagnostics = new PromptCacheDiagnostics();
  constructor(private readonly options: ProviderOptions, private readonly fetcher: typeof fetch = fetch) {}

  async *stream(prompt: Prompt, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    const phase = prompt.prefixVersion.startsWith("participation") ? "decision model" : prompt.purpose === "checkpoint" ? "checkpoint model" : prompt.purpose === "inspection" ? "inspection model" : "reply model";
    const messages = wireMessages(prompt);
    yield { kind: "opaque", payload: this.cacheDiagnostics.compare(prompt, messages) };
    const response = await requestTimings.wait(`${phase} response headers`, () => this.fetcher(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify({ model: this.options.model, messages, stream: true, stream_options: { include_usage: true }, ...(prompt.maxOutputTokens ? { max_tokens: prompt.maxOutputTokens } : {}) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? 120_000)]) : AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
    }));
    if (!response.ok) { await response.body?.cancel(); throw new ProviderError(response.status); }
    if (!response.body) throw new Error("Provider returned an empty stream");
    let completed = false;
    let fullText = "";
    const nativeCalls = new Map<number, { name: string; arguments: string }>();
    for await (const data of sseData(response.body, `${phase} stream read`)) {
      if (data === "[DONE]") { completed = true; break; }
      const chunk = record(JSON.parse(data));
      // Preserve the complete original provider chunk, including unknown reasoning formats.
      yield { kind: "opaque", payload: chunk as Json };
      if (chunk.error) throw new Error("Provider reported a stream error");
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
            const parts = nativeCalls.get(index) ?? { name: "", arguments: "" };
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
        if (choice.finish_reason === "length") throw new Error("Provider reached its output limit; response is incomplete");
      }
    }
    if (!completed) throw new Error("Provider stream ended before completion");
    if (nativeCalls.size) {
      const calls = [...nativeCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => {
        const args = record(JSON.parse(call.arguments));
        if (!/^[a-z][a-z0-9_]{0,31}$/.test(call.name)) throw new Error("Invalid tool name");
        return { name: call.name, arguments: args as Json };
      });
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
