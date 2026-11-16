import { logError } from "./errors.js";
import type { Message } from "./domain.js";
import type { ObjectStorageProvider } from "./object-storage.js";
import { requestTimings } from "./request-timing.js";
import { projectFileKey, type ProjectStore } from "./projects.js";
import type { SandboxProfile } from "./sandbox-profile.js";
import type { SandboxOpenHook } from "./sandbox-session.js";
import { uniqueNames, uploadName } from "./sandbox-uploads.js";
import type { SandboxSession } from "./sandbox.js";

export interface ProjectSandboxDeps {
  projects: Pick<ProjectStore, "project" | "projectFiles">;
  storage: Pick<ObjectStorageProvider, "get">;
  /** The probed profile. Its home wins over the home the sandbox session reports. */
  profile?: SandboxProfile;
}

const PROJECT_DIR = "project";
/** Holds the Project.updated the copy was made from. Upload names never start with a dot, so no project file can use this name. */
const REVISION_FILE = ".slopbot-rev";
const SYNC_RUN_SECONDS = 30;

/** A storage read of an object that is not there: S3 NoSuchKey, or ENOENT from local disk. S3 keeps the SDK error as the cause of its ToolError. */
function isMissingObject(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && typeof current === "object" && depth < 5; depth++) {
    const { name, code, cause } = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (name === "NoSuchKey" || code === "ENOENT") return true;
    current = cause;
  }
  return false;
}

/**
 * Copies the files of the message's project to <home>/project when the copy is not from the project's current revision.
 * Only the owner's project chats are copied. A file whose object is missing is skipped and the marker is still written.
 * Any other failure is logged and leaves no marker, so the next run copies again. It never throws.
 */
export async function syncProjectToSandbox(deps: ProjectSandboxDeps, message: Message, session: SandboxSession, home: string): Promise<void> {
  if (!message.project) return;
  const context = { stage: "project sandbox sync", server: message.server, channel: message.channel, messageId: message.id };
  try {
    const project = await deps.projects.project(message.project);
    if (!project || project.owner !== message.author) return;
    const dir = `${deps.profile?.home ?? home}/${PROJECT_DIR}`, marker = `${dir}/${REVISION_FILE}`;
    const revision = String(project.updated);
    if (await session.read(marker).catch(() => "") === revision) return;
    // The revision is read before the files, so a change during the copy leaves an older marker and the next run copies again.
    const files = await deps.projects.projectFiles(project.id);
    const names = uniqueNames(files.map(file => uploadName(file.name)));
    const made = await requestTimings.wait("sandbox project directory", () => session.run(`rm -rf ${dir} && mkdir -p ${dir}`, SYNC_RUN_SECONDS * 1000));
    if (made.exitCode !== 0) throw new Error(`mkdir failed: ${made.stderr.trim() || made.exitCode}`);
    for (const [index, file] of files.entries()) {
      let bytes: Uint8Array;
      try { bytes = await requestTimings.wait("project file read", () => deps.storage.get(projectFileKey(project.id, file.id))); }
      catch (error) {
        if (!isMissingObject(error)) throw error;
        // ErrorContext has no file field, so the id goes in through a variable. Adding fileId to ErrorContext would make this explicit.
        const missing = { ...context, fileId: file.id };
        logError("project_sandbox_file_missing", error, missing, true);
        continue;
      }
      await requestTimings.wait("sandbox project write", () => session.write(`${dir}/${names[index]!}`, bytes));
    }
    await requestTimings.wait("sandbox project write", () => session.write(marker, revision));
  } catch (error) {
    logError("project_sandbox_sync_failed", error, context, true);
  }
}

/**
 * The hook that onSandboxOpen runs for a store that has projects. Syncs for one sandbox run one at a time,
 * so parallel sandbox calls (run_tools_code with Promise.all) cannot rewrite the copy under each other.
 */
export function projectSandboxOpenHook(deps: ProjectSandboxDeps): SandboxOpenHook {
  const queue = new Map<string, Promise<void>>();
  return async (message, session, home) => {
    const run = (queue.get(session.id) ?? Promise.resolve()).then(() => syncProjectToSandbox(deps, message, session, home));
    queue.set(session.id, run);
    await run;
    if (queue.get(session.id) === run) queue.delete(session.id);
  };
}
