// File-reference ("@path") parsing, flattening, ranking, and chip
// derivation for the composer. The draft text is the only state: accepting
// the menu inserts a plain relative path, and the chips are parsed back out
// of the draft, so a reference never exists anywhere the host cannot see.
import type { FileChildren } from "../panes/inspector-store.ts";
import { scoreQueryMatch } from "./match.ts";

/** One picker row: a file or directory known to the session's file index. */
export interface FileRefEntry {
  readonly path: string;
  readonly name: string;
  readonly isDir: boolean;
}

/** The active "@" query and the index of its trigger character. */
export interface FileRefQuery {
  readonly query: string;
  readonly start: number;
}

/** A reference token found in the draft, with its span for chip removal. */
export interface FileRefToken {
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

/** Path-token characters, including Unicode names and symbols such as emoji. */
const TOKEN_CHARS = /^[\p{L}\p{M}\p{N}\p{S}_./-]*$/u;

function isSafeFileRefQuery(value: string): boolean {
  if (value === "") return true;
  if (value.startsWith("/") || value.startsWith("~")) return false;
  const segments = value.split("/");
  return segments.every(
    (segment, index) =>
      segment !== "." &&
      segment !== ".." &&
      (segment.length > 0 || index === segments.length - 1),
  );
}

/**
 * The active file-reference query, when the caret sits inside an "@token".
 * The "@" must start a whitespace-delimited token, so "name@host" never
 * opens the menu. Null when the menu should be closed.
 */
export function activeFileRefQuery(text: string, caret: number): FileRefQuery | null {
  const head = text.slice(0, caret);
  const at = head.search(/@\S*$/);
  if (at === -1) return null;
  const before = at === 0 ? undefined : head[at - 1];
  if (before !== undefined && !/\s/.test(before)) return null;
  const query = head.slice(at + 1);
  if (!TOKEN_CHARS.test(query) || !isSafeFileRefQuery(query)) return null;
  return { query, start: at };
}

/**
 * Flatten the inspector's lazy directory listings into picker entries.
 * Only resolved listings contribute; "loading"/"error" dirs are skipped.
 * Lexical directory order puts every parent before its children, so the
 * result is a stable depth-first walk with listing order preserved.
 */
export function flattenFileIndex(
  childrenByPath: Readonly<Record<string, FileChildren>>,
): FileRefEntry[] {
  const entries: FileRefEntry[] = [];
  for (const dir of Object.keys(childrenByPath).sort()) {
    const children = childrenByPath[dir];
    if (!Array.isArray(children)) continue;
    for (const node of children) {
      entries.push({ path: node.path, name: node.name, isDir: node.kind === "dir" });
    }
  }
  return entries;
}

function scoreFileRef(entry: FileRefEntry, query: string): number | null {
  const nameScore = scoreQueryMatch(entry.name.toLowerCase(), query, {
    exactBase: 0,
    prefixBase: 2,
    boundaryBase: 4,
    includesBase: 6,
    fuzzyBase: 100,
  });
  const pathScore = scoreQueryMatch(entry.path.toLowerCase(), query, {
    exactBase: 5,
    prefixBase: 8,
    boundaryBase: 10,
    includesBase: 12,
    fuzzyBase: 140,
  });
  if (nameScore === null) return pathScore;
  if (pathScore === null) return nameScore;
  return Math.min(nameScore, pathScore);
}

/** Rank picker entries for a query ("" keeps flatten order). Stable and pure. */
export function rankFileRefs(
  entries: readonly FileRefEntry[],
  rawQuery: string,
  limit = 8,
): FileRefEntry[] {
  const query = rawQuery.trim().toLowerCase();
  if (query === "") return entries.slice(0, limit);
  const ranked: { entry: FileRefEntry; score: number }[] = [];
  for (const entry of entries) {
    const score = scoreFileRef(entry, query);
    if (score !== null) ranked.push({ entry, score });
  }
  ranked.sort(
    (left, right) => left.score - right.score || left.entry.path.localeCompare(right.entry.path),
  );
  return ranked.slice(0, limit).map((rankedEntry) => rankedEntry.entry);
}

/**
 * Replace the active "@query" span with the accepted path. Directories keep
 * a trailing slash so the menu stays open for drill-down; files close the
 * token with a trailing space.
 */
export function buildFileRefInsert(
  text: string,
  caret: number,
  start: number,
  entry: FileRefEntry,
): { readonly nextText: string; readonly nextCaret: number } {
  const suffix = text.slice(caret);
  const close = entry.isDir ? "/" : /^\s/u.test(suffix) ? "" : " ";
  const insert = `@${entry.path}${close}`;
  return {
    nextText: text.slice(0, start) + insert + text.slice(caret),
    nextCaret: start + insert.length,
  };
}

/**
 * Derive chip tokens from the draft: "@path" spans whose path the file
 * index currently knows. Unknown or partial paths stay plain text — a chip
 * is only ever a view over text the host will receive verbatim.
 */
export function fileRefTokensInDraft(
  text: string,
  knownPaths: { readonly has: (key: string) => boolean },
): FileRefToken[] {
  const tokens: FileRefToken[] = [];
  for (const match of text.matchAll(/(^|\s)@([\p{L}\p{M}\p{N}\p{S}_./-]+)/gu)) {
    const prefix = match[1] ?? "";
    const raw = match[2];
    if (raw === undefined) continue;
    // Directory accepts leave a trailing slash; it belongs to the span,
    // not to the lookup key.
    const path = raw.replace(/\/+$/, "");
    if (path === "" || !knownPaths.has(path)) continue;
    const start = match.index + prefix.length;
    tokens.push({ path, start, end: start + 1 + raw.length });
  }
  return tokens;
}
