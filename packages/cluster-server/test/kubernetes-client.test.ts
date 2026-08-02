import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLUSTER_INTERNAL_AUDIENCE,
	KubernetesApiClient,
	KubernetesGatewayMutationBackend,
	KubernetesTokenReviewer,
	semanticResourceHash,
} from "../src/kubernetes-client.ts";
import { ClusterInfrastructureProjection, portableWorkspaceRevision, restResourceId, restResourceRevision, type KubernetesResource } from "../src/kubernetes-projection.ts";
import { createClusterRestHandler } from "../src/rest-handler.ts";
import type { RequestIdentity } from "../src/identity.ts";

const PRINCIPAL = "owner@example.com";
function requestIdentity(principalId: string): RequestIdentity {
	return Object.freeze({
		principalId,
		authorizedScopes: Object.freeze([]),
		adapter: Object.freeze({ id: "test", type: "tailscale" }),
		policyRevision: "1",
	});
}
const IDENTITY = requestIdentity(PRINCIPAL);

function recordingFetch(responses: unknown[]) {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(input), init });
		return Response.json(responses.shift() ?? {}, { status: init?.method === "POST" ? 201 : 200 });
	}) as typeof globalThis.fetch;
	return { requests, fetch };
}

function conflictFetch(existing: unknown) {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(input), init });
		return requests.length === 1
			? Response.json({ reason: "AlreadyExists" }, { status: 409 })
			: Response.json(existing);
	}) as typeof globalThis.fetch;
	return { requests, fetch };
}

describe("namespaced Kubernetes client", () => {
	it("lists and watches only the three cluster.t4.dev resources with bounded resource versions", async () => {
		const values = recordingFetch([
			{
				metadata: { resourceVersion: "20" },
				items: [{ apiVersion: "cluster.t4.dev/v1alpha1", kind: "T4ClusterHost", metadata: { name: "primary", uid: "host-uid", resourceVersion: "20" }, spec: {} }],
			},
			{ metadata: { resourceVersion: "21" }, items: [] },
			{ metadata: { resourceVersion: "22" }, items: [] },
		]);
		const client = new KubernetesApiClient({
			baseUrl: "https://kubernetes.default.svc",
			namespace: "development",
			token: "service-account-token",
			fetch: values.fetch,
		});
		const listed = await client.listInfrastructure();
		expect(listed.resourceVersion).toBe("22");
		expect(values.requests.map(request => request.url)).toEqual([
			"https://kubernetes.default.svc/apis/cluster.t4.dev/v1alpha1/namespaces/development/t4clusterhosts?limit=256",
			"https://kubernetes.default.svc/apis/cluster.t4.dev/v1alpha1/namespaces/development/t4workspaces?limit=256",
			"https://kubernetes.default.svc/apis/cluster.t4.dev/v1alpha1/namespaces/development/t4sessions?limit=1000",
		]);
		for (const request of values.requests) {
			expect(new Headers(request.init?.headers).get("authorization")).toBe("Bearer service-account-token");
		}
		expect(JSON.stringify(listed)).not.toContain("service-account-token");
	});

	it("observes projected service account token rotation without recreating the client", async () => {
		const directory = await mkdtemp(join(tmpdir(), "t4-kubernetes-client-token-"));
		try {
			const tokenFile = join(directory, "token");
			const nextTokenFile = join(directory, "token.next");
			const values = recordingFetch([{}, {}]);
			await writeFile(join(directory, "token-one"), "projected-token-one\n", { mode: 0o400 });
			await writeFile(join(directory, "token-two"), "projected-token-two\n", { mode: 0o400 });
			await symlink(join(directory, "token-one"), tokenFile);
			const client = new KubernetesApiClient({
				baseUrl: "https://kubernetes.default.svc",
				namespace: "development",
				tokenFile,
				fetch: values.fetch,
			});

			await client.list("t4clusterhosts", 1);
			await symlink(join(directory, "token-two"), nextTokenFile);
			await rename(nextTokenFile, tokenFile);
			await client.list("t4clusterhosts", 1);

			expect(values.requests.map(request => new Headers(request.init?.headers).get("authorization"))).toEqual([
				"Bearer projected-token-one",
				"Bearer projected-token-two",
			]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("requires exactly one bounded valid credential source and fails closed", async () => {
		const common = { baseUrl: "https://kubernetes.default.svc", namespace: "development" } as const;
		expect(() => new KubernetesApiClient(common)).toThrow("exactly one credential source");
		expect(() => new KubernetesApiClient({ ...common, token: "static-token", tokenFile: "/projected/token" })).toThrow("exactly one credential source");
		expect(() => new KubernetesApiClient({ ...common, tokenFile: "relative/token" })).toThrow("must be absolute");
		expect(() => new KubernetesApiClient({ ...common, token: "malformed token" })).toThrow("token is invalid");

		const directory = await mkdtemp(join(tmpdir(), "t4-kubernetes-client-invalid-token-"));
		try {
			const tokenFile = join(directory, "token");
			const nextTokenFile = join(directory, "token.next");
			const values = recordingFetch([]);
			const client = new KubernetesApiClient({ ...common, tokenFile, fetch: values.fetch });
			await writeFile(nextTokenFile, "malformed token", { mode: 0o400 });
			await rename(nextTokenFile, tokenFile);
			await expect(client.request("/version")).rejects.toThrow("Kubernetes token file is invalid");
			await writeFile(nextTokenFile, "x".repeat(16_385), { mode: 0o400 });
			await rename(nextTokenFile, tokenFile);
			await expect(client.request("/version")).rejects.toThrow("Kubernetes token file is invalid");
			expect(values.requests).toHaveLength(0);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("persists idempotent CR identity as command id plus semantic hash without credentials or arbitrary URLs", async () => {
		const values = recordingFetch([
			{},
			{ kind: "T4Workspace", metadata: { name: "workspace-one" }, spec: { hostRef: "primary", owner: PRINCIPAL } },
		]);
		const client = new KubernetesApiClient({
			baseUrl: "https://kubernetes.default.svc",
			namespace: "development",
			token: "service-account-token",
			fetch: values.fetch,
		});
		const backend = new KubernetesGatewayMutationBackend({ client, hostRef: "primary" });
		const workspaceArgs = {
			displayName: "Created workspace",
			retentionPolicy: "Retain" as const,
			capacity: "20Gi",
			repository: { repositoryId: "t4-code", ref: "refs/heads/main", commit: "abcdef0" },
		};
		await backend.createWorkspace("command-create-workspace", workspaceArgs, PRINCIPAL, IDENTITY);
		const workspaceBody = JSON.parse(String(values.requests[0]?.init?.body));
		expect(values.requests[0]).toMatchObject({
			url: "https://kubernetes.default.svc/apis/cluster.t4.dev/v1alpha1/namespaces/development/t4workspaces",
			init: { method: "POST" },
		});
		expect(workspaceBody).toMatchObject({
			apiVersion: "cluster.t4.dev/v1alpha1",
			kind: "T4Workspace",
			metadata: {
				name: expect.stringMatching(/^workspace-[a-f0-9]{16}$/),
				finalizers: ["cluster.t4.dev/workspace-protection"],
				annotations: {
					"cluster.t4.dev/command-id": "command-create-workspace",
					"cluster.t4.dev/principal-hash": semanticResourceHash(PRINCIPAL),
					"cluster.t4.dev/semantic-hash": semanticResourceHash({ args: workspaceArgs, principal: PRINCIPAL }),
				},
			},
			spec: {
				hostRef: "primary",
				owner: PRINCIPAL,
				displayName: "Created workspace",
				retentionPolicy: "Retain",
				size: "20Gi",
				repository: { repositoryId: "t4-code", ref: "refs/heads/main", commit: "abcdef0" },
			},
		});
		expect(JSON.stringify(workspaceBody)).not.toContain("token");
		expect(JSON.stringify(workspaceBody)).not.toContain("url");

		await backend.createSession("command-create-session", {
			workspaceId: "workspace-one",
			title: "Task",
			runtimeProfile: "omp-17.0.5",
			guiEnabled: true,
			ci: { provider: "woodpecker", repositoryId: "t4-code", ref: "refs/heads/main", commit: "abcdef0" },
		}, PRINCIPAL, IDENTITY);
		const sessionBody = JSON.parse(String(values.requests[2]?.init?.body));
		expect(sessionBody).toMatchObject({
			apiVersion: "cluster.t4.dev/v1alpha1",
			kind: "T4Session",
			metadata: { name: expect.stringMatching(/^session-[a-f0-9]{16}$/) },
			spec: { hostRef: "primary", workspaceRef: "workspace-one", title: "Task", runtimeProfile: "omp-17.0.5", guiEnabled: true, browserPolicy: "Allowed" },
		});
	});

	it("reuses exact principal-scoped annotations and rejects semantic conflicts", async () => {
		const args = { displayName: "Created", retentionPolicy: "Delete" as const, capacity: "10Gi" };
		const annotations = {
			"cluster.t4.dev/command-id": "command-one",
			"cluster.t4.dev/principal-hash": semanticResourceHash(PRINCIPAL),
			"cluster.t4.dev/semantic-hash": semanticResourceHash({ args, principal: PRINCIPAL }),
		};
		const existing = {
			metadata: { name: "workspace-existing", resourceVersion: "9", annotations },
			status: { revision: "workspace-r1" },
		};
		const exact = conflictFetch(existing);
		const backend = new KubernetesGatewayMutationBackend({
			client: new KubernetesApiClient({ baseUrl: "https://kubernetes.default.svc", namespace: "development", token: "token", fetch: exact.fetch }),
			hostRef: "primary",
		});
		expect(await backend.createWorkspace("command-one", args, PRINCIPAL, IDENTITY)).toEqual({ id: "workspace-existing", revision: "9" });
		expect(exact.requests.map(request => request.init?.method ?? "GET")).toEqual(["POST", "GET"]);

		const conflicting = conflictFetch({ ...existing, metadata: { ...existing.metadata, annotations: { ...annotations, "cluster.t4.dev/semantic-hash": "wrong" } } });
		const conflictingBackend = new KubernetesGatewayMutationBackend({
			client: new KubernetesApiClient({ baseUrl: "https://kubernetes.default.svc", namespace: "development", token: "token", fetch: conflicting.fetch }),
			hostRef: "primary",
		});
		await expect(conflictingBackend.createWorkspace("command-one", args, PRINCIPAL, IDENTITY)).rejects.toThrow("idempotency conflict");
	});

	it("treats an already absent session as a successful idempotent delete", async () => {
		const fetch = (async () => Response.json({ reason: "NotFound" }, { status: 404 })) as unknown as typeof globalThis.fetch;
		const backend = new KubernetesGatewayMutationBackend({
			client: new KubernetesApiClient({ baseUrl: "https://kubernetes.default.svc", namespace: "development", token: "token", fetch }),
			hostRef: "primary",
		});
		expect(await backend.deleteSession("command-delete", "session-gone", PRINCIPAL, IDENTITY)).toEqual({ deleted: true });
	});

	describe("durable REST mutation authority", () => {
		function kubernetesAuthority() {
			const resources = new Map<string, KubernetesResource>();
			const requests: Array<{ url: string; init?: RequestInit }> = [];
			let version = 100;
			let updates = 0;
			const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				requests.push({ url, init });
				const match = /\/(t4workspaces|t4sessions)(?:\/([^?]+))?(?:\?.*)?$/u.exec(url);
				if (!match) return Response.json({ reason: "NotFound" }, { status: 404 });
				const collection = match[1]!;
				const name = match[2] ? decodeURIComponent(match[2]) : undefined;
				const method = init?.method ?? "GET";
				if (method === "POST") {
					const proposed = JSON.parse(String(init?.body)) as KubernetesResource;
					const key = `${collection}/${proposed.metadata.name}`;
					if (resources.has(key)) return Response.json({ reason: "AlreadyExists" }, { status: 409 });
					const created = {
						...proposed,
						metadata: {
							...proposed.metadata,
							uid: `${proposed.metadata.name}-uid`,
							resourceVersion: String(++version),
							generation: 1,
							creationTimestamp: "2026-07-29T12:00:00.000Z",
						},
						status: { phase: "Pending", observedGeneration: 0 },
					};
					resources.set(key, created);
					return Response.json(created, { status: 201 });
				}
				if (!name) {
					const items = [...resources.entries()].filter(([key]) => key.startsWith(`${collection}/`)).map(([, value]) => value);
					return Response.json({ metadata: { resourceVersion: String(version) }, items });
				}
				const key = `${collection}/${name}`;
				const current = resources.get(key);
				if (!current) return Response.json({ reason: "NotFound" }, { status: 404 });
				if (method === "PUT") {
					const proposed = JSON.parse(String(init?.body)) as KubernetesResource;
					if (proposed.metadata.uid !== current.metadata.uid || proposed.metadata.resourceVersion !== current.metadata.resourceVersion)
						return Response.json({ reason: "Conflict" }, { status: 409 });
					const updated = {
						...proposed,
						metadata: { ...proposed.metadata, resourceVersion: String(++version), generation: (current.metadata.generation ?? 0) + 1 },
					};
					resources.set(key, updated);
					updates++;
					return Response.json(updated);
				}
				if (method === "DELETE") {
					const options = JSON.parse(String(init?.body)) as { preconditions: { uid: string; resourceVersion: string } };
					if (options.preconditions.uid !== current.metadata.uid || options.preconditions.resourceVersion !== current.metadata.resourceVersion)
						return Response.json({ reason: "Conflict" }, { status: 409 });
					resources.delete(key);
					return Response.json({ status: "Success" });
				}
				return Response.json(current);
			}) as typeof globalThis.fetch;
			const client = () => new KubernetesApiClient({
				baseUrl: "https://kubernetes.default.svc",
				namespace: "development",
				token: "token",
				fetch,
			});
			return { resources, requests, client, updates: () => updates };
		}

		it("maps public IDs privately and makes PUT exact-idempotent while rejecting incompatible reuse", async () => {
			const authority = kubernetesAuthority();
			const backend = new KubernetesGatewayMutationBackend({ client: authority.client(), hostRef: "primary" });
			const input = {
				scopeId: "scope_personal",
				displayName: "Portable workspace",
				capacityBytes: 1_073_741_824,
				retention: "Retain" as const,
			};
			const created = await backend.putRestWorkspace("customer-choice", input, PRINCIPAL, IDENTITY);
			expect(created.created).toBe(true);
			expect(created.resource.metadata.name).toMatch(/^ws-[a-f0-9]{40}$/u);
			expect(created.resource.metadata.name).not.toContain("customer-choice");
			expect(created.resource.metadata.finalizers).toContain("cluster.t4.dev/workspace-protection");
			expect(created.resource.spec).toMatchObject({ publicId: "customer-choice" });
			expect(created.resource.metadata.annotations?.["cluster.t4.dev/scope-id"]).toBe(input.scopeId);
			const retried = await backend.putRestWorkspace("customer-choice", input, PRINCIPAL, IDENTITY);
			expect(retried.created).toBe(false);
			expect(retried.resource.metadata.uid).toBe(created.resource.metadata.uid);
			await expect(backend.putRestWorkspace("customer-choice", { ...input, displayName: "Changed create" }, PRINCIPAL, IDENTITY))
				.rejects.toMatchObject({ code: "resource_conflict" });
			await expect(backend.patchRestWorkspace("customer-choice", "rev_stale", { retention: "Delete" }, PRINCIPAL, IDENTITY))
				.rejects.toMatchObject({ code: "revision_mismatch", currentRevision: portableWorkspaceRevision(restResourceRevision("workspace", created.resource), 0) });
			const updated = await backend.patchRestWorkspace(
				"customer-choice",
				portableWorkspaceRevision(restResourceRevision("workspace", created.resource), 0),
				{ retention: "Delete" },
				PRINCIPAL,
				IDENTITY,
			);
			expect(updated.resource.spec?.retentionPolicy).toBe("Delete");
			await expect(backend.patchRestWorkspace("customer-choice", restResourceRevision("workspace", created.resource), { retention: "Delete" }, "other@example.com", requestIdentity("other@example.com")))
				.rejects.toMatchObject({ code: "not_found" });
		});


		it("resolves legacy UID-derived public IDs, returns authoritative attachments, and accepts UTF-8 principals", async () => {
			const authority = kubernetesAuthority();
			const unicodePrincipal = "Δ owner@example.test";
			const legacyWorkspace: KubernetesResource = {
				apiVersion: "cluster.t4.dev/v1alpha1",
				kind: "T4Workspace",
				metadata: { name: "legacy-private-workspace", uid: "legacy-workspace-uid", resourceVersion: "70", generation: 1 },
				spec: { hostRef: "primary", owner: unicodePrincipal, displayName: "Legacy", size: "2Gi", retentionPolicy: "Retain" },
				status: { phase: "Ready", observedGeneration: 1 },
			};
			const legacyRuntime: KubernetesResource = {
				apiVersion: "cluster.t4.dev/v1alpha1",
				kind: "T4Session",
				metadata: { name: "legacy-private-runtime", uid: "legacy-runtime-uid", resourceVersion: "71", generation: 1 },
				spec: { hostRef: "primary", workspaceRef: legacyWorkspace.metadata.name, title: "Legacy runtime", runtimeProfile: "default" },
				status: { phase: "Pending", observedGeneration: 1 },
			};
			const deletingRuntime: KubernetesResource = {
				...legacyRuntime,
				metadata: {
					...legacyRuntime.metadata,
					name: "legacy-deleting-runtime",
					uid: "legacy-deleting-runtime-uid",
					resourceVersion: "72",
					deletionTimestamp: "2026-07-29T12:05:00.000Z",
				},
			};
			authority.resources.set(`t4workspaces/${legacyWorkspace.metadata.name}`, legacyWorkspace);
			authority.resources.set(`t4sessions/${legacyRuntime.metadata.name}`, legacyRuntime);
			authority.resources.set(`t4sessions/${deletingRuntime.metadata.name}`, deletingRuntime);
			const backend = new KubernetesGatewayMutationBackend({ client: authority.client(), hostRef: "primary" });
			const workspaceId = restResourceId("ws", legacyWorkspace);
			const runtimeId = restResourceId("rt", legacyRuntime);
			const patchedWorkspace = await backend.patchRestWorkspace(
				workspaceId, restResourceRevision("workspace", legacyWorkspace), { retention: "Delete" }, unicodePrincipal, requestIdentity(unicodePrincipal),
			);
			expect(patchedWorkspace.attachmentCount).toBe(2);
			expect(patchedWorkspace.resource.metadata.name).toBe("legacy-private-workspace");
			const patchedRuntime = await backend.patchRestRuntime(
				runtimeId, restResourceRevision("runtime", legacyRuntime), { displayName: "Renamed" }, unicodePrincipal, requestIdentity(unicodePrincipal),
			);
			expect(patchedRuntime.resource.metadata.name).toBe("legacy-private-runtime");
			await expect(backend.deleteRestWorkspace(
				workspaceId, restResourceRevision("workspace", patchedWorkspace.resource), unicodePrincipal, requestIdentity(unicodePrincipal),
			)).rejects.toMatchObject({ code: "workspace_attached" });
		});
		it("classifies Kubernetes 422 as a permanent typed policy rejection", async () => {
			const fetch = (async (_input: string | URL | Request, init?: RequestInit) =>
				init?.method === "POST"
					? Response.json({ reason: "Invalid" }, { status: 422 })
					: Response.json({ metadata: { resourceVersion: "1" }, items: [] })) as typeof globalThis.fetch;
			const backend = new KubernetesGatewayMutationBackend({
				client: new KubernetesApiClient({
					baseUrl: "https://kubernetes.default.svc",
					namespace: "development",
					token: "token",
					fetch,
				}),
				hostRef: "primary",
			});
			await expect(backend.putRestWorkspace("policy-rejected", {
				scopeId: "scope_personal",
				displayName: "Rejected",
				capacityBytes: 1_073_741_824,
				retention: "Retain",
			}, PRINCIPAL, IDENTITY)).rejects.toMatchObject({ code: "invalid_resource" });
		});

		it("retains action replay across replicas and invokes one atomic mutation for concurrent duplicates", async () => {
			const authority = kubernetesAuthority();
			const first = new KubernetesGatewayMutationBackend({ client: authority.client(), hostRef: "primary" });
			const second = new KubernetesGatewayMutationBackend({ client: authority.client(), hostRef: "primary" });
			await first.putRestWorkspace("public-workspace", {
				scopeId: "scope_personal", displayName: "Workspace", capacityBytes: 1_073_741_824, retention: "Retain",
			}, PRINCIPAL, IDENTITY);
			const runtime = await first.putRestRuntime("public-runtime", {
				scopeId: "scope_personal",
				displayName: "Runtime",
				workspaceId: "public-workspace",
				hostProfileId: "Team.Profile~One",
				desiredState: "Running",
				browserPolicy: "Disabled",
			}, PRINCIPAL, IDENTITY);
			expect(runtime.resource.spec).toMatchObject({
				publicHostProfileId: "Team.Profile~One",
				runtimeProfile: expect.stringMatching(/^rest-[a-f0-9]{24}$/u),
			});
			expect(runtime.resource.metadata.annotations?.["cluster.t4.dev/scope-id"]).toBe("scope_personal");
			const expected = restResourceRevision("runtime", runtime.resource);
			const projectedRuntime: KubernetesResource = {
				...runtime.resource,
				status: { ...runtime.resource.status, runtimeGeneration: "gen_controller_owned_test" },
			};
			const projection = new ClusterInfrastructureProjection({ epoch: "rest-replica", namespace: "development" });
			projection.replace({
				host: { kind: "T4ClusterHost", metadata: { name: "primary", uid: "host-uid", resourceVersion: "1" }, spec: {} },
				workspaces: runtime.workspace ? [runtime.workspace] : [],
				sessions: [projectedRuntime],
				resourceVersion: "1",
			});
			const config = {
				restBaseUrl: "https://public.example.test/v1",
				ompAppWebSocketUrl: "wss://public.example.test/v1/ws",
				build: { version: "test", revision: "test-revision", builtAt: "2026-07-29T12:00:00.000Z" },
			};
			const firstHandler = createClusterRestHandler({ projection, config, mutations: first });
			const secondHandler = createClusterRestHandler({ projection, config, mutations: second });
			const actionRequest = () => new Request("https://public.example.test/v1/runtimes/public-runtime:sleep", {
				method: "POST",
				headers: { "if-match": `"${expected}"`, "idempotency-key": "same-action-key-1" },
			});
			const [left, right] = await Promise.all([
				firstHandler(actionRequest(), IDENTITY),
				secondHandler(actionRequest(), IDENTITY),
			]);
			expect(left.status).toBe(202);
			expect(right.status).toBe(202);
			expect(authority.updates()).toBe(1);
			expect(left.headers.get("etag")).toBe(right.headers.get("etag"));
			expect(await left.json()).toEqual(await right.json());
			const replay = await secondHandler(new Request("https://public.example.test/v1/runtimes/public-runtime:sleep", {
				method: "POST",
				headers: { "if-match": "\"rev_now_stale\"", "idempotency-key": "same-action-key-1" },
			}), IDENTITY);
			expect(replay.status).toBe(202);
			expect(authority.updates()).toBe(1);
			expect(replay.headers.get("etag")).toBe(left.headers.get("etag"));
			const conflict = await secondHandler(new Request("https://public.example.test/v1/runtimes/public-runtime:wake", {
				method: "POST",
				headers: { "if-match": `"${expected}"`, "idempotency-key": "same-action-key-1" },
			}), IDENTITY);
			expect(conflict.status).toBe(409);
			expect(await conflict.json()).toMatchObject({ code: "idempotency_conflict" });
			const storedRuntime = [...authority.resources.values()].find(resource => resource.kind === "T4Session")!;
			expect(storedRuntime.metadata.annotations?.["cluster.t4.dev/rest-idempotency"]).not.toContain(PRINCIPAL);
			const updateRequest = authority.requests.find(request => request.init?.method === "PUT")!;
			expect((JSON.parse(String(updateRequest.init?.body)) as KubernetesResource).metadata).toMatchObject({
				uid: runtime.resource.metadata.uid,
				resourceVersion: runtime.resource.metadata.resourceVersion,
			});
		});

		it("uses UID/resourceVersion delete preconditions and rejects attached workspace deletion", async () => {
			const authority = kubernetesAuthority();
			const backend = new KubernetesGatewayMutationBackend({ client: authority.client(), hostRef: "primary" });
			const workspace = await backend.putRestWorkspace("workspace-delete", {
				scopeId: "scope_personal", displayName: "Workspace", capacityBytes: 1_073_741_824, retention: "Retain",
			}, PRINCIPAL, IDENTITY);
			const deletingWorkspace = await backend.putRestWorkspace("workspace-deleting", {
				scopeId: "scope_personal", displayName: "Deleting", capacityBytes: 1_073_741_824, retention: "Retain",
			}, PRINCIPAL, IDENTITY);
			authority.resources.set(`t4workspaces/${deletingWorkspace.resource.metadata.name}`, {
				...deletingWorkspace.resource,
				metadata: { ...deletingWorkspace.resource.metadata, deletionTimestamp: "2026-07-29T12:10:00.000Z" },
			});
			await expect(backend.putRestRuntime("runtime-too-late", {
				scopeId: "scope_personal", displayName: "Late runtime", workspaceId: "workspace-deleting", hostProfileId: "default",
				desiredState: "Running", browserPolicy: "Disabled",
			}, PRINCIPAL, IDENTITY)).rejects.toMatchObject({ code: "resource_conflict" });
			const runtime = await backend.putRestRuntime("runtime-delete", {
				scopeId: "scope_personal", displayName: "Runtime", workspaceId: "workspace-delete", hostProfileId: "default",
				desiredState: "Running", browserPolicy: "Disabled",
			}, PRINCIPAL, IDENTITY);
			await expect(backend.deleteRestWorkspace("workspace-delete", restResourceRevision("workspace", workspace.resource), PRINCIPAL, IDENTITY))
				.rejects.toMatchObject({ code: "workspace_attached" });
			await backend.deleteRestRuntime("runtime-delete", restResourceRevision("runtime", runtime.resource), PRINCIPAL, IDENTITY);
			const deletion = authority.requests.find(request => request.init?.method === "DELETE");
			expect(JSON.parse(String(deletion?.init?.body))).toMatchObject({
				preconditions: { uid: runtime.resource.metadata.uid, resourceVersion: runtime.resource.metadata.resourceVersion },
			});
		});
	});
});

describe("Kubernetes projected identity review", () => {
	it("submits the presented bearer with the fixed audience and requires the exact server ServiceAccount", async () => {
		const directory = await mkdtemp(join(tmpdir(), "t4-token-review-"));
		try {
			await writeFile(join(directory, "token"), "reviewer-api-token", { mode: 0o400 });
			await writeFile(join(directory, "ca.crt"), "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n", { mode: 0o400 });
			await writeFile(join(directory, "namespace"), "team\n", { mode: 0o400 });
			const presentedToken = `header.payload.${"s".repeat(64)}`;
			const requests: Array<{ url: string; init?: RequestInit }> = [];
			const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(input), init });
				return Response.json({
					apiVersion: "authentication.k8s.io/v1",
					kind: "TokenReview",
					status: {
						authenticated: true,
						audiences: [CLUSTER_INTERNAL_AUDIENCE],
						user: { username: "system:serviceaccount:team:release-t4-cluster-server" },
					},
				});
			}) as typeof globalThis.fetch;
			const reviewer = new KubernetesTokenReviewer({
				baseUrl: "https://kubernetes.default.svc",
				tokenPath: join(directory, "token"),
				caPath: join(directory, "ca.crt"),
				namespacePath: join(directory, "namespace"),
				serverServiceAccountName: "release-t4-cluster-server",
				fetch,
			});
			expect(await reviewer.review(presentedToken)).toBe(true);
			expect(requests[0]?.url).toBe("https://kubernetes.default.svc/apis/authentication.k8s.io/v1/tokenreviews");
			expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer reviewer-api-token");
			expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
				apiVersion: "authentication.k8s.io/v1",
				kind: "TokenReview",
				spec: { token: presentedToken, audiences: ["t4-cluster-internal"] },
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("denies malformed, rejected, wrong-audience, wrong-username, API-status, and network responses", async () => {
		const directory = await mkdtemp(join(tmpdir(), "t4-token-review-denied-"));
		try {
			await writeFile(join(directory, "token"), "reviewer-api-token", { mode: 0o400 });
			await writeFile(join(directory, "ca.crt"), "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n", { mode: 0o400 });
			await writeFile(join(directory, "namespace"), "team", { mode: 0o400 });
			const presentedToken = `header.payload.${"s".repeat(64)}`;
			const statuses: unknown[] = [
				{ authenticated: false },
				{ authenticated: true, audiences: ["other"], user: { username: "system:serviceaccount:team:release-t4-cluster-server" } },
				{ authenticated: true, audiences: [CLUSTER_INTERNAL_AUDIENCE], user: { username: "system:serviceaccount:other:release-t4-cluster-server" } },
				{ authenticated: true, audiences: [CLUSTER_INTERNAL_AUDIENCE] },
				{ authenticated: true, error: "review failed", audiences: [CLUSTER_INTERNAL_AUDIENCE], user: { username: "system:serviceaccount:team:release-t4-cluster-server" } },
			];
			for (const status of statuses) {
				const reviewer = new KubernetesTokenReviewer({
					baseUrl: "https://kubernetes.default.svc",
					tokenPath: join(directory, "token"),
					caPath: join(directory, "ca.crt"),
					namespacePath: join(directory, "namespace"),
					serverServiceAccountName: "release-t4-cluster-server",
					fetch: (async () => Response.json({ apiVersion: "authentication.k8s.io/v1", kind: "TokenReview", status })) as unknown as typeof globalThis.fetch,
				});
				expect(await reviewer.review(presentedToken)).toBe(false);
			}
			const malformed = new KubernetesTokenReviewer({
				baseUrl: "https://kubernetes.default.svc",
				tokenPath: join(directory, "token"), caPath: join(directory, "ca.crt"), namespacePath: join(directory, "namespace"),
				serverServiceAccountName: "release-t4-cluster-server",
				fetch: (async () => new Response("{", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch,
			});
			expect(await malformed.review(presentedToken)).toBe(false);
			const unavailable = new KubernetesTokenReviewer({
				baseUrl: "https://kubernetes.default.svc",
				tokenPath: join(directory, "token"), caPath: join(directory, "ca.crt"), namespacePath: join(directory, "namespace"),
				serverServiceAccountName: "release-t4-cluster-server",
				fetch: (async () => { throw new Error("network unavailable"); }) as unknown as typeof globalThis.fetch,
			});
			expect(await unavailable.review(presentedToken)).toBe(false);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
