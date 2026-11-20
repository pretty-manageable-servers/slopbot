// The project_files tool: the model reads the files of its chat's project. Read-only. Files are copied to ~/project/ in the sandbox by project-sandbox.ts.
import type { ObjectStorageProvider } from "./object-storage.js";
import { humanSize, projectFileKey, type ProjectFile, type ProjectStore } from "./projects.js";
import { ToolError, type ToolContext, type ToolDefinition } from "./tools.js";

/** The text of a text file that one read returns. A longer file continues from the offset in the "more" line. */
const TEXT_CHUNK_CHARS = 16000;
const TEXT_MIME = new Set(["application/json", "application/xml", "application/javascript", "application/x-yaml"]);
const TEXT_EXTENSIONS = new Set(["md", "txt", "csv", "tsv", "json", "yaml", "yml", "xml", "html", "css", "js", "ts", "py", "rs", "go", "java", "c", "h", "cpp", "sh", "sql", "toml", "ini", "log"]);

/** True for files the tool returns as text. Other files go to inspectFile with a question. */
export function isTextFile(file: Pick<ProjectFile, "name" | "contentType">): boolean {
  const type = file.contentType.split(";")[0]!.trim().toLowerCase();
  const extension = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  return type.startsWith("text/") || TEXT_MIME.has(type) || TEXT_EXTENSIONS.has(extension);
}

/** Exact id, then exact name, then name ignoring case. */
function findFile(files: readonly ProjectFile[], wanted: string): ProjectFile | undefined {
  return files.find(file => file.id === wanted) ?? files.find(file => file.name === wanted) ?? files.find(file => file.name.toLowerCase() === wanted.toLowerCase());
}

export interface ProjectFileDeps {
  projects: Pick<ProjectStore, "project" | "projectFiles">;
  storage: Pick<ObjectStorageProvider, "get">;
  /** Answers a question about a file that is not text (inspectFile in files.ts). */
  inspect(context: ToolContext, file: ProjectFile, bytes: Uint8Array, question: string): Promise<string>;
}

export function projectFilesTool(deps: ProjectFileDeps): ToolDefinition {
  return {
    name: "project_files",
    description: "Read the files of this chat's project: list, or read a file. Read-only.",
    surface: "top", needs: ["files"], access: "member", effect: "read", retrySafe: true, execution: "inline",
    fields: {
      action: { type: "string", required: true, choices: ["list", "read"], description: "list: the project's files. read: a file's text, or an answer to a question about a file that is not text." },
      file: { type: "string", max: 300, description: "For read: the file name or id, as listed." },
      question: { type: "string", max: 2000, description: "For read of a file that is not text (PDF, image, office file): the question to answer about it. Required for those." },
      offset: { type: "integer", min: 0, description: "For read of a text file: the character offset to start from, default 0." },
    },
    async execute(context, args) {
      const message = context.message;
      const project = message.project ? await deps.projects.project(message.project) : undefined;
      if (!project || project.owner !== message.author) throw new ToolError("This chat is not in a project.");
      const files = await deps.projects.projectFiles(project.id);
      if (args.action === "list") return files.length ? files.map(file => `${file.name} (${file.contentType}, ${humanSize(file.size)})`).join("\n") : "This project has no files.";
      const wanted = typeof args.file === "string" ? args.file : "";
      if (!wanted) throw new ToolError("Give the file name or id to read.");
      const file = findFile(files, wanted);
      if (!file) throw new ToolError(files.length ? `No project file "${wanted}". Files: ${files.slice(0, 10).map(item => item.name).join(", ")}` : "This project has no files.");
      if (isTextFile(file)) {
        const text = new TextDecoder().decode(await deps.storage.get(projectFileKey(project.id, file.id)));
        const offset = typeof args.offset === "number" ? args.offset : 0;
        const part = text.slice(offset, offset + TEXT_CHUNK_CHARS), next = offset + part.length;
        return next < text.length ? `${part}\n[more from offset ${next}]` : part;
      }
      const question = typeof args.question === "string" ? args.question.trim() : "";
      if (!question) throw new ToolError(`${file.name} is not a text file. Pass a question about it to read it.`);
      return deps.inspect(context, file, await deps.storage.get(projectFileKey(project.id, file.id)), question);
    },
  };
}
