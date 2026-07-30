import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeClientFrame } from "@t4-code/host-wire";
import { createT4ApiClient, type components, type T4ApiClient } from "@t4-code/t4-api-client";
import { describe, expect, it } from "vite-plus/test";

import {
  BrowserPreviewAuthority,
  createBrowserPreviewOperations,
  type CdpTargetTransport,
} from "../src/browser-preview-authority.ts";
import {
  CmuxWebSocketBridge,
  type CmuxJsonlByteStream,
} from "../src/cmux-websocket.ts";
import {
  decodeProviderRequestFrame,
  encodeProviderRequest,
} from "../../provider-engine/src/machine-provider-v1.ts";
import { authenticatedSshIdentity } from "../../ssh-gateway/src/identity.ts";
import {
  ompAppV1ProtocolProvider,
  type OmpClientMessage,
} from "../../client/src/index.ts";
import { T4ApiV1ConformanceService } from "../../client/test/t4-api-v1-conformance-service.ts";

type WorkspaceCreate = components["schemas"]["WorkspaceCreate"];
type RuntimeCreate = components["schemas"]["RuntimeCreate"];

const WORKSPACE_ID = "workspace-cross-client";
const RUNTIME_ID = "runtime-cross-client";
const HOST_ID = "host-cross-client";
const SESSION_ID = "session-cross-client";
const WORKSPACE_CREATE = {
  scopeId: "scope-a",
  displayName: "Cross-client workspace",
  capacityBytes: 1_073_741_824,
  retention: "Retain",
} as const satisfies WorkspaceCreate;
const RUNTIME_CREATE = {
  scopeId: "scope-a",
  workspaceId: WORKSPACE_ID,
  displayName: "Cross-client runtime",
  hostProfileId: "profile-portable-v1",
  desiredState: "Running",
  browserPolicy: "Allowed",
  idlePolicy: { enabled: true, idleSeconds: 300 },
} as const satisfies RuntimeCreate;
const CLIENT_FAMILIES = [
  { name: "desktop-web", platform: "darwin", origin: "https://desktop.conformance.test" },
  { name: "ios", platform: "ios", origin: "https://ios.conformance.test" },
  { name: "android-web", platform: "android", origin: "https://android.conformance.test" },
] as const;

function clientFor(service: T4ApiV1ConformanceService) {
  return createT4ApiClient({ baseUrl: service.origin, credential: "token-a", fetch: service.fetch });
}

function requireData<T>(result: { readonly data?: T; readonly error?: unknown }): T {
  expect(result.error).toBeUndefined();
  expect(result.data).toBeDefined();
  return result.data!;
}

function command(
  family: (typeof CLIENT_FAMILIES)[number],
  commandName: string,
  args: Readonly<Record<string, unknown>>,
): OmpClientMessage {
  return {
    kind: "command",
    requestId: `request-${family.name}-${commandName}`,
    commandId: `command-${family.name}-${commandName}`,
    hostId: HOST_ID,
    sessionId: SESSION_ID,
    command: commandName,
    ...(commandName === "transcript.page" ? {} : { expectedRevision: "opaque-session-revision" }),
    args,
  };
}

class DeterministicCdpTransport implements CdpTargetTransport {
  readonly calls: string[] = [];
  readonly generation = 1;
  #url = "https://example.test/start";

  onGenerationLoss(): () => void { return () => undefined; }
  async createTarget(url: string): Promise<string> { this.#url = url; return "cdp-target-one"; }
  async closeTarget(): Promise<void> { this.calls.push("Target.closeTarget"); }
  async activateTarget(): Promise<void> { this.calls.push("Target.activateTarget"); }
  async command<T extends Record<string, unknown> = Record<string, unknown>>(
    _targetId: string,
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<T> {
    this.calls.push(method);
    if (method === "Page.navigate" && typeof params?.url === "string") this.#url = params.url;
    if (method === "Runtime.evaluate") {
      const value = params?.expression === "location.href" ? this.#url : params?.expression === "document.title" ? "Portable client" : true;
      return { result: { value } } as unknown as T;
    }
    if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{ id: 1, url: this.#url }] } as unknown as T;
    if (method === "Page.captureScreenshot") return { data: Buffer.from("deterministic-png").toString("base64") } as unknown as T;
    return {} as T;
  }
  async close(): Promise<void> { return; }
}

function normalizeRoutes(routes: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] {
  return routes.map(route => {
    if (route.kind === "machine-provider-ssh") {
      return { kind: route.kind, providerVersion: route.providerVersion, port: route.port, user: route.user };
    }
    const url = new URL(String(route.url));
    return { kind: route.kind, protocol: route.protocol, path: url.pathname };
  });
}

describe("Portable Agent Platform integrated client-family conformance", () => {
  it("keeps every advertised client and route on one portable authority contract", async () => {
    const routeSemantics: Array<readonly Record<string, unknown>[]> = [];
    const stableRuntimeIds = new Set<string>();
    const stableWorkspaceIds = new Set<string>();
    const profiles: Array<{ readonly service: T4ApiV1ConformanceService; readonly client: T4ApiClient; readonly runtimeEtag: string }> = [];

    for (const [index, family] of CLIENT_FAMILIES.entries()) {
      const service = new T4ApiV1ConformanceService({ origin: family.origin, eventStream: index === 0 ? "reconnect" : "normal" });
      const client = clientFor(service);
      const discovery = requireData(await client.http.GET("/.well-known/omperator"));
      const capabilities = requireData(await client.http.GET("/v1/capabilities"));
      expect(discovery).toMatchObject({
        restBaseUrl: `${family.origin}/v1`,
        ompAppWebSocketUrl: `wss://${new URL(family.origin).host}/v1/ws`,
        protocols: { application: ["omp-app/1"], cmux: [10], machineProvider: ["machine-provider-v1"] },
      });
      expect(capabilities).toMatchObject({
        features: { browser: true, directCmuxWebSocket: true, restLifecycle: true, scaleToZero: true, sshProvider: true },
        protocols: { machineProvider: { versions: [1] }, ompApp: { versions: [1] }, cmux: { versions: [10] } },
      });

      const workspaceResult = await client.http.PUT("/v1/workspaces/{workspaceId}", {
        params: { path: { workspaceId: WORKSPACE_ID }, header: { "If-None-Match": "*" } },
        body: WORKSPACE_CREATE,
      });
      const workspace = requireData(workspaceResult);
      const runtimeResult = await client.http.PUT("/v1/runtimes/{runtimeId}", {
        params: { path: { runtimeId: RUNTIME_ID }, header: { "If-None-Match": "*" } },
        body: RUNTIME_CREATE,
      });
      const runtime = requireData(runtimeResult);
      const connectionResult = await client.http.GET("/v1/runtimes/{runtimeId}/connections", {
        params: { path: { runtimeId: RUNTIME_ID } },
      });
      const descriptor = requireData(connectionResult);

      stableWorkspaceIds.add(workspace.id);
      stableRuntimeIds.add(runtime.id);
      expect(descriptor.runtimeId).toBe(runtime.id);
      expect(descriptor.generation).toBe(runtime.generation);
      expect(runtime.revision).toMatch(/^rev:[a-z0-9]+$/u);
      expect(connectionResult.response.headers.get("ETag")).toBe(`"${runtime.revision}"`);
      expect(descriptor.routes.map(route => route.kind)).toEqual(["machine-provider-ssh", "omp-app-websocket", "cmux-websocket"]);
      routeSemantics.push(normalizeRoutes(descriptor.routes));

      const hello = ompAppV1ProtocolProvider.encodeClientMessage({
        kind: "hello",
        client: { name: family.name, version: "1", build: "conformance", platform: family.platform },
        requestedFeatures: ["resume", "transcript.page", "preview.control"],
        savedCursors: [{ hostId: HOST_ID, sessionId: SESSION_ID, cursor: { epoch: "durable-epoch", seq: 41 } }],
        capabilities: ["sessions.read", "sessions.prompt", "term.open", "term.input", "term.resize", "preview.read", "preview.control"],
      });
      const frames = [
        decodeClientFrame(JSON.parse(hello) as unknown),
        decodeClientFrame(JSON.parse(ompAppV1ProtocolProvider.encodeClientMessage(command(family, "session.prompt", { message: "portable prompt" }))) as unknown),
        decodeClientFrame(JSON.parse(ompAppV1ProtocolProvider.encodeClientMessage(command(family, "transcript.page", { before: "opaque-page-cursor", limit: 64, maxBytes: 262_144 }))) as unknown),
        decodeClientFrame(JSON.parse(ompAppV1ProtocolProvider.encodeClientMessage(command(family, "preview.navigate", { previewId: "preview-one", url: "https://example.test/next" }))) as unknown),
        decodeClientFrame(JSON.parse(ompAppV1ProtocolProvider.encodeClientMessage({ kind: "terminal-input", hostId: HOST_ID, sessionId: SESSION_ID, terminalId: "terminal-one", data: "pwd\n" })) as unknown),
      ];
      expect(frames.map(frame => frame.v)).toEqual(Array(frames.length).fill("omp-app/1"));
      expect(new Set(frames.flatMap(frame => "hostId" in frame ? [String(frame.hostId)] : []))).toEqual(new Set([HOST_ID]));
      expect(new Set(frames.flatMap(frame => "sessionId" in frame ? [String(frame.sessionId)] : []))).toEqual(new Set([SESSION_ID]));

      profiles.push({ service, client, runtimeEtag: runtimeResult.response.headers.get("ETag")! });
    }

    expect(stableWorkspaceIds).toEqual(new Set([WORKSPACE_ID]));
    expect(stableRuntimeIds).toEqual(new Set([RUNTIME_ID]));
    expect(routeSemantics[1]).toEqual(routeSemantics[0]);
    expect(routeSemantics[2]).toEqual(routeSemantics[0]);
    expect(routeSemantics[0]).toEqual([
      { kind: "machine-provider-ssh", providerVersion: 1, port: 22, user: "agent" },
      { kind: "omp-app-websocket", protocol: "omp-app/1", path: "/v1/ws" },
      { kind: "cmux-websocket", protocol: 10, path: `/v1/cmux/${RUNTIME_ID}` },
    ]);

    const primary = profiles[0];
    if (!primary) throw new Error("primary conformance profile was not created");
    const reconnectedEvents = [];
    for await (const event of primary.client.watchEvents({ scopeId: "scope-a", maxEvents: 2, retryBackoffMs: 0 })) reconnectedEvents.push(event);
    expect(reconnectedEvents.map(event => event.event === "invalidation" ? event.resourceId : event.reason)).toEqual([WORKSPACE_ID, RUNTIME_ID]);
    expect(primary.service.watchCursors).toEqual([
      { scopeId: "scope-a", lastEventId: null },
      { scopeId: "scope-a", lastEventId: reconnectedEvents[0]!.eventId },
    ]);

    const slept = await primary.client.http.POST("/v1/runtimes/{runtimeId}:sleep", {
      params: { path: { runtimeId: RUNTIME_ID }, header: { "If-Match": primary.runtimeEtag, "Idempotency-Key": "sleep-cross-client-0001" } },
    });
    expect(requireData(slept)).toMatchObject({ id: RUNTIME_ID, desiredState: "Sleeping", phase: "Sleeping" });
    const woke = await primary.client.http.POST("/v1/runtimes/{runtimeId}:wake", {
      params: { path: { runtimeId: RUNTIME_ID }, header: { "If-Match": slept.response.headers.get("ETag")!, "Idempotency-Key": "wake-cross-client-00001" } },
    });
    expect(requireData(woke)).toMatchObject({ id: RUNTIME_ID, desiredState: "Running", phase: "Ready" });

    const providerHello = encodeProviderRequest({
      protocol: "cmux.machine-provider",
      version: 1,
      id: "provider-hello",
      method: "hello",
      params: { token: "opaque-provider-credential", client: { name: "cmux", version: "10", supported_versions: [1] } },
    });
    const decodedProviderHello = decodeProviderRequestFrame(providerHello.subarray(0, providerHello.byteLength - 1));
    expect(decodedProviderHello).toMatchObject({ protocol: "cmux.machine-provider", version: 1, method: "hello" });

    const cmuxWrites: Uint8Array[] = [];
    const cmuxStream: CmuxJsonlByteStream = {
      readable: { async *[Symbol.asyncIterator]() { yield* []; } },
      async write(value) { cmuxWrites.push(value); },
      async end() { return; },
      async close() { return; },
    };
    const cmuxCloses: Array<[number, string]> = [];
    const cmuxBridge = new CmuxWebSocketBridge(cmuxStream, {
      sendText: () => 0,
      close: (code, reason) => { cmuxCloses.push([code, reason]); },
    }, new AbortController());
    const cmuxIdentify = '{"type":"identify","protocol":10,"runtimeId":"runtime-cross-client"}';
    cmuxBridge.receiveText(cmuxIdentify);
    await Promise.resolve();
    await Promise.resolve();
    expect(new TextDecoder().decode(cmuxWrites[0])).toBe(`${cmuxIdentify}\n`);
    expect(cmuxCloses).toEqual([]);
    await cmuxBridge.clientClosed();

    const sshRoot = await mkdtemp(join(tmpdir(), "portable-client-ssh-"));
    try {
      const authInfo = join(sshRoot, "auth-info");
      await writeFile(authInfo, "publickey ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGQ2YjM0NzI4OWQ2YjM0NzI4OWQ2YjM0NzI4OWQ2YjM0NzI4\n", { mode: 0o600 });
      await chmod(authInfo, 0o600);
      const sshIdentity = await authenticatedSshIdentity(authInfo);
      expect(sshIdentity).toMatchObject({ adapter: { id: "openssh-expose-auth-info", type: "ssh" }, policyRevision: "ssh-expose-auth-info-v1" });
      expect(sshIdentity.principalId).toMatch(/^id_[A-Za-z0-9_-]{43}$/u);
    } finally {
      await rm(sshRoot, { recursive: true, force: true });
    }

    const cdp = new DeterministicCdpTransport();
    const browserAuthority = new BrowserPreviewAuthority({
      hostId: HOST_ID as never,
      sessionId: SESSION_ID as never,
      workspaceRoot: tmpdir(),
      transport: cdp,
      epoch: "preview-conformance-epoch",
      now: () => 1_800_000_000_000,
    });
    const browserContext = {
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      deviceId: "device-cross-client",
      connectionId: "connection-cross-client",
      capabilities: new Set(["preview.read", "preview.control", "preview.input"]),
      abortSignal: new AbortController().signal,
    } as never;
    const browser = browserAuthority.operations();
    const launched = await browser.previewLaunch!({ url: "https://example.test/start" }, browserContext);
    if (launched.preview === null || typeof launched.preview !== "object" || !("previewId" in launched.preview) || typeof launched.preview.previewId !== "string") {
      throw new Error("browser authority returned an invalid preview");
    }
    const previewId = launched.preview.previewId;
    const navigated = await browser.previewNavigate!({ previewId, url: "https://example.test/next" }, browserContext);
    expect(navigated.preview).toMatchObject({ previewId, url: "https://example.test/next", authority: { id: "cluster-session-browser" } });
    await browserAuthority.close();

    const unavailableBrowser = createBrowserPreviewOperations(
      { mode: "disabled" },
      { hostId: HOST_ID as never, sessionId: SESSION_ID as never, workspaceRoot: tmpdir(), transport: new DeterministicCdpTransport() },
    );
    expect(unavailableBrowser.authority).toBeUndefined();
    expect(unavailableBrowser.operations.previewLaunch).toBeUndefined();

    const reduced = new T4ApiV1ConformanceService({
      origin: "https://reduced.conformance.test",
      features: { browser: false, directCmuxWebSocket: false, sshProvider: false },
    });
    const reducedClient = clientFor(reduced);
    await reducedClient.http.PUT("/v1/workspaces/{workspaceId}", {
      params: { path: { workspaceId: WORKSPACE_ID }, header: { "If-None-Match": "*" } }, body: WORKSPACE_CREATE,
    });
    const reducedRuntime = requireData(await reducedClient.http.PUT("/v1/runtimes/{runtimeId}", {
      params: { path: { runtimeId: RUNTIME_ID }, header: { "If-None-Match": "*" } },
      body: { ...RUNTIME_CREATE, browserPolicy: "Disabled" },
    }));
    const reducedDiscovery = requireData(await reducedClient.http.GET("/.well-known/omperator"));
    const reducedConnections = requireData(await reducedClient.http.GET("/v1/runtimes/{runtimeId}/connections", { params: { path: { runtimeId: RUNTIME_ID } } }));
    expect(reducedRuntime.capabilities).toEqual(["terminal"]);
    expect(reducedDiscovery).not.toHaveProperty("cmuxWebSocketTemplate");
    expect(reducedDiscovery).not.toHaveProperty("ssh");
    expect(reducedConnections.routes).toEqual([{ kind: "omp-app-websocket", protocol: "omp-app/1", url: "wss://reduced.conformance.test/v1/ws" }]);
    expect(ompAppV1ProtocolProvider.requiredCapability("session.prompt")).toBe("sessions.prompt");
    expect(new Set(["sessions.read"]).has(ompAppV1ProtocolProvider.requiredCapability("session.prompt")!)).toBe(false);

    for (const profile of profiles) {
      const runtime = await profile.client.http.GET("/v1/runtimes/{runtimeId}", { params: { path: { runtimeId: RUNTIME_ID } } });
      const runtimeDelete = await profile.client.http.DELETE("/v1/runtimes/{runtimeId}", {
        params: { path: { runtimeId: RUNTIME_ID }, header: { "If-Match": runtime.response.headers.get("ETag")! } },
      });
      const workspace = await profile.client.http.GET("/v1/workspaces/{workspaceId}", { params: { path: { workspaceId: WORKSPACE_ID } } });
      const workspaceDelete = await profile.client.http.DELETE("/v1/workspaces/{workspaceId}", {
        params: { path: { workspaceId: WORKSPACE_ID }, header: { "If-Match": workspace.response.headers.get("ETag")! } },
      });
      expect([runtimeDelete.response.status, workspaceDelete.response.status]).toEqual([204, 204]);
    }
  });
});
