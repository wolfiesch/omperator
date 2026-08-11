import { createHash } from "node:crypto";
import {
	SharedControlLedgerCapacityError,
	SharedControlLedgerUnavailableError,
	type IdempotencyKey,
	type InfrastructureEvent,
	type TicketBinding,
} from "@t4-code/portable-control-store";
import { describe, expect, it } from "vite-plus/test";
import { KubernetesApiError, type KubernetesApiClient } from "../src/kubernetes-client.ts";
import { createKubernetesControlStore } from "../src/kubernetes-control-store.ts";

const START = Date.parse("2026-07-29T12:00:00.000Z");
const fixtureMutationKey = (suffix: string): string => `fixture-mutation-${suffix}`;
const binding: TicketBinding = {
	principalId: "principal_alice", scopeId: "scope_personal", audience: "cmux-machine-provider", runtimeId: "rt_alpha",
	runtimeGeneration: "gen_runtime_1", providerControlGeneration: "gen_control_1", purpose: "runtime.connect.cmux",
};
const idempotency: IdempotencyKey = {
	principalId: "principal_alice", scopeId: "scope_personal", method: "POST", canonicalPath: "/runtimes/rt_alpha/actions/wake",
	idempotencyKey: fixtureMutationKey("one"), canonicalBodyDigest: "a".repeat(64),
};
const event = (id: string, revision: string, scopeId = "scope_personal"): InfrastructureEvent => ({ eventId: id, resourceKind: "runtime", resourceId: scopeId === "scope_personal" ? "rt_alpha" : "rt_other", scopeId, revision, phase: "Ready", timestamp: new Date(START).toISOString() });
const random = (seed: number) => { let invocation = 0; return (length: number): Uint8Array => { invocation++; return Uint8Array.from({ length }, (_, index) => (seed + invocation + index) % 251); }; };

class FakeKubernetes {
	readonly namespace = "development";
	resource?: Record<string, unknown>;
	version = 0;
	conflicts = 0;
	unavailable = false;
	alwaysConflict = false;
	requests = 0;
	lastPutResourceVersion?: string;
	async request(path: string, init?: RequestInit): Promise<unknown> {
		this.requests++;
		await Promise.resolve();
		if (this.unavailable) throw new KubernetesApiError(503, "upstream included secret-token");
		const method = init?.method ?? "GET";
		if (method === "GET") {
			if (!this.resource) throw new KubernetesApiError(404, "not found");
			return structuredClone(this.resource);
		}
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (method === "POST") {
			if (this.resource || this.alwaysConflict) { this.conflicts++; throw new KubernetesApiError(409, "conflict"); }
			this.version++;
			this.resource = this.withVersion(body);
			return structuredClone(this.resource);
		}
		if (method === "PUT") {
			const metadata = body.metadata as Record<string, unknown>;
			this.lastPutResourceVersion = String(metadata.resourceVersion);
			const current = (this.resource?.metadata as Record<string, unknown> | undefined)?.resourceVersion;
			if (this.alwaysConflict || metadata.resourceVersion !== current) { this.conflicts++; throw new KubernetesApiError(409, "stale resourceVersion"); }
			this.version++;
			this.resource = this.withVersion(body);
			return structuredClone(this.resource);
		}
		throw new Error(`unexpected ${method} ${path}`);
	}
	serializedState(): string { return String((this.resource?.data as Record<string, unknown> | undefined)?.state ?? ""); }
	seedSerialized(state: string): void { this.version++; this.resource = { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "seeded", resourceVersion: String(this.version) }, data: { state } }; }
	withVersion(body: Record<string, unknown>): Record<string, unknown> { return { ...body, metadata: { ...(body.metadata as Record<string, unknown>), resourceVersion: String(this.version) } }; }
}
function replica(api: FakeKubernetes, seed: number, now: () => number, options: Record<string, number> = {}) {
	return createKubernetesControlStore(api as unknown as KubernetesApiClient, "primary", { now, randomBytes: random(seed), ...options });
}

describe("Kubernetes shared portable control store", () => {
	it("atomically claims one digest-only ticket across replicas and preserves exact binding, expiry, consumption, and revocation", async () => {
		let now = START; const api = new FakeKubernetes(); const first = replica(api, 1, () => now); const second = replica(api, 81, () => now);
		const minted = await first.mintTicket({ ...binding, ttlSeconds: 60 });
		expect(api.serializedState()).not.toContain(minted.ticket);
		expect(api.serializedState()).toContain(createHash("sha256").update(minted.ticket).digest("hex"));
		const [left, right] = await Promise.all([first.consumeTicket({ ...binding, ticket: minted.ticket }), second.consumeTicket({ ...binding, ticket: minted.ticket })]);
		expect([left, right].filter(Boolean)).toHaveLength(1);
		expect(api.conflicts).toBeGreaterThan(0);
		expect(await first.consumeTicket({ ...binding, ticket: minted.ticket })).toBe(false);
		const replacement = replica(api, 161, () => now);
		const acrossRollingLoss = await first.mintTicket({ ...binding, ttlSeconds: 60 });
		expect(await replacement.consumeTicket({ ...binding, ticket: acrossRollingLoss.ticket })).toBe(true);
		expect(await second.consumeTicket({ ...binding, ticket: acrossRollingLoss.ticket })).toBe(false);


		const exact = await first.mintTicket({ ...binding, ttlSeconds: 60 });
		for (const mismatch of [
			{ ...binding, principalId: "principal_other" },
			{ ...binding, scopeId: "scope_other" },
			{ ...binding, audience: "other-audience" },
			{ ...binding, purpose: "other-purpose" },
			{ ...binding, runtimeGeneration: "gen_runtime_2" },
			{ ...binding, providerControlGeneration: "gen_control_2" },
		]) expect(await second.consumeTicket({ ...mismatch, ticket: exact.ticket })).toBe(false);
		expect(await second.consumeTicket({ ...binding, ticket: exact.ticket })).toBe(true);
		const generationBound = await first.mintTicket({ ...binding, ttlSeconds: 60 });
		expect(await second.consumeTicket({ ...binding, runtimeGeneration: "gen_runtime_2", ticket: generationBound.ticket })).toBe(false);
		const transportBound = await first.mintTicket({ ...binding, ttlSeconds: 60 });
		expect(await second.consumeTicketForTransport({ ticket: transportBound.ticket, principalId: binding.principalId, audience: binding.audience, providerControlGeneration: "gen_control_2", purpose: binding.purpose })).toEqual({ outcome: "rejected" });
		expect(await first.consumeTicketForTransport({ ticket: transportBound.ticket, principalId: binding.principalId, audience: binding.audience, providerControlGeneration: binding.providerControlGeneration, purpose: binding.purpose })).toMatchObject({ outcome: "consumed", binding });
		expect(await second.revokeTickets({ cause: "runtimeGenerationReplacement", scopeId: binding.scopeId, runtimeId: binding.runtimeId, runtimeGeneration: binding.runtimeGeneration })).toBe(1);
		expect(await first.consumeTicket({ ...binding, ticket: generationBound.ticket })).toBe(false);
		const expired = await first.mintTicket({ ...binding, ttlSeconds: 1 }); now += 1_001;
		expect(await second.consumeTicketForTransport({ ticket: expired.ticket, principalId: binding.principalId, audience: binding.audience, providerControlGeneration: binding.providerControlGeneration, purpose: binding.purpose })).toEqual({ outcome: "rejected" });
	});

	it("reserves, completes, replays, conflicts, and expires idempotency records with a 24 hour CAS contract", async () => {
		let now = START; const api = new FakeKubernetes(); const first = replica(api, 2, () => now); const second = replica(api, 82, () => now);
		const reservations = await Promise.all([first.reserveIdempotency(idempotency), second.reserveIdempotency(idempotency)]);
		expect(reservations.filter(value => value.outcome === "new")).toHaveLength(1);
		expect(reservations.filter(value => value.outcome === "pending")).toHaveLength(1);
		const reservation = reservations.find(value => value.outcome === "new");
		if (!reservation || reservation.outcome !== "new") throw new Error("reservation missing");
		expect(await second.reserveIdempotency({ ...idempotency, canonicalBodyDigest: "b".repeat(64) })).toEqual({ outcome: "conflict" });
		expect(await first.completeIdempotency({ ...idempotency, reservationToken: "res_wrong", result: { status: 202 } })).toEqual({ outcome: "reservationMismatch" });
		const result = { status: 202, resourceId: "rt_alpha" } as const;
		expect(await first.completeIdempotency({ ...idempotency, reservationToken: reservation.reservationToken, result })).toEqual({ outcome: "completed" });
		expect(await second.reserveIdempotency(idempotency)).toEqual({ outcome: "replay", result });
		now += 86_400_001;
		expect(await second.cleanupIdempotency()).toBe(1);
		const recoveryKey = { ...idempotency, idempotencyKey: fixtureMutationKey("two") };
		expect((await first.reserveIdempotency(recoveryKey)).outcome).toBe("new");
		expect(await second.reconcileIdempotency({ ...recoveryKey, result: { status: 201, resourceId: "rt_recovered" } })).toEqual({ outcome: "completed" });
		expect(await first.reserveIdempotency(recoveryKey)).toEqual({ outcome: "replay", result: { status: 201, resourceId: "rt_recovered" } });
		expect((await first.reserveIdempotency(idempotency)).outcome).toBe("new");
	});

	it("enforces tombstone per-scope capacity and retention without last-write-wins loss", async () => {
		let now = START; const api = new FakeKubernetes(); const first = replica(api, 3, () => now, { maximumTombstonesPerScope: 2 }); const second = replica(api, 83, () => now, { maximumTombstonesPerScope: 2 });
		const deletedAt = new Date(now).toISOString();
		const [one, two] = await Promise.all([
			first.putTombstone({ scopeId: "scope_personal", resourceKind: "runtime", resourceId: "rt_one", deletedAt }),
			second.putTombstone({ scopeId: "scope_personal", resourceKind: "runtime", resourceId: "rt_two", deletedAt }),
		]);
		expect([one.outcome, two.outcome].sort()).toEqual(["created", "created"]);
		expect(await first.putTombstone({ scopeId: "scope_personal", resourceKind: "runtime", resourceId: "rt_three", deletedAt })).toEqual({ outcome: "capacityExceeded" });
		expect((await second.getTombstone({ scopeId: "scope_personal", resourceKind: "runtime", resourceId: "rt_one" }))?.resourceId).toBe("rt_one");
		now += 86_400_001;
		expect(await first.cleanupTombstones("scope_personal")).toBe(2);
		expect(await second.getTombstone({ scopeId: "scope_personal", resourceKind: "runtime", resourceId: "rt_two" })).toBeUndefined();
	});

	it("durably binds public identifiers to one scope and Kubernetes incarnation", async () => {
		const api = new FakeKubernetes();
		const first = replica(api, 31, () => START);
		const second = replica(api, 91, () => START);
		const request = { scopeId: "scope_personal", resourceKind: "runtime" as const, resourceId: "rt_stable", bindingDigest: "a".repeat(64) };
		expect((await first.reserveIssuedIdentifier(request)).outcome).toBe("reserved");
		expect((await second.reserveIssuedIdentifier(request)).outcome).toBe("existing");
		expect((await second.reserveIssuedIdentifier({ ...request, scopeId: "scope_other" })).outcome).toBe("conflict");
		expect((await first.claimIssuedIdentifierCreation({ resourceKind: "runtime", resourceId: "rt_stable", bindingDigest: request.bindingDigest, ownerToken: "owner_first", now: START, leaseExpiresAt: START + 1_000 })).outcome).toBe("claimed");
		expect((await second.claimIssuedIdentifierCreation({ resourceKind: "runtime", resourceId: "rt_stable", bindingDigest: request.bindingDigest, ownerToken: "owner_second", now: START + 500, leaseExpiresAt: START + 1_500 })).outcome).toBe("inProgress");
		expect((await second.claimIssuedIdentifierCreation({ resourceKind: "runtime", resourceId: "rt_stable", bindingDigest: request.bindingDigest, ownerToken: "owner_second", now: START + 1_000, leaseExpiresAt: START + 2_000 })).outcome).toBe("takenOver");
		expect((await first.bindIssuedIdentifier({ ...request, incarnationUid: "uid_original", creationOwnerToken: "owner_second" })).outcome).toBe("bound");
		expect((await second.bindIssuedIdentifier({ ...request, incarnationUid: "uid_replacement" })).outcome).toBe("conflict");
		expect((await first.beginIssuedIdentifierDeletion({ resourceKind: "runtime", resourceId: "rt_stable", incarnationUid: "uid_original", expectedRevision: "rev_public", backendRevision: "42", requestedAt: new Date(START).toISOString() })).outcome).toBe("begun");
		expect((await second.beginIssuedIdentifierDeletion({ resourceKind: "runtime", resourceId: "rt_stable", incarnationUid: "uid_original", expectedRevision: "rev_public", backendRevision: "42", requestedAt: new Date(START + 1).toISOString() })).outcome).toBe("existing");
		expect((await second.beginIssuedIdentifierDeletion({ resourceKind: "runtime", resourceId: "rt_stable", incarnationUid: "uid_original", expectedRevision: "rev_other", backendRevision: "42", requestedAt: new Date(START + 1).toISOString() })).outcome).toBe("conflict");
		expect((await second.cancelIssuedIdentifierDeletion({ resourceKind: "runtime", resourceId: "rt_stable", incarnationUid: "uid_original", expectedRevision: "rev_other", backendRevision: "42" })).outcome).toBe("conflict");
		expect((await first.cancelIssuedIdentifierDeletion({ resourceKind: "runtime", resourceId: "rt_stable", incarnationUid: "uid_original", expectedRevision: "rev_public", backendRevision: "42" })).outcome).toBe("cancelled");
		expect((await second.beginIssuedIdentifierDeletion({ resourceKind: "runtime", resourceId: "rt_stable", incarnationUid: "uid_original", expectedRevision: "rev_public", backendRevision: "43", requestedAt: new Date(START + 2).toISOString() })).outcome).toBe("begun");
		expect((await first.markIssuedIdentifierDeleted({ resourceKind: "runtime", resourceId: "rt_stable", incarnationUid: "uid_original", deletedAt: new Date(START).toISOString() })).outcome).toBe("deleted");
		expect((await second.markIssuedIdentifierDeleted({ resourceKind: "runtime", resourceId: "rt_stable", incarnationUid: "uid_original", deletedAt: new Date(START).toISOString() })).outcome).toBe("existing");
		expect(await second.getIssuedIdentifier("runtime", "rt_stable")).toMatchObject({ scopeId: "scope_personal", incarnationUid: "uid_original", deletedAt: new Date(START).toISOString() });
	});

	it("orders event CAS conflicts and resumes list-watch continuity across replicas", async () => {
		const api = new FakeKubernetes(); const first = replica(api, 4, () => START); const second = replica(api, 84, () => START);
		const initial = await first.appendEvent(event("evt_initial", "rev_1"));
		await Promise.all([first.appendEvent(event("evt_left", "rev_2")), second.appendEvent(event("evt_right", "rev_3"))]);
		const replay = await second.readAfter({ scopeId: "scope_personal", cursor: initial.cursor });
		expect(replay.outcome).toBe("events"); if (replay.outcome !== "events") throw new Error("event replay reset unexpectedly");
		expect(replay.events.map(value => value.eventId).sort()).toEqual(["evt_left", "evt_right"]);
		expect(api.conflicts).toBeGreaterThan(0);
		const controller = new AbortController(); const watching = first.subscribe({ scopeId: "scope_personal", cursor: replay.outcome === "events" ? replay.cursor : initial.cursor, signal: controller.signal, pollMilliseconds: 1 }); const next = watching[Symbol.asyncIterator]().next();
		await second.appendEvent(event("evt_watched", "rev_4"));
		expect(await next).toMatchObject({ done: false, value: { outcome: "events", events: [{ eventId: "evt_watched" }] } }); controller.abort();

		let retainedNow = START; const retainedApi = new FakeKubernetes(); const retained = replica(retainedApi, 44, () => retainedNow, { maximumEvents: 2, eventRetentionSeconds: 60 });
		const retainedFirst = await retained.appendEvent(event("evt_retained_1", "rev_1"));
		await retained.appendEvent(event("evt_retained_2", "rev_2"));
		await expect(retained.appendEvent(event("evt_over_capacity", "rev_3"))).rejects.toBeInstanceOf(SharedControlLedgerCapacityError);
		retainedNow += 60_001;
		await retained.appendEvent(event("evt_after_expiry", "rev_4"));
		expect(await retained.readAfter({ scopeId: "scope_personal", cursor: retainedFirst.cursor })).toMatchObject({ outcome: "cursorExpired", reset: { reason: "cursor_expired" } });

		let interleavedNow = START; const interleavedApi = new FakeKubernetes(); const interleaved = replica(interleavedApi, 45, () => interleavedNow);
		const personalHead = await interleaved.appendEvent(event("evt_personal_head", "rev_personal"));
		interleavedNow += 60_001;
		await interleaved.appendEvent(event("evt_other_scope", "rev_other", "scope_other"));
		expect(await interleaved.readAfter({ scopeId: "scope_personal", cursor: personalHead.cursor })).toMatchObject({ outcome: "events", events: [], cursor: personalHead.cursor });
	});

	it("shares provider generations, stream activation, and nonce replay through Kubernetes CAS", async () => {
		const api = new FakeKubernetes();
		const first = replica(api, 101, () => START);
		const second = replica(api, 151, () => START);
		expect(await first.installProviderControlGeneration({ principalId: binding.principalId, generation: binding.providerControlGeneration })).toEqual({ outcome: "installed" });
		expect(await first.registerProviderConnection({ ...binding, connectionId: "connection-one", ticket: "p".repeat(32) })).toEqual({ outcome: "registered" });
		expect(await second.activateProviderConnection({ ...binding, ticket: "p".repeat(32) })).toEqual({ outcome: "active", connectionId: "connection-one" });
		expect(await second.installProviderControlGeneration({ principalId: binding.principalId, generation: "gen_control_2" })).toEqual({
			outcome: "installed",
			replaced: { generation: binding.providerControlGeneration, bindings: [binding] },
		});
		expect(await second.isProviderConnectionActive("conn-shared")).toBeFalsy();
		const claims = await Promise.all([
			first.claimProviderAssertionNonce({ nonce: "n".repeat(24), expiresAt: START / 1_000 + 20 }),
			second.claimProviderAssertionNonce({ nonce: "n".repeat(24), expiresAt: START / 1_000 + 20 }),
		]);
		expect(claims.sort()).toEqual(["claimed", "replayed"]);
		expect(api.conflicts).toBeGreaterThan(0);
	});
	it("fails closed with sanitized bounded errors for corrupt, oversized, unavailable, and permanently contended state", async () => {
		const corruptApi = new FakeKubernetes(); corruptApi.seedSerialized("{\"version\":1}");
		await expect(replica(corruptApi, 5, () => START).reserveIdempotency(idempotency)).rejects.toEqual(new SharedControlLedgerUnavailableError());
		const oversizedApi = new FakeKubernetes(); oversizedApi.seedSerialized(`{"padding":"${"x".repeat(769 * 1024)}"}`);
		await expect(replica(oversizedApi, 6, () => START).reserveIdempotency(idempotency)).rejects.toEqual(new SharedControlLedgerUnavailableError());
		const duplicateEventApi = new FakeKubernetes();
		duplicateEventApi.seedSerialized(JSON.stringify({ version: 1, eventHeads: [{ scopeId: "scope_personal", sequence: 2 }], tickets: [], idempotency: [], tombstones: [], events: [{ sequence: 1, event: event("evt_duplicate", "rev_1"), storedAt: START }, { sequence: 2, event: event("evt_duplicate", "rev_2"), storedAt: START }] }));
		await expect(replica(duplicateEventApi, 61, () => START).reserveIdempotency(idempotency)).rejects.toBeInstanceOf(SharedControlLedgerUnavailableError);
		const legacyEmptyApi = new FakeKubernetes(); legacyEmptyApi.seedSerialized(JSON.stringify({ version: 1, nextEventSequence: 1, tickets: [], idempotency: [], tombstones: [], events: [] }));
		expect((await replica(legacyEmptyApi, 62, () => START).reserveIdempotency(idempotency)).outcome).toBe("new");
		const unavailableApi = new FakeKubernetes(); unavailableApi.unavailable = true;
		await expect(replica(unavailableApi, 7, () => START).mintTicket({ ...binding, ttlSeconds: 60 })).rejects.toMatchObject({ name: "SharedControlLedgerUnavailableError", message: "shared control ledger is unavailable" });
		const contendedApi = new FakeKubernetes(); contendedApi.alwaysConflict = true;
		await expect(replica(contendedApi, 8, () => START, { maximumContentionRetries: 3 }).mintTicket({ ...binding, ttlSeconds: 60 })).rejects.toBeInstanceOf(SharedControlLedgerUnavailableError);
		expect(contendedApi.requests).toBe(6);

		const capacityApi = new FakeKubernetes(); const capacity = replica(capacityApi, 9, () => START, { maximumTickets: 1 });
		await capacity.mintTicket({ ...binding, ttlSeconds: 60 });
		await expect(capacity.mintTicket({ ...binding, ttlSeconds: 60 })).rejects.toBeInstanceOf(SharedControlLedgerCapacityError);

		const opaqueVersionApi = new FakeKubernetes(); const opaqueVersion = replica(opaqueVersionApi, 10, () => START);
		await opaqueVersion.mintTicket({ ...binding, ttlSeconds: 60 });
		(opaqueVersionApi.resource!.metadata as Record<string, unknown>).resourceVersion = "rv/opaque value:1";
		await opaqueVersion.mintTicket({ ...binding, ttlSeconds: 60 });
		expect(opaqueVersionApi.lastPutResourceVersion).toBe("rv/opaque value:1");
	});
});
