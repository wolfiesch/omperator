import {
	CLUSTER_MAX_WORKSPACES as WIRE_MAX_WORKSPACES,
	decodeClusterCondition,
	decodeSessionCiState,
	decodeSessionRef,
	decodeWorkspaceInfrastructureProjection,
	hostId,
	revision,
	type ClusterCondition,
	type Cursor,
	type HostId,
	type SessionRef,
	type SessionCiState,
	type WorkspaceInfrastructureProjection,
	type WorkspaceListResult,
	type WorkspaceStateFrame,
} from "@t4-code/host-wire";
import type { PodHostEndpoint, PodHostRoute } from "./pod-host-router.ts";
export const CLUSTER_MAX_WORKSPACES = WIRE_MAX_WORKSPACES;
export const CLUSTER_MAX_SESSIONS = 1_000;
export const CLUSTER_WORKSPACE_REPLAY_FRAMES = 512;

export interface KubernetesMetadata {
	readonly name: string;
	readonly uid?: string;
	readonly resourceVersion?: string;
	readonly generation?: number;
	readonly creationTimestamp?: string;
	readonly deletionTimestamp?: string;
	readonly annotations?: Readonly<Record<string, string>>;
}
export interface KubernetesResource {
	readonly apiVersion?: string;
	readonly kind?: string;
	readonly metadata: KubernetesMetadata;
	readonly spec?: Readonly<Record<string, unknown>>;
	readonly status?: Readonly<Record<string, unknown>>;
}
export interface KubernetesWatchEvent {
	readonly type: "ADDED" | "MODIFIED" | "DELETED";
	readonly object: KubernetesResource;
}
export class KubernetesAuthorityInvalidatedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "KubernetesAuthorityInvalidatedError";
	}
}
export interface InfrastructureList {
	readonly host: KubernetesResource;
	readonly workspaces: readonly KubernetesResource[];
	readonly sessions: readonly KubernetesResource[];
	readonly resourceVersion: string;
	readonly resourceVersions?: Readonly<Record<string, string>>;
}
export interface ClusterInfrastructureProjectionOptions {
	readonly epoch: string;
	readonly namespace: string;
	readonly maxWorkspaces?: number;
	readonly maxSessions?: number;
}

type SessionListener = () => void;
interface WorkspaceReplayItem { readonly frame: WorkspaceStateFrame; readonly owner?: string; }
interface WorkspaceSubscription { readonly listener: (frame: WorkspaceStateFrame) => void; readonly principal?: string; }
export interface SessionCiCorrelation {
	readonly sessionId: string;
	readonly repositoryId: string;
	readonly ref: string;
	readonly commit: string;
}

interface SessionAuthorityWaiter { readonly resolve: (value: SessionRef) => void; readonly reject: (reason: Error) => void; readonly timer: ReturnType<typeof setTimeout>; }
function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}
function number(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}
function firstCondition(status: Readonly<Record<string, unknown>>): ClusterCondition | undefined {
	if (!Array.isArray(status.conditions) || status.conditions.length === 0) return undefined;
	const raw = record(status.conditions[0]);
	try {
		return decodeClusterCondition({
			type: raw.type,
			status: raw.status,
			reason: raw.reason,
			message: raw.message ?? "",
			observedGeneration: raw.observedGeneration ?? status.observedGeneration ?? 0,
		});
	} catch {
		return undefined;
	}
}
function categorical<const T extends readonly string[]>(value: unknown, values: T, fallback: T[number]): T[number] {
	return typeof value === "string" && (values as readonly string[]).includes(value) ? value as T[number] : fallback;
}
function resourceRevision(resource: KubernetesResource): string {
	return text(resource.metadata.resourceVersion, `generation-${number(resource.metadata.generation)}`);
}
function serviceName(value: unknown): string | undefined {
	if (typeof value !== "string" || !/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u.test(value)) return undefined;
	return value;
}
function workspaceOwner(resource: KubernetesResource): string | undefined {
	const owner = record(resource.spec).owner;
	if (typeof owner !== "string" || owner.length === 0 || new TextEncoder().encode(owner).byteLength > 256 || /\p{Cc}/u.test(owner)) return undefined;
	return owner;
}
function ciSelection(resource: KubernetesResource): { readonly repositoryId: string; readonly ref: string; readonly commit: string } | undefined {
	const ci = record(record(resource.spec).ci);
	if (typeof ci.repositoryId !== "string" || typeof ci.ref !== "string" || typeof ci.commit !== "string") return undefined;
	return { repositoryId: ci.repositoryId, ref: ci.ref, commit: ci.commit };
}

export function clusterHostIdFromUid(uid: string): HostId {
	if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u.test(uid)) throw new Error("T4ClusterHost UID is invalid");
	return hostId(`cluster:${uid}`);
}

export class ClusterInfrastructureProjection {
	readonly epoch: string;
	readonly namespace: string;
	readonly maxWorkspaces: number;
	readonly maxSessions: number;
	#hostId?: HostId;
	#host?: KubernetesResource;
	#workspaces = new Map<string, KubernetesResource>();
	#sessions = new Map<string, KubernetesResource>();
	#authoritativeSessions = new Map<string, SessionRef>();
	#ciStates = new Map<string, SessionCiState>();
	#authorityWaiters = new Map<string, Set<SessionAuthorityWaiter>>();
	#versions = new Map<string, string>();
	#workspaceSequence = 0;
	#sessionSequence = 0;
	#workspaceListeners = new Set<WorkspaceSubscription>();
	#sessionListeners = new Set<SessionListener>();
	#replay: WorkspaceReplayItem[] = [];
	#resourceVersion = "0";
	#resourceVersions: Readonly<Record<string, string>> = {};
	#initialized = false;

	constructor(options: ClusterInfrastructureProjectionOptions) {
		if (!options.epoch || options.epoch.length > 128) throw new Error("replica epoch is invalid");
		if (!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u.test(options.namespace)) throw new Error("namespace is invalid");
		this.epoch = options.epoch;
		this.namespace = options.namespace;
		this.maxWorkspaces = options.maxWorkspaces ?? CLUSTER_MAX_WORKSPACES;
		this.maxSessions = options.maxSessions ?? CLUSTER_MAX_SESSIONS;
		if (this.maxWorkspaces < 1 || this.maxWorkspaces > CLUSTER_MAX_WORKSPACES) throw new Error("workspace projection limit is invalid");
		if (this.maxSessions < 1 || this.maxSessions > CLUSTER_MAX_SESSIONS) throw new Error("session projection limit is invalid");
	}

	get hostId(): HostId {
		if (!this.#hostId) throw new Error("cluster host projection is not synchronized");
		return this.#hostId;
	}
	get workspaceCursor(): Cursor { return { epoch: this.epoch, seq: this.#workspaceSequence }; }
	get sessionCursor(): Cursor { return { epoch: this.epoch, seq: this.#sessionSequence }; }
	get resourceVersion(): string { return this.#resourceVersion; }
	resourceVersionFor(resource: string): string { return this.#resourceVersions[resource] ?? this.#resourceVersion; }

	replace(input: InfrastructureList): void {
		if (input.workspaces.length > this.maxWorkspaces) throw new Error("workspace projection limit exceeded");
		if (input.sessions.length > this.maxSessions) throw new Error("session projection limit exceeded");
		if (input.host.kind !== "T4ClusterHost" || !input.host.metadata.uid) throw new Error("T4ClusterHost identity is missing");
		const selectedHost = input.host.metadata.name;
		for (const resource of input.workspaces)
			if (resource.kind !== "T4Workspace" || record(resource.spec).hostRef !== selectedHost) throw new Error("workspace belongs to another cluster host");
		for (const resource of input.sessions)
			if (resource.kind !== "T4Session" || record(resource.spec).hostRef !== selectedHost) throw new Error("session belongs to another cluster host");
		const nextHostId = clusterHostIdFromUid(input.host.metadata.uid);
		if (this.#hostId && this.#hostId !== nextHostId) throw new Error("T4ClusterHost UID changed within a replica epoch");
		const initialized = this.#initialized;
		const previousWorkspaces = this.#workspaces;
		const previousSessions = this.#sessions;
		const nextWorkspaces = new Map(input.workspaces.map(resource => [resource.metadata.name, resource]));
		const nextSessions = new Map(input.sessions.map(resource => [resource.metadata.name, resource]));
		this.#hostId = nextHostId;
		this.#host = input.host;
		this.#initialized = true;
		this.#workspaces = nextWorkspaces;
		this.#sessions = nextSessions;
		for (const name of this.#authoritativeSessions.keys()) if (!nextSessions.has(name)) this.#authoritativeSessions.delete(name);
		for (const [name, state] of this.#ciStates) {
			const selected = nextSessions.get(name);
			const ci = selected ? ciSelection(selected) : undefined;
			if (!ci || ci.repositoryId !== state.repositoryId || ci.ref !== state.ref || ci.commit !== state.commit) this.#ciStates.delete(name);
		}
		this.#versions.clear();
		for (const resource of [input.host, ...input.workspaces, ...input.sessions])
			this.#versions.set(`${resource.kind ?? "unknown"}/${resource.metadata.name}`, text(resource.metadata.resourceVersion));
		this.#resourceVersion = input.resourceVersion;
		this.#resourceVersions = input.resourceVersions ?? {};
		if (!initialized) {
			this.#workspaceSequence = 1;
			this.#sessionSequence = 1;
			return;
		}
		const workspaceNames = [...new Set([...previousWorkspaces.keys(), ...nextWorkspaces.keys()])].sort();
		let workspaceAccessChanged = false;
		for (const name of workspaceNames) {
			const before = previousWorkspaces.get(name);
			const after = nextWorkspaces.get(name);
			if (before && after && resourceRevision(before) === resourceRevision(after)) continue;
			const beforeOwner = before ? workspaceOwner(before) : undefined;
			const afterOwner = after ? workspaceOwner(after) : undefined;
			if (before && after && beforeOwner !== afterOwner) {
				this.#publishWorkspace(before, true, beforeOwner);
				this.#publishWorkspace(after, false, afterOwner);
				workspaceAccessChanged = true;
			} else if (after) {
				this.#publishWorkspace(after, false, afterOwner);
				workspaceAccessChanged ||= !before;
			} else if (before) {
				this.#publishWorkspace(before, true, beforeOwner);
				workspaceAccessChanged = true;
			}
		}
		const sessionNames = new Set([...previousSessions.keys(), ...nextSessions.keys()]);
		const sessionsChanged = [...sessionNames].some(name => {
			const before = previousSessions.get(name);
			const after = nextSessions.get(name);
			return !before || !after || resourceRevision(before) !== resourceRevision(after);
		});
		if (sessionsChanged || workspaceAccessChanged) {
			this.#sessionSequence++;
			for (const listener of this.#sessionListeners) listener();
		}
	}

	workspaceList(principal?: string): WorkspaceListResult {
		return {
			cursor: this.workspaceCursor,
			workspaces: [...this.#workspaces.values()]
				.filter(resource => principal === undefined || workspaceOwner(resource) === principal)
				.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
				.map(resource => this.#workspace(resource)),
		};
	}
	sessionRefs(principal?: string): SessionRef[] {
		return [...this.#sessions.values()]
			.filter(resource => principal === undefined || this.#ownsSessionResource(resource, principal))
			.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
			.flatMap(resource => {
				const authoritative = this.#authoritativeSessions.get(resource.metadata.name);
				return authoritative ? [this.#session(resource, authoritative)] : [];
			});
	}

	allowedOrigins(): readonly string[] {
		const values = record(this.#host?.spec).allowedOrigins;
		if (!Array.isArray(values) || values.length > 64) return [];
		const origins: string[] = [];
		for (const value of values) {
			if (typeof value !== "string") continue;
			try {
				const url = new URL(value);
				if (url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash)
					origins.push(url.origin);
			} catch {}
		}
		return origins;
	}

	ownsWorkspace(workspace: string, principal: string): boolean {
		const resource = this.#workspaces.get(workspace);
		return resource !== undefined && workspaceOwner(resource) === principal;
	}
	ownsSession(session: string, principal: string): boolean {
		const resource = this.#sessions.get(session);
		return resource !== undefined && this.#ownsSessionResource(resource, principal);
	}
	sessionExists(session: string): boolean {
		return this.#sessions.has(session);
	}
	sessionGuiState(session: string, principal?: string): "Unavailable" | "Starting" | "Ready" | "Failed" | undefined {
		const resource = this.#sessions.get(session);
		if (!resource || principal !== undefined && !this.#ownsSessionResource(resource, principal)) return undefined;
		if (record(resource.spec).guiEnabled !== true) return "Unavailable";
		const phase = record(resource.status).phase;
		if (phase === "Running") return "Ready";
		if (phase === "Failed" || phase === "Terminating") return "Failed";
		return "Starting";
	}
	sessionEndpoints(): PodHostEndpoint[] {
		return [...this.#sessions.values()].flatMap(resource => {
			const service = serviceName(record(resource.status).serviceName);
			return service ? [{ clusterSessionId: resource.metadata.name, url: `ws://${service}.${this.namespace}.svc:8787/v1/ws` }] : [];
		});
	}
	sessionRoute(clusterSessionId: string, principal?: string): PodHostRoute | undefined {
		const resource = this.#sessions.get(clusterSessionId);
		const authoritative = this.#authoritativeSessions.get(clusterSessionId);
		if (!resource || !authoritative || principal !== undefined && !this.#ownsSessionResource(resource, principal)) return undefined;
		const service = serviceName(record(resource.status).serviceName);
		if (!service) return undefined;
		return { clusterSessionId, upstreamSessionId: authoritative.sessionId, url: `ws://${service}.${this.namespace}.svc:8787/v1/ws` };
	}
	sessionRevision(session: string, principal?: string): string | undefined {
		const resource = this.#sessions.get(session);
		const authoritative = this.#authoritativeSessions.get(session);
		if (!resource || !authoritative || principal !== undefined && !this.#ownsSessionResource(resource, principal)) return undefined;
		return authoritative.revision;
	}
	sessionRef(session: string, principal?: string): SessionRef | undefined {
		const resource = this.#sessions.get(session);
		const authoritative = this.#authoritativeSessions.get(session);
		if (!resource || !authoritative || principal !== undefined && !this.#ownsSessionResource(resource, principal)) return undefined;
		return this.#session(resource, authoritative);
	}
	setSessionAuthority(clusterSessionId: string, value: SessionRef): void {
		const resource = this.#sessions.get(clusterSessionId);
		if (!resource) return;
		const authoritative = decodeSessionRef(value, `authority.${clusterSessionId}`);
		const previous = this.#authoritativeSessions.get(clusterSessionId);
		if (previous && JSON.stringify(previous) === JSON.stringify(authoritative)) return;
		const projected = this.#session(resource, authoritative);
		this.#authoritativeSessions.set(clusterSessionId, authoritative);
		this.#sessionSequence++;
		for (const waiter of this.#authorityWaiters.get(clusterSessionId) ?? []) {
			clearTimeout(waiter.timer);
			waiter.resolve(projected);
		}
		this.#authorityWaiters.delete(clusterSessionId);
		for (const listener of this.#sessionListeners) listener();
	}
	clearSessionAuthority(clusterSessionId: string): void {
		if (!this.#authoritativeSessions.delete(clusterSessionId)) return;
		this.#sessionSequence++;
		for (const listener of this.#sessionListeners) listener();
	}
	waitForSessionAuthority(clusterSessionId: string, timeoutMs = 30_000): Promise<SessionRef> {
		const current = this.sessionRef(clusterSessionId);
		if (current) return Promise.resolve(current);
		const deferred = Promise.withResolvers<SessionRef>();
		let waiter: SessionAuthorityWaiter | undefined;
		const timer = setTimeout(() => {
			const waiters = this.#authorityWaiters.get(clusterSessionId);
			if (waiter) waiters?.delete(waiter);
			if (waiters?.size === 0) this.#authorityWaiters.delete(clusterSessionId);
			deferred.reject(new Error("authoritative OMP session did not become available"));
		}, timeoutMs);
		waiter = { resolve: deferred.resolve, reject: deferred.reject, timer };
		const waiters = this.#authorityWaiters.get(clusterSessionId) ?? new Set<SessionAuthorityWaiter>();
		waiters.add(waiter);
		this.#authorityWaiters.set(clusterSessionId, waiters);
		return deferred.promise;
	}
	sessionCiSelection(session: string, principal?: string): { repositoryId: string; ref: string; commit: string } | undefined {
		const resource = this.#sessions.get(session);
		if (!resource || principal !== undefined && !this.#ownsSessionResource(resource, principal)) return undefined;
		return ciSelection(resource);
	}
	sessionCiCorrelations(): SessionCiCorrelation[] {
		return [...this.#sessions.values()].flatMap(resource => {
			const selected = ciSelection(resource);
			return selected ? [{ sessionId: resource.metadata.name, ...selected }] : [];
		});
	}
	setSessionCiState(session: string, value: SessionCiState): void {
		const resource = this.#sessions.get(session);
		const selected = resource ? ciSelection(resource) : undefined;
		if (!selected) return;
		const state = decodeSessionCiState(value, `ci.${session}`);
		if (state.repositoryId !== selected.repositoryId || state.ref !== selected.ref || state.commit !== selected.commit)
			throw new Error("CI provider state does not match the declared session correlation");
		const previous = this.#ciStates.get(session);
		if (previous && JSON.stringify(previous) === JSON.stringify(state)) return;
		this.#ciStates.set(session, state);
		this.#sessionSequence++;
		for (const listener of this.#sessionListeners) listener();
	}

	applyWatch(event: KubernetesWatchEvent): void {
		const resource = event.object;
		const name = resource.metadata.name;
		if (resource.kind === "T4ClusterHost") {
			if (!this.#host || name !== this.#host.metadata.name) return;
			let authorityValid = false;
			try {
				authorityValid = event.type !== "DELETED"
					&& resource.metadata.uid !== undefined
					&& clusterHostIdFromUid(resource.metadata.uid) === this.#hostId;
			} catch { /* An invalid replacement UID invalidates the selected authority too. */ }
			if (!authorityValid) {
				const error = new KubernetesAuthorityInvalidatedError(
					event.type === "DELETED" ? "selected T4ClusterHost was deleted" : "selected T4ClusterHost identity changed",
				);
				this.#invalidateAuthority(error);
				throw error;
			}
		} else if (resource.kind === "T4Workspace" || resource.kind === "T4Session") {
			if (!this.#host) return;
			if (record(resource.spec).hostRef !== this.#host.metadata.name) {
				if (resource.kind === "T4Session") {
					if (!this.#sessions.delete(name)) return;
					this.#authoritativeSessions.delete(name);
					this.#ciStates.delete(name);
					this.#sessionSequence++;
					for (const listener of this.#sessionListeners) listener();
					return;
				}
				const existing = this.#workspaces.get(name);
				if (!existing) return;
				this.#workspaces.delete(name);
				this.#publishWorkspace(existing, true, workspaceOwner(existing));
				this.#sessionSequence++;
				for (const listener of this.#sessionListeners) listener();
				return;
			}
		} else return;
		const key = `${resource.kind}/${name}`;
		const version = text(resource.metadata.resourceVersion);
		if (event.type !== "DELETED" && version && this.#versions.get(key) === version) return;
		if (version) {
			this.#versions.set(key, version);
			this.#resourceVersion = version;
			const collection = resource.kind === "T4ClusterHost" ? "t4clusterhosts" : resource.kind === "T4Workspace" ? "t4workspaces" : "t4sessions";
			this.#resourceVersions = { ...this.#resourceVersions, [collection]: version };
		}
		if (resource.kind === "T4ClusterHost") { this.#host = resource; return; }
		if (resource.kind === "T4Session") {
			if (event.type === "DELETED") {
				if (!this.#sessions.delete(name)) return;
				this.#authoritativeSessions.delete(name);
				this.#ciStates.delete(name);
			} else {
				if (!this.#sessions.has(name) && this.#sessions.size >= this.maxSessions) throw new Error("session projection limit exceeded");
				this.#sessions.set(name, resource);
				const state = this.#ciStates.get(name);
				const selected = ciSelection(resource);
				if (state && (!selected || state.repositoryId !== selected.repositoryId || state.ref !== selected.ref || state.commit !== selected.commit))
					this.#ciStates.delete(name);
			}
			this.#sessionSequence++;
			for (const listener of this.#sessionListeners) listener();
			return;
		}
		const existing = this.#workspaces.get(name);
		let workspaceAccessChanged = false;
		if (event.type === "DELETED") {
			if (!existing) return;
			this.#workspaces.delete(name);
			this.#publishWorkspace(resource, true, workspaceOwner(existing) ?? workspaceOwner(resource));
			workspaceAccessChanged = true;
		} else {
			if (!existing && this.#workspaces.size >= this.maxWorkspaces) throw new Error("workspace projection limit exceeded");
			this.#workspaces.set(name, resource);
			const previousOwner = existing ? workspaceOwner(existing) : undefined;
			const nextOwner = workspaceOwner(resource);
			if (existing && previousOwner !== nextOwner) this.#publishWorkspace(existing, true, previousOwner);
			this.#publishWorkspace(resource, false, nextOwner);
			workspaceAccessChanged = !existing || previousOwner !== nextOwner;
		}
		if (workspaceAccessChanged) {
			this.#sessionSequence++;
			for (const listener of this.#sessionListeners) listener();
		}
	}

	subscribe(listener: (frame: WorkspaceStateFrame) => void, cursor?: Cursor, principal?: string): () => void {
		if (cursor && cursor.epoch === this.epoch && cursor.seq < this.#workspaceSequence)
			for (const item of this.#replay) if (item.frame.cursor.seq > cursor.seq && (principal === undefined || item.owner === principal)) listener(item.frame);
		const subscription: WorkspaceSubscription = { listener, ...(principal === undefined ? {} : { principal }) };
		this.#workspaceListeners.add(subscription);
		return () => { this.#workspaceListeners.delete(subscription); };
	}
	subscribeSessions(listener: SessionListener): () => void {
		this.#sessionListeners.add(listener);
		return () => { this.#sessionListeners.delete(listener); };
	}

	#invalidateAuthority(error: KubernetesAuthorityInvalidatedError): void {
		const workspaces = [...this.#workspaces.values()];
		const sessionStateChanged = workspaces.length > 0 || this.#sessions.size > 0 || this.#authoritativeSessions.size > 0;
		this.#workspaces.clear();
		this.#sessions.clear();
		this.#authoritativeSessions.clear();
		this.#ciStates.clear();
		for (const resource of workspaces) {
			try { this.#publishWorkspace(resource, true, workspaceOwner(resource)); }
			catch { /* A subscriber cannot veto authority invalidation. */ }
		}
		this.#host = undefined;
		this.#hostId = undefined;
		this.#versions.clear();
		this.#resourceVersion = "0";
		this.#resourceVersions = {};
		for (const waiters of this.#authorityWaiters.values()) {
			for (const waiter of waiters) {
				clearTimeout(waiter.timer);
				waiter.reject(error);
			}
		}
		this.#authorityWaiters.clear();
		if (sessionStateChanged) {
			this.#sessionSequence++;
			for (const listener of this.#sessionListeners) {
				try { listener(); }
				catch { /* A subscriber cannot veto authority invalidation. */ }
			}
		}
	}
	#ownsSessionResource(resource: KubernetesResource, principal: string): boolean {
		const workspace = text(record(resource.spec).workspaceRef);
		return workspace.length > 0 && this.ownsWorkspace(workspace, principal);
	}
	#publishWorkspace(resource: KubernetesResource, deleted: boolean, owner?: string): void {
		this.#workspaceSequence++;
		const name = resource.metadata.name;
		const currentRevision = revision(resourceRevision(resource));
		const frame: WorkspaceStateFrame = deleted
			? { v: "omp-app/1", type: "workspace.state", hostId: this.hostId, workspaceId: name, cursor: this.workspaceCursor, revision: currentRevision, remove: name }
			: { v: "omp-app/1", type: "workspace.state", hostId: this.hostId, workspaceId: name, cursor: this.workspaceCursor, revision: currentRevision, upsert: this.#workspace(resource) };
		this.#replay.push({ frame, ...(owner === undefined ? {} : { owner }) });
		if (this.#replay.length > CLUSTER_WORKSPACE_REPLAY_FRAMES) this.#replay.shift();
		for (const subscription of this.#workspaceListeners)
			if (subscription.principal === undefined || subscription.principal === owner) subscription.listener(frame);
	}
	#session(resource: KubernetesResource, authoritative: SessionRef): SessionRef {
		const spec = record(resource.spec);
		const status = record(resource.status);
		const workspaceId = text(spec.workspaceRef, "unknown-workspace");
		const selectedCi = ciSelection(resource);
		const projectedCi = this.#ciStates.get(resource.metadata.name) ?? (selectedCi ? {
			provider: "woodpecker" as const,
			correlation: "unknown" as const,
			...selectedCi,
		} : undefined);
		const condition = firstCondition(status);
		const guiEnabled = spec.guiEnabled === true;
		const infrastructurePhase = categorical(status.phase, ["Pending", "Running", "Failed", "Terminating", "Unknown"] as const, "Unknown");
		const guiState = !guiEnabled
			? "Unavailable"
			: infrastructurePhase === "Running"
				? "Ready"
				: infrastructurePhase === "Failed" || infrastructurePhase === "Terminating"
					? "Failed"
					: "Starting";
		const { cluster: _upstreamCluster, ci: _upstreamCi, ...ompLiveState } = authoritative.liveState ?? {};
		return decodeSessionRef({
			...authoritative,
			hostId: this.hostId,
			sessionId: resource.metadata.name,
			liveState: {
				...ompLiveState,
				cluster: {
					workspaceId,
					phase: infrastructurePhase,
					...(condition ? { condition } : {}),
					gui: { state: guiState },
				},
				...(projectedCi ? { ci: projectedCi } : {}),
			},
		}, `session.${resource.metadata.name}`);
	}
	#workspace(resource: KubernetesResource): WorkspaceInfrastructureProjection {
		const spec = record(resource.spec);
		const status = record(resource.status);
		const condition = firstCondition(status);
		return decodeWorkspaceInfrastructureProjection({
			id: resource.metadata.name,
			displayName: text(spec.displayName, resource.metadata.name).slice(0, 256),
			phase: resource.metadata.deletionTimestamp ? "Terminating" : categorical(status.phase, ["Pending", "Ready", "Failed", "Terminating", "Unknown"] as const, "Unknown"),
			retentionPolicy: spec.retentionPolicy === "Delete" ? "Delete" : "Retain",
			...(typeof record(this.#host?.spec).storageClassName === "string" ? { storageClass: String(record(this.#host?.spec).storageClassName).slice(0, 128) } : {}),
			...(typeof status.capacity === "string" ? { capacity: status.capacity.slice(0, 64) } : typeof spec.size === "string" ? { capacity: spec.size.slice(0, 64) } : {}),
			accessMode: "ReadWriteMany",
			revision: resourceRevision(resource),
			...(condition ? { condition } : {}),
		}, `workspace.${resource.metadata.name}`);
	}
}
