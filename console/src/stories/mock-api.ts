// A fake bot for stories: window.fetch answers from a route table instead of the network. Each story sets its
// routes with the `api` parameter (see console.tsx); routes not listed answer 404, so a missing fixture shows as
// the console's own error, as with a real bot.
export type Answer = unknown | ((request: { url: URL; body: unknown }) => unknown);
/** Keys are "METHOD /path" (no query string), e.g. "GET /api/session". A `status` answer sends that status. */
export type Routes = Record<string, Answer>;

export class Status { constructor(readonly status: number, readonly body: unknown = {}) {} }

let routes: Routes = {};
const realFetch = window.fetch.bind(window);

export function setRoutes(next: Routes) { routes = next; }

window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  // Storybook's own files and the kit's assets come from the Vite server.
  if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/auth/")) return realFetch(input, init);
  const method = (init?.method ?? "GET").toUpperCase();
  const key = `${method} ${url.pathname}`;
  if (!(key in routes)) {
    console.warn(`[mock api] no route for ${key}`);
    return json(404, { error: "Not found." });
  }
  const route = routes[key];
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  const answer = typeof route === "function" ? await route({ url, body }) : route;
  return answer instanceof Status ? json(answer.status, answer.body) : json(200, answer);
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
