#!/usr/bin/env bun
import { appendFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const [kind, logPath, socketPath = "", exitDelay = "-1", exitCode = "0", stubborn = "false", identityMode = "valid", generation = "", generationAuthSha256 = ""] = process.argv.slice(2);
if (!kind || !logPath) process.exit(64);
const log = (event: string): void => appendFileSync(logPath, `${kind}:${event}:${process.pid}\n`);
if (kind === "identify") {
	const socketIndex = process.argv.indexOf("--socket");
	const selectedSocket = process.argv[socketIndex + 1];
	const mode = (() => { try { return readFileSync(`${selectedSocket}.identify-mode`, "utf8"); } catch { return "valid"; } })();
	writeFileSync(`${selectedSocket}.identify-started`, "1");
	if (mode === "hang") {
		setInterval(() => undefined, 1_000);
		await new Promise(() => undefined);
	}
	if (mode === "transient" || mode === "transient-empty") {
		const countPath = `${selectedSocket}.identify-count`;
		let count = 0;
		try { count = Number(readFileSync(countPath, "utf8")); } catch { /* first attempt */ }
		writeFileSync(countPath, String(count + 1));
		if (count === 0) {
			if (mode === "transient-empty") process.exit(0);
			process.exit(1);
		}
	}
	const pid = Number(readFileSync(`${selectedSocket}.pid`, "utf8"));
	process.stdout.write(`${JSON.stringify({ protocol: mode === "wrong-protocol" ? 9 : 10, pid: mode === "wrong-pid" ? pid + 1 : pid })}\n`);
	process.exit(0);
}
let server: { stop(closeActiveConnections?: boolean): void } | undefined;
if ((kind === "xvfb" || kind === "cmux") && socketPath) {
	server = Bun.listen({ unix: socketPath, socket: { data() {} } });
	writeFileSync(`${socketPath}.pid`, String(process.pid));
}
if (kind === "cmux") writeFileSync(`${socketPath}.identify-mode`, identityMode);
if (kind === "cmux") log(`cdp=${process.env.CMUX_MUX_CDP_URL ?? "absent"}`);
if (kind === "session-host" && socketPath) writeFileSync(socketPath, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, generation, generationAuthSha256 })}\n`);
log("started");
if (stubborn === "descendant") {
	spawn(process.execPath, [import.meta.path, `${kind}-descendant`, logPath, "", "-1", "0", "true"], {
		detached: false,
		stdio: "ignore",
	});
}
const stop = (): void => {
	log("term");
	if (stubborn === "true") return;
	server?.stop(true);
	if (kind === "session-host" && socketPath) {
		try { unlinkSync(socketPath); } catch { /* already absent */ }
	}
	process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
const delay = Number(exitDelay);
if (delay >= 0) setTimeout(() => process.exit(Number(exitCode)), delay);
setInterval(() => undefined, 1_000);
