import { describe, expect, test } from "vite-plus/test";
import { createHash } from "node:crypto";
import type { InfrastructureEvent, SharedIssuedIdentifier } from "@t4-code/portable-control-store";
import {
	KubernetesApiError,
	type KubernetesResourceApi,
} from "../src/kubernetes-client.ts";
import {
	KubernetesDriver,
	type KubernetesDriverControlStore,
	type KubernetesDriverOptions,
} from "../src/kubernetes-driver.ts";
import {
	ClusterInfrastructureProjection,
	type KubernetesResource,
} from "../src/kubernetes-projection.ts";

const SCOPE = "scope_personal";
const PRINCIPAL = "principal_alice";
const HOST = "primary";
const NOW = Date.parse("2026-07-29T12:00:00.000Z");
const capabilities: KubernetesDriverOptions["capabilities"] = {
	apiVersion: "v1",
	protocols: {
		machineProvider: { versions: [1], capabilities: ["runtime.lifecycle"] },
		cmux: { versions: [10] },
		ompApp: { versions: [1] },
	},
	limits: { maxActiveRuntimes: 100, maxRetainedRuntimes: 1_000, idempotencyRetentionSeconds: 86_400, eventRetentionSeconds: 60, maxPageSize: 200 },
	features: { restLifecycle: true, sshProvider: false, directCmuxWebSocket: true, browser: true, scaleToZero: true },
};
const admissionPolicy: KubernetesDriverOptions["admissionPolicy"] = {
	maxActiveRuntimes: 100,
	maxRetainedRuntimes: 1_000,
	maxWorkspaceCapacityBytes: Number.MAX_SAFE_INTEGER,
	maxCpuMillis: 1_000_000,
	maxMemoryBytes: Number.MAX_SAFE_INTEGER,
	maxGpuUnits: 0,
	browserEnabled: false,
	runtimeResources: { cpuMillis: 500, memoryBytes: 1_073_741_824, gpuUnits: 0 },
	creationRate: { windowSeconds: 60, burst: 100_000, maximumRetryAfterSeconds: 30 },
};

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function cursor(scopeId: string, sequence: number): string {
	return `k1.${createHash("sha256").update(scopeId).digest("hex").slice(0, 16)}.${sequence.toString(36)}`;
}

class FakeEventStore implements KubernetesDriverControlStore {
	readonly events: InfrastructureEvent[] = [];
	readonly #waiters = new Set<() => void>();
	readonly identifiers = new Map<string, SharedIssuedIdentifier>();
	failNextMark = false;
	failNextBind = false;
	failNextReserveIdentifier = false;
	failNextAdmissionReconciliation = false;
	readonly admissionReconciliations: Array<{ readonly scopeId: string; readonly resourceKind: "workspace" | "runtime"; readonly resourceKey: string; readonly transition?: "create" | "activate" | "enableBrowser" }> = [];
	admissionDecision: { readonly outcome: "denied"; readonly reason: "active_runtime_limit" } | undefined;
	#admissionSequence = 0;
	readonly #admissions = new Set<string>();
	get admissionCount(): number { return this.#admissions.size; }
	async reserveAdmission(request: Parameters<KubernetesDriverControlStore["reserveAdmission"]>[0]) {
		if (this.admissionDecision) return this.admissionDecision;
		if (request.browserRequested && !request.policy.browserEnabled) return { outcome: "denied" as const, reason: "browser_disabled" as const };
		const reservationToken = `adm_${++this.#admissionSequence}`;
		this.#admissions.add(reservationToken);
		return { outcome: "admitted" as const, reservationToken };
	}
	async commitAdmission(reservationToken: string) { return this.#admissions.has(reservationToken) ? "committed" as const : "notFound" as const; }
	async reconcileAdmissionAbsence(request: { readonly scopeId: string; readonly resourceKind: "workspace" | "runtime"; readonly resourceKey: string; readonly transition?: "create" | "activate" | "enableBrowser" }) {
		if (this.failNextAdmissionReconciliation) {
			this.failNextAdmissionReconciliation = false;
			throw new Error("admission reconciliation unavailable");
		}
		this.admissionReconciliations.push(structuredClone(request));
		return "released" as const;
	}
	async releaseAdmission(reservationToken: string) { return this.#admissions.delete(reservationToken) ? "released" as const : "notFound" as const; }
	async appendEvent(event: InfrastructureEvent): Promise<{ event: InfrastructureEvent; cursor: string }> {
		if (this.events.some(value => value.eventId === event.eventId)) return { event, cursor: cursor(event.scopeId, this.events.filter(value => value.scopeId === event.scopeId).length) };
		this.events.push(structuredClone(event));
		for (const wake of this.#waiters) wake();
		this.#waiters.clear();
		return { event, cursor: cursor(event.scopeId, this.events.filter(value => value.scopeId === event.scopeId).length) };
	}
	async eventHeadCursor(scopeId: string): Promise<string> {
		return cursor(scopeId, this.events.filter(value => value.scopeId === scopeId).length);
	}
	async reserveIssuedIdentifier(request: Omit<SharedIssuedIdentifier, "incarnationUid" | "deletedAt" | "deletion" | "creation">) {
		if (this.failNextReserveIdentifier) {
			this.failNextReserveIdentifier = false;
			throw new Error("control store unavailable before backend");
		}
		const key = `${request.resourceKind}\0${request.resourceId}`;
		const existing = this.identifiers.get(key);
		if (existing) return { outcome: existing.scopeId === request.scopeId && existing.bindingDigest === request.bindingDigest ? "existing" as const : "conflict" as const, record: structuredClone(existing) };
		const record = structuredClone(request);
		this.identifiers.set(key, record);
		return { outcome: "reserved" as const, record };
	}
	async bindIssuedIdentifier(request: Omit<SharedIssuedIdentifier, "deletedAt" | "deletion" | "creation"> & { readonly incarnationUid: string; readonly creationOwnerToken?: string }) {
		if (this.failNextBind) {
			this.failNextBind = false;
			throw new Error("ambiguous bind response");
		}
		const key = `${request.resourceKind}\0${request.resourceId}`;
		const existing = this.identifiers.get(key);
		if (existing?.creation !== undefined && existing.creation.ownerToken !== request.creationOwnerToken)
			return { outcome: "conflict" as const, record: structuredClone(existing) };
		if (!existing || existing.scopeId !== request.scopeId || existing.bindingDigest !== request.bindingDigest || existing.deletedAt !== undefined || existing.incarnationUid !== undefined && existing.incarnationUid !== request.incarnationUid)
			return { outcome: "conflict" as const, record: structuredClone(existing ?? request) };
		if (existing.incarnationUid === request.incarnationUid) return { outcome: "existing" as const, record: structuredClone(existing) };
		const { creationOwnerToken: _creationOwnerToken, ...record } = request;
		this.identifiers.set(key, record);
		return { outcome: "bound" as const, record };
	}
	async claimIssuedIdentifierCreation(request: Pick<SharedIssuedIdentifier, "resourceKind" | "resourceId" | "bindingDigest"> & { readonly ownerToken: string; readonly now: number; readonly leaseExpiresAt: number }) {
		const key = `${request.resourceKind}\0${request.resourceId}`;
		const existing = this.identifiers.get(key);
		if (!existing) return { outcome: "notFound" as const };
		if (existing.bindingDigest !== request.bindingDigest || existing.incarnationUid !== undefined || existing.deletedAt !== undefined) return { outcome: "conflict" as const, record: structuredClone(existing) };
		if (existing.creation?.ownerToken === request.ownerToken) {
			const record = { ...existing, creation: { ownerToken: request.ownerToken, leaseExpiresAt: Math.max(existing.creation.leaseExpiresAt, request.leaseExpiresAt) } };
			this.identifiers.set(key, record);
			return { outcome: "owned" as const, record: structuredClone(record) };
		}
		if (existing.creation && existing.creation.leaseExpiresAt > request.now) return { outcome: "inProgress" as const, record: structuredClone(existing) };
		const outcome = existing.creation === undefined ? "claimed" as const : "takenOver" as const;
		const record = { ...existing, creation: { ownerToken: request.ownerToken, leaseExpiresAt: request.leaseExpiresAt } };
		this.identifiers.set(key, record);
		return { outcome, record: structuredClone(record) };
	}
	async beginIssuedIdentifierDeletion(request: Pick<SharedIssuedIdentifier, "resourceKind" | "resourceId" | "incarnationUid"> & { readonly expectedRevision: string; readonly backendRevision: string; readonly requestedAt: string }) {
		const key = `${request.resourceKind}\0${request.resourceId}`;
		const existing = this.identifiers.get(key);
		if (!existing) return { outcome: "notFound" as const };
		if (existing.incarnationUid !== request.incarnationUid || existing.deletedAt !== undefined) return { outcome: "conflict" as const, record: structuredClone(existing) };
		if (existing.deletion) {
			const outcome = existing.deletion.expectedRevision === request.expectedRevision && existing.deletion.backendRevision === request.backendRevision ? "existing" as const : "conflict" as const;
			return { outcome, record: structuredClone(existing) };
		}
		const record = { ...existing, deletion: { expectedRevision: request.expectedRevision, backendRevision: request.backendRevision, requestedAt: request.requestedAt } };
		this.identifiers.set(key, record);
		return { outcome: "begun" as const, record: structuredClone(record) };
	}
	async cancelIssuedIdentifierDeletion(request: Pick<SharedIssuedIdentifier, "resourceKind" | "resourceId" | "incarnationUid"> & { readonly expectedRevision: string; readonly backendRevision: string }) {
		const key = `${request.resourceKind}\0${request.resourceId}`;
		const existing = this.identifiers.get(key);
		if (!existing) return { outcome: "notFound" as const };
		if (existing.incarnationUid !== request.incarnationUid || existing.deletedAt !== undefined) return { outcome: "conflict" as const, record: structuredClone(existing) };
		if (!existing.deletion) return { outcome: "alreadyClear" as const, record: structuredClone(existing) };
		if (existing.deletion.expectedRevision !== request.expectedRevision || existing.deletion.backendRevision !== request.backendRevision)
			return { outcome: "conflict" as const, record: structuredClone(existing) };
		const { deletion: _deletion, ...record } = existing;
		this.identifiers.set(key, record);
		return { outcome: "cancelled" as const, record: structuredClone(record) };
	}
	async markIssuedIdentifierDeleted(request: Pick<SharedIssuedIdentifier, "resourceKind" | "resourceId" | "incarnationUid"> & { readonly deletedAt: string }) {
		if (this.failNextMark) {
			this.failNextMark = false;
			throw new Error("ambiguous ledger response");
		}
		const key = `${request.resourceKind}\0${request.resourceId}`;
		const existing = this.identifiers.get(key);
		if (!existing) return { outcome: "notFound" as const };
		if (existing.incarnationUid !== request.incarnationUid) return { outcome: "conflict" as const, record: structuredClone(existing) };
		if (existing.deletedAt !== undefined) return { outcome: "existing" as const, record: structuredClone(existing) };
		const record: SharedIssuedIdentifier = { scopeId: existing.scopeId, resourceKind: existing.resourceKind, resourceId: existing.resourceId, bindingDigest: existing.bindingDigest, incarnationUid: request.incarnationUid, deletedAt: request.deletedAt };
		this.identifiers.set(key, record);
		return { outcome: "deleted" as const, record: structuredClone(record) };
	}
	async getIssuedIdentifier(resourceKind: "workspace" | "runtime", resourceId: string): Promise<SharedIssuedIdentifier | undefined> {
		const selected = this.identifiers.get(`${resourceKind}\0${resourceId}`);
		return selected ? structuredClone(selected) : undefined;
	}
	async readAfter(request: { readonly scopeId: string; readonly cursor: string; readonly limit?: number }) {
		const match = /^k1\.[a-f0-9]{16}\.([0-9a-z]+)$/u.exec(request.cursor);
		if (!match) throw new TypeError("invalid cursor");
		const sequence = Number.parseInt(match[1]!, 36);
		const scoped = this.events.filter(value => value.scopeId === request.scopeId);
		const selected = scoped.slice(sequence, sequence + (request.limit ?? 200));
		return { outcome: "events" as const, events: selected, cursor: cursor(request.scopeId, sequence + selected.length) };
	}
	async *subscribe(request: { readonly scopeId: string; readonly cursor: string; readonly signal?: AbortSignal; readonly pollMilliseconds?: number; readonly batchLimit?: number }) {
		let current = request.cursor;
		while (!request.signal?.aborted) {
			const outcome = await this.readAfter({ scopeId: request.scopeId, cursor: current, limit: request.batchLimit });
			if (outcome.events.length > 0) { current = outcome.cursor; yield outcome; continue; }
			await new Promise<void>(resolve => {
				const finish = (): void => { this.#waiters.delete(finish); request.signal?.removeEventListener("abort", finish); resolve(); };
				this.#waiters.add(finish);
				request.signal?.addEventListener("abort", finish, { once: true });
				if (request.signal?.aborted) finish();
			});
		}
	}
}

class FakeKubernetesApi implements KubernetesResourceApi {
	readonly namespace = "private-namespace";
	readonly #projection: ClusterInfrastructureProjection;
	readonly #resources: Record<string, Map<string, KubernetesResource>> = {
		t4workspaces: new Map(),
		t4sessions: new Map(),
	};
	#version = 10;
	#generation = 0;
	conflictNextUpdate = false;
	conflictNextDelete = false;
	createCount = 0;

	constructor(projection: ClusterInfrastructureProjection) { this.#projection = projection; }
	async list(resource: string, _limit: number): Promise<{ items: KubernetesResource[]; resourceVersion: string }> {
		return { items: [...(this.#resources[resource]?.values() ?? [])].map(value => structuredClone(value)), resourceVersion: String(this.#version) };
	}
	async create(resource: string, body: unknown): Promise<KubernetesResource> {
		this.createCount++;
		const input = structuredClone(body) as KubernetesResource;
		const values = this.#resources[resource];
		if (!values) throw new KubernetesApiError(404, "missing collection");
		if (values.has(input.metadata.name)) throw new KubernetesApiError(409, "already exists");
		const created = this.#reconcile({
			...input,
			metadata: {
				...input.metadata,
				uid: `uid-${createHash("sha256").update(input.metadata.name).digest("hex").slice(0, 12)}`,
				resourceVersion: String(++this.#version),
				generation: 1,
				creationTimestamp: new Date(NOW).toISOString(),
			},
		});
		values.set(created.metadata.name, created);
		this.#projection.applyWatch({ type: "ADDED", object: created });
		return structuredClone(created);
	}
	async get(resource: string, name: string): Promise<KubernetesResource> {
		const selected = this.#resources[resource]?.get(name);
		if (!selected) throw new KubernetesApiError(404, "not found");
		return structuredClone(selected);
	}
	async update(resource: string, name: string, body: unknown): Promise<KubernetesResource> {
		const current = this.#resources[resource]?.get(name);
		if (!current) throw new KubernetesApiError(404, "not found");
		const input = structuredClone(body) as KubernetesResource;
		if (input.metadata.resourceVersion !== current.metadata.resourceVersion) throw new KubernetesApiError(409, "conflict");
		if (this.conflictNextUpdate) {
			this.conflictNextUpdate = false;
			const conflicted = {
				...current,
				metadata: { ...current.metadata, resourceVersion: String(++this.#version) },
				status: { ...object(current.status), phase: "Pending", observedGeneration: current.metadata.generation },
			};
			this.#resources[resource]!.set(name, conflicted);
			this.#projection.applyWatch({ type: "MODIFIED", object: conflicted });
			throw new KubernetesApiError(409, "conflict");
		}
		const changed = JSON.stringify(input.spec) !== JSON.stringify(current.spec);
		const updated = this.#reconcile({
			...input,
			metadata: { ...input.metadata, resourceVersion: String(++this.#version), generation: (current.metadata.generation ?? 1) + (changed ? 1 : 0) },
		});
		this.#resources[resource]!.set(name, updated);
		this.#projection.applyWatch({ type: "MODIFIED", object: updated });
		return structuredClone(updated);
	}
	async delete(resource: string, name: string, preconditions: { readonly uid: string; readonly resourceVersion: string }): Promise<unknown> {
		const current = this.#resources[resource]?.get(name);
		if (!current) throw new KubernetesApiError(404, "not found");
		if (this.conflictNextDelete) {
			this.conflictNextDelete = false;
			const conflicted = { ...current, metadata: { ...current.metadata, resourceVersion: String(++this.#version) } };
			this.#resources[resource]!.set(name, conflicted);
			this.#projection.applyWatch({ type: "MODIFIED", object: conflicted });
			throw new KubernetesApiError(409, "conflict");
		}
		if (current.metadata.uid !== preconditions.uid || current.metadata.resourceVersion !== preconditions.resourceVersion) throw new KubernetesApiError(409, "conflict");
		this.#resources[resource]!.delete(name);
		this.#projection.applyWatch({ type: "DELETED", object: current });
		return {};
	}
	replaceRuntime(publicId: string, change: (resource: KubernetesResource) => KubernetesResource): void {
		const selected = [...this.#resources.t4sessions.values()].find(value => object(value.spec).publicId === publicId);
		if (!selected) throw new Error("runtime missing");
		const replacement = change(structuredClone(selected));
		const updated = { ...replacement, metadata: { ...replacement.metadata, resourceVersion: String(++this.#version) } };
		this.#resources.t4sessions.set(updated.metadata.name, updated);
		this.#projection.applyWatch({ type: "MODIFIED", object: updated });
	}
	#reconcile(resource: KubernetesResource): KubernetesResource {
		if (resource.kind === "T4Workspace") return { ...resource, status: { phase: "Ready", capacity: object(resource.spec).size, observedGeneration: resource.metadata.generation, conditions: [] } };
		if (resource.kind !== "T4Session") return resource;
		const desiredState = object(resource.spec).desiredState;
		const running = desiredState === "Running";
		const generationIndex = running ? ++this.#generation : this.#generation === 0 ? ++this.#generation : this.#generation;
		const generation = `gen_runtime_${String(generationIndex).padStart(4, "0")}`;
		const service = running ? `service-private-${generationIndex}` : undefined;
		return {
			...resource,
			status: {
				observedGeneration: resource.metadata.generation,
				runtimeGeneration: generation,
				phase: running ? "Ready" : desiredState,
				fenceState: "FenceProven",
				serviceName: service,
				serviceUid: running ? `service-uid-${generationIndex}` : undefined,
				podName: running ? `pod-private-${generationIndex}` : undefined,
				podIP: "10.244.9.17",
				clusterIP: "10.96.4.20",
				credentials: "never-return-this",
				conditions: [
					{ type: "Fenced", status: "True", reason: "FenceProven", observedGeneration: resource.metadata.generation, lastTransitionTime: new Date(NOW).toISOString() },
					{ type: "RouteReady", status: running ? "True" : "False", reason: running ? "CompositeReadinessProven" : "NotRunning", observedGeneration: resource.metadata.generation, lastTransitionTime: new Date(NOW).toISOString() },
				],
			},
		};
	}
}

function setup() {
	const projection = new ClusterInfrastructureProjection({ epoch: "driver-test", namespace: "private-namespace" });
	projection.replace({
		host: { apiVersion: "cluster.t4.dev/v1alpha1", kind: "T4ClusterHost", metadata: { name: HOST, uid: "host-uid", resourceVersion: "1" }, spec: {} },
		workspaces: [], sessions: [], resourceVersion: "1",
	});
	const api = new FakeKubernetesApi(projection);
	const events = new FakeEventStore();
	const driver = new KubernetesDriver({
		api, projection, controlStore: events, initialEventCursors: { [SCOPE]: cursor(SCOPE, 0) }, hostRef: HOST,
		scopes: [{ id: SCOPE, principal: PRINCIPAL, displayName: "Personal", kind: "Personal" }],
		capabilities, admissionPolicy, now: () => NOW, random: bytes => new Uint8Array(bytes).fill(7), watchPollMilliseconds: 1,
	});
	return { api, driver, events, projection };
}
async function createWorkspace(driver: KubernetesDriver) {
	const result = await driver.createWorkspace({ id: "ws_public", scopeId: SCOPE, displayName: "Workspace", capacityBytes: 20 * 1024 ** 3, retention: "Retain" });
	expect(result.outcome).toBe("created");
	if (result.outcome !== "created") throw new Error("workspace create failed");
	return result.resource;
}
async function createRuntime(driver: KubernetesDriver, desiredState: "Running" | "Sleeping" | "Stopped" = "Running") {
	await createWorkspace(driver);
	const result = await driver.createRuntime({ id: "rt_public", scopeId: SCOPE, workspaceId: "ws_public", displayName: "Runtime", hostProfileId: "default", desiredState, browserPolicy: "Disabled" });
	expect(result.outcome).toBe("created");
	if (result.outcome !== "created") throw new Error("runtime create failed");
	return result.resource;
}


describe("KubernetesDriver", () => {
	test("matches LocalDriver create/list/update and wake/sleep/stop outcomes with exact CAS", async () => {
		const { api, driver, events } = setup();
		const workspace = await createWorkspace(driver);
		expect((await driver.createWorkspace({ id: workspace.id, scopeId: SCOPE, displayName: "Other", capacityBytes: workspace.capacityBytes, retention: "Retain" })).outcome).toBe("alreadyIssued");
		const created = await driver.createRuntime({ id: "rt_public", scopeId: SCOPE, workspaceId: workspace.id, displayName: "Runtime", hostProfileId: "default", desiredState: "Sleeping", browserPolicy: "Disabled" });
		expect(created.outcome).toBe("created");
		if (created.outcome !== "created") return;
		expect(driver.resolveRuntimeRoute(created.resource.id, "omp-app-v1", created.resource.generation)).toEqual({ outcome: "notReady" });
		const attached = driver.getWorkspace(workspace.id);
		expect(attached).toMatchObject({ outcome: "found", resource: { attachmentCount: 1 } });
		expect(attached.outcome === "found" && attached.resource.revision).not.toBe(workspace.revision);
		const woke = await driver.setRuntimeDesiredState(created.resource.id, "Running", created.resource.revision);
		expect(woke).toMatchObject({ outcome: "updated", resource: { desiredState: "Running", phase: "Starting" } });
		if (woke.outcome !== "updated") return;
		const slept = await driver.setRuntimeDesiredState(woke.resource.id, "Sleeping", woke.resource.revision);
		expect(slept).toMatchObject({ outcome: "updated", resource: { desiredState: "Sleeping", phase: "Sleeping" } });
		if (slept.outcome !== "updated") return;
		expect(events.admissionReconciliations).toContainEqual({ scopeId: SCOPE, resourceKind: "runtime", resourceKey: slept.resource.id, transition: "activate" });
		events.failNextAdmissionReconciliation = true;
		expect(await driver.setRuntimeDesiredState(slept.resource.id, "Sleeping", slept.resource.revision))
			.toEqual({ outcome: "invalidState", reason: "AdmissionReconciliationUnavailable" });
		const stopped = await driver.setRuntimeDesiredState(slept.resource.id, "Stopped", slept.resource.revision);
		expect(stopped).toMatchObject({ outcome: "updated", resource: { desiredState: "Stopped", phase: "Stopped" } });
		if (stopped.outcome !== "updated") return;
		expect(await driver.setRuntimeDesiredState(stopped.resource.id, "Stopped", stopped.resource.revision)).toEqual({ outcome: "updated", resource: stopped.resource });
		api.conflictNextUpdate = true;
		const conflict = await driver.updateRuntime(stopped.resource.id, { displayName: "Renamed" }, stopped.resource.revision);
		expect(conflict).toMatchObject({ outcome: "revisionMismatch", currentRevision: expect.any(String) });
		await driver.close();
	});
	test("rejects admission before creating a Kubernetes workload resource", async () => {
		const { api, driver, events } = setup();
		events.admissionDecision = { outcome: "denied", reason: "active_runtime_limit" };
		const before = api.createCount;
		const result = await driver.createWorkspace({ id: "ws_denied", scopeId: SCOPE, displayName: "Denied", capacityBytes: 1_048_576, retention: "Retain" });
		expect(result).toEqual({ outcome: "admissionDenied", reason: "active_runtime_limit" });
		expect(api.createCount).toBe(before);
		await driver.close();
	});
	test("releases admission when identifier reservation fails before the backend is invoked", async () => {
		const { api, driver, events } = setup();
		events.failNextReserveIdentifier = true;
		const before = api.createCount;
		expect(await driver.createWorkspace({ id: "ws_prebackend_failure", scopeId: SCOPE, displayName: "Failure", capacityBytes: 1_048_576, retention: "Retain" }))
			.toEqual({ outcome: "invalidState", reason: "KubernetesAuthorityUnavailable" });
		expect(api.createCount).toBe(before);
		expect(events.admissionCount).toBe(0);
		await driver.close();
	});
	test("denies enabling browser resources under a disabled scope policy", async () => {
		const { driver } = setup();
		const runtime = await createRuntime(driver, "Stopped");
		expect(await driver.updateRuntime(runtime.id, { browserPolicy: "Allowed" }, runtime.revision))
			.toEqual({ outcome: "admissionDenied", reason: "browser_disabled" });
		await driver.close();
	});


	test("serializes identical creates across driver replicas", async () => {
		const { api, driver: first, events, projection } = setup();
		const second = new KubernetesDriver({
			api, projection, controlStore: events, initialEventCursors: { [SCOPE]: cursor(SCOPE, 0) }, hostRef: HOST,
			scopes: [{ id: SCOPE, principal: PRINCIPAL, displayName: "Personal", kind: "Personal" }],
			capabilities, admissionPolicy, now: () => NOW, random: bytes => new Uint8Array(bytes).fill(8), watchPollMilliseconds: 1,
		});
		const workspaceRequest = { id: "ws_concurrent", scopeId: SCOPE, displayName: "Concurrent", capacityBytes: 1_048_576, retention: "Retain" as const };
		const workspaceOutcomes = await Promise.all([first.createWorkspace(workspaceRequest), second.createWorkspace(workspaceRequest)]);
		expect(workspaceOutcomes.map(value => value.outcome).sort()).toEqual(["alreadyIssued", "created"]);
		const runtimeRequest = { id: "rt_concurrent", scopeId: SCOPE, workspaceId: "ws_concurrent", displayName: "Concurrent", hostProfileId: "default", desiredState: "Stopped" as const, browserPolicy: "Disabled" as const };
		const runtimeOutcomes = await Promise.all([first.createRuntime(runtimeRequest), second.createRuntime(runtimeRequest)]);
		expect(runtimeOutcomes.map(value => value.outcome).sort()).toEqual(["alreadyIssued", "created"]);
		await Promise.all([first.close(), second.close()]);
	});


	test("returns the current opaque workspace revision after a Kubernetes resourceVersion conflict", async () => {
		const { api, driver } = setup();
		const value = await createWorkspace(driver);
		api.conflictNextUpdate = true;
		const conflict = await driver.updateWorkspace(value.id, { displayName: "Renamed" }, value.revision);
		expect(conflict).toMatchObject({ outcome: "revisionMismatch", currentRevision: expect.any(String) });
		if (conflict.outcome === "revisionMismatch") expect(conflict.currentRevision).not.toBe(value.revision);
		await driver.close();
	});

	test("preserves attached-workspace deletion rules and deterministic delete retries", async () => {
		const { driver } = setup();
		const value = await createRuntime(driver, "Stopped");
		const attached = driver.getWorkspace(value.workspaceId);
		expect(attached.outcome).toBe("found");
		if (attached.outcome !== "found") return;
		expect(await driver.deleteWorkspace(attached.resource.id, attached.resource.revision)).toEqual({ outcome: "invalidState", reason: "WorkspaceAttached" });
		expect(await driver.deleteRuntime(value.id, value.revision)).toEqual({ outcome: "deleted" });
		expect(await driver.deleteRuntime(value.id, value.revision)).toEqual({ outcome: "deleted" });
		const detached = driver.getWorkspace(value.workspaceId);
		expect(detached).toMatchObject({ outcome: "found", resource: { attachmentCount: 0 } });
		if (detached.outcome !== "found") return;
		expect(await driver.deleteWorkspace(detached.resource.id, detached.resource.revision)).toEqual({ outcome: "deleted" });
		expect(await driver.deleteWorkspace(detached.resource.id, detached.resource.revision)).toEqual({ outcome: "deleted" });
		expect((await driver.createRuntime({ id: value.id, scopeId: SCOPE, workspaceId: value.workspaceId, displayName: "Replacement", hostProfileId: "default", desiredState: "Stopped", browserPolicy: "Disabled" })).outcome).toBe("alreadyIssued");
		expect((await driver.createWorkspace({ id: detached.resource.id, scopeId: SCOPE, displayName: "Replacement", capacityBytes: detached.resource.capacityBytes, retention: "Retain" })).outcome).toBe("alreadyIssued");
		await driver.close();
	});

	test("recovers an original create whose Kubernetes object preceded identifier binding", async () => {
		const { driver, events } = setup();
		const workspace = await createWorkspace(driver);
		events.failNextBind = true;
		const request = { id: "rt_bind_recovery", scopeId: SCOPE, workspaceId: workspace.id, displayName: "Recovered", hostProfileId: "default", desiredState: "Stopped" as const, browserPolicy: "Disabled" as const };
		expect((await driver.createRuntime(request)).outcome).toBe("invalidState");
		const recovered = await driver.createRuntime(request);
		expect(recovered.outcome).toBe("created");
		events.failNextBind = true;
		const workspaceRequest = { id: "ws_bind_recovery", scopeId: SCOPE, displayName: "Recovered workspace", capacityBytes: 1_048_576, retention: "Retain" as const };
		expect((await driver.createWorkspace(workspaceRequest)).outcome).toBe("invalidState");
		expect((await driver.createWorkspace(workspaceRequest)).outcome).toBe("created");
		await driver.close();
	});

	test("reconciles a successful Kubernetes delete after an ambiguous ledger completion", async () => {
		const { driver, events } = setup();
		const value = await createRuntime(driver, "Stopped");
		events.failNextMark = true;
		expect(await driver.deleteRuntime(value.id, value.revision)).toEqual({ outcome: "invalidState", reason: "KubernetesControlStoreUnavailable" });
		expect(await driver.deleteRuntime(value.id, value.revision)).toEqual({ outcome: "deleted" });
		await driver.close();
	});

	test("clears a rejected delete intent so the current revision can be retried", async () => {
		const { api, driver } = setup();
		const value = await createRuntime(driver, "Stopped");
		api.conflictNextDelete = true;
		const conflicted = await driver.deleteRuntime(value.id, value.revision);
		expect(conflicted.outcome).toBe("revisionMismatch");
		if (conflicted.outcome !== "revisionMismatch") return;
		expect(await driver.deleteRuntime(value.id, conflicted.currentRevision)).toEqual({ outcome: "deleted" });
		await driver.close();
	});

	test("fails closed for uncertain fencing and stale generations", async () => {
		const { api, driver } = setup();
		const value = await createRuntime(driver);
		api.replaceRuntime(value.id, resource => ({
			...resource,
			status: {
				...object(resource.status), phase: "Degraded", fenceState: "FenceUncertain", serviceName: undefined,
				conditions: [
					{ type: "Fenced", status: "False", reason: "FenceUncertain", observedGeneration: resource.metadata.generation, lastTransitionTime: new Date(NOW).toISOString() },
					{ type: "RouteReady", status: "False", reason: "FenceUncertain", observedGeneration: resource.metadata.generation, lastTransitionTime: new Date(NOW).toISOString() },
				],
			},
		}));
		const uncertain = driver.getRuntime(value.id);
		expect(uncertain).toMatchObject({ outcome: "found", resource: { phase: "Degraded" } });
		if (uncertain.outcome !== "found") return;
		expect(driver.resolveRuntimeRoute(value.id, "omp-app-v1", uncertain.resource.generation)).toEqual({ outcome: "fenceUncertain" });
		expect(driver.resolveRuntimeRoute(value.id, "omp-app-v1", "gen_stale_0001")).toEqual({ outcome: "staleGeneration" });
		expect(await driver.setRuntimeDesiredState(value.id, "Running", uncertain.resource.revision)).toEqual({ outcome: "invalidState", reason: "ManualFenceRecoveryRequired" });
		expect(await driver.recoverRuntimeFence(value.id, uncertain.resource.revision)).toEqual({ outcome: "invalidState", reason: "KubernetesFenceRecoveryUnsupported" });
		await driver.close();
	});

	test("returns generation-bound opaque Service routes and replaces them without leaking backend addresses", async () => {
		const { api, driver } = setup();
		expect(driver.resolveRuntimeRoute("rt_missing", "omp-app-v1", "gen_missing_0001")).toEqual({ outcome: "notFound" });
		const value = await createRuntime(driver);
		const first = driver.resolveRuntimeRoute(value.id, "omp-app-v1", value.generation);
		expect(first.outcome).toBe("resolved");
		if (first.outcome !== "resolved") return;
		const serialized = JSON.stringify(first);
		for (const secret of ["private-namespace", "service-private", "service-uid", "pod-private", "10.244.9.17", "10.96.4.20", "never-return-this", PRINCIPAL]) expect(serialized).not.toContain(secret);
		expect(driver.resolveRuntimeRoute(value.id, "unknown" as "cmux-v10", value.generation)).toEqual({ outcome: "unsupported" });
		api.replaceRuntime(value.id, resource => ({ ...resource, status: { ...object(resource.status), observedGeneration: (resource.metadata.generation ?? 1) - 1 } }));
		expect(driver.resolveRuntimeRoute(value.id, "omp-app-v1", value.generation)).toEqual({ outcome: "notReady" });
		api.replaceRuntime(value.id, resource => ({ ...resource, status: { ...object(resource.status), observedGeneration: resource.metadata.generation, serviceUid: undefined } }));
		expect(driver.resolveRuntimeRoute(value.id, "omp-app-v1", value.generation)).toEqual({ outcome: "notReady" });
		api.replaceRuntime(value.id, resource => ({ ...resource, status: { ...object(resource.status), observedGeneration: resource.metadata.generation, serviceName: "replacement-service", serviceUid: "replacement-service-uid" } }));
		const replacement = driver.resolveRuntimeRoute(value.id, "omp-app-v1", value.generation);
		expect(replacement.outcome).toBe("resolved");
		if (replacement.outcome === "resolved") expect(replacement.route.reference).not.toBe(first.route.reference);
		await driver.close();
	});

	test("publishes bounded per-scope events and close aborts active watches", async () => {
		const { driver } = setup();
		const initial = driver.listWorkspaces(SCOPE).highWaterCursor;
		await createWorkspace(driver);
		expect(driver.listWorkspaces(SCOPE).highWaterCursor).not.toBe(initial);
		const replay = await driver.listInfrastructureEvents(SCOPE, initial, 2);
		expect(replay).toMatchObject({ outcome: "events", events: expect.arrayContaining([expect.objectContaining({ resourceKind: "workspace", resourceId: "ws_public", scopeId: SCOPE })]) });
		if (replay.outcome !== "events") return;
		const watch = driver.watchInfrastructureEvents(SCOPE, replay.cursor)[Symbol.asyncIterator]();
		for (let discarded = 0; discarded < 100; discarded++) driver.watchInfrastructureEvents(SCOPE, replay.cursor);
		const pending = watch.next();
		const created = await driver.createRuntime({ id: "rt_public", scopeId: SCOPE, workspaceId: "ws_public", displayName: "Runtime", hostProfileId: "default", desiredState: "Stopped", browserPolicy: "Disabled" });
		expect(created.outcome).toBe("created");
		const watchedEvents: InfrastructureEvent[] = [];
		for (let attempt = 0; attempt < 3; attempt++) {
			const watched = attempt === 0 ? await pending : await watch.next();
			if (watched.done) break;
			if (watched.value.outcome === "events") watchedEvents.push(...watched.value.events);
			if (watchedEvents.some(event => event.resourceKind === "runtime" && event.resourceId === "rt_public")) break;
		}
		expect(watchedEvents).toEqual(expect.arrayContaining([expect.objectContaining({ resourceKind: "runtime", resourceId: "rt_public" })]));
		const closing = watch.next();
		await driver.close();
		expect(await closing).toEqual({ value: undefined, done: true });
		expect(() => driver.watchInfrastructureEvents(SCOPE, replay.cursor)).toThrow("closed");
		expect(await driver.close()).toBeUndefined();
	});
});
