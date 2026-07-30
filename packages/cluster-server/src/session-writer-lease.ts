import { KubernetesApiError, type KubernetesApiClient } from "./kubernetes-client.ts";

export const WRITER_LEASE_GENERATION_ANNOTATION = "cluster.t4.dev/runtime-generation";
const MAX_CONFLICT_RETRIES = 8;

interface LeaseResource {
	readonly apiVersion: "coordination.k8s.io/v1";
	readonly kind: "Lease";
	readonly metadata: {
		readonly name: string;
		readonly namespace?: string;
		readonly uid: string;
		readonly resourceVersion: string;
		readonly annotations?: Readonly<Record<string, string>>;
	};
	readonly spec?: {
		readonly holderIdentity?: string | null;
		readonly acquireTime?: string | null;
		readonly renewTime?: string | null;
		readonly leaseTransitions?: number | null;
	};
}

export interface WriterLeaseApi {
	request(path: string, init?: RequestInit): Promise<unknown>;
}

export interface WriterLeaseIdentity {
	readonly namespace: string;
	readonly leaseName: string;
	readonly podUid: string;
	readonly generation: string;
}

function dns(value: string, name: string): string {
	if (!/^[a-z0-9](?:[-a-z0-9]{0,251}[a-z0-9])?$/u.test(value)) throw new Error(`${name} is invalid`);
	return value;
}

function identity(value: string, name: string, expression: RegExp): string {
	if (!expression.test(value)) throw new Error(`${name} is invalid`);
	return value;
}

function leaseResource(value: unknown, expectedName: string): LeaseResource {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("writer Lease response is invalid");
	const lease = value as Partial<LeaseResource>;
	const metadata = lease.metadata;
	if (lease.apiVersion !== "coordination.k8s.io/v1" || lease.kind !== "Lease" || !metadata ||
		metadata.name !== expectedName || typeof metadata.uid !== "string" || !metadata.uid ||
		typeof metadata.resourceVersion !== "string" || !metadata.resourceVersion) {
		throw new Error("writer Lease response identity is invalid");
	}
	return lease as LeaseResource;
}

export class KubernetesWriterLeaseAuthority {
	readonly #api: WriterLeaseApi;
	readonly #identity: WriterLeaseIdentity;
	readonly #path: string;
	#acquiredLeaseUid?: string;

	constructor(api: WriterLeaseApi | KubernetesApiClient, identityValue: WriterLeaseIdentity) {
		this.#api = api;
		this.#identity = {
			namespace: dns(identityValue.namespace, "writer Lease namespace"),
			leaseName: dns(identityValue.leaseName, "writer Lease name"),
			podUid: identity(identityValue.podUid, "Pod UID", /^[A-Za-z0-9-]{8,128}$/u),
			generation: identity(identityValue.generation, "runtime generation", /^gen_[A-Za-z0-9_-]{24}$/u),
		};
		this.#path = `/apis/coordination.k8s.io/v1/namespaces/${encodeURIComponent(this.#identity.namespace)}/leases/${encodeURIComponent(this.#identity.leaseName)}`;
	}

	get acquired(): boolean { return this.#acquiredLeaseUid !== undefined; }

	async acquire(): Promise<void> {
		for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt += 1) {
			const current = await this.#read();
			this.#assertGeneration(current);
			const holder = current.spec?.holderIdentity ?? "";
			if (holder && holder !== this.#identity.podUid) throw new Error("writer Lease is held by another Pod");
			if (holder === this.#identity.podUid) {
				this.#acquiredLeaseUid = current.metadata.uid;
				return;
			}
			const now = new Date().toISOString();
			const transitions = current.spec?.leaseTransitions;
			const next = {
				...current,
				metadata: { ...current.metadata, resourceVersion: current.metadata.resourceVersion },
				spec: {
					...current.spec,
					holderIdentity: this.#identity.podUid,
					acquireTime: now,
					renewTime: now,
					leaseTransitions: Number.isSafeInteger(transitions) ? (transitions as number) + 1 : 1,
				},
			};
			try {
				const acquired = leaseResource(await this.#put(next), this.#identity.leaseName);
				this.#assertGeneration(acquired);
				if (acquired.metadata.uid !== current.metadata.uid) throw new Error("writer Lease identity changed during acquisition");
				if (acquired.spec?.holderIdentity !== this.#identity.podUid) throw new Error("writer Lease acquisition was not persisted");
				this.#acquiredLeaseUid = acquired.metadata.uid;
				return;
			} catch (error) {
				if (!(error instanceof KubernetesApiError) || error.status !== 409) throw error;
			}
		}
		throw new Error("writer Lease acquisition conflicted repeatedly");
	}
	async verifyHeld(): Promise<boolean> {
		const acquiredUid = this.#acquiredLeaseUid;
		if (!acquiredUid) return false;
		try {
			const current = await this.#read();
			const held = current.metadata.uid === acquiredUid &&
				current.metadata.annotations?.[WRITER_LEASE_GENERATION_ANNOTATION] === this.#identity.generation &&
				current.spec?.holderIdentity === this.#identity.podUid;
			if (!held) this.#acquiredLeaseUid = undefined;
			return held;
		} catch (error) {
			if (error instanceof KubernetesApiError && error.status === 404) {
				this.#acquiredLeaseUid = undefined;
				return false;
			}
			throw error;
		}
	}


	async release(): Promise<void> {
		const acquiredUid = this.#acquiredLeaseUid;
		if (!acquiredUid) return;
		try {
			for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt += 1) {
				let current: LeaseResource;
				try { current = await this.#read(); }
				catch (error) {
					if (error instanceof KubernetesApiError && error.status === 404) return;
					throw error;
				}
				if (current.metadata.uid !== acquiredUid ||
					current.metadata.annotations?.[WRITER_LEASE_GENERATION_ANNOTATION] !== this.#identity.generation ||
					current.spec?.holderIdentity !== this.#identity.podUid) return;
				const next = {
					...current,
					metadata: { ...current.metadata, resourceVersion: current.metadata.resourceVersion },
					spec: { ...current.spec, holderIdentity: null, acquireTime: null, renewTime: null },
				};
				try {
					const released = leaseResource(await this.#put(next), this.#identity.leaseName);
					if (released.metadata.uid !== acquiredUid ||
						released.metadata.annotations?.[WRITER_LEASE_GENERATION_ANNOTATION] !== this.#identity.generation ||
						released.spec?.holderIdentity) throw new Error("writer Lease release was not persisted");
					return;
				} catch (error) {
					if (!(error instanceof KubernetesApiError) || error.status !== 409) throw error;
				}
			}
			throw new Error("writer Lease release conflicted repeatedly");
		} finally {
			this.#acquiredLeaseUid = undefined;
		}
	}

	async #read(): Promise<LeaseResource> {
		return leaseResource(await this.#api.request(this.#path), this.#identity.leaseName);
	}
	async #put(lease: LeaseResource | object): Promise<unknown> {
		return await this.#api.request(this.#path, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(lease),
		});
	}
	#assertGeneration(lease: LeaseResource): void {
		if (lease.metadata.annotations?.[WRITER_LEASE_GENERATION_ANNOTATION] !== this.#identity.generation)
			throw new Error("writer Lease belongs to a stale runtime generation");
	}
}
