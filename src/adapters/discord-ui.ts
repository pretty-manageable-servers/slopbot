import {
  suppressLinkPreviews,
  tablesToLists,
} from "../presentation/discord.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  TextDisplayBuilder,
  StringSelectMenuBuilder,
  type APIMessageTopLevelComponent,
} from "discord.js";
import type { UiDocument } from "../ui/schema.js";
export function discordUi(
  document: UiDocument,
  id: string,
  revision: number,
  disabled = false,
) {
  if (document.type === "poll")
    return {
      poll: {
        question: { text: document.question },
        answers: document.answers.map((text) => ({ text })),
        duration: document.durationHours,
        allowMultiselect: document.multiple ?? false,
      },
    };
  const title = document.title ? `**${document.title}**\n` : "";
  const text = {
    type: 10 as const,
    content: title + tablesToLists(document.text).slice(0,3500),
  };
  const components: APIMessageTopLevelComponent[] = [text];
  let buttons: ActionRowBuilder<ButtonBuilder> | undefined;
  if (document.type === "select") {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`slopui:${id}:${revision}:select`)
      .setDisabled(disabled)
      .setPlaceholder("Choose an action")
      .addOptions(
        document.options.map((action, index) => ({
          label: action.label,
          value: String(index),
        })),
      );
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>()
        .addComponents(select)
        .toJSON(),
    );
  } else if (document.actions?.length) {
    buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      document.actions.map((action, index) =>
        new ButtonBuilder()
          .setDisabled(disabled)
          .setLabel(action.label)
          .setStyle(ButtonStyle.Secondary)
          .setCustomId(`slopui:${id}:${revision}:${index}`),
      ),
    );
    components.push(buttons.toJSON());
  }
  const flags: ("IsComponentsV2" | "SuppressEmbeds")[] = ["IsComponentsV2"];
  if (suppressLinkPreviews(title + document.text)) flags.push("SuppressEmbeds");
  if (document.type === "card") {
    const card = new ContainerBuilder()
      .setAccentColor(0x5865f2)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(text.content),
      );
    if (buttons) card.addActionRowComponents(buttons);
    return { flags, components: [card.toJSON()] };
  }
  return { flags, components };
}
