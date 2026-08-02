import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { Writable } from "node:stream";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionCredentialClient } from "../src/session-credential-client.ts";
import { credentialBrokerRegistrationIsFresh, decodeSessionCredentialBrokerRequest, forwardCmuxClientFrame, releaseSessionWriterAuthority, runSessionCredentialBroker } from "../src/session-credential-broker.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("session credential broker boundary", () => {
	it("accepts only its exact narrow command schemas", () => {
		expect(decodeSessionCredentialBrokerRequest({ id: 1, command: "state" })).toEqual({ id: 1, command: "state" });
		expect(decodeSessionCredentialBrokerRequest({ id: 2, command: "review", token: "x".repeat(32) })).toMatchObject({ command: "review" });
		for (const hostile of [
			{ id: 1, command: "exec", argv: ["cat", "/var/run/secrets/kubernetes.io/serviceaccount/token"] },
			{ id: 1, command: "state", extra: true },
			{ id: 1, command: "review", token: "x".repeat(16_385) },
			{ id: 1, command: "heartbeat", generation: 1 },
		]) expect(() => decodeSessionCredentialBrokerRequest(hostile)).toThrow("not allowed");
	});

	it("expires stale and future host heartbeats", () => {
		expect(credentialBrokerRegistrationIsFresh(10_000, 24_999)).toBe(true);
		expect(credentialBrokerRegistrationIsFresh(10_000, 25_001)).toBe(false);
		expect(credentialBrokerRegistrationIsFresh(25_001, 25_000)).toBe(false);
		expect(credentialBrokerRegistrationIsFresh(undefined, 25_000)).toBe(false);
	});

	it("pauses raw cmux clients until the upstream socket drains", () => {
		const events: string[] = [];
		const client = { readyState: 1, pause: () => events.push("pause"), resume: () => events.push("resume") };
		const upstream = new Writable({ highWaterMark: 1, write: () => undefined });
		forwardCmuxClientFrame(client, upstream, Buffer.from("frame"), () => events.push("close"));
		expect(events).toEqual(["pause"]);
		upstream.emit("drain");
		expect(events).toEqual(["pause", "resume"]);
	});

	it("closes raw cmux clients and upstreams before releasing writer authority", async () => {
		const order: string[] = [];
		let accepting = true;
		const clients = new Set([{ terminate: () => order.push("client-terminated") }]);
		const upstreams = new Set([{ destroy: () => order.push("upstream-destroyed") }]);
		const fence = (): void => {
			accepting = false;
			for (const upstream of upstreams) upstream.destroy();
			for (const client of clients) client.terminate();
			upstreams.clear();
			clients.clear();
		};
		await releaseSessionWriterAuthority(fence, { release: async () => {
			expect(accepting).toBeFalsy();
			expect(clients.size).toBe(0);
			expect(upstreams.size).toBe(0);
			order.push("lease-released");
		} });
		expect(order).toEqual(["upstream-destroyed", "client-terminated", "lease-released"]);
	});

	it("allows one private authority peer and removes the rendezvous socket", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-credential-broker-")); roots.push(root);
		const tokenPath = join(root, "token"); const caPath = join(root, "ca.crt"); const namespacePath = join(root, "namespace"); const authPath = join(root, "generation.key"); const socketPath = join(root, "broker.sock");
		await Promise.all([writeFile(tokenPath, "projected-token"), writeFile(caPath, "fixture-ca"), writeFile(namespacePath, "team"), writeFile(authPath, Buffer.alloc(32, 0x54))]);
		const running = runSessionCredentialBroker({ socketPath, kubernetesBaseUrl: "https://127.0.0.1:1", kubernetesTokenPath: tokenPath, kubernetesCaPath: caPath, kubernetesNamespacePath: namespacePath, serverServiceAccountName: "cluster-server", writerLeaseName: "writer-session", podUid: "pod-12345678", runtimeUid: "runtime-uid", generation: "gen_123456789012345678901234", generationAuthPath: authPath, activitySocketPath: join(root, "activity.sock"), cmuxSocketPath: join(root, "cmux.sock"), activityPort: 0 });
		const authority = await SessionCredentialClient.connect(socketPath);
		await expect(authority.register("gen_123456789012345678901234", "pod:session", "session-id")).resolves.toMatchObject({ generationAuthSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
		await expect(authority.state()).resolves.toMatchObject({ registered: true, fresh: true, leaseHeld: false });
		await expect(new Promise<void>((resolve, reject) => { const peer = createConnection(socketPath); peer.once("connect", () => { peer.destroy(); resolve(); }); peer.once("error", reject); })).rejects.toBeDefined();
		authority.close();
		await running;
	});
});
