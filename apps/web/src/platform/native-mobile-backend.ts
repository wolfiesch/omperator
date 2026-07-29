export const MOBILE_BACKEND_STORAGE_KEY = "t4-code:mobile-backends:v3";
export const DEFAULT_MOBILE_PROFILE_ID = "default";

const MAX_URL_LENGTH = 2048;
const MAX_LABEL_LENGTH = 128;
const MAX_PROFILE_ID_LENGTH = 64;

export interface StoredMobileBackend {
  readonly version: 3;
  readonly endpointKey: string;
  readonly origin: string;
  readonly profileId: string;
  readonly wsUrl: string;
  readonly label: string;
  readonly clusterOperatorEnabled?: true;
}

export interface StoredMobileBackendDirectory {
  readonly version: 3;
  readonly activeEndpointKey: string;
  readonly backends: readonly StoredMobileBackend[];
}

function requiredLabel(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LABEL_LENGTH) {
    throw new Error("The saved host label is invalid.");
  }
  return value;
}

export function normalizeMobileProfileId(value?: string): string {
  if (value === undefined) return DEFAULT_MOBILE_PROFILE_ID;
  const trimmed = value.trim();
  if (trimmed === "") return DEFAULT_MOBILE_PROFILE_ID;
  if (
    trimmed.length > MAX_PROFILE_ID_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(trimmed)
  ) {
    throw new Error("Use a profile ID made of ASCII letters, numbers, dot, dash, or underscore.");
  }
  return trimmed;
}

function endpointKeyFor(origin: string, profileId: string): string {
  return `${origin}#profile=${profileId}`;
}

function websocketUrlFor(origin: string, profileId: string): string {
  const websocket = new URL(origin);
  websocket.protocol = "wss:";
  websocket.pathname =
    profileId === DEFAULT_MOBILE_PROFILE_ID
      ? "/v1/ws"
      : `/v1/profiles/${encodeURIComponent(profileId)}/ws`;
  return websocket.toString();
}

export function parseTailnetBackend(
  value: string,
  profileId?: string,
  clusterOperatorEnabled = false,
): StoredMobileBackend {
  const trimmed = value.trim();
  if (trimmed.length === 0)
    throw new Error("Enter the HTTPS address shown by T4 Code on your computer.");
  if (trimmed.length > MAX_URL_LENGTH) throw new Error("That address is too long.");
  const selectedProfile = normalizeMobileProfileId(profileId);
  if (clusterOperatorEnabled && selectedProfile !== DEFAULT_MOBILE_PROFILE_ID) {
    throw new Error("The cluster operator uses the default secure WSS route.");
  }
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Enter a valid HTTPS Tailnet address.");
  }
  if (parsed.protocol !== "https:") throw new Error("Use the HTTPS Tailnet address, not HTTP.");
  if (parsed.username !== "" || parsed.password !== "")
    throw new Error("The address cannot contain credentials.");
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("Enter the host address only, without a path, query, or fragment.");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "ts.net" || !hostname.endsWith(".ts.net")) {
    throw new Error("Use the full Tailscale hostname ending in .ts.net.");
  }
  if (clusterOperatorEnabled && parsed.port !== "") {
    throw new Error("The cluster operator requires the standard secure WSS route, not a NodePort.");
  }
  const origin = parsed.origin;
  return {
    version: 3,
    endpointKey: endpointKeyFor(origin, selectedProfile),
    origin,
    profileId: selectedProfile,
    wsUrl: websocketUrlFor(origin, selectedProfile),
    label: requiredLabel(`T4 on ${hostname.slice(0, hostname.indexOf("."))}`),
    ...(clusterOperatorEnabled ? { clusterOperatorEnabled: true as const } : {}),
  };
}
