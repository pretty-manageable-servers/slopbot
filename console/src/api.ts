// Calls to the bot's console API. Writes need the session's CSRF token, which /api/session gives.

import type { ChatSummary, Session } from "./api-types";
export type { ChatSummary, Session } from "./api-types";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
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
  if (!response.ok) throw new ApiError(typeof data.error === "string" ? data.error : `Request failed (${response.status}).`, response.status);
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
  if (!response.ok) throw new ApiError(typeof data.error === "string" ? data.error : `Upload failed (${response.status}).`, response.status);
  return data as T;
}

export async function loadSession(): Promise<Session> {
  const session = await call<Session>("GET", "/api/session");
  csrf = session.csrf;
  return session;
}

const chat = (id: string) => `/api/chats/${encodeURIComponent(id)}`;

export const api = {
  session: loadSession,
  chats: () => call<ChatSummary[]>("GET", "/api/chats"),
  createChat: (server: string) => call<{ id: string }>("POST", "/api/chats", { server }),
  messages: (id: string, limit = 50) => call<{ messages: unknown[]; hasMore: boolean; streamId: number }>("GET", `${chat(id)}/messages?limit=${limit}`),
  send: (id: string, text: string) => call<{ id: string }>("POST", `${chat(id)}/messages`, { text, images: [], files: [] }),
  update: (id: string, change: { title?: string; effort?: string }) => call<unknown>("PATCH", chat(id), change),
  remove: (id: string) => call<unknown>("DELETE", chat(id)),
  logout: () => call<unknown>("POST", "/api/logout", {}),
  stop: (id: string) => call<{ stopped: number }>("POST", `${chat(id)}/stop`, {}),
  run: (runId: string) => call<{ steps: unknown[] }>("GET", `/api/runs/${encodeURIComponent(runId)}`),
  streamUrl: (id: string, after: number) => `${chat(id)}/stream?after=${after}`,
};
