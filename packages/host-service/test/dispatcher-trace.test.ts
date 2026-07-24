// The host ingress trace is diagnostic code that is meant to stay. Terminal
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

describe("host ingress trace", () => {
	it("emits only request id, command, phase and elapsed", () => {
		const line = formatHostTrace("req-1", "term.open", "ingress", 42);
		expect(line).toBe("[t4-host-trace] req=req-1 command=term.open phase=ingress ms=42");
	});

	it("omits elapsed when it is not supplied", () => {
		expect(formatHostTrace("req-1", "term.open", "ingress")).toBe(
			"[t4-host-trace] req=req-1 command=term.open phase=ingress",
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

	it("traces ingress before validation so a rejected command is still visible", async () => {
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

		await dispatcher.dispatch(frame as never, context as never).catch(() => undefined);

		expect(lines.some(line => line.includes("phase=ingress"))).toBe(true);
		// A rejected command must still settle, otherwise it is indistinguishable
		// from a hang.
		expect(lines.some(line => line.includes("phase=threw"))).toBe(true);
		// It never reached the authority.
		expect(lines.some(line => line.includes("phase=authority-invoke"))).toBe(false);
	});
});
