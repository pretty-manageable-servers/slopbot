import type { ChatDeps } from "../src/clients/web/web-chats.js";
import type { Workspace } from "../src/engine/api.js";
import { engineEvents } from "../src/engine/event-log.js";

type Fake = Partial<Workspace>;
const idle: Workspace = {
  server: "",
  async submit() { /* none */ },
  async stop() { return []; },
  async act() { throw new Error("no cards in this test"); },
  openChat() { /* none */ },
  closeChat() { /* none */ },
};

/** The chat service's engine and Discord directory as fakes. `workspace` is one fake for every server, or a function that answers per server (undefined = server not open). */
export function chatDeps(options: {
  member: (user: string, server: string) => boolean | Promise<boolean>;
  workspace?: Fake | ((server: string) => Fake | undefined);
  limiter?: ChatDeps["limiter"];
  access: ChatDeps["access"];
  images?: ChatDeps["images"];
}): ChatDeps {
  const pick = (server: string): Fake | undefined => typeof options.workspace === "function" ? options.workspace(server) : options.workspace ?? {};
  return {
    engine: {
      events: engineEvents,
      async workspace(server) { const fake = pick(server); return fake ? { ...idle, server, ...fake } : undefined; },
    },
    directory: {
      isMember: async (user, server) => options.member(user, server),
      canManage: async () => false,
      profiles: async () => new Map(),
      channelName: async () => undefined,
    },
    limiter: options.limiter ?? { check: async () => ({ allowed: true }) },
    access: options.access,
    ...(options.images ? { images: options.images } : {}),
  };
}
