import { randomUUID } from "node:crypto";
import { requestTimings } from "./request-timing.js";
import type { Message, Reply } from "./domain.js";
import { ProviderError } from "./adapters/chat-completions.js";
import { UncertainActionError } from "./tools.js";

export interface Job {
  id: string; message: Message; status: "pending" | "running" | "ready" | "sending" | "done" | "failed" | "blocked" | "cancelled";
  reply: Reply | null; attempts: number; error: string | null;
}
export interface QueueStore {
  enqueueJob(message: Message): Job | Promise<Job>;
  acquireWorker(server: string, owner: string, expires: number): boolean | Promise<boolean>;
  releaseWorker(server: string, owner: string): void | Promise<void>;
  recoverJobs(server: string): void | Promise<void>;
  claimJob(server: string): Job | undefined | Promise<Job | undefined>;
  readyJob(id: string, reply: Reply): void | Promise<void>;
  finishJob(id: string): void | Promise<void>;
  retryLater(id: string, at: number): void | Promise<void>;
  failJob(id: string, error: string, blocked: boolean): void | Promise<void>;
  hasBlocked(server: string, channel: string): boolean | Promise<boolean>;
  hasPendingOther(server: string, channel: string, messageId: string): boolean | Promise<boolean>;
  jobs(server: string, channel: string): Job[] | Promise<Job[]>;
  retryJob(server: string, channel: string, id: string): boolean | Promise<boolean>;
}
export class TaskWorker {
  private readonly owner = randomUUID();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopping = false;
  private active = new Set<Promise<void>>();
  private started = false;
  private pumping = false;
  private ticking = false;
  constructor(private readonly server: string, private readonly store: QueueStore,
    private readonly run: (message: Message) => Promise<Reply | undefined>,
    private readonly deliver: (message: Message, reply: Reply, deliveryId: string) => Promise<void>,
    private readonly accepts: (message: Message) => boolean, private readonly concurrency = 3, private readonly onFailure: (job: Job, error: unknown) => Promise<void> = async () => {}) {}

  start(): void {
    if(this.timer || this.started) return;
    const tick = async () => {
      if(this.ticking) return; this.ticking=true;
      try {
        if(!await this.store.acquireWorker(this.server,this.owner,Date.now()+60000)) { if(this.started)this.stopping=true; return; }
        if(!this.started) { await this.store.recoverJobs(this.server);this.started=true; }
        await this.pump();
      } catch(error) { console.error("Task worker database operation failed",error instanceof Error?error.name:"UnknownError"); }
      finally {this.ticking=false;}
    };
    void tick();this.timer=setInterval(()=>{void tick();},1000);this.timer.unref();
  }
  async enqueue(message: Message): Promise<Job> { requestTimings.start(message, "queue"); const job=await this.store.enqueueJob(message);await this.pump();return job; }
  wake(): void { void this.pump(); }
  private async pump(): Promise<void> {
    return requestTimings.withoutScope(() => this.pumpUnscoped());
  }
  private async pumpUnscoped(): Promise<void> {
    if(!this.started || this.stopping || this.pumping)return;
    this.pumping=true;
    try {
      while(this.active.size<this.concurrency && !this.stopping) {
        const job=await this.store.claimJob(this.server);if(!job)return;
        const promise=this.process(job).finally(()=>{this.active.delete(promise);void this.pump();});this.active.add(promise);
      }
    } finally {this.pumping=false;}
  }
  private async process(job: Job): Promise<void> {
    return requestTimings.withScope(job.message, () => this.processScoped(job));
  }
  private async processScoped(job: Job): Promise<void> {
    requestTimings.end(job.message, "retry backoff");
    requestTimings.end(job.message, "queue");
    try {
      if (!this.accepts(job.message)) throw new Error("Channel is no longer enabled");
      const reply = job.reply ?? await this.run(job.message);
      if (reply) await this.store.readyJob(job.id, reply);
      if (reply) await this.deliver(job.message, reply, job.id);
      await this.store.finishJob(job.id);
    } catch (error) {
      const transient = error instanceof ProviderError && (error.status === 429 || error.status >= 500) || error instanceof TypeError;
      if (transient && job.attempts < 2) { await this.store.retryLater(job.id, Date.now() + 5000 * (job.attempts + 1)); requestTimings.start(job.message, "retry backoff"); return; }
      await this.store.failJob(job.id, error instanceof Error ? error.message : "Unknown failure", error instanceof UncertainActionError);
      try { await this.onFailure(job, error); } catch { console.error("Could not publish task failure notice"); }
      console.error(`Task job ${job.id} ${error instanceof UncertainActionError ? "needs reconciliation" : "failed"}: ${error instanceof Error ? error.name : "UnknownError"}`);
    }
  }
  async idle(): Promise<void> {
    while (this.active.size || this.pumping || this.ticking) { await Promise.all([...this.active]); if(this.pumping || this.ticking) await new Promise(resolve=>setTimeout(resolve,1)); }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    // Keep renewing ownership until in-flight actions finish.
    await this.idle();
    if (this.timer) clearInterval(this.timer);
    if (this.started) await this.store.releaseWorker(this.server, this.owner);
  }
}
