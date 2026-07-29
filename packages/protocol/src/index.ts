import {
  decodeServerFrame as decodeAppWireServerFrame,
  decodeSessionListResult as decodeAppWireSessionListResult,
  decodeSessions as decodeAppWireSessions,
  parseBounded,
  type ServerFrame,
  type SessionListResult,
  type SessionRef,
  type SessionsFrame,
} from "@t4-code/host-wire";
import type { OmpServerFrame } from "./server-event.ts";

export * from "@t4-code/host-wire";
export * from "./app-update.ts";
export * from "./pair-link.ts";
export * from "./server-event.ts";

export type SessionControlCompatibility = "absent" | "known" | "unknown";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isKnownSessionControl(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.mode === "observer") {
    return (
      hasExactKeys(value, ["mode", "lockStatus", "transcript"]) &&
      (value.lockStatus === "live" ||
        value.lockStatus === "suspect" ||
        value.lockStatus === "malformed") &&
      (value.transcript === "live" || value.transcript === "snapshot")
    );
  }
  return (
    (value.mode === "reconciling" || value.mode === "unverified") &&
    hasExactKeys(value, ["mode", "transcript"]) &&
    (value.transcript === "live" || value.transcript === "snapshot")
  );
}

/**
 * Classifies the additive control field without interpreting malformed or
 * future values as field absence. Only true absence is writable.
 */
export function sessionControlCompatibility(value: unknown): SessionControlCompatibility {
  if (!isRecord(value) || !Object.hasOwn(value, "liveState")) {
    return "absent";
  }
  if (!isRecord(value.liveState)) return "unknown";
  const liveState = value.liveState;
  if (!Object.hasOwn(liveState, "sessionControl")) return "absent";
  return isKnownSessionControl(liveState.sessionControl) ? "known" : "unknown";
}

/**
 * Preserves a decoded fail-closed marker inside the existing app-wire shape.
 * Consumers must use a strict reader; this marker is deliberately not a wire
 * value and is never encoded back to OMP.
 */
export function markUnknownSessionControl(value: SessionRef): SessionRef {
  return {
    ...value,
    liveState: {
      ...(isRecord(value.liveState) ? value.liveState : {}),
      sessionControl: { mode: "unknown" },
    },
  } as unknown as SessionRef;
}

interface PreparedSessionRef {
  readonly value: unknown;
  readonly unknownControl: boolean;
}

function prepareSessionRef(value: unknown): PreparedSessionRef {
  if (sessionControlCompatibility(value) !== "unknown" || !isRecord(value)) {
    return { value, unknownControl: false };
  }
  return {
    value: {
      ...value,
      liveState: {
        ...(isRecord(value.liveState) ? value.liveState : {}),
        sessionControl: { mode: "reconciling", transcript: "snapshot" },
      },
    },
    unknownControl: true,
  };
}

interface PreparedSessionList {
  readonly value: unknown;
  readonly unknownControls: readonly boolean[];
}

function prepareSessionList(value: unknown): PreparedSessionList {
  if (!isRecord(value) || !Array.isArray(value.sessions)) {
    return { value, unknownControls: [] };
  }
  let sessions: unknown[] | undefined;
  let unknownControls: boolean[] | undefined;
  for (const [index, session] of value.sessions.entries()) {
    if (sessionControlCompatibility(session) !== "unknown") continue;
    sessions ??= [...value.sessions];
    unknownControls ??= Array.from({ length: value.sessions.length }, () => false);
    sessions[index] = prepareSessionRef(session).value;
    unknownControls[index] = true;
  }
  return unknownControls === undefined
    ? { value, unknownControls: [] }
    : { value: { ...value, sessions }, unknownControls };
}

function restoreSessionList<T extends { readonly sessions: readonly SessionRef[] }>(
  value: T,
  unknownControls: readonly boolean[],
): T {
  if (!unknownControls.some(Boolean)) return value;
  return {
    ...value,
    sessions: value.sessions.map((session, index) =>
      unknownControls[index] === true ? markUnknownSessionControl(session) : session,
    ),
  } as T;
}

function materialize(input: unknown): unknown {
  return typeof input === "string" || input instanceof Uint8Array ? parseBounded(input) : input;
}

export function decodeSessions(input: unknown): SessionsFrame {
  const prepared = prepareSessionList(materialize(input));
  return restoreSessionList(decodeAppWireSessions(prepared.value), prepared.unknownControls);
}

export function decodeSessionListResult(input: unknown): SessionListResult {
  const prepared = prepareSessionList(input);
  return restoreSessionList(
    decodeAppWireSessionListResult(prepared.value),
    prepared.unknownControls,
  );
}

function decodeSessionDelta(input: Record<string, unknown>): ServerFrame {
  const prepared = prepareSessionRef(input.upsert);
  const decoded = decodeAppWireServerFrame(
    prepared.unknownControl ? { ...input, upsert: prepared.value } : input,
  );
  if (!prepared.unknownControl || decoded.type !== "session.delta" || decoded.upsert === undefined) {
    return decoded;
  }
  return { ...decoded, upsert: markUnknownSessionControl(decoded.upsert) };
}

function decodeResponse(input: Record<string, unknown>): ServerFrame {
  if (input.command === "host.list" || input.command === "session.list") {
    const prepared = prepareSessionList(input.result);
    const decoded = decodeAppWireServerFrame(
      prepared.unknownControls.some(Boolean) ? { ...input, result: prepared.value } : input,
    );
    if (
      !prepared.unknownControls.some(Boolean) ||
      decoded.type !== "response" ||
      !isRecord(decoded.result) ||
      !Array.isArray(decoded.result.sessions)
    ) {
      return decoded;
    }
    return {
      ...decoded,
      result: restoreSessionList(
        decoded.result as Record<string, unknown> & { readonly sessions: readonly SessionRef[] },
        prepared.unknownControls,
      ),
    };
  }
  if (input.command === "session.create" && isRecord(input.result)) {
    const prepared = prepareSessionRef(input.result.session);
    const decoded = decodeAppWireServerFrame(
      prepared.unknownControl
        ? { ...input, result: { ...input.result, session: prepared.value } }
        : input,
    );
    if (
      !prepared.unknownControl ||
      decoded.type !== "response" ||
      !isRecord(decoded.result) ||
      !isRecord(decoded.result.session)
    ) {
      return decoded;
    }
    return {
      ...decoded,
      result: {
        ...decoded.result,
        session: markUnknownSessionControl(decoded.result.session as unknown as SessionRef),
      },
    };
  }
  return decodeAppWireServerFrame(input);
}

/**
 * T4's app-wire boundary preserves a categorical read-only marker for a
 * present control shape that this client does not understand. The immutable
 * app-wire decoder stays strict; valid known frames retain their exact shape.
 */
export function decodeServerFrame(input: unknown): OmpServerFrame {
  const value = materialize(input);
  if (!isRecord(value)) return decodeAppWireServerFrame(value) as OmpServerFrame;
  if (value.type === "sessions") return decodeSessions(value);
  if (value.type === "session.delta") return decodeSessionDelta(value) as OmpServerFrame;
  if (value.type === "response") return decodeResponse(value) as OmpServerFrame;
  return decodeAppWireServerFrame(value) as OmpServerFrame;
}
