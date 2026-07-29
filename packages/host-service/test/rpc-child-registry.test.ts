import { describe, expect, test } from "bun:test";
import { lstat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type RpcChildIdentity,
	RpcChildRegistry,
} from "../src/rpc-child-registry.ts";
import { BunRpcChildFactory } from "../src/rpc-child.ts";

function identity(pid: number, overrides: Partial<RpcChildIdentity> = {}): RpcChildIdentity {
	return {
		pid,
		pgid: pid,
		bootId: "boot-a",
		startedAt: "Sun Jul 26 16:45:00 2026",
		commandSha256: "a".repeat(64),
		...overrides,
	};
}

describe("durable RPC child process registry", () => {
	test("reaps only an unchanged dedicated child process group", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-rpc-registry-"));
		const path = join(root, "children.json");
		const current = new Map([
			[process.pid, identity(process.pid)],
			[1234, identity(1234)],
		]);
		const killed: number[] = [];
		const registry = new RpcChildRegistry(path, {
			inspect: pid => current.get(pid),
			killGroup: (pgid, signal) => {
				killed.push(pgid);
				if (signal === "SIGTERM") current.delete(pgid);
			},
		});
		registry.register(1234);
		expect((await lstat(path)).mode & 0o777).toBe(0o600);
		current.delete(process.pid);

		expect(await registry.reap()).toEqual({ killed: [1234], skipped: [] });
		expect(killed).toEqual([1234]);
		expect(await Bun.file(path).exists()).toBe(false);
	});

	test("fails closed when a PID was reused or its process identity changed", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-rpc-registry-reused-"));
		const path = join(root, "children.json");
		let current = identity(4321);
		let ownerAlive = true;
		const killed: number[] = [];
		const registry = new RpcChildRegistry(path, {
			inspect: pid => (pid === process.pid ? (ownerAlive ? identity(process.pid) : undefined) : current),
			killGroup: pgid => killed.push(pgid),
		});
		registry.register(4321);
		ownerAlive = false;
		current = identity(4321, { startedAt: "Sun Jul 26 16:46:00 2026" });

		expect(await registry.reap()).toEqual({ killed: [], skipped: [4321] });
		expect(killed).toEqual([]);
		expect(await Bun.file(path).exists()).toBe(true);
	});

	test("refuses to register a child that is not its process-group leader", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-rpc-registry-shared-"));
		let now = 0;
		const registry = new RpcChildRegistry(join(root, "children.json"), {
			inspect: pid =>
				pid === process.pid ? identity(process.pid) : identity(pid, { pgid: 99 }),
			now: () => now,
			waitSync: milliseconds => {
				now += milliseconds;
			},
		});
		expect(() => registry.register(5555)).toThrow("dedicated process group");
	});

	test("waits for a detached child to become its process-group leader", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-rpc-registry-transition-"));
		let inspections = 0;
		let now = 0;
		const registry = new RpcChildRegistry(join(root, "children.json"), {
			inspect: pid => {
				if (pid === process.pid) return identity(process.pid);
				inspections += 1;
				return identity(pid, { pgid: inspections === 1 ? 99 : pid });
			},
			now: () => now,
			waitSync: milliseconds => {
				now += milliseconds;
			},
		});

		expect(registry.register(5555)).toEqual(identity(5555));
		expect(inspections).toBe(2);
	});

	test("removes only the exact identity registered by this host", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-rpc-registry-remove-"));
		const path = join(root, "children.json");
		const original = identity(7777);
		const registry = new RpcChildRegistry(path, {
			inspect: pid => (pid === process.pid ? identity(process.pid) : original),
		});
		const registered = registry.register(7777);
		registry.unregister({ ...registered, commandSha256: "b".repeat(64) });
		expect(await Bun.file(path).exists()).toBe(true);
		registry.unregister(registered);
		expect(await Bun.file(path).exists()).toBe(false);
	});

	test("the production factory creates a dedicated group and a live owner prevents reaping", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-rpc-registry-real-"));
		const registry = new RpcChildRegistry(join(root, "children.json"));
		const factory = new BunRpcChildFactory("/bin/sleep", undefined, {}, registry);
		const child = factory.spawn({
			session: {} as never,
			argv: ["/bin/sleep", "30"],
			cwd: root,
		});
		const reaped = await registry.reap();
		expect(reaped.killed).toEqual([]);
		expect(reaped.skipped).toEqual([expect.any(Number)]);
		child.kill("SIGKILL");
		expect(await child.exited).not.toBe(0);
	});
});
