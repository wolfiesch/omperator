import { type Cursor, decodeCursor } from "./cursor.js";
import { fail } from "./errors.js";
import {
  boundedArray,
  boundedMetadata,
  boundedText,
  controlFree,
  finiteNumber,
  inputObject,
  isSecretLikeKey,
  safeSeq,
} from "./guards.js";
import {
  type HostId,
  hostId,
  type PreviewCaptureId,
  type PreviewId,
  previewCaptureId,
  previewId,
  type Revision,
  revision,
  type SessionId,
  sessionId,
} from "./ids.js";
import {
  PREVIEW_CAPTURE_MAX_BYTES,
  PREVIEW_CAPTURE_MAX_PIXELS,
  PROTOCOL_VERSION,
} from "./limits.js";

export const PREVIEW_CAPTURE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type PreviewCaptureMimeType = (typeof PREVIEW_CAPTURE_MIME_TYPES)[number];
export type PreviewState = "launching" | "ready" | "running" | "stopped" | "failed";
export const PREVIEW_AUTHORITY_KINDS = ["isolated-session", "authenticated-profile"] as const;
export type PreviewAuthorityKind = (typeof PREVIEW_AUTHORITY_KINDS)[number];

export interface PreviewAuthorityDescriptor {
  readonly id: string;
  readonly label: string;
  readonly kind: PreviewAuthorityKind;
  readonly requiresExplicitOptIn: boolean;
}

export const PREVIEW_ACTIONS = [
  "activate",
  "navigate",
  "back",
  "forward",
  "reload",
  "close",
  "capture",
  "click",
  "fill",
  "type",
  "press",
  "scroll",
  "select",
  "upload",
  "handoff",
] as const;
export type PreviewAction = (typeof PREVIEW_ACTIONS)[number];

export interface PreviewViewport {
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor?: number;
}

export interface PreviewCaptureMetadata {
  readonly captureId: PreviewCaptureId;
  readonly mimeType: PreviewCaptureMimeType;
  readonly size: number;
  readonly width: number;
  readonly height: number;
  readonly capturedAt: number;
  readonly sha256: string;
}

export interface PreviewSnapshot {
  readonly previewId: PreviewId;
  readonly state: PreviewState;
  readonly url: string;
  readonly revision: Revision;
  readonly cursor: Cursor;
  readonly title?: string;
  readonly canGoBack?: boolean;
  readonly canGoForward?: boolean;
  readonly viewport?: PreviewViewport;
  readonly capture?: PreviewCaptureMetadata;
  readonly authority?: PreviewAuthorityDescriptor;
  readonly availableActions?: readonly PreviewAction[];
}

export interface PreviewLaunchFrame extends PreviewSnapshot {
  v: typeof PROTOCOL_VERSION;
  type: "preview.launch";
  hostId: HostId;
  sessionId: SessionId;
  [key: string]: unknown;
}

export interface PreviewStateFrame extends PreviewSnapshot {
  v: typeof PROTOCOL_VERSION;
  type: "preview.state";
  hostId: HostId;
  sessionId: SessionId;
  error?: string;
  [key: string]: unknown;
}

export interface PreviewNavigationFrame extends PreviewSnapshot {
  v: typeof PROTOCOL_VERSION;
  type: "preview.navigation";
  hostId: HostId;
  sessionId: SessionId;
  [key: string]: unknown;
}

export interface PreviewCaptureFrame extends PreviewSnapshot {
  v: typeof PROTOCOL_VERSION;
  type: "preview.capture";
  hostId: HostId;
  sessionId: SessionId;
  capture: PreviewCaptureMetadata;
  [key: string]: unknown;
}

export interface PreviewErrorFrame {
  v: typeof PROTOCOL_VERSION;
  type: "preview.error";
  hostId: HostId;
  sessionId: SessionId;
  previewId: PreviewId;
  cursor: Cursor;
  revision: Revision;
  code: string;
  message: string;
  [key: string]: unknown;
}

export type PreviewFrame =
  | PreviewLaunchFrame
  | PreviewStateFrame
  | PreviewNavigationFrame
  | PreviewCaptureFrame
  | PreviewErrorFrame;

function frame(input: unknown, expected: readonly string[]): Record<string, unknown> {
  const x = inputObject(input);
  if (x.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
  if (typeof x.type !== "string" || !expected.includes(x.type))
    fail("UNKNOWN_FRAME", "unknown discriminant", "type");
  if (x.metadata !== undefined) boundedMetadata(x.metadata, "metadata", isSecretLikeKey);
  return x;
}

function own(x: Record<string, unknown>): { hostId: HostId; sessionId: SessionId } {
  return { hostId: hostId(x.hostId), sessionId: sessionId(x.sessionId) };
}

function known(value: unknown, path: string, values: readonly string[]): string {
  const result = controlFree(value, path, 128);
  if (!values.includes(result)) fail("UNKNOWN_FRAME", `unknown discriminant ${result}`, path);
  return result;
}

function httpUrl(value: unknown, path: string): string {
  const text = controlFree(value, path, 4096);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    fail("INVALID_FRAME", "invalid preview URL", path);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  )
    fail("INVALID_FRAME", "preview URL must be http(s) without credentials", path);
  return text;
}

function previewCaptureMimeType(value: unknown, path: string): PreviewCaptureMimeType {
  if (
    typeof value !== "string" ||
    !(PREVIEW_CAPTURE_MIME_TYPES as readonly string[]).includes(value)
  )
    fail("INVALID_FRAME", "unsupported preview capture MIME type", path);
  return value as PreviewCaptureMimeType;
}

export function decodePreviewViewport(value: unknown, path = "viewport"): PreviewViewport {
  const x = inputObject(value);
  const width = safeSeq(x.width, `${path}.width`);
  const height = safeSeq(x.height, `${path}.height`);
  if (width === 0 || height === 0 || width * height > PREVIEW_CAPTURE_MAX_PIXELS)
    fail("BOUNDS", "preview viewport dimensions exceed limit", path);
  const result: { width: number; height: number; deviceScaleFactor?: number } = { width, height };
  if (x.deviceScaleFactor !== undefined) {
    const scale = finiteNumber(x.deviceScaleFactor, `${path}.deviceScaleFactor`);
    if (scale <= 0 || scale > 8)
      fail("BOUNDS", "preview device scale factor exceeds limit", `${path}.deviceScaleFactor`);
    result.deviceScaleFactor = scale;
  }
  return result;
}

export function decodePreviewCaptureMetadata(
  value: unknown,
  path = "capture",
): PreviewCaptureMetadata {
  const x = inputObject(value);
  const size = safeSeq(x.size, `${path}.size`);
  const width = safeSeq(x.width, `${path}.width`);
  const height = safeSeq(x.height, `${path}.height`);
  if (size === 0 || size > PREVIEW_CAPTURE_MAX_BYTES)
    fail("BOUNDS", "preview capture size exceeds limit", `${path}.size`);
  if (width === 0 || height === 0 || width * height > PREVIEW_CAPTURE_MAX_PIXELS)
    fail("BOUNDS", "preview capture dimensions exceed limit", path);
  const digest = controlFree(x.sha256, `${path}.sha256`, 64);
  if (!/^[0-9a-f]{64}$/u.test(digest))
    fail("INVALID_FRAME", "preview capture digest must be lowercase sha256", `${path}.sha256`);
  return {
    captureId: previewCaptureId(x.captureId, `${path}.captureId`),
    mimeType: previewCaptureMimeType(x.mimeType, `${path}.mimeType`),
    size,
    width,
    height,
    capturedAt: safeSeq(x.capturedAt, `${path}.capturedAt`),
    sha256: digest,
  };
}

export function decodePreviewAuthority(
  value: unknown,
  path = "authority",
): PreviewAuthorityDescriptor {
  const x = inputObject(value);
  if (typeof x.requiresExplicitOptIn !== "boolean")
    fail(
      "INVALID_FRAME",
      "preview authority requiresExplicitOptIn must be boolean",
      `${path}.requiresExplicitOptIn`,
    );
  return {
    id: controlFree(x.id, `${path}.id`, 128),
    label: boundedText(x.label, `${path}.label`, 256),
    kind: known(x.kind, `${path}.kind`, PREVIEW_AUTHORITY_KINDS) as PreviewAuthorityKind,
    requiresExplicitOptIn: x.requiresExplicitOptIn,
  };
}

function decodePreviewActions(value: unknown, path: string): readonly PreviewAction[] {
  const actions = boundedArray(value, path, PREVIEW_ACTIONS.length).map((item, index) =>
    known(item, `${path}[${index}]`, PREVIEW_ACTIONS),
  ) as PreviewAction[];
  if (new Set(actions).size !== actions.length)
    fail("INVALID_FRAME", "preview actions must be unique", path);
  return actions;
}

export function decodePreviewSnapshot(value: unknown, path = "preview"): PreviewSnapshot {
  const x = inputObject(value);
  const result: PreviewSnapshot & {
    title?: string;
    canGoBack?: boolean;
    canGoForward?: boolean;
    viewport?: PreviewViewport;
    capture?: PreviewCaptureMetadata;
    authority?: PreviewAuthorityDescriptor;
    availableActions?: readonly PreviewAction[];
  } = {
    previewId: previewId(x.previewId, `${path}.previewId`),
    state: known(x.state, `${path}.state`, [
      "launching",
      "ready",
      "running",
      "stopped",
      "failed",
    ]) as PreviewState,
    url: httpUrl(x.url, `${path}.url`),
    revision: revision(x.revision, `${path}.revision`),
    cursor: decodeCursor(x.cursor, `${path}.cursor`),
  };
  if (x.title !== undefined) result.title = boundedText(x.title, `${path}.title`, 512);
  if (x.canGoBack !== undefined) {
    if (typeof x.canGoBack !== "boolean")
      fail("INVALID_FRAME", "canGoBack must be boolean", `${path}.canGoBack`);
    result.canGoBack = x.canGoBack;
  }
  if (x.canGoForward !== undefined) {
    if (typeof x.canGoForward !== "boolean")
      fail("INVALID_FRAME", "canGoForward must be boolean", `${path}.canGoForward`);
    result.canGoForward = x.canGoForward;
  }
  if (x.viewport !== undefined)
    result.viewport = decodePreviewViewport(x.viewport, `${path}.viewport`);
  if (x.capture !== undefined)
    result.capture = decodePreviewCaptureMetadata(x.capture, `${path}.capture`);
  if (x.authority !== undefined)
    result.authority = decodePreviewAuthority(x.authority, `${path}.authority`);
  if (x.availableActions !== undefined)
    result.availableActions = decodePreviewActions(x.availableActions, `${path}.availableActions`);
  return result;
}

export function decodePreview(input: unknown): PreviewFrame {
  const x = frame(input, [
      "preview.launch",
      "preview.state",
      "preview.navigation",
      "preview.capture",
      "preview.error",
    ]),
    type = x.type as string,
    ids = own(x);
  if (type === "preview.error")
    return {
      ...x,
      type,
      ...ids,
      previewId: previewId(x.previewId),
      cursor: decodeCursor(x.cursor),
      revision: revision(x.revision),
      code: controlFree(x.code, "code", 128),
      message: boundedText(x.message, "message", 2048),
    } as PreviewErrorFrame;
  const snapshot = decodePreviewSnapshot(x, "preview");
  const result = { ...x, type, ...ids, ...snapshot };
  if (type === "preview.state" && x.error !== undefined)
    return { ...result, error: boundedText(x.error, "error", 2048) } as PreviewStateFrame;
  if (type === "preview.launch") return result as PreviewLaunchFrame;
  if (type === "preview.navigation") return result as PreviewNavigationFrame;
  if (type === "preview.capture") {
    if (snapshot.capture === undefined)
      fail("INVALID_FRAME", "preview capture frame requires capture metadata", "capture");
    return result as PreviewCaptureFrame;
  }
  return result as PreviewStateFrame;
}
