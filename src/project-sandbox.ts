import { logError } from "./errors.js";
import type { Message } from "./domain.js";
import type { ObjectStorageProvider } from "./object-storage.js";
import type { RecordStore } from "./records.js";
import { requestTimings } from "./request-timing.js";
import { projectFileKey, type ProjectStore } from "./projects.js";
import type { SandboxProfile } from "./sandbox-profile.js";
import { sandboxSession } from "./sandbox-session.js";
import { uniqueNames, uploadName } from "./sandbox-uploads.js";
import type { SandboxProvider } from "./sandbox.js";

export interface ProjectSandboxDeps {
  store: RecordStore;
  provider: SandboxProvider;
  projects: Pick<ProjectStore, "project" | "projectFiles">;
  storage: Pick<ObjectStorageProvider, "get">;
  /** The probed profile. Its home wins over the home of the sandbox. */
  profile?: SandboxProfile;
}

const PROJECT_DIR = "project";
/** Holds the Project.updated the copy was made from. Upload names never start with a dot, so no project file can use this name. */
const REVISION_FILE = ".slopbot-rev";
const SYNC_RUN_SECONDS = 30;

/**
 * Copies the files of the message's project to <home>/project before the run, when the copy is not from the project's current revision.
 * Only the owner's project chats are copied. Does nothing when deps is undefined. A failure is logged and never fails the run.
 */
export async function syncProjectToSandbox(deps: ProjectSandboxDeps | undefined, message: Message): Promise<void> {
  if (!deps || !message.project) return;
  try {
    const project = await deps.projects.project(message.project);
    if (!project || project.owner !== message.author) return;
    const opened = await sandboxSession(deps.store, deps.provider, message, `project:${message.id}`);
    const { session } = opened;
    const dir = `${deps.profile?.home ?? opened.home}/${PROJECT_DIR}`, marker = `${dir}/${REVISION_FILE}`;
    const revision = String(project.updated);
    if (await session.read(marker).catch(() => "") === revision) return;
    // The revision is read before the files, so a change during the copy leaves an older marker and the next run copies again.
    const files = await deps.projects.projectFiles(project.id);
    const names = uniqueNames(files.map(file => uploadName(file.name)));
    const made = await requestTimings.wait("sandbox project directory", () => session.run(`rm -rf ${dir} && mkdir -p ${dir}`, SYNC_RUN_SECONDS * 1000));
    if (made.exitCode !== 0) throw new Error(`mkdir failed: ${made.stderr.trim() || made.exitCode}`);
    for (const [index, file] of files.entries()) {
      const bytes = await requestTimings.wait("project file read", () => deps.storage.get(projectFileKey(project.id, file.id)));
      await requestTimings.wait("sandbox project write", () => session.write(`${dir}/${names[index]!}`, bytes));
    }
    await requestTimings.wait("sandbox project write", () => session.write(marker, revision));
  } catch (error) {
    logError("project_sandbox_sync_failed", error, { stage: "project sandbox sync", server: message.server, channel: message.channel, messageId: message.id }, true);
  }
}
