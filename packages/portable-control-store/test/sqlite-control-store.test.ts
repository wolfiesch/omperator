import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scope, Workspace } from "@t4-code/portable-core";
import { ControlStoreInputError, ControlStoreStateError, SqliteControlStore, type IdempotencyKey, type TicketBinding } from "../src/index.js";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function databasePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "t4-control-store-"));
	directories.push(directory);
	return join(directory, "control.sqlite");
}

function deterministicRandom(seed = 0): (length: number) => Uint8Array {
	let next = seed;
	return (length) => {
		const bytes = new Uint8Array(length);
		for (let index = 0; index < length; index++) bytes[index] = (next++ % 251) + 1;
		return bytes;
	};
}

function scope(id = "scope_personal"): Omit<Scope, "revision"> {
	return { id, displayName: "Personal", kind: "Personal" };
}

function workspace(id = "ws_alpha"): Omit<Workspace, "revision"> {
	return {
		id,
		scopeId: "scope_personal",
		displayName: "Alpha",
		capacityBytes: 1_073_741_824,
		retention: "Retain",
		phase: "Ready",
		attachmentCount: 0,
		conditions: [],
		createdAt: "2026-07-29T00:00:00.000Z",
		updatedAt: "2026-07-29T00:00:00.000Z",
	};
}


const idempotency: IdempotencyKey = {
	principalId: "principal_alice",
	scopeId: "scope_personal",
	method: "PATCH",
	canonicalPath: "/v1/runtimes/rt_alpha",
	idempotencyKey: "retry-key-0000001",
	canonicalBodyDigest: "a".repeat(64),
};

const ticketBinding: TicketBinding = {
	principalId: "principal_alice",
	scopeId: "scope_personal",
	audience: "provider-control",
	runtimeId: "rt_alpha",
	runtimeGeneration: "gen_current",
	providerControlGeneration: "pcg_current",
	purpose: "cmux-connect",
};

describe("SQLite resource registry", () => {
	test("compare-and-swap changes the opaque revision and stale retries have no side effect", async () => {
		const path = await databasePath();
		const store = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom() });
		const created = store.createResource({ kind: "workspace", value: workspace() });
		expect(created.outcome).toBe("created");
		if (created.outcome !== "created") throw new Error("workspace was not created");

		const update = { scopeId: "scope_personal", displayName: "Renamed", capacityBytes: 1_073_741_824, retention: "Retain" as const, phase: "Ready" as const, attachmentCount: 0, conditions: [], createdAt: "2026-07-29T00:00:00.000Z", updatedAt: "2026-07-29T00:00:00.000Z" };
		const changed = store.compareAndSwapResource({ kind: "workspace", id: "ws_alpha", expectedRevision: created.resource.revision, value: update });
		expect(changed.outcome).toBe("updated");
		if (changed.outcome !== "updated") throw new Error("workspace was not updated");
		expect(changed.resource.revision).not.toBe(created.resource.revision);

		const stale = store.compareAndSwapResource({ kind: "workspace", id: "ws_alpha", expectedRevision: created.resource.revision, value: { ...update, displayName: "Lost write" } });
		expect(stale).toEqual({ outcome: "revisionMismatch", currentRevision: changed.resource.revision });
		expect(store.getResource("workspace", "ws_alpha")?.displayName).toBe("Renamed");
		store.close();
	});

	test("resource pagination returns a complete baseline and carries one high-water across more than 200 resources", async () => {
		const path = await databasePath();
		const store = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom() });
		for (let index = 0; index < 205; index++) store.createResource({ kind: "workspace", value: workspace(`ws_${String(index).padStart(3, "0")}`) });
		const first = store.listResources({ scopeId: "scope_personal", kinds: ["workspace"], limit: 100 });
		if (!first.nextPageCursor) throw new Error("first resource page was not continued");
		store.createResource({ kind: "workspace", value: workspace("ws_999") });
		const removedDuringList = store.getResource("workspace", "ws_150");
		if (!removedDuringList) throw new Error("snapshot deletion fixture is missing");
		store.putTombstone({ scopeId: "scope_personal", resourceKind: "workspace", resourceId: "ws_150", deletedAt: "2026-07-29T00:00:00.000Z" });
		store.deleteResource({ kind: "workspace", id: "ws_150", expectedRevision: removedDuringList.revision });
		store.appendEvent({ eventId: "evt_during_list", resourceKind: "workspace", resourceId: "ws_999", scopeId: "scope_personal", revision: "rev_during", phase: "Ready", timestamp: "2026-07-29T00:00:01.000Z" });
		const second = store.listResources({ scopeId: "scope_personal", kinds: ["workspace"], limit: 100, pageCursor: first.nextPageCursor });
		if (!second.nextPageCursor) throw new Error("second resource page was not continued");
		const third = store.listResources({ scopeId: "scope_personal", kinds: ["workspace"], limit: 100, pageCursor: second.nextPageCursor });
		expect([...first.items, ...second.items, ...third.items].map((item) => item.id)).toEqual(Array.from({ length: 205 }, (_, index) => `ws_${String(index).padStart(3, "0")}`));
		expect(second.highWaterCursor).toBe(first.highWaterCursor);
		expect(third.highWaterCursor).toBe(first.highWaterCursor);
		expect(third.nextPageCursor).toBeUndefined();
		const replay = store.readAfter({ scopeId: "scope_personal", cursor: first.highWaterCursor });
		expect(replay.outcome === "events" && replay.events.map((event) => event.eventId)).toEqual(["evt_during_list"]);
		store.close();
	});

	test("issued identifiers remain unavailable after deletion, tombstone expiry, and restart", async () => {
		const path = await databasePath();
		let now = Date.parse("2026-07-29T00:00:00.000Z");
		const options = { databasePath: path, now: () => now, randomBytes: deterministicRandom(), tombstoneRetentionSeconds: 86_400 };
		let store = new SqliteControlStore(options);
		const created = store.createResource({ kind: "workspace", value: workspace() });
		if (created.outcome !== "created") throw new Error("workspace was not created");
		expect(store.putTombstone({ scopeId: "scope_personal", resourceKind: "workspace", resourceId: "ws_alpha", deletedAt: new Date(now).toISOString() }).outcome).toBe("created");
		expect(store.deleteResource({ kind: "workspace", id: "ws_alpha", expectedRevision: created.resource.revision })).toEqual({ outcome: "deleted" });
		store.close();

		now += 86_400_001;
		store = new SqliteControlStore({ ...options, randomBytes: deterministicRandom(80) });
		expect(store.cleanupTombstones("scope_personal")).toBe(1);
		expect(store.getTombstone({ scopeId: "scope_personal", resourceKind: "workspace", resourceId: "ws_alpha" })).toBeUndefined();
		expect(store.identifierWasIssued("workspace", "ws_alpha")).toBe(true);
		expect(store.createResource({ kind: "workspace", value: workspace() })).toEqual({ outcome: "alreadyIssued" });
		store.close();
	});

	test("stored metadata corruption fails closed", async () => {
		const path = await databasePath();
		const store = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom() });
		store.createResource({ kind: "scope", value: scope() });
		store.close();
		const database = new Database(path);
		database.run("UPDATE resources SET revision='rev_corrupt' WHERE resource_kind='scope'");
		database.close();
		const reopened = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom(90) });
		expect(() => reopened.getResource("scope", "scope_personal")).toThrow(ControlStoreStateError);
		reopened.close();
	});
	test("resource mutation and its journal event commit atomically while rejected CAS emits nothing", async () => {
		const path = await databasePath();
		const store = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom() });
		const created = store.createResourceWithEvent({ kind: "workspace", value: workspace(), event: { eventId: "evt_create", phase: "Ready", timestamp: "2026-07-29T00:00:00.000Z" } });
		if (created.outcome !== "created") throw new Error("workspace was not created");
		expect(created.event).toMatchObject({ resourceKind: "workspace", resourceId: "ws_alpha", scopeId: "scope_personal", revision: created.resource.revision });
		const baseline = store.listResources({ scopeId: "scope_personal", kinds: ["workspace"] });
		const stale = store.compareAndSwapResourceWithEvent({ kind: "workspace", id: "ws_alpha", expectedRevision: "rev_stale", value: { ...created.resource, displayName: "Lost" }, event: { eventId: "evt_stale", phase: "Ready", timestamp: "2026-07-29T00:00:01.000Z" } });
		expect(stale).toMatchObject({ outcome: "revisionMismatch", currentRevision: created.resource.revision });
		expect(store.readAfter({ scopeId: "scope_personal", cursor: baseline.highWaterCursor })).toMatchObject({ outcome: "events", events: [] });
		const changed = store.compareAndSwapResourceWithEvent({ kind: "workspace", id: "ws_alpha", expectedRevision: created.resource.revision, value: { ...created.resource, displayName: "Changed" }, event: { eventId: "evt_update", phase: "Ready", timestamp: "2026-07-29T00:00:02.000Z" } });
		if (changed.outcome !== "updated") throw new Error("workspace was not updated");
		expect(changed.event.revision).toBe(changed.resource.revision);
		expect(store.readAfter({ scopeId: "scope_personal", cursor: baseline.highWaterCursor })).toMatchObject({ outcome: "events", events: [changed.event] });
		store.close();
	});

	test("runtime attachment creation and tombstoned deletion commit with both resource events atomically", async () => {
		const path = await databasePath();
		const store = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom(7) });
		const workspaceCreated = store.createResourceWithEvent({ kind: "workspace", value: workspace(), event: { eventId: "evt_workspace", phase: "Ready", timestamp: "2026-07-29T00:00:00.000Z" } });
		if (workspaceCreated.outcome !== "created") throw new Error("workspace was not created");
		const runtimeDraft = { id: "rt_atomic", scopeId: "scope_personal", displayName: "Atomic Runtime", workspaceId: "ws_alpha", hostProfileId: "host_default", desiredState: "Stopped", phase: "Provisioning", generation: "gen_initial", capabilities: [], conditions: [], createdAt: "2026-07-29T00:00:01.000Z", updatedAt: "2026-07-29T00:00:01.000Z" } as const;
		const created = store.createRuntimeWithWorkspaceAttachment({ value: runtimeDraft, workspaceId: "ws_alpha", expectedWorkspaceRevision: workspaceCreated.resource.revision, configurationIntent: { runtimeId: "rt_atomic", operationId: "op_create", browserPolicy: "Disabled" }, runtimeEvent: { eventId: "evt_runtime_create", phase: "Provisioning", timestamp: "2026-07-29T00:00:01.000Z" }, workspaceEvent: { eventId: "evt_workspace_attach", phase: "Ready", timestamp: "2026-07-29T00:00:01.000Z" } });
		expect(created).toMatchObject({ outcome: "created", workspace: { attachmentCount: 1 }, events: [{ resourceKind: "workspace" }, { resourceKind: "runtime" }] });
		if (created.outcome !== "created") throw new Error("runtime was not created");
		const stale = store.createRuntimeWithWorkspaceAttachment({ value: { ...runtimeDraft, id: "rt_stale" }, workspaceId: "ws_alpha", expectedWorkspaceRevision: workspaceCreated.resource.revision, configurationIntent: { runtimeId: "rt_stale", operationId: "op_stale", browserPolicy: "Disabled" }, runtimeEvent: { eventId: "evt_stale_runtime", phase: "Provisioning", timestamp: "2026-07-29T00:00:02.000Z" }, workspaceEvent: { eventId: "evt_stale_workspace", phase: "Ready", timestamp: "2026-07-29T00:00:02.000Z" } });
		expect(stale).toMatchObject({ outcome: "workspaceRevisionMismatch", currentRevision: created.workspace.revision });
		expect(store.identifierWasIssued("runtime", "rt_stale")).toBe(false);
		expect(store.getRuntimeConfigurationIntent("rt_atomic")).toEqual({ runtimeId: "rt_atomic", operationId: "op_create", browserPolicy: "Disabled" });
		const deleting = store.compareAndSwapResourceWithEvent({ kind: "runtime", id: created.resource.id, expectedRevision: created.resource.revision, value: { ...created.resource, phase: "Deleting", updatedAt: "2026-07-29T00:00:03.000Z" }, event: { eventId: "evt_runtime_deleting", phase: "Deleting", timestamp: "2026-07-29T00:00:03.000Z" } });
		if (deleting.outcome !== "updated") throw new Error("runtime did not enter deleting");
		const finalized = store.finalizeRuntimeDeletion({ runtimeId: deleting.resource.id, expectedRevision: deleting.resource.revision, deletedAt: "2026-07-29T00:00:04.000Z", runtimeEvent: { eventId: "evt_runtime_deleted", phase: "Deleting", timestamp: "2026-07-29T00:00:04.000Z" }, workspaceEvent: { eventId: "evt_workspace_detach", phase: "Ready", timestamp: "2026-07-29T00:00:04.000Z" } });
		expect(finalized).toMatchObject({ outcome: "deleted", workspace: { attachmentCount: 0 }, tombstone: { resourceKind: "runtime", resourceId: "rt_atomic" }, events: [{ resourceKind: "workspace" }, { resourceKind: "runtime" }] });
		expect(store.getResource("runtime", "rt_atomic")).toBeUndefined();
		expect(store.identifierWasIssued("runtime", "rt_atomic")).toBe(true);
		expect(store.getRuntimeConfigurationIntent("rt_atomic")).toBeUndefined();
		expect(store.getBackendCleanup("runtime", "rt_atomic")).toMatchObject({ cleanupRequired: true, completed: false });
		expect(store.completeBackendCleanup("runtime", "rt_atomic")).toBe(true);
		expect(store.getBackendCleanup("runtime", "rt_atomic")).toMatchObject({ completed: true });
		store.close();
	});

});

describe("idempotency ledger", () => {
	test("racing replicas reserve once, matching retries stay pending, and conflicts reject", async () => {
		const path = await databasePath();
		const first = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom(1) });
		const second = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom(101) });
		const reservation = first.reserveIdempotency(idempotency);
		expect(reservation.outcome).toBe("new");
		expect(second.reserveIdempotency(idempotency)).toEqual({ outcome: "pending" });
		expect(second.reserveIdempotency({ ...idempotency, canonicalBodyDigest: "b".repeat(64) })).toEqual({ outcome: "conflict" });
		first.close();
		second.close();
	});

	test("only the matching reservation publishes an exact restart-persistent replay", async () => {
		const path = await databasePath();
		let store = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom() });
		const reservation = store.reserveIdempotency(idempotency);
		if (reservation.outcome !== "new") throw new Error("reservation was not new");
		expect(store.completeIdempotency({ ...idempotency, reservationToken: "res_wrong-token", result: { status: 200 } })).toEqual({ outcome: "reservationMismatch" });
		const result = { status: 202, body: { runtimeId: "rt_alpha" }, headers: ["ETag", "opaque"] } as const;
		expect(store.completeIdempotency({ ...idempotency, reservationToken: reservation.reservationToken, result })).toEqual({ outcome: "completed" });
		store.close();

		store = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom(100) });
		expect(store.reserveIdempotency(idempotency)).toEqual({ outcome: "replay", result });
		store.close();
	});

	test("an exact authoritative reconciliation completes a pending reservation across replicas", async () => {
		const path = await databasePath();
		const first = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom(1) });
		const second = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom(101) });
		expect(first.reserveIdempotency(idempotency).outcome).toBe("new");
		const result = { status: 201, resourceId: "rt_recovered" } as const;
		expect(second.reconcileIdempotency({ ...idempotency, result })).toEqual({ outcome: "completed" });
		expect(first.reserveIdempotency(idempotency)).toEqual({ outcome: "replay", result });
		expect(second.reconcileIdempotency({ ...idempotency, canonicalBodyDigest: "b".repeat(64), result })).toEqual({ outcome: "conflict" });
		first.close();
		second.close();
	});

	test("completed results cannot be cleaned before the 24-hour minimum", async () => {
		const path = await databasePath();
		let now = 1_800_000_000_000;
		const store = new SqliteControlStore({ databasePath: path, now: () => now, randomBytes: deterministicRandom(), idempotencyRetentionSeconds: 86_400 });
		const reservation = store.reserveIdempotency(idempotency);
		if (reservation.outcome !== "new") throw new Error("reservation was not new");
		store.completeIdempotency({ ...idempotency, reservationToken: reservation.reservationToken, result: { ok: true } });
		now += 86_399_999;
		expect(store.cleanupIdempotency()).toBe(0);
		expect(store.reserveIdempotency(idempotency).outcome).toBe("replay");
		now += 2;
		expect(store.cleanupIdempotency()).toBe(1);
		store.close();
	});
});

describe("single-use generation-bound tickets", () => {
	test("two store handles can consume a ticket only once", async () => {
		const path = await databasePath();
		const first = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom() });
		const second = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom(120) });
		const minted = first.mintTicket({ ...ticketBinding, ttlSeconds: 60 });
		const attempts = [first.consumeTicket({ ...ticketBinding, ticket: minted.ticket }), second.consumeTicket({ ...ticketBinding, ticket: minted.ticket })];
		expect(attempts.filter(Boolean)).toHaveLength(1);
		expect(first.consumeTicket({ ...ticketBinding, ticket: minted.ticket })).toBe(false);
		first.close();
		second.close();
	});

	test("transport selector atomically returns the stored binding across replicas", async () => {
		const path = await databasePath();
		const first = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom() });
		const second = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom(120) });
		const minted = first.mintTicket({ ...ticketBinding, ttlSeconds: 60 });
		const selector = { ticket: minted.ticket, principalId: ticketBinding.principalId, audience: ticketBinding.audience, providerControlGeneration: ticketBinding.providerControlGeneration, purpose: ticketBinding.purpose };
		const attempts = [first.consumeTicketForTransport(selector), second.consumeTicketForTransport(selector)];
		expect(attempts.filter(attempt => attempt.outcome === "consumed")).toEqual([{ outcome: "consumed", binding: ticketBinding }]);
		expect(first.consumeTicketForTransport(selector)).toEqual({ outcome: "rejected" });
		first.close();
		second.close();
	});

	test("transport selector mismatches do not consume the ticket", async () => {
		const path = await databasePath();
		const store = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom() });
		const minted = store.mintTicket({ ...ticketBinding, ttlSeconds: 60 });
		for (const mismatch of [
			{ principalId: "principal_other", audience: ticketBinding.audience, providerControlGeneration: ticketBinding.providerControlGeneration, purpose: ticketBinding.purpose },
			{ principalId: ticketBinding.principalId, audience: "other-audience", providerControlGeneration: ticketBinding.providerControlGeneration, purpose: ticketBinding.purpose },
			{ principalId: ticketBinding.principalId, audience: ticketBinding.audience, providerControlGeneration: "gen_other_control", purpose: ticketBinding.purpose },
			{ principalId: ticketBinding.principalId, audience: ticketBinding.audience, providerControlGeneration: ticketBinding.providerControlGeneration, purpose: "other.purpose" },
		]) {
			expect(store.consumeTicketForTransport({ ticket: minted.ticket, ...mismatch })).toEqual({ outcome: "rejected" });
		}
		expect(store.consumeTicketForTransport({ ticket: minted.ticket, principalId: ticketBinding.principalId, audience: ticketBinding.audience, providerControlGeneration: ticketBinding.providerControlGeneration, purpose: ticketBinding.purpose })).toEqual({ outcome: "consumed", binding: ticketBinding });
		store.close();
	});

	test("expired transport tickets reject without returning their binding", async () => {
		const path = await databasePath();
		let now = 1_800_000_000_000;
		const store = new SqliteControlStore({ databasePath: path, now: () => now, randomBytes: deterministicRandom() });
		const minted = store.mintTicket({ ...ticketBinding, ttlSeconds: 1 });
		now += 1001;
		expect(store.consumeTicketForTransport({ ticket: minted.ticket, principalId: ticketBinding.principalId, audience: ticketBinding.audience, providerControlGeneration: ticketBinding.providerControlGeneration, purpose: ticketBinding.purpose })).toEqual({ outcome: "rejected" });
		store.close();
	});

	test("transport selector returns the binding after a store restart", async () => {
		const path = await databasePath();
		let store = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom() });
		const minted = store.mintTicket({ ...ticketBinding, ttlSeconds: 60 });
		store.close();
		store = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom(200) });
		expect(store.consumeTicketForTransport({ ticket: minted.ticket, principalId: ticketBinding.principalId, audience: ticketBinding.audience, providerControlGeneration: ticketBinding.providerControlGeneration, purpose: ticketBinding.purpose })).toEqual({ outcome: "consumed", binding: ticketBinding });
		store.close();
	});

	test("wrong generation does not consume and expiry fails closed", async () => {
		const path = await databasePath();
		let now = 1_800_000_000_000;
		const store = new SqliteControlStore({ databasePath: path, now: () => now, randomBytes: deterministicRandom() });
		const minted = store.mintTicket({ ...ticketBinding, ttlSeconds: 1 });
		expect(store.consumeTicket({ ...ticketBinding, runtimeGeneration: "gen_stale", ticket: minted.ticket })).toBe(false);
		now += 1001;
		expect(store.consumeTicket({ ...ticketBinding, ticket: minted.ticket })).toBe(false);
		store.close();
	});

	test("an unexpired digest remains consumable exactly once after restart", async () => {
		const path = await databasePath();
		let store = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom() });
		const minted = store.mintTicket({ ...ticketBinding, ttlSeconds: 60 });
		store.close();
		store = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom(200) });
		expect(store.consumeTicket({ ...ticketBinding, ticket: minted.ticket })).toBe(true);
		expect(store.consumeTicket({ ...ticketBinding, ticket: minted.ticket })).toBe(false);
		store.close();
	});

	test("the database retains only the digest and generation replacement revokes atomically", async () => {
		const path = await databasePath();
		const store = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom() });
		const minted = store.mintTicket({ ...ticketBinding, ttlSeconds: 60 });
		expect(store.revokeTickets({ cause: "runtimeGenerationReplacement", scopeId: ticketBinding.scopeId, runtimeId: ticketBinding.runtimeId, runtimeGeneration: ticketBinding.runtimeGeneration })).toBe(1);
		expect(store.consumeTicket({ ...ticketBinding, ticket: minted.ticket })).toBe(false);
		store.close();
		const database = new Database(path);
		const schema = database.query("SELECT sql FROM sqlite_schema WHERE name='tickets'").get();
		if (!schema || typeof schema !== "object" || !(("sql" in schema)) || typeof schema.sql !== "string") throw new Error("tickets schema missing");
		expect(schema.sql).not.toContain("ticket TEXT");
		database.close();
	});
});

describe("bounded tombstones", () => {
	test("capacity rejects a deletion instead of evicting a required tombstone", async () => {
		const path = await databasePath();
		const now = Date.parse("2026-07-29T00:00:00.000Z");
		const store = new SqliteControlStore({ databasePath: path, now: () => now, randomBytes: deterministicRandom(), maximumTombstonesPerScope: 1 });
		store.createResource({ kind: "workspace", value: workspace("ws_one") });
		store.createResource({ kind: "workspace", value: workspace("ws_two") });
		expect(store.putTombstone({ scopeId: "scope_personal", resourceKind: "workspace", resourceId: "ws_one", deletedAt: new Date(now).toISOString() }).outcome).toBe("created");
		expect(store.putTombstone({ scopeId: "scope_personal", resourceKind: "workspace", resourceId: "ws_two", deletedAt: new Date(now).toISOString() })).toEqual({ outcome: "capacityExceeded" });
		expect(store.getTombstone({ scopeId: "scope_personal", resourceKind: "workspace", resourceId: "ws_one" })).toBeDefined();
		store.close();
	});

	test("unissued and cross-scope identifiers cannot receive tombstones", async () => {
		const path = await databasePath();
		const now = Date.parse("2026-07-29T00:00:00.000Z");
		const store = new SqliteControlStore({ databasePath: path, now: () => now, randomBytes: deterministicRandom() });
		expect(() => store.putTombstone({ scopeId: "scope_personal", resourceKind: "runtime", resourceId: "rt_missing", deletedAt: new Date(now).toISOString() })).toThrow(ControlStoreStateError);
		store.close();
	});
});

describe("bounded event journal", () => {
	test("retained cursors replay monotonically without duplication and empty reads preserve the cursor", async () => {
		const path = await databasePath();
		const store = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom() });
		const highWater = store.listResources({ scopeId: "scope_personal" }).highWaterCursor;
		const one = store.appendEvent({ eventId: "evt_one", resourceKind: "runtime", resourceId: "rt_alpha", scopeId: "scope_personal", revision: "rev_one", phase: "Starting", timestamp: "2026-07-29T00:00:01.000Z" });
		store.appendEvent({ eventId: "evt_two", resourceKind: "runtime", resourceId: "rt_alpha", scopeId: "scope_personal", revision: "rev_two", phase: "Ready", timestamp: "2026-07-29T00:00:02.000Z" });
		const firstPage = store.readAfter({ scopeId: "scope_personal", cursor: highWater, limit: 1 });
		expect(firstPage.outcome).toBe("events");
		if (firstPage.outcome !== "events") throw new Error("cursor unexpectedly expired");
		expect(firstPage.events.map((event) => event.eventId)).toEqual(["evt_one"]);
		expect(Object.keys(firstPage.events[0] ?? {}).sort()).toEqual(["eventId", "phase", "resourceId", "resourceKind", "revision", "scopeId", "timestamp"]);
		const secondPage = store.readAfter({ scopeId: "scope_personal", cursor: firstPage.cursor });
		expect(secondPage.outcome === "events" && secondPage.events.map((event) => event.eventId)).toEqual(["evt_two"]);
		if (secondPage.outcome !== "events") throw new Error("cursor unexpectedly expired");
		const empty = store.readAfter({ scopeId: "scope_personal", cursor: secondPage.cursor });
		expect(empty).toEqual({ outcome: "events", events: [], cursor: secondPage.cursor });
		expect(one.cursor).toBe(firstPage.cursor);
		store.close();
	});

	test("retention stays bounded and an expired cursor returns the exact reset shape", async () => {
		const path = await databasePath();
		let now = Date.parse("2026-07-29T00:00:00.000Z");
		const store = new SqliteControlStore({ databasePath: path, now: () => now, randomBytes: deterministicRandom(), maximumEventsPerScope: 2, eventRetentionSeconds: 604_800 });
		const oldCursor = store.listResources({ scopeId: "scope_personal" }).highWaterCursor;
		for (let index = 1; index <= 3; index++) {
			now += 1000;
			store.appendEvent({ eventId: `evt_${index}`, resourceKind: "runtime", resourceId: "rt_alpha", scopeId: "scope_personal", revision: `rev_${index}`, phase: "Ready", timestamp: new Date(now).toISOString() });
		}
		const expired = store.readAfter({ scopeId: "scope_personal", cursor: oldCursor });
		expect(expired.outcome).toBe("cursorExpired");
		if (expired.outcome !== "cursorExpired") throw new Error("old cursor was accepted");
		expect(Object.keys(expired.reset).sort()).toEqual(["event", "eventId", "reason", "timestamp"]);
		expect(expired.reset.event).toBe("reset");
		expect(expired.reset.reason).toBe("cursor_expired");
		store.close();
		const database = new Database(path);
		const retained = database.query("SELECT COUNT(*) AS count FROM events WHERE scope_id='scope_personal'").get();
		if (!retained || typeof retained !== "object" || !(("count" in retained)) || typeof retained.count !== "number") throw new Error("event count missing");
		expect(retained.count).toBe(2);
		database.close();
	});

	test("interior and trailing journal deletion fail closed instead of replaying a gap", async () => {
		for (const deletedSequence of [2, 3]) {
			const path = await databasePath();
			let store = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom(deletedSequence) });
			const cursor = store.listResources({ scopeId: "scope_personal" }).highWaterCursor;
			for (let index = 1; index <= 3; index++) store.appendEvent({ eventId: `evt_${deletedSequence}_${index}`, resourceKind: "runtime", resourceId: "rt_alpha", scopeId: "scope_personal", revision: `rev_${index}`, phase: "Ready", timestamp: `2026-07-29T00:00:0${index}.000Z` });
			store.close();
			const database = new Database(path);
			database.run("DELETE FROM events WHERE scope_id=? AND sequence=?", ["scope_personal", deletedSequence]);
			database.close();
			store = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom(100 + deletedSequence) });
			expect(() => store.readAfter({ scopeId: "scope_personal", cursor })).toThrow(ControlStoreStateError);
			store.close();
		}
	});

	test("clock rollback cannot age-prune a middle event into a journal hole", async () => {
		const path = await databasePath();
		let now = Date.parse("2026-07-29T00:00:10.000Z");
		const store = new SqliteControlStore({ databasePath: path, now: () => now, randomBytes: deterministicRandom(), eventRetentionSeconds: 1 });
		const cursor = store.listResources({ scopeId: "scope_personal" }).highWaterCursor;
		store.appendEvent({ eventId: "evt_clock_1", resourceKind: "runtime", resourceId: "rt_alpha", scopeId: "scope_personal", revision: "rev_1", phase: "Ready", timestamp: new Date(now).toISOString() });
		now -= 2000;
		store.appendEvent({ eventId: "evt_clock_2", resourceKind: "runtime", resourceId: "rt_alpha", scopeId: "scope_personal", revision: "rev_2", phase: "Ready", timestamp: new Date(now).toISOString() });
		now += 1500;
		store.appendEvent({ eventId: "evt_clock_3", resourceKind: "runtime", resourceId: "rt_alpha", scopeId: "scope_personal", revision: "rev_3", phase: "Ready", timestamp: new Date(now).toISOString() });
		const replay = store.readAfter({ scopeId: "scope_personal", cursor });
		expect(replay.outcome === "events" && replay.events.map((event) => event.eventId)).toEqual(["evt_clock_1", "evt_clock_2", "evt_clock_3"]);
		store.close();
	});

	test("cursor authentication survives restart and rejects cross-scope or future cursors", async () => {
		const path = await databasePath();
		let store = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom() });
		const cursor = store.listResources({ scopeId: "scope_personal" }).highWaterCursor;
		store.close();
		store = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom(200) });
		expect(store.readAfter({ scopeId: "scope_personal", cursor })).toEqual({ outcome: "events", events: [], cursor });
		expect(() => store.readAfter({ scopeId: "scope_other", cursor })).toThrow(ControlStoreInputError);
		store.close();
	});

	test("subscribe replays an event appended after list without a list-watch gap", async () => {
		const path = await databasePath();
		const store = new SqliteControlStore({ databasePath: path, randomBytes: deterministicRandom() });
		const cursor = store.listResources({ scopeId: "scope_personal" }).highWaterCursor;
		store.appendEvent({ eventId: "evt_between", resourceKind: "runtime", resourceId: "rt_alpha", scopeId: "scope_personal", revision: "rev_one", phase: "Ready", timestamp: "2026-07-29T00:00:01.000Z" });
		const abort = new AbortController();
		const subscription = store.subscribe({ scopeId: "scope_personal", cursor, signal: abort.signal });
		const replay = await subscription.next();
		abort.abort();
		expect(replay.value?.outcome === "events" && replay.value.events.map((event) => event.eventId)).toEqual(["evt_between"]);
		store.close();
	});
});
