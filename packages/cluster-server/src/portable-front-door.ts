import {
  assertEndpointOnlyProfileDifference,
  createPortableClientProfile,
  portableDeploymentStatus,
  type PortableClientProfile,
  type PortableFrontDoorEndpoints,
} from "@t4-code/portable-driver";
import type { ClusterRestApiConfig } from "./rest-handler.ts";

export interface PortableFrontDoorBuild {
  readonly version: string;
  readonly revision: string;
  readonly builtAt: string;
}

export interface LocalAndSingleHostProfiles {
  readonly local: PortableClientProfile;
  readonly singleHost: PortableClientProfile;
}

export function createLocalAndSingleHostProfiles(input: {
  readonly localEndpoints: PortableFrontDoorEndpoints;
  readonly singleHostEndpoints: PortableFrontDoorEndpoints;
  readonly localPrincipalId: string;
  readonly remotePrincipalId: string;
}): LocalAndSingleHostProfiles {
  const local = createPortableClientProfile({
    profileId: "local",
    endpoints: input.localEndpoints,
    identity: { kind: "local-peer", principalId: input.localPrincipalId },
  });
  const singleHost = createPortableClientProfile({
    profileId: "single-host",
    endpoints: input.singleHostEndpoints,
    identity: { kind: "bearer", principalId: input.remotePrincipalId },
  });
  assertEndpointOnlyProfileDifference(local, singleHost);
  return Object.freeze({ local, singleHost });
}

/** Uses the same REST/provider/cmux/omp-app descriptor shape for either host. */
export function portableRestApiConfig(
  profile: PortableClientProfile,
  build: PortableFrontDoorBuild,
): ClusterRestApiConfig {
  return Object.freeze({
    restBaseUrl: profile.endpoints.restBaseUrl,
    providerWebSocketUrl: profile.endpoints.providerWebSocketUrl,
    cmuxWebSocketTemplate: profile.endpoints.cmuxWebSocketTemplate,
    ompAppWebSocketUrl: profile.endpoints.ompAppWebSocketUrl,
    build: Object.freeze({ ...build }),
    deployment: portableDeploymentStatus(profile.identity.kind === "local-peer" ? "local" : "single-host"),
  });
}
