import test from "node:test";
import assert from "node:assert/strict";
import { selectRunImages } from "../src/run-images.js";
import { RUN_IMAGE_LIMIT } from "../src/model-images.js";
import type { ImageSource } from "../src/model-images.js";
import { ContextBuilder } from "../src/context-builder.js";
import { ByteTokenCounter } from "../src/context.js";
import { formatLine, toLine } from "../src/transcript.js";
import type { Attachment, Message, PromptItem } from "../src/domain.js";
import type { Store } from "../src/ports.js";

const NOW = Date.UTC(2026, 9, 22, 14, 0, 0);
const SEC = 1000;
const image = (name: string, extra: Partial<Attachment> = {}): Attachment => ({ name, url: `https://cdn.discordapp.com/attachments/1/2/${name}?ex=a&is=b&hm=c`, contentType: "image/jpeg", ...extra });
const msg = (id: string, extra: Partial<Message> = {}): Message => ({ id, server: "srv", channel: "chan", author: "alice", authorName: "Alice", text: `text ${id}`, timestamp: NOW, ...extra });
/** Links are fresh per message and attachment, so tests can see which image was picked. */
const source: ImageSource = { link: async (message, attachment) => `https://fresh.test/${message.id}/${attachment.name}` };
const labels = (images: readonly { label: string }[]) => images.map(item => item.label);

test("request_images_first", async () => {
  const request = msg("req", { attachments: [image("own.jpg")] });
  const target = msg("tgt", { author: "bob", attachments: [image("target.jpg")] });
  const withLinks = await selectRunImages({ request: { ...request, modelImages: [{ url: "web-chat://a", label: "web.png" }] }, target, recent: [], source });
  assert.deepEqual(withLinks.map(item => item.url), ["web-chat://a", "https://fresh.test/tgt/target.jpg"], "web chat links cover the request's own attachments, not the target's");
  const plain = await selectRunImages({ request, target, recent: [], source });
  assert.deepEqual(labels(plain), ["own.jpg", "target.jpg"]);
  assert.equal(plain[0]?.url, "https://fresh.test/req/own.jpg");
});

test("reply_target_images_included", async () => {
  const target = msg("tgt", { author: "bob", attachments: [image("picture.png"), image("second.png")] });
  const request = msg("req", { replyTo: "tgt" });
  const images = await selectRunImages({ request, target, recent: [target], source });
  assert.deepEqual(labels(images), ["picture.png", "second.png"]);
  assert.equal(images[0]?.url, "https://fresh.test/tgt/picture.png");
});

test("same_author_within_two_minutes_included", async () => {
  const earlier = msg("old", { timestamp: NOW - 90 * SEC, attachments: [image("shot.jpg")] });
  const images = await selectRunImages({ request: msg("req"), recent: [earlier], source });
  assert.deepEqual(labels(images), ["shot.jpg"]);
});

test("other_author_older_or_bot_excluded", async () => {
  const recent = [
    msg("other", { author: "bob", timestamp: NOW - 30 * SEC, attachments: [image("bob.jpg")] }),
    msg("older", { timestamp: NOW - 3 * 60 * SEC, attachments: [image("older.jpg")] }),
    msg("bot", { timestamp: NOW - 10 * SEC, isBot: true, attachments: [image("bot.jpg")] }),
    msg("later", { timestamp: NOW + 5 * SEC, attachments: [image("later.jpg")] }),
    msg("self", { timestamp: NOW - 5 * SEC, attachments: [image("self.jpg")] }),
  ];
  const request = msg("req", { id: "req" });
  const images = await selectRunImages({ request, recent: [...recent, msg("req", { attachments: [] })], source });
  assert.deepEqual(labels(images), ["self.jpg"], "only the same author's own non-bot message is in the window, and not the request itself");
});

test("max_four_newest_first", async () => {
  const recent = [1, 2, 3, 4, 5].map(n => msg(`m${n}`, { timestamp: NOW - n * SEC, attachments: [image(`m${n}.png`)] }));
  const images = await selectRunImages({ request: msg("req"), recent, source });
  assert.equal(images.length, RUN_IMAGE_LIMIT);
  assert.deepEqual(labels(images), ["m1.png", "m2.png", "m3.png", "m4.png"]);
  // The request's own image takes one of the four places, so only three recent ones fit.
  const withOwn = await selectRunImages({ request: msg("req", { attachments: [image("own.jpg")] }), recent, source });
  assert.deepEqual(labels(withOwn), ["own.jpg", "m1.png", "m2.png", "m3.png"]);
});

test("request_own_images_never_capped", async () => {
  const own = [1, 2, 3, 4, 5, 6].map(n => image(`own${n}.jpg`));
  const request = msg("req", { attachments: own });
  const images = await selectRunImages({ request, recent: [msg("old", { timestamp: NOW - SEC, attachments: [image("old.png")] })], source });
  assert.deepEqual(labels(images), own.map(item => item.name), "all six of the request's own attachments pass, and nothing else fits");
  const links = Array.from({ length: 10 }, (_, n) => ({ url: `web-chat://${n}`, label: `web${n}.png` }));
  const web = await selectRunImages({ request: { ...msg("web"), modelImages: links }, recent: [], source });
  assert.deepEqual(web, links, "all ten web chat links pass");
});

test("preview_never_included", async () => {
  const preview = image("card.png", { preview: true });
  const target = msg("tgt", { author: "bob", attachments: [preview] });
  const recent = [msg("old", { timestamp: NOW - 5 * SEC, attachments: [preview] })];
  const images = await selectRunImages({ request: msg("req", { replyTo: "tgt", attachments: [preview] }), target, recent, source });
  assert.deepEqual(images, []);
});

test("missing_or_throwing_link_skipped", async () => {
  const flaky: ImageSource = {
    link: async (_message, attachment) => {
      if (attachment.name === "gone.png") return undefined;
      if (attachment.name === "broken.png") throw new Error("storage down");
      return `https://fresh.test/${attachment.name}`;
    },
  };
  const request = msg("req", { attachments: [image("gone.png"), image("broken.png"), image("kept.png")] });
  assert.deepEqual(labels(await selectRunImages({ request, recent: [], source: flaky })), ["kept.png"]);
  assert.deepEqual(await selectRunImages({ request, recent: [] }), [], "no source gives no stored images");
});

test("transcript_line_has_no_cdn_url", () => {
  const text = "how do I do this\n[Attachment image.jpg, type image/jpeg: https://cdn.discordapp.com/attachments/1/2/image.jpg; content not inspected]";
  const message = msg("req", { text, attachments: [image("image.jpg")] });
  const line = formatLine(toLine(message, "m1", new Map()));
  assert.ok(!line.includes("http"), line);
  assert.ok(line.includes("[images: image.jpg]"), line);
  assert.ok(line.endsWith(": how do I do this"), line);
});

test("same_author_image_reaches_request_item", async () => {
  const earlier = msg("shot", { timestamp: NOW - 7 * SEC, attachments: [image("image.jpg")] });
  const request = msg("req", { text: "how do I do this" });
  const store = {
    contextVersion: async () => 1,
    context: async () => [earlier],
  } as unknown as Store;
  const builder = new ContextBuilder({ store, counter: new ByteTokenCounter(), inputLimit: 100_000, outputLimit: 100, prefix: [], images: source });
  const noHistory = async (): Promise<readonly PromptItem[]> => [];
  const result = await builder.build(request, undefined, 12, noHistory);
  const last = result.inputs.at(-1);
  assert.deepEqual(last?.images, [{ url: "https://fresh.test/shot/image.jpg", label: "image.jpg" }]);
  assert.ok(!result.inputs.some(item => item.content.includes("http")), "no URL reaches the model as text");
});
