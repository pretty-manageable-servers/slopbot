import { describe, expect, test } from "vitest";
import type { Conversation } from "../api-types";
import { serverSections } from "./tree";

const conversation = (over: Partial<Conversation> & Pick<Conversation, "id" | "name">): Conversation => ({
  kind: "channel", parent: null, newest: 1, canSend: true, enabled: true, ...over,
});

describe("serverSections", () => {
  test("puts channels and threads in their own sections, in the order the server sent", () => {
    const sections = serverSections([
      conversation({ id: "c2", name: "news", newest: 30 }),
      conversation({ id: "t1", name: "Bug hunt", kind: "thread", parent: "c1", newest: 20 }),
      conversation({ id: "c1", name: "general", newest: 10 }),
    ], (c) => `/server/s1/channel/${c.id}`);
    expect(sections.map((s) => [s.id, s.items.map((i) => i.id)])).toEqual([
      ["channels", ["c2", "c1"]],
      ["threads", ["t1"]],
    ]);
  });
});
