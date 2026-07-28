import { randomUUID } from "node:crypto";
import {
	type ClientFrame,
	COMMAND_DESCRIPTORS,
	type CommandFrame,
	type ConfirmFrame,
	DEVICE_CAPABILITIES,
	type HelloFrame,
	isSecretLikeKey,
	MAX_ARRAY_ITEMS,
	MAX_MAP_KEYS,
	type PairOkFrame,
	type PairStartFrame,
	pairingId,
	REMOTE_DEFAULT_CAPABILITIES,
	type ServerFrame,
	leaseId as wireLeaseId,
} from "@t4-code/host-wire";
import {
	type AuthenticatedPrincipal,
	type AuthorizationGuard,
	type Capability,
	canonicalDeviceIdentityKey,
	type Clock,
	type DeviceMetadata,
	type DeviceRegistry,
	type Lease,
	LeaseRegistry,
	LocalPairingTicketIssuer,
	type PairingService,
	type Random,
	type SecureConfirmationStore,
	type RemotePeerIdentity as SecurityPeerIdentity,
	SqliteDeviceRegistry,
	type TokenBucketLimiter,
} from "../security/index.ts";
import type { RemoteAuthorizationContext, RemoteConnectionPolicy, RemoteHelloDecision } from "../types.ts";
import type { RemoteConnection, RemotePeerIdentity } from "./types.ts";

interface CachedCommand {
	readonly fingerprint: string;
	readonly response: ServerFrame;
	readonly expiresAt: number;
}
interface ConnectionState {
	readonly connection: RemoteConnection;
	principal?: AuthenticatedPrincipal;
	capabilities: readonly Capability[];
	features: readonly string[];
	paired: boolean;
	justPaired: boolean;
	ready: boolean;
	closeIssued: boolean;
	readonly commandContexts: Map<
		string,
		{ capability: Capability; sessionId?: string; leaseId?: string; lease?: Lease; released?: boolean }
	>;
	readonly idempotency: Map<string, CachedCommand>;
}
export interface TailscaleRemotePolicyOptions {
	readonly registry: DeviceRegistry;
	readonly pairing?: PairingService;
	readonly localPairing?: LocalPairingTicketIssuer;
	readonly leases?: LeaseRegistry;
	readonly guard?: AuthorizationGuard;
	readonly limiter?: TokenBucketLimiter;
	readonly confirmations?: SecureConfirmationStore;
	readonly clock?: Clock;
	readonly random?: Random;
	readonly supportedCapabilities?: readonly string[];
	readonly supportedFeatures?: readonly string[];
}
export interface LocalPairingTicketFactoryOptions {
	readonly databasePath: string;
	readonly key: Uint8Array;
	readonly clock?: Clock;
	readonly random?: Random;
}
export function createTailscaleRemotePolicy(options: LocalPairingTicketFactoryOptions): TailscaleRemotePolicy {
	const registry = new SqliteDeviceRegistry(options.databasePath, options.clock, options.random);
	const localPairing = new LocalPairingTicketIssuer(registry, options.key, options.clock, options.random);
	return new TailscaleRemotePolicy({ registry, localPairing, clock: options.clock, random: options.random });
}
function securityIdentity(peer: RemotePeerIdentity): SecurityPeerIdentity {
	const address = peer.addresses[0];
	if (!address) throw new Error("peer identity invalid");
	return {
		nodeId: peer.nodeId,
		login: peer.user ?? peer.nodeId,
		hostId: peer.hostname ?? peer.nodeId,
		tailnetIp: address,
	};
}
/** The exact device identity key registry.authenticate derives for this peer
 * at hello time — used to mint the local autoconnect device record offline. */
export function deviceIdentityKeyForPeer(peer: RemotePeerIdentity): string {
	return canonicalDeviceIdentityKey(securityIdentity(peer));
}
function safeString(value: unknown, max = 256): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max && ![...value].some(character => {
		const code = character.codePointAt(0) ?? 0;
		return code <= 0x1f || code === 0x7f;
	});
}
function requestedCapabilities(hello: HelloFrame): Capability[] {
	const requested = hello.capabilities === undefined ? REMOTE_DEFAULT_CAPABILITIES : hello.capabilities.client;
	return requested.filter((value): value is Capability => (DEVICE_CAPABILITIES as readonly string[]).includes(value));
}
function capIntersection(
	granted: readonly string[],
	requested: readonly string[],
	supported: readonly string[],
): Capability[] {
	const requestedSet = new Set(requested);
	const allowed = new Set(granted);
	return supported.filter(
		(value): value is Capability =>
			requestedSet.has(value) && allowed.has(value) && (DEVICE_CAPABILITIES as readonly string[]).includes(value),
	);
}
function featureIntersection(
	granted: readonly string[],
	requested: readonly string[],
	supported: readonly string[],
): string[] {
	const requestedSet = new Set(requested);
	const allowed = new Set(granted);
	return supported.filter(value => requestedSet.has(value) && allowed.has(value));
}
function leaseId(args: Record<string, unknown>): string | undefined {
	if (!Object.hasOwn(args, "leaseId") || args.leaseId === undefined) return undefined;
	try {
		return wireLeaseId(args.leaseId, "args.leaseId");
	} catch {
		return undefined;
	}
}
function mutation(command: string): boolean {
	return [
		"session.prompt",
		"session.steer",
		"session.followUp",
		"session.ui.respond",
		"session.rename",
		"session.retry",
		"session.compact",
		"session.pause",
		"session.resume",
		"session.model.set",
		"session.thinking.set",
		"session.fast.set",
		"session.mode.set",
		"session.close",
		"session.cancel",
		"files.write",
		"files.patch",
		"review.apply",
		"bash.run",
		"agent.cancel",
		"preview.launch",
		"preview.navigate",
	].includes(command);
}
function commandFeature(command: string): string | undefined {
	if (command.startsWith("controller.lease.")) return "controller.lease";
	if (command.startsWith("prompt.lease.")) return "prompt.lease";
	if (command === "files.list") return "files.list";
	if (command === "files.search") return "files.search";
	if (command === "files.diff") return "files.diff";
	if (command === "transcript.search" || command === "transcript.context") return "transcript.search";
	if (command === "transcript.page") return "transcript.page";
	if (command.startsWith("preview.")) return "preview.control";
	return undefined;
}
function serverLeaseCommand(command: string): boolean {
	return command.startsWith("controller.lease.") || command.startsWith("prompt.lease.");
}
function frameFeature(frame: ClientFrame): string | undefined {
	if (frame.type === "command") return commandFeature(frame.command);
	if (frame.type === "terminal.input" || frame.type === "terminal.resize" || frame.type === "terminal.close")
		return "terminal.io";
	return undefined;
}
function frameCapability(frame: ClientFrame): Capability | undefined {
	if (frame.type === "command") return COMMAND_DESCRIPTORS[frame.command]?.capability;
	if (frame.type === "terminal.input" || frame.type === "terminal.resize" || frame.type === "terminal.close")
		return frame.type === "terminal.input"
			? "term.input"
			: frame.type === "terminal.resize"
				? "term.resize"
				: "term.open";
	return undefined;
}
function canonicalValue(value: unknown, seen = new WeakSet<object>()): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
	if (typeof value !== "object") return "null";
	if (seen.has(value)) throw new Error("command payload cycle");
	seen.add(value);
	let result: string;
	if (Array.isArray(value)) result = `[${value.map(item => canonicalValue(item, seen)).join(",")}]`;
	else
		result = `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, child]) => `${JSON.stringify(key)}:${canonicalValue(child, seen)}`)
			.join(",")}}`;
	seen.delete(value);
	return result;
}
function commandFingerprint(frame: CommandFrame): string {
	return canonicalValue({
		command: frame.command,
		hostId: frame.hostId,
		sessionId: frame.sessionId,
		expectedRevision: frame.expectedRevision,
		confirmationId: frame.confirmationId,
		args: frame.args,
	});
}
function leaseResponse(
	frame: CommandFrame,
	context: { leaseId?: string; lease?: Lease; released?: boolean },
): ServerFrame {
	const result = context.lease
		? {
				leaseId: context.lease.leaseId,
				owner: context.lease.owner,
				deviceId: context.lease.deviceId,
				connectionId: context.lease.connectionId,
				sessionId: context.lease.sessionId,
				kind: context.lease.kind,
				expiresAt: context.lease.expiresAt,
			}
		: { leaseId: context.leaseId, released: context.released === true };
	return {
		v: "omp-app/1",
		type: "response",
		requestId: frame.requestId,
		commandId: frame.commandId,
		command: frame.command,
		hostId: frame.hostId,
		sessionId: frame.sessionId,
		ok: true,
		result,
	} as ServerFrame;
}
function leaseErrorResponse(
	frame: CommandFrame,
	code: string,
	message: string,
	details?: Record<string, unknown>,
): ServerFrame {
	return {
		v: "omp-app/1",
		type: "response",
		requestId: frame.requestId,
		commandId: frame.commandId,
		command: frame.command,
		hostId: frame.hostId,
		sessionId: frame.sessionId,
		ok: false,
		error: {
			code,
			message,
			...(details ? { details } : {}),
		},
	} as ServerFrame;
}
function boundedRevisionDetails(expected: unknown, actual: unknown): Record<string, unknown> | undefined {
	return safeString(expected) && safeString(actual)
		? { expectedRevision: expected, actualRevision: actual }
		: undefined;
}

export class TailscaleRemotePolicy implements RemoteConnectionPolicy {
	readonly #states = new Map<string, ConnectionState>();
	readonly #registry: DeviceRegistry;
	readonly #localPairing?: LocalPairingTicketIssuer;
	readonly #leases: LeaseRegistry;
	readonly #guard?: AuthorizationGuard;
	readonly #limiter?: TokenBucketLimiter;
	readonly #confirmations?: SecureConfirmationStore;
	readonly #clock: Clock;
	readonly #supportedCapabilities: readonly Capability[];
	readonly #supportedFeatures: readonly string[];
	readonly #unsubscribeInvalidation?: () => void;
	constructor(options: TailscaleRemotePolicyOptions) {
		this.#registry = options.registry;
		this.#localPairing = options.localPairing;
		this.#leases = options.leases ?? new LeaseRegistry(options.clock, options.random);
		this.#guard = options.guard;
		this.#limiter = options.limiter;
		this.#confirmations = options.confirmations;
		this.#clock = options.clock ?? { now: () => Date.now() };
		this.#supportedCapabilities = (options.supportedCapabilities ?? DEVICE_CAPABILITIES).filter(
			(value): value is Capability => (DEVICE_CAPABILITIES as readonly string[]).includes(value),
		);
		this.#supportedFeatures = [
			...(options.supportedFeatures ?? [
				"resume",
				"controller.lease",
				"prompt.lease",
				"terminal.io",
				"files.list",
				"files.diff",
				"catalog.metadata",
				"settings.metadata",
			]),
		];
		this.#unsubscribeInvalidation = options.registry.onInvalidation?.(deviceId => this.#invalidateDevice(deviceId));
	}
	issuePairingTicket(
		allowedCapabilities: readonly string[],
		ttlMs = 120_000,
		nodeId?: string,
	): { readonly code: string; readonly expiresAt: number } {
		if (
			!this.#localPairing ||
			allowedCapabilities.length === 0 ||
			allowedCapabilities.some(value => !DEVICE_CAPABILITIES.includes(value as Capability))
		)
			throw new Error("local pairing capabilities invalid");
		return this.#localPairing.issue(allowedCapabilities as Capability[], ttlMs, nodeId);
	}
	listDeviceSummaries() {
		return this.#registry.list().map(device => ({
			deviceId: device.deviceId,
			label: device.metadata.label,
			...(device.metadata.platform ? { platform: device.metadata.platform } : {}),
			capabilities: [...device.capabilities],
			createdAt: device.createdAt,
			lastSeenAt: device.lastSeenAt,
			revokedAt: device.revokedAt,
		}));
	}
	revokeDevice(deviceId: string): { readonly revoked: true } {
		if (!safeString(deviceId, 512)) throw new Error("device id invalid");
		this.#registry.revoke(deviceId);
		this.#invalidateDevice(deviceId);
		return { revoked: true };
	}
	close(): void {
		this.#unsubscribeInvalidation?.();
		this.#registry.close();
	}
	#invalidateDevice(deviceId: string): void {
		this.#leases.invalidateDevice(deviceId);
		this.#confirmations?.invalidateDevice(deviceId);
		for (const state of this.#states.values()) {
			if (state.principal?.deviceId !== deviceId) continue;
			state.paired = false;
			state.ready = false;
			state.justPaired = false;
			state.capabilities = [];
			state.features = [];
			state.commandContexts.clear();
			state.idempotency.clear();
			if (!state.closeIssued) {
				state.closeIssued = true;
				try {
					state.connection.socket.close(1008, "remote policy denied");
				} catch {}
			}
		}
	}
	#livePrincipal(state: ConnectionState): AuthenticatedPrincipal | undefined {
		if (!state.principal || !state.paired || !state.ready) return undefined;
		const principal = this.#registry.getAuthenticatedPrincipal(
			state.connection.connectionId,
			state.principal.deviceId,
		);
		if (!principal) {
			this.#invalidateDevice(state.principal.deviceId);
			return undefined;
		}
		state.principal = principal;
		return principal;
	}
	isClosed(connection: RemoteConnection): boolean {
		return this.#states.get(connection.connectionId)?.closeIssued === true;
	}
	authenticate(connection: RemoteConnection, hello: HelloFrame): RemoteHelloDecision {
		const state: ConnectionState = {
			connection,
			capabilities: [],
			features: [],
			paired: false,
			justPaired: false,
			ready: false,
			closeIssued: false,
			commandContexts: new Map(),
			idempotency: new Map(),
		};
		this.#states.set(connection.connectionId, state);
		if (hello.authentication === undefined)
			return {
				authenticated: false,
				authentication: "pairing-required",
				grantedCapabilities: [],
				grantedFeatures: [],
			};
		try {
			const principal = this.#registry.authenticate(
				hello.authentication.deviceId,
				hello.authentication.deviceToken,
				securityIdentity(connection.peer.identity),
				connection.connectionId,
			);
			state.principal = principal;
			state.paired = true;
			state.ready = true;
			state.capabilities = capIntersection(
				principal.capabilities,
				requestedCapabilities(hello),
				this.#supportedCapabilities,
			);
			state.features = featureIntersection(
				this.#supportedFeatures,
				hello.requestedFeatures,
				this.#supportedFeatures,
			);
			return {
				authenticated: true,
				authentication: "paired",
				grantedCapabilities: state.capabilities,
				grantedFeatures: state.features,
				deviceId: principal.deviceId,
			};
		} catch {
			return { authenticated: false, authentication: "denied", grantedCapabilities: [], grantedFeatures: [] };
		}
	}
	pairStart(connection: RemoteConnection, frame: PairStartFrame): PairOkFrame | undefined {
		const state = this.#states.get(connection.connectionId);
		if (!state || state.paired || !this.#localPairing) return undefined;
		const source = connection.peer.identity;
		if (
			this.#limiter &&
			!this.#limiter.allowUnauthenticatedPairing(securityIdentity(source), connection.peer.address)
		)
			return undefined;
		try {
			const result = this.#localPairing.consume(
				frame.code,
				securityIdentity(source),
				frame.deviceId,
				{ label: frame.deviceName, platform: frame.platform } satisfies DeviceMetadata,
				frame.requestedCapabilities as Capability[],
			);
			state.paired = true;
			state.justPaired = true;
			state.ready = true;
			state.principal = this.#registry.authenticate(
				result.deviceId,
				result.token,
				securityIdentity(source),
				connection.connectionId,
			);
			state.capabilities = capIntersection(result.capabilities, result.capabilities, this.#supportedCapabilities);
			state.features = [];
			return {
				v: "omp-app/1",
				type: "pair.ok",
				requestId: frame.requestId,
				pairingId: pairingId(`pair-${randomUUID()}`),
				deviceId: result.deviceId,
				deviceName: frame.deviceName,
				platform: frame.platform,
				requestedCapabilities: [...frame.requestedCapabilities],
				grantedCapabilities: [...state.capabilities],
				deviceToken: result.token,
				expiresAt: new Date(result.tokenExpiresAt).toISOString(),
			};
		} catch {
			return undefined;
		}
	}
	authorize(connection: RemoteConnection, frame: ClientFrame, context: RemoteAuthorizationContext): boolean {
		const state = this.#states.get(connection.connectionId);
		if (!state) return false;
		if (frame.type === "ping") return true;
		const principal = this.#livePrincipal(state);
		if (!principal || state.justPaired) return false;
		const feature = frameFeature(frame);
		if (feature !== undefined && !state.features.includes(feature)) return false;
		const capability = frameCapability(frame);
		if (frame.type === "confirm") return this.#authorizeConfirm(state, frame, principal);
		if (!capability || !state.capabilities.includes(capability)) return false;
		if (frame.type !== "command") return true;
		const descriptor = COMMAND_DESCRIPTORS[frame.command];
		if (!descriptor) return false;
		let fingerprint: string;
		try {
			fingerprint = commandFingerprint(frame);
		} catch {
			return false;
		}
		const now = this.#clock.now();
		if (!Number.isFinite(now)) return false;
		const commandKey = String(frame.commandId);
		const cached = state.idempotency.get(commandKey);
		if (cached) {
			if (cached.expiresAt <= now) state.idempotency.delete(commandKey);
			else return cached.fingerprint === fingerprint;
		}
		const cacheResponse = (response: ServerFrame): true => {
			state.idempotency.set(commandKey, { fingerprint, response, expiresAt: now + 300_000 });
			while (state.idempotency.size > 128)
				state.idempotency.delete(state.idempotency.keys().next().value ?? commandKey);
			return true;
		};
		const lease = leaseId(frame.args);
		let leaseResult: Lease | undefined;
		let released = false;
		let releasePending = false;
		if (frame.command === "controller.lease.acquire" || frame.command === "prompt.lease.acquire") {
			if (!frame.sessionId || context.sessionRevision === undefined)
				return cacheResponse(leaseErrorResponse(frame, "unknown_session", "session is not indexed"));
			if (frame.expectedRevision === undefined || frame.expectedRevision !== context.sessionRevision)
				return cacheResponse(
					leaseErrorResponse(
						frame,
						"stale_revision",
						frame.expectedRevision === undefined ? "expectedRevision is required" : "session revision is stale",
						boundedRevisionDetails(frame.expectedRevision, context.sessionRevision),
					),
				);
			const kind = frame.command.startsWith("prompt.") ? "prompt" : "controller";
			try {
				leaseResult = this.#leases.acquire(
					principal.deviceId,
					connection.connectionId,
					frame.sessionId,
					kind,
					30_000,
					principal.epoch,
					frame.expectedRevision,
				);
			} catch {
				return false;
			}
		} else if (
			frame.command === "controller.lease.renew" ||
			frame.command === "controller.lease.release" ||
			frame.command === "prompt.lease.renew" ||
			frame.command === "prompt.lease.release"
		) {
			if (
				!frame.sessionId ||
				!lease ||
				!this.#leases.verify(
					lease,
					principal.deviceId,
					connection.connectionId,
					frame.sessionId,
					frame.command,
					principal.epoch,
					frame.expectedRevision,
				)
			)
				return false;
			if (frame.command.endsWith("renew")) {
				try {
					leaseResult = this.#leases.renew(
						lease,
						principal.deviceId,
						connection.connectionId,
						30_000,
						principal.epoch,
						frame.expectedRevision,
						frame.command,
					);
				} catch {
					return false;
				}
			} else {
				releasePending = true;
			}
		} else if (mutation(frame.command)) {
			if (
				!frame.sessionId ||
				!lease ||
				!this.#leases.verify(
					lease,
					principal.deviceId,
					connection.connectionId,
					frame.sessionId,
					frame.command,
					principal.epoch,
					frame.expectedRevision,
				)
			)
				return false;
		}
		if (this.#guard) {
			try {
				this.#guard.authorize({
					principal,
					command: frame.command,
					capabilities: state.capabilities,
					connectionId: connection.connectionId,
					sessionId: frame.sessionId,
					revision: frame.expectedRevision,
					leaseId: lease,
					confirmationId: frame.confirmationId,
					args: frame.args,
				});
			} catch {
				if (leaseResult)
					this.#leases.release(
						leaseResult.leaseId,
						principal.deviceId,
						connection.connectionId,
						principal.epoch,
						frame.expectedRevision,
						leaseResult.kind === "prompt" ? "prompt.lease.release" : "controller.lease.release",
					);
				return false;
			}
		}
		if (releasePending) {
			try {
				this.#leases.release(
					lease!,
					principal.deviceId,
					connection.connectionId,
					principal.epoch,
					frame.expectedRevision,
					frame.command,
				);
				released = true;
			} catch {
				return false;
			}
		}
		const commandContext = {
			capability,
			...(frame.sessionId ? { sessionId: frame.sessionId } : {}),
			...(lease ? { leaseId: lease } : {}),
			...(leaseResult ? { lease: leaseResult } : {}),
			...(released ? { released } : {}),
		};
		state.commandContexts.set(commandKey, commandContext);
		state.idempotency.set(commandKey, {
			fingerprint,
			response: leaseResponse(frame, commandContext),
			expiresAt: now + 300_000,
		});
		while (state.idempotency.size > 128)
			state.idempotency.delete(state.idempotency.keys().next().value ?? commandKey);
		return true;
	}
	handleCommand(connection: RemoteConnection, frame: CommandFrame): ServerFrame | undefined {
		const state = this.#states.get(connection.connectionId);
		const principal = state ? this.#livePrincipal(state) : undefined;
		const feature = commandFeature(frame.command);
		if (
			!state ||
			!principal ||
			state.justPaired ||
			feature === undefined ||
			!state.features.includes(feature) ||
			!serverLeaseCommand(frame.command)
		)
			return undefined;
		const cached = state.idempotency.get(String(frame.commandId));
		if (!cached) return undefined;
		const now = this.#clock.now();
		if (!Number.isFinite(now) || cached.expiresAt <= now) {
			state.idempotency.delete(String(frame.commandId));
			return undefined;
		}
		let fingerprint: string;
		try {
			fingerprint = commandFingerprint(frame);
		} catch {
			return undefined;
		}
		if (cached.fingerprint !== fingerprint) return undefined;
		if (cached.response.type !== "response") return undefined;
		return { ...cached.response, requestId: frame.requestId, commandId: frame.commandId };
	}
	#authorizeConfirm(state: ConnectionState, frame: ConfirmFrame, principal: AuthenticatedPrincipal): boolean {
		const context = state.commandContexts.get(String(frame.commandId));
		if (!context || !state.capabilities.includes(context.capability)) return false;
		if (
			context.leaseId &&
			context.sessionId &&
			!this.#leases.verify(
				context.leaseId,
				principal.deviceId,
				state.connection.connectionId,
				context.sessionId,
				"session.prompt",
				principal.epoch,
			)
		)
			return false;
		return true;
	}
	transformOutbound(connection: RemoteConnection, frame: ServerFrame): ServerFrame | undefined {
		const state = this.#states.get(connection.connectionId);
		if (!state || state.closeIssued) return undefined;
		if (frame.type === "pair.ok") {
			if (!state.justPaired) return undefined;
			state.justPaired = false;
			return frame;
		}
		const cloned = sanitizeRemoteFrame(frame);
		if (cloned === undefined) return undefined;
		return cloned as ServerFrame;
	}
	disconnected(connection: RemoteConnection): void {
		const state = this.#states.get(connection.connectionId);
		if (state?.principal) this.#leases.disconnect(state.principal.deviceId, connection.connectionId);
		else this.#leases.disconnect("", connection.connectionId);
		state?.commandContexts.clear();
		state?.idempotency.clear();
		this.#states.delete(connection.connectionId);
	}
}

function sanitizeRemoteFrame(frame: ServerFrame): ServerFrame | undefined {
	const seen = new WeakSet<object>();
	// Read commands whose result carries one large bounded payload string. The
	// 64 KiB generic string bound would silently drop their responses (a
	// base64 chunk is ~1.33× the bytes); the protocol's own chunk sizes are
	// the real cap, so these fields get their per-command bound instead.
	const LARGE_CONTENT: Readonly<Record<string, number>> = {
		"files.read": 786_432 * 2, // MAX_FILE_BYTES base64 ceiling, with slack
		"session.image.read": 400_000,
		"artifact.read": 400_000,
		"preview.capture.read": 400_000,
	};
	const largeStringLimit =
		frame.type === "response" && typeof frame.command === "string" ? LARGE_CONTENT[frame.command] : undefined;
	const walk = (value: unknown, depth: number, settingsMap = false, largeContent = false): unknown => {
		if (depth > 12) throw new Error("outbound depth exceeded");
		if (typeof value === "string") {
			if (value.length > (largeContent && largeStringLimit !== undefined ? largeStringLimit : 65_536))
				throw new Error("outbound string exceeded");
			if (largeContent) return value; // bounded payload field: no secret/path redaction of base64
			if (
				/^(?:[A-Za-z]+\s+)?[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value) ||
				/^Bearer\s+/iu.test(value)
			)
				return "[redacted]";
			if (value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/u.test(value))
				return "[relative-path-redacted]";
			return value;
		}
		if (value === null || typeof value !== "object") return value;
		if (seen.has(value)) throw new Error("outbound cycle");
		seen.add(value);
			if (Array.isArray(value)) {
			if (value.length > MAX_ARRAY_ITEMS) throw new Error("outbound array exceeded");
			const result = value.map(item => walk(item, depth + 1, false, false));
			seen.delete(value);
			return result;
		}
		const result: Record<string, unknown> = {};
		const entries = Object.entries(value);
		if (entries.length > MAX_MAP_KEYS) throw new Error("outbound object exceeded");
		for (const [childKey, child] of entries) {
			const childIsSettingsMap =
				frame.type === "response" && frame.command === "settings.read" && depth === 1 && childKey === "settings";
			if (
				(frame.type === "welcome" && depth === 0 && childKey === "authentication") ||
				(frame.type === "response" && depth === 0 && childKey === "command")
			) {
				result[childKey] = child;
			} else if (!settingsMap && (childKey === "deviceToken" || isSecretLikeKey(childKey))) {
				result[childKey] = "[redacted]";
			} else
				result[childKey] = walk(
					child,
					depth + 1,
					childIsSettingsMap,
					largeStringLimit !== undefined && (childKey === "content" || childKey === "data"),
				);
		}
		seen.delete(value);
		return result;
	};
	try {
		const output = walk(frame, 0);
		return output && typeof output === "object" && !Array.isArray(output) ? (output as ServerFrame) : undefined;
	} catch {
		return undefined;
	}
}

export type { Lease, RemotePeerIdentity };
