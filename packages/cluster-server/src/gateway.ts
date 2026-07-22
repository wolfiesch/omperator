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

const GATEWAY_CAPABILITIES = [
	"sessions.read", "sessions.prompt", "sessions.control", "sessions.manage", "agents.control",
	"bash.run", "files.read", "files.write", "files.list", "files.diff",
	"preview.read", "preview.control", "preview.input", "term.open", "term.input", "term.resize", CI_TRIGGER_CAPABILITY,
] as const;
const GATEWAY_FEATURES = [
	"resume", "session.state", "session.delta", "session.observer", "controller.lease", "prompt.lease", "prompt.images",
	"transcript.images", "transcript.search", "transcript.page", "agent.lifecycle", "agent.progress", "agent.event",
	"agent.transcript", "terminal.io", "files.list", "files.diff", "preview.control", CLUSTER_OPERATOR_FEATURE,
] as const;

export interface GatewayClient {
	send(frame: ServerFrame): void;
	close(code?: number, reason?: string): void;
}
export interface GatewayMutationBackend {
	createWorkspace(commandId: string, args: ClusterWorkspaceCreateArguments, principal: string): Promise<{ id: string; revision: string }>;
	createSession(commandId: string, args: ClusterSessionCreateArguments, principal: string): Promise<{ sessionId: string; revision: string }>;
	deleteSession(commandId: string, sessionId: string, principal: string): Promise<{ deleted: true }>;
}
export interface ClusterGatewayOptions {
	readonly projection: ClusterInfrastructureProjection;
	readonly connector: PodHostConnector;
	readonly mutations: GatewayMutationBackend;
	readonly ciProvider?: CiProvider;
	readonly appserverVersion?: string;
	readonly appserverBuild?: string;
}
export interface GatewayConnection {
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
interface RoutedPodConnection { readonly route: PodHostRoute; readonly pending: Promise<PodHostConnection>; }

function validPrincipal(value: string): boolean {
	return value.length > 0 && new TextEncoder().encode(value).byteLength <= 256 && !/\p{Cc}/u.test(value) && value === value.trim();
}
export class ClusterGateway {
	readonly #projection: ClusterInfrastructureProjection;
	readonly #connector: PodHostConnector;
	readonly #mutations: GatewayMutationBackend;
	readonly #ci?: CiProvider;
	readonly #idempotency = new IdempotencyStore({ maxCompletedEntries: 1_024, completedTtlMs: 5 * 60_000 });
	readonly #connections = new Set<GatewayConnection>();
	readonly #version: string;
	readonly #build: string;
	#draining = false;

	constructor(options: ClusterGatewayOptions) {
		this.#projection = options.projection;
		this.#connector = options.connector;
		this.#mutations = options.mutations;
		this.#ci = options.ciProvider;
		this.#version = options.appserverVersion ?? "0.1.31";
		this.#build = options.appserverBuild ?? "cluster";
	}
	get connectionCount(): number { return this.#connections.size; }
	get draining(): boolean { return this.#draining; }
	beginDrain(): void {
		this.#draining = true;
		for (const connection of this.#connections) connection.drain();
	}
	connect(client: GatewayClient, principal: string): GatewayConnection {
		if (!validPrincipal(principal)) {
			client.close(1008, "authenticated gateway identity required");
			return { receive: async () => undefined, close: () => undefined, drain: () => undefined };
		}
		if (this.#draining) {
			client.close(1012, "cluster server draining");
			return { receive: async () => undefined, close: () => undefined, drain: () => undefined };
		}
		let helloReceived = false;
		let operatorEnabled = false;
		let grantedCapabilities = new Set<string>();
		let grantedFeatures = new Set<string>();
		let unsubscribeWorkspaces: (() => void) | undefined;
		let unsubscribeSessions: (() => void) | undefined;
		const challenges = new Map<string, PendingConfirmation>();
		const upstream = new Map<string, RoutedPodConnection>();
		const previewOwners = new Map<string, string>();
		let closed = false;
		const sendSessions = (): void => {
			const sessions = this.#projection.sessionRefs(principal);
			client.send({
				v: "omp-app/1", type: "sessions", hostId: this.#projection.hostId,
				cursor: this.#projection.sessionCursor, sessions,
				totalCount: sessions.length, truncated: false,
			});
			for (const [session, cached] of upstream) {
				const current = this.#projection.sessionRoute(session, principal);
				if (current?.url === cached.route.url && current.upstreamSessionId === cached.route.upstreamSessionId) continue;
				upstream.delete(session);
				void cached.pending.then(connection => connection.close(1001, "session route changed"), () => undefined);
			}
		};
		const close = (): void => {
			if (closed) return;
			closed = true;
			unsubscribeWorkspaces?.();
			unsubscribeSessions?.();
			challenges.clear();
			for (const cached of upstream.values()) void cached.pending.then(value => value.close(1001, "gateway client closed"), () => undefined);
			upstream.clear();
			this.#connections.delete(connection);
		};
		const idempotent = async (command: CommandFrame, operation: () => Promise<ServerFrame>): Promise<void> => {
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
			if (cached && (cached.route.url !== selected.url || cached.route.upstreamSessionId !== selected.upstreamSessionId)) {
				upstream.delete(clusterSessionId);
				void cached.pending.then(connection => connection.close(1001, "session route changed"), () => undefined);
				cached = undefined;
			}
			if (!cached) {
				let pending: Promise<PodHostConnection>;
				pending = this.#connector.connect(
					selected,
					upstreamFrame => {
						if (upstreamFrame.type === "sessions") return;
						const current = this.#projection.sessionRoute(clusterSessionId, principal);
						if (current?.url !== selected.url || current.upstreamSessionId !== selected.upstreamSessionId) return;
						const previewId = (upstreamFrame as unknown as Record<string, unknown>).previewId;
						if (upstreamFrame.type.startsWith("preview.") && typeof previewId === "string") previewOwners.set(previewId, clusterSessionId);
						client.send(rewriteServerAddress(upstreamFrame, selected, this.#projection.hostId));
					},
					() => { if (upstream.get(clusterSessionId)?.pending === pending) upstream.delete(clusterSessionId); },
				);
				cached = { route: selected, pending };
				upstream.set(clusterSessionId, cached);
				pending.catch(() => { if (upstream.get(clusterSessionId)?.pending === pending) upstream.delete(clusterSessionId); });
			}
			try {
				const socket = await cached.pending;
				const current = this.#projection.sessionRoute(clusterSessionId, principal);
				if (!current
					|| current.clusterSessionId !== selected.clusterSessionId
					|| current.url !== selected.url
					|| current.upstreamSessionId !== selected.upstreamSessionId) {
					if (upstream.get(clusterSessionId)?.pending === cached.pending) upstream.delete(clusterSessionId);
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
		const confirm = async (frame: ConfirmFrame): Promise<boolean> => {
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
			await idempotent(command, async () => {
				const session = command.sessionId!;
				if (!this.#projection.ownsSession(session, principal))
					return this.#projection.sessionExists(session)
						? errorResult(command, "NOT_AUTHORIZED", "session is unavailable for this identity")
						: successResult(command, { deleted: true });
				if (this.#projection.sessionRevision(session, principal) !== command.expectedRevision)
					return errorResult(command, "stale_revision", "session revision changed before deletion");
				return successResult(command, await this.#mutations.deleteSession(command.commandId, session, principal));
			});
			return true;
		};
		const receive = async (input: unknown): Promise<void> => {
			if (closed) return;
			let frame: ClientFrame;
			try { frame = decodeClientFrame(typeof input === "string" || input instanceof Uint8Array ? parseBounded(input) : input); }
			catch { client.close(1002, "invalid omp-app frame"); close(); return; }
			if (frame.type === "hello") {
				if (helloReceived) { client.close(1002, "duplicate hello"); close(); return; }
				helloReceived = true;
				operatorEnabled = frame.requestedFeatures.includes(CLUSTER_OPERATOR_FEATURE);
				const requestedCapabilities = new Set(frame.capabilities?.client ?? []);
				grantedCapabilities = new Set(GATEWAY_CAPABILITIES.filter(capability => requestedCapabilities.has(capability) && (capability !== CI_TRIGGER_CAPABILITY || this.#ci !== undefined)));
				const requestedFeatures = new Set(frame.requestedFeatures);
				grantedFeatures = new Set(GATEWAY_FEATURES.filter(feature => requestedFeatures.has(feature) && (feature !== CLUSTER_OPERATOR_FEATURE || operatorEnabled)));
				client.send({
					v: "omp-app/1", type: "welcome", selectedProtocol: "omp-app/1", hostId: this.#projection.hostId,
					ompVersion: "17.0.5", ompBuild: "8476f4451ed95c5d5401785d279a93d3c659fac4",
					appserverVersion: this.#version, appserverBuild: this.#build, epoch: this.#projection.epoch,
					grantedCapabilities: [...grantedCapabilities], grantedFeatures: [...grantedFeatures],
					negotiatedLimits: { maxPayloadLength: 1_048_576, maxWorkspaces: 256, maxSessions: 1_000, workspaceReplayFrames: 512 },
					authentication: "paired",
					resumed: frame.savedCursors.some(saved => saved.hostId === this.#projection.hostId && saved.cursor.epoch === this.#projection.epoch),
				});
				if (!operatorEnabled || !grantedCapabilities.has("sessions.read")) return;
				sendSessions();
				unsubscribeWorkspaces = this.#projection.subscribe(value => client.send(value), this.#projection.workspaceCursor, principal);
				unsubscribeSessions = this.#projection.subscribeSessions(sendSessions);
				return;
			}
			if (!helloReceived) { client.close(1002, "hello required"); close(); return; }
			if (frame.type === "ping") { client.send({ v: "omp-app/1", type: "pong", nonce: frame.nonce, timestamp: frame.timestamp }); return; }
			if (frame.type === "confirm" && await confirm(frame)) return;
			if (frame.type !== "command") {
				if (!operatorEnabled || !("hostId" in frame) || frame.hostId !== this.#projection.hostId) return;
				if (frame.type === "terminal.input" && (!grantedFeatures.has("terminal.io") || !grantedCapabilities.has("term.input"))) return;
				if (frame.type === "terminal.resize" && (!grantedFeatures.has("terminal.io") || !grantedCapabilities.has("term.resize"))) return;
				if (frame.type === "terminal.close" && (!grantedFeatures.has("terminal.io") || !grantedCapabilities.has("term.open"))) return;
				if (frame.type !== "confirm" && !frame.type.startsWith("terminal.")) return;
				await route(frame);
				return;
			}
			if (!operatorEnabled) { client.send(errorResult(frame, "UNSUPPORTED_FEATURE", "cluster.operator was not negotiated")); return; }
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
				await idempotent(frame, async () => {
					const args = frame.args as unknown as ClusterWorkspaceCreateArguments;
					const created = await this.#mutations.createWorkspace(frame.commandId, args, principal);
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
				await idempotent(frame, async () => {
					const created = await this.#mutations.createSession(frame.commandId, args, principal);
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
					client.send(this.#projection.sessionExists(frame.sessionId)
						? errorResult(frame, "NOT_AUTHORIZED", "session is unavailable for this identity")
						: successResult(frame, { deleted: true }));
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
				await idempotent(frame, async () => {
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
				if (preview && previewOwners.has(preview) && previewOwners.get(preview) !== frame.sessionId) {
					client.send(errorResult(frame, "NOT_AUTHORIZED", "preview belongs to another session"));
					return;
				}
			}
			await route(frame);
		};
		const connection: GatewayConnection = {
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
