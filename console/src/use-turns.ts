// Loads the turn of each saved reply that has no live events: the reply's thinking and tool steps come from the
// same events and the same reducer as a live reply.
import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { loadTurns, unloadedReplies, withLoadedTurns, type ChatState, type TurnSource } from "./events";

/** Asks once for the turn of each reply on the page. A reply whose turn fails to load shows without steps. */
export function useTurns(state: ChatState | null, setState: Dispatch<SetStateAction<ChatState | null>>, source: TurnSource): void {
  const asked = useRef(new Set<string>());
  const sourceRef = useRef(source);
  sourceRef.current = source;
  useEffect(() => {
    if (!state) return;
    const ids = unloadedReplies(state).filter((id) => !asked.current.has(id));
    if (!ids.length) return;
    for (const id of ids) asked.current.add(id);
    void loadTurns(state, ids, sourceRef.current).then((found) => setState((s) => s && withLoadedTurns(s, found)));
  }, [state, setState]);
}
