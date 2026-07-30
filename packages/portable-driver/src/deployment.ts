export type PortableDeploymentMode = "local" | "single-host" | "kubernetes";

export interface PortableHighAvailabilityStatus {
  readonly gateway: boolean;
  readonly runtime: boolean;
}

export interface PortableDeploymentStatus {
  readonly mode: PortableDeploymentMode;
  readonly highAvailability: PortableHighAvailabilityStatus;
  /** OMP remains the sole writable authority regardless of deployment topology. */
  readonly writableOmpAuthoritiesPerRuntime: 1;
}

export interface PortableFrontDoorEndpoints {
  readonly restBaseUrl: string;
  readonly providerWebSocketUrl: string;
  readonly cmuxWebSocketTemplate: string;
  readonly ompAppWebSocketUrl: string;
}

export interface PortableProfileIdentity {
  readonly kind: "local-peer" | "bearer";
  readonly principalId: string;
}

export interface PortableClientProfile {
  readonly profileId: string;
  readonly endpoints: PortableFrontDoorEndpoints;
  readonly identity: PortableProfileIdentity;
  readonly protocols: {
    readonly machineProvider: readonly [1];
    readonly cmux: readonly [10];
    readonly ompApp: readonly [1];
  };
  readonly resources: {
    readonly scopes: "/v1/scopes";
    readonly workspaces: "/v1/workspaces";
    readonly runtimes: "/v1/runtimes";
    readonly events: "/v1/events";
  };
}

const PROTOCOLS = Object.freeze({
  machineProvider: Object.freeze([1] as const),
  cmux: Object.freeze([10] as const),
  ompApp: Object.freeze([1] as const),
});
const RESOURCES = Object.freeze({
  scopes: "/v1/scopes" as const,
  workspaces: "/v1/workspaces" as const,
  runtimes: "/v1/runtimes" as const,
  events: "/v1/events" as const,
});

function bounded(value: string, name: string, maximum = 2048): string {
  if (value.length < 1 || value.length > maximum || value.includes("\r") || value.includes("\n") || value.includes("\0")) throw new TypeError(`${name} is invalid`);
  return value;
}

function endpoint(value: string, name: string, protocols: readonly string[]): string {
  bounded(value, name);
  const parsed = new URL(value);
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  const plaintext = parsed.protocol === "http:" || parsed.protocol === "ws:";
  if (!protocols.includes(parsed.protocol) || plaintext && !loopback || parsed.username || parsed.password || parsed.search || parsed.hash) throw new TypeError(`${name} is invalid`);
  return value;
}

export function portableDeploymentStatus(
  mode: PortableDeploymentMode,
  highAvailability: Partial<PortableHighAvailabilityStatus> = {},
): PortableDeploymentStatus {
  if (mode !== "local" && mode !== "single-host" && mode !== "kubernetes") throw new TypeError("deployment mode is invalid");
  if (mode !== "kubernetes" && (highAvailability.gateway === true || highAvailability.runtime === true))
    throw new TypeError("local and single-host deployments cannot advertise high availability");
  return Object.freeze({
    mode,
    highAvailability: Object.freeze({ gateway: highAvailability.gateway === true, runtime: highAvailability.runtime === true }),
    writableOmpAuthoritiesPerRuntime: 1,
  });
}

export function createPortableClientProfile(input: {
  readonly profileId: string;
  readonly endpoints: PortableFrontDoorEndpoints;
  readonly identity: PortableProfileIdentity;
}): PortableClientProfile {
  const endpoints = Object.freeze({
    restBaseUrl: endpoint(input.endpoints.restBaseUrl, "REST base URL", ["http:", "https:"]),
    providerWebSocketUrl: endpoint(input.endpoints.providerWebSocketUrl, "provider WebSocket URL", ["ws:", "wss:"]),
    cmuxWebSocketTemplate: endpoint(input.endpoints.cmuxWebSocketTemplate, "cmux WebSocket template", ["ws:", "wss:"]),
    ompAppWebSocketUrl: endpoint(input.endpoints.ompAppWebSocketUrl, "omp-app WebSocket URL", ["ws:", "wss:"]),
  });
  if (!endpoints.cmuxWebSocketTemplate.includes("{runtimeId}")) throw new TypeError("cmux WebSocket template must contain {runtimeId}");
  if (input.identity.kind !== "local-peer" && input.identity.kind !== "bearer") throw new TypeError("profile identity kind is invalid");
  return Object.freeze({
    profileId: bounded(input.profileId, "profile id", 128),
    endpoints,
    identity: Object.freeze({
      kind: input.identity.kind,
      principalId: bounded(input.identity.principalId, "principal id", 256),
    }),
    protocols: PROTOCOLS,
    resources: RESOURCES,
  });
}

/** Throws when two host profiles differ in any portable semantic descriptor. */
export function assertEndpointOnlyProfileDifference(left: PortableClientProfile, right: PortableClientProfile): void {
  if (JSON.stringify(left.protocols) !== JSON.stringify(right.protocols) || JSON.stringify(left.resources) !== JSON.stringify(right.resources))
    throw new TypeError("portable host profiles differ outside endpoints and identity");
}
