// Checks and saves user instructions. WP3 of the user instructions plan fills this in.
import type { SafetyClassifier } from "./safety.js";
import type { InstructionsSaveResult, InstructionsService, UserInstructions, UserInstructionsStore } from "./user-instructions.js";

/** Normalizes line ends, removes control and zero-width characters and any user-instructions or slopbot-system tag, trims. */
export function cleanInstructions(_text: string): string { throw new Error("not implemented"); }

/** classifier undefined: every non-empty save fails with check_failed (fail closed). */
export class UserInstructionsService implements InstructionsService {
  constructor(private readonly store: UserInstructionsStore, private readonly classifier: SafetyClassifier | undefined, private readonly now: () => number = Date.now) {}
  async get(_user: string): Promise<UserInstructions | undefined> { void this.store; throw new Error("not implemented"); }
  async save(_user: string, _text: string): Promise<InstructionsSaveResult> { void this.classifier; void this.now; throw new Error("not implemented"); }
}
