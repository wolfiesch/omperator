import type { Cursor } from "@t4-code/protocol";
import type {
  PreviewAction,
  PreviewAuthorityProjection,
  PreviewEventProjection,
  PreviewProjection,
  ProjectionPreviewFrame,
} from "./projection-contract.ts";

const PREVIEW_ACTIONS: readonly PreviewAction[] = [
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
];

function freezeArray<T>(value: T[]): readonly T[] {
  return Object.freeze(value);
}

function appendBounded<T>(items: readonly T[], item: T, max: number): readonly T[] {
  const next =
    items.length >= max ? [...items.slice(items.length - max + 1), item] : [...items, item];
  return freezeArray(next);
}

export function previewCursorState(
  preview: PreviewProjection | undefined,
  cursor: Cursor,
): "accept" | "duplicate" | "gap" {
  if (preview === undefined) return "accept";
  if (cursor.epoch !== preview.cursor.epoch) return "gap";
  if (cursor.seq <= preview.cursor.seq) return "duplicate";
  return cursor.seq === preview.cursor.seq + 1 ? "accept" : "gap";
}

export function previewAuthority(value: unknown): PreviewAuthorityProjection | undefined {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("id" in value) ||
    !("label" in value) ||
    !("kind" in value) ||
    !("requiresExplicitOptIn" in value)
  )
    return undefined;
  const { id, label, kind, requiresExplicitOptIn } = value;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > 128 ||
    typeof label !== "string" ||
    label.length > 256 ||
    (kind !== "isolated-session" && kind !== "authenticated-profile") ||
    typeof requiresExplicitOptIn !== "boolean"
  )
    return undefined;
  return Object.freeze({ id, label, kind, requiresExplicitOptIn });
}

export function previewActions(value: unknown): readonly PreviewAction[] | undefined {
  if (!Array.isArray(value) || value.length > PREVIEW_ACTIONS.length) return undefined;
  const actions = value.filter(
    (action): action is PreviewAction =>
      typeof action === "string" && PREVIEW_ACTIONS.includes(action as PreviewAction),
  );
  return actions.length === value.length && new Set(actions).size === actions.length
    ? Object.freeze(actions)
    : undefined;
}

export function previewProjection(
  frame: ProjectionPreviewFrame,
  previous: PreviewProjection | undefined,
): PreviewProjection {
  const hostId = String(frame.hostId);
  const sessionId = String(frame.sessionId);
  const previewId = String(frame.previewId);
  const authority = previewAuthority(frame.authority);
  const availableActions = previewActions(frame.availableActions);
  if (frame.type === "preview.error")
    return Object.freeze({
      hostId,
      sessionId,
      previewId,
      state: "failed",
      revision: String(frame.revision),
      cursor: Object.freeze({ ...frame.cursor }),
      ...(previous?.url === undefined ? {} : { url: previous.url }),
      ...(previous?.title === undefined ? {} : { title: previous.title }),
      ...(previous?.canGoBack === undefined ? {} : { canGoBack: previous.canGoBack }),
      ...(previous?.canGoForward === undefined ? {} : { canGoForward: previous.canGoForward }),
      ...(previous?.viewport === undefined ? {} : { viewport: previous.viewport }),
      ...(previous?.capture === undefined ? {} : { capture: previous.capture }),
      ...(previous?.authority === undefined ? {} : { authority: previous.authority }),
      ...(previous?.availableActions === undefined
        ? {}
        : { availableActions: previous.availableActions }),
      error: Object.freeze({ code: frame.code, message: frame.message }),
      freshness: "fresh",
    });
  return Object.freeze({
    hostId,
    sessionId,
    previewId,
    state: frame.state,
    url: frame.url,
    revision: String(frame.revision),
    cursor: Object.freeze({ ...frame.cursor }),
    ...(frame.title === undefined ? {} : { title: frame.title }),
    ...(frame.canGoBack === undefined ? {} : { canGoBack: frame.canGoBack }),
    ...(frame.canGoForward === undefined ? {} : { canGoForward: frame.canGoForward }),
    ...(frame.viewport === undefined ? {} : { viewport: Object.freeze({ ...frame.viewport }) }),
    ...(frame.capture === undefined ? {} : { capture: Object.freeze({ ...frame.capture }) }),
    ...(authority === undefined ? {} : { authority }),
    ...(availableActions === undefined ? {} : { availableActions }),
    ...(frame.type === "preview.state" && frame.error !== undefined
      ? { error: Object.freeze({ code: "preview_state", message: frame.error }) }
      : {}),
    freshness: "fresh",
  });
}

export function previewActivity(
  frame: ProjectionPreviewFrame,
  preview: PreviewProjection,
): PreviewEventProjection | null {
  if (frame.type === "preview.state") return null;
  const type =
    frame.type === "preview.launch"
      ? "launch"
      : frame.type === "preview.navigation"
        ? "navigation"
        : frame.type === "preview.capture"
          ? "capture"
          : "error";
  let url: PreviewEventProjection["url"];
  if (preview.url !== undefined) {
    try {
      const parsed = new URL(preview.url);
      url = Object.freeze({
        origin: parsed.origin.slice(0, 512),
        pathname: parsed.pathname.slice(0, 1024),
        hasQuery: parsed.search.length > 0,
      });
    } catch {
      // The wire decoder rejects malformed URLs; keep defensive projection behavior for stale cache/tests.
    }
  }
  return Object.freeze({
    type,
    previewId: preview.previewId,
    cursor: Object.freeze({ ...preview.cursor }),
    ...(url === undefined ? {} : { url }),
    ...(preview.capture === undefined ? {} : { timestamp: preview.capture.capturedAt }),
    ...(preview.capture === undefined ? {} : { captureId: preview.capture.captureId }),
    ...(preview.error === undefined ? {} : { errorCode: preview.error.code }),
  });
}

export function appendPreviewActivity(
  events: readonly PreviewEventProjection[],
  event: PreviewEventProjection,
  max: number,
): readonly PreviewEventProjection[] {
  if (
    events.some(
      (previous) =>
        previous.previewId === event.previewId &&
        previous.cursor.epoch === event.cursor.epoch &&
        previous.cursor.seq === event.cursor.seq,
    )
  )
    return events;
  return appendBounded(events, event, max);
}
