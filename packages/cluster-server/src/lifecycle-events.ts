import type { RequestIdentity } from "./identity.ts";

import { createHash, randomBytes } from "node:crypto";
import type { KubernetesApiClient } from "./kubernetes-client.ts";
import type { ClusterInfrastructureProjection, RestPrincipalProjection, RestRuntimeProjection, RestWorkspaceProjection } from "./kubernetes-projection.ts";

export const LIFECYCLE_EVENT_RETENTION_MS = 60_000;
export const LIFECYCLE_EVENT_MAX_COUNT = 256;
export const LIFECYCLE_EVENT_MAX_BYTES = 192 * 1024;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9:._~-]{0,127}$/u;
const PHASES = new Set(["Pending", "Provisioning", "Starting", "Ready", "Sleeping", "Stopped", "Deleting", "Unavailable", "Degraded", "Failed"]);
const encoder = new TextEncoder();

export type LifecycleResourceKind = "scope" | "workspace" | "runtime";
export interface LifecycleInvalidationData { readonly eventId: string; readonly event: "invalidation"; readonly resourceKind: LifecycleResourceKind; readonly resourceId: string; readonly scopeId: string; readonly revision: string; readonly phase: string; readonly timestamp: string; }
export interface LifecycleResetData { readonly eventId: string; readonly event: "reset"; readonly reason: "cursor_expired"; readonly timestamp: string; }
export type LifecycleEventData = LifecycleInvalidationData | LifecycleResetData;
export interface LifecycleInvalidationInput { readonly principal: string; readonly resourceKind: LifecycleResourceKind; readonly resourceId: string; readonly scopeId: string; readonly revision: string; readonly phase: string; readonly timestamp?: string; }
export interface ClusterLifecycleEventSource { response(principal: string, lastEventId: string | undefined, signal: AbortSignal, scopeId?: string, identity?: RequestIdentity): Promise<Response>; }
export interface ClusterLifecycleEventLedger extends ClusterLifecycleEventSource { append(input: LifecycleInvalidationInput): Promise<LifecycleInvalidationData>; close(): void | Promise<void>; }
interface StoredLifecycleEvent extends LifecycleInvalidationData { readonly sequence: number; readonly principal: string; }
export interface LifecycleLedgerState { readonly version: 1; readonly nextSequence: number; readonly events: readonly StoredLifecycleEvent[]; }
export interface LifecycleLedgerSnapshot { readonly resourceVersion: string; readonly state: LifecycleLedgerState; }
export interface LifecycleEventStorage { read(): Promise<LifecycleLedgerSnapshot | undefined>; create(state: LifecycleLedgerState): Promise<LifecycleLedgerSnapshot>; replace(resourceVersion: string, state: LifecycleLedgerState): Promise<LifecycleLedgerSnapshot>; }

export class LifecycleEventConflictError extends Error { constructor() { super("lifecycle event ledger changed concurrently"); this.name = "LifecycleEventConflictError"; } }
export class LifecycleEventCapacityError extends Error { constructor() { super("lifecycle event ledger has reached its retained capacity"); this.name = "LifecycleEventCapacityError"; } }
export class LifecycleEventUnavailableError extends Error { constructor() { super("lifecycle event ledger is unavailable"); this.name = "LifecycleEventUnavailableError"; } }

function normalizedTimestamp(value: string | undefined, now: number): string {
	if (value === undefined) return new Date(now).toISOString();
	const milliseconds = Date.parse(value);
	if (!Number.isFinite(milliseconds) || value.length > 64) throw new Error("lifecycle event timestamp is invalid");
	return new Date(milliseconds).toISOString();
}
function publicValue(value: string, pattern: RegExp, label: string): string { if (!pattern.test(value)) throw new Error(`lifecycle event ${label} is invalid`); return value; }
function validateInput(input: LifecycleInvalidationInput, now: number): Omit<StoredLifecycleEvent, "eventId" | "sequence"> {
	if (!input.principal || encoder.encode(input.principal).byteLength > 256 || /\p{Cc}/u.test(input.principal)) throw new Error("lifecycle event principal is invalid");
	if (input.resourceKind !== "scope" && input.resourceKind !== "workspace" && input.resourceKind !== "runtime") throw new Error("lifecycle event resource kind is invalid");
	if (!PHASES.has(input.phase)) throw new Error("lifecycle event phase is invalid");
	return { principal: input.principal, event: "invalidation", resourceKind: input.resourceKind, resourceId: publicValue(input.resourceId, EVENT_ID, "resource ID"), scopeId: publicValue(input.scopeId, EVENT_ID, "scope ID"), revision: publicValue(input.revision, REVISION, "revision"), phase: input.phase, timestamp: normalizedTimestamp(input.timestamp, now) };
}
function parseState(value: LifecycleLedgerState, maxCount: number, maxBytes: number): LifecycleLedgerState {
	if (!value || value.version !== 1 || !Number.isSafeInteger(value.nextSequence) || value.nextSequence < 1 || !Array.isArray(value.events) || value.events.length > maxCount || encoder.encode(JSON.stringify(value)).byteLength > maxBytes) throw new LifecycleEventUnavailableError();
	let previous = 0;
	for (const item of value.events) {
		if (!Number.isSafeInteger(item.sequence) || item.sequence <= previous || item.sequence >= value.nextSequence || !EVENT_ID.test(item.eventId)) throw new LifecycleEventUnavailableError();
		validateInput(item, Date.parse(item.timestamp));
		previous = item.sequence;
	}
	return value;
}
function stateBytes(value: LifecycleLedgerState): number { return encoder.encode(JSON.stringify(value)).byteLength; }
function createEventId(sequence: number, principal: string, resourceKind: string, resourceId: string, revision: string): string {
	const digest = createHash("sha256").update(String(sequence)).update("\0").update(principal).update("\0").update(resourceKind).update("\0").update(resourceId).update("\0").update(revision).digest("base64url").slice(0, 28);
	return `evt_${digest}`;
}
export function publicLifecycleScopeId(principal: string): string { return `scope_${createHash("sha256").update(principal).digest("base64url").slice(0, 24)}`; }
export function encodeLifecycleSse(data: LifecycleEventData): Uint8Array { return encoder.encode(`id: ${data.eventId}\nevent: ${data.event}\ndata: ${JSON.stringify(data)}\n\n`); }

interface Subscriber { readonly principal: string; readonly scopeId?: string; afterSequence: number; readonly controller: ReadableStreamDefaultController<Uint8Array>; readonly queue: Uint8Array[]; closed: boolean; cleanup(): void; }
export interface SharedLifecycleEventLedgerOptions { readonly storage: LifecycleEventStorage; readonly now?: () => number; readonly retentionMs?: number; readonly maxCount?: number; readonly maxBytes?: number; readonly pollMs?: number; readonly subscriberQueueLimit?: number; }
export class SharedLifecycleEventLedger implements ClusterLifecycleEventLedger {
	readonly #storage: LifecycleEventStorage; readonly #now: () => number; readonly #retentionMs: number; readonly #maxCount: number; readonly #maxBytes: number; readonly #pollMs: number; readonly #subscriberQueueLimit: number;
	readonly #subscribers = new Set<Subscriber>(); #timer?: ReturnType<typeof setInterval>; #polling?: Promise<void>; #closed = false;
	constructor(options: SharedLifecycleEventLedgerOptions) {
		this.#storage = options.storage; this.#now = options.now ?? Date.now; this.#retentionMs = options.retentionMs ?? LIFECYCLE_EVENT_RETENTION_MS; this.#maxCount = options.maxCount ?? LIFECYCLE_EVENT_MAX_COUNT; this.#maxBytes = options.maxBytes ?? LIFECYCLE_EVENT_MAX_BYTES; this.#pollMs = options.pollMs ?? 1_000; this.#subscriberQueueLimit = options.subscriberQueueLimit ?? this.#maxCount + 1;
		if (!Number.isSafeInteger(this.#retentionMs) || this.#retentionMs !== LIFECYCLE_EVENT_RETENTION_MS) throw new Error("lifecycle event retention must be 60 seconds");
		if (!Number.isSafeInteger(this.#maxCount) || this.#maxCount < 1 || this.#maxCount > 10_000) throw new Error("lifecycle event count limit is invalid");
		if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 512 || this.#maxBytes > 512 * 1024) throw new Error("lifecycle event byte limit is invalid");
		if (!Number.isSafeInteger(this.#pollMs) || this.#pollMs < 10 || this.#pollMs > 10_000) throw new Error("lifecycle event poll interval is invalid");
		if (!Number.isSafeInteger(this.#subscriberQueueLimit) || this.#subscriberQueueLimit < 1 || this.#subscriberQueueLimit > this.#maxCount + 1) throw new Error("lifecycle subscriber queue limit is invalid");
	}
	get connectionCount(): number { return this.#subscribers.size; }
	async append(input: LifecycleInvalidationInput): Promise<LifecycleInvalidationData> {
		if (this.#closed) throw new LifecycleEventUnavailableError();
		const now = this.#now(); const valid = validateInput(input, now);
		for (let attempt = 0; attempt < 8; attempt++) {
			const snapshot = await this.#storage.read();
			const current: LifecycleLedgerState = snapshot ? parseState(snapshot.state, this.#maxCount, this.#maxBytes) : { version: 1, nextSequence: 1, events: [] };
			const retained = current.events.filter(item => Date.parse(item.timestamp) > now - this.#retentionMs);
			let latest: StoredLifecycleEvent | undefined;
			for (let index = retained.length - 1; index >= 0; index--) {
				const item = retained[index]!;
				if (item.principal === valid.principal && item.scopeId === valid.scopeId && item.resourceKind === valid.resourceKind && item.resourceId === valid.resourceId) { latest = item; break; }
			}
			if (latest?.revision === valid.revision && latest.phase === valid.phase) return this.#public(latest);
			const sequence = current.nextSequence; if (!Number.isSafeInteger(sequence + 1)) throw new LifecycleEventCapacityError();
			const item: StoredLifecycleEvent = { ...valid, sequence, eventId: createEventId(sequence, valid.principal, valid.resourceKind, valid.resourceId, valid.revision) };
			const next: LifecycleLedgerState = { version: 1, nextSequence: sequence + 1, events: [...retained, item] };
			if (next.events.length > this.#maxCount || stateBytes(next) > this.#maxBytes) throw new LifecycleEventCapacityError();
			try { if (snapshot) await this.#storage.replace(snapshot.resourceVersion, next); else await this.#storage.create(next); void this.#poll(); return this.#public(item); }
			catch (error) { if (error instanceof LifecycleEventConflictError) continue; throw error; }
		}
		throw new LifecycleEventUnavailableError();
	}
	async response(principal: string, lastEventId: string | undefined, signal: AbortSignal, scopeId?: string, _identity?: RequestIdentity): Promise<Response> {
		if (this.#closed || !principal || encoder.encode(principal).byteLength > 256 || /\p{Cc}/u.test(principal)) throw new LifecycleEventUnavailableError();
		if (lastEventId !== undefined && !EVENT_ID.test(lastEventId)) throw new Error("Last-Event-ID is invalid");
		if (scopeId !== undefined && !EVENT_ID.test(scopeId)) throw new Error("lifecycle event scope filter is invalid");
		const now = this.#now(); const snapshot = await this.#storage.read();
		const state: LifecycleLedgerState = snapshot ? parseState(snapshot.state, this.#maxCount, this.#maxBytes) : { version: 1, nextSequence: 1, events: [] };
		const own = state.events.filter(item => item.principal === principal && (scopeId === undefined || item.scopeId === scopeId) && Date.parse(item.timestamp) > now - this.#retentionMs);
		const cursor = lastEventId === undefined ? undefined : own.find(item => item.eventId === lastEventId);
		const initial: LifecycleEventData[] = [];
		if (lastEventId !== undefined && !cursor) {
			initial.push({ eventId: `reset_${randomBytes(18).toString("base64url")}`, event: "reset", reason: "cursor_expired", timestamp: new Date(now).toISOString() });
		} else if (cursor) for (const item of own) if (item.sequence > cursor.sequence) initial.push(this.#public(item));
		let subscriber: Subscriber | undefined;
		const stream = new ReadableStream<Uint8Array>({
			start: controller => {
				const queue = initial.map(encodeLifecycleSse);
				const cleanup = (): void => { if (!subscriber || subscriber.closed) return; subscriber.closed = true; this.#subscribers.delete(subscriber); signal.removeEventListener("abort", abort); this.#stopPollingWhenIdle(); };
				const abort = (): void => { cleanup(); try { controller.close(); } catch { /* already closed */ } };
				subscriber = { principal, ...(scopeId === undefined ? {} : { scopeId }), afterSequence: state.nextSequence - 1, controller, queue, closed: false, cleanup }; this.#subscribers.add(subscriber); signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) abort(); else { this.#flush(subscriber); this.#startPolling(); }
			}, pull: () => { if (subscriber) this.#flush(subscriber); }, cancel: () => { subscriber?.cleanup(); },
		});
		return new Response(stream, { headers: { "cache-control": "no-store", "content-type": "text/event-stream", "x-accel-buffering": "no", "content-encoding": "identity" } });
	}
	close(): void { if (this.#closed) return; this.#closed = true; if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; for (const subscriber of this.#subscribers) { subscriber.cleanup(); try { subscriber.controller.close(); } catch { /* already closed */ } } }
	#public(item: StoredLifecycleEvent): LifecycleInvalidationData { return { eventId: item.eventId, event: "invalidation", resourceKind: item.resourceKind, resourceId: item.resourceId, scopeId: item.scopeId, revision: item.revision, phase: item.phase, timestamp: item.timestamp }; }
	#flush(subscriber: Subscriber): void { while (!subscriber.closed && subscriber.queue.length > 0 && (subscriber.controller.desiredSize ?? 0) > 0) subscriber.controller.enqueue(subscriber.queue.shift()!); }
	#startPolling(): void { if (this.#timer || this.#closed) return; this.#timer = setInterval(() => { void this.#poll(); }, this.#pollMs); this.#timer.unref?.(); }
	#stopPollingWhenIdle(): void { if (this.#subscribers.size > 0 || !this.#timer) return; clearInterval(this.#timer); this.#timer = undefined; }
	async #poll(): Promise<void> {
		if (this.#polling || this.#closed || this.#subscribers.size === 0) return this.#polling;
		this.#polling = (async () => {
			try {
				const snapshot = await this.#storage.read();
				if (!snapshot) return;
				const state = parseState(snapshot.state, this.#maxCount, this.#maxBytes);
				const now = this.#now();
				for (const subscriber of this.#subscribers) {
					const additions = state.events.filter(item =>
						item.sequence > subscriber.afterSequence &&
						item.principal === subscriber.principal &&
						(subscriber.scopeId === undefined || item.scopeId === subscriber.scopeId) &&
						Date.parse(item.timestamp) > now - this.#retentionMs);
					subscriber.afterSequence = Math.max(subscriber.afterSequence, state.nextSequence - 1);
					if (subscriber.queue.length + additions.length > this.#subscriberQueueLimit) {
						subscriber.cleanup();
						try { subscriber.controller.error(new LifecycleEventCapacityError()); } catch { /* already closed */ }
						continue;
					}
					for (const item of additions) subscriber.queue.push(encodeLifecycleSse(this.#public(item)));
					this.#flush(subscriber);
				}
			} catch {
				for (const subscriber of this.#subscribers) {
					subscriber.cleanup();
					try { subscriber.controller.error(new LifecycleEventUnavailableError()); } catch { /* already closed */ }
				}
			} finally {
				this.#polling = undefined;
			}
		})();
		return this.#polling;
	}
}

export class KubernetesConfigMapLifecycleEventStorage implements LifecycleEventStorage {
	readonly #client: KubernetesApiClient; readonly #name: string;
	constructor(client: KubernetesApiClient, authorityName: string) { this.#client = client; this.#name = `t4-events-${createHash("sha256").update(authorityName).digest("hex").slice(0, 24)}`; }
	async read(): Promise<LifecycleLedgerSnapshot | undefined> { try { return this.#snapshot(await this.#client.request(this.#path()) as Record<string, unknown>); } catch (error) { if (typeof error === "object" && error !== null && "status" in error && error.status === 404) return undefined; throw new LifecycleEventUnavailableError(); } }
	async create(state: LifecycleLedgerState): Promise<LifecycleLedgerSnapshot> { try { const body = this.#body(state); return this.#snapshot(await this.#client.request(this.#collection(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as Record<string, unknown>); } catch (error) { return this.#translate(error); } }
	async replace(resourceVersion: string, state: LifecycleLedgerState): Promise<LifecycleLedgerSnapshot> { try { const body = this.#body(state, resourceVersion); return this.#snapshot(await this.#client.request(this.#path(), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as Record<string, unknown>); } catch (error) { return this.#translate(error); } }
	#collection(): string { return `/api/v1/namespaces/${encodeURIComponent(this.#client.namespace)}/configmaps`; }
	#path(): string { return `${this.#collection()}/${this.#name}`; }
	#body(state: LifecycleLedgerState, resourceVersion?: string): object { return { apiVersion: "v1", kind: "ConfigMap", metadata: { name: this.#name, ...(resourceVersion ? { resourceVersion } : {}) }, immutable: false, data: { ledger: JSON.stringify(state) } }; }
	#snapshot(value: Record<string, unknown>): LifecycleLedgerSnapshot { const metadata = value.metadata as Record<string, unknown> | undefined; const data = value.data as Record<string, unknown> | undefined; if (value.apiVersion !== "v1" || value.kind !== "ConfigMap" || typeof metadata?.resourceVersion !== "string" || typeof data?.ledger !== "string" || encoder.encode(data.ledger).byteLength > LIFECYCLE_EVENT_MAX_BYTES) throw new LifecycleEventUnavailableError(); try { return { resourceVersion: metadata.resourceVersion, state: JSON.parse(data.ledger) as LifecycleLedgerState }; } catch { throw new LifecycleEventUnavailableError(); } }
	#translate(error: unknown): never { if (typeof error === "object" && error !== null && "status" in error && error.status === 409) throw new LifecycleEventConflictError(); throw new LifecycleEventUnavailableError(); }
}

export interface LifecycleProjectionNotifierOptions { readonly projection: ClusterInfrastructureProjection; readonly ledger: Pick<ClusterLifecycleEventLedger, "append">; readonly now?: () => number; readonly onError?: (error: unknown) => void; }
export class LifecycleProjectionNotifier {
	readonly #projection: ClusterInfrastructureProjection;
	readonly #ledger: Pick<ClusterLifecycleEventLedger, "append">;
	readonly #now: () => number;
	readonly #onError?: (error: unknown) => void;
	#previous = new Map<string, RestPrincipalProjection>();
	#initialized = false;
	#appendChain: Promise<void> = Promise.resolve();
	#unsubscribeWorkspace?: () => void;
	#unsubscribeSessions?: () => void;
	constructor(options: LifecycleProjectionNotifierOptions) {
		this.#projection = options.projection;
		this.#ledger = options.ledger;
		this.#now = options.now ?? Date.now;
		this.#onError = options.onError;
	}
	start(): void {
		if (this.#unsubscribeWorkspace || this.#unsubscribeSessions) throw new Error("lifecycle projection notifier already started");
		const notify = (): void => { void this.synchronize().catch(error => { this.#onError?.(error); }); };
		this.#unsubscribeWorkspace = this.#projection.subscribe(notify);
		this.#unsubscribeSessions = this.#projection.subscribeSessions(notify);
	}
	async stop(): Promise<void> {
		this.#unsubscribeWorkspace?.();
		this.#unsubscribeSessions?.();
		this.#unsubscribeWorkspace = undefined;
		this.#unsubscribeSessions = undefined;
		await this.#appendChain;
	}
	synchronize(): Promise<void> {
		const active = new Set(this.#projection.restPrincipals());
		const principals = new Set([...this.#previous.keys(), ...active]);
		const next = new Map<string, RestPrincipalProjection>();
		for (const principal of [...active].sort()) next.set(principal, this.#projection.restProjection(principal));
		if (!this.#initialized) {
			this.#previous = next;
			this.#initialized = true;
			return this.#appendChain;
		}
		const inputs: LifecycleInvalidationInput[] = [];
		for (const principal of [...principals].sort()) {
			const before = this.#previous.get(principal) ?? { revision: "", workspaces: [], runtimes: [] };
			const after = next.get(principal) ?? this.#projection.restProjection(principal);
			const scopeId = publicLifecycleScopeId(principal);
			const time = new Date(this.#now()).toISOString();
			if (before.revision !== after.revision && after.revision)
				inputs.push({ principal, resourceKind: "scope", resourceId: scopeId, scopeId, revision: after.revision, phase: "Ready", timestamp: time });
			this.#collectChangedResources(inputs, principal, scopeId, "workspace", before.workspaces, after.workspaces, time);
			this.#collectChangedResources(inputs, principal, scopeId, "runtime", before.runtimes, after.runtimes, time);
		}
		this.#previous = next;
		const pending = this.#appendChain.then(async () => {
			for (const input of inputs) await this.#ledger.append(input);
		});
		this.#appendChain = pending.catch(() => undefined);
		return pending;
	}
	#collectChangedResources(
		inputs: LifecycleInvalidationInput[],
		principal: string,
		scopeId: string,
		kind: "workspace" | "runtime",
		before: readonly (RestWorkspaceProjection | RestRuntimeProjection)[],
		after: readonly (RestWorkspaceProjection | RestRuntimeProjection)[],
		time: string,
	): void {
		const old = new Map(before.map(item => [item.id, item]));
		const current = new Map(after.map(item => [item.id, item]));
		for (const id of [...new Set([...old.keys(), ...current.keys()])].sort()) {
			const prior = old.get(id);
			const value = current.get(id);
			if (prior?.revision === value?.revision && prior?.phase === value?.phase) continue;
			const selected = value ?? prior;
			if (selected) inputs.push({
				principal,
				resourceKind: kind,
				resourceId: id,
				scopeId,
				revision: selected.revision,
				phase: value?.phase ?? "Deleting",
				timestamp: time,
			});
		}
	}
}
