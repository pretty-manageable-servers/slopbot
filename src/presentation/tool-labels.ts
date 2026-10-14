export const slopbotEmoji = {
  pulse: "<a:slopbot_pulse:1559390627152531586>",
  bloom: "<a:slopbot_bloom:1559390625214898340>",
};
export const funLines = [
  "Blooming…", "Pollinating…", "Watering the petals…", "Planting ideas…", "Unfurling…",
  "Photosynthesizing…", "Growing roots…", "Catching sunlight…", "Sprouting…", "Gathering nectar…",
  "Turning toward light…", "Spreading seeds…", "Opening up…", "Drinking rain…", "Feeling the breeze…",
  "Making pollen…", "Tending the garden…", "Stretching stems…", "Rooting around…", "Growing taller…",
];
const special: Record<string, { emoji: string; group?: [string, string] }> = {
  web_search: { emoji: "🔎", group: ["web search", "web searches"] },
  history_search: { emoji: "📜", group: ["history search", "history searches"] },
  history_read: { emoji: "📖", group: ["message read", "message reads"] },
  file_read: { emoji: "📎" },
  memory: { emoji: "🧠" },
  memory_remember: { emoji: "🧠" },
  memory_forget: { emoji: "🧠" },
  reminder: { emoji: "⏰" },
  task_manage: { emoji: "📋" },
  task_start: { emoji: "📋" },
  task_status: { emoji: "📋" },
  task_retry: { emoji: "📋" },
  poll_create: { emoji: "📊" },
  sandbox: { emoji: "💻" },
  run_tools_code: { emoji: "🧩", group: ["code run", "code runs"] },
};
export const toolEmoji = (name: string): string => special[name]?.emoji ?? "🛠️";
// [singular, plural]; other tools use the name with spaces for both.
export const toolGroup = (name: string): [string, string] => {
  const words = name.replace(/_/g, " ");
  return special[name]?.group ?? [words, words];
};
export const escapeMarkdown = (text: string): string => text.replace(/\s+/g, " ").replace(/[\\`*_~<>|\[\]]/g, "\\$&");
// Short text for the "now" line. Only the query is shown, never other arguments.
export function currentStep(name: string, query: unknown): string {
  if (name === "history_read") return "reading a message";
  if (typeof query !== "string" || !query.trim()) return name;
  const short = query.length <= 60 ? query : query.slice(0, 59).replace(/[\uD800-\uDBFF]$/, "") + "…";
  return `"${escapeMarkdown(short)}"`;
}
