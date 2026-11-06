import { createServer, type Server } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import type { WebEnv } from "../src/clients/web/env.js";
import type { TranscriptRoutes } from "../src/web-transcripts.js";

/** Serves the transcript routes on their own. The signed-in user comes from the x-user header, as if a login had been found. */
export function transcriptServer(routes: TranscriptRoutes): Server {
  const app = new Hono<WebEnv>();
  app.use("*", async (c, next) => {
    const user = c.req.header("x-user");
    c.set("out", new Headers());
    c.set("session", user ? { user, csrf: "", hash: "" } : undefined);
    return next();
  });
  app.route("/api", routes);
  return createServer(getRequestListener(app.fetch, { overrideGlobalObjects: false }));
}
