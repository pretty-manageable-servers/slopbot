import { describe, expect, it } from "vitest";
import { buildSections, fuzzyScore, parseRecent, pushRecent, recentItems, type PaletteItem } from "./palette-search";

const none = { items: [] };
const chat = (key: string, name: string, ts?: number): PaletteItem => ({ key: `chat:${key}`, group: "chats", name, ts });

describe("fuzzy match", () => {
  it("matches a typo in a word of the text", () => {
    expect(fuzzyScore("hotfx", "Ship the hotfix")).toBeGreaterThan(0);
    expect(fuzzyScore("hotfx", "Ship the release")).toBe(0);
  });

  it("ignores accents and case", () => {
    expect(fuzzyScore("cafe", "Café au lait")).toBe(1);
    expect(fuzzyScore("CAFÉ", "cafe menu")).toBe(1);
  });

  it("matches the words of a query in any order, with a typo too", () => {
    expect(fuzzyScore("staging deploy", "Deploy to staging")).toBeGreaterThan(0);
    expect(fuzzyScore("stagng deploy", "Deploy to staging")).toBeGreaterThan(0);
  });

  it("returns zero when a query word matches nothing", () => {
    expect(fuzzyScore("zebra", "Deploy notes")).toBe(0);
    expect(fuzzyScore("deploy zebra", "Deploy notes")).toBe(0);
  });
});

describe("sections", () => {
  it("ranks a text match above a typo match, and drops rows that match nothing", () => {
    const items = [chat("a", "Plsn"), chat("b", "The plan"), chat("c", "Standup")];
    const [section] = buildSections(items, "plan", "chats", [], none);
    expect(section!.items.map(item => item.name)).toEqual(["The plan", "Plsn"]);
  });

  it("shows the empty-field recents, then the actions, under All", () => {
    const items = [chat("a", "Old", 1), chat("b", "New", 2), { key: "action:new", group: "actions" as const, name: "New chat" }];
    const recent = recentItems(items, []);
    expect(buildSections(items, "", "all", recent, none).map(section => section.title)).toEqual(["Recent", "Actions"]);
  });

  it("gives a message hint under the Messages filter until two letters are typed", () => {
    const [section] = buildSections<PaletteItem>([], "a", "messages", [], none);
    expect(section!.status).toMatch(/two or more letters/);
  });
});

describe("recent picks", () => {
  it("puts the picked rows first, then the newest chats, at most six", () => {
    const items = [1, 2, 3, 4, 5, 6, 7].map(n => chat(String(n), `Chat ${n}`, n));
    const recent = recentItems(items, ["chat:2", "chat:gone"]);
    expect(recent.map(item => item.key)).toEqual(["chat:2", "chat:7", "chat:6", "chat:5", "chat:4", "chat:3"]);
  });

  it("keeps the newest pick first without repeats, and treats a bad stored value as none", () => {
    let picks = parseRecent("not json");
    for (const key of ["a", "b", "c", "d", "e", "f", "g", "c"]) picks = pushRecent(picks, key);
    expect(picks).toEqual(["c", "g", "f", "e", "d", "b"]);
  });
});
