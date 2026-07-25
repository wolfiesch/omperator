import { ImmutableMap } from "./immutable-map.ts";
import type {
  ProjectionFileFrame,
  ProjectionOptions,
  SessionProjection,
  TerminalProjection,
} from "./projection-contract.ts";

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();
/** Immutable projection values make exact byte totals safe to memoize by identity. */
const TERMINAL_PROJECTION_BYTES = new WeakMap<TerminalProjection, number>();
const FILE_PROJECTION_BYTES = new WeakMap<ProjectionFileFrame, number>();

function immutableMap<K, V>(entries?: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  return new ImmutableMap(entries);
}

function utf8Bytes(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

/** Keep a valid UTF-8 suffix without splitting a multi-byte code point. */
function retainedUtf8Tail(value: string, maxBytes: number): string {
  const encoded = UTF8_ENCODER.encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  let offset = Math.max(0, encoded.byteLength - Math.max(0, Math.floor(maxBytes)));
  while (offset < encoded.byteLength && (encoded[offset]! & 0xc0) === 0x80) offset += 1;
  return UTF8_DECODER.decode(encoded.subarray(offset));
}

/** Keep a valid UTF-8 prefix without splitting a multi-byte code point. */
function retainedUtf8Head(value: string, maxBytes: number): string {
  const encoded = UTF8_ENCODER.encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  let end = Math.min(encoded.byteLength, Math.max(0, Math.floor(maxBytes)));
  while (end > 0 && end < encoded.byteLength && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return UTF8_DECODER.decode(encoded.subarray(0, end));
}

function terminalProjectionBytes(terminal: TerminalProjection): number {
  const cached = TERMINAL_PROJECTION_BYTES.get(terminal);
  if (cached !== undefined) return cached;
  const bytes =
    utf8Bytes(terminal.terminalId) + utf8Bytes(terminal.stdout) + utf8Bytes(terminal.stderr);
  TERMINAL_PROJECTION_BYTES.set(terminal, bytes);
  return bytes;
}

function trimTerminalProjection(
  terminal: TerminalProjection,
  maxBytes: number,
  preferredStream: "stdout" | "stderr" = "stdout",
): TerminalProjection {
  if (terminalProjectionBytes(terminal) <= maxBytes) return terminal;
  const outputBudget = Math.max(0, maxBytes - utf8Bytes(terminal.terminalId));
  const secondaryStream = preferredStream === "stdout" ? "stderr" : "stdout";
  const preferred = retainedUtf8Tail(terminal[preferredStream], outputBudget);
  const secondary = retainedUtf8Tail(
    terminal[secondaryStream],
    Math.max(0, outputBudget - utf8Bytes(preferred)),
  );
  return Object.freeze({
    ...terminal,
    [preferredStream]: preferred,
    [secondaryStream]: secondary,
  });
}

/**
 * Terminal map iteration order is receive-recency order. Protect the current
 * terminal, shed completed terminals first, then the least-recent open ones.
 */
export function retainTerminalProjection(
  terminals: ReadonlyMap<string, TerminalProjection>,
  terminalId: string,
  terminal: TerminalProjection,
  options: Required<ProjectionOptions>,
  preferredStream: "stdout" | "stderr" = "stdout",
): ReadonlyMap<string, TerminalProjection> {
  const next = new Map(terminals);
  let totalBytes = 0;
  for (const value of next.values()) totalBytes += terminalProjectionBytes(value);
  const replaced = next.get(terminalId);
  if (replaced !== undefined) totalBytes -= terminalProjectionBytes(replaced);
  next.delete(terminalId);
  const perTerminalLimit = Math.min(options.maxTerminalBytesPerTerminal, options.maxTerminalBytes);
  const retained = trimTerminalProjection(terminal, perTerminalLimit, preferredStream);
  const retainedBytes = terminalProjectionBytes(retained);
  // The id is required to address a terminal. If it cannot fit by itself,
  // dropping the projection is the only way to honor an absolute item budget.
  if (retainedBytes <= perTerminalLimit) {
    next.set(terminalId, retained);
    totalBytes += retainedBytes;
  }
  while (next.size > options.maxTerminals) {
    const completed = [...next].find(([id, value]) => id !== terminalId && value.closed)?.[0];
    const oldestOther = [...next.keys()].find((id) => id !== terminalId);
    const evicted = completed ?? oldestOther ?? next.keys().next().value;
    if (evicted === undefined) break;
    totalBytes -= terminalProjectionBytes(next.get(evicted)!);
    next.delete(evicted);
  }
  while (totalBytes > options.maxTerminalBytes) {
    const completed = [...next].find(([id, value]) => id !== terminalId && value.closed)?.[0];
    const oldestOther = [...next.keys()].find((id) => id !== terminalId);
    const evicted = completed ?? oldestOther;
    if (evicted === undefined) break;
    totalBytes -= terminalProjectionBytes(next.get(evicted)!);
    next.delete(evicted);
  }
  const current = next.get(terminalId);
  if (current !== undefined && totalBytes > options.maxTerminalBytes) {
    const trimmed = trimTerminalProjection(current, options.maxTerminalBytes, preferredStream);
    totalBytes += terminalProjectionBytes(trimmed) - terminalProjectionBytes(current);
    next.set(terminalId, trimmed);
  }
  if (totalBytes > options.maxTerminalBytes) next.delete(terminalId);
  return immutableMap(next);
}

function fileProjectionBytes(file: ProjectionFileFrame): number {
  const cached = FILE_PROJECTION_BYTES.get(file);
  if (cached !== undefined) return cached;
  const bytes = utf8Bytes(file.path) + (file.content === undefined ? 0 : utf8Bytes(file.content));
  FILE_PROJECTION_BYTES.set(file, bytes);
  return bytes;
}

function fileWithoutContent(file: ProjectionFileFrame): ProjectionFileFrame {
  const { content: _content, ...metadata } = file;
  return Object.freeze({ ...metadata, truncated: true });
}

function trimFileProjection(file: ProjectionFileFrame, maxBytes: number): ProjectionFileFrame {
  if (fileProjectionBytes(file) <= maxBytes || file.content === undefined) return file;
  const content = retainedUtf8Head(file.content, Math.max(0, maxBytes - utf8Bytes(file.path)));
  return Object.freeze({ ...file, content, truncated: true });
}

/** Keep recent content first while retaining older paths as useful tree metadata. */
export function retainFileProjection(
  files: ReadonlyMap<string, ProjectionFileFrame>,
  path: string,
  file: ProjectionFileFrame,
  options: Required<ProjectionOptions>,
): ReadonlyMap<string, ProjectionFileFrame> {
  const next = new Map(files);
  let totalBytes = 0;
  for (const value of next.values()) totalBytes += fileProjectionBytes(value);
  const replaced = next.get(path);
  if (replaced !== undefined) totalBytes -= fileProjectionBytes(replaced);
  next.delete(path);
  const perFileLimit = Math.min(options.maxFileBytes, options.maxFilesBytes);
  const retained = trimFileProjection(file, perFileLimit);
  const retainedBytes = fileProjectionBytes(retained);
  // A path is required file metadata. If the path alone exceeds the item
  // budget, omit the projection instead of silently violating the contract.
  if (retainedBytes <= perFileLimit) {
    next.set(path, retained);
    totalBytes += retainedBytes;
  }
  while (next.size > options.maxFiles) {
    const evicted = next.keys().next().value;
    if (evicted === undefined) break;
    totalBytes -= fileProjectionBytes(next.get(evicted)!);
    next.delete(evicted);
  }
  while (totalBytes > options.maxFilesBytes) {
    const oldestWithContent = [...next].find(
      ([candidatePath, candidate]) => candidatePath !== path && candidate.content !== undefined,
    );
    if (oldestWithContent === undefined) break;
    const metadata = fileWithoutContent(oldestWithContent[1]);
    totalBytes += fileProjectionBytes(metadata) - fileProjectionBytes(oldestWithContent[1]);
    next.set(oldestWithContent[0], metadata);
  }
  const current = next.get(path);
  if (current !== undefined && totalBytes > options.maxFilesBytes) {
    const otherBytes = totalBytes - fileProjectionBytes(current);
    const trimmed = trimFileProjection(current, Math.max(0, options.maxFilesBytes - otherBytes));
    totalBytes += fileProjectionBytes(trimmed) - fileProjectionBytes(current);
    next.set(path, trimmed);
  }
  while (totalBytes > options.maxFilesBytes) {
    const oldestOther = [...next.keys()].find((candidatePath) => candidatePath !== path);
    if (oldestOther === undefined) break;
    totalBytes -= fileProjectionBytes(next.get(oldestOther)!);
    next.delete(oldestOther);
  }
  if (totalBytes > options.maxFilesBytes) next.delete(path);
  return immutableMap(next);
}

export function retainRestoredSessionResources(
  session: SessionProjection,
  options: Required<ProjectionOptions>,
): SessionProjection {
  let terminals = immutableMap<string, TerminalProjection>();
  for (const [terminalId, terminal] of session.terminals) {
    terminals = retainTerminalProjection(terminals, terminalId, terminal, options);
  }
  let files = immutableMap<string, ProjectionFileFrame>();
  for (const [path, file] of session.files) {
    files = retainFileProjection(files, path, file, options);
  }
  return Object.freeze({ ...session, terminals, files });
}
