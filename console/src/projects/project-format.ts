// Project rules the console checks before it sends, the words for the codes the bot answers with, and the copy of the
// delete confirm. The limits are the bot's (ProjectLimits in api-types.ts). The pages are in the project files.
import type { ProjectLimits } from "../api-types";

export const NAME_MAX = 80;
export const DESCRIPTION_MAX = 500;
export const INSTRUCTIONS_MAX = 8000;

const KB = 1024;
const MB = 1024 * KB;

/** Length in characters as the bot counts them: an emoji is one. */
export const textLength = (text: string) => [...text].length;

/** "one file", "2 files". */
export const plural = (count: number, word: string) => `${count} ${count === 1 ? word : `${word}s`}`;

const oneDecimal = (value: number) => Number(value.toFixed(1));

/** A size as the console shows it: 512 KB, 1.4 MB, 25 MB. */
export function sizeText(bytes: number): string {
  return bytes < MB ? `${oneDecimal(bytes / KB)} KB` : `${oneDecimal(bytes / MB)} MB`;
}

/** The project's use of its storage and files: "used 1.2 MB of 25 MB, 3 of 20 files". */
export function usageText(usedBytes: number, fileCount: number, limits: ProjectLimits): string {
  return `used ${sizeText(usedBytes)} of ${sizeText(limits.maxProjectBytes)}, ${fileCount} of ${limits.maxFiles} files`;
}

/** Why a name cannot be saved, or null. A name is 1 to 80 characters once trimmed. */
export function nameProblem(name: string): string | null {
  const text = name.trim();
  if (!text) return "Give the project a name.";
  if (textLength(text) > NAME_MAX) return `A name is ${NAME_MAX} characters or fewer.`;
  return null;
}

/** Why a description cannot be saved, or null. */
export function descriptionProblem(description: string): string | null {
  return textLength(description) > DESCRIPTION_MAX ? `A description is ${DESCRIPTION_MAX} characters or fewer.` : null;
}

/** The file limit a file breaks, as the bot's error code, or null when it fits. `usage` is the project's files now,
 *  plus the files already added in this batch. */
export function fileProblem(file: { size: number }, usage: { files: number; bytes: number }, limits: ProjectLimits): "file_too_large" | "file_limit" | "project_full" | null {
  if (file.size > limits.maxFileBytes) return "file_too_large";
  if (usage.files >= limits.maxFiles) return "file_limit";
  if (usage.bytes + file.size > limits.maxProjectBytes) return "project_full";
  return null;
}

/** The words for a bot error code, or null for any other code (those are shown as the notice). */
export function projectErrorText(code: string, limits: ProjectLimits): string | null {
  switch (code) {
    case "project_limit": return `You have reached the limit of ${plural(limits.maxProjects, "project")}. Delete one to make another.`;
    case "file_too_large": return `That file is larger than ${sizeText(limits.maxFileBytes)}.`;
    case "file_limit": return `A project holds ${plural(limits.maxFiles, "file")}. Remove one to add another.`;
    case "project_full": return `This project is full: it holds ${sizeText(limits.maxProjectBytes)} of files. Remove some to add more.`;
    case "storage_unavailable": return "Files are not available right now. Try again in a moment.";
    case "project_failed": return "The project could not be saved. Try again.";
    default: return null;
  }
}

/** The body of the delete confirm: how many chats go with the project. */
export function deleteProjectText(chatCount: number): string {
  const chats = chatCount === 0 ? "It has no chats." : `This also deletes its ${plural(chatCount, "chat")}.`;
  return `${chats} Its files and memories are deleted too. This cannot be undone.`;
}
