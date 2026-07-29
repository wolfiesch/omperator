import { describe, expect, spyOn, test } from "bun:test";
import {
	COMMAND_DESCRIPTORS,
	commandId,
	DEVICE_CAPABILITIES,
	decodeCommand,
	hostId,
	requestId,
	revision,
	sessionId,
	terminalId,
} from "@t4-code/host-wire";
import {
	DesktopOperationDispatcher,
	type DesktopOperationsAuthority,
	type OperationContext,
	operationCapabilities,
	operationFeatures,
	TerminalOwnerRegistry,
} from "../src/operations/dispatcher.ts";

const previewSnapshot = {
	previewId: "preview-1",
	state: "ready",
	url: "http://localhost",
	revision: "preview-revision",
	cursor: { epoch: "preview-epoch", seq: 1 },
};

const PREVIEW_METHOD_BY_COMMAND = {
	"preview.launch": "previewLaunch",
	"preview.state": "previewState",
	"preview.activate": "previewActivate",
	"preview.navigate": "previewNavigate",
	"preview.back": "previewBack",
	"preview.forward": "previewForward",
	"preview.reload": "previewReload",
	"preview.close": "previewClose",
	"preview.capture": "previewCapture",
	"preview.capture.read": "previewCaptureRead",
	"preview.click": "previewClick",
	"preview.fill": "previewFill",
	"preview.scroll": "previewScroll",
	"preview.type": "previewType",
	"preview.select": "previewSelect",
	"preview.press": "previewPress",
	"preview.upload": "previewUpload",
	"preview.policy.check": "previewPolicyCheck",
	"preview.lease.acquire": "previewLeaseAcquire",
	"preview.lease.renew": "previewLeaseRenew",
	"preview.lease.release": "previewLeaseRelease",
	"preview.handoff": "previewHandoff",
} as const satisfies Readonly<Record<string, keyof DesktopOperationsAuthority>>;

function previewArgs(name: string): Record<string, unknown> {
	if (name === "preview.launch") return { url: "http://localhost" };
	if (name === "preview.state") return {};
	if (name === "preview.navigate") return { previewId: "preview-1", url: "http://localhost/next" };
	if (name === "preview.capture.read") return { previewId: "preview-1", captureId: "capture-1", offset: 0 };
	if (name === "preview.click") return { previewId: "preview-1", selector: "button" };
	if (name === "preview.fill" || name === "preview.type") return { previewId: "preview-1", text: "hello" };
	if (name === "preview.scroll") return { previewId: "preview-1", deltaX: 0, deltaY: 10 };
	if (name === "preview.select") return { previewId: "preview-1", selector: "select", value: "one" };
	if (name === "preview.press") return { previewId: "preview-1", key: "Enter" };
	if (name === "preview.upload") return { previewId: "preview-1", selector: "input", path: "upload.txt" };
	if (name === "preview.policy.check") return { action: "navigate", url: "http://localhost" };
	if (name === "preview.lease.acquire") return { previewId: "preview-1" };
	if (name === "preview.lease.renew" || name === "preview.lease.release")
		return { previewId: "preview-1", leaseId: "preview-lease-1" };
	if (name === "preview.handoff") return { previewId: "preview-1", message: "Continue manually" };
	return { previewId: "preview-1" };
}

function previewResult(name: string): Record<string, unknown> {
	if (name === "preview.state") return { previews: [previewSnapshot] };
	if (name === "preview.capture.read")
		return {
			previewId: "preview-1",
			captureId: "capture-1",
			size: 1,
			offset: 0,
			nextOffset: 1,
			complete: true,
			content: "eA==",
		};
	if (name === "preview.policy.check") return { allowed: true, confirmationRequired: false };
	if (name === "preview.lease.acquire" || name === "preview.lease.renew")
		return { previewId: "preview-1", leaseId: "preview-lease-1", expiresAt: 1_000 };
	if (name === "preview.lease.release") return { previewId: "preview-1", released: true };
	return { preview: previewSnapshot };
}

const context: OperationContext = {
	hostId: hostId("host-1"),
	sessionId: sessionId("session-1"),
	deviceId: "device-1",
	connectionId: "connection-1",
	capabilities: new Set(DEVICE_CAPABILITIES),
	currentRevision: revision("r-1"),
	abortSignal: new AbortController().signal,
};
function command(name: string, args: Record<string, unknown> = {}, session = true, expectedRevision?: string) {
	const requiredRevision = ["files.write", "files.patch", "review.apply", "settings.write", "config.write"].includes(
		name,
	);
	return decodeCommand({
		v: "omp-app/1",
		type: "command",
		requestId: requestId(`request-${name}`),
		commandId: commandId(`command-${name}`),
		hostId: context.hostId,
		...(session ? { sessionId: context.sessionId } : {}),
		command: name,
		...(expectedRevision || requiredRevision ? { expectedRevision: expectedRevision ?? "r-1" } : {}),
		args,
	});
}
function authority(overrides: Partial<DesktopOperationsAuthority> = {}): DesktopOperationsAuthority {
	return {
		filesRead: async () => ({ content: "hello" }),
		filesList: async () => ({ entries: [] }),
		filesSearch: async () => ({ matches: [], truncated: false }),
		filesDiff: async () => ({ diff: "" }),
		filesWrite: async () => ({}),
		filesPatch: async () => ({}),
		reviewRead: async () => ({}),
		reviewApply: async () => ({}),
		bashRun: async () => ({}),
		termOpen: async () => ({ terminalId: "term-1" }),
		catalogGet: async () => ({ revision: "revision-catalog", items: [] }),
		settingsRead: async () => ({ revision: "revision-settings", settings: {} }),
		brokerStatus: async () => ({ state: "local", generation: 1 }),
		settingsWrite: async () => ({}),
		configWrite: async () => ({}),
		previewLaunch: async () => ({ preview: previewSnapshot }),
		previewState: async () => ({ previews: [previewSnapshot] }),
		previewNavigate: async () => ({ preview: previewSnapshot }),
		previewCapture: async () => ({ preview: previewSnapshot }),
		terminalInput: async () => {},
		terminalResize: async () => {},
		terminalClose: async () => {},
		...overrides,
	};
}

describe("desktop operation dispatcher", () => {
	test("routes operation families through typed authority", async () => {
		const dispatcher = new DesktopOperationDispatcher(authority());
		for (const name of [
			"files.read",
			"files.list",
			"files.search",
			"files.diff",
			"files.write",
			"files.patch",
			"review.read",
			"review.apply",
			"bash.run",
			"catalog.get",
			"settings.read",
			"broker.status",
			"settings.write",
			"config.write",
			"preview.launch",
			"preview.state",
			"preview.navigate",
			"preview.capture",
		]) {
			const args = name.startsWith("preview.")
				? previewArgs(name)
				: name === "files.search"
					? { query: "app" }
					: name.startsWith("files.")
					? {
							path: "src/a.txt",
							...(name === "files.write" ? { content: "x" } : {}),
							...(name === "files.patch" ? { patch: "x" } : {}),
						}
					: name.startsWith("review.")
						? { reviewId: "review-1" }
						: name === "bash.run"
							? { command: "structured" }
							: {};
			const hostCommand = [
				"catalog.get",
				"settings.read",
				"broker.status",
				"settings.write",
				"config.write",
			].includes(name);
			await expect(
				dispatcher.dispatch(command(name, args, !hostCommand), {
					...context,
					...(hostCommand ? { sessionId: undefined } : {}),
				}),
			).resolves.toBeObject();
		}
	});
	test("routes every declared preview command only to its matching optional authority method", async () => {
		const declared = Object.keys(COMMAND_DESCRIPTORS)
			.filter(name => name.startsWith("preview."))
			.sort();
		expect(Object.keys(PREVIEW_METHOD_BY_COMMAND).sort()).toEqual(declared);
		for (const [name, method] of Object.entries(PREVIEW_METHOD_BY_COMMAND)) {
			const calls: string[] = [];
			const previewAuthority = {
				[method]: async () => {
					calls.push(method);
					return previewResult(name);
				},
			} as DesktopOperationsAuthority;
			const dispatcher = new DesktopOperationDispatcher(previewAuthority);
			await expect(dispatcher.dispatch(command(name, previewArgs(name)), context)).resolves.toBeObject();
			expect(calls).toEqual([method]);
		}
	});
	test("advertises only the preview capability and feature backed by an optional method", () => {
		const stateOnly: DesktopOperationsAuthority = { previewState: async () => ({ previews: [] }) };
		expect(operationCapabilities(stateOnly)).toEqual(new Set(["preview.read"]));
		expect(operationFeatures(stateOnly)).toEqual(new Set(["preview.control"]));
		expect(operationFeatures(undefined)).toEqual(new Set());
	});
	test("rejects wrong host/scope, stale revision, abort, missing capability, and redacts authority errors", async () => {
		const dispatcher = new DesktopOperationDispatcher(
			authority({
				filesRead: async () => {
					throw { code: "secret-provider", message: "token=bad" };
				},
			}),
		);
		await expect(
			dispatcher.dispatch(command("files.read", { path: "a" }), { ...context, sessionId: sessionId("other") }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(dispatcher.dispatch(command("term.open", {}, true, "r-2"), context)).rejects.toMatchObject({
			code: "STALE_REVISION",
		});
		await expect(
			dispatcher.dispatch(command("files.read", { path: "a" }), { ...context, abortSignal: AbortSignal.abort() }),
		).rejects.toMatchObject({ code: "ABORTED" });
		await expect(
			dispatcher.dispatch(command("files.read", { path: "a" }), { ...context, capabilities: new Set() }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(dispatcher.dispatch(command("files.read", { path: "a" }), context)).rejects.toMatchObject({
			code: "OPERATION_FAILED",
		});
	});
	test("terminal lifecycle is all-or-nothing and late output is harmless", async () => {
		let closes = 0;
		let outputs = 0;
		const dispatcher = new DesktopOperationDispatcher(
			authority({
				termOpen: async () => ({ terminalId: "term-1" }),
				terminalClose: async () => {
					closes++;
					if (closes === 1) throw new Error("close failed");
				},
				terminalOutput: () => {
					outputs++;
				},
			}),
		);
		expect(operationCapabilities({ termOpen: async () => ({ terminalId: "partial" }) })).not.toContain("term.open");
		const first = await dispatcher.dispatch(command("term.open"), context);
		const owner = {
			connectionId: context.connectionId,
			deviceId: context.deviceId,
			hostId: context.hostId,
			sessionId: context.sessionId!,
			terminalId: terminalId(String(first.terminalId)),
		};
		dispatcher.publishTerminalOutput(
			{
				v: "omp-app/1",
				type: "terminal.output",
				hostId: context.hostId,
				sessionId: context.sessionId,
				terminalId: owner.terminalId,
				cursor: { epoch: "e", seq: 1 },
				stream: "stdout",
				data: "x",
			},
			owner,
		);
		expect(outputs).toBe(1);
		await expect(
			dispatcher.disconnect(context.connectionId, { ...context, sessionId: context.sessionId! }),
		).rejects.toMatchObject({ code: "OPERATION_FAILED" });
		expect(closes).toBe(1);
		expect(() =>
			dispatcher.publishTerminalOutput(
				{
					v: "omp-app/1",
					type: "terminal.output",
					hostId: context.hostId,
					sessionId: context.sessionId,
					terminalId: owner.terminalId,
					cursor: { epoch: "e", seq: 2 },
					stream: "stdout",
					data: "late",
				},
				owner,
			),
		).not.toThrow();
	});

	test("flushes synchronous terminal output exactly once after claiming its owner", async () => {
		let authorityOutputs = 0;
		let forwardedOutputs = 0;
		const dispatcher = new DesktopOperationDispatcher(
			authority({
				termOpen: async (_args, operationContext) => {
					operationContext.emitTerminalOutput?.({
						v: "omp-app/1",
						type: "terminal.output",
						hostId: context.hostId,
						sessionId: context.sessionId,
						terminalId: terminalId("term-1"),
						cursor: { epoch: "e", seq: 1 },
						stream: "stdout",
						data: "synchronous",
					});
					return { terminalId: "term-1" };
				},
				terminalOutput: () => {
					authorityOutputs++;
				},
			}),
			undefined,
			() => {
				forwardedOutputs++;
			},
		);
		await dispatcher.dispatch(command("term.open"), context);
		expect(authorityOutputs).toBe(1);
		expect(forwardedOutputs).toBe(1);
	});

	test("discards synchronous output when a terminal owner claim conflicts", async () => {
		const owners = new TerminalOwnerRegistry();
		owners.claim({
			connectionId: "other-connection",
			deviceId: "other-device",
			hostId: context.hostId,
			sessionId: context.sessionId!,
			terminalId: terminalId("term-1"),
		});
		let closes = 0;
		const dispatcher = new DesktopOperationDispatcher(
			authority({
				termOpen: async (_args, operationContext) => {
					operationContext.emitTerminalOutput?.({
						v: "omp-app/1",
						type: "terminal.output",
						hostId: context.hostId,
						sessionId: context.sessionId,
						terminalId: terminalId("term-1"),
						cursor: { epoch: "e", seq: 1 },
						stream: "stdout",
						data: "discard",
					});
					return { terminalId: "term-1" };
				},
				terminalClose: async () => {
					closes++;
				},
			}),
			owners,
		);
		const publish = spyOn(dispatcher, "publishTerminalOutput");
		await expect(dispatcher.dispatch(command("term.open"), context)).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(publish).not.toHaveBeenCalled();
		expect(closes).toBe(1);
	});

	test("releases a claimed terminal owner when buffered output is invalid", async () => {
		let closes = 0;
		const dispatcher = new DesktopOperationDispatcher(
			authority({
				termOpen: async (_args, operationContext) => {
					operationContext.emitTerminalOutput?.({ type: "invalid-terminal-frame" });
					return { terminalId: "term-1" };
				},
				terminalClose: async () => {
					closes++;
				},
			}),
		);
		await expect(dispatcher.dispatch(command("term.open"), context)).rejects.toBeDefined();
		expect(dispatcher.hasOpenTerminals(context.sessionId!)).toBe(false);
		expect(closes).toBe(1);
	});

	test("authority receives unchanged revision and abort signal", async () => {
		let seen: OperationContext | undefined;
		const dispatcher = new DesktopOperationDispatcher(
			authority({
				filesWrite: async (_args, operationContext) => {
					seen = operationContext;
					return {};
				},
			}),
		);
		await dispatcher.dispatch(command("files.write", { path: "a", content: "x" }, true, "file-hash"), context);
		expect(String(seen?.expectedRevision)).toBe("file-hash");
		expect(seen && Object.isFrozen(seen.capabilities)).toBe(false);
	});
	test("terminal owner registry rejects wrong connection and releases on disconnect", () => {
		const registry = new TerminalOwnerRegistry();
		const owner = {
			connectionId: context.connectionId,
			deviceId: context.deviceId,
			hostId: context.hostId,
			sessionId: context.sessionId!,
			terminalId: terminalId("term-1"),
		};
		registry.claim(owner);
		expect(() => registry.assert({ ...owner, connectionId: "other" })).toThrow();
		registry.releaseConnection(context.connectionId);
		expect(() => registry.assert(owner)).toThrow();
	});
	test("disconnect closes every owned terminal and late callbacks remain harmless", async () => {
		let next = 0;
		let closes = 0;
		const dispatcher = new DesktopOperationDispatcher(
			authority({
				termOpen: async () => ({ terminalId: `term-${++next}` }),
				terminalClose: async () => {
					closes++;
					if (closes === 1) throw new Error("close failed");
				},
			}),
		);
		await dispatcher.dispatch(command("term.open"), context);
		await dispatcher.dispatch(
			{
				...command("term.open"),
				commandId: commandId("command-term-open-2"),
				requestId: requestId("request-term-open-2"),
			},
			context,
		);
		await expect(
			dispatcher.disconnect(context.connectionId, { ...context, sessionId: context.sessionId! }),
		).rejects.toMatchObject({ code: "OPERATION_FAILED" });
		expect(closes).toBe(2);
	});
	test("abortSignal identity is passed unchanged to authority", async () => {
		let seen: AbortSignal | undefined;
		const signal = new AbortController().signal;
		const dispatcher = new DesktopOperationDispatcher(
			authority({
				filesRead: async (_args, operationContext) => {
					seen = operationContext.abortSignal;
					return { content: "ok" };
				},
			}),
		);
		await dispatcher.dispatch(command("files.read", { path: "a" }), { ...context, abortSignal: signal });
		expect(seen).toBe(signal);
	});
});
