import type { SessionCiState } from "@t4-code/host-wire";
import type { ClusterInfrastructureProjection, SessionCiCorrelation } from "./kubernetes-projection.ts";
import type { CiProvider } from "./woodpecker.ts";

export interface CiProjectionRunnerOptions {
	readonly projection: ClusterInfrastructureProjection;
	readonly provider: CiProvider;
	readonly pollMs?: number;
	readonly onError?: (error: unknown) => void;
}

/** Reconstructs bounded CI observations from the configured provider on every replica. */
export class CiProjectionRunner {
	readonly #projection: ClusterInfrastructureProjection;
	readonly #provider: CiProvider;
	readonly #pollMs: number;
	readonly #onError?: (error: unknown) => void;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#inflight: Promise<void> | undefined;
	#unsubscribe: (() => void) | undefined;
	#correlationFingerprint = "";
	#started = false;

	constructor(options: CiProjectionRunnerOptions) {
		this.#projection = options.projection;
		this.#provider = options.provider;
		this.#pollMs = options.pollMs ?? 5_000;
		if (!Number.isSafeInteger(this.#pollMs) || this.#pollMs < 10 || this.#pollMs > 60_000)
			throw new Error("CI projection poll interval is invalid");
		this.#onError = options.onError;
	}

	start(): void {
		if (this.#started) throw new Error("CI projection runner already started");
		this.#started = true;
		this.#unsubscribe = this.#projection.subscribeSessions(() => this.#scheduleWhenCorrelationsChange());
		this.#correlationFingerprint = this.#fingerprint(this.#projection.sessionCiCorrelations());
		this.#schedule(0);
	}

	async stop(): Promise<void> {
		if (!this.#started) return;
		this.#started = false;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		await this.#inflight;
	}

	#fingerprint(correlations: readonly SessionCiCorrelation[]): string {
		return JSON.stringify([...correlations].sort((left, right) => left.sessionId.localeCompare(right.sessionId)));
	}

	#scheduleWhenCorrelationsChange(): void {
		const fingerprint = this.#fingerprint(this.#projection.sessionCiCorrelations());
		if (fingerprint === this.#correlationFingerprint) return;
		this.#correlationFingerprint = fingerprint;
		this.#schedule(0);
	}

	#schedule(delayMs: number): void {
		if (!this.#started) return;
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			if (this.#inflight) return;
			const operation = this.#refresh();
			this.#inflight = operation;
			const finish = (): void => {
				if (this.#inflight === operation) this.#inflight = undefined;
				this.#schedule(this.#pollMs);
			};
			void operation.then(finish, error => {
				this.#onError?.(error);
				finish();
			});
		}, delayMs);
	}

	async #refresh(): Promise<void> {
		const correlations = this.#projection.sessionCiCorrelations();
		this.#correlationFingerprint = this.#fingerprint(correlations);
		await Promise.all(correlations.map(async correlation => {
			let state: SessionCiState;
			try {
				state = await this.#provider.query(correlation);
				this.#projection.setSessionCiState(correlation.sessionId, state);
			} catch (error) {
				this.#projection.setSessionCiState(correlation.sessionId, {
					provider: "woodpecker",
					correlation: "unknown",
					repositoryId: correlation.repositoryId,
					ref: correlation.ref,
					commit: correlation.commit,
				});
				this.#onError?.(error);
			}
		}));
	}
}
