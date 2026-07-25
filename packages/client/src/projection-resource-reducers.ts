import { isCursor } from "@t4-code/protocol";
import { previewKey } from "./preview.ts";
import {
  appendPreviewActivity,
  previewActivity,
  previewCursorState,
  previewProjection,
} from "./projection-preview.ts";
import { retainFileProjection, retainTerminalProjection } from "./projection-retention.ts";
import type {
  ProjectionConfirmationFrame,
  ProjectionInputFrame,
  ProjectionOptions,
  ProjectionResultFrame,
  ProjectionSnapshot,
  ResultProjection,
  TerminalProjection,
  SessionProjection,
} from "./projection-contract.ts";
import { safeValue } from "./projection-sanitize.ts";

export interface ProjectionResourceReducerDependencies {
  readonly key: (hostId: string, sessionId: string) => string;
  readonly mapWith: <K, V>(
    map: ReadonlyMap<K, V>,
    itemKey: K,
    value: V,
    max?: number,
  ) => ReadonlyMap<K, V>;
  readonly immutableMap: <K, V>(entries?: Iterable<readonly [K, V]>) => ReadonlyMap<K, V>;
  readonly withSession: (
    snapshot: ProjectionSnapshot,
    sessionKey: string,
    update: (session: SessionProjection) => SessionProjection,
  ) => ProjectionSnapshot;
}

function freezeArray<T>(value: T[]): readonly T[] {
  return Object.freeze(value);
}

function appendBounded<T>(items: readonly T[], item: T, max: number): readonly T[] {
  const next =
    items.length >= max ? [...items.slice(items.length - max + 1), item] : [...items, item];
  return freezeArray(next);
}

function confirmationsAfterResponse(
  confirmations: ReadonlyMap<string, ProjectionConfirmationFrame>,
  frame: ProjectionResultFrame,
  immutableMap: ProjectionResourceReducerDependencies["immutableMap"],
): ReadonlyMap<string, ProjectionConfirmationFrame> {
  const invalid = frame.error?.code === "confirmation_invalid";
  let changed = false;
  const next = new Map<string, ProjectionConfirmationFrame>();
  for (const [confirmationKey, challenge] of confirmations) {
    if (String(challenge.commandId) !== String(frame.commandId)) {
      next.set(confirmationKey, challenge);
      continue;
    }
    if (invalid) {
      next.set(confirmationKey, challenge);
      continue;
    }
    changed = true;
  }
  return changed ? immutableMap(next) : confirmations;
}

function resultProjection(frame: ProjectionResultFrame): ResultProjection {
  const output: ResultProjection = {
    requestId: String(frame.requestId),
    ...(frame.commandId === undefined ? {} : { commandId: String(frame.commandId) }),
    ok: frame.ok,
    ...(frame.result === undefined ? {} : { result: safeValue(frame.result) }),
    ...(frame.error === undefined
      ? {}
      : { error: Object.freeze({ code: frame.error.code, message: frame.error.message }) }),
  };
  return Object.freeze(output);
}

function attachAcknowledgesCurrentCursor(
  session: SessionProjection,
  frame: ProjectionResultFrame,
): boolean {
  if (
    !frame.ok ||
    frame.command !== "session.attach" ||
    session.cursor === undefined ||
    frame.result === null ||
    typeof frame.result !== "object" ||
    Array.isArray(frame.result)
  ) {
    return false;
  }
  const result = frame.result as Record<string, unknown>;
  if (result.attached !== true || !isCursor(result.cursor)) return false;
  return result.cursor.epoch === session.cursor.epoch && result.cursor.seq === session.cursor.seq;
}

/** Returns undefined for a frame family owned by the root projection reducer. */
export function reduceResourceProjection(
  snapshot: ProjectionSnapshot,
  frame: ProjectionInputFrame,
  config: Required<ProjectionOptions>,
  dependencies: ProjectionResourceReducerDependencies,
): ProjectionSnapshot | undefined {
  const { immutableMap, key, mapWith, withSession } = dependencies;
  switch (frame.type) {
    case "preview.launch":
    case "preview.state":
    case "preview.navigation":
    case "preview.capture":
    case "preview.error": {
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      const previewIdentity = {
        hostId: String(frame.hostId),
        sessionId: String(frame.sessionId),
        previewId: String(frame.previewId),
      };
      const previewMapKey = previewKey(previewIdentity);
      const current = snapshot.sessions.get(sessionKey)?.previews.get(previewMapKey);
      const order = previewCursorState(current, frame.cursor);
      const baseline = frame.type === "preview.launch" || frame.type === "preview.state";
      if (!baseline && order === "duplicate") return snapshot;
      if (order === "gap" && !baseline)
        return withSession(snapshot, sessionKey, (session) => {
          const previous = session.previews.get(previewMapKey);
          return previous === undefined || previous.freshness === "stale"
            ? session
            : Object.freeze({
                ...session,
                previews: mapWith(
                  session.previews,
                  previewMapKey,
                  Object.freeze({ ...previous, freshness: "stale" as const }),
                  config.maxPreviews,
                ),
              });
        });
      if (current !== undefined && current.freshness !== "fresh" && !baseline)
        return withSession(snapshot, sessionKey, (session) => {
          const previous = session.previews.get(previewMapKey);
          return previous === undefined || previous.freshness === "stale"
            ? session
            : Object.freeze({
                ...session,
                previews: mapWith(
                  session.previews,
                  previewMapKey,
                  Object.freeze({ ...previous, freshness: "stale" as const }),
                  config.maxPreviews,
                ),
              });
        });
      const projected = previewProjection(frame, current);
      const activity = previewActivity(frame, projected);
      return withSession(snapshot, sessionKey, (session) =>
        Object.freeze({
          ...session,
          previews: mapWith(session.previews, previewMapKey, projected, config.maxPreviews),
          previewEvents:
            activity === null
              ? session.previewEvents
              : appendPreviewActivity(session.previewEvents, activity, config.maxPreviewEvents),
        }),
      );
    }
    case "terminal": {
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      return withSession(snapshot, sessionKey, (session) => {
        const existing =
          session.terminals.get(String(frame.terminalId)) ??
          Object.freeze({
            terminalId: String(frame.terminalId),
            stdout: "",
            stderr: "",
            closed: false,
          });
        const data = frame.data ?? "";
        const stream =
          frame.stream === "stderr" ? "stderr" : frame.stream === "stdout" ? "stdout" : undefined;
        const text = stream === undefined ? existing.stdout : `${existing[stream]}${data}`;
        const terminal: TerminalProjection = Object.freeze({
          ...existing,
          ...(stream === undefined ? {} : { [stream]: text }),
          ...(frame.exitCode === undefined ? {} : { exitCode: frame.exitCode }),
          ...(stream === undefined || frame.stream === "exit" ? { closed: true } : {}),
        });
        return Object.freeze({
          ...session,
          terminals: retainTerminalProjection(
            session.terminals,
            String(frame.terminalId),
            terminal,
            config,
            stream ?? "stdout",
          ),
        });
      });
    }
    case "files": {
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      return withSession(snapshot, sessionKey, (session) =>
        Object.freeze({
          ...session,
          files: retainFileProjection(
            session.files,
            frame.path,
            Object.freeze({ ...frame }),
            config,
          ),
        }),
      );
    }
    case "review": {
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      return withSession(snapshot, sessionKey, (session) =>
        Object.freeze({
          ...session,
          reviews: mapWith(
            session.reviews,
            frame.reviewId,
            Object.freeze({
              ...frame,
              findings: frame.findings.map((item) =>
                Object.freeze(safeValue(item) as Record<string, unknown>),
              ),
            }),
          ),
        }),
      );
    }
    case "audit": {
      if (frame.sessionId === undefined) return snapshot;
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      return withSession(snapshot, sessionKey, (session) =>
        Object.freeze({
          ...session,
          audit: appendBounded(
            session.audit,
            Object.freeze({
              ...frame,
              ...(frame.detail === undefined
                ? {}
                : { detail: Object.freeze(safeValue(frame.detail) as Record<string, unknown>) }),
            }),
            config.maxAudit,
          ),
        }),
      );
    }
    case "confirmation": {
      if (frame.sessionId === undefined) return snapshot;
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      return withSession(snapshot, sessionKey, (session) =>
        Object.freeze({
          ...session,
          confirmations: mapWith(
            session.confirmations,
            String(frame.confirmationId),
            Object.freeze({ ...frame }),
          ),
        }),
      );
    }
    case "response": {
      if (frame.sessionId === undefined) return snapshot;
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      return withSession(snapshot, sessionKey, (session) => {
        const attachedAtCurrentCursor = attachAcknowledgesCurrentCursor(session, frame);
        return Object.freeze({
          ...session,
          confirmations: confirmationsAfterResponse(session.confirmations, frame, immutableMap),
          results: mapWith(session.results, String(frame.requestId), resultProjection(frame)),
          ...(attachedAtCurrentCursor ? { freshness: "fresh" as const, gap: undefined } : {}),
        });
      });
    }
    default:
      return undefined;
  }
}
