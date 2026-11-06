import { describe, expect, it } from "vitest";
import { buildSections, fuzzyScore, parseRecent, pushRecent, recentItems, type PaletteItem } from "./palette-search";

const none = { items: [] };
const chat = (key: string, name: string, ts?: number): PaletteItem => ({ key: `chat:${key}`, group: "chats", name, ts });

describe("fuzzy match", () => {
  const matches: [string, string][] = [
    ["hotfx", "Ship the hotfix"],
    ["CAFÉ", "cafe menu"],
    ["staging deploy", "Deploy to staging"],
    ["stagng deploy", "Deploy to staging"],
  ];
  it.each(matches)("%j matches %j", (query, text) => {
    expect(fuzzyScore(query, text)).toBeGreaterThan(0);
  });

  it.each([["hotfx", "Ship the release"], ["deploy zebra", "Deploy notes"]])("%j does not match %j", (query, text) => {
    expect(fuzzyScore(query, text)).toBe(0);
  });
});

describe("sections", () => {
  it("ranks a text match above a typo match, and drops rows that match nothing", () => {
    const items = [chat("a", "Plsn"), chat("b", "The plan"), chat("c", "Standup")];
    const [section] = buildSections(items, "plan", "chats", [], none);
    expect(section!.items.map(item => item.name)).toEqual(["The plan", "Plsn"]);
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
