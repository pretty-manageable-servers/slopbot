import { createHash } from "node:crypto";
import type { Json, Prompt, PromptItem } from "./domain.js";
import type { TokenCounter } from "./context.js";
import type { ToolResult } from "./tools.js";
// Sort structural keys only. Array order and literal user/model text are preserved.
export function stableJson(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, value]) => [key, canonical(value)]),
          )
        : item;
  return JSON.stringify(canonical(value));
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export class PromptCacheDiagnostics {
  private readonly lanes = new Map<string, string[]>();
  compare(prompt: Prompt, messages: readonly unknown[]): Json {
    const lane = hash(
      prompt.cacheScope ??
        `${prompt.purpose ?? "reply"}:${prompt.prefixVersion}`,
    );
    const fingerprints = messages.map((message) => hash(stableJson(message)));
    const previous = this.lanes.get(lane);
    let common = 0;
    while (
      previous &&
      common < Math.min(previous.length, fingerprints.length) &&
      previous[common] === fingerprints[common]
    )
      common++;
    const relation = !previous
      ? "first"
      : common === previous.length
        ? fingerprints.length === previous.length
          ? "repeat"
          : "append"
        : "branch";
    this.lanes.delete(lane);
    this.lanes.set(lane, fingerprints);
    if (this.lanes.size > 128)
      this.lanes.delete(this.lanes.keys().next().value!);
    return {
      type: "client_prompt_cache",
      lane,
      prefix_fingerprint: hash(
        stableJson(messages.slice(0, prompt.prefix.length)),
      ),
      relation,
      unchanged_messages: common,
      total_messages: fingerprints.length,
      ...(previous && common < previous.length
        ? { changed_at_message: common }
        : {}),
    };
  }
}
export function appendToolEvidence(
  name: string,
  output: ToolResult,
  base: readonly PromptItem[],
  counter: TokenCounter,
  limit: number,
): PromptItem {
  const max = Math.min(output.text.length, 2000);
  const build = (length: number): PromptItem => ({
    role: "user",
    contextOnly: true,
    content: JSON.stringify({
      tool: name,
      result: {
        ...output,
        ...(output.ui ? { ui: { type: output.ui.type, prepared: true } } : {}),
        text:
          output.text.slice(0, length) +
          (length < output.text.length
            ? " [truncated for context; full result is in the action log]"
            : ""),
      },
    }),
  });
  if (counter.count([...base, build(0)]) > limit)
    throw new Error(
      "Context budget boundary reached; original prompts and tool results are retained. Start a fresh request to continue.",
    );
  let left = 0,
    right = max;
  while (left < right) {
    const middle = Math.ceil((left + right) / 2);
    if (counter.count([...base, build(middle)]) <= limit) left = middle;
    else right = middle - 1;
  }
  return build(left);
}
