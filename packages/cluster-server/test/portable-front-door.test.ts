import { describe, expect, test } from "vite-plus/test";
import { createLocalAndSingleHostProfiles, portableRestApiConfig } from "../src/portable-front-door.ts";
import { ClusterInfrastructureProjection } from "../src/kubernetes-projection.ts";
import { createClusterRestHandler } from "../src/rest-handler.ts";

const build = { version: "0.2.1", revision: "portable-v1", builtAt: "2026-07-30T00:00:00.000Z" } as const;

describe("local and single-host front-door composition", () => {
  test("preserves REST/provider/cmux/omp-app descriptors with endpoint-only profile differences", () => {
    const profiles = createLocalAndSingleHostProfiles({
      localPrincipalId: "local-user",
      remotePrincipalId: "remote-user",
      localEndpoints: {
        restBaseUrl: "http://127.0.0.1:8787/v1",
        providerWebSocketUrl: "ws://127.0.0.1:8787/v1/provider/control",
        cmuxWebSocketTemplate: "ws://127.0.0.1:8787/v1/cmux/{runtimeId}",
        ompAppWebSocketUrl: "ws://127.0.0.1:8787/v1/ws",
      },
      singleHostEndpoints: {
        restBaseUrl: "https://host.example.test/v1",
        providerWebSocketUrl: "wss://host.example.test/v1/provider/control",
        cmuxWebSocketTemplate: "wss://host.example.test/v1/cmux/{runtimeId}",
        ompAppWebSocketUrl: "wss://host.example.test/v1/ws",
      },
    });

    expect(profiles.local.protocols).toEqual(profiles.singleHost.protocols);
    expect(profiles.local.resources).toEqual(profiles.singleHost.resources);
    const local = portableRestApiConfig(profiles.local, build);
    const remote = portableRestApiConfig(profiles.singleHost, build);
    expect(Object.keys(local).sort()).toEqual(Object.keys(remote).sort());
    expect(local.build).toEqual(remote.build);
    expect(local.deployment).toEqual({ mode: "local", highAvailability: { gateway: false, runtime: false }, writableOmpAuthoritiesPerRuntime: 1 });
    expect(remote.deployment).toEqual({ mode: "single-host", highAvailability: { gateway: false, runtime: false }, writableOmpAuthoritiesPerRuntime: 1 });
  });

  test("serves the composed descriptors through the shared REST front door", async () => {
    const profiles = createLocalAndSingleHostProfiles({
      localPrincipalId: "local-user",
      remotePrincipalId: "remote-user",
      localEndpoints: {
        restBaseUrl: "http://127.0.0.1:8787/v1",
        providerWebSocketUrl: "ws://127.0.0.1:8787/v1/provider/control",
        cmuxWebSocketTemplate: "ws://127.0.0.1:8787/v1/cmux/{runtimeId}",
        ompAppWebSocketUrl: "ws://127.0.0.1:8787/v1/ws",
      },
      singleHostEndpoints: {
        restBaseUrl: "https://host.example.test/v1",
        providerWebSocketUrl: "wss://host.example.test/v1/provider/control",
        cmuxWebSocketTemplate: "wss://host.example.test/v1/cmux/{runtimeId}",
        ompAppWebSocketUrl: "wss://host.example.test/v1/ws",
      },
    });
    const projection = new ClusterInfrastructureProjection({ epoch: "portable", namespace: "single-host" });
    const discover = async (profile: typeof profiles.local) => {
      const handler = createClusterRestHandler({ projection, config: portableRestApiConfig(profile, build), directCmuxWebSocket: true });
      const response = await handler(new Request("https://untrusted.invalid/.well-known/omperator"));
      return await response.json() as Record<string, unknown>;
    };

    const local = await discover(profiles.local);
    const remote = await discover(profiles.singleHost);
    expect(Object.keys(local).sort()).toEqual(Object.keys(remote).sort());
    expect(local).toMatchObject({
      service: "omperator",
      providerWebSocketUrl: profiles.local.endpoints.providerWebSocketUrl,
      cmuxWebSocketTemplate: profiles.local.endpoints.cmuxWebSocketTemplate,
      ompAppWebSocketUrl: profiles.local.endpoints.ompAppWebSocketUrl,
      deployment: { mode: "local", highAvailability: { gateway: false, runtime: false }, writableOmpAuthoritiesPerRuntime: 1 },
    });
    expect(remote).toMatchObject({
      providerWebSocketUrl: profiles.singleHost.endpoints.providerWebSocketUrl,
      deployment: { mode: "single-host", highAvailability: { gateway: false, runtime: false }, writableOmpAuthoritiesPerRuntime: 1 },
    });
  });
});
