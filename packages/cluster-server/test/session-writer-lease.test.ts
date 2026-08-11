import { describe, expect, test } from "vite-plus/test";
import { KubernetesApiError } from "../src/kubernetes-client.ts";
import {
	KubernetesWriterLeaseAuthority,
	WRITER_LEASE_GENERATION_ANNOTATION,
	type WriterLeaseApi,
} from "../src/session-writer-lease.ts";

const GENERATION = "gen_abcdefghijklmnopqrstuvwx";
const POD_UID = "12345678-abcd-4321-abcd-123456789abc";

function lease(resourceVersion = "1", holderIdentity: string | null = null, generation = GENERATION): Record<string, unknown> {
	return {
		apiVersion: "coordination.k8s.io/v1",
		kind: "Lease",
		metadata: {
			name: "t4-writer-session",
			namespace: "team",
			uid: "lease-uid",
			resourceVersion,
			annotations: { [WRITER_LEASE_GENERATION_ANNOTATION]: generation },
		},
		spec: { holderIdentity, leaseTransitions: 0 },
	};
}

class MemoryLeaseApi implements WriterLeaseApi {
	current = lease();
	conflicts = 0;
	puts: Array<Record<string, unknown>> = [];
	async request(_path: string, init?: RequestInit): Promise<unknown> {
		if (init?.method !== "PUT") return structuredClone(this.current);
		if (this.conflicts > 0) {
			this.conflicts -= 1;
			throw new KubernetesApiError(409, "conflict");
		}
		const proposed = JSON.parse(String(init.body)) as Record<string, unknown>;
		this.puts.push(proposed);
		const metadata = proposed.metadata as Record<string, unknown>;
		this.current = { ...proposed, metadata: { ...metadata, resourceVersion: String(Number(metadata.resourceVersion) + 1) } };
		return structuredClone(this.current);
	}
}

function authority(api: WriterLeaseApi): KubernetesWriterLeaseAuthority {
	return new KubernetesWriterLeaseAuthority(api, {
		namespace: "team",
		leaseName: "t4-writer-session",
		podUid: POD_UID,
		generation: GENERATION,
	});
}

describe("generation-bound Kubernetes writer Lease", () => {
	test("performs the real unheld-to-current-Pod acquisition transition without a client", async () => {
		const api = new MemoryLeaseApi();
		const writer = authority(api);
		await writer.acquire();
		expect(writer.acquired).toBe(true);
		expect((api.current.spec as Record<string, unknown>).holderIdentity).toBe(POD_UID);
		expect((api.current.spec as Record<string, unknown>).acquireTime).toEqual(expect.any(String));
		expect((api.current.spec as Record<string, unknown>).renewTime).toEqual(expect.any(String));
		expect((api.current.spec as Record<string, unknown>).leaseTransitions).toBe(1);
	});
	test("actively verifies that the authoritative Lease is still held", async () => {
		const api = new MemoryLeaseApi();
		const writer = authority(api);
		await writer.acquire();
		await expect(writer.verifyHeld()).resolves.toBe(true);
		api.current = lease("3", "87654321-other");
		await expect(writer.verifyHeld()).resolves.toBe(false);
		expect(writer.acquired).toBe(false);
	});


	test("re-reads resourceVersion after conflicts and releases only its acquired generation", async () => {
		const api = new MemoryLeaseApi();
		api.conflicts = 1;
		const writer = authority(api);
		await writer.acquire();
		expect((api.current.spec as Record<string, unknown>).holderIdentity).toBe(POD_UID);
		api.conflicts = 1;
		await writer.release();
		expect((api.current.spec as Record<string, unknown>).holderIdentity).toBeNull();
		expect(writer.acquired).toBe(false);
	});

	test("cannot acquire a stale generation or release authority after generation changes", async () => {
		const staleApi = new MemoryLeaseApi();
		staleApi.current = lease("1", null, "gen_zyxwvutsrqponmlkjihgfedc");
		await expect(authority(staleApi).acquire()).rejects.toThrow("stale runtime generation");

		const api = new MemoryLeaseApi();
		const writer = authority(api);
		await writer.acquire();
		api.current = lease("3", POD_UID, "gen_zyxwvutsrqponmlkjihgfedc");
		await writer.release();
		expect((api.current.spec as Record<string, unknown>).holderIdentity).toBe(POD_UID);
	});

	test("does not steal or release another Pod's holder identity", async () => {
		const api = new MemoryLeaseApi();
		api.current = lease("1", "87654321-other");
		await expect(authority(api).acquire()).rejects.toThrow("another Pod");

		const writer = authority(api);
		api.current = lease();
		await writer.acquire();
		api.current = lease("4", "87654321-other");
		await writer.release();
		expect((api.current.spec as Record<string, unknown>).holderIdentity).toBe("87654321-other");
	});
});
