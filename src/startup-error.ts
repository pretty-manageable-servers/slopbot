// Classify errors without exposing provider bodies, request headers or tokens.
export function discordStartupError(error: unknown): string {
  const value = typeof error === "object" && error !== null
    ? error as { message?: unknown; code?: unknown; cause?: { code?: unknown } }
    : {};
  const message = typeof value.message === "string" ? value.message.toLowerCase() : "";
  const code = value.code ?? value.cause?.code;
  if (message.includes("disallowed intents") || code === 4014) {
    return "Discord rejected Message Content Intent. Open Developer Portal > your application > Bot > Privileged Gateway Intents, enable Message Content Intent, save, and restart.";
  }
  if (code === "TokenInvalid" || code === 4004 || message.includes("invalid token")) {
    return "Discord rejected the bot token. Update DISCORD_BOT_TOKEN in .env using the token from your application's Bot page.";
  }
  if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ETIMEDOUT"].includes(String(code))) {
    return "Discord is unreachable. Check network/DNS access; if running in a restricted sandbox, run npm start in your local terminal.";
  }
  return "Discord login failed. Check the bot token, gateway intents, and network access.";
}
