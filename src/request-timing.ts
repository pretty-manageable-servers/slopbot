import { performance } from "node:perf_hooks";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Message } from "./domain.js";
import type { RecordStore } from "./records.js";
type Scope = Pick<Message, "server" | "channel" | "id">;
export interface TimingSnapshot {
  totalMs: number;
  steps: Record<string, number>;
  firstOutputMs: number[];
  partial: boolean;
  blockedMs?: Record<string, number>;
  activeWaits?: { name: string; elapsedMs: number }[];
  timeline?: {
    startMs: number;
    endMs: number;
    waits: string[];
    stages?: string[];
  }[];
  timelineTruncated?: boolean;
  activeStages?: string[];
}
interface Trace {
  start: number;
  steps: Record<string, number>;
  pending: Record<string, number>;
  firstOutputMs: number[];
  partial: boolean;
  last: number;
  waits: Map<symbol, { name: string; start: number }>;
  blocked: Record<string, number>;
  timeline: {
    startMs: number;
    endMs: number;
    waits: string[];
    stages?: string[];
  }[];
  truncated: boolean;
  manualWaits: Map<string, symbol>;
}
// Bounded, content-free measurements. No tracing service or prompt changes.
export class RequestTimings {
  private readonly scope = new AsyncLocalStorage<Scope>();
  private readonly traces = new Map<string, Trace>();
  constructor(private readonly now = () => performance.now()) {}
  private key(message: Scope): string {
    return JSON.stringify([message.server, message.channel, message.id]);
  }
  begin(message: Scope, partial = false): void {
    const key = this.key(message);
    if (this.traces.has(key)) return;
    const now = this.now();
    for (const [id, trace] of this.traces)
      if (now - trace.start > 7200000) this.traces.delete(id);
    if (this.traces.size >= 256)
      this.traces.delete(this.traces.keys().next().value!);
    this.traces.set(key, {
      start: now,
      steps: {},
      pending: {},
      firstOutputMs: [],
      partial,
      last: now,
      manualWaits: new Map(),
      waits: new Map(),
      blocked: {},
      timeline: [],
      truncated: false,
    });
  }
  withScope<T>(message: Scope, work: () => Promise<T>): Promise<T> {
    this.begin(message, true);
    return this.scope.run(message, work);
  }
  withoutScope<T>(work: () => Promise<T>): Promise<T> {
    return this.scope.exit(work);
  }
  private account(trace: Trace): void {
    const now = this.now(),
      startMs = Math.round(trace.last - trace.start),
      endMs = Math.round(now - trace.start);
    const waits = [
      ...new Set([...trace.waits.values()].map((wait) => wait.name)),
    ].sort();
    const stages = Object.keys(trace.pending);
    let label = waits.join(" + ") || "application/uninstrumented";
    if (!(label in trace.blocked) && Object.keys(trace.blocked).length >= 128) {
      label = "other wait combinations";
      trace.truncated = true;
    }
    trace.blocked[label] = (trace.blocked[label] ?? 0) + endMs - startMs;
    if (endMs > startMs) {
      const last = trace.timeline.at(-1);
      if (
        last &&
        last.waits.join("|") === waits.join("|") &&
        (last.stages ?? []).join("|") === stages.join("|")
      )
        last.endMs = endMs;
      else trace.timeline.push({ startMs, endMs, waits, stages });
      if (trace.timeline.length > 256) {
        trace.timeline.shift();
        trace.truncated = true;
      }
    }
    trace.last = now;
  }
  async wait<T>(name: string, work: () => Promise<T>): Promise<T> {
    const message = this.scope.getStore(),
      trace = message ? this.traces.get(this.key(message)) : undefined;
    if (!trace) return work();
    this.account(trace);
    const token = Symbol();
    trace.waits.set(token, { name, start: this.now() });
    try {
      return await work();
    } finally {
      this.account(trace);
      trace.waits.delete(token);
    }
  }
  active(
    server: string,
    channel: string,
  ): { requestId: string; timing: TimingSnapshot }[] {
    return [...this.traces.keys()].flatMap((key) => {
      const [s, c, id] = JSON.parse(key) as string[];
      if (s !== server || c !== channel) return [];
      const timing = this.snapshot({ server, channel, id: id! });
      return timing ? [{ requestId: id!, timing }] : [];
    });
  }
  slow(minMs = 10000): {
    server: string;
    channel: string;
    requestId: string;
    timing: TimingSnapshot;
  }[] {
    return [...this.traces.entries()].flatMap(([key, trace]) => {
      if (
        this.now() - trace.start < minMs ||
        (!trace.waits.size && !Object.keys(trace.pending).length)
      )
        return [];
      const [server, channel, requestId] = JSON.parse(key) as [
        string,
        string,
        string,
      ];
      return [
        {
          server,
          channel,
          requestId,
          timing: this.snapshot({ server, channel, id: requestId })!,
        },
      ];
    });
  }
  start(message: Scope, name: string): void {
    this.begin(message, true);
    const trace = this.traces.get(this.key(message))!;
    this.account(trace);
    trace.pending[name] ??= this.now();
    if (
      (name === "queue" || name === "retry backoff") &&
      !trace.manualWaits.has(name)
    ) {
      this.account(trace);
      const token = Symbol();
      trace.manualWaits.set(name, token);
      trace.waits.set(token, {
        name: name === "queue" ? "worker queue" : name,
        start: this.now(),
      });
    }
  }
  end(message: Scope, name: string): void {
    const trace = this.traces.get(this.key(message));
    if (!trace || trace.pending[name] === undefined) return;
    this.account(trace);
    trace.steps[name] =
      (trace.steps[name] ?? 0) + this.now() - trace.pending[name]!;
    delete trace.pending[name];
    const token = trace.manualWaits.get(name);
    if (token) {
      this.account(trace);
      trace.waits.delete(token);
      trace.manualWaits.delete(name);
    }
  }
  async measure<T>(
    message: Scope,
    name: string,
    work: () => Promise<T>,
  ): Promise<T> {
    this.start(message, name);
    try {
      return await work();
    } finally {
      this.end(message, name);
    }
  }
  firstOutput(message: Scope, elapsed: number): void {
    const trace = this.traces.get(this.key(message));
    if (trace && trace.firstOutputMs.length < 16)
      trace.firstOutputMs.push(Math.round(elapsed));
  }
  snapshot(message: Scope): TimingSnapshot | undefined {
    const trace = this.traces.get(this.key(message));
    if (!trace) return undefined;
    this.account(trace);
    return {
      totalMs: Math.round(this.now() - trace.start),
      steps: Object.fromEntries(
        Object.entries(trace.steps).map(([name, ms]) => [name, Math.round(ms)]),
      ),
      firstOutputMs: [...trace.firstOutputMs],
      partial: trace.partial,
      blockedMs: { ...trace.blocked },
      activeWaits: [...trace.waits.values()].map((wait) => ({
        name: wait.name,
        elapsedMs: Math.round(this.now() - wait.start),
      })),
      timeline: trace.timeline.map((interval) => ({
        ...interval,
        waits: [...interval.waits],
        ...(interval.stages ? { stages: [...interval.stages] } : {}),
      })),
      timelineTruncated: trace.truncated,
      activeStages: Object.keys(trace.pending),
    };
  }
  finish(message: Scope): TimingSnapshot | undefined {
    const value = this.snapshot(message);
    this.traces.delete(this.key(message));
    return value;
  }
}
export const requestTimings = new RequestTimings();
// Remains usable when all bot workers are waiting. No DB access or Discord traffic.
const waitWatchdog = setInterval(() => {
  for (const { server, channel, requestId, timing } of requestTimings.slow()) {
    console.info(
      JSON.stringify({
        type: "request_wait",
        server,
        channel,
        requestId,
        elapsedMs: timing.totalMs,
        activeStages: timing.activeStages,
        activeWaits: timing.activeWaits,
        partial: timing.partial,
      }),
    );
  }
}, 15000);
waitWatchdog.unref();
export const nestedTiming = (name: string): boolean =>
  name === "checkpoint model" ||
  name.endsWith(" journal") ||
  name === "participation queue" ||
  name === "decision classifier";
export function timingFooter(value: TimingSnapshot): string {
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  if (value.blockedMs) {
    const buckets = Object.entries(value.blockedMs)
      .filter(([, ms]) => ms > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    const remainder = Math.max(
      0,
      value.totalMs - buckets.reduce((sum, [, ms]) => sum + ms, 0),
    );
    const labels = [
      ...buckets.map(([name, ms]) => `${name} ${seconds(ms)}`),
      ...(remainder ? [`remaining ${seconds(remainder)}`] : []),
    ];
    return `\n\n-# Total time: ${seconds(value.totalMs)} (before delivery${value.partial ? ", partial" : ""}) | ${labels.join(" | ")}${value.firstOutputMs.length ? ` | first output (within model) ${value.firstOutputMs.map(seconds).join(", ")}` : ""}`;
  }
  const displayed = Object.entries(value.steps)
    // Checkpoint streaming is already included in context building.
    .filter(([name]) => !nestedTiming(name) && name !== "delivery")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const other = Math.max(
    0,
    value.totalMs - displayed.reduce((sum, [, ms]) => sum + ms, 0),
  );
  const steps = [
    ...displayed.map(([name, ms]) => `${name} ${seconds(ms)}`),
    `other ${seconds(other)}`,
  ];
  return `\n\n-# Total time: ${seconds(value.totalMs)} (before delivery${value.partial ? ", partial" : ""}) | ${steps.join(" | ")}${value.firstOutputMs.length ? ` | first output (within model) ${value.firstOutputMs.map(seconds).join(", ")}` : ""}`;
}
export async function savedTimingFooter(
  store: RecordStore & { setting(server: string, key: string): unknown },
  message: Scope,
  deliveryId: string,
): Promise<string> {
  const saved = await store.record(
    message.server,
    "request_timing_footer",
    deliveryId,
  );
  if (saved) return typeof saved.value === "string" ? saved.value : "";
  const snapshot = requestTimings.snapshot(message);
  const footer =
    store.setting(message.server, "timing_footer") === true && snapshot
      ? timingFooter(snapshot)
      : "";
  if (
    await store.putRecord(
      message.server,
      "request_timing_footer",
      deliveryId,
      footer,
      0,
    )
  )
    return footer;
  const winner = await store.record(
    message.server,
    "request_timing_footer",
    deliveryId,
  );
  if (!winner || typeof winner.value !== "string")
    throw new Error("Timing footer could not be saved");
  return winner.value;
}
