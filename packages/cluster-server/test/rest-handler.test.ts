import { describe, expect, it, vi } from "vite-plus/test";
import { hostId, projectId, revision, sessionId, type SessionRef } from "@t4-code/host-wire";
import { ClusterInfrastructureProjection, type KubernetesResource } from "../src/kubernetes-projection.ts";
import { createClusterRestHandler } from "../src/rest-handler.ts";
import { RestMutationError, type RestMutationResult } from "../src/kubernetes-client.ts";
import type { ClusterRestHandlerOptions } from "../src/rest-handler.ts";
import { requestIdentityScopeId, type RequestIdentity, type ScopeGrant } from "../src/identity.ts";
import { ScopeAdmissionError } from "../src/scope-admission.ts";

const OWNER = "owner@example.test";
const OTHER = "other@example.test";
const config = {
	restBaseUrl: "https://public.example.test/v1",
	ompAppWebSocketUrl: "wss://public.example.test/v1/ws",
	build: { version: "0.1.33", revision: "0123456789abcdef", builtAt: "2026-07-29T12:00:00.000Z" },
} as const;
function identity(principalId: string, grants: readonly ScopeGrant[] = []): RequestIdentity {
	return Object.freeze({
		principalId,
		authorizedScopes: Object.freeze(grants.map(grant => Object.freeze({ scopeId: grant.scopeId, roles: Object.freeze([...(grant.roles ?? [])]) }))),
		adapter: Object.freeze({ id: "test", type: "tailscale" }),
		policyRevision: "test-1",
	});
}
function withPrincipal(handler: (request: Request, identity?: RequestIdentity) => Response | Promise<Response>) {
	return (request: Request, principal?: string) => handler(request, principal ? identity(principal) : undefined);
}
const host: KubernetesResource = {
	apiVersion: "cluster.t4.dev/v1alpha1",
	kind: "T4ClusterHost",
	metadata: { name: "primary", uid: "host-uid", resourceVersion: "900" },
	spec: {},
};
function workspace(name: string, owner: string, phase: string, resourceVersion: string): KubernetesResource {
	return {
		apiVersion: "cluster.t4.dev/v1alpha1",
		kind: "T4Workspace",
		metadata: { name, uid: `${name}-uid`, resourceVersion, generation: 2, creationTimestamp: "2026-07-29T10:00:00Z" },
		spec: { hostRef: "primary", owner, displayName: `Workspace ${name.at(-1)?.toUpperCase() ?? "Unknown"}`, retentionPolicy: "Retain", size: "2Gi", credentialPath: "/private/token" },
		status: {
			phase,
			capacity: "2Gi",
			pvcRef: `internal-${name}`,
			conditions: [{ type: "StorageReady", status: phase === "Ready" ? "True" : "False", reason: "Reconciled", message: `internal-service.${name}.svc`, lastTransitionTime: "2026-07-29T10:05:00Z" }],
		},
	};
}
function runtime(name: string, workspaceRef: string, phase: string, resourceVersion: string): KubernetesResource {
	return {
		apiVersion: "cluster.t4.dev/v1alpha1",
		kind: "T4Session",
		metadata: { name, uid: `${name}-uid`, resourceVersion, generation: 4, creationTimestamp: "2026-07-29T10:10:00Z" },
		spec: { hostRef: "primary", workspaceRef, title: `Runtime ${name.at(-1)?.toUpperCase() ?? "Unknown"}`, runtimeProfile: "default", guiEnabled: true, token: "never-return-this" },
		status: {
			runtimeGeneration: `gen_${name.replaceAll("-", "_")}`,
			phase: phase === "Running" ? "Ready" : phase,
			podName: `${name}-pod-private`,
			serviceName: `${name}-service-private`,
			conditions: [
				{ type: "Available", status: phase === "Running" ? "True" : "False", reason: "Reconciled", message: `${name}-pod-private`, observedGeneration: 4, lastTransitionTime: "2026-07-29T10:15:00Z" },
				{ type: "RouteReady", status: phase === "Running" ? "True" : "False", reason: "Reconciled", message: "route gate", observedGeneration: 4, lastTransitionTime: "2026-07-29T10:15:00Z" },
			],
		},
	};
}
function authority(value: string): SessionRef {
	return {
		hostId: hostId("private-pod-host"),
		sessionId: sessionId(value),
		project: { projectId: projectId("private-project"), name: "Private project" },
		revision: revision("private-upstream-revision"),
		title: "Private authority",
		status: "idle",
		updatedAt: "2026-07-29T10:15:00.000Z",
	};
}
function fixture(directCmuxWebSocket = false) {
	const projection = new ClusterInfrastructureProjection({ epoch: "replica-1", namespace: "private-namespace" });
	const selectedConfig = directCmuxWebSocket
		? { ...config, cmuxWebSocketTemplate: "wss://public.example.test/v1/cmux/{runtimeId}" }
		: config;
	projection.replace({
		host,
		workspaces: [
			workspace("workspace-a", OWNER, "Ready", "901"),
			workspace("workspace-b", OWNER, "Pending", "902"),
			workspace("workspace-foreign", OTHER, "Ready", "903"),
		],
		sessions: [
			runtime("runtime-a", "workspace-a", "Running", "904"),
			runtime("runtime-b", "workspace-b", "Pending", "905"),
			runtime("runtime-foreign", "workspace-foreign", "Running", "906"),
		],
		resourceVersion: "906",
	});
	projection.setSessionAuthority("runtime-a", authority("upstream-private"));
	projection.setSessionAuthority("runtime-foreign", authority("foreign-upstream-private"));
	return {
		projection,
		handle: withPrincipal(createClusterRestHandler({
			projection,
			config: selectedConfig,
			directCmuxWebSocket,
			now: () => new Date("2026-07-29T12:00:00Z"),
		})),
	};
}
async function body(response: Response | Promise<Response>): Promise<Record<string, unknown>> {
	return await (await response).json() as Record<string, unknown>;
}
function get(path: string): Request {
	return new Request(`https://attacker-controlled.invalid${path}`);
}

describe("cluster read-only REST gateway", () => {
	it("serves only discovery without authentication and never infers its public identity from Host", async () => {
		const { handle } = fixture();
		const discovery = await handle(get("/.well-known/omperator"));
		expect(discovery.status).toBe(200);
		expect(discovery.headers.get("cache-control")).toBe("no-store");
		expect(await body(discovery)).toEqual({
			service: "omperator",
			apiVersion: "v1",
			restBaseUrl: config.restBaseUrl,
			ompAppWebSocketUrl: config.ompAppWebSocketUrl,
			protocols: { machineProvider: ["machine-provider-v1"], cmux: [10], application: ["omp-app/1"] },
			deployment: { mode: "kubernetes", highAvailability: { gateway: false, runtime: false }, writableOmpAuthoritiesPerRuntime: 1 },
		});
		for (const path of ["/v1/version", "/v1/capabilities", "/v1/not-supported"]) {
			const response = await handle(get(path));
			expect(response.status).toBe(401);
			expect(response.headers.get("content-type")).toBe("application/problem+json");
		}
		expect(await body(handle(get("/v1/version"), OWNER))).toEqual({
			apiVersion: "v1",
			build: config.build,
			protocols: { machineProvider: ["machine-provider-v1"], cmux: [10], application: ["omp-app/1"] },
		});
	});

	it("returns truthful read-only capabilities without sleep, SSH, cmux routes, or mutation support", async () => {
		const { handle } = fixture();
		const capabilities = await body(handle(get("/v1/capabilities"), OWNER));
		expect(capabilities).toMatchObject({
			deployment: { mode: "kubernetes", highAvailability: { gateway: false, runtime: false }, writableOmpAuthoritiesPerRuntime: 1 },
			features: { restLifecycle: false, sshProvider: false, directCmuxWebSocket: false, browser: false, scaleToZero: false },
			limits: { maxPageSize: 200, idempotencyRetentionSeconds: 86_400, eventRetentionSeconds: 60 },
		});
		expect(JSON.stringify(capabilities)).not.toContain("sleep");
	});

	it("isolates principals and makes foreign resources indistinguishable from missing resources", async () => {
		const { handle } = fixture();
		const scopes = await body(handle(get("/v1/scopes"), OWNER)) as { items: Array<Record<string, unknown>> };
		expect(scopes.items).toHaveLength(1);
		expect(scopes.items[0]?.id).toMatch(/^scope_[A-Za-z0-9_-]+$/u);
		expect(JSON.stringify(scopes)).not.toContain(OWNER);
		const workspaces = await body(handle(get("/v1/workspaces"), OWNER)) as { items: Array<Record<string, unknown>> };
		expect(workspaces.items.map(item => item.displayName)).toEqual(["Workspace A", "Workspace B"]);
		expect(workspaces.items.map(item => item.id)).toEqual([
			expect.stringMatching(/^ws_[A-Za-z0-9_-]+$/u),
			expect.stringMatching(/^ws_[A-Za-z0-9_-]+$/u),
		]);
		expect(JSON.stringify(workspaces)).not.toContain("workspace-a");
		const foreign = await handle(get("/v1/workspaces/workspace-foreign"), OWNER);
		const missing = await handle(get("/v1/workspaces/does-not-exist"), OWNER);
		expect(foreign.status).toBe(404);
		expect(missing.status).toBe(404);
		expect(await body(foreign)).toMatchObject({ status: 404, code: "not_found", detail: "The requested resource was not found." });
		expect(await body(missing)).toMatchObject({ status: 404, code: "not_found", detail: "The requested resource was not found." });
		expect((await handle(get("/v1/runtimes/runtime-foreign"), OWNER)).status).toBe(404);
	});

	it("applies exact bounded filters and opaque deterministic pagination", async () => {
		const { handle } = fixture();
		const first = await body(handle(get("/v1/workspaces?limit=1"), OWNER)) as { items: Array<Record<string, unknown>>; nextCursor: string };
		expect(first.items.map(item => item.displayName)).toEqual(["Workspace A"]);
		expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
		expect(Buffer.from(first.nextCursor, "base64url").toString("utf8")).not.toContain("workspace-a");
		const second = await body(handle(get(`/v1/workspaces?limit=1&cursor=${first.nextCursor}`), OWNER)) as { items: Array<Record<string, unknown>> };
		expect(second.items.map(item => item.displayName)).toEqual(["Workspace B"]);
		const ready = await body(handle(get("/v1/workspaces?phase=Ready&updatedSince=2026-07-29T10%3A00%3A00Z"), OWNER)) as { items: Array<Record<string, unknown>> };
		expect(ready.items.map(item => item.displayName)).toEqual(["Workspace A"]);
		const workspaceId = String(ready.items[0]?.id);
		const runtimeFiltered = await body(handle(get(`/v1/runtimes?desiredState=Running&workspaceId=${workspaceId}&phase=Ready`), OWNER)) as { items: Array<Record<string, unknown>> };
		expect(runtimeFiltered.items.map(item => item.displayName)).toEqual(["Runtime A"]);
		expect((await handle(get("/v1/workspaces?limit=201"), OWNER)).status).toBe(400);
		expect((await handle(get("/v1/workspaces?limit=1&limit=2"), OWNER)).status).toBe(400);
		expect((await handle(get("/v1/workspaces?cursor=not-a-current-cursor"), OWNER)).status).toBe(400);
	});

	it("returns bounded OpenAPI resources and never leaks Kubernetes or upstream identities", async () => {
		const { handle } = fixture();
		const workspaceList = await body(handle(get("/v1/workspaces"), OWNER)) as { items: Array<Record<string, unknown>> };
		const workspaceId = String(workspaceList.items.find(item => item.displayName === "Workspace A")?.id);
		const workspaceResponse = await handle(get(`/v1/workspaces/${workspaceId}`), OWNER);
		expect(workspaceResponse.status).toBe(200);
		expect(workspaceResponse.headers.get("etag")).toMatch(/^"rev_[A-Za-z0-9_-]+"$/u);
		const workspaceBody = await body(workspaceResponse);
		expect(workspaceBody).toMatchObject({ capacityBytes: 2 * 1024 ** 3, retention: "Retain", phase: "Ready", attachmentCount: 1 });
		const runtimeList = await body(handle(get("/v1/runtimes"), OWNER)) as { items: Array<Record<string, unknown>> };
		const runtimeId = String(runtimeList.items.find(item => item.displayName === "Runtime A")?.id);
		const runtimeResponse = await handle(get(`/v1/runtimes/${runtimeId}`), OWNER);
		expect(runtimeResponse.headers.get("etag")).toMatch(/^"rev_[A-Za-z0-9_-]+"$/u);
		const serialized = JSON.stringify([workspaceBody, await body(runtimeResponse)]);
		for (const secret of [OWNER, OTHER, "workspace-a", "runtime-a", "private-namespace", "pvcRef", "podName", "serviceName", "credentialPath", "never-return-this", "upstream-private", "private-upstream-revision", "internal-service"]) {
			expect(serialized).not.toContain(secret);
		}
		expect(serialized).not.toContain("connectionReady");
	});

	it("returns only a current authorized omp-app route and reports unready runtimes without placeholders", async () => {
		const { handle } = fixture();
		const runtimeList = await body(handle(get("/v1/runtimes"), OWNER)) as { items: Array<Record<string, unknown>> };
		const readyId = String(runtimeList.items.find(item => item.displayName === "Runtime A")?.id);
		const unreadyId = String(runtimeList.items.find(item => item.displayName === "Runtime B")?.id);
		const ready = await handle(get(`/v1/runtimes/${readyId}/connections`), OWNER);
		expect(ready.status).toBe(200);
		expect(ready.headers.get("cache-control")).toBe("no-store");
		expect(ready.headers.get("etag")).toMatch(/^"rev_[A-Za-z0-9_-]+"$/u);
		expect(await body(ready)).toEqual(expect.objectContaining({
			runtimeId: readyId,
			expiresAt: "2026-07-29T12:05:00.000Z",
			routes: [{ kind: "omp-app-websocket", url: config.ompAppWebSocketUrl, protocol: "omp-app/1" }],
		}));
		expect((await handle(get(`/v1/runtimes/${unreadyId}/connections`), OWNER)).status).toBe(409);
		expect((await handle(get("/v1/runtimes/runtime-foreign/connections"), OWNER)).status).toBe(404);
	});

	it("advertises and describes the public direct cmux route only with an enabled valid template", async () => {
		const { handle, projection } = fixture(true);
		expect(await body(handle(get("/.well-known/omperator")))).toMatchObject({
			cmuxWebSocketTemplate: "wss://public.example.test/v1/cmux/{runtimeId}",
		});
		expect(await body(handle(get("/v1/capabilities"), OWNER))).toMatchObject({
			features: { directCmuxWebSocket: true },
		});
		const runtimes = await body(handle(get("/v1/runtimes"), OWNER)) as { items: Array<Record<string, unknown>> };
		const runtimeId = String(runtimes.items.find(item => item.displayName === "Runtime A")?.id);
		const descriptor = await body(handle(get(`/v1/runtimes/${runtimeId}/connections`), OWNER)) as {
			routes: Array<Record<string, unknown>>;
		};
		expect(descriptor.routes).toEqual([
			{ kind: "omp-app-websocket", url: config.ompAppWebSocketUrl, protocol: "omp-app/1" },
			{ kind: "cmux-websocket", url: `wss://public.example.test/v1/cmux/${encodeURIComponent(runtimeId)}`, protocol: 10 },
		]);
		projection.applyWatch({ type: "MODIFIED", object: workspace("workspace-a", OWNER, "Pending", "999") });
		const ineligible = await body(handle(get(`/v1/runtimes/${runtimeId}/connections`), OWNER)) as {
			routes: Array<Record<string, unknown>>;
		};
		expect(ineligible.routes).toEqual([
			{ kind: "omp-app-websocket", url: config.ompAppWebSocketUrl, protocol: "omp-app/1" },
		]);
		const serialized = JSON.stringify(descriptor);
		for (const internal of ["runtime-a", "private-namespace", "service-private", "pod-private", "upstream-private"])
			expect(serialized).not.toContain(internal);
	});

	it("uses problem JSON for exact 404/405 routing and quotes resource ETags", async () => {
		const { handle } = fixture();
		const missing = await handle(get("/v1/events"), OWNER);
		expect(missing.status).toBe(404);
		expect(missing.headers.get("content-type")).toBe("application/problem+json");
		const method = await handle(new Request("https://public.example.test/v1/version", { method: "POST" }), OWNER);
		expect(method.status).toBe(405);
		expect(method.headers.get("allow")).toBe("GET");
		expect(method.headers.get("content-type")).toBe("application/problem+json");
		const workspaces = await body(handle(get("/v1/workspaces"), OWNER)) as { items: Array<Record<string, unknown>> };
		expect((await handle(get(`/v1/workspaces/${String(workspaces.items[0]?.id)}`), OWNER)).headers.get("etag")).toMatch(/^"[^"]+"$/u);
	});

	it("authorizes exact shared scope lists without making absent or foreign resources distinguishable", async () => {
		const { projection } = fixture();
		const otherScopeId = requestIdentityScopeId(identity(OTHER));
		const reader = identity(OWNER, [{ scopeId: otherScopeId, roles: ["reader"] }]);
		const handler = createClusterRestHandler({ projection, config });
		const scopes = await handler(get("/v1/scopes"), reader);
		expect(scopes.status).toBe(200);
		expect(await body(scopes)).toMatchObject({ items: [{ id: otherScopeId, kind: "Shared" }] });
		const shared = await handler(get(`/v1/workspaces?scopeId=${otherScopeId}`), reader);
		expect(shared.status).toBe(200);
		const sharedBody = await body(shared) as { items: Array<Record<string, unknown>> };
		expect(sharedBody.items).toHaveLength(1);
		expect(sharedBody.items[0]).toMatchObject({ scopeId: otherScopeId, displayName: "Workspace N" });
		const sharedWorkspaceId = String(sharedBody.items[0]!.id);
		const individual = await handler(get(`/v1/workspaces/${sharedWorkspaceId}?scopeId=${otherScopeId}`), reader);
		expect(individual.status).toBe(200);
		expect(await body(individual)).toMatchObject({ id: sharedWorkspaceId, scopeId: otherScopeId });
		expect((await handler(get("/v1/workspaces?scopeId=scope_absent"), reader)).status).toBe(404);
		expect((await handler(get("/v1/workspaces/ws_missing"), reader)).status).toBe(404);
		expect((await handler(get("/v1/workspaces/ws_foreign"), reader)).status).toBe(404);
	});

	it("binds colliding resource IDs to the explicit authenticated scope selector", async () => {
		const projection = new ClusterInfrastructureProjection({ epoch: "replica-collision", namespace: "development" });
		const personal = workspace("workspace-personal-collision", OWNER, "Ready", "910");
		const shared = workspace("workspace-shared-collision", OTHER, "Ready", "911");
		projection.replace({
			host,
			workspaces: [
				{ ...personal, spec: { ...personal.spec, publicId: "duplicate-id", displayName: "Personal duplicate" } },
				{ ...shared, spec: { ...shared.spec, publicId: "duplicate-id", displayName: "Shared duplicate" } },
			],
			sessions: [],
			resourceVersion: "911",
		});
		const personalScopeId = requestIdentityScopeId(identity(OWNER));
		const sharedScopeId = requestIdentityScopeId(identity(OTHER));
		const reader = identity(OWNER, [
			{ scopeId: personalScopeId, roles: ["reader"] },
			{ scopeId: sharedScopeId, roles: ["reader"] },
		]);
		const handler = createClusterRestHandler({ projection, config });
		expect(await body(handler(get("/v1/workspaces/duplicate-id"), reader))).toMatchObject({
			scopeId: personalScopeId,
			displayName: "Personal duplicate",
		});
		expect(await body(handler(get(`/v1/workspaces/duplicate-id?scopeId=${sharedScopeId}`), reader))).toMatchObject({
			scopeId: sharedScopeId,
			displayName: "Shared duplicate",
		});
	});

	it("omits unauthorized connection and mutation capabilities", async () => {
		const { projection } = fixture(true);
		const reader = identity(OWNER, [{ scopeId: "personal", roles: ["reader"] }]);
		const handler = createClusterRestHandler({ projection, config: { ...config, cmuxWebSocketTemplate: "wss://public.example.test/v1/cmux/{runtimeId}" }, directCmuxWebSocket: true });
		const capabilities = await body(handler(get("/v1/capabilities"), reader));
		expect(capabilities).toMatchObject({ features: { restLifecycle: false, directCmuxWebSocket: false, browser: false, scaleToZero: false } });
	});

describe("cluster REST lifecycle mutations", () => {
	function mutationFixture() {
		const { projection } = fixture();
		const workspaceResource: KubernetesResource = {
			apiVersion: "cluster.t4.dev/v1alpha1",
			kind: "T4Workspace",
			metadata: {
				name: "ws-private-name",
				uid: "ws-private-uid",
				resourceVersion: "1001",
				annotations: { "cluster.t4.dev/rest-revision": "base-workspace" },
			},
			spec: {
				publicId: "client-workspace",
				hostRef: "primary",
				owner: OWNER,
				displayName: "Created workspace",
				size: "1073741824",
				retentionPolicy: "Retain",
			},
			status: { phase: "Pending" },
		};
		const runtimeResource: KubernetesResource = {
			apiVersion: "cluster.t4.dev/v1alpha1",
			kind: "T4Session",
			metadata: {
				name: "rt-private-name",
				uid: "rt-private-uid",
				resourceVersion: "1002",
				annotations: { "cluster.t4.dev/rest-revision": "base-runtime" },
			},
			spec: {
				publicId: "client-runtime",
				hostRef: "primary",
				workspaceRef: "ws-private-name",
				title: "Created runtime",
				runtimeProfile: "default",
				desiredState: "Sleeping",
				browserPolicy: "Disabled",
			},
			status: { phase: "Pending" },
		};
		const workspaceResult: RestMutationResult = { created: true, resource: workspaceResource, attachmentCount: 2 };
		const runtimeResult: RestMutationResult = { created: true, resource: runtimeResource, workspace: workspaceResource };
		const mutations: NonNullable<ClusterRestHandlerOptions["mutations"]> = {
			putRestWorkspace: vi.fn(async () => workspaceResult),
			patchRestWorkspace: vi.fn(async () => workspaceResult),
			deleteRestWorkspace: vi.fn(async () => undefined),
			putRestRuntime: vi.fn(async () => runtimeResult),
			patchRestRuntime: vi.fn(async () => runtimeResult),
			deleteRestRuntime: vi.fn(async () => undefined),
			mutateRestRuntimeAction: vi.fn(async () => ({ ...runtimeResult, retainedStatus: 202, retainedBody: {
				id: "client-runtime",
				scopeId: "scope-retained",
				displayName: "Created runtime",
				workspaceId: "client-workspace",
				hostProfileId: "default",
				desiredState: "Sleeping",
				phase: "Pending",
				generation: "1",
				revision: "rev_retained",
				capabilities: [],
				conditions: [],
				createdAt: "2026-07-29T12:00:00.000Z",
				updatedAt: "2026-07-29T12:00:00.000Z",
			}, retainedEtag: "\"rev_retained\"" })),
		};
		return {
			mutations,
			projection,
			handle: withPrincipal(createClusterRestHandler({ projection, config, mutations, now: () => new Date("2026-07-29T12:00:00Z") })),
		};
	}

	it("denies reader mutations before the backend seam is touched", async () => {
		const { projection, mutations } = mutationFixture();
		const scopeId = requestIdentityScopeId(identity(OTHER));
		const reader = identity(OWNER, [{ scopeId, roles: ["reader"] }]);
		const handler = createClusterRestHandler({ projection, config, mutations });
		const response = await handler(new Request("https://public.example.test/v1/workspaces/client-workspace", {
			method: "PUT",
			headers: { "content-type": "application/json", "if-none-match": "*" },
			body: JSON.stringify({ scopeId, displayName: "Denied", capacityBytes: 1_073_741_824, retention: "Retain" }),
		}), reader);
		expect(response.status).toBe(404);
		expect(mutations.putRestWorkspace).not.toHaveBeenCalled();
	});

	it("returns typed bounded quota failures before Kubernetes creation", async () => {
		const { projection, mutations } = mutationFixture();
		const scopeId = requestIdentityScopeId(identity(OWNER));
		const admission = {
			createWorkspace: vi.fn(async () => { throw new ScopeAdmissionError({ outcome: "denied", reason: "creation_rate_limit", retryAfterSeconds: 17 }); }),
			createRuntime: vi.fn(async () => { throw new ScopeAdmissionError({ outcome: "denied", reason: "browser_disabled" }); }),
			wakeRuntime: vi.fn(async () => { throw new ScopeAdmissionError({ outcome: "denied", reason: "active_runtime_limit" }); }),
			patchRuntime: vi.fn(async () => { throw new ScopeAdmissionError({ outcome: "denied", reason: "browser_disabled" }); }),
			retireWorkspace: vi.fn(),
			retireRuntime: vi.fn(),
			beginDeletion: vi.fn(),
			resumeDeletion: vi.fn(async () => false),
			finishDeletion: vi.fn(),
		};
		const handler = createClusterRestHandler({ projection, config, mutations, admission });
		const response = await handler(new Request("https://public.example.test/v1/workspaces/over-quota", {
			method: "PUT",
			headers: { "content-type": "application/json", "if-none-match": "*" },
			body: JSON.stringify({ scopeId, displayName: "Denied", capacityBytes: 1_073_741_824, retention: "Retain" }),
		}), identity(OWNER));
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("17");
		expect(await response.json()).toMatchObject({ code: "creation_rate_limit", status: 429 });
		expect(mutations.putRestWorkspace).not.toHaveBeenCalled();
	});

	it("denies a browser PATCH before invoking the Kubernetes backend", async () => {
		const { projection, mutations } = mutationFixture();
		const runtimeId = projection.restProjection(OWNER).runtimes[0]!.id;
		const admission: NonNullable<ClusterRestHandlerOptions["admission"]> = {
			createWorkspace: vi.fn(),
			createRuntime: vi.fn(),
			wakeRuntime: vi.fn(),
			patchRuntime: vi.fn(async () => { throw new ScopeAdmissionError({ outcome: "denied", reason: "browser_disabled" }); }),
			retireWorkspace: vi.fn(),
			retireRuntime: vi.fn(),
			beginDeletion: vi.fn(),
			resumeDeletion: vi.fn(async () => false),
			finishDeletion: vi.fn(),
		};
		const handler = createClusterRestHandler({ projection, config, mutations, admission });
		const response = await handler(new Request(`https://public.example.test/v1/runtimes/${runtimeId}`, {
			method: "PATCH",
			headers: { "content-type": "application/merge-patch+json", "if-match": "\"rev_current\"" },
			body: JSON.stringify({ browserPolicy: "Allowed" }),
		}), identity(OWNER));
		expect(response.status).toBe(409);
		expect(await body(response)).toMatchObject({ code: "browser_disabled" });
		expect(mutations.patchRestRuntime).not.toHaveBeenCalled();
	});

	it("surfaces retirement failure after a confirmed REST sleep mutation", async () => {
		const { projection, mutations } = mutationFixture();
		const runtimeId = projection.restProjection(OWNER).runtimes[0]!.id;
		const admission: NonNullable<ClusterRestHandlerOptions["admission"]> = {
			createWorkspace: vi.fn(),
			createRuntime: vi.fn(),
			wakeRuntime: vi.fn(),
			patchRuntime: vi.fn(),
			retireWorkspace: vi.fn(),
			retireRuntime: vi.fn(async () => { throw new ScopeAdmissionError({ outcome: "denied", reason: "admission_unavailable", retryAfterSeconds: 1 }); }),
			beginDeletion: vi.fn(),
			resumeDeletion: vi.fn(async () => false),
			finishDeletion: vi.fn(),
		};
		const handler = createClusterRestHandler({ projection, config, mutations, admission });
		const response = await handler(new Request(`https://public.example.test/v1/runtimes/${runtimeId}:sleep`, {
			method: "POST",
			headers: { "if-match": "\"rev_current\"", "idempotency-key": "retire-failure-0001" },
		}), identity(OWNER));
		expect(response.status).toBe(503);
		expect(mutations.mutateRestRuntimeAction).toHaveBeenCalledOnce();
		expect(admission.retireRuntime).toHaveBeenCalledWith(requestIdentityScopeId(identity(OWNER)), runtimeId, ["activate"]);
	});

	it("resumes durable admission retirement when delete succeeded before reconciliation failed", async () => {
		const { projection, mutations } = mutationFixture();
		const runtimeResource = projection.restProjection(OWNER).runtimes[0]!;
		const runtimeId = runtimeResource.id;
		const scopeId = requestIdentityScopeId(identity(OWNER));
		const admission: NonNullable<ClusterRestHandlerOptions["admission"]> = {
			createWorkspace: vi.fn(),
			createRuntime: vi.fn(),
			wakeRuntime: vi.fn(),
			patchRuntime: vi.fn(),
			retireWorkspace: vi.fn(),
			retireRuntime: vi.fn(),
			beginDeletion: vi.fn(),
			resumeDeletion: vi.fn(async () => true),
			finishDeletion: vi.fn(async () => { throw new ScopeAdmissionError({ outcome: "denied", reason: "admission_unavailable", retryAfterSeconds: 1 }); }),
		};
		const handler = createClusterRestHandler({ projection, config, mutations, admission });
		const request = () => new Request(`https://public.example.test/v1/runtimes/${runtimeId}`, {
			method: "DELETE",
			headers: { "if-match": "\"rev_current\"" },
		});
		expect((await handler(request(), identity(OWNER))).status).toBe(503);
		expect(admission.beginDeletion).toHaveBeenCalledWith(scopeId, "runtime", runtimeId);
		projection.applyWatch({ type: "DELETED", object: runtime("runtime-a", "workspace-a", "Running", "904") });
		expect((await handler(request(), identity(OWNER))).status).toBe(204);
		expect(mutations.deleteRestRuntime).toHaveBeenCalledOnce();
		expect(admission.resumeDeletion).toHaveBeenCalledWith(scopeId, "runtime", runtimeId);
	});

	it("routes shared writer and admin mutations to the resource owner while preserving actor identity", async () => {
		const { projection, mutations } = mutationFixture();
		const sharedScopeId = requestIdentityScopeId(identity(OTHER));
		const sharedRuntimeId = projection.restProjection(OTHER).runtimes[0]!.id;
		const writer = identity(OWNER, [{ scopeId: sharedScopeId, roles: ["writer"] }]);
		const writerHandler = createClusterRestHandler({ projection, config, mutations });
		const create = await writerHandler(new Request("https://public.example.test/v1/workspaces/shared-created", {
			method: "PUT",
			headers: { "content-type": "application/json", "if-none-match": "*" },
			body: JSON.stringify({ scopeId: sharedScopeId, displayName: "Shared", capacityBytes: 1_073_741_824, retention: "Retain" }),
		}), writer);
		expect(create.status).toBe(202);
		expect(mutations.putRestWorkspace).toHaveBeenCalledWith(
			"shared-created",
			expect.objectContaining({ scopeId: sharedScopeId }),
			OTHER,
			writer,
		);
		const update = await writerHandler(new Request(`https://public.example.test/v1/runtimes/${sharedRuntimeId}?scopeId=${sharedScopeId}`, {
			method: "PATCH",
			headers: { "content-type": "application/merge-patch+json", "if-match": "\"rev_current\"" },
			body: JSON.stringify({ desiredState: "Sleeping" }),
		}), writer);
		expect(update.status).toBe(202);
		expect(mutations.patchRestRuntime).toHaveBeenCalledWith(sharedRuntimeId, "rev_current", { desiredState: "Sleeping" }, OTHER, writer);
		const action = await writerHandler(new Request(`https://public.example.test/v1/runtimes/${sharedRuntimeId}:wake?scopeId=${sharedScopeId}`, {
			method: "POST",
			headers: { "if-match": "\"rev_current\"", "idempotency-key": "shared-action-0001" },
		}), writer);
		expect(action.status).toBe(202);
		expect(mutations.mutateRestRuntimeAction).toHaveBeenCalledWith(
			sharedRuntimeId,
			"rev_current",
			"shared-action-0001",
			expect.any(String),
			"Running",
			OTHER,
			writer,
		);

		const admin = identity(OWNER, [{ scopeId: sharedScopeId, roles: ["admin"] }]);
		const adminHandler = createClusterRestHandler({ projection, config, mutations });
		const deletion = await adminHandler(new Request(`https://public.example.test/v1/runtimes/${sharedRuntimeId}?scopeId=${sharedScopeId}`, {
			method: "DELETE",
			headers: { "if-match": "\"rev_current\"" },
		}), admin);
		expect(deletion.status).toBe(204);
		expect(mutations.deleteRestRuntime).toHaveBeenCalledWith(sharedRuntimeId, "rev_current", OTHER, admin);
	});

	it("keeps absent, foreign, and ungranted existing mutations indistinguishable before backend access", async () => {
		const { projection, mutations } = mutationFixture();
		const otherRuntimeId = projection.restProjection(OTHER).runtimes[0]!.id;
		const handler = createClusterRestHandler({ projection, config, mutations });
		for (const runtimeId of ["rt_absent", otherRuntimeId]) {
			const response = await handler(new Request(`https://public.example.test/v1/runtimes/${runtimeId}`, {
				method: "DELETE",
				headers: { "if-match": "\"rev_current\"" },
			}), identity(OWNER));
			expect(response.status).toBe(404);
		}
		expect(mutations.deleteRestRuntime).not.toHaveBeenCalled();
	});

	it("advertises lifecycle only when the production mutation seam is wired", async () => {
		const { handle } = mutationFixture();
		expect(await body(handle(get("/v1/capabilities"), OWNER))).toMatchObject({
			features: { restLifecycle: true, scaleToZero: false },
		});
	});

	it("strictly decodes canonical workspace PUT and returns accepted headers without exposing its CRD name", async () => {
		const { handle, mutations } = mutationFixture();
		const scopes = await body(handle(get("/v1/scopes"), OWNER)) as { items: Array<{ id: string }> };
		const input = { scopeId: scopes.items[0]!.id, displayName: "Created workspace", capacityBytes: 1_073_741_824, retention: "Retain" };
		const valid = await handle(new Request("https://public.example.test/v1/workspaces/client-workspace", {
			method: "PUT",
			headers: { "content-type": "application/json", "if-none-match": "*" },
			body: JSON.stringify(input),
		}), OWNER);
		expect(valid.status).toBe(202);
		expect(valid.headers.get("location")).toBe("/v1/workspaces/client-workspace");
		expect(valid.headers.get("etag")).toMatch(/^"rev_[A-Za-z0-9_-]+"$/u);
		expect(valid.headers.get("retry-after")).toBe("1");
		const validBody = await body(valid);
		expect(validBody).toMatchObject({ attachmentCount: 2 });
		expect(JSON.stringify(validBody)).not.toContain("ws-private-name");
		expect(mutations.putRestWorkspace).toHaveBeenCalledWith("client-workspace", input, OWNER, identity(OWNER));

		for (const request of [
			new Request("https://public.example.test/v1/workspaces/client-workspace", { method: "PUT", headers: { "content-type": "application/json; charset=utf-8", "if-none-match": "*" }, body: JSON.stringify(input) }),
			new Request("https://public.example.test/v1/workspaces/client-workspace", { method: "PUT", headers: { "content-type": "application/json", "if-none-match": "*" }, body: JSON.stringify({ ...input, image: "forbidden" }) }),
			new Request("https://public.example.test/v1/workspaces/client-workspace", { method: "PUT", headers: { "content-type": "application/json", "if-none-match": "*" }, body: "{" }),
		]) expect((await handle(request, OWNER)).status).toBe(400);
	});

	it("returns bounded typed stale-revision and action idempotency responses", async () => {
		const { handle, mutations, projection } = mutationFixture();
		const existingRuntimeId = projection.restProjection(OWNER).runtimes[0]!.id;
		vi.mocked(mutations.patchRestRuntime).mockRejectedValueOnce(new RestMutationError("revision_mismatch", "The resource revision does not match.", "rev_current"));
		const stale = await handle(new Request(`https://public.example.test/v1/runtimes/${existingRuntimeId}`, {
			method: "PATCH",
			headers: { "content-type": "application/merge-patch+json", "if-match": "\"rev_stale\"" },
			body: JSON.stringify({ desiredState: "Sleeping" }),
		}), OWNER);
		expect(stale.status).toBe(412);
		expect(await body(stale)).toMatchObject({ code: "revision_mismatch", currentRevision: "rev_current" });

		const action = await handle(new Request(`https://public.example.test/v1/runtimes/${existingRuntimeId}:sleep`, {
			method: "POST",
			headers: { "if-match": "\"rev_current\"", "idempotency-key": "action-key-000001" },
		}), OWNER);
		expect(action.status).toBe(202);
		expect(action.headers.get("etag")).toBe("\"rev_retained\"");
		expect(action.headers.get("location")).toBe("/v1/runtimes/client-runtime");
		expect(await body(action)).toMatchObject({ id: "client-runtime", desiredState: "Sleeping" });
	});

	it("returns permanent Kubernetes policy rejection as non-retryable 422", async () => {
		const { handle, mutations } = mutationFixture();
		vi.mocked(mutations.putRestRuntime).mockRejectedValueOnce(
			new RestMutationError("invalid_resource", "The requested resource is not supported by Kubernetes policy."),
		);
		const scopes = await body(handle(get("/v1/scopes"), OWNER)) as { items: Array<{ id: string }> };
		const response = await handle(new Request("https://public.example.test/v1/runtimes/client-runtime", {
			method: "PUT",
			headers: { "content-type": "application/json", "if-none-match": "*" },
			body: JSON.stringify({
				scopeId: scopes.items[0]!.id,
				displayName: "Runtime",
				workspaceId: "client-workspace",
				hostProfileId: "Team.Profile~One",
				desiredState: "Running",
				browserPolicy: "Disabled",
			}),
		}), OWNER);
		expect(response.status).toBe(422);
		expect(response.headers.get("retry-after")).toBeNull();
		expect(await body(response)).toMatchObject({ code: "invalid_resource", retryable: false });
	});

	it("projects stable client IDs and accepted desired state without exposing private CRD names", async () => {
		const projection = new ClusterInfrastructureProjection({ epoch: "replica-rest-created", namespace: "private-namespace" });
		projection.replace({
			host,
			workspaces: [{
				...workspace("private-workspace-name", OWNER, "Ready", "1100"),
				spec: {
					hostRef: "primary",
					owner: OWNER,
					publicId: "client-workspace-id",
					displayName: "Client workspace",
					retentionPolicy: "Retain",
					size: "2Gi",
				},
			}],
			sessions: [{
				...runtime("private-runtime-name", "private-workspace-name", "Pending", "1101"),
				spec: {
					hostRef: "primary",
					workspaceRef: "private-workspace-name",
					publicId: "client-runtime-id",
					title: "Client runtime",
					runtimeProfile: "default",
					desiredState: "Sleeping",
					browserPolicy: "Disabled",
					publicHostProfileId: "Team.Profile~One",
				},
			}],
			resourceVersion: "1101",
		});
		const handle = withPrincipal(createClusterRestHandler({ projection, config }));
		const workspaces = await body(handle(get("/v1/workspaces"), OWNER)) as { items: Array<Record<string, unknown>> };
		const runtimes = await body(handle(get("/v1/runtimes"), OWNER)) as { items: Array<Record<string, unknown>> };
		expect(workspaces.items[0]).toMatchObject({ id: "client-workspace-id" });
		expect(runtimes.items[0]).toMatchObject({ id: "client-runtime-id", workspaceId: "client-workspace-id", hostProfileId: "Team.Profile~One", desiredState: "Sleeping" });
		expect(JSON.stringify({ workspaces, runtimes })).not.toContain("private-workspace-name");
		expect(JSON.stringify({ workspaces, runtimes })).not.toContain("private-runtime-name");
	});
});
});
