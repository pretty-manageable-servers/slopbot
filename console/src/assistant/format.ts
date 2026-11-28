// Words and options for Bud's screens: sprout statuses and pauses, wakes, rule effects and efforts, activity kinds.
import type { ActivityKind, TaskPause, TaskStatus, Wake } from "../api-types";
import type { BadgeTone } from "slop-ui-components";

export const STATUS_LABEL: Record<TaskStatus, string> = { proposed: "Proposed", active: "Active", paused: "Paused", done: "Done", cancelled: "Cancelled", declined: "Declined" };
export const STATUS_TONE: Record<TaskStatus, BadgeTone> = { proposed: "info", active: "success", paused: "warning", done: "neutral", cancelled: "neutral", declined: "neutral" };
/** The order of the sprouts list: what waits for the user first. */
export const STATUS_ORDER: Record<TaskStatus, number> = { proposed: 0, active: 1, paused: 2, done: 3, cancelled: 4, declined: 5 };
export const PAUSE_LABEL: Record<TaskPause, string> = { owner: "Paused by you", failures: "Paused after repeated failures", usage: "Paused at the usage limit" };
export const KIND_LABEL: Record<ActivityKind, string> = { update: "Update", brief: "Brief", approval: "Approval", proposal: "Proposal", done: "Done", paused: "Paused", error: "Error" };

export const RULE_EFFECTS = [{ id: "allow", label: "Allow" }, { id: "ask", label: "Ask first" }, { id: "block", label: "Block" }] as const;
export const EFFORTS = [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "xhigh", label: "Extra high" }] as const;

export const wakeText = (wake: Wake) => wake.kind === "interval" ? `Every ${wake.minutes} min` : `${wake.cron} (${wake.timezone})`;
