import { SlashCommandBuilder, ChannelType } from "discord.js";
import type { ToolRegistry } from "../tools.js";

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
        if (field.choices) option.addChoices(...field.choices.map(value => ({ name: value, value })));
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
