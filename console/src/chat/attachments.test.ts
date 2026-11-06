import { describe, expect, test } from "vitest";
import { ATTACHMENT_MAX_COUNT, FILE_MAX_BYTES, IMAGE_MAX_BYTES, attachmentIds, attachmentKind, attachmentProblem } from "./attachments";

const file = (name: string, type: string, size: number) => ({ name, type, size });

describe("attachments", () => {
  test("only the four image types the bot reads go to the images route", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) expect(attachmentKind(type)).toBe("image");
    for (const type of ["application/pdf", "image/svg+xml", "image/heic", ""]) expect(attachmentKind(type)).toBe("file");
  });

  test("size and count limits are enforced at the boundary", () => {
    const cases: [ReturnType<typeof file>, number, boolean][] = [
      [file("a.jpg", "image/jpeg", IMAGE_MAX_BYTES), 0, true],
      [file("a.jpg", "image/jpeg", IMAGE_MAX_BYTES + 1), 0, false],
      [file("a.pdf", "application/pdf", FILE_MAX_BYTES), 0, true],
      [file("a.pdf", "application/pdf", FILE_MAX_BYTES + 1), 0, false],
      [file("a.png", "image/png", 1), ATTACHMENT_MAX_COUNT - 1, true],
      [file("a.png", "image/png", 1), ATTACHMENT_MAX_COUNT, false],
    ];
    for (const [f, count, ok] of cases) expect(attachmentProblem(f, count) === null).toBe(ok);
  });

  test("a message sends only ready attachments, images and files apart", () => {
    const drafts = [
      { mime: "image/png", status: "ready" as const, fileId: "img_1" },
      { mime: "application/pdf", status: "ready" as const, fileId: "file_1" },
      { mime: "image/webp", status: "uploading" as const },
      { mime: "text/plain", status: "error" as const },
    ];
    expect(attachmentIds(drafts)).toEqual({ images: ["img_1"], files: ["file_1"] });
  });
});
