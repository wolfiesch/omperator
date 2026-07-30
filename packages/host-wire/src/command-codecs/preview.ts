import { decodePreviewSnapshot, PREVIEW_ACTIONS } from "../additive.js";
import { fail } from "../errors.js";
import {
  boundedArray,
  boundedBase64,
  boundedMap,
  boundedText,
  controlFree,
  finiteNumber,
  safeRelativePath,
  safeSeq,
} from "../guards.js";
import { leaseId, previewCaptureId, previewId } from "../ids.js";
import {
  PREVIEW_CAPTURE_CHUNK_BYTES,
  PREVIEW_CAPTURE_MAX_BYTES,
  PREVIEW_HANDOFF_MESSAGE_BYTES,
  PREVIEW_HANDOFF_TIMEOUT_MAX_MS,
  PREVIEW_LEASE_TTL_MAX_MS,
  PREVIEW_MAX_PER_SESSION,
  PREVIEW_SCROLL_DELTA_LIMIT,
  PREVIEW_SELECTOR_BYTES,
  PREVIEW_TEXT_INPUT_BYTES,
} from "../limits.js";

type CommandArguments = Record<string, unknown>;
type CommandResult = Record<string, unknown>;
type Decoder<T> = (value: unknown) => T;

function strictMap(
  value: unknown,
  path: string,
  allowed: readonly string[],
): Record<string, unknown> {
  const x = boundedMap(value, path);
  const unexpected = Object.keys(x).find((key) => !allowed.includes(key));
  if (unexpected !== undefined)
    fail("INVALID_FRAME", `unexpected field ${unexpected}`, `${path}.${unexpected}`);
  return x;
}

function strictArgs(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  return strictMap(value, "args", allowed);
}

function result(value: unknown): Record<string, unknown> {
  return boundedMap(value, "result");
}

function url(value: unknown, path: string): string {
  const text = controlFree(value, path, 4096);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    fail("INVALID_FRAME", "invalid URL", path);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  )
    fail("INVALID_FRAME", "URL must be http(s) without credentials", path);
  return text;
}

function previewAuthorityId(value: unknown, path: string): string {
  return controlFree(value, path, 128);
}

function previewSelector(value: unknown, path: string): string {
  return controlFree(value, path, PREVIEW_SELECTOR_BYTES);
}

function previewTtl(value: unknown, path: string): number {
  const ttl = safeSeq(value, path);
  if (ttl === 0 || ttl > PREVIEW_LEASE_TTL_MAX_MS)
    fail("BOUNDS", "preview lease TTL exceeds limit", path);
  return ttl;
}

function previewTarget(value: unknown, allowed: readonly string[] = []): CommandArguments {
  const x = strictArgs(value, ["previewId", "leaseId", ...allowed]);
  previewId(x.previewId, "args.previewId");
  if (x.leaseId !== undefined) leaseId(x.leaseId, "args.leaseId");
  return x;
}

function decodePreviewStateArguments(value: unknown): CommandArguments {
  const x = strictArgs(value, ["previewId"]);
  if (x.previewId !== undefined) previewId(x.previewId, "args.previewId");
  return x;
}

function decodePreviewLaunchArguments(value: unknown): CommandArguments {
  const x = strictArgs(value, ["url", "authorityId"]);
  url(x.url, "args.url");
  if (x.authorityId !== undefined) previewAuthorityId(x.authorityId, "args.authorityId");
  return x;
}

function decodePreviewNavigateArguments(value: unknown): CommandArguments {
  const x = previewTarget(value, ["url"]);
  url(x.url, "args.url");
  return x;
}

function decodePreviewClickArguments(value: unknown): CommandArguments {
  const x = previewTarget(value, ["x", "y", "selector", "button", "clickCount"]);
  const hasCoordinates = x.x !== undefined || x.y !== undefined;
  const hasSelector = x.selector !== undefined;
  if (
    hasCoordinates === hasSelector ||
    (hasCoordinates && (x.x === undefined || x.y === undefined))
  )
    fail("INVALID_FRAME", "preview click requires either x/y coordinates or one selector", "args");
  if (hasCoordinates) {
    const px = finiteNumber(x.x, "args.x");
    const py = finiteNumber(x.y, "args.y");
    if (px < 0 || py < 0 || px > PREVIEW_SCROLL_DELTA_LIMIT || py > PREVIEW_SCROLL_DELTA_LIMIT)
      fail("BOUNDS", "preview click coordinate exceeds limit", "args");
  } else {
    previewSelector(x.selector, "args.selector");
  }
  if (x.button !== undefined && !["left", "middle", "right"].includes(String(x.button)))
    fail("INVALID_FRAME", "preview click button is invalid", "args.button");
  if (x.clickCount !== undefined) {
    const count = safeSeq(x.clickCount, "args.clickCount");
    if (count < 1 || count > 3)
      fail("BOUNDS", "preview click count exceeds limit", "args.clickCount");
  }
  return x;
}

function decodePreviewScrollArguments(value: unknown): CommandArguments {
  const x = previewTarget(value, ["deltaX", "deltaY", "selector"]);
  for (const key of ["deltaX", "deltaY"] as const) {
    const delta = finiteNumber(x[key], `args.${key}`);
    if (Math.abs(delta) > PREVIEW_SCROLL_DELTA_LIMIT)
      fail("BOUNDS", "preview scroll delta exceeds limit", `args.${key}`);
  }
  if (x.selector !== undefined) previewSelector(x.selector, "args.selector");
  return x;
}

function decodePreviewTextArguments(value: unknown): CommandArguments {
  const x = previewTarget(value, ["text", "selector"]);
  boundedText(x.text, "args.text", PREVIEW_TEXT_INPUT_BYTES);
  if (x.selector !== undefined) previewSelector(x.selector, "args.selector");
  return x;
}

function decodePreviewSelectArguments(value: unknown): CommandArguments {
  const x = previewTarget(value, ["selector", "value"]);
  previewSelector(x.selector, "args.selector");
  boundedText(x.value, "args.value", PREVIEW_TEXT_INPUT_BYTES);
  return x;
}

function decodePreviewUploadArguments(value: unknown): CommandArguments {
  const x = previewTarget(value, ["selector", "path"]);
  previewSelector(x.selector, "args.selector");
  safeRelativePath(x.path, "args.path");
  return x;
}

function decodePreviewPressArguments(value: unknown): CommandArguments {
  const x = previewTarget(value, ["key"]);
  controlFree(x.key, "args.key", 128);
  return x;
}

function decodePreviewCaptureReadArguments(value: unknown): CommandArguments {
  const x = previewTarget(value, ["captureId", "offset"]);
  previewCaptureId(x.captureId, "args.captureId");
  safeSeq(x.offset, "args.offset");
  return x;
}

function decodePreviewPolicyCheckArguments(value: unknown): CommandArguments {
  const x = strictArgs(value, ["action", "previewId", "url", "authorityId"]);
  const action = controlFree(x.action, "args.action", 64);
  if (!(PREVIEW_ACTIONS as readonly string[]).includes(action))
    fail("INVALID_FRAME", "preview policy action is invalid", "args.action");
  if (x.previewId !== undefined) previewId(x.previewId, "args.previewId");
  if (x.url !== undefined) url(x.url, "args.url");
  if (x.authorityId !== undefined) previewAuthorityId(x.authorityId, "args.authorityId");
  return x;
}

function decodePreviewLeaseAcquireArguments(value: unknown): CommandArguments {
  const x = strictArgs(value, ["previewId", "ttlMs"]);
  previewId(x.previewId, "args.previewId");
  if (x.ttlMs !== undefined) previewTtl(x.ttlMs, "args.ttlMs");
  return x;
}

function decodePreviewLeaseRenewArguments(value: unknown): CommandArguments {
  const x = strictArgs(value, ["previewId", "leaseId", "ttlMs"]);
  previewId(x.previewId, "args.previewId");
  leaseId(x.leaseId, "args.leaseId");
  if (x.ttlMs !== undefined) previewTtl(x.ttlMs, "args.ttlMs");
  return x;
}

function decodePreviewLeaseReleaseArguments(value: unknown): CommandArguments {
  const x = strictArgs(value, ["previewId", "leaseId"]);
  previewId(x.previewId, "args.previewId");
  leaseId(x.leaseId, "args.leaseId");
  return x;
}

function decodePreviewHandoffArguments(value: unknown): CommandArguments {
  const x = previewTarget(value, [
    "message",
    "mode",
    "selector",
    "urlSubstring",
    "text",
    "timeoutMs",
  ]);
  boundedText(x.message, "args.message", PREVIEW_HANDOFF_MESSAGE_BYTES);
  const mode = x.mode === undefined ? "manual" : controlFree(x.mode, "args.mode", 16);
  if (!["manual", "selector", "url", "text"].includes(mode))
    fail("INVALID_FRAME", "preview handoff mode is invalid", "args.mode");
  const conditions = {
    selector: x.selector !== undefined,
    url: x.urlSubstring !== undefined,
    text: x.text !== undefined,
  };
  if (mode === "manual") {
    if (conditions.selector || conditions.url || conditions.text)
      fail("INVALID_FRAME", "manual preview handoff cannot include a completion condition", "args");
  } else if (
    !conditions[mode as keyof typeof conditions] ||
    Object.values(conditions).filter(Boolean).length !== 1
  ) {
    fail(
      "INVALID_FRAME",
      "preview handoff requires exactly one matching completion condition",
      "args",
    );
  }
  if (x.selector !== undefined) previewSelector(x.selector, "args.selector");
  if (x.urlSubstring !== undefined) controlFree(x.urlSubstring, "args.urlSubstring", 4096);
  if (x.text !== undefined) controlFree(x.text, "args.text", PREVIEW_TEXT_INPUT_BYTES);
  if (x.timeoutMs !== undefined) {
    const timeoutMs = safeSeq(x.timeoutMs, "args.timeoutMs");
    if (timeoutMs === 0 || timeoutMs > PREVIEW_HANDOFF_TIMEOUT_MAX_MS)
      fail("BOUNDS", "preview handoff timeout exceeds limit", "args.timeoutMs");
  }
  return x;
}

function decodePreviewMutationResult(value: unknown): CommandResult {
  const x = result(value);
  return { ...x, preview: decodePreviewSnapshot(x.preview, "result.preview") };
}

function decodePreviewStateResult(value: unknown): CommandResult {
  const x = result(value);
  return {
    ...x,
    previews: boundedArray(x.previews, "result.previews", PREVIEW_MAX_PER_SESSION).map(
      (preview, index) => decodePreviewSnapshot(preview, `result.previews[${index}]`),
    ),
  };
}

function decodePreviewCaptureReadResult(value: unknown): CommandResult {
  const x = result(value);
  const size = safeSeq(x.size, "result.size");
  const offset = safeSeq(x.offset, "result.offset");
  const nextOffset = safeSeq(x.nextOffset, "result.nextOffset");
  if (size === 0 || size > PREVIEW_CAPTURE_MAX_BYTES)
    fail("BOUNDS", "preview capture size exceeds limit", "result.size");
  if (offset > nextOffset || nextOffset > size)
    fail("INVALID_FRAME", "preview capture offsets are invalid", "result");
  if (typeof x.complete !== "boolean")
    fail("INVALID_FRAME", "preview capture completion must be boolean", "result.complete");
  if (x.complete !== (nextOffset === size))
    fail("INVALID_FRAME", "preview capture completion disagrees with offsets", "result.complete");
  if (!x.complete && nextOffset === offset)
    fail(
      "INVALID_FRAME",
      "preview capture read must advance while incomplete",
      "result.nextOffset",
    );
  previewId(x.previewId, "result.previewId");
  previewCaptureId(x.captureId, "result.captureId");
  const content = boundedBase64(x.content, "result.content", PREVIEW_CAPTURE_CHUNK_BYTES);
  const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (
    (padding === 2 && (alphabet.indexOf(content[content.length - 3]!) & 0x0f) !== 0) ||
    (padding === 1 && (alphabet.indexOf(content[content.length - 2]!) & 0x03) !== 0)
  )
    fail(
      "INVALID_FRAME",
      "preview capture content has non-canonical padding bits",
      "result.content",
    );
  const decodedBytes = (content.length / 4) * 3 - padding;
  if (decodedBytes !== nextOffset - offset)
    fail("INVALID_FRAME", "preview capture content does not match its offsets", "result.content");
  return x;
}

function decodePreviewPolicyCheckResult(value: unknown): CommandResult {
  const x = result(value);
  if (typeof x.allowed !== "boolean")
    fail("INVALID_FRAME", "preview policy allowed must be boolean", "result.allowed");
  if (typeof x.confirmationRequired !== "boolean")
    fail(
      "INVALID_FRAME",
      "preview policy confirmationRequired must be boolean",
      "result.confirmationRequired",
    );
  if (x.reason !== undefined) controlFree(x.reason, "result.reason", 256);
  return x;
}

function decodePreviewLeaseResult(value: unknown): CommandResult {
  const x = result(value);
  previewId(x.previewId, "result.previewId");
  leaseId(x.leaseId, "result.leaseId");
  safeSeq(x.expiresAt, "result.expiresAt");
  return x;
}

function decodePreviewLeaseReleaseResult(value: unknown): CommandResult {
  const x = result(value);
  previewId(x.previewId, "result.previewId");
  if (typeof x.released !== "boolean")
    fail("INVALID_FRAME", "preview lease released must be boolean", "result.released");
  return x;
}

export const PREVIEW_ARGUMENT_DECODERS: Readonly<Record<string, Decoder<CommandArguments>>> = {
  "preview.launch": decodePreviewLaunchArguments,
  "preview.state": decodePreviewStateArguments,
  "preview.activate": previewTarget,
  "preview.navigate": decodePreviewNavigateArguments,
  "preview.back": previewTarget,
  "preview.forward": previewTarget,
  "preview.reload": previewTarget,
  "preview.close": previewTarget,
  "preview.capture": previewTarget,
  "preview.capture.read": decodePreviewCaptureReadArguments,
  "preview.click": decodePreviewClickArguments,
  "preview.fill": decodePreviewTextArguments,
  "preview.scroll": decodePreviewScrollArguments,
  "preview.type": decodePreviewTextArguments,
  "preview.select": decodePreviewSelectArguments,
  "preview.press": decodePreviewPressArguments,
  "preview.upload": decodePreviewUploadArguments,
  "preview.policy.check": decodePreviewPolicyCheckArguments,
  "preview.lease.acquire": decodePreviewLeaseAcquireArguments,
  "preview.lease.renew": decodePreviewLeaseRenewArguments,
  "preview.lease.release": decodePreviewLeaseReleaseArguments,
  "preview.handoff": decodePreviewHandoffArguments,
};

export const PREVIEW_RESULT_DECODERS: Readonly<Record<string, Decoder<CommandResult>>> = {
  "preview.launch": decodePreviewMutationResult,
  "preview.state": decodePreviewStateResult,
  "preview.activate": decodePreviewMutationResult,
  "preview.navigate": decodePreviewMutationResult,
  "preview.back": decodePreviewMutationResult,
  "preview.forward": decodePreviewMutationResult,
  "preview.reload": decodePreviewMutationResult,
  "preview.close": decodePreviewMutationResult,
  "preview.capture": decodePreviewMutationResult,
  "preview.capture.read": decodePreviewCaptureReadResult,
  "preview.click": decodePreviewMutationResult,
  "preview.fill": decodePreviewMutationResult,
  "preview.scroll": decodePreviewMutationResult,
  "preview.type": decodePreviewMutationResult,
  "preview.select": decodePreviewMutationResult,
  "preview.press": decodePreviewMutationResult,
  "preview.upload": decodePreviewMutationResult,
  "preview.policy.check": decodePreviewPolicyCheckResult,
  "preview.lease.acquire": decodePreviewLeaseResult,
  "preview.lease.renew": decodePreviewLeaseResult,
  "preview.lease.release": decodePreviewLeaseReleaseResult,
  "preview.handoff": decodePreviewMutationResult,
};
