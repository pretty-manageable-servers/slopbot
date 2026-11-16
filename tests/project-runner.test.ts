import test from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { AgentRunner } from "../src/agent-runner.js";
import { FakeLLM } from "../src/adapters/fake-llm.js";
import type { Message } from "../src/domain.js";
import type { Project, ProjectFile } from "../src/projects.js";
import type { UserInstructionsStore } from "../src/user-instructions.js";

class FakeInstructions implements UserInstructionsStore {
  constructor(private readonly saved: Record<string, string>) {}
  async userInstructions(user: string) {
    const text = this.saved[user];
    return text === undefined ? undefined : { text, updated: 1 };
  }
  async setUserInstructions(): Promise<void> { throw new Error("not used"); }
  async deleteUserInstructions(): Promise<void> { throw new Error("not used"); }
}

class FakeProjects {
  constructor(private readonly projects: Record<string, Project>, private readonly files: ProjectFile[] = [], private readonly fails = false) {}
  async project(id: string): Promise<Project | undefined> {
    if (this.fails) throw new Error("store unavailable");
    return this.projects[id];
  }
  async projectFiles(project: string): Promise<ProjectFile[]> {
    return this.files.filter(file => file.project === project);
  }
}

const project = (owner: string, instructions = ""): Project => ({ id: "cccccccccccccccccccccccccccccccc", owner, name: "Thesis", description: "", instructions, instructionsUpdated: null, created: 1, updated: 1 });
const file = (name: string): ProjectFile => ({ id: `f-${name}`, project: "cccccccccccccccccccccccccccccccc", name, contentType: "text/markdown", size: 2048, created: 1 });

function setup(t: { after(fn: () => void): void }, options: { saved?: Record<string, string>; projects?: FakeProjects } = {}) {
  const llm = new FakeLLM(); const store = new SQLiteStore(); t.after(() => store.close());
  const policy = { allowedChannels: [{ server: "s", channel: "web:abc" }, { server: "s", channel: "c" }] };
  const runner = new AgentRunner(store, llm, policy, undefined, { instructions: new FakeInstructions(options.saved ?? {}), ...(options.projects ? { projects: options.projects } : {}) });
  const message = (id: string, author: string, extra: Partial<Message> = {}): Message => ({ id, server: "s", channel: "web:abc", author, text: "hello", ...extra });
  const run = async (input: Message) => { await store.ingest(input); return runner.run(input); };
  const lastPrefix = () => llm.prompts.at(-1)!.prefix;
  return { llm, message, run, lastPrefix };
}

test("a project chat run adds the project item after the rules and the user instructions", async t => {
  const projects = new FakeProjects({ cccccccccccccccccccccccccccccccc: project("alice", "Write in British English.") }, [file("notes.md")]);
  const { message, run, lastPrefix } = setup(t, { saved: { alice: "Answer in short bullets." }, projects });
  await run(message("1", "alice", { project: "cccccccccccccccccccccccccccccccc" }));
  const prefix = lastPrefix();
  assert.equal(prefix.length, 3);
  assert.equal(prefix[0]!.role, "system");
  assert.ok(prefix[1]!.content.includes("<user-instructions>\nAnswer in short bullets.\n</user-instructions>"));
  assert.equal(prefix[2]!.role, "system");
  assert.ok(prefix[2]!.content.includes("<project-instructions>\nWrite in British English.\n</project-instructions>"));
});

test("the project item lists the project's file names", async t => {
  const projects = new FakeProjects({ cccccccccccccccccccccccccccccccc: project("alice") }, [file("notes.md"), file("data.csv")]);
  const { message, run, lastPrefix } = setup(t, { projects });
  await run(message("1", "alice", { project: "cccccccccccccccccccccccccccccccc" }));
  const item = lastPrefix().at(-1)!.content;
  assert.ok(item.includes("notes.md"));
  assert.ok(item.includes("data.csv"));
});

test("a message without a project gets no project item", async t => {
  const projects = new FakeProjects({ cccccccccccccccccccccccccccccccc: project("alice", "Write in British English.") }, [file("notes.md")]);
  const { message, run, lastPrefix } = setup(t, { projects });
  await run(message("1", "alice"));
  assert.equal(lastPrefix().length, 1);
});

test("another owner's project gives no project item", async t => {
  const projects = new FakeProjects({ cccccccccccccccccccccccccccccccc: project("bob", "Write in British English.") }, [file("notes.md")]);
  const { message, run, lastPrefix } = setup(t, { projects });
  await run(message("1", "alice", { project: "cccccccccccccccccccccccccccccccc" }));
  assert.equal(lastPrefix().length, 1);
  assert.ok(!lastPrefix()[0]!.content.includes("Write in British English."));
});

test("a deleted project gives no project item", async t => {
  const projects = new FakeProjects({});
  const { message, run, lastPrefix } = setup(t, { projects });
  await run(message("1", "alice", { project: "cccccccccccccccccccccccccccccccc" }));
  assert.equal(lastPrefix().length, 1);
});

test("a project message in a server channel gets no project item", async t => {
  const projects = new FakeProjects({ cccccccccccccccccccccccccccccccc: project("alice", "Write in British English.") }, [file("notes.md")]);
  const { message, run, lastPrefix } = setup(t, { projects });
  await run(message("1", "alice", { channel: "c", project: "cccccccccccccccccccccccccccccccc" }));
  assert.equal(lastPrefix().length, 1);
});

test("a failing project store still gets an answer, without the project item", async t => {
  t.mock.method(console, "warn", () => {});
  const projects = new FakeProjects({ cccccccccccccccccccccccccccccccc: project("alice") }, [], true);
  const { llm, message, run, lastPrefix } = setup(t, { projects });
  const reply = await run(message("1", "alice", { project: "cccccccccccccccccccccccccccccccc" }));
  assert.ok(reply, "the run answers");
  assert.equal(llm.prompts.length, 1);
  assert.equal(lastPrefix().length, 1);
});
