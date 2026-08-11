// Onboarding and remote-access view models. These are renderer projections
// of what the T4 host reports over app-wire (pairing, host index, service
// state) — never a second protocol and never a credential store. Nothing in
// this module may carry a bearer token, raw address, socket path, or service
// file path: hosts and devices travel as safe display labels only.

/**
 * What a paired device is allowed to do on a host. Fixed set: the server
 * enforces these; the renderer only names them and edits a grant before it
 * is approved.
 */
export type CapabilityId = "observe" | "control" | "shell" | "files" | "destructive";

export interface CapabilityInfo {
  readonly id: CapabilityId;
  /** Short label for chips and checkbox rows. */
  readonly label: string;
  /** What granting this actually lets the device do, in plain words. */
  readonly impact: string;
}

/**
 * Ordered capability catalog. `observe` is the floor: a pairing that grants
 * nothing is a denial, not an empty grant.
 */
export const CAPABILITIES: readonly CapabilityInfo[] = [
  {
    id: "observe",
    label: "See sessions",
    impact: "Read session activity, agent output, and file previews on this host.",
  },
  {
    id: "control",
    label: "Control sessions",
    impact: "Send prompts, steer agents, and cancel work on this host.",
  },
  {
    id: "shell",
    label: "Open terminals",
    impact: "Open its own terminals on this host and run commands as your user.",
  },
  {
    id: "files",
    label: "Read project files",
    impact: "Open any file inside project folders this host exposes.",
  },
  {
    id: "destructive",
    label: "Approve risky commands",
    impact: "Confirm commands the host classifies as destructive, like deletes and force-pushes.",
  },
];

export const CAPABILITY_BY_ID: Readonly<Record<CapabilityId, CapabilityInfo>> =
  Object.fromEntries(CAPABILITIES.map((capability) => [capability.id, capability])) as Record<
    CapabilityId,
    CapabilityInfo
  >;

/** Human list for confirmation copy: "See sessions and Control sessions". */
export function capabilityLabels(ids: readonly CapabilityId[]): string {
  const labels = CAPABILITIES.filter((capability) => ids.includes(capability.id)).map(
    (capability) => capability.label.toLowerCase(),
  );
  if (labels.length === 0) return "nothing";
  if (labels.length === 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1] ?? ""}`;
}

/**
 * Who a remote peer is, as verified by the host. Safe display labels only —
 * never an IP, hostname with paths, or key material.
 */
export interface PeerIdentity {
  /** Canonical account, e.g. "maintainer@github". */
  readonly account: string;
  /** Node display name, e.g. "studio-mac". */
  readonly node: string;
}

export type DevicePlatform = "macos" | "linux" | "windows" | "ios" | "android";

export const DEVICE_PLATFORM_LABELS: Readonly<Record<DevicePlatform, string>> = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
  ios: "iOS",
  android: "Android",
};

/**
 * A device this host has paired. Deliberately token-free: the credential
 * lives in the OS keychain on the device and as a hash on the host. If a
 * field resembling a token ever lands here, that is a defect
 * (see onboarding tests).
 */
export interface PairedDevice {
  readonly id: string;
  readonly label: string;
  readonly platform: DevicePlatform;
  readonly identity: PeerIdentity;
  readonly pairedAt: string;
  /** null = never seen since pairing. */
  readonly lastSeenAt: string | null;
  readonly capabilities: readonly CapabilityId[];
  readonly connected: boolean;
}

/**
 * Adapter from a wire pairing result to the renderer device record. The wire
 * payload carries the bearer token exactly once (for the OS credential
 * store); this is the seam that guarantees it never reaches the renderer:
 * fields are copied one by one and the token is not one of them.
 */
export interface WirePairResult {
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly platform: DevicePlatform;
  readonly account: string;
  readonly node: string;
  readonly pairedAt: string;
  readonly capabilities: readonly CapabilityId[];
  /** Never displayed, never stored in renderer state. */
  readonly token: string;
}

export function deviceFromPairResult(result: WirePairResult): PairedDevice {
  return {
    id: result.deviceId,
    label: result.deviceLabel,
    platform: result.platform,
    identity: { account: result.account, node: result.node },
    pairedAt: result.pairedAt,
    lastSeenAt: result.pairedAt,
    capabilities: result.capabilities,
    connected: true,
  };
}

/** Format an ISO timestamp relative to a deterministic "now". */
export function formatLastSeen(iso: string | null, nowMs: number): string {
  if (iso === null) return "Never connected";
  const elapsedMs = nowMs - Date.parse(iso);
  if (elapsedMs < 60_000) return "Just now";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
