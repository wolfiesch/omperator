import { describe, expect, test } from "bun:test";
import { entryId, hostId, projectId, sessionId } from "@t4-code/host-wire";
import { OmpAuthorityBridgeClient, type OmpAuthorityBridgeChild } from "../src/omp-authority-bridge-client.ts";
import {
	decodeOmpAuthorityBridgeClientFrame,
	encodeOmpAuthorityBridgeFrame,
	OMP_AUTHORITY_BRIDGE_MAX_LINE_BYTES,
	OMP_AUTHORITY_BRIDGE_PROTOCOL,
} from "../src/omp-authority-bridge-contract.ts";
import type { SessionRecord } from "../src/types.ts";

class AsyncQueue implements AsyncIterable<string> {
	readonly #values: string[] = [];
	readonly #waiters: Array<(value: IteratorResult<string>) => void> = [];
	#closed = false;
	push(value: string): void {
		const waiter = this.#waiters.shift();
		if (waiter) waiter({ done: false, value });
		else this.#values.push(value);
	}
	close(): void {
		this.#closed = true;
		for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
	}
	[Symbol.asyncIterator](): AsyncIterator<string> {
		return {
			next: () => {
				const value = this.#values.shift();
				if (value !== undefined) return Promise.resolve({ done: false, value });
				if (this.#closed) return Promise.resolve({ done: true, value: undefined });
				return new Promise(resolve => this.#waiters.push(resolve));
			},
		};
	}
}

class FakeBridgeChild implements OmpAuthorityBridgeChild {
	readonly output = new AsyncQueue();
	readonly error = new AsyncQueue();
	readonly writes: string[] = [];
	readonly exit = Promise.withResolvers<number>();
	killed = false;
	readonly stdin = {
		write: (data: string): void => { this.writes.push(data); },
		end: (): void => { this.output.close(); this.exit.resolve(0); },
	};
	readonly stdout = this.output;
	readonly stderr = this.error;
	readonly exited = this.exit.promise;
	kill(): void { this.killed = true; this.output.close(); this.exit.resolve(143); }
	server(frame: Parameters<typeof encodeOmpAuthorityBridgeFrame>[0]): void {
		this.output.push(encodeOmpAuthorityBridgeFrame(frame));
	}
	request(index = 0) {
		return decodeOmpAuthorityBridgeClientFrame(JSON.parse(this.writes[index]!));
	}
}

const ready = {
	v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
	type: "ready" as const,
	methods: ["host.info", "session.list", "operation.termOpen", "terminal.input", "terminal.resize", "terminal.close", "lock.status", "usage.read"] as const,
	ompVersion: "17.0.5",
	ompBuild: "bridge-test",
};

function listedSession(id: string): SessionRecord {
	return {
		sessionId: sessionId(id),
		path: `/tmp/${id}.jsonl`,
		cwd: "/tmp",
		projectId: projectId("listed-project"),
		title: id,
		updatedAt: "2026-07-23T00:00:00.000Z",
		status: "idle",
		entries: [],
	};
}

describe("OMP authority bridge client", () => {
	test("waits for ready, exposes only advertised authorities, and routes responses", async () => {
		const child = new FakeBridgeChild();
		const client = new OmpAuthorityBridgeClient({ executable: "/opt/omp" }, () => child);
		const started = client.start();
		child.server(ready);
		expect((await started).methods).toEqual(ready.methods);
		expect(client.identity).toEqual({ ompVersion: "17.0.5", ompBuild: "bridge-test" });
		const authorities = client.createAuthorities();
		expect(authorities.operationsAuthority.filesRead).toBeUndefined();
		expect(typeof authorities.operationsAuthority.termOpen).toBe("function");
		// An OMP build that does not advertise forking exposes no fork method, so
		// the host withholds the feature instead of calling into a missing one.
		expect(authorities.sessionAuthority.fork).toBeUndefined();
		const listed = authorities.sessionAuthority.list();
		await Bun.sleep(0);
		const request = child.request();
		expect(request).toMatchObject({ type: "request", method: "session.list", params: {} });
		child.server({ v: OMP_AUTHORITY_BRIDGE_PROTOCOL, type: "response", id: request.id, ok: true, result: [] });
		expect(await listed).toEqual([]);
		await client.stop();
	});

	test("assembles every bounded page from one bridge inventory snapshot", async () => {
		const child = new FakeBridgeChild();
		const client = new OmpAuthorityBridgeClient({ executable: "/opt/omp" }, () => child);
		const started = client.start();
		child.server(ready);
		await started;
		const authorities = client.createAuthorities();
		const listed = authorities.sessionAuthority.list();
		await Bun.sleep(0);
		const first = child.request(0);
		expect(first).toMatchObject({ type: "request", method: "session.list", params: {} });
		child.server({
			v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
			type: "response",
			id: first.id,
			ok: true,
			result: {
				sessions: [listedSession("first")],
				nextCursor: "snapshot-cursor-1",
				complete: true,
				totalCount: 3,
			},
		});
		await Bun.sleep(0);
		const second = child.request(1);
		expect(second).toMatchObject({
			type: "request",
			method: "session.list",
			params: { cursor: "snapshot-cursor-1" },
		});
		child.server({
			v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
			type: "response",
			id: second.id,
			ok: true,
			result: {
				sessions: [listedSession("second")],
				nextCursor: "snapshot-cursor-2",
				complete: true,
				totalCount: 3,
			},
		});
		await Bun.sleep(0);
		const third = child.request(2);
		expect(third).toMatchObject({
			type: "request",
			method: "session.list",
			params: { cursor: "snapshot-cursor-2" },
		});
		child.server({
			v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
			type: "response",
			id: third.id,
			ok: true,
			result: { sessions: [listedSession("third")], complete: true, totalCount: 3 },
		});
		expect((await listed).map(record => String(record.sessionId))).toEqual(["first", "second", "third"]);
		expect(authorities.discovery.inventoryComplete?.()).toBe(true);
		expect(authorities.discovery.inventoryTotalCount?.()).toBe(3);
		await client.stop();
	});

	test("preserves partial-inventory metadata for safe host reconciliation", async () => {
		const child = new FakeBridgeChild();
		const client = new OmpAuthorityBridgeClient({ executable: "/opt/omp" }, () => child);
		const started = client.start();
		child.server(ready);
		await started;
		const authorities = client.createAuthorities();
		const listed = authorities.sessionAuthority.list();
		await Bun.sleep(0);
		const request = child.request();
		child.server({
			v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
			type: "response",
			id: request.id,
			ok: true,
			result: {
				sessions: [listedSession("visible")],
				complete: false,
				totalCount: 2,
			},
		});
		expect((await listed).map(record => String(record.sessionId))).toEqual(["visible"]);
		expect(authorities.discovery.inventoryComplete?.()).toBe(false);
		expect(authorities.discovery.inventoryTotalCount?.()).toBe(2);
		await client.stop();
	});

	test("keeps session inventory sparse when the bridge cache contains loaded transcripts", async () => {
		const child = new FakeBridgeChild();
		const client = new OmpAuthorityBridgeClient({ executable: "/opt/omp" }, () => child);
		const started = client.start();
		child.server(ready);
		await started;
		const listed = client.createAuthorities().sessionAuthority.list();
		await Bun.sleep(0);
		const request = child.request();
		const session: SessionRecord = {
			sessionId: sessionId("loaded-session"),
			path: "/tmp/loaded-session.jsonl",
			cwd: "/tmp",
			projectId: projectId("loaded-project"),
			title: "Loaded session",
			updatedAt: "2026-07-22T00:00:00.000Z",
			status: "idle",
			entries: [{
				id: entryId("loaded-entry"),
				parentId: null,
				hostId: hostId("host-test"),
				sessionId: sessionId("loaded-session"),
				kind: "message",
				timestamp: "2026-07-22T00:00:00.000Z",
				data: { text: "x".repeat(600_000) },
			}],
		};
		child.server({
			v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
			type: "response",
			id: request.id,
			ok: true,
			result: [session],
		});
		expect(await listed).toEqual([{ ...session, entriesLoaded: false, entries: [] }]);
		await client.stop();
	});

	test("keeps terminal events attached before and after term.open settles", async () => {
		const child = new FakeBridgeChild();
		const client = new OmpAuthorityBridgeClient({ executable: "/opt/omp" }, () => child);
		const started = client.start();
		child.server(ready);
		await started;
		const authorities = client.createAuthorities();
		const events: unknown[] = [];
		const context = {
			hostId: hostId("host-test"),
			sessionId: sessionId("session-test"),
			deviceId: "device-test",
			connectionId: "connection-test",
			capabilities: new Set(["term.open", "term.input", "term.resize"] as const),
			abortSignal: new AbortController().signal,
			emitTerminalOutput: (frame: unknown) => events.push(frame),
		};
		const opened = authorities.operationsAuthority.termOpen!({}, context);
		await Bun.sleep(0);
		const request = child.request();
		const output = { type: "terminal.output", terminalId: "terminal-1", data: "before" };
		child.server({ v: OMP_AUTHORITY_BRIDGE_PROTOCOL, type: "event", id: request.id, event: "terminal", payload: output });
		child.server({
			v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
			type: "response",
			id: request.id,
			ok: true,
			result: { terminalId: "terminal-1" },
		});
		expect(await opened).toEqual({ terminalId: "terminal-1" });
		const after = { type: "terminal.exit", terminalId: "terminal-1", exitCode: 0 };
		child.server({ v: OMP_AUTHORITY_BRIDGE_PROTOCOL, type: "event", id: request.id, event: "terminal", payload: after });
		await Bun.sleep(0);
		expect(events).toEqual([output, after]);
		await client.stop();
	});

	test("forwards abort and rejects locally without waiting for an unresponsive bridge", async () => {
		const child = new FakeBridgeChild();
		const client = new OmpAuthorityBridgeClient({ executable: "/opt/omp" }, () => child);
		const started = client.start();
		child.server(ready);
		await started;
		const controller = new AbortController();
		const pending = client.createAuthorities().usageAuthority!.read(controller.signal);
		await Bun.sleep(0);
		const request = child.request();
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "ABORTED", message: "operation was cancelled" });
		expect(child.request(1)).toEqual({ v: OMP_AUTHORITY_BRIDGE_PROTOCOL, type: "cancel", id: request.id });
		await client.stop();
	});

	test("sends sparse session references to authority methods after a transcript is loaded", async () => {
		const child = new FakeBridgeChild();
		const client = new OmpAuthorityBridgeClient({ executable: "/opt/omp" }, () => child);
		const started = client.start();
		child.server({
			...ready,
			methods: [
				...ready.methods,
				"session.archive",
				"session.restore",
				"session.delete",
				"session.fork",
				"discovery.load",
				"discovery.page",
				"lock.check",
			],
		});
		await started;
		const authorities = client.createAuthorities();
		const session: SessionRecord = {
			sessionId: sessionId("large-session"),
			path: "/tmp/large-session.jsonl",
			cwd: "/tmp",
			projectId: projectId("large-project"),
			title: "Large session",
			updatedAt: "2026-07-22T00:00:00.000Z",
			status: "idle",
			entries: [{
				id: entryId("large-entry"),
				parentId: null,
				hostId: hostId("host-test"),
				sessionId: sessionId("large-session"),
				kind: "message",
				timestamp: "2026-07-22T00:00:00.000Z",
				data: { text: "x".repeat(300_000) },
			}],
		};
		const forkResult = { sessionId: sessionId("forked-session"), path: "/tmp/forked-session.jsonl", cwd: "/tmp", title: "Large session", entries: [] };
		const calls = [
			{ method: "lock.status", pending: authorities.lockStatus(session), result: "missing" },
			{ method: "lock.check", pending: Promise.resolve(authorities.lockCheck(session)), result: null },
			{ method: "session.archive", pending: authorities.sessionAuthority.archive(session, "2026-07-22T00:00:00.000Z"), result: null },
			{ method: "session.restore", pending: authorities.sessionAuthority.restore(session), result: null },
			{ method: "session.delete", pending: authorities.sessionAuthority.delete(session), result: null },
			// The source crosses as a sparse reference; OMP resolves it by id.
			{ method: "session.fork", pending: authorities.sessionAuthority.fork!(session), result: forkResult },
			{ method: "discovery.load", pending: authorities.discovery.load!(session), result: session },
			{ method: "discovery.page", pending: authorities.discovery.page!(session, { limit: 10 }), result: { entries: [], hasMore: false } },
		] as const;
		for (let index = 0; index < calls.length; index += 1) {
			await Bun.sleep(0);
			const request = child.request(index);
			expect(request).toMatchObject({
				type: "request",
				method: calls[index]!.method,
				params: { session: { entries: [], entriesLoaded: false } },
			});
			child.server({
				v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
				type: "response",
				id: request.id,
				ok: true,
				result: calls[index]!.result,
			});
			await calls[index]!.pending;
		}
		await client.stop();
	});

	test("fails closed on an oversized unfinished bridge frame", async () => {
		const child = new FakeBridgeChild();
		const client = new OmpAuthorityBridgeClient({ executable: "/opt/omp" }, () => child);
		const started = client.start();
		child.output.push("x".repeat(OMP_AUTHORITY_BRIDGE_MAX_LINE_BYTES + 1));
		await expect(started).rejects.toThrow("bridge output exceeds the line limit");
		expect(child.killed).toBe(true);
	});
});
