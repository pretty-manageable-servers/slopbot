import type { UserLimiter } from "./user-limiter.js";
import { ToolError, type ToolRegistry } from "./tools.js";

const dollars = (micros: number) => `$${(micros / 1000000).toFixed(2)}`;

/** Lets a requester see their own spend and banked resets, and use one reset on a window. */
export function registerUsageTool(registry: ToolRegistry, limiter: UserLimiter): void {
  registry.register({
    name: "usage",
    description: "Show your spend in the 5-hour and weekly windows, with the reset time and banked resets. Action reset spends one banked reset to clear that window. Only your own usage is shown.",
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
      const windows = await limiter.usage(server, author);
      return windows.map(window => `${window.kind}: ${dollars(window.spent)} spent${window.limit ? ` of ${dollars(window.limit)}` : " (no limit)"}${window.resetAt ? `, resets <t:${Math.ceil(window.resetAt / 1000)}:R>` : ""}. Banked resets: ${window.banked}.`).join("\n");
    },
  });
}
