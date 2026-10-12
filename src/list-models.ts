import { logError } from "./errors.js";
// Loads only provider configuration; a Discord token is not needed.
const baseUrl = process.env.LLM_BASE_URL ?? "https://api.pmservers.org/ai/v1";
const key = process.env.LLM_API_KEY;
if (!key) { console.error("Set LLM_API_KEY in .env first."); process.exitCode = 1; }
else {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Models endpoint returned HTTP ${response.status}`);
    const body = await response.json() as { data?: { id?: unknown }[] };
    if (!Array.isArray(body.data)) throw new Error("Provider did not return a model list");
    for (const model of body.data) if (typeof model.id === "string") console.log(model.id);
  } catch (error) {
    logError("model_lookup_failed", error, { stage: "model discovery" }); process.exitCode = 1;
  }
}
