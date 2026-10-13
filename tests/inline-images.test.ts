import test from "node:test";
import assert from "node:assert/strict";
import { inlineImages } from "../src/adapters/chat-completions.js";

test("remote image URLs are sent to the model as data: URLs, and a failed image becomes a text note", async () => {
  const fetched: string[] = [];
  const fake = (async (url: string) => {
    fetched.push(url);
    if (url.endsWith("/bad")) return new Response("no", { status: 403 });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
  }) as unknown as typeof fetch;
  const out = await inlineImages([
    { role: "user", content: "plain" },
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "https://s3/a.png" } }, { type: "image_url", image_url: { url: "https://s3/a.png" } }, { type: "image_url", image_url: { url: "https://s3/bad" } }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] },
  ], fake);
  assert.equal(out[0]!.content, "plain");
  assert.deepEqual(out[1]!.content, [
    { type: "text", text: "look" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
    { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
    { type: "text", text: "[An image could not be loaded.]" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
  ]);
  assert.deepEqual(fetched, ["https://s3/a.png", "https://s3/bad"], "each URL is fetched once; data: URLs are not fetched");
});
