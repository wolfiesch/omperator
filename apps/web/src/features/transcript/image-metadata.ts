// Transcript image metadata stays tiny and inert in the row projection. The
// bytes live behind `session.image.read`; rows carry only the durable entry id,
// digest, and MIME type needed to ask the host for an authorized blob.
import type { DurableEntry } from "./projection.ts";

export const TRANSCRIPT_IMAGE_MAX_COUNT = 64;

export const TRANSCRIPT_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type TranscriptImageMimeType = (typeof TRANSCRIPT_IMAGE_MIME_TYPES)[number];

export interface TranscriptImageReference {
  readonly entryId: string;
  readonly sha256: string;
  readonly mimeType: TranscriptImageMimeType;
}

export interface TranscriptImageMetadataResult {
  readonly images: readonly TranscriptImageReference[];
  /** Present only when an entry advertised malformed image metadata. */
  readonly issue: string | null;
}

export const INVALID_TRANSCRIPT_IMAGE_METADATA =
  "This transcript entry contains invalid image metadata.";

const EMPTY_RESULT: TranscriptImageMetadataResult = Object.freeze({
  images: Object.freeze([]),
  issue: null,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isMimeType(value: unknown): value is TranscriptImageMimeType {
  return (
    typeof value === "string" &&
    (TRANSCRIPT_IMAGE_MIME_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Mirror app-wire 0.5.5's strict metadata decoder until that generated
 * package is vendored. One malformed item rejects the whole ordered list;
 * partially trusted metadata must never trigger a host read.
 */
export function transcriptImagesFromEntry(entry: DurableEntry): TranscriptImageMetadataResult {
  const raw = entry.data.images;
  if (raw === undefined) return EMPTY_RESULT;
  if (!Array.isArray(raw) || raw.length > TRANSCRIPT_IMAGE_MAX_COUNT) {
    return { images: [], issue: INVALID_TRANSCRIPT_IMAGE_METADATA };
  }

  const images: TranscriptImageReference[] = [];
  for (const item of raw) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ["sha256", "mimeType"]) ||
      typeof item.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.sha256) ||
      !isMimeType(item.mimeType)
    ) {
      return { images: [], issue: INVALID_TRANSCRIPT_IMAGE_METADATA };
    }
    images.push({ entryId: String(entry.id), sha256: item.sha256, mimeType: item.mimeType });
  }
  return { images, issue: null };
}
