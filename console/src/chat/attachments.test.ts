import { describe, expect, test } from "vitest";
import { ATTACHMENT_MAX_COUNT, FILE_MAX_BYTES, IMAGE_MAX_BYTES, attachmentIds, attachmentKind, attachmentProblem } from "./attachments";

const MB = 1024 * 1024;
const file = (name: string, type: string, size: number) => ({ name, type, size });

describe("attachmentKind", () => {
  test("the four image types the bot reads go to the images route", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) expect(attachmentKind(type)).toBe("image");
  });

  test("other types, including images the model cannot read, go to the files route", () => {
    for (const type of ["application/pdf", "text/plain", "image/svg+xml", "image/heic", ""]) expect(attachmentKind(type)).toBe("file");
  });
});

describe("attachmentProblem", () => {
  test("a file under its limit can be attached", () => {
    expect(attachmentProblem(file("a.png", "image/png", 1 * MB), 0)).toBeNull();
    expect(attachmentProblem(file("a.pdf", "application/pdf", 1 * MB), 0)).toBeNull();
  });

  test("an image up to 25 MB is allowed, and one byte more is refused", () => {
    expect(attachmentProblem(file("big.jpg", "image/jpeg", IMAGE_MAX_BYTES), 0)).toBeNull();
    expect(attachmentProblem(file("big.jpg", "image/jpeg", IMAGE_MAX_BYTES + 1), 0)).toContain("25 MB");
  });

  test("a file over 10 MB is refused, even when it would fit the image limit", () => {
    expect(attachmentProblem(file("a.pdf", "application/pdf", FILE_MAX_BYTES), 0)).toBeNull();
    expect(attachmentProblem(file("a.pdf", "application/pdf", 20 * MB), 0)).toContain("10 MB");
  });

  test("no more than 10 attachments in the composer", () => {
    expect(attachmentProblem(file("a.png", "image/png", 1), ATTACHMENT_MAX_COUNT - 1)).toBeNull();
    expect(attachmentProblem(file("a.png", "image/png", 1), ATTACHMENT_MAX_COUNT)).not.toBeNull();
  });
});

describe("attachmentIds", () => {
  test("a message sends the ready images and files apart, and leaves out files still uploading or failed", () => {
    const drafts = [
      { mime: "image/png", status: "ready" as const, fileId: "img_1" },
      { mime: "application/pdf", status: "ready" as const, fileId: "file_1" },
      { mime: "image/webp", status: "uploading" as const },
      { mime: "text/plain", status: "error" as const },
      { mime: "image/gif", status: "ready" as const, fileId: "img_2" },
    ];
    expect(attachmentIds(drafts)).toEqual({ images: ["img_1", "img_2"], files: ["file_1"] });
  });

  test("no attachments sends no ids", () => {
    expect(attachmentIds([])).toEqual({ images: [], files: [] });
  });
});
