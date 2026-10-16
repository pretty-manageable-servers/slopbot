import { errorReply, logError } from "../errors.js";
import {
  MessageFlags,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { Message } from "../domain.js";
import { ToolError } from "../tools.js";
import type { UiRuntime } from "../ui/runtime.js";
import { discordUi } from "./discord-ui.js";
export async function handleDiscordUi(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  runtime: UiRuntime,
  scope?: { server: string; channel: string },
): Promise<void> {
  if ((!scope && !interaction.guildId) || !interaction.channelId) return;
  const message: Message = {
    server: scope?.server ?? interaction.guildId!,
    channel: scope?.channel ?? interaction.channelId,
    author: interaction.user.id,
    id: `interaction:${interaction.id}`,
    text: "UI action",
    timestamp: Date.now(),
  };
  const [, id, revision, rawIndex] = interaction.customId.split(":");
  try {
    await interaction.deferUpdate();
    const index = interaction.isStringSelectMenu()
      ? Number(interaction.values[0])
      : Number(rawIndex);
    if (
      !id ||
      !Number.isSafeInteger(Number(revision)) ||
      !Number.isSafeInteger(index)
    )
      throw new ToolError("Invalid control.");
    const result = await runtime.act(
      message,
      id,
      Number(revision),
      index,
      interaction.id,
    );
    await interaction.editReply({
      ...discordUi(result.document, id, result.revision),
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    logError("ui_action_failed", error, { stage: "UI action", server: message.server, channel: message.channel, messageId: message.id });
    if (id) {
      try {
        const current = await runtime.current(message, id);
        await interaction.editReply({
          ...discordUi(current.document, id, current.revision, current.pending),
          allowedMentions: { parse: [] },
        });
      } catch (recoveryError) {
        logError("ui_recovery_display_failed", recoveryError, { stage: "UI recovery", messageId: message.id }, true);
      }
    }
    const content = errorReply(error);
    if (interaction.deferred || interaction.replied)
      await interaction.followUp({
        content,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    else
      await interaction.reply({
        content,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
  }
}
