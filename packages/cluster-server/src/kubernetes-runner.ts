import { KubernetesApiClient, KubernetesApiError } from "./kubernetes-client.ts";
import { ClusterInfrastructureProjection, KubernetesAuthorityInvalidatedError } from "./kubernetes-projection.ts";

export interface KubernetesProjectionRunnerOptions {
	readonly client: KubernetesApiClient;
	readonly projection: ClusterInfrastructureProjection;
	readonly hostName: string;
	readonly onSynchronized?: () => void;
	readonly onError?: (error: unknown) => void;
	readonly retryMs?: number;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const finish = (): void => { signal.removeEventListener("abort", abort); resolve(); };
		const timer = setTimeout(finish, milliseconds);
		const abort = (): void => { clearTimeout(timer); reject(signal.reason); };
		signal.addEventListener("abort", abort, { once: true });
	});
}

/** Rebuildable list/watch runner. Kubernetes remains the sole infrastructure source. */
export class KubernetesProjectionRunner {
	readonly #options: KubernetesProjectionRunnerOptions;
	readonly #synchronized = new Set<string>();
	#abort?: AbortController;
	#running?: Promise<void>;
	#relist?: Promise<void>;
	constructor(options: KubernetesProjectionRunnerOptions) { this.#options = options; }

	async start(): Promise<void> {
		if (this.#running) throw new Error("Kubernetes projection runner already started");
		this.#abort = new AbortController();
		const signal = this.#abort.signal;
		const initial = await this.#options.client.listInfrastructure(this.#options.hostName, signal);
		this.#options.projection.replace(initial);
		this.#synchronized.clear();
		for (const resource of ["t4clusterhosts", "t4workspaces", "t4sessions"]) this.#synchronized.add(resource);
		this.#options.onSynchronized?.();
		this.#running = this.#run(signal);
	}

	async stop(): Promise<void> {
		this.#abort?.abort(new Error("Kubernetes projection runner stopped"));
		await this.#running?.catch(() => undefined);
		this.#running = undefined;
		this.#abort = undefined;
		this.#relist = undefined;
		this.#synchronized.clear();
	}

	async #run(signal: AbortSignal): Promise<void> {
		const resources = ["t4clusterhosts", "t4workspaces", "t4sessions"] as const;
		while (!signal.aborted) {
			const generation = new AbortController();
			const stopGeneration = (): void => generation.abort(signal.reason);
			signal.addEventListener("abort", stopGeneration, { once: true });
			await Promise.all(resources.map(resource => this.#watchResource(resource, resources.length, signal, generation)));
			signal.removeEventListener("abort", stopGeneration);
		}
	}

	async #watchResource(
		resource: string,
		resourceCount: number,
		rootSignal: AbortSignal,
		generation: AbortController,
	): Promise<void> {
		let version = this.#options.projection.resourceVersionFor(resource);
		while (!generation.signal.aborted) {
			try {
				await this.#options.client.watch(
					resource,
					version,
					event => {
						this.#options.projection.applyWatch(event);
						version = event.object.metadata.resourceVersion ?? version;
					},
					generation.signal,
					() => {
						this.#synchronized.add(resource);
						if (this.#synchronized.size === resourceCount) this.#options.onSynchronized?.();
					},
				);
				if (generation.signal.aborted) return;
				this.#synchronized.delete(resource);
				this.#options.onError?.(new Error(`Kubernetes ${resource} watch ended`));
			} catch (error) {
				if (generation.signal.aborted || rootSignal.aborted) return;
				this.#synchronized.delete(resource);
				this.#options.onError?.(error);
				const requiresRelist = error instanceof KubernetesAuthorityInvalidatedError
					|| error instanceof KubernetesApiError && error.status === 410;
				if (requiresRelist) {
					try { await this.#restartGeneration(generation, rootSignal); }
					catch (relistError) {
						if (!rootSignal.aborted) this.#options.onError?.(relistError);
					}
					return;
				}
			}
			try { await delay(this.#options.retryMs ?? 1_000, generation.signal); }
			catch { return; }
		}
	}

	async #restartGeneration(generation: AbortController, signal: AbortSignal): Promise<void> {
		if (!this.#relist) {
			this.#synchronized.clear();
			generation.abort(new Error("Kubernetes watch generation relisting"));
			this.#relist = (async () => {
				while (!signal.aborted) {
					try {
						const snapshot = await this.#options.client.listInfrastructure(this.#options.hostName, signal);
						this.#options.projection.replace(snapshot);
						return;
					} catch (error) {
						if (signal.aborted) throw error;
						this.#options.onError?.(error);
						await delay(this.#options.retryMs ?? 1_000, signal);
					}
				}
				throw signal.reason;
			})().finally(() => { this.#relist = undefined; });
		}
		await this.#relist;
	}
}
