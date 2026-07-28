import type { DurableEntry } from "@t4-code/protocol";

import type { TranscriptProjection } from "../transcript/projection.ts";

export const INITIAL_TRANSCRIPT_PAGE_ENTRIES = 64;
export const INITIAL_TRANSCRIPT_PAGE_BYTES = 256 * 1024;
export const OLDER_TRANSCRIPT_PAGE_ENTRIES = 128;
export const OLDER_TRANSCRIPT_PAGE_BYTES = 512 * 1024;
export const MAX_PAGED_TRANSCRIPT_ENTRIES = 4_096;

export function prependTranscriptPage(
  current: readonly DurableEntry[],
  older: readonly DurableEntry[],
): readonly DurableEntry[] {
  const existing = new Set(current.map((entry) => entry.id));
  const added: DurableEntry[] = [];
  for (const entry of older) {
    if (existing.has(entry.id)) continue;
    existing.add(entry.id);
    added.push(entry);
  }
  return [...added, ...current];
}

export function presentPagedTranscript(
  projection: TranscriptProjection,
  pagedEntries: readonly DurableEntry[],
): TranscriptProjection {
  if (pagedEntries.length === 0) return projection;
  if (projection.entries.length === 0) return { ...projection, entries: pagedEntries };
  const pagedIds = new Set(pagedEntries.map((entry) => entry.id));
  const firstAnchor = projection.entries.findIndex((entry) => pagedIds.has(entry.id));
  if (firstAnchor < 0) {
    return { ...projection, entries: [...pagedEntries, ...projection.entries] };
  }
  const lastAnchor = projection.entries.findLastIndex((entry) => pagedIds.has(entry.id));
  return {
    ...projection,
    entries: [
      ...projection.entries.slice(0, firstAnchor),
      ...pagedEntries,
      ...projection.entries.slice(lastAnchor + 1),
    ],
  };
}
