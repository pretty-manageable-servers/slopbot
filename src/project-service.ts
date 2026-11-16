// Projects: create and edit, files, instructions and project memories. The project routes (clients/web/routes/projects.ts)
// call it. Every method checks that the project belongs to the owner. Anyone else gets the same 404 as a missing project.
import { logError, ToolError } from "./errors.js";
import type { Message } from "./domain.js";
import type { Knowledge, MemoryCategory, MemoryRecord } from "./memory.js";
import type { ObjectStorageProvider } from "./object-storage.js";
import {
  PROJECT_DESCRIPTION_MAX_CHARS, PROJECT_INSTRUCTIONS_MAX_CHARS, PROJECT_MEMORY_SERVER, PROJECT_NAME_MAX_CHARS,
  newProjectId, projectFileKey, projectMemoryChannel, type Project, type ProjectChats, type ProjectFile, type ProjectLimits, type ProjectStore,
} from "./projects.js";
import type { SafetyCategory, SafetyClassifier } from "./safety.js";
import { cleanInstructions } from "./user-instructions-service.js";
import { INSTRUCTIONS_REJECT_MESSAGES, USER_INSTRUCTIONS_CHECKS_PER_HOUR, type InstructionsRejectReason } from "./user-instructions.js";
import { fileContentType, fileName, newChatFileId } from "./web-chat-files.js";

const HOUR_MS = 60 * 60 * 1000;
/** How long a file download link works. */
const FILE_LINK_SECONDS = 300;

/** A failure with its HTTP status. The routes answer { error: code }. */
export class ProjectError extends Error {
  override name = "ProjectError";
  constructor(readonly status: 400 | 404 | 409 | 413 | 503, readonly code: string) { super(code); }
}
const notFound = () => new ProjectError(404, "not_found");
const badRequest = () => new ProjectError(400, "bad_request");

/** Name and description as the routes pass them. Values are checked here, so unknown input is allowed. */
export interface ProjectFields { name?: unknown; description?: unknown }
export interface ProjectSummary { id: string; name: string; description: string; updated: number; fileCount: number }
export interface ProjectDetail { project: Project; files: ProjectFile[]; chats: Awaited<ReturnType<ProjectChats["chatsInProject"]>>; usedBytes: number }
export interface ProjectMemoryView { id: string; content: string; category: MemoryCategory; updatedAt: number }
export type ProjectInstructionsResult =
  | { ok: true; project: Project }
  | { ok: false; reason: InstructionsRejectReason; category?: SafetyCategory; message: string };

const PROJECT_INSTRUCTIONS_MESSAGES: Record<InstructionsRejectReason, string> = {
  ...INSTRUCTIONS_REJECT_MESSAGES,
  too_long: `Instructions can be at most ${PROJECT_INSTRUCTIONS_MAX_CHARS} characters.`,
};

type ProjectPatch = Partial<Pick<Project, "name" | "description" | "instructions" | "instructionsUpdated">>;

export class ProjectService {
  // Instruction checks per owner. Only the last hour is kept.
  private readonly checks = new Map<string, number[]>();

  constructor(
    private readonly store: ProjectStore,
    private readonly chats: ProjectChats,
    private readonly storage: ObjectStorageProvider | undefined,
    private readonly knowledge: Knowledge,
    /** undefined: every non-empty instructions save fails with check_failed (fail closed). */
    private readonly classifier: SafetyClassifier | undefined,
    private readonly limits: () => ProjectLimits,
    private readonly now: () => number = Date.now,
  ) {}

  async list(owner: string): Promise<{ projects: ProjectSummary[]; limits: ProjectLimits }> {
    const projects = await this.store.projectsOf(owner);
    const summaries = await Promise.all(projects.map(async (project): Promise<ProjectSummary> => ({
      id: project.id, name: project.name, description: project.description, updated: project.updated,
      fileCount: (await this.store.projectFiles(project.id)).length,
    })));
    return { projects: summaries, limits: this.limits() };
  }

  async create(owner: string, input: ProjectFields): Promise<Project> {
    const name = checkName(input.name);
    const description = input.description === undefined ? "" : checkDescription(input.description);
    if ((await this.store.projectsOf(owner)).length >= this.limits().maxProjects) throw new ProjectError(409, "project_limit");
    const at = this.now();
    const project: Project = { id: newProjectId(), owner, name, description, instructions: "", instructionsUpdated: null, created: at, updated: at };
    await this.store.createProject(project);
    return project;
  }

  async detail(owner: string, id: string): Promise<ProjectDetail> {
    const project = await this.owned(owner, id);
    const files = await this.store.projectFiles(id);
    return { project, files, chats: await this.chats.chatsInProject(owner, id), usedBytes: files.reduce((sum, file) => sum + file.size, 0) };
  }

  async update(owner: string, id: string, input: ProjectFields): Promise<Project> {
    await this.owned(owner, id);
    const patch: Partial<Pick<Project, "name" | "description">> = {};
    if (input.name !== undefined) patch.name = checkName(input.name);
    if (input.description !== undefined) patch.description = checkDescription(input.description);
    return this.write(id, patch);
  }

  /** Same steps as UserInstructionsService.save. Rejections are results, not errors, so the route can show the message. */
  async saveInstructions(owner: string, id: string, text: unknown): Promise<ProjectInstructionsResult> {
    const project = await this.owned(owner, id);
    if (typeof text !== "string") throw badRequest();
    const cleaned = cleanInstructions(text);
    if (cleaned === project.instructions) return { ok: true, project };
    if (cleaned === "") return { ok: true, project: await this.write(id, { instructions: "", instructionsUpdated: this.now() }) };
    if ([...cleaned].length > PROJECT_INSTRUCTIONS_MAX_CHARS) return reject("too_long");
    if (!this.takeCheck(owner)) return reject("rate_limited");
    if (!this.classifier) return reject("check_failed");

    let verdict;
    try {
      verdict = await this.classifier.check({ server: "global", user: owner }, "instructions", cleaned);
    } catch (error) {
      logError("project_instructions_check_failed", error, { stage: "project instructions" }, true);
      return reject("check_failed");
    }
    if (verdict.flagged) {
      console.warn(JSON.stringify({ event: "project_instructions_rejected", user: owner, project: id, category: verdict.category }));
      return reject("flagged", verdict.category);
    }
    return { ok: true, project: await this.write(id, { instructions: cleaned, instructionsUpdated: this.now() }) };
  }

  async addFile(owner: string, id: string, rawName: string | null, rawType: string | null, bytes: Uint8Array): Promise<ProjectFile> {
    await this.owned(owner, id);
    const storage = this.requireStorage();
    const limits = this.limits();
    if (!bytes.length) throw badRequest();
    if (bytes.length > limits.maxFileBytes) throw new ProjectError(413, "file_too_large");
    const files = await this.store.projectFiles(id);
    if (files.length >= limits.maxFiles) throw new ProjectError(409, "file_limit");
    if (files.reduce((sum, file) => sum + file.size, 0) + bytes.length > limits.maxProjectBytes) throw new ProjectError(409, "project_full");

    const name = fileName(rawName), contentType = fileContentType(rawType);
    const file: ProjectFile = { id: newChatFileId(name), project: id, name, contentType, size: bytes.length, created: this.now() };
    await storage.put(projectFileKey(id, file.id), bytes, contentType);
    try {
      await this.store.addProjectFile(file);
    } catch (error) {
      await this.dropObject(id, file.id);
      throw error;
    }
    return file;
  }

  async deleteFile(owner: string, id: string, fileId: string): Promise<void> {
    await this.owned(owner, id);
    if (!await this.store.deleteProjectFile(id, fileId, this.now())) throw notFound();
    await this.dropObject(id, fileId);
  }

  async fileLink(owner: string, id: string, fileId: string): Promise<string> {
    await this.owned(owner, id);
    const file = (await this.store.projectFiles(id)).find(item => item.id === fileId);
    if (!file) throw notFound();
    return this.requireStorage().link(projectFileKey(id, fileId), file.name, FILE_LINK_SECONDS);
  }

  /** Deletes the file objects, then the project's memories and chats, then the project row. */
  async delete(owner: string, id: string): Promise<void> {
    await this.owned(owner, id);
    for (const file of await this.store.projectFiles(id)) await this.dropObject(id, file.id);
    const channel = projectMemoryChannel(id);
    for (const memory of await this.knowledge.memories(PROJECT_MEMORY_SERVER, channel)) {
      await this.knowledge.forget(PROJECT_MEMORY_SERVER, channel, memory.id, owner);
    }
    for (const chat of await this.chats.chatsInProject(owner, id)) await this.chats.deleteChat(owner, chat.id);
    await this.store.deleteProject(id, this.now());
  }

  async memories(owner: string, id: string): Promise<ProjectMemoryView[]> {
    await this.owned(owner, id);
    return (await this.knowledge.memories(PROJECT_MEMORY_SERVER, projectMemoryChannel(id))).map(memoryView);
  }

  async editMemory(owner: string, id: string, memoryId: string, content: string): Promise<ProjectMemoryView> {
    await this.owned(owner, id);
    const channel = projectMemoryChannel(id);
    const current = (await this.knowledge.memories(PROJECT_MEMORY_SERVER, channel)).find(memory => memory.id === memoryId);
    if (!current) throw notFound();
    const message: Message = { id: "project-memory-edit", server: PROJECT_MEMORY_SERVER, channel, author: owner, text: "", project: id };
    let updated: MemoryRecord | undefined;
    try {
      updated = await this.knowledge.updateMemory(message, memoryId, { content }, current.revision);
    } catch (error) {
      if (error instanceof ToolError) throw badRequest();
      throw error;
    }
    if (!updated) throw notFound();
    return memoryView(updated);
  }

  async deleteMemory(owner: string, id: string, memoryId: string): Promise<void> {
    await this.owned(owner, id);
    if (!await this.knowledge.forget(PROJECT_MEMORY_SERVER, projectMemoryChannel(id), memoryId, owner)) throw notFound();
  }

  /** The project when the owner has it. A missing project and another owner's project give the same 404. */
  private async owned(owner: string, id: string): Promise<Project> {
    const project = await this.store.project(id);
    if (!project || project.owner !== owner) throw notFound();
    return project;
  }

  /** Saves a patch and returns the stored project. */
  private async write(id: string, patch: ProjectPatch): Promise<Project> {
    await this.store.updateProject(id, patch, this.now());
    const project = await this.store.project(id);
    if (!project) throw notFound();
    return project;
  }

  private requireStorage(): ObjectStorageProvider {
    if (!this.storage) throw new ProjectError(503, "storage_unavailable");
    return this.storage;
  }

  /** Deletes a file object. A failure is logged and not thrown: the row is already gone, so the caller carries on. */
  private async dropObject(id: string, fileId: string): Promise<void> {
    await this.storage?.delete(projectFileKey(id, fileId)).catch(error => logError("project_file_delete_failed", error, { stage: "project files" }, true));
  }

  /** Records a check for the owner if the hour's budget allows it. */
  private takeCheck(owner: string): boolean {
    const at = this.now();
    const recent = (this.checks.get(owner) ?? []).filter(time => at - time < HOUR_MS);
    const allowed = recent.length < USER_INSTRUCTIONS_CHECKS_PER_HOUR;
    this.checks.set(owner, allowed ? [...recent, at] : recent);
    return allowed;
  }
}

function checkName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || [...name].length > PROJECT_NAME_MAX_CHARS) throw badRequest();
  return name;
}

function checkDescription(value: unknown): string {
  if (typeof value !== "string") throw badRequest();
  const description = value.trim();
  if ([...description].length > PROJECT_DESCRIPTION_MAX_CHARS) throw badRequest();
  return description;
}

function memoryView(memory: MemoryRecord): ProjectMemoryView {
  return { id: memory.id, content: memory.content, category: memory.category, updatedAt: memory.updatedAt };
}

function reject(reason: InstructionsRejectReason, category?: SafetyCategory): ProjectInstructionsResult {
  const message = PROJECT_INSTRUCTIONS_MESSAGES[reason];
  return category === undefined ? { ok: false, reason, message } : { ok: false, reason, category, message };
}
