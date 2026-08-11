import { createHash } from "node:crypto";
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
import type { CmuxWebSocketRoute } from "./cmux-websocket.ts";
import type { RequestIdentity } from "./identity.ts";
export const CLUSTER_MAX_WORKSPACES = WIRE_MAX_WORKSPACES;
export const CLUSTER_MAX_SESSIONS = 1_000;
export const CLUSTER_WORKSPACE_REPLAY_FRAMES = 512;
export const REST_SCOPE_ID_ANNOTATION = "cluster.t4.dev/scope-id";

export interface KubernetesMetadata {
	readonly name: string;
	readonly uid?: string;
	readonly resourceVersion?: string;
	readonly generation?: number;
	readonly creationTimestamp?: string;
	readonly finalizers?: readonly string[];
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
export interface CmuxRuntimeBackend {
	readonly namespace: string;
	readonly serviceName: string;
	readonly generationSecretName: string;
	readonly runtimeUid: string;
	readonly generation: string;
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

export interface RestConditionProjection {
	readonly type: string;
	readonly status: "True" | "False" | "Unknown";
	readonly reason: string;
	readonly lastTransitionTime: string;
}
export interface RestWorkspaceProjection {
	readonly id: string;
	readonly displayName: string;
	readonly capacityBytes: number;
	readonly retention: "Retain" | "Delete";
	readonly phase: "Pending" | "Ready" | "Deleting" | "Unavailable" | "Failed";
	readonly attachmentCount: number;
	readonly revision: string;
	readonly conditions: readonly RestConditionProjection[];
	readonly createdAt: string;
	readonly updatedAt: string;
}
export interface RestRuntimeProjection {
	readonly id: string;
	readonly displayName: string;
	readonly workspaceId: string;
	readonly hostProfileId: string;
	readonly desiredState: "Running" | "Sleeping" | "Stopped";
	readonly phase: "Pending" | "Provisioning" | "Starting" | "Ready" | "Sleeping" | "Stopped" | "Deleting" | "Unavailable" | "Degraded" | "Failed";
	readonly generation: string;
	readonly revision: string;
	readonly capabilities: readonly string[];
	readonly conditions: readonly RestConditionProjection[];
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly connectionReady: boolean;
}
export interface RestPrincipalProjection {
	readonly revision: string;
	readonly workspaces: readonly RestWorkspaceProjection[];
	readonly runtimes: readonly RestRuntimeProjection[];
}
export type PortableRuntimeRouteProjection =
	| { readonly outcome: "resolved"; readonly generation: string; readonly reference: string }
	| { readonly outcome: "notFound" | "notReady" | "staleGeneration" | "fenceUncertain" };
export interface PortableRuntimeObservation {
	readonly metadataGeneration?: number;
	readonly observedGeneration?: number;
	readonly desiredState: "Running" | "Sleeping" | "Stopped";
	readonly browserPolicy: "Allowed" | "Disabled";
	readonly phase: RestRuntimeProjection["phase"];
	readonly fenceUncertain: boolean;
	readonly resource?: RestRuntimeProjection;
}



interface SessionAuthorityWaiter { readonly resolve: (value: SessionRef) => void; readonly reject: (reason: Error) => void; readonly timer: ReturnType<typeof setTimeout>; }
function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function sessionBrowserEnabled(spec: Readonly<Record<string, unknown>>): boolean {
	return spec.browserPolicy === "Allowed" || (spec.browserPolicy === undefined && spec.guiEnabled === true);
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
function sessionInfrastructurePhase(value: unknown): "Pending" | "Running" | "Failed" | "Terminating" | "Unknown" {
	switch (value) {
		case "Pending":
		case "Provisioning":
		case "Starting":
			return "Pending";
		case "Ready":
		case "Running":
			return "Running";
		case "Failed":
		case "Unavailable":
		case "Degraded":
			return "Failed";
		case "Deleting":
		case "Terminating":
			return "Terminating";
		default:
			return "Unknown";
	}
}
function resourceRevision(resource: KubernetesResource): string {
	return text(resource.metadata.resourceVersion, `generation-${number(resource.metadata.generation)}`);
}
function serviceName(value: unknown): string | undefined {
	if (typeof value !== "string" || !/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u.test(value)) return undefined;
	return value;
}
export function sessionAttachesToWorkspace(resource: KubernetesResource, workspaceName: string): boolean {
	return record(resource.spec).workspaceRef === workspaceName;
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

const REST_EPOCH = "1970-01-01T00:00:00.000Z";
const REST_CODE = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const REST_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
export const REST_PUBLIC_ID_ANNOTATION = "cluster.t4.dev/public-id";
export const REST_REVISION_ANNOTATION = "cluster.t4.dev/rest-revision";
function opaque(prefix: string, ...values: readonly string[]): string {
	return `${prefix}_${createHash("sha256").update(values.join("\u0000")).digest("base64url").slice(0, 24)}`;
}
function statusConditionTrue(resource: KubernetesResource, type: string): boolean {
	const status = record(resource.status);
	if (!Array.isArray(status.conditions)) return false;
	return status.conditions.some(value => {
		const item = record(value);
		return item.type === type
			&& item.status === "True"
			&& item.observedGeneration === resource.metadata.generation;
	});
}
function statusConditionTrueForGeneration(resource: KubernetesResource, type: string): boolean {
	const generation = resource.metadata.generation;
	const status = record(resource.status);
	if (typeof generation !== "number" || status.observedGeneration !== generation || !Array.isArray(status.conditions)) return false;
	return status.conditions.some(value => {
		const item = record(value);
		return item.type === type && item.status === "True" && item.observedGeneration === generation;
	});
}

function sessionRouteGeneration(resource: KubernetesResource): string | undefined {
	const uid = resource.metadata.uid;
	const status = record(resource.status);
	const service = serviceName(status.serviceName);
	const pod = serviceName(status.podName);
	const generation = runtimeGeneration(resource);
	if (!uid || !service || !pod || !generation || status.phase !== "Ready" || !statusConditionTrue(resource, "RouteReady")) return undefined;
	return opaque("route", uid, generation, service, pod);
}
function runtimeGeneration(resource: KubernetesResource): string | undefined {
	const generation = record(resource.status).runtimeGeneration;
	return typeof generation === "string" && /^gen_[A-Za-z0-9_-]{4,124}$/u.test(generation) ? generation : undefined;
}

export function restResourceId(prefix: "ws" | "rt", resource: KubernetesResource): string {
	const publicId = record(resource.spec).publicId ?? resource.metadata.annotations?.[REST_PUBLIC_ID_ANNOTATION];
	return typeof publicId === "string" && REST_ID.test(publicId) ? publicId : opaque(prefix, resource.metadata.uid ?? resource.metadata.name);
}
export function restResourceRevision(kind: "workspace" | "runtime", resource: KubernetesResource): string {
	const stored = resource.metadata.annotations?.[REST_REVISION_ANNOTATION];
	if (stored && /^[A-Za-z0-9][A-Za-z0-9:._~-]{0,127}$/u.test(stored)) {
		const status = record(resource.status);
		const conditions = Array.isArray(status.conditions) ? status.conditions.slice(0, 16) : [];
		return opaque("rev", kind, stored, String(status.observedGeneration ?? ""), text(status.phase), text(status.runtimeGeneration), text(status.serviceName), text(status.serviceUid, text(status.serviceUID)), JSON.stringify(conditions), resource.metadata.deletionTimestamp ?? "");
	}
	return opaque("rev", kind, resource.metadata.uid ?? resource.metadata.name, resourceRevision(resource));
}
export function portableWorkspaceRevision(revision: string, attachmentCount: number): string {
	return `rev_${createHash("sha256").update(revision).update("\0").update(String(attachmentCount)).digest("base64url").slice(0, 24)}`;
}
function restId(prefix: string, value: string): string {
	return REST_ID.test(value) ? value : opaque(prefix, value);
}
function timestamp(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > 64) return undefined;
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}
function resourceTimestamps(resource: KubernetesResource, conditions: readonly RestConditionProjection[]): { createdAt: string; updatedAt: string } {
	const createdAt = timestamp(resource.metadata.creationTimestamp) ?? REST_EPOCH;
	const updatedAt = conditions.reduce(
		(latest, condition) => condition.lastTransitionTime > latest ? condition.lastTransitionTime : latest,
		createdAt,
	);
	return { createdAt, updatedAt };
}
function restConditions(resource: KubernetesResource): readonly RestConditionProjection[] {
	const values = record(resource.status).conditions;
	if (!Array.isArray(values)) return [];
	const output: RestConditionProjection[] = [];
	for (const value of values.slice(0, 16)) {
		const item = record(value);
		if (!REST_CODE.test(text(item.type)) || !REST_CODE.test(text(item.reason))) continue;
		const lastTransitionTime = timestamp(item.lastTransitionTime) ?? timestamp(resource.metadata.creationTimestamp) ?? REST_EPOCH;
		output.push({
			type: text(item.type),
			status: categorical(item.status, ["True", "False", "Unknown"] as const, "Unknown"),
			reason: text(item.reason),
			lastTransitionTime,
		});
	}
	return Object.freeze(output);
}
function quantityBytes(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isSafeInteger(value) && value >= 1_048_576 && value <= 1_125_899_906_842_624 ? value : undefined;
	if (typeof value !== "string") return undefined;
	const match = /^(0|[1-9][0-9]*)(Ki|Mi|Gi|Ti|K|M|G|T)?$/u.exec(value);
	if (!match) return undefined;
	const multipliers: Readonly<Record<string, number>> = {
		"": 1, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4,
		K: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4,
	};
	const result = Number(match[1]) * multipliers[match[2] ?? ""]!;
	return Number.isSafeInteger(result) && result >= 1_048_576 && result <= 1_125_899_906_842_624 ? result : undefined;
}
function workspaceRestPhase(resource: KubernetesResource): RestWorkspaceProjection["phase"] {
	if (resource.metadata.deletionTimestamp) return "Deleting";
	switch (record(resource.status).phase) {
		case "Ready": return "Ready";
		case "Pending": return "Pending";
		case "Failed": return "Failed";
		case "Terminating": return "Deleting";
		default: return "Unavailable";
	}
}
function workspaceCmuxPrincipal(resource: KubernetesResource | undefined): string | undefined {
	if (!resource || workspaceRestPhase(resource) !== "Ready") return undefined;
	const spec = record(resource.spec);
	if (quantityBytes(record(resource.status).capacity ?? spec.size) === undefined) return undefined;
	return workspaceOwner(resource);
}
function runtimeRestPhase(resource: KubernetesResource, connectionReady: boolean): RestRuntimeProjection["phase"] {
	if (resource.metadata.deletionTimestamp) return "Deleting";
	const desiredState = categorical(record(resource.spec).desiredState, ["Running", "Sleeping", "Stopped"] as const, "Running");
	switch (record(resource.status).phase) {
		case "Ready":
		case "Running": return connectionReady ? "Ready" : "Starting";
		case "Provisioning": return "Provisioning";
		case "Starting": return "Starting";
		case "Sleeping": return "Sleeping";
		case "Stopped": return "Stopped";
		case "Pending": return desiredState === "Running" ? "Provisioning" : "Pending";
		case "Deleting":
		case "Terminating": return "Deleting";
		case "Unavailable": return "Unavailable";
		case "Degraded": return "Degraded";
		case "Failed": return "Failed";
		default: return "Unavailable";
	}
}

export function clusterHostIdFromUid(uid: string): HostId {
	if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u.test(uid)) throw new Error("T4ClusterHost UID is invalid");
	return hostId(`cluster:${uid}`);
}

interface SessionAuthorityBinding {
	readonly routeGeneration: string;
	readonly ref: SessionRef;
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
	#authoritativeSessions = new Map<string, SessionAuthorityBinding>();
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
		for (const [name, binding] of this.#authoritativeSessions) {
			const selected = nextSessions.get(name);
			if (!selected || sessionRouteGeneration(selected) !== binding.routeGeneration)
				this.#authoritativeSessions.delete(name);
		}
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
			const routeEligibilityChanged = workspaceCmuxPrincipal(before) !== workspaceCmuxPrincipal(after);
			if (before && after && resourceRevision(before) === resourceRevision(after) && !routeEligibilityChanged) continue;
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
			workspaceAccessChanged ||= routeEligibilityChanged;
		}
		const sessionNames = new Set([...previousSessions.keys(), ...nextSessions.keys()]);
		const sessionsChanged = [...sessionNames].some(name => {
			const before = previousSessions.get(name);
			const after = nextSessions.get(name);
			return !before
				|| !after
				|| resourceRevision(before) !== resourceRevision(after)
				|| sessionRouteGeneration(before) !== sessionRouteGeneration(after);
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
				return authoritative ? [this.#session(resource, authoritative.ref)] : [];
			});
	}

	restPrincipals(): readonly string[] {
		return [...new Set([...this.#workspaces.values()].flatMap(resource => {
			const owner = workspaceOwner(resource);
			return owner ? [owner] : [];
		}))].sort();
	}

	restProjection(principal: string, identity?: RequestIdentity): RestPrincipalProjection {
		if (identity && identity.principalId !== principal) throw new Error("request identity binding is invalid");
		const workspaceResources = [...this.#workspaces.values()]
			.filter(resource => workspaceOwner(resource) === principal)
			.sort((left, right) => left.metadata.name.localeCompare(right.metadata.name));
		const workspaceCapacities = new Map(workspaceResources.flatMap(resource => {
			const spec = record(resource.spec);
			const capacity = quantityBytes(record(resource.status).capacity ?? spec.size);
			return capacity === undefined ? [] : [[resource.metadata.name, capacity] as const];
		}));
		const workspaceIds = new Map(workspaceResources.flatMap(resource => {
			const capacity = workspaceCapacities.get(resource.metadata.name);
			return capacity === undefined ? [] : [[
				resource.metadata.name,
				restResourceId("ws", resource),
			] as const];
		}));
		const runtimeResources = [...this.#sessions.values()]
			.filter(resource => this.#ownsSessionResource(resource, principal))
			.sort((left, right) => left.metadata.name.localeCompare(right.metadata.name));
		const attachmentCounts = new Map<string, number>();
		for (const workspaceResource of workspaceResources) {
			const count = runtimeResources.filter(resource =>
				sessionAttachesToWorkspace(resource, workspaceResource.metadata.name)
			).length;
			attachmentCounts.set(workspaceResource.metadata.name, count);
		}
		const workspaces = workspaceResources.flatMap(resource => {
			const capacityBytes = workspaceCapacities.get(resource.metadata.name);
			if (capacityBytes === undefined) return [];
			const spec = record(resource.spec);
			const conditions = restConditions(resource);
			const times = resourceTimestamps(resource, conditions);
			const attachmentCount = attachmentCounts.get(resource.metadata.name) ?? 0;
			return [Object.freeze({
				id: workspaceIds.get(resource.metadata.name)!,
				displayName: text(spec.displayName, "Workspace").slice(0, 128) || "Workspace",
				capacityBytes,
				retention: spec.retentionPolicy === "Delete" ? "Delete" as const : "Retain" as const,
				phase: workspaceRestPhase(resource),
				attachmentCount,
				revision: restResourceRevision("workspace", resource),
				conditions,
				...times,
			})];
		});
		const runtimes = runtimeResources.flatMap(resource => {
			const spec = record(resource.spec);
			const workspaceId = workspaceIds.get(text(spec.workspaceRef));
			if (!workspaceId) return [];
			const conditions = restConditions(resource);
			const times = resourceTimestamps(resource, conditions);
			const route = this.sessionRoute(resource.metadata.name, principal);
			const connectionReady = route !== undefined && record(resource.status).phase === "Ready";
			const generation = runtimeGeneration(resource);
			if (!generation) return [];
			const profile = text(spec.publicHostProfileId, text(spec.runtimeProfile, "default"));
			return [Object.freeze({
				id: restResourceId("rt", resource),
				displayName: text(spec.title, "Runtime").slice(0, 128) || "Runtime",
				workspaceId,
				hostProfileId: restId("profile", profile),
				desiredState: categorical(spec.desiredState, ["Running", "Sleeping", "Stopped"] as const, "Running"),
				phase: runtimeRestPhase(resource, connectionReady),
				generation,
				revision: restResourceRevision("runtime", resource),
				capabilities: Object.freeze(connectionReady ? ["omp-app"] : []),
				conditions,
				...times,
				connectionReady,
			})];
		});
		return Object.freeze({
			revision: opaque("rev", "scope", principal, ...workspaces.map(workspace => workspace.revision), ...runtimes.map(runtime => runtime.revision)),
			workspaces: Object.freeze(workspaces),
			runtimes: Object.freeze(runtimes),
		});
	}
	portableRuntimeRoute(principal: string, runtimeId: string, kind: "cmux-v10" | "omp-app-v1", generation: string): PortableRuntimeRouteProjection {
		const candidates = [...this.#sessions.values()].filter(resource =>
			this.#ownsSessionResource(resource, principal) && restResourceId("rt", resource) === runtimeId
		);
		if (candidates.length !== 1) return { outcome: "notFound" };
		const resource = candidates[0]!;
		const currentGeneration = runtimeGeneration(resource);
		if (!currentGeneration || generation !== currentGeneration) return { outcome: "staleGeneration" };
		const status = record(resource.status);
		const fenceUncertain = status.fenceState === "FenceUncertain"
			|| (Array.isArray(status.conditions) && status.conditions.some(value => {
				const item = record(value);
				return item.type === "Fenced" && item.status === "False" && item.reason === "FenceUncertain";
			}));
		if (fenceUncertain) return { outcome: "fenceUncertain" };
		const service = serviceName(status.serviceName);
		if (
			status.phase !== "Ready"
			|| record(resource.spec).desiredState !== "Running"
			|| !statusConditionTrueForGeneration(resource, "RouteReady")
			|| !service
			|| !resource.metadata.uid
		) return { outcome: "notReady" };
		const serviceIdentity = text(status.serviceUid, text(status.serviceUID));
		if (!serviceIdentity) return { outcome: "notReady" };
		return {
			outcome: "resolved",
			generation: currentGeneration,
			reference: opaque("route", kind, resource.metadata.uid, currentGeneration, service, serviceIdentity),
		};
	}
	portableResourceUid(principal: string, kind: "workspace" | "runtime", publicId: string): string | undefined {
		const candidates = kind === "workspace"
			? [...this.#workspaces.values()].filter(resource => workspaceOwner(resource) === principal && restResourceId("ws", resource) === publicId)
			: [...this.#sessions.values()].filter(resource => this.#ownsSessionResource(resource, principal) && restResourceId("rt", resource) === publicId);
		return candidates.length === 1 ? candidates[0]!.metadata.uid : undefined;
	}
	portableRuntimeObservation(principal: string, runtimeId: string): PortableRuntimeObservation | undefined {
		const candidates = [...this.#sessions.values()].filter(resource =>
			this.#ownsSessionResource(resource, principal) && restResourceId("rt", resource) === runtimeId
		);
		if (candidates.length !== 1) return undefined;
		const resource = candidates[0]!;
		const status = record(resource.status);
		const desiredState = categorical(record(resource.spec).desiredState, ["Running", "Sleeping", "Stopped"] as const, "Running");
		const browserPolicy = sessionBrowserEnabled(record(resource.spec)) ? "Allowed" : "Disabled";
		const fenceUncertain = status.fenceState === "FenceUncertain"
			|| (Array.isArray(status.conditions) && status.conditions.some(value => {
				const item = record(value);
				return item.type === "Fenced" && item.status === "False" && item.reason === "FenceUncertain";
			}));
		const projected = this.restProjection(principal).runtimes.filter(value => value.id === runtimeId);
		return {
			...(resource.metadata.generation === undefined ? {} : { metadataGeneration: resource.metadata.generation }),
			...(typeof status.observedGeneration === "number" ? { observedGeneration: status.observedGeneration } : {}),
			desiredState,
			browserPolicy,
			phase: runtimeRestPhase(resource, statusConditionTrue(resource, "RouteReady")),
			fenceUncertain,
			...(projected.length === 1 ? { resource: projected[0] } : {}),
		};
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
	cmuxWebSocketRoute(runtimeId: string, principal: string, identity?: RequestIdentity): CmuxWebSocketRoute | undefined {
		if (identity && identity.principalId !== principal) return undefined;
		let resource: KubernetesResource | undefined;
		for (const candidate of this.#sessions.values()) {
			if (!this.#ownsSessionResource(candidate, principal) || restResourceId("rt", candidate) !== runtimeId) continue;
			if (resource) return undefined;
			resource = candidate;
		}
		if (!resource || record(resource.status).phase !== "Ready" || !statusConditionTrue(resource, "RouteReady")) return undefined;
		const workspace = this.#workspaces.get(text(record(resource.spec).workspaceRef));
		if (workspaceCmuxPrincipal(workspace) !== principal) return undefined;
		const route = this.sessionRoute(resource.metadata.name, principal);
		const authority = this.#authoritativeSessions.get(resource.metadata.name);
		const generation = runtimeGeneration(resource);
		if (!route || !authority || !generation) return undefined;
		return {
			principal,
			runtimeId,
			generation,
			routeGeneration: route.routeGeneration,
		};
	}
	cmuxRuntimeBackend(route: CmuxWebSocketRoute): CmuxRuntimeBackend | undefined {
		const projected = this.cmuxWebSocketRoute(route.runtimeId, route.principal);
		if (
			!projected ||
			projected.generation !== route.generation ||
			projected.routeGeneration !== route.routeGeneration
		) return undefined;
		let resource: KubernetesResource | undefined;
		for (const candidate of this.#sessions.values()) {
			if (!this.#ownsSessionResource(candidate, route.principal) || restResourceId("rt", candidate) !== route.runtimeId) continue;
			if (resource) return undefined;
			resource = candidate;
		}
		const status = record(resource?.status);
		const serviceName = text(status.serviceName);
		const generationSecretName = text(status.generationSecretName);
		const runtimeUid = resource?.metadata.uid;
		if (!serviceName || !generationSecretName || !runtimeUid) return undefined;
		return { namespace: this.namespace, serviceName, generationSecretName, runtimeUid, generation: route.generation };
	}
	cmuxRuntimeIngressIdentity(runtimeId: string, principal: string, identity?: RequestIdentity): Readonly<{ runtimeId: string; generation: string }> | undefined {
		if (identity && identity.principalId !== principal) return undefined;
		let resource: KubernetesResource | undefined;
		for (const candidate of this.#sessions.values()) {
			if (!this.#ownsSessionResource(candidate, principal) || restResourceId("rt", candidate) !== runtimeId) continue;
			if (resource) return undefined;
			resource = candidate;
		}
		const generation = resource ? runtimeGeneration(resource) : undefined;
		return resource && generation ? { runtimeId: resource.metadata.name, generation } : undefined;
	}

	sessionExists(session: string): boolean {
		return this.#sessions.has(session);
	}
	sessionGuiState(session: string, principal?: string): "Unavailable" | "Starting" | "Ready" | "Failed" | undefined {
		const resource = this.#sessions.get(session);
		if (!resource || principal !== undefined && !this.#ownsSessionResource(resource, principal)) return undefined;
		if (!sessionBrowserEnabled(record(resource.spec))) return "Unavailable";
		const phase = record(resource.status).phase;
		if (phase === "Ready") return "Ready";
		if (phase === "Failed" || phase === "Terminating") return "Failed";
		return "Starting";
	}
	sessionEndpoints(): PodHostEndpoint[] {
		return [...this.#sessions.values()].flatMap(resource => {
			const routeGeneration = sessionRouteGeneration(resource);
			const generation = runtimeGeneration(resource);
			const service = serviceName(record(resource.status).serviceName);
			return routeGeneration && generation && service ? [{
				clusterSessionId: resource.metadata.name,
				routeGeneration,
				runtimeGeneration: generation,
				url: `ws://${service}.${this.namespace}.svc:8787/v1/ws`,
			}] : [];
		});
	}
	sessionRoute(clusterSessionId: string, principal?: string): PodHostRoute | undefined {
		const resource = this.#sessions.get(clusterSessionId);
		const authoritative = this.#authoritativeSessions.get(clusterSessionId);
		if (!resource || !authoritative || principal !== undefined && !this.#ownsSessionResource(resource, principal)) return undefined;
		const routeGeneration = sessionRouteGeneration(resource);
		const generation = runtimeGeneration(resource);
		const service = serviceName(record(resource.status).serviceName);
		if (!routeGeneration || !generation || authoritative.routeGeneration !== routeGeneration || !service) return undefined;
		return {
			clusterSessionId,
			routeGeneration,
			runtimeGeneration: generation,
			upstreamSessionId: authoritative.ref.sessionId,
			url: `ws://${service}.${this.namespace}.svc:8787/v1/ws`,
		};
	}
	sessionRevision(session: string, principal?: string): string | undefined {
		const resource = this.#sessions.get(session);
		const authoritative = this.#authoritativeSessions.get(session);
		if (!resource || !authoritative || principal !== undefined && !this.#ownsSessionResource(resource, principal)) return undefined;
		if (sessionRouteGeneration(resource) !== authoritative.routeGeneration) return undefined;
		return authoritative.ref.revision;
	}
	sessionRef(session: string, principal?: string): SessionRef | undefined {
		const resource = this.#sessions.get(session);
		const authoritative = this.#authoritativeSessions.get(session);
		if (!resource || !authoritative || principal !== undefined && !this.#ownsSessionResource(resource, principal)) return undefined;
		if (sessionRouteGeneration(resource) !== authoritative.routeGeneration) return undefined;
		return this.#session(resource, authoritative.ref);
	}
	setSessionAuthority(clusterSessionId: string, value: SessionRef, expectedRouteGeneration?: string): boolean {
		const resource = this.#sessions.get(clusterSessionId);
		const routeGeneration = resource ? sessionRouteGeneration(resource) : undefined;
		if (!resource || !routeGeneration || expectedRouteGeneration !== undefined && expectedRouteGeneration !== routeGeneration) return false;
		const authoritative = decodeSessionRef(value, `authority.${clusterSessionId}`);
		const previous = this.#authoritativeSessions.get(clusterSessionId);
		if (previous?.routeGeneration === routeGeneration && JSON.stringify(previous.ref) === JSON.stringify(authoritative)) return true;
		const projected = this.#session(resource, authoritative);
		this.#authoritativeSessions.set(clusterSessionId, { routeGeneration, ref: authoritative });
		this.#sessionSequence++;
		for (const waiter of this.#authorityWaiters.get(clusterSessionId) ?? []) {
			clearTimeout(waiter.timer);
			waiter.resolve(projected);
		}
		this.#authorityWaiters.delete(clusterSessionId);
		for (const listener of this.#sessionListeners) listener();
		return true;
	}
	clearSessionAuthority(clusterSessionId: string, expectedRouteGeneration?: string, expectedUpstreamSessionId?: string): boolean {
		const authoritative = this.#authoritativeSessions.get(clusterSessionId);
		if (!authoritative
			|| expectedRouteGeneration !== undefined && authoritative.routeGeneration !== expectedRouteGeneration
			|| expectedUpstreamSessionId !== undefined && authoritative.ref.sessionId !== expectedUpstreamSessionId) return false;
		this.#authoritativeSessions.delete(clusterSessionId);
		this.#sessionSequence++;
		for (const listener of this.#sessionListeners) listener();
		return true;
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
		const existingSession = resource.kind === "T4Session" ? this.#sessions.get(name) : undefined;
		const routeChanged = existingSession !== undefined
			&& sessionRouteGeneration(existingSession) !== sessionRouteGeneration(resource);
		if (event.type !== "DELETED" && version && this.#versions.get(key) === version && !routeChanged) return;
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
				if (routeChanged) this.#authoritativeSessions.delete(name);
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
		const beforeEligibility = workspaceCmuxPrincipal(existing);
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
		workspaceAccessChanged ||= beforeEligibility !== workspaceCmuxPrincipal(this.#workspaces.get(name));
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
		const guiEnabled = sessionBrowserEnabled(spec);
		const infrastructurePhase = sessionInfrastructurePhase(status.phase);
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
