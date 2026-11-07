// The safety check contract. The vane adapter (src/adapters/safety-classifier.ts) implements it. Saved user
// instructions use it now; the safety classifier plan reuses it for prompts and tool results.
import type { Attribution } from "./usage-meter.js";

export const SAFETY_CATEGORIES = ["safe", "jailbreak", "illegal", "self_harm", "sexual_minors", "violence_weapons", "other_harm"] as const;
export type SafetyCategory = typeof SAFETY_CATEGORIES[number];
/** What the text is. "instructions" is a user's saved instructions. */
export type SafetySource = "prompt" | "tool" | "web" | "instructions";
/** flagged is true when probabilities.safe is below the threshold. category is the most likely category. */
export interface SafetyVerdict { flagged: boolean; category: SafetyCategory; probabilities: Record<SafetyCategory, number> }
export interface SafetyClassifier {
  /** Charges the call to `who` (undefined: not charged). Throws on any endpoint error or timeout; the caller decides fail open or closed. */
  check(who: Attribution | undefined, source: SafetySource, text: string, signal?: AbortSignal): Promise<SafetyVerdict>;
}
/** Global settings. Threshold default SAFETY_DEFAULT_THRESHOLD. */
export const SAFETY_SETTINGS = { toolCheck: "safety_tool_check", threshold: "safety_threshold" } as const;
export const SAFETY_DEFAULT_THRESHOLD = 0.5;
