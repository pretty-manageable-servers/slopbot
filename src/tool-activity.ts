export interface ToolActivity {
  readonly id: string;
  readonly name: string;
  readonly status: 'running' | 'completed' | 'rejected' | 'failed' | 'delegated';
  readonly reused?: boolean;
  readonly durationMs?: number;
  readonly reason?: string;
}
export type ToolActivityObserver = (message: import('./domain.js').Message, activity: ToolActivity) => Promise<void>;
