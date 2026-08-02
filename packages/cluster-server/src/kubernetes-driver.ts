import { createHash, randomBytes } from "node:crypto";
import type {
	Capabilities,
	ScopeAdmissionPolicy,
	Condition,
	DesiredState,
	Generation,
	Page,
	Phase,
	Revision,
	Runtime,
	RuntimeCreate,
	RuntimeId,
	RuntimePatch,
	Scope,
	ScopeId,
	Workspace,
	WorkspaceCreate,
	WorkspaceId,
	WorkspacePatch,
} from "@t4-code/portable-core";
import type {
	InfrastructureEvent,
	ScopeAdmissionOutcome,
	SharedPortableControlLedger,
	SharedIssuedIdentifier,
} from "@t4-code/portable-control-store";
import type {
	CreateOutcome,
	DeleteOutcome,
	DriverResourcePage,
	EventReadOutcome,
	LookupOutcome,
	MutationOutcome,
	ResourceDriver,
	RouteKind,
	RouteOutcome,
} from "@t4-code/portable-driver";
import {
	KubernetesGatewayMutationBackend,
	RestMutationError,
	semanticResourceHash,
	type KubernetesResourceApi,
} from "./kubernetes-client.ts";
import {
	ClusterInfrastructureProjection,
	type RestPrincipalProjection,
	type RestRuntimeProjection,
	type RestWorkspaceProjection,
	portableWorkspaceRevision,
	type KubernetesResource,
} from "./kubernetes-projection.ts";

const ROUTE_KINDS: readonly RouteKind[] = ["cmux-v10", "omp-app-v1"];
const MAX_WATCHES = 64;
const MAX_EVENT_BATCH = 200;
const PAGE_CURSOR = /^kp1\.([A-Za-z0-9_-]{16})\.([0-9a-z]+)$/u;

export interface KubernetesDriverScope extends Pick<Scope, "id" | "displayName" | "kind"> {
	/** Internal owner principal. It is never included in a portable resource or route descriptor. */
	readonly principal: string;
}

export type KubernetesDriverControlStore = Pick<SharedPortableControlLedger, "appendEvent" | "readAfter" | "subscribe" | "eventHeadCursor" | "reserveIssuedIdentifier" | "bindIssuedIdentifier" | "beginIssuedIdentifierDeletion" | "markIssuedIdentifierDeleted" | "getIssuedIdentifier" | "reserveAdmission" | "commitAdmission" | "releaseAdmission" | "reconcileAdmissionAbsence"> & {
	readonly cancelIssuedIdentifierDeletion: (request: Pick<SharedIssuedIdentifier, "resourceKind" | "resourceId" | "incarnationUid"> & { readonly expectedRevision: string; readonly backendRevision: string }) => { readonly outcome: "cancelled" | "alreadyClear" | "conflict" | "notFound" } | Promise<{ readonly outcome: "cancelled" | "alreadyClear" | "conflict" | "notFound" }>;
	readonly claimIssuedIdentifierCreation: (request: Pick<SharedIssuedIdentifier, "resourceKind" | "resourceId" | "bindingDigest"> & { readonly ownerToken: string; readonly now: number; readonly leaseExpiresAt: number }) => { readonly outcome: "claimed" | "takenOver" | "owned" | "inProgress" | "conflict" | "notFound"; readonly record?: SharedIssuedIdentifier } | Promise<{ readonly outcome: "claimed" | "takenOver" | "owned" | "inProgress" | "conflict" | "notFound"; readonly record?: SharedIssuedIdentifier }>;
};
export interface KubernetesDriverOptions {
	readonly api: KubernetesResourceApi;
	readonly projection: ClusterInfrastructureProjection;
	readonly controlStore: KubernetesDriverControlStore;
	/** Per-scope replay cursors captured no later than the projection snapshot used to construct the driver. */
	readonly initialEventCursors: Readonly<Record<string, string>>;
	readonly hostRef: string;
	readonly scopes: readonly KubernetesDriverScope[];
	readonly capabilities: Capabilities;
	readonly admissionPolicy: ScopeAdmissionPolicy;
	readonly now?: () => number;
	readonly random?: (bytes: number) => Uint8Array;
	readonly watchPollMilliseconds?: number;
	readonly projectionTimeoutMilliseconds?: number;
}
export type KubernetesDriverFactoryOptions = Omit<KubernetesDriverOptions, "initialEventCursors">;

type ScopeBinding = KubernetesDriverScope;
interface LocatedRuntime { readonly scope: ScopeBinding; readonly resource: Runtime; }
type RuntimeTransitionResult =
	| { readonly outcome: "terminal"; readonly resource: Runtime }
	| { readonly outcome: "fenceUncertain"; readonly resource: Runtime }
	| { readonly outcome: "failed"; readonly resource?: Runtime };

function opaque(prefix: string, random: (bytes: number) => Uint8Array): string {
	return `${prefix}_${Buffer.from(random(18)).toString("base64url")}`;
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function fenceUncertain(runtime: Runtime): boolean {
	return runtime.conditions.some((condition: Condition) => condition.type === "Fenced" && condition.status === "False" && condition.reason === "FenceUncertain");
}
function syntheticIdentity(principal: string) {
	return Object.freeze({
		principalId: principal,
		authorizedScopes: Object.freeze([]),
		adapter: Object.freeze({ id: "kubernetes-driver", type: "mtls" as const }),
		policyRevision: "kubernetes-driver-v1",
	});
}
function workspace(scopeId: ScopeId, value: RestWorkspaceProjection): Workspace {
	const revision = portableWorkspaceRevision(value.revision, value.attachmentCount);
	return Object.freeze({ ...value, scopeId, revision, conditions: Object.freeze(value.conditions.map(item => Object.freeze({ ...item }))) });
}
function runtime(scopeId: ScopeId, value: RestRuntimeProjection): Runtime {
	const { connectionReady: _connectionReady, ...portable } = value;
	return Object.freeze({ ...portable, scopeId, conditions: Object.freeze(value.conditions.map(item => Object.freeze({ ...item }))) });
}
function isTransitioning(phase: Phase): boolean {
	return phase === "Pending" || phase === "Provisioning" || phase === "Starting" || phase === "Unavailable";
}

export class KubernetesDriverClosedError extends Error {
	constructor() { super("Kubernetes driver is closed"); this.name = "KubernetesDriverClosedError"; }
}
export async function createKubernetesDriver(options: KubernetesDriverFactoryOptions): Promise<KubernetesDriver> {
	const entries = await Promise.all(options.scopes.map(async scope => [scope.id, await options.controlStore.eventHeadCursor(scope.id)] as const));
	return new KubernetesDriver({ ...options, initialEventCursors: Object.fromEntries(entries) });
}


export class KubernetesDriver implements ResourceDriver {
	readonly #projection: ClusterInfrastructureProjection;
	readonly #backend: KubernetesGatewayMutationBackend;
	readonly #store: KubernetesDriverControlStore;
	readonly #scopes: readonly ScopeBinding[];
	readonly #creationOwnerPrefix: string;
	readonly #activeCreates = new Set<string>();
	readonly #scopeById: ReadonlyMap<ScopeId, ScopeBinding>;
	readonly #capabilities: Capabilities;
	readonly #admissionPolicy: ScopeAdmissionPolicy;
	readonly #now: () => number;
	readonly #random: (bytes: number) => Uint8Array;
	readonly #watchPoll: number;
	readonly #projectionTimeout: number;
	readonly #eventCursors = new Map<ScopeId, string>();
	readonly #watchControllers = new Set<AbortController>();
	readonly #projectionWaiters = new Set<() => void>();
	#previous = new Map<ScopeId, RestPrincipalProjection>();
	#eventTail: Promise<void> = Promise.resolve();
	#unsubscribeWorkspaces: (() => void) | undefined;
	#unsubscribeRuntimes: (() => void) | undefined;
	#closed = false;
	#closePromise: Promise<void> | undefined;

	constructor(options: KubernetesDriverOptions) {
		if (!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u.test(options.hostRef)) throw new TypeError("hostRef is invalid");
		if (options.scopes.length === 0 || options.scopes.length > 64) throw new TypeError("Kubernetes driver scopes are invalid");
		const ids = new Set<string>();
		const principals = new Set<string>();
		this.#scopes = Object.freeze(options.scopes.map(value => {
			if (!value.id || ids.has(value.id) || !value.principal || principals.has(value.principal) || /\p{Cc}/u.test(value.principal)) throw new TypeError("Kubernetes driver scope binding is invalid");
			ids.add(value.id); principals.add(value.principal);
			return Object.freeze({ ...value });
		}));
		this.#scopeById = new Map(this.#scopes.map(value => [value.id, value]));
		this.#projection = options.projection;
		this.#backend = new KubernetesGatewayMutationBackend({ client: options.api, hostRef: options.hostRef });
		this.#store = options.controlStore;
		this.#capabilities = options.capabilities;
		this.#admissionPolicy = options.admissionPolicy;
		this.#now = options.now ?? Date.now;
		this.#random = options.random ?? randomBytes;
		this.#creationOwnerPrefix = opaque("co", this.#random);
		this.#watchPoll = options.watchPollMilliseconds ?? 100;
		if (!Number.isSafeInteger(this.#watchPoll) || this.#watchPoll < 1 || this.#watchPoll > 60_000) throw new TypeError("watch poll interval is invalid");
		this.#projectionTimeout = options.projectionTimeoutMilliseconds ?? 15_000;
		if (!Number.isSafeInteger(this.#projectionTimeout) || this.#projectionTimeout < 100 || this.#projectionTimeout > 60_000) throw new TypeError("projection timeout is invalid");
		for (const scope of this.#scopes) {
			const cursor = options.initialEventCursors[scope.id];
			if (typeof cursor !== "string" || cursor.length === 0) throw new TypeError(`initial event cursor is missing for scope ${scope.id}`);
			this.#eventCursors.set(scope.id, cursor);
			this.#previous.set(scope.id, this.#snapshot(scope));
		}
		const synchronize = (): void => { this.#queueEventSynchronization(); };
		this.#unsubscribeWorkspaces = this.#projection.subscribe(synchronize);
		this.#unsubscribeRuntimes = this.#projection.subscribeSessions(synchronize);
	}

	getCapabilities(): Capabilities { return this.#capabilities; }
	getScope(id: ScopeId): LookupOutcome<Scope> {
		const binding = this.#scopeById.get(id);
		if (!binding) return { outcome: "notFound" };
		const revision = this.#projection.restProjection(binding.principal).revision;
		return { outcome: "found", resource: Object.freeze({ id: binding.id, displayName: binding.displayName, kind: binding.kind, revision }) };
	}
	listScopes(): Page<Scope> {
		const items = this.#scopes.map(binding => {
			const revision = this.#projection.restProjection(binding.principal).revision;
			return Object.freeze({ id: binding.id, displayName: binding.displayName, kind: binding.kind, revision });
		});
		return { items: Object.freeze(items) };
	}

	async createWorkspace(request: WorkspaceCreate & { readonly id?: WorkspaceId }): Promise<CreateOutcome<Workspace>> {
		this.#assertOpen();
		const scope = this.#scopeById.get(request.scopeId);
		if (!scope) return { outcome: "notFound", resourceKind: "scope" };
		const id = request.id ?? opaque("ws", this.#random);
		const bindingDigest = semanticResourceHash({ scopeId: scope.id, request });
		let previouslyIssued: SharedIssuedIdentifier | undefined;
		try { previouslyIssued = await this.#store.getIssuedIdentifier("workspace", id); }
		catch { return { outcome: "invalidState", reason: "KubernetesControlStoreUnavailable" }; }
		const recoveringUnbound = previouslyIssued !== undefined && previouslyIssued.scopeId === scope.id && previouslyIssued.bindingDigest === bindingDigest && previouslyIssued.incarnationUid === undefined && previouslyIssued.deletedAt === undefined;
		if (this.#locateWorkspace(id) && !recoveringUnbound) return { outcome: "alreadyIssued" };
		const createKey = `workspace\0${id}`;
		if (this.#activeCreates.has(createKey)) return { outcome: "alreadyIssued" };
		const admission = await this.#reserveAdmission(scope, "workspace", id, request);
		if (admission.outcome === "denied") return { outcome: "admissionDenied", reason: admission.reason, ...(admission.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: admission.retryAfterSeconds }) };
		const admissionToken = admission.reservationToken;
		this.#activeCreates.add(createKey);
		let backendInvoked = false;
		try {
			const reserved = await this.#store.reserveIssuedIdentifier({ scopeId: scope.id, resourceKind: "workspace", resourceId: id, bindingDigest });
			if (reserved.outcome === "conflict" || reserved.record.deletedAt !== undefined) {
				await this.#store.releaseAdmission(admissionToken);
				return { outcome: "alreadyIssued" };
			}
			const ownership = await this.#claimCreation("workspace", id, bindingDigest);
			if (ownership.outcome === "duplicate") {
				await this.#store.releaseAdmission(admissionToken);
				return { outcome: "alreadyIssued" };
			}
			backendInvoked = true;
			const result = await this.#backend.putRestWorkspace(id, request, scope.principal, syntheticIdentity(scope.principal));
			if (!result.created && ownership.outcome !== "recovery") {
				await this.#store.releaseAdmission(admissionToken);
				return { outcome: "alreadyIssued" };
			}
			if (await this.#store.commitAdmission(admissionToken) !== "committed") return { outcome: "invalidState", reason: "KubernetesAdmissionCommitUnavailable" };
			const incarnationUid = result.resource.metadata.uid;
			if (!incarnationUid) return { outcome: "invalidState", reason: "KubernetesIncarnationUidUnavailable" };
			const bound = await this.#store.bindIssuedIdentifier({ scopeId: scope.id, resourceKind: "workspace", resourceId: id, bindingDigest, incarnationUid, creationOwnerToken: ownership.ownerToken });
			if (bound.outcome === "conflict") return { outcome: "alreadyIssued" };
			this.#projection.applyWatch({ type: result.created ? "ADDED" : "MODIFIED", object: result.resource });
			await this.#eventTail;
			const selected = this.#workspaceFor(scope, id);
			return selected ? { outcome: "created", resource: selected } : { outcome: "invalidState", reason: "KubernetesProjectionRejectedWorkspace" };
		} catch (error) {
			if (!backendInvoked || error instanceof RestMutationError) await this.#store.releaseAdmission(admissionToken);
			else await this.#store.commitAdmission(admissionToken);
			return this.#createFailure(error);
		} finally { this.#activeCreates.delete(createKey); }
	}
	getWorkspace(id: WorkspaceId): LookupOutcome<Workspace> {
		const selected = this.#locateWorkspace(id);
		return selected ? { outcome: "found", resource: selected } : { outcome: "notFound" };
	}
	listWorkspaces(scopeId: ScopeId, pageCursor?: string): DriverResourcePage<Workspace> {
		const scope = this.#scopeById.get(scopeId);
		const values = scope ? this.#snapshot(scope).workspaces.map(value => workspace(scope.id, value)) : [];
		return this.#page(scopeId, values, pageCursor);
	}
	async updateWorkspace(id: WorkspaceId, patch: WorkspacePatch, expectedRevision: Revision): Promise<MutationOutcome<Workspace>> {
		this.#assertOpen();
		const located = this.#locateWorkspaceWithScope(id);
		if (!located) return { outcome: "notFound" };
		if (located.resource.revision !== expectedRevision) return { outcome: "revisionMismatch", currentRevision: located.resource.revision };
		if (located.resource.phase === "Deleting") return { outcome: "invalidState", reason: "WorkspaceDeleting" };
		if (located.resource.phase === "Provisioning") return { outcome: "invalidState", reason: "WorkspaceTransitionInProgress" };
		try {
			const result = await this.#backend.patchRestWorkspace(id, this.#rawWorkspaceRevision(located.scope, id), patch, located.scope.principal, syntheticIdentity(located.scope.principal));
			this.#projection.applyWatch({ type: "MODIFIED", object: result.resource });
			await this.#eventTail;
			const selected = this.#workspaceFor(located.scope, id);
			return selected ? { outcome: "updated", resource: selected } : { outcome: "invalidState", reason: "KubernetesProjectionRejectedWorkspace" };
		} catch (error) { return this.#mutationFailure(error); }
	}
	async deleteWorkspace(id: WorkspaceId, expectedRevision: Revision): Promise<DeleteOutcome> {
		this.#assertOpen();
		const located = this.#locateWorkspaceWithScope(id);
		if (!located) return await this.#missingDeleteOutcome("workspace", id, expectedRevision);
		if (located.resource.revision !== expectedRevision) return { outcome: "revisionMismatch", currentRevision: located.resource.revision };
		if (located.resource.phase === "Provisioning") return { outcome: "invalidState", reason: "WorkspaceTransitionInProgress" };
		if (located.resource.attachmentCount !== 0) return { outcome: "invalidState", reason: "WorkspaceAttached" };
		const uid = this.#projection.portableResourceUid(located.scope.principal, "workspace", id);
		if (!uid) return { outcome: "invalidState", reason: "KubernetesIncarnationUidUnavailable" };
		let issued: SharedIssuedIdentifier | undefined;
		try { issued = await this.#claimExistingIdentifier(located.scope, "workspace", id, uid); }
		catch { return { outcome: "invalidState", reason: "KubernetesControlStoreUnavailable" }; }
		if (!issued || (issued.incarnationUid !== undefined && issued.incarnationUid !== uid)) return { outcome: "invalidState", reason: "KubernetesIdentifierBindingConflict" };
		if (issued.deletedAt !== undefined)
			return await this.#retireAdmission(located.scope.id, "workspace", id, ["create"]) ? { outcome: "deleted" } : { outcome: "invalidState", reason: "AdmissionReconciliationUnavailable" };
		const backendRevision = this.#rawWorkspaceRevision(located.scope, id);
		let deletion: Awaited<ReturnType<KubernetesDriverControlStore["beginIssuedIdentifierDeletion"]>>;
		try { deletion = await this.#store.beginIssuedIdentifierDeletion({ resourceKind: "workspace", resourceId: id, incarnationUid: uid, expectedRevision, backendRevision, requestedAt: new Date(this.#now()).toISOString() }); }
		catch { return { outcome: "invalidState", reason: "KubernetesControlStoreUnavailable" }; }
		if (deletion.outcome === "conflict" || deletion.outcome === "notFound") return { outcome: "invalidState", reason: "KubernetesIdentifierBindingConflict" };
		try {
			await this.#backend.deleteRestWorkspace(id, backendRevision, located.scope.principal, syntheticIdentity(located.scope.principal));
			return await this.#finishIssuedDeletion("workspace", id, uid, located.scope.id);
		} catch (error) {
			if (error instanceof RestMutationError && error.code === "not_found") return await this.#finishIssuedDeletion("workspace", id, uid, located.scope.id);
			return await this.#deleteRejected(error, "workspace", id, uid, expectedRevision, backendRevision);
		}
	}

	async createRuntime(request: RuntimeCreate & { readonly id?: RuntimeId }): Promise<CreateOutcome<Runtime>> {
		this.#assertOpen();
		const scope = this.#scopeById.get(request.scopeId);
		if (!scope) return { outcome: "notFound", resourceKind: "scope" };
		const id = request.id ?? opaque("rt", this.#random);
		const bindingDigest = semanticResourceHash({ scopeId: scope.id, request });
		let previouslyIssued: SharedIssuedIdentifier | undefined;
		try { previouslyIssued = await this.#store.getIssuedIdentifier("runtime", id); }
		catch { return { outcome: "invalidState", reason: "KubernetesControlStoreUnavailable" }; }
		const recoveringUnbound = previouslyIssued !== undefined && previouslyIssued.scopeId === scope.id && previouslyIssued.bindingDigest === bindingDigest && previouslyIssued.incarnationUid === undefined && previouslyIssued.deletedAt === undefined;
		if (this.#locateRuntime(id) && !recoveringUnbound) return { outcome: "alreadyIssued" };
		if (previouslyIssued && (previouslyIssued.scopeId !== scope.id || previouslyIssued.bindingDigest !== bindingDigest || previouslyIssued.deletedAt !== undefined)) return { outcome: "alreadyIssued" };
		const owner = this.#locateWorkspaceWithScope(request.workspaceId);
		if (!owner || owner.scope.id !== scope.id) return { outcome: "notFound", resourceKind: "workspace" };
		const createKey = `runtime\0${id}`;
		if (this.#activeCreates.has(createKey)) return { outcome: "alreadyIssued" };
		const admission = await this.#reserveAdmission(scope, "runtime", id, request);
		if (admission.outcome === "denied") return { outcome: "admissionDenied", reason: admission.reason, ...(admission.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: admission.retryAfterSeconds }) };
		const admissionToken = admission.reservationToken;
		this.#activeCreates.add(createKey);
		let backendInvoked = false;
		try {
			const reserved = await this.#store.reserveIssuedIdentifier({ scopeId: scope.id, resourceKind: "runtime", resourceId: id, bindingDigest });
			if (reserved.outcome === "conflict" || reserved.record.deletedAt !== undefined) {
				await this.#store.releaseAdmission(admissionToken);
				return { outcome: "alreadyIssued" };
			}
			const ownership = await this.#claimCreation("runtime", id, bindingDigest);
			if (ownership.outcome === "duplicate") {
				await this.#store.releaseAdmission(admissionToken);
				return { outcome: "alreadyIssued" };
			}
			backendInvoked = true;
			const result = await this.#backend.putRestRuntime(id, request, scope.principal, syntheticIdentity(scope.principal));
			if (!result.created && ownership.outcome !== "recovery") {
				await this.#store.releaseAdmission(admissionToken);
				return { outcome: "alreadyIssued" };
			}
			if (await this.#store.commitAdmission(admissionToken) !== "committed") return { outcome: "invalidState", reason: "KubernetesAdmissionCommitUnavailable" };
			const incarnationUid = result.resource.metadata.uid;
			if (!incarnationUid) return { outcome: "invalidState", reason: "KubernetesIncarnationUidUnavailable" };
			const bound = await this.#store.bindIssuedIdentifier({ scopeId: scope.id, resourceKind: "runtime", resourceId: id, bindingDigest, incarnationUid, creationOwnerToken: ownership.ownerToken });
			if (bound.outcome === "conflict") return { outcome: "alreadyIssued" };
			this.#projection.applyWatch({ type: result.created ? "ADDED" : "MODIFIED", object: result.resource });
			await this.#eventTail;
			const generation = result.resource.metadata.generation;
			if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) return { outcome: "invalidState", reason: "KubernetesGenerationUnavailable" };
			const transition = await this.#waitForRuntime(scope, id, generation, request.desiredState);
			await this.#eventTail;
			if (!transition) return { outcome: "invalidState", reason: "KubernetesProjectionRejectedRuntime" };
			if (transition.outcome === "fenceUncertain") return { outcome: "fenceUncertain", resource: transition.resource };
			if (transition.outcome === "failed") return { outcome: "invalidState", reason: "KubernetesRuntimeTransitionFailed" };
			return { outcome: "created", resource: transition.resource };
		} catch (error) {
			if (!backendInvoked || error instanceof RestMutationError) await this.#store.releaseAdmission(admissionToken);
			else await this.#store.commitAdmission(admissionToken);
			return this.#createFailure(error);
		} finally { this.#activeCreates.delete(createKey); }
	}
	getRuntime(id: RuntimeId): LookupOutcome<Runtime> {
		const selected = this.#locateRuntime(id);
		return selected ? { outcome: "found", resource: selected.resource } : { outcome: "notFound" };
	}
	listRuntimes(scopeId: ScopeId, pageCursor?: string): DriverResourcePage<Runtime> {
		const scope = this.#scopeById.get(scopeId);
		const values = scope ? this.#snapshot(scope).runtimes.map(value => runtime(scope.id, value)) : [];
		return this.#page(scopeId, values, pageCursor);
	}
	async updateRuntime(id: RuntimeId, patch: Omit<RuntimePatch, "desiredState">, expectedRevision: Revision): Promise<MutationOutcome<Runtime>> {
		this.#assertOpen();
		const located = this.#locateRuntime(id);
		if (!located) return { outcome: "notFound" };
		const guard = this.#runtimeMutationGuard(located.resource, expectedRevision);
		if (guard) return guard;
		const admission = patch.browserPolicy === "Allowed"
			? await this.#reserveAdmission(located.scope, "runtime", id, { scopeId: located.scope.id, desiredState: located.resource.desiredState, browserPolicy: "Allowed" }, "enableBrowser")
			: undefined;
		if (admission?.outcome === "denied") return { outcome: "admissionDenied", reason: admission.reason, ...(admission.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: admission.retryAfterSeconds }) };
		let backendInvoked = false;
		try {
			backendInvoked = true;
			const result = await this.#backend.patchRestRuntime(id, expectedRevision, patch, located.scope.principal, syntheticIdentity(located.scope.principal));
			if (admission?.outcome === "admitted") await this.#store.commitAdmission(admission.reservationToken);
			const completed = await this.#completeRuntimeMutation(located.scope, id, result.resource, located.resource.desiredState);
			if (patch.browserPolicy === "Disabled" && !(await this.#retireAdmission(located.scope.id, "runtime", id, ["enableBrowser"])))
				return { outcome: "invalidState", reason: "AdmissionReconciliationUnavailable" };
			return completed;
		} catch (error) {
			if (admission?.outcome === "admitted") {
				if (!backendInvoked || error instanceof RestMutationError) await this.#store.releaseAdmission(admission.reservationToken);
				else await this.#store.commitAdmission(admission.reservationToken);
			}
			return this.#mutationFailure(error);
		}
	}
	async setRuntimeDesiredState(id: RuntimeId, desiredState: DesiredState, expectedRevision: Revision): Promise<MutationOutcome<Runtime>> {
		this.#assertOpen();
		const located = this.#locateRuntime(id);
		if (!located) return { outcome: "notFound" };
		if (located.resource.revision !== expectedRevision) return { outcome: "revisionMismatch", currentRevision: located.resource.revision };
		if (located.resource.phase === "Deleting") return { outcome: "invalidState", reason: "RuntimeDeleting" };
		if (fenceUncertain(located.resource)) return { outcome: "invalidState", reason: "ManualFenceRecoveryRequired" };
		if (located.resource.desiredState === desiredState) {
			const generation = this.#projection.portableRuntimeObservation(located.scope.principal, id)?.metadataGeneration;
			const completed = typeof generation === "number"
				? await this.#runtimeTransitionOutcome(located.scope, id, generation, desiredState)
				: { outcome: "invalidState" as const, reason: "KubernetesGenerationUnavailable" };
			if (desiredState !== "Running" && !(await this.#retireAdmission(located.scope.id, "runtime", id, ["activate"])))
				return { outcome: "invalidState", reason: "AdmissionReconciliationUnavailable" };
			return completed;
		}
		const admission = desiredState === "Running"
			? await this.#reserveAdmission(located.scope, "runtime", id, { scopeId: located.scope.id, desiredState: "Running", browserPolicy: "Disabled" }, "activate")
			: undefined;
		if (admission?.outcome === "denied") return { outcome: "admissionDenied", reason: admission.reason, ...(admission.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: admission.retryAfterSeconds }) };
		let backendInvoked = false;
		try {
			backendInvoked = true;
			const result = await this.#backend.patchRestRuntime(id, expectedRevision, { desiredState }, located.scope.principal, syntheticIdentity(located.scope.principal));
			if (admission?.outcome === "admitted") await this.#store.commitAdmission(admission.reservationToken);
			const completed = await this.#completeRuntimeMutation(located.scope, id, result.resource, desiredState);
			if (desiredState !== "Running" && !(await this.#retireAdmission(located.scope.id, "runtime", id, ["activate"])))
				return { outcome: "invalidState", reason: "AdmissionReconciliationUnavailable" };
			return completed;
		} catch (error) {
			if (admission?.outcome === "admitted") {
				if (!backendInvoked || error instanceof RestMutationError) await this.#store.releaseAdmission(admission.reservationToken);
				else await this.#store.commitAdmission(admission.reservationToken);
			}
			return this.#mutationFailure(error);
		}
	}
	async recoverRuntimeFence(id: RuntimeId, expectedRevision: Revision): Promise<MutationOutcome<Runtime>> {
		this.#assertOpen();
		const located = this.#locateRuntime(id);
		if (!located) return { outcome: "notFound" };
		if (located.resource.revision !== expectedRevision) return { outcome: "revisionMismatch", currentRevision: located.resource.revision };
		if (!fenceUncertain(located.resource)) return { outcome: "invalidState", reason: "FenceRecoveryNotRequired" };
		return { outcome: "invalidState", reason: "KubernetesFenceRecoveryUnsupported" };
	}
	async deleteRuntime(id: RuntimeId, expectedRevision: Revision): Promise<DeleteOutcome> {
		this.#assertOpen();
		const located = this.#locateRuntime(id);
		if (!located) return await this.#missingDeleteOutcome("runtime", id, expectedRevision);
		if (located.resource.revision !== expectedRevision) return { outcome: "revisionMismatch", currentRevision: located.resource.revision };
		if (fenceUncertain(located.resource)) return { outcome: "invalidState", reason: "ManualFenceRecoveryRequired" };
		const uid = this.#projection.portableResourceUid(located.scope.principal, "runtime", id);
		if (!uid) return { outcome: "invalidState", reason: "KubernetesIncarnationUidUnavailable" };
		let issued: SharedIssuedIdentifier | undefined;
		try { issued = await this.#claimExistingIdentifier(located.scope, "runtime", id, uid); }
		catch { return { outcome: "invalidState", reason: "KubernetesControlStoreUnavailable" }; }
		if (!issued || (issued.incarnationUid !== undefined && issued.incarnationUid !== uid)) return { outcome: "invalidState", reason: "KubernetesIdentifierBindingConflict" };
		if (issued.deletedAt !== undefined)
			return await this.#retireAdmission(located.scope.id, "runtime", id, ["create", "activate", "enableBrowser"]) ? { outcome: "deleted" } : { outcome: "invalidState", reason: "AdmissionReconciliationUnavailable" };
		let deletion: Awaited<ReturnType<KubernetesDriverControlStore["beginIssuedIdentifierDeletion"]>>;
		try { deletion = await this.#store.beginIssuedIdentifierDeletion({ resourceKind: "runtime", resourceId: id, incarnationUid: uid, expectedRevision, backendRevision: expectedRevision, requestedAt: new Date(this.#now()).toISOString() }); }
		catch { return { outcome: "invalidState", reason: "KubernetesControlStoreUnavailable" }; }
		if (deletion.outcome === "conflict" || deletion.outcome === "notFound") return { outcome: "invalidState", reason: "KubernetesIdentifierBindingConflict" };
		try {
			await this.#backend.deleteRestRuntime(id, expectedRevision, located.scope.principal, syntheticIdentity(located.scope.principal));
			return await this.#finishIssuedDeletion("runtime", id, uid, located.scope.id);
		} catch (error) {
			if (error instanceof RestMutationError && error.code === "not_found") return await this.#finishIssuedDeletion("runtime", id, uid, located.scope.id);
			return await this.#deleteRejected(error, "runtime", id, uid, expectedRevision, expectedRevision);
		}
	}

	resolveRuntimeRoute(runtimeId: RuntimeId, kind: RouteKind, generation: Generation): RouteOutcome {
		if (!ROUTE_KINDS.includes(kind)) return { outcome: "unsupported" };
		const located = this.#locateRuntime(runtimeId);
		if (!located) return { outcome: "notFound" };
		const route = this.#projection.portableRuntimeRoute(located.scope.principal, runtimeId, kind, generation);
		if (route.outcome !== "resolved") return route;
		return { outcome: "resolved", generation: route.generation, route: { kind, reference: route.reference } };
	}
	async listInfrastructureEvents(scopeId: ScopeId, cursor: string, limit?: number): Promise<EventReadOutcome> {
		if (!this.#scopeById.has(scopeId)) throw new TypeError("scope is not configured");
		await this.#eventTail;
		return await this.#store.readAfter({ scopeId, cursor, ...(limit === undefined ? {} : { limit }) });
	}
	watchInfrastructureEvents(scopeId: ScopeId, cursor: string, signal?: AbortSignal): AsyncIterable<EventReadOutcome> {
		if (!this.#scopeById.has(scopeId)) throw new TypeError("scope is not configured");
		if (this.#closed) throw new KubernetesDriverClosedError();
		return this.#watchInfrastructureEvents(scopeId, cursor, signal);
	}
	async *#watchInfrastructureEvents(scopeId: ScopeId, cursor: string, signal?: AbortSignal): AsyncIterableIterator<EventReadOutcome> {
		if (this.#closed) throw new KubernetesDriverClosedError();
		if (this.#watchControllers.size >= MAX_WATCHES) throw new Error("Kubernetes driver watch capacity exceeded");
		const controller = new AbortController();
		this.#watchControllers.add(controller);
		if (signal?.aborted) controller.abort();
		const abort = (): void => { controller.abort(); };
		signal?.addEventListener("abort", abort, { once: true });
		try {
			await this.#eventTail;
			if (this.#closed || controller.signal.aborted) return;
			const iterable = await this.#store.subscribe({ scopeId, cursor, signal: controller.signal, pollMilliseconds: this.#watchPoll, batchLimit: Math.min(this.#capabilities.limits.maxPageSize, MAX_EVENT_BATCH) });
			for await (const outcome of iterable) yield outcome;
		} finally {
			signal?.removeEventListener("abort", abort);
			this.#watchControllers.delete(controller);
			controller.abort();
		}
	}
	close(): Promise<void> {
		this.#closePromise ??= this.#close();
		return this.#closePromise;
	}

	async #close(): Promise<void> {
		this.#closed = true;
		this.#unsubscribeWorkspaces?.();
		this.#unsubscribeRuntimes?.();
		this.#unsubscribeWorkspaces = undefined;
		this.#unsubscribeRuntimes = undefined;
		for (const controller of this.#watchControllers) controller.abort();
		for (const finish of this.#projectionWaiters) finish();
		this.#projectionWaiters.clear();
		await this.#eventTail;
	}
	async #reserveAdmission(
		scope: ScopeBinding,
		resourceKind: "workspace" | "runtime",
		resourceKey: string,
		request: { readonly scopeId: ScopeId; readonly capacityBytes?: number; readonly desiredState?: DesiredState; readonly browserPolicy?: "Allowed" | "Disabled" },
		transition: "create" | "activate" | "enableBrowser" = "create",
	): Promise<ScopeAdmissionOutcome> {
		const snapshot = this.#snapshot(scope);
		const activeRuntimes = snapshot.runtimes.filter(item =>
			item.desiredState === "Running" && item.phase !== "Deleting" && item.phase !== "Failed").length;
		const add = (sum: number, value: number): number =>
			sum > Number.MAX_SAFE_INTEGER - value ? Number.MAX_SAFE_INTEGER : sum + value;
		const workspaceCapacityBytes = snapshot.workspaces.reduce((sum, item) => add(sum, item.capacityBytes), 0);
		const demand = this.#admissionPolicy.runtimeResources;
		const product = (value: number, count: number): number =>
			value !== 0 && count > Math.floor(Number.MAX_SAFE_INTEGER / value) ? Number.MAX_SAFE_INTEGER : value * count;
		try {
			return await this.#store.reserveAdmission({
				scopeId: scope.id,
				resourceKey,
				resourceKind,
				transition,
				...(resourceKind === "workspace" ? { workspaceCapacityBytes: request.capacityBytes ?? 0 } : {
					active: transition !== "enableBrowser" && request.desiredState === "Running",
					browserRequested: request.browserPolicy === "Allowed",
				}),
				policy: this.#admissionPolicy,
				usage: {
					activeRuntimes,
					retainedRuntimes: snapshot.runtimes.length,
					workspaceCapacityBytes,
					cpuMillis: product(demand.cpuMillis, activeRuntimes),
					memoryBytes: product(demand.memoryBytes, activeRuntimes),
					gpuUnits: product(demand.gpuUnits, activeRuntimes),
					observedResourceDigests: [
						...snapshot.workspaces.map(item => hash(`${scope.id}\0workspace\0${item.id}\0create`)),
						...snapshot.runtimes.map(item => hash(`${scope.id}\0runtime\0${item.id}\0create`)),
						...snapshot.runtimes.filter(item => item.desiredState === "Running").map(item => hash(`${scope.id}\0runtime\0${item.id}\0activate`)),
						...snapshot.runtimes.filter(item => this.#projection.portableRuntimeObservation(scope.principal, item.id)?.browserPolicy === "Allowed").map(item => hash(`${scope.id}\0runtime\0${item.id}\0enableBrowser`)),
					],
				},
			});
		} catch {
			return { outcome: "denied", reason: "admission_unavailable", retryAfterSeconds: 1 };
		}
	}
	#assertOpen(): void { if (this.#closed) throw new KubernetesDriverClosedError(); }
	#snapshot(scope: ScopeBinding): RestPrincipalProjection { return this.#projection.restProjection(scope.principal); }
	#workspaceFor(scope: ScopeBinding, id: WorkspaceId): Workspace | undefined {
		const selected = this.#snapshot(scope).workspaces.filter(value => value.id === id);
		return selected.length === 1 ? workspace(scope.id, selected[0]!) : undefined;
	}
	#rawWorkspaceRevision(scope: ScopeBinding, id: WorkspaceId): Revision {
		const selected = this.#snapshot(scope).workspaces.filter(value => value.id === id);
		if (selected.length !== 1) throw new Error("workspace projection is ambiguous");
		return selected[0]!.revision;
	}

	#runtimeFor(scope: ScopeBinding, id: RuntimeId): Runtime | undefined {
		const selected = this.#snapshot(scope).runtimes.filter(value => value.id === id);
		return selected.length === 1 ? runtime(scope.id, selected[0]!) : undefined;
	}
	async #waitForRuntime(scope: ScopeBinding, id: RuntimeId, expectedGeneration: number, desiredState: DesiredState): Promise<RuntimeTransitionResult | undefined> {
		const current = (): RuntimeTransitionResult | undefined => {
			const observation = this.#projection.portableRuntimeObservation(scope.principal, id);
			if (!observation) return undefined;
			const selected = observation.resource ? runtime(scope.id, observation.resource) : undefined;
			if (observation.metadataGeneration !== expectedGeneration) {
				return observation.metadataGeneration !== undefined && observation.metadataGeneration > expectedGeneration ? { outcome: "failed", ...(selected ? { resource: selected } : {}) } : undefined;
			}
			if (observation.fenceUncertain) return selected ? { outcome: "fenceUncertain", resource: selected } : { outcome: "failed" };
			if (observation.observedGeneration !== expectedGeneration) return undefined;
			if (observation.phase === "Failed" || observation.phase === "Degraded") return { outcome: "failed", ...(selected ? { resource: selected } : {}) };
			const terminal = (desiredState === "Running" && observation.phase === "Ready")
				|| (desiredState === "Sleeping" && observation.phase === "Sleeping")
				|| (desiredState === "Stopped" && observation.phase === "Stopped");
			return terminal && selected ? { outcome: "terminal", resource: selected } : undefined;
		};
		const immediate = current();
		if (immediate || this.#closed) return immediate;
		return await new Promise<RuntimeTransitionResult | undefined>(resolve => {
			let settled = false;
			let unsubscribe: (() => void) | undefined;
			let timer: NodeJS.Timeout | undefined;
			const finish = (): void => {
				if (settled) return;
				const selected = current();
				if (!selected && !this.#closed && timer !== undefined) return;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				unsubscribe?.();
				this.#projectionWaiters.delete(close);
				resolve(selected);
			};
			const close = (): void => {
				if (timer !== undefined) clearTimeout(timer);
				timer = undefined;
				finish();
			};
			unsubscribe = this.#projection.subscribeSessions(finish);
			timer = setTimeout(close, this.#projectionTimeout);
			this.#projectionWaiters.add(close);
			finish();
		});
	}

	#locateWorkspace(id: WorkspaceId): Workspace | undefined { return this.#locateWorkspaceWithScope(id)?.resource; }
	#locateWorkspaceWithScope(id: WorkspaceId): { scope: ScopeBinding; resource: Workspace } | undefined {
		const found = this.#scopes.flatMap(scope => { const resource = this.#workspaceFor(scope, id); return resource ? [{ scope, resource }] : []; });
		return found.length === 1 ? found[0] : undefined;
	}
	#locateRuntime(id: RuntimeId): LocatedRuntime | undefined {
		const found = this.#scopes.flatMap(scope => { const resource = this.#runtimeFor(scope, id); return resource ? [{ scope, resource }] : []; });
		return found.length === 1 ? found[0] : undefined;
	}
	#page<T>(scopeId: ScopeId, values: readonly T[], cursor?: string): DriverResourcePage<T> {
		const revision = hash(JSON.stringify(values)).slice(0, 16);
		let offset = 0;
		const highWaterCursor = this.#eventCursors.get(scopeId);
		if (highWaterCursor === undefined) throw new TypeError("scope is not configured");
		if (cursor !== undefined) {
			const match = PAGE_CURSOR.exec(cursor);
			if (!match || match[1] !== revision) throw new TypeError("page cursor is stale or invalid");
			offset = Number.parseInt(match[2]!, 36);
			if (!Number.isSafeInteger(offset) || offset < 0 || offset > values.length) throw new TypeError("page cursor offset is invalid");
		}
		const end = Math.min(values.length, offset + this.#capabilities.limits.maxPageSize);
		return {
			items: Object.freeze(values.slice(offset, end)),
			highWaterCursor,
			...(end < values.length ? { nextCursor: `kp1.${revision}.${end.toString(36)}` } : {}),
		};
	}
	#runtimeMutationGuard(runtime: Runtime, expectedRevision: Revision): MutationOutcome<Runtime> | undefined {
		if (runtime.revision !== expectedRevision) return { outcome: "revisionMismatch", currentRevision: runtime.revision };
		if (runtime.phase === "Deleting") return { outcome: "invalidState", reason: "RuntimeDeleting" };
		if (fenceUncertain(runtime)) return { outcome: "invalidState", reason: "ManualFenceRecoveryRequired" };
		if (isTransitioning(runtime.phase)) return { outcome: "invalidState", reason: "RuntimeTransitionInProgress" };
		return undefined;
	}
	async #completeRuntimeMutation(scope: ScopeBinding, id: RuntimeId, resourceValue: KubernetesResource, desiredState: DesiredState): Promise<MutationOutcome<Runtime>> {
		this.#projection.applyWatch({ type: "MODIFIED", object: resourceValue });
		await this.#eventTail;
		const generation = resourceValue.metadata.generation;
		if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) return { outcome: "invalidState", reason: "KubernetesGenerationUnavailable" };
		return await this.#runtimeTransitionOutcome(scope, id, generation, desiredState);
	}
	async #runtimeTransitionOutcome(scope: ScopeBinding, id: RuntimeId, generation: number, desiredState: DesiredState): Promise<MutationOutcome<Runtime>> {
		const transition = await this.#waitForRuntime(scope, id, generation, desiredState);
		await this.#eventTail;
		if (!transition) return { outcome: "invalidState", reason: "KubernetesProjectionRejectedRuntime" };
		if (transition.outcome === "fenceUncertain") return { outcome: "fenceUncertain", resource: transition.resource };
		if (transition.outcome === "failed") return { outcome: "invalidState", reason: "KubernetesRuntimeTransitionFailed" };
		return { outcome: "updated", resource: transition.resource };
	}
	async #claimExistingIdentifier(scope: ScopeBinding, kind: "workspace" | "runtime", id: string, uid: string): Promise<SharedIssuedIdentifier | undefined> {
		const existing = await this.#store.getIssuedIdentifier(kind, id);
		if (existing) return existing;
		const bindingDigest = semanticResourceHash({ adopted: true, scopeId: scope.id, resourceKind: kind, resourceId: id });
		const reserved = await this.#store.reserveIssuedIdentifier({ scopeId: scope.id, resourceKind: kind, resourceId: id, bindingDigest });
		if (reserved.outcome === "conflict") return reserved.record;
		const bound = await this.#store.bindIssuedIdentifier({ scopeId: scope.id, resourceKind: kind, resourceId: id, bindingDigest, incarnationUid: uid });
		return bound.record;
	}
	async #claimCreation(kind: "workspace" | "runtime", id: string, bindingDigest: string): Promise<{ readonly outcome: "fresh" | "recovery"; readonly ownerToken: string } | { readonly outcome: "duplicate" }> {
		const ownerToken = `own_${hash(`${this.#creationOwnerPrefix}\0${kind}\0${id}\0${bindingDigest}`).slice(0, 32)}`;
		const startedAt = Date.now(), baseNow = this.#now(), leaseMilliseconds = 30_000;
		for (;;) {
			if (this.#closed) throw new KubernetesDriverClosedError();
			const now = baseNow + (Date.now() - startedAt);
			const claim = await this.#store.claimIssuedIdentifierCreation({ resourceKind: kind, resourceId: id, bindingDigest, ownerToken, now, leaseExpiresAt: now + leaseMilliseconds });
			if (claim.outcome === "claimed") return { outcome: "fresh", ownerToken };
			if (claim.outcome === "takenOver") return { outcome: "recovery", ownerToken };
			if (claim.outcome === "owned") return { outcome: "recovery", ownerToken };
			if (claim.outcome === "conflict" || claim.outcome === "notFound") return { outcome: "duplicate" };
			const wait = Math.max(1, Math.min(25, (claim.record?.creation?.leaseExpiresAt ?? now + 1) - now));
			await new Promise<void>(resolve => setTimeout(resolve, wait));
		}
	}
	async #missingDeleteOutcome(kind: "workspace" | "runtime", id: string, expectedRevision: Revision): Promise<DeleteOutcome> {
		let issued: SharedIssuedIdentifier | undefined;
		try { issued = await this.#store.getIssuedIdentifier(kind, id); }
		catch { return { outcome: "invalidState", reason: "KubernetesControlStoreUnavailable" }; }
		if (issued?.deletedAt !== undefined) {
			return await this.#retireAdmission(issued.scopeId, kind, id, kind === "workspace" ? ["create"] : ["create", "activate", "enableBrowser"])
				? { outcome: "deleted" }
				: { outcome: "invalidState", reason: "AdmissionReconciliationUnavailable" };
		}
		if (!issued?.deletion || !issued.incarnationUid) return { outcome: "notFound" };
		if (issued.deletion.expectedRevision !== expectedRevision) return { outcome: "revisionMismatch", currentRevision: issued.deletion.expectedRevision };
		const scope = this.#scopeById.get(issued.scopeId);
		if (!scope) return { outcome: "invalidState", reason: "KubernetesIdentifierBindingConflict" };
		try {
			if (kind === "workspace") await this.#backend.deleteRestWorkspace(id, issued.deletion.backendRevision, scope.principal, syntheticIdentity(scope.principal));
			else await this.#backend.deleteRestRuntime(id, issued.deletion.backendRevision, scope.principal, syntheticIdentity(scope.principal));
		} catch (error) {
			if (!(error instanceof RestMutationError) || error.code !== "not_found") return this.#deleteFailure(error);
		}
		return await this.#finishIssuedDeletion(kind, id, issued.incarnationUid, issued.scopeId);
	}
	async #deleteRejected(error: unknown, kind: "workspace" | "runtime", id: string, uid: string, expectedRevision: Revision, backendRevision: string): Promise<DeleteOutcome> {
		if (error instanceof RestMutationError && error.code !== "unavailable" && error.code !== "idempotency_unavailable") {
			try {
				const cancelled = await this.#store.cancelIssuedIdentifierDeletion({ resourceKind: kind, resourceId: id, incarnationUid: uid, expectedRevision, backendRevision });
				if (cancelled.outcome === "conflict" || cancelled.outcome === "notFound") return { outcome: "invalidState", reason: "KubernetesIdentifierBindingConflict" };
			} catch {
				return { outcome: "invalidState", reason: "KubernetesControlStoreUnavailable" };
			}
		}
		return this.#deleteFailure(error);
	}
	async #finishIssuedDeletion(kind: "workspace" | "runtime", id: string, uid: string, scopeId: string): Promise<DeleteOutcome> {
		try {
			const marked = await this.#store.markIssuedIdentifierDeleted({ resourceKind: kind, resourceId: id, incarnationUid: uid, deletedAt: new Date(this.#now()).toISOString() });
			if (marked.outcome !== "deleted" && marked.outcome !== "existing")
				return { outcome: "invalidState", reason: "KubernetesIdentifierBindingConflict" };
			if (!(await this.#retireAdmission(scopeId, kind, id, kind === "workspace" ? ["create"] : ["create", "activate", "enableBrowser"])))
				return { outcome: "invalidState", reason: "AdmissionReconciliationUnavailable" };
			return { outcome: "deleted" };
		} catch {
			return { outcome: "invalidState", reason: "KubernetesControlStoreUnavailable" };
		}
	}
	async #retireAdmission(scopeId: string, resourceKind: "workspace" | "runtime", resourceKey: string, transitions: readonly ("create" | "activate" | "enableBrowser")[]): Promise<boolean> {
		try {
			for (const transition of transitions)
				await this.#store.reconcileAdmissionAbsence({ scopeId, resourceKind, resourceKey, transition });
			return true;
		} catch {
			return false;
		}
	}
	#createFailure<T>(error: unknown): CreateOutcome<T> {
		if (error instanceof RestMutationError) {
			if (error.code === "not_found") return { outcome: "notFound", resourceKind: "workspace" };
			if (error.code === "resource_conflict") return { outcome: "alreadyIssued" };
			return { outcome: "invalidState", reason: this.#reason(error) };
		}
		return { outcome: "invalidState", reason: "KubernetesAuthorityUnavailable" };
	}
	#mutationFailure<T>(error: unknown): MutationOutcome<T> {
		if (error instanceof RestMutationError) {
			if (error.code === "not_found") return { outcome: "notFound" };
			if (error.code === "revision_mismatch") return { outcome: "revisionMismatch", currentRevision: error.currentRevision! };
			return { outcome: "invalidState", reason: this.#reason(error) };
		}
		return { outcome: "invalidState", reason: "KubernetesAuthorityUnavailable" };
	}
	#deleteFailure(error: unknown): DeleteOutcome {
		if (error instanceof RestMutationError) {
			if (error.code === "not_found") return { outcome: "notFound" };
			if (error.code === "revision_mismatch") return { outcome: "revisionMismatch", currentRevision: error.currentRevision! };
			if (error.code === "workspace_attached") return { outcome: "invalidState", reason: "WorkspaceAttached" };
			return { outcome: "invalidState", reason: this.#reason(error) };
		}
		return { outcome: "invalidState", reason: "KubernetesAuthorityUnavailable" };
	}
	#reason(error: RestMutationError): string {
		return error.code === "workspace_attached" ? "WorkspaceAttached"
			: error.code === "invalid_resource" ? "KubernetesPolicyRejectedMutation"
			: error.code === "unavailable" ? "KubernetesAuthorityUnavailable"
			: "KubernetesResourceConflict";
	}
	#queueEventSynchronization(): void {
		if (this.#closed) return;
		const pending = this.#eventTail.catch(() => undefined).then(async () => { await this.#synchronizeEvents(); });
		this.#eventTail = pending;
	}
	async #synchronizeEvents(): Promise<void> {
		for (const scope of this.#scopes) {
			const before = this.#previous.get(scope.id)!;
			const after = this.#snapshot(scope);
			if (before.revision !== after.revision) await this.#appendEvent("scope", { id: scope.id, revision: after.revision }, scope.id, "Ready");
			await this.#appendChangedResources(scope.id, "workspace", before.workspaces.map(value => workspace(scope.id, value)), after.workspaces.map(value => workspace(scope.id, value)));
			await this.#appendChangedResources(scope.id, "runtime", before.runtimes.map(value => runtime(scope.id, value)), after.runtimes.map(value => runtime(scope.id, value)));
			this.#previous.set(scope.id, after);
		}
	}
	async #appendChangedResources(scopeId: ScopeId, kind: "workspace" | "runtime", before: readonly Workspace[] | readonly Runtime[], after: readonly Workspace[] | readonly Runtime[]): Promise<void> {
		const old = new Map(before.map(value => [value.id, value]));
		const current = new Map(after.map(value => [value.id, value]));
		for (const id of [...new Set([...old.keys(), ...current.keys()])].sort()) {
			const prior = old.get(id);
			const selected = current.get(id);
			if (prior?.revision === selected?.revision && prior?.phase === selected?.phase) continue;
			const value = selected ?? prior;
			if (value) await this.#appendEvent(kind, value, scopeId, selected?.phase ?? "Deleting");
		}
	}
	async #appendEvent(kind: "scope" | "workspace" | "runtime", value: Pick<Scope, "id" | "revision"> | Pick<Workspace, "id" | "revision"> | Pick<Runtime, "id" | "revision">, scopeId: ScopeId, phase: Phase): Promise<void> {
		const timestamp = new Date(this.#now()).toISOString();
		const event: InfrastructureEvent = {
			eventId: `evt_${createHash("sha256").update(scopeId).update("\0").update(kind).update("\0").update(value.id).update("\0").update(value.revision).update("\0").update(phase).digest("base64url").slice(0, 24)}`,
			resourceKind: kind,
			resourceId: value.id,
			scopeId,
			revision: value.revision,
			phase,
			timestamp,
		};
		const appended = await this.#store.appendEvent(event);
		this.#eventCursors.set(scopeId, appended.cursor);
	}
}
