import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionId, type SessionId } from "@t4-code/host-wire";
import { stableProjectId } from "../src/discovery.ts";
import { createAppserver } from "../src/server.ts";
import { RawUdsWebSocket } from "./raw-uds-client.ts";
import { host, record, FakeFactory } from "./appserver-fixtures.ts";

async function connectAppserver() {
	const root = await mkdtemp(join(tmpdir(), "t4-lease-flow-"));
	const socketPath = join(root, "run", "appserver.sock");
	const sid = sessionId("lease-flow-session");
	const sessionRecord = {
		...record(sid),
		path: join(root, `${sid}.jsonl`),
		cwd: root,
		projectId: stableProjectId(root),
	};
	const authority = {
		create: async () => sessionRecord,
		list: async () => [sessionRecord],
		archive: async () => {},
		restore: async () => {},
		delete: async () => {},
	};
	const appserver = createAppserver({
		hostId: host,
		epoch: "lease-flow-test",
		socketPath,
		discovery: authority,
		sessionAuthority: authority,
		childFactory: new FakeFactory(),
		lockStatus: () => "live",
	});
	await appserver.start();
	const client = await RawUdsWebSocket.connect(socketPath);
	const close = async () => {
		await client.close();
		await appserver.stop();
		await rm(root, { recursive: true, force: true });
	};
	return { appserver, client, close, sid, socketPath };
}

function hello(requestIdSuffix: string, features: string[] = ["resume", "prompt.lease", "controller.lease"]) {
	return {
		v: "omp-app/1",
		type: "hello",
		protocol: { min: "omp-app/1", max: "omp-app/1" },
		client: { name: `lease-${requestIdSuffix}`, version: "1", build: "test", platform: "linux" },
		requestedFeatures: features,
		capabilities: { client: ["sessions.read", "sessions.prompt", "sessions.control"] },
		savedCursors: [],
	};
}

async function responseFor(client: RawUdsWebSocket, requestId: string): Promise<Record<string, unknown>> {
	for (;;) {
		const frame = await client.nextServer();
		if (frame.type === "response" && frame.requestId === requestId) {
			return frame as unknown as Record<string, unknown>;
		}
	}
}

async function revisionFor(appserver: Awaited<ReturnType<typeof connectAppserver>>["appserver"], sid: SessionId): Promise<string> {
	const revision = appserver.snapshot(sid)?.revision;
	if (revision === undefined) throw new Error("missing session revision");
	return revision;
}

function leaseCommand(requestId: string, command: string, sid: string, args: Record<string, unknown>, revision: string) {
	return {
		v: "omp-app/1",
		type: "command",
		requestId,
		commandId: `${requestId}-command`,
		hostId: host,
		sessionId: sid,
		command,
		args,
		expectedRevision: revision,
	};
}

describe("composer leases over the local transport", () => {
	test("welcome grants the lease features and acquire/renew/release round-trip", async () => {
		const { appserver, client, close, sid } = await connectAppserver();
		try {
			client.sendJson(hello("flow"));
			expect(await client.nextServer()).toMatchObject({ type: "welcome" });
			expect((await client.nextServer()).type).toBe("sessions");
			const revision = await revisionFor(appserver, sid);
			client.sendJson(
				leaseCommand("lease-acquire", "prompt.lease.acquire", sid, { ownerId: "test-client" }, revision),
			);
			const acquired = await responseFor(client, "lease-acquire");
			expect(acquired.ok).toBe(true);
			const leaseId = (acquired.result as Record<string, unknown>).leaseId as string;
			expect(typeof leaseId).toBe("string");
			expect(leaseId.length).toBeGreaterThan(0);

			client.sendJson(
				leaseCommand("lease-renew", "prompt.lease.renew", sid, { leaseId }, revision),
			);
			const renewed = await responseFor(client, "lease-renew");
			expect(renewed.ok).toBe(true);
			expect((renewed.result as Record<string, unknown>).leaseId).toBe(leaseId);

			client.sendJson(
				leaseCommand("lease-release", "prompt.lease.release", sid, { leaseId }, revision),
			);
			const released = await responseFor(client, "lease-release");
			expect(released.ok).toBe(true);
			expect((released.result as Record<string, unknown>).released).toBe(true);
		} finally {
			await close();
		}
	});

	test("a second connection is refused while the lease is held and can acquire after release", async () => {
		const { appserver, client, close, sid, socketPath } = await connectAppserver();
		const second = await RawUdsWebSocket.connect(socketPath);
		try {
			client.sendJson(hello("one"));
			expect(await client.nextServer()).toMatchObject({ type: "welcome" });
			expect((await client.nextServer()).type).toBe("sessions");
			const revision = await revisionFor(appserver, sid);

			client.sendJson(
				leaseCommand("lease-acquire-one", "prompt.lease.acquire", sid, { ownerId: "one" }, revision),
			);
			const acquired = await responseFor(client, "lease-acquire-one");
			expect(acquired.ok).toBe(true);
			const leaseId = (acquired.result as Record<string, unknown>).leaseId as string;

			second.sendJson(hello("two"));
			expect(await second.nextServer()).toMatchObject({ type: "welcome" });
			expect((await second.nextServer()).type).toBe("sessions");
			second.sendJson(
				leaseCommand("lease-acquire-two", "prompt.lease.acquire", sid, { ownerId: "two" }, revision),
			);
			const busy = await responseFor(second, "lease-acquire-two");
			expect(busy.ok).toBe(false);
			expect((busy.error as Record<string, unknown>).code).toBe("lease_busy");

			second.sendJson(
				leaseCommand("lease-release-two", "prompt.lease.release", sid, { leaseId }, revision),
			);
			const foreign = await responseFor(second, "lease-release-two");
			expect(foreign.ok).toBe(false);
			expect((foreign.error as Record<string, unknown>).code).toBe("lease_verify_failed");

			client.sendJson(
				leaseCommand("lease-release-one", "prompt.lease.release", sid, { leaseId }, revision),
			);
			expect((await responseFor(client, "lease-release-one")).ok).toBe(true);

			second.sendJson(
				leaseCommand("lease-acquire-again", "prompt.lease.acquire", sid, { ownerId: "two" }, revision),
			);
			expect((await responseFor(second, "lease-acquire-again")).ok).toBe(true);
		} finally {
			await second.close();
			await close();
		}
	});

	test("controller and prompt leases are independent", async () => {
		const { appserver, client, close, sid } = await connectAppserver();
		try {
			client.sendJson(hello("kinds"));
			expect(await client.nextServer()).toMatchObject({ type: "welcome" });
			expect((await client.nextServer()).type).toBe("sessions");
			const revision = await revisionFor(appserver, sid);
			client.sendJson(
				leaseCommand("prompt-acquire", "prompt.lease.acquire", sid, { ownerId: "kinds" }, revision),
			);
			expect((await responseFor(client, "prompt-acquire")).ok).toBe(true);
			client.sendJson(
				leaseCommand("controller-acquire", "controller.lease.acquire", sid, { ownerId: "kinds" }, revision),
			);
			expect((await responseFor(client, "controller-acquire")).ok).toBe(true);
		} finally {
			await close();
		}
	});
});
