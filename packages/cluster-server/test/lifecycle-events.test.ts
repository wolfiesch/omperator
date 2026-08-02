import { describe, expect, it } from "vite-plus/test";
import {
	LifecycleEventCapacityError, LifecycleEventConflictError, LifecycleProjectionNotifier,
	SharedLifecycleEventLedger, encodeLifecycleSse, publicLifecycleScopeId,
	type LifecycleEventStorage, type LifecycleLedgerSnapshot, type LifecycleLedgerState,
} from "../src/lifecycle-events.ts";
import { ClusterInfrastructureProjection, REST_PUBLIC_ID_ANNOTATION, REST_REVISION_ANNOTATION, type KubernetesResource } from "../src/kubernetes-projection.ts";
import { createClusterRestHandler } from "../src/rest-handler.ts";
import type { RequestIdentity } from "../src/identity.ts";

const OWNER = "owner@example.test";
const FOREIGN = "foreign@example.test";
const START = Date.parse("2026-07-29T12:00:00.000Z");
function identity(principalId: string): RequestIdentity {
	return Object.freeze({
		principalId,
		authorizedScopes: Object.freeze([]),
		adapter: Object.freeze({ id: "test", type: "tailscale" }),
		policyRevision: "test-1",
	});
}
class MemoryStorage implements LifecycleEventStorage {
	state?: LifecycleLedgerState; version = 0; reads = 0;
	async read(): Promise<LifecycleLedgerSnapshot | undefined> { this.reads++; return this.state ? { resourceVersion: String(this.version), state: structuredClone(this.state) } : undefined; }
	async create(state: LifecycleLedgerState): Promise<LifecycleLedgerSnapshot> { if (this.state) throw new LifecycleEventConflictError(); this.state = structuredClone(state); this.version++; return { resourceVersion: String(this.version), state: structuredClone(this.state) }; }
	async replace(resourceVersion: string, state: LifecycleLedgerState): Promise<LifecycleLedgerSnapshot> { if (resourceVersion !== String(this.version)) throw new LifecycleEventConflictError(); this.state = structuredClone(state); this.version++; return { resourceVersion: String(this.version), state: structuredClone(this.state) }; }
}
function input(revision: string, principal = OWNER, resourceId = "rt_public") { return { principal, resourceKind: "runtime" as const, resourceId, scopeId: publicLifecycleScopeId(principal), revision, phase: "Ready", timestamp: new Date(START).toISOString() }; }
async function nextFrame(response: Response): Promise<string> { const result = await response.body!.getReader().read(); if (result.done) throw new Error("event stream ended before a frame was emitted"); return new TextDecoder().decode(result.value); }
function data(frame: string): Record<string, unknown> { const line = frame.split("\n").find(value => value.startsWith("data: ")); if (!line) throw new Error("SSE data line is missing"); return JSON.parse(line.slice(6)) as Record<string, unknown>; }

describe("shared lifecycle event ledger", () => {
	it("encodes the exact three-field SSE wire frame with one JSON data line", () => {
		const value = { eventId: "evt_1", event: "invalidation" as const, resourceKind: "runtime" as const, resourceId: "rt_public", scopeId: "scope_public", revision: "rev_public", phase: "Ready", timestamp: "2026-07-29T12:00:00.000Z" };
		expect(new TextDecoder().decode(encodeLifecycleSse(value))).toBe(`id: evt_1\nevent: invalidation\ndata: ${JSON.stringify(value)}\n\n`);
	});
	it("resumes strictly after a retained event ID and survives source recreation", async () => {
		const storage = new MemoryStorage(); const firstSource = new SharedLifecycleEventLedger({ storage, now: () => START });
		const first = await firstSource.append(input("rev_1")); const second = await firstSource.append(input("rev_2")); firstSource.close();
		const recreated = new SharedLifecycleEventLedger({ storage, now: () => START }); const controller = new AbortController(); const response = await recreated.response(OWNER, first.eventId, controller.signal);
		expect(response.headers.get("content-type")).toBe("text/event-stream"); expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.headers.get("x-accel-buffering")).toBe("no"); expect(data(await nextFrame(response))).toEqual(second);
		controller.abort(); expect(recreated.connectionCount).toBe(0); recreated.close();
	});
	it("emits a fresh typed reset for unknown, expired, foreign-principal, and out-of-scope cursors", async () => {
		let now = START;
		const storage = new MemoryStorage();
		const source = new SharedLifecycleEventLedger({ storage, now: () => now });
		const owner = await source.append(input("rev_owner"));
		const foreign = await source.append(input("rev_foreign", FOREIGN, "rt_foreign"));
		const otherScope = await source.append({ ...input("rev_other_scope", OWNER, "rt_other"), scopeId: "scope_other" });
		const resetIds: string[] = [];
		for (const cursor of ["evt_unknown", "evt_unknown", foreign.eventId, otherScope.eventId]) {
			const abort = new AbortController();
			const reset = data(await nextFrame(await source.response(OWNER, cursor, abort.signal, publicLifecycleScopeId(OWNER))));
			expect(reset).toMatchObject({ event: "reset", reason: "cursor_expired" });
			expect(JSON.stringify(reset)).not.toContain("foreign");
			resetIds.push(String(reset.eventId));
			abort.abort();
		}
		expect(resetIds[0]).not.toBe(resetIds[1]);
		now += 60_001;
		const abort = new AbortController();
		const expired = data(await nextFrame(await source.response(OWNER, owner.eventId, abort.signal, publicLifecycleScopeId(OWNER))));
		expect(expired).toMatchObject({ event: "reset", reason: "cursor_expired" });
		expect(resetIds).not.toContain(expired.eventId);
		abort.abort();
		source.close();
	});
	it("prunes only events older than 60 seconds and fails closed at count and byte caps", async () => {
		let now = START; const storage = new MemoryStorage(); const source = new SharedLifecycleEventLedger({ storage, now: () => now, maxCount: 2, maxBytes: 4_096 });
		await source.append(input("rev_1")); await source.append(input("rev_2")); await expect(source.append(input("rev_3"))).rejects.toBeInstanceOf(LifecycleEventCapacityError);
		now += 60_001; await expect(source.append({ ...input("rev_3"), timestamp: new Date(now).toISOString() })).resolves.toMatchObject({ revision: "rev_3" }); expect(storage.state?.events).toHaveLength(1); source.close();
		const bytesStorage = new MemoryStorage(); const bytes = new SharedLifecycleEventLedger({ storage: bytesStorage, now: () => START, maxCount: 10, maxBytes: 512 });
		await expect(bytes.append(input(`rev_${"x".repeat(120)}`, OWNER, `rt_${"y".repeat(120)}`))).rejects.toBeInstanceOf(LifecycleEventCapacityError); bytes.close();
	});
	it("atomically orders concurrent replica appends and deduplicates the same public resource revision", async () => {
		const storage = new MemoryStorage(); const replicaA = new SharedLifecycleEventLedger({ storage, now: () => START }); const replicaB = new SharedLifecycleEventLedger({ storage, now: () => START });
		const [sameA, sameB] = await Promise.all([replicaA.append(input("rev_same")), replicaB.append(input("rev_same"))]); expect(sameA.eventId).toBe(sameB.eventId);
		const [nextA, nextB] = await Promise.all([replicaA.append(input("rev_a", OWNER, "rt_a")), replicaB.append(input("rev_b", OWNER, "rt_b"))]); expect(new Set([nextA.eventId, nextB.eventId]).size).toBe(2); expect(storage.state?.events.map(event => event.sequence)).toEqual([1, 2, 3]); replicaA.close(); replicaB.close();
	});
	it("deduplicates only an identical latest revision and phase while preserving phase transitions", async () => {
		const storage = new MemoryStorage();
		const source = new SharedLifecycleEventLedger({ storage, now: () => START });
		const ready = await source.append(input("rev_stable"));
		expect((await source.append(input("rev_stable"))).eventId).toBe(ready.eventId);
		const starting = await source.append({ ...input("rev_stable"), phase: "Starting" });
		const readyAgain = await source.append(input("rev_stable"));
		expect(starting.eventId).not.toBe(ready.eventId);
		expect(readyAgain.eventId).not.toBe(ready.eventId);
		expect((await source.append(input("rev_stable"))).eventId).toBe(readyAgain.eventId);
		expect(storage.state?.events.map(event => event.phase)).toEqual(["Ready", "Starting", "Ready"]);
		source.close();
	});
	it("removes connection-local subscriber state on request abort and source drain", async () => {
		const source = new SharedLifecycleEventLedger({ storage: new MemoryStorage(), now: () => START });
		const abort = new AbortController();
		const response = await source.response(OWNER, undefined, abort.signal);
		expect(source.connectionCount).toBe(1);
		const aborted = response.body!.getReader().read();
		abort.abort();
		expect(await aborted).toEqual({ done: true, value: undefined });
		expect(source.connectionCount).toBe(0);
		const draining = await source.response(OWNER, undefined, new AbortController().signal);
		const drained = draining.body!.getReader().read();
		expect(source.connectionCount).toBe(1);
		source.close();
		expect(await drained).toEqual({ done: true, value: undefined });
		expect(source.connectionCount).toBe(0);
	});
});

function workspace(owner = OWNER, phase = "Ready", resourceVersion = "2"): KubernetesResource { return { apiVersion: "cluster.t4.dev/v1alpha1", kind: "T4Workspace", metadata: { name: `workspace-${owner === OWNER ? "owner" : "foreign"}`, uid: `uid-${owner}`, resourceVersion, creationTimestamp: "2026-07-29T11:00:00Z", annotations: { [REST_PUBLIC_ID_ANNOTATION]: owner === OWNER ? "ws_public" : "ws_foreign", [REST_REVISION_ANNOTATION]: "workspace-base" } }, spec: { hostRef: "primary", owner, displayName: "Workspace", size: "20Gi", retentionPolicy: "Retain" }, status: { observedGeneration: Number(resourceVersion), phase, capacity: "20Gi" } }; }
function runtime(owner = OWNER, phase = "Pending", resourceVersion = "3"): KubernetesResource { return { apiVersion: "cluster.t4.dev/v1alpha1", kind: "T4Session", metadata: { name: `runtime-${owner === OWNER ? "owner" : "foreign"}`, uid: `runtime-uid-${owner}`, resourceVersion, creationTimestamp: "2026-07-29T11:00:00Z", annotations: { [REST_PUBLIC_ID_ANNOTATION]: owner === OWNER ? "rt_public" : "rt_foreign", [REST_REVISION_ANNOTATION]: "runtime-base" } }, spec: { hostRef: "primary", workspaceRef: `workspace-${owner === OWNER ? "owner" : "foreign"}`, publicId: owner === OWNER ? "rt_public" : "rt_foreign", title: "Runtime", desiredState: "Running", runtimeProfile: "default" }, status: { observedGeneration: Number(resourceVersion), runtimeGeneration: owner === OWNER ? "gen_owner_runtime" : "gen_foreign_runtime", phase } }; }
function projection(): ClusterInfrastructureProjection { const value = new ClusterInfrastructureProjection({ epoch: "replica", namespace: "development" }); value.replace({ host: { apiVersion: "cluster.t4.dev/v1alpha1", kind: "T4ClusterHost", metadata: { name: "primary", uid: "host-uid", resourceVersion: "1" }, spec: {} }, workspaces: [workspace(), workspace(FOREIGN)], sessions: [runtime(), runtime(FOREIGN)], resourceVersion: "3" }); return value; }

describe("projection lifecycle notifications", () => {
	it("emits sanitized scope and runtime invalidations for controller status changes, but not unchanged frames", async () => {
		const events: Array<Record<string, unknown>> = []; const state = projection();
		const notifier = new LifecycleProjectionNotifier({ projection: state, ledger: { append: async value => { events.push(value as unknown as Record<string, unknown>); return { ...value, eventId: "evt_test", event: "invalidation", timestamp: value.timestamp! }; } }, now: () => START });
		await notifier.synchronize(); notifier.start(); state.applyWatch({ type: "MODIFIED", object: runtime(OWNER, "Running", "4") }); await notifier.synchronize();
		expect(events).toEqual([expect.objectContaining({ principal: OWNER, resourceKind: "scope", resourceId: publicLifecycleScopeId(OWNER), scopeId: publicLifecycleScopeId(OWNER), phase: "Ready" }), expect.objectContaining({ principal: OWNER, resourceKind: "runtime", resourceId: "rt_public", scopeId: publicLifecycleScopeId(OWNER), phase: "Starting" })]);
		expect(JSON.stringify(events)).not.toContain("runtime-owner"); expect(JSON.stringify(events)).not.toContain("foreign"); state.applyWatch({ type: "MODIFIED", object: runtime(OWNER, "Running", "4") }); await notifier.synchronize(); expect(events).toHaveLength(2); await notifier.stop();
	});
});

describe("REST lifecycle stream seam", () => {
	const config = { restBaseUrl: "https://public.example.test/v1", ompAppWebSocketUrl: "wss://public.example.test/v1/ws", build: { version: "1.0.0", revision: "build_public", builtAt: "2026-07-29T00:00:00Z" } };
	it("authenticates and validates the exact optional owned scope filter before accessing the source", async () => {
		const accesses: Array<{ principal: string; scopeId?: string }> = [];
		const handle = createClusterRestHandler({
			projection: projection(),
			config,
			eventSource: {
				response: async (principal, _cursor, _signal, scopeId) => {
					accesses.push({ principal, scopeId });
					return new Response("stream", { headers: { "content-type": "text/event-stream" } });
				},
			},
		});
		const ownedScope = publicLifecycleScopeId(OWNER);
		expect((await handle(new Request("https://public.example.test/v1/events"))).status).toBe(401);
		expect((await handle(new Request("https://public.example.test/v1/events?unknown=value"), identity(OWNER))).status).toBe(400);
		expect((await handle(new Request(`https://public.example.test/v1/events?scopeId=${ownedScope}&scopeId=${ownedScope}`), identity(OWNER))).status).toBe(400);
		expect((await handle(new Request("https://public.example.test/v1/events?scopeId=scope_foreign"), identity(OWNER))).status).toBe(404);
		expect((await handle(new Request("https://public.example.test/v1/events", { method: "POST" }), identity(OWNER))).status).toBe(405);
		expect((await handle(new Request("https://public.example.test/v1/events", { headers: { "last-event-id": "not valid" } }), identity(OWNER))).status).toBe(400);
		expect(accesses).toEqual([]);
		expect((await handle(new Request(`https://public.example.test/v1/events?scopeId=${ownedScope}`), identity(OWNER))).headers.get("content-type")).toBe("text/event-stream");
		expect((await handle(new Request("https://public.example.test/v1/events", { headers: { "last-event-id": "evt_valid" } }), identity(OWNER))).headers.get("content-type")).toBe("text/event-stream");
		expect(accesses).toEqual([{ principal: OWNER, scopeId: ownedScope }, { principal: OWNER, scopeId: ownedScope }]);
	});
});
