// Checks and saves user instructions. WP3 of the user instructions plan fills this in.
import { logError } from "./errors.js";
import type { SafetyCategory, SafetyClassifier } from "./safety.js";
import { INSTRUCTIONS_REJECT_MESSAGES, USER_INSTRUCTIONS_CHECKS_PER_HOUR, USER_INSTRUCTIONS_MAX_CHARS, type InstructionsRejectReason, type InstructionsSaveResult, type InstructionsService, type UserInstructions, type UserInstructionsStore } from "./user-instructions.js";

const HOUR_MS = 60 * 60 * 1000;
// Zero-width and bidi control characters (the isolates U+2066 to U+2069 included), then C0 and C1 controls (DEL too)
// except tab and newline. Runs before the tag match, so a zero-width space inside a tag name is gone first.
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
// A candidate runs from a tag opener to the next opener or closer, on one line. Entities and full-width brackets count.
const TAG_CANDIDATE = /(?:<|＜|&lt;)(?:(?!<|＜|>|＞|&lt;|&gt;)[^\n])*(?:>|＞|&gt;)?/gi;
// The tag itself, tested on the NFKC form of a candidate with its entities decoded.
const TAG = /^<\s*\/?\s*(?:user-instructions|slopbot-system)(?![\w-])[^<>]*>?$/i;

/** Normalizes line ends, removes control and zero-width characters and any user-instructions or slopbot-system tag, trims.
 *  NFKC is applied to each candidate span only to decide whether it is a tag; kept text is returned as written. */
export function cleanInstructions(text: string): string {
  const plain = text.replace(/\r\n?/g, "\n").replace(INVISIBLE, "").replace(CONTROL, "");
  const untagged = plain.replace(TAG_CANDIDATE, span => {
    const folded = span.normalize("NFKC").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
    return TAG.test(folded) ? "" : span;
  });
  return untagged.replace(/\n(?:[ \t]*\n){2,}/g, "\n\n").trim();
}

/** classifier undefined: every non-empty save fails with check_failed (fail closed). */
export class UserInstructionsService implements InstructionsService {
  // Check times per user. Only the last hour is kept.
  private readonly checks = new Map<string, number[]>();

  constructor(private readonly store: UserInstructionsStore, private readonly classifier: SafetyClassifier | undefined, private readonly now: () => number = Date.now) {}

  async get(user: string): Promise<UserInstructions | undefined> {
    return this.store.userInstructions(user);
  }

  async save(user: string, text: string): Promise<InstructionsSaveResult> {
    const cleaned = cleanInstructions(text);
    if (cleaned === "") {
      await this.store.deleteUserInstructions(user);
      return { ok: true, saved: null };
    }
    if ([...cleaned].length > USER_INSTRUCTIONS_MAX_CHARS) return reject("too_long");
    const current = await this.store.userInstructions(user);
    if (current?.text === cleaned) return { ok: true, saved: current };
    if (!this.takeCheck(user)) return reject("rate_limited");
    if (!this.classifier) return reject("check_failed");

    let verdict;
    try {
      verdict = await this.classifier.check({ server: "global", user }, "instructions", cleaned);
    } catch (error) {
      logError("user_instructions_check_failed", error, { stage: "user instructions" }, true);
      return reject("check_failed");
    }
    if (verdict.flagged) {
      console.warn(JSON.stringify({ event: "user_instructions_rejected", user, category: verdict.category }));
      return reject("flagged", verdict.category);
    }
    const updated = this.now();
    await this.store.setUserInstructions(user, cleaned, updated);
    return { ok: true, saved: { text: cleaned, updated } };
  }

  /** Records a check for the user if the hour's budget allows it. */
  private takeCheck(user: string): boolean {
    const at = this.now();
    const recent = (this.checks.get(user) ?? []).filter(time => at - time < HOUR_MS);
    const allowed = recent.length < USER_INSTRUCTIONS_CHECKS_PER_HOUR;
    this.checks.set(user, allowed ? [...recent, at] : recent);
    return allowed;
  }
}

function reject(reason: InstructionsRejectReason, category?: SafetyCategory): InstructionsSaveResult {
  const message = INSTRUCTIONS_REJECT_MESSAGES[reason];
  return category === undefined ? { ok: false, reason, message } : { ok: false, reason, category, message };
}
