import { SlashCommandBuilder, ChannelType, type APIEmbed } from "discord.js";
import type { ToolRegistry } from "../tools.js";
import { usageView, type UsageView, type UserLimiter } from "../user-limiter.js";

const WINDOW_LABELS: Record<string, string> = { "5h": "5-hour", week: "weekly" };
const BAR_BLOCKS = 10;

/** The top-level /usage command. One optional reset choice and no subcommands. */
export function buildUsageCommand(): SlashCommandBuilder {
  const command = new SlashCommandBuilder().setName("usage").setDescription("See your Slopbot usage and limits");
  command.addStringOption(option => option.setName("reset").setDescription("Use one banked reset on this window").setRequired(false)
    .addChoices({ name: "5-hour", value: "5h" }, { name: "weekly", value: "week" }));
  return command;
}

/** A text bar of 10 blocks. No limit gives an empty bar. */
export function usageBar(percent: number | null): string {
  const filled = percent === null ? 0 : Math.round(percent / 100 * BAR_BLOCKS);
  return "▰".repeat(filled) + "▱".repeat(BAR_BLOCKS - filled);
}

/** The /usage embed. Shows percents, reset times and banked resets only. Never money. */
export function usageEmbed(view: UsageView): APIEmbed {
  return {
    title: "Your Slopbot usage",
    description: `Plan: ${view.plan} (free)`,
    fields: view.windows.map(window => ({
      name: WINDOW_LABELS[window.kind] ?? window.kind,
      value: [
        window.percent === null ? `${usageBar(null)} No limit` : `${usageBar(window.percent)}\n${window.percent}% used`,
        ...(window.resetAt ? [`resets <t:${Math.ceil(window.resetAt / 1000)}:R>`] : []),
        `Banked resets: ${window.banked}`,
      ].join("\n"),
    })),
  };
}

export interface UsageReply { content?: string; embeds: APIEmbed[] }

/**
 * Builds the /usage reply for one user. Read-only, and it never checks the UserLimiter gate,
 * so a user over the limit still sees their usage and can use a banked reset.
 */
export async function usageReply(limiter: UserLimiter, user: string, reset: string | null): Promise<UsageReply> {
  if (reset !== null) {
    if (reset !== "5h" && reset !== "week") return { content: "Choose 5-hour or weekly to reset.", embeds: [] };
    if (!await limiter.useReset(user, reset)) return { content: `You have no banked ${WINDOW_LABELS[reset]} reset.`, embeds: [] };
    return { content: `Used one ${WINDOW_LABELS[reset]} reset. That window is cleared.`, embeds: [usageEmbed(usageView(await limiter.usage(user)))] };
  }
  return { embeds: [usageEmbed(usageView(await limiter.usage(user)))] };
}

export function buildToolCommands(registry: ToolRegistry): SlashCommandBuilder {
  const command = new SlashCommandBuilder().setName("slopbot").setDescription("Slopbot tools, settings and diagnostics");
  // Discord limits subcommands. The generic runner reaches every registered connector.
  for (const tool of registry.definitions().filter(tool => !tool.provider?.startsWith('mcp:')).slice(0, 24)) command.addSubcommand(subcommand => {
    subcommand.setName(tool.name).setDescription(tool.description.slice(0, 100));
    const fields = Object.entries(tool.fields).sort((a, b) => Number(Boolean(b[1].required)) - Number(Boolean(a[1].required)));
    for (const [name, field] of fields) {
      const description = field.description.slice(0, 100), required = Boolean(field.required);
      if (field.type === "boolean") subcommand.addBooleanOption(option => option.setName(name).setDescription(description).setRequired(required));
      else if (field.type === "integer") subcommand.addIntegerOption(option => option.setName(name).setDescription(description).setRequired(required).setMinValue(field.min ?? 0).setMaxValue(field.max ?? 1000000));
      else if (field.type === "channel") subcommand.addChannelOption(option => option.setName(name).setDescription(description).setRequired(required).addChannelTypes(ChannelType.GuildText, ChannelType.PublicThread));
      else subcommand.addStringOption(option => {
        option.setName(name).setDescription(description).setRequired(required).setMaxLength(Math.min(field.max ?? 4000, 6000));
        // Larger enums accept typed input; ToolRegistry still validates every value.
        if (field.choices?.length && field.choices.length <= 25) option.addChoices(...field.choices.map(value => ({ name: value, value })));
        return option;
      });
    }
    return subcommand;
  });
  command.addSubcommand(subcommand => subcommand.setName("run").setDescription("Run any registered tool, including external connectors")
    .addStringOption(option => option.setName("tool").setDescription("Registered tool name").setRequired(true))
    .addStringOption(option => option.setName("arguments").setDescription("JSON object of tool arguments").setMaxLength(6000)));
  return command;
}
