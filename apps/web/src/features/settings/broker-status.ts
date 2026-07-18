// Active-host account-broker status. `broker.status` is a host-scoped,
// no-args command whose strict result says where the host's accounts come
// from — never what the credentials are. This model queries only hosts that
// both hold the `broker.read` grant and advertise the command in their
// catalog; anything older, ungranted, or undecodable is "unsupported" or
// "error" — never silently "local". Raw error text and unsafe endpoints
// stop at this seam.
import type { DesktopRuntimeSnapshot } from "@t4-code/client";
import { hostId as brandHostId, type ResultFrame } from "@t4-code/protocol";

import type { LiveSettingsRuntimePort } from "./live-controller.ts";

type ResultPayload = Omit<ResultFrame, "v" | "type">;

export const BROKER_STATUS_COMMAND = "broker.status";
export const BROKER_READ_CAPABILITY = "broker.read";

const MAX_ENDPOINT_LENGTH = 512;
const DEFAULT_TIMEOUT_MS = 15_000;

/** The strict `broker.status` result: where this host's accounts live. */
export type BrokerStatus =
  | { readonly state: "local"; readonly generation: number }
  | { readonly state: "connected"; readonly endpoint: string; readonly generation: number }
  | { readonly state: "missing-token"; readonly endpoint?: string; readonly generation: number }
  | { readonly state: "unreachable"; readonly endpoint: string; readonly generation: number };

function decodeGeneration(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("generation must be a nonnegative bounded integer");
  }
  return value;
}

/**
 * The producer contract says the endpoint arrives as a bounded HTTP(S) URL
 * with credentials, query, and fragment already removed. Anything else is a
 * contract violation and rejects the whole result — a leaked credential must
 * never survive into renderer state.
 */
function decodeEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ENDPOINT_LENGTH) {
    throw new Error("endpoint must be a bounded string");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("endpoint is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("endpoint must be HTTP(S)");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("endpoint carries credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("endpoint carries a query or fragment");
  }
  return url.origin + (url.pathname === "/" ? "" : url.pathname);
}

function exactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  for (const key of required) {
    if (!(key in record)) throw new Error(`broker status is missing ${key}`);
  }
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new Error(`broker status carries an unknown field: ${key}`);
    }
  }
}

/** Strict decoder for the `broker.status` result payload. Throws on any
 * violation; the caller renders "error", never a guess. */
export function decodeBrokerStatus(result: unknown): BrokerStatus {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("broker status must be an object");
  }
  const record = result as Record<string, unknown>;
  const generation = decodeGeneration(record.generation);
  switch (record.state) {
    case "local":
      exactKeys(record, ["state", "generation"]);
      return { state: "local", generation };
    case "connected":
      exactKeys(record, ["state", "endpoint", "generation"]);
      return { state: "connected", endpoint: decodeEndpoint(record.endpoint), generation };
    case "missing-token":
      exactKeys(record, ["state", "generation"], ["endpoint"]);
      return record.endpoint === undefined
        ? { state: "missing-token", generation }
        : { state: "missing-token", endpoint: decodeEndpoint(record.endpoint), generation };
    case "unreachable":
      exactKeys(record, ["state", "endpoint", "generation"]);
      return { state: "unreachable", endpoint: decodeEndpoint(record.endpoint), generation };
    default:
      throw new Error("unknown broker state");
  }
}

/** The connected target+host the status is about. */
export interface BrokerHostRef {
  readonly targetId: string;
  readonly hostId: string;
}

/** The slice of the runtime snapshot the support check reads. Structural
 * (and optional per member) so recorded or minimal test snapshots work. */
export interface BrokerSnapshotSlice {
  readonly connections?: ReadonlyMap<string, string>;
  readonly hosts?: ReadonlyMap<string, { readonly grantedCapabilities: readonly string[] }>;
  readonly catalogs?: DesktopRuntimeSnapshot["catalogs"];
}

/** Does this host advertise AND route `broker.status` right now? Older
 * hosts fail one of these checks and stay honestly unsupported. */
export function brokerStatusSupported(snapshot: BrokerSnapshotSlice, ref: BrokerHostRef): boolean {
  if (snapshot.connections?.get(ref.targetId) !== "connected") return false;
  const host = snapshot.hosts?.get(ref.hostId);
  if (host === undefined || !host.grantedCapabilities.includes(BROKER_READ_CAPABILITY)) return false;
  const catalog = snapshot.catalogs?.get(ref.hostId);
  if (catalog === undefined) return false;
  const item = catalog.items.find(
    (candidate) =>
      candidate.kind === "command" &&
      (String(candidate.id) === BROKER_STATUS_COMMAND || candidate.name === BROKER_STATUS_COMMAND),
  );
  return item !== undefined && item.supported !== false;
}

/** Every renderable broker state. `error` with a `last` value is the stale
 * case: the old answer stays visible, marked as possibly out of date. */
export type BrokerStatusView =
  | { readonly kind: "unsupported" }
  | { readonly kind: "loading"; readonly last: BrokerStatus | null }
  | { readonly kind: "ready"; readonly status: BrokerStatus }
  | { readonly kind: "error"; readonly last: BrokerStatus | null };

export interface BrokerStatusCopy {
  readonly text: string;
  readonly tone: "muted" | "warning";
}

function statusText(status: BrokerStatus): string {
  switch (status.state) {
    case "local":
      return "Accounts are stored on this host.";
    case "connected":
      return `Accounts come from ${status.endpoint}.`;
    case "missing-token":
      return status.endpoint === undefined
        ? "This host's account broker needs a new sign-in."
        : `The account broker at ${status.endpoint} needs a new sign-in on this host.`;
    case "unreachable":
      return `This host can't reach the account broker at ${status.endpoint} right now.`;
  }
}

/** Concise, truthful copy per state. Never raw error text, never a token,
 * never an unvetted endpoint. */
export function brokerStatusCopy(view: BrokerStatusView): BrokerStatusCopy {
  switch (view.kind) {
    case "unsupported":
      return { text: "This host doesn't report where its accounts come from.", tone: "muted" };
    case "loading":
      return { text: "Checking where this host's accounts come from…", tone: "muted" };
    case "error":
      return view.last === null
        ? { text: "Account status couldn't be read. Refresh to try again.", tone: "warning" }
        : { text: `Account status may be out of date. ${statusText(view.last)}`, tone: "warning" };
    case "ready": {
      const state = view.status.state;
      return { text: statusText(view.status), tone: state === "local" || state === "connected" ? "muted" : "warning" };
    }
  }
}

export interface BrokerStatusModel {
  getState(): BrokerStatusView;
  /**
   * Reconcile with the active host. Queries once per target+host key while
   * supported; a host switch drops the previous answer AND any in-flight
   * reply, so a late response can never describe the wrong host. Never
   * notifies synchronously — callers read state right after.
   */
  sync(active: BrokerHostRef | null): void;
  /** Deliberate re-query of the current host; keeps the last answer visible. */
  refresh(): void;
  subscribe(listener: () => void): () => void;
}

export function createBrokerStatusModel(
  runtime: LiveSettingsRuntimePort,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): BrokerStatusModel {
  const listeners = new Set<() => void>();
  let state: BrokerStatusView = { kind: "unsupported" };
  let current: BrokerHostRef | null = null;
  let queriedKey: string | null = null;
  // Monotonic query token: any resolution carrying a stale token is dropped.
  let epoch = 0;

  function set(next: BrokerStatusView, notify: boolean): void {
    state = next;
    if (notify) for (const listener of listeners) listener();
  }

  function lastKnown(): BrokerStatus | null {
    if (state.kind === "ready") return state.status;
    if (state.kind === "error" || state.kind === "loading") return state.last;
    return null;
  }

  async function runQuery(ref: BrokerHostRef): Promise<BrokerStatus | "error" | "unsupported"> {
    // Collect the response before sending: the frame can beat the invoke
    // round-trip back to the renderer, and correlation is by requestId.
    const responses = new Map<string, ResultPayload>();
    let notifyResponse: (() => void) | null = null;
    const unsubscribe = runtime.subscribeEvents(
      { targetId: ref.targetId, hostId: ref.hostId, kinds: ["response"] },
      (event) => {
        if (event.event.kind !== "response") return;
        const frame = event.event.payload as ResultPayload;
        if (frame.command === BROKER_STATUS_COMMAND || frame.command === undefined) {
          responses.set(String(frame.requestId), frame);
          notifyResponse?.();
        }
      },
    );
    try {
      let sent;
      try {
        sent = await runtime.command(ref.targetId, {
          hostId: brandHostId(ref.hostId),
          command: BROKER_STATUS_COMMAND,
          args: {},
        });
      } catch (error) {
        // A client that predates the command refuses to route it; that is
        // an unsupported path, not a broker problem.
        const message = error instanceof Error ? error.message : "";
        return /unknown command|capabilit/iu.test(message) ? "unsupported" : "error";
      }
      const deadline = Date.now() + timeoutMs;
      let response = responses.get(sent.requestId);
      while (response === undefined && Date.now() < deadline) {
        const remaining = deadline - Date.now();
        const { promise: next, resolve: arm } = Promise.withResolvers<void>();
        notifyResponse = arm;
        const timer = setTimeout(arm, Math.max(1, remaining));
        await next;
        clearTimeout(timer);
        notifyResponse = null;
        response = responses.get(sent.requestId);
      }
      if (response === undefined || !response.ok) return "error";
      try {
        return decodeBrokerStatus(response.result);
      } catch {
        return "error";
      }
    } finally {
      unsubscribe();
    }
  }

  function query(ref: BrokerHostRef, carryLast: boolean, notify: boolean): void {
    epoch += 1;
    const token = epoch;
    set({ kind: "loading", last: carryLast ? lastKnown() : null }, notify);
    void runQuery(ref).then((outcome) => {
      if (token !== epoch) return; // the screen moved on; drop the late reply
      if (outcome === "unsupported") {
        // The key stays marked as queried: re-asking a client that cannot
        // route the command would loop. A deliberate refresh may retry.
        set({ kind: "unsupported" }, true);
      } else if (outcome === "error") {
        set({ kind: "error", last: lastKnown() }, true);
      } else {
        set({ kind: "ready", status: outcome }, true);
      }
    });
  }

  function invalidate(): void {
    queriedKey = null;
    epoch += 1;
    if (state.kind !== "unsupported") set({ kind: "unsupported" }, false);
  }

  return {
    getState: () => state,
    sync(active) {
      const key = active === null ? null : `${active.targetId}\u0000${active.hostId}`;
      const previousKey = current === null ? null : `${current.targetId}\u0000${current.hostId}`;
      current = active;
      if (active === null || key === null) {
        invalidate();
        return;
      }
      if (!brokerStatusSupported(runtime.getSnapshot(), active)) {
        invalidate();
        return;
      }
      if (queriedKey !== key) {
        queriedKey = key;
        query(active, key === previousKey, false);
      }
    },
    refresh() {
      if (current === null) return;
      if (!brokerStatusSupported(runtime.getSnapshot(), current)) {
        queriedKey = null;
        epoch += 1;
        set({ kind: "unsupported" }, true);
        return;
      }
      queriedKey = `${current.targetId}\u0000${current.hostId}`;
      query(current, true, true);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
