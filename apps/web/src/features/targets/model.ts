// Remote target view models and the renderer-side mirror of the desktop
// validation contract (apps/desktop remote-runtime/registry.ts). Everything
// here is display shapes and pre-flight validation — the desktop main
// process re-validates every request, and nothing in this module ever sees
// a token, a credential, or a socket path.
import type { DesktopRuntimeSnapshot } from "@t4-code/client";
import type { ConnectionState, DesktopTarget, TargetAddRequest } from "@t4-code/protocol/desktop-ipc";

// ─── Capability groups ──────────────────────────────────────────────────────

/** Plain-language capability groups offered when adding a target. */
export type TargetCapabilityGroupId = "observe" | "control" | "shell" | "files" | "settings" | "cluster";

export interface TargetCapabilityGroup {
  readonly id: TargetCapabilityGroupId;
  readonly label: string;
  /** What granting this actually lets this app do, in plain words. */
  readonly impact: string;
  readonly capabilities: readonly string[];
}

/**
 * Ordered group catalog. `observe` is the floor: without it the connection
 * cannot even list sessions, so the form keeps it on.
 */
export const TARGET_CAPABILITY_GROUPS: readonly TargetCapabilityGroup[] = [
  {
    id: "observe",
    label: "See sessions",
    impact: "Read session activity, the command catalog, and settings on that host.",
    capabilities: ["sessions.read", "catalog.read", "config.read", "audit.read"],
  },
  {
    id: "control",
    label: "Control sessions",
    impact: "Send prompts, steer agents, and cancel work on that host.",
    capabilities: ["sessions.prompt", "sessions.control", "sessions.manage", "agents.control"],
  },
  {
    id: "shell",
    label: "Open terminals",
    impact: "Open terminals on that host and run commands as its user.",
    capabilities: ["term.open", "term.input", "term.resize", "bash.run"],
  },
  {
    id: "files",
    label: "Work with project files",
    impact: "Read and change files inside project folders that host exposes.",
    capabilities: ["files.read", "files.list", "files.diff", "files.write"],
  },
  {
    id: "settings",
    label: "Change host settings",
    impact: "Edit that host's settings from this app.",
    capabilities: ["config.write"],
  },
  {
    id: "cluster",
    label: "Cluster sessions",
    impact: "Trigger CI and view or control isolated session GUIs on that host.",
    capabilities: ["ci.trigger", "preview.read", "preview.control", "preview.input"],
  },
];

const DEFAULT_TARGET_CAPABILITY_GROUPS = TARGET_CAPABILITY_GROUPS.filter(
  (group) => group.id !== "cluster",
);

/** Groups offered by the add-host form; cluster access is an explicit app opt-in. */
export function selectTargetCapabilityGroups(
  clusterOperatorEnabled?: boolean,
): readonly TargetCapabilityGroup[] {
  return clusterOperatorEnabled === true ? TARGET_CAPABILITY_GROUPS : DEFAULT_TARGET_CAPABILITY_GROUPS;
}

/** Wire capabilities for a set of chosen groups, in catalog order. */
export function capabilitiesForGroups(groups: ReadonlySet<TargetCapabilityGroupId>): readonly string[] {
  const out: string[] = [];
  for (const group of TARGET_CAPABILITY_GROUPS) {
    if (groups.has(group.id)) out.push(...group.capabilities);
  }
  return out;
}

export interface CapabilityDiff {
  /** Requested and granted. */
  readonly granted: readonly string[];
  /** Requested but not granted by the host. */
  readonly missing: readonly string[];
  /** Granted without being requested (host- or admin-added). */
  readonly extra: readonly string[];
}

export function capabilityDiff(
  requested: readonly string[],
  granted: readonly string[],
): CapabilityDiff {
  const requestedSet = new Set(requested);
  const grantedSet = new Set(granted);
  return {
    granted: requested.filter((capability) => grantedSet.has(capability)),
    missing: requested.filter((capability) => !grantedSet.has(capability)),
    extra: granted.filter((capability) => !requestedSet.has(capability)),
  };
}

// ─── Pair command ────────────────────────────────────────────────────────────

/** Read-only floor the command falls back to when no request survives. */
const OBSERVE_ONLY_CAPABILITIES = capabilitiesForGroups(new Set(["observe"]));

/** Every capability the catalog can name; the fence around the command. */
const CATALOG_CAPABILITY: Readonly<Record<string, true>> = Object.fromEntries(
  TARGET_CAPABILITY_GROUPS.flatMap((group) => group.capabilities.map((capability) => [capability, true] as const)),
);

export interface PairCommand {
  /** Exact shell command. Built only from code-owned catalog constants. */
  readonly command: string;
  /** Capabilities the command asks for, in catalog order. */
  readonly capabilities: readonly string[];
  /** True when no usable request existed and the read-only floor stood in. */
  readonly observeFallback: boolean;
}

/**
 * The host-side pair command for a target's requested capabilities. `omp
 * appserver pair` defaults to read-only, so each requested capability
 * becomes one `--capability` flag. Only catalog constants ever enter the
 * string — never an address, label, token, or pair code — so the command is
 * shell-safe by construction. Names outside the catalog are dropped, and if
 * nothing usable remains the command asks for the observe floor and reports
 * that through `observeFallback`.
 */
export function pairCommandForTarget(requested: readonly string[] | undefined): PairCommand {
  const usable = new Set((requested ?? []).filter((capability) => CATALOG_CAPABILITY[capability] === true));
  const observeFallback = usable.size === 0;
  const capabilities = observeFallback
    ? OBSERVE_ONLY_CAPABILITIES
    : TARGET_CAPABILITY_GROUPS.flatMap((group) => group.capabilities.filter((capability) => usable.has(capability)));
  return {
    command: ["omp appserver pair", ...capabilities.map((capability) => `--capability ${capability}`)].join(" "),
    capabilities,
    observeFallback,
  };
}

// ─── Pair code ──────────────────────────────────────────────────────────────

/** Exactly six digits, matching the desktop IPC contract. */
export const PAIR_CODE_PATTERN = /^\d{6}$/u;

export const PAIR_CODE_ERROR = "Enter the six digits exactly as the host shows them.";

// ─── Add-target validation (mirror of the desktop contract) ─────────────────

export type TargetMode = "direct" | "serve";

export interface TargetDraft {
  readonly label: string;
  readonly mode: TargetMode;
  /** Direct: Tailscale IP or MagicDNS name. Serve: HTTPS/WSS URL. */
  readonly address: string;
  readonly port: string;
  readonly expectedHostId: string;
  readonly groups: ReadonlySet<TargetCapabilityGroupId>;
}

export const EMPTY_TARGET_DRAFT: TargetDraft = {
  label: "",
  mode: "direct",
  address: "",
  port: "",
  expectedHostId: "",
  groups: new Set(["observe", "control", "shell", "files"]),
};

export type TargetDraftField = "label" | "address" | "port" | "expectedHostId";

export type TargetDraftResult =
  | { readonly ok: true; readonly target: TargetAddRequest["target"] }
  | { readonly ok: false; readonly errors: Partial<Record<TargetDraftField, string>> };

const MAGIC_DNS = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/iu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
const CONTROL_CHARS = /\p{Cc}/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** Tailscale CGNAT IPv4 (100.64/10) or Tailscale ULA IPv6 (fd7a:115c:a1e0::/48). */
function isTailscaleIp(value: string): boolean {
  const v4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
  if (v4 !== null) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return false;
    return octets[0] === 100 && (octets[1] ?? 0) >= 64 && (octets[1] ?? 0) <= 127;
  }
  return /^fd7a:115c:a1e0:/iu.test(value);
}

function directAddressError(address: string): string | null {
  const normalized = address.trim().toLowerCase();
  if (normalized.length === 0) return "Enter the host's Tailscale IP or name.";
  if (isTailscaleIp(normalized)) return null;
  if (MAGIC_DNS.test(normalized) && normalized.endsWith(".ts.net") && !normalized.endsWith(".local")) return null;
  return "Use the host's Tailscale IP (100.x) or its full tailnet name ending in .ts.net.";
}

function serveAddressError(address: string, port: number | null): string | null {
  if (address.trim().length === 0) return "Enter the host's HTTPS address.";
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return "Enter a full address, like https://host.tailnet.ts.net";
  }
  if (url.protocol !== "https:" && url.protocol !== "wss:") return "The address must start with https:// or wss://";
  if (url.username !== "" || url.password !== "") return "Take the account details out of the address.";
  if (url.search !== "" || url.hash !== "" || url.pathname !== "/") return "Use just the address — no path or extra parts.";
  if (directAddressError(url.hostname) !== null) return "The address must point at a tailnet name ending in .ts.net.";
  const authorityPort = url.port === "" ? 443 : Number(url.port);
  if (port !== null && authorityPort !== port) return "The port in the address doesn't match the port field.";
  return null;
}

/**
 * Pre-flight validation with the same rules the desktop main process
 * enforces, phrased for the form. Passing here does not skip the desktop
 * check — it only means the request will not bounce for a knowable reason.
 */
export function validateTargetDraft(draft: TargetDraft, existingIds: ReadonlySet<string>): TargetDraftResult {
  const errors: Partial<Record<TargetDraftField, string>> = {};

  const label = draft.label.trim();
  if (label.length === 0 || label.length > 128 || CONTROL_CHARS.test(label)) {
    errors.label = "Give this host a short name.";
  }

  const portText = draft.port.trim();
  const portNumber = portText.length === 0 ? (draft.mode === "serve" ? 443 : null) : Number(portText);
  if (portNumber === null || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    errors.port = "Enter a port between 1 and 65535.";
  }

  const addressError =
    draft.mode === "direct"
      ? directAddressError(draft.address)
      : serveAddressError(draft.address, errors.port === undefined ? portNumber : null);
  if (addressError !== null) errors.address = addressError;

  const expectedHostId = draft.expectedHostId.trim();
  if (expectedHostId.length > 0 && (expectedHostId.length > 256 || CONTROL_CHARS.test(expectedHostId))) {
    errors.expectedHostId = "That host ID doesn't look right.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[^a-z0-9]+/u, "")
    .slice(0, 100);
  let targetId = base.length === 0 ? "remote" : base;
  if (!OPAQUE_ID.test(targetId)) targetId = "remote";
  if (existingIds.has(targetId)) {
    let suffix = 2;
    while (existingIds.has(`${targetId}-${suffix}`)) suffix += 1;
    targetId = `${targetId}-${suffix}`;
  }

  const requestedCapabilities = capabilitiesForGroups(new Set([...draft.groups, "observe"]));
  return {
    ok: true,
    target: {
      targetId,
      label,
      mode: draft.mode,
      address: draft.mode === "direct" ? draft.address.trim().toLowerCase() : draft.address.trim(),
      port: portNumber as number,
      requestedCapabilities,
      grantedCapabilities: [],
      status: "unknown",
      ...(expectedHostId.length === 0 ? {} : { expectedHostId }),
    },
  };
}

// ─── Row derivation ─────────────────────────────────────────────────────────

export interface ConnectionStateMeta {
  readonly label: string;
  readonly tone: "success" | "working" | "error" | "warning" | "muted";
  readonly live: boolean;
}

export const CONNECTION_STATE_META: Record<ConnectionState, ConnectionStateMeta> = {
  connected: { label: "Connected", tone: "success", live: false },
  connecting: { label: "Connecting", tone: "working", live: true },
  disconnected: { label: "Disconnected", tone: "muted", live: false },
  "pairing-required": { label: "Needs pairing", tone: "warning", live: false },
  error: { label: "Connection problem", tone: "error", live: false },
};

export interface TargetRow {
  readonly target: DesktopTarget;
  readonly state: ConnectionState;
  /** Host bound to this target once a welcome arrived. */
  readonly hostId: string | null;
  /** Capabilities the host actually granted, once connected. */
  readonly grantedCapabilities: readonly string[] | null;
  /** Most recent runtime error attributed to this target, already redacted. */
  readonly lastError: string | null;
}

export function deriveTargetRows(snapshot: DesktopRuntimeSnapshot): readonly TargetRow[] {
  const rows: TargetRow[] = [];
  for (const target of snapshot.targets.values()) {
    const state = snapshot.connections.get(target.targetId) ?? target.state;
    const hostId = snapshot.targetHosts.get(target.targetId) ?? null;
    const host = hostId === null ? undefined : snapshot.hosts.get(hostId);
    let lastError: string | null = null;
    for (const entry of snapshot.runtimeErrors) {
      if (entry.targetId === target.targetId) lastError = entry.message;
    }
    rows.push({
      target,
      state,
      hostId,
      grantedCapabilities: host === undefined ? null : host.grantedCapabilities,
      lastError,
    });
  }
  // Local first, then remote targets by label.
  rows.sort((a, b) =>
    a.target.kind === b.target.kind
      ? a.target.label.localeCompare(b.target.label)
      : a.target.kind === "local"
        ? -1
        : 1,
  );
  return rows;
}
