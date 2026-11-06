import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatShare } from "../api-types";
import { SharePanel } from "./share-dialog";

/** The panel rendered with the share list already loaded, as it is after the list query answers. */
function render(shares: ChatShare[]): string {
  const client = new QueryClient();
  client.setQueryData(["shares", "chat-1"], shares);
  return renderToString(<QueryClientProvider client={client}><SharePanel chatId="chat-1" onClose={() => {}} /></QueryClientProvider>);
}

const link = (newer: boolean): ChatShare => ({ id: "s1", created_at: 1000, revoked: false, frozen_at: 2000, newer });
const addButton = (html: string) => /<button[^>]*>\s*Add new messages\s*<\/button>/.exec(html)?.[0];

describe("Add new messages", () => {
  it("is disabled when the chat has nothing newer than the link", () => {
    expect(addButton(render([link(false)]))).toMatch(/ disabled=""/);
  });
  it("is enabled when the chat has newer messages", () => {
    const button = addButton(render([link(true)]));
    expect(button).toBeDefined();
    expect(button).not.toMatch(/ disabled=""/);
  });
  it("is absent without an active link", () => {
    expect(addButton(render([{ ...link(true), revoked: true }]))).toBeUndefined();
  });
});
