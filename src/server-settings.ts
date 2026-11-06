import type { Config } from "./config.js";
import { parseEffort } from "./domain.js";
import { decisionThresholds } from "./participation-history.js";
import { toolDisplayMode } from "./presentation/tool-activity.js";
import type { RuntimeStore } from "./runtime-store.js";

/** The server settings that the console shows to a server admin: the saved value, or the config default. */
export function serverSettingsSnapshot(config: Config, store: RuntimeStore, server: string): Record<string, unknown> {
  return {
    monitoring: store.setting(server, 'monitoring') ?? config.jevEnabled,
    participation_thresholds: decisionThresholds(store.setting(server, 'participation_thresholds'), config.jevThresholds),
    classifier_context: store.setting(server, 'classifier_context') ?? config.jevContextMessages,
    reply_context: store.setting(server, 'reply_context') ?? config.replyContextMessages,
    cooldown_seconds: store.setting(server, 'cooldown_seconds') ?? config.jevCooldownSeconds,
    max_unsolicited_per_hour: store.setting(server, 'max_unsolicited_per_hour') ?? config.jevMaxRepliesPerHour,
    tool_display: toolDisplayMode(store.setting(server, 'tool_display')),
    default_effort: parseEffort(store.setting(server, 'default_effort')) ?? 'default',
    timing_footer: store.setting(server, 'timing_footer') ?? false,
    mock: config.mock,
  };
}
