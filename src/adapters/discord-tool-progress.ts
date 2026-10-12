import { logError } from "../errors.js";
import type { ToolActivity } from '../tool-activity.js';
import { toolProgress } from '../presentation/tool-activity.js';
interface StatusMessage { edit(content: string): Promise<unknown>; delete(): Promise<unknown>; }
export class DiscordToolProgress {
  private readonly requests = new Map<string, {steps: ToolActivity[]; message?: StatusMessage}>();
  async update(key: string, activity: ToolActivity, send: (content: string) => Promise<StatusMessage>): Promise<void> {
    let request=this.requests.get(key);
    if(!request){request={steps:[]};this.requests.set(key,request);if(this.requests.size>1000)this.requests.delete(this.requests.keys().next().value!);}
    const index=request.steps.findIndex(step=>step.id===activity.id);
    if(index<0)request.steps.push(activity);else request.steps[index]=activity;
    const text=toolProgress(request.steps);
    if(request.message) await request.message.edit(text);else request.message=await send(text);
  }
  async finish(key: string): Promise<void> {
    const request=this.requests.get(key);this.requests.delete(key);
    await request?.message?.delete().catch(error => logError("tool_progress_cleanup_failed", error, { stage: "Discord status cleanup" }, true));
  }
}
