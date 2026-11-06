// Server settings: the limits of the number fields, the fraction-to-percent mapping of the participation cutoffs and
// the bodies the form sends. Kept apart from server.tsx so they test without the UI.
import type { ServerSettings, SettingArgs } from "../../api-types";

export interface Range { min: number; max: number }

/** The limits of the number fields, as the old console's inputs had them (jev context is at most 5). */
export const RANGES = {
  cutoff: { min: 0, max: 100 },
  jevContext: { min: 0, max: 5 },
  replyContext: { min: 0, max: 100 },
  cooldownSeconds: { min: 0, max: 3600 },
  repliesPerHour: { min: 0, max: 1000 },
} satisfies Record<string, Range>;

export const VOICE_MAX_LENGTH = 1000;

export interface Cutoffs { addressed: number; respond: number; unsolicited: number; funny: number }

/** The snapshot keeps cutoffs as fractions 0..1 and the form shows percents: 0.35 is 35. */
export const toPercent = (fraction: number) => Math.round(fraction * 100);

export const cutoffsFrom = (thresholds: ServerSettings["participation_thresholds"]): Cutoffs => ({
  addressed: toPercent(thresholds.addressed),
  respond: toPercent(thresholds.respond),
  unsolicited: toPercent(thresholds.unsolicited),
  funny: toPercent(thresholds.funny),
});

/** The calibration save. The setting takes percents, so the form's numbers go as they are. */
export const calibrationArgs = (cutoffs: Cutoffs): SettingArgs["calibration"] => ({
  action: "set",
  addressed: cutoffs.addressed,
  respond: cutoffs.respond,
  unsolicited: cutoffs.unsolicited,
  funny: cutoffs.funny,
});

export interface NumberCheck { label: string; value: number; range: Range }

/** The number fields that are not a whole number in their range (NaN from an empty field too). Save waits for none. */
export const badNumbers = (checks: NumberCheck[]) =>
  checks.filter(({ value, range }) => !Number.isInteger(value) || value < range.min || value > range.max);

/** The voice instructions as the setting takes them: trimmed. */
export const voiceArgs = (instructions: string): SettingArgs["voice"] => ({ action: "style", instructions: instructions.trim() });

/** "default" resets the voice to the bot's own. */
export const VOICE_RESET = voiceArgs("default");
