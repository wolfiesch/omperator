import type { SessionId } from "@t4-code/host-wire";
import type { AppserverEvent } from "./transcript-events.ts";
import type {
	AppserverDrainResult,
	AppserverOptions,
	AppserverTestControl,
	AppserverTestControlStatus,
	AppserverTestSeedRequest,
} from "./types.ts";

const ORDERED_STREAM_TEST_SCENARIO = "ordered-turn-v1";

export interface AdminRequestHooks {
	readonly health: () => {
		readonly ok: true;
		readonly hostId: string;
		readonly epoch: string;
		readonly draining: boolean;
	};
	readonly unavailable: () => boolean;
	readonly stopping: () => boolean;
	readonly tryDrainIfIdle: (expectedHostId: string, expectedEpoch: string) => AppserverDrainResult;
	readonly runLifecycleMutation: (operation: () => Promise<Response>) => Promise<Response>;
	readonly runTestControlMutation: (operation: () => Promise<Response>) => Promise<Response>;
	readonly refreshInventoryAfterMutation: () => Promise<void>;
	readonly claimTestSessions: (control: AppserverTestControl, runId: string) => Promise<void>;
	readonly quiesceTestSessions: (control: AppserverTestControl, runId: string) => Promise<void>;
	readonly testControlStatus: (
		control: AppserverTestControl,
		runId: string,
		status: AppserverTestControlStatus,
	) => Promise<AppserverTestControlStatus>;
	readonly streamTestEvents: (
		sessionId: SessionId,
		events: readonly AppserverEvent[],
		stepMs: number,
	) => Promise<boolean>;
	readonly evictTestSession: (sessionId: SessionId) => Promise<void>;
	readonly now: () => Date;
}

export class AdminRequestRouter {
	readonly #admin: AppserverOptions["admin"];
	readonly #testControl: AppserverOptions["testControl"];
	readonly #hooks: AdminRequestHooks;

	constructor(options: Pick<AppserverOptions, "admin" | "testControl">, hooks: AdminRequestHooks) {
		this.#admin = options.admin;
		this.#testControl = options.testControl;
		this.#hooks = hooks;
	}

	async route(request: Request): Promise<Response | undefined> {
		const pathname = new URL(request.url).pathname;
		if (pathname === "/health" && request.method === "GET") return Response.json(this.#hooks.health());
		if (pathname === "/admin/drain-if-idle") return this.#drainIfIdle(request);
		if (pathname === "/admin/pair-ticket") return this.#pairTicket(request);
		if (pathname === "/admin/devices") return this.#devices(request);
		if (pathname === "/admin/revoke") return this.#revoke(request);
		if (pathname === "/admin/test/seed") return this.#testSeed(request);
		if (pathname === "/admin/test/status") return this.#testStatus(request);
		if (pathname === "/admin/test/stream") return this.#testStream(request);
		if (pathname === "/admin/test/cleanup") return this.#testCleanup(request);
		return undefined;
	}

	#error(status = 400): Response {
		return Response.json({ error: "invalid admin request" }, { status });
	}

	async #json(request: Request, keys: readonly string[]): Promise<Record<string, unknown> | Response> {
		if (request.method !== "POST" || request.headers.get("content-type") !== "application/json")
			return this.#error(405);
		const length = request.headers.get("content-length");
		if (length !== null && (!/^\d+$/u.test(length) || Number(length) > 16_384)) return this.#error(413);
		let bytes: ArrayBuffer;
		try {
			bytes = await request.arrayBuffer();
		} catch {
			return this.#error();
		}
		if (bytes.byteLength > 16_384) return this.#error(413);
		let value: unknown;
		try {
			value = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			return this.#error();
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) return this.#error();
		const body = value as Record<string, unknown>;
		if (Object.keys(body).some(key => !keys.includes(key))) return this.#error();
		return body;
	}

	async #drainIfIdle(request: Request): Promise<Response> {
		if (this.#hooks.stopping()) return this.#error(503);
		const body = await this.#json(request, ["expectedHostId", "expectedEpoch"]);
		if (body instanceof Response) return body;
		if (this.#hooks.stopping()) return this.#error(503);
		if (
			typeof body.expectedHostId !== "string" ||
			body.expectedHostId.length === 0 ||
			body.expectedHostId.length > 1024 ||
			typeof body.expectedEpoch !== "string" ||
			body.expectedEpoch.length === 0 ||
			body.expectedEpoch.length > 1024
		)
			return this.#error();
		return Response.json(this.#hooks.tryDrainIfIdle(body.expectedHostId, body.expectedEpoch));
	}

	async #pairTicket(request: Request): Promise<Response> {
		if (!this.#admin || request.method !== "POST") return this.#error(404);
		if (this.#hooks.unavailable()) return this.#error(503);
		return this.#hooks.runLifecycleMutation(async () => {
			const body = await this.#json(request, ["capabilities", "ttlMs", "expectedNodeId"]);
			if (body instanceof Response) return body;
			if (this.#hooks.unavailable()) return this.#error(503);
			const capabilities = body.capabilities;
			if (
				!Array.isArray(capabilities) ||
				capabilities.length === 0 ||
				capabilities.length > 32 ||
				capabilities.some(value => typeof value !== "string" || value.length === 0 || value.length > 128)
			)
				return this.#error();
			const ttl = body.ttlMs;
			if (ttl !== undefined && (typeof ttl !== "number" || !Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 600_000))
				return this.#error();
			const nodeId = body.expectedNodeId;
			if (nodeId !== undefined && (typeof nodeId !== "string" || nodeId.length === 0 || nodeId.length > 512))
				return this.#error();
			try {
				return Response.json(this.#admin?.issuePairingTicket(capabilities, ttl, nodeId));
			} catch {
				return this.#error();
			}
		});
	}

	#devices(request: Request): Response {
		if (!this.#admin || request.method !== "GET") return this.#error(404);
		try {
			return Response.json({ devices: this.#admin.listDevices() });
		} catch {
			return this.#error(500);
		}
	}

	async #revoke(request: Request): Promise<Response> {
		if (!this.#admin || request.method !== "POST") return this.#error(404);
		if (this.#hooks.unavailable()) return this.#error(503);
		return this.#hooks.runLifecycleMutation(async () => {
			const body = await this.#json(request, ["deviceId"]);
			if (body instanceof Response) return body;
			if (this.#hooks.unavailable()) return this.#error(503);
			if (typeof body.deviceId !== "string" || body.deviceId.length === 0 || body.deviceId.length > 512)
				return this.#error();
			try {
				return Response.json(this.#admin?.revokeDevice(body.deviceId));
			} catch {
				return this.#error();
			}
		});
	}

	#authorizedTestControl(request: Request): AppserverTestControl | undefined {
		const control = this.#testControl;
		if (!control || request.headers.get("authorization") !== `Bearer ${control.token}`) return undefined;
		return control;
	}

	async #testSeed(request: Request): Promise<Response> {
		const control = this.#authorizedTestControl(request);
		if (!control) return this.#error(404);
		if (this.#hooks.unavailable()) return this.#error(503);
		const body = await this.#json(request, ["runId", "projectRoot", "sessionCount", "historyEntries"]);
		if (body instanceof Response) return body;
		if (
			typeof body.runId !== "string" ||
			body.runId.length === 0 ||
			body.runId.length > 128 ||
			typeof body.projectRoot !== "string" ||
			body.projectRoot.length === 0 ||
			body.projectRoot.length > 4096 ||
			typeof body.sessionCount !== "number" ||
			!Number.isSafeInteger(body.sessionCount) ||
			body.sessionCount < 1 ||
			body.sessionCount > 100 ||
			typeof body.historyEntries !== "number" ||
			!Number.isSafeInteger(body.historyEntries) ||
			body.historyEntries < 0 ||
			body.historyEntries > 10_000
		)
			return this.#error();
		const seedRequest: AppserverTestSeedRequest = {
			runId: body.runId,
			projectRoot: body.projectRoot,
			sessionCount: body.sessionCount,
			historyEntries: body.historyEntries,
		};
		return this.#hooks.runTestControlMutation(async () => {
			try {
				await control.seed(seedRequest);
				await this.#hooks.refreshInventoryAfterMutation();
				await this.#hooks.claimTestSessions(control, seedRequest.runId);
				const status = await this.#hooks.testControlStatus(
					control,
					seedRequest.runId,
					await control.status(seedRequest.runId),
				);
				return Response.json(status);
			} catch {
				return this.#error(500);
			}
		});
	}

	async #testStatus(request: Request): Promise<Response> {
		const control = this.#authorizedTestControl(request);
		if (!control) return this.#error(404);
		const body = await this.#json(request, ["runId"]);
		if (body instanceof Response) return body;
		if (typeof body.runId !== "string" || body.runId.length === 0 || body.runId.length > 128)
			return this.#error();
		try {
			return Response.json(
				await this.#hooks.testControlStatus(control, body.runId, await control.status(body.runId)),
			);
		} catch {
			return this.#error(500);
		}
	}

	async #testStream(request: Request): Promise<Response> {
		const control = this.#authorizedTestControl(request);
		if (!control) return this.#error(404);
		if (this.#hooks.unavailable()) return this.#error(503);
		const body = await this.#json(request, ["runId", "scenario", "stepMs"]);
		if (body instanceof Response) return body;
		if (
			typeof body.runId !== "string" ||
			body.runId.length === 0 ||
			body.runId.length > 128 ||
			body.scenario !== ORDERED_STREAM_TEST_SCENARIO ||
			typeof body.stepMs !== "number" ||
			!Number.isSafeInteger(body.stepMs) ||
			body.stepMs < 0 ||
			body.stepMs > 250
		)
			return this.#error();
		const runId = body.runId;
		const stepMs = body.stepMs;
		return this.#hooks.runTestControlMutation(async () => {
			try {
				const [target, ...extra] = await control.sessionIds(runId);
				if (!target || extra.length > 0) return this.#error();
				await this.#hooks.refreshInventoryAfterMutation();
				const events = orderedStreamTestEvents(this.#hooks.now().toISOString());
				if (!(await this.#hooks.streamTestEvents(target, events, stepMs))) return this.#error(409);
				return Response.json({
					v: 1,
					runId,
					scenario: ORDERED_STREAM_TEST_SCENARIO,
					sessionId: target,
					events: events.length,
				});
			} catch {
				return this.#error(500);
			}
		});
	}

	async #testCleanup(request: Request): Promise<Response> {
		const control = this.#authorizedTestControl(request);
		if (!control) return this.#error(404);
		if (this.#hooks.unavailable()) return this.#error(503);
		const body = await this.#json(request, ["runId"]);
		if (body instanceof Response) return body;
		if (typeof body.runId !== "string" || body.runId.length === 0 || body.runId.length > 128)
			return this.#error();
		const runId = body.runId;
		return this.#hooks.runTestControlMutation(async () => {
			try {
				const sessionIds = await control.sessionIds(runId);
				await this.#hooks.quiesceTestSessions(control, runId);
				const result = await control.cleanup(runId);
				const retained = new Set(await control.sessionIds(runId));
				for (const sessionId of sessionIds)
					if (!retained.has(sessionId)) await this.#hooks.evictTestSession(sessionId);
				await this.#hooks.refreshInventoryAfterMutation();
				return Response.json(await this.#hooks.testControlStatus(control, runId, result));
			} catch {
				return this.#error(500);
			}
		});
	}
}

function accumulatedTestBlock(
	entryId: string,
	blockIndex: number,
	blockKind: "text" | "thinking" | "tool-input",
	content: string,
	at: string,
	options: { callId?: string; tool?: string } = {},
): AppserverEvent[] {
	const characters = [...content];
	const stride = 3;
	const events: AppserverEvent[] = [];
	for (let length = stride; length < characters.length; length += stride) {
		events.push({
			type: "assistant.block.update",
			entryId,
			blockIndex,
			blockKind,
			content: characters.slice(0, length).join(""),
			...options,
			at,
		});
	}
	events.push({ type: "assistant.block.update", entryId, blockIndex, blockKind, content, ...options, at });
	return events;
}

function orderedStreamTestEvents(at: string): AppserverEvent[] {
	const entryId = "assistant:test-ordered-turn";
	const primaryCallId = "test-write-primary";
	const coverageCallId = "test-write-coverage";
	return [
		{ type: "turn.start", at },
		...accumulatedTestBlock(
			entryId,
			0,
			"thinking",
			"I’ll preserve the provider’s block order, then stream both writes.",
			at,
		),
		...accumulatedTestBlock(entryId, 1, "text", "I’m updating the implementation first.", at),
		...accumulatedTestBlock(
			entryId,
			2,
			"tool-input",
			'{"path":"Sources/Streaming.swift","content":"struct StreamState {\\n    let isSmooth = true\\n}"}',
			at,
			{ callId: primaryCallId, tool: "write" },
		),
		{
			type: "tool.start",
			callId: primaryCallId,
			tool: "write",
			title: "Write implementation",
			args: { path: "Sources/Streaming.swift" },
			at,
		},
		...accumulatedTestBlock(
			entryId,
			3,
			"thinking",
			"The implementation is in place. I’ll add coverage without hiding the first tool.",
			at,
		),
		...accumulatedTestBlock(
			entryId,
			4,
			"tool-input",
			'{"path":"Tests/StreamingTests.swift","content":"func testOrderedStreaming() {\\n    XCTAssertTrue(true)\\n}"}',
			at,
			{ callId: coverageCallId, tool: "write" },
		),
		{
			type: "tool.start",
			callId: coverageCallId,
			tool: "write",
			title: "Write coverage",
			args: { path: "Tests/StreamingTests.swift" },
			at,
		},
		{ type: "tool.progress", callId: primaryCallId, note: "formatting implementation", at },
		{ type: "tool.progress", callId: coverageCallId, note: "running focused coverage", at },
		{ type: "tool.result", callId: primaryCallId, ok: true, result: { bytes: 48 }, at },
		{ type: "tool.result", callId: coverageCallId, ok: true, result: { tests: 1 }, at },
		{ type: "turn.end", at },
	];
}
