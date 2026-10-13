import { usageView, type UserLimiter } from "./user-limiter.js";
import { ToolError, type ToolRegistry } from "./tools.js";

/** Lets a requester see their own usage (as percents, never money) and banked resets, and use one reset on a window. */
export function registerUsageTool(registry: ToolRegistry, limiter: UserLimiter): void {
  registry.register({
    name: "usage",
    description: "Show your usage as a percent of the 5-hour and weekly limits, with the reset time and banked resets. Action reset spends one banked reset to clear that window. Only your own usage is shown. Never mention dollars or cost.",
    fields: {
      action: { type: "string", description: "Default: show", choices: ["show", "reset"] },
      window: { type: "string", description: "Window to reset (required for reset)", choices: ["5h", "week"] },
    },
    access: "member", effect: "read", retrySafe: false,
    writes: args => args.action === "reset",
    async execute(context, args) {
      const { server, author } = context.message;
      if (args.action === "reset") {
        const kind = String(args.window ?? "");
        if (!["5h", "week"].includes(kind)) throw new ToolError("Choose window 5h or week to reset.");
        if (!await limiter.useReset(server, author, kind)) throw new ToolError(`You have no banked ${kind} reset.`);
        return `Used one ${kind} reset. That window is cleared.`;
      }
      const windows = usageView(await limiter.usage(server, author)).windows;
      return windows.map(window => `${window.kind}: ${window.percent === null ? "no limit" : `${window.percent}% used`}${window.resetAt ? `, resets <t:${Math.ceil(window.resetAt / 1000)}:R>` : ""}. Banked resets: ${window.banked}.`).join("\n");
    },
  });
}
