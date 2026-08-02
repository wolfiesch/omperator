import { Database } from "bun:sqlite";
import { createHash, createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync } from "node:fs";
import type {
	BrowserPolicy,
	Generation,
	IdlePolicy,
	Phase,
	Revision,
	Runtime,
	RuntimeId,
	Scope,
	ScopeId,
	Timestamp,
	Workspace,
	WorkspaceId,
} from "@t4-code/portable-core";
import {
	decodeGeneration,
	decodeOpaqueId,
	decodePhase,
	decodeRevision,
	decodeRuntime,
	decodeScope,
	decodeTimestamp,
	decodeWorkspace,
} from "@t4-code/portable-core";

const SCHEMA_VERSION = 1;
const MIN_RETENTION_SECONDS = 86_400;
const MAX_RESOURCE_SNAPSHOT_ITEMS = 100_000;
const RESOURCE_SNAPSHOT_TTL_MS = 60_000;
const MAX_ACTIVE_RESOURCE_SNAPSHOTS_PER_SCOPE = 16;
const MAX_TOMBSTONE_RETENTION_SECONDS = 604_800;
const MAX_TOMBSTONES_PER_SCOPE = 100_000;
const MAX_TICKET_TTL_SECONDS = 60;
const MAX_JSON_BYTES = 65_536;
const MAX_EVENTS_PER_SCOPE = 100_000;
const MAX_EVENT_RETENTION_SECONDS = 604_800;
const MAX_LIST_LIMIT = 200;
const CURSOR_BYTES = 25;

export type ResourceKind = "scope" | "workspace" | "runtime";
export type PortableResource = Scope | Workspace | Runtime;
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface ResourceByKind {
	readonly scope: Scope;
	readonly workspace: Workspace;
	readonly runtime: Runtime;
}

export type ResourceDraft<K extends ResourceKind> = Omit<ResourceByKind[K], "revision">;
export type ResourceUpdate<K extends ResourceKind> = Omit<ResourceByKind[K], "id" | "revision">;
export interface ResourceEventDraft {
	readonly eventId: string;
	readonly phase: Phase;
	readonly timestamp: Timestamp;
}

export interface ResourceListPage {
	readonly items: readonly PortableResource[];
	readonly highWaterCursor: string;
	readonly nextPageCursor?: string;
}

export interface InfrastructureEvent {
	readonly eventId: string;
	readonly resourceKind: ResourceKind;
	readonly resourceId: string;
	readonly scopeId: ScopeId;
	readonly revision: Revision;
	readonly phase: Phase;
	readonly timestamp: Timestamp;
}

export interface ResetEvent {
	readonly eventId: string;
	readonly event: "reset";
	readonly reason: "cursor_expired";
	readonly timestamp: Timestamp;
}

export interface Tombstone {
	readonly scopeId: ScopeId;
	readonly resourceKind: ResourceKind;
	readonly resourceId: string;
	readonly deletedAt: Timestamp;
	readonly expiresAt: Timestamp;
}

export interface RuntimeConfigurationIntent {
	readonly runtimeId: RuntimeId;
	readonly operationId: string;
	readonly browserPolicy: BrowserPolicy;
	readonly idlePolicy?: IdlePolicy;
}

export interface RuntimeStartAttempt {
	readonly runtimeId: RuntimeId;
	readonly revision: Revision;
	readonly generation: Generation;
	readonly token: string;
}

export interface BackendCleanupRecord {
	readonly resourceKind: "workspace" | "runtime";
	readonly resourceId: string;
	readonly scopeId: ScopeId;
	readonly cleanupRequired: boolean;
	readonly completed: boolean;
}

export interface IdempotencyKey {
	readonly principalId: string;
	readonly scopeId: ScopeId;
	readonly method: string;
	readonly canonicalPath: string;
	readonly idempotencyKey: string;
	readonly canonicalBodyDigest: string;
}

export type IdempotencyReservation =
	| { readonly outcome: "new"; readonly reservationToken: string }
	| { readonly outcome: "pending" }
	| { readonly outcome: "replay"; readonly result: JsonValue }
	| { readonly outcome: "conflict" };

export interface TicketBinding {
	readonly principalId: string;
	readonly scopeId: ScopeId;
	readonly audience: string;
	readonly runtimeId: RuntimeId;
	readonly runtimeGeneration: Generation;
	readonly providerControlGeneration: Generation;
	readonly purpose: string;
}

export interface TicketConsumeSelector {
	readonly ticket: string;
	readonly principalId: string;
	readonly audience: string;
	readonly providerControlGeneration: Generation;
	readonly purpose: string;
}

export type TicketConsumeOutcome =
	| { readonly outcome: "consumed"; readonly binding: TicketBinding }
	| { readonly outcome: "rejected" };

export type TicketRevocation =
	| ({ readonly cause: "controlDisconnect"; readonly providerControlGeneration: Generation } & Pick<TicketBinding, "scopeId" | "runtimeId">)
	| ({ readonly cause: "providerControlGenerationReplacement"; readonly providerControlGeneration: Generation } & Pick<TicketBinding, "scopeId" | "runtimeId">)
	| ({ readonly cause: "runtimeGenerationReplacement"; readonly runtimeGeneration: Generation } & Pick<TicketBinding, "scopeId" | "runtimeId">)
	| ({ readonly cause: "explicitCancellation" } & Pick<TicketBinding, "scopeId" | "runtimeId"> & Partial<Pick<TicketBinding, "runtimeGeneration" | "providerControlGeneration" | "purpose">>);

export interface SqliteControlStoreOptions {
	readonly databasePath: string;
	readonly now?: () => number;
	readonly randomBytes?: (length: number) => Uint8Array;
	readonly idempotencyRetentionSeconds?: number;
	readonly tombstoneRetentionSeconds?: number;
	readonly maximumTombstonesPerScope?: number;
	readonly eventRetentionSeconds?: number;
	readonly maximumEventsPerScope?: number;
	readonly busyTimeoutMilliseconds?: number;
}

/** Backend-neutral operations exercised by local and shared-store conformance suites. */
export interface PortableControlStore {
	createResource<K extends ResourceKind>(request: { readonly kind: K; readonly value: ResourceDraft<K> }): { readonly outcome: "created"; readonly resource: ResourceByKind[K] } | { readonly outcome: "alreadyIssued" };
	createResourceWithEvent<K extends ResourceKind>(request: { readonly kind: K; readonly value: ResourceDraft<K>; readonly event: ResourceEventDraft }): { readonly outcome: "created"; readonly resource: ResourceByKind[K]; readonly event: InfrastructureEvent; readonly cursor: string } | { readonly outcome: "alreadyIssued" };
	createRuntimeWithWorkspaceAttachment(request: { readonly value: ResourceDraft<"runtime">; readonly workspaceId: WorkspaceId; readonly expectedWorkspaceRevision: Revision; readonly configurationIntent: RuntimeConfigurationIntent; readonly runtimeEvent: ResourceEventDraft; readonly workspaceEvent: ResourceEventDraft }): { readonly outcome: "created"; readonly resource: Runtime; readonly workspace: Workspace; readonly events: readonly [InfrastructureEvent, InfrastructureEvent]; readonly cursor: string } | { readonly outcome: "alreadyIssued" } | { readonly outcome: "workspaceRevisionMismatch"; readonly currentRevision: Revision } | { readonly outcome: "workspaceNotFound" } | { readonly outcome: "invalidState"; readonly reason: "WorkspaceDeleting" };
	getRuntimeConfigurationIntent(runtimeId: RuntimeId): RuntimeConfigurationIntent | undefined;
	completeRuntimeConfigurationIntent(runtimeId: RuntimeId, operationId: string): boolean;
	getResource<K extends ResourceKind>(kind: K, id: string): ResourceByKind[K] | undefined;
	compareAndSwapResource<K extends ResourceKind>(request: { readonly kind: K; readonly id: string; readonly expectedRevision: Revision; readonly value: ResourceUpdate<K> }): { readonly outcome: "updated"; readonly resource: ResourceByKind[K] } | { readonly outcome: "revisionMismatch"; readonly currentRevision: Revision } | { readonly outcome: "notFound" };
	compareAndSwapResourceWithEvent<K extends ResourceKind>(request: { readonly kind: K; readonly id: string; readonly expectedRevision: Revision; readonly value: ResourceUpdate<K>; readonly event: ResourceEventDraft }): { readonly outcome: "updated"; readonly resource: ResourceByKind[K]; readonly event: InfrastructureEvent; readonly cursor: string } | { readonly outcome: "revisionMismatch"; readonly currentRevision: Revision } | { readonly outcome: "notFound" };
	compareAndSwapRuntimeWithConfigurationIntent(request: { readonly id: RuntimeId; readonly expectedRevision: Revision; readonly value: ResourceUpdate<"runtime">; readonly event: ResourceEventDraft; readonly intent: RuntimeConfigurationIntent }): { readonly outcome: "updated"; readonly resource: Runtime; readonly event: InfrastructureEvent; readonly cursor: string } | { readonly outcome: "revisionMismatch"; readonly currentRevision: Revision } | { readonly outcome: "notFound" } | { readonly outcome: "intentExists" };
	compareAndSwapRuntimeWithStartAttempt(request: { readonly id: RuntimeId; readonly expectedRevision: Revision; readonly value: ResourceUpdate<"runtime">; readonly event: ResourceEventDraft; readonly generation: Generation; readonly token: string }): { readonly outcome: "updated"; readonly resource: Runtime; readonly attempt: RuntimeStartAttempt; readonly event: InfrastructureEvent; readonly cursor: string } | { readonly outcome: "revisionMismatch"; readonly currentRevision: Revision } | { readonly outcome: "notFound" } | { readonly outcome: "attemptExists" };
	getRuntimeStartAttempt(runtimeId: RuntimeId): RuntimeStartAttempt | undefined;
	completeRuntimeStartAttempt(runtimeId: RuntimeId, revision: Revision, token: string): boolean;
	deleteResource(request: { readonly kind: ResourceKind; readonly id: string; readonly expectedRevision: Revision }): { readonly outcome: "deleted" } | { readonly outcome: "revisionMismatch"; readonly currentRevision: Revision } | { readonly outcome: "notFound" };
	deleteResourceWithEvent(request: { readonly kind: ResourceKind; readonly id: string; readonly expectedRevision: Revision; readonly event: ResourceEventDraft }): { readonly outcome: "deleted"; readonly event: InfrastructureEvent; readonly cursor: string } | { readonly outcome: "revisionMismatch"; readonly currentRevision: Revision } | { readonly outcome: "notFound" };
	deleteResourceWithTombstoneAndEvent(request: { readonly kind: ResourceKind; readonly id: string; readonly scopeId: ScopeId; readonly expectedRevision: Revision; readonly deletedAt: Timestamp; readonly cleanupRequired: boolean; readonly event: ResourceEventDraft }): { readonly outcome: "deleted"; readonly tombstone: Tombstone; readonly event: InfrastructureEvent; readonly cursor: string } | { readonly outcome: "revisionMismatch"; readonly currentRevision: Revision } | { readonly outcome: "notFound" } | { readonly outcome: "scopeMismatch" } | { readonly outcome: "tombstoneCapacityExceeded" };
	finalizeRuntimeDeletion(request: { readonly runtimeId: RuntimeId; readonly expectedRevision: Revision; readonly deletedAt: Timestamp; readonly runtimeEvent: ResourceEventDraft; readonly workspaceEvent: ResourceEventDraft }): { readonly outcome: "deleted"; readonly workspace: Workspace; readonly tombstone: Tombstone; readonly events: readonly [InfrastructureEvent, InfrastructureEvent]; readonly cursor: string } | { readonly outcome: "revisionMismatch"; readonly currentRevision: Revision } | { readonly outcome: "notFound" } | { readonly outcome: "invalidState"; readonly reason: "RuntimeNotDeleting" | "WorkspaceAttachmentMissing" } | { readonly outcome: "tombstoneCapacityExceeded" };
	getBackendCleanup(resourceKind: "workspace" | "runtime", resourceId: string): BackendCleanupRecord | undefined;
	completeBackendCleanup(resourceKind: "workspace" | "runtime", resourceId: string): boolean;
	identifierWasIssued(kind: ResourceKind, id: string): boolean;
	listResources(request: { readonly scopeId: ScopeId; readonly kinds?: readonly ResourceKind[]; readonly limit?: number; readonly pageCursor?: string }): ResourceListPage;
	reserveIdempotency(request: IdempotencyKey): IdempotencyReservation;
	completeIdempotency(request: IdempotencyKey & { readonly reservationToken: string; readonly result: JsonValue }): { readonly outcome: "completed" } | { readonly outcome: "alreadyCompleted"; readonly result: JsonValue } | { readonly outcome: "reservationMismatch" } | { readonly outcome: "notFound" };
	releaseIdempotency(request: IdempotencyKey & { readonly reservationToken: string }): { readonly outcome: "released" | "reservationMismatch" | "notFound" };
	reconcileIdempotency(request: IdempotencyKey & { readonly result: JsonValue }): { readonly outcome: "completed" } | { readonly outcome: "alreadyCompleted"; readonly result: JsonValue } | { readonly outcome: "conflict" } | { readonly outcome: "notFound" };
	cleanupIdempotency(): number;
	mintTicket(request: TicketBinding & { readonly ttlSeconds: number }): { readonly ticket: string; readonly expiresAt: Timestamp };
	consumeTicket(request: TicketBinding & { readonly ticket: string }): boolean;
	consumeTicketForTransport(request: TicketConsumeSelector): TicketConsumeOutcome;
	revokeTicket(ticket: string): boolean;
	revokeTickets(request: TicketRevocation): number;
	putTombstone(request: { readonly scopeId: ScopeId; readonly resourceKind: ResourceKind; readonly resourceId: string; readonly deletedAt: Timestamp }): { readonly outcome: "created" | "existing"; readonly tombstone: Tombstone } | { readonly outcome: "capacityExceeded" };
	getTombstone(request: { readonly scopeId: ScopeId; readonly resourceKind: ResourceKind; readonly resourceId: string }): Tombstone | undefined;
	cleanupTombstones(scopeId: ScopeId): number;
	appendEvent(event: InfrastructureEvent): { readonly event: InfrastructureEvent; readonly cursor: string };
	readAfter(request: { readonly scopeId: ScopeId; readonly cursor: string; readonly limit?: number }): { readonly outcome: "events"; readonly events: readonly InfrastructureEvent[]; readonly cursor: string } | { readonly outcome: "cursorExpired"; readonly reset: ResetEvent };
	subscribe(request: { readonly scopeId: ScopeId; readonly cursor: string; readonly signal?: AbortSignal; readonly pollMilliseconds?: number; readonly batchLimit?: number }): AsyncIterable<{ readonly outcome: "events"; readonly events: readonly InfrastructureEvent[]; readonly cursor: string } | { readonly outcome: "cursorExpired"; readonly reset: ResetEvent }>;
}

export class ControlStoreInputError extends TypeError {
	constructor(message: string) {
		super(message);
		this.name = "ControlStoreInputError";
	}
}

export class ControlStoreStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ControlStoreStateError";
	}
}

function input(condition: unknown, message: string): asserts condition {
	if (!condition) throw new ControlStoreInputError(message);
}

function exactKeys(value: object, allowed: readonly string[], name: string): void {
	for (const key of Object.keys(value)) input(allowed.includes(key), `${name}.${key} is not allowed`);
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
	input(Number.isSafeInteger(value) && value >= minimum && value <= maximum, `${name} is outside its supported range`);
	return value;
}

function boundedText(value: string, minimum: number, maximum: number, name: string, pattern?: RegExp): string {
	input(typeof value === "string" && value.length >= minimum && value.length <= maximum, `${name} is outside its supported length`);
	input(!pattern || pattern.test(value), `${name} is malformed`);
	return value;
}

function runtimeConfigurationIntent(value: RuntimeConfigurationIntent): RuntimeConfigurationIntent {
	exactKeys(value, ["runtimeId", "operationId", "browserPolicy", "idlePolicy"], "intent");
	const runtimeId = decodeOpaqueId(value.runtimeId) as RuntimeId;
	const operationId = decodeOpaqueId(value.operationId);
	input(value.browserPolicy === "Allowed" || value.browserPolicy === "Disabled", "intent.browserPolicy is unsupported");
	input(value.idlePolicy === undefined || (value.idlePolicy !== null && typeof value.idlePolicy === "object" && !Array.isArray(value.idlePolicy)), "intent.idlePolicy is malformed");
	return { runtimeId, operationId, browserPolicy: value.browserPolicy, ...(value.idlePolicy === undefined ? {} : { idlePolicy: value.idlePolicy }) };
}

function resourceKind(value: string): ResourceKind {
	input(value === "scope" || value === "workspace" || value === "runtime", "resourceKind is unsupported");
	return value;
}

function parseJson(value: string, name: string): JsonValue {
	input(Buffer.byteLength(value) <= MAX_JSON_BYTES, `${name} is too large`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new ControlStoreStateError(`${name} is corrupt`);
	}
	return jsonValue(parsed, name);
}

function jsonValue(value: unknown, name: string, depth = 0): JsonValue {
	input(depth <= 32, `${name} is too deeply nested`);
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		input(Number.isFinite(value), `${name} contains a non-finite number`);
		return value;
	}
	if (Array.isArray(value)) {
		input(value.length <= 10_000, `${name} contains too many array items`);
		return value.map((item, index) => jsonValue(item, `${name}[${index}]`, depth + 1));
	}
	input(value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype, `${name} is not JSON`);
	const entries = Object.entries(value as Record<string, unknown>);
	input(entries.length <= 10_000, `${name} contains too many object fields`);
	const result = Object.create(null) as Record<string, JsonValue>;
	for (const [key, item] of entries) result[key] = jsonValue(item, `${name}.${key}`, depth + 1);
	return result;
}

function encodeJson(value: unknown, name: string): string {
	const normalized = jsonValue(value, name);
	const encoded = JSON.stringify(normalized);
	input(Buffer.byteLength(encoded) <= MAX_JSON_BYTES, `${name} is too large`);
	return encoded;
}

function decodeResource(kind: ResourceKind, encoded: string): PortableResource {
	let parsed: unknown;
	try {
		parsed = JSON.parse(encoded);
		return kind === "scope" ? decodeScope(parsed) : kind === "workspace" ? decodeWorkspace(parsed) : decodeRuntime(parsed);
	} catch (cause) {
		throw new ControlStoreStateError(`Stored ${kind} resource is malformed: ${cause instanceof Error ? cause.message : "invalid value"}`);
	}
}

function eventFromRow(row: Record<string, unknown>): InfrastructureEvent {
	try {
		return {
			eventId: boundedText(String(row.event_id), 1, 128, "eventId", /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u),
			resourceKind: resourceKind(String(row.resource_kind)),
			resourceId: decodeOpaqueId(row.resource_id),
			scopeId: decodeOpaqueId(row.scope_id),
			revision: decodeRevision(row.revision),
			phase: decodePhase(row.phase),
			timestamp: decodeTimestamp(row.timestamp),
		};
	} catch (cause) {
		throw new ControlStoreStateError(`Stored event is malformed: ${cause instanceof Error ? cause.message : "invalid value"}`);
	}
}

function iso(milliseconds: number): Timestamp {
	return decodeTimestamp(new Date(milliseconds).toISOString());
}

export class SqliteControlStore implements PortableControlStore {
	readonly #database: Database;
	readonly #now: () => number;
	readonly #randomBytes: (length: number) => Uint8Array;
	readonly #idempotencyRetentionMs: number;
	readonly #tombstoneRetentionMs: number;
	readonly #maximumTombstonesPerScope: number;
	readonly #eventRetentionMs: number;
	readonly #maximumEventsPerScope: number;
	#cursorKey!: Uint8Array;
	#closed = false;

	constructor(options: SqliteControlStoreOptions) {
		exactKeys(options, ["databasePath", "now", "randomBytes", "idempotencyRetentionSeconds", "tombstoneRetentionSeconds", "maximumTombstonesPerScope", "eventRetentionSeconds", "maximumEventsPerScope", "busyTimeoutMilliseconds"], "options");
		input(typeof options.databasePath === "string" && options.databasePath.length > 0 && options.databasePath.length <= 4096, "databasePath is invalid");
		this.#now = options.now ?? Date.now;
		this.#randomBytes = options.randomBytes ?? ((length) => nodeRandomBytes(length));
		this.#idempotencyRetentionMs = boundedInteger(options.idempotencyRetentionSeconds ?? MIN_RETENTION_SECONDS, MIN_RETENTION_SECONDS, MAX_TOMBSTONE_RETENTION_SECONDS, "idempotencyRetentionSeconds") * 1000;
		this.#tombstoneRetentionMs = boundedInteger(options.tombstoneRetentionSeconds ?? MIN_RETENTION_SECONDS, MIN_RETENTION_SECONDS, MAX_TOMBSTONE_RETENTION_SECONDS, "tombstoneRetentionSeconds") * 1000;
		this.#maximumTombstonesPerScope = boundedInteger(options.maximumTombstonesPerScope ?? MAX_TOMBSTONES_PER_SCOPE, 1, MAX_TOMBSTONES_PER_SCOPE, "maximumTombstonesPerScope");
		this.#eventRetentionMs = boundedInteger(options.eventRetentionSeconds ?? MAX_EVENT_RETENTION_SECONDS, 1, MAX_EVENT_RETENTION_SECONDS, "eventRetentionSeconds") * 1000;
		this.#maximumEventsPerScope = boundedInteger(options.maximumEventsPerScope ?? 10_000, 1, MAX_EVENTS_PER_SCOPE, "maximumEventsPerScope");
		const busyTimeout = boundedInteger(options.busyTimeoutMilliseconds ?? 5000, 1, 60_000, "busyTimeoutMilliseconds");
		this.#database = new Database(options.databasePath, { create: true, strict: true });
		if (options.databasePath !== ":memory:") chmodSync(options.databasePath, 0o600);
		this.#database.run(`PRAGMA busy_timeout = ${busyTimeout}`);
		this.#database.run("PRAGMA journal_mode = WAL");
		this.#database.run("PRAGMA foreign_keys = ON");
		this.#initialize();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#database.close(false);
	}

	createResource<K extends ResourceKind>(request: { readonly kind: K; readonly value: ResourceDraft<K> }): { readonly outcome: "created"; readonly resource: ResourceByKind[K] } | { readonly outcome: "alreadyIssued" } {
		this.#assertOpen();
		exactKeys(request, ["kind", "value"], "request");
		const kind = resourceKind(request.kind);
		const draft = request.value as ResourceDraft<ResourceKind>;
		const id = decodeOpaqueId(draft.id);
		const scopeId = kind === "scope" ? id : decodeOpaqueId((draft as Workspace | Runtime).scopeId);
		const revision = this.#newOpaque("rev", 18);
		const decoded = this.#decodeInputResource(kind, { ...draft, revision });
		const body = encodeJson(decoded, "resource");
		return this.#transaction(() => {
			const issued = this.#database.query("SELECT 1 AS found FROM issued_identifiers WHERE resource_kind=? AND resource_id=?").get(kind, id);
			if (issued) return { outcome: "alreadyIssued" } as const;
			this.#database.run("INSERT INTO issued_identifiers(resource_kind,resource_id,scope_id,issued_at) VALUES (?,?,?,?)", [kind, id, scopeId, this.#nowMs()]);
			this.#database.run("INSERT INTO resources(resource_kind,resource_id,scope_id,revision,body) VALUES (?,?,?,?,?)", [kind, id, scopeId, revision, body]);
			return { outcome: "created", resource: decoded as ResourceByKind[K] } as const;
		});
	}

	createResourceWithEvent<K extends ResourceKind>(request: { readonly kind: K; readonly value: ResourceDraft<K>; readonly event: ResourceEventDraft }): { readonly outcome: "created"; readonly resource: ResourceByKind[K]; readonly event: InfrastructureEvent; readonly cursor: string } | { readonly outcome: "alreadyIssued" } {
		this.#assertOpen();
		exactKeys(request, ["kind", "value", "event"], "request");
		const kind = resourceKind(request.kind);
		const draft = request.value as ResourceDraft<ResourceKind>;
		const id = decodeOpaqueId(draft.id);
		const scopeId = kind === "scope" ? id : decodeOpaqueId((draft as Workspace | Runtime).scopeId);
		const revision = this.#newOpaque("rev", 18);
		const decoded = this.#decodeInputResource(kind, { ...draft, revision });
		const body = encodeJson(decoded, "resource");
		const event = this.#resourceEvent(kind, id, scopeId, revision, request.event);
		return this.#transaction(() => {
			const issued = this.#database.query("SELECT 1 AS found FROM issued_identifiers WHERE resource_kind=? AND resource_id=?").get(kind, id);
			if (issued) return { outcome: "alreadyIssued" } as const;
			this.#database.run("INSERT INTO issued_identifiers(resource_kind,resource_id,scope_id,issued_at) VALUES (?,?,?,?)", [kind, id, scopeId, this.#nowMs()]);
			this.#database.run("INSERT INTO resources(resource_kind,resource_id,scope_id,revision,body) VALUES (?,?,?,?,?)", [kind, id, scopeId, revision, body]);
			const appended = this.#appendEventInTransaction(event);
			return { outcome: "created", resource: decoded as ResourceByKind[K], ...appended } as const;
		});
	}

	createRuntimeWithWorkspaceAttachment(request: { readonly value: ResourceDraft<"runtime">; readonly workspaceId: WorkspaceId; readonly expectedWorkspaceRevision: Revision; readonly configurationIntent: RuntimeConfigurationIntent; readonly runtimeEvent: ResourceEventDraft; readonly workspaceEvent: ResourceEventDraft }): { readonly outcome: "created"; readonly resource: Runtime; readonly workspace: Workspace; readonly events: readonly [InfrastructureEvent, InfrastructureEvent]; readonly cursor: string } | { readonly outcome: "alreadyIssued" } | { readonly outcome: "workspaceRevisionMismatch"; readonly currentRevision: Revision } | { readonly outcome: "workspaceNotFound" } | { readonly outcome: "invalidState"; readonly reason: "WorkspaceDeleting" } {
		this.#assertOpen();
		exactKeys(request, ["value", "workspaceId", "expectedWorkspaceRevision", "configurationIntent", "runtimeEvent", "workspaceEvent"], "request");
		const draft = request.value;
		const runtimeId = decodeOpaqueId(draft.id);
		const intent = runtimeConfigurationIntent(request.configurationIntent);
		input(intent.runtimeId === runtimeId, "configuration intent runtime disagrees with resource");
		const workspaceId = decodeOpaqueId(request.workspaceId);
		input(draft.workspaceId === workspaceId, "runtime workspace binding disagrees with workspaceId");
		const expectedWorkspaceRevision = decodeRevision(request.expectedWorkspaceRevision);
		const runtimeRevision = this.#newOpaque("rev", 18);
		const workspaceRevision = this.#newOpaque("rev", 18);
		const runtime = this.#decodeInputResource("runtime", { ...draft, revision: runtimeRevision }) as Runtime;
		const runtimeBody = encodeJson(runtime, "resource");
		return this.#transaction(() => {
			const issued = this.#database.query("SELECT 1 AS found FROM issued_identifiers WHERE resource_kind='runtime' AND resource_id=?").get(runtimeId);
			if (issued) return { outcome: "alreadyIssued" } as const;
			const workspaceRow = this.#database.query("SELECT scope_id,revision,body FROM resources WHERE resource_kind='workspace' AND resource_id=?").get(workspaceId) as Record<string, unknown> | null;
			if (!workspaceRow) return { outcome: "workspaceNotFound" } as const;
			const workspace = this.#validatedStoredResource("workspace", workspaceId, workspaceRow) as Workspace;
			if (workspace.revision !== expectedWorkspaceRevision) return { outcome: "workspaceRevisionMismatch", currentRevision: workspace.revision } as const;
			if (workspace.phase === "Deleting") return { outcome: "invalidState", reason: "WorkspaceDeleting" } as const;
			input(workspace.scopeId === runtime.scopeId, "runtime and workspace scopes disagree");
			const attached: Workspace = { ...workspace, attachmentCount: workspace.attachmentCount + 1, revision: workspaceRevision, updatedAt: request.workspaceEvent.timestamp };
			const workspaceBody = encodeJson(this.#decodeInputResource("workspace", attached), "resource");
			this.#database.run("UPDATE resources SET revision=?,body=? WHERE resource_kind='workspace' AND resource_id=? AND revision=?", [workspaceRevision, workspaceBody, workspaceId, expectedWorkspaceRevision]);
			this.#database.run("INSERT INTO issued_identifiers(resource_kind,resource_id,scope_id,issued_at) VALUES ('runtime',?,?,?)", [runtimeId, runtime.scopeId, this.#nowMs()]);
			this.#database.run("INSERT INTO resources(resource_kind,resource_id,scope_id,revision,body) VALUES ('runtime',?,?,?,?)", [runtimeId, runtime.scopeId, runtimeRevision, runtimeBody]);
			const workspaceEvent = this.#appendEventInTransaction(this.#resourceEvent("workspace", workspaceId, workspace.scopeId, workspaceRevision, request.workspaceEvent)).event;
			const runtimeAppend = this.#appendEventInTransaction(this.#resourceEvent("runtime", runtimeId, runtime.scopeId, runtimeRevision, request.runtimeEvent));
			this.#database.run("INSERT INTO runtime_configuration_intents(runtime_id,operation_id,browser_policy,idle_policy) VALUES (?,?,?,?)", [runtimeId, intent.operationId, intent.browserPolicy, intent.idlePolicy === undefined ? null : encodeJson(intent.idlePolicy as unknown as JsonValue, "idlePolicy")]);
			return { outcome: "created", resource: runtime, workspace: attached, events: [workspaceEvent, runtimeAppend.event] as const, cursor: runtimeAppend.cursor };
		});
	}

	getRuntimeConfigurationIntent(runtimeIdValue: RuntimeId): RuntimeConfigurationIntent | undefined {
		this.#assertOpen();
		const runtimeId = decodeOpaqueId(runtimeIdValue) as RuntimeId;
		const row = this.#database.query("SELECT operation_id,browser_policy,idle_policy FROM runtime_configuration_intents WHERE runtime_id=?").get(runtimeId) as { operation_id: string; browser_policy: BrowserPolicy; idle_policy: string | null } | null;
		if (!row) return undefined;
		const idlePolicy = row.idle_policy === null ? undefined : parseJson(row.idle_policy, "idlePolicy") as unknown as IdlePolicy;
		return runtimeConfigurationIntent({ runtimeId, operationId: row.operation_id, browserPolicy: row.browser_policy, ...(idlePolicy === undefined ? {} : { idlePolicy }) });
	}

	completeRuntimeConfigurationIntent(runtimeIdValue: RuntimeId, operationIdValue: string): boolean {
		this.#assertOpen();
		const runtimeId = decodeOpaqueId(runtimeIdValue);
		const operationId = decodeOpaqueId(operationIdValue);
		return this.#database.run("DELETE FROM runtime_configuration_intents WHERE runtime_id=? AND operation_id=?", [runtimeId, operationId]).changes === 1;
	}

	getResource<K extends ResourceKind>(kindValue: K, idValue: string): ResourceByKind[K] | undefined {
		this.#assertOpen();
		const kind = resourceKind(kindValue);
		const id = decodeOpaqueId(idValue);
		const row = this.#database.query("SELECT scope_id,revision,body FROM resources WHERE resource_kind=? AND resource_id=?").get(kind, id) as Record<string, unknown> | null;
		if (!row) return undefined;
		return this.#validatedStoredResource(kind, id, row) as ResourceByKind[K];
	}

	compareAndSwapResource<K extends ResourceKind>(request: { readonly kind: K; readonly id: string; readonly expectedRevision: Revision; readonly value: ResourceUpdate<K> }): { readonly outcome: "updated"; readonly resource: ResourceByKind[K] } | { readonly outcome: "revisionMismatch"; readonly currentRevision: Revision } | { readonly outcome: "notFound" } {
		this.#assertOpen();
		exactKeys(request, ["kind", "id", "expectedRevision", "value"], "request");
		const kind = resourceKind(request.kind);
		const id = decodeOpaqueId(request.id);
		const expectedRevision = decodeRevision(request.expectedRevision);
		const revision = this.#newOpaque("rev", 18);
		const complete = { ...(request.value as object), id, revision };
		const decoded = this.#decodeInputResource(kind, complete);
		const scopeId = kind === "scope" ? id : decodeOpaqueId((decoded as Workspace | Runtime).scopeId);
		const body = encodeJson(decoded, "resource");
		return this.#transaction(() => {
			const current = this.#database.query("SELECT scope_id,revision,body FROM resources WHERE resource_kind=? AND resource_id=?").get(kind, id) as Record<string, unknown> | null;
			if (!current) return { outcome: "notFound" } as const;
			this.#validatedStoredResource(kind, id, current);
			const currentRevision = decodeRevision(current.revision);
			if (currentRevision !== expectedRevision) return { outcome: "revisionMismatch", currentRevision } as const;
			this.#database.run("UPDATE resources SET scope_id=?,revision=?,body=? WHERE resource_kind=? AND resource_id=? AND revision=?", [scopeId, revision, body, kind, id, expectedRevision]);
			return { outcome: "updated", resource: decoded as ResourceByKind[K] } as const;
		});
	}

	compareAndSwapResourceWithEvent<K extends ResourceKind>(request: { readonly kind: K; readonly id: string; readonly expectedRevision: Revision; readonly value: ResourceUpdate<K>; readonly event: ResourceEventDraft }): { readonly outcome: "updated"; readonly resource: ResourceByKind[K]; readonly event: InfrastructureEvent; readonly cursor: string } | { readonly outcome: "revisionMismatch"; readonly currentRevision: Revision } | { readonly outcome: "notFound" } {
		this.#assertOpen();
		exactKeys(request, ["kind", "id", "expectedRevision", "value", "event"], "request");
		const kind = resourceKind(request.kind);
		const id = decodeOpaqueId(request.id);
		const expectedRevision = decodeRevision(request.expectedRevision);
		const revision = this.#newOpaque("rev", 18);
		const decoded = this.#decodeInputResource(kind, { ...(request.value as object), id, revision });
		const scopeId = kind === "scope" ? id : decodeOpaqueId((decoded as Workspace | Runtime).scopeId);
		const body = encodeJson(decoded, "resource");
		const event = this.#resourceEvent(kind, id, scopeId, revision, request.event);
		return this.#transaction(() => {
			const current = this.#database.query("SELECT scope_id,revision,body FROM resources WHERE resource_kind=? AND resource_id=?").get(kind, id) as Record<string, unknown> | null;
			if (!current) return { outcome: "notFound" } as const;
			this.#validatedStoredResource(kind, id, current);
			const currentRevision = decodeRevision(current.revision);
			if (currentRevision !== expectedRevision) return { outcome: "revisionMismatch", currentRevision } as const;
			this.#database.run("UPDATE resources SET scope_id=?,revision=?,body=? WHERE resource_kind=? AND resource_id=? AND revision=?", [scopeId, revision, body, kind, id, expectedRevision]);
			const appended = this.#appendEventInTransaction(event);
			return { outcome: "updated", resource: decoded as ResourceByKind[K], ...appended } as const;
		});
	}

	compareAndSwapRuntimeWithConfigurationIntent(request: { readonly id: RuntimeId; readonly expectedRevision: Revision; readonly value: ResourceUpdate<"runtime">; readonly event: ResourceEventDraft; readonly intent: RuntimeConfigurationIntent }): { readonly outcome: "updated"; readonly resource: Runtime; readonly event: InfrastructureEvent; readonly cursor: string } | { readonly outcome: "revisionMismatch"; readonly currentRevision: Revision } | { readonly outcome: "notFound" } | { readonly outcome: "intentExists" } {
		this.#assertOpen();
		exactKeys(request, ["id", "expectedRevision", "value", "event", "intent"], "request");
		const id = decodeOpaqueId(request.id) as RuntimeId;
		const expectedRevision = decodeRevision(request.expectedRevision);
		const revision = this.#newOpaque("rev", 18);
		const runtime = this.#decodeInputResource("runtime", { ...request.value, id, revision }) as Runtime;
		const intent = runtimeConfigurationIntent(request.intent);
		input(intent.runtimeId === id, "configuration intent runtime disagrees with resource");
		const body = encodeJson(runtime, "resource");
		const event = this.#resourceEvent("runtime", id, runtime.scopeId, revision, request.event);
		return this.#transaction(() => {
			const current = this.#database.query("SELECT scope_id,revision,body FROM resources WHERE resource_kind='runtime' AND resource_id=?").get(id) as Record<string, unknown> | null;
			if (!current) return { outcome: "notFound" } as const;
			this.#validatedStoredResource("runtime", id, current);
			const currentRevision = decodeRevision(current.revision);
			if (currentRevision !== expectedRevision) return { outcome: "revisionMismatch", currentRevision } as const;
			if (this.#database.query("SELECT 1 AS found FROM runtime_configuration_intents WHERE runtime_id=?").get(id)) return { outcome: "intentExists" } as const;
			this.#database.run("UPDATE resources SET scope_id=?,revision=?,body=? WHERE resource_kind='runtime' AND resource_id=? AND revision=?", [runtime.scopeId, revision, body, id, expectedRevision]);
			this.#database.run("INSERT INTO runtime_configuration_intents(runtime_id,operation_id,browser_policy,idle_policy) VALUES (?,?,?,?)", [id, intent.operationId, intent.browserPolicy, intent.idlePolicy === undefined ? null : encodeJson(intent.idlePolicy as unknown as JsonValue, "idlePolicy")]);
			const appended = this.#appendEventInTransaction(event);
			return { outcome: "updated", resource: runtime, ...appended };
		});
	}

	compareAndSwapRuntimeWithStartAttempt(request: { readonly id: RuntimeId; readonly expectedRevision: Revision; readonly value: ResourceUpdate<"runtime">; readonly event: ResourceEventDraft; readonly generation: Generation; readonly token: string }): { readonly outcome: "updated"; readonly resource: Runtime; readonly attempt: RuntimeStartAttempt; readonly event: InfrastructureEvent; readonly cursor: string } | { readonly outcome: "revisionMismatch"; readonly currentRevision: Revision } | { readonly outcome: "notFound" } | { readonly outcome: "attemptExists" } {
		this.#assertOpen();
		exactKeys(request, ["id", "expectedRevision", "value", "event", "generation", "token"], "request");
		const id = decodeOpaqueId(request.id) as RuntimeId;
		const expectedRevision = decodeRevision(request.expectedRevision);
		const generation = decodeGeneration(request.generation);
		const token = decodeOpaqueId(request.token);
		const revision = this.#newOpaque("rev", 18);
		const runtime = this.#decodeInputResource("runtime", { ...request.value, id, revision, generation }) as Runtime;
		const body = encodeJson(runtime, "resource");
		const event = this.#resourceEvent("runtime", id, runtime.scopeId, revision, request.event);
		return this.#transaction(() => {
			const current = this.#database.query("SELECT scope_id,revision,body FROM resources WHERE resource_kind='runtime' AND resource_id=?").get(id) as Record<string, unknown> | null;
			if (!current) return { outcome: "notFound" } as const;
			this.#validatedStoredResource("runtime", id, current);
			const currentRevision = decodeRevision(current.revision);
			if (currentRevision !== expectedRevision) return { outcome: "revisionMismatch", currentRevision } as const;
			if (this.#database.query("SELECT 1 AS found FROM runtime_start_attempts WHERE runtime_id=?").get(id)) return { outcome: "attemptExists" } as const;
			this.#database.run("UPDATE resources SET scope_id=?,revision=?,body=? WHERE resource_kind='runtime' AND resource_id=? AND revision=?", [runtime.scopeId, revision, body, id, expectedRevision]);
			this.#database.run("INSERT INTO runtime_start_attempts(runtime_id,revision,generation,token) VALUES (?,?,?,?)", [id, revision, generation, token]);
			const appended = this.#appendEventInTransaction(event);
			return { outcome: "updated", resource: runtime, attempt: { runtimeId: id, revision, generation, token }, ...appended };
		});
	}

	getRuntimeStartAttempt(runtimeIdValue: RuntimeId): RuntimeStartAttempt | undefined {
		this.#assertOpen();
		const runtimeId = decodeOpaqueId(runtimeIdValue) as RuntimeId;
		const row = this.#database.query("SELECT revision,generation,token FROM runtime_start_attempts WHERE runtime_id=?").get(runtimeId) as { revision: string; generation: string; token: string } | null;
		return row ? { runtimeId, revision: decodeRevision(row.revision), generation: decodeGeneration(row.generation), token: decodeOpaqueId(row.token) } : undefined;
	}

	completeRuntimeStartAttempt(runtimeIdValue: RuntimeId, revisionValue: Revision, tokenValue: string): boolean {
		this.#assertOpen();
		const runtimeId = decodeOpaqueId(runtimeIdValue);
		const revision = decodeRevision(revisionValue);
		const token = decodeOpaqueId(tokenValue);
		return this.#database.run("DELETE FROM runtime_start_attempts WHERE runtime_id=? AND revision=? AND token=?", [runtimeId, revision, token]).changes === 1;
	}

	deleteResource(request: { readonly kind: ResourceKind; readonly id: string; readonly expectedRevision: Revision }): { readonly outcome: "deleted" } | { readonly outcome: "revisionMismatch"; readonly currentRevision: Revision } | { readonly outcome: "notFound" } {
		this.#assertOpen();
		exactKeys(request, ["kind", "id", "expectedRevision"], "request");
		const kind = resourceKind(request.kind);
		const id = decodeOpaqueId(request.id);
		const expectedRevision = decodeRevision(request.expectedRevision);
		return this.#transaction(() => {
			const current = this.#database.query("SELECT scope_id,revision,body FROM resources WHERE resource_kind=? AND resource_id=?").get(kind, id) as Record<string, unknown> | null;
			if (!current) return { outcome: "notFound" } as const;
			this.#validatedStoredResource(kind, id, current);
			const currentRevision = decodeRevision(current.revision);
			if (currentRevision !== expectedRevision) return { outcome: "revisionMismatch", currentRevision } as const;
			this.#database.run("DELETE FROM resources WHERE resource_kind=? AND resource_id=? AND revision=?", [kind, id, expectedRevision]);
			return { outcome: "deleted" } as const;
		});
	}

	deleteResourceWithEvent(request: { readonly kind: ResourceKind; readonly id: string; readonly expectedRevision: Revision; readonly event: ResourceEventDraft }): { readonly outcome: "deleted"; readonly event: InfrastructureEvent; readonly cursor: string } | { readonly outcome: "revisionMismatch"; readonly currentRevision: Revision } | { readonly outcome: "notFound" } {
		this.#assertOpen();
		exactKeys(request, ["kind", "id", "expectedRevision", "event"], "request");
		const kind = resourceKind(request.kind);
		const id = decodeOpaqueId(request.id);
		const expectedRevision = decodeRevision(request.expectedRevision);
		return this.#transaction(() => {
			const current = this.#database.query("SELECT scope_id,revision,body FROM resources WHERE resource_kind=? AND resource_id=?").get(kind, id) as Record<string, unknown> | null;
			if (!current) return { outcome: "notFound" } as const;
			const resource = this.#validatedStoredResource(kind, id, current);
			const currentRevision = decodeRevision(current.revision);
			if (currentRevision !== expectedRevision) return { outcome: "revisionMismatch", currentRevision } as const;
			const scopeId = kind === "scope" ? resource.id : (resource as Workspace | Runtime).scopeId;
			const event = this.#resourceEvent(kind, id, scopeId, currentRevision, request.event);
			this.#database.run("DELETE FROM resources WHERE resource_kind=? AND resource_id=? AND revision=?", [kind, id, expectedRevision]);
			const appended = this.#appendEventInTransaction(event);
			return { outcome: "deleted", ...appended } as const;
		});
	}

	deleteResourceWithTombstoneAndEvent(request: { readonly kind: ResourceKind; readonly id: string; readonly scopeId: ScopeId; readonly expectedRevision: Revision; readonly deletedAt: Timestamp; readonly cleanupRequired: boolean; readonly event: ResourceEventDraft }): { readonly outcome: "deleted"; readonly tombstone: Tombstone; readonly event: InfrastructureEvent; readonly cursor: string } | { readonly outcome: "revisionMismatch"; readonly currentRevision: Revision } | { readonly outcome: "notFound" } | { readonly outcome: "scopeMismatch" } | { readonly outcome: "tombstoneCapacityExceeded" } {
		this.#assertOpen();
		exactKeys(request, ["kind", "id", "scopeId", "expectedRevision", "deletedAt", "cleanupRequired", "event"], "request");
		const kind = resourceKind(request.kind);
		input(kind === "workspace" || kind === "runtime", "backend cleanup records require workspace or runtime");
		input(typeof request.cleanupRequired === "boolean", "cleanupRequired must be boolean");
		const id = decodeOpaqueId(request.id);
		const scopeId = decodeOpaqueId(request.scopeId);
		const expectedRevision = decodeRevision(request.expectedRevision);
		const deletedAt = decodeTimestamp(request.deletedAt);
		const createdAt = this.#nowMs();
		input(Date.parse(deletedAt) <= createdAt, "deletedAt cannot be in the future");
		return this.#transaction(() => {
			const row = this.#database.query("SELECT scope_id,revision,body FROM resources WHERE resource_kind=? AND resource_id=?").get(kind, id) as Record<string, unknown> | null;
			if (!row) return { outcome: "notFound" } as const;
			const resource = this.#validatedStoredResource(kind, id, row);
			if (resource.revision !== expectedRevision) return { outcome: "revisionMismatch", currentRevision: resource.revision } as const;
			const resourceScopeId = (resource as Workspace | Runtime).scopeId;
			if (resourceScopeId !== scopeId) return { outcome: "scopeMismatch" } as const;
			this.#cleanupTombstonesInTransaction(scopeId);
			let tombstone: Tombstone;
			const existing = this.#database.query("SELECT deleted_at,created_at,expires_at FROM tombstones WHERE scope_id=? AND resource_kind=? AND resource_id=?").get(scopeId, kind, id) as Record<string, unknown> | null;
			if (existing) tombstone = this.#tombstoneFromRow(scopeId, kind, id, existing);
			else {
				const countRow = this.#database.query("SELECT COUNT(*) AS count FROM tombstones WHERE scope_id=?").get(scopeId) as { count: number };
				if (Number(countRow.count) >= this.#maximumTombstonesPerScope) return { outcome: "tombstoneCapacityExceeded" } as const;
				const expiresAt = createdAt + this.#tombstoneRetentionMs;
				this.#database.run("INSERT INTO tombstones(scope_id,resource_kind,resource_id,deleted_at,created_at,expires_at) VALUES (?,?,?,?,?,?)", [scopeId, kind, id, deletedAt, createdAt, expiresAt]);
				tombstone = { scopeId, resourceKind: kind, resourceId: id, deletedAt, expiresAt: iso(expiresAt) };
			}
			this.#database.run("INSERT OR REPLACE INTO backend_cleanups(resource_kind,resource_id,scope_id,cleanup_required,completed) VALUES (?,?,?,?,0)", [kind, id, scopeId, request.cleanupRequired ? 1 : 0]);
			this.#database.run("DELETE FROM resources WHERE resource_kind=? AND resource_id=? AND revision=?", [kind, id, expectedRevision]);
			const appended = this.#appendEventInTransaction(this.#resourceEvent(kind, id, scopeId, expectedRevision, request.event));
			return { outcome: "deleted", tombstone, ...appended };
		});
	}

	finalizeRuntimeDeletion(request: { readonly runtimeId: RuntimeId; readonly expectedRevision: Revision; readonly deletedAt: Timestamp; readonly runtimeEvent: ResourceEventDraft; readonly workspaceEvent: ResourceEventDraft }): { readonly outcome: "deleted"; readonly workspace: Workspace; readonly tombstone: Tombstone; readonly events: readonly [InfrastructureEvent, InfrastructureEvent]; readonly cursor: string } | { readonly outcome: "revisionMismatch"; readonly currentRevision: Revision } | { readonly outcome: "notFound" } | { readonly outcome: "invalidState"; readonly reason: "RuntimeNotDeleting" | "WorkspaceAttachmentMissing" } | { readonly outcome: "tombstoneCapacityExceeded" } {
		this.#assertOpen();
		exactKeys(request, ["runtimeId", "expectedRevision", "deletedAt", "runtimeEvent", "workspaceEvent"], "request");
		const runtimeId = decodeOpaqueId(request.runtimeId);
		const expectedRevision = decodeRevision(request.expectedRevision);
		const deletedAt = decodeTimestamp(request.deletedAt);
		const createdAt = this.#nowMs();
		input(Date.parse(deletedAt) <= createdAt, "deletedAt cannot be in the future");
		const workspaceRevision = this.#newOpaque("rev", 18);
		return this.#transaction(() => {
			const runtimeRow = this.#database.query("SELECT scope_id,revision,body FROM resources WHERE resource_kind='runtime' AND resource_id=?").get(runtimeId) as Record<string, unknown> | null;
			if (!runtimeRow) return { outcome: "notFound" } as const;
			const runtime = this.#validatedStoredResource("runtime", runtimeId, runtimeRow) as Runtime;
			if (runtime.revision !== expectedRevision) return { outcome: "revisionMismatch", currentRevision: runtime.revision } as const;
			if (runtime.phase !== "Deleting") return { outcome: "invalidState", reason: "RuntimeNotDeleting" } as const;
			const workspaceRow = this.#database.query("SELECT scope_id,revision,body FROM resources WHERE resource_kind='workspace' AND resource_id=?").get(runtime.workspaceId) as Record<string, unknown> | null;
			if (!workspaceRow) return { outcome: "invalidState", reason: "WorkspaceAttachmentMissing" } as const;
			const workspace = this.#validatedStoredResource("workspace", runtime.workspaceId, workspaceRow) as Workspace;
			if (workspace.attachmentCount <= 0) return { outcome: "invalidState", reason: "WorkspaceAttachmentMissing" } as const;
			this.#cleanupTombstonesInTransaction(runtime.scopeId);
			let tombstone: Tombstone;
			const existing = this.#database.query("SELECT deleted_at,created_at,expires_at FROM tombstones WHERE scope_id=? AND resource_kind='runtime' AND resource_id=?").get(runtime.scopeId, runtimeId) as Record<string, unknown> | null;
			if (existing) tombstone = this.#tombstoneFromRow(runtime.scopeId, "runtime", runtimeId, existing);
			else {
				const countRow = this.#database.query("SELECT COUNT(*) AS count FROM tombstones WHERE scope_id=?").get(runtime.scopeId) as { count: number };
				if (Number(countRow.count) >= this.#maximumTombstonesPerScope) return { outcome: "tombstoneCapacityExceeded" } as const;
				const expiresAt = createdAt + this.#tombstoneRetentionMs;
				this.#database.run("INSERT INTO tombstones(scope_id,resource_kind,resource_id,deleted_at,created_at,expires_at) VALUES (?,'runtime',?,?,?,?)", [runtime.scopeId, runtimeId, deletedAt, createdAt, expiresAt]);
				tombstone = { scopeId: runtime.scopeId, resourceKind: "runtime", resourceId: runtimeId, deletedAt, expiresAt: iso(expiresAt) };
			}
			const detached: Workspace = { ...workspace, attachmentCount: workspace.attachmentCount - 1, revision: workspaceRevision, updatedAt: request.workspaceEvent.timestamp };
			const workspaceBody = encodeJson(this.#decodeInputResource("workspace", detached), "resource");
			this.#database.run("UPDATE resources SET revision=?,body=? WHERE resource_kind='workspace' AND resource_id=? AND revision=?", [workspaceRevision, workspaceBody, workspace.id, workspace.revision]);
			this.#database.run("DELETE FROM runtime_configuration_intents WHERE runtime_id=?", [runtimeId]);
			this.#database.run("DELETE FROM runtime_start_attempts WHERE runtime_id=?", [runtimeId]);
			this.#database.run("INSERT OR REPLACE INTO backend_cleanups(resource_kind,resource_id,scope_id,cleanup_required,completed) VALUES ('runtime',?,?,1,0)", [runtimeId, runtime.scopeId]);
			this.#database.run("DELETE FROM resources WHERE resource_kind='runtime' AND resource_id=? AND revision=?", [runtimeId, expectedRevision]);
			const workspaceEvent = this.#appendEventInTransaction(this.#resourceEvent("workspace", workspace.id, workspace.scopeId, workspaceRevision, request.workspaceEvent)).event;
			const runtimeAppend = this.#appendEventInTransaction(this.#resourceEvent("runtime", runtimeId, runtime.scopeId, runtime.revision, request.runtimeEvent));
			return { outcome: "deleted", workspace: detached, tombstone, events: [workspaceEvent, runtimeAppend.event] as const, cursor: runtimeAppend.cursor };
		});
	}

	getBackendCleanup(resourceKindValue: "workspace" | "runtime", resourceIdValue: string): BackendCleanupRecord | undefined {
		this.#assertOpen();
		input(resourceKindValue === "workspace" || resourceKindValue === "runtime", "backend cleanup resource kind is unsupported");
		const resourceId = decodeOpaqueId(resourceIdValue);
		const row = this.#database.query("SELECT scope_id,cleanup_required,completed FROM backend_cleanups WHERE resource_kind=? AND resource_id=?").get(resourceKindValue, resourceId) as { scope_id: string; cleanup_required: number; completed: number } | null;
		if (!row) return undefined;
		input((row.cleanup_required === 0 || row.cleanup_required === 1) && (row.completed === 0 || row.completed === 1), "backend cleanup record is corrupt");
		return { resourceKind: resourceKindValue, resourceId, scopeId: decodeOpaqueId(row.scope_id), cleanupRequired: row.cleanup_required === 1, completed: row.completed === 1 };
	}

	completeBackendCleanup(resourceKindValue: "workspace" | "runtime", resourceIdValue: string): boolean {
		this.#assertOpen();
		input(resourceKindValue === "workspace" || resourceKindValue === "runtime", "backend cleanup resource kind is unsupported");
		const resourceId = decodeOpaqueId(resourceIdValue);
		return this.#database.run("UPDATE backend_cleanups SET completed=1 WHERE resource_kind=? AND resource_id=? AND completed=0", [resourceKindValue, resourceId]).changes === 1;
	}

	identifierWasIssued(kindValue: ResourceKind, idValue: string): boolean {
		this.#assertOpen();
		const kind = resourceKind(kindValue);
		const id = decodeOpaqueId(idValue);
		return Boolean(this.#database.query("SELECT 1 AS found FROM issued_identifiers WHERE resource_kind=? AND resource_id=?").get(kind, id));
	}

	listResources(request: { readonly scopeId: ScopeId; readonly kinds?: readonly ResourceKind[]; readonly limit?: number; readonly pageCursor?: string }): ResourceListPage {
		this.#assertOpen();
		exactKeys(request, ["scopeId", "kinds", "limit", "pageCursor"], "request");
		const scopeId = decodeOpaqueId(request.scopeId);
		const kinds = request.kinds === undefined ? ["runtime", "scope", "workspace"] : [...request.kinds].sort();
		input(kinds.length >= 1 && kinds.length <= 3 && new Set(kinds).size === kinds.length, "kinds must be a non-empty unique resource-kind list");
		for (const kind of kinds) resourceKind(kind);
		const limit = boundedInteger(request.limit ?? MAX_LIST_LIMIT, 1, MAX_LIST_LIMIT, "limit");
		const page = request.pageCursor === undefined ? undefined : this.#decodeResourcePageCursor(scopeId, kinds, request.pageCursor);
		return this.#transaction(() => {
			const now = this.#nowMs();
			this.#database.run("DELETE FROM resource_snapshots WHERE expires_at<=?", [now]);
			if (page) {
				const snapshot = this.#database.query("SELECT scope_id,kinds,high_water,item_count,expires_at FROM resource_snapshots WHERE snapshot_id=?").get(page.snapshotId) as Record<string, unknown> | null;
				if (!snapshot || snapshot.scope_id !== scopeId || snapshot.kinds !== kinds.join(",") || Number(snapshot.high_water) !== page.highWater || Number(snapshot.expires_at) <= now) throw new ControlStoreInputError("Resource page cursor has expired or lost snapshot authority");
				const itemCount = Number(snapshot.item_count);
				if (!Number.isSafeInteger(itemCount) || itemCount < page.offset || itemCount > MAX_RESOURCE_SNAPSHOT_ITEMS) throw new ControlStoreStateError("Resource snapshot metadata is corrupt");
				const rows = this.#database.query("SELECT resource_kind,resource_id,scope_id,revision,body FROM resource_snapshot_items WHERE snapshot_id=? AND ordinal>=? ORDER BY ordinal LIMIT ?").all(page.snapshotId, page.offset, limit + 1) as Record<string, unknown>[];
				if (rows.length !== Math.min(itemCount - page.offset, limit + 1)) throw new ControlStoreStateError("Resource snapshot contains a pagination gap");
				const visible = rows.slice(0, limit);
				const items = visible.map((row) => this.#validatedStoredResource(resourceKind(String(row.resource_kind)), String(row.resource_id), row));
				if (rows.length <= limit) {
					this.#database.run("DELETE FROM resource_snapshots WHERE snapshot_id=?", [page.snapshotId]);
					return { items, highWaterCursor: this.#encodeCursor(scopeId, page.highWater) };
				}
				return { items, highWaterCursor: this.#encodeCursor(scopeId, page.highWater), nextPageCursor: this.#encodeResourcePageCursor(scopeId, kinds, page.highWater, page.snapshotId, page.offset + limit) };
			}
			const placeholders = kinds.map(() => "?").join(",");
			const countRow = this.#database.query(`SELECT COUNT(*) AS count FROM resources WHERE scope_id=? AND resource_kind IN (${placeholders})`).get(scopeId, ...kinds) as Record<string, unknown>;
			const count = Number(countRow.count);
			if (!Number.isSafeInteger(count) || count < 0 || count > MAX_RESOURCE_SNAPSHOT_ITEMS) throw new ControlStoreStateError("Resource baseline exceeds the bounded snapshot capacity");
			const head = this.#journalHead(scopeId);
			if (count <= limit) {
				const rows = this.#database.query(`SELECT resource_kind,resource_id,scope_id,revision,body FROM resources WHERE scope_id=? AND resource_kind IN (${placeholders}) ORDER BY resource_kind,resource_id`).all(scopeId, ...kinds) as Record<string, unknown>[];
				return { items: rows.map((row) => this.#validatedStoredResource(resourceKind(String(row.resource_kind)), String(row.resource_id), row)), highWaterCursor: this.#encodeCursor(scopeId, head) };
			}
			const activeRow = this.#database.query("SELECT COUNT(*) AS count FROM resource_snapshots WHERE scope_id=?").get(scopeId) as Record<string, unknown>;
			const activeSnapshots = Number(activeRow.count);
			if (!Number.isSafeInteger(activeSnapshots) || activeSnapshots < 0 || activeSnapshots >= MAX_ACTIVE_RESOURCE_SNAPSHOTS_PER_SCOPE) throw new ControlStoreStateError("Resource snapshot capacity is exhausted for this scope");
			const snapshotId = Buffer.from(this.#checkedRandom(18)).toString("base64url");
			this.#database.run("INSERT INTO resource_snapshots(snapshot_id,scope_id,kinds,high_water,item_count,expires_at) VALUES (?,?,?,?,?,?)", [snapshotId, scopeId, kinds.join(","), head, count, now + RESOURCE_SNAPSHOT_TTL_MS]);
			this.#database.run(`INSERT INTO resource_snapshot_items(snapshot_id,ordinal,resource_kind,resource_id,scope_id,revision,body) SELECT ?,ROW_NUMBER() OVER (ORDER BY resource_kind,resource_id)-1,resource_kind,resource_id,scope_id,revision,body FROM resources WHERE scope_id=? AND resource_kind IN (${placeholders}) ORDER BY resource_kind,resource_id`, [snapshotId, scopeId, ...kinds]);
			const rows = this.#database.query("SELECT resource_kind,resource_id,scope_id,revision,body FROM resource_snapshot_items WHERE snapshot_id=? ORDER BY ordinal LIMIT ?").all(snapshotId, limit) as Record<string, unknown>[];
			return {
				items: rows.map((row) => this.#validatedStoredResource(resourceKind(String(row.resource_kind)), String(row.resource_id), row)),
				highWaterCursor: this.#encodeCursor(scopeId, head),
				nextPageCursor: this.#encodeResourcePageCursor(scopeId, kinds, head, snapshotId, limit),
			};
		});
	}

	reserveIdempotency(request: IdempotencyKey): IdempotencyReservation {
		this.#assertOpen();
		exactKeys(request, ["principalId", "scopeId", "method", "canonicalPath", "idempotencyKey", "canonicalBodyDigest"], "request");
		this.#validateIdempotency(request);
		return this.#transaction(() => {
			const row = this.#database.query("SELECT canonical_body_digest,reservation_token,state,result FROM idempotency WHERE principal_id=? AND scope_id=? AND method=? AND canonical_path=? AND idempotency_key=?").get(request.principalId, request.scopeId, request.method, request.canonicalPath, request.idempotencyKey) as Record<string, unknown> | null;
			if (row) {
				const storedDigest = boundedText(String(row.canonical_body_digest), 64, 64, "stored canonicalBodyDigest", /^[a-f0-9]{64}$/u);
				if (storedDigest !== request.canonicalBodyDigest) return { outcome: "conflict" };
				if (row.state === "pending" && row.result === null) return { outcome: "pending" };
				if (row.state === "complete" && typeof row.result === "string") return { outcome: "replay", result: parseJson(row.result, "stored idempotency result") };
				throw new ControlStoreStateError("Idempotency record is corrupt");
			}
			const reservationToken = this.#newOpaque("res", 24);
			this.#database.run("INSERT INTO idempotency(principal_id,scope_id,method,canonical_path,idempotency_key,canonical_body_digest,reservation_token,state,result,completed_at,expires_at) VALUES (?,?,?,?,?,?,?,'pending',NULL,NULL,NULL)", [request.principalId, request.scopeId, request.method, request.canonicalPath, request.idempotencyKey, request.canonicalBodyDigest, reservationToken]);
			return { outcome: "new", reservationToken };
		});
	}

	completeIdempotency(request: IdempotencyKey & { readonly reservationToken: string; readonly result: JsonValue }): { readonly outcome: "completed" } | { readonly outcome: "alreadyCompleted"; readonly result: JsonValue } | { readonly outcome: "reservationMismatch" } | { readonly outcome: "notFound" } {
		this.#assertOpen();
		exactKeys(request, ["principalId", "scopeId", "method", "canonicalPath", "idempotencyKey", "canonicalBodyDigest", "reservationToken", "result"], "request");
		this.#validateIdempotency(request);
		const reservationToken = boundedText(request.reservationToken, 1, 128, "reservationToken", /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u);
		const result = encodeJson(request.result, "result");
		return this.#transaction(() => {
			const row = this.#database.query("SELECT canonical_body_digest,reservation_token,state,result FROM idempotency WHERE principal_id=? AND scope_id=? AND method=? AND canonical_path=? AND idempotency_key=?").get(request.principalId, request.scopeId, request.method, request.canonicalPath, request.idempotencyKey) as Record<string, unknown> | null;
			if (!row) return { outcome: "notFound" };
			if (row.canonical_body_digest !== request.canonicalBodyDigest || row.reservation_token !== reservationToken) return { outcome: "reservationMismatch" };
			if (row.state === "complete" && typeof row.result === "string") return { outcome: "alreadyCompleted", result: parseJson(row.result, "stored idempotency result") };
			if (row.state !== "pending" || row.result !== null) throw new ControlStoreStateError("Idempotency record is corrupt");
			const completedAt = this.#nowMs();
			this.#database.run("UPDATE idempotency SET state='complete',result=?,completed_at=?,expires_at=? WHERE principal_id=? AND scope_id=? AND method=? AND canonical_path=? AND idempotency_key=? AND reservation_token=? AND state='pending'", [result, completedAt, completedAt + this.#idempotencyRetentionMs, request.principalId, request.scopeId, request.method, request.canonicalPath, request.idempotencyKey, reservationToken]);
			return { outcome: "completed" };
		});
	}
	releaseIdempotency(request: IdempotencyKey & { readonly reservationToken: string }): { readonly outcome: "released" | "reservationMismatch" | "notFound" } {
		this.#assertOpen();
		exactKeys(request, ["principalId", "scopeId", "method", "canonicalPath", "idempotencyKey", "canonicalBodyDigest", "reservationToken"], "request");
		this.#validateIdempotency(request);
		const reservationToken = boundedText(request.reservationToken, 1, 128, "reservationToken", /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u);
		return this.#transaction(() => {
			const row = this.#database.query("SELECT canonical_body_digest,reservation_token,state FROM idempotency WHERE principal_id=? AND scope_id=? AND method=? AND canonical_path=? AND idempotency_key=?").get(request.principalId, request.scopeId, request.method, request.canonicalPath, request.idempotencyKey) as Record<string, unknown> | null;
			if (!row) return { outcome: "notFound" };
			if (row.canonical_body_digest !== request.canonicalBodyDigest || row.reservation_token !== reservationToken || row.state !== "pending") return { outcome: "reservationMismatch" };
			this.#database.run("DELETE FROM idempotency WHERE principal_id=? AND scope_id=? AND method=? AND canonical_path=? AND idempotency_key=? AND reservation_token=? AND state='pending'", [request.principalId, request.scopeId, request.method, request.canonicalPath, request.idempotencyKey, reservationToken]);
			return { outcome: "released" };
		});
	}


	reconcileIdempotency(request: IdempotencyKey & { readonly result: JsonValue }): { readonly outcome: "completed" } | { readonly outcome: "alreadyCompleted"; readonly result: JsonValue } | { readonly outcome: "conflict" } | { readonly outcome: "notFound" } {
		this.#assertOpen();
		exactKeys(request, ["principalId", "scopeId", "method", "canonicalPath", "idempotencyKey", "canonicalBodyDigest", "result"], "request");
		this.#validateIdempotency(request);
		const result = encodeJson(request.result, "result");
		return this.#transaction(() => {
			const row = this.#database.query("SELECT canonical_body_digest,state,result FROM idempotency WHERE principal_id=? AND scope_id=? AND method=? AND canonical_path=? AND idempotency_key=?").get(request.principalId, request.scopeId, request.method, request.canonicalPath, request.idempotencyKey) as Record<string, unknown> | null;
			if (!row) return { outcome: "notFound" };
			if (row.canonical_body_digest !== request.canonicalBodyDigest) return { outcome: "conflict" };
			if (row.state === "complete" && typeof row.result === "string") return { outcome: "alreadyCompleted", result: parseJson(row.result, "stored idempotency result") };
			if (row.state !== "pending" || row.result !== null) throw new ControlStoreStateError("Idempotency record is corrupt");
			const completedAt = this.#nowMs();
			this.#database.run("UPDATE idempotency SET state='complete',result=?,completed_at=?,expires_at=? WHERE principal_id=? AND scope_id=? AND method=? AND canonical_path=? AND idempotency_key=? AND state='pending'", [result, completedAt, completedAt + this.#idempotencyRetentionMs, request.principalId, request.scopeId, request.method, request.canonicalPath, request.idempotencyKey]);
			return { outcome: "completed" };
		});
	}

	cleanupIdempotency(): number {
		this.#assertOpen();
		return this.#database.run("DELETE FROM idempotency WHERE state='complete' AND expires_at<=?", [this.#nowMs()]).changes;
	}

	mintTicket(request: TicketBinding & { readonly ttlSeconds: number }): { readonly ticket: string; readonly expiresAt: Timestamp } {
		this.#assertOpen();
		exactKeys(request, ["principalId", "scopeId", "audience", "runtimeId", "runtimeGeneration", "providerControlGeneration", "purpose", "ttlSeconds"], "request");
		const binding = this.#validateTicketBinding(request);
		const ttlSeconds = boundedInteger(request.ttlSeconds, 1, MAX_TICKET_TTL_SECONDS, "ttlSeconds");
		const ticket = Buffer.from(this.#checkedRandom(32)).toString("base64url");
		const digest = createHash("sha256").update(ticket).digest("hex");
		const now = this.#nowMs();
		const expiresAt = now + ttlSeconds * 1000;
		this.#transaction(() => {
			this.#database.run("DELETE FROM tickets WHERE expires_at<=?", [now]);
			this.#database.run("INSERT INTO tickets(digest,principal_id,scope_id,audience,runtime_id,runtime_generation,provider_control_generation,purpose,expires_at) VALUES (?,?,?,?,?,?,?,?,?)", [digest, binding.principalId, binding.scopeId, binding.audience, binding.runtimeId, binding.runtimeGeneration, binding.providerControlGeneration, binding.purpose, expiresAt]);
		});
		return { ticket, expiresAt: iso(expiresAt) };
	}

	consumeTicket(request: TicketBinding & { readonly ticket: string }): boolean {
		this.#assertOpen();
		exactKeys(request, ["principalId", "scopeId", "audience", "runtimeId", "runtimeGeneration", "providerControlGeneration", "purpose", "ticket"], "request");
		const binding = this.#validateTicketBinding(request);
		const ticket = boundedText(request.ticket, 32, 128, "ticket", /^[A-Za-z0-9_-]+$/u);
		const digest = createHash("sha256").update(ticket).digest("hex");
		return this.#database.run("DELETE FROM tickets WHERE digest=? AND principal_id=? AND scope_id=? AND audience=? AND runtime_id=? AND runtime_generation=? AND provider_control_generation=? AND purpose=? AND expires_at>?", [digest, binding.principalId, binding.scopeId, binding.audience, binding.runtimeId, binding.runtimeGeneration, binding.providerControlGeneration, binding.purpose, this.#nowMs()]).changes === 1;
	}

	consumeTicketForTransport(request: TicketConsumeSelector): TicketConsumeOutcome {
		this.#assertOpen();
		exactKeys(request, ["ticket", "principalId", "audience", "providerControlGeneration", "purpose"], "request");
		const ticket = boundedText(request.ticket, 32, 128, "ticket", /^[A-Za-z0-9_-]+$/u);
		const principalId = boundedText(request.principalId, 1, 512, "principalId");
		const audience = boundedText(request.audience, 1, 128, "audience", /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u);
		const providerControlGeneration = decodeGeneration(request.providerControlGeneration);
		const purpose = boundedText(request.purpose, 1, 128, "purpose", /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u);
		const digest = createHash("sha256").update(ticket).digest("hex");
		const row = this.#database.query(
			"DELETE FROM tickets WHERE digest=? AND principal_id=? AND audience=? AND provider_control_generation=? AND purpose=? AND expires_at>? RETURNING principal_id,scope_id,audience,runtime_id,runtime_generation,provider_control_generation,purpose",
		).get(digest, principalId, audience, providerControlGeneration, purpose, this.#nowMs()) as { principal_id: string; scope_id: string; audience: string; runtime_id: string; runtime_generation: string; provider_control_generation: string; purpose: string } | null;
		if (!row) return { outcome: "rejected" };
		return {
			outcome: "consumed",
			binding: this.#validateTicketBinding({
				principalId: row.principal_id,
				scopeId: row.scope_id,
				audience: row.audience,
				runtimeId: row.runtime_id,
				runtimeGeneration: row.runtime_generation,
				providerControlGeneration: row.provider_control_generation,
				purpose: row.purpose,
			}),
		};
	}

	revokeTicket(ticketValue: string): boolean {
		this.#assertOpen();
		const ticket = boundedText(ticketValue, 32, 128, "ticket", /^[A-Za-z0-9_-]+$/u);
		const digest = createHash("sha256").update(ticket).digest("hex");
		return this.#database.run("DELETE FROM tickets WHERE digest=?", [digest]).changes === 1;
	}

	revokeTickets(request: TicketRevocation): number {
		this.#assertOpen();
		const scopeId = decodeOpaqueId(request.scopeId);
		const runtimeId = decodeOpaqueId(request.runtimeId);
		if (request.cause === "controlDisconnect" || request.cause === "providerControlGenerationReplacement") {
			exactKeys(request, ["cause", "scopeId", "runtimeId", "providerControlGeneration"], "request");
			const generation = decodeGeneration(request.providerControlGeneration);
			return this.#database.run("DELETE FROM tickets WHERE scope_id=? AND runtime_id=? AND provider_control_generation=?", [scopeId, runtimeId, generation]).changes;
		}
		if (request.cause === "runtimeGenerationReplacement") {
			exactKeys(request, ["cause", "scopeId", "runtimeId", "runtimeGeneration"], "request");
			const generation = decodeGeneration(request.runtimeGeneration);
			return this.#database.run("DELETE FROM tickets WHERE scope_id=? AND runtime_id=? AND runtime_generation=?", [scopeId, runtimeId, generation]).changes;
		}
		exactKeys(request, ["cause", "scopeId", "runtimeId", "runtimeGeneration", "providerControlGeneration", "purpose"], "request");
		const clauses = ["scope_id=?", "runtime_id=?"];
		const bindings: (string | number)[] = [scopeId, runtimeId];
		if (request.runtimeGeneration !== undefined) { clauses.push("runtime_generation=?"); bindings.push(decodeGeneration(request.runtimeGeneration)); }
		if (request.providerControlGeneration !== undefined) { clauses.push("provider_control_generation=?"); bindings.push(decodeGeneration(request.providerControlGeneration)); }
		if (request.purpose !== undefined) { clauses.push("purpose=?"); bindings.push(boundedText(request.purpose, 1, 128, "purpose", /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u)); }
		return this.#database.run(`DELETE FROM tickets WHERE ${clauses.join(" AND ")}`, bindings).changes;
	}

	putTombstone(request: { readonly scopeId: ScopeId; readonly resourceKind: ResourceKind; readonly resourceId: string; readonly deletedAt: Timestamp }): { readonly outcome: "created" | "existing"; readonly tombstone: Tombstone } | { readonly outcome: "capacityExceeded" } {
		this.#assertOpen();
		exactKeys(request, ["scopeId", "resourceKind", "resourceId", "deletedAt"], "request");
		const scopeId = decodeOpaqueId(request.scopeId);
		const kind = resourceKind(request.resourceKind);
		const id = decodeOpaqueId(request.resourceId);
		const deletedAt = decodeTimestamp(request.deletedAt);
		const deletedMs = Date.parse(deletedAt);
		const createdAt = this.#nowMs();
		input(deletedMs <= createdAt, "deletedAt cannot be in the future");
		return this.#transaction(() => {
			this.#cleanupTombstonesInTransaction(scopeId);
			const existing = this.#database.query("SELECT deleted_at,created_at,expires_at FROM tombstones WHERE scope_id=? AND resource_kind=? AND resource_id=?").get(scopeId, kind, id) as Record<string, unknown> | null;
			if (existing) return { outcome: "existing", tombstone: this.#tombstoneFromRow(scopeId, kind, id, existing) };
			const issued = this.#database.query("SELECT scope_id FROM issued_identifiers WHERE resource_kind=? AND resource_id=?").get(kind, id) as Record<string, unknown> | null;
			if (!issued || issued.scope_id !== scopeId) throw new ControlStoreStateError("A tombstone requires an issued identifier in the same scope");
			const countRow = this.#database.query("SELECT COUNT(*) AS count FROM tombstones WHERE scope_id=?").get(scopeId) as { count: number };
			if (Number(countRow.count) >= this.#maximumTombstonesPerScope) return { outcome: "capacityExceeded" };
			const expiresAt = createdAt + this.#tombstoneRetentionMs;
			this.#database.run("INSERT INTO tombstones(scope_id,resource_kind,resource_id,deleted_at,created_at,expires_at) VALUES (?,?,?,?,?,?)", [scopeId, kind, id, deletedAt, createdAt, expiresAt]);
			return { outcome: "created", tombstone: { scopeId, resourceKind: kind, resourceId: id, deletedAt, expiresAt: iso(expiresAt) } };
		});
	}

	getTombstone(request: { readonly scopeId: ScopeId; readonly resourceKind: ResourceKind; readonly resourceId: string }): Tombstone | undefined {
		this.#assertOpen();
		exactKeys(request, ["scopeId", "resourceKind", "resourceId"], "request");
		const scopeId = decodeOpaqueId(request.scopeId);
		const kind = resourceKind(request.resourceKind);
		const id = decodeOpaqueId(request.resourceId);
		return this.#transaction(() => {
			this.#cleanupTombstonesInTransaction(scopeId);
			const row = this.#database.query("SELECT deleted_at,created_at,expires_at FROM tombstones WHERE scope_id=? AND resource_kind=? AND resource_id=?").get(scopeId, kind, id) as Record<string, unknown> | null;
			return row ? this.#tombstoneFromRow(scopeId, kind, id, row) : undefined;
		});
	}

	cleanupTombstones(scopeIdValue: ScopeId): number {
		this.#assertOpen();
		const scopeId = decodeOpaqueId(scopeIdValue);
		return this.#transaction(() => this.#cleanupTombstonesInTransaction(scopeId));
	}

	appendEvent(value: InfrastructureEvent): { readonly event: InfrastructureEvent; readonly cursor: string } {
		this.#assertOpen();
		const event = this.#validateEvent(value);
		return this.#transaction(() => this.#appendEventInTransaction(event));
	}

	readAfter(request: { readonly scopeId: ScopeId; readonly cursor: string; readonly limit?: number }): { readonly outcome: "events"; readonly events: readonly InfrastructureEvent[]; readonly cursor: string } | { readonly outcome: "cursorExpired"; readonly reset: ResetEvent } {
		this.#assertOpen();
		exactKeys(request, ["scopeId", "cursor", "limit"], "request");
		const scopeId = decodeOpaqueId(request.scopeId);
		const sequence = this.#decodeCursor(scopeId, request.cursor);
		const limit = boundedInteger(request.limit ?? MAX_LIST_LIMIT, 1, MAX_LIST_LIMIT, "limit");
		return this.#readTransaction(() => {
			const head = this.#journalHead(scopeId);
			if (sequence > head) throw new ControlStoreInputError("cursor is ahead of the authoritative journal");
			const window = this.#validatedJournalWindow(scopeId, head);
			if ((window.minimum !== null && sequence < window.minimum - 1) || (window.minimum === null && sequence < head)) return { outcome: "cursorExpired", reset: this.#resetEvent() };
			const rows = this.#database.query("SELECT scope_id,sequence,event_id,resource_kind,resource_id,revision,phase,timestamp FROM events WHERE scope_id=? AND sequence>? ORDER BY sequence LIMIT ?").all(scopeId, sequence, limit) as Record<string, unknown>[];
			let expected = sequence + 1;
			for (const row of rows) {
				if (Number(row.sequence) !== expected) throw new ControlStoreStateError("Journal replay contains a sequence gap");
				expected++;
			}
			const events = rows.map(eventFromRow);
			const tail = rows.length === 0 ? sequence : expected - 1;
			if (rows.length === 0 && sequence !== head) throw new ControlStoreStateError("Journal replay ended before its authoritative head");
			if (rows.length < limit && tail !== head) throw new ControlStoreStateError("Journal replay tail disagrees with its authoritative head");
			return { outcome: "events", events, cursor: this.#encodeCursor(scopeId, tail) };
		});
	}

	async *subscribe(request: { readonly scopeId: ScopeId; readonly cursor: string; readonly signal?: AbortSignal; readonly pollMilliseconds?: number; readonly batchLimit?: number }): AsyncGenerator<{ readonly outcome: "events"; readonly events: readonly InfrastructureEvent[]; readonly cursor: string } | { readonly outcome: "cursorExpired"; readonly reset: ResetEvent }, void> {
		exactKeys(request, ["scopeId", "cursor", "signal", "pollMilliseconds", "batchLimit"], "request");
		const scopeId = decodeOpaqueId(request.scopeId);
		let cursor = request.cursor;
		const pollMilliseconds = boundedInteger(request.pollMilliseconds ?? 100, 1, 60_000, "pollMilliseconds");
		const batchLimit = boundedInteger(request.batchLimit ?? MAX_LIST_LIMIT, 1, MAX_LIST_LIMIT, "batchLimit");
		while (!request.signal?.aborted) {
			const result = this.readAfter({ scopeId, cursor, limit: batchLimit });
			if (result.outcome === "cursorExpired") { yield result; return; }
			if (result.events.length > 0) {
				cursor = result.cursor;
				yield result;
				continue;
			}
			await new Promise<void>((resolve) => {
				const finish = () => {
					clearTimeout(timer);
					request.signal?.removeEventListener("abort", finish);
					resolve();
				};
				const timer = setTimeout(finish, pollMilliseconds);
				request.signal?.addEventListener("abort", finish, { once: true });
			});
		}
	}

	#initialize(): void {
		const check = this.#database.query("PRAGMA quick_check").get() as Record<string, unknown> | null;
		if (!check || check.quick_check !== "ok") throw new ControlStoreStateError("SQLite quick_check failed");
		const versionRow = this.#database.query("PRAGMA user_version").get() as Record<string, unknown> | null;
		const version = Number(versionRow?.user_version);
		if (!Number.isSafeInteger(version) || version < 0 || version > SCHEMA_VERSION) throw new ControlStoreStateError("Unsupported control-store schema version");
		this.#database.run("BEGIN IMMEDIATE");
		try {
			this.#database.run("CREATE TABLE IF NOT EXISTS store_metadata(key TEXT PRIMARY KEY,value BLOB NOT NULL)");
			this.#database.run("CREATE TABLE IF NOT EXISTS issued_identifiers(resource_kind TEXT NOT NULL,resource_id TEXT NOT NULL,scope_id TEXT NOT NULL,issued_at INTEGER NOT NULL,PRIMARY KEY(resource_kind,resource_id)) WITHOUT ROWID");
			this.#database.run("CREATE TABLE IF NOT EXISTS resources(resource_kind TEXT NOT NULL,resource_id TEXT NOT NULL,scope_id TEXT NOT NULL,revision TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(resource_kind,resource_id),FOREIGN KEY(resource_kind,resource_id) REFERENCES issued_identifiers(resource_kind,resource_id)) WITHOUT ROWID");
			this.#database.run("CREATE INDEX IF NOT EXISTS resources_by_scope ON resources(scope_id,resource_kind,resource_id)");
			this.#database.run("CREATE TABLE IF NOT EXISTS resource_snapshots(snapshot_id TEXT PRIMARY KEY,scope_id TEXT NOT NULL,kinds TEXT NOT NULL,high_water INTEGER NOT NULL,item_count INTEGER NOT NULL,expires_at INTEGER NOT NULL) WITHOUT ROWID");
			this.#database.run("CREATE INDEX IF NOT EXISTS resource_snapshots_expiry ON resource_snapshots(expires_at)");
			this.#database.run("CREATE TABLE IF NOT EXISTS resource_snapshot_items(snapshot_id TEXT NOT NULL,ordinal INTEGER NOT NULL,resource_kind TEXT NOT NULL,resource_id TEXT NOT NULL,scope_id TEXT NOT NULL,revision TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(snapshot_id,ordinal),FOREIGN KEY(snapshot_id) REFERENCES resource_snapshots(snapshot_id) ON DELETE CASCADE) WITHOUT ROWID");
			this.#database.run("CREATE TABLE IF NOT EXISTS idempotency(principal_id TEXT NOT NULL,scope_id TEXT NOT NULL,method TEXT NOT NULL,canonical_path TEXT NOT NULL,idempotency_key TEXT NOT NULL,canonical_body_digest TEXT NOT NULL,reservation_token TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','complete')),result TEXT,completed_at INTEGER,expires_at INTEGER,PRIMARY KEY(principal_id,scope_id,method,canonical_path,idempotency_key)) WITHOUT ROWID");
			this.#database.run("CREATE INDEX IF NOT EXISTS idempotency_expiry ON idempotency(expires_at) WHERE state='complete'");
			this.#database.run("CREATE TABLE IF NOT EXISTS tickets(digest TEXT PRIMARY KEY,principal_id TEXT NOT NULL,scope_id TEXT NOT NULL,audience TEXT NOT NULL,runtime_id TEXT NOT NULL,runtime_generation TEXT NOT NULL,provider_control_generation TEXT NOT NULL,purpose TEXT NOT NULL,expires_at INTEGER NOT NULL) WITHOUT ROWID");
			this.#database.run("CREATE INDEX IF NOT EXISTS tickets_binding ON tickets(scope_id,runtime_id,runtime_generation,provider_control_generation)");
			this.#database.run("CREATE TABLE IF NOT EXISTS tombstones(scope_id TEXT NOT NULL,resource_kind TEXT NOT NULL,resource_id TEXT NOT NULL,deleted_at TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(scope_id,resource_kind,resource_id),FOREIGN KEY(resource_kind,resource_id) REFERENCES issued_identifiers(resource_kind,resource_id)) WITHOUT ROWID");
			this.#database.run("CREATE INDEX IF NOT EXISTS tombstones_expiry ON tombstones(scope_id,expires_at)");
			this.#database.run("CREATE TABLE IF NOT EXISTS runtime_configuration_intents(runtime_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,browser_policy TEXT NOT NULL,idle_policy TEXT) WITHOUT ROWID");
			this.#database.run("CREATE TABLE IF NOT EXISTS runtime_start_attempts(runtime_id TEXT PRIMARY KEY,revision TEXT NOT NULL,generation TEXT NOT NULL,token TEXT NOT NULL) WITHOUT ROWID");
			this.#database.run("CREATE TABLE IF NOT EXISTS backend_cleanups(resource_kind TEXT NOT NULL,resource_id TEXT NOT NULL,scope_id TEXT NOT NULL,cleanup_required INTEGER NOT NULL CHECK(cleanup_required IN (0,1)),completed INTEGER NOT NULL CHECK(completed IN (0,1)),PRIMARY KEY(resource_kind,resource_id),FOREIGN KEY(resource_kind,resource_id) REFERENCES issued_identifiers(resource_kind,resource_id)) WITHOUT ROWID");
			this.#database.run("CREATE TABLE IF NOT EXISTS journal_heads(scope_id TEXT PRIMARY KEY,head INTEGER NOT NULL CHECK(head>=0)) WITHOUT ROWID");
			this.#database.run("CREATE TABLE IF NOT EXISTS events(scope_id TEXT NOT NULL,sequence INTEGER NOT NULL,event_id TEXT NOT NULL UNIQUE,resource_kind TEXT NOT NULL,resource_id TEXT NOT NULL,revision TEXT NOT NULL,phase TEXT NOT NULL,timestamp TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(scope_id,sequence)) WITHOUT ROWID");
			this.#database.run("CREATE INDEX IF NOT EXISTS events_retention ON events(scope_id,created_at,sequence)");
			let keyRow = this.#database.query("SELECT value FROM store_metadata WHERE key='cursor_hmac_key'").get() as Record<string, unknown> | null;
			if (!keyRow) {
				const key = this.#checkedRandom(32);
				this.#database.run("INSERT INTO store_metadata(key,value) VALUES ('cursor_hmac_key',?)", [key]);
				keyRow = { value: key };
			}
			input(keyRow.value instanceof Uint8Array && keyRow.value.byteLength === 32, "Stored cursor key is malformed");
			this.#cursorKey = new Uint8Array(keyRow.value);
			this.#database.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
			this.#database.run("COMMIT");
		} catch (cause) {
			try { this.#database.run("ROLLBACK"); } catch {}
			throw cause;
		}
	}

	#transaction<T>(action: () => T): T {
		this.#database.run("BEGIN IMMEDIATE");
		try {
			const result = action();
			this.#database.run("COMMIT");
			return result;
		} catch (cause) {
			try { this.#database.run("ROLLBACK"); } catch {}
			throw cause;
		}
	}

	#readTransaction<T>(action: () => T): T {
		this.#database.run("BEGIN");
		try {
			const result = action();
			this.#database.run("COMMIT");
			return result;
		} catch (cause) {
			try { this.#database.run("ROLLBACK"); } catch {}
			throw cause;
		}
	}

	#assertOpen(): void {
		if (this.#closed) throw new ControlStoreStateError("Control store is closed");
	}

	#nowMs(): number {
		return boundedInteger(this.#now(), 0, Number.MAX_SAFE_INTEGER, "clock value");
	}

	#checkedRandom(length: number): Uint8Array {
		const value = this.#randomBytes(length);
		if (!(value instanceof Uint8Array) || value.byteLength !== length) throw new ControlStoreStateError("Random source returned an invalid value");
		return value;
	}

	#newOpaque(prefix: string, bytes: number): string {
		return `${prefix}_${Buffer.from(this.#checkedRandom(bytes)).toString("base64url")}`;
	}

	#decodeInputResource(kind: ResourceKind, value: unknown): PortableResource {
		return kind === "scope" ? decodeScope(value) : kind === "workspace" ? decodeWorkspace(value) : decodeRuntime(value);
	}

	#validatedStoredResource(kind: ResourceKind, id: string, row: Record<string, unknown>): PortableResource {
		if (typeof row.body !== "string") throw new ControlStoreStateError("Stored resource body is malformed");
		const decoded = decodeResource(kind, row.body);
		const expectedScope = kind === "scope" ? decoded.id : (decoded as Workspace | Runtime).scopeId;
		if (decoded.id !== id || decoded.revision !== row.revision || expectedScope !== row.scope_id) throw new ControlStoreStateError("Stored resource metadata disagrees with its body");
		return decoded;
	}

	#validateIdempotency(value: IdempotencyKey): void {
		decodeOpaqueId(value.principalId);
		decodeOpaqueId(value.scopeId);
		boundedText(value.method, 3, 16, "method", /^[A-Z]+$/u);
		boundedText(value.canonicalPath, 1, 2048, "canonicalPath", /^\/(?!\/)(?:[\x21-\x7E])*$/u);
		input(!value.canonicalPath.includes("?") && !value.canonicalPath.includes("#"), "canonicalPath cannot contain a query or fragment");
		boundedText(value.idempotencyKey, 16, 128, "idempotencyKey", /^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/u);
		boundedText(value.canonicalBodyDigest, 64, 64, "canonicalBodyDigest", /^[a-f0-9]{64}$/u);
	}

	#validateTicketBinding(value: TicketBinding): TicketBinding {
		return {
			principalId: decodeOpaqueId(value.principalId),
			scopeId: decodeOpaqueId(value.scopeId),
			audience: boundedText(value.audience, 1, 128, "audience", /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u),
			runtimeId: decodeOpaqueId(value.runtimeId),
			runtimeGeneration: decodeGeneration(value.runtimeGeneration),
			providerControlGeneration: decodeGeneration(value.providerControlGeneration),
			purpose: boundedText(value.purpose, 1, 128, "purpose", /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u),
		};
	}

	#cleanupTombstonesInTransaction(scopeId: ScopeId): number {
		return this.#database.run("DELETE FROM tombstones WHERE scope_id=? AND expires_at<=?", [scopeId, this.#nowMs()]).changes;
	}

	#tombstoneFromRow(scopeId: ScopeId, kind: ResourceKind, id: string, row: Record<string, unknown>): Tombstone {
		try {
			const deletedAt = decodeTimestamp(row.deleted_at);
			const createdAtMs = Number(row.created_at);
			const expiresAtMs = Number(row.expires_at);
			if (!Number.isSafeInteger(createdAtMs) || createdAtMs < Date.parse(deletedAt) || !Number.isSafeInteger(expiresAtMs) || expiresAtMs < createdAtMs + MIN_RETENTION_SECONDS * 1000 || expiresAtMs > createdAtMs + MAX_TOMBSTONE_RETENTION_SECONDS * 1000) throw new Error("invalid retention interval");
			return { scopeId, resourceKind: kind, resourceId: id, deletedAt, expiresAt: iso(expiresAtMs) };
		} catch (cause) {
			throw new ControlStoreStateError(`Stored tombstone is malformed: ${cause instanceof Error ? cause.message : "invalid value"}`);
		}
	}

	#resourceEvent(kind: ResourceKind, id: string, scopeId: ScopeId, revision: Revision, draft: ResourceEventDraft): InfrastructureEvent {
		exactKeys(draft, ["eventId", "phase", "timestamp"], "event");
		return this.#validateEvent({ eventId: draft.eventId, resourceKind: kind, resourceId: id, scopeId, revision, phase: draft.phase, timestamp: draft.timestamp });
	}

	#validateEvent(value: InfrastructureEvent): InfrastructureEvent {
		exactKeys(value, ["eventId", "resourceKind", "resourceId", "scopeId", "revision", "phase", "timestamp"], "event");
		return {
			eventId: boundedText(value.eventId, 1, 128, "eventId", /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u),
			resourceKind: resourceKind(value.resourceKind),
			resourceId: decodeOpaqueId(value.resourceId),
			scopeId: decodeOpaqueId(value.scopeId),
			revision: decodeRevision(value.revision),
			phase: decodePhase(value.phase),
			timestamp: decodeTimestamp(value.timestamp),
		};
	}

	#appendEventInTransaction(event: InfrastructureEvent): { readonly event: InfrastructureEvent; readonly cursor: string } {
		this.#database.run("INSERT INTO journal_heads(scope_id,head) VALUES (?,0) ON CONFLICT(scope_id) DO NOTHING", [event.scopeId]);
		this.#database.run("UPDATE journal_heads SET head=head+1 WHERE scope_id=?", [event.scopeId]);
		const sequence = this.#journalHead(event.scopeId);
		this.#database.run("INSERT INTO events(scope_id,sequence,event_id,resource_kind,resource_id,revision,phase,timestamp,created_at) VALUES (?,?,?,?,?,?,?,?,?)", [event.scopeId, sequence, event.eventId, event.resourceKind, event.resourceId, event.revision, event.phase, event.timestamp, this.#nowMs()]);
		this.#pruneEventsInTransaction(event.scopeId, sequence);
		return { event, cursor: this.#encodeCursor(event.scopeId, sequence) };
	}

	#journalHead(scopeId: ScopeId): number {
		const row = this.#database.query("SELECT head FROM journal_heads WHERE scope_id=?").get(scopeId) as Record<string, unknown> | null;
		if (!row) return 0;
		const head = Number(row.head);
		if (!Number.isSafeInteger(head) || head < 0) throw new ControlStoreStateError("Journal head is corrupt");
		return head;
	}

	#pruneEventsInTransaction(scopeId: ScopeId, head: number): void {
		this.#validatedJournalWindow(scopeId, head);
		const countBoundary = Math.max(0, head - this.#maximumEventsPerScope);
		const cutoff = this.#nowMs() - this.#eventRetentionMs;
		const firstFresh = this.#database.query("SELECT sequence FROM events WHERE scope_id=? AND created_at>? ORDER BY sequence LIMIT 1").get(scopeId, cutoff) as Record<string, unknown> | null;
		const ageBoundary = firstFresh ? Number(firstFresh.sequence) - 1 : head;
		if (!Number.isSafeInteger(ageBoundary) || ageBoundary < 0 || ageBoundary > head) throw new ControlStoreStateError("Journal retention boundary is corrupt");
		const pruneThrough = Math.max(countBoundary, ageBoundary);
		if (pruneThrough > 0) this.#database.run("DELETE FROM events WHERE scope_id=? AND sequence<=?", [scopeId, pruneThrough]);
	}

	#validatedJournalWindow(scopeId: ScopeId, head: number): { readonly minimum: number | null; readonly maximum: number | null } {
		const row = this.#database.query("SELECT MIN(sequence) AS minimum,MAX(sequence) AS maximum,COUNT(*) AS count FROM events WHERE scope_id=?").get(scopeId) as Record<string, unknown>;
		const count = Number(row.count);
		if (!Number.isSafeInteger(count) || count < 0) throw new ControlStoreStateError("Journal count is corrupt");
		if (count === 0) {
			if (row.minimum !== null || row.maximum !== null) throw new ControlStoreStateError("Empty journal bounds are corrupt");
			return { minimum: null, maximum: null };
		}
		const minimum = Number(row.minimum);
		const maximum = Number(row.maximum);
		if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum < 1 || maximum !== head || count !== maximum - minimum + 1) throw new ControlStoreStateError("Journal retained window is not contiguous with its authoritative head");
		return { minimum, maximum };
	}

	#encodeResourcePageCursor(scopeId: ScopeId, kinds: readonly string[], highWater: number, snapshotId: string, offset: number): string {
		const snapshotBytes = Buffer.from(snapshotId, "base64url");
		if (snapshotBytes.byteLength !== 18) throw new ControlStoreStateError("Resource snapshot identifier is malformed");
		const payload = Buffer.alloc(31);
		payload[0] = 2;
		payload.writeBigUInt64BE(BigInt(highWater), 1);
		payload.writeUInt32BE(offset, 9);
		snapshotBytes.copy(payload, 13);
		const signature = createHmac("sha256", this.#cursorKey).update(scopeId).update("\0").update(kinds.join(",")).update("\0").update(payload).digest().subarray(0, 16);
		return Buffer.concat([payload, signature]).toString("base64url");
	}

	#decodeResourcePageCursor(scopeId: ScopeId, kinds: readonly string[], cursor: string): { readonly highWater: number; readonly snapshotId: string; readonly offset: number } {
		boundedText(cursor, 1, 512, "pageCursor", /^[A-Za-z0-9_-]+={0,2}$/u);
		let raw: Buffer;
		try { raw = Buffer.from(cursor, "base64url"); } catch { throw new ControlStoreInputError("pageCursor is malformed"); }
		input(raw.toString("base64url") === cursor.replace(/=+$/u, ""), "pageCursor is not canonical");
		input(raw.byteLength === 47 && raw[0] === 2, "pageCursor is malformed");
		const payload = raw.subarray(0, 31);
		const signature = raw.subarray(31);
		const expected = createHmac("sha256", this.#cursorKey).update(scopeId).update("\0").update(kinds.join(",")).update("\0").update(payload).digest().subarray(0, 16);
		input(timingSafeEqual(signature, expected), "pageCursor is invalid for this scope or resource filter");
		const highWater = Number(payload.readBigUInt64BE(1));
		input(Number.isSafeInteger(highWater), "pageCursor high-water is unsupported");
		const offset = payload.readUInt32BE(9);
		input(offset >= 1 && offset <= MAX_RESOURCE_SNAPSHOT_ITEMS, "pageCursor offset is unsupported");
		const snapshotId = payload.subarray(13).toString("base64url");
		return { highWater, snapshotId, offset };
	}

	#encodeCursor(scopeId: ScopeId, sequence: number): string {
		const payload = Buffer.alloc(9);
		payload[0] = 1;
		payload.writeBigUInt64BE(BigInt(sequence), 1);
		const signature = createHmac("sha256", this.#cursorKey).update(scopeId).update("\0").update(payload).digest().subarray(0, 16);
		return Buffer.concat([payload, signature]).toString("base64url");
	}

	#decodeCursor(scopeId: ScopeId, cursor: string): number {
		boundedText(cursor, 1, 512, "cursor", /^[A-Za-z0-9_-]+={0,2}$/u);
		let raw: Buffer;
		try { raw = Buffer.from(cursor, "base64url"); } catch { throw new ControlStoreInputError("cursor is malformed"); }
		input(raw.toString("base64url") === cursor.replace(/=+$/u, ""), "cursor is not canonical");
		input(raw.byteLength === CURSOR_BYTES && raw[0] === 1, "cursor is malformed");
		const payload = raw.subarray(0, 9);
		const signature = raw.subarray(9);
		const expected = createHmac("sha256", this.#cursorKey).update(scopeId).update("\0").update(payload).digest().subarray(0, 16);
		input(signature.byteLength === expected.byteLength && timingSafeEqual(signature, expected), "cursor is invalid for this scope");
		const sequence = Number(payload.readBigUInt64BE(1));
		input(Number.isSafeInteger(sequence), "cursor sequence is unsupported");
		return sequence;
	}

	#resetEvent(): ResetEvent {
		return { eventId: this.#newOpaque("evt", 18), event: "reset", reason: "cursor_expired", timestamp: iso(this.#nowMs()) };
	}
}

export * from "./shared-control-store.ts";
export * from "./sqlite-shared-ledger-storage.ts";
