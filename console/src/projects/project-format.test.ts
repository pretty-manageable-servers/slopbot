import { describe, expect, test } from "vitest";
import type { ProjectLimits } from "../api-types";
import { NAME_MAX, deleteProjectText, descriptionProblem, fileProblem, nameProblem, projectErrorText, sizeText, usageText } from "./project-format";

const MB = 1024 * 1024;
const limits: ProjectLimits = { maxProjects: 5, maxFiles: 20, maxFileBytes: 10 * MB, maxProjectBytes: 25 * MB };

describe("sizes", () => {
  test("sizes read in KB below a megabyte and in MB above, with one decimal at most", () => {
    expect(sizeText(512 * 1024)).toBe("512 KB");
    expect(sizeText(1.44 * MB)).toBe("1.4 MB");
    expect(sizeText(25 * MB)).toBe("25 MB");
  });

  test("the usage line gives the used storage and the file count against the limits", () => {
    expect(usageText(1.2 * MB, 3, limits)).toBe("used 1.2 MB of 25 MB, 3 of 20 files");
  });
});

describe("names and descriptions", () => {
  test("a name is required and at most 80 characters once trimmed", () => {
    expect(nameProblem("   ")).not.toBeNull();
    expect(nameProblem("  Thesis  ")).toBeNull();
    expect(nameProblem("a".repeat(NAME_MAX))).toBeNull();
    expect(nameProblem("a".repeat(NAME_MAX + 1))).not.toBeNull();
  });

  test("a name counts characters, so an emoji is one", () => {
    expect(nameProblem("🙂".repeat(NAME_MAX))).toBeNull();
    expect(nameProblem("🙂".repeat(NAME_MAX + 1))).not.toBeNull();
  });

  test("a description is at most 500 characters and may be empty", () => {
    expect(descriptionProblem("")).toBeNull();
    expect(descriptionProblem("x".repeat(500))).toBeNull();
    expect(descriptionProblem("x".repeat(501))).not.toBeNull();
  });
});

describe("file checks before upload", () => {
  test("a file over the per-file limit is refused first", () => {
    expect(fileProblem({ size: 11 * MB }, { files: 0, bytes: 0 }, limits)).toBe("file_too_large");
  });

  test("a full file list is refused", () => {
    expect(fileProblem({ size: 1 }, { files: 20, bytes: 0 }, limits)).toBe("file_limit");
  });

  test("a file that would pass the project's storage is refused", () => {
    expect(fileProblem({ size: 5 * MB }, { files: 1, bytes: 21 * MB }, limits)).toBe("project_full");
  });

  test("a file that fits every limit is allowed, and the limit is inclusive", () => {
    expect(fileProblem({ size: 10 * MB }, { files: 0, bytes: 15 * MB }, limits)).toBeNull();
    expect(fileProblem({ size: 1 }, { files: 19, bytes: 0 }, limits)).toBeNull();
  });
});

describe("error codes from the bot", () => {
  test("each limit code has a message, and other codes have none", () => {
    for (const code of ["project_limit", "file_too_large", "file_limit", "project_full", "storage_unavailable", "project_failed"]) {
      expect(projectErrorText(code, limits)).not.toBeNull();
    }
    expect(projectErrorText("something_else", limits)).toBeNull();
  });
});

describe("delete confirm", () => {
  test("the confirm says how many chats go with the project", () => {
    expect(deleteProjectText(2)).toContain("2 chats");
    expect(deleteProjectText(1)).toContain("1 chat");
    expect(deleteProjectText(1)).not.toContain("1 chats");
  });
});
