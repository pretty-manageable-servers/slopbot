import type { Server } from "node:http";

/** Stops new connections, then ends open connections such as SSE streams. Without this, close() waits for them forever. */
export function closeWeb(web: Pick<Server, "close" | "closeAllConnections" | "closeIdleConnections">): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    web.close(error => error ? reject(error) : resolve());
    web.closeIdleConnections();
    web.closeAllConnections();
  });
}
