import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type ButtonInteraction, type MessageCreateOptions } from "discord.js";
import { errorReply, logError } from "../errors.js";
import type { Json, Message } from "../domain.js";
import type { RecordStore } from "../records.js";
import type { ConfirmationRequired, ToolArgs, ToolJournal, ToolRegistry } from "../tools.js";
import { displayToolResult, ToolError, toolFailed } from "../tools.js";
import type { ToolActivity } from "../tool-activity.js";
import { toolTraceRows } from "./discord-tool-trace.js";
import { pruneToolTraces } from "../tool-trace.js";
import { codeBlock, codeParts, PROGRAM_CODE_KEEP_MS } from "../code-display.js";

const PROGRAM_TOOL = "run_tools_code";
const CODE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const CONFIRM_ARGS_CHARS = 1500;
export const CONFIRM_RECORD = "tool-confirm";
const CONFIRM_ID = /^slopconfirm:(.+):(yes|no)$/;

/** The record store and the operation journal that the code buttons read and write. */
export type CodeStore = RecordStore & Pick<ToolJournal, "operation" | "pruneOperations">;
/** The tool runner that a confirmed call goes through. */
export type CodeRunner = Pick<ToolRegistry, "invokeResult">;

/** One entry point for all tool runs in a reply. Legacy slopcode buttons remain readable. */
export function showCodeRows(activity: readonly ToolActivity[], mode: "none" | "summary" | "full", traceId = activity[0]?.id): ActionRowBuilder<ButtonBuilder>[] {
  return mode !== "none" && activity.length && traceId ? toolTraceRows(traceId) : [];
}

/** Posts the Confirm and Cancel message for a call that stopped a run_tools_code program. The record is saved before this runs. */
export async function postConfirmation(channel: { send(options: MessageCreateOptions): Promise<unknown> }, call: ConfirmationRequired["call"], requester: string): Promise<void> {
  const json = JSON.stringify(call.arguments, null, 2) ?? "{}";
  const shown = json.length > CONFIRM_ARGS_CHARS ? `${json.slice(0, CONFIRM_ARGS_CHARS - 1)}…` : json;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`slopconfirm:${call.operationId}:yes`).setLabel("Confirm").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`slopconfirm:${call.operationId}:no`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
  );
  await channel.send({
    content: `<@${requester}> Confirm this action to let the code run continue.\n**${call.name}**\n${codeBlock(shown, "json")}`,
    components: [row],
    allowedMentions: { users: [requester] },
  });
}

/** Routes a slopcode button: replies ephemerally with the program code. */
export async function handleShowCode(interaction: ButtonInteraction, store: CodeStore): Promise<void> {
  const operationId = interaction.customId.slice("slopcode:".length);
  const operation = operationId ? await store.operation(operationId) : undefined;
  const code = operation?.name === PROGRAM_TOOL && typeof operation.args.code === "string" ? operation.args.code : undefined;
  if (code === undefined) {
    await interaction.reply({ content: "This code is no longer kept.", flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }
  // Long code goes in several messages. A file attachment fails: discord.js rejects the FormData of this undici build.
  const [first, ...rest] = codeParts(code);
  await interaction.reply({ content: codeBlock(first!), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  for (const part of rest) await interaction.followUp({ content: codeBlock(part), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

interface PendingConfirmation { name: string; arguments: ToolArgs; channel: string; author: string; requestId?: string; taskId?: string; replyTo?: string }

function pendingOf(value: Json | undefined): PendingConfirmation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, Json>;
  if (record.done === true) return undefined;
  const args = record.arguments;
  if (typeof record.name !== "string" || typeof record.channel !== "string" || typeof record.author !== "string") return undefined;
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  return { name: record.name, arguments: args as ToolArgs, channel: record.channel, author: record.author, ...(typeof record.requestId === "string" ? { requestId: record.requestId } : {}), ...(typeof record.taskId === "string" ? { taskId: record.taskId } : {}), ...(typeof record.replyTo === "string" ? { replyTo: record.replyTo } : {}) };
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

/** Routes a slopconfirm button. Only the requester may click. Yes runs the saved call once; Cancel only ends the record. */
export async function handleConfirm(interaction: ButtonInteraction, store: CodeStore, tools: CodeRunner, scope?: { server: string; channel: string }): Promise<void> {
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
  // The record is marked done before the call runs, so a second click cannot run it again.
  // A Cancel is marked, so the program does not ask the same call again.
  if (!await store.putRecord(server, CONFIRM_RECORD, operationId, choice === "no" ? { done: true, cancelled: true } : { done: true }, record.revision)) { await notice("This confirmation was already handled."); return; }
  if (choice === "no") { await interaction.editReply({ content: "Cancelled.", components: [], allowedMentions: { parse: [] } }); return; }
  const message: Message = { server, channel: pending.channel, author: pending.author, id: pending.requestId ?? `interaction:${interaction.id}`, ...(pending.taskId ? { taskId: pending.taskId } : {}), ...(pending.replyTo ? { replyTo: pending.replyTo } : {}), text: `Confirmed ${pending.name}`, timestamp: Date.now() };
  let content: string;
  try {
    const result = await tools.invokeResult(message, pending.name, pending.arguments, operationId, "command");
    if (toolFailed(result)) throw new ToolError(result.reason ?? result.text, result.status === "failed" ? "failed" : "rejected");
    const shown = displayToolResult(result);
    content = `Confirmed ${pending.name}.\n${shown.length > 1800 ? `${shown.slice(0, 1799)}…` : shown}`;
  } catch (error) {
    logError("confirmed_tool_failed", error, { tool: pending.name, operationId, server, channel: pending.channel }, true);
    // Authorization failures happen before the journal starts. Keep the same approved call retryable.
    const retryable = await store.putRecord(server, CONFIRM_RECORD, operationId, record.value, record.revision + 1);
    content = `Could not complete ${pending.name}.\n${errorReply(error)}${retryable ? "\nThe saved action is still pending. Use Confirm to retry or Cancel." : ""}`;
    if (retryable) { await interaction.editReply({ content, allowedMentions: { parse: [] } }); return; }
  }
  await interaction.editReply({ content, components: [], allowedMentions: { parse: [] } });
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
