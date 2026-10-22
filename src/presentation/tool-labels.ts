export const slopbotEmoji = {
  pulse: "<a:slopbot_pulse:1559390627152531586>",
  bloom: "<a:slopbot_bloom:1559390625214898340>",
};
export const funLines = [
  "Accomplishing…", "Actualizing…", "Baking…", "Brewing…", "Calculating…",
  "Cerebrating…", "Churning…", "Clauding…", "Coalescing…", "Cogitating…",
  "Computing…", "Conjuring…", "Considering…", "Cooking…", "Crafting…",
  "Creating…", "Crunching…", "Deliberating…", "Determining…", "Doing…",
  "Finagling…", "Forging…", "Forming…", "Generating…", "Hatching…",
  "Herding…", "Honking…", "Hustling…", "Ideating…", "Inferring…",
  "Manifesting…", "Marinating…", "Moseying…", "Mulling…", "Mustering…",
  "Musing…", "Noodling…", "Percolating…", "Pondering…", "Processing…",
  "Puttering…", "Reticulating…", "Ruminating…", "Schlepping…", "Shucking…",
  "Simmering…", "Smooshing…", "Spinning…", "Stewing…", "Synthesizing…",
  "Thinking…", "Transmuting…", "Vibing…", "Working…",
];
const special: Record<string, { emoji: string; group?: [string, string] }> = {
  web_search: { emoji: "🔎", group: ["web search", "web searches"] },
  history_search: { emoji: "📜", group: ["history search", "history searches"] },
  history_read: { emoji: "📖", group: ["message read", "message reads"] },
  view_image: { emoji: "🖼️", group: ["image view", "image views"] },
  attach_file: { emoji: "📎", group: ["file attach", "file attaches"] },
  read: { emoji: "📎" },
  write: { emoji: "📝" },
  edit: { emoji: "📝" },
  shell: { emoji: "💻" },
  memory: { emoji: "🧠" },
  memory_remember: { emoji: "🧠" },
  memory_update: { emoji: "🧠" },
  memory_forget: { emoji: "🧠" },
  reminder: { emoji: "⏰" },
  task_manage: { emoji: "📋" },
  task_start: { emoji: "📋" },
  task_status: { emoji: "📋" },
  task_retry: { emoji: "📋" },
  poll_create: { emoji: "📊" },
  issue_draft: { emoji: "📝", group: ["issue draft", "issue drafts"] },
  file_report: { emoji: "🐞", group: ["report filing", "report filings"] },
  sandbox_manage: { emoji: "💻" },
  run_tools_code: { emoji: "🧩", group: ["code run", "code runs"] },
};
export const toolEmoji = (name: string): string => special[name]?.emoji ?? "🛠️";
// [singular, plural]; other tools use the name with spaces for both.
export const toolGroup = (name: string): [string, string] => {
  const words = name.replace(/_/g, " ");
  return special[name]?.group ?? [words, words];
};
const times = (count: number): string => count > 1 ? ` ${count}×` : '';
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;
// Plain words for the footer, by tool and count. Other tools use their name with spaces.
const plainWordsOf: Record<string, (count: number) => string> = {
  history_search: count => `searched history${times(count)}`,
  history_read: count => `read ${plural(count, 'message')}`,
  web_search: count => `searched the web${times(count)}`,
  web_fetch: count => `read ${plural(count, 'page')}`,
  read: count => `read ${plural(count, 'file')}`,
  write: count => `wrote ${plural(count, 'file')}`,
  edit: count => `edited ${plural(count, 'file')}`,
  shell: count => `ran ${plural(count, 'command')}`,
  view_image: count => `viewed ${plural(count, 'image')}`,
  memory: count => `checked memory${times(count)}`,
  memory_remember: count => count === 1 ? 'saved a memory' : `saved ${count} memories`,
  memory_update: count => count === 1 ? 'updated a memory' : `updated ${count} memories`,
  memory_forget: count => count === 1 ? 'forgot a memory' : `forgot ${count} memories`,
  profile: count => count === 1 ? 'checked a profile' : `checked ${count} profiles`,
  reminder: count => count === 1 ? 'set a reminder' : `set ${count} reminders`,
  inbox_add: count => count === 1 ? 'added to inbox' : `added ${count} items to inbox`,
  inbox_done: count => `cleared ${plural(count, 'inbox item')}`,
  inbox_list: count => `read inbox${times(count)}`,
  schedule: count => `updated ${plural(count, 'schedule')}`,
  file_store: count => `read ${plural(count, 'stored file')}`,
  file_store_write: count => `saved ${plural(count, 'file')}`,
  attach_file: count => `attached ${plural(count, 'file')}`,
  issue_draft: count => count === 1 ? 'drafted an issue' : `drafted ${plural(count, 'issue')}`,
  file_report: count => count === 1 ? 'filed a report' : `filed ${count} reports`,
  bot_info: count => `read bot info${times(count)}`,
  task_start: count => count === 1 ? 'started a task' : `started ${count} tasks`,
  task_manage: count => `managed tasks${times(count)}`,
  task_status: count => `checked task status${times(count)}`,
  task_retry: count => count === 1 ? 'retried a task' : `retried ${count} tasks`,
  poll_create: count => count === 1 ? 'made a poll' : `made ${count} polls`,
  ui_publish: count => count === 1 ? 'published a view' : `published ${count} views`,
  sandbox_manage: count => `managed the sandbox${times(count)}`,
  usage: count => `checked usage${times(count)}`,
  run_tools_code: count => `ran code${times(count)}`,
  voice: count => `managed voice${times(count)}`,
  voice_say: count => `said ${plural(count, 'line')} aloud`,
  voice_skip: count => `skipped ${plural(count, 'transcript')}`,
};
// Tools without a phrase: the name in spaces, as a plain verb phrase. Never a × glued to the name.
export const plainWords = (name: string, count: number): string => {
  const label = name.replace(/_/g, ' ');
  return plainWordsOf[name]?.(count) ?? (count > 1 ? `used ${label} ${count} times` : `used ${label}`);
};
// True when the tool has its own footer phrase, so plainWords does not fall back to the tool name.
export const hasPlainWords = (name: string): boolean => Object.hasOwn(plainWordsOf, name);
export const escapeMarkdown = (text: string): string => text.replace(/\s+/g, " ").replace(/[\\`*_~<>|\[\]]/g, "\\$&");
// Short text for the "now" line. Only the query is shown, never other arguments.
export function currentStep(name: string, query: unknown): string {
  if (name === "history_read") return "reading a message";
  if (typeof query !== "string" || !query.trim()) return name;
  const short = query.length <= 60 ? query : query.slice(0, 59).replace(/[\uD800-\uDBFF]$/, "") + "…";
  return `"${escapeMarkdown(short)}"`;
}
