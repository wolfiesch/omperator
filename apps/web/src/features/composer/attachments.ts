// Attachment intake rules for the composer. Browser File objects and preview
// URLs stay renderer-local; the live runtime converts a File into an appserver
// upload and sends only the resulting image id across the wire.
import type { PromptAttachment } from "../session-runtime/intents.ts";
import {
  readFileWithFileReader,
  sniffPromptImageMimeType,
} from "../session-runtime/image-upload.ts";

export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // Mirrors app-wire.
/** One fully legal eight-image prompt across all preserved session drafts. */
export const MAX_STAGED_ATTACHMENT_BYTES = MAX_ATTACHMENTS * MAX_ATTACHMENT_BYTES;
/** Bounds tiny-file/object-URL retention without silently evicting a draft. */
export const MAX_STAGED_ATTACHMENTS = 64;

const IMAGE_TYPES: Record<string, true> = {
  "image/png": true,
  "image/jpeg": true,
  "image/webp": true,
  "image/gif": true,
};

const IMAGE_TYPE_ALIASES: Readonly<Record<string, string>> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
};

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export interface AttachmentCandidate {
  readonly file: File;
}

/** Exact renderer-local payload staged for a future image protocol upload. */
export interface StagedAttachment extends PromptAttachment {
  readonly file: File;
  readonly previewUrl: string;
}

export interface AttachmentIntake {
  readonly accepted: readonly StagedAttachment[];
  /** One plain-language line per rejected candidate. */
  readonly rejections: readonly string[];
}

export interface AttachmentIntakeOptions {
  /** Test seam; production uses a collision-resistant browser crypto id. */
  readonly createId?: () => string;
  /** Test seam; production uses a revocable blob URL. */
  readonly createPreviewUrl?: (file: File) => string;
  /** Declared bytes already staged across every session, including `existing`. */
  readonly stagedBytes?: number;
  /** Images already staged across every session, including `existing`. */
  readonly stagedCount?: number;
}

export interface AttachmentMaterialization {
  readonly accepted: readonly AttachmentCandidate[];
  readonly rejections: readonly string[];
}

export interface AttachmentMaterializationReservation {
  readonly bytes: number;
  readonly count: number;
}

export interface AttachmentMaterializationOptions {
  /**
   * Test seam. Production deliberately starts FileReader synchronously while
   * the Android picker grant is fresh instead of retaining its lazy File.
   */
  readonly readFile?: (file: File) => Promise<ArrayBuffer>;
  /** Attachments already staged for the active session. */
  readonly existing?: readonly StagedAttachment[];
  /** Declared bytes already staged across every session. */
  readonly stagedBytes?: number;
  /** Images already staged across every session. */
  readonly stagedCount?: number;
  /** Synchronously records pending memory before any FileReader starts. */
  readonly onReserve?: (reservation: AttachmentMaterializationReservation) => void;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${bytes} B`;
}

/**
 * Browser and Android content-provider Files can omit `type`, report a
 * generic binary type, or use a legacy JPEG alias. A supported filename
 * extension is enough to stage those files; the uploader still magic-sniffs
 * the bytes and uses that authoritative MIME type before begin.
 */
export function provisionalImageMediaType(file: File): string | null {
  if (IMAGE_TYPES[file.type] === true) return file.type;
  const alias = IMAGE_TYPE_ALIASES[file.type];
  if (alias !== undefined) return alias;
  const dot = file.name.lastIndexOf(".");
  if (dot < 0 || dot === file.name.length - 1) return null;
  return IMAGE_EXTENSIONS[file.name.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * Copy picker-backed Files into renderer-owned Files before the input is
 * cleared. Android content providers can invalidate or mutate their synthetic
 * File metadata after the change event; starting every FileReader here keeps
 * the grant live, and staging only the immutable copies removes that lifetime
 * from preview and submission.
 */
export async function materializeAttachmentCandidates(
  candidates: readonly AttachmentCandidate[],
  options: AttachmentMaterializationOptions = {},
): Promise<AttachmentMaterialization> {
  const readFile = options.readFile ?? readFileWithFileReader;
  const existing = options.existing ?? [];
  let count = existing.length;
  let stagedBytes =
    options.stagedBytes ?? existing.reduce((total, attachment) => total + attachment.sizeBytes, 0);
  let stagedCount = options.stagedCount ?? existing.length;
  const seenFiles = new Set(existing.map((attachment) => attachment.file));
  let reservedBytes = 0;
  let reservedCount = 0;
  const planned = candidates.map(({ file }) => {
    const name = file.name || "untitled";
    let rejection: string | null = null;
    if (count >= MAX_ATTACHMENTS) {
      rejection = `${name}: limit of ${MAX_ATTACHMENTS} attachments reached.`;
    } else if (provisionalImageMediaType(file) === null) {
      rejection = `${name}: attach a PNG, JPEG, WebP, or GIF image.`;
    } else if (file.size === 0) {
      rejection = `${name}: the image is empty.`;
    } else if (file.size > MAX_ATTACHMENT_BYTES) {
      rejection = `${name}: ${formatBytes(file.size)} is over the ${formatBytes(MAX_ATTACHMENT_BYTES)} limit.`;
    } else if (seenFiles.has(file)) {
      rejection = `${name}: already attached.`;
    } else if (stagedCount >= MAX_STAGED_ATTACHMENTS) {
      rejection = `${name}: the app already has ${MAX_STAGED_ATTACHMENTS} staged images. Remove one before adding another.`;
    } else if (stagedBytes + file.size > MAX_STAGED_ATTACHMENT_BYTES) {
      rejection = `${name}: staged images across sessions would exceed ${formatBytes(MAX_STAGED_ATTACHMENT_BYTES)}. Remove one before adding another.`;
    }
    if (rejection !== null) return { file: null, name, rejection } as const;

    count += 1;
    stagedBytes += file.size;
    stagedCount += 1;
    reservedBytes += file.size;
    reservedCount += 1;
    seenFiles.add(file);
    return { file, name, rejection: null } as const;
  });

  // The caller owns this reservation until admission or disposal finishes.
  // This callback runs before any asynchronous file read starts, so another
  // paste/drop/picker batch sees the pending memory in its own preflight.
  options.onReserve?.({ bytes: reservedBytes, count: reservedCount });
  const results = await Promise.all(
    planned.map(async ({ file, name, rejection }) => {
      if (file === null) return { candidate: null, rejection } as const;
      let buffer: ArrayBuffer;
      try {
        // This call occurs synchronously for every candidate before the outer
        // function reaches its first await.
        buffer = await readFile(file);
      } catch {
        return {
          candidate: null,
          rejection: `${file.name || "untitled"}: the selected image could not be read. Try choosing it again or selecting it through Files.`,
        } as const;
      }

      const mediaType = sniffPromptImageMimeType(new Uint8Array(buffer));
      if (mediaType === null) {
        return {
          candidate: null,
          rejection: `${name}: attach a PNG, JPEG, WebP, or GIF image.`,
        } as const;
      }

      try {
        return {
          candidate: {
            file: new File([buffer], name, { type: mediaType }),
          },
          rejection: null,
        } as const;
      } catch {
        return {
          candidate: null,
          rejection: `${name}: could not prepare a stable image copy.`,
        } as const;
      }
    }),
  );

  const accepted: AttachmentCandidate[] = [];
  const rejections: string[] = [];
  for (const result of results) {
    if (result.candidate === null) rejections.push(result.rejection);
    else accepted.push(result.candidate);
  }
  return { accepted, rejections };
}

/**
 * Validate candidates against the current attachment list. This first slice
 * accepts images only; text/file parity waits for an explicit host protocol.
 * Repeated references to the exact same File object are dropped, while two
 * distinct files with the same filename remain independently addressable.
 */
export function admitAttachments(
  existing: readonly StagedAttachment[],
  candidates: readonly AttachmentCandidate[],
  options: AttachmentIntakeOptions = {},
): AttachmentIntake {
  const accepted: StagedAttachment[] = [];
  const rejections: string[] = [];
  const usedIds = new Set(existing.map((attachment) => attachment.id));
  const createId = options.createId ?? createAttachmentId;
  const createPreviewUrl = options.createPreviewUrl ?? ((file: File) => URL.createObjectURL(file));
  let count = existing.length;
  let stagedBytes =
    options.stagedBytes ?? existing.reduce((total, attachment) => total + attachment.sizeBytes, 0);
  let stagedCount = options.stagedCount ?? existing.length;
  for (const candidate of candidates) {
    const { file } = candidate;
    const name = file.name || "untitled";
    const mediaType = provisionalImageMediaType(file);
    if (count >= MAX_ATTACHMENTS) {
      rejections.push(`${name}: limit of ${MAX_ATTACHMENTS} attachments reached.`);
      continue;
    }
    if (mediaType === null) {
      rejections.push(`${name}: attach a PNG, JPEG, WebP, or GIF image.`);
      continue;
    }
    if (file.size === 0) {
      rejections.push(`${name}: the image is empty.`);
      continue;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      rejections.push(
        `${name}: ${formatBytes(file.size)} is over the ${formatBytes(MAX_ATTACHMENT_BYTES)} limit.`,
      );
      continue;
    }
    const duplicate =
      existing.some((attachment) => attachment.file === file) ||
      accepted.some((attachment) => attachment.file === file);
    if (duplicate) {
      rejections.push(`${name}: already attached.`);
      continue;
    }
    if (stagedCount >= MAX_STAGED_ATTACHMENTS) {
      rejections.push(
        `${name}: the app already has ${MAX_STAGED_ATTACHMENTS} staged images. Remove one before adding another.`,
      );
      continue;
    }
    if (stagedBytes + file.size > MAX_STAGED_ATTACHMENT_BYTES) {
      rejections.push(
        `${name}: staged images across sessions would exceed ${formatBytes(MAX_STAGED_ATTACHMENT_BYTES)}. Remove one before adding another.`,
      );
      continue;
    }
    let id = createId();
    // Crypto collisions are vanishingly unlikely, but removal keys must still
    // be unique if an injected/random source repeats once.
    for (let attempt = 0; usedIds.has(id) && attempt < 8; attempt += 1) id = createId();
    if (usedIds.has(id)) {
      rejections.push(`${name}: could not allocate a safe attachment id.`);
      continue;
    }
    let previewUrl: string;
    try {
      previewUrl = createPreviewUrl(file);
    } catch {
      rejections.push(`${name}: could not prepare an image preview.`);
      continue;
    }
    accepted.push({
      id,
      name,
      mediaType,
      sizeBytes: file.size,
      kind: "image",
      file,
      previewUrl,
    });
    usedIds.add(id);
    count += 1;
    stagedBytes += file.size;
    stagedCount += 1;
  }
  return { accepted, rejections };
}

function createAttachmentId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `attachment-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Keep the exact File for the renderer-local runtime; preview URLs stay UI-only. */
export function toPromptAttachment(attachment: StagedAttachment): PromptAttachment {
  return {
    id: attachment.id,
    name: attachment.name,
    mediaType: attachment.mediaType,
    sizeBytes: attachment.sizeBytes,
    kind: attachment.kind,
    file: attachment.file,
  };
}
