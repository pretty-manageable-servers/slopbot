import { useDictation } from "agentic-ui-kit";
import { api } from "../api";
import { notifyError } from "./feedback";

/** Dictation for the composers. Each partial re-sends the whole clip, so partials come every 2 s. */
export const useConsoleDictation = () => useDictation({ transcribe: api.transcribe, partialEvery: 2000, onError: notifyError });
