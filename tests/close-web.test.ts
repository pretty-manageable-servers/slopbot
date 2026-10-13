import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { closeWeb } from "../src/close-web.js";

test("closeWeb finishes while an event stream is open", async () => {
  const server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write("retry: 3000\n\n"); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const req = request({ host: "127.0.0.1", port: address.port, path: "/" });
  req.on("error", () => undefined);
  req.end();
  const [res] = await once(req, "response");
  res.on("error", () => undefined);
  await once(res, "data");
  const closed = Promise.race([closeWeb(server).then(() => "closed"), new Promise(resolve => setTimeout(() => resolve("hung"), 3000))]);
  assert.equal(await closed, "closed");
});
