import { randomUUID } from "node:crypto";
import { ToolError, errorSummary, logError } from "../errors.js";
import type { Message } from "../domain.js";
import { PERSONAL_SERVER } from "../personal.js";
import { toolResult, type AssistantGate, type ToolArgs, type ToolRegistry, type ToolResult } from "../tools.js";
import type { AssistantStore } from "./store.js";
import { assistantHomeChannel, assistantTaskChannel, defaultRule, MAX_NOTIFY_CHARS, type ActivityItem, type ApprovalRequest, type AssistantLimits, type Notifier, type RuleEffect } from "./types.js";

export interface GateDeps {
  store: AssistantStore;
  notifier: Notifier;
  limits(): Promise<AssistantLimits>;
  registry: () => ToolRegistry;
  now?: () => number;
  id?: () => string;
}

const HOUR_MS = 3600e3;
const SUMMARY_JSON_CHARS = 200;

/** Stops a sprout's risky tool calls until the owner approves them. Read calls run by default. */
export class Gate implements AssistantGate {
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(private readonly deps: GateDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.id = deps.id ?? (() => randomUUID());
  }

  async decide(message: Message, name: string, args: ToolArgs, effect: "read" | "write"): Promise<{ run: true } | { result: ToolResult }> {
    const tag = message.assistant;
    if (!tag) return { run: true };
    const task = tag.task ? await this.deps.store.task(tag.task) : undefined;
    const rule: RuleEffect = task?.rules[name] ?? defaultRule(effect);
    if (rule === "allow") return { run: true };
    if (rule === "block") throw new ToolError("Blocked by your rules for this sprout.");
    return { result: await this.queue(message, tag.owner, tag.task, name, args) };
  }

  /** Runs an approved call once, as the owner, then wakes the sprout with the result. `always` also sets the tool's rule to allow. */
  async execute(approvalId: string, user: string, always = false): Promise<ToolResult> {
    const approval = await this.own(approvalId, user);
    const now = this.now();
    if (approval.status === "pending" && approval.expiresAt <= now) {
      await this.deps.store.decideApproval(approval.id, "expired", null, now);
      throw new ToolError("This approval expired.");
    }
    if (approval.status !== "pending") throw new ToolError("Already decided.");
    if (always && approval.task) await this.allowTool(approval.task, approval.tool);
    if (!(await this.deps.store.decideApproval(approval.id, "approved", null, now))) throw new ToolError("Already decided.");

    let result: ToolResult;
    try {
      result = await this.deps.registry().invokeResult(this.approvalMessage(approval), approval.tool, approval.input, `assistant-approval:${approval.id}`, "command");
    } catch (error) {
      const text = errorSummary(error);
      await this.deps.store.setApprovalResult(approval.id, "failed", text);
      await this.wake(approval, { approval: approval.id, tool: approval.tool, error: text });
      await this.addActivity(approval, "error", `${approval.tool} failed after approval: ${text}`.slice(0, MAX_NOTIFY_CHARS), approval.id);
      throw error;
    }
    await this.deps.store.setApprovalResult(approval.id, "approved", result.text);
    await this.wake(approval, { approval: approval.id, tool: approval.tool, result: result.text });
    await this.addActivity(approval, "approval", result.text.slice(0, MAX_NOTIFY_CHARS), approval.id);
    return result;
  }

  async deny(approvalId: string, user: string): Promise<void> {
    const approval = await this.own(approvalId, user);
    if (!(await this.deps.store.decideApproval(approval.id, "denied", null, this.now()))) throw new ToolError("Already decided.");
    await this.wake(approval, { approval: approval.id, denied: true });
  }

  private async queue(message: Message, owner: string, task: string | null, name: string, args: ToolArgs): Promise<ToolResult> {
    const limits = await this.deps.limits();
    if ((await this.deps.store.pendingApprovals(owner)).length >= limits.maxPendingApprovals) throw new ToolError("Too many approvals are waiting. Ask the user to review them.");
    const now = this.now();
    const approval: ApprovalRequest = {
      id: this.id(), owner, task, run: message.id, tool: name, input: args,
      summary: `${name}: ${JSON.stringify(args).slice(0, SUMMARY_JSON_CHARS)}`,
      status: "pending", result: null, createdAt: now, decidedAt: null, expiresAt: now + limits.approvalTtlHours * HOUR_MS,
    };
    await this.deps.store.addApproval(approval);
    const item = await this.addActivity(approval, "approval", `Waiting for your approval: ${approval.summary}`, approval.id);
    // The approval is queued already. A failed DM must not lose it.
    try { await this.deps.notifier.notify(item, approval); } catch (error) { logError("assistant_notify_failed", error, { stage: "assistant approval notify", operationId: approval.id }); }
    return toolResult(`Queued for approval ${approval.id}. Continue without it.`);
  }

  private async own(approvalId: string, user: string): Promise<ApprovalRequest> {
    const approval = await this.deps.store.approval(approvalId);
    if (!approval || approval.owner !== user) throw new ToolError("Not found.");
    return approval;
  }

  /** Sets rules[tool] to allow with a compare-and-set on the task revision. Retries once after a miss. */
  private async allowTool(task: string, tool: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await this.deps.store.task(task);
      if (!current) return;
      const next = { ...current, rules: { ...current.rules, [tool]: "allow" as const }, revision: current.revision + 1, updatedAt: this.now() };
      if (await this.deps.store.putTask(next, current.revision)) return;
    }
    throw new ToolError("The sprout changed while saving the rule. Try again.");
  }

  /** The approved call runs as the request that asked for it (the saved wake message), so tools that cite the request, like memory_remember, find it. The operation id keeps the approval apart. */
  private approvalMessage(approval: ApprovalRequest): Message {
    return {
      id: approval.run, server: PERSONAL_SERVER, surface: "web", author: approval.owner, text: "",
      channel: approval.task ? assistantTaskChannel(approval.task) : assistantHomeChannel(approval.owner),
    };
  }

  private async addActivity(approval: ApprovalRequest, kind: ActivityItem["kind"], text: string, ref: string): Promise<ActivityItem> {
    const item: ActivityItem = { id: this.id(), owner: approval.owner, task: approval.task, kind, text, ref, createdAt: this.now(), readAt: null };
    await this.deps.store.addActivity(item);
    return item;
  }

  private async wake(approval: ApprovalRequest, payload: Record<string, unknown>): Promise<void> {
    await this.deps.store.addTrigger({ id: this.id(), owner: approval.owner, task: approval.task, kind: "approval", payload, createdAt: this.now(), takenAt: null });
  }
}
