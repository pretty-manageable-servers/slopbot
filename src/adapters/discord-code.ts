import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type ButtonInteraction, type MessageCreateOptions } from "discord.js";
import { describeError, logError } from "../errors.js";
import type { Json, Message } from "../domain.js";
import type { RecordStore } from "../records.js";
import type { ConfirmationRequired, ToolArgs, ToolJournal, ToolRegistry } from "../tools.js";
import { displayToolResult, ToolError, toolFailed } from "../tools.js";
import type { ToolActivity } from "../tool-activity.js";
import { runTranscriptUrl, toolRunLinkRows, toolTraceRows } from "./discord-tool-trace.js";
import { pruneToolTraces } from "../tool-trace.js";
import { codeBlock, PROGRAM_CODE_KEEP_MS } from "../code-display.js";

const PROGRAM_TOOL = "run_tools_code";
const CODE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const CONFIRM_ARGS_CHARS = 1500;
export const CONFIRM_RECORD = "tool-confirm";
/** A pending Confirm record older than this is expired: a click shows Expired and runs nothing. */
export const CONFIRM_TTL_MS = 24 * 60 * 60 * 1000;
const CONFIRM_ID = /^slopconfirm:(.+):(yes|no)$/;

/** The record store and the operation journal that the code buttons read and write. */
export type CodeStore = RecordStore & Pick<ToolJournal, "operation" | "pruneOperations">;
/** The tool runner that a confirmed call goes through. */
export type CodeRunner = Pick<ToolRegistry, "invokeResult">;

/** One entry point for all tool runs in a reply. With web on, a link goes to the run transcript. Otherwise the in-Discord trace button. Legacy slopcode buttons remain readable. */
export function showCodeRows(activity: readonly ToolActivity[], mode: "none" | "summary" | "full", traceId = activity[0]?.id, link?: string): ActionRowBuilder<ButtonBuilder>[] {
  if (mode === "none" || !activity.length) return [];
  if (link) return toolRunLinkRows(link);
  return traceId ? toolTraceRows(traceId) : [];
}

/** The transcript link for a reply, or undefined when web is off or the reply has no run to show. The last run of the reply is used. */
export function replyRunLink(origin: string | undefined, server: string, channel: string, runIds: readonly string[]): string | undefined {
  const runId = runIds.at(-1);
  return origin && runId ? runTranscriptUrl(origin, server, channel, runId) : undefined;
}

/** The Confirm and Cancel row. Disabled buttons stay visible after the record is expired or handled. */
function confirmRow(operationId: string, disabled = false): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`slopconfirm:${operationId}:yes`).setLabel("Confirm").setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`slopconfirm:${operationId}:no`).setLabel("Cancel").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  );
}

/** Posts the Confirm and Cancel message for a call that stopped a run_tools_code program. The record is saved before this runs. */
export async function postConfirmation(channel: { send(options: MessageCreateOptions): Promise<unknown> }, call: ConfirmationRequired["call"], requester: string): Promise<void> {
  const json = JSON.stringify(call.arguments, null, 2) ?? "{}";
  const shown = json.length > CONFIRM_ARGS_CHARS ? `${json.slice(0, CONFIRM_ARGS_CHARS - 1)}…` : json;
  await channel.send({
    content: `<@${requester}> Confirm this action to let the code run continue.\n**${call.name}**\n${codeBlock(shown, "json")}`,
    components: [confirmRow(call.operationId)],
    allowedMentions: { users: [requester] },
  });
}

interface PendingConfirmation { name: string; arguments: ToolArgs; channel: string; author: string; createdAt: number; requestId?: string; taskId?: string; replyTo?: string }

function pendingOf(value: Json | undefined): PendingConfirmation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, Json>;
  if (record.done === true) return undefined;
  const args = record.arguments;
  if (typeof record.name !== "string" || typeof record.channel !== "string" || typeof record.author !== "string") return undefined;
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  // A record without createdAt is treated as expired.
  return { name: record.name, arguments: args as ToolArgs, channel: record.channel, author: record.author, createdAt: typeof record.createdAt === "number" ? record.createdAt : 0, ...(typeof record.requestId === "string" ? { requestId: record.requestId } : {}), ...(typeof record.taskId === "string" ? { taskId: record.taskId } : {}), ...(typeof record.replyTo === "string" ? { replyTo: record.replyTo } : {}) };
}

/** Saves a pending confirmation. A record that is still pending is kept, so its Confirm and Cancel buttons still work. A done record is replaced. Retries a revision conflict, and throws rather than losing the record. */
export async function saveConfirmation(store: RecordStore, server: string, operationId: string, value: Json): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const previous = await store.record(server, CONFIRM_RECORD, operationId);
    if (previous && (previous.value as Record<string, Json> | undefined)?.done !== true) return;
    if (await store.putRecord(server, CONFIRM_RECORD, operationId, value, previous?.revision ?? 0)) return;
  }
  throw new Error("Confirmation record kept changing while it was saved");
}

/** Starts a new model turn for a confirmed call. The bot wires it to the worker: the note is saved, then queued on the original channel. */
export type ConfirmResume = (note: Message) => Promise<void>;

/** Routes a slopconfirm button. Only the requester may click. Yes runs the saved call once; Cancel only ends the record.
 * The outcome, success or failure, goes to the model in a new turn, so the model can explain or retry. The channel shows only "Confirmed.". */
export async function handleConfirm(interaction: ButtonInteraction, store: CodeStore, tools: CodeRunner, scope?: { server: string; channel: string }, resume?: ConfirmResume): Promise<void> {
  const match = CONFIRM_ID.exec(interaction.customId);
  const server = scope?.server ?? interaction.guildId;
  await interaction.deferUpdate();
  const notice = (content: string) => interaction.followUp({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  if (!match || !server) { await notice("This confirmation is no longer pending."); return; }
  const operationId = match[1]!, choice = match[2];
  const record = await store.record(server, CONFIRM_RECORD, operationId);
  const pending = pendingOf(record?.value);
  if (!record || !pending) { await notice("This confirmation is no longer pending."); return; }
  if (pending.channel !== (scope?.channel ?? interaction.channelId)) { await notice("This confirmation belongs to another channel."); return; }
  if (interaction.user.id !== pending.author) { await notice("Only the requester can confirm this action."); return; }
  // An expired record runs nothing. Its buttons are disabled, so the click ends here.
  if (Date.now() - pending.createdAt > CONFIRM_TTL_MS) {
    if (await store.putRecord(server, CONFIRM_RECORD, operationId, { done: true, expired: true }, record.revision))
      await interaction.editReply({ content: "Expired. This action was not run.", components: [confirmRow(operationId, true)], allowedMentions: { parse: [] } });
    return;
  }
  // The record is marked done before the call runs, so a second click cannot run it again.
  // A Cancel is marked, so the program does not ask the same call again.
  if (!await store.putRecord(server, CONFIRM_RECORD, operationId, choice === "no" ? { done: true, cancelled: true } : { done: true }, record.revision)) { await notice("This confirmation was already handled."); return; }
  if (choice === "no") { await interaction.editReply({ content: "Cancelled.", components: [], allowedMentions: { parse: [] } }); return; }
  let note: string;
  try {
    const result = await tools.invokeResult({ server, channel: pending.channel, author: pending.author, id: pending.requestId ?? `interaction:${interaction.id}`, ...(pending.taskId ? { taskId: pending.taskId } : {}), ...(pending.replyTo ? { replyTo: pending.replyTo } : {}), text: `Confirmed ${pending.name}`, timestamp: Date.now() }, pending.name, pending.arguments, operationId, "command");
    if (toolFailed(result)) throw new ToolError(result.reason ?? result.text, result.status === "failed" ? "failed" : "rejected");
    note = `Confirmed ${pending.name}. Result:\n${displayToolResult(result)}`;
  } catch (error) {
    logError("confirmed_tool_failed", error, { tool: pending.name, operationId, server, channel: pending.channel }, true);
    note = `Confirmed ${pending.name} failed: ${describeError(error).message}`;
  }
  await interaction.editReply({ content: "Confirmed.", components: [], allowedMentions: { parse: [] } });
  // The model gets the outcome in a new turn on the original channel. Raw errors stay out of the channel.
  if (resume) await resume({ id: `confirm-result:${operationId}`, server, channel: pending.channel, author: pending.author, text: note, addressed: true, ...(pending.taskId ? { taskId: pending.taskId } : {}), ...(pending.replyTo ? { replyTo: pending.replyTo } : {}), timestamp: Date.now() });
}

/** Deletes program code older than PROGRAM_CODE_KEEP_MS, once an hour. Returns a function that stops the timer. */
export function startCodeMaintenance(store: Pick<CodeStore, "pruneOperations"> & RecordStore, server: string): () => void {
  const timer = setInterval(() => {
    void pruneToolTraces(store, server).catch(error => logError("tool_trace_prune_failed", error, {}, true));
    void Promise.resolve(store.pruneOperations?.(PROGRAM_TOOL, Date.now() - PROGRAM_CODE_KEEP_MS))
      .catch(error => logError("run_tools_code_prune_failed", error, {}, true));
  }, CODE_PRUNE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
