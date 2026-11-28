import type { ActivityItem, ApprovalRequest, AssistantSettings, AssistantTask, Trigger } from "./types.js";

export interface AssistantStore {
  settings(user: string): Promise<AssistantSettings | undefined>;
  putSettings(s: AssistantSettings): Promise<void>;
  tasks(owner: string): Promise<AssistantTask[]>;
  task(id: string): Promise<AssistantTask | undefined>;
  putTask(t: AssistantTask, expectedRevision: number | null): Promise<boolean>;   // CAS; null = insert
  dueTasks(now: number, limit: number): Promise<AssistantTask[]>;                 // active, nextAt <= now
  dueBriefs(now: number, limit: number): Promise<AssistantSettings[]>;            // enabled, brief_cron set, brief_next_at <= now
  setBriefNextAt(user: string, at: number | null): Promise<void>;
  addTrigger(t: Trigger): Promise<void>;
  takeTriggers(owner: string, now: number): Promise<Trigger[]>;                    // sets takenAt
  addApproval(a: ApprovalRequest): Promise<void>;
  approval(id: string): Promise<ApprovalRequest | undefined>;
  decideApproval(id: string, status: ApprovalRequest["status"], result: string | null, now: number): Promise<boolean>; // only from pending
  pendingApprovals(owner: string): Promise<ApprovalRequest[]>;
  addActivity(a: ActivityItem): Promise<void>;
  activity(owner: string, before: number | null, limit: number): Promise<ActivityItem[]>;
  markRead(owner: string, ids: string[], now: number): Promise<void>;
}
