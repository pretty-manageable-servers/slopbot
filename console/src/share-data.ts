// The frozen copy of the share page (sharePageData in src/shares.ts) as kit messages.
import type { Message, Part } from "agentic-ui-kit/core";

export interface ShareData {
  id: string;
  messages: {
    author: string; bot: boolean; at: number | null; text: string;
    tools: { name: string; status: string; input?: unknown }[];
    thinking: string;
    images: { src: string; name: string }[];
    files: { name: string; size: number }[];
    other: number;
  }[];
}

/** The kind of the custom part that names a message's author. */
export const AUTHOR = "share-author";

/** The copy as kit messages. Author lines are shown only when more than one person wrote. */
export function shareMessages(data: ShareData): Message[] {
  const people = new Set(data.messages.filter((m) => !m.bot).map((m) => m.author));
  return data.messages.map((message, index): Message => {
    const id = `share:${index}`;
    const parts: Part[] = [];
    if (people.size > 1) parts.push({ type: "custom", id: `${id}:author`, status: "done", kind: AUTHOR, data: message.author, text: message.author });
    message.images.forEach((image, n) => parts.push({ type: "attachment", id: `${id}:image:${n}`, status: "done", fileId: `${id}:image:${n}`, name: image.name, mime: "image/*", size: 0, url: image.src }));
    message.files.forEach((file, n) => parts.push({ type: "attachment", id: `${id}:file:${n}`, status: "done", fileId: `${id}:file:${n}`, name: file.name, mime: "application/octet-stream", size: file.size }));
    if (message.thinking) parts.push({ type: "thinking", id: `${id}:thinking`, text: message.thinking, status: "done" });
    message.tools.forEach((tool, n) => parts.push({ type: "tool_call", id: `${id}:tool:${n}`, name: tool.name, status: "done", inputJson: JSON.stringify(tool.input ?? {}), input: tool.input ?? {}, result: tool.status }));
    const extra = message.other ? `\n\n_${message.other === 1 ? "1 attachment is" : `${message.other} attachments are`} not in this copy._` : "";
    if (message.text || extra) parts.push({ type: "text", id: `${id}:text`, text: message.text + extra, status: "done" });
    return { id, parentId: null, role: message.bot ? "assistant" : "user", status: "done", parts, createdAt: new Date(message.at ?? 0).toISOString() };
  });
}

