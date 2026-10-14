#!/usr/bin/env node
// Prompt format eval. Usage: node scripts/development/prompt-format-eval.mjs <old-dist> <new-dist> [out.md]
// <dist> is the build output folder (the one that holds src/). Builds the real prompt with ContextBuilder and wireMessages.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "../../tests/prompt-format-fixtures");
const [oldDist, newDist, out] = process.argv.slice(2);
if (!oldDist || !newDist) { console.error("Usage: prompt-format-eval.mjs <old-dist> <new-dist> [out.md]"); process.exit(2); }

const load = async (dist, file) => import(pathToFileURL(resolve(dist, "src", file)).href);
const loadBuild = async dist => ({
  ContextBuilder: (await load(dist, "context-builder.js")).ContextBuilder,
  wireMessages: (await load(dist, "adapters/chat-completions.js")).wireMessages,
  ByteTokenCounter: (await load(dist, "context.js")).ByteTokenCounter,
  transcript: existsSync(resolve(dist, "src/transcript.js")) ? await load(dist, "transcript.js") : undefined,
});

function fakeStore(fixture) {
  const all = [...fixture.history];
  const settings = new Map([[`${fixture.serverId}\u0000context_bot_author`, fixture.selfId]]);
  const replies = new Map(Object.entries(fixture.modelReplies ?? {}));
  return {
    async contextVersion() { return 1; },
    async context(message, limit) { return all.filter(item => item.channel === message.channel && item.id !== message.id).slice(-limit); },
    setting(server, key) { return settings.get(`${server}\u0000${key}`); },
    async setSetting(server, key, value) { settings.set(`${server}\u0000${key}`, value); },
    async modelReplies(_server, ids) { return new Map(ids.filter(id => replies.has(id)).map(id => [id, replies.get(id)])); },
  };
}
const profiles = fixture => {
  const people = new Map([...fixture.history, fixture.request].map(m => [m.author, m]));
  return {
    async profile(_server, user) { const m = people.get(user); return { name: m?.authorName ?? "unknown", identity: m?.authorIdentity ?? {}, fields: [] }; },
    async findPeople() { return []; },
  };
};

async function buildPrompt(build, fixture) {
  const store = fakeStore(fixture);
  const counter = new build.ByteTokenCounter();
  const prefix = [{ role: "system", content: "You are Slopbot, a helpful Discord assistant." }];
  const builder = new build.ContextBuilder({ store, profiles: profiles(fixture), tools: {}, counter, inputLimit: 100000, outputLimit: 8000, prefix });
  let request = fixture.request, taskKey;
  if (fixture.kind === "task_seed") {
    // Same steps as Bot.startTask: seed text from the source channel, then the task run reads the seed as its request.
    const source = fixture.request;
    const context = fixture.history;
    let text;
    if (build.transcript) {
      const { items } = build.transcript.renderTranscript(context, fixture.selfId, await store.modelReplies(fixture.serverId, context.map(m => m.id)), source.replyTo, "s");
      text = `Task goal: ${fixture.goal}\nSource-channel context:\n${items.map(i => i.role === "assistant" ? `Slopbot: ${i.content}` : i.content).join("\n")}`;
    } else {
      text = `Task goal: ${fixture.goal}\nSource-channel context: ${JSON.stringify(context.map(item => ({ ...item, context_role: item.id === source.replyTo ? "reply_target" : "background" })))}`;
    }
    request = { id: `task-seed:${source.id}`, server: source.server, channel: fixture.threadId, author: source.author, text, taskId: fixture.threadId, addressed: true, authorName: source.authorName, authorIdentity: source.authorIdentity, timestamp: source.timestamp };
    taskKey = fixture.threadId;
    store.context = async () => [];
  }
  const built = await builder.build(request, taskKey, 20, async () => [], prefix);
  const prompt = { prefixVersion: "eval", prefix, history: built.history, inputs: built.inputs };
  return { wire: build.wireMessages(prompt), items: [...prefix, ...built.history, ...built.inputs], counter, refs: built.refs };
}

const text = m => typeof m.content === "string" ? m.content : (m.content ?? []).map(p => p.text ?? "").join("");

function checks(fixture, wire) {
  const failures = [];
  const first = wire.find(m => m.role !== "system");
  if (!first || first.role !== "user") failures.push(`first non-system message is ${first?.role}`);
  const replyTexts = Object.values(fixture.modelReplies ?? {}).map(r => r.text);
  for (const m of wire.filter(m => m.role === "assistant")) {
    let rest = text(m);
    for (const t of replyTexts) rest = rest.split(t).join("");
    if (rest.trim() !== "") failures.push(`assistant text is not a model reply: ${JSON.stringify(text(m).slice(0, 80))}`);
  }
  const noticeTexts = (fixture.notices ?? []).map(id => fixture.history.find(m => m.id === id)?.text).filter(Boolean);
  for (const m of wire.filter(m => m.role === "assistant")) for (const t of noticeTexts) if (text(m).includes(t)) failures.push(`notice in assistant message: ${JSON.stringify(t)}`);
  const joined = wire.map(text);
  for (const word of ["authorAliases", "revisionTimestamp", "context_role", "authorIdentity"]) {
    const hit = joined.find(t => t.includes(`"${word}"`) || t.includes(word));
    if (hit) failures.push(`raw field ${word}: ${hit.slice(Math.max(0, hit.indexOf(word) - 30), hit.indexOf(word) + 50).replace(/\n/g, " ")}`);
  }
  // Message IDs must not appear. User IDs are allowed in the People and Request context sections and in <@id> mentions.
  for (const t of joined) {
    let section = false;
    const kept = t.split("\n").filter(line => {
      if (line === "") { section = false; return true; }
      if (/^(People|Request context):$/.test(line)) { section = true; return false; }
      return !section;
    }).join("\n").replace(/<@!?\d+>/g, "<@user>");
    const id = kept.match(/(?<!\d)\d{17,20}(?!\d)/);
    if (id) failures.push(`ID in prompt: ...${kept.slice(Math.max(0, id.index - 40), id.index + 25).replace(/\n/g, " ")}...`);
  }
  return failures;
}

const fixtures = readdirSync(fixtureDir).filter(f => f.endsWith(".json")).sort().map(f => JSON.parse(readFileSync(join(fixtureDir, f), "utf8")));
const builds = { old: await loadBuild(oldDist), new: await loadBuild(newDist) };
const rows = [];
const dumps = [];
for (const fixture of fixtures) {
  const result = {};
  for (const side of ["old", "new"]) {
    const built = await buildPrompt(builds[side], fixture);
    result[side] = { tokens: built.counter.count(built.items), chars4: Math.ceil(built.wire.map(text).join("").length / 4), failures: checks(fixture, built.wire), wire: built.wire };
  }
  rows.push({ name: fixture.name, ...result });
}
const modelKey = process.env.PMS_AI_KEY || existsSync(join(process.env.HOME, "jokes/pmservers/scratchpad/pms/key.json"));
const modelNote = modelKey ? "key found, model check not run by this script" : "skipped: no key";
const lines = ["| case | old tokens | new tokens | old chars/4 | new chars/4 | new checks | old checks | model notes |", "|---|---|---|---|---|---|---|---|"];
for (const r of rows) lines.push(`| ${r.name} | ${r.old.tokens} | ${r.new.tokens} | ${r.old.chars4} | ${r.new.chars4} | ${r.new.failures.length ? "FAIL" : "pass"} | ${r.old.failures.length ? `fail (${r.old.failures.length})` : "pass"} | ${modelNote} |`);
const sum = k => rows.reduce((a, r) => a + r[k].tokens, 0);
lines.push(`| total | ${sum("old")} | ${sum("new")} | | | | | |`);
let report = lines.join("\n") + "\n";
const failed = rows.filter(r => r.new.failures.length);
if (failed.length) report += "\nNew build failures:\n" + failed.map(r => `- ${r.name}:\n${r.new.failures.map(f => `  - ${f}`).join("\n")}`).join("\n") + "\n";
if (process.env.DUMP) report += "\n" + rows.map(r => `## ${r.name} (new wire)\n\n\`\`\`\n${r.new.wire.map(m => `[${m.role}] ${text(m)}`).join("\n---\n")}\n\`\`\`\n`).join("\n");
console.log(report);
if (out) writeFileSync(out, report);
process.exitCode = failed.length ? 1 : 0;
