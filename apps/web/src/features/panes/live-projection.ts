// Pure adapters from the live SessionProjection (app-wire frames the
// desktop runtime already validated and bounded) to the inspector pane
// view models. Every function here is derivation only: unknown fields stay
// null, unsafe paths disappear, and nothing is invented to fill a gap.
import type { AgentTranscriptProjection, ResultProjection, SessionProjection } from "@t4-code/client";

import { classifySessionEvent } from "./activity-log.ts";
import { displayStateFromWire } from "./model.ts";
import type {
  ActivityEntry,
  AgentNode,
  AgentTranscriptEntry,
  FilePreview,
  FileTreeNode,
  ReviewFile,
  ReviewFileStatus,
} from "./model.ts";
import { countPatchChanges } from "./review-model.ts";

type SessionMapValue<Key extends keyof SessionProjection> =
  SessionProjection[Key] extends ReadonlyMap<string, infer Value> ? Value : never;
type ProjectionAgentFrame = SessionMapValue<"agents">;
type ProjectionFileFrame = SessionMapValue<"files">;
type ProjectionReviewFrame = SessionMapValue<"reviews">;
type ProjectionLiveEventFrame = SessionProjection["events"][number];

// ---------------------------------------------------------------------------
// Path safety. Mirrors app-wire's safeRelativePath rules: relative POSIX
// paths only, no backslashes, drive letters, home anchors, or dot segments.
// Anything else is hidden from every pane surface, never partially shown.
// ---------------------------------------------------------------------------

export function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > 4096) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(value)) return false;
  if (value.includes("\\") || value.startsWith("/") || value.startsWith("~")) return false;
  if (/^[A-Za-z]:/u.test(value)) return false;
  return value
    .split("/")
    .every((part) => part.length > 0 && part !== "." && part !== "..");
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
function readNonNegativeNumber(record: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}


function readSafePath(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = readString(record, key);
  return value !== null && isSafeRelativePath(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Agents: AgentFrame (+ agent-scoped live events) → AgentNode.
// ---------------------------------------------------------------------------

function transcriptEntryFrom(
  record: Readonly<Record<string, unknown>>,
  fallbackId: string,
): AgentTranscriptEntry | null {
  const role = record.role;
  if (role !== "user" && role !== "assistant" && role !== "tool") return null;
  const text = readString(record, "text");
  if (text === null) return null;
  return {
    id: readString(record, "id") ?? fallbackId,
    role,
    text,
    at: readString(record, "at") ?? "",
  };
}

/**
 * One agent node from its latest frame plus this session's live events.
 * Fields the wire did not state stay null; the row title falls back to the
 * agent's real id — never a made-up label.
 */
export function agentNodeFromFrame(
  frame: ProjectionAgentFrame,
  events: readonly ProjectionLiveEventFrame[],
  durableTranscript?: AgentTranscriptProjection,
): AgentNode {
  const id = String(frame.agentId);
  const detail: Readonly<Record<string, unknown>> = frame.detail ?? {};
  const transcript: AgentTranscriptEntry[] = [];
  const rawTranscript = detail.transcript;
  if (Array.isArray(rawTranscript)) {
    for (const [index, item] of rawTranscript.entries()) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const entry = transcriptEntryFrom(item as Record<string, unknown>, `detail-${index}`);
      if (entry !== null) transcript.push(entry);
    }
  }
  let startedAt = readString(detail, "startedAt");
  let lastActivityAt = readString(detail, "lastActivityAt");
  for (const eventFrame of events) {
    const event = eventFrame.event;
    if (readString(event, "agentId") !== id) continue;
    const at = readString(event, "at");
    if (at !== null) {
      if (event.type === "agent.spawn" && startedAt === null) startedAt = at;
      lastActivityAt = at;
    }
    if (event.type === "agent.transcript") {
      const entry = transcriptEntryFrom(
        event,
        `event-${eventFrame.cursor.epoch}-${eventFrame.cursor.seq}`,
      );
      if (entry !== null) transcript.push(entry);
    }
  }
  const rawContext = detail.contextUsage;
  const contextRecord =
    typeof rawContext === "object" && rawContext !== null && !Array.isArray(rawContext)
      ? (rawContext as Readonly<Record<string, unknown>>)
      : null;
  const contextUsed = contextRecord === null ? null : readNonNegativeNumber(contextRecord, "used");
  const contextLimit = contextRecord === null ? null : readNonNegativeNumber(contextRecord, "limit");
  const validContext = contextUsed !== null && contextLimit !== null && contextUsed <= contextLimit;
  const parentId = readString(detail, "parentId");
  const kindValue = detail.kind;
  return {
    id,
    parentId: parentId !== null && parentId !== id ? parentId : null,
    title: readString(detail, "title") ?? readString(detail, "name") ?? id,
    kind: kindValue === "main" || kindValue === "batch" ? kindValue : "agent",
    state: displayStateFromWire(frame.state),
    progress: frame.progress ?? null,
    startedAt,
    lastActivityAt,
    model: readString(detail, "model"),
    contextUsed: validContext ? contextUsed : null,
    contextLimit: validContext ? contextLimit : null,
    worktree: readSafePath(detail, "worktree"),
    path: readSafePath(detail, "path"),
    currentTool: readString(detail, "currentTool") ?? readString(detail, "tool"),
    evidence: readString(detail, "evidence"),
    transcriptEntries: durableTranscript?.entries ?? [],
    transcriptReceived: durableTranscript !== undefined,
    transcriptFreshness: durableTranscript?.freshness ?? "fresh",
    transcriptHistoryTruncated: durableTranscript?.historyTruncated === true,
    transcript,
  };
}

/** Cheap change check so unchanged frames never re-enter the store. */
export function sameAgentNode(a: AgentNode, b: AgentNode): boolean {
  if (
    a.id !== b.id ||
    a.parentId !== b.parentId ||
    a.title !== b.title ||
    a.kind !== b.kind ||
    a.state !== b.state ||
    a.progress !== b.progress ||
    a.startedAt !== b.startedAt ||
    a.contextUsed !== b.contextUsed ||
    a.contextLimit !== b.contextLimit ||
    a.lastActivityAt !== b.lastActivityAt ||
    a.model !== b.model ||
    a.worktree !== b.worktree ||
    a.path !== b.path ||
    a.currentTool !== b.currentTool ||
    a.evidence !== b.evidence ||
    a.transcriptEntries !== b.transcriptEntries ||
    a.transcriptReceived !== b.transcriptReceived ||
    a.transcriptFreshness !== b.transcriptFreshness ||
    a.transcriptHistoryTruncated !== b.transcriptHistoryTruncated ||
    a.transcript.length !== b.transcript.length
  ) {
    return false;
  }
  const lastA = a.transcript[a.transcript.length - 1];
  const lastB = b.transcript[b.transcript.length - 1];
  return lastA?.id === lastB?.id && lastA?.text === lastB?.text;
}

// ---------------------------------------------------------------------------
// Activity: live events, audit frames, and command results, each with a
// stable identity key so replays and re-syncs never duplicate an entry.
// ---------------------------------------------------------------------------

export interface KeyedActivityEntry {
  /** Stable identity across syncs; the ingest loop deduplicates on it. */
  readonly key: string;
  readonly entry: Omit<ActivityEntry, "seq">;
}

/**
 * Everything the session did, in the projection's own retained order:
 * live events (cursor-keyed), then audit records, then command results.
 * Incremental syncs see mostly-known keys, so arrival order wins in
 * practice; a full re-sync reproduces the same sequence deterministically.
 */
export function collectActivity(session: SessionProjection): KeyedActivityEntry[] {
  const entries: KeyedActivityEntry[] = [];
  for (const frame of session.events) {
    entries.push({
      key: `event:${frame.cursor.epoch}:${frame.cursor.seq}`,
      entry: classifySessionEvent(frame.event, 0, ""),
    });
  }
  for (const frame of session.audit) {
    entries.push({
      key: `audit:${frame.timestamp}\u0000${frame.action}\u0000${frame.actor}`,
      entry: {
        at: frame.timestamp,
        kind: "system",
        title: frame.action,
        detail: frame.actor,
        agentId: null,
        terminalId: null,
        raw: frame.detail ?? {},
        unknown: false,
        shellOutput: null,
      },
    });
  }
  for (const result of session.results.values()) {
    entries.push({
      key: `result:${result.requestId}`,
      entry: resultActivityEntry(result),
    });
  }
  return entries;
}

/** A command's settled outcome as a stream entry; failures keep their code. */
function resultActivityEntry(result: ResultProjection): Omit<ActivityEntry, "seq"> {
  return {
    at: "",
    kind: result.ok ? "system" : "error",
    title: result.ok ? "Command completed" : (result.error?.message ?? "Command failed"),
    detail: result.ok ? null : (result.error?.code ?? null),
    agentId: null,
    terminalId: null,
    raw: {
      requestId: result.requestId,
      ok: result.ok,
      ...(result.commandId === undefined ? {} : { commandId: result.commandId }),
      ...(result.result === undefined ? {} : { result: result.result }),
      ...(result.error === undefined ? {} : { error: result.error }),
    },
    unknown: false,
    shellOutput: null,
  };
}

// ---------------------------------------------------------------------------
// Review: ReviewFrame status/metadata → ReviewFile rows. The wire carries
// no unified diff of its own; a patch renders only when a frame's findings
// actually contain one. Nothing synthesizes a diff.
// ---------------------------------------------------------------------------

const REVIEW_FILE_STATUSES: Readonly<Record<ReviewFileStatus, true>> = {
  added: true,
  modified: true,
  deleted: true,
  renamed: true,
};

function reviewFileFrom(
  frame: ProjectionReviewFrame,
  path: string,
  source: Readonly<Record<string, unknown>>,
): ReviewFile {
  const patch = readString(source, "patch") ?? readString(source, "diff");
  const counted = patch === null ? null : countPatchChanges(patch);
  const additions = source.additions;
  const deletions = source.deletions;
  const sizeBytes = source.sizeBytes;
  const status = source.status;
  return {
    path,
    oldPath: readSafePath(source, "oldPath"),
    status:
      typeof status === "string" && REVIEW_FILE_STATUSES[status as ReviewFileStatus] === true
        ? (status as ReviewFileStatus)
        : "modified",
    kind: "text",
    additions:
      typeof additions === "number" && Number.isInteger(additions) && additions >= 0
        ? additions
        : (counted?.additions ?? 0),
    deletions:
      typeof deletions === "number" && Number.isInteger(deletions) && deletions >= 0
        ? deletions
        : (counted?.deletions ?? 0),
    patch,
    sizeBytes: typeof sizeBytes === "number" && Number.isFinite(sizeBytes) ? sizeBytes : null,
    applyState:
      frame.status === "applied" ? "applied" : frame.status === "discarded" ? "discarded" : "pending",
  };
}

export interface ReviewProjection {
  readonly files: readonly ReviewFile[];
  /** Which wire review each rendered file row came from; commands need it. */
  readonly reviewIdByPath: ReadonlyMap<string, string>;
}

/**
 * Review rows from the session's review frames. A frame with its own safe
 * path is one row; otherwise each finding that names a safe path is a row.
 * Unsafe or absent paths render nothing — there is no anonymous diff row.
 */
export function reviewProjectionFromFrames(session: SessionProjection): ReviewProjection {
  const files: ReviewFile[] = [];
  const reviewIdByPath = new Map<string, string>();
  for (const frame of session.reviews.values()) {
    const framePath = frame.path;
    if (framePath !== undefined && isSafeRelativePath(framePath)) {
      if (reviewIdByPath.has(framePath)) continue;
      const finding = frame.findings.find((item) => readString(item, "path") === framePath);
      files.push(reviewFileFrom(frame, framePath, finding ?? {}));
      reviewIdByPath.set(framePath, frame.reviewId);
      continue;
    }
    for (const finding of frame.findings) {
      const path = readSafePath(finding, "path");
      if (path === null || reviewIdByPath.has(path)) continue;
      files.push(reviewFileFrom(frame, path, finding));
      reviewIdByPath.set(path, frame.reviewId);
    }
  }
  return { files, reviewIdByPath };
}

/** Same rows in the same order; comments and view state never compared. */
export function sameReviewFiles(a: readonly ReviewFile[], b: readonly ReviewFile[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i] as ReviewFile;
    const right = b[i] as ReviewFile;
    if (
      left.path !== right.path ||
      left.oldPath !== right.oldPath ||
      left.status !== right.status ||
      left.additions !== right.additions ||
      left.deletions !== right.deletions ||
      left.patch !== right.patch ||
      left.sizeBytes !== right.sizeBytes ||
      left.applyState !== right.applyState
    ) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Files: FileFrame paths → directory listings and previews. Only safe
// relative paths participate; everything else is invisible.
// ---------------------------------------------------------------------------

/**
 * Directory listings derived from the file frames the host pushed. This is
 * the honest fallback tree when `files.list` is not offered: it contains
 * exactly the files the session touched, nothing more.
 */
export function fileListingsFromFrames(
  session: SessionProjection,
): Readonly<Record<string, readonly FileTreeNode[]>> {
  const byDir = new Map<string, Map<string, FileTreeNode>>();
  byDir.set("", new Map());
  for (const path of session.files.keys()) {
    if (!isSafeRelativePath(path)) continue;
    let current = path;
    let kind: FileTreeNode["kind"] = "file";
    // Walk up: register the file, then every ancestor directory.
    for (;;) {
      const slash = current.lastIndexOf("/");
      const dir = slash === -1 ? "" : current.slice(0, slash);
      let siblings = byDir.get(dir);
      if (siblings === undefined) {
        siblings = new Map();
        byDir.set(dir, siblings);
      }
      const existing = siblings.get(current);
      if (existing === undefined || (existing.kind === "file" && kind === "dir")) {
        siblings.set(current, {
          path: current,
          name: slash === -1 ? current : current.slice(slash + 1),
          kind,
        });
      }
      if (dir === "") break;
      current = dir;
      kind = "dir";
    }
  }
  const listings: Record<string, readonly FileTreeNode[]> = {};
  for (const [dir, children] of byDir) {
    listings[dir] = [...children.values()].sort((left, right) =>
      left.kind !== right.kind
        ? left.kind === "dir"
          ? -1
          : 1
        : left.name.localeCompare(right.name),
    );
  }
  return listings;
}

/** Same entries in the same order; used to skip redundant store writes. */
export function sameListing(a: readonly FileTreeNode[], b: readonly FileTreeNode[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]?.path !== b[i]?.path || a[i]?.kind !== b[i]?.kind) return false;
  }
  return true;
}

/** Preview straight from a pushed file frame; no content, honest message. */
export function previewFromFileFrame(frame: ProjectionFileFrame): FilePreview {
  if (frame.content === undefined) {
    return {
      kind: "diagnostic",
      path: frame.path,
      message: "The host announced this file without sharing its contents.",
    };
  }
  return {
    kind: "code",
    path: frame.path,
    text: frame.content,
    truncated: frame.truncated === true,
  };
}
