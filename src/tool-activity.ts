export interface ToolActivity {
  readonly id: string;
  readonly name: string;
  readonly arguments?: import('./tools.js').ToolArgs;
  readonly status: 'running' | 'completed' | 'rejected' | 'failed' | 'delegated';
  readonly reused?: boolean;
  readonly durationMs?: number;
  readonly startedAt?: number;
  readonly reason?: string;
  /** The program code. Set only for run_tools_code. */
  readonly code?: string;
  /** The run_tools_code operation that made this call. */
  readonly parentId?: string;
}
export type ToolActivityObserver = (message: import('./domain.js').Message, activity: ToolActivity) => Promise<void>;
