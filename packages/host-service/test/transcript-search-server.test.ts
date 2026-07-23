import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	entryId,
	hostId,
	projectId,
	type Revision,
	type ServerFrame,
	type SessionId,
	sessionId,
	type TranscriptContextArguments,
	type TranscriptContextResult,
	type TranscriptSearchArguments,
	type TranscriptSearchResult,
} from "@t4-code/host-wire";
import { appserverSupportedFeatures, createAppserver, type LocalAppserver } from "../src/server.ts";
import { TranscriptSearchError, TranscriptSearchIndex } from "../src/transcript-search-index.ts";
import type {
	AppserverTranscriptSearchAuthority,
	SessionAuthority,
	SessionDiscovery,
	SessionRecord,
} from "../src/types.ts";
import { RawUdsWebSocket } from "./raw-uds-client.ts";

const host = hostId("transcript-search-server-test");
const project = projectId("project-test");
const stamp = "2026-01-01T00:00:00.000Z";

function record(id: string, archivedAt?: string): SessionRecord {
	return {
		sessionId: sessionId(id),
		path: `/tmp/${id}.jsonl`,
		cwd: "/tmp",
		projectId: project,
		title: id,
		updatedAt: stamp,
		status: "idle",
		...(archivedAt ? { archivedAt } : {}),
		entries: [],
	};
}

function transcriptMessage(id: string, text: string): string {
	return `${JSON.stringify({
		type: "message",
		id,
		timestamp: stamp,
		message: { role: "assistant", content: [{ type: "text", text }] },
	})}\n`;
}

class StaticDiscovery implements SessionDiscovery {
	constructor(private readonly records: SessionRecord[]) {}
	async list(): Promise<SessionRecord[]> {
		return this.records;
	}
}

class PartialDiscovery extends StaticDiscovery {
	inventoryComplete(): boolean {
		return false;
	}
	inventoryTotalCount(): number {
		return 2;
	}
}

class FakeSessionAuthority implements SessionAuthority {
	constructor(
		private readonly records: SessionRecord[],
		private readonly lifecycle: string[],
	) {}
	async list(): Promise<SessionRecord[]> {
		return this.records;
	}
	async create(): Promise<SessionRecord> {
		throw new Error("not used");
	}
	async archive(): Promise<void> {
		throw new Error("not used");
	}
	async restore(): Promise<void> {
		throw new Error("not used");
	}
	async delete(session: SessionRecord): Promise<void> {
		this.lifecycle.push(`session.delete:${session.sessionId}`);
		const index = this.records.findIndex(candidate => candidate.sessionId === session.sessionId);
		if (index >= 0) this.records.splice(index, 1);
	}
}

const searchResult: TranscriptSearchResult = {
	items: [],
	incomplete: false,
	index: {
		state: "ready",
		indexedSessions: 1,
		knownSessions: 1,
		generation: "generation-1",
	},
};

const contextResult: TranscriptContextResult = {
	anchorId: entryId("anchor-1"),
	rows: [
		{
			anchorId: entryId("anchor-1"),
			role: "assistant",
			timestamp: stamp,
			text: "The earlier decision",
		},
	],
	anchorIndex: 0,
	hasBefore: false,
	hasAfter: false,
	generation: "generation-1",
};

class FakeTranscriptSearchAuthority implements AppserverTranscriptSearchAuthority {
	readonly lifecycle: string[];
	readonly searches: TranscriptSearchArguments[] = [];
	readonly contexts: Array<{ sessionId: string; args: TranscriptContextArguments }> = [];
	initializeCalls = 0;
	reconcileCalls = 0;
	lastReconcileOptions: { readonly pruneMissing?: boolean } | undefined;
	closeCalls = 0;
	constructor(lifecycle: string[] = []) {
		this.lifecycle = lifecycle;
	}

	async initialize(): Promise<void> {
		this.initializeCalls += 1;
		this.lifecycle.push("search.initialize");
	}
	async reconcile(
		_records: readonly SessionRecord[],
		options?: { readonly pruneMissing?: boolean },
	): Promise<TranscriptSearchResult["index"]> {
		this.reconcileCalls += 1;
		this.lastReconcileOptions = options;
		this.lifecycle.push("search.reconcile");
		return searchResult.index;
	}
	search(args: TranscriptSearchArguments, signal: AbortSignal): TranscriptSearchResult {
		expect(signal.aborted).toBe(false);
		this.searches.push(args);
		return searchResult;
	}
	context(session: SessionId, args: TranscriptContextArguments, signal: AbortSignal): TranscriptContextResult {
		expect(signal.aborted).toBe(false);
		this.contexts.push({ sessionId: session, args });
		return contextResult;
	}
	deleteSession(session: SessionId): void {
		this.lifecycle.push(`search.delete:${session}`);
	}
	close(): void {
		this.closeCalls += 1;
		this.lifecycle.push("search.close");
	}
}

class FailingTranscriptSearchAuthority extends FakeTranscriptSearchAuthority {
	override search(): TranscriptSearchResult {
		throw new TranscriptSearchError("transcript_cursor_stale");
	}
	override context(): TranscriptContextResult {
		throw new TranscriptSearchError("transcript_anchor_not_found");
	}
}

class SynchronouslyFailingReconcileAuthority extends FakeTranscriptSearchAuthority {
	override reconcile(): Promise<TranscriptSearchResult["index"]> {
		throw new Error("synchronous search maintenance failure");
	}
}

function hello(): Record<string, unknown> {
	return {
		v: "omp-app/1",
		type: "hello",
		protocol: { min: "omp-app/1", max: "omp-app/1" },
		client: { name: "transcript-search-test", version: "1", build: "test", platform: "linux" },
		requestedFeatures: ["transcript.search"],
		capabilities: { client: ["sessions.read", "sessions.manage"] },
		savedCursors: [],
	};
}

function hostCommand(
	requestId: string,
	commandId: string,
	command: string,
	args: Record<string, unknown>,
): Record<string, unknown> {
	return {
		v: "omp-app/1",
		type: "command",
		requestId,
		commandId,
		hostId: host,
		command,
		args,
	};
}

function sessionCommand(
	requestId: string,
	commandId: string,
	command: string,
	session: string,
	args: Record<string, unknown>,
	expectedRevision?: Revision,
): Record<string, unknown> {
	return {
		...hostCommand(requestId, commandId, command, args),
		sessionId: sessionId(session),
		...(expectedRevision === undefined ? {} : { expectedRevision }),
	};
}

function confirmation(
	requestId: string,
	confirmationId: string,
	commandId: string,
	session: string,
): Record<string, unknown> {
	return {
		v: "omp-app/1",
		type: "confirm",
		requestId,
		confirmationId,
		commandId,
		hostId: host,
		sessionId: sessionId(session),
		decision: "approve",
	};
}

async function readyClient(socketPath: string): Promise<{
	client: RawUdsWebSocket;
	welcome: Extract<ServerFrame, { type: "welcome" }>;
}> {
	const client = await RawUdsWebSocket.connect(socketPath);
	client.sendJson(hello());
	const welcome = await client.nextServer();
	if (welcome.type !== "welcome") throw new Error("missing welcome frame");
	const sessions = await client.nextServer();
	if (sessions.type !== "sessions") throw new Error("missing sessions frame");
	return { client, welcome };
}

async function responseFor(
	client: RawUdsWebSocket,
	requestId: string,
): Promise<Extract<ServerFrame, { type: "response" }>> {
	for (;;) {
		const frame = await client.nextServer();
		if (frame.type === "response" && frame.requestId === requestId) return frame;
	}
}

async function startServer(
	records: SessionRecord[],
	transcriptSearchAuthority: AppserverTranscriptSearchAuthority,
	sessionAuthority?: SessionAuthority,
): Promise<{ appserver: LocalAppserver; client: RawUdsWebSocket; root: string }> {
	const root = await mkdtemp(join(tmpdir(), "omp-transcript-search-server-"));
	const socketPath = join(root, "run", "app.sock");
	const appserver = createAppserver({
		hostId: host,
		epoch: "transcript-search-test",
		socketPath,
		discovery: new StaticDiscovery(records),
		sessionAuthority,
		transcriptSearchAuthority,
	});
	await appserver.start();
	const { client } = await readyClient(socketPath);
	return { appserver, client, root };
}

async function cleanup(appserver: LocalAppserver, client: RawUdsWebSocket, root: string): Promise<void> {
	client.destroy();
	await client.closed();
	await appserver.stop();
	await rm(root, { recursive: true, force: true });
}

describe("transcript search appserver boundary", () => {
	test("advertises the feature only when a search authority exists", () => {
		expect(appserverSupportedFeatures({})).not.toContain("transcript.search");
		expect(appserverSupportedFeatures({ transcriptSearchAuthority: new FakeTranscriptSearchAuthority() })).toContain(
			"transcript.search",
		);
	});

	test("keeps initial session inventory independent from deferred search maintenance", async () => {
		const search = new SynchronouslyFailingReconcileAuthority();
		const { appserver, client, root } = await startServer([record("visible")], search);
		await cleanup(appserver, client, root);
	});

	test("marks partial inventory reconciliation as non-pruning", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-transcript-search-partial-"));
		const socketPath = join(root, "run", "app.sock");
		const search = new FakeTranscriptSearchAuthority();
		const appserver = createAppserver({
			hostId: host,
			epoch: "transcript-search-partial-test",
			socketPath,
			discovery: new PartialDiscovery([record("visible")]),
			transcriptSearchAuthority: search,
		});
		await appserver.start();
		const { client } = await readyClient(socketPath);
		try {
			for (let attempt = 0; attempt < 20 && search.reconcileCalls === 0; attempt += 1)
				await Bun.sleep(5);
			expect(search.lastReconcileOptions).toEqual({ pruneMissing: false });
		} finally {
			await cleanup(appserver, client, root);
		}
	});

	test("routes search and archived context reads and never replays them from idempotency", async () => {
		const search = new FakeTranscriptSearchAuthority();
		const archived = record("archived", "2026-01-02T00:00:00.000Z");
		const { appserver, client, root } = await startServer([archived], search);
		try {
			client.sendJson(
				hostCommand("search-1", "reused-search-command", "transcript.search", {
					query: "earlier decision",
					limit: 7,
					roles: ["user", "assistant"],
					archived: "include",
				}),
			);
			expect(await responseFor(client, "search-1")).toMatchObject({ ok: true, result: searchResult });

			client.sendJson(
				hostCommand("search-2", "reused-search-command", "transcript.search", {
					query: "earlier decision",
					limit: 7,
					roles: ["user", "assistant"],
					archived: "include",
				}),
			);
			expect(await responseFor(client, "search-2")).toMatchObject({ ok: true, result: searchResult });
			expect(search.searches).toEqual([
				{ query: "earlier decision", limit: 7, roles: ["user", "assistant"], archived: "include" },
				{ query: "earlier decision", limit: 7, roles: ["user", "assistant"], archived: "include" },
			]);

			client.sendJson(
				sessionCommand("context-1", "reused-context-command", "transcript.context", "archived", {
					anchorId: "anchor-1",
					before: 3,
					after: 4,
				}),
			);
			expect(await responseFor(client, "context-1")).toMatchObject({ ok: true, result: contextResult });
			client.sendJson(
				sessionCommand("context-2", "reused-context-command", "transcript.context", "archived", {
					anchorId: "anchor-1",
					before: 3,
					after: 4,
				}),
			);
			expect(await responseFor(client, "context-2")).toMatchObject({ ok: true, result: contextResult });
			expect(search.contexts).toEqual([
				{ sessionId: "archived", args: { anchorId: entryId("anchor-1"), before: 3, after: 4 } },
				{ sessionId: "archived", args: { anchorId: entryId("anchor-1"), before: 3, after: 4 } },
			]);
		} finally {
			await cleanup(appserver, client, root);
		}
	});

	test("refreshes appended transcripts and newly discovered sessions before serving search", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-transcript-search-live-"));
		const firstPath = join(root, "first.jsonl");
		const secondPath = join(root, "second.jsonl");
		await Bun.write(firstPath, transcriptMessage("old", "original koala decision"));
		const records = [{ ...record("first"), path: firstPath }];
		const search = new TranscriptSearchIndex(join(root, "search.sqlite"));
		const socketPath = join(root, "run", "app.sock");
		const appserver = createAppserver({
			hostId: host,
			epoch: "transcript-search-live-test",
			socketPath,
			discovery: new StaticDiscovery(records),
			transcriptSearchAuthority: search,
		});
		await appserver.start();
		const { client } = await readyClient(socketPath);
		try {
			await appendFile(firstPath, transcriptMessage("recent", "recent narwhal conclusion"));
			client.sendJson(hostCommand("recent-search", "recent-search", "transcript.search", { query: "narwhal" }));
			expect(await responseFor(client, "recent-search")).toMatchObject({
				ok: true,
				result: {
					items: [{ sessionId: "first", anchorId: "recent" }],
					incomplete: false,
					index: { state: "ready", indexedSessions: 1, knownSessions: 1 },
				},
			});

			await Bun.write(secondPath, transcriptMessage("new-session", "new platypus architecture"));
			records.push({ ...record("second"), path: secondPath });
			client.sendJson(hostCommand("new-search", "new-search", "transcript.search", { query: "platypus" }));
			expect(await responseFor(client, "new-search")).toMatchObject({
				ok: true,
				result: {
					items: [{ sessionId: "second", anchorId: "new-session" }],
					incomplete: false,
					index: { state: "ready", indexedSessions: 2, knownSessions: 2 },
				},
			});
		} finally {
			await cleanup(appserver, client, root);
		}
	});

	test("purges a deleted session before reporting success and closes its index authority", async () => {
		const lifecycle: string[] = [];
		const records = [record("delete-me")];
		const search = new FakeTranscriptSearchAuthority(lifecycle);
		const authority = new FakeSessionAuthority(records, lifecycle);
		const { appserver, client, root } = await startServer(records, search, authority);
		try {
			const revision = appserver.snapshot(sessionId("delete-me"))?.revision;
			if (revision === undefined) throw new Error("missing session revision");
			client.sendJson(sessionCommand("delete", "delete", "session.delete", "delete-me", {}, revision));
			const challenge = await client.nextServer();
			if (challenge.type !== "confirmation") throw new Error("missing deletion confirmation");
			client.sendJson(confirmation("delete-confirm", String(challenge.confirmationId), "delete", "delete-me"));
			expect(await responseFor(client, "delete")).toMatchObject({ ok: true, result: { deleted: true } });
			expect(lifecycle).toContain("session.delete:delete-me");
			expect(lifecycle).toContain("search.delete:delete-me");
			expect(lifecycle.indexOf("session.delete:delete-me")).toBeLessThan(
				lifecycle.indexOf("search.delete:delete-me"),
			);
		} finally {
			await cleanup(appserver, client, root);
		}
		expect(search.initializeCalls).toBe(1);
		expect(search.reconcileCalls).toBeGreaterThanOrEqual(1);
		expect(search.closeCalls).toBe(1);
		expect(lifecycle.at(-1)).toBe("search.close");
	});

	test("returns stable public errors without an unrelated operations authority", async () => {
		const search = new FailingTranscriptSearchAuthority();
		const current = record("current");
		const { appserver, client, root } = await startServer([current], search);
		try {
			client.sendJson(hostCommand("stale", "stale", "transcript.search", { query: "decision" }));
			expect(await responseFor(client, "stale")).toMatchObject({
				ok: false,
				error: { code: "transcript_cursor_stale", message: "transcript search cursor is stale" },
			});

			client.sendJson(sessionCommand("missing", "missing", "transcript.context", "current", { anchorId: "gone" }));
			expect(await responseFor(client, "missing")).toMatchObject({
				ok: false,
				error: { code: "transcript_anchor_not_found", message: "transcript entry no longer exists" },
			});
		} finally {
			await cleanup(appserver, client, root);
		}
	});
});
