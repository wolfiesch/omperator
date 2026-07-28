import type { DesktopRuntimeController, DesktopRuntimeSnapshot } from "@t4-code/client";
import { readTranscriptPage, TranscriptPageClientError } from "@t4-code/client";
import type { DurableEntry } from "@t4-code/protocol";

import type { TranscriptProjection } from "../transcript/projection.ts";
import type { TranscriptHistoryPageState } from "./controller.ts";

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

export interface LiveTranscriptPager {
  readonly history: TranscriptHistoryPageState | undefined;
  loadEarlier(): Promise<void>;
  present(projection: TranscriptProjection): TranscriptProjection;
  prime(): Promise<void>;
}

interface LiveTranscriptPagerOptions {
  readonly controller: DesktopRuntimeController;
  readonly targetId: string;
  readonly hostId: string;
  readonly sessionId: string;
  readonly isDisposed: () => boolean;
  readonly notify: () => void;
}

export function createLiveTranscriptPager(
  options: LiveTranscriptPagerOptions,
): LiveTranscriptPager {
  let entries: readonly DurableEntry[] = [];
  let history: TranscriptHistoryPageState | undefined;
  let generation: string | undefined;
  let cursor: string | undefined;
  let request: Promise<void> | null = null;

  const supported = (runtime: DesktopRuntimeSnapshot): boolean => {
    const host = runtime.hosts.get(options.hostId);
    return (
      runtime.connections.get(options.targetId) === "connected" &&
      runtime.targetHosts.get(options.targetId) === options.hostId &&
      host?.grantedCapabilities.includes("sessions.read") === true &&
      host.grantedFeatures.includes("transcript.page")
    );
  };

  const load = (before?: string): Promise<void> => {
    if (request !== null) return request;
    const loadingOlder = before !== undefined;
    const remainingEntries = MAX_PAGED_TRANSCRIPT_ENTRIES - entries.length;
    if (loadingOlder && remainingEntries <= 0) return Promise.resolve();
    history = {
      phase: "loading",
      hasMore: cursor !== undefined,
      error: null,
    };
    options.notify();
    const currentRequest = readTranscriptPage(
      options.controller,
      {
        targetId: options.targetId,
        hostId: options.hostId,
        sessionId: options.sessionId,
      },
      {
        ...(before === undefined ? {} : { before }),
        limit: loadingOlder
          ? Math.min(OLDER_TRANSCRIPT_PAGE_ENTRIES, remainingEntries)
          : INITIAL_TRANSCRIPT_PAGE_ENTRIES,
        maxBytes: loadingOlder ? OLDER_TRANSCRIPT_PAGE_BYTES : INITIAL_TRANSCRIPT_PAGE_BYTES,
      },
    )
      .then((page) => {
        if (options.isDisposed()) return;
        if (loadingOlder && generation !== undefined && page.generation !== generation) {
          throw new TranscriptPageClientError(
            "stale",
            "The transcript changed while older history was loading.",
            "transcript_generation_changed",
          );
        }
        entries = loadingOlder ? prependTranscriptPage(entries, page.entries) : [...page.entries];
        generation = page.generation;
        cursor = page.nextCursor;
        history = {
          phase: "ready",
          hasMore: page.hasMore && entries.length < MAX_PAGED_TRANSCRIPT_ENTRIES,
          error:
            page.hasMore && entries.length >= MAX_PAGED_TRANSCRIPT_ENTRIES
              ? "This view reached its in-memory history limit."
              : null,
        };
        options.notify();
      })
      .catch((error: unknown) => {
        if (options.isDisposed()) return;
        const unsupported =
          error instanceof TranscriptPageClientError && error.code === "unsupported";
        history = {
          phase: unsupported ? "unsupported" : "error",
          hasMore: cursor !== undefined,
          error: unsupported
            ? null
            : error instanceof TranscriptPageClientError
              ? error.message
              : "Older transcript history could not be loaded.",
        };
        options.notify();
      })
      .finally(() => {
        if (request === currentRequest) request = null;
      });
    request = currentRequest;
    return currentRequest;
  };

  return {
    get history() {
      return history;
    },
    async loadEarlier() {
      if (history?.phase === "loading") return;
      if (cursor === undefined && history?.phase !== "error") return;
      await load(cursor);
    },
    present(projection) {
      return presentPagedTranscript(projection, entries);
    },
    prime() {
      if (history !== undefined) return request ?? Promise.resolve();
      if (!supported(options.controller.getSnapshot())) {
        history = { phase: "unsupported", hasMore: false, error: null };
        return Promise.resolve();
      }
      return load();
    },
  };
}
