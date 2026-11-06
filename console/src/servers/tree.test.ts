import type { ChatSummary } from "agentic-ui-kit";
import { describe, expect, test } from "vitest";
import type { Conversation } from "../api-types";
import { serverSections } from "./tree";

const conversation = (over: Partial<Conversation> & Pick<Conversation, "id" | "name">): Conversation => ({
  kind: "channel", parent: null, newest: 1, canSend: true, enabled: true, ...over,
});
const href = (c: Conversation) => `/server/s1/channel/${c.id}`;

describe("serverSections", () => {
  test("puts channels and threads in their own sections, in the order the server sent", () => {
    const sections = serverSections([
      conversation({ id: "c2", name: "news", newest: 30 }),
      conversation({ id: "t1", name: "Bug hunt", kind: "thread", parent: "c1", newest: 20 }),
      conversation({ id: "c1", name: "general", newest: 10 }),
    ], href);
    expect(sections.map((s) => [s.id, s.items.map((i) => i.id)])).toEqual([
      ["channels", ["c2", "c1"]],
      ["threads", ["t1"]],
    ]);
  });

  test("a channel shows a hash before its name, a thread shows its name", () => {
    const [channels, threads] = serverSections([
      conversation({ id: "c1", name: "general" }),
      conversation({ id: "t1", name: "Bug hunt", kind: "thread", parent: "c1" }),
    ], href);
    expect(channels!.items).toEqual([{ id: "c1", title: "#general", href: "/server/s1/channel/c1" }]);
    expect(threads!.items).toEqual([{ id: "t1", title: "Bug hunt", href: "/server/s1/channel/t1" }]);
  });

  test("a channel with its transcripts off is still listed, with its title marked", () => {
    const [channels] = serverSections([conversation({ id: "c1", name: "general", enabled: false })], href);
    const [item] = channels!.items as ChatSummary[];
    expect(item).toMatchObject({ id: "c1", href: "/server/s1/channel/c1" });
    expect(item!.title).toContain("general");
    expect(item!.title).not.toBe("#general");
  });

  test("leaves out a section with nothing in it", () => {
    const sections = serverSections([conversation({ id: "c1", name: "general" })], href);
    expect(sections.map((s) => s.id)).toEqual(["channels"]);
  });

  test("no conversations, no sections", () => {
    expect(serverSections([], href)).toEqual([]);
  });
});
