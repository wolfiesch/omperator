// The host command trace is diagnostic code that is meant to stay. Terminal
// commands cross a trust boundary, so this pins its privacy contract: the trace
// may carry the wire request id, the command name, a phase, and elapsed time,
// and nothing else. A comment alone would not stop a later change from logging
// a payload.
import { describe, expect, it } from "bun:test";

import { DesktopOperationDispatcher, formatHostTrace } from "../src/operations/dispatcher.ts";

const SECRETS = {
	sessionId: "sess-SUPERSECRET-9f1",
	cwd: "/Users/someone/private/client-work",
	shell: "/opt/custom/secret-shell",
	env: "AWS_SECRET_ACCESS_KEY=leakme",
};

function collectingDispatcher() {
	const lines: string[] = [];
	const authority = {
		// term.open resolves with a terminal id so the success path runs fully.
		termOpen: async () => ({ terminalId: "term-1" }),
	};
	const dispatcher = new DesktopOperationDispatcher(
		authority as never,
		undefined,
		undefined,
		line => lines.push(line),
	);
	return { dispatcher, lines };
}

describe("host command trace", () => {
	it("emits only request id, command, phase and elapsed", () => {
		const line = formatHostTrace("req-1", "term.open", "operation-ingress", 42);
		expect(line).toBe("[t4-host-trace] req=req-1 command=term.open phase=operation-ingress ms=42");
	});

	it("omits elapsed when it is not supplied", () => {
		expect(formatHostTrace("req-1", "term.open", "operation-ingress")).toBe(
			"[t4-host-trace] req=req-1 command=term.open phase=operation-ingress",
		);
	});

	it("never writes session, cwd, shell, env or args from a dispatched frame", async () => {
		const { dispatcher, lines } = collectingDispatcher();
		const frame = {
			v: 1,
			type: "command",
			requestId: "req-secretless",
			commandId: "cmd-1",
			hostId: "host-1",
			sessionId: SECRETS.sessionId,
			command: "term.open",
			args: { cwd: SECRETS.cwd, shell: SECRETS.shell, env: SECRETS.env, cols: 80, rows: 24 },
		};
		const context = {
			hostId: "host-1",
			sessionId: SECRETS.sessionId,
			deviceId: "device-1",
			connectionId: "conn-1",
			capabilities: new Set(["term.open"]),
			abortSignal: new AbortController().signal,
		};

		// The dispatch itself may reject on validation; the contract under test is
		// what the trace contains, not whether this stub frame is accepted.
		await dispatcher.dispatch(frame as never, context as never).catch(() => undefined);

		expect(lines.length).toBeGreaterThan(0);
		const joined = lines.join("\n");
		for (const secret of Object.values(SECRETS)) expect(joined).not.toContain(secret);
		// Guard the shapes too, so a future change cannot smuggle a payload blob.
		expect(joined).not.toContain("cols");
		expect(joined).not.toContain("{");
		for (const line of lines) {
			expect(line).toMatch(/^\[t4-host-trace] req=\S+ command=\S+ phase=\S+( ms=\d+)?$/);
		}
	});

	it("traces operation ingress before validation so a rejected operation is still visible", async () => {
		const { dispatcher, lines } = collectingDispatcher();
		const frame = {
			v: 1,
			type: "command",
			requestId: "req-rejected",
			commandId: "cmd-2",
			hostId: "host-1",
			command: "definitely.not.a.command",
			args: {},
		};
		const context = {
			hostId: "host-1",
			deviceId: "device-1",
			connectionId: "conn-1",
			capabilities: new Set<string>(),
			abortSignal: new AbortController().signal,
		};

		// This command does not exist, so dispatch MUST reject. Asserting that
		// keeps the test from silently passing if it ever starts succeeding.
		await expect(
			dispatcher.dispatch(frame as never, context as never),
		).rejects.toBeDefined();

		expect(lines.some(line => line.includes("phase=operation-ingress"))).toBe(true);
		// A rejected command must still settle, otherwise it is indistinguishable
		// from a hang.
		expect(lines.some(line => line.includes("phase=threw"))).toBe(true);
		// It never reached the authority.
		expect(lines.some(line => line.includes("phase=authority-invoke"))).toBe(false);
	});

	// `settings.read` results are decoded and require a revision; omitting it
	// makes dispatch throw, which would silently turn the success case below
	// into a failure case. Matches the fixture in operations.test.ts.
	const settingsAuthority = () =>
		({ settingsRead: async () => ({ revision: "revision-settings", settings: {} }) }) as never;

	const settingsFrame = (requestId: string, commandId: string) => ({
		v: 1,
		type: "command",
		requestId,
		commandId,
		hostId: "host-1",
		command: "settings.read",
		args: {},
	});

	const settingsContext = () => ({
		hostId: "host-1",
		deviceId: "device-1",
		connectionId: "conn-1",
		capabilities: new Set(["config.read"]),
		abortSignal: new AbortController().signal,
	});

	it("emits the full phase sequence when the authority answers", async () => {
		const lines: string[] = [];
		const dispatcher = new DesktopOperationDispatcher(
			settingsAuthority(),
			undefined,
			undefined,
			line => lines.push(line),
		);

		// Not caught: a rejection here must fail the test rather than be mistaken
		// for a traced success.
		const result = await dispatcher.dispatch(
			settingsFrame("req-ok", "cmd-3") as never,
			settingsContext() as never,
		);
		expect(result).toBeDefined();

		// The exact ordering IS the diagnostic. Reaching `authority-invoke` is
		// what separates a host-side stall from an authority-side one, and the
		// run must end in `returned`, never `threw`.
		const phases = lines.map(line => (line.match(/phase=(\S+)/) ?? [])[1]);
		expect(phases).toEqual(["operation-ingress", "authority-invoke", "authority-ok", "returned"]);
	});

	it("does not let a throwing sink break the command it observes", async () => {
		const dispatcher = new DesktopOperationDispatcher(
			settingsAuthority(),
			undefined,
			undefined,
			() => {
				throw new Error("sink exploded");
			},
		);

		// The sink throws on every phase. The dispatch must still RESOLVE, so an
		// unhandled rejection here fails the test outright.
		const result = await dispatcher.dispatch(
			settingsFrame("req-sink", "cmd-4") as never,
			settingsContext() as never,
		);
		expect(result).toBeDefined();
	});
});
