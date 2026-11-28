import type { Effort } from "../domain.js";

export const ASSISTANT_LIMITS_KEY = "assistant_limits";          // GLOBAL_SETTINGS_SCOPE
export interface AssistantLimits { maxActiveTasks: number; minWakeMinutes: number; maxPendingApprovals: number; approvalTtlHours: number; mentionDebounceMinutes: number }
export const DEFAULT_ASSISTANT_LIMITS: AssistantLimits = { maxActiveTasks: 5, minWakeMinutes: 60, maxPendingApprovals: 20, approvalTtlHours: 168, mentionDebounceMinutes: 5 };
export const ASSISTANT_TICK_MS = 15_000;
export const MAX_TASK_FAILURES = 3;
export const MAX_GOAL_CHARS = 1500;
export const MAX_NOTIFY_CHARS = 1500;

/** Channels. Each one is a web_chats row in PERSONAL_SERVER, so the normal chat view shows it. */
export const assistantHomeChannel = (user: string) => `web:assistant:${user}`;
export const assistantTaskChannel = (task: string) => `web:assistant-task:${task}`;
export const isAssistantChannel = (c: string) => c.startsWith("web:assistant:") || c.startsWith("web:assistant-task:");
/** Notes memory channel of a sprout (personal memory stays `user:<id>`). */
export const assistantTaskMemoryChannel = (task: string) => `assistant-task:${task}`;

export type Wake = { kind: "interval"; minutes: number } | { kind: "cron"; cron: string; timezone: string };
export type RuleEffect = "allow" | "ask" | "block";
export type TaskStatus = "proposed" | "active" | "paused" | "done" | "cancelled" | "declined";
export type TaskPause = "owner" | "failures" | "usage";
export type TriggerKind = "timer" | "mention" | "approval" | "user";

export interface AssistantSettings { user: string; enabled: boolean; briefCron: string | null; timezone: string; dmUpdates: boolean; quietStart: string | null; quietEnd: string | null; updated: number }
export interface AssistantTask {
  id: string; owner: string; goal: string; instructions: string; status: TaskStatus; pause: TaskPause | null;
  wake: Wake; nextAt: number | null; rules: Record<string, RuleEffect>;   // tool name → effect; missing = default
  effort: Effort; failures: number; lastRunAt: number | null; lastError: string | null;
  createdAt: number; updatedAt: number; revision: number;
}
export interface ApprovalRequest {
  id: string; owner: string; task: string | null; run: string; tool: string; input: Record<string, unknown>;
  summary: string; status: "pending" | "approved" | "denied" | "expired" | "failed"; result: string | null;
  createdAt: number; decidedAt: number | null; expiresAt: number;
}
export type ActivityKind = "update" | "brief" | "approval" | "proposal" | "done" | "paused" | "error";
export interface ActivityItem { id: string; owner: string; task: string | null; kind: ActivityKind; text: string; ref: string | null; createdAt: number; readAt: number | null }
export interface Trigger { id: string; owner: string; task: string | null; kind: TriggerKind; payload: Record<string, unknown>; createdAt: number; takenAt: number | null }

/** Set on a Message that an assistant wake makes. The approval gate keys off it. */
export interface AssistantRunTag { owner: string; task: string | null; trigger: TriggerKind }

/** Tools the gate never stops (they only touch the assistant's own state). */
export const ASSISTANT_INTERNAL_TOOLS = ["assistant_notify", "assistant_idle", "task_propose", "task_finish", "task_note"] as const;
/** Default effect when a task has no rule for a tool. */
export const defaultRule = (effect: "read" | "write"): RuleEffect => effect === "read" ? "allow" : "ask";

export interface Notifier { notify(item: ActivityItem, approval?: ApprovalRequest): Promise<void> }
