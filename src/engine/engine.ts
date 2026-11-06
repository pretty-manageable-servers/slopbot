import type { Engine, EngineEventLog, Workspace } from "./api.js";
import { engineEvents } from "./event-log.js";

/** One Workspace per server. The platform client adds a Workspace when it opens a server and removes it when it closes it. */
export class WorkspaceEngine implements Engine {
  private readonly workspaces = new Map<string, Promise<Workspace>>();

  constructor(readonly events: EngineEventLog = engineEvents) {}

  /** Registers a Workspace that is still being opened. A failed opening is dropped, so the server can be opened again. */
  add(server: string, opening: Promise<Workspace>): void {
    this.workspaces.set(server, opening);
    opening.catch(() => { if (this.workspaces.get(server) === opening) this.workspaces.delete(server); });
  }
  remove(server: string): void { this.workspaces.delete(server); }
  servers(): string[] { return [...this.workspaces.keys()]; }
  async workspace(server: string): Promise<Workspace | undefined> {
    const opening = this.workspaces.get(server);
    return opening ? await opening.catch(() => undefined) : undefined;
  }
}
