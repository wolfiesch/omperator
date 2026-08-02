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
	readonly identity: symbol;
	readonly pending: Promise<PodHostConnection>;
	upstreamSessionId?: string;
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
			if (current?.routeGeneration === existing.endpoint.routeGeneration) continue;
			this.#connections.delete(session);
			this.#options.projection.clearSessionAuthority(
				session,
				existing.endpoint.routeGeneration,
				existing.upstreamSessionId,
			);
			void existing.pending.then(connection => connection.close(1001, "session endpoint generation changed"), () => undefined);
		}
		for (const [session, endpoint] of endpoints) {
			if (this.#connections.has(session)) continue;
			const identity = Symbol(session);
			const pending = this.#options.connector.connect(
				endpoint,
				frame => this.#projectFrame(session, identity, frame),
				() => this.#disconnected(session, identity),
			);
			const entry: AuthorityConnection = { endpoint, identity, pending };
			this.#connections.set(session, entry);
			pending.catch(error => {
				if (this.#connections.get(session)?.identity !== identity) return;
				this.#connections.delete(session);
				this.#options.projection.clearSessionAuthority(
					session,
					endpoint.routeGeneration,
					entry.upstreamSessionId,
				);
				this.#options.onError?.(error);
				this.#scheduleRetry();
			});
		}
	}

	#projectFrame(session: string, identity: symbol, frame: ServerFrame): void {
		const entry = this.#connections.get(session);
		if (!entry || entry.identity !== identity) return;
		if (frame.type === "sessions") {
			if (frame.sessions.length !== 1) {
				this.#invalidate(session, entry, "session pod must expose exactly one authoritative OMP session");
				return;
			}
			const authority = frame.sessions[0] as SessionRef;
			if (entry.upstreamSessionId !== undefined && entry.upstreamSessionId !== authority.sessionId) {
				this.#invalidate(session, entry, "session pod authority changed without a new route generation");
				return;
			}
			entry.upstreamSessionId = authority.sessionId;
			if (!this.#options.projection.setSessionAuthority(session, authority, entry.endpoint.routeGeneration))
				this.#invalidate(session, entry, "session route generation changed during authority snapshot");
			return;
		}
		if (frame.type !== "session.delta") return;
		if (entry.upstreamSessionId === undefined) {
			this.#invalidate(session, entry, "session authority delta arrived before an exact snapshot");
			return;
		}
		const deltaSessionId = frame.upsert?.sessionId ?? frame.remove;
		if (deltaSessionId !== entry.upstreamSessionId) {
			this.#invalidate(session, entry, "session authority delta did not match the bound upstream session");
			return;
		}
		if (frame.upsert) {
			if (!this.#options.projection.setSessionAuthority(session, frame.upsert, entry.endpoint.routeGeneration))
				this.#invalidate(session, entry, "session route generation changed during authority delta");
		} else {
			this.#options.projection.clearSessionAuthority(
				session,
				entry.endpoint.routeGeneration,
				entry.upstreamSessionId,
			);
		}
	}

	#invalidate(session: string, entry: AuthorityConnection, message: string): void {
		if (this.#connections.get(session)?.identity !== entry.identity) return;
		this.#connections.delete(session);
		this.#options.projection.clearSessionAuthority(
			session,
			entry.endpoint.routeGeneration,
			entry.upstreamSessionId,
		);
		void entry.pending.then(connection => connection.close(1008, message), () => undefined);
		this.#options.onError?.(new Error(message));
		this.#scheduleRetry();
	}

	#disconnected(session: string, identity: symbol): void {
		const entry = this.#connections.get(session);
		if (!entry || entry.identity !== identity) return;
		this.#connections.delete(session);
		this.#options.projection.clearSessionAuthority(
			session,
			entry.endpoint.routeGeneration,
			entry.upstreamSessionId,
		);
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
