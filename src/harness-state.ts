// SPDX-License-Identifier: AGPL-3.0-only
// TypeScript adaptation of bushshrub/auger's auger-core/auger-statemachine.mmd.
// Upstream commit: 7e126e04d3cf7f223bd31824a9b95b1531cade64.
// See THIRD_PARTY_NOTICES.md and licenses/auger-AGPL-3.0.txt.

export type CallState = 'Undecided' | 'Running' | 'DoneWithheld' | 'DoneContinue';
export interface HarnessCall { id: string; state: CallState; denied: boolean }
export type HarnessState =
  | { kind: 'WaitingForUserMessage' | 'Streaming' | 'StreamingInterrupted' | 'StreamingFailed' }
  | { kind: 'InterruptingStream'; queuedMessage: boolean }
  | { kind: 'ToolPhase' | 'ToolResultsHeld'; calls: readonly HarnessCall[]; queuedMessage: boolean };
export type HarnessEvent =
  | { type: 'SendMessage' }
  | { type: 'StreamCompleted' }
  | { type: 'StreamFailed' }
  | { type: 'Interrupt' }
  | { type: 'StreamInterrupted' }
  | { type: 'ToolsRequested'; ids: readonly string[] }
  | { type: 'ToolDecision'; id: string; decision: 'approve' | 'deny_continue' | 'deny_withhold' }
  | { type: 'ToolRejected'; id: string }
  | { type: 'ToolResult'; id: string }
  | { type: 'ToolInterrupted'; id: string };

function settle(state: Extract<HarnessState, { calls: readonly HarnessCall[] }>): HarnessState {
  if (state.calls.some(call => call.state === 'Undecided' || call.state === 'Running')) return state;
  return state.calls.some(call => call.state === 'DoneWithheld') || state.calls.every(call => call.denied)
    ? { ...state, kind: 'ToolResultsHeld' }
    : { kind: 'Streaming' };
}
export function transition(state: HarnessState, event: HarnessEvent): HarnessState {
  if (event.type === 'SendMessage') {
    switch (state.kind) {
      case 'WaitingForUserMessage': case 'StreamingInterrupted': case 'StreamingFailed': case 'ToolResultsHeld': return { kind: 'Streaming' };
      case 'InterruptingStream': return { ...state, queuedMessage: true };
      case 'ToolPhase': return { ...state, queuedMessage: true };
    }
  }
  if (state.kind === 'Streaming') {
    if (event.type === 'StreamCompleted') return { kind: 'WaitingForUserMessage' };
    if (event.type === 'StreamFailed') return { kind: 'StreamingFailed' };
    if (event.type === 'Interrupt') return { kind: 'InterruptingStream', queuedMessage: false };
    if (event.type === 'ToolsRequested') {
      if (!event.ids.length || new Set(event.ids).size !== event.ids.length) throw new Error('Tool call IDs must be nonempty and unique');
      return { kind: 'ToolPhase', calls: event.ids.map(id => ({ id, state: 'Undecided', denied: false })), queuedMessage: false };
    }
  }
  if (state.kind === 'InterruptingStream' && event.type === 'StreamInterrupted') return { kind: state.queuedMessage ? 'Streaming' : 'StreamingInterrupted' };
  if (state.kind === 'ToolPhase') {
    if (event.type === 'Interrupt') return settle({ ...state, calls: state.calls.map(call => call.state === 'Undecided' || call.state === 'Running' ? { ...call, state: 'DoneContinue' as const } : call) });
    if (event.type === 'ToolDecision' || event.type === 'ToolResult' || event.type === 'ToolRejected' || event.type === 'ToolInterrupted') {
      const call = state.calls.find(call => call.id === event.id);
      if (!call) throw new Error('Unknown tool call ID');
      let updated: HarnessCall;
      if (event.type === 'ToolDecision' && call.state === 'Undecided') updated = { ...call, state: event.decision === 'approve' ? 'Running' : event.decision === 'deny_withhold' ? 'DoneWithheld' : 'DoneContinue', denied: event.decision !== 'approve' };
      else if (event.type === 'ToolRejected' && call.state === 'Running') updated = { ...call, state: 'DoneContinue', denied: true };
      else if (event.type === 'ToolResult' && call.state === 'Running') updated = { ...call, state: 'DoneContinue' };
      else if (event.type === 'ToolInterrupted' && (call.state === 'Undecided' || call.state === 'Running')) updated = { ...call, state: 'DoneContinue' };
      else throw new Error(`Invalid tool transition: ${call.state} / ${event.type}`);
      return settle({ ...state, calls: state.calls.map(item => item.id === call.id ? updated : item) });
    }
  }
  throw new Error(`Invalid harness transition: ${state.kind} / ${event.type}`);
}

// Reconstruct only execution state. Original model/tool events remain in their journals.
// Running calls become undecided and MUST pass the operation journal's reconciliation.
export function restoreHarness(state?: HarnessState): HarnessState {
  if (!state) return { kind: 'WaitingForUserMessage' };
  if (state.kind === 'Streaming' || state.kind === 'InterruptingStream') return { kind: 'StreamingInterrupted' };
  if (state.kind === 'ToolPhase') return settle({ ...state, calls: state.calls.map(call => call.state === 'Running' ? { ...call, state: 'Undecided' as const } : call) });
  return state;
}
export class HarnessMachine {
  state: HarnessState;
  constructor(state?: HarnessState) { this.state = restoreHarness(state); }
  dispatch(event: HarnessEvent): HarnessState { this.state = transition(this.state, event); return this.state; }
}
export interface HarnessJournal {
  recordHarness(message: { server: string; id: string }, state: HarnessState, event: HarnessEvent): Promise<void>;
  harnessState(server: string, id: string): Promise<HarnessState | undefined>;
}
export class HarnessInterrupted extends Error { override name = 'HarnessInterrupted'; }
