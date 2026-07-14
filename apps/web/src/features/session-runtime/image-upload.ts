import {
  IMAGE_UPLOAD_CHUNK_BYTES,
  IMAGE_UPLOAD_MAX_BYTES,
  PROMPT_IMAGE_MAX_COUNT,
  type PromptImageMimeType,
} from "@t4-code/protocol";
import type { CommandResultError } from "@t4-code/protocol/desktop-ipc";

import type { PromptOutcome } from "./controller.ts";
import type { PromptAttachment } from "./intents.ts";

export { IMAGE_UPLOAD_CHUNK_BYTES, IMAGE_UPLOAD_MAX_BYTES, PROMPT_IMAGE_MAX_COUNT };
const BASE64_CONVERSION_BATCH_BYTES = 32 * 1024;

export const IMAGE_UPLOAD_PREPARATION_REASON =
  "One of the attached files is not a readable PNG, JPEG, WebP, or GIF image. Your draft and staged images are safe.";
export const IMAGE_UPLOAD_INTERRUPTED_REASON =
  "The image upload did not finish. Your draft and staged images are safe; reconnect and send again.";
export const IMAGE_UPLOAD_PROTOCOL_REASON =
  "This host returned an invalid image-upload response. Your draft and staged images are safe.";
export const IMAGE_PROMPT_UNKNOWN_REASON =
  "The connection dropped before the host answered. Your draft is safe. Check the transcript before resending so you do not send it twice.";

export type ImageUploadCommand =
  | "session.image.begin"
  | "session.image.chunk"
  | "session.image.discard";

export interface ImageUploadCommandResult {
  readonly accepted: boolean;
  readonly result?: unknown;
  readonly error?: CommandResultError;
}

export interface ImagePromptUploadOptions {
  /** All runtimes sharing a transport target serialize through one lane. */
  readonly targetId: string;
  readonly attachments: readonly PromptAttachment[];
  readonly command: (
    command: ImageUploadCommand,
    args: Readonly<Record<string, unknown>>,
  ) => Promise<ImageUploadCommandResult>;
  readonly sendPrompt: (images: readonly Readonly<{ imageId: string }>[]) => Promise<PromptOutcome>;
  readonly rejectionReason: (error: CommandResultError | undefined) => string;
}

interface PreparedImage {
  readonly bytes: Uint8Array;
  readonly mimeType: PromptImageMimeType;
  readonly sha256: string;
}

class ImageUploadFailure extends Error {}
class ImagePreparationFailure extends Error {}
class ImageProtocolFailure extends Error {}

const targetPipelineTails = new Map<string, Promise<void>>();

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImageId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  );
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.byteLength < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

/** Byte authority for MIME; filename and browser metadata are never trusted. */
export function sniffPromptImageMimeType(bytes: Uint8Array): PromptImageMimeType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return "image/gif";
  }
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.byteLength >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/** Canonical browser base64 without spreading more than 32 KiB at once. */
export function canonicalBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += BASE64_CONVERSION_BATCH_BYTES) {
    const end = Math.min(offset + BASE64_CONVERSION_BATCH_BYTES, bytes.byteLength);
    binary += String.fromCharCode(...bytes.subarray(offset, end));
  }
  return btoa(binary);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readFileWithFileReader(file: File): Promise<ArrayBuffer> {
  if (typeof globalThis.FileReader !== "function") {
    return Promise.reject(new Error("This browser cannot read the selected file."));
  }

  return new Promise((resolve, reject) => {
    const reader = new globalThis.FileReader();
    let settled = false;
    const settle = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      reader.onload = null;
      reader.onerror = null;
      reader.onabort = null;
      complete();
    };

    reader.onload = () => {
      const result = reader.result;
      settle(() => {
        if (result instanceof ArrayBuffer) resolve(result);
        else reject(new Error("The selected file returned invalid bytes."));
      });
    };
    reader.onerror = () => {
      const error = reader.error ?? new Error("The selected file could not be read.");
      settle(() => reject(error));
    };
    reader.onabort = () => {
      settle(() => reject(new Error("Reading the selected file was cancelled.")));
    };

    try {
      reader.readAsArrayBuffer(file);
    } catch (error) {
      settle(() => reject(error));
    }
  });
}

/** File.arrayBuffer arrived after the oldest Android WebView T4 supports. */
function readFileArrayBuffer(file: File): Promise<ArrayBuffer> {
  const read = file.arrayBuffer;
  return typeof read === "function" ? read.call(file) : readFileWithFileReader(file);
}

async function prepareImage(attachment: PromptAttachment): Promise<PreparedImage> {
  const file = attachment.file;
  if (
    file === undefined ||
    file.size <= 0 ||
    file.size > IMAGE_UPLOAD_MAX_BYTES ||
    file.size !== attachment.sizeBytes
  ) {
    throw new ImagePreparationFailure(IMAGE_UPLOAD_PREPARATION_REASON);
  }
  let buffer: ArrayBuffer;
  try {
    buffer = await readFileArrayBuffer(file);
  } catch {
    throw new ImagePreparationFailure(IMAGE_UPLOAD_PREPARATION_REASON);
  }
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength !== file.size) {
    throw new ImagePreparationFailure(IMAGE_UPLOAD_PREPARATION_REASON);
  }
  const mimeType = sniffPromptImageMimeType(bytes);
  if (mimeType === null) throw new ImagePreparationFailure(IMAGE_UPLOAD_PREPARATION_REASON);
  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
    return { bytes, mimeType, sha256: hex(new Uint8Array(digest)) };
  } catch {
    throw new ImagePreparationFailure(IMAGE_UPLOAD_PREPARATION_REASON);
  }
}

function acceptedResult(
  result: ImageUploadCommandResult,
  rejectionReason: ImagePromptUploadOptions["rejectionReason"],
): unknown {
  if (!result.accepted) throw new ImageUploadFailure(rejectionReason(result.error));
  return result.result;
}

function decodeBeginResult(value: unknown): string {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["imageId", "chunkBytes"]) ||
    !isImageId(value.imageId) ||
    value.chunkBytes !== IMAGE_UPLOAD_CHUNK_BYTES
  ) {
    throw new ImageProtocolFailure(IMAGE_UPLOAD_PROTOCOL_REASON);
  }
  return value.imageId;
}

function verifyChunkResult(
  value: unknown,
  imageId: string,
  received: number,
  complete: boolean,
): void {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["imageId", "received", "complete"]) ||
    value.imageId !== imageId ||
    value.received !== received ||
    value.complete !== complete
  ) {
    throw new ImageProtocolFailure(IMAGE_UPLOAD_PROTOCOL_REASON);
  }
}

async function uploadOne(
  attachment: PromptAttachment,
  options: ImagePromptUploadOptions,
  begunImageIds: string[],
): Promise<string> {
  // Called serially by the outer loop: at most one whole File and digest are
  // resident/in flight for this target at a time.
  const prepared = await prepareImage(attachment);
  let begin: ImageUploadCommandResult;
  try {
    begin = await options.command("session.image.begin", {
      mimeType: prepared.mimeType,
      size: prepared.bytes.byteLength,
      sha256: prepared.sha256,
    });
  } catch {
    throw new ImageUploadFailure(IMAGE_UPLOAD_INTERRUPTED_REASON);
  }
  const imageId = decodeBeginResult(acceptedResult(begin, options.rejectionReason));
  begunImageIds.push(imageId);

  for (let offset = 0; offset < prepared.bytes.byteLength; offset += IMAGE_UPLOAD_CHUNK_BYTES) {
    const end = Math.min(offset + IMAGE_UPLOAD_CHUNK_BYTES, prepared.bytes.byteLength);
    const content = canonicalBase64(prepared.bytes.subarray(offset, end));
    let chunk: ImageUploadCommandResult;
    try {
      chunk = await options.command("session.image.chunk", { imageId, offset, content });
    } catch {
      throw new ImageUploadFailure(IMAGE_UPLOAD_INTERRUPTED_REASON);
    }
    verifyChunkResult(
      acceptedResult(chunk, options.rejectionReason),
      imageId,
      end,
      end === prepared.bytes.byteLength,
    );
  }
  return imageId;
}

async function discardAll(
  imageIds: readonly string[],
  command: ImagePromptUploadOptions["command"],
): Promise<void> {
  await Promise.all(
    imageIds.map(async (imageId) => {
      try {
        await command("session.image.discard", { imageId });
      } catch {
        // Cleanup is best effort. The host also expires unconsumed spools.
      }
    }),
  );
}

async function withTargetPipeline<T>(targetId: string, task: () => Promise<T>): Promise<T> {
  const previous = targetPipelineTails.get(targetId) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  targetPipelineTails.set(targetId, tail);
  try {
    return await run;
  } finally {
    if (targetPipelineTails.get(targetId) === tail) targetPipelineTails.delete(targetId);
  }
}

/**
 * Hash, upload, then issue exactly one refs-only prompt. Every begun image is
 * discarded after settlement (harmless once consumed) and on all failures.
 */
export async function runImagePromptUpload(
  options: ImagePromptUploadOptions,
): Promise<PromptOutcome> {
  return withTargetPipeline(options.targetId, async () => {
    if (options.attachments.length === 0 || options.attachments.length > PROMPT_IMAGE_MAX_COUNT) {
      return { kind: "rejected", reason: IMAGE_UPLOAD_PREPARATION_REASON };
    }
    const begunImageIds: string[] = [];
    let promptAttempted = false;
    try {
      const imageIds: string[] = [];
      for (const attachment of options.attachments) {
        imageIds.push(await uploadOne(attachment, options, begunImageIds));
      }
      promptAttempted = true;
      return await options.sendPrompt(imageIds.map((imageId) => ({ imageId })));
    } catch (error) {
      if (promptAttempted) return { kind: "unknown", reason: IMAGE_PROMPT_UNKNOWN_REASON };
      if (error instanceof ImagePreparationFailure) {
        return { kind: "rejected", reason: IMAGE_UPLOAD_PREPARATION_REASON };
      }
      if (error instanceof ImageProtocolFailure) {
        return { kind: "rejected", reason: IMAGE_UPLOAD_PROTOCOL_REASON };
      }
      if (error instanceof ImageUploadFailure) {
        return { kind: "rejected", reason: error.message };
      }
      return { kind: "rejected", reason: IMAGE_UPLOAD_INTERRUPTED_REASON };
    } finally {
      // Once prompt dispatch begins, the host owns every consumed spool and
      // releases it after the child acknowledges the prompt. A best-effort
      // discard may still help a rejected/uncertain dispatch, but must not keep
      // an already-settled composer or this target's next prompt blocked.
      if (promptAttempted) void discardAll(begunImageIds, options.command);
      else await discardAll(begunImageIds, options.command);
    }
  });
}
