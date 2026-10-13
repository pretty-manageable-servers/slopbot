import { logError } from "../errors.js";
import type { ToolActivity } from '../tool-activity.js';
import { toolProgress } from '../presentation/tool-activity.js';
interface StatusMessage { edit(content: string): Promise<unknown>; delete(): Promise<unknown>; }
export class DiscordToolProgress {
  private readonly requests = new Map<string, {steps: ToolActivity[]; message?: StatusMessage}>();
  private readonly pending = new Map<string, Promise<void>>();
  async update(key: string, activity: ToolActivity, send: (content: string) => Promise<StatusMessage>): Promise<void> {
    return this.serialize(key, async () => {
      let request = this.requests.get(key);
      if (!request) {
        request = {steps: []};
        this.requests.set(key, request);
        if (this.requests.size > 1000) this.requests.delete(this.requests.keys().next().value!);
      }
      const index = request.steps.findIndex(step => step.id === activity.id);
      if (index < 0) request.steps.push(activity);
      else request.steps[index] = activity;
      const content = toolProgress(request.steps);
      if (request.message) await request.message.edit(content);
      else request.message = await send(content);
    });
  }
  async finish(key: string): Promise<void> {
    return this.serialize(key, async () => {
      const request = this.requests.get(key);
      this.requests.delete(key);
      await request?.message?.delete().catch(error => logError("tool_progress_cleanup_failed", error, { stage: "Discord status cleanup" }, true));
    });
  }
  private async serialize(key: string, action: () => Promise<void>): Promise<void> {
    // Program tools can report several child calls concurrently.
    const next = (this.pending.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
    this.pending.set(key, next);
    try { await next; }
    finally { if (this.pending.get(key) === next) this.pending.delete(key); }
  }
}
