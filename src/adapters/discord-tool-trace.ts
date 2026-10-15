import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type ButtonInteraction } from 'discord.js';
import type { Json, Message } from '../domain.js';
import type { RecordStore } from '../records.js';
import { uiKey } from '../ui/runtime.js';
import { TOOL_TRACE_KIND, TOOL_TRACE_CURSOR_KIND, tracePage, type ToolTrace, type TraceCursor } from '../tool-trace.js';

export function toolTraceRows(id: string): ActionRowBuilder<ButtonBuilder>[] {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`sloptrace:${id}`).setLabel('Tool runs').setStyle(ButtonStyle.Secondary),
  )];
}

/** Like history.next, each page uses a saved, expiring cursor bound to the reader and channel. */
export async function handleToolTrace(interaction: ButtonInteraction, store: RecordStore, authorize: (message: Message) => Promise<void>): Promise<void> {
  const paging = interaction.customId.startsWith('sloptracepage:');
  if (paging) await interaction.deferUpdate(); else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const show = (content: string) => interaction.editReply({ content, components: [], allowedMentions: { parse: [] } });
  const server = interaction.guildId;
  if (!server) { await show('This tool trace is unavailable.'); return; }
  let id = interaction.customId.slice('sloptrace:'.length), index = 0;
  if (paging) {
    const cursor = (await store.record(server, TOOL_TRACE_CURSOR_KIND, interaction.customId.slice('sloptracepage:'.length)))?.value as unknown as TraceCursor | undefined;
    if (!cursor || cursor.actor !== interaction.user.id || cursor.channel !== interaction.channelId || !(cursor.expires > Date.now())) {
      await show('This page cursor expired or belongs to another reader. Open Tool runs again.'); return;
    }
    id = cursor.trace; index = cursor.index;
  }
  const trace = (await store.record(server, TOOL_TRACE_KIND, id))?.value as unknown as ToolTrace | undefined;
  if (!trace || trace.channel !== interaction.channelId || !(trace.expires > Date.now()) || !Number.isSafeInteger(index) || !trace.steps[index]) {
    await show('This tool trace expired or is unavailable in this channel.'); return;
  }
  if (trace.owner !== interaction.user.id) { await show('These tool runs belong to the requester.'); return; }
  const message: Message = { server, channel: interaction.channelId, id: `interaction:${interaction.id}`, author: interaction.user.id, text: '' };
  try { await authorize(message); } catch { await show('You no longer have access to this tool trace.'); return; }
  const controls = new ActionRowBuilder<ButtonBuilder>();
  for (const [label, target] of [['Previous', index - 1], ['Next', index + 1]] as const) {
    const disabled = target < 0 || target >= trace.steps.length;
    const cursor = uiKey(`${id}:${interaction.user.id}:${target}`);
    if (!disabled) await store.putRecord(server, TOOL_TRACE_CURSOR_KIND, cursor, {
      trace: id, index: target, actor: interaction.user.id, channel: interaction.channelId, expires: trace.expires,
    } as unknown as Json, 0);
    controls.addComponents(new ButtonBuilder().setCustomId(`sloptracepage:${cursor}`).setLabel(label).setDisabled(disabled).setStyle(ButtonStyle.Secondary));
  }
  await interaction.editReply({ content: tracePage(trace, index), components: [controls], allowedMentions: { parse: [] } });
}
