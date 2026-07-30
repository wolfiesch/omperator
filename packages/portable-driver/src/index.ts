import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type {
  BrowserPolicy,
  AdmissionDenialReason,
  ScopeAdmissionPolicy,
  Capabilities,
  Condition,
  DesiredState,
  IdlePolicy,
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
  StorageCapabilities,
  Timestamp,
  Workspace,
  WorkspaceCreate,
  WorkspaceId,
  WorkspacePatch,
} from "@t4-code/portable-core";
import type {
  InfrastructureEvent,
  ScopeAdmissionLedger,
  ScopeAdmissionOutcome,
  PortableControlStore,
  ResetEvent,
  ResourceEventDraft,
  RuntimeConfigurationIntent,
} from "@t4-code/portable-control-store";

export type RouteKind = "cmux-v10" | "omp-app-v1";
export interface RouteDescriptor {
  readonly kind: RouteKind;
  readonly reference: string;
}

export type LookupOutcome<T> = { readonly outcome: "found"; readonly resource: T } | { readonly outcome: "notFound" };
export type MutationOutcome<T> =
  | { readonly outcome: "updated"; readonly resource: T }
  | { readonly outcome: "revisionMismatch"; readonly currentRevision: Revision }
  | { readonly outcome: "notFound" }
  | { readonly outcome: "invalidState"; readonly reason: string }
  | { readonly outcome: "fenceUncertain"; readonly resource: Runtime }
  | { readonly outcome: "admissionDenied"; readonly reason: AdmissionDenialReason; readonly retryAfterSeconds?: number };
export type CreateOutcome<T> =
  | { readonly outcome: "created"; readonly resource: T }
  | { readonly outcome: "alreadyIssued" }
  | { readonly outcome: "notFound"; readonly resourceKind: "scope" | "workspace" }
  | { readonly outcome: "invalidState"; readonly reason: string }
  | { readonly outcome: "fenceUncertain"; readonly resource: Runtime }
  | { readonly outcome: "admissionDenied"; readonly reason: AdmissionDenialReason; readonly retryAfterSeconds?: number };
export type DeleteOutcome =
  | { readonly outcome: "deleted" }
  | { readonly outcome: "revisionMismatch"; readonly currentRevision: Revision }
  | { readonly outcome: "notFound" }
  | { readonly outcome: "invalidState"; readonly reason: string }
  | { readonly outcome: "tombstoneCapacityExceeded" }
  | { readonly outcome: "fenceUncertain"; readonly resource: Runtime };
export type RouteOutcome =
  | { readonly outcome: "resolved"; readonly route: RouteDescriptor; readonly generation: Generation }
  | { readonly outcome: "notFound" | "notReady" | "staleGeneration" | "fenceUncertain" | "unsupported" };
export type EventReadOutcome =
  | { readonly outcome: "events"; readonly events: readonly InfrastructureEvent[]; readonly cursor: string }
  | { readonly outcome: "cursorExpired"; readonly reset: ResetEvent };
export interface DriverResourcePage<T> extends Page<T> {
  readonly highWaterCursor: string;
}

export type SnapshotConsistency = "Quiesced" | "CrashConsistent";
export interface StorageSnapshotResource {
  readonly id: string;
  readonly sourceKind: "workspace" | "runtime-state";
  readonly sourceId: WorkspaceId | RuntimeId;
  readonly consistency: SnapshotConsistency;
  readonly runtimeGeneration: Generation;
  readonly readyToUse: boolean;
  readonly createdAt: Timestamp;
}
export interface CheckpointResource {
  readonly requestId: string;
  readonly runtimeId: RuntimeId;
  readonly runtimeGeneration: Generation;
  readonly consistency: SnapshotConsistency;
  readonly durableAcks: Readonly<{ omp: boolean; cmux: boolean; browser: boolean }>;
  readonly workspaceSnapshot: StorageSnapshotResource;
  readonly runtimeStateSnapshot: StorageSnapshotResource;
  readonly completedAt?: Timestamp;
}

export interface CompleteReadiness {
  readonly runtimeGeneration: Generation;
  readonly storageReady: true;
  readonly exclusiveWriterLeaseHeld: true;
  readonly internalGenerationAuthenticationReady: true;
  readonly hostReady: true;
  readonly ompAuthorityReady: true;
  readonly cmuxProtocol10Ready: true;
  readonly requiredBrowserReady: true;
}
export interface RuntimeLaunchContext {
  readonly runtimeId: RuntimeId;
  readonly generation: Generation;
  readonly browserPolicy: BrowserPolicy;
  readonly idlePolicy?: IdlePolicy;
  readonly workspacePath: string;
  readonly runtimeStatePath: string;
  readonly generationCredentialPath: string;
}
export interface RuntimeLaunchSpec {
  readonly executable: string;
  readonly arguments?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly routeKinds: readonly RouteKind[];
  /** Must report the full ADR-023 readiness conjunction. LocalDriver does not infer cmux readiness. */
  readonly readinessProbe: (context: RuntimeLaunchContext) => Promise<CompleteReadiness | undefined>;
  readonly quiesce?: (context: RuntimeLaunchContext) => Promise<boolean>;
  readonly closeConnections?: (context: RuntimeLaunchContext) => Promise<void>;
  /** Required OS-backed proof that the generation containment unit is empty and cannot write runtime state. */
  readonly terminateAndProveFence: (context: RuntimeLaunchContext, containment: { readonly processGroupId: number; readonly graceMilliseconds: number; readonly killMilliseconds: number }) => Promise<boolean>;
}
export type RuntimeLaunchFactory = (runtime: Runtime, context: RuntimeLaunchContext) => RuntimeLaunchSpec;

export interface LocalDriverOptions {
  readonly root: string;
  readonly store: PortableControlStore;
  /** Scope creation is an operator bootstrap action, not implicit creator authorization. */
  readonly bootstrapScopes: readonly Pick<Scope, "id" | "displayName" | "kind">[];
  readonly launch: RuntimeLaunchFactory;
  readonly admissionLedger: ScopeAdmissionLedger;
  readonly admissionPolicy: ScopeAdmissionPolicy;
  readonly capabilities: Capabilities;
  readonly readinessTimeoutMilliseconds?: number;
  readonly shutdownGraceMilliseconds?: number;
  readonly shutdownKillMilliseconds?: number;
  readonly now?: () => number;
  readonly random?: (bytes: number) => Uint8Array;
  readonly lsofExecutable?: string;
}

export type Awaitable<T> = T | Promise<T>;

export interface ResourceDriver {
  getScope(id: ScopeId): LookupOutcome<Scope>;
  listScopes(): Page<Scope>;
  createWorkspace(request: WorkspaceCreate & { readonly id?: WorkspaceId }): Awaitable<CreateOutcome<Workspace>>;
  getWorkspace(id: WorkspaceId): LookupOutcome<Workspace>;
  listWorkspaces(scopeId: ScopeId, pageCursor?: string): DriverResourcePage<Workspace>;
  updateWorkspace(id: WorkspaceId, patch: WorkspacePatch, expectedRevision: Revision): Awaitable<MutationOutcome<Workspace>>;
  deleteWorkspace(id: WorkspaceId, expectedRevision: Revision): Awaitable<DeleteOutcome>;
  createRuntime(request: RuntimeCreate & { readonly id?: RuntimeId }): Promise<CreateOutcome<Runtime>>;
  getRuntime(id: RuntimeId): LookupOutcome<Runtime>;
  listRuntimes(scopeId: ScopeId, pageCursor?: string): DriverResourcePage<Runtime>;
  updateRuntime(id: RuntimeId, patch: Omit<RuntimePatch, "desiredState">, expectedRevision: Revision): Promise<MutationOutcome<Runtime>>;
  deleteRuntime(id: RuntimeId, expectedRevision: Revision): Promise<DeleteOutcome>;
  setRuntimeDesiredState(id: RuntimeId, desiredState: DesiredState, expectedRevision: Revision): Promise<MutationOutcome<Runtime>>;
  recoverRuntimeFence(id: RuntimeId, expectedRevision: Revision): Promise<MutationOutcome<Runtime>>;
  getCapabilities(): Capabilities;
  /** Bounded observed storage truth; absent means this driver predates probing and callers must fail closed. */
  getStorageCapabilities?(): StorageCapabilities | undefined;
  resolveRuntimeRoute(runtimeId: RuntimeId, kind: RouteKind, generation: Generation): RouteOutcome;
  listInfrastructureEvents(scopeId: ScopeId, cursor: string, limit?: number): Awaitable<EventReadOutcome>;
  watchInfrastructureEvents(scopeId: ScopeId, cursor: string, signal?: AbortSignal): AsyncIterable<EventReadOutcome>;
  close(): Promise<void>;
}

type FenceState = "NoPriorWriter" | "DrainRequired" | "ShutdownRequested" | "FenceVerifying" | "FenceProven" | "FenceUncertain";
interface BackendRecord {
  readonly version: 1;
  readonly runtimeId: RuntimeId;
  readonly generation: Generation;
  readonly pid: number;
  readonly leaseToken: string;
  readonly credentialName: string;
  readonly routeReferences: Partial<Record<RouteKind, string>>;
  readonly launchedAt: Timestamp;
}

const PROCESS_BOOTSTRAP = fileURLToPath(new URL("./process-bootstrap.mjs", import.meta.url));
interface RuntimeConfiguration {
  readonly browserPolicy: BrowserPolicy;
  readonly idlePolicy?: IdlePolicy;
}
const ROUTE_KINDS: readonly RouteKind[] = ["cmux-v10", "omp-app-v1"];
const FENCE_CONDITION = "Fenced";
const ROUTE_CONDITION = "RouteReady";
const MAX_ROOT_LENGTH = 3000;
const START_AUTHORITY_OWNERS = new Map<string, symbol>();

function iso(now: () => number): Timestamp { return new Date(now()).toISOString(); }
function opaque(prefix: string, random: (bytes: number) => Uint8Array, bytes = 18): string {
  return `${prefix}_${Buffer.from(random(bytes)).toString("base64url")}`;
}
function hashedComponent(prefix: string, id: string): string {
  return `${prefix}-${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}
function condition(type: string, status: "True" | "False" | "Unknown", reason: string, at: Timestamp): Condition {
  return { type, status, reason, lastTransitionTime: at };
}
function replaceCondition(conditions: readonly Condition[], replacement: Condition): readonly Condition[] {
  return Object.freeze([...conditions.filter((item) => item.type !== replacement.type), replacement]);
}
function fencedUncertain(runtime: Runtime): boolean {
  return runtime.conditions.some((item: Condition) => item.type === FENCE_CONDITION && item.status === "False" && item.reason === "FenceUncertain");
}
function sleep(milliseconds: number): Promise<void> {
  const { promise, resolve: resolvePromise } = Promise.withResolvers<void>();
  setTimeout(resolvePromise, milliseconds);
  return promise;
}
function processGroupAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  const result = spawnSync("ps", ["-axo", "pgid=,stat="], {
    encoding: "utf8",
    timeout: 1000,
  });
  if (result.error || result.status !== 0) return true;
  for (const row of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)/.exec(row);
    if (match && Number(match[1]) === pid && !match[2]!.startsWith("Z")) return true;
  }
  return false;
}
function exactChildEnvironment(extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  for (const [key, value] of Object.entries(extra ?? {})) env[key] = value;
  return env;
}

export class LocalDriver implements ResourceDriver {
  readonly #root: string;
  readonly #workspaceRoot: string;
  readonly #runtimeRoot: string;
  readonly #store: PortableControlStore;
  readonly #bootstrapScopeIds: readonly ScopeId[];
  readonly #launch: RuntimeLaunchFactory;
  readonly #capabilities: Capabilities;
  readonly #admissionLedger: ScopeAdmissionLedger;
  readonly #admissionPolicy: ScopeAdmissionPolicy;
  readonly #readinessTimeout: number;
  readonly #shutdownGrace: number;
  readonly #shutdownKill: number;
  readonly #now: () => number;
  readonly #random: (bytes: number) => Uint8Array;
  readonly #lsof: string;
  readonly #children = new Map<RuntimeId, ChildProcess>();
  readonly #adoptedRuntimes = new Set<RuntimeId>();
  readonly #fence = new Map<RuntimeId, FenceState>();
  readonly #runtimeTails = new Map<RuntimeId, Promise<void>>();
  readonly #attemptHandles = new Map<RuntimeId, number>();
  readonly #adoptedMonitors = new Map<RuntimeId, NodeJS.Timeout>();
  readonly #startAuthorityOwner = Symbol("LocalDriverStartAuthority");
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: LocalDriverOptions) {
    if (!resolve(options.root).startsWith(sep) || options.root.length > MAX_ROOT_LENGTH) throw new TypeError("root must be a bounded absolute path");
    this.#root = resolve(options.root);
    this.#store = options.store;
    this.#launch = options.launch;
    this.#capabilities = options.capabilities;
    this.#admissionLedger = options.admissionLedger;
    this.#admissionPolicy = options.admissionPolicy;
    this.#readinessTimeout = options.readinessTimeoutMilliseconds ?? 15_000;
    this.#shutdownGrace = options.shutdownGraceMilliseconds ?? 5_000;
    this.#shutdownKill = options.shutdownKillMilliseconds ?? 2_000;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? randomBytes;
    this.#lsof = options.lsofExecutable ?? "lsof";
    this.#preparePrivateDirectory(this.#root);
    this.#workspaceRoot = join(this.#root, "workspaces");
    this.#runtimeRoot = join(this.#root, "runtime-state");
    this.#preparePrivateDirectory(this.#workspaceRoot);
    this.#preparePrivateDirectory(this.#runtimeRoot);
    const ids: ScopeId[] = [];
    for (const scope of options.bootstrapScopes) {
      const result = this.#store.createResourceWithEvent({ kind: "scope", value: scope, event: this.#eventDraft("Ready") });
      if (result.outcome === "alreadyIssued" && !this.#store.getResource("scope", scope.id)) throw new Error(`scope identifier ${scope.id} was already issued`);
      ids.push(scope.id);
    }
    this.#bootstrapScopeIds = Object.freeze(ids);
    this.#recoverConfigurationIntents();
  }
  close(): Promise<void> {
    this.#closePromise ??= this.#closeLifecycle();
    return this.#closePromise;
  }

  async #closeLifecycle(): Promise<void> {
    this.#closed = true;
    for (const monitor of this.#adoptedMonitors.values()) clearInterval(monitor);
    this.#adoptedMonitors.clear();
    this.#neutralizeChildCallbacks();
    while (this.#runtimeTails.size > 0) {
      await Promise.allSettled(this.#runtimeTails.values());
    }
    this.#neutralizeChildCallbacks();
    for (const id of this.#attemptHandles.keys()) this.#closeStartAttemptHandle(id);
    this.#adoptedRuntimes.clear();
  }

  #neutralizeChildCallbacks(): void {
    for (const child of this.#children.values()) {
      child.removeAllListeners("exit");
      child.removeAllListeners("error");
      child.on("error", () => { /* closed drivers never touch control state */ });
    }
    this.#children.clear();
  }

  getScope(id: ScopeId): LookupOutcome<Scope> { const resource = this.#store.getResource("scope", id); return resource ? { outcome: "found", resource } : { outcome: "notFound" }; }
  listScopes(): Page<Scope> { return { items: this.#bootstrapScopeIds.map((id) => this.#store.getResource("scope", id)).filter((item): item is Scope => item !== undefined) }; }
  getCapabilities(): Capabilities { return this.#capabilities; }
  getStorageCapabilities(): StorageCapabilities | undefined { return this.#capabilities.storage; }

  async createWorkspace(request: WorkspaceCreate & { readonly id?: WorkspaceId }): Promise<CreateOutcome<Workspace>> {
    if (!this.#store.getResource("scope", request.scopeId)) return { outcome: "notFound", resourceKind: "scope" };
    const id = request.id ?? opaque("ws", this.#random);
    if (this.#store.identifierWasIssued("workspace", id)) return { outcome: "alreadyIssued" };
    const admission = await this.#reserveAdmission("workspace", id, request);
    if (admission.outcome === "denied") return { outcome: "admissionDenied", reason: admission.reason, ...(admission.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: admission.retryAfterSeconds }) };
    let accepted = false;
    try {
      const result = this.#createWorkspace({ ...request, id });
      accepted = result.outcome === "created";
      if (accepted) await this.#admissionLedger.commitAdmission(admission.reservationToken);
      else await this.#admissionLedger.releaseAdmission(admission.reservationToken);
      return result;
    } catch (error) {
      if (accepted) await this.#admissionLedger.commitAdmission(admission.reservationToken);
      else await this.#admissionLedger.releaseAdmission(admission.reservationToken);
      throw error;
    }
  }
  #createWorkspace(request: WorkspaceCreate & { readonly id: WorkspaceId }): CreateOutcome<Workspace> {
    const id = request.id;
    const stagingPath = this.#ownedPath(this.#workspaceRoot, hashedComponent("stage", opaque("workspace", this.#random)));
    this.#preparePrivateDirectory(stagingPath);
    const at = iso(this.#now);
    const created = this.#store.createResourceWithEvent({ kind: "workspace", value: { id, scopeId: request.scopeId, displayName: request.displayName, capacityBytes: request.capacityBytes, retention: request.retention, phase: "Provisioning", attachmentCount: 0, conditions: [], createdAt: at, updatedAt: at }, event: this.#eventDraft("Provisioning") });
    if (created.outcome === "alreadyIssued") { rmSync(stagingPath, { recursive: true, force: true }); return created; }
    renameSync(stagingPath, this.#workspacePath(id));
    const ready = this.#store.compareAndSwapResourceWithEvent({ kind: "workspace", id, expectedRevision: created.resource.revision, value: { ...created.resource, phase: "Ready", updatedAt: iso(this.#now) }, event: this.#eventDraft("Ready") });
    return ready.outcome === "updated" ? { outcome: "created", resource: ready.resource } : { outcome: "invalidState", reason: "WorkspacePreparationAuthorityLost" };
  }
  getWorkspace(id: WorkspaceId): LookupOutcome<Workspace> { const resource = this.#store.getResource("workspace", id); return resource ? { outcome: "found", resource } : { outcome: "notFound" }; }
  listWorkspaces(scopeId: ScopeId, pageCursor?: string): DriverResourcePage<Workspace> {
    const page = this.#store.listResources({ scopeId, kinds: ["workspace"], ...(pageCursor === undefined ? {} : { pageCursor }) });
    return { items: page.items as readonly Workspace[], highWaterCursor: page.highWaterCursor, ...(page.nextPageCursor === undefined ? {} : { nextCursor: page.nextPageCursor }) };
  }
  updateWorkspace(id: WorkspaceId, patch: WorkspacePatch, expectedRevision: Revision): MutationOutcome<Workspace> {
    const current = this.#store.getResource("workspace", id); if (!current) return { outcome: "notFound" };
    const at = iso(this.#now);
    if (current.revision !== expectedRevision) return { outcome: "revisionMismatch", currentRevision: current.revision };
    if (current.phase === "Deleting") return { outcome: "invalidState", reason: "WorkspaceDeleting" };
    if (current.phase === "Provisioning") return { outcome: "invalidState", reason: "WorkspaceTransitionInProgress" };
    return this.#store.compareAndSwapResourceWithEvent({ kind: "workspace", id, expectedRevision, value: { ...current, ...patch, updatedAt: at }, event: this.#eventDraft(current.phase) });
  }
  async deleteWorkspace(id: WorkspaceId, expectedRevision: Revision): Promise<DeleteOutcome> {
    const current = this.#store.getResource("workspace", id);
    if (!current) {
      const cleanup = this.#store.getBackendCleanup("workspace", id);
      if (!cleanup) return { outcome: "notFound" };
      if (!(await this.#retireAdmission(cleanup.scopeId, "workspace", id, ["create"]))) return { outcome: "invalidState", reason: "AdmissionReconciliationUnavailable" };
      if (cleanup.cleanupRequired && !cleanup.completed) {
        try { rmSync(this.#workspacePath(id), { recursive: true, force: true }); } catch { return { outcome: "deleted" }; }
      }
      this.#store.completeBackendCleanup("workspace", id);
      return { outcome: "deleted" };
    }
    if (current.revision !== expectedRevision) return { outcome: "revisionMismatch", currentRevision: current.revision };
    if (current.phase === "Provisioning") return { outcome: "invalidState", reason: "WorkspaceTransitionInProgress" };
    if (current.attachmentCount !== 0 || this.#workspaceHasRuntime(current.scopeId, id)) return { outcome: "invalidState", reason: "WorkspaceAttached" };
    let deleting = current;
    if (current.phase !== "Deleting") {
      const transitioned = this.#store.compareAndSwapResourceWithEvent({ kind: "workspace", id, expectedRevision, value: { ...current, phase: "Deleting", updatedAt: iso(this.#now) }, event: this.#eventDraft("Deleting") });
      if (transitioned.outcome !== "updated") return transitioned;
      deleting = transitioned.resource;
    }
    const deleted = this.#store.deleteResourceWithTombstoneAndEvent({ kind: "workspace", id, scopeId: current.scopeId, expectedRevision: deleting.revision, deletedAt: iso(this.#now), cleanupRequired: current.retention === "Delete", event: this.#eventDraft("Deleting") });
    if (deleted.outcome === "tombstoneCapacityExceeded") return deleted;
    if (deleted.outcome === "scopeMismatch") return { outcome: "invalidState", reason: "WorkspaceScopeAuthorityMismatch" };
    if (deleted.outcome === "notFound" && this.#store.getTombstone({ scopeId: current.scopeId, resourceKind: "workspace", resourceId: id })) {
      return await this.#retireAdmission(current.scopeId, "workspace", id, ["create"])
        ? { outcome: "deleted" }
        : { outcome: "invalidState", reason: "AdmissionReconciliationUnavailable" };
    }
    if (deleted.outcome !== "deleted") return deleted;
    if (!(await this.#retireAdmission(current.scopeId, "workspace", id, ["create"]))) return { outcome: "invalidState", reason: "AdmissionReconciliationUnavailable" };
    if (current.retention === "Delete") {
      try { rmSync(this.#workspacePath(id), { recursive: true, force: true }); }
      catch { return { outcome: "deleted" }; }
    }
    this.#store.completeBackendCleanup("workspace", id);
    return deleted;
  }

  async createRuntime(request: RuntimeCreate & { readonly id?: RuntimeId }): Promise<CreateOutcome<Runtime>> {
    const id = request.id ?? opaque("rt", this.#random);
    return await this.#serializeRuntime(id, async () => {
      if (!this.#store.getResource("scope", request.scopeId)) return { outcome: "notFound", resourceKind: "scope" };
      if (this.#store.identifierWasIssued("runtime", id)) return { outcome: "alreadyIssued" };
      const workspace = this.#store.getResource("workspace", request.workspaceId);
      if (!workspace || workspace.scopeId !== request.scopeId) return { outcome: "notFound", resourceKind: "workspace" };
      const admission = await this.#reserveAdmission("runtime", id, request);
      if (admission.outcome === "denied") return { outcome: "admissionDenied", reason: admission.reason, ...(admission.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: admission.retryAfterSeconds }) };
      let accepted = false;
      try {
        const result = await this.#createRuntime({ ...request, id });
        accepted = result.outcome === "created" || result.outcome === "fenceUncertain";
        if (accepted) await this.#admissionLedger.commitAdmission(admission.reservationToken);
        else await this.#admissionLedger.releaseAdmission(admission.reservationToken);
        return result;
      } catch (error) {
        if (accepted) await this.#admissionLedger.commitAdmission(admission.reservationToken);
        else await this.#admissionLedger.releaseAdmission(admission.reservationToken);
        throw error;
      }
    });
  }
  async #createRuntime(request: RuntimeCreate & { readonly id: RuntimeId }): Promise<CreateOutcome<Runtime>> {
    if (!this.#store.getResource("scope", request.scopeId)) return { outcome: "notFound", resourceKind: "scope" };
    const id = request.id;
    if (this.#store.identifierWasIssued("runtime", id)) return { outcome: "alreadyIssued" };
    const runtimePath = this.#runtimePath(id);
    const stagingPath = this.#runtimeStagingPath(id);
    const configuration: RuntimeConfiguration = { browserPolicy: request.browserPolicy, ...(request.idlePolicy === undefined ? {} : { idlePolicy: request.idlePolicy }) };
    const encodedConfiguration = JSON.stringify(configuration);
    if (statExists(stagingPath)) {
      try {
        this.#preparePrivateDirectory(stagingPath);
        if (readFileSync(join(stagingPath, "runtime-config.json"), "utf8") !== encodedConfiguration) return { outcome: "invalidState", reason: "ConflictingRuntimeCreateStaging" };
      } catch { return { outcome: "invalidState", reason: "UnsafeRuntimeCreateStaging" }; }
    } else {
      this.#preparePrivateDirectory(stagingPath);
      writeFileSync(join(stagingPath, "runtime-config.json"), encodedConfiguration, { mode: 0o600, flag: "wx" });
    }
    const at = iso(this.#now), generation = opaque("gen", this.#random, 16);
    const draft: Omit<Runtime, "revision"> = { id, scopeId: request.scopeId, displayName: request.displayName, workspaceId: request.workspaceId, hostProfileId: request.hostProfileId, desiredState: request.desiredState, phase: "Provisioning", generation, capabilities: [], conditions: [condition(FENCE_CONDITION, "True", "NoPriorWriter", at), condition(ROUTE_CONDITION, "False", "NotRunning", at)], createdAt: at, updatedAt: at };
    let created: ReturnType<PortableControlStore["createRuntimeWithWorkspaceAttachment"]>;
    const operationId = hashedComponent("op", id);
    for (;;) {
      const workspace = this.#store.getResource("workspace", request.workspaceId);
      if (!workspace || workspace.scopeId !== request.scopeId) return { outcome: "notFound", resourceKind: "workspace" };
      created = this.#store.createRuntimeWithWorkspaceAttachment({ value: draft, workspaceId: request.workspaceId, expectedWorkspaceRevision: workspace.revision, configurationIntent: { runtimeId: id, operationId, ...configuration }, runtimeEvent: this.#eventDraft("Provisioning"), workspaceEvent: this.#eventDraft(workspace.phase) });
      if (created.outcome !== "workspaceRevisionMismatch") break;
    }
    if (created.outcome === "alreadyIssued") return created;
    if (created.outcome === "workspaceNotFound") return { outcome: "notFound", resourceKind: "workspace" };
    if (created.outcome === "invalidState") return { outcome: "invalidState", reason: created.reason };
    renameSync(stagingPath, runtimePath);
    const phase: Phase = request.desiredState === "Running" ? "Pending" : request.desiredState === "Sleeping" ? "Sleeping" : "Stopped";
    const prepared = this.#casRuntime(created.resource, created.resource.revision, { phase });
    if (prepared.outcome !== "updated") return { outcome: "invalidState", reason: "RuntimePreparationAuthorityLost" };
    this.#fence.set(id, "NoPriorWriter");
    if (request.desiredState !== "Running") {
      if (!this.#store.completeRuntimeConfigurationIntent(id, operationId)) return { outcome: "invalidState", reason: "ConfigurationCommitPendingRecovery" };
      return { outcome: "created", resource: prepared.resource };
    }
    const started = await this.#start(prepared.resource, prepared.resource.revision, true);
    return started.outcome === "updated" ? { outcome: "created", resource: started.resource } : started.outcome === "fenceUncertain" ? started : { outcome: "invalidState", reason: started.outcome };
  }
  getRuntime(id: RuntimeId): LookupOutcome<Runtime> { const resource = this.#store.getResource("runtime", id); return resource ? { outcome: "found", resource } : { outcome: "notFound" }; }
  listRuntimes(scopeId: ScopeId, pageCursor?: string): DriverResourcePage<Runtime> {
    const page = this.#store.listResources({ scopeId, kinds: ["runtime"], ...(pageCursor === undefined ? {} : { pageCursor }) });
    return { items: page.items as readonly Runtime[], highWaterCursor: page.highWaterCursor, ...(page.nextPageCursor === undefined ? {} : { nextCursor: page.nextPageCursor }) };
  }
  async updateRuntime(id: RuntimeId, patch: Omit<RuntimePatch, "desiredState">, expectedRevision: Revision): Promise<MutationOutcome<Runtime>> {
    return this.#serializeRuntime(id, () => this.#updateRuntime(id, patch, expectedRevision));
  }
  async #updateRuntime(id: RuntimeId, patch: Omit<RuntimePatch, "desiredState">, expectedRevision: Revision): Promise<MutationOutcome<Runtime>> {
    const current = this.#store.getResource("runtime", id); if (!current) return { outcome: "notFound" };
    if (current.revision !== expectedRevision) return { outcome: "revisionMismatch", currentRevision: current.revision };
    if (current.phase === "Deleting" || current.phase === "Pending" || current.phase === "Provisioning" || current.phase === "Starting" || current.phase === "Unavailable" || fencedUncertain(current)) return { outcome: "invalidState", reason: current.phase === "Deleting" ? "RuntimeDeleting" : fencedUncertain(current) ? "ManualFenceRecoveryRequired" : "RuntimeTransitionInProgress" };
    let configuration: RuntimeConfiguration;
    try { configuration = this.#readConfiguration(id); }
    catch { return { outcome: "invalidState", reason: "ConfigurationReadFailed" }; }
    const browserAdmission = patch.browserPolicy === "Allowed" && configuration.browserPolicy !== "Allowed"
      ? await this.#reserveAdmission("runtime", id, { scopeId: current.scopeId, desiredState: current.desiredState, browserPolicy: "Allowed" }, "enableBrowser")
      : undefined;
    if (browserAdmission?.outcome === "denied") return { outcome: "admissionDenied", reason: browserAdmission.reason, ...(browserAdmission.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: browserAdmission.retryAfterSeconds }) };
    const result = await this.#applyRuntimeUpdate(id, patch, expectedRevision, current, configuration);
    if (browserAdmission?.outcome === "admitted") {
      if (result.outcome === "updated" || result.outcome === "fenceUncertain" || result.outcome === "invalidState" && result.reason === "ConfigurationCommitPendingRecovery")
        await this.#admissionLedger.commitAdmission(browserAdmission.reservationToken);
      else
        await this.#admissionLedger.releaseAdmission(browserAdmission.reservationToken);
    }
    const accepted = result.outcome === "updated" || result.outcome === "fenceUncertain" || result.outcome === "invalidState" && result.reason === "ConfigurationCommitPendingRecovery";
    if (patch.browserPolicy === "Disabled" && accepted && !(await this.#retireAdmission(current.scopeId, "runtime", id, ["enableBrowser"])))
      return { outcome: "invalidState", reason: "AdmissionReconciliationUnavailable" };
    return result;
  }
  async #applyRuntimeUpdate(id: RuntimeId, patch: Omit<RuntimePatch, "desiredState">, expectedRevision: Revision, current: Runtime, configuration: RuntimeConfiguration): Promise<MutationOutcome<Runtime>> {
    const { browserPolicy, idlePolicy, ...resourcePatch } = patch;
    const nextIdlePolicy = idlePolicy ?? configuration.idlePolicy;
    const nextConfiguration: RuntimeConfiguration = { browserPolicy: browserPolicy ?? configuration.browserPolicy, ...(nextIdlePolicy === undefined ? {} : { idlePolicy: nextIdlePolicy }) };
    const configurationChanged = nextConfiguration.browserPolicy !== configuration.browserPolicy || JSON.stringify(nextConfiguration.idlePolicy) !== JSON.stringify(configuration.idlePolicy);
    const operationId = opaque("op", this.#random);
    let stagedConfiguration: string | undefined;
    if (configurationChanged) {
      try { stagedConfiguration = this.#stageConfiguration(id, operationId, nextConfiguration); }
      catch { return { outcome: "invalidState", reason: "ConfigurationStageFailed" }; }
    }
    const changes = configurationChanged
      ? { ...resourcePatch, phase: "Unavailable" as const, conditions: replaceCondition(current.conditions, condition(ROUTE_CONDITION, "False", "ConfigurationReplacement", iso(this.#now))) }
      : resourcePatch;
    const nextRuntime = { ...current, ...changes, updatedAt: iso(this.#now) };
    const result = configurationChanged
      ? this.#store.compareAndSwapRuntimeWithConfigurationIntent({ id, expectedRevision, value: nextRuntime, event: this.#eventDraft("phase" in changes && changes.phase !== undefined ? changes.phase : current.phase), intent: { runtimeId: id, operationId, ...nextConfiguration } })
      : this.#store.compareAndSwapResourceWithEvent({ kind: "runtime", id, expectedRevision, value: nextRuntime, event: this.#eventDraft("phase" in changes && changes.phase !== undefined ? changes.phase : current.phase) });
    if (result.outcome !== "updated") {
      if (stagedConfiguration) rmSync(stagedConfiguration, { force: true });
      return result.outcome === "intentExists" ? { outcome: "invalidState", reason: "ConfigurationIntentPending" } : result;
    }
    if (!configurationChanged || !stagedConfiguration) return result;
    try {
      this.#commitConfiguration(id, stagedConfiguration);
    } catch {
      return { outcome: "invalidState", reason: "ConfigurationCommitPendingRecovery" };
    }
    if (current.desiredState !== "Running") {
      const terminal = this.#casRuntime(result.resource, result.resource.revision, { phase: current.phase });
      if (terminal.outcome === "updated") this.#store.completeRuntimeConfigurationIntent(id, operationId);
      return terminal;
    }
    if (!(await this.#drainAndFence(result.resource))) return this.#markFenceUncertain(result.resource);
    const restarted = await this.#start(result.resource, result.resource.revision, false);
    if (restarted.outcome === "updated" && restarted.resource.phase === "Ready") this.#store.completeRuntimeConfigurationIntent(id, operationId);
    return restarted;
  }

  async setRuntimeDesiredState(id: RuntimeId, desiredState: DesiredState, expectedRevision: Revision): Promise<MutationOutcome<Runtime>> {
    return this.#serializeRuntime(id, () => this.#setRuntimeDesiredState(id, desiredState, expectedRevision));
  }
  async #setRuntimeDesiredState(id: RuntimeId, desiredState: DesiredState, expectedRevision: Revision): Promise<MutationOutcome<Runtime>> {
    const current = this.#store.getResource("runtime", id); if (!current) return { outcome: "notFound" };
    if (current.revision !== expectedRevision) return { outcome: "revisionMismatch", currentRevision: current.revision };
    if (current.phase === "Deleting") return { outcome: "invalidState", reason: "RuntimeDeleting" };
    if (fencedUncertain(current)) return { outcome: "invalidState", reason: "ManualFenceRecoveryRequired" };
    if (current.desiredState === desiredState && desiredState === "Running" && current.phase === "Ready") {
      const locallyOwned = this.#children.has(id) || this.#adoptedRuntimes.has(id);
      return locallyOwned && this.#runtimeLocallyAlive(current) ? { outcome: "updated", resource: current } : this.#adoptOrReplace(current);
    }
    if (current.desiredState === desiredState && ((desiredState === "Sleeping" && current.phase === "Sleeping") || (desiredState === "Stopped" && current.phase === "Stopped"))) {
      if (!(await this.#retireAdmission(current.scopeId, "runtime", id, ["activate"]))) return { outcome: "invalidState", reason: "AdmissionReconciliationUnavailable" };
      return { outcome: "updated", resource: current };
    }
    if (current.phase === "Provisioning") return { outcome: "invalidState", reason: "RuntimeTransitionInProgress" };
    if (current.phase === "Pending" && desiredState === "Running") return this.#start(current, current.revision, true);
    if (current.phase === "Starting" && desiredState === "Running") return this.#adoptOrReplace(current);
    if (current.phase === "Unavailable" && desiredState === "Running") {
      let backend: BackendRecord | undefined;
      try { backend = this.#readBackend(current.id); } catch { return this.#markFenceUncertain(current); }
      const claimed = this.#casRuntime(current, current.revision, { phase: "Unavailable", conditions: replaceCondition(current.conditions, condition(ROUTE_CONDITION, "False", "UnavailableRecoveryDraining", iso(this.#now))) });
      if (claimed.outcome !== "updated") return claimed;
      if (!(await this.#drainAndFence(claimed.resource, undefined, undefined, backend))) return this.#markFenceUncertain(claimed.resource);
      return this.#start(claimed.resource, claimed.resource.revision, false);
    }
    if (desiredState === "Running") {
      const admission = await this.#reserveAdmission("runtime", id, { scopeId: current.scopeId, desiredState: "Running", browserPolicy: "Disabled" }, "activate");
      if (admission.outcome === "denied") return { outcome: "admissionDenied", reason: admission.reason, ...(admission.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: admission.retryAfterSeconds }) };
      try {
        const pending = this.#casRuntime(current, expectedRevision, { desiredState: "Running", phase: "Pending", conditions: replaceCondition(current.conditions, condition(ROUTE_CONDITION, "False", "WakePending", iso(this.#now))) });
        if (pending.outcome !== "updated") {
          await this.#admissionLedger.releaseAdmission(admission.reservationToken);
          return pending;
        }
        const started = await this.#start(pending.resource, pending.resource.revision, false);
        if (started.outcome === "updated" || started.outcome === "fenceUncertain") await this.#admissionLedger.commitAdmission(admission.reservationToken);
        else await this.#admissionLedger.releaseAdmission(admission.reservationToken);
        return started;
      } catch (error) {
        await this.#admissionLedger.commitAdmission(admission.reservationToken);
        throw error;
      }
    }
    const targetPhase: Phase = desiredState === "Sleeping" ? "Sleeping" : "Stopped";
    const draining = this.#casRuntime(current, expectedRevision, { desiredState, phase: "Unavailable", conditions: replaceCondition(current.conditions, condition(ROUTE_CONDITION, "False", "RouteDraining", iso(this.#now))) });
    if (draining.outcome !== "updated") return draining;
    const fence = await this.#drainAndFence(draining.resource);
    if (!fence) return this.#markFenceUncertain(draining.resource);
    const terminal = this.#casRuntime(draining.resource, draining.resource.revision, { phase: targetPhase, conditions: replaceCondition(draining.resource.conditions, condition(FENCE_CONDITION, "True", "FenceProven", iso(this.#now))) });
    if (terminal.outcome === "updated" && !(await this.#retireAdmission(current.scopeId, "runtime", id, ["activate"])))
      return { outcome: "invalidState", reason: "AdmissionReconciliationUnavailable" };
    return terminal;
  }

  async recoverRuntimeFence(id: RuntimeId, expectedRevision: Revision): Promise<MutationOutcome<Runtime>> {
    return this.#serializeRuntime(id, () => this.#recoverRuntimeFence(id, expectedRevision));
  }
  async #recoverRuntimeFence(id: RuntimeId, expectedRevision: Revision): Promise<MutationOutcome<Runtime>> {
    const current = this.#store.getResource("runtime", id); if (!current) return { outcome: "notFound" };
    if (current.revision !== expectedRevision) return { outcome: "revisionMismatch", currentRevision: current.revision };
    if (!fencedUncertain(current)) return { outcome: "invalidState", reason: "FenceRecoveryNotRequired" };
    const claimed = this.#casRuntime(current, expectedRevision, { conditions: replaceCondition(current.conditions, condition(FENCE_CONDITION, "False", "ManualFenceRecoveryInProgress", iso(this.#now))) });
    if (claimed.outcome !== "updated") return claimed;
    if (!(await this.#proveFence(claimed.resource))) return this.#markFenceUncertain(claimed.resource);
    const phase: Phase = current.desiredState === "Sleeping" ? "Sleeping" : "Stopped";
    return this.#casRuntime(claimed.resource, claimed.resource.revision, { phase, conditions: replaceCondition(claimed.resource.conditions, condition(FENCE_CONDITION, "True", "ManualFenceRecovery", iso(this.#now))) });
  }
  async deleteRuntime(id: RuntimeId, expectedRevision: Revision): Promise<DeleteOutcome> {
    return this.#serializeRuntime(id, async () => {
      const current = this.#store.getResource("runtime", id);
      if (!current) {
        const cleanup = this.#store.getBackendCleanup("runtime", id);
        if (!cleanup) return { outcome: "notFound" };
        if (!(await this.#retireAdmission(cleanup.scopeId, "runtime", id, ["create", "activate", "enableBrowser"]))) return { outcome: "invalidState", reason: "AdmissionReconciliationUnavailable" };
        if (!cleanup.completed) {
          try { rmSync(this.#runtimePath(id), { recursive: true, force: true }); } catch { return { outcome: "deleted" };
          }
        }
        this.#store.completeBackendCleanup("runtime", id);
        return { outcome: "deleted" };
      }
      return this.#deleteRuntime(id, expectedRevision);
    });
  }
  async #deleteRuntime(id: RuntimeId, expectedRevision: Revision): Promise<DeleteOutcome> {
    const current = this.#store.getResource("runtime", id); if (!current) return { outcome: "notFound" };
    if (current.revision !== expectedRevision) return { outcome: "revisionMismatch", currentRevision: current.revision };
    if (fencedUncertain(current)) return { outcome: "invalidState", reason: "ManualFenceRecoveryRequired" };
    let deleting = current;
    if (current.phase !== "Deleting") {
      const transitioned = this.#casRuntime(current, expectedRevision, { phase: "Deleting", conditions: replaceCondition(current.conditions, condition(ROUTE_CONDITION, "False", "RouteDraining", iso(this.#now))) });
      if (transitioned.outcome !== "updated") return transitioned;
      deleting = transitioned.resource;
    }
    if (!(await this.#drainAndFence(deleting))) {
      const uncertain = this.#markFenceUncertain(deleting);
      return uncertain.outcome === "fenceUncertain" ? uncertain : uncertain.outcome === "revisionMismatch" ? uncertain : uncertain.outcome === "notFound" ? uncertain : { outcome: "invalidState", reason: "FenceUncertainProjectionFailed" };
    }
    const finalized = this.#store.finalizeRuntimeDeletion({ runtimeId: id, expectedRevision: deleting.revision, deletedAt: iso(this.#now), runtimeEvent: this.#eventDraft("Deleting"), workspaceEvent: this.#eventDraft("Ready") });
    if (finalized.outcome === "tombstoneCapacityExceeded") return finalized;
    if (finalized.outcome === "invalidState") return { outcome: "invalidState", reason: finalized.reason };
    if (finalized.outcome === "notFound" && this.#store.getTombstone({ scopeId: current.scopeId, resourceKind: "runtime", resourceId: id })) {
      return await this.#retireAdmission(current.scopeId, "runtime", id, ["create", "activate", "enableBrowser"])
        ? { outcome: "deleted" }
        : { outcome: "invalidState", reason: "AdmissionReconciliationUnavailable" };
    }
    if (finalized.outcome !== "deleted") return finalized;
    if (!(await this.#retireAdmission(current.scopeId, "runtime", id, ["create", "activate", "enableBrowser"])))
      return { outcome: "invalidState", reason: "AdmissionReconciliationUnavailable" };
    try {
      rmSync(this.#runtimePath(id), { recursive: true, force: true });
      this.#store.completeBackendCleanup("runtime", id);
    } catch { /* tombstone and pending cleanup remain authoritative */ }
    return finalized;
  }

  resolveRuntimeRoute(runtimeId: RuntimeId, kind: RouteKind, generation: Generation): RouteOutcome {
    if (!ROUTE_KINDS.includes(kind)) return { outcome: "unsupported" };
    const runtime = this.#store.getResource("runtime", runtimeId); if (!runtime) return { outcome: "notFound" };
    if (generation !== runtime.generation) return { outcome: "staleGeneration" };
    if (fencedUncertain(runtime)) return { outcome: "fenceUncertain" };
    if (runtime.phase !== "Ready" || runtime.desiredState !== "Running") return { outcome: "notReady" };
    if (!this.#children.has(runtimeId) && !this.#adoptedRuntimes.has(runtimeId)) return { outcome: "notReady" };
    const backend = this.#readBackend(runtimeId);
    if (!backend || backend.generation !== runtime.generation || !processGroupAlive(backend.pid)) return { outcome: "notReady" };
    const reference = backend.routeReferences[kind]; if (!reference) return { outcome: "unsupported" };
    return { outcome: "resolved", route: { kind, reference }, generation: runtime.generation };
  }
  listInfrastructureEvents(scopeId: ScopeId, cursor: string, limit?: number): EventReadOutcome { return this.#store.readAfter({ scopeId, cursor, ...(limit === undefined ? {} : { limit }) }); }
  watchInfrastructureEvents(scopeId: ScopeId, cursor: string, signal?: AbortSignal) { return this.#store.subscribe({ scopeId, cursor, ...(signal === undefined ? {} : { signal }) }); }

  async #adoptOrReplace(current: Runtime): Promise<MutationOutcome<Runtime>> {
    const attempt = this.#store.getRuntimeStartAttempt(current.id);
    if (attempt && attempt.revision === current.revision && attempt.generation === current.generation) {
      const attemptPath = this.#startAttemptPath(current.id, attempt.generation);
      if (this.#startAttemptOwnedByOther(attemptPath)) return { outcome: "invalidState", reason: "StartAttemptInProgress" };
    }
    const backend = this.#readBackend(current.id);
    if (backend && backend.generation === current.generation && processGroupAlive(backend.pid)) {
      const credentialPath = join(this.#runtimePath(current.id), backend.credentialName);
      const configuration = this.#readConfiguration(current.id);
      const context: RuntimeLaunchContext = { runtimeId: current.id, generation: current.generation, ...configuration, workspacePath: this.#workspacePath(current.workspaceId), runtimeStatePath: this.#runtimePath(current.id), generationCredentialPath: credentialPath };
      const spec = this.#launch(current, context);
      const deadline = Date.now() + this.#readinessTimeout;
      while (Date.now() <= deadline && processGroupAlive(backend.pid)) {
        const observation = await spec.readinessProbe(context);
        if (observation && observation.runtimeGeneration === current.generation && observation.storageReady && observation.exclusiveWriterLeaseHeld && observation.internalGenerationAuthenticationReady && observation.hostReady && observation.ompAuthorityReady && observation.cmuxProtocol10Ready && observation.requiredBrowserReady && statExists(credentialPath)) {
          this.#adoptedRuntimes.add(current.id);
          this.#monitorAdoptedRuntime(current.id, current.generation, backend.pid);
          if (current.phase !== "Ready") {
            const published = this.#casRuntime(current, current.revision, { phase: "Ready", conditions: replaceCondition(current.conditions, condition(ROUTE_CONDITION, "True", "CompleteReadiness", iso(this.#now))) });
            if (published.outcome !== "updated") return published;
            this.#releaseCurrentStartAttempt(current.id);
            return published;
          }
          this.#releaseCurrentStartAttempt(current.id);
          return { outcome: "updated", resource: current };
        }
        await sleep(25);
      }
    }
    const draining = this.#casRuntime(current, current.revision, { phase: "Unavailable", conditions: replaceCondition(current.conditions, condition(ROUTE_CONDITION, "False", "AdoptionReadinessFailed", iso(this.#now))) });
    if (draining.outcome !== "updated") return draining;
    if (!(await this.#drainAndFence(draining.resource))) return this.#markFenceUncertain(draining.resource);
    return this.#start(draining.resource, draining.resource.revision, false);
  }

  async #start(current: Runtime, expectedRevision: Revision, noPriorWriter: boolean): Promise<MutationOutcome<Runtime>> {
    if (fencedUncertain(current)) return { outcome: "invalidState", reason: "ManualFenceRecoveryRequired" };
    try {
      this.#preparePrivateDirectory(this.#workspacePath(current.workspaceId));
      this.#preparePrivateDirectory(this.#runtimePath(current.id));
    } catch {
      return { outcome: "invalidState", reason: "UnsafeLocalState" };
    }
    const generation = opaque("gen", this.#random, 16), at = iso(this.#now), attemptToken = opaque("attempt", this.#random);
    const advancing = this.#store.compareAndSwapRuntimeWithStartAttempt({
      id: current.id,
      expectedRevision,
      value: { ...current, desiredState: "Running", phase: "Starting", generation, conditions: [condition(FENCE_CONDITION, "True", noPriorWriter ? "NoPriorWriter" : "FenceProven", at), condition(ROUTE_CONDITION, "False", "ReadinessPending", at)], updatedAt: at },
      event: this.#eventDraft("Starting"),
      generation,
      token: attemptToken,
    });
    if (advancing.outcome !== "updated") return advancing.outcome === "attemptExists" ? { outcome: "invalidState", reason: "StartAttemptInProgress" } : advancing;
    const runtime = advancing.resource, workspacePath = this.#workspacePath(runtime.workspaceId), runtimeStatePath = this.#runtimePath(runtime.id);
    const attemptPath = this.#startAttemptPath(runtime.id, generation);
    try {
      const handle = openSync(attemptPath, "wx", 0o600);
      writeFileSync(handle, attemptToken);
      this.#attemptHandles.set(runtime.id, handle);
      START_AUTHORITY_OWNERS.set(attemptPath, this.#startAuthorityOwner);
    } catch {
      this.#releaseStartAttempt(runtime.id, runtime.revision, attemptToken, attemptPath);
      return this.#markFenceUncertain(runtime);
    }
    const leaseToken = opaque("lease", this.#random), credentialName = this.#generationCredentialName(generation);
    const leaseAcquired = noPriorWriter ? this.#acquireWriterLease(runtime.id, leaseToken) : this.#replaceWriterLease(runtime.id, leaseToken);
    if (!leaseAcquired) { this.#releaseStartAttempt(runtime.id, runtime.revision, attemptToken, attemptPath); return this.#markFenceUncertain(runtime); }
    const credentialPath = join(runtimeStatePath, credentialName);
    let context: RuntimeLaunchContext;
    let spec: RuntimeLaunchSpec;
    try {
      writeFileSync(credentialPath, Buffer.from(this.#random(32)).toString("base64url"), { mode: 0o600, flag: "wx" });
      const runtimeConfiguration = this.#readConfiguration(runtime.id);
      context = { runtimeId: runtime.id, generation, ...runtimeConfiguration, workspacePath, runtimeStatePath, generationCredentialPath: credentialPath };
      spec = this.#launch(runtime, context);
      if (!spec.executable || !resolve(spec.executable).startsWith(sep)) throw new Error("unsafe runtime executable");
    } catch {
      try { this.#revokeCredential(credentialPath); } catch { /* uncertainty is projected below */ }
      this.#releaseStartAttempt(runtime.id, runtime.revision, attemptToken, attemptPath);
      return this.#markFenceUncertain(runtime);
    }
    const authoritative = this.#store.getResource("runtime", runtime.id);
    const attempt = this.#store.getRuntimeStartAttempt(runtime.id);
    if (!authoritative || authoritative.revision !== runtime.revision || authoritative.generation !== generation || !attempt || attempt.revision !== runtime.revision || attempt.generation !== generation || attempt.token !== attemptToken) {
      this.#revokeCredential(credentialPath);
      this.#releaseStartAttempt(runtime.id, runtime.revision, attemptToken, attemptPath);
      return authoritative ? { outcome: "revisionMismatch", currentRevision: authoritative.revision } : { outcome: "notFound" };
    }
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [PROCESS_BOOTSTRAP, spec.executable, ...(spec.arguments ?? [])], { cwd: workspacePath, env: { ...exactChildEnvironment(spec.environment), T4_RUNTIME_ID: runtime.id, T4_RUNTIME_GENERATION: generation, T4_RUNTIME_STATE_ROOT: runtimeStatePath, T4_GENERATION_CREDENTIAL: credentialPath }, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], shell: false });
    } catch { this.#revokeCredential(credentialPath); this.#releaseStartAttempt(runtime.id, runtime.revision, attemptToken, attemptPath); return this.#markFenceUncertain(runtime); }
    if (!child.pid) { this.#revokeCredential(credentialPath); this.#releaseStartAttempt(runtime.id, runtime.revision, attemptToken, attemptPath); return this.#markFenceUncertain(runtime); }
    const handleChildLoss = (): void => {
      if (this.#children.get(runtime.id) !== child) return;
      this.#children.delete(runtime.id);
      this.#scheduleUnexpectedLoss(runtime.id, generation, spec, context);
    };
    child.once("error", handleChildLoss);
    const routeReferences: Partial<Record<RouteKind, string>> = {};
    for (const kind of new Set(spec.routeKinds)) { if (!ROUTE_KINDS.includes(kind)) continue; routeReferences[kind] = opaque("route", this.#random, 24); }
    const backendRecord: BackendRecord = { version: 1, runtimeId: runtime.id, generation, pid: child.pid, leaseToken, credentialName, routeReferences, launchedAt: at };
    try {
      this.#writeBackend(runtime.id, backendRecord);
    } catch {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* wrapper may already be gone */ }
      this.#revokeCredential(credentialPath);
      this.#releaseStartAttempt(runtime.id, runtime.revision, attemptToken, attemptPath);
      return this.#markFenceUncertain(runtime);
    }
    const delivery = Promise.withResolvers<void>();
    child.send("start", (error) => error ? delivery.reject(error) : delivery.resolve());
    try { await delivery.promise; } catch {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* wrapper may already be gone */ }
      this.#revokeCredential(credentialPath);
      this.#releaseStartAttempt(runtime.id, runtime.revision, attemptToken, attemptPath);
      return this.#markFenceUncertain(runtime);
    }
    child.disconnect();
    child.unref();
    this.#children.set(runtime.id, child);
    child.once("exit", handleChildLoss);
    const deadline = Date.now() + this.#readinessTimeout;
    let ready = false;
    while (Date.now() <= deadline && processGroupAlive(child.pid)) {
      let observation: CompleteReadiness | undefined;
      try { observation = await spec.readinessProbe(context); } catch { break; }
      if (observation && observation.runtimeGeneration === generation && observation.storageReady && observation.exclusiveWriterLeaseHeld && observation.internalGenerationAuthenticationReady && observation.hostReady && observation.ompAuthorityReady && observation.cmuxProtocol10Ready && observation.requiredBrowserReady) { ready = true; break; }
      await sleep(25);
    }
    if (!ready || !processGroupAlive(child.pid)) {
      const draining = this.#casRuntime(runtime, runtime.revision, { phase: "Unavailable", conditions: replaceCondition(runtime.conditions, condition(ROUTE_CONDITION, "False", "ReadinessFailed", iso(this.#now))) });
      if (draining.outcome !== "updated") return draining;
      if (!(await this.#drainAndFence(draining.resource, spec, context, backendRecord))) return this.#markFenceUncertain(draining.resource);
      return { outcome: "updated", resource: draining.resource };
    }
    const published = this.#casRuntime(runtime, runtime.revision, { phase: "Ready", conditions: replaceCondition(runtime.conditions, condition(ROUTE_CONDITION, "True", "CompleteReadiness", iso(this.#now))) });
    if (published.outcome === "updated") {
      this.#releaseStartAttempt(runtime.id, runtime.revision, attemptToken, attemptPath);
      const configurationIntent = this.#store.getRuntimeConfigurationIntent(runtime.id);
      if (configurationIntent) this.#store.completeRuntimeConfigurationIntent(runtime.id, configurationIntent.operationId);
      return published;
    }
    const observed = this.#store.getResource("runtime", runtime.id);
    if (observed && observed.generation === generation && (observed.phase === "Ready" || observed.phase === "Starting")) {
      const draining = this.#casRuntime(observed, observed.revision, { phase: "Unavailable", conditions: replaceCondition(observed.conditions, condition(ROUTE_CONDITION, "False", "ReadyPublicationConflict", iso(this.#now))) });
      if (draining.outcome === "updated" && !(await this.#drainAndFence(draining.resource, spec, context, backendRecord))) this.#markFenceUncertain(draining.resource);
    }
    return published;
  }

  async #drainAndFence(runtime: Runtime, suppliedSpec?: RuntimeLaunchSpec, suppliedContext?: RuntimeLaunchContext, expectedBackend?: BackendRecord): Promise<boolean> {
    const authority = this.#store.getResource("runtime", runtime.id);
    if (!authority || authority.revision !== runtime.revision || authority.generation !== runtime.generation || !authority.conditions.some((item) => item.type === ROUTE_CONDITION && item.status === "False")) {
      this.#fence.set(runtime.id, "FenceUncertain");
      return false;
    }
    this.#fence.set(runtime.id, "DrainRequired");
    let backend: BackendRecord | undefined;
    try {
      this.#preparePrivateDirectory(this.#runtimePath(runtime.id));
      backend = this.#readBackend(runtime.id);
    } catch {
      this.#fence.set(runtime.id, "FenceUncertain");
      return false;
    }
    if (expectedBackend && (!backend || backend.generation !== expectedBackend.generation || backend.pid !== expectedBackend.pid || backend.credentialName !== expectedBackend.credentialName || backend.leaseToken !== expectedBackend.leaseToken)) {
      this.#fence.set(runtime.id, "FenceUncertain");
      return false;
    }
    const startAttempt = this.#store.getRuntimeStartAttempt(runtime.id);
    const confirmedAuthority = this.#store.getResource("runtime", runtime.id);
    const confirmedAttempt = this.#store.getRuntimeStartAttempt(runtime.id);
    const attemptChanged = startAttempt
      ? !confirmedAttempt || confirmedAttempt.revision !== startAttempt.revision || confirmedAttempt.generation !== startAttempt.generation || confirmedAttempt.token !== startAttempt.token
      : confirmedAttempt !== undefined;
    if (!confirmedAuthority || confirmedAuthority.revision !== runtime.revision || confirmedAuthority.generation !== runtime.generation || attemptChanged || (startAttempt !== undefined && startAttempt.generation !== runtime.generation)) {
      this.#fence.set(runtime.id, "FenceUncertain");
      return false;
    }
    const startAttemptPath = startAttempt ? this.#startAttemptPath(runtime.id, startAttempt.generation) : undefined;
    const foreignStartAuthority = startAttemptPath !== undefined && this.#startAttemptOwnedByOther(startAttemptPath);
    this.#closeStartAttemptHandle(runtime.id);
    let revocationCertain = true;
    if (startAttempt) {
      try { this.#store.revokeTickets({ cause: "runtimeGenerationReplacement", scopeId: runtime.scopeId, runtimeId: runtime.id, runtimeGeneration: startAttempt.generation }); } catch { revocationCertain = false; }
      try { this.#revokeCredential(join(this.#runtimePath(runtime.id), this.#generationCredentialName(startAttempt.generation))); } catch { revocationCertain = false; }
    }
    if (!backend) {
      this.#fence.set(runtime.id, "NoPriorWriter");
      const proven = revocationCertain && await this.#proveFence(runtime);
      if (proven && !foreignStartAuthority) this.#releaseCurrentStartAttempt(runtime.id);
      return proven;
    }
    let confirmedBackend: BackendRecord | undefined;
    try { confirmedBackend = this.#readBackend(runtime.id); } catch { confirmedBackend = undefined; }
    if (!confirmedBackend || confirmedBackend.generation !== backend.generation || confirmedBackend.pid !== backend.pid || confirmedBackend.credentialName !== backend.credentialName || confirmedBackend.leaseToken !== backend.leaseToken) {
      this.#fence.set(runtime.id, "FenceUncertain");
      return false;
    }
    const credentialPath = join(this.#runtimePath(runtime.id), backend.credentialName);
    try { this.#store.revokeTickets({ cause: "runtimeGenerationReplacement", scopeId: runtime.scopeId, runtimeId: runtime.id, runtimeGeneration: backend.generation }); } catch { revocationCertain = false; }
    try { this.#revokeCredential(credentialPath); } catch { revocationCertain = false; }
    this.#children.delete(runtime.id);
    const monitor = this.#adoptedMonitors.get(runtime.id);
    if (monitor) { clearInterval(monitor); this.#adoptedMonitors.delete(runtime.id); }
    let containmentProven = false;
    let spec = suppliedSpec;
    let context = suppliedContext;
    try {
      if (!context) {
        const runtimeConfiguration = this.#readConfiguration(runtime.id);
        context = { runtimeId: runtime.id, generation: backend.generation, ...runtimeConfiguration, workspacePath: this.#workspacePath(runtime.workspaceId), runtimeStatePath: this.#runtimePath(runtime.id), generationCredentialPath: credentialPath };
      }
      spec ??= this.#launch(runtime, context);
      try { await spec.closeConnections?.(context); } catch { /* process teardown remains mandatory */ }
      try { await spec.quiesce?.(context); } catch { /* process teardown remains mandatory */ }
      containmentProven = await spec.terminateAndProveFence(context, { processGroupId: backend.pid, graceMilliseconds: this.#shutdownGrace, killMilliseconds: this.#shutdownKill });
    } catch { containmentProven = false; }
    this.#fence.set(runtime.id, "ShutdownRequested");
    if (processGroupAlive(backend.pid)) { try { process.kill(-backend.pid, "SIGTERM"); } catch { /* observed below */ } }
    await this.#waitForGroupDeath(backend.pid, this.#shutdownGrace);
    if (processGroupAlive(backend.pid)) { try { process.kill(-backend.pid, "SIGKILL"); } catch { /* observed below */ } }
    await this.#waitForGroupDeath(backend.pid, this.#shutdownKill);
    this.#children.delete(runtime.id);
    this.#adoptedRuntimes.delete(runtime.id);
    this.#fence.set(runtime.id, "FenceVerifying");
    const proven = revocationCertain && containmentProven && await this.#proveFence(runtime);
    if (proven && !foreignStartAuthority) this.#releaseCurrentStartAttempt(runtime.id);
    return proven;
  }
  #monitorAdoptedRuntime(id: RuntimeId, generation: Generation, pid: number): void {
    clearInterval(this.#adoptedMonitors.get(id));
    const monitor = setInterval(() => {
      if (processGroupAlive(pid)) return;
      clearInterval(monitor);
      this.#adoptedMonitors.delete(id);
      this.#adoptedRuntimes.delete(id);
      this.#scheduleUnexpectedLoss(id, generation);
    }, 100);
    monitor.unref();
    this.#adoptedMonitors.set(id, monitor);
  }

  #scheduleUnexpectedLoss(id: RuntimeId, generation: Generation, spec?: RuntimeLaunchSpec, context?: RuntimeLaunchContext): void {
    if (this.#closed) return;
    void this.#serializeRuntime(id, async () => {
      const observed = this.#store.getResource("runtime", id);
      if (!observed || observed.generation !== generation || (observed.phase !== "Ready" && observed.phase !== "Starting")) return;
      const unavailable = this.#casRuntime(observed, observed.revision, { phase: "Unavailable", conditions: replaceCondition(observed.conditions, condition(ROUTE_CONDITION, "False", "ProcessExited", iso(this.#now))) });
      if (unavailable.outcome !== "updated") return;
      if (!(await this.#drainAndFence(unavailable.resource, spec, context))) {
        this.#markFenceUncertain(unavailable.resource);
        return;
      }
      if (unavailable.resource.desiredState === "Running") {
        await this.#start(unavailable.resource, unavailable.resource.revision, false);
        return;
      }
      const phase: Phase = unavailable.resource.desiredState === "Sleeping" ? "Sleeping" : "Stopped";
      this.#casRuntime(unavailable.resource, unavailable.resource.revision, { phase });
    }).catch(() => {
      if (this.#closed) return;
      const observed = this.#store.getResource("runtime", id);
      if (observed && observed.generation === generation && !fencedUncertain(observed)) this.#markFenceUncertain(observed);
    });
  }


  async #serializeRuntime<T>(id: RuntimeId, operation: () => Promise<T>): Promise<T> {
    if (this.#closed) throw new Error("LocalDriver is closed");
    const previous = this.#runtimeTails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const tail = previous.then(() => turn);
    this.#runtimeTails.set(id, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#runtimeTails.get(id) === tail) this.#runtimeTails.delete(id);
    }
  }

  async #proveFence(runtime: Runtime, reacquireLease = true): Promise<boolean> {
    const backend = this.#readBackend(runtime.id);
    if (backend && processGroupAlive(backend.pid)) {
      this.#fence.set(runtime.id, "FenceUncertain");
      return false;
    }
    const path = this.#runtimePath(runtime.id);
    if (!this.#noForeignOpenHandle(path)) {
      this.#fence.set(runtime.id, "FenceUncertain");
      return false;
    }
    if (reacquireLease) {
      const token = opaque("fence", this.#random);
      if (!this.#replaceWriterLease(runtime.id, token)) {
        this.#fence.set(runtime.id, "FenceUncertain");
        return false;
      }
    }
    this.#fence.set(runtime.id, backend ? "FenceProven" : "NoPriorWriter");
    return true;
  }
  #noForeignOpenHandle(path: string): boolean {
    const result = spawnSync(this.#lsof, ["-n", "-P", "-F", "p", "+D", path], { encoding: "utf8", timeout: Math.max(5000, this.#shutdownKill) });
    if (result.error || (result.status !== 0 && result.status !== 1)) return false;
    for (const line of result.stdout.split("\n")) if (line.startsWith("p") && Number(line.slice(1)) !== process.pid) return false;
    return true;
  }
  async #waitForGroupDeath(pid: number, timeout: number): Promise<void> { const deadline = Date.now() + timeout; while (Date.now() <= deadline && processGroupAlive(pid)) await sleep(20); }
  #markFenceUncertain(current: Runtime): MutationOutcome<Runtime> {
    this.#fence.set(current.id, "FenceUncertain");
    const at = iso(this.#now), conditions = replaceCondition(replaceCondition(current.conditions, condition(FENCE_CONDITION, "False", "FenceUncertain", at)), condition(ROUTE_CONDITION, "False", "FenceUncertain", at));
    const result = this.#casRuntime(current, current.revision, { phase: "Degraded", conditions });
    return result.outcome === "updated" ? { outcome: "fenceUncertain", resource: result.resource } : result;
  }
  #workspaceHasRuntime(scopeId: ScopeId, workspaceId: WorkspaceId): boolean {
    let pageCursor: string | undefined;
    do {
      const page = this.#store.listResources({ scopeId, kinds: ["runtime"], ...(pageCursor === undefined ? {} : { pageCursor }) });
      if (page.items.some((resource) => "workspaceId" in resource && resource.workspaceId === workspaceId)) return true;
      pageCursor = page.nextPageCursor;
    } while (pageCursor !== undefined);
    return false;
  }
  #runtimeLocallyAlive(runtime: Runtime): boolean {
    let backend: BackendRecord | undefined;
    try { backend = this.#readBackend(runtime.id); } catch { return false; }
    return backend !== undefined && backend.generation === runtime.generation && processGroupAlive(backend.pid) && statExists(join(this.#runtimePath(runtime.id), backend.credentialName));
  }
  #recoverConfigurationIntents(): void {
    for (const scopeId of this.#bootstrapScopeIds) {
      let pageCursor: string | undefined;
      do {
        const page = this.#store.listResources({ scopeId, kinds: ["runtime"], ...(pageCursor === undefined ? {} : { pageCursor }) });
        for (const resource of page.items) {
          if (!("workspaceId" in resource)) continue;
          const runtime = resource as Runtime;
          const intent: RuntimeConfigurationIntent | undefined = this.#store.getRuntimeConfigurationIntent(runtime.id);
          if (intent) {
            const configuration: RuntimeConfiguration = { browserPolicy: intent.browserPolicy, ...(intent.idlePolicy === undefined ? {} : { idlePolicy: intent.idlePolicy }) };
            const temporary = `${this.#configurationPath(runtime.id)}.${intent.operationId}`;
            try {
              this.#preparePrivateDirectory(this.#runtimePath(runtime.id));
              if (!statExists(temporary)) writeFileSync(temporary, JSON.stringify(configuration), { mode: 0o600, flag: "wx" });
              this.#commitConfiguration(runtime.id, temporary);
              rmSync(this.#runtimeStagingPath(runtime.id), { recursive: true, force: true });
              this.#scheduleConfigurationRecovery(runtime.id, intent.operationId);
            } catch { /* durable intent keeps this runtime blocked until recovery succeeds */ }
          }
          if (runtime.phase === "Provisioning" && !this.#store.getRuntimeConfigurationIntent(runtime.id)) {
            const phase: Phase = runtime.desiredState === "Running" ? "Pending" : runtime.desiredState === "Sleeping" ? "Sleeping" : "Stopped";
            this.#casRuntime(runtime, runtime.revision, { phase });
          }
        }
        pageCursor = page.nextPageCursor;
      } while (pageCursor !== undefined);
      let workspaceCursor: string | undefined;
      do {
        const workspaces = this.#store.listResources({ scopeId, kinds: ["workspace"], ...(workspaceCursor === undefined ? {} : { pageCursor: workspaceCursor }) });
        for (const resource of workspaces.items) {
          if (!("attachmentCount" in resource) || resource.phase !== "Provisioning") continue;
          try {
            this.#preparePrivateDirectory(this.#workspacePath(resource.id));
            this.#store.compareAndSwapResourceWithEvent({ kind: "workspace", id: resource.id, expectedRevision: resource.revision, value: { ...resource, phase: "Ready", updatedAt: iso(this.#now) }, event: this.#eventDraft("Ready") });
          } catch { /* provisioning remains visible until owned storage is safe */ }
        }
        workspaceCursor = workspaces.nextPageCursor;
      } while (workspaceCursor !== undefined);
    }
  }
  #scheduleConfigurationRecovery(id: RuntimeId, operationId: string): void {
    if (this.#closed) return;
    void this.#serializeRuntime(id, async () => {
      const intent = this.#store.getRuntimeConfigurationIntent(id);
      if (!intent || intent.operationId !== operationId) return;
      let current = this.#store.getResource("runtime", id);
      if (!current || fencedUncertain(current) || current.phase === "Deleting") return;
      if (current.phase === "Provisioning") {
        const phase: Phase = current.desiredState === "Running" ? "Pending" : current.desiredState === "Sleeping" ? "Sleeping" : "Stopped";
        const prepared = this.#casRuntime(current, current.revision, { phase });
        if (prepared.outcome !== "updated") return;
        current = prepared.resource;
      }
      if (current.desiredState === "Running") {
        if (current.phase === "Ready") {
          if (intent.browserPolicy === "Disabled" && !(await this.#retireAdmission(current.scopeId, "runtime", id, ["enableBrowser"]))) return;
          this.#store.completeRuntimeConfigurationIntent(id, operationId);
          return;
        }
        let converged: MutationOutcome<Runtime>;
        if (current.phase === "Starting") converged = await this.#adoptOrReplace(current);
        else if (current.phase === "Pending") converged = await this.#start(current, current.revision, true);
        else {
          let backend: BackendRecord | undefined;
          try { backend = this.#readBackend(current.id); } catch { this.#markFenceUncertain(current); return; }
          if (backend && backend.generation !== current.generation) { this.#markFenceUncertain(current); return; }
          const draining = this.#casRuntime(current, current.revision, { phase: "Unavailable", conditions: replaceCondition(current.conditions, condition(ROUTE_CONDITION, "False", "ConfigurationRecoveryDraining", iso(this.#now))) });
          if (draining.outcome !== "updated") return;
          current = draining.resource;
          if (!(await this.#drainAndFence(current, undefined, undefined, backend))) { this.#markFenceUncertain(current); return; }
          converged = await this.#start(current, current.revision, false);
        }
        if (converged.outcome === "updated" && converged.resource.phase === "Ready") {
          if (intent.browserPolicy === "Disabled" && !(await this.#retireAdmission(current.scopeId, "runtime", id, ["enableBrowser"]))) return;
          this.#store.completeRuntimeConfigurationIntent(id, operationId);
        }
        return;
      }
      if (current.phase !== "Sleeping" && current.phase !== "Stopped") {
        let backend: BackendRecord | undefined;
        try { backend = this.#readBackend(current.id); } catch { this.#markFenceUncertain(current); return; }
        if (backend && backend.generation !== current.generation) { this.#markFenceUncertain(current); return; }
        const draining = this.#casRuntime(current, current.revision, { phase: "Unavailable", conditions: replaceCondition(current.conditions, condition(ROUTE_CONDITION, "False", "ConfigurationRecoveryDraining", iso(this.#now))) });
        if (draining.outcome !== "updated") return;
        current = draining.resource;
        if (!(await this.#drainAndFence(current, undefined, undefined, backend))) { this.#markFenceUncertain(current); return; }
        const phase: Phase = current.desiredState === "Sleeping" ? "Sleeping" : "Stopped";
        const terminal = this.#casRuntime(current, current.revision, { phase });
        if (terminal.outcome !== "updated") return;
      }
      const retiredTransitions: ("activate" | "enableBrowser")[] = ["activate"];
      if (intent.browserPolicy === "Disabled") retiredTransitions.push("enableBrowser");
      if (!(await this.#retireAdmission(current.scopeId, "runtime", id, retiredTransitions))) return;
      this.#store.completeRuntimeConfigurationIntent(id, operationId);
    }).catch(() => { /* the durable intent remains authoritative for the next recovery */ });
  }

  async #retireAdmission(scopeId: ScopeId, resourceKind: "workspace" | "runtime", resourceKey: string, transitions: readonly ("create" | "activate" | "enableBrowser")[]): Promise<boolean> {
    try {
      for (const transition of transitions)
        await this.#admissionLedger.reconcileAdmissionAbsence({ scopeId, resourceKind, resourceKey, transition });
      return true;
    } catch {
      return false;
    }
  }
  async #reserveAdmission(
    resourceKind: "workspace" | "runtime",
    resourceKey: string,
    request: { readonly scopeId: ScopeId; readonly capacityBytes?: number; readonly desiredState?: DesiredState; readonly browserPolicy?: "Allowed" | "Disabled" },
    transition: "create" | "activate" | "enableBrowser" = "create",
  ): Promise<ScopeAdmissionOutcome> {
    let cursor: string | undefined;
    const workspaces: Workspace[] = [];
    const runtimes: Runtime[] = [];
    do {
      const page = this.#store.listResources({ scopeId: request.scopeId, kinds: ["workspace", "runtime"], limit: 200, ...(cursor === undefined ? {} : { pageCursor: cursor }) });
      for (const item of page.items) {
        if ("capacityBytes" in item) workspaces.push(item as Workspace);
        else if ("desiredState" in item) runtimes.push(item as Runtime);
      }
      cursor = page.nextPageCursor;
    } while (cursor !== undefined);
    const browserEnabledRuntimeIds = new Set(runtimes.flatMap(item => {
      try { return this.#readConfiguration(item.id).browserPolicy === "Allowed" ? [item.id] : []; }
      catch { return []; }
    }));
    const activeRuntimes = runtimes.filter(item => item.desiredState === "Running" && item.phase !== "Deleting" && item.phase !== "Failed").length;
    const workspaceCapacityBytes = workspaces.reduce((sum, item) =>
      sum > Number.MAX_SAFE_INTEGER - item.capacityBytes ? Number.MAX_SAFE_INTEGER : sum + item.capacityBytes, 0);
    const demand = this.#admissionPolicy.runtimeResources;
    const product = (value: number): number =>
      value !== 0 && activeRuntimes > Math.floor(Number.MAX_SAFE_INTEGER / value) ? Number.MAX_SAFE_INTEGER : value * activeRuntimes;
    try {
      return await this.#admissionLedger.reserveAdmission({
        scopeId: request.scopeId,
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
          retainedRuntimes: runtimes.length,
          workspaceCapacityBytes,
          cpuMillis: product(demand.cpuMillis),
          memoryBytes: product(demand.memoryBytes),
          gpuUnits: product(demand.gpuUnits),
          observedResourceDigests: [
            ...workspaces.map(item => createHash("sha256").update(`${request.scopeId}\0workspace\0${item.id}\0create`).digest("hex")),
            ...runtimes.map(item => createHash("sha256").update(`${request.scopeId}\0runtime\0${item.id}\0create`).digest("hex")),
            ...runtimes.filter(item => item.desiredState === "Running").map(item => createHash("sha256").update(`${request.scopeId}\0runtime\0${item.id}\0activate`).digest("hex")),
            ...runtimes.filter(item => browserEnabledRuntimeIds.has(item.id)).map(item => createHash("sha256").update(`${request.scopeId}\0runtime\0${item.id}\0enableBrowser`).digest("hex")),
          ],
        },
      });
    } catch {
      return { outcome: "denied", reason: "admission_unavailable", retryAfterSeconds: 1 };
    }
  }
  #casRuntime(current: Runtime, expectedRevision: Revision, changes: Partial<Omit<Runtime, "id" | "revision">>): Exclude<MutationOutcome<Runtime>, { readonly outcome: "admissionDenied" }> {
    return this.#store.compareAndSwapResourceWithEvent({ kind: "runtime", id: current.id, expectedRevision, value: { ...current, ...changes, updatedAt: iso(this.#now) }, event: this.#eventDraft((changes.phase as Phase | undefined) ?? current.phase) });
  }
  #eventDraft(phase: Phase): ResourceEventDraft {
    return { eventId: opaque("evt", this.#random), phase, timestamp: iso(this.#now) };
  }
  #preparePrivateDirectory(path: string): void {
    let cursor = path;
    while (!statExists(cursor)) cursor = dirname(cursor);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`symlink rejected at ${cursor}`);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    cursor = path;
    while (cursor.startsWith(this.#root ?? path)) { const stat = lstatSync(cursor); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe directory ${cursor}`); chmodSync(cursor, 0o700); if (cursor === (this.#root ?? path)) break; cursor = dirname(cursor); }
  }
  #workspacePath(id: WorkspaceId): string { return this.#ownedPath(this.#workspaceRoot, hashedComponent("ws", id)); }
  #runtimeStagingPath(id: RuntimeId): string { return this.#ownedPath(this.#runtimeRoot, `${hashedComponent("rt", id)}.staging`); }
  #startAttemptPath(id: RuntimeId, generation: Generation): string { return join(this.#runtimePath(id), `.start-${createHash("sha256").update(generation).digest("hex").slice(0, 20)}.authority`); }
  #generationCredentialName(generation: Generation): string { return `generation-${createHash("sha256").update(generation).digest("hex").slice(0, 20)}.credential`; }
  #startAttemptOwnedByOther(path: string): boolean {
    const inProcessOwner = START_AUTHORITY_OWNERS.get(path);
    if (inProcessOwner !== undefined) return inProcessOwner !== this.#startAuthorityOwner;
    if (!statExists(path)) return false;
    const result = spawnSync(this.#lsof, ["-F", "p", "--", path], { encoding: "utf8", timeout: Math.max(1000, this.#shutdownKill) });
    if (result.error || (result.status !== 0 && result.status !== 1)) return true;
    return result.stdout.split("\n").some((line) => line.startsWith("p") && Number(line.slice(1)) !== process.pid);
  }
  #forgetStartAuthority(path?: string): void {
    if (path !== undefined) {
      if (START_AUTHORITY_OWNERS.get(path) === this.#startAuthorityOwner) START_AUTHORITY_OWNERS.delete(path);
      return;
    }
    for (const [candidate, owner] of START_AUTHORITY_OWNERS) if (owner === this.#startAuthorityOwner) START_AUTHORITY_OWNERS.delete(candidate);
  }
  #closeStartAttemptHandle(id: RuntimeId): void {
    const handle = this.#attemptHandles.get(id);
    if (handle === undefined) return;
    this.#attemptHandles.delete(id);
    try { closeSync(handle); } catch { /* a concurrent drain may already have closed it */ }
    if (this.#attemptHandles.size === 0) this.#forgetStartAuthority();
  }
  #releaseStartAttempt(id: RuntimeId, revision: Revision, token: string, path: string): void {
    let failure: unknown;
    try {
      this.#store.completeRuntimeStartAttempt(id, revision, token);
    } catch (cause) {
      failure = cause;
    }
    this.#closeStartAttemptHandle(id);
    this.#forgetStartAuthority(path);
    try {
      unlinkSync(path);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT" && failure === undefined) failure = cause;
    }
    if (failure !== undefined) throw failure;
  }
  #releaseCurrentStartAttempt(id: RuntimeId): void {
    const attempt = this.#store.getRuntimeStartAttempt(id);
    if (!attempt) { this.#closeStartAttemptHandle(id); return; }
    this.#releaseStartAttempt(id, attempt.revision, attempt.token, this.#startAttemptPath(id, attempt.generation));
  }
  #runtimePath(id: RuntimeId): string { return this.#ownedPath(this.#runtimeRoot, hashedComponent("rt", id)); }
  #ownedPath(root: string, component: string): string { const path = join(root, component); if (dirname(path) !== root || basename(path) !== component || path.length > MAX_ROOT_LENGTH + 80) throw new Error("derived path is unsafe"); return path; }
  #backendPath(id: RuntimeId): string { return join(this.#runtimePath(id), "supervisor-state.json"); }
  #configurationPath(id: RuntimeId): string { return join(this.#runtimePath(id), "runtime-config.json"); }
  #stageConfiguration(id: RuntimeId, operationId: string, configuration: RuntimeConfiguration): string {
    this.#preparePrivateDirectory(this.#runtimePath(id));
    const temporary = `${this.#configurationPath(id)}.${operationId}`;
    writeFileSync(temporary, JSON.stringify(configuration), { mode: 0o600, flag: "wx" });
    return temporary;
  }
  #commitConfiguration(id: RuntimeId, temporary: string): void {
    this.#preparePrivateDirectory(this.#runtimePath(id));
    const target = this.#configurationPath(id);
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  }
  #readConfiguration(id: RuntimeId): RuntimeConfiguration {
    this.#preparePrivateDirectory(this.#runtimePath(id));
    const path = this.#configurationPath(id), stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.mode & 0o077) throw new Error("unsafe runtime configuration");
    const value = JSON.parse(readFileSync(path, "utf8")) as RuntimeConfiguration;
    if ((value.browserPolicy !== "Allowed" && value.browserPolicy !== "Disabled") || (value.idlePolicy !== undefined && typeof value.idlePolicy !== "object")) throw new Error("invalid runtime configuration");
    return value;
  }
  #leasePath(id: RuntimeId): string { return join(this.#runtimePath(id), ".writer-lease"); }
  #writeBackend(id: RuntimeId, record: BackendRecord): void { this.#preparePrivateDirectory(this.#runtimePath(id)); const target = this.#backendPath(id), temporary = `${target}.${opaque("tmp", this.#random)}`; writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" }); renameSync(temporary, target); chmodSync(target, 0o600); }
  #readBackend(id: RuntimeId): BackendRecord | undefined {
    this.#preparePrivateDirectory(this.#runtimePath(id));
    const path = this.#backendPath(id); if (!statExists(path)) return undefined;
    const stat = lstatSync(path); if (stat.isSymbolicLink() || !stat.isFile() || stat.mode & 0o077) throw new Error("unsafe supervisor state");
    const value = JSON.parse(readFileSync(path, "utf8")) as BackendRecord;
    if (value.version !== 1 || value.runtimeId !== id || !Number.isSafeInteger(value.pid) || value.pid <= 1) throw new Error("invalid supervisor state");
    return value;
  }
  #acquireWriterLease(id: RuntimeId, token: string): boolean { try { mkdirSync(this.#leasePath(id), { mode: 0o700 }); writeFileSync(join(this.#leasePath(id), "token"), token, { mode: 0o600, flag: "wx" }); return true; } catch { return false; } }
  #replaceWriterLease(id: RuntimeId, token: string): boolean { try { rmSync(this.#leasePath(id), { recursive: true, force: true }); return this.#acquireWriterLease(id, token); } catch { return false; } }
  #revokeCredential(path: string): void { try { const stat = lstatSync(path); if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("unsafe generation credential"); unlinkSync(path); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; } }
}

function statExists(path: string): boolean { try { statSync(path); return true; } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false; throw cause; } }
