// Host connection view model: how the host menu names every connection
// state, why the host is in it, and the one safe action the user can take
// from the menu. States mirror what the client supervisor reports; the
// renderer never invents a rosier one (a cached host is "cached", never
// "connected").
import type { PeerIdentity } from "./model.ts";

export type HostKind = "local" | "remote";

export type HostConnectionState =
  | "starting"
  | "ready"
  | "unavailable"
  | "reconnecting"
  | "offline-cache"
  | "version-skew"
  | "upgrade-required"
  | "read-only";

export const HOST_CONNECTION_STATES: readonly HostConnectionState[] = [
  "starting",
  "ready",
  "unavailable",
  "reconnecting",
  "offline-cache",
  "version-skew",
  "upgrade-required",
  "read-only",
];

/**
 * A host row as the menu renders it. `name`, `identity`, and `reason` are
 * safe display labels — no addresses, ports, socket paths, or unit paths.
 */
export interface HostRow {
  readonly id: string;
  readonly kind: HostKind;
  readonly name: string;
  /** Verified identity for remote hosts; null for the local host. */
  readonly identity: PeerIdentity | null;
  readonly state: HostConnectionState;
  /** Exact cause, written for the row it sits under. */
  readonly reason: string;
  /** Session count as last known; null when nothing is known yet. */
  readonly sessionCount: number | null;
  /** App-wire version the host speaks, when the handshake got that far. */
  readonly protocolLabel: string | null;
}

export type HostActionId =
  | "retry"
  | "start-service"
  | "open-diagnostics"
  | "update-app"
  | "upgrade-host"
  | "view-cached";

export interface HostAction {
  readonly id: HostActionId;
  readonly label: string;
}

/** Visual tone per state; every tone maps to an existing semantic hue. */
export type HostStateTone = "working" | "success" | "error" | "muted" | "warning" | "info";

export interface HostStateMeta {
  readonly label: string;
  readonly tone: HostStateTone;
  /** Live states pulse their dot; everything else sits still. */
  readonly live: boolean;
  /** The one safe action the menu offers; null when waiting is the action. */
  readonly action: HostAction | null;
}

/**
 * The state → presentation contract. One place, so the menu, the onboarding
 * flow, and the tests all agree on label, tone, and safe action.
 */
export const HOST_STATE_META: Readonly<Record<HostConnectionState, HostStateMeta>> = {
  starting: {
    label: "Starting",
    tone: "working",
    live: true,
    action: null,
  },
  ready: {
    label: "Ready",
    tone: "success",
    live: false,
    action: null,
  },
  unavailable: {
    label: "Unavailable",
    tone: "error",
    live: false,
    action: { id: "retry", label: "Try again" },
  },
  reconnecting: {
    label: "Reconnecting",
    tone: "working",
    live: true,
    action: { id: "open-diagnostics", label: "Diagnostics" },
  },
  "offline-cache": {
    label: "Offline · cached",
    tone: "muted",
    live: false,
    action: { id: "view-cached", label: "Browse cached sessions" },
  },
  "version-skew": {
    label: "Older host",
    tone: "warning",
    live: false,
    action: { id: "upgrade-host", label: "How to update the host" },
  },
  "upgrade-required": {
    label: "Update needed",
    tone: "warning",
    live: false,
    action: { id: "update-app", label: "Update this app" },
  },
  "read-only": {
    label: "View only",
    tone: "info",
    live: false,
    action: null,
  },
};

/** States that count as "this host is usable enough to move on". */
export function hostIsUsable(state: HostConnectionState): boolean {
  return (
    state === "ready" ||
    state === "starting" ||
    state === "reconnecting" ||
    state === "read-only" ||
    state === "version-skew"
  );
}

export interface HostGroup {
  readonly kind: HostKind;
  readonly label: string;
  readonly hosts: readonly HostRow[];
}

/** Local first, then remote; original order preserved inside each group. */
export function groupHosts(hosts: readonly HostRow[]): readonly HostGroup[] {
  const groups: HostGroup[] = [];
  const local = hosts.filter((host) => host.kind === "local");
  const remote = hosts.filter((host) => host.kind === "remote");
  if (local.length > 0) groups.push({ kind: "local", label: "This computer", hosts: local });
  if (remote.length > 0) groups.push({ kind: "remote", label: "Paired computers", hosts: remote });
  return groups;
}
