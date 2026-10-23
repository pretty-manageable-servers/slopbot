// Finds the real type of a file from its first bytes. A name or a claimed MIME type is never trusted for media.

export interface SniffedMedia { extension: string; contentType: string; kind: "image" | "video" | "audio" }

const ascii = (bytes: Uint8Array, start: number, text: string) => text.split("").every((char, i) => bytes[start + i] === char.charCodeAt(0));

/** The media type of the bytes, or undefined when they are not one of the supported formats. */
export function sniffMedia(bytes: Uint8Array): SniffedMedia | undefined {
  if (bytes.length < 12) return undefined;
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => bytes[i] === byte)) return { extension: "png", contentType: "image/png", kind: "image" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { extension: "jpg", contentType: "image/jpeg", kind: "image" };
  if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a")) return { extension: "gif", contentType: "image/gif", kind: "image" };
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return { extension: "webp", contentType: "image/webp", kind: "image" };
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE")) return { extension: "wav", contentType: "audio/wav", kind: "audio" };
  if (ascii(bytes, 4, "ftyp")) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    if (brand === "qt  ") return { extension: "mov", contentType: "video/quicktime", kind: "video" };
    if (brand === "M4A " || brand === "M4B ") return { extension: "m4a", contentType: "audio/mp4", kind: "audio" };
    return { extension: "mp4", contentType: "video/mp4", kind: "video" };
  }
  // EBML header, then the DocType: "webm" (Matroska files are not supported).
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    const head = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 64)));
    if (head.includes("webm")) return { extension: "webm", contentType: "video/webm", kind: "video" };
    return undefined;
  }
  if (ascii(bytes, 0, "OggS")) return { extension: "ogg", contentType: "audio/ogg", kind: "audio" };
  if (ascii(bytes, 0, "ID3") || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0 && (bytes[1]! & 0x06) !== 0)) return { extension: "mp3", contentType: "audio/mpeg", kind: "audio" };
  return undefined;
}

/** A name with the extension that matches the media type. Other names keep their extension. */
export function matchName(name: string, media: SniffedMedia | undefined): string {
  if (!media) return name;
  const base = name.replace(/\.[^./\\]*$/, "") || "file";
  return `${base}.${media.extension}`;
}
