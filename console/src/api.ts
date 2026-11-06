// Calls to the bot's console API. Writes need the session's CSRF token, which /api/session gives.

export interface Session {
  user: string;
  csrf: string;
  servers: { id: string; name: string; icon: string | null; admin: boolean }[];
}

export interface ChatSummary { id: string; title: string; updated: number; effort: string }

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

let csrf = "";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
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

export async function loadSession(): Promise<Session> {
  const session = await call<Session>("GET", "/api/session");
  csrf = session.csrf;
  return session;
}

const chat = (id: string) => `/api/chats/${encodeURIComponent(id)}`;

export const api = {
  chats: () => call<ChatSummary[]>("GET", "/api/chats"),
  createChat: (server: string) => call<{ id: string }>("POST", "/api/chats", { server }),
  messages: (id: string, limit = 50) => call<{ messages: unknown[]; hasMore: boolean; streamId: number }>("GET", `${chat(id)}/messages?limit=${limit}`),
  send: (id: string, text: string) => call<{ id: string }>("POST", `${chat(id)}/messages`, { text, images: [], files: [] }),
  stop: (id: string) => call<{ stopped: number }>("POST", `${chat(id)}/stop`, {}),
  streamUrl: (id: string, after: number) => `${chat(id)}/stream?after=${after}`,
};
