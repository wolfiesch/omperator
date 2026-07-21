import type { ServerFrame, SessionRef } from "@t4-code/host-wire";
import { ClusterInfrastructureProjection } from "./kubernetes-projection.ts";
import type { PodHostConnection, PodHostConnector, PodHostEndpoint } from "./pod-host-router.ts";

export interface SessionAuthorityRunnerOptions {
	readonly projection: ClusterInfrastructureProjection;
	readonly connector: PodHostConnector;
	readonly retryMs?: number;
	readonly onError?: (error: unknown) => void;
}

interface AuthorityConnection {
	readonly endpoint: PodHostEndpoint;
	readonly pending: Promise<PodHostConnection>;
}

/** Reconstructs session truth from each pod's authenticated omp-app/1 inventory. */
export class SessionAuthorityRunner {
	readonly #options: SessionAuthorityRunnerOptions;
	readonly #connections = new Map<string, AuthorityConnection>();
	#unsubscribe?: () => void;
	#retry?: ReturnType<typeof setTimeout>;
	#started = false;

	constructor(options: SessionAuthorityRunnerOptions) { this.#options = options; }

	start(): void {
		if (this.#started) throw new Error("session authority runner already started");
		this.#started = true;
		this.#unsubscribe = this.#options.projection.subscribeSessions(() => this.#reconcile());
		this.#reconcile();
	}

	async stop(): Promise<void> {
		if (!this.#started) return;
		this.#started = false;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		if (this.#retry) clearTimeout(this.#retry);
		this.#retry = undefined;
		const pending = [...this.#connections.values()].map(entry => entry.pending);
		this.#connections.clear();
		await Promise.allSettled(pending.map(async connection => (await connection).close(1001, "cluster server stopping")));
	}

	#reconcile(): void {
		if (!this.#started) return;
		const endpoints = new Map(this.#options.projection.sessionEndpoints().map(endpoint => [endpoint.clusterSessionId, endpoint]));
		for (const [session, existing] of this.#connections) {
			const current = endpoints.get(session);
			if (current?.url === existing.endpoint.url) continue;
			this.#connections.delete(session);
			this.#options.projection.clearSessionAuthority(session);
			void existing.pending.then(connection => connection.close(1001, "session endpoint changed"), () => undefined);
		}
		for (const [session, endpoint] of endpoints) {
			if (this.#connections.has(session)) continue;
			let pending: Promise<PodHostConnection>;
			pending = this.#options.connector.connect(
				endpoint,
				frame => this.#projectFrame(endpoint, frame),
				() => this.#disconnected(session, pending),
			);
			this.#connections.set(session, { endpoint, pending });
			pending.catch(error => {
				if (this.#connections.get(session)?.pending !== pending) return;
				this.#connections.delete(session);
				this.#options.projection.clearSessionAuthority(session);
				this.#options.onError?.(error);
				this.#scheduleRetry();
			});
		}
	}

	#projectFrame(endpoint: PodHostEndpoint, frame: ServerFrame): void {
		if (frame.type === "sessions") {
			if (frame.sessions.length !== 1) throw new Error("session pod must expose exactly one authoritative OMP session");
			this.#options.projection.setSessionAuthority(endpoint.clusterSessionId, frame.sessions[0] as SessionRef);
			return;
		}
		if (frame.type !== "session.delta") return;
		if (frame.upsert) this.#options.projection.setSessionAuthority(endpoint.clusterSessionId, frame.upsert);
		else if (frame.remove) this.#options.projection.clearSessionAuthority(endpoint.clusterSessionId);
	}

	#disconnected(session: string, pending: Promise<PodHostConnection>): void {
		if (this.#connections.get(session)?.pending !== pending) return;
		this.#connections.delete(session);
		this.#options.projection.clearSessionAuthority(session);
		this.#scheduleRetry();
	}

	#scheduleRetry(): void {
		if (!this.#started || this.#retry) return;
		this.#retry = setTimeout(() => {
			this.#retry = undefined;
			this.#reconcile();
		}, this.#options.retryMs ?? 1_000);
	}
}
