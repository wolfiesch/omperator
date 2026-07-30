import { createHash, randomUUID } from "node:crypto";
import {
	CI_TRIGGER_CAPABILITY,
	CLUSTER_OPERATOR_FEATURE,
	commandId,
	decodeClientFrame,
	parseBounded,
	requiredCapability,
	type CiRunArguments,
	type ConfirmFrame,
	type ClientFrame,
	type ClusterSessionCreateArguments,
	type ClusterWorkspaceCreateArguments,
	type CommandFrame,
	type ResultFrame,
	type ServerFrame,
} from "@t4-code/host-wire";
import type { Revision } from "@t4-code/host-wire";
import { commandFeature, IdempotencyStore, type CommandOutcome } from "@t4-code/host-service";
import type { RuntimeIngressAcquireOutcome, RuntimeIngressLedger } from "@t4-code/portable-control-store";
import { ClusterInfrastructureProjection } from "./kubernetes-projection.ts";
import {
	rewriteClientAddress,
	rewriteServerAddress,
	type PodHostConnection,
	type PodHostConnector,
	type PodHostRoute,
} from "./pod-host-router.ts";
import type { CiProvider } from "./woodpecker.ts";
import { KubernetesApiError } from "./kubernetes-client.ts";
import { requestIdentityOwnsProjectedScope, requestIdentityScopeId, type RequestIdentity } from "./identity.ts";
import { Authorizer, createAuthorizationRequestId, isAuthorized, type AuthorizationAction } from "./authorization.ts";

export const FORWARDED_SESSION_COMMANDS = Object.freeze({
	"session.attach": true,
	"session.prompt": true,
	"session.image.begin": true,
	"session.image.chunk": true,
	"session.image.discard": true,
	"session.image.read": true,
	"session.state.get": true,
	"session.steer": true,
	"session.followUp": true,
	"session.ui.respond": true,
	"session.cancel": true,
	"transcript.page": true,
	"files.read": true,
	"files.list": true,
	"files.search": true,
	"files.diff": true,
	"review.read": true,
	"term.open": true,
	"preview.launch": true,
	"preview.state": true,
	"preview.activate": true,
	"preview.navigate": true,
	"preview.back": true,
	"preview.forward": true,
	"preview.reload": true,
	"preview.close": true,
	"preview.capture": true,
	"preview.capture.read": true,
	"preview.click": true,
	"preview.fill": true,
	"preview.scroll": true,
	"preview.type": true,
	"preview.select": true,
	"preview.press": true,
	"preview.upload": true,
	"preview.policy.check": true,
	"preview.lease.acquire": true,
	"preview.lease.renew": true,
	"preview.lease.release": true,
	"preview.handoff": true,
} as const);
const PLATFORM_COMMANDS = Object.freeze({
	"session.list": true,
	"workspace.list": true,
	"workspace.create": true,
	"session.create": true,
	"session.delete": true,
	"ci.run": true,
} as const);
const GATEWAY_CAPABILITIES = [
	"sessions.read", "sessions.prompt", "sessions.control", "sessions.manage",
	"files.read", "files.list", "files.diff",
	"preview.read", "preview.control", "preview.input", "term.open", "term.input", "term.resize", CI_TRIGGER_CAPABILITY,
] as const;
const GATEWAY_FEATURES = [
	"resume", "session.state", "session.delta", "session.observer", "prompt.images",
	"transcript.images", "transcript.page", "agent.lifecycle", "agent.progress", "agent.event",
	"agent.transcript", "terminal.io", "files.list", "files.search", "files.diff", "preview.control", CLUSTER_OPERATOR_FEATURE,
] as const;

export interface GatewayClient {
	send(frame: ServerFrame): void;
	close(code?: number, reason?: string): void;
}
export interface GatewayMutationBackend {
	createWorkspace(commandId: string, args: ClusterWorkspaceCreateArguments, principal: string, identity: RequestIdentity): Promise<{ id: string; revision: string }>;
	createSession(commandId: string, args: ClusterSessionCreateArguments, principal: string, identity: RequestIdentity): Promise<{ sessionId: string; revision: string }>;
	deleteSession(commandId: string, sessionId: string, principal: string, identity: RequestIdentity): Promise<{ deleted: true }>;
}
export interface ClusterGatewayOptions {
	readonly projection: ClusterInfrastructureProjection;
	readonly connector: PodHostConnector;
	readonly mutations: GatewayMutationBackend;
	readonly ciProvider?: CiProvider;
	readonly appserverVersion?: string;
	readonly appserverBuild?: string;
	readonly authorizer?: Authorizer;
	readonly runtimeIngress: RuntimeIngressLedger;
	readonly onProtocolMismatch?: () => void;
}
export interface GatewayConnection {
	readonly identity: RequestIdentity;
	receive(frame: unknown): Promise<void>;
	close(): void;
	drain(): void;
}

function errorResult(command: CommandFrame, code: string, message: string): ResultFrame {
	return {
		v: "omp-app/1", type: "response", requestId: command.requestId, commandId: command.commandId,
		hostId: command.hostId, ...(command.sessionId ? { sessionId: command.sessionId } : {}), ok: false,
		error: { code, message },
	};
}
function successResult(command: CommandFrame, result: unknown): ResultFrame {
	return {
		v: "omp-app/1", type: "response", requestId: command.requestId, commandId: command.commandId,
		hostId: command.hostId, ...(command.sessionId ? { sessionId: command.sessionId } : {}), ok: true,
		command: command.command, result,
	};
}
function replayForRequest(frame: ServerFrame, command: CommandFrame): ServerFrame {
	return frame.type === "response" ? { ...frame, requestId: command.requestId, commandId: command.commandId } : frame;
}

interface PendingConfirmation { readonly command: CommandFrame; readonly expiresAt: number; }
interface RoutedPodConnection {
	readonly route: PodHostRoute;
	readonly pending: Promise<PodHostConnection>;
	readonly ingressLeaseId: string;
	readonly fenceTimer: ReturnType<typeof setInterval>;
	readonly expiryTimer: ReturnType<typeof setTimeout>;
}
interface PreviewOwner { readonly clusterSessionId: string; readonly routeGeneration: string; }
const INGRESS_LEASE_TTL_SECONDS = 4;
const INGRESS_RELEASE_ATTEMPTS = 3;

function samePodRoute(left: PodHostRoute | undefined, right: PodHostRoute): boolean {
	return left?.routeGeneration === right.routeGeneration
		&& left.upstreamSessionId === right.upstreamSessionId
		&& left.url === right.url;
}

function validPrincipal(value: string): boolean {
	return value.length > 0 && new TextEncoder().encode(value).byteLength <= 256 && !/\p{Cc}/u.test(value) && value === value.trim();
}
export function gatewayCommandAction(command: string): AuthorizationAction | undefined {
	if (command === "session.list") return "runtime.read";
	if (command === "workspace.list") return "workspace.read";
	if (command === "workspace.create") return "workspace.create";
	if (command === "session.create") return "runtime.create";
	if (command === "session.delete") return "runtime.delete";
	if (command === "preview.state" || command === "preview.capture" || command === "preview.capture.read") return "browser.read";
	if (command === "preview.click" || command === "preview.fill" || command === "preview.scroll" || command === "preview.type" || command === "preview.select" || command === "preview.press" || command === "preview.upload") return "browser.input";
	if (command.startsWith("preview.")) return "browser.control";
	if (Object.hasOwn(FORWARDED_SESSION_COMMANDS, command) || command === "ci.run") return "runtime.connect.omp-app";
	return undefined;
}

const CAPABILITY_ACTIONS = Object.freeze({
	"sessions.read": ["runtime.read"],
	"sessions.prompt": ["runtime.connect.omp-app"],
	"sessions.control": ["runtime.connect.omp-app"],
	"sessions.manage": ["runtime.create", "runtime.delete"],
	"files.read": ["runtime.read"],
	"files.list": ["runtime.read"],
	"files.diff": ["runtime.read"],
	"preview.read": ["browser.read"],
	"preview.control": ["browser.control"],
	"preview.input": ["browser.input"],
	"term.open": ["runtime.connect.omp-app"],
	"term.input": ["runtime.connect.omp-app"],
	"term.resize": ["runtime.connect.omp-app"],
	[CI_TRIGGER_CAPABILITY]: ["runtime.connect.omp-app"],
} as const satisfies Readonly<Record<string, readonly AuthorizationAction[]>>);

export class ClusterGateway {
	readonly #projection: ClusterInfrastructureProjection;
	readonly #connector: PodHostConnector;
	readonly #mutations: GatewayMutationBackend;
	readonly #ci?: CiProvider;
	readonly #idempotency = new IdempotencyStore({ maxCompletedEntries: 1_024, completedTtlMs: 5 * 60_000 });
	readonly #connections = new Set<GatewayConnection>();
	readonly #routedUpstreams = new Set<RoutedPodConnection>();
	readonly #version: string;
	readonly #build: string;
	readonly #authorizer?: Authorizer;
	readonly #runtimeIngress: RuntimeIngressLedger;
	readonly #gatewayReplicaEpoch = randomUUID();
	readonly #onProtocolMismatch?: () => void;
	#draining = false;

	constructor(options: ClusterGatewayOptions) {
		this.#projection = options.projection;
		this.#connector = options.connector;
		this.#mutations = options.mutations;
		this.#ci = options.ciProvider;
		this.#version = options.appserverVersion ?? "0.2.1";
		this.#build = options.appserverBuild ?? "cluster";
		this.#authorizer = options.authorizer;
		this.#runtimeIngress = options.runtimeIngress;
		this.#onProtocolMismatch = options.onProtocolMismatch;
	}
	get connectionCount(): number { return this.#connections.size; }
	get draining(): boolean { return this.#draining; }
	runtimeActivity(clusterSessionId: string, routeGeneration: string): Readonly<{ gatewayUpstreams: number }> {
		let gatewayUpstreams = 0;
		for (const upstream of this.#routedUpstreams)
			if (upstream.route.clusterSessionId === clusterSessionId && upstream.route.routeGeneration === routeGeneration)
				gatewayUpstreams += 1;
		return { gatewayUpstreams };
	}

	beginDrain(): void {
		this.#draining = true;
		for (const connection of this.#connections) connection.drain();
	}
	connect(client: GatewayClient, identity: RequestIdentity, preauthorizedRequestId?: string): GatewayConnection {
		const principal = identity?.principalId;
		if (!validPrincipal(principal)) {
			client.close(1008, "authenticated gateway identity required");
			return { identity, receive: async () => undefined, close: () => undefined, drain: () => undefined };
		}
		const scopeId = requestIdentityScopeId(identity);
		const authorize = (action: AuthorizationAction, resourceId?: string, requestId = createAuthorizationRequestId()): boolean => this.#authorizer
			? this.#authorizer.decide({ identity, scopeId, action, gateway: "omp-app", requestId, ...(resourceId ? { resourceId } : {}) }).allowed
			: isAuthorized(identity, scopeId, action);
		if (preauthorizedRequestId === undefined && !authorize("runtime.connect.omp-app")) {
			client.close(1008, "gateway scope unavailable");
			return { identity, receive: async () => undefined, close: () => undefined, drain: () => undefined };
		}
		if (this.#draining) {
			client.close(1012, "cluster server draining");
			return { identity, receive: async () => undefined, close: () => undefined, drain: () => undefined };
		}
		let helloReceived = false;
		let operatorEnabled = false;
		let grantedCapabilities = new Set<string>();
		let grantedFeatures = new Set<string>();
		let previewAvailableAtWelcome: boolean | undefined;
		let previewRenegotiationRequested = false;
		let unsubscribeWorkspaces: (() => void) | undefined;
		let unsubscribeSessions: (() => void) | undefined;
		const challenges = new Map<string, PendingConfirmation>();
		const upstream = new Map<string, RoutedPodConnection>();
		const previewOwners = new Map<string, PreviewOwner>();
		const releaseIngress = (routed: RoutedPodConnection): void => {
			const release = async (): Promise<void> => {
				for (let attempt = 0; attempt < INGRESS_RELEASE_ATTEMPTS; attempt++) {
					try {
						await this.#runtimeIngress.releaseRuntimeIngress({
							runtimeId: routed.route.clusterSessionId,
							generation: routed.route.runtimeGeneration,
							gatewayReplicaEpoch: this.#gatewayReplicaEpoch,
							leaseId: routed.ingressLeaseId,
						});
						return;
					} catch {
						// The bounded lease remains crash-recoverable if every release attempt fails.
					}
				}
			};
			void release();
		};
		const removeUpstream = (clusterSessionId: string, expected?: RoutedPodConnection): RoutedPodConnection | undefined => {
			const current = upstream.get(clusterSessionId);
			if (!current || (expected && current !== expected)) return undefined;
			clearInterval(current.fenceTimer);
			clearTimeout(current.expiryTimer);
			upstream.delete(clusterSessionId);
			this.#routedUpstreams.delete(current);
			releaseIngress(current);
			return current;
		};

		const clearPreviewOwners = (route: PodHostRoute): void => {
			for (const [previewId, owner] of previewOwners)
				if (owner.clusterSessionId === route.clusterSessionId && owner.routeGeneration === route.routeGeneration)
					previewOwners.delete(previewId);
		};
		let closed = false;
		const previewAvailable = (): boolean => this.#projection.sessionRefs(principal).some(session =>
			this.#projection.sessionGuiState(String(session.sessionId), principal) === "Ready"
			&& this.#projection.sessionRoute(String(session.sessionId), principal) !== undefined
		);
		const sendSessions = (): void => {
			const sessions = this.#projection.sessionRefs(principal);
			client.send({
				v: "omp-app/1", type: "sessions", hostId: this.#projection.hostId,
				cursor: this.#projection.sessionCursor, sessions,
				totalCount: sessions.length, truncated: false,
			});
			for (const [session, cached] of upstream) {
				const current = this.#projection.sessionRoute(session, principal);
				if (samePodRoute(current, cached.route)) continue;
				removeUpstream(session, cached);
				clearPreviewOwners(cached.route);
				void cached.pending.then(connection => connection.close(1001, "session route changed"), () => undefined);
			}
		};
		const close = (): void => {
			if (closed) return;
			closed = true;
			unsubscribeWorkspaces?.();
			unsubscribeSessions?.();
			challenges.clear();
			for (const cached of upstream.values()) {
				this.#routedUpstreams.delete(cached);
				releaseIngress(cached);
				void cached.pending.then(value => value.close(1001, "gateway client closed"), () => undefined);
			}
			upstream.clear();
			this.#connections.delete(connection);
		};
		const idempotent = async (command: CommandFrame, action: AuthorizationAction, requestId: string, operation: () => Promise<ServerFrame>): Promise<void> => {
			const scopedId = commandId(createHash("sha256").update(principal).update("\u0000").update(command.commandId).digest("base64url"));
			const state = this.#idempotency.begin(scopedId, command);
			if (state.kind === "conflict") { client.send(errorResult(command, "idempotency_conflict", "command id was reused with another payload")); return; }
			if (state.kind === "replay" || state.kind === "pending") {
				const outcome = state.kind === "replay" ? state.outcome : await state.outcome;
				client.send(replayForRequest(outcome.frame, command));
				return;
			}
			let output: ServerFrame;
			try { output = await operation(); }
			catch (error) {
				this.#authorizer?.error({ identity, scopeId, action, gateway: "omp-app", requestId, ...(command.sessionId ? { resourceId: command.sessionId } : {}) });
				output = error instanceof KubernetesApiError && error.status === 422
					? errorResult(command, "INVALID_FRAME", "cluster request did not satisfy the Kubernetes API contract")
					: errorResult(command, "UPSTREAM_UNAVAILABLE", "cluster operation failed");
			}
			const outcome: CommandOutcome = { frame: output };
			this.#idempotency.complete(scopedId, command, outcome);
			client.send(output);
		};
		const route = async (frame: ClientFrame): Promise<void> => {
			const clusterSessionId = "sessionId" in frame && typeof frame.sessionId === "string" ? frame.sessionId : undefined;
			if (!clusterSessionId) { if (frame.type === "command") client.send(errorResult(frame, "INVALID_FRAME", "session route is required")); return; }
			const selected = this.#projection.sessionRoute(clusterSessionId, principal);
			if (!selected) { if (frame.type === "command") client.send(errorResult(frame, "NOT_AUTHORIZED", "session is unavailable for this identity")); return; }
			let cached = upstream.get(clusterSessionId);
			if (cached && !samePodRoute(cached.route, selected)) {
				removeUpstream(clusterSessionId, cached);
				clearPreviewOwners(cached.route);
				void cached.pending.then(connection => connection.close(1001, "session route changed"), () => undefined);
				cached = undefined;
			}
			if (!cached) {
				let lease: RuntimeIngressAcquireOutcome;
				try {
					lease = await this.#runtimeIngress.acquireRuntimeIngress({
						runtimeId: selected.clusterSessionId,
						generation: selected.runtimeGeneration,
						gatewayReplicaEpoch: this.#gatewayReplicaEpoch,
						ttlSeconds: INGRESS_LEASE_TTL_SECONDS,
					});
				} catch {
					if (frame.type === "command") client.send(errorResult(frame, "UPSTREAM_UNAVAILABLE", "runtime ingress authority is unavailable"));
					return;
				}
				if (lease.outcome === "fenced") {
					if (frame.type === "command") client.send(errorResult(frame, "UPSTREAM_UNAVAILABLE", "runtime is draining"));
					return;
				}
				const existing = upstream.get(clusterSessionId);
				if (existing && samePodRoute(existing.route, selected)) {
					await Promise.resolve(this.#runtimeIngress.releaseRuntimeIngress({
						runtimeId: selected.clusterSessionId,
						generation: selected.runtimeGeneration,
						gatewayReplicaEpoch: this.#gatewayReplicaEpoch,
						leaseId: lease.leaseId,
					})).catch(() => undefined);
					cached = existing;
				} else {
					let pending: Promise<PodHostConnection>;
					pending = this.#connector.connect(
						selected,
						upstreamFrame => {
							if (upstreamFrame.type === "sessions") return;
							if (upstream.get(clusterSessionId)?.pending !== pending) return;
							const current = this.#projection.sessionRoute(clusterSessionId, principal);
							if (!samePodRoute(current, selected)) return;
							const previewId = (upstreamFrame as unknown as Record<string, unknown>).previewId;
							if (upstreamFrame.type.startsWith("preview.") && typeof previewId === "string")
								previewOwners.set(previewId, { clusterSessionId, routeGeneration: selected.routeGeneration });
							client.send(rewriteServerAddress(upstreamFrame, selected, this.#projection.hostId));
						},
						() => {
							if (upstream.get(clusterSessionId)?.pending !== pending) return;
							removeUpstream(clusterSessionId);
							clearPreviewOwners(selected);
						},
					);
					let leaseExpiresAt = Date.parse(lease.expiresAt);
					let renewalAttempt = 0;
					let expiryTimer!: ReturnType<typeof setTimeout>;
					const expireRoute = (): void => {
						const current = upstream.get(clusterSessionId);
						if (!current || current.pending !== pending) return;
						const remaining = leaseExpiresAt - Date.now();
						if (remaining > 0) {
							expiryTimer = setTimeout(expireRoute, remaining);
							expiryTimer.unref?.();
							return;
						}
						removeUpstream(clusterSessionId, current);
						clearPreviewOwners(selected);
						void pending.then(connection => connection.close(1012, "runtime ingress lease expired"), () => undefined);
					};
					const scheduleExpiry = (): void => {
						clearTimeout(expiryTimer);
						expiryTimer = setTimeout(expireRoute, Math.max(0, leaseExpiresAt - Date.now()));
						expiryTimer.unref?.();
					};
					scheduleExpiry();
					const fenceTimer = setInterval(() => {
						if (Date.now() >= leaseExpiresAt) {
							expireRoute();
							return;
						}
						const renew = Date.now() >= leaseExpiresAt - INGRESS_LEASE_TTL_SECONDS * 500;
						const attempt = ++renewalAttempt;
						const operation = renew
							? Promise.resolve(this.#runtimeIngress.renewRuntimeIngress({
								runtimeId: selected.clusterSessionId,
								generation: selected.runtimeGeneration,
								gatewayReplicaEpoch: this.#gatewayReplicaEpoch,
								leaseId: lease.leaseId,
								ttlSeconds: INGRESS_LEASE_TTL_SECONDS,
							}))
							: Promise.resolve(this.#runtimeIngress.runtimeIngressState({
								runtimeId: selected.clusterSessionId,
								generation: selected.runtimeGeneration,
							}));
						void operation.then(result => {
							const current = upstream.get(clusterSessionId);
							if (!current || current.pending !== pending || attempt !== renewalAttempt) return;
							if ("expiresAt" in result) {
								if (Date.now() >= leaseExpiresAt) {
									expireRoute();
									return;
								}
								const acknowledgedExpiry = Date.parse(result.expiresAt);
								if (Number.isFinite(acknowledgedExpiry) && acknowledgedExpiry > leaseExpiresAt) {
									leaseExpiresAt = acknowledgedExpiry;
									scheduleExpiry();
								}
								return;
							}
							if ("open" in result && result.open) return;
							removeUpstream(clusterSessionId, current);
							clearPreviewOwners(selected);
							void pending.then(connection => connection.close(1012, "runtime draining"), () => undefined);
						}, () => undefined);
					}, 100);
					fenceTimer.unref?.();
					cached = { route: selected, pending, ingressLeaseId: lease.leaseId, fenceTimer, expiryTimer };
					upstream.set(clusterSessionId, cached);
					this.#routedUpstreams.add(cached);
					pending.catch(() => {
						if (upstream.get(clusterSessionId)?.pending !== pending) return;
						removeUpstream(clusterSessionId);
						clearPreviewOwners(selected);
					});
				}
			}
			try {
				const socket = await cached.pending;
				const current = this.#projection.sessionRoute(clusterSessionId, principal);
				if (!samePodRoute(current, selected)) {
					if (upstream.get(clusterSessionId)?.pending === cached.pending) removeUpstream(clusterSessionId, cached);
					socket.close(1001, "session route changed");
					if (frame.type === "command") {
						client.send(current
							? errorResult(frame, "UPSTREAM_UNAVAILABLE", "session pod route changed while connecting")
							: errorResult(frame, "NOT_AUTHORIZED", "session is unavailable for this identity"));
					}
					return;
				}
				socket.send(rewriteClientAddress(frame, selected, socket.hostId ?? "upstream"));
			} catch {
				if (frame.type === "command") client.send(errorResult(frame, "UPSTREAM_UNAVAILABLE", "session pod host connection failed"));
			}
		};
		const confirm = async (frame: ConfirmFrame, requestId: string): Promise<boolean> => {
			if (!authorize("destructive.confirm", frame.sessionId, requestId)) return true;
			const pending = challenges.get(String(frame.confirmationId));
			if (!pending) return false;
			const command = { ...pending.command, requestId: frame.requestId } as CommandFrame;
			if (pending.expiresAt < Date.now() || pending.command.commandId !== frame.commandId || pending.command.hostId !== frame.hostId || pending.command.sessionId !== frame.sessionId) {
				challenges.delete(String(frame.confirmationId));
				client.send(errorResult(command, "confirmation_invalid", "confirmation is invalid or expired"));
				return true;
			}
			challenges.delete(String(frame.confirmationId));
			if (frame.decision === "deny") {
				client.send(errorResult(command, "confirmation_denied", "command was denied"));
				return true;
			}
			if (!authorize("runtime.delete", command.sessionId, requestId)) {
				client.send(errorResult(command, "NOT_AUTHORIZED", "session is unavailable for this identity"));
				return true;
			}
			await idempotent(command, "runtime.delete", requestId, async () => {
				const session = command.sessionId!;
				if (!this.#projection.ownsSession(session, principal))
					return successResult(command, { deleted: true });
				if (this.#projection.sessionRevision(session, principal) !== command.expectedRevision)
					return errorResult(command, "stale_revision", "session revision changed before deletion");
				return successResult(command, await this.#mutations.deleteSession(command.commandId, session, principal, identity));

			});
			return true;
		};
		const receive = async (input: unknown): Promise<void> => {
			if (closed) return;
			let frame: ClientFrame;
			try { frame = decodeClientFrame(typeof input === "string" || input instanceof Uint8Array ? parseBounded(input) : input); }
			catch { this.#onProtocolMismatch?.(); client.close(1002, "invalid omp-app frame"); close(); return; }
			const requestId = createAuthorizationRequestId();
			if (!authorize("runtime.connect.omp-app", undefined, requestId) || !requestIdentityOwnsProjectedScope(identity, scopeId)) {
				client.close(1008, "gateway scope unavailable");
				close();
				return;
			}
			if (frame.type === "hello") {
				if (helloReceived) { client.close(1002, "duplicate hello"); close(); return; }
				helloReceived = true;
				operatorEnabled = frame.requestedFeatures.includes(CLUSTER_OPERATOR_FEATURE);
				previewAvailableAtWelcome = previewAvailable();
				previewRenegotiationRequested = frame.requestedFeatures.includes("preview.control")
					|| (frame.capabilities?.client ?? []).some(capability => capability.startsWith("preview."));
				const requestedCapabilities = new Set(frame.capabilities?.client ?? []);
				grantedCapabilities = new Set(GATEWAY_CAPABILITIES.filter(capability => {
					if (!requestedCapabilities.has(capability) || capability === CI_TRIGGER_CAPABILITY && this.#ci === undefined) return false;
					if (capability.startsWith("preview.") && !previewAvailableAtWelcome) return false;
					return (CAPABILITY_ACTIONS[capability] ?? []).every(action => authorize(action, undefined, requestId));
				}));
				const requestedFeatures = new Set(frame.requestedFeatures);
				grantedFeatures = new Set(GATEWAY_FEATURES.filter(feature =>
					requestedFeatures.has(feature)
					&& (feature !== CLUSTER_OPERATOR_FEATURE || operatorEnabled)
					&& (feature !== "preview.control" || previewAvailableAtWelcome && authorize("browser.control", undefined, requestId))
				));
				client.send({
					v: "omp-app/1", type: "welcome", selectedProtocol: "omp-app/1", hostId: this.#projection.hostId,
					ompVersion: "17.1.2", ompBuild: "b86f6116e6223ebb2d747748dc1dc14ddcb35428",
					appserverVersion: this.#version, appserverBuild: this.#build, epoch: this.#projection.epoch,
					grantedCapabilities: [...grantedCapabilities], grantedFeatures: [...grantedFeatures],
					negotiatedLimits: { maxPayloadLength: 1_048_576, maxWorkspaces: 256, maxSessions: 1_000, workspaceReplayFrames: 512 },
					authentication: "paired",
					resumed: frame.savedCursors.some(saved => saved.hostId === this.#projection.hostId && saved.cursor.epoch === this.#projection.epoch),
				});
				const sessionInventoryEnabled = operatorEnabled && grantedCapabilities.has("sessions.read");
				if (sessionInventoryEnabled) {
					sendSessions();
					unsubscribeWorkspaces = this.#projection.subscribe(value => client.send(value), this.#projection.workspaceCursor, principal);
				}
				if (previewRenegotiationRequested || sessionInventoryEnabled) {
					unsubscribeSessions = this.#projection.subscribeSessions(() => {
						if (previewRenegotiationRequested && previewAvailable() !== previewAvailableAtWelcome) {
							client.send({ v: "omp-app/1", type: "bye", code: "server_restart", reason: "browser availability changed", retryable: true });
							client.close(1012, "browser availability changed");
							close();
							return;
						}
						if (sessionInventoryEnabled) sendSessions();
					});
				}
				return;
			}
			if (!helloReceived) { client.close(1002, "hello required"); close(); return; }
			if (frame.type === "ping") { client.send({ v: "omp-app/1", type: "pong", nonce: frame.nonce, timestamp: frame.timestamp }); return; }
			if (frame.type === "confirm" && await confirm(frame, requestId)) return;
			if (frame.type !== "command") {
				if (!operatorEnabled || !("hostId" in frame) || frame.hostId !== this.#projection.hostId) return;
				if (frame.type === "terminal.input" && (!grantedFeatures.has("terminal.io") || !grantedCapabilities.has("term.input"))) return;
				if (frame.type === "terminal.resize" && (!grantedFeatures.has("terminal.io") || !grantedCapabilities.has("term.resize"))) return;
				if (frame.type === "terminal.close" && (!grantedFeatures.has("terminal.io") || !grantedCapabilities.has("term.open"))) return;
				if (frame.type !== "confirm" && !frame.type.startsWith("terminal.")) return;
				if (!authorize("runtime.connect.omp-app", "sessionId" in frame ? frame.sessionId : undefined, requestId)) return;
				await route(frame);
				return;
			}
			if (!operatorEnabled) { client.send(errorResult(frame, "UNSUPPORTED_FEATURE", "cluster.operator was not negotiated")); return; }
			if (!Object.hasOwn(PLATFORM_COMMANDS, frame.command) && !Object.hasOwn(FORWARDED_SESSION_COMMANDS, frame.command)) {
				client.send(errorResult(frame, "UNSUPPORTED_FEATURE", "command is not supported by the cluster gateway"));
				return;
			}
			const policyAction = gatewayCommandAction(frame.command);
			if (!policyAction || !authorize(policyAction, frame.sessionId, requestId)) {
				client.send(errorResult(frame, "NOT_AUTHORIZED", "command is unavailable for this identity"));
				return;
			}
			if (frame.hostId !== this.#projection.hostId) { client.send(errorResult(frame, "NOT_FOUND", "cluster host was not found")); return; }
			const capability = requiredCapability(frame.command);
			if (!capability || !grantedCapabilities.has(capability)) { client.send(errorResult(frame, "NOT_AUTHORIZED", "command capability was not granted")); return; }
			if (frame.command === "session.list") {
				const sessions = this.#projection.sessionRefs(principal);
				client.send(successResult(frame, { cursor: this.#projection.sessionCursor, sessions, totalCount: sessions.length, truncated: false }));
				return;
			}
			if (frame.command === "workspace.list") { client.send(successResult(frame, this.#projection.workspaceList(principal))); return; }
			if (frame.command === "workspace.create") {
				const args = frame.args as unknown as ClusterWorkspaceCreateArguments;
				await idempotent(frame, "workspace.create", requestId, async () => {
					const created = await this.#mutations.createWorkspace(frame.commandId, args, principal, identity);
					return successResult(frame, { workspace: {
						id: created.id, displayName: args.displayName, phase: "Pending", retentionPolicy: args.retentionPolicy,
						capacity: args.capacity,
						accessMode: "ReadWriteMany", revision: created.revision,
					} });
				});
				return;
			}
			if (frame.command === "session.create") {
				const args = frame.args as unknown as ClusterSessionCreateArguments;
				if (!this.#projection.ownsWorkspace(args.workspaceId, principal)) { client.send(errorResult(frame, "NOT_AUTHORIZED", "workspace is unavailable for this identity")); return; }
				await idempotent(frame, "runtime.create", requestId, async () => {
					const created = await this.#mutations.createSession(frame.commandId, args, principal, identity);
					const session = await this.#projection.waitForSessionAuthority(created.sessionId);
					if (!this.#projection.ownsSession(created.sessionId, principal))
						return errorResult(frame, "NOT_AUTHORIZED", "session is unavailable for this identity");
					return successResult(frame, { session });
				});
				return;
			}
			if (frame.command === "session.delete") {
				if (!frame.sessionId) { client.send(errorResult(frame, "INVALID_FRAME", "session route is required")); return; }
				if (!this.#projection.ownsSession(frame.sessionId, principal)) {
					client.send(successResult(frame, { deleted: true }));
					return;
				}
				if (this.#projection.sessionRevision(frame.sessionId, principal) !== frame.expectedRevision) { client.send(errorResult(frame, "stale_revision", "session revision changed before confirmation")); return; }
				if (frame.confirmationId !== undefined) { client.send(errorResult(frame, "confirmation_invalid", "command confirmation must use a confirm frame")); return; }
				for (const [id, pending] of challenges) if (pending.expiresAt < Date.now()) challenges.delete(id);
				if (challenges.size >= 5) { client.send(errorResult(frame, "confirmation_unavailable", "confirmation capacity exceeded")); return; }
				const confirmationId = randomUUID();
				const expiresAt = Date.now() + 60_000;
				challenges.set(confirmationId, { command: frame, expiresAt });
				client.send({
					v: "omp-app/1", type: "confirmation", confirmationId: confirmationId as never,
					commandId: frame.commandId, hostId: this.#projection.hostId, sessionId: frame.sessionId,
					commandHash: createHash("sha256").update(JSON.stringify({ ...frame, confirmationId: undefined })).digest("hex"),
					revision: frame.expectedRevision as Revision,
					expiresAt: new Date(expiresAt).toISOString(), summary: "session.delete",
				});
				return;
			}
			if (frame.command === "ci.run") {
				await idempotent(frame, "runtime.connect.omp-app", requestId, async () => {
					if (!frame.sessionId || this.#projection.sessionRevision(frame.sessionId, principal) !== frame.expectedRevision)
						return errorResult(frame, "stale_revision", "session revision changed before CI trigger");
					if (!this.#ci) return errorResult(frame, "UNSUPPORTED_FEATURE", "CI provider is unavailable");
					const args = frame.args as unknown as CiRunArguments;
					const allowed = this.#projection.sessionCiSelection(frame.sessionId, principal);
					if (!allowed || allowed.repositoryId !== args.repositoryId || allowed.ref !== args.ref || allowed.commit !== args.commit)
						return errorResult(frame, "NOT_AUTHORIZED", "CI correlation is not declared by this session");
					return successResult(frame, await this.#ci.run({ commandId: frame.commandId, sessionId: frame.sessionId, repositoryId: args.repositoryId, ref: args.ref, commit: args.commit }));
				});
				return;
			}
			const feature = commandFeature(frame.command);
			if (feature && !grantedFeatures.has(feature)) { client.send(errorResult(frame, "UNSUPPORTED_FEATURE", "command feature was not negotiated")); return; }
			if (frame.command.startsWith("preview.")) {
				if (!frame.sessionId) { client.send(errorResult(frame, "INVALID_FRAME", "session route is required")); return; }
				const guiState = this.#projection.sessionGuiState(frame.sessionId, principal);
				if (guiState === undefined) { client.send(errorResult(frame, "NOT_AUTHORIZED", "session is unavailable for this identity")); return; }
				if (guiState !== "Ready") {
					client.send(errorResult(frame, guiState === "Unavailable" ? "UNSUPPORTED_FEATURE" : "UPSTREAM_UNAVAILABLE", guiState === "Unavailable" ? "GUI is disabled for this session" : "session GUI is not ready"));
					return;
				}
				const preview = typeof frame.args.previewId === "string" ? frame.args.previewId : undefined;
				const previewOwner = preview ? previewOwners.get(preview) : undefined;
				const routeGeneration = this.#projection.sessionRoute(frame.sessionId, principal)?.routeGeneration;
				if (previewOwner && (
					previewOwner.clusterSessionId !== frame.sessionId
					|| previewOwner.routeGeneration !== routeGeneration
				)) {
					client.send(errorResult(frame, "NOT_AUTHORIZED", "preview belongs to another session generation"));
					return;
				}
			}
			await route(frame);
		};
		const connection: GatewayConnection = {
			identity,
			receive,
			close,
			drain: () => {
				if (closed) return;
				client.send({ v: "omp-app/1", type: "bye", code: "server_restart", reason: "cluster server draining", retryable: true });
				client.close(1012, "cluster server draining");
				close();
			},
		};
		this.#connections.add(connection);
		return connection;
	}
}
