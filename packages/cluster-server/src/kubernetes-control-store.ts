import { createHash } from "node:crypto";
import {
	SharedControlLedgerConflictError,
	SharedControlLedgerUnavailableError,
	SharedControlStore,
	type SharedControlLedgerSnapshot,
	type SharedControlLedgerState,
	type SharedControlLedgerStorage,
	type SharedControlStoreOptions,
} from "@t4-code/portable-control-store";
import { KubernetesApiError, type KubernetesApiClient } from "./kubernetes-client.ts";

const MAX_CONFIG_MAP_STATE_BYTES = 768 * 1024;
const encoder = new TextEncoder();

export class KubernetesConfigMapControlLedgerStorage implements SharedControlLedgerStorage {
	readonly #client: KubernetesApiClient;
	readonly #name: string;
	constructor(client: KubernetesApiClient, authorityName: string) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/u.test(authorityName)) throw new TypeError("control ledger authority name is invalid");
		this.#client = client;
		this.#name = `t4-control-${createHash("sha256").update(authorityName).digest("hex").slice(0, 24)}`;
	}
	async read(): Promise<SharedControlLedgerSnapshot | undefined> {
		try { return this.#snapshot(await this.#client.request(this.#path()) as Record<string, unknown>); }
		catch (error) { if (error instanceof KubernetesApiError && error.status === 404) return undefined; throw new SharedControlLedgerUnavailableError(); }
	}
	async create(state: SharedControlLedgerState): Promise<SharedControlLedgerSnapshot> {
		try {
			return this.#snapshot(await this.#client.request(this.#collection(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(this.#body(state)) }) as Record<string, unknown>);
		} catch (error) { return this.#translate(error); }
	}
	async replace(resourceVersion: string, state: SharedControlLedgerState): Promise<SharedControlLedgerSnapshot> {
		if (!resourceVersion || encoder.encode(resourceVersion).byteLength > 256 || /\p{Cc}/u.test(resourceVersion)) throw new SharedControlLedgerUnavailableError();
		try {
			return this.#snapshot(await this.#client.request(this.#path(), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(this.#body(state, resourceVersion)) }) as Record<string, unknown>);
		} catch (error) { return this.#translate(error); }
	}
	#collection(): string { return `/api/v1/namespaces/${encodeURIComponent(this.#client.namespace)}/configmaps`; }
	#path(): string { return `${this.#collection()}/${this.#name}`; }
	#body(state: SharedControlLedgerState, resourceVersion?: string): object {
		const serialized = JSON.stringify(state);
		if (encoder.encode(serialized).byteLength > MAX_CONFIG_MAP_STATE_BYTES) throw new SharedControlLedgerUnavailableError();
		return { apiVersion: "v1", kind: "ConfigMap", metadata: { name: this.#name, ...(resourceVersion === undefined ? {} : { resourceVersion }), labels: { "app.kubernetes.io/managed-by": "omperator", "cluster.t4.dev/control-ledger": "true" } }, immutable: false, data: { state: serialized } };
	}
	#snapshot(value: Record<string, unknown>): SharedControlLedgerSnapshot {
		const metadata = value.metadata as Record<string, unknown> | undefined;
		const data = value.data as Record<string, unknown> | undefined;
		if (value.apiVersion !== "v1" || value.kind !== "ConfigMap" || typeof metadata?.resourceVersion !== "string" || !metadata.resourceVersion || encoder.encode(metadata.resourceVersion).byteLength > 256 || /\p{Cc}/u.test(metadata.resourceVersion) || typeof data?.state !== "string" || encoder.encode(data.state).byteLength > MAX_CONFIG_MAP_STATE_BYTES) throw new SharedControlLedgerUnavailableError();
		try { return { resourceVersion: metadata.resourceVersion, state: JSON.parse(data.state) as SharedControlLedgerState }; }
		catch { throw new SharedControlLedgerUnavailableError(); }
	}
	#translate(error: unknown): never {
		if (error instanceof KubernetesApiError && error.status === 409) throw new SharedControlLedgerConflictError();
		throw new SharedControlLedgerUnavailableError();
	}
}

export function createKubernetesControlStore(client: KubernetesApiClient, authorityName: string, options: Omit<SharedControlStoreOptions, "storage"> = {}): SharedControlStore {
	return new SharedControlStore({ ...options, storage: new KubernetesConfigMapControlLedgerStorage(client, authorityName) });
}
