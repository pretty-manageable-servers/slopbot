import { describe, expect, test } from "vitest";
import { shareMessages, type ShareData } from "./share-data";

const message = (over: Partial<ShareData["messages"][number]>): ShareData["messages"][number] => ({ author: "A", bot: false, at: 1000, text: "", tools: [], thinking: "", images: [], files: [], other: 0, ...over });

describe("shareMessages", () => {
  test("a reply's widget becomes a done tool part with its input, before the reply text", () => {
    const widget = { widget_code: "<svg></svg>", title: "Heat" };
    const [, reply] = shareMessages({ id: "s", messages: [message({ text: "plot" }), message({ bot: true, author: "Slopbot", text: "Plotted", tools: [{ name: "show_widget", status: "Used tool show_widget", input: widget }] })] });
    expect(reply!.role).toBe("assistant");
    expect(reply!.parts.map((p) => p.type)).toEqual(["tool_call", "text"]);
    expect(reply!.parts[0]).toMatchObject({ name: "show_widget", status: "done", input: widget });
  });
});
