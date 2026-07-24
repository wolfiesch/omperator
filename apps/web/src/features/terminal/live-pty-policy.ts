import type { ResultProjection } from "@t4-code/client";
import type { UserPtyBridge } from "./pty.ts";
export type OpenCorrelation =
  | { readonly kind: "result"; readonly result: ResultProjection }
  | { readonly kind: "timeout" }
  | { readonly kind: "disconnected" };
export interface LivePtyBridgeOptions {
  readonly openTimeoutMs?: number;
  readonly maxPendingInputChars?: number;
  readonly maxBufferedFrameChars?: number;
}
export interface LivePtyBridge extends UserPtyBridge {
  availability(): LiveTerminalAvailability;
  dispose(): void;
}
import type { DesktopRuntimeSnapshot } from "@t4-code/client";
import {
  terminalId as brandTerminalId,
  type CatalogItem,
  type TerminalId,
} from "@t4-code/protocol";

import type { LiveSessionAddress } from "../../platform/live-workspace.ts";
import { sessionWriteLink } from "../session-runtime/session-inventory.ts";
import {
  presentSessionControl,
  readSessionControl,
} from "../session-runtime/session-observer.ts";
import type { PtyError } from "./pty.ts";
import { WIRE_MAX_COLS, WIRE_MAX_ROWS } from "./wire.ts";

/** Strict CURRENT ownership truth for one session; null means writable. */
export function sessionControlGateReason(
  snapshot: DesktopRuntimeSnapshot,
  address: Pick<LiveSessionAddress, "hostId" | "sessionId">,
): string | null {
  const key = `${address.hostId}\u0000${address.sessionId}`;
  const control = readSessionControl(
    snapshot.projection.sessions.get(key)?.ref ?? snapshot.projection.sessionIndex.get(key),
  );
  return control === null ? null : presentSessionControl(control).controlReason;
}

export const TERM_OPEN_COMMAND = "term.open";
const TERMINAL_IO_FEATURE = "terminal.io";

/** Messages are fixed, plain-language strings — never raw host output. */
export const MESSAGES = {
  notReady: "This session isn't ready for a shell yet. Try again in a moment.",
  syncing: "This session is still syncing from the host. Try again in a moment.",
  rejected: "The host didn't accept the shell request. Try again.",
  contested: "Something else is driving this session right now. Try again in a moment.",
  openTimeout: "The host didn't answer in time. Try again.",
  openDisconnected: "The connection dropped before the host answered. Try again once you're back.",
  denied: "The host didn't allow this shell.",
  failed: "The shell couldn't be started.",
  badResult: "The host answered with something this app couldn't use.",
  openFailedLocally: "This app couldn't send the shell request. Try again.",
  openRequestFailed: "The shell request failed. Try again.",
  openOutcomeUnknown:
    "The shell request may have reached the host. Check for a new shell before trying again.",
  connectionLost: "The connection dropped. The shell may still be running on the host.",
} as const;
export type LiveTerminalAvailability =
  | { readonly available: true }
  | {
      readonly available: false;
      readonly kind: "permission" | "transport";
      readonly reason: string;
    };

function unavailable(kind: "permission" | "transport", reason: string): LiveTerminalAvailability {
  return { available: false, kind, reason };
}

export function termOpenCatalogItem(
  snapshot: DesktopRuntimeSnapshot,
  hostIdValue: string,
): CatalogItem | undefined {
  const catalog = snapshot.catalogs.get(hostIdValue);
  return catalog?.items.find(
    (item) =>
      item.kind === "command" &&
      (item.name === TERM_OPEN_COMMAND || String(item.id) === TERM_OPEN_COMMAND),
  );
}

export function resolveLiveTerminalAvailability(
  snapshot: DesktopRuntimeSnapshot,
  address: LiveSessionAddress,
): LiveTerminalAvailability {
  if (snapshot.connections.get(address.targetId) !== "connected") {
    return unavailable("transport", "Unavailable while the host is unreachable");
  }
  const host = snapshot.hosts.get(address.hostId);
  if (host === undefined || snapshot.targetHosts.get(address.targetId) !== address.hostId) {
    return unavailable("transport", "Still connecting to this host");
  }
  if (!host.grantedFeatures.includes(TERMINAL_IO_FEATURE)) {
    return unavailable("permission", "Needs terminal access on this host");
  }
  if (snapshot.catalogs.get(address.hostId) === undefined) {
    return unavailable("transport", "Waiting for this host's command list");
  }
  const item = termOpenCatalogItem(snapshot, address.hostId);
  if (item === undefined) return unavailable("permission", "This host doesn't offer shells");
  if (item.supported === false) {
    return unavailable("permission", item.reason ?? "Not available on this host");
  }
  const required = new Set<string>([TERM_OPEN_COMMAND, ...(item.capabilities ?? [])]);
  for (const capability of required) {
    if (!host.grantedCapabilities.includes(capability)) {
      return unavailable(
        "permission",
        capability.startsWith("term.") || capability === TERMINAL_IO_FEATURE
          ? "Needs terminal access on this host"
          : "Not granted on this host",
      );
    }
  }
  // Full freshness before ownership: a cached link (unbound target,
  // incomplete inventory, or a stale warm copy) cannot prove current
  // session truth, so no shell may open, restore, or restart against it.
  if (
    sessionWriteLink(snapshot, address.targetId, address.hostId, address.sessionId) !== "live"
  ) {
    return unavailable("transport", MESSAGES.syncing);
  }
  // Ownership last among the honest reasons: while another app owns the
  // session (or the shape is unproven), fail closed with the exact copy.
  const controlReason = sessionControlGateReason(snapshot, address);
  if (controlReason !== null) return unavailable("permission", controlReason);
  return { available: true };
}

export function shellFieldAdvertised(item: CatalogItem | undefined): boolean {
  const metadata = item?.metadata;
  if (metadata === undefined || !("optionalArgs" in metadata)) return false;
  const optional: unknown = metadata.optionalArgs;
  return Array.isArray(optional) && optional.some((entry) => entry === "shell");
}

export function clampCols(cols: number): number {
  return Math.min(Math.max(Math.round(cols), 1), WIRE_MAX_COLS);
}
export function clampRows(rows: number): number {
  return Math.min(Math.max(Math.round(rows), 1), WIRE_MAX_ROWS);
}

export function isRelativeCwd(cwd: string): boolean {
  return !cwd.startsWith("/") && !cwd.startsWith("~") && !/^[A-Za-z]:[\\/]/.test(cwd);
}

export function parseTerminalIdFrom(result: ResultProjection): TerminalId | null {
  if (!result.ok) return null;
  const payload = result.result;
  if (payload === null || typeof payload !== "object" || !("terminalId" in payload)) return null;
  try {
    return brandTerminalId(payload.terminalId);
  } catch {
    return null;
  }
}

export function errorFromResult(result: ResultProjection): PtyError {
  const text = `${result.error?.code ?? ""} ${result.error?.message ?? ""}`;
  return /permission|denied|capabilit|forbidden/i.test(text)
    ? { kind: "permission-denied", message: MESSAGES.denied }
    : { kind: "shell-error", message: MESSAGES.failed };
}
