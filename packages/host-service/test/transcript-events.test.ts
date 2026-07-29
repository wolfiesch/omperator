import { describe, expect, test } from "bun:test";
import {
	AGENT_SESSION_EVENT_DISPOSITIONS,
	type AppserverEvent,
	RPC_INTERNAL_FRAME_DISPOSITIONS,
	RPC_OUT_OF_BAND_DISPOSITIONS,
	RPC_PROMPT_RESULT_DISPOSITIONS,
	TranscriptEventTranslator,
} from "../src/transcript-events.ts";

describe("appserver transcript event translator", () => {
	test("maps one assistant/tool turn into stable dot events", () => {
		const translator = new TranscriptEventTranslator(() => 99);
		const events = [
			...translator.translate({ type: "turn_start" }),
			...translator.translate({ type: "message_start", message: { role: "assistant", content: [] } }),
			...translator.translate({
				type: "message_update",
				message: {
					role: "assistant",
					timestamp: 10,
					content: [
						{ type: "thinking", thinking: "plan" },
						{ type: "text", text: "hello" },
					],
				},
			}),
			...translator.translate({
				type: "message_update",
				message: {
					role: "assistant",
					timestamp: 10,
					content: [
						{ type: "thinking", thinking: "plan" },
						{ type: "text", text: "hello" },
					],
				},
			}),
			...translator.translate({
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "read",
				args: { path: "x" },
			}),
			...translator.translate({ type: "tool_execution_update", toolCallId: "call-1", partialResult: "working" }),
			...translator.translate({
				type: "tool_execution_end",
				toolCallId: "call-1",
				isError: false,
				result: { content: [{ type: "text", text: "done" }] },
			}),
			...translator.translate({
				type: "tool_execution_end",
				toolCallId: "call-1",
				isError: false,
				result: { content: [{ type: "text", text: "duplicate" }] },
			}),
			...translator.translate({
				type: "message_end",
				message: {
					role: "assistant",
					timestamp: 10,
					content: [
						{ type: "thinking", thinking: "plan" },
						{ type: "text", text: "hello" },
					],
				},
			}),
			...translator.translate({ type: "turn_end" }),
		];

		expect(events.map(event => event.type)).toEqual([
			"turn.start",
			"message.update",
			"tool.start",
			"tool.progress",
			"tool.result",
			"turn.end",
		]);
		const message = events.find(event => event.type === "message.update");
		expect(message).toMatchObject({
			entryId: "assistant:1",
			role: "assistant",
			text: "hello",
			reasoning: "plan",
			at: "1970-01-01T00:00:00.010Z",
		});
		const toolStart = events.find(event => event.type === "tool.start");
		expect(toolStart).toMatchObject({
			callId: "call-1",
			tool: "read",
			title: "read",
			args: { path: "x" },
			at: "1970-01-01T00:00:00.099Z",
		});
		expect(events.filter(event => event.type === "tool.result")).toHaveLength(1);
	});

	test("projects v17 xdev execution frames as the semantic live tool", () => {
		const translator = new TranscriptEventTranslator(() => 99);
		const [start] = translator.translate({
			type: "tool_execution_start",
			toolCallId: "xdev-call",
			toolName: "write",
			args: {
				path: "xd://hub",
				content: JSON.stringify({ op: "send", to: "reviewer", message: "Please verify." }),
			},
		});
		const [end] = translator.translate({
			type: "tool_execution_end",
			toolCallId: "xdev-call",
			toolName: "write",
			result: {
				content: [{ type: "text", text: "delivered" }],
				details: {
					xdev: {
						tool: "hub",
						mode: "execute",
						args: { op: "send", to: "reviewer", message: "Please verify." },
						inner: {
							receipts: [{ to: "reviewer", outcome: "woken" }],
							logPath: "/home/tester/private/hub.log",
						},
					},
				},
			},
			isError: false,
		});

		expect(start).toEqual({
			type: "tool.start",
			callId: "xdev-call",
			tool: "hub",
			title: "hub",
			args: { op: "send", to: "reviewer", message: "Please verify." },
			at: "1970-01-01T00:00:00.099Z",
		});
		expect(end).toMatchObject({
			type: "tool.result",
			callId: "xdev-call",
			ok: true,
			result: {
				content: [{ type: "text", text: "delivered" }],
				details: {
					receipts: [{ to: "reviewer", outcome: "woken" }],
					logPath: "[path]",
				},
			},
		});
		expect(JSON.stringify(end)).not.toContain('"xdev"');
	});

	test("leaves non-executable and mismatched xdev live frames safely wrapped", () => {
		const translator = new TranscriptEventTranslator(() => 99);
		const [malformedStart] = translator.translate({
			type: "tool_execution_start",
			toolCallId: "malformed",
			toolName: "write",
			args: { path: "xd://hub", content: "not-json" },
		});
		const [semanticStart] = translator.translate({
			type: "tool_execution_start",
			toolCallId: "mismatch",
			toolName: "write",
			args: { path: "xd://hub", content: JSON.stringify({ op: "list" }) },
		});
		const [mismatchEnd] = translator.translate({
			type: "tool_execution_end",
			toolCallId: "mismatch",
			result: {
				content: [{ type: "text", text: "unexpected" }],
				details: {
					xdev: { tool: "generate_image", mode: "execute", args: { prompt: "spoof" }, inner: {} },
				},
			},
			isError: false,
		});
		translator.translate({
			type: "tool_execution_start",
			toolCallId: "same-tool-mismatch",
			toolName: "write",
			args: { path: "xd://resolve", content: "Apply A" },
		});
		const [sameToolMismatchEnd] = translator.translate({
			type: "tool_execution_end",
			toolCallId: "same-tool-mismatch",
			result: {
				content: [{ type: "text", text: "unexpected" }],
				details: {
					xdev: {
						tool: "resolve",
						mode: "execute",
						args: { reason: "Apply B" },
						inner: { action: "apply" },
					},
				},
			},
			isError: false,
		});
		translator.translate({
			type: "tool_execution_start",
			toolCallId: "json-argument-mismatch",
			toolName: "write",
			args: {
				path: "xd://hub",
				content: JSON.stringify({ op: "send", to: "reviewer" }),
			},
		});
		const [jsonArgumentMismatchEnd] = translator.translate({
			type: "tool_execution_end",
			toolCallId: "json-argument-mismatch",
			result: {
				content: [{ type: "text", text: "unexpected" }],
				details: {
					xdev: {
						tool: "hub",
						mode: "execute",
						args: { op: "delete", to: "victim" },
						inner: { action: "delete" },
					},
				},
			},
			isError: false,
		});

		expect(malformedStart).toMatchObject({ tool: "write", args: { path: "xd://hub", content: "not-json" } });
		expect(semanticStart).toMatchObject({ tool: "hub", args: { op: "list" } });
		expect(mismatchEnd).toMatchObject({
			result: { details: { xdev: { tool: "generate_image", mode: "execute" } } },
		});
		expect(sameToolMismatchEnd).toMatchObject({
			result: { details: { xdev: { tool: "resolve", args: { reason: "Apply B" } } } },
		});
		expect(jsonArgumentMismatchEnd).toMatchObject({
			result: { details: { xdev: { tool: "hub", args: { op: "delete", to: "victim" } } } },
		});
	});

	test("settles a correlated assistant stream onto the authoritative durable entry exactly once", () => {
		const translator = new TranscriptEventTranslator(() => 99);
		translator.translate({ type: "turn_start" });
		translator.translate({
			type: "message_start",
			streamId: "stream-1",
			message: { role: "assistant", content: [] },
		});
		translator.translate({
			type: "message_update",
			streamId: "stream-1",
			message: { role: "assistant", timestamp: 10, content: [{ type: "text", text: "done" }] },
		});
		translator.translate({
			type: "message_end",
			streamId: "stream-1",
			message: { role: "assistant", timestamp: 10, content: [{ type: "text", text: "done" }] },
		});
		expect(
			translator.translate({
				type: "message_update",
				streamId: "stream-1",
				message: { role: "assistant", timestamp: 10, content: [{ type: "text", text: "late partial" }] },
			}),
		).toEqual([]);
		expect(
			translator.observeSessionEntry(
				{
					type: "message",
					id: "raw-durable-1",
					message: { role: "assistant", timestamp: 10, content: [{ type: "text", text: "done" }] },
				},
				[
					{
						id: "durable-1" as never,
						parentId: null,
						hostId: "host" as never,
						sessionId: "session" as never,
						kind: "message",
						timestamp: "1970-01-01T00:00:00.010Z",
						data: { role: "assistant", text: "done" },
					},
				],
			),
		).toEqual([]);
		expect(
			translator.translate({
				type: "message_persisted",
				streamId: "stream-1",
				entryId: "raw-durable-1",
			}),
		).toEqual([
			{
				type: "message.settled",
				transientEntryId: "assistant:stream-1",
				entryId: "durable-1",
				at: "1970-01-01T00:00:00.010Z",
			},
		]);
		expect(
			translator.translate({
				type: "message_persisted",
				streamId: "stream-1",
				entryId: "raw-durable-1",
			}),
		).toEqual([]);
		expect(
			translator.translate({
				type: "message_update",
				streamId: "stream-1",
				message: { role: "assistant", timestamp: 10, content: [{ type: "text", text: "late partial" }] },
			}),
		).toEqual([]);
		expect(
			translator.observeSessionEntry(
				{
					type: "message",
					id: "raw-durable-1",
					message: { role: "assistant", timestamp: 10, content: [{ type: "text", text: "done" }] },
				},
				[],
			),
		).toEqual([]);
		expect(translator.translate({ type: "prompt_result", agentInvoked: true })).toEqual([]);
		expect(translator.translate({ type: "future_frame", payload: "ignored" })).toEqual([]);
	});

	test("keeps exact same-millisecond assistant streams correlated across turn-end interleaving", () => {
		const translator = new TranscriptEventTranslator(() => 99);
		const assistant = { role: "assistant", timestamp: 10, content: [{ type: "text", text: "identical" }] };
		const durable = (id: string) => ({
			id: id as never,
			parentId: null,
			hostId: "host" as never,
			sessionId: "session" as never,
			kind: "message" as const,
			timestamp: "1970-01-01T00:00:00.010Z",
			data: { role: "assistant", text: "identical" },
		});

		for (const streamId of ["stream-a", "stream-b"]) {
			translator.translate({ type: "turn_start" });
			translator.translate({ type: "message_start", streamId, message: { ...assistant, content: [] } });
			translator.translate({ type: "message_end", streamId, message: assistant });
			translator.translate({ type: "turn_end" });
		}

		expect(
			translator.observeSessionEntry(
				{ type: "message", id: "raw-a", message: { ...assistant, content: [{ type: "text", text: "redacted" }] } },
				[durable("durable-a")],
			),
		).toEqual([]);
		expect(
			translator.observeSessionEntry(
				{ type: "message", id: "raw-b", message: { ...assistant, content: [{ type: "text", text: "redacted" }] } },
				[durable("durable-b")],
			),
		).toEqual([]);

		expect(translator.translate({ type: "message_persisted", streamId: "stream-b", entryId: "raw-b" })).toEqual([
			{
				type: "message.settled",
				transientEntryId: "assistant:stream-b",
				entryId: "durable-b",
				at: "1970-01-01T00:00:00.010Z",
			},
		]);
		expect(translator.translate({ type: "message_persisted", streamId: "stream-a", entryId: "raw-a" })).toEqual([
			{
				type: "message.settled",
				transientEntryId: "assistant:stream-a",
				entryId: "durable-a",
				at: "1970-01-01T00:00:00.010Z",
			},
		]);
	});

	test("waits for the exact entry when persistence mapping arrives first and ignores skipped streams", () => {
		const translator = new TranscriptEventTranslator(() => 99);
		const message = { role: "assistant", timestamp: 10, content: [{ type: "text", text: "done" }] };
		translator.translate({ type: "message_start", streamId: "pending", message: { ...message, content: [] } });
		translator.translate({ type: "message_end", streamId: "pending", message });
		expect(translator.translate({ type: "message_persisted", streamId: "pending", entryId: "raw-pending" })).toEqual(
			[],
		);
		expect(
			translator.observeSessionEntry({ type: "message", id: "raw-other", message }, [
				{
					id: "durable-other" as never,
					parentId: null,
					hostId: "host" as never,
					sessionId: "session" as never,
					kind: "message",
					timestamp: "1970-01-01T00:00:00.010Z",
					data: { role: "assistant", text: "done" },
				},
			]),
		).toEqual([]);
		expect(
			translator.observeSessionEntry({ type: "message", id: "raw-pending", message }, [
				{
					id: "durable-pending" as never,
					parentId: null,
					hostId: "host" as never,
					sessionId: "session" as never,
					kind: "message",
					timestamp: "1970-01-01T00:00:00.010Z",
					data: { role: "assistant", text: "done" },
				},
			]),
		).toEqual([
			{
				type: "message.settled",
				transientEntryId: "assistant:pending",
				entryId: "durable-pending",
				at: "1970-01-01T00:00:00.010Z",
			},
		]);

		translator.translate({ type: "message_start", streamId: "skipped", message: { ...message, content: [] } });
		translator.translate({ type: "message_end", streamId: "skipped", message });
		expect(translator.translate({ type: "message_persisted", streamId: "skipped", entryId: null })).toEqual([]);
		expect(translator.translate({ type: "message_persisted", streamId: "skipped", entryId: "raw-other" })).toEqual(
			[],
		);
	});

	test("settles directly onto an already-projected persisted entry", () => {
		const translator = new TranscriptEventTranslator(() => 99);
		translator.observeKnownEntries([
			{
				id: "existing-entry" as never,
				parentId: null,
				hostId: "host" as never,
				sessionId: "session" as never,
				kind: "message",
				timestamp: "1970-01-01T00:00:00.010Z",
				data: { role: "assistant", text: "already there" },
			},
		]);
		const message = {
			role: "assistant",
			timestamp: 10,
			content: [{ type: "text", text: "already there" }],
		};
		translator.translate({ type: "message_start", streamId: "replayed", message: { ...message, content: [] } });
		translator.translate({ type: "message_end", streamId: "replayed", message });
		expect(
			translator.translate({ type: "message_persisted", streamId: "replayed", entryId: "existing-entry" }),
		).toEqual([
			{
				type: "message.settled",
				transientEntryId: "assistant:replayed",
				entryId: "existing-entry",
				at: "1970-01-01T00:00:00.010Z",
			},
		]);
	});
	test("maps RPC extension UI requests and resolves the matching pending kind", () => {
		const translator = new TranscriptEventTranslator(() => 99);
		const select = translator.translate({
			type: "extension_ui_request",
			id: "ask-1",
			method: "select",
			title: "Pick",
			options: ["one", "two"],
		});
		const input = translator.translate({ type: "extension_ui_request", id: "ask-2", method: "input", title: "Name" });
		const confirm = translator.translate({
			type: "extension_ui_request",
			id: "approval-1",
			method: "confirm",
			title: "Allow",
			message: "Run it?",
		});
		expect(select[0]).toMatchObject({
			type: "ask.request",
			askId: "ask-1",
			question: "Pick",
			options: [
				{ id: "one", label: "one" },
				{ id: "two", label: "two" },
			],
			allowText: false,
			responseKind: "value",
			source: "rpc-ui",
			at: "1970-01-01T00:00:00.099Z",
		});
		expect(input[0]).toMatchObject({
			type: "ask.request",
			askId: "ask-2",
			question: "Name",
			allowText: true,
			responseKind: "value",
			source: "rpc-ui",
			at: "1970-01-01T00:00:00.099Z",
		});
		expect(confirm[0]).toMatchObject({
			type: "approval.request",
			approvalId: "approval-1",
			title: "Allow",
			message: "Run it?",
			responseKind: "confirmed",
			source: "rpc-ui",
			at: "1970-01-01T00:00:00.099Z",
		});
		expect(translator.pendingUiRequests()).toEqual([
			{
				id: "ask-1",
				kind: "ask",
				attention: {
					kind: "question",
					id: "ask-1",
					question: "Pick",
					options: [
						{ id: "one", label: "one" },
						{ id: "two", label: "two" },
					],
					allowText: false,
					requestedAt: "1970-01-01T00:00:00.099Z",
				},
			},
			{ id: "ask-2", kind: "ask", attention: expect.objectContaining({ kind: "question", id: "ask-2" }) },
			{
				id: "approval-1",
				kind: "approval",
				attention: expect.objectContaining({ kind: "approval", id: "approval-1" }),
			},
		]);
		expect(translator.pendingUiRequest("ask-1")).toMatchObject({
			id: "ask-1",
			kind: "ask",
			attention: { kind: "question", question: "Pick" },
		});
		expect(translator.resolveUiRequest("ask-1")).toEqual({
			type: "ask.resolved",
			askId: "ask-1",
			at: "1970-01-01T00:00:00.099Z",
		});
		expect(translator.resolveUiRequest("ask-1")).toBeUndefined();
		expect(
			translator.translate({
				type: "extension_ui_request",
				id: "cancel-1",
				method: "cancel",
				targetId: "approval-1",
			}),
		).toMatchObject([{ type: "approval.resolved", approvalId: "approval-1", at: "1970-01-01T00:00:00.099Z" }]);
		expect(
			translator.translate({ type: "extension_ui_request", id: "notify-1", method: "notify", message: "ignored" }),
		).toEqual([]);
		const bounded = new TranscriptEventTranslator(() => 99);
		bounded.translate({
			type: "extension_ui_request",
			id: "bounded-ask",
			method: "select",
			title: "Use token=secret at https://example.test/private from /Users/name/project",
			options: Array.from({ length: 40 }, (_, index) => `option-${index}`),
		});
		const boundedAttention = bounded.pendingUiRequest("bounded-ask")?.attention;
		expect(boundedAttention).toMatchObject({
			question: "Use token=[redacted] at [url] from [path]",
		});
		expect(boundedAttention?.kind === "question" ? boundedAttention.options : []).toHaveLength(32);
		expect(
			bounded.translate({ type: "extension_ui_request", id: "x".repeat(257), method: "input", title: "ignored" }),
		).toEqual([]);
	});
	test("falls back instead of throwing for timestamps outside the Date range", () => {
		const translator = new TranscriptEventTranslator(() => 99);
		const events = translator.translate({
			type: "message_start",
			message: {
				role: "assistant",
				timestamp: Number.MAX_VALUE,
				content: [{ type: "text", text: "safe" }],
			},
		});
		expect(events[0]).toMatchObject({ type: "message.update", at: "1970-01-01T00:00:00.099Z" });
		const invalidClock = new TranscriptEventTranslator(() => Number.POSITIVE_INFINITY);
		expect(invalidClock.translate({ type: "turn_start" })).toEqual([
			{ type: "turn.start", at: "1970-01-01T00:00:00.000Z" },
		]);
	});
	test("dedupes timestamp-less repeated snapshots with stable active start time", () => {
		let now = 100;
		const translator = new TranscriptEventTranslator(() => now);
		translator.translate({ type: "message_start", message: { role: "assistant", content: [] } });
		const first = translator.translate({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "same" }] },
		});
		now = 200;
		const duplicate = translator.translate({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "same" }] },
		});
		expect(first[0]).toMatchObject({ at: "1970-01-01T00:00:00.100Z" });
		expect(duplicate).toEqual([]);
	});

	test("translates every authoritative AgentSessionEvent type through an exhaustive corpus", () => {
		interface CorpusCase {
			raw: Record<string, unknown>;
			expected: Array<AppserverEvent["type"]>;
			prepare?: (translator: TranscriptEventTranslator) => void;
		}
		const assistant = (text: string, stopReason = "stop") => ({
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason,
			timestamp: 10,
		});
		const cases: CorpusCase[] = [
			{ raw: { type: "agent_start" }, expected: ["agent.start"] },
			{ raw: { type: "agent_end", messages: [assistant("done")] }, expected: ["agent.end"] },
			{ raw: { type: "turn_start" }, expected: ["turn.start"] },
			{ raw: { type: "turn_end", message: assistant("done"), toolResults: [] }, expected: ["turn.end"] },
			{ raw: { type: "message_start", message: assistant("start") }, expected: ["message.update"] },
			{ raw: { type: "message_update", message: assistant("update") }, expected: ["message.update"] },
			{
				raw: { type: "message_end", message: assistant("end") },
				expected: ["message.update"],
				prepare: translator => {
					translator.translate({ type: "message_start", message: assistant("") });
				},
			},
			{
				raw: { type: "message_persisted", streamId: "contract-stream", entryId: "contract-raw" },
				expected: ["message.settled"],
				prepare: translator => {
					translator.translate({
						type: "message_start",
						streamId: "contract-stream",
						message: assistant(""),
					});
					translator.translate({
						type: "message_end",
						streamId: "contract-stream",
						message: assistant("done"),
					});
					translator.observeSessionEntry({ type: "message", id: "contract-raw", message: assistant("done") }, [
						{
							id: "contract-durable" as never,
							parentId: null,
							hostId: "host" as never,
							sessionId: "session" as never,
							kind: "message",
							timestamp: "1970-01-01T00:00:00.010Z",
							data: { role: "assistant", text: "done" },
						},
					]);
				},
			},
			{
				raw: { type: "tool_execution_start", toolCallId: "call-start", toolName: "read", args: {} },
				expected: ["tool.start"],
			},
			{
				raw: { type: "tool_execution_update", toolCallId: "call-update", toolName: "read", partialResult: "work" },
				expected: ["tool.progress"],
				prepare: translator => {
					translator.translate({
						type: "tool_execution_start",
						toolCallId: "call-update",
						toolName: "read",
						args: {},
					});
				},
			},
			{
				raw: { type: "tool_execution_end", toolCallId: "call-end", toolName: "read", result: {}, isError: false },
				expected: ["tool.result"],
				prepare: translator => {
					translator.translate({
						type: "tool_execution_start",
						toolCallId: "call-end",
						toolName: "read",
						args: {},
					});
				},
			},
			{
				raw: { type: "auto_compaction_start", reason: "threshold", action: "context-full" },
				expected: ["compaction.start"],
			},
			{
				raw: {
					type: "auto_compaction_end",
					action: "context-full",
					result: { summary: "folded", firstKeptEntryId: "entry-1", tokensBefore: 100 },
					aborted: false,
					willRetry: false,
				},
				expected: ["compaction.end"],
			},
			{
				raw: { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: "busy" },
				expected: ["turn.retry"],
			},
			{ raw: { type: "auto_retry_end", success: true, attempt: 1 }, expected: ["turn.retry.result"] },
			{
				raw: { type: "retry_fallback_applied", from: "model-a", to: "model-b", role: "default" },
				expected: ["model.fallback"],
			},
			{
				raw: { type: "retry_fallback_succeeded", model: "model-b", role: "default" },
				expected: ["model.fallback.result"],
			},
			{
				raw: { type: "ttsr_triggered", rules: [{ name: "scope", description: "Use it" }] },
				expected: ["ttsr.triggered"],
			},
			{
				raw: {
					type: "todo_reminder",
					todos: [{ content: "finish", status: "in_progress" }],
					attempt: 1,
					maxAttempts: 2,
				},
				expected: ["todo.reminder"],
			},
			{ raw: { type: "todo_auto_clear" }, expected: ["todo.cleared"] },
			{
				raw: {
					type: "irc_message",
					message: {
						role: "custom",
						customType: "irc:incoming",
						content: "hello",
						details: { from: "WorkerA" },
						timestamp: 10,
					},
				},
				expected: ["irc.message"],
			},
			{ raw: { type: "notice", level: "warning", message: "heads up" }, expected: ["notice"] },
			{
				raw: { type: "thinking_level_changed", thinkingLevel: "high", configured: "auto", resolved: "high" },
				expected: ["thinking.level.changed"],
			},
			{
				raw: {
					type: "goal_updated",
					goal: {
						id: "goal-1",
						objective: "ship",
						status: "active",
						tokensUsed: 10,
						timeUsedSeconds: 2,
						createdAt: 1,
						updatedAt: 2,
					},
				},
				expected: ["goal.updated"],
			},
		];

		expect(cases.map(item => String(item.raw.type)).sort()).toEqual(
			Object.keys(AGENT_SESSION_EVENT_DISPOSITIONS).sort(),
		);
		for (const item of cases) {
			const translator = new TranscriptEventTranslator(() => 99);
			item.prepare?.(translator);
			expect(translator.translate(item.raw).map(event => event.type)).toEqual(item.expected);
		}
	});

	test("projects a normal live sequence with lifecycle boundaries and an end-time timestamp", () => {
		let now = 1;
		const translator = new TranscriptEventTranslator(() => now++);
		const assistant = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			stopReason: "stop",
			timestamp: 10,
		};
		const events = [
			...translator.translate({ type: "agent_start" }),
			...translator.translate({ type: "turn_start" }),
			...translator.translate({ type: "message_start", message: { ...assistant, content: [] } }),
			...translator.translate({ type: "message_update", message: assistant }),
			...translator.translate({ type: "message_end", message: assistant }),
			...translator.translate({ type: "turn_end", message: assistant, toolResults: [] }),
			...translator.translate({ type: "agent_end", messages: [assistant] }),
		];
		expect(events.map(event => event.type)).toEqual([
			"agent.start",
			"turn.start",
			"message.update",
			"turn.end",
			"agent.end",
		]);
		const start = events.find(event => event.type === "turn.start");
		const end = events.find(event => event.type === "turn.end");
		expect(Date.parse(end?.at ?? "")).toBeGreaterThan(Date.parse(start?.at ?? ""));
	});

	test("prefers bounded agent-end metadata while retaining legacy message fallback", () => {
		const translator = new TranscriptEventTranslator(() => 99);
		const completed = {
			role: "assistant",
			content: [{ type: "text", text: "suffix" }],
			stopReason: "stop",
			timestamp: 10,
		};
		const explicit = translator.translate({
			type: "agent_end",
			messages: [completed],
			messageCount: 37,
			status: "cancelled",
		});
		expect(explicit).toMatchObject([{ type: "agent.end", messageCount: 37, status: "cancelled" }]);

		const legacy = translator.translate({
			type: "agent_end",
			messages: [{ ...completed, stopReason: "error" }],
		});
		expect(legacy).toMatchObject([{ type: "agent.end", messageCount: 1, status: "failed" }]);
	});

	test("derives turn.error only from an authoritative assistant error and redacts diagnostic text", () => {
		const translator = new TranscriptEventTranslator(() => 99);
		const error = translator.translate({
			type: "turn_end",
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage:
					"Bearer abcdefghijklmnop failed at /home/tester/private token=plaintext https://signed.example/download?signature=url-secret",
				errorStatus: 503,
				errorId: 12,
			},
			toolResults: [],
		});
		expect(error).toMatchObject([{ type: "turn.error", errorStatus: 503, errorId: 12 }, { type: "turn.end" }]);
		expect(JSON.stringify(error)).not.toContain("abcdefghijklmnop");
		expect(JSON.stringify(error)).not.toContain("/home/tester");
		expect(JSON.stringify(error)).not.toContain("plaintext");
		expect(JSON.stringify(error)).not.toContain("signed.example");
		expect(JSON.stringify(error)).not.toContain("url-secret");

		const nonAuthoritative = translator.translate({
			type: "turn_end",
			message: { role: "assistant", stopReason: "stop", errorMessage: "not an error outcome" },
			toolResults: [],
		});
		expect(nonAuthoritative.map(event => event.type)).toEqual(["turn.end"]);
	});

	test("bounds new event payloads to safe summaries instead of forwarding raw objects", () => {
		const translator = new TranscriptEventTranslator(() => 99);
		const compaction = translator.translate({
			type: "auto_compaction_end",
			action: "context-full",
			result: {
				summary: "Kept /home/tester/private token=plaintext",
				firstKeptEntryId: "entry-1",
				tokensBefore: 10,
				details: { authorization: "Bearer abcdefghijklmnop" },
				preserveData: { secret: "plaintext" },
			},
			aborted: false,
			willRetry: false,
		});
		expect(compaction[0]).toMatchObject({
			type: "compaction.end",
			status: "completed",
			summary: "Kept [path] token=[redacted]",
			tokensBefore: 10,
			firstKeptEntryId: "entry-1",
		});
		const serialized = JSON.stringify(compaction);
		expect(serialized).not.toContain("details");
		expect(serialized).not.toContain("preserveData");
		expect(serialized).not.toContain("abcdefghijklmnop");
		expect(serialized).not.toContain("plaintext");
	});

	test("keeps local prompt results internal and closes only a real open turn on late failure", () => {
		const translator = new TranscriptEventTranslator(() => 99);
		expect(RPC_PROMPT_RESULT_DISPOSITIONS).toEqual({
			agentInvoked: "intentionally-internal",
			error: "translated",
		});
		expect(translator.translate({ type: "prompt_result", id: "local", agentInvoked: false })).toEqual([]);

		const earlyFailure = translator.translate({
			type: "prompt_result",
			id: "early",
			error: "Bearer abcdefghijklmnop failed at /home/tester/private token=plaintext https://signed.example/download?signature=url-secret",
		});
		expect(earlyFailure).toEqual([
			{
				type: "turn.error",
				message: "Bearer [redacted] failed at [path] token=[redacted] [url]",
				at: new Date(99).toISOString(),
			},
		]);

		expect(translator.translate({ type: "turn_start" }).map(event => event.type)).toEqual(["turn.start"]);
		const staleFailure = translator.translate(
			{ type: "prompt_result", id: "stale", error: "stale provider rejection" },
			{ currentPromptResult: false },
		);
		expect(staleFailure).toEqual([]);
		const inTurnFailure = translator.translate(
			{ type: "prompt_result", id: "open", error: "provider rejected" },
			{ currentPromptResult: true },
		);
		expect(inTurnFailure.map(event => event.type)).toEqual(["turn.error", "turn.end"]);
	});

	test("surfaces subagent event summaries while adjacent frames remain separately projected", () => {
		const translator = new TranscriptEventTranslator(() => 99);
		expect(RPC_OUT_OF_BAND_DISPOSITIONS).toEqual({
			session_entry: "separately-projected",
			subagent_lifecycle: "separately-projected",
			subagent_progress: "separately-projected",
			subagent_event: "translated",
		});
		expect(RPC_INTERNAL_FRAME_DISPOSITIONS).toEqual({
			available_commands_update: "intentionally-internal",
		});
		expect(translator.translate({ type: "subagent_lifecycle", payload: {} })).toEqual([]);
		expect(translator.translate({ type: "subagent_progress", payload: {} })).toEqual([]);

		const known = translator.translate({
			type: "subagent_event",
			payload: {
				id: "WorkerA",
				event: {
					type: "notice",
					level: "error",
					message: "Bearer abcdefghijklmnop failed at /home/tester/private",
				},
			},
		});
		expect(known).toMatchObject([
			{
				type: "agent.event",
				agentId: "WorkerA",
				event: "notice",
				detail: { level: "error", message: "Bearer [redacted] failed at [path]" },
			},
		]);
		expect(JSON.stringify(known)).not.toContain("abcdefghijklmnop");

		expect(
			translator.translate({
				type: "subagent_event",
				payload: { id: "WorkerA", event: { type: "future_subagent_event", secret: "do-not-forward" } },
			}),
		).toMatchObject([
			{ type: "agent.event", agentId: "WorkerA", event: "unknown", detail: { rawType: "future_subagent_event" } },
		]);
	});
});
