import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import type {
	IdempotencyKey,
	IdempotencyReservation,
	InfrastructureEvent,
	JsonValue,
	ResetEvent,
	PortableControlStore,
	ResourceKind,
	TicketBinding,
	TicketConsumeOutcome,
	TicketConsumeSelector,
	TicketRevocation,
	Tombstone,
} from "./index.ts";
import { decodeScopeAdmissionPolicy, type AdmissionDenialReason, type ScopeAdmissionPolicy } from "@t4-code/portable-core";

const DAY_MS = 86_400_000;
const MAX_TICKET_TTL_SECONDS = 60;
const PROVIDER_CONNECTION_LEASE_MS = 30_000;
const MAX_LIST_LIMIT = 200;
const encoder = new TextEncoder();
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,511}$/u;
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const PHASES = new Set(["Pending", "Provisioning", "Starting", "Ready", "Sleeping", "Stopped", "Deleting", "Unavailable", "Degraded", "Failed"]);
const DIGEST = /^[a-f0-9]{64}$/u;
const TICKET = /^[A-Za-z0-9_-]{32,128}$/u;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;

export type Awaitable<T> = T | Promise<T>;
type ProviderControlOperation = "reserveIdempotency" | "completeIdempotency" | "releaseIdempotency" | "cleanupIdempotency" | "mintTicket" | "consumeTicket" | "consumeTicketForTransport" | "revokeTicket" | "revokeTickets";
type AwaitableMethod<T> = T extends (...args: infer Arguments) => infer Result ? (...args: Arguments) => Awaitable<Result> : never;
export type ProviderControlLedger = {
	readonly [K in ProviderControlOperation]: AwaitableMethod<PortableControlStore[K]>;
} & {
	reconcileIdempotency(request: IdempotencyKey & { readonly result: JsonValue }): Awaitable<{ readonly outcome: "completed" } | { readonly outcome: "alreadyCompleted"; readonly result: JsonValue } | { readonly outcome: "conflict" } | { readonly outcome: "notFound" }>;
};

interface StoredTicket { readonly digest: string; readonly binding: TicketBinding; readonly mintedAt: number; readonly expiresAt: number; readonly consumedAt?: number; readonly revokedAt?: number; }
type IdempotencyCompletion = { readonly outcome: "completed" } | { readonly outcome: "alreadyCompleted"; readonly result: JsonValue } | { readonly outcome: "reservationMismatch" } | { readonly outcome: "notFound" };
type IdempotencyReconciliation = { readonly outcome: "completed" } | { readonly outcome: "alreadyCompleted"; readonly result: JsonValue } | { readonly outcome: "conflict" } | { readonly outcome: "notFound" };
type TombstonePutOutcome = { readonly outcome: "created" | "existing"; readonly tombstone: Tombstone } | { readonly outcome: "capacityExceeded" };
export interface SharedIssuedIdentifier {
	readonly scopeId: string;
	readonly resourceKind: "workspace" | "runtime";
	readonly resourceId: string;
	readonly bindingDigest: string;
	readonly incarnationUid?: string;
	readonly deletedAt?: string;
	readonly deletion?: {
		readonly expectedRevision: string;
		readonly backendRevision: string;
		readonly requestedAt: string;
	};
	readonly creation?: {
		readonly ownerToken: string;
		readonly leaseExpiresAt: number;
	};
}
export type IssuedIdentifierReserveOutcome =
	| { readonly outcome: "reserved" | "existing"; readonly record: SharedIssuedIdentifier }
	| { readonly outcome: "conflict"; readonly record: SharedIssuedIdentifier };
export type IssuedIdentifierBindOutcome =
	| { readonly outcome: "bound" | "existing"; readonly record: SharedIssuedIdentifier }
	| { readonly outcome: "conflict"; readonly record: SharedIssuedIdentifier };
export type IssuedIdentifierDeleteOutcome = { readonly outcome: "deleted" | "existing" | "conflict" | "notFound"; readonly record?: SharedIssuedIdentifier };
type IdempotencyReleaseOutcome = { readonly outcome: "released" | "reservationMismatch" | "notFound" };
export type IssuedIdentifierDeletionBeginOutcome = { readonly outcome: "begun" | "existing" | "conflict" | "notFound"; readonly record?: SharedIssuedIdentifier };
export type IssuedIdentifierDeletionCancelOutcome = { readonly outcome: "cancelled" | "alreadyClear" | "conflict" | "notFound"; readonly record?: SharedIssuedIdentifier };
export type IssuedIdentifierCreationClaimOutcome = { readonly outcome: "claimed" | "takenOver" | "owned" | "inProgress" | "conflict" | "notFound"; readonly record?: SharedIssuedIdentifier };
export type ScopeAdmissionTransition = "create" | "activate" | "enableBrowser";

export interface ScopeAdmissionUsage {
	readonly activeRuntimes: number;
	readonly retainedRuntimes: number;
	readonly workspaceCapacityBytes: number;
	readonly cpuMillis: number;
	readonly memoryBytes: number;
	readonly gpuUnits: number;
	/** SHA-256 digests of resources already reflected in authoritative usage. */
	readonly observedResourceDigests?: readonly string[];
}
export interface ScopeAdmissionRequest {
	readonly scopeId: string;
	readonly resourceKey: string;
	readonly resourceKind: "workspace" | "runtime";
	readonly transition?: ScopeAdmissionTransition;
	readonly workspaceCapacityBytes?: number;
	readonly active?: boolean;
	readonly browserRequested?: boolean;
	readonly policy: ScopeAdmissionPolicy;
	readonly usage: ScopeAdmissionUsage;
}
export type ScopeAdmissionOutcome =
	| { readonly outcome: "admitted"; readonly reservationToken: string }
	| { readonly outcome: "denied"; readonly reason: AdmissionDenialReason; readonly retryAfterSeconds?: number };
export interface AdmissionRetirementIntent {
	readonly scopeId: string;
	readonly resourceKind: "workspace" | "runtime";
	readonly resourceKey: string;
	readonly state: "pending" | "complete";
	readonly createdAt: string;
	readonly completedAt?: string;
}

export interface ScopeAdmissionLedger {
	reserveAdmission(request: ScopeAdmissionRequest): Awaitable<ScopeAdmissionOutcome>;
	commitAdmission(reservationToken: string): Awaitable<"committed" | "notFound">;
	releaseAdmission(reservationToken: string): Awaitable<"released" | "notFound">;
	reconcileAdmissionAbsence(request: Pick<ScopeAdmissionRequest, "scopeId" | "resourceKind" | "resourceKey" | "transition">): Awaitable<"released" | "notFound">;
}
export interface AdmissionRetirementLedger {
	beginAdmissionRetirement(request: Pick<AdmissionRetirementIntent, "scopeId" | "resourceKind" | "resourceKey">): Awaitable<AdmissionRetirementIntent>;
	getAdmissionRetirement(request: Pick<AdmissionRetirementIntent, "scopeId" | "resourceKind" | "resourceKey">): Awaitable<AdmissionRetirementIntent | undefined>;
	completeAdmissionRetirement(request: Pick<AdmissionRetirementIntent, "scopeId" | "resourceKind" | "resourceKey">): Awaitable<"completed" | "alreadyCompleted" | "notFound">;
}


export interface RuntimeIngressIdentity {
	readonly runtimeId: string;
	readonly generation: string;
}
export interface RuntimeIngressState extends RuntimeIngressIdentity {
	readonly open: boolean;
	readonly activeLeases: number;
}
export interface RuntimeIngressLeaseIdentity extends RuntimeIngressIdentity {
	readonly gatewayReplicaEpoch: string;
	readonly leaseId: string;
}
export type RuntimeIngressAcquireOutcome =
	| { readonly outcome: "acquired"; readonly leaseId: string; readonly expiresAt: string }
	| { readonly outcome: "fenced" };
export interface RuntimeIngressLedger {
	acquireRuntimeIngress(request: RuntimeIngressIdentity & { readonly gatewayReplicaEpoch: string; readonly ttlSeconds: number }): Awaitable<RuntimeIngressAcquireOutcome>;
	renewRuntimeIngress(request: RuntimeIngressLeaseIdentity & { readonly ttlSeconds: number }): Awaitable<
		| { readonly outcome: "renewed"; readonly expiresAt: string }
		| { readonly outcome: "fenced" | "notFound" }
	>;
	releaseRuntimeIngress(request: RuntimeIngressLeaseIdentity): Awaitable<"released" | "notFound">;
	beginRuntimeIngressDrain(request: RuntimeIngressIdentity & { readonly mode: "idle" | "explicit" }): Awaitable<
		| { readonly outcome: "fenced"; readonly activeLeases: number }
		| { readonly outcome: "busy"; readonly activeLeases: number }
	>;
	reopenRuntimeIngress(request: RuntimeIngressIdentity): Awaitable<"reopened" | "notFound">;
	runtimeIngressState(request: RuntimeIngressIdentity): Awaitable<RuntimeIngressState>;
}

export interface SharedProviderConnectionRecord extends TicketBinding {
	readonly connectionId: string;
	readonly ticketDigest: string;
	readonly state: "ticket" | "active" | "closed";
	readonly updatedAt: number;
}
export interface SharedProviderConnectionLedger {
	installProviderControlGeneration(request: { readonly principalId: string; readonly generation: string; readonly ownerId?: string }): Awaitable<{ readonly outcome: "installed"; readonly replaced?: { readonly generation: string; readonly bindings: readonly TicketBinding[] } } | { readonly outcome: "alreadyActive" }>;
	isCurrentProviderControlGeneration(request: { readonly principalId: string; readonly generation: string; readonly ownerId?: string }): Awaitable<boolean>;
	registerProviderConnection(request: TicketBinding & { readonly connectionId: string; readonly ticket: string }): Awaitable<{ readonly outcome: "registered" | "conflict" | "staleGeneration" }>;
	activateProviderConnection(request: TicketBinding & { readonly ticket: string }): Awaitable<{ readonly outcome: "active"; readonly connectionId: string } | { readonly outcome: "rejected" }>;
	isProviderConnectionActive(connectionId: string): Awaitable<boolean>;
	renewProviderConnection(connectionId: string): Awaitable<"renewed" | "revoked">;
	closeProviderConnection(connectionId: string): Awaitable<{ readonly outcome: "closed" | "notFound" }>;
	closeProviderControlGeneration(request: { readonly principalId: string; readonly generation: string }): Awaitable<number>;
	releaseProviderControlGeneration(request: { readonly principalId: string; readonly generation: string; readonly ownerId?: string }): Awaitable<{ readonly outcome: "released"; readonly bindings: readonly TicketBinding[] } | { readonly outcome: "notCurrent" }>;
	acceptProviderAssertionKeyring(request: { readonly revision: number; readonly activeKid: string; readonly assertionKid: string; readonly previousKid?: string; readonly previousNotAfter?: number }): Awaitable<"accepted" | "rollback">;
	claimProviderAssertionNonce(request: { readonly nonce: string; readonly expiresAt: number }): Awaitable<"claimed" | "replayed">;
}

type SharedControlOperation = "putTombstone" | "getTombstone" | "cleanupTombstones" | "appendEvent" | "readAfter" | "subscribe";
export type SharedPortableControlLedger = ProviderControlLedger & SharedProviderConnectionLedger & {
	readonly [K in SharedControlOperation]: AwaitableMethod<PortableControlStore[K]>;
} & {
	reserveIssuedIdentifier(request: Omit<SharedIssuedIdentifier, "incarnationUid" | "deletedAt" | "deletion" | "creation">): Awaitable<IssuedIdentifierReserveOutcome>;
	bindIssuedIdentifier(request: Omit<SharedIssuedIdentifier, "deletedAt" | "deletion" | "creation"> & { readonly incarnationUid: string; readonly creationOwnerToken?: string }): Awaitable<IssuedIdentifierBindOutcome>;
	beginIssuedIdentifierDeletion(request: Pick<SharedIssuedIdentifier, "resourceKind" | "resourceId" | "incarnationUid"> & { readonly expectedRevision: string; readonly backendRevision: string; readonly requestedAt: string }): Awaitable<IssuedIdentifierDeletionBeginOutcome>;
	claimIssuedIdentifierCreation(request: Pick<SharedIssuedIdentifier, "resourceKind" | "resourceId" | "bindingDigest"> & { readonly ownerToken: string; readonly now: number; readonly leaseExpiresAt: number }): Awaitable<IssuedIdentifierCreationClaimOutcome>;
	cancelIssuedIdentifierDeletion(request: Pick<SharedIssuedIdentifier, "resourceKind" | "resourceId" | "incarnationUid"> & { readonly expectedRevision: string; readonly backendRevision: string }): Awaitable<IssuedIdentifierDeletionCancelOutcome>;
	markIssuedIdentifierDeleted(request: Pick<SharedIssuedIdentifier, "resourceKind" | "resourceId" | "incarnationUid"> & { readonly deletedAt: string }): Awaitable<IssuedIdentifierDeleteOutcome>;
	getIssuedIdentifier(resourceKind: "workspace" | "runtime", resourceId: string): Awaitable<SharedIssuedIdentifier | undefined>;
	eventHeadCursor(scopeId: string): Awaitable<string>;
	readonly reserveAdmission: ScopeAdmissionLedger["reserveAdmission"];
	readonly commitAdmission: ScopeAdmissionLedger["commitAdmission"];
	readonly releaseAdmission: ScopeAdmissionLedger["releaseAdmission"];
	readonly reconcileAdmissionAbsence: ScopeAdmissionLedger["reconcileAdmissionAbsence"];
	readonly beginAdmissionRetirement: AdmissionRetirementLedger["beginAdmissionRetirement"];
	readonly getAdmissionRetirement: AdmissionRetirementLedger["getAdmissionRetirement"];
	readonly completeAdmissionRetirement: AdmissionRetirementLedger["completeAdmissionRetirement"];
	readonly acquireRuntimeIngress: RuntimeIngressLedger["acquireRuntimeIngress"];
	readonly renewRuntimeIngress: RuntimeIngressLedger["renewRuntimeIngress"];
	readonly releaseRuntimeIngress: RuntimeIngressLedger["releaseRuntimeIngress"];
	readonly beginRuntimeIngressDrain: RuntimeIngressLedger["beginRuntimeIngressDrain"];
	readonly reopenRuntimeIngress: RuntimeIngressLedger["reopenRuntimeIngress"];
	readonly runtimeIngressState: RuntimeIngressLedger["runtimeIngressState"];
};
interface StoredIdempotency { readonly keyDigest: string; readonly bindingDigest: string; readonly reservationDigest: string; readonly state: "pending" | "complete"; readonly createdAt: number; readonly completedAt?: number; readonly expiresAt: number; readonly result?: JsonValue; }
interface StoredTombstone extends Tombstone { readonly createdAt: number; readonly expiresAtMs: number; }
interface StoredEvent { readonly sequence: number; readonly event: InfrastructureEvent; readonly storedAt: number; }
interface StoredEventHead { readonly scopeId: string; readonly sequence: number; }
type StoredIssuedIdentifier = SharedIssuedIdentifier;
interface StoredAdmissionReservation {
	readonly tokenDigest: string;
	readonly resourceDigest: string;
	readonly scopeId: string;
	readonly transition: ScopeAdmissionTransition;
	readonly resourceKind: "workspace" | "runtime";
	readonly activeRuntimes: number;
	readonly retainedRuntimes: number;
	readonly workspaceCapacityBytes: number;
	readonly cpuMillis: number;
	readonly memoryBytes: number;
	readonly gpuUnits: number;
	readonly createdAt: number;
	readonly expiresAt: number;
	readonly committed: boolean;
}
interface StoredAdmissionRateEvent { readonly scopeId: string; readonly createdAt: number; }
interface StoredAdmissionRetirement {
	readonly scopeId: string;
	readonly resourceKind: "workspace" | "runtime";
	readonly resourceKey: string;
	readonly state: "pending" | "complete";
	readonly createdAt: number;
	readonly completedAt?: number;
}
interface StoredRuntimeIngressLease {
	readonly leaseIdDigest: string;
	readonly gatewayReplicaEpoch: string;
	readonly expiresAt: number;
}
interface StoredRuntimeIngress extends RuntimeIngressIdentity {
	readonly open: boolean;
	readonly leases: readonly StoredRuntimeIngressLease[];
}
interface StoredProviderControlGeneration { readonly principalId: string; readonly generation: string; readonly ownerId: string; readonly updatedAt: number; }
interface StoredProviderAssertionKeyring { readonly revision: number; readonly activeKid: string; readonly previousKid?: string; readonly previousNotAfter?: number; }
interface StoredProviderAssertionNonce { readonly digest: string; readonly expiresAt: number; }
export interface SharedControlLedgerState {
	readonly version: 1;
	readonly eventHeads: readonly StoredEventHead[];
	readonly tickets: readonly StoredTicket[];
	readonly idempotency: readonly StoredIdempotency[];
	readonly tombstones: readonly StoredTombstone[];
	readonly issuedIdentifiers: readonly StoredIssuedIdentifier[];
	readonly events: readonly StoredEvent[];
	readonly admissionReservations: readonly StoredAdmissionReservation[];
	readonly admissionRateEvents: readonly StoredAdmissionRateEvent[];
	readonly runtimeIngress: readonly StoredRuntimeIngress[];
	readonly admissionRetirements: readonly StoredAdmissionRetirement[];
	readonly providerControlGenerations: readonly StoredProviderControlGeneration[];
	readonly providerAssertionKeyring?: StoredProviderAssertionKeyring;
	readonly providerConnections: readonly SharedProviderConnectionRecord[];
	readonly providerAssertionNonces: readonly StoredProviderAssertionNonce[];
}
export interface SharedControlLedgerSnapshot { readonly resourceVersion: string; readonly state: SharedControlLedgerState; }
export interface SharedControlLedgerStorage {
	read(): Promise<SharedControlLedgerSnapshot | undefined>;
	create(state: SharedControlLedgerState): Promise<SharedControlLedgerSnapshot>;
	replace(resourceVersion: string, state: SharedControlLedgerState): Promise<SharedControlLedgerSnapshot>;
}
export class SharedControlLedgerConflictError extends Error { constructor() { super("shared control ledger changed concurrently"); this.name = "SharedControlLedgerConflictError"; } }
export class SharedControlLedgerUnavailableError extends Error { constructor() { super("shared control ledger is unavailable"); this.name = "SharedControlLedgerUnavailableError"; } }
export class SharedControlLedgerCapacityError extends Error { constructor() { super("shared control ledger retention capacity is exhausted"); this.name = "SharedControlLedgerCapacityError"; } }

export interface SharedControlStoreOptions {
	readonly storage: SharedControlLedgerStorage;
	readonly now?: () => number;
	readonly randomBytes?: (length: number) => Uint8Array;
	readonly maximumStateBytes?: number;
	readonly maximumTickets?: number;
	readonly maximumIdempotencyRecords?: number;
	readonly maximumIssuedIdentifiers?: number;
	readonly maximumAdmissionReservations?: number;
	readonly tombstoneRetentionSeconds?: number;
	readonly maximumTombstonesPerScope?: number;
	readonly eventRetentionSeconds?: number;
	readonly maximumEvents?: number;
	readonly maximumContentionRetries?: number;
	readonly maximumProviderConnections?: number;
	readonly maximumProviderAssertionNonces?: number;
}

const initialState = (): SharedControlLedgerState => ({ version: 1, eventHeads: [], tickets: [], idempotency: [], tombstones: [], issuedIdentifiers: [], events: [], admissionReservations: [], admissionRateEvents: [], admissionRetirements: [], runtimeIngress: [], providerControlGenerations: [], providerConnections: [], providerAssertionNonces: [] });
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
const json = (value: unknown): string => JSON.stringify(canonical(value));
const sameDigest = (left: string, right: string): boolean => DIGEST.test(left) && DIGEST.test(right) && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
const exactBinding = (left: TicketBinding, right: TicketBinding): boolean => left.principalId === right.principalId && left.scopeId === right.scopeId && left.audience === right.audience && left.runtimeId === right.runtimeId && left.runtimeGeneration === right.runtimeGeneration && left.providerControlGeneration === right.providerControlGeneration && left.purpose === right.purpose;
const boundedInteger = (value: number, minimum: number, maximum: number, label: string): number => { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${label} is invalid`); return value; };
const text = (value: string, pattern: RegExp, label: string): string => { if (typeof value !== "string" || !pattern.test(value) || /\p{Cc}/u.test(value)) throw new TypeError(`${label} is invalid`); return value; };
const timestamp = (value: string, label: string): string => { const milliseconds = Date.parse(value); if (!Number.isFinite(milliseconds) || value.length > 64) throw new TypeError(`${label} is invalid`); return new Date(milliseconds).toISOString(); };
const saturatedAdd = (left: number, right: number): number =>
	left > Number.MAX_SAFE_INTEGER - right ? Number.MAX_SAFE_INTEGER : left + right;
const iso = (value: number): string => new Date(value).toISOString();

function validateBinding(value: TicketBinding): TicketBinding {
	return {
		principalId: text(value.principalId, OPAQUE, "principalId"), scopeId: text(value.scopeId, OPAQUE, "scopeId"),
		audience: text(value.audience, /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u, "audience"), runtimeId: text(value.runtimeId, OPAQUE, "runtimeId"),
		runtimeGeneration: text(value.runtimeGeneration, GENERATION, "runtimeGeneration"), providerControlGeneration: text(value.providerControlGeneration, GENERATION, "providerControlGeneration"),
		purpose: text(value.purpose, /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u, "purpose"),
	};
}
function validateIdempotency(value: IdempotencyKey): void {
	text(value.principalId, OPAQUE, "principalId"); text(value.scopeId, OPAQUE, "scopeId"); text(value.method, /^[A-Z]{3,16}$/u, "method");
	if (!/^\/(?!\/)[\x21-\x7E]{0,2047}$/u.test(value.canonicalPath) || value.canonicalPath.includes("?") || value.canonicalPath.includes("#")) throw new TypeError("canonicalPath is invalid");
	text(value.idempotencyKey, /^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/u, "idempotencyKey"); text(value.canonicalBodyDigest, DIGEST, "canonicalBodyDigest");
}
function idempotencyDigests(value: IdempotencyKey): { keyDigest: string; bindingDigest: string } {
	validateIdempotency(value);
	const key = [value.principalId, value.scopeId, value.method, value.canonicalPath, value.idempotencyKey].join("\0");
	return { keyDigest: hash(key), bindingDigest: hash(`${key}\0${value.canonicalBodyDigest}`) };
}
function validateEvent(value: InfrastructureEvent): InfrastructureEvent {
	if (value.resourceKind !== "scope" && value.resourceKind !== "workspace" && value.resourceKind !== "runtime") throw new TypeError("event resourceKind is invalid");
	if (!PHASES.has(value.phase)) throw new TypeError("event phase is invalid");
	return { eventId: text(value.eventId, EVENT_ID, "eventId"), resourceKind: value.resourceKind, resourceId: text(value.resourceId, OPAQUE, "resourceId"), scopeId: text(value.scopeId, OPAQUE, "scopeId"), revision: text(value.revision, GENERATION, "revision"), phase: value.phase, timestamp: timestamp(value.timestamp, "event timestamp") };
}

export class SharedControlStore implements SharedPortableControlLedger {
	readonly #storage: SharedControlLedgerStorage; readonly #now: () => number; readonly #randomBytes: (length: number) => Uint8Array;
	readonly #maximumStateBytes: number; readonly #maximumTickets: number; readonly #maximumIdempotencyRecords: number; readonly #maximumIssuedIdentifiers: number; readonly #maximumAdmissionReservations: number; readonly #tombstoneRetentionMs: number;
	readonly #maximumTombstonesPerScope: number; readonly #eventRetentionMs: number; readonly #maximumEvents: number; readonly #maximumContentionRetries: number;
	readonly #maximumProviderConnections: number; readonly #maximumProviderAssertionNonces: number;
	constructor(options: SharedControlStoreOptions) {
		this.#storage = options.storage; this.#now = options.now ?? Date.now; this.#randomBytes = options.randomBytes ?? (length => nodeRandomBytes(length));
		this.#maximumStateBytes = boundedInteger(options.maximumStateBytes ?? 512 * 1024, 1024, 768 * 1024, "maximumStateBytes");
		this.#maximumTickets = boundedInteger(options.maximumTickets ?? 2_048, 1, 100_000, "maximumTickets");
		this.#maximumIdempotencyRecords = boundedInteger(options.maximumIdempotencyRecords ?? 2_048, 1, 100_000, "maximumIdempotencyRecords");
		this.#maximumIssuedIdentifiers = boundedInteger(options.maximumIssuedIdentifiers ?? 10_000, 1, 100_000, "maximumIssuedIdentifiers");
		this.#maximumAdmissionReservations = boundedInteger(options.maximumAdmissionReservations ?? 4_096, 1, 100_000, "maximumAdmissionReservations");
		this.#tombstoneRetentionMs = boundedInteger(options.tombstoneRetentionSeconds ?? 86_400, 86_400, 604_800, "tombstoneRetentionSeconds") * 1000;
		this.#maximumTombstonesPerScope = boundedInteger(options.maximumTombstonesPerScope ?? 4_096, 1, 100_000, "maximumTombstonesPerScope");
		this.#eventRetentionMs = boundedInteger(options.eventRetentionSeconds ?? 60, 1, 604_800, "eventRetentionSeconds") * 1000;
		this.#maximumEvents = boundedInteger(options.maximumEvents ?? 10_000, 1, 100_000, "maximumEvents");
		this.#maximumContentionRetries = boundedInteger(options.maximumContentionRetries ?? 8, 1, 32, "maximumContentionRetries");
		this.#maximumProviderConnections = boundedInteger(options.maximumProviderConnections ?? 4_096, 1, 100_000, "maximumProviderConnections");
		this.#maximumProviderAssertionNonces = boundedInteger(options.maximumProviderAssertionNonces ?? 4_096, 1, 100_000, "maximumProviderAssertionNonces");
	}
	async installProviderControlGeneration(request: { readonly principalId: string; readonly generation: string; readonly ownerId?: string }) {
		const principalId = text(request.principalId, OPAQUE, "principalId");
		const generation = text(request.generation, GENERATION, "provider control generation");
		const ownerId = text(request.ownerId ?? "legacy-owner", OPAQUE, "provider control owner");
		const now = this.#clock();
		return await this.#mutate<{ readonly outcome: "installed"; readonly replaced?: { readonly generation: string; readonly bindings: readonly TicketBinding[] } } | { readonly outcome: "alreadyActive" }>(state => {
			const current = state.providerControlGenerations.find(item => item.principalId === principalId);
			if (current?.generation === generation) {
				return current.ownerId === ownerId ? { state, result: { outcome: "installed" as const } } : { state, result: { outcome: "alreadyActive" as const } };
			}
			const bindings = current ? this.#providerGenerationBindings(state.providerConnections, principalId, current.generation) : [];
			const providerConnections = current ? state.providerConnections.map(item => item.principalId === principalId && item.providerControlGeneration === current.generation && item.state !== "closed" ? { ...item, state: "closed" as const, updatedAt: now } : item) : state.providerConnections;
			const tickets = current ? state.tickets.map(item =>
				item.binding.principalId === principalId && item.binding.providerControlGeneration === current.generation && item.consumedAt === undefined && item.revokedAt === undefined && item.expiresAt > now
					? { ...item, revokedAt: now } : item,
			) : state.tickets;
			const providerControlGenerations = [...state.providerControlGenerations.filter(item => item.principalId !== principalId), { principalId, generation, ownerId, updatedAt: now }];
			return { state: { ...state, tickets, providerControlGenerations, providerConnections: this.#retainProviderConnections(providerConnections, now) }, result: { outcome: "installed" as const, ...(current ? { replaced: { generation: current.generation, bindings } } : {}) } };
		});
	}
	async isCurrentProviderControlGeneration(request: { readonly principalId: string; readonly generation: string; readonly ownerId?: string }): Promise<boolean> {
		const principalId = text(request.principalId, OPAQUE, "principalId"), generation = text(request.generation, GENERATION, "provider control generation"), ownerId = text(request.ownerId ?? "legacy-owner", OPAQUE, "provider control owner");
		const state = await this.#read();
		return state.providerControlGenerations.some(item => item.principalId === principalId && item.generation === generation && item.ownerId === ownerId);
	}
	async registerProviderConnection(request: TicketBinding & { readonly connectionId: string; readonly ticket: string }) {
		const binding = validateBinding(request), connectionId = text(request.connectionId, OPAQUE, "connectionId"), ticketDigest = this.#ticketDigest(request.ticket), now = this.#clock();
		return await this.#mutate<{ readonly outcome: "registered" | "conflict" | "staleGeneration" }>(state => {
			if (!state.providerControlGenerations.some(item => item.principalId === binding.principalId && item.generation === binding.providerControlGeneration))
				return { state, result: { outcome: "staleGeneration" as const } };
			const retained = this.#retainProviderConnections(state.providerConnections, now);
			if (retained.some(item => item.connectionId === connectionId) || retained.length >= this.#maximumProviderConnections)
				return { state: { ...state, providerConnections: retained }, result: { outcome: "conflict" as const } };
			return { state: { ...state, providerConnections: [...retained, { ...binding, connectionId, ticketDigest, state: "ticket" as const, updatedAt: now }] }, result: { outcome: "registered" as const } };
		});
	}
	async activateProviderConnection(request: TicketBinding & { readonly ticket: string }) {
		const binding = validateBinding(request), ticketDigest = this.#ticketDigest(request.ticket), now = this.#clock();
		return await this.#mutate<{ readonly outcome: "active"; readonly connectionId: string } | { readonly outcome: "rejected" }>(state => {
			const retained = this.#retainProviderConnections(state.providerConnections, now);
			const index = retained.findIndex(item => item.state === "ticket" && sameDigest(item.ticketDigest, ticketDigest) && exactBinding(item, binding));
			if (index < 0 || !state.providerControlGenerations.some(item => item.principalId === binding.principalId && item.generation === binding.providerControlGeneration))
				return { state: { ...state, providerConnections: retained }, result: { outcome: "rejected" as const } };
			const providerConnections = [...retained], current = providerConnections[index]!;
			providerConnections[index] = { ...current, state: "active", updatedAt: now };
			return { state: { ...state, providerConnections }, result: { outcome: "active" as const, connectionId: current.connectionId } };
		});
	}
	async isProviderConnectionActive(connectionIdValue: string): Promise<boolean> {
		const connectionId = text(connectionIdValue, OPAQUE, "connectionId"), now = this.#clock(), state = await this.#read();
		const connection = state.providerConnections.find(item => item.connectionId === connectionId);
		return connection?.state === "active" && connection.updatedAt > now - PROVIDER_CONNECTION_LEASE_MS &&
			state.providerControlGenerations.some(item => item.principalId === connection.principalId && item.generation === connection.providerControlGeneration);
	}
	async renewProviderConnection(connectionIdValue: string): Promise<"renewed" | "revoked"> {
		const connectionId = text(connectionIdValue, OPAQUE, "connectionId"), now = this.#clock();
		return await this.#mutate(state => {
			const providerConnections = this.#retainProviderConnections(state.providerConnections, now);
			const index = providerConnections.findIndex(item => item.connectionId === connectionId && item.state === "active");
			if (index < 0) return { state: { ...state, providerConnections }, result: "revoked" as const };
			const current = providerConnections[index]!;
			if (!state.providerControlGenerations.some(item => item.principalId === current.principalId && item.generation === current.providerControlGeneration))
				return { state: { ...state, providerConnections }, result: "revoked" as const };
			providerConnections[index] = { ...current, updatedAt: now };
			return { state: { ...state, providerConnections }, result: "renewed" as const };
		});
	}
	async closeProviderConnection(connectionIdValue: string) {
		const connectionId = text(connectionIdValue, OPAQUE, "connectionId"), now = this.#clock();
		return await this.#mutate<{ readonly outcome: "closed" | "notFound" }>(state => {
			const index = state.providerConnections.findIndex(item => item.connectionId === connectionId);
			if (index < 0) return { state, result: { outcome: "notFound" as const } };
			const providerConnections = [...state.providerConnections], current = providerConnections[index]!;
			providerConnections[index] = { ...current, state: "closed", updatedAt: now };
			return { state: { ...state, providerConnections: this.#retainProviderConnections(providerConnections, now) }, result: { outcome: "closed" as const } };
		});
	}
	async closeProviderControlGeneration(request: { readonly principalId: string; readonly generation: string }): Promise<number> {
		const principalId = text(request.principalId, OPAQUE, "principalId"), generation = text(request.generation, GENERATION, "provider control generation"), now = this.#clock();
		return await this.#mutate(state => {
			let count = 0;
			const providerConnections = state.providerConnections.map(item => {
				if (item.principalId !== principalId || item.providerControlGeneration !== generation || item.state === "closed") return item;
				count++; return { ...item, state: "closed" as const, updatedAt: now };
			});
			return { state: { ...state, providerConnections: this.#retainProviderConnections(providerConnections, now) }, result: count };
		});
	}
	async releaseProviderControlGeneration(request: { readonly principalId: string; readonly generation: string; readonly ownerId?: string }) {
		const principalId = text(request.principalId, OPAQUE, "principalId"), generation = text(request.generation, GENERATION, "provider control generation"), ownerId = text(request.ownerId ?? "legacy-owner", OPAQUE, "provider control owner"), now = this.#clock();
		return await this.#mutate<{ readonly outcome: "released"; readonly bindings: readonly TicketBinding[] } | { readonly outcome: "notCurrent" }>(state => {
			if (!state.providerControlGenerations.some(item => item.principalId === principalId && item.generation === generation && item.ownerId === ownerId))
				return { state, result: { outcome: "notCurrent" as const } };
			const bindings = this.#providerGenerationBindings(state.providerConnections, principalId, generation);
			const providerConnections = state.providerConnections.map(item => item.principalId === principalId && item.providerControlGeneration === generation && item.state !== "closed" ? { ...item, state: "closed" as const, updatedAt: now } : item);
			return { state: { ...state, providerControlGenerations: state.providerControlGenerations.filter(item => item.principalId !== principalId), providerConnections: this.#retainProviderConnections(providerConnections, now) }, result: { outcome: "released" as const, bindings } };
		});
	}
	async acceptProviderAssertionKeyring(request: { readonly revision: number; readonly activeKid: string; readonly assertionKid: string; readonly previousKid?: string; readonly previousNotAfter?: number }): Promise<"accepted" | "rollback"> {
		const revision = boundedInteger(request.revision, 1, Number.MAX_SAFE_INTEGER, "provider assertion keyring revision");
		const activeKid = text(request.activeKid, /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/u, "provider assertion active kid");
		const assertionKid = text(request.assertionKid, /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/u, "provider assertion kid");
		if ((request.previousKid === undefined) !== (request.previousNotAfter === undefined)) throw new TypeError("provider assertion previous key is invalid");
		const previous = request.previousKid === undefined || request.previousNotAfter === undefined ? undefined : {
			previousKid: text(request.previousKid, /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/u, "provider assertion previous kid"),
			previousNotAfter: boundedInteger(request.previousNotAfter, 1, Number.MAX_SAFE_INTEGER, "provider assertion previous expiry"),
		};
		const previousKid = previous?.previousKid, previousNotAfter = previous?.previousNotAfter;
		const now = Math.floor(this.#clock() / 1_000);
		const kidAccepted = (floor: StoredProviderAssertionKeyring): boolean =>
			assertionKid === floor.activeKid || assertionKid === floor.previousKid && floor.previousNotAfter !== undefined && floor.previousNotAfter >= now;
		return await this.#mutate(state => {
			const current = state.providerAssertionKeyring;
			if (current && revision < current.revision)
				return { state, result: current.previousKid === activeKid && current.previousNotAfter !== undefined && current.previousNotAfter >= now && assertionKid === activeKid ? "accepted" as const : "rollback" as const };
			if (current?.revision === revision)
				return { state, result: current.activeKid === activeKid && current.previousKid === previousKid && current.previousNotAfter === previousNotAfter && kidAccepted(current) ? "accepted" as const : "rollback" as const };
			if (current && (previousKid !== current.activeKid || previousNotAfter === undefined || previousNotAfter < now))
				return { state, result: "rollback" as const };
			const next = { revision, activeKid, ...previous } satisfies StoredProviderAssertionKeyring;
			if (!kidAccepted(next)) return { state, result: "rollback" as const };
			return { state: { ...state, providerAssertionKeyring: next }, result: "accepted" as const };
		});
	}
	async claimProviderAssertionNonce(request: { readonly nonce: string; readonly expiresAt: number }): Promise<"claimed" | "replayed"> {
		const digest = hash(text(request.nonce, /^[A-Za-z0-9_-]{24}$/u, "provider assertion nonce"));
		const expiresAt = boundedInteger(request.expiresAt, 1, Number.MAX_SAFE_INTEGER, "provider assertion expiry"), now = Math.floor(this.#clock() / 1_000);
		if (expiresAt < now || expiresAt > now + 30) throw new TypeError("provider assertion expiry is invalid");
		return await this.#mutate(state => {
			const retained = state.providerAssertionNonces.filter(item => item.expiresAt >= now);
			if (retained.some(item => sameDigest(item.digest, digest))) return { state: { ...state, providerAssertionNonces: retained }, result: "replayed" as const };
			if (retained.length >= this.#maximumProviderAssertionNonces) throw new SharedControlLedgerCapacityError();
			return { state: { ...state, providerAssertionNonces: [...retained, { digest, expiresAt }] }, result: "claimed" as const };
		});
	}
	async acquireRuntimeIngress(request: RuntimeIngressIdentity & { readonly gatewayReplicaEpoch: string; readonly ttlSeconds: number }): Promise<RuntimeIngressAcquireOutcome> {
		const identity = this.#runtimeIngressIdentity(request);
		const gatewayReplicaEpoch = text(request.gatewayReplicaEpoch, GENERATION, "gatewayReplicaEpoch");
		const ttlSeconds = boundedInteger(request.ttlSeconds, 1, 60, "ttlSeconds");
		const leaseId = this.#opaque("ing", 24);
		const leaseIdDigest = hash(leaseId);
		const now = this.#clock();
		const expiresAt = now + ttlSeconds * 1000;
		return await this.#mutate<RuntimeIngressAcquireOutcome>(state => {
			const retained = state.runtimeIngress.filter(item =>
				item.runtimeId !== identity.runtimeId || item.generation === identity.generation ||
				item.open || item.leases.some(lease => lease.expiresAt > now));
			const index = retained.findIndex(item => item.runtimeId === identity.runtimeId && item.generation === identity.generation);
			const current = index < 0 ? undefined : retained[index]!;
			if (current?.open === false) return { state: { ...state, runtimeIngress: retained }, result: { outcome: "fenced" as const } };
			const record: StoredRuntimeIngress = {
				...identity,
				open: true,
				leases: [
					...(current?.leases.filter(lease => lease.expiresAt > now) ?? []),
					{ leaseIdDigest, gatewayReplicaEpoch, expiresAt },
				],
			};
			if (index < 0) retained.push(record);
			else retained[index] = record;
			return { state: { ...state, runtimeIngress: retained }, result: { outcome: "acquired" as const, leaseId, expiresAt: iso(expiresAt) } };
		});
	}
	async renewRuntimeIngress(request: RuntimeIngressLeaseIdentity & { readonly ttlSeconds: number }): Promise<
		{ readonly outcome: "renewed"; readonly expiresAt: string } | { readonly outcome: "fenced" | "notFound" }
	> {
		const identity = this.#runtimeIngressIdentity(request);
		const gatewayReplicaEpoch = text(request.gatewayReplicaEpoch, GENERATION, "gatewayReplicaEpoch");
		const leaseIdDigest = hash(text(request.leaseId, TICKET, "runtime ingress leaseId"));
		const ttlSeconds = boundedInteger(request.ttlSeconds, 1, 60, "ttlSeconds");
		const now = this.#clock();
		const expiresAt = now + ttlSeconds * 1000;
		return await this.#mutate<{ readonly outcome: "renewed"; readonly expiresAt: string } | { readonly outcome: "fenced" | "notFound" }>(state => {
			const index = state.runtimeIngress.findIndex(item => item.runtimeId === identity.runtimeId && item.generation === identity.generation);
			if (index < 0) return { state, result: { outcome: "notFound" as const } };
			const current = state.runtimeIngress[index]!;
			const leases = current.leases.filter(lease => lease.expiresAt > now);
			if (!current.open) {
				const runtimeIngress = [...state.runtimeIngress];
				runtimeIngress[index] = { ...current, leases };
				return { state: { ...state, runtimeIngress }, result: { outcome: "fenced" as const } };
			}
			const leaseIndex = leases.findIndex(lease => lease.gatewayReplicaEpoch === gatewayReplicaEpoch && sameDigest(lease.leaseIdDigest, leaseIdDigest));
			if (leaseIndex < 0) {
				const runtimeIngress = [...state.runtimeIngress];
				runtimeIngress[index] = { ...current, leases };
				return { state: { ...state, runtimeIngress }, result: { outcome: "notFound" as const } };
			}
			leases[leaseIndex] = { ...leases[leaseIndex]!, expiresAt };
			const runtimeIngress = [...state.runtimeIngress];
			runtimeIngress[index] = { ...current, leases };
			return { state: { ...state, runtimeIngress }, result: { outcome: "renewed" as const, expiresAt: iso(expiresAt) } };
		});
	}
	async releaseRuntimeIngress(request: RuntimeIngressLeaseIdentity): Promise<"released" | "notFound"> {
		const identity = this.#runtimeIngressIdentity(request);
		const gatewayReplicaEpoch = text(request.gatewayReplicaEpoch, GENERATION, "gatewayReplicaEpoch");
		const leaseIdDigest = hash(text(request.leaseId, TICKET, "runtime ingress leaseId"));
		return await this.#mutate(state => {
			const index = state.runtimeIngress.findIndex(item => item.runtimeId === identity.runtimeId && item.generation === identity.generation);
			if (index < 0) return { state, result: "notFound" as const };
			const current = state.runtimeIngress[index]!;
			const leaseIndex = current.leases.findIndex(lease => lease.gatewayReplicaEpoch === gatewayReplicaEpoch && sameDigest(lease.leaseIdDigest, leaseIdDigest));
			if (leaseIndex < 0) return { state, result: "notFound" as const };
			const runtimeIngress = [...state.runtimeIngress];
			runtimeIngress[index] = { ...current, leases: current.leases.filter((_, candidate) => candidate !== leaseIndex) };
			return { state: { ...state, runtimeIngress }, result: "released" as const };
		});
	}
	async beginRuntimeIngressDrain(request: RuntimeIngressIdentity & { readonly mode: "idle" | "explicit" }): Promise<
		{ readonly outcome: "fenced"; readonly activeLeases: number } | { readonly outcome: "busy"; readonly activeLeases: number }
	> {
		const identity = this.#runtimeIngressIdentity(request);
		if (request.mode !== "idle" && request.mode !== "explicit") throw new TypeError("runtime ingress drain mode is invalid");
		const now = this.#clock();
		return await this.#mutate<{ readonly outcome: "fenced"; readonly activeLeases: number } | { readonly outcome: "busy"; readonly activeLeases: number }>(state => {
			const index = state.runtimeIngress.findIndex(item => item.runtimeId === identity.runtimeId && item.generation === identity.generation);
			const current = index < 0 ? { ...identity, open: true, leases: [] } : state.runtimeIngress[index]!;
			const leases = current.leases.filter(lease => lease.expiresAt > now);
			const activeLeases = leases.length;
			const runtimeIngress = [...state.runtimeIngress];
			if (request.mode === "idle" && activeLeases > 0) {
				if (index >= 0) runtimeIngress[index] = { ...current, leases };
				return { state: { ...state, runtimeIngress }, result: { outcome: "busy" as const, activeLeases } };
			}
			const fenced = { ...current, open: false, leases };
			if (index < 0) runtimeIngress.push(fenced);
			else runtimeIngress[index] = fenced;
			return { state: { ...state, runtimeIngress }, result: { outcome: "fenced" as const, activeLeases } };
		});
	}
	async reopenRuntimeIngress(request: RuntimeIngressIdentity): Promise<"reopened" | "notFound"> {
		const identity = this.#runtimeIngressIdentity(request);
		return await this.#mutate(state => {
			const index = state.runtimeIngress.findIndex(item => item.runtimeId === identity.runtimeId && item.generation === identity.generation);
			if (index < 0) return { state, result: "notFound" as const };
			const runtimeIngress = [...state.runtimeIngress];
			runtimeIngress[index] = { ...runtimeIngress[index]!, open: true };
			return { state: { ...state, runtimeIngress }, result: "reopened" as const };
		});
	}
	async runtimeIngressState(request: RuntimeIngressIdentity): Promise<RuntimeIngressState> {
		const identity = this.#runtimeIngressIdentity(request);
		const now = this.#clock();
		return await this.#mutate(state => {
			const index = state.runtimeIngress.findIndex(item => item.runtimeId === identity.runtimeId && item.generation === identity.generation);
			if (index < 0) return { state, result: { ...identity, open: true, activeLeases: 0 } };
			const current = state.runtimeIngress[index]!;
			const leases = current.leases.filter(lease => lease.expiresAt > now);
			const runtimeIngress = [...state.runtimeIngress];
			runtimeIngress[index] = { ...current, leases };
			return { state: { ...state, runtimeIngress }, result: { ...identity, open: current.open, activeLeases: leases.length } };
		});
	}
	async reserveAdmission(request: ScopeAdmissionRequest): Promise<ScopeAdmissionOutcome> {
		const scopeId = text(request.scopeId, OPAQUE, "scopeId");
		const resourceKey = text(request.resourceKey, OPAQUE, "resourceKey");
		if (request.resourceKind !== "workspace" && request.resourceKind !== "runtime") throw new TypeError("resourceKind is invalid");
		const policy = decodeScopeAdmissionPolicy(request.policy);
		const usage: ScopeAdmissionUsage = {
			activeRuntimes: boundedInteger(request.usage.activeRuntimes, 0, 100_000, "usage.activeRuntimes"),
			retainedRuntimes: boundedInteger(request.usage.retainedRuntimes, 0, 100_000, "usage.retainedRuntimes"),
			workspaceCapacityBytes: boundedInteger(request.usage.workspaceCapacityBytes, 0, Number.MAX_SAFE_INTEGER, "usage.workspaceCapacityBytes"),
			cpuMillis: boundedInteger(request.usage.cpuMillis, 0, Number.MAX_SAFE_INTEGER, "usage.cpuMillis"),
			memoryBytes: boundedInteger(request.usage.memoryBytes, 0, Number.MAX_SAFE_INTEGER, "usage.memoryBytes"),
			gpuUnits: boundedInteger(request.usage.gpuUnits, 0, Number.MAX_SAFE_INTEGER, "usage.gpuUnits"),
			...(request.usage.observedResourceDigests === undefined ? {} : { observedResourceDigests: request.usage.observedResourceDigests.map((value) => text(value, DIGEST, "usage.observedResourceDigests")) }),
		};
		const workspaceCapacityBytes = boundedInteger(request.workspaceCapacityBytes ?? 0, 0, Number.MAX_SAFE_INTEGER, "workspaceCapacityBytes");
		const transition = request.transition ?? "create";
		if (transition !== "create" && transition !== "activate" && transition !== "enableBrowser") throw new TypeError("transition is invalid");
		const active = request.resourceKind === "runtime" && request.active === true;
		const browserRequested = request.resourceKind === "runtime" && request.browserRequested === true;
		const delta = {
			activeRuntimes: active ? 1 : 0,
			retainedRuntimes: transition === "create" && request.resourceKind === "runtime" ? 1 : 0,
			workspaceCapacityBytes: transition === "create" && request.resourceKind === "workspace" ? workspaceCapacityBytes : 0,
			cpuMillis: active ? policy.runtimeResources.cpuMillis : 0,
			memoryBytes: active ? policy.runtimeResources.memoryBytes : 0,
			gpuUnits: active ? policy.runtimeResources.gpuUnits : 0,
		};
		const resourceDigest = hash(`${scopeId}\0${request.resourceKind}\0${resourceKey}\0${transition}`);
		const token = this.#opaque("adm", 24);
		const tokenDigest = hash(token);
		const now = this.#clock();
		return await this.#mutate<ScopeAdmissionOutcome>(state => {
			const observed = new Set(usage.observedResourceDigests ?? []);
			const reservations = state.admissionReservations.filter(item =>
				(item.committed || item.expiresAt > now) && !(item.committed && observed.has(item.resourceDigest)));
			const existing = reservations.find(item => item.resourceDigest === resourceDigest);
			if (existing) return { state: { ...state, admissionReservations: reservations }, result: { outcome: "denied", reason: "admission_unavailable", retryAfterSeconds: 1 } };
			if (browserRequested && !policy.browserEnabled)
				return { state: { ...state, admissionReservations: reservations }, result: { outcome: "denied", reason: "browser_disabled" } };
			const scoped = reservations.filter(item => item.scopeId === scopeId);
			const total = (field: keyof typeof delta, base: number): number =>
				scoped.reduce((sum, item) => saturatedAdd(sum, item[field]), saturatedAdd(base, delta[field]));
			const limits: readonly [keyof typeof delta, number, AdmissionDenialReason][] = [
				["activeRuntimes", policy.maxActiveRuntimes, "active_runtime_limit"],
				["retainedRuntimes", policy.maxRetainedRuntimes, "retained_runtime_limit"],
				["workspaceCapacityBytes", policy.maxWorkspaceCapacityBytes, "workspace_capacity_limit"],
				["cpuMillis", policy.maxCpuMillis, "cpu_limit"],
				["memoryBytes", policy.maxMemoryBytes, "memory_limit"],
				["gpuUnits", policy.maxGpuUnits, "gpu_limit"],
			];
			for (const [field, limit, reason] of limits) {
				if (total(field, usage[field]) > limit)
					return { state: { ...state, admissionReservations: reservations }, result: { outcome: "denied", reason } };
			}
			const windowMs = policy.creationRate.windowSeconds * 1000;
			const rateEvents = state.admissionRateEvents.filter(item => item.createdAt > now - windowMs);
			const rateContributors = transition === "create"
				? [...rateEvents.filter(item => item.scopeId === scopeId), ...scoped.filter(item => !item.committed && item.transition === "create" && item.createdAt > now - windowMs)]
				: [];
			if (rateContributors.length >= policy.creationRate.burst) {
				const oldest = rateContributors.reduce((minimum, item) => Math.min(minimum, item.createdAt), now);
				const retryAfterSeconds = Math.max(1, Math.min(policy.creationRate.maximumRetryAfterSeconds, Math.ceil((oldest + windowMs - now) / 1000)));
				return { state: { ...state, admissionReservations: reservations, admissionRateEvents: rateEvents }, result: { outcome: "denied", reason: "creation_rate_limit", retryAfterSeconds } };
			}
			if (reservations.length >= this.#maximumAdmissionReservations) throw new SharedControlLedgerCapacityError();
			const item: StoredAdmissionReservation = {
				tokenDigest, resourceDigest, scopeId, resourceKind: request.resourceKind, transition, ...delta,
				createdAt: now, expiresAt: now + Math.max(windowMs, 300_000), committed: false,
			};
			return { state: { ...state, admissionReservations: [...reservations, item], admissionRateEvents: rateEvents }, result: { outcome: "admitted", reservationToken: token } };
		});
	}
	async commitAdmission(reservationToken: string): Promise<"committed" | "notFound"> {
		const tokenDigest = hash(text(reservationToken, OPAQUE, "reservationToken"));
		const now = this.#clock();
		return await this.#mutate(state => {
			const reservations = state.admissionReservations.filter(item => item.committed || item.expiresAt > now);
			const index = reservations.findIndex(item => sameDigest(item.tokenDigest, tokenDigest));
			if (index < 0) return { state: { ...state, admissionReservations: reservations }, result: "notFound" as const };
			const current = reservations[index]!;
			if (!current.committed) {
				reservations[index] = { ...current, committed: true };
				return { state: { ...state, admissionReservations: reservations, admissionRateEvents: current.transition === "create" ? [...state.admissionRateEvents, { scopeId: current.scopeId, createdAt: current.createdAt }] : state.admissionRateEvents }, result: "committed" as const };
			}
			return { state: { ...state, admissionReservations: reservations }, result: "committed" as const };
		});
	}
	async releaseAdmission(reservationToken: string): Promise<"released" | "notFound"> {
		const tokenDigest = hash(text(reservationToken, OPAQUE, "reservationToken"));
		const now = this.#clock();
		return await this.#mutate(state => {
			const reservations = state.admissionReservations.filter(item => item.committed || item.expiresAt > now);
			const found = reservations.some(item => !item.committed && sameDigest(item.tokenDigest, tokenDigest));
			return { state: { ...state, admissionReservations: reservations.filter(item => item.committed || !sameDigest(item.tokenDigest, tokenDigest)) }, result: found ? "released" as const : "notFound" as const };
		});
	}
	async reconcileAdmissionAbsence(request: Pick<ScopeAdmissionRequest, "scopeId" | "resourceKind" | "resourceKey" | "transition">): Promise<"released" | "notFound"> {
		const scopeId = text(request.scopeId, OPAQUE, "scopeId");
		const resourceKey = text(request.resourceKey, OPAQUE, "resourceKey");
		if (request.resourceKind !== "workspace" && request.resourceKind !== "runtime") throw new TypeError("resourceKind is invalid");
		const transition = request.transition ?? "create";
		if (transition !== "create" && transition !== "activate" && transition !== "enableBrowser") throw new TypeError("transition is invalid");
		const resourceDigest = hash(`${scopeId}\0${request.resourceKind}\0${resourceKey}\0${transition}`);
		const now = this.#clock();
		return await this.#mutate(state => {
			const reservations = state.admissionReservations.filter(item => item.committed || item.expiresAt > now);
			const found = reservations.some(item => item.committed && sameDigest(item.resourceDigest, resourceDigest));
			return {
				state: { ...state, admissionReservations: reservations.filter(item => !(item.committed && sameDigest(item.resourceDigest, resourceDigest))) },
				result: found ? "released" as const : "notFound" as const,
			};
		});
	}
	async beginAdmissionRetirement(request: Pick<AdmissionRetirementIntent, "scopeId" | "resourceKind" | "resourceKey">): Promise<AdmissionRetirementIntent> {
		const scopeId = text(request.scopeId, OPAQUE, "scopeId");
		const resourceKey = text(request.resourceKey, OPAQUE, "resourceKey");
		if (request.resourceKind !== "workspace" && request.resourceKind !== "runtime") throw new TypeError("resourceKind is invalid");
		const now = this.#clock();
		return await this.#mutate(state => {
			const existing = state.admissionRetirements.find(item => item.scopeId === scopeId && item.resourceKind === request.resourceKind && item.resourceKey === resourceKey);
			if (existing) return { state, result: this.#publicAdmissionRetirement(existing) };
			if (state.admissionRetirements.length >= this.#maximumAdmissionReservations) throw new SharedControlLedgerCapacityError();
			const created: StoredAdmissionRetirement = { scopeId, resourceKind: request.resourceKind, resourceKey, state: "pending", createdAt: now };
			return { state: { ...state, admissionRetirements: [...state.admissionRetirements, created] }, result: this.#publicAdmissionRetirement(created) };
		});
	}
	async getAdmissionRetirement(request: Pick<AdmissionRetirementIntent, "scopeId" | "resourceKind" | "resourceKey">): Promise<AdmissionRetirementIntent | undefined> {
		const scopeId = text(request.scopeId, OPAQUE, "scopeId");
		const resourceKey = text(request.resourceKey, OPAQUE, "resourceKey");
		if (request.resourceKind !== "workspace" && request.resourceKind !== "runtime") throw new TypeError("resourceKind is invalid");
		const state = await this.#read();
		const existing = state.admissionRetirements.find(item => item.scopeId === scopeId && item.resourceKind === request.resourceKind && item.resourceKey === resourceKey);
		return existing ? this.#publicAdmissionRetirement(existing) : undefined;
	}
	async completeAdmissionRetirement(request: Pick<AdmissionRetirementIntent, "scopeId" | "resourceKind" | "resourceKey">): Promise<"completed" | "alreadyCompleted" | "notFound"> {
		const scopeId = text(request.scopeId, OPAQUE, "scopeId");
		const resourceKey = text(request.resourceKey, OPAQUE, "resourceKey");
		if (request.resourceKind !== "workspace" && request.resourceKind !== "runtime") throw new TypeError("resourceKind is invalid");
		const now = this.#clock();
		return await this.#mutate(state => {
			const index = state.admissionRetirements.findIndex(item => item.scopeId === scopeId && item.resourceKind === request.resourceKind && item.resourceKey === resourceKey);
			if (index < 0) return { state, result: "notFound" as const };
			const current = state.admissionRetirements[index]!;
			if (current.state === "complete") return { state, result: "alreadyCompleted" as const };
			const records = [...state.admissionRetirements];
			records[index] = { ...current, state: "complete", completedAt: now };
			return { state: { ...state, admissionRetirements: records }, result: "completed" as const };
		});
	}
	async reserveIdempotency(request: IdempotencyKey): Promise<IdempotencyReservation> {
		const digests = idempotencyDigests(request); const token = this.#opaque("res", 24); const reservationDigest = hash(token); const now = this.#clock();
		return await this.#mutate<IdempotencyReservation>(state => {
			const records = state.idempotency.filter(item => item.expiresAt > now);
			const retained = records.find(item => sameDigest(item.keyDigest, digests.keyDigest));
			if (retained) return { state: { ...state, idempotency: records }, result: sameDigest(retained.bindingDigest, digests.bindingDigest) ? retained.state === "complete" ? { outcome: "replay" as const, result: structuredClone(retained.result!) } : { outcome: "pending" as const } : { outcome: "conflict" as const } };
			if (records.length >= this.#maximumIdempotencyRecords) throw new SharedControlLedgerCapacityError();
			return { state: { ...state, idempotency: [...records, { ...digests, reservationDigest, state: "pending", createdAt: now, expiresAt: now + DAY_MS }] }, result: { outcome: "new" as const, reservationToken: token } };
		});
	}
	async completeIdempotency(request: IdempotencyKey & { readonly reservationToken: string; readonly result: JsonValue }): Promise<IdempotencyCompletion> {
		const digests = idempotencyDigests(request); text(request.reservationToken, /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u, "reservationToken"); this.#jsonValue(request.result); const reservationDigest = hash(request.reservationToken); const now = this.#clock();
		return await this.#mutate<IdempotencyCompletion>(state => {
			const index = state.idempotency.findIndex(item => sameDigest(item.keyDigest, digests.keyDigest)); if (index < 0 || state.idempotency[index]!.expiresAt <= now) return { state: { ...state, idempotency: state.idempotency.filter(item => item.expiresAt > now) }, result: { outcome: "notFound" as const } };
			const current = state.idempotency[index]!; if (!sameDigest(current.bindingDigest, digests.bindingDigest) || !sameDigest(current.reservationDigest, reservationDigest)) return { state, result: { outcome: "reservationMismatch" as const } };
			if (current.state === "complete") return { state, result: { outcome: "alreadyCompleted" as const, result: structuredClone(current.result!) } };
			const records = [...state.idempotency]; records[index] = { ...current, state: "complete", result: structuredClone(request.result), completedAt: now, expiresAt: now + DAY_MS };
			return { state: { ...state, idempotency: records }, result: { outcome: "completed" as const } };
		});
	}
	async releaseIdempotency(request: IdempotencyKey & { readonly reservationToken: string }): Promise<IdempotencyReleaseOutcome> {
		const digests = idempotencyDigests(request);
		text(request.reservationToken, /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u, "reservationToken");
		const reservationDigest = hash(request.reservationToken);
		const now = this.#clock();
		return await this.#mutate<IdempotencyReleaseOutcome>(state => {
			const retained = state.idempotency.filter(item => item.expiresAt > now);
			const index = retained.findIndex(item => sameDigest(item.keyDigest, digests.keyDigest));
			if (index < 0) return { state: { ...state, idempotency: retained }, result: { outcome: "notFound" as const } };
			const current = retained[index]!;
			if (current.state !== "pending" || !sameDigest(current.bindingDigest, digests.bindingDigest) || !sameDigest(current.reservationDigest, reservationDigest))
				return { state: { ...state, idempotency: retained }, result: { outcome: "reservationMismatch" as const } };
			return { state: { ...state, idempotency: retained.filter((_, itemIndex) => itemIndex !== index) }, result: { outcome: "released" as const } };
		});
	}

	async reconcileIdempotency(request: IdempotencyKey & { readonly result: JsonValue }): Promise<IdempotencyReconciliation> {
		const digests = idempotencyDigests(request); this.#jsonValue(request.result); const now = this.#clock();
		return await this.#mutate<IdempotencyReconciliation>(state => {
			const index = state.idempotency.findIndex(item => sameDigest(item.keyDigest, digests.keyDigest)); if (index < 0 || state.idempotency[index]!.expiresAt <= now) return { state: { ...state, idempotency: state.idempotency.filter(item => item.expiresAt > now) }, result: { outcome: "notFound" as const } };
			const current = state.idempotency[index]!; if (!sameDigest(current.bindingDigest, digests.bindingDigest)) return { state, result: { outcome: "conflict" as const } };
			if (current.state === "complete") return { state, result: { outcome: "alreadyCompleted" as const, result: structuredClone(current.result!) } };
			const records = [...state.idempotency]; records[index] = { ...current, state: "complete", result: structuredClone(request.result), completedAt: now, expiresAt: now + DAY_MS };
			return { state: { ...state, idempotency: records }, result: { outcome: "completed" as const } };
		});
	}
	async cleanupIdempotency(): Promise<number> { const now = this.#clock(); return await this.#mutate(state => { const kept = state.idempotency.filter(item => item.expiresAt > now); return { state: { ...state, idempotency: kept }, result: state.idempotency.length - kept.length }; }); }
	async mintTicket(request: TicketBinding & { readonly ttlSeconds: number }): Promise<{ readonly ticket: string; readonly expiresAt: string }> {
		const binding = validateBinding(request); const ttl = boundedInteger(request.ttlSeconds, 1, MAX_TICKET_TTL_SECONDS, "ttlSeconds"); const ticket = this.#opaque("", 32); const digest = hash(ticket); const now = this.#clock(); const expiresAt = now + ttl * 1000;
		return await this.#mutate(state => { const retained = state.tickets.filter(item => item.expiresAt > now); if (retained.length >= this.#maximumTickets || retained.some(item => sameDigest(item.digest, digest))) throw new SharedControlLedgerCapacityError(); return { state: { ...state, tickets: [...retained, { digest, binding, mintedAt: now, expiresAt }] }, result: { ticket, expiresAt: iso(expiresAt) } }; });
	}
	async consumeTicket(request: TicketBinding & { readonly ticket: string }): Promise<boolean> { const binding = validateBinding(request); return (await this.#claim(request.ticket, value => exactBinding(value, binding))).outcome === "consumed"; }
	async consumeTicketForTransport(request: TicketConsumeSelector): Promise<TicketConsumeOutcome> {
		const selector = request as TicketConsumeSelector & Pick<TicketBinding, "providerControlGeneration">;
		text(selector.principalId, OPAQUE, "principalId"); text(selector.audience, /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u, "audience"); text(selector.providerControlGeneration, GENERATION, "providerControlGeneration"); text(selector.purpose, /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u, "purpose");
		return await this.#claim(selector.ticket, value => value.principalId === selector.principalId && value.audience === selector.audience && value.providerControlGeneration === selector.providerControlGeneration && value.purpose === selector.purpose);
	}
	async revokeTicket(ticket: string): Promise<boolean> { const digest = this.#ticketDigest(ticket); const now = this.#clock(); return await this.#mutate(state => { const retained = state.tickets.filter(item => item.expiresAt > now); const index = retained.findIndex(item => sameDigest(item.digest, digest)); if (index < 0) return { state: { ...state, tickets: retained }, result: false }; const tickets = [...retained]; const current = tickets[index]!; if (current.revokedAt !== undefined || current.consumedAt !== undefined) return { state: { ...state, tickets }, result: false }; tickets[index] = { ...current, revokedAt: now }; return { state: { ...state, tickets }, result: true }; }); }
	async revokeTickets(request: TicketRevocation): Promise<number> { const now = this.#clock(); text(request.scopeId, OPAQUE, "scopeId"); text(request.runtimeId, OPAQUE, "runtimeId"); return await this.#mutate(state => { let count = 0; const tickets = state.tickets.filter(item => item.expiresAt > now).map(item => { if (item.consumedAt !== undefined || item.revokedAt !== undefined || !this.#revocationMatches(item.binding, request)) return item; count++; return { ...item, revokedAt: now }; }); return { state: { ...state, tickets }, result: count }; }); }
	async putTombstone(request: { readonly scopeId: string; readonly resourceKind: ResourceKind; readonly resourceId: string; readonly deletedAt: string }): Promise<TombstonePutOutcome> {
		const scopeId = text(request.scopeId, OPAQUE, "scopeId"), resourceId = text(request.resourceId, OPAQUE, "resourceId"); if (!["scope", "workspace", "runtime"].includes(request.resourceKind)) throw new TypeError("resourceKind is invalid"); const deletedAt = timestamp(request.deletedAt, "deletedAt"), now = this.#clock(); if (Date.parse(deletedAt) > now) throw new TypeError("deletedAt cannot be in the future");
		return await this.#mutate<TombstonePutOutcome>(state => { const retained = state.tombstones.filter(item => item.expiresAtMs > now); const existing = retained.find(item => item.scopeId === scopeId && item.resourceKind === request.resourceKind && item.resourceId === resourceId); if (existing) return { state: { ...state, tombstones: retained }, result: { outcome: "existing" as const, tombstone: this.#publicTombstone(existing) } }; if (retained.filter(item => item.scopeId === scopeId).length >= this.#maximumTombstonesPerScope) return { state: { ...state, tombstones: retained }, result: { outcome: "capacityExceeded" as const } }; const expiresAtMs = now + this.#tombstoneRetentionMs; const item: StoredTombstone = { scopeId, resourceKind: request.resourceKind, resourceId, deletedAt, createdAt: now, expiresAt: iso(expiresAtMs), expiresAtMs }; return { state: { ...state, tombstones: [...retained, item] }, result: { outcome: "created" as const, tombstone: this.#publicTombstone(item) } }; });
	}
	async getTombstone(request: { readonly scopeId: string; readonly resourceKind: ResourceKind; readonly resourceId: string }): Promise<Tombstone | undefined> { const scopeId = text(request.scopeId, OPAQUE, "scopeId"), resourceId = text(request.resourceId, OPAQUE, "resourceId"), now = this.#clock(); return await this.#mutate(state => { const retained = state.tombstones.filter(item => item.expiresAtMs > now); const item = retained.find(value => value.scopeId === scopeId && value.resourceKind === request.resourceKind && value.resourceId === resourceId); return { state: { ...state, tombstones: retained }, result: item ? this.#publicTombstone(item) : undefined }; }); }
	async cleanupTombstones(scopeIdValue: string): Promise<number> { const scopeId = text(scopeIdValue, OPAQUE, "scopeId"), now = this.#clock(); return await this.#mutate(state => { const kept = state.tombstones.filter(item => item.scopeId !== scopeId || item.expiresAtMs > now); return { state: { ...state, tombstones: kept }, result: state.tombstones.length - kept.length }; }); }
	async reserveIssuedIdentifier(request: Omit<SharedIssuedIdentifier, "incarnationUid" | "deletedAt" | "deletion" | "creation">): Promise<IssuedIdentifierReserveOutcome> {
		const record = this.#issuedRecord(request);
		return await this.#mutate<IssuedIdentifierReserveOutcome>(state => {
			const existing = state.issuedIdentifiers.find(item => item.resourceKind === record.resourceKind && item.resourceId === record.resourceId);
			if (existing) {
				const outcome = existing.scopeId === record.scopeId && sameDigest(existing.bindingDigest, record.bindingDigest) ? "existing" as const : "conflict" as const;
				return { state, result: { outcome, record: structuredClone(existing) } };
			}
			if (state.issuedIdentifiers.length >= this.#maximumIssuedIdentifiers) throw new SharedControlLedgerCapacityError();
			return { state: { ...state, issuedIdentifiers: [...state.issuedIdentifiers, record] }, result: { outcome: "reserved" as const, record } };
		});
	}
	async bindIssuedIdentifier(request: Omit<SharedIssuedIdentifier, "deletedAt" | "deletion" | "creation"> & { readonly incarnationUid: string; readonly creationOwnerToken?: string }): Promise<IssuedIdentifierBindOutcome> {
		const requested = { ...this.#issuedRecord(request), incarnationUid: text(request.incarnationUid, OPAQUE, "incarnationUid") };
		return await this.#mutate<IssuedIdentifierBindOutcome>(state => {
			const index = state.issuedIdentifiers.findIndex(item => item.resourceKind === requested.resourceKind && item.resourceId === requested.resourceId);
			if (index < 0) return { state, result: { outcome: "conflict" as const, record: requested } };
			const current = state.issuedIdentifiers[index]!;
			if (current.creation !== undefined && current.creation.ownerToken !== request.creationOwnerToken) return { state, result: { outcome: "conflict" as const, record: structuredClone(current) } };
			if (current.scopeId !== requested.scopeId || !sameDigest(current.bindingDigest, requested.bindingDigest) || current.deletedAt !== undefined || current.incarnationUid !== undefined && current.incarnationUid !== requested.incarnationUid)
				return { state, result: { outcome: "conflict" as const, record: structuredClone(current) } };
			if (current.incarnationUid === requested.incarnationUid) return { state, result: { outcome: "existing" as const, record: structuredClone(current) } };
			const records = [...state.issuedIdentifiers];
			records[index] = requested;
			return { state: { ...state, issuedIdentifiers: records }, result: { outcome: "bound" as const, record: requested } };
		});
	}
	async claimIssuedIdentifierCreation(request: Pick<SharedIssuedIdentifier, "resourceKind" | "resourceId" | "bindingDigest"> & { readonly ownerToken: string; readonly now: number; readonly leaseExpiresAt: number }): Promise<IssuedIdentifierCreationClaimOutcome> {
		const resourceKind = this.#issuedKind(request.resourceKind), resourceId = text(request.resourceId, OPAQUE, "resourceId");
		const bindingDigest = text(request.bindingDigest, DIGEST, "bindingDigest"), ownerToken = text(request.ownerToken, OPAQUE, "ownerToken");
		const now = boundedInteger(request.now, 0, Number.MAX_SAFE_INTEGER, "now"), leaseExpiresAt = boundedInteger(request.leaseExpiresAt, now + 1, Number.MAX_SAFE_INTEGER, "leaseExpiresAt");
		return await this.#mutate<IssuedIdentifierCreationClaimOutcome>(state => {
			const index = state.issuedIdentifiers.findIndex(item => item.resourceKind === resourceKind && item.resourceId === resourceId);
			if (index < 0) return { state, result: { outcome: "notFound" as const } };
			const current = state.issuedIdentifiers[index]!;
			if (!sameDigest(current.bindingDigest, bindingDigest) || current.deletedAt !== undefined || current.incarnationUid !== undefined)
				return { state, result: { outcome: "conflict" as const, record: structuredClone(current) } };
			if (current.creation?.ownerToken === ownerToken) {
				const updated = { ...current, creation: { ownerToken, leaseExpiresAt: Math.max(current.creation.leaseExpiresAt, leaseExpiresAt) } };
				const records = [...state.issuedIdentifiers]; records[index] = updated;
				return { state: { ...state, issuedIdentifiers: records }, result: { outcome: "owned" as const, record: updated } };
			}
			if (current.creation && current.creation.leaseExpiresAt > now) return { state, result: { outcome: "inProgress" as const, record: structuredClone(current) } };
			const outcome = current.creation === undefined ? "claimed" as const : "takenOver" as const;
			const updated = { ...current, creation: { ownerToken, leaseExpiresAt } };
			const records = [...state.issuedIdentifiers]; records[index] = updated;
			return { state: { ...state, issuedIdentifiers: records }, result: { outcome, record: updated } };
		});
	}
	async beginIssuedIdentifierDeletion(request: Pick<SharedIssuedIdentifier, "resourceKind" | "resourceId" | "incarnationUid"> & { readonly expectedRevision: string; readonly backendRevision: string; readonly requestedAt: string }): Promise<IssuedIdentifierDeletionBeginOutcome> {
		const resourceKind = this.#issuedKind(request.resourceKind);
		const resourceId = text(request.resourceId, OPAQUE, "resourceId");
		const incarnationUid = text(request.incarnationUid ?? "", OPAQUE, "incarnationUid");
		const deletion = { expectedRevision: text(request.expectedRevision, OPAQUE, "expectedRevision"), backendRevision: text(request.backendRevision, OPAQUE, "backendRevision"), requestedAt: timestamp(request.requestedAt, "requestedAt") };
		return await this.#mutate<IssuedIdentifierDeletionBeginOutcome>(state => {
			const index = state.issuedIdentifiers.findIndex(item => item.resourceKind === resourceKind && item.resourceId === resourceId);
			if (index < 0) return { state, result: { outcome: "notFound" as const } };
			const current = state.issuedIdentifiers[index]!;
			if (current.incarnationUid !== incarnationUid || current.deletedAt !== undefined) return { state, result: { outcome: "conflict" as const, record: structuredClone(current) } };
			if (current.deletion !== undefined) {
				const outcome = current.deletion.expectedRevision === deletion.expectedRevision && current.deletion.backendRevision === deletion.backendRevision ? "existing" as const : "conflict" as const;
				return { state, result: { outcome, record: structuredClone(current) } };
			}
			const updated = { ...current, deletion };
			const records = [...state.issuedIdentifiers]; records[index] = updated;
			return { state: { ...state, issuedIdentifiers: records }, result: { outcome: "begun" as const, record: updated } };
		});
	}
	async cancelIssuedIdentifierDeletion(request: Pick<SharedIssuedIdentifier, "resourceKind" | "resourceId" | "incarnationUid"> & { readonly expectedRevision: string; readonly backendRevision: string }): Promise<IssuedIdentifierDeletionCancelOutcome> {
		const resourceKind = this.#issuedKind(request.resourceKind);
		const resourceId = text(request.resourceId, OPAQUE, "resourceId");
		const incarnationUid = text(request.incarnationUid ?? "", OPAQUE, "incarnationUid");
		const expectedRevision = text(request.expectedRevision, OPAQUE, "expectedRevision");
		const backendRevision = text(request.backendRevision, OPAQUE, "backendRevision");
		return await this.#mutate<IssuedIdentifierDeletionCancelOutcome>(state => {
			const index = state.issuedIdentifiers.findIndex(item => item.resourceKind === resourceKind && item.resourceId === resourceId);
			if (index < 0) return { state, result: { outcome: "notFound" as const } };
			const current = state.issuedIdentifiers[index]!;
			if (current.incarnationUid !== incarnationUid || current.deletedAt !== undefined) return { state, result: { outcome: "conflict" as const, record: structuredClone(current) } };
			if (current.deletion === undefined) return { state, result: { outcome: "alreadyClear" as const, record: structuredClone(current) } };
			if (current.deletion.expectedRevision !== expectedRevision || current.deletion.backendRevision !== backendRevision)
				return { state, result: { outcome: "conflict" as const, record: structuredClone(current) } };
			const { deletion: _deletion, ...cleared } = current;
			const records = [...state.issuedIdentifiers]; records[index] = cleared;
			return { state: { ...state, issuedIdentifiers: records }, result: { outcome: "cancelled" as const, record: cleared } };
		});
	}

	async markIssuedIdentifierDeleted(request: Pick<SharedIssuedIdentifier, "resourceKind" | "resourceId" | "incarnationUid"> & { readonly deletedAt: string }): Promise<IssuedIdentifierDeleteOutcome> {
		const resourceKind = this.#issuedKind(request.resourceKind), resourceId = text(request.resourceId, OPAQUE, "resourceId"), incarnationUid = text(request.incarnationUid ?? "", OPAQUE, "incarnationUid"), deletedAt = timestamp(request.deletedAt, "deletedAt");
		return await this.#mutate<IssuedIdentifierDeleteOutcome>(state => {
			const index = state.issuedIdentifiers.findIndex(item => item.resourceKind === resourceKind && item.resourceId === resourceId);
			if (index < 0) return { state, result: { outcome: "notFound" as const } };
			const current = state.issuedIdentifiers[index]!;
			if (current.incarnationUid !== incarnationUid) return { state, result: { outcome: "conflict" as const, record: structuredClone(current) } };
			if (current.deletedAt !== undefined) return { state, result: { outcome: "existing" as const, record: structuredClone(current) } };
			const updated: SharedIssuedIdentifier = { scopeId: current.scopeId, resourceKind: current.resourceKind, resourceId: current.resourceId, bindingDigest: current.bindingDigest, incarnationUid, deletedAt };
			const records = [...state.issuedIdentifiers]; records[index] = updated;
			return { state: { ...state, issuedIdentifiers: records }, result: { outcome: "deleted" as const, record: updated } };
		});
	}
	async getIssuedIdentifier(resourceKindValue: "workspace" | "runtime", resourceIdValue: string): Promise<SharedIssuedIdentifier | undefined> {
		const resourceKind = this.#issuedKind(resourceKindValue), resourceId = text(resourceIdValue, OPAQUE, "resourceId");
		const state = await this.#read();
		const selected = state.issuedIdentifiers.find(item => item.resourceKind === resourceKind && item.resourceId === resourceId);
		return selected ? structuredClone(selected) : undefined;
	}
	async eventHeadCursor(scopeIdValue: string): Promise<string> {
		const scopeId = text(scopeIdValue, OPAQUE, "scopeId");
		const state = await this.#read();
		return this.#cursor(scopeId, state.eventHeads.find(item => item.scopeId === scopeId)?.sequence ?? 0);
	}
	async appendEvent(value: InfrastructureEvent): Promise<{ readonly event: InfrastructureEvent; readonly cursor: string }> {
		const event = validateEvent(value), now = this.#clock();
		return await this.#mutate(state => {
			const retained = state.events.filter(item => item.storedAt > now - this.#eventRetentionMs);
			const duplicate = retained.find(item => item.event.eventId === event.eventId);
			if (duplicate) {
				if (
					duplicate.event.resourceKind !== event.resourceKind
					|| duplicate.event.resourceId !== event.resourceId
					|| duplicate.event.scopeId !== event.scopeId
					|| duplicate.event.revision !== event.revision
					|| duplicate.event.phase !== event.phase
				) throw new SharedControlLedgerUnavailableError();
				return { state: { ...state, events: retained }, result: { event: structuredClone(duplicate.event), cursor: this.#cursor(event.scopeId, duplicate.sequence) } };
			}
			if (retained.length >= this.#maximumEvents) throw new SharedControlLedgerCapacityError();
			const headIndex = state.eventHeads.findIndex(item => item.scopeId === event.scopeId);
			if (headIndex < 0 && state.eventHeads.length >= this.#maximumEvents) throw new SharedControlLedgerCapacityError();
			const sequence = (headIndex < 0 ? 0 : state.eventHeads[headIndex]!.sequence) + 1;
			if (!Number.isSafeInteger(sequence)) throw new SharedControlLedgerCapacityError();
			const eventHeads = [...state.eventHeads];
			const nextHead = { scopeId: event.scopeId, sequence };
			if (headIndex < 0) eventHeads.push(nextHead); else eventHeads[headIndex] = nextHead;
			return { state: { ...state, eventHeads, events: [...retained, { sequence, event, storedAt: now }] }, result: { event, cursor: this.#cursor(event.scopeId, sequence) } };
		});
	}
	async readAfter(request: { readonly scopeId: string; readonly cursor: string; readonly limit?: number }): Promise<{ readonly outcome: "events"; readonly events: readonly InfrastructureEvent[]; readonly cursor: string } | { readonly outcome: "cursorExpired"; readonly reset: ResetEvent }> {
		const scopeId = text(request.scopeId, OPAQUE, "scopeId"), sequence = this.#decodeCursor(scopeId, request.cursor), limit = boundedInteger(request.limit ?? MAX_LIST_LIMIT, 1, MAX_LIST_LIMIT, "limit"), now = this.#clock();
		const state = await this.#read(); const scoped = state.events.filter(item => item.event.scopeId === scopeId && item.storedAt > now - this.#eventRetentionMs);
		const head = state.eventHeads.find(item => item.scopeId === scopeId)?.sequence ?? 0;
		if (sequence > head) throw new TypeError("cursor is ahead of the authoritative journal");
		const minimum = scoped[0]?.sequence;
		if ((minimum !== undefined && sequence < minimum - 1) || (minimum === undefined && sequence < head)) return { outcome: "cursorExpired", reset: { eventId: this.#opaque("reset", 18), event: "reset", reason: "cursor_expired", timestamp: iso(now) } };
		const selected = scoped.filter(item => item.sequence > sequence).slice(0, limit); const tail = selected.at(-1)?.sequence ?? sequence;
		return { outcome: "events", events: selected.map(item => structuredClone(item.event)), cursor: this.#cursor(scopeId, tail) };
	}
	async *subscribe(request: { readonly scopeId: string; readonly cursor: string; readonly signal?: AbortSignal; readonly pollMilliseconds?: number; readonly batchLimit?: number }) { let cursor = request.cursor; const poll = boundedInteger(request.pollMilliseconds ?? 100, 1, 60_000, "pollMilliseconds"); while (!request.signal?.aborted) { const result = await this.readAfter({ scopeId: request.scopeId, cursor, ...(request.batchLimit === undefined ? {} : { limit: request.batchLimit }) }); if (result.outcome === "cursorExpired") { yield result; return; } if (result.events.length) { cursor = result.cursor; yield result; continue; } await new Promise<void>(resolve => { const finish = () => { clearTimeout(timer); request.signal?.removeEventListener("abort", finish); resolve(); }; const timer = setTimeout(finish, poll); request.signal?.addEventListener("abort", finish, { once: true }); }); } }
	async #claim(ticket: string, matches: (binding: TicketBinding) => boolean): Promise<TicketConsumeOutcome> { const digest = this.#ticketDigest(ticket), now = this.#clock(); return await this.#mutate<TicketConsumeOutcome>(state => { const index = state.tickets.findIndex(item => sameDigest(item.digest, digest)); if (index < 0) return { state, result: { outcome: "rejected" as const } }; const current = state.tickets[index]!; if (current.expiresAt <= now || current.consumedAt !== undefined || current.revokedAt !== undefined || !matches(current.binding)) return { state, result: { outcome: "rejected" as const } }; const tickets = [...state.tickets]; tickets[index] = { ...current, consumedAt: now }; return { state: { ...state, tickets }, result: { outcome: "consumed" as const, binding: structuredClone(current.binding) } }; }); }
	async #read(): Promise<SharedControlLedgerState> { try { const snapshot = await this.#storage.read(); return this.#validateState(snapshot?.state ?? initialState()); } catch (error) { if (error instanceof SharedControlLedgerUnavailableError) throw error; throw new SharedControlLedgerUnavailableError(); } }
	async #mutate<T>(operation: (state: SharedControlLedgerState) => { state: SharedControlLedgerState; result: T }): Promise<T> { for (let attempt = 0; attempt < this.#maximumContentionRetries; attempt++) { let snapshot: SharedControlLedgerSnapshot | undefined; try { snapshot = await this.#storage.read(); const current = this.#validateState(snapshot?.state ?? initialState()); const changed = operation(structuredClone(current)); this.#validateState(changed.state); if (json(changed.state) === json(current)) return changed.result; if (snapshot) await this.#storage.replace(snapshot.resourceVersion, changed.state); else await this.#storage.create(changed.state); return changed.result; } catch (error) { if (error instanceof SharedControlLedgerConflictError) continue; if (error instanceof TypeError || error instanceof SharedControlLedgerCapacityError || error instanceof SharedControlLedgerUnavailableError) throw error; throw new SharedControlLedgerUnavailableError(); } } throw new SharedControlLedgerUnavailableError(); }
	#validateState(value: SharedControlLedgerState): SharedControlLedgerState {
		try {
			const candidate = value as unknown as Record<string, unknown>;
			if (!Array.isArray(candidate.eventHeads)) {
				if (candidate.nextEventSequence !== 1 || !Array.isArray(candidate.events) || candidate.events.length !== 0) throw new Error();
				const { nextEventSequence: _legacyEmptyHead, ...rest } = candidate;
				value = { ...rest, eventHeads: [] } as unknown as SharedControlLedgerState;
			}
			if (!Array.isArray(candidate.issuedIdentifiers)) value = { ...value, issuedIdentifiers: [] };
			if (!Array.isArray((value as unknown as Record<string, unknown>).admissionReservations))
				value = { ...value, admissionReservations: [] };
			if (!Array.isArray((value as unknown as Record<string, unknown>).admissionRateEvents))
				value = { ...value, admissionRateEvents: [] };
			if (!Array.isArray((value as unknown as Record<string, unknown>).admissionRetirements))
				value = { ...value, admissionRetirements: [] };
			if (!Array.isArray((value as unknown as Record<string, unknown>).runtimeIngress))
				value = { ...value, runtimeIngress: [] };
			if (!Array.isArray((value as unknown as Record<string, unknown>).providerControlGenerations))
				value = { ...value, providerControlGenerations: [] };
			value = { ...value, providerControlGenerations: value.providerControlGenerations.map(item =>
				typeof (item as unknown as Record<string, unknown>).ownerId === "string" ? item : { ...item, ownerId: `legacy_${hash(`${item.principalId}\0${item.generation}`).slice(0, 24)}` },
			) };
			if (!Array.isArray((value as unknown as Record<string, unknown>).providerConnections))
				value = { ...value, providerConnections: [] };
			if (!Array.isArray((value as unknown as Record<string, unknown>).providerAssertionNonces))
				value = { ...value, providerAssertionNonces: [] };
			if (!value || value.version !== 1 || !Array.isArray(value.eventHeads) ||
				!Array.isArray(value.tickets) || !Array.isArray(value.idempotency) || !Array.isArray(value.tombstones) || !Array.isArray(value.issuedIdentifiers) || !Array.isArray(value.events) ||
				!Array.isArray(value.admissionReservations) || !Array.isArray(value.admissionRateEvents) || !Array.isArray(value.admissionRetirements) || !Array.isArray(value.runtimeIngress) ||
				!Array.isArray(value.providerControlGenerations) || !Array.isArray(value.providerConnections) || !Array.isArray(value.providerAssertionNonces) ||
				value.eventHeads.length > this.#maximumEvents || value.tickets.length > this.#maximumTickets || value.idempotency.length > this.#maximumIdempotencyRecords || value.issuedIdentifiers.length > this.#maximumIssuedIdentifiers || value.events.length > this.#maximumEvents ||
				value.admissionReservations.length > this.#maximumAdmissionReservations || value.admissionRateEvents.length > this.#maximumAdmissionReservations ||
				value.admissionRetirements.length > this.#maximumAdmissionReservations || value.runtimeIngress.length > this.#maximumIssuedIdentifiers || value.providerControlGenerations.length > this.#maximumIssuedIdentifiers ||
				value.providerConnections.length > this.#maximumProviderConnections || value.providerAssertionNonces.length > this.#maximumProviderAssertionNonces ||
				encoder.encode(JSON.stringify(value)).byteLength > this.#maximumStateBytes) throw new Error();
			const ticketDigests = new Set<string>();
			for (const item of value.tickets) {
				if (!DIGEST.test(item.digest) || ticketDigests.has(item.digest) || !Number.isSafeInteger(item.mintedAt) || !Number.isSafeInteger(item.expiresAt) ||
					item.expiresAt <= item.mintedAt || item.expiresAt > item.mintedAt + MAX_TICKET_TTL_SECONDS * 1000 ||
					item.consumedAt !== undefined && (!Number.isSafeInteger(item.consumedAt) || item.consumedAt < item.mintedAt || item.consumedAt >= item.expiresAt) ||
					item.revokedAt !== undefined && (!Number.isSafeInteger(item.revokedAt) || item.revokedAt < item.mintedAt || item.revokedAt >= item.expiresAt) ||
					item.consumedAt !== undefined && item.revokedAt !== undefined) throw new Error();
				ticketDigests.add(item.digest);
				validateBinding(item.binding);
			}
			const idempotencyKeys = new Set<string>();
			for (const item of value.idempotency) {
				const retentionAnchor = item.state === "complete" ? item.completedAt : item.createdAt;
				if (!DIGEST.test(item.keyDigest) || !DIGEST.test(item.bindingDigest) || !DIGEST.test(item.reservationDigest) || idempotencyKeys.has(item.keyDigest) ||
					!Number.isSafeInteger(item.createdAt) || !Number.isSafeInteger(retentionAnchor) || item.expiresAt !== retentionAnchor! + DAY_MS ||
					(item.state === "complete") !== (item.result !== undefined) || (item.state === "complete") !== (item.completedAt !== undefined)) throw new Error();
				idempotencyKeys.add(item.keyDigest);
				if (item.result !== undefined) this.#jsonValue(item.result);
			}
			const admissionTokens = new Set<string>(); const admissionResources = new Set<string>();
			for (const item of value.admissionReservations) {
				text(item.scopeId, OPAQUE, "admission scopeId");
				if ((item.resourceKind !== "workspace" && item.resourceKind !== "runtime") ||
					!DIGEST.test(item.tokenDigest) || !DIGEST.test(item.resourceDigest) ||
					admissionTokens.has(item.tokenDigest) || admissionResources.has(item.resourceDigest) ||
					!Number.isSafeInteger(item.createdAt) || !Number.isSafeInteger(item.expiresAt) || item.expiresAt <= item.createdAt ||
					typeof item.committed !== "boolean") throw new Error();
				for (const field of ["activeRuntimes", "retainedRuntimes", "workspaceCapacityBytes", "cpuMillis", "memoryBytes", "gpuUnits"] as const)
					boundedInteger(item[field], 0, Number.MAX_SAFE_INTEGER, `admission ${field}`);
				admissionTokens.add(item.tokenDigest); admissionResources.add(item.resourceDigest);
			}
			const admissionRetirements = new Set<string>();
			for (const item of value.admissionRetirements) {
				text(item.scopeId, OPAQUE, "admission retirement scopeId");
				text(item.resourceKey, OPAQUE, "admission retirement resourceKey");
				const key = `${item.scopeId}\0${item.resourceKind}\0${item.resourceKey}`;
				if ((item.resourceKind !== "workspace" && item.resourceKind !== "runtime") || admissionRetirements.has(key) ||
					(item.state !== "pending" && item.state !== "complete") || !Number.isSafeInteger(item.createdAt) ||
					(item.state === "complete") !== Number.isSafeInteger(item.completedAt) ||
					item.completedAt !== undefined && item.completedAt < item.createdAt) throw new Error();
				admissionRetirements.add(key);
			}
			for (const item of value.admissionRateEvents) {
				text(item.scopeId, OPAQUE, "admission rate scopeId");
				boundedInteger(item.createdAt, 0, Number.MAX_SAFE_INTEGER, "admission rate createdAt");
			}
			const runtimeIngressKeys = new Set<string>();
			for (const item of value.runtimeIngress) {
				const identity = this.#runtimeIngressIdentity(item);
				const key = `${identity.runtimeId}\0${identity.generation}`;
				if (runtimeIngressKeys.has(key) || typeof item.open !== "boolean" || !Array.isArray(item.leases) || item.leases.length > 100_000)
					throw new Error();
				const leases = new Set<string>();
				for (const lease of item.leases) {
					text(lease.gatewayReplicaEpoch, GENERATION, "gatewayReplicaEpoch");
					if (!DIGEST.test(lease.leaseIdDigest) || leases.has(lease.leaseIdDigest) ||
						!Number.isSafeInteger(lease.expiresAt) || lease.expiresAt < 1) throw new Error();
					leases.add(lease.leaseIdDigest);
				}
				runtimeIngressKeys.add(key);
			}
			if (value.providerAssertionKeyring !== undefined) {
				const floor = value.providerAssertionKeyring;
				boundedInteger(floor.revision, 1, Number.MAX_SAFE_INTEGER, "provider assertion keyring revision");
				text(floor.activeKid, /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/u, "provider assertion active kid");
				if (Boolean(floor.previousKid) !== (floor.previousNotAfter !== undefined)) throw new Error();
				if (floor.previousKid !== undefined) text(floor.previousKid, /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/u, "provider assertion previous kid");
				if (floor.previousNotAfter !== undefined) boundedInteger(floor.previousNotAfter, 1, Number.MAX_SAFE_INTEGER, "provider assertion previous expiry");
			}
			const providerPrincipals = new Set<string>();
			for (const item of value.providerControlGenerations) {
				text(item.principalId, OPAQUE, "provider principalId");
				text(item.generation, GENERATION, "provider control generation");
				text(item.ownerId, OPAQUE, "provider control owner");
				boundedInteger(item.updatedAt, 0, Number.MAX_SAFE_INTEGER, "provider generation updatedAt");
				if (providerPrincipals.has(item.principalId)) throw new Error();
				providerPrincipals.add(item.principalId);
			}
			const providerConnectionIds = new Set<string>();
			for (const item of value.providerConnections) {
				validateBinding(item);
				text(item.connectionId, OPAQUE, "provider connectionId");
				if (!DIGEST.test(item.ticketDigest) || providerConnectionIds.has(item.connectionId) || !["ticket", "active", "closed"].includes(item.state))
					throw new Error();
				boundedInteger(item.updatedAt, 0, Number.MAX_SAFE_INTEGER, "provider connection updatedAt");
				providerConnectionIds.add(item.connectionId);
			}
			const assertionNonces = new Set<string>();
			for (const item of value.providerAssertionNonces) {
				if (!DIGEST.test(item.digest) || assertionNonces.has(item.digest)) throw new Error();
				boundedInteger(item.expiresAt, 1, Number.MAX_SAFE_INTEGER, "provider assertion expiry");
				assertionNonces.add(item.digest);
			}
			const tombstoneKeys = new Set<string>(); const byScope = new Map<string, number>();
			for (const item of value.tombstones) {
				text(item.scopeId, OPAQUE, "scopeId"); text(item.resourceId, OPAQUE, "resourceId"); const deletedAt = Date.parse(timestamp(item.deletedAt, "deletedAt"));
				if ((item.resourceKind !== "scope" && item.resourceKind !== "workspace" && item.resourceKind !== "runtime") || !Number.isSafeInteger(item.createdAt) ||
					deletedAt > item.createdAt || item.expiresAtMs !== item.createdAt + this.#tombstoneRetentionMs || item.expiresAt !== iso(item.expiresAtMs)) throw new Error();
				const key = `${item.scopeId}\0${item.resourceKind}\0${item.resourceId}`; if (tombstoneKeys.has(key)) throw new Error(); tombstoneKeys.add(key);
				byScope.set(item.scopeId, (byScope.get(item.scopeId) ?? 0) + 1); if (byScope.get(item.scopeId)! > this.#maximumTombstonesPerScope) throw new Error();
			}
			const issuedKeys = new Set<string>();
			for (const item of value.issuedIdentifiers) {
				const normalized = this.#issuedRecord(item);
				const key = `${normalized.resourceKind}\0${normalized.resourceId}`;
				if (issuedKeys.has(key)) throw new Error();
				issuedKeys.add(key);
				if (item.incarnationUid !== undefined) text(item.incarnationUid, OPAQUE, "incarnationUid");
				if (item.deletedAt !== undefined) {
					timestamp(item.deletedAt, "issued identifier deletedAt");
					if (item.incarnationUid === undefined) throw new Error();
				}
				if (item.deletion !== undefined) {
					text(item.deletion.expectedRevision, OPAQUE, "deletion expectedRevision");
					text(item.deletion.backendRevision, OPAQUE, "deletion backendRevision");
					timestamp(item.deletion.requestedAt, "deletion requestedAt");
					if (item.incarnationUid === undefined || item.deletedAt !== undefined) throw new Error();
				}
				if (item.creation !== undefined) {
					text(item.creation.ownerToken, OPAQUE, "creation ownerToken");
					boundedInteger(item.creation.leaseExpiresAt, 1, Number.MAX_SAFE_INTEGER, "creation leaseExpiresAt");
					if (item.incarnationUid !== undefined || item.deletedAt !== undefined) throw new Error();
				}
			}

			const heads = new Map<string, number>();
			for (const item of value.eventHeads) {
				text(item.scopeId, OPAQUE, "event head scopeId");
				if (heads.has(item.scopeId) || !Number.isSafeInteger(item.sequence) || item.sequence < 1) throw new Error();
				heads.set(item.scopeId, item.sequence);
			}
			const priorByScope = new Map<string, number>(); const eventIds = new Set<string>();
			for (const item of value.events) {
				const scopeId = item.event.scopeId, prior = priorByScope.get(scopeId) ?? 0, head = heads.get(scopeId);
				if (!Number.isSafeInteger(item.sequence) || item.sequence <= prior || head === undefined || item.sequence > head || !Number.isSafeInteger(item.storedAt) || eventIds.has(item.event.eventId)) throw new Error();
				validateEvent(item.event); priorByScope.set(scopeId, item.sequence); eventIds.add(item.event.eventId);
			}
			return value;
		} catch (error) {
			if (error instanceof SharedControlLedgerUnavailableError) throw error;
			throw new SharedControlLedgerUnavailableError();
		}
	}
	#retainProviderConnections(records: readonly SharedProviderConnectionRecord[], now: number): SharedProviderConnectionRecord[] {
		return records.filter(item => item.updatedAt > now - (item.state === "active" ? PROVIDER_CONNECTION_LEASE_MS : MAX_TICKET_TTL_SECONDS * 1000));
	}
	#providerGenerationBindings(records: readonly SharedProviderConnectionRecord[], principalId: string, generation: string): TicketBinding[] {
		return records.filter(item => item.principalId === principalId && item.providerControlGeneration === generation && item.state !== "closed").map(item => ({
			principalId: item.principalId,
			scopeId: item.scopeId,
			audience: item.audience,
			runtimeId: item.runtimeId,
			runtimeGeneration: item.runtimeGeneration,
			providerControlGeneration: item.providerControlGeneration,
			purpose: item.purpose,
		}));
	}
	#runtimeIngressIdentity(value: RuntimeIngressIdentity): RuntimeIngressIdentity {
		return {
			runtimeId: text(value.runtimeId, OPAQUE, "runtime ingress runtimeId"),
			generation: text(value.generation, GENERATION, "runtime ingress generation"),
		};
	}
	#issuedKind(value: string): "workspace" | "runtime" {
		if (value !== "workspace" && value !== "runtime") throw new TypeError("issued resourceKind is invalid");
		return value;
	}
	#issuedRecord(value: Omit<SharedIssuedIdentifier, "incarnationUid" | "deletedAt" | "deletion" | "creation">): StoredIssuedIdentifier {
		return {
			scopeId: text(value.scopeId, OPAQUE, "scopeId"),
			resourceKind: this.#issuedKind(value.resourceKind),
			resourceId: text(value.resourceId, OPAQUE, "resourceId"),
			bindingDigest: text(value.bindingDigest, DIGEST, "bindingDigest"),
		};
	}
	#jsonValue(value: JsonValue): void { const encoded = JSON.stringify(value); if (encoded === undefined || encoder.encode(encoded).byteLength > 65_536) throw new TypeError("result is invalid"); JSON.parse(encoded); }
	#clock(): number { return boundedInteger(this.#now(), 0, Number.MAX_SAFE_INTEGER, "clock value"); }
	#opaque(prefix: string, bytes: number): string { const value = this.#randomBytes(bytes); if (!(value instanceof Uint8Array) || value.byteLength !== bytes) throw new SharedControlLedgerUnavailableError(); const encoded = Buffer.from(value).toString("base64url"); return prefix ? `${prefix}_${encoded}` : encoded; }
	#ticketDigest(ticket: string): string { text(ticket, TICKET, "ticket"); return hash(ticket); }
	#publicTombstone(item: StoredTombstone): Tombstone { return { scopeId: item.scopeId, resourceKind: item.resourceKind, resourceId: item.resourceId, deletedAt: item.deletedAt, expiresAt: item.expiresAt }; }
	#publicAdmissionRetirement(item: StoredAdmissionRetirement): AdmissionRetirementIntent {
		return {
			scopeId: item.scopeId,
			resourceKind: item.resourceKind,
			resourceKey: item.resourceKey,
			state: item.state,
			createdAt: new Date(item.createdAt).toISOString(),
			...(item.completedAt === undefined ? {} : { completedAt: new Date(item.completedAt).toISOString() }),
		};
	}
	#cursor(scopeId: string, sequence: number): string { return `k1.${hash(scopeId).slice(0, 16)}.${sequence.toString(36)}`; }
	#decodeCursor(scopeId: string, cursor: string): number { const match = /^k1\.([a-f0-9]{16})\.([0-9a-z]+)$/u.exec(cursor); if (!match || match[1] !== hash(scopeId).slice(0, 16)) throw new TypeError("cursor is invalid"); const sequence = Number.parseInt(match[2]!, 36); return boundedInteger(sequence, 0, Number.MAX_SAFE_INTEGER, "cursor"); }
	#revocationMatches(binding: TicketBinding, request: TicketRevocation): boolean { if (binding.scopeId !== request.scopeId || binding.runtimeId !== request.runtimeId) return false; if (request.cause === "controlDisconnect" || request.cause === "providerControlGenerationReplacement") return binding.providerControlGeneration === request.providerControlGeneration; if (request.cause === "runtimeGenerationReplacement") return binding.runtimeGeneration === request.runtimeGeneration; return (request.runtimeGeneration === undefined || binding.runtimeGeneration === request.runtimeGeneration) && (request.providerControlGeneration === undefined || binding.providerControlGeneration === request.providerControlGeneration) && (request.purpose === undefined || binding.purpose === request.purpose); }
}
