// Calls to the bot's console API. Writes need the session's CSRF token, which /api/session gives.

import type { EngineEvent } from "@slopbot/contracts";
import type { ChatFile, ChatImage, ChatShare, ChatSummary, Session, Usage } from "./api-types";
export type { ChatSummary, Session } from "./api-types";

/** A failed call: the bot's error text, the status and the whole error body (for fields such as resetAt). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly data: Record<string, unknown> = {}) { super(message); }
}

let csrf = "";

/** One JSON call. Writes get the CSRF token. A failed call throws ApiError with the bot's error text. */
export async function call<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const write = method !== "GET";
  const response = await fetch(path, {
    method,
    headers: { ...(body !== undefined && { "Content-Type": "application/json" }), ...(write && { "X-CSRF-Token": csrf }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(typeof data.error === "string" ? data.error : `Request failed (${response.status}).`, response.status, data);
  return data as T;
}

export const get = <T>(path: string) => call<T>("GET", path);
export const post = <T>(path: string, body: unknown = {}) => call<T>("POST", path, body);
/** A query string from the set values, e.g. qs({ server, q }) is "?server=1&q=x". */
export const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") out.set(key, String(value));
  const text = out.toString();
  return text ? `?${text}` : "";
};

/** Raw bytes (an image or a file) to an upload route. */
export async function upload<T>(path: string, file: File): Promise<T> {
  const response = await fetch(`${path}${qs({ name: file.name })}`, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream", "X-CSRF-Token": csrf },
    body: file,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(typeof data.error === "string" ? data.error : `Upload failed (${response.status}).`, response.status, data);
  return data as T;
}

/** Raw WAV to the speech-to-text route. Resolves to the words heard. */
async function transcribe(audio: Blob, signal: AbortSignal): Promise<string> {
  const response = await fetch("/api/transcribe", { method: "POST", headers: { "Content-Type": "audio/wav", "X-CSRF-Token": csrf }, body: audio, signal });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(typeof data.error === "string" ? data.error : `Dictation failed (${response.status}).`, response.status, data);
  return typeof data.text === "string" ? data.text : "";
}

export async function loadSession(): Promise<Session> {
  const session = await call<Session>("GET", "/api/session");
  csrf = session.csrf;
  return session;
}

const chat = (id: string) => `/api/chats/${encodeURIComponent(id)}`;

export const api = {
  session: loadSession,
  transcribe,
  chats: () => call<ChatSummary[]>("GET", "/api/chats"),
  createChat: (server: string) => call<{ id: string }>("POST", "/api/chats", { server }),
  messages: (id: string, limit = 50) => call<{ messages: unknown[]; hasMore: boolean; streamId: number }>("GET", `${chat(id)}/messages?limit=${limit}`),
  send: (id: string, text: string, images: string[] = [], files: string[] = []) => call<{ id: string }>("POST", `${chat(id)}/messages`, { text, images, files }),
  update: (id: string, change: { title?: string; effort?: string }) => call<unknown>("PATCH", chat(id), change),
  remove: (id: string) => call<unknown>("DELETE", chat(id)),
  uploadImage: (id: string, file: File) => upload<ChatImage>(`${chat(id)}/images`, file),
  uploadFile: (id: string, file: File) => upload<ChatFile>(`${chat(id)}/files`, file),
  removeImage: (id: string, imageId: string) => call<unknown>("DELETE", `${chat(id)}/images/${encodeURIComponent(imageId)}`),
  removeFile: (id: string, fileId: string) => call<unknown>("DELETE", `${chat(id)}/files/${encodeURIComponent(fileId)}`),
  shares: (id: string) => call<{ shares: ChatShare[] }>("GET", `${chat(id)}/shares`),
  createShare: (id: string) => call<{ id: string }>("POST", `${chat(id)}/shares`, {}),
  revokeShare: (id: string, shareId: string) => call<unknown>("POST", `${chat(id)}/shares/${encodeURIComponent(shareId)}/revoke`, {}),
  continueShare: (shareId: string) => call<{ id: string; title: string }>("POST", `/api/shares/${encodeURIComponent(shareId)}/continue`, {}),
  usage: (server: string) => get<Usage>(`/api/usage${qs({ server })}`),
  useReset: (server: string, kind: string) => post<Usage>("/api/usage/reset", { server, kind }),
  logout: () => call<unknown>("POST", "/api/logout", {}),
  stop: (id: string) => call<{ stopped: number }>("POST", `${chat(id)}/stop`, {}),
  /** The request (turn) of a run. A saved reply names its runs, not its turn. */
  run: (runId: string) => call<{ requestId: string }>("GET", `/api/runs/${encodeURIComponent(runId)}`),
  turnEvents: (id: string, turn: string) => call<{ events: EngineEvent[] }>("GET", `${chat(id)}/turns/${encodeURIComponent(turn)}/events`),
  /** The live engine events of a chat. No position: the stream starts at the newest event. */
  eventsUrl: (id: string) => `${chat(id)}/events`,
};
