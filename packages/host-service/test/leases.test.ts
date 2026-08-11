import { describe, expect, test } from "bun:test";
import { LeaseRegistry } from "../src/leases.ts";

function registryAt(start = 1_000_000) {
	let now = start;
	return { registry: new LeaseRegistry(() => now), tick: (ms: number) => { now += ms; } };
}

describe("LeaseRegistry", () => {
	test("acquire grants one lease per session and kind", () => {
		const { registry } = registryAt();
		const first = registry.acquire("s1", "prompt", "conn-a", 30_000);
		expect(first.leaseId).toBeTruthy();
		expect(first.sessionId).toBe("s1");
		expect(first.kind).toBe("prompt");
		expect(first.ownerConnectionId).toBe("conn-a");
		expect(first.expiresAt).toBe(1_000_000 + 30_000);
		expect(() => registry.acquire("s1", "prompt", "conn-b", 30_000)).toThrow("lease held");
	});

	test("a different kind or session does not collide", () => {
		const { registry } = registryAt();
		registry.acquire("s1", "prompt", "conn-a");
		expect(() => registry.acquire("s1", "controller", "conn-a")).not.toThrow();
		expect(() => registry.acquire("s2", "prompt", "conn-a")).not.toThrow();
	});

	test("renew extends the holder and rejects other connections", () => {
		const { registry, tick } = registryAt();
		const lease = registry.acquire("s1", "prompt", "conn-a", 30_000);
		tick(10_000);
		const renewed = registry.renew(lease.leaseId, "conn-a", 30_000);
		expect(renewed.expiresAt).toBe(1_000_000 + 10_000 + 30_000);
		expect(() => registry.renew(lease.leaseId, "conn-b", 30_000)).toThrow("lease verify failed");
	});

	test("release frees the session for the next acquirer and is owner-scoped", () => {
		const { registry } = registryAt();
		const lease = registry.acquire("s1", "prompt", "conn-a");
		expect(() => registry.release(lease.leaseId, "conn-b")).toThrow("lease verify failed");
		registry.release(lease.leaseId, "conn-a");
		expect(() => registry.acquire("s1", "prompt", "conn-b")).not.toThrow();
	});

	test("expired leases are swept so the session can be re-acquired", () => {
		const { registry, tick } = registryAt();
		registry.acquire("s1", "prompt", "conn-a", 30_000);
		tick(31_000);
		expect(() => registry.acquire("s1", "prompt", "conn-b", 30_000)).not.toThrow();
	});

	test("releaseAllForConnection drops every lease the connection holds", () => {
		const { registry } = registryAt();
		registry.acquire("s1", "prompt", "conn-a");
		registry.acquire("s1", "controller", "conn-a");
		registry.acquire("s2", "prompt", "conn-b");
		registry.releaseAllForConnection("conn-a");
		expect(() => registry.acquire("s1", "prompt", "conn-b")).not.toThrow();
		expect(() => registry.acquire("s1", "controller", "conn-b")).not.toThrow();
		expect(() => registry.acquire("s2", "prompt", "conn-a")).toThrow("lease held");
	});

	test("verify reflects live ownership", () => {
		const { registry, tick } = registryAt();
		const lease = registry.acquire("s1", "prompt", "conn-a", 30_000);
		expect(registry.verify(lease.leaseId, "conn-a")).toBe(true);
		expect(registry.verify(lease.leaseId, "conn-b")).toBe(false);
		tick(31_000);
		expect(registry.verify(lease.leaseId, "conn-a")).toBe(false);
	});
});
