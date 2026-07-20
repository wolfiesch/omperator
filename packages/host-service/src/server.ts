import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { chmod, stat as fsStat, lstat, open, readlink, realpath, rename, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
	type AttentionOutcome,
	COMMAND_DESCRIPTORS,
	type CommandFrame,
	type ConfirmationChallenge,
	type ConfirmFrame,
	type DurableEntry,
	decodeClientFrame,
	decodeCommandArguments,
	decodeCursor,
	decodeProviderTransportState,
	decodeSessionPromptArguments,
	decodeSessionStateResult,
	decodeUsageReadResult,
	type EntryId,
	entryId,
	type HelloFrame,
	type HostId,
	IMAGE_UPLOAD_CHUNK_BYTES,
	type ImageId,
	type PendingAttentionItem,
	type PromptImageMimeType,
	type ProviderTransportState,
	parseBounded,
	projectId,
	type ResultFrame,
	requiredCapability,
	type ServerFrame,
	type SessionId,
	type SessionImageReadArguments,
	type SessionRef,
	type SessionStateResult,
	sessionId,
	type TranscriptContextArguments,
	type TranscriptPageArguments,
	type TranscriptSearchArguments,
	type UsageReadResult,
	utf8ByteLength,
} from "@t4-code/host-wire";
import type {
	RpcResponse,
	RpcSessionEntryFrame,
	RpcSubagentMessagesResult,
} from "./omp-rpc-contract.ts";
import { AgentTranscriptProjection } from "./agent-transcript-projection.ts";
import { ArtifactReadError, ArtifactReader } from "./artifact-reader.ts";
import { completeAttachOutput, prepareAttachOutput } from "./attach-output.ts";
import { AttentionOutcomeStore } from "./attention-outcome-store.ts";
import { AppserverCommandHandlers } from "./command-handler.ts";
import {
	artifactDescriptorForRoot,
	fallbackSessionTitle,
	projectMessageText,
	projectNameFromCwd,
	SessionEntryProjector,
	SessionTranscriptObserver,
	type SessionTranscriptPoll,
	stableProjectId,
} from "./discovery.ts";
import { IdempotencyStore, payloadHash } from "./idempotency.ts";
import {
	createEpoch,
	createHostId,
	defaultHostIdPath,
	defaultSocketPath,
	loadPersistentHostId,
	unixSocketActive,
} from "./identity.ts";
import { ImageUploadError, ImageUploadStore } from "./image-upload-store.ts";
import {
	commandFeature,
	DesktopOperationDispatcher,
	type OperationContext,
	operationCapabilities,
	operationFeatures,
} from "./operations/dispatcher.ts";
import {
	ensureSecureSocketDirectory,
	markerIdentity,
	type OwnerPaths,
	type OwnerRecord,
	ownerPaths,
	readPublicTarget,
	readStrictOwner,
	sameIdentity,
	unlinkIfExists,
} from "./ownership.ts";
import { SessionProjection } from "./projection.ts";
import { BunRemoteListener, createListenerPlan, createServeProxyPlan } from "./remote/listener.ts";
import type { RemoteConnection, RemoteListenerConfig } from "./remote/types.ts";
import { BunRpcChildFactory, RpcChildSupervisor } from "./rpc-child.ts";
import type {
	RuntimeAdapterRegistry,
	RuntimePermissionResponse,
	RuntimeSession,
	RuntimeWorkspaceIdentity,
} from "./runtime-adapter.ts";
import { SubagentProjection, subagentIdFromFrame } from "./subagent-projection.ts";
import {
	type AppserverEvent,
	asAppWireEvent,
	safeAttentionDisplay,
	TranscriptEventTranslator,
} from "./transcript-events.ts";
import { TranscriptImageError, TranscriptImageReader } from "./transcript-image-reader.ts";
import { TranscriptPageError } from "./transcript-page-reader.ts";
import { TranscriptSearchError } from "./transcript-search-index.ts";
import type {
	AppserverDrainBusy,
	AppserverDrainResult,
	AppserverHandle,
	AppserverOptions,
	AppserverTestControl,
	AppserverTestControlStatus,
	AppserverTestSeedRequest,
	AppserverTranscriptSearchAuthority,
	AppserverUsageAuthority,
	ChildHandle,
	Clock,
	CommandOutcome,
	ConnectionTransport,
	LockCheckHook,
	RemoteConnectionPolicy,
	RemoteHelloDecision,
	RpcChildFactory,
	SessionAuthority,
	SessionDiscovery,
	SessionLockStatus,
	SessionRecord,
} from "./types.ts";
import { type WorkspaceAuthority, WorkspaceAuthorityError, type WorkspaceRecord } from "./workspace-authority.ts";

const clock: Clock = { now: () => new Date() };
const ARCHIVED_SESSION_COMMANDS = new Set([
	"session.attach",
	"session.archive",
	"session.restore",
	"session.delete",
	"session.image.read",
	"artifact.read",
	"files.read",
	"files.list",
	"files.diff",
	"review.read",
	"transcript.context",
	"transcript.page",
]);
const SESSION_LIFECYCLE_COMMANDS = new Set(["session.close", "session.archive", "session.restore", "session.delete"]);
const IMAGE_UPLOAD_COMMANDS = new Set(["session.image.begin", "session.image.chunk", "session.image.discard"]);
const DIRECT_SESSION_RPC_COMMANDS: ReadonlySet<string> = new Set([
	"session.retry",
	"session.pause",
	"session.resume",
	"session.compact",
	"session.rename",
	"session.model.set",
	"session.thinking.set",
	"session.fast.set",
]);
const SESSION_CANCEL_COMMAND = "session.cancel";
const AGENT_CANCEL_COMMAND = "agent.cancel";
const OBSERVER_READ_COMMANDS = new Set([
	"session.attach",
	"session.image.read",
	"artifact.read",
	"files.read",
	"files.list",
	"files.diff",
	"review.read",
	"preview.state",
	"preview.capture",
	"preview.capture.read",
	"preview.policy.check",
	"transcript.context",
	"transcript.page",
]);
const SUBAGENT_TRANSCRIPT_RPC_BYTES = 384 * 1024;
const REMOTE_OUTBOUND_TRANSFORM_TIMEOUT_MS = 10_000;
const DEFAULT_USAGE_READ_TIMEOUT_MS = 15_000;
const PENDING_PROMPT_TEXT_BYTES = 8 * 1024;
// cleanText removes most controls, but retained newlines, quotes, and
// backslashes can double when JSON encoded. Keep enough room for that escaping
// plus the event envelope under the 64 KiB transient-event budget.
const PENDING_PROMPT_EVENT_TEXT_BYTES = 24 * 1024;
const MAX_PENDING_PROMPTS = 16;
// A session snapshot may carry all 16 reconnect prompts, but the session index
// can contain 1,000 refs. Bound that aggregate independently so a pathological
// all-pending index remains decodable by the 1 MiB / 20k-node app-wire limits.
// The canonical per-session projection stays complete; only the index copy is
// reduced, with an explicit count/truncation marker for clients.
const SESSION_LIST_PENDING_PROMPT_BYTES = 256 * 1024;
const SESSION_LIST_PENDING_PROMPT_ENTRIES = 512;
const SESSION_LIST_ATTENTION_BYTES = 256 * 1024;
const SESSION_LIST_ATTENTION_ENTRIES = 512;
const SESSION_LIST_REFS_BYTES = 768 * 1024;
const SESSION_LIST_REF_NODES = 16_000;
const textEncoder = new TextEncoder();

interface SessionListBudget {
	pendingBytes: number;
	pendingEntries: number;
	attentionBytes: number;
	attentionEntries: number;
}

function encodedJsonBytes(value: unknown): number {
	return textEncoder.encode(JSON.stringify(value)).byteLength;
}

function jsonNodeCount(value: unknown, ceiling: number): number {
	const stack: unknown[] = [value];
	let nodes = 0;
	while (stack.length > 0) {
		const current = stack.pop();
		nodes += 1;
		if (nodes > ceiling) return nodes;
		if (!current || typeof current !== "object") continue;
		if (Array.isArray(current)) stack.push(...current);
		else stack.push(...Object.values(current));
	}
	return nodes;
}

function projectSessionListPendingPrompts(ref: SessionRef, budget: SessionListBudget): SessionRef {
	const currentLiveState = ref.liveState;
	if (!currentLiveState) return ref;
	const rawPending = currentLiveState.pendingPrompts;
	if (!Array.isArray(rawPending) || rawPending.length === 0) {
		if (!Object.hasOwn(currentLiveState, "pendingPrompts")) return ref;
		const liveState = { ...currentLiveState };
		delete liveState.pendingPrompts;
		const next = { ...ref };
		if (Object.keys(liveState).length > 0) next.liveState = liveState;
		else delete next.liveState;
		return next;
	}

	const retained: unknown[] = [];
	for (const pending of rawPending) {
		if (budget.pendingEntries >= SESSION_LIST_PENDING_PROMPT_ENTRIES) break;
		const separatorBytes = retained.length === 0 ? 0 : 1;
		const bytes = encodedJsonBytes(pending) + separatorBytes;
		if (budget.pendingBytes + bytes > SESSION_LIST_PENDING_PROMPT_BYTES) break;
		retained.push(pending);
		budget.pendingBytes += bytes;
		budget.pendingEntries += 1;
	}
	if (retained.length === rawPending.length) return ref;

	const liveState: Record<string, unknown> = {
		...currentLiveState,
		pendingPromptCount: rawPending.length,
		pendingPromptsTruncated: true,
	};
	if (retained.length > 0) liveState.pendingPrompts = retained;
	else delete liveState.pendingPrompts;
	return { ...ref, liveState };
}

function projectSessionListAttention(ref: SessionRef, budget: SessionListBudget): SessionRef {
	const attention = ref.attention;
	if (!attention || attention.pending.length === 0) return ref;
	const retained: PendingAttentionItem[] = [];
	for (const pending of attention.pending) {
		if (budget.attentionEntries >= SESSION_LIST_ATTENTION_ENTRIES) break;
		const separatorBytes = retained.length === 0 ? 0 : 1;
		const bytes = encodedJsonBytes(pending) + separatorBytes;
		if (budget.attentionBytes + bytes > SESSION_LIST_ATTENTION_BYTES) break;
		retained.push(pending);
		budget.attentionBytes += bytes;
		budget.attentionEntries += 1;
	}
	if (retained.length === attention.pending.length) return ref;
	return {
		...ref,
		attention: {
			...attention,
			pending: retained,
			truncated: attention.pendingCount > retained.length,
		},
	};
}

async function boundedRemoteTransform<T>(operation: Promise<T> | T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error("remote outbound transform timed out")),
			REMOTE_OUTBOUND_TRANSFORM_TIMEOUT_MS,
		);
	});
	try {
		return await Promise.race([Promise.resolve(operation), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function raceAbortSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw new Error("operation aborted");
	const gate = Promise.withResolvers<T>();
	const onAbort = (): void => gate.reject(new Error("operation aborted"));
	signal.addEventListener("abort", onAbort, { once: true });
	operation.then(gate.resolve, gate.reject);
	try {
		return await gate.promise;
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function queuedLifecycleWork(liveState: Record<string, unknown> | undefined): boolean {
	if (!liveState) return false;
	if (typeof liveState.queuedMessageCount === "number" && liveState.queuedMessageCount > 0) return true;
	const queued = liveState.queuedMessages;
	if (!queued || typeof queued !== "object" || Array.isArray(queued)) return false;
	return Object.values(queued).some(value => Array.isArray(value) && value.length > 0);
}
function response(
	hostId: HostId,
	command: CommandFrame,
	ok: boolean,
	result?: unknown,
	error?: { code: string; message: string; details?: Record<string, unknown> },
): ResultFrame {
	return {
		v: "omp-app/1",
		type: "response",
		requestId: command.requestId,
		commandId: command.commandId,
		command: command.command,
		hostId,
		sessionId: command.sessionId,
		ok,
		...(ok ? { result } : { error }),
	} as ResultFrame;
}
function argumentError(command: CommandFrame): string | undefined {
	const args = command.args;
	if (!args || typeof args !== "object" || Array.isArray(args)) return "args must be an object";
	const keys = Object.keys(args);
	if (command.command === "session.prompt") {
		try {
			decodeSessionPromptArguments(args);
			return undefined;
		} catch {
			return "prompt arguments are invalid";
		}
	}
	if (command.command === "session.attach") {
		if (keys.length === 0) return undefined;
		if (keys.length === 1 && keys[0] === "cursor") {
			try {
				decodeCursor(args.cursor);
				return undefined;
			} catch {
				return "attach cursor is invalid";
			}
		}
		return "attach accepts only an optional cursor";
	}
	if (command.command === "session.create") {
		if (keys.some(key => !["projectId", "title", "runtimeId", "workspaceInstanceId"].includes(key)))
			return "create arguments are invalid";
		if (typeof args.projectId !== "string" || args.projectId.length === 0 || utf8ByteLength(args.projectId) > 256)
			return "create projectId must be a bounded non-empty UTF-8 string";
		if (
			args.title !== undefined &&
			(typeof args.title !== "string" || args.title.length === 0 || utf8ByteLength(args.title) > 512)
		)
			return "create title must be a bounded non-empty UTF-8 string";
		for (const [key, limit] of [
			["runtimeId", 64],
			["workspaceInstanceId", 128],
		] as const)
			if (
				args[key] !== undefined &&
				(typeof args[key] !== "string" || args[key].length === 0 || utf8ByteLength(args[key]) > limit)
			)
				return `create ${key} must be a bounded non-empty UTF-8 string`;
		if ((args.runtimeId === undefined) !== (args.workspaceInstanceId === undefined))
			return "create runtimeId and workspaceInstanceId must be provided together";
		return undefined;
	}
	// Operation argument shapes are validated by decodeCommand and the typed
	// authority. Host/session list remain explicitly empty for compatibility
	// with their legacy broad argument decoders.
	if (command.command !== "host.list" && command.command !== "session.list") return undefined;
	if (keys.length !== 0) return "command does not accept args";
	return undefined;
}
function safeSessionState(value: unknown): SessionStateResult {
	const raw =
		value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	if (!raw) throw new Error("rpc state is not an object");
	const model =
		raw.model && typeof raw.model === "object" && !Array.isArray(raw.model)
			? (raw.model as Record<string, unknown>)
			: undefined;
	const context =
		raw.contextUsage && typeof raw.contextUsage === "object" && !Array.isArray(raw.contextUsage)
			? (raw.contextUsage as Record<string, unknown>)
			: undefined;
	const queued =
		raw.queuedMessages && typeof raw.queuedMessages === "object" && !Array.isArray(raw.queuedMessages)
			? (raw.queuedMessages as Record<string, unknown>)
			: undefined;
	const state = {
		isStreaming: raw.isStreaming,
		isCompacting: raw.isCompacting,
		isPaused: raw.isPaused === true,
		messageCount: raw.messageCount,
		queuedMessageCount: raw.queuedMessageCount,
		steeringMode: raw.steeringMode,
		followUpMode: raw.followUpMode,
		interruptMode: raw.interruptMode,
		...(model
			? {
					model: {
						id: model.id,
						provider: model.provider,
						...(typeof model.name === "string" ? { displayName: model.name } : {}),
						...(typeof model.selector === "string"
							? { selector: model.selector }
							: typeof raw.modelSelector === "string"
								? { selector: raw.modelSelector }
								: {}),
						...(typeof model.role === "string"
							? { role: model.role }
							: typeof raw.modelRole === "string"
								? { role: raw.modelRole }
								: {}),
					},
				}
			: {}),
		...(raw.thinkingLevel === undefined ? {} : { thinking: raw.thinkingLevel }),
		...(raw.thinkingEffective === undefined ? {} : { thinkingEffective: raw.thinkingEffective }),
		...(raw.thinkingResolved === undefined ? {} : { thinkingResolved: raw.thinkingResolved }),
		...(raw.thinkingLevels === undefined ? {} : { thinkingLevels: raw.thinkingLevels }),
		...(raw.thinkingSupported === undefined ? {} : { thinkingSupported: raw.thinkingSupported }),
		...(raw.thinkingOffFloored === undefined ? {} : { thinkingOffFloored: raw.thinkingOffFloored }),
		...(typeof raw.fast === "boolean" ? { fast: raw.fast } : {}),
		...(raw.fastAvailable === undefined ? {} : { fastAvailable: raw.fastAvailable }),
		...(raw.fastActive === undefined ? {} : { fastActive: raw.fastActive }),
		...(typeof raw.sessionName === "string" ? { sessionName: raw.sessionName } : {}),
		...(context
			? { contextUsage: { used: context.used ?? context.tokens, limit: context.limit ?? context.contextWindow } }
			: {}),
		...(queued ? { queuedMessages: { steering: queued.steering, followUp: queued.followUp } } : {}),
	};
	return decodeSessionStateResult(state);
}
function safeProviderTransport(value: unknown): ProviderTransportState | undefined {
	const raw =
		value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	if (raw?.providerTransport === undefined) return undefined;
	try {
		return decodeProviderTransportState(raw.providerTransport, "rpc.providerTransport");
	} catch {
		// Diagnostics are additive. A malformed or future shape must not block
		// the authoritative state refresh that carries session controls.
		return undefined;
	}
}
function childBoolean(value: unknown, key: string): boolean {
	const record =
		value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	if (!record || typeof record[key] !== "boolean") throw new Error("rpc child result is malformed");
	return record[key] as boolean;
}
function childAgentInvoked(value: unknown): boolean | undefined {
	const record =
		value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	const data =
		record?.data && typeof record.data === "object" && !Array.isArray(record.data)
			? (record.data as Record<string, unknown>)
			: undefined;
	return typeof data?.agentInvoked === "boolean" ? data.agentInvoked : undefined;
}
type AppWs = ConnectionTransport;
type LocalWs = Bun.ServerWebSocket<ServerWebSocketData>;
interface RunIdentity {
	paths: OwnerPaths;
	record: OwnerRecord;
	marker: { device: number; inode: number };
}
interface SessionLifecycleFailure {
	code: string;
	message: string;
	details?: Record<string, unknown>;
}
interface PromptLifecycle {
	requestId: string;
	commandId: string;
	commandHash: string;
	kind: "prompt" | "steer" | "followUp";
	accepted?: true;
	cancelRequested?: true;
	internalId?: string;
	transientEntryId?: string;
}
type PromptDiscardReason = "rejected" | "local-only" | "failed" | "cancelled" | "completed-without-entry";
interface ExternalRuntimeOwner {
	readonly runtimeId: string;
	readonly workspaceInstanceId: string;
	readonly session: RuntimeSession;
}
interface ExternalPermissionRequest {
	readonly resolve: (response: RuntimePermissionResponse) => void;
	readonly allowOptionId?: string;
	readonly rejectOptionId?: string;
}
interface ExternalToolProjection {
	readonly entryId: EntryId;
	readonly callId: string;
	tool: string;
	title: string;
	status?: string;
	settled?: true;
}
interface ExternalTurnProjection {
	readonly assistantEntryId: EntryId;
	text: string;
	reasoning: string;
	readonly tools: Map<string, ExternalToolProjection>;
}
class ExternalRuntimeCommandError extends Error {
	constructor(message = "command is unsupported by the selected runtime") {
		super(message);
		this.name = "ExternalRuntimeCommandError";
	}
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function rpcSubagentMessagesResult(value: unknown): RpcSubagentMessagesResult {
	const result = objectRecord(value);
	if (
		!result ||
		!Number.isSafeInteger(result.fromByte) ||
		!Number.isSafeInteger(result.nextByte) ||
		(result.fromByte as number) < 0 ||
		(result.nextByte as number) < (result.fromByte as number) ||
		!Array.isArray(result.entries) ||
		(result.reset !== undefined && typeof result.reset !== "boolean") ||
		(result.messages !== undefined && !Array.isArray(result.messages)) ||
		(result.sessionFile !== undefined && typeof result.sessionFile !== "string")
	) throw new Error("malformed subagent transcript response");
	return {
		fromByte: result.fromByte as number,
		nextByte: result.nextByte as number,
		entries: result.entries,
		...(result.reset !== undefined && { reset: result.reset as boolean }),
		...(result.messages !== undefined && { messages: result.messages as unknown[] }),
		...(result.sessionFile !== undefined && { sessionFile: result.sessionFile as string }),
	};
}

function promptEntryCorrelationId(entry: RpcSessionEntryFrame["entry"]): string | undefined {
	if (entry.type === "message" && entry.message.role === "user") return entry.message.clientCorrelationId;
	if (entry.type === "custom_message" && entry.attribution === "user") return entry.clientCorrelationId;
	return undefined;
}
function isErrno(error: unknown, code: string): boolean {
	return (error as NodeJS.ErrnoException).code === code;
}
async function pidIsAlive(pid: number): Promise<boolean> {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (isErrno(error, "ESRCH")) return false;
		return true;
	}
}
async function statIdentity(path: string): Promise<{ device: number; inode: number } | undefined> {
	try {
		const info = await lstat(path);
		return { device: Number(info.dev), inode: Number(info.ino) };
	} catch (error) {
		if (isErrno(error, "ENOENT")) return undefined;
		throw error;
	}
}
function sameOwnerRecord(a: OwnerRecord, b: OwnerRecord): boolean {
	return (
		a.version === b.version &&
		a.ownerId === b.ownerId &&
		a.pid === b.pid &&
		a.backingName === b.backingName &&
		a.device === b.device &&
		a.inode === b.inode
	);
}
async function completedOwnerEndpointInactive(
	paths: OwnerPaths,
	record: OwnerRecord,
	markerStat: { dev: number; ino: number },
): Promise<boolean> {
	if (record.device === 0 || record.inode === 0) return false;
	try {
		const publicTarget = await readPublicTarget(paths.publicPath);
		if (publicTarget.target !== paths.backingName) return false;
		const backing = await statIdentity(paths.backingPath);
		if (!backing || !sameIdentity(backing, record) || (await unixSocketActive(paths.backingPath))) return false;

		await Bun.sleep(100);

		const latestOwner = await readStrictOwner(paths.ownerPath);
		if (
			latestOwner.stat.dev !== markerStat.dev ||
			latestOwner.stat.ino !== markerStat.ino ||
			!sameOwnerRecord(latestOwner.record, record)
		)
			return false;
		const latestPublicTarget = await readPublicTarget(paths.publicPath);
		if (
			latestPublicTarget.stat.device !== publicTarget.stat.device ||
			latestPublicTarget.stat.inode !== publicTarget.stat.inode ||
			latestPublicTarget.target !== paths.backingName
		)
			return false;
		const latestBacking = await statIdentity(paths.backingPath);
		return Boolean(
			latestBacking && sameIdentity(latestBacking, record) && !(await unixSocketActive(paths.backingPath)),
		);
	} catch {
		return false;
	}
}
async function publishSymlink(paths: OwnerPaths): Promise<void> {
	await symlink(paths.backingName, paths.publicPath);
	const published = await readPublicTarget(paths.publicPath);
	if (published.target !== paths.backingName)
		throw new Error("appserver public symlink target changed during publish");
}
async function publishOwnerAtomic(
	paths: OwnerPaths,
	record: OwnerRecord,
	claimed: { device: number; inode: number },
): Promise<{ device: number; inode: number }> {
	const temp = join(paths.directory, `.appserver-owner-${record.ownerId}.tmp`);
	const handle = await open(temp, "wx", 0o600);
	try {
		await handle.write(`${JSON.stringify(record)}\n`, 0);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		const current = await statIdentity(paths.ownerPath);
		if (!current || current.device !== claimed.device || current.inode !== claimed.inode)
			throw new Error("appserver owner marker changed during startup");
		await rename(temp, paths.ownerPath);
	} catch (error) {
		await unlinkIfExists(temp);
		throw error;
	}
	const final = await statIdentity(paths.ownerPath);
	if (!final) throw new Error("appserver owner marker disappeared during startup");
	return final;
}
export function appserverSupportedFeatures(
	options: Pick<
		AppserverOptions,
		| "operationsAuthority"
		| "projectRevealer"
		| "projectRootForProject"
		| "discovery"
		| "supportedFeatures"
		| "transcriptImageRoot"
		| "transcriptSearchAuthority"
		| "runtimeAdapters"
		| "workspaceAuthority"
		| "workspaceTargetPathForProject"
	> & { readonly remotePolicy?: AppserverOptions["remotePolicy"] },
	includeRemotePolicy = false,
): string[] {
	const unsupportedAdditiveFeatures = new Set(["host.watch", "session.watch"]);
	const implementedFeatures = new Set<string>([
		"resume",
		"prompt.images",
		"agent.transcript",
		"session.observer",
		"artifacts.read",
	]);
	if (includeRemotePolicy) {
		implementedFeatures.add("controller.lease");
		implementedFeatures.add("prompt.lease");
	}
	const authority = options.operationsAuthority;
	if (options.runtimeAdapters) implementedFeatures.add("runtime.adapters");
	if (options.workspaceAuthority && options.projectRootForProject && options.workspaceTargetPathForProject)
		implementedFeatures.add("workspace.lifecycle");
	if (options.transcriptImageRoot) implementedFeatures.add("transcript.images");
	if (options.discovery?.page) implementedFeatures.add("transcript.page");
	if (options.transcriptSearchAuthority) implementedFeatures.add("transcript.search");
	if (!includeRemotePolicy && options.projectRootForProject && options.projectRevealer)
		implementedFeatures.add("project.reveal");
	if (authority?.catalogGet) implementedFeatures.add("catalog.metadata");
	if (authority?.settingsRead) implementedFeatures.add("settings.metadata");
	if (authority?.termOpen && authority.terminalInput && authority.terminalResize && authority.terminalClose)
		implementedFeatures.add("terminal.io");
	if (authority?.filesList) implementedFeatures.add("files.list");
	if (authority?.filesDiff) implementedFeatures.add("files.diff");
	for (const feature of operationFeatures(authority)) implementedFeatures.add(feature);
	return [...(options.supportedFeatures ?? implementedFeatures)].filter(
		feature => implementedFeatures.has(feature) && !unsupportedAdditiveFeatures.has(feature),
	);
}
export function appserverSupportedCapabilities(
	options: Pick<AppserverOptions, "operationsAuthority" | "supportedCapabilities" | "usageAuthority">,
): string[] {
	const implemented = new Set([
		"sessions.read",
		"sessions.manage",
		"sessions.prompt",
		"sessions.control",
		"agents.control",
		...operationCapabilities(options.operationsAuthority),
	]);
	if (options.usageAuthority?.read) implemented.add("usage.read");
	return [...(options.supportedCapabilities ?? implemented)];
}
export class LocalAppserver implements AppserverHandle {
	hostId: HostId;
	readonly epoch: string;
	readonly socketPath: string;
	#clock: Clock;
	#discovery: SessionDiscovery;
	#authority?: SessionAuthority;
	#operations?: DesktopOperationDispatcher;
	#usageAuthority?: AppserverUsageAuthority;
	#transcriptSearch?: AppserverTranscriptSearchAuthority;
	#transcriptSearchReconcile?: Promise<unknown>;
	#transcriptSearchRerun = false;
	#factory: RpcChildFactory;
	#imageUploads: ImageUploadStore;
	#transcriptImages?: TranscriptImageReader;
	#artifacts = new ArtifactReader();
	#lockCheck: LockCheckHook;
	#ringSize: number;
	#lifecycleQuiesceTimeoutMs: number;
	#usageReadTimeoutMs: number;
	#handlers = new AppserverCommandHandlers();
	#challenges = new Map<string, { command: CommandFrame; ws: AppWs; expiresAt: number; hash: string }>();
	#records = new Map<SessionId, SessionRecord>();
	#createdPending = new Map<SessionId, { record: SessionRecord; refreshesRemaining: number }>();
	#projections = new Map<SessionId, SessionProjection>();
	#supervisors = new Map<SessionId, RpcChildSupervisor>();
	#externalRuntimes = new Map<SessionId, ExternalRuntimeOwner>();
	readonly #openingExternalRuntimes = new Map<string, number>();
	readonly #archivingWorkspaces = new Set<string>();
	#externalPermissions = new Map<SessionId, Map<string, ExternalPermissionRequest>>();
	#externalTurns = new Map<SessionId, ExternalTurnProjection>();
	#promptLifecycles = new Map<SessionId, PromptLifecycle>();
	#messageLifecycles = new Map<SessionId, PromptLifecycle[]>();
	#messageLifecyclesByCommandId = new Map<string, PromptLifecycle>();
	#stateRefreshGenerations = new Map<SessionId, number>();
	#transcripts = new Map<SessionId, TranscriptEventTranslator>();
	#subagents = new Map<SessionId, SubagentProjection>();
	#lockStatus: (session: SessionRecord) => SessionLockStatus | Promise<SessionLockStatus>;
	#observers = new Map<SessionId, SessionTranscriptObserver>();
	#observerTimers = new Map<SessionId, ReturnType<typeof setInterval>>();
	#observerRefreshes = new Map<SessionId, { promise: Promise<void>; rerun: boolean }>();
	#promotionFailures = new Map<SessionId, string>();
	#locklessObservers = new WeakSet<SessionTranscriptObserver>();
	#locklessObserverBaselines = new WeakSet<SessionTranscriptObserver>();
	#sessionRefresh?: Promise<void>;
	#sessionLoads = new Map<SessionId, Promise<void>>();
	#inventoryGeneration = 0;
	#inventoryLoaded = false;
	#discoveryMisses = new Map<SessionId, number>();
	#agentTranscripts = new Map<SessionId, AgentTranscriptProjection>();
	#startPromises = new Map<SessionId, Promise<RpcChildSupervisor>>();
	#lifecycleMutations = new Set<SessionId>();
	#testControlMutations = new Set<Promise<Response>>();
	#inflightSessionOperations = new Map<SessionId, number>();
	#closedSessions = new Set<SessionId>();
	#idempotency: IdempotencyStore;
	#connectionIdempotency = new Map<AppWs, IdempotencyStore>();
	#server?: Bun.Server<ServerWebSocketData>;
	#clients = new Set<AppWs>();
	#draining = false;
	#inflightMessages = 0;
	#inflightLifecycleMutations = 0;
	#hello = new Set<AppWs>();
	#clientCapabilities = new Map<AppWs, Set<string>>();
	#clientFeatures = new Map<AppWs, Set<string>>();
	#attached = new Map<AppWs, Set<SessionId>>();
	#deviceIds = new Map<AppWs, string>();
	#abortControllers = new Map<AppWs, Set<AbortController>>();
	#outboundTails = new Map<AppWs, Promise<void>>();
	#localTransports = new Map<LocalWs, AppWs>();
	#remoteTransports = new Map<string, AppWs>();
	#remoteConnections = new Map<AppWs, RemoteConnection>();
	#remoteDecisions = new Map<AppWs, RemoteHelloDecision>();
	#remoteListener?: BunRemoteListener;
	#remotePolicy?: RemoteConnectionPolicy;
	#admin?: AppserverOptions["admin"];
	#testControl?: AppserverOptions["testControl"];
	#remoteEndpoint?: RemoteListenerConfig;
	#remoteResolver?: AppserverOptions["remoteResolver"];
	#started = false;
	#stopping = false;
	#hostProvided: boolean;
	#hostIdPath?: string;
	#attentionOutcomes?: AttentionOutcomeStore;
	#ownerLock = false;
	#ownerPaths?: OwnerPaths;
	#ownerHandle?: FileHandle;
	#runIdentity?: RunIdentity;
	#partialBacking?: { path: string; identity: { device: number; inode: number } };
	#partialMarker?: { device: number; inode: number };
	#ompVersion: string;
	#ompBuild: string;
	#appserverVersion: string;
	#appserverBuild: string;
	#supportedFeatures: Set<string>;
	#remoteSupportedFeatures: Set<string>;
	#supportedCapabilities: Set<string>;
	#projectRootForProject?: AppserverOptions["projectRootForProject"];
	#projectRevealer?: AppserverOptions["projectRevealer"];
	#runtimeAdapters?: RuntimeAdapterRegistry;
	#workspaceAuthority?: WorkspaceAuthority;
	#workspaceTargetPathForProject?: AppserverOptions["workspaceTargetPathForProject"];
	#onOwnerAcquired?: AppserverOptions["onOwnerAcquired"];
	constructor(options: AppserverOptions = {}) {
		if (options.testControl && (options.remoteEndpoint || options.remoteListener)) {
			throw new Error("appserver test control is local-only");
		}
		if (options.testControl) {
			if (process.env.OMP_APP_TEST_MODE !== "1") {
				throw new Error("appserver test control requires OMP_APP_TEST_MODE=1");
			}
			const tokenBytes = utf8ByteLength(options.testControl.token);
			if (tokenBytes < 32 || tokenBytes > 256) {
				throw new Error("appserver test control token must contain 32 to 256 bytes");
			}
		}
		this.#hostProvided = Boolean(options.hostId);
		this.hostId = options.hostId ?? createHostId();
		this.#hostIdPath = options.hostIdPath;
		if (options.attentionOutcomePath || !options.hostId) {
			const hostIdPath = options.hostIdPath ?? defaultHostIdPath();
			this.#attentionOutcomes = new AttentionOutcomeStore(
				options.attentionOutcomePath ?? join(dirname(hostIdPath), "attention-outcomes.json"),
			);
		}
		this.epoch = createEpoch(options.epoch);
		this.socketPath = options.socketPath ?? defaultSocketPath();
		this.#remotePolicy = options.remotePolicy;
		this.#remoteEndpoint = options.remoteEndpoint;
		this.#remoteResolver = options.remoteResolver;
		this.#admin = options.admin;
		this.#testControl = options.testControl;
		this.#remoteListener = options.remoteListener;
		this.#clock = options.clock ?? clock;
		this.#idempotency = new IdempotencyStore({ now: () => this.#clock.now().getTime() });
		this.#authority = options.sessionAuthority;
		this.#operations = options.operationsAuthority
			? new DesktopOperationDispatcher(options.operationsAuthority, undefined, (frame, owner) => {
					for (const ws of this.#clients)
						if (ws.connectionId === owner.connectionId && ws.deviceId === owner.deviceId)
							void this.#sendFrame(ws, frame as ServerFrame);
				})
			: undefined;
		this.#usageAuthority = options.usageAuthority;
		this.#transcriptSearch = options.transcriptSearchAuthority;
		this.#projectRootForProject = options.projectRootForProject;
		this.#projectRevealer = options.projectRevealer;
		this.#runtimeAdapters = options.runtimeAdapters;
		this.#workspaceAuthority = options.workspaceAuthority;
		this.#workspaceTargetPathForProject = options.workspaceTargetPathForProject;
		this.#onOwnerAcquired = options.onOwnerAcquired;
		this.#discovery = options.discovery ?? options.sessionAuthority ?? { list: async () => [] };
		this.#imageUploads = new ImageUploadStore({ root: `${this.socketPath}.images` });
		this.#transcriptImages = options.transcriptImageRoot
			? new TranscriptImageReader({ root: options.transcriptImageRoot })
			: undefined;
		this.#lockStatus = options.lockStatus ?? (() => "missing");
		this.#factory = options.childFactory ?? new BunRpcChildFactory(options.rpcChildInvocation, this.#imageUploads.root);
		this.#ringSize = options.ringSize ?? 256;
		if (options.lockStatus && !options.lockCheck)
			this.#lockCheck = () => {
				throw new Error("session is locked by another process");
			};
		else this.#lockCheck = options.lockCheck ?? (() => undefined);
		this.#lifecycleQuiesceTimeoutMs = options.lifecycleQuiesceTimeoutMs ?? 2_000;
		this.#usageReadTimeoutMs = options.usageReadTimeoutMs ?? DEFAULT_USAGE_READ_TIMEOUT_MS;
		if (
			!Number.isSafeInteger(this.#lifecycleQuiesceTimeoutMs) ||
			this.#lifecycleQuiesceTimeoutMs <= 0 ||
			this.#lifecycleQuiesceTimeoutMs > 60_000
		)
			throw new Error("lifecycleQuiesceTimeoutMs must be between 1 and 60000");
		if (
			!Number.isSafeInteger(this.#usageReadTimeoutMs) ||
			this.#usageReadTimeoutMs <= 0 ||
			this.#usageReadTimeoutMs > 60_000
		)
			throw new Error("usageReadTimeoutMs must be between 1 and 60000");
		this.#ompVersion = options.ompVersion ?? "local";
		this.#ompBuild = options.ompBuild ?? "local";
		this.#appserverVersion = options.appserverVersion ?? "0.1.0";
		this.#appserverBuild = options.appserverBuild ?? "local";
		this.#supportedFeatures = new Set(appserverSupportedFeatures(options));
		this.#remoteSupportedFeatures = new Set(appserverSupportedFeatures(options, true));
		const requested = appserverSupportedCapabilities(options);
		const implemented = new Set([
			"sessions.read",
			"sessions.manage",
			"sessions.prompt",
			"sessions.control",
			"agents.control",
			...operationCapabilities(options.operationsAuthority),
		]);
		if (options.usageAuthority?.read) implemented.add("usage.read");
		if (requested.some(capability => !implemented.has(capability)))
			throw new Error("unsupported capability has no handler");
		this.#supportedCapabilities = new Set(requested);
		this.#handlers.register("session.create", command => this.handleCreate(command));
		if (this.#runtimeAdapters) this.#handlers.register("runtime.list", command => this.handleRuntimeList(command));
		if (this.#workspaceAuthority) {
			this.#handlers.register("workspace.list", command => this.handleWorkspaceList(command));
			this.#handlers.register("workspace.archive", command => this.handleWorkspaceArchive(command));
			this.#handlers.register("workspace.recover", command => this.handleWorkspaceRecover(command));
			if (this.#workspaceTargetPathForProject && this.#projectRootForProject) {
				this.#handlers.register("workspace.create", command => this.handleWorkspaceCreate(command));
				this.#handlers.register("workspace.import", command => this.handleWorkspaceImport(command));
			}
		}
		if (this.#projectRootForProject && this.#projectRevealer)
			this.#handlers.register("project.reveal", command => this.handleProjectReveal(command));
		this.#handlers.register("session.close", command => this.handleClose(command));
		this.#handlers.register("session.archive", command => this.handleArchive(command));
		this.#handlers.register("session.restore", command => this.handleRestore(command));
		this.#handlers.register("session.delete", command => this.handleDelete(command));
	}
	hasDesktopCatalogCommandHandler(command: string): boolean {
		if (command === "usage.read") return this.#usageAuthority !== undefined;
		if (command === "transcript.page") return this.#discovery.page !== undefined;
		if (command === "transcript.search" || command === "transcript.context")
			return this.#transcriptSearch !== undefined;
		if (this.#operations?.hasCommand(command)) return true;
		return (
			this.#handlers.has(command) ||
			DIRECT_SESSION_RPC_COMMANDS.has(command) ||
			command === SESSION_CANCEL_COMMAND ||
			command === AGENT_CANCEL_COMMAND
		);
	}
	async start(): Promise<void> {
		if (this.#started) return;
		this.#inventoryGeneration += 1;
		this.#inventoryLoaded = false;
		this.#stopping = false;
		this.#draining = false;
		this.#closedSessions.clear();
		if (!this.#hostProvided) this.hostId = await loadPersistentHostId(this.#hostIdPath);
		await this.#attentionOutcomes?.load();
		try {
			await this.#transcriptSearch?.initialize();
			this.#records.clear();
			this.#projections.clear();
		} catch (error) {
			await this.#transcriptSearch?.close();
			throw error;
		}
		await ensureSecureSocketDirectory(this.socketPath);
		const ownerId = randomUUID();
		const paths = ownerPaths(this.socketPath, ownerId);
		const initial: OwnerRecord = {
			version: 2,
			ownerId,
			pid: process.pid,
			backingName: paths.backingName,
			device: 0,
			inode: 0,
		};
		let ownerHandle: FileHandle;
		try {
			ownerHandle = await open(`${this.socketPath}.owner`, "wx", 0o600);
			await ownerHandle.write(`${JSON.stringify(initial)}\n`);
			await ownerHandle.sync();
		} catch (error) {
			if (!isErrno(error, "EEXIST")) throw error;
			const existing = await readStrictOwner(`${this.socketPath}.owner`);
			const existingPaths = ownerPaths(this.socketPath, existing.record.ownerId);
			if (
				(await pidIsAlive(existing.record.pid)) &&
				!(await completedOwnerEndpointInactive(existingPaths, existing.record, existing.stat))
			)
				throw new Error(`appserver socket has another owner: ${this.socketPath}`);
			await this.recoverStale(existingPaths, existing.record, existing.stat);
			ownerHandle = await open(`${this.socketPath}.owner`, "wx", 0o600);
			await ownerHandle.write(`${JSON.stringify(initial)}\n`);
			await ownerHandle.sync();
		}
		this.#ownerHandle = ownerHandle;
		this.#ownerLock = true;
		this.#ownerPaths = paths;
		try {
			await this.#onOwnerAcquired?.();
			await this.#imageUploads.start();
			await this.preparePublic(paths);
			this.#server = Bun.serve<ServerWebSocketData>({
				unix: paths.backingPath,
				fetch: (request, server) => this.fetch(request, server),
				websocket: {
					maxPayloadLength: 1024 * 1024,
					backpressureLimit: 1024 * 1024,
					closeOnBackpressureLimit: true,
					open: ws => {
						if (this.#draining || this.#stopping) {
							ws.close(1012, "appserver maintenance");
							return;
						}
						const transport = this.#createLocalTransport(ws);
						this.#localTransports.set(ws, transport);
						this.#clients.add(transport);
						this.#clientCapabilities.set(transport, new Set());
						this.#clientFeatures.set(transport, new Set());
						this.#attached.set(transport, new Set());
						this.#deviceIds.set(transport, transport.deviceId);
						this.#abortControllers.set(transport, new Set());
						this.#connectionIdempotency.set(transport, new IdempotencyStore());
					},
					message: (ws, message) => {
						const transport = this.#localTransports.get(ws);
						if (transport) void this.message(transport, message);
					},
					close: ws => {
						const transport = this.#localTransports.get(ws);
						if (transport) void this.disconnectClient(transport);
					},
				},
			});
			await chmod(paths.backingPath, 0o600);
			if (this.#stopping) throw new Error("appserver is stopping");
			const backing = await fsStat(paths.backingPath);
			const record: OwnerRecord = {
				version: 2,
				ownerId,
				pid: process.pid,
				backingName: paths.backingName,
				device: Number(backing.dev),
				inode: Number(backing.ino),
			};
			this.#partialBacking = {
				path: paths.backingPath,
				identity: { device: Number(backing.dev), inode: Number(backing.ino) },
			};
			const claimed = await markerIdentity(ownerHandle);
			const finalMarker = await publishOwnerAtomic(paths, record, claimed);
			this.#partialMarker = finalMarker;
			const currentRecord = await readStrictOwner(paths.ownerPath);
			if (currentRecord.record.ownerId !== ownerId || !sameIdentity(currentRecord.record, record))
				throw new Error("appserver owner marker changed during startup");
			await publishSymlink(paths);
			if (this.#stopping) throw new Error("appserver is stopping");
			this.#runIdentity = { paths, record, marker: finalMarker };
			this.#started = true;
			if (this.#remotePolicy && this.#remoteEndpoint) {
				const listener =
					this.#remoteListener ??
					new BunRemoteListener(
						this.#remoteEndpoint.serveProxy === true
							? createServeProxyPlan(this.#remoteEndpoint)
							: createListenerPlan(this.#remoteEndpoint),
						{
							connected: connection => this.#remoteConnected(connection),
							message: (connection, message) => this.#remoteMessage(connection, message),
							disconnected: connection => this.#remoteDisconnected(connection),
						},
						this.#remoteEndpoint,
						this.#remoteResolver,
					);
				this.#remoteListener = listener;
				try {
					listener.start();
				} catch (error) {
					this.#remoteListener = undefined;
					throw error;
				}
			}
		} catch (error) {
			try {
				await this.cleanupPartial();
			} finally {
				await this.#transcriptSearch?.close();
				await this.#imageUploads.stop().catch(() => undefined);
			}
			throw error;
		}
	}
	async stop(): Promise<void> {
		if (
			!this.#started &&
			!this.#server &&
			!this.#ownerLock &&
			this.#startPromises.size === 0 &&
			this.#testControlMutations.size === 0
		)
			return;
		this.#stopping = true;
		this.#inventoryGeneration += 1;
		this.#sessionRefresh = undefined;
		this.#sessionLoads.clear();
		try {
			await this.#remoteListener?.stop();
			this.#remoteListener = undefined;
			await Promise.all(
				[...this.#clients].map(async ws => {
					for (const controller of this.#abortControllers.get(ws) ?? []) controller.abort();
					await this.disconnectClient(ws);
					ws.close(1001, "server stopping");
				}),
			);
			const server = this.#server;
			this.#server = undefined;
			let displaced: string | undefined;
			if (this.#runIdentity) {
				const current = await statIdentity(this.#runIdentity.paths.backingPath);
				if (current && !sameIdentity(current, this.#runIdentity.record)) {
					displaced = join(
						this.#runIdentity.paths.directory,
						`.appserver-displaced-${this.#runIdentity.record.ownerId}-${randomUUID()}`,
					);
					await rename(this.#runIdentity.paths.backingPath, displaced);
				}
			}
			await Promise.allSettled(this.#testControlMutations);
			this.#testControlMutations.clear();
			server?.stop(true);
			if (displaced) {
				try {
					await rename(displaced, this.#runIdentity?.paths.backingPath ?? "");
				} catch (error) {
					process.emitWarning(error instanceof Error ? error.message : String(error));
				}
			}
			for (const timer of this.#observerTimers.values()) clearInterval(timer);
			this.#observerTimers.clear();
			this.#observers.clear();
			this.#observerRefreshes.clear();
			for (const supervisor of this.#supervisors.values()) supervisor.stop();
			this.#supervisors.clear();
			for (const sessionId of this.#externalPermissions.keys()) this.cancelExternalPermissions(sessionId);
			await Promise.allSettled(Array.from(this.#externalRuntimes.values(), owner => owner.session.dispose()));
			this.#externalRuntimes.clear();
			this.#externalTurns.clear();
			this.#promptLifecycles.clear();
			this.#messageLifecycles.clear();
			this.#messageLifecyclesByCommandId.clear();
			this.#stateRefreshGenerations.clear();
			this.#transcripts.clear();
			this.#subagents.clear();
			for (const transcript of this.#agentTranscripts.values()) transcript.dispose();
			this.#agentTranscripts.clear();
			await Promise.allSettled(this.#startPromises.values());
			this.#startPromises.clear();
			await this.#transcriptSearchReconcile?.catch(() => undefined);
			this.#transcriptSearchReconcile = undefined;
			this.#transcriptSearchRerun = false;
			await this.#attentionOutcomes?.flush().catch(() => undefined);
			this.#started = false;
			const identity = this.#runIdentity;
			if (identity) await this.cleanupOwned(identity);
			else await this.cleanupPartial();
			this.#runIdentity = undefined;
			this.#ownerLock = false;
			this.#ownerPaths = undefined;
			await this.#ownerHandle?.close();
			this.#ownerHandle = undefined;
		} finally {
			this.#transcriptImages?.clear();
			await this.#transcriptSearch?.close();
			await this.#imageUploads.stop();
		}
	}
	private async recoverStale(
		paths: OwnerPaths,
		record: OwnerRecord,
		markerStat: { dev: number; ino: number },
	): Promise<void> {
		if (record.backingName !== paths.backingName)
			throw new Error(`appserver socket has another owner: ${this.socketPath}`);
		try {
			const publicStat = await lstat(paths.publicPath);
			if (!publicStat.isSymbolicLink()) throw new Error(`appserver socket has another owner: ${this.socketPath}`);
			const target = await readlink(paths.publicPath);
			if (target !== paths.backingName) throw new Error(`appserver socket has another owner: ${this.socketPath}`);
			const backing = await statIdentity(paths.backingPath);
			if (backing && (!sameIdentity(backing, record) || (await unixSocketActive(paths.backingPath))))
				throw new Error(`appserver socket has another owner: ${this.socketPath}`);
			const latest = await lstat(paths.publicPath);
			const latestTarget = await readlink(paths.publicPath);
			const latestBacking = await statIdentity(paths.backingPath);
			if (
				latest.dev !== publicStat.dev ||
				latest.ino !== publicStat.ino ||
				!latest.isSymbolicLink() ||
				latestTarget !== paths.backingName ||
				(latestBacking && !sameIdentity(latestBacking, record))
			)
				throw new Error(`appserver socket has another owner: ${this.socketPath}`);
			await unlink(paths.publicPath);
		} catch (error) {
			if (!isErrno(error, "ENOENT")) throw error;
		}
		const backing = await statIdentity(paths.backingPath);
		if (backing) {
			if (!sameIdentity(backing, record) || (await unixSocketActive(paths.backingPath)))
				throw new Error(`appserver socket has another owner: ${this.socketPath}`);
			await unlink(paths.backingPath);
		}
		const current = await statIdentity(paths.ownerPath);
		if (!current || current.device !== Number(markerStat.dev) || current.inode !== Number(markerStat.ino))
			throw new Error(`appserver socket has another owner: ${this.socketPath}`);
		await unlink(paths.ownerPath);
	}
	private async preparePublic(paths: OwnerPaths): Promise<void> {
		try {
			const info = await lstat(paths.publicPath);
			throw new Error(
				`${info.isSocket() ? "refusing existing public socket" : "refusing non-socket public path"}: ${paths.publicPath}`,
			);
		} catch (error) {
			if (!isErrno(error, "ENOENT")) throw error;
		}
	}
	private async cleanupPartial(): Promise<void> {
		const paths = this.#ownerPaths;
		const marker = this.#partialMarker ?? (this.#ownerHandle ? await markerIdentity(this.#ownerHandle) : undefined);
		this.#server?.stop(true);
		this.#server = undefined;
		if (paths) {
			const publicInfo = await statIdentity(paths.publicPath);
			if (publicInfo) {
				try {
					const target = await readPublicTarget(paths.publicPath);
					const latest = await lstat(paths.publicPath);
					const latestTarget = await readlink(paths.publicPath);
					const backing = await statIdentity(paths.backingPath);
					if (
						latest.dev === publicInfo.device &&
						latest.ino === publicInfo.inode &&
						latest.isSymbolicLink() &&
						latestTarget === paths.backingName &&
						(!backing || (this.#partialBacking && sameIdentity(backing, this.#partialBacking.identity)))
					)
						await unlink(paths.publicPath);
					else if (target.target !== paths.backingName)
						process.emitWarning(`appserver socket ownership conflict; preserving ${paths.publicPath}`);
				} catch (error) {
					if (!isErrno(error, "ENOENT"))
						process.emitWarning(error instanceof Error ? error.message : String(error));
				}
			}
			const backing = await statIdentity(paths.backingPath);
			if (backing && this.#partialBacking && sameIdentity(backing, this.#partialBacking.identity)) {
				const latestBacking = await statIdentity(paths.backingPath);
				if (latestBacking && sameIdentity(latestBacking, backing)) await unlink(paths.backingPath);
			}
			if (marker) {
				const current = await statIdentity(paths.ownerPath);
				const latest = await statIdentity(paths.ownerPath);
				if (
					current &&
					latest &&
					current.device === marker.device &&
					current.inode === marker.inode &&
					latest.device === current.device &&
					latest.inode === current.inode
				)
					await unlink(paths.ownerPath);
			}
		}
		if (this.#ownerHandle) {
			await this.#ownerHandle.close();
			this.#ownerHandle = undefined;
		}
		this.#ownerLock = false;
		this.#partialBacking = undefined;
		this.#partialMarker = undefined;
	}
	private async cleanupOwned(identity: RunIdentity): Promise<void> {
		const { paths, record, marker } = identity;
		const markerNow = await statIdentity(paths.ownerPath);
		let conflict = !markerNow || markerNow.device !== marker.device || markerNow.inode !== marker.inode;
		try {
			const markerValue = await readStrictOwner(paths.ownerPath);
			if (
				markerValue.record.ownerId !== record.ownerId ||
				markerValue.record.pid !== record.pid ||
				markerValue.record.backingName !== record.backingName ||
				!sameIdentity(markerValue.record, record)
			)
				conflict = true;
		} catch (error) {
			if (!isErrno(error, "ENOENT")) conflict = true;
		}
		let publicStat: { device: number; inode: number } | undefined;
		try {
			publicStat = (await readPublicTarget(paths.publicPath)).stat;
			if ((await readPublicTarget(paths.publicPath)).target !== record.backingName) conflict = true;
		} catch (error) {
			if (!isErrno(error, "ENOENT")) conflict = true;
		}
		const backing = await statIdentity(paths.backingPath);
		if (backing && !sameIdentity(backing, record)) conflict = true;
		if (conflict) {
			process.emitWarning(`appserver socket ownership conflict; preserving ${paths.publicPath}`);
			return;
		}
		if (publicStat) {
			const check = await statIdentity(paths.publicPath);
			if (!check || check.device !== publicStat.device || check.inode !== publicStat.inode) {
				process.emitWarning(`appserver socket ownership conflict; preserving ${paths.publicPath}`);
				return;
			}
			await unlink(paths.publicPath);
		}
		const markerCheck = await statIdentity(paths.ownerPath);
		if (markerCheck && markerCheck.device === marker.device && markerCheck.inode === marker.inode)
			await unlink(paths.ownerPath);
		const backingCheck = await statIdentity(paths.backingPath);
		if (backingCheck && sameIdentity(backingCheck, record)) await unlink(paths.backingPath);
	}
	snapshot(sessionId: SessionId) {
		return this.#projections.get(sessionId)?.value;
	}
	replay(sessionId: SessionId, cursor: { epoch: string; seq: number }): ServerFrame[] {
		return this.#projections.get(sessionId)?.replay(cursor) ?? [];
	}
	childFor(sessionId: SessionId): ChildHandle | undefined {
		return this.#supervisors.get(sessionId)?.child();
	}
	async #command(command: CommandFrame, ws?: AppWs, approved = false): Promise<CommandOutcome> {
		if (command.hostId !== this.hostId)
			return {
				frame: response(this.hostId, command, false, undefined, {
					code: "host_mismatch",
					message: "command targets another host",
				}),
			};
		const capabilities = ws ? this.#clientCapabilities.get(ws) : undefined;
		const descriptor = COMMAND_DESCRIPTORS[command.command];
		if (!descriptor)
			return {
				frame: response(this.hostId, command, false, undefined, {
					code: "unsupported",
					message: "unknown command",
				}),
			};
		const promptHasImages =
			command.command === "session.prompt" &&
			command.args !== null &&
			typeof command.args === "object" &&
			!Array.isArray(command.args) &&
			Object.hasOwn(command.args, "images");
		const requiredFeature = commandFeature(command.command) ?? (promptHasImages ? "prompt.images" : undefined);
		if (requiredFeature && (!ws || !this.#clientFeatures.get(ws)?.has(requiredFeature)))
			return {
				frame: response(this.hostId, command, false, undefined, {
					code: "UNSUPPORTED_FEATURE",
					message: "command requires an unavailable negotiated feature",
					details: { feature: requiredFeature },
				}),
			};
		if (descriptor.confirmation === "challenge" && !approved)
			return {
				frame: response(this.hostId, command, false, undefined, {
					code: "confirmation_invalid",
					message: "command requires a consumed confirmation",
				}),
			};
		const required = requiredCapability(command.command);
		if (capabilities && required && !capabilities.has(required))
			return {
				frame: response(this.hostId, command, false, undefined, {
					code: "capability_denied",
					message: "client capability was not granted",
				}),
			};
		if (command.command === "host.list" || command.command === "session.list") {
			try {
				await this.refreshSessions();
			} catch {
				return {
					frame: response(this.hostId, command, false, undefined, {
						code: "session_inventory_unavailable",
						message: "session history is unavailable",
					}),
				};
			}
		} else if (command.command === "transcript.search") await this.refreshTranscriptSearch();
		else if (command.sessionId) {
			if (!this.#records.has(command.sessionId)) {
				try {
					await this.refreshSessions();
				} catch {
					return {
						frame: response(this.hostId, command, false, undefined, {
							code: "session_inventory_unavailable",
							message: "session history is unavailable",
						}),
					};
				}
			}
			if (command.command !== "transcript.page")
				try {
					await this.loadSession(command.sessionId);
				} catch {
					return {
						frame: response(this.hostId, command, false, undefined, {
							code: "session_load_failed",
							message: "session transcript could not be loaded",
						}),
					};
				}
		}
		const projection = command.sessionId ? this.#projections.get(command.sessionId) : undefined;
		// Attach output is connection-scoped and rebuilt on every delivery. A
		if (this.observerBarrierBlocks(command)) return this.observerBarrierOutcome(command);
		// cached success cannot attach a session that has since been deleted.
		if (command.command === "session.attach" && !projection)
			return {
				frame: response(this.hostId, command, false, undefined, {
					code: "unknown_session",
					message: "session is not indexed",
				}),
			};
		// Read chunks can be hundreds of KiB. They are safe to recompute, so never
		// retain their response bodies in the completed-command cache.
		const bypassOutcomeCache =
			command.command === "session.image.read" ||
			command.command === "transcript.page" ||
			command.command === "transcript.search" ||
			command.command === "transcript.context";
		const acceptedLifecycle = this.#messageLifecyclesByCommandId.get(command.commandId);
		if (acceptedLifecycle?.accepted)
			return acceptedLifecycle.commandHash === payloadHash(command)
				? { frame: response(this.hostId, command, true, { accepted: true }) }
				: {
						frame: response(this.hostId, command, false, undefined, {
							code: "idempotency_conflict",
							message: "commandId was already used with another payload",
						}),
					};
		const idempotency = bypassOutcomeCache
			? undefined
			: ws && IMAGE_UPLOAD_COMMANDS.has(command.command)
				? this.#connectionIdempotency.get(ws)
				: this.#idempotency;
		if (!bypassOutcomeCache && !idempotency)
			return {
				frame: response(this.hostId, command, false, undefined, {
					code: "connection_closed",
					message: "image upload connection is closed",
				}),
			};
		if (idempotency) {
			const check = idempotency.begin(command.commandId, command);
			if (check.kind === "replay")
				return {
					frame: { ...check.outcome.frame, requestId: command.requestId } as ServerFrame,
					unknown: check.outcome.unknown,
				};
			if (check.kind === "pending") {
				const outcome = await check.outcome;
				return {
					frame: { ...outcome.frame, requestId: command.requestId } as ServerFrame,
					unknown: outcome.unknown,
				};
			}
			if (check.kind === "conflict")
				return {
					frame: response(this.hostId, command, false, undefined, {
						code: "idempotency_conflict",
						message: "commandId was already used with another payload",
					}),
				};
		}
		const invalidArgs = argumentError(command);
		if (invalidArgs)
			return this.finish(
				command,
				{
					frame: response(this.hostId, command, false, undefined, { code: "invalid_frame", message: invalidArgs }),
				},
				idempotency,
			);
		const promptArguments =
			command.command === "session.prompt" ? decodeSessionPromptArguments(command.args) : undefined;
		if (descriptor.revision === "required" && command.expectedRevision === undefined)
			return this.finish(
				command,
				{
					frame: response(this.hostId, command, false, undefined, {
						code: "stale_revision",
						message: "expectedRevision is required",
					}),
				},
				idempotency,
			);
		if (descriptor.revision === "none" && command.expectedRevision !== undefined)
			return this.finish(
				command,
				{
					frame: response(this.hostId, command, false, undefined, {
						code: "stale_revision",
						message: "expectedRevision is forbidden",
					}),
				},
				idempotency,
			);
		if (descriptor.scope === "session" && !projection)
			return this.finish(
				command,
				{
					frame: response(this.hostId, command, false, undefined, {
						code: "unknown_session",
						message: "session is not indexed",
					}),
				},
				idempotency,
			);
		if (
			descriptor.revisionOwner === "session" &&
			command.expectedRevision !== undefined &&
			projection &&
			command.expectedRevision !== projection.value.revision
		)
			return this.finish(
				command,
				{
					frame: response(this.hostId, command, false, undefined, {
						code: "stale_revision",
						message: "session revision is stale",
						details: { expectedRevision: command.expectedRevision, actualRevision: projection.value.revision },
					}),
				},
				idempotency,
			);
		if (
			command.sessionId &&
			this.sessionArchived(command.sessionId) &&
			!ARCHIVED_SESSION_COMMANDS.has(command.command)
		)
			return this.finish(
				command,
				{
					frame: response(this.hostId, command, false, undefined, {
						code: "session_archived",
						message: "archived sessions are read-only; restore the session to continue work",
					}),
				},
				idempotency,
			);
		const trackSessionOperation = Boolean(command.sessionId && !SESSION_LIFECYCLE_COMMANDS.has(command.command));
		if (trackSessionOperation && !this.beginSessionOperation(command.sessionId!))
			return this.finish(
				command,
				{
					frame: response(this.hostId, command, false, undefined, {
						code: "session_busy",
						message: "session lifecycle mutation is in progress",
					}),
				},
				idempotency,
			);
		const controller = new AbortController();
		if (ws) this.#abortControllers.get(ws)?.add(controller);
		let outcome: CommandOutcome;
		let messageLifecycle: PromptLifecycle | undefined;
		try {
			// Upload commands are connection-owned. Avoid yielding before their
			// spool operation is queued so disconnect cleanup cannot run first and
			// leave a late upload behind for a dead connection.
			const registered = this.#handlers.has(command.command) ? await this.#handlers.dispatch(command) : undefined;
			if (registered) outcome = registered;
			else if (command.command === "transcript.page") {
				if (!this.#discovery.page)
					outcome = {
						frame: response(this.hostId, command, false, undefined, {
							code: "unsupported",
							message: "transcript paging is unavailable",
						}),
					};
				else {
					const args = decodeCommandArguments(
						command.command,
						command.args,
					) as unknown as TranscriptPageArguments;
					const record = this.#records.get(command.sessionId!);
					if (!record) throw new TranscriptPageError("transcript_page_unavailable");
					const result = await this.#discovery.page(record, args);
					outcome = { frame: response(this.hostId, command, true, result) };
				}
			} else if (command.command === "transcript.search") {
				if (!this.#transcriptSearch)
					outcome = {
						frame: response(this.hostId, command, false, undefined, {
							code: "unsupported",
							message: "transcript search is unavailable",
						}),
					};
				else {
					const args = decodeCommandArguments(
						command.command,
						command.args,
					) as unknown as TranscriptSearchArguments;
					const result = await this.#transcriptSearch.search(args, controller.signal);
					outcome = { frame: response(this.hostId, command, true, result) };
				}
			} else if (command.command === "transcript.context") {
				if (!this.#transcriptSearch)
					outcome = {
						frame: response(this.hostId, command, false, undefined, {
							code: "unsupported",
							message: "transcript context is unavailable",
						}),
					};
				else {
					const args = decodeCommandArguments(
						command.command,
						command.args,
					) as unknown as TranscriptContextArguments;
					const result = await this.#transcriptSearch.context(command.sessionId!, args, controller.signal);
					outcome = { frame: response(this.hostId, command, true, result) };
				}
			} else if (command.command === "host.list" || command.command === "session.list")
				outcome = {
					frame: response(this.hostId, command, true, {
						cursor: { epoch: this.epoch, seq: 0 },
						...this.sessionListResult(),
					}),
				};
			else if (command.command === "usage.read") {
				if (!this.#usageAuthority) {
					outcome = {
						frame: response(this.hostId, command, false, undefined, {
							code: "unsupported",
							message: "usage reading is unavailable",
						}),
					};
				} else {
					const timeoutSignal = AbortSignal.timeout(this.#usageReadTimeoutMs);
					const usageSignal = AbortSignal.any([controller.signal, timeoutSignal]);
					try {
						const result: UsageReadResult = decodeUsageReadResult(
							await raceAbortSignal(this.#usageAuthority.read(usageSignal), usageSignal),
						);
						outcome = { frame: response(this.hostId, command, true, result) };
					} catch {
						const code = controller.signal.aborted
							? "aborted"
							: timeoutSignal.aborted
								? "timeout"
								: "usage_unavailable";
						outcome = {
							frame: response(this.hostId, command, false, undefined, {
								code,
								message: code === "timeout" ? "usage read timed out" : "usage read failed",
							}),
						};
					}
				}
			} else if (command.command === "session.attach") {
				await this.enqueueExternalRefresh(command.sessionId!);
				const cursor = command.args.cursor;
				const attachOutput = prepareAttachOutput(
					projection!,
					cursor === undefined ? undefined : decodeCursor(cursor),
				);
				outcome = {
					frame: response(this.hostId, command, true, { attached: true, cursor: attachOutput.baseline }),
					attachOutput,
				};
			} else if (command.command === "session.image.read") {
				if (!ws || !this.#attached.get(ws)?.has(command.sessionId!))
					throw new TranscriptImageError("session_not_attached", "session must be attached before reading images");
				if (!this.#transcriptImages)
					throw new TranscriptImageError("image_not_found", "transcript image reading is unavailable");
				const args = decodeCommandArguments(command.command, command.args) as unknown as SessionImageReadArguments;
				let metadata = projection!.transcriptImage(args.entryId, args.sha256);
				if (!metadata && this.#clientFeatures.get(ws)?.has("agent.transcript"))
					metadata = this.#agentTranscripts.get(command.sessionId!)?.transcriptImage(args.entryId, args.sha256);
				if (!metadata)
					throw new TranscriptImageError(
						"image_not_found",
						"transcript entry does not contain the requested image",
					);
				const result = await this.#transcriptImages.read(
					metadata.sha256,
					metadata.mimeType,
					args.offset,
					controller.signal,
				);
				outcome = { frame: response(this.hostId, command, true, result) };
			} else if (command.command === "artifact.read") {
				if (!ws || !this.#attached.get(ws)?.has(command.sessionId!))
					throw new ArtifactReadError("session_not_attached", "session must be attached before reading artifacts");
				const args = decodeCommandArguments(command.command, command.args) as {
					artifactId: string;
					offset: number;
				};
				let descriptor = projection!.artifact(args.artifactId);
				if (!descriptor && this.#clientFeatures.get(ws)?.has("agent.transcript"))
					descriptor = this.#agentTranscripts.get(command.sessionId!)?.artifact(args.artifactId);
				if (!descriptor)
					throw new ArtifactReadError("artifact_not_found", "artifact is not projected for this session");
				const record = this.#records.get(command.sessionId!);
				if (!record?.path.endsWith(".jsonl"))
					throw new ArtifactReadError("artifact_not_found", "artifact session is unavailable");
				const result = await this.#artifacts.read(
					record.path.slice(0, -".jsonl".length),
					descriptor,
					args.offset,
					controller.signal,
				);
				outcome = { frame: response(this.hostId, command, true, result) };
			} else if (command.command === "session.image.begin") {
				if (!ws) throw new ImageUploadError("image_invalid", "image upload requires a live connection");
				if (controller.signal.aborted)
					throw new ImageUploadError("connection_closed", "image upload connection is closed");
				const args = decodeCommandArguments(command.command, command.args);
				const begun = await this.#imageUploads.begin({
					connectionId: ws.connectionId,
					sessionId: command.sessionId!,
					mimeType: args.mimeType as PromptImageMimeType,
					size: args.size as number,
					sha256: args.sha256 as string,
				});
				outcome = {
					frame: response(this.hostId, command, true, {
						imageId: begun.imageId,
						chunkBytes: IMAGE_UPLOAD_CHUNK_BYTES,
					}),
				};
			} else if (command.command === "session.image.chunk") {
				if (!ws) throw new ImageUploadError("image_invalid", "image upload requires a live connection");
				if (controller.signal.aborted)
					throw new ImageUploadError("connection_closed", "image upload connection is closed");
				const args = decodeCommandArguments(command.command, command.args);
				const content = args.content as string;
				const data = Buffer.from(content, "base64");
				if (data.toString("base64") !== content)
					throw new ImageUploadError("image_invalid", "image chunk content is not canonical base64");
				const progress = await this.#imageUploads.chunk({
					connectionId: ws.connectionId,
					sessionId: command.sessionId!,
					imageId: args.imageId as ImageId,
					offset: args.offset as number,
					data,
				});
				outcome = { frame: response(this.hostId, command, true, progress) };
			} else if (command.command === "session.image.discard") {
				if (!ws) throw new ImageUploadError("image_invalid", "image upload requires a live connection");
				if (controller.signal.aborted)
					throw new ImageUploadError("connection_closed", "image upload connection is closed");
				const args = decodeCommandArguments(command.command, command.args);
				const discarded = await this.#imageUploads.discard(
					ws.connectionId,
					command.sessionId!,
					args.imageId as ImageId,
				);
				outcome = { frame: response(this.hostId, command, true, { discarded }) };
			} else if (command.command === "session.state.get") {
				const supervisor = await this.ensureSupervisor(command.sessionId!);
				const state = await this.refreshState(
					command.sessionId!,
					supervisor,
					command.requestId,
					false,
					controller.signal,
				);
				outcome = { frame: response(this.hostId, command, true, state) };
			} else if (command.command === "session.steer" || command.command === "session.followUp") {
				const supervisor = await this.ensureSupervisor(command.sessionId!);
				const kind = command.command === "session.steer" ? "steer" : "followUp";
				const lifecycle: PromptLifecycle = {
					requestId: command.requestId,
					commandId: command.commandId,
					commandHash: payloadHash(command),
					kind,
				};
				if (!this.#registerMessageLifecycle(command.sessionId!, lifecycle)) {
					outcome = {
						frame: response(this.hostId, command, false, undefined, {
							code: "message_queue_full",
							message: `at most ${MAX_PENDING_PROMPTS} accepted prompts may be pending`,
						}),
					};
				} else {
					messageLifecycle = lifecycle;
					this.updateStatus(command.sessionId!, "active");
					this.#emitPromptTransient(command.sessionId!, command, lifecycle, command.args.message as string, 0);
					const type = kind === "steer" ? "steer" : "follow_up";
					const result = await supervisor.call(
						{ type, message: command.args.message },
						command.requestId,
						undefined,
						internalId => {
							if (this.#hasMessageLifecycle(command.sessionId!, lifecycle)) lifecycle.internalId = internalId;
						},
					);
					if (!result.success) this.#releaseMessageLifecycle(command.sessionId!, lifecycle, "rejected");
					else lifecycle.accepted = true;
					outcome = {
						frame: response(
							this.hostId,
							command,
							result.success,
							{ accepted: result.success },
							result.success ? undefined : { code: "child_error", message: "session command failed" },
						),
					};
					this.scheduleStateRefresh(command.sessionId!, supervisor, command.requestId);
				}
			} else if (command.command === "session.ui.respond") {
				const externalOutcome = this.respondExternalPermission(command);
				if (externalOutcome) outcome = externalOutcome;
				else {
					if (this.#externalRuntimes.has(command.sessionId!)) throw new Error("UI request is no longer pending");
					const supervisor = await this.ensureSupervisor(command.sessionId!);
					const requestId = command.args.requestId;
					if (typeof requestId !== "string") throw new Error("UI request ID is invalid");
					const transcript = this.#transcripts.get(command.sessionId!);
					if (!transcript) throw new Error("session transcript translator is unavailable");
					const pendingUi = transcript.pendingUiRequest(requestId);
					if (!pendingUi) throw new Error("UI request is no longer pending");
					let payload: { value?: string; confirmed?: boolean; cancelled?: true };
					if (command.args.cancelled === true) payload = { cancelled: true };
					else if (pendingUi.kind === "ask" && typeof command.args.value === "string")
						payload = { value: command.args.value };
					else if (pendingUi.kind === "approval" && typeof command.args.confirmed === "boolean")
						payload = { confirmed: command.args.confirmed };
					else throw new Error("UI response kind does not match the pending request");
					await supervisor.respondUi(requestId, payload);
					const resolved = transcript.resolveUiRequest(requestId);
					if (resolved) {
						this.broadcast(command.sessionId!, projection!.appendEvent(asAppWireEvent(resolved)));
						this.#projectAttentionEvent(command.sessionId!, transcript, resolved);
					}
					outcome = { frame: response(this.hostId, command, true, { accepted: true }) };
				}
			} else if (DIRECT_SESSION_RPC_COMMANDS.has(command.command)) {
				const supervisor = await this.ensureSupervisor(command.sessionId!);
				const type =
					command.command === "session.retry"
						? "retry"
						: command.command === "session.pause"
							? "pause"
							: command.command === "session.resume"
								? "resume"
								: command.command === "session.compact"
									? "compact"
									: command.command === "session.rename"
										? "set_session_name"
										: command.command === "session.model.set"
											? "set_model"
											: command.command === "session.thinking.set"
												? "set_thinking_level"
												: "set_fast";
				const args =
					command.command === "session.compact"
						? { customInstructions: command.args.instructions }
						: command.command === "session.rename"
							? { name: command.args.name }
							: command.command === "session.model.set"
								? {
										selector: command.args.selector,
										role: command.args.role,
										persist: command.args.persistence === "settings",
									}
								: command.command === "session.thinking.set"
									? { level: command.args.level }
									: command.command === "session.fast.set"
										? { enabled: command.args.enabled }
										: {};
				const result = await supervisor.call({ type, ...args }, command.requestId, controller.signal);
				if (!result.success)
					outcome = {
						frame: response(this.hostId, command, false, undefined, {
							code: "child_error",
							message: "session command failed",
						}),
					};
				else {
					const childData = "data" in result ? result.data : undefined;
					const data =
						command.command === "session.retry"
							? { retried: childBoolean(childData, "retried") }
							: command.command === "session.pause"
								? { paused: childBoolean(childData, "paused"), changed: childBoolean(childData, "changed") }
								: command.command === "session.resume"
									? { resumed: childBoolean(childData, "resumed"), paused: childBoolean(childData, "paused") }
									: command.command === "session.compact"
										? { compacted: true }
										: command.command === "session.rename"
											? { renamed: true }
											: { accepted: true };
					if (
						command.command === "session.model.set" ||
						command.command === "session.thinking.set" ||
						command.command === "session.fast.set"
					)
						await this.refreshState(command.sessionId!, supervisor, command.requestId);
					outcome = { frame: response(this.hostId, command, true, data) };
				}
				if (
					command.command !== "session.model.set" &&
					command.command !== "session.thinking.set" &&
					command.command !== "session.fast.set"
				)
					this.scheduleStateRefresh(command.sessionId!, supervisor, command.requestId);
			} else if (command.command === "session.prompt") {
				if (this.#closedSessions.has(command.sessionId!)) throw new Error("session is closed");
				const externalOwner = this.#externalRuntimes.get(command.sessionId!);
				if (externalOwner) outcome = await this.handleExternalPrompt(command, externalOwner, promptArguments!);
				else {
					const supervisor = await this.ensureSupervisor(command.sessionId!);
					if (this.#promptLifecycles.has(command.sessionId!)) {
						outcome = {
							frame: response(this.hostId, command, false, undefined, {
								code: "session_busy",
								message: "another prompt is still running; use steer or follow-up",
							}),
						};
					} else if (this.#pendingMessageCount(command.sessionId!) >= MAX_PENDING_PROMPTS) {
						outcome = {
							frame: response(this.hostId, command, false, undefined, {
								code: "message_queue_full",
								message: `at most ${MAX_PENDING_PROMPTS} accepted prompts may be pending`,
							}),
						};
					} else {
						const lifecycle: PromptLifecycle = {
							requestId: command.requestId,
							commandId: command.commandId,
							commandHash: payloadHash(command),
							kind: "prompt",
						};
						messageLifecycle = lifecycle;
						if (!this.#registerMessageLifecycle(command.sessionId!, lifecycle))
							throw new Error("pending prompt capacity changed");
						this.#promptLifecycles.set(command.sessionId!, lifecycle);
						this.updateStatus(command.sessionId!, "active");
						const managedImages = promptArguments?.images
							? await this.#imageUploads.consume(ws!.connectionId, command.sessionId!, promptArguments.images)
							: undefined;
						this.#emitPromptTransient(
							command.sessionId!,
							command,
							lifecycle,
							promptArguments!.message,
							promptArguments?.images?.length ?? 0,
						);
						let result: RpcResponse;
						try {
							result = await supervisor.prompt(
								command.requestId,
								promptArguments!.message,
								// Registration and transient publication make this accepted work.
								// Client disconnect must not revoke it before the child acknowledges it.
								undefined,
								internalId => {
									if (this.#hasMessageLifecycle(command.sessionId!, lifecycle))
										lifecycle.internalId = internalId;
								},
								managedImages,
							);
						} finally {
							if (managedImages) await this.#imageUploads.release(managedImages);
						}
						if (!result.success || childAgentInvoked(result) === false) {
							const reason = result.success ? "local-only" : "rejected";
							if (this.#releaseMessageLifecycle(command.sessionId!, lifecycle, reason))
								this.#projectTerminalStatus(command.sessionId!, supervisor, `${command.requestId}:terminal`);
						} else lifecycle.accepted = true;
						outcome = {
							frame: response(
								this.hostId,
								command,
								result.success,
								{ accepted: result.success },
								result.success ? undefined : { code: "child_error", message: "session command failed" },
							),
						};
						if (this.#hasMessageLifecycle(command.sessionId!, lifecycle))
							this.scheduleStateRefresh(command.sessionId!, supervisor, command.requestId, true);
					}
				}
			} else if (command.command === AGENT_CANCEL_COMMAND) {
				const supervisor = await this.ensureSupervisor(command.sessionId!);
				// Confirmation makes cancellation accepted work. Once dispatched, a
				// client disconnect must not replace the child's durable result with
				// an aborted command outcome.
				const result = await supervisor.cancelSubagent(command.args.agentId, command.requestId);
				if (!result.success) {
					outcome = {
						frame: response(this.hostId, command, false, undefined, {
							code: "child_error",
							message: "subagent cancellation failed",
						}),
					};
				} else {
					try {
						outcome = {
							frame: response(this.hostId, command, true, {
								cancelled: childBoolean("data" in result ? result.data : undefined, "cancelled"),
							}),
						};
					} catch {
						outcome = {
							frame: response(this.hostId, command, false, undefined, {
								code: "child_error",
								message: "subagent cancellation failed",
							}),
						};
					}
				}
			} else if (command.command === SESSION_CANCEL_COMMAND) {
				const externalOwner = this.#externalRuntimes.get(command.sessionId!);
				if (externalOwner) outcome = await this.handleExternalCancel(command, externalOwner);
				else {
					// Capture the exact root before the first yield. A root which settles
					// while the supervisor starts must not let this unscoped RPC abort a
					// newer prompt that registered in the meantime.
					const cancelledLifecycle = this.#promptLifecycles.get(command.sessionId!);
					const supervisor = await this.ensureSupervisor(command.sessionId!);
					if (this.#promptLifecycles.get(command.sessionId!) !== cancelledLifecycle) {
						outcome = { frame: response(this.hostId, command, true, { cancelled: false }) };
					} else {
						const result = await supervisor.cancel(command.requestId);
						if (result.success) {
							this.#releaseMessageLifecycle(command.sessionId!, cancelledLifecycle, "cancelled");
							this.#projectTerminalStatus(command.sessionId!, supervisor, `${command.requestId}:terminal`);
						}
						outcome = {
							frame: response(
								this.hostId,
								command,
								result.success,
								{ cancelled: result.success },
								result.success ? undefined : { code: "child_error", message: "session command failed" },
							),
						};
					}
				}
			} else if (this.#operations && ws) {
				const context: OperationContext = {
					hostId: this.hostId,
					sessionId: command.sessionId,
					deviceId: ws.deviceId,
					connectionId: ws.connectionId,
					capabilities: (capabilities ?? new Set()) as OperationContext["capabilities"],
					currentRevision: projection?.value.revision,
					expectedRevision: command.expectedRevision,
					abortSignal: controller.signal,
				};
				const result = await this.#operations.dispatch(command, context);
				outcome = { frame: response(this.hostId, command, true, result) };
			} else
				outcome = {
					frame: response(this.hostId, command, false, undefined, {
						code: "unsupported",
						message: "command is unsupported",
					}),
				};
		} catch (error) {
			if (
				messageLifecycle &&
				this.#releaseMessageLifecycle(command.sessionId!, messageLifecycle, "failed") &&
				!this.#closedSessions.has(command.sessionId!)
			)
				this.#projectTerminalStatus(command.sessionId!);
			const imageError =
				error instanceof ImageUploadError || error instanceof TranscriptImageError ? error : undefined;
			const externalRuntimeError = error instanceof ExternalRuntimeCommandError ? error : undefined;
			const transcriptSearchError = error instanceof TranscriptSearchError ? error : undefined;
			const transcriptPageError = error instanceof TranscriptPageError ? error : undefined;
			const operation =
				this.#operations &&
				ws &&
				![
					"session.create",
					"session.close",
					"session.prompt",
					"session.cancel",
					"session.attach",
					"session.list",
					"host.list",
				].includes(command.command);
			const code = transcriptPageError
				? transcriptPageError.code
				: transcriptSearchError
				? transcriptSearchError.code
				: externalRuntimeError
					? "unsupported"
					: imageError
						? imageError.code
						: command.command === "session.ui.respond"
							? "ui_request_invalid"
							: operation &&
									error &&
									typeof error === "object" &&
									"code" in error &&
									typeof error.code === "string"
								? error.code
								: "outcome_unknown";
			outcome = {
				frame: response(this.hostId, command, false, undefined, {
					code,
					message: transcriptPageError
						? transcriptPageError.code === "transcript_cursor_stale"
							? "transcript page cursor is stale"
							: transcriptPageError.code === "transcript_cursor_invalid"
								? "transcript page cursor is invalid"
								: "transcript paging is unavailable"
						: transcriptSearchError
						? transcriptSearchError.code === "transcript_anchor_not_found"
							? "transcript entry no longer exists"
							: transcriptSearchError.code === "transcript_cursor_stale"
								? "transcript search cursor is stale"
								: "transcript search cursor is invalid"
						: (externalRuntimeError?.message ??
							imageError?.message ??
							(operation ? "operation failed" : "command failed")),
				}),
				unknown: !operation && !imageError && !externalRuntimeError && !transcriptSearchError && !transcriptPageError,
			};
		} finally {
			if (ws) this.#abortControllers.get(ws)?.delete(controller);
			if (trackSessionOperation) this.endSessionOperation(command.sessionId!);
		}
		return this.finish(command, outcome, idempotency);
	}
	private async createSession(args: Record<string, unknown>): Promise<Record<string, unknown>> {
		const runtimeId = typeof args.runtimeId === "string" ? args.runtimeId : undefined;
		if (runtimeId) return this.createExternalSession(args, runtimeId, args.workspaceInstanceId as string);
		if (!this.#authority) throw new Error("session creation is unavailable");
		const canonical = await this.resolveProjectRoot(args.projectId);
		const title = typeof args.title === "string" ? args.title : undefined;
		const created = await this.#authority.create(canonical, title);
		const timestamp = this.#clock.now().toISOString();
		const record: SessionRecord = {
			sessionId: created.sessionId,
			path: created.path,
			cwd: created.cwd,
			projectId: stableProjectId(created.cwd),
			projectName: projectNameFromCwd(created.cwd),
			title: created.title ?? "Session",
			updatedAt: timestamp,
			status: "idle",
			entries: created.entries,
		};
		this.#records.set(record.sessionId, record);
		this.#projections.set(record.sessionId, new SessionProjection(this.hostId, record, this.epoch, this.#ringSize));
		this.#createdPending.set(record.sessionId, { record, refreshesRemaining: 1 });
		return { sessionId: record.sessionId };
	}
	private async createExternalSession(
		args: Record<string, unknown>,
		runtimeId: string,
		workspaceInstanceId: string,
	): Promise<Record<string, unknown>> {
		if (!this.#runtimeAdapters || !this.#workspaceAuthority)
			throw new Error("external runtime session creation is unavailable");
		const requestedProject = projectId(args.projectId as string);
		const workspace = this.#workspaceAuthority.get(workspaceInstanceId);
		if (!workspace) throw new Error("workspace is not indexed");
		if (workspace.lifecycle !== "active") throw new Error("workspace is not active");
		if (workspace.repositoryId !== requestedProject)
			throw new Error("workspace does not belong to the requested project");
		if (this.#archivingWorkspaces.has(workspace.instanceId))
			throw new Error("workspace is being archived");
		this.#reserveExternalRuntimeOpening(workspace.instanceId);
		const publicSessionId = sessionId(`session-${randomUUID()}`);
		const runtimeWorkspace: RuntimeWorkspaceIdentity = {
			instanceId: workspace.instanceId,
			cwd: workspace.canonicalPath,
			ownership: workspace.ownership,
			git: { commonDir: workspace.repositoryRoot, head: workspace.expectedHead },
		};
		let runtimeSession: RuntimeSession | undefined;
		try {
			runtimeSession = await this.#runtimeAdapters.openSession(runtimeId, {
				workspace: runtimeWorkspace,
				callbacks: {
					onSessionUpdate: update => this.projectExternalUpdate(publicSessionId, update),
					onPermissionRequest: request => this.requestExternalPermission(publicSessionId, request),
				},
			});
			const timestamp = this.#clock.now().toISOString();
			const record: SessionRecord = {
				sessionId: publicSessionId,
				path: workspace.canonicalPath,
				cwd: workspace.canonicalPath,
				projectId: requestedProject,
				projectName: projectNameFromCwd(workspace.canonicalPath),
				title: typeof args.title === "string" ? args.title : "Session",
				updatedAt: timestamp,
				status: "idle",
				entries: [],
				runtime: { id: runtimeId, workspaceInstanceId: workspace.instanceId },
			};
			this.#records.set(publicSessionId, record);
			this.#projections.set(publicSessionId, new SessionProjection(this.hostId, record, this.epoch, this.#ringSize));
			this.#externalRuntimes.set(publicSessionId, { runtimeId, workspaceInstanceId, session: runtimeSession });
			return { sessionId: publicSessionId };
		} catch (cause) {
			if (runtimeSession) await runtimeSession.dispose().catch(() => undefined);
			this.#records.delete(publicSessionId);
			this.#projections.delete(publicSessionId);
			throw cause;
		} finally {
			this.#releaseExternalRuntimeOpening(workspace.instanceId);
		}
	}

	#reserveExternalRuntimeOpening(workspaceInstanceId: string): void {
		this.#openingExternalRuntimes.set(
			workspaceInstanceId,
			(this.#openingExternalRuntimes.get(workspaceInstanceId) ?? 0) + 1,
		);
	}

	#releaseExternalRuntimeOpening(workspaceInstanceId: string): void {
		const openings = this.#openingExternalRuntimes.get(workspaceInstanceId);
		if (openings === undefined || openings <= 1) this.#openingExternalRuntimes.delete(workspaceInstanceId);
		else this.#openingExternalRuntimes.set(workspaceInstanceId, openings - 1);
	}

	#workspaceHasExternalRuntimeOwner(workspaceInstanceId: string): boolean {
		return (
			this.#openingExternalRuntimes.has(workspaceInstanceId) ||
			[...this.#externalRuntimes.values()].some(owner => owner.workspaceInstanceId === workspaceInstanceId)
		);
	}
	private appendExternalEntry(
		sessionId: SessionId,
		kind: string,
		data: Record<string, unknown>,
		id = entryId(`acp-${randomUUID()}`),
	): string | undefined {
		const projection = this.#projections.get(sessionId);
		if (!projection || this.#closedSessions.has(sessionId)) return undefined;
		const entry: DurableEntry = {
			id,
			parentId: null,
			hostId: this.hostId,
			sessionId,
			kind,
			timestamp: this.#clock.now().toISOString(),
			data,
		};
		const frame = projection.appendEntry(entry);
		if (frame) this.broadcast(sessionId, frame);
		return id;
	}
	private projectExternalUpdate(sessionId: SessionId, value: unknown): void {
		const turn = this.#externalTurns.get(sessionId);
		if (!turn) return;
		const notification = objectRecord(value);
		const update = objectRecord(notification?.update);
		if (!update || typeof update.sessionUpdate !== "string") return;
		const at = this.#clock.now().toISOString();
		if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
			const content = objectRecord(update.content);
			if (content?.type !== "text" || typeof content.text !== "string" || content.text.length === 0) return;
			const reasoning = update.sessionUpdate === "agent_thought_chunk";
			if (reasoning) turn.reasoning = projectMessageText(turn.reasoning + content.text);
			else turn.text = projectMessageText(turn.text + content.text);
			const messageFrame = this.#projections.get(sessionId)?.appendEvent(
				asAppWireEvent({
					type: "message.update",
					entryId: turn.assistantEntryId,
					role: "assistant",
					text: turn.text,
					reasoning: turn.reasoning,
					at,
				}),
			);
			if (messageFrame) this.broadcast(sessionId, messageFrame);
			return;
		}
		if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
			if (typeof update.toolCallId !== "string") return;
			const providerKey = createHash("sha256").update(update.toolCallId).digest("hex");
			let toolState = turn.tools.get(providerKey);
			if (!toolState) {
				const tool = projectMessageText(typeof update.kind === "string" ? update.kind : "other", 64) || "other";
				toolState = {
					entryId: entryId(`acp-${randomUUID()}`),
					callId: `tool-${randomUUID()}`,
					tool,
					title: projectMessageText(typeof update.title === "string" ? update.title : tool, 512) || tool,
				};
				turn.tools.set(providerKey, toolState);
				const startFrame = this.#projections.get(sessionId)?.appendEvent(
					asAppWireEvent({
						type: "tool.start",
						callId: toolState.callId,
						tool: toolState.tool,
						title: toolState.title,
						args: {},
						at,
					}),
				);
				if (startFrame) this.broadcast(sessionId, startFrame);
			}
			if (toolState.settled) return;
			if (typeof update.kind === "string") toolState.tool = projectMessageText(update.kind, 64) || toolState.tool;
			if (typeof update.title === "string")
				toolState.title = projectMessageText(update.title, 512) || toolState.title;
			const status = projectMessageText(update.status, 64);
			if (status) {
				toolState.status = status;
				const terminal = status === "completed" || status === "failed";
				if (terminal) toolState.settled = true;
				const toolFrame = this.#projections.get(sessionId)?.appendEvent(
					asAppWireEvent(
						terminal
							? {
									type: "tool.result",
									callId: toolState.callId,
									ok: status === "completed",
									result: { status },
									at,
								}
							: { type: "tool.progress", callId: toolState.callId, note: status, at },
					),
				);
				if (toolFrame) this.broadcast(sessionId, toolFrame);
			}
		}
	}
	private finalizeExternalTurn(sessionId: SessionId, turn: ExternalTurnProjection): void {
		if (this.#externalTurns.get(sessionId) !== turn) return;
		this.#externalTurns.delete(sessionId);
		if (turn.text || turn.reasoning)
			this.appendExternalEntry(
				sessionId,
				"message",
				{ role: "assistant", text: turn.text, ...(turn.reasoning ? { reasoning: turn.reasoning } : {}) },
				turn.assistantEntryId,
			);
		for (const tool of turn.tools.values())
			this.appendExternalEntry(
				sessionId,
				"tool-use",
				{
					toolCallId: tool.callId,
					tool: tool.tool,
					title: tool.title,
					...(tool.status ? { status: tool.status } : {}),
				},
				tool.entryId,
			);
		const frame = this.#projections
			.get(sessionId)
			?.appendEvent(asAppWireEvent({ type: "turn.end", at: this.#clock.now().toISOString() }));
		if (frame) this.broadcast(sessionId, frame);
	}
	private requestExternalPermission(sessionId: SessionId, value: unknown): Promise<RuntimePermissionResponse> {
		const request = objectRecord(value);
		const toolCall = objectRecord(request?.toolCall);
		const options = Array.isArray(request?.options) ? request.options.map(objectRecord).filter(Boolean) : [];
		const allow =
			options.find(option => option?.kind === "allow_once") ??
			options.find(option => option?.kind === "allow_always");
		const reject =
			options.find(option => option?.kind === "reject_once") ??
			options.find(option => option?.kind === "reject_always");
		const allowOptionId = typeof allow?.optionId === "string" ? allow.optionId : undefined;
		const rejectOptionId = typeof reject?.optionId === "string" ? reject.optionId : undefined;
		if (!allowOptionId && !rejectOptionId) return Promise.resolve({ outcome: "cancelled" });
		const requestId = `acp-permission-${randomUUID()}`;
		const pending = Promise.withResolvers<RuntimePermissionResponse>();
		let requests = this.#externalPermissions.get(sessionId);
		if (!requests) {
			requests = new Map();
			this.#externalPermissions.set(sessionId, requests);
		}
		requests.set(requestId, { resolve: pending.resolve, allowOptionId, rejectOptionId });
		const clean = (input: unknown, fallback: string) =>
			[...(typeof input === "string" ? input : fallback)].map(character => {
				const code = character.codePointAt(0) ?? 0;
				return code <= 0x1f || code === 0x7f ? " " : character;
			}).join("").slice(0, 512);
		const title = clean(toolCall?.title, "Runtime permission required");
		const frame = this.#projections.get(sessionId)?.setPendingAttention({
			kind: "approval",
			id: requestId,
			title,
			summary: title,
			requestedAt: this.#clock.now().toISOString(),
		});
		if (frame) this.broadcast(sessionId, frame);
		return pending.promise.finally(() => {
			const current = this.#externalPermissions.get(sessionId);
			current?.delete(requestId);
			if (current?.size === 0) this.#externalPermissions.delete(sessionId);
			const cleared = this.#projections.get(sessionId)?.removePendingAttention(requestId);
			if (cleared) this.broadcast(sessionId, cleared);
		});
	}
	private cancelExternalPermissions(sessionId: SessionId): void {
		const pending = this.#externalPermissions.get(sessionId);
		this.#externalPermissions.delete(sessionId);
		for (const request of pending?.values() ?? []) request.resolve({ outcome: "cancelled" });
		const cleared = this.#projections.get(sessionId)?.clearPendingAttention();
		if (cleared) this.broadcast(sessionId, cleared);
	}

	private async handleExternalPrompt(
		command: CommandFrame,
		owner: ExternalRuntimeOwner,
		args: { message: string; images?: readonly unknown[] },
	): Promise<CommandOutcome> {
		const sessionId = command.sessionId!;
		if (args.images && args.images.length > 0)
			return {
				frame: response(this.hostId, command, false, undefined, {
					code: "unsupported",
					message: "the selected runtime does not support prompt images",
				}),
			};
		if (this.#promptLifecycles.has(sessionId))
			return {
				frame: response(this.hostId, command, false, undefined, {
					code: "session_busy",
					message: "another prompt is still running",
				}),
			};
		const lifecycle: PromptLifecycle = {
			requestId: command.requestId,
			commandId: command.commandId,
			commandHash: payloadHash(command),
			kind: "prompt",
		};
		if (!this.#registerMessageLifecycle(sessionId, lifecycle))
			return {
				frame: response(this.hostId, command, false, undefined, {
					code: "message_queue_full",
					message: `at most ${MAX_PENDING_PROMPTS} accepted prompts may be pending`,
				}),
			};
		const turn: ExternalTurnProjection = {
			assistantEntryId: entryId(`acp-${randomUUID()}`),
			text: "",
			reasoning: "",
			tools: new Map(),
		};
		this.#promptLifecycles.set(sessionId, lifecycle);
		this.#externalTurns.set(sessionId, turn);
		this.updateStatus(sessionId, "active");
		const turnStart = this.#projections
			.get(sessionId)
			?.appendEvent(asAppWireEvent({ type: "turn.start", at: this.#clock.now().toISOString() }));
		if (turnStart) this.broadcast(sessionId, turnStart);
		this.#emitPromptTransient(sessionId, command, lifecycle, args.message, 0);
		const userEntryId = this.appendExternalEntry(sessionId, "message", {
			role: "user",
			text: projectMessageText(args.message),
		});
		if (userEntryId) this.#settlePromptTransient(sessionId, lifecycle, userEntryId);
		let failed = false;
		try {
			await owner.session.prompt(args.message);
			lifecycle.accepted = true;
			return { frame: response(this.hostId, command, true, { accepted: true }) };
		} catch (cause) {
			failed = true;
			throw cause;
		} finally {
			this.finalizeExternalTurn(sessionId, turn);
			const reason: PromptDiscardReason = failed
				? "failed"
				: lifecycle.cancelRequested
					? "cancelled"
					: "completed-without-entry";
			if (this.#releaseMessageLifecycle(sessionId, lifecycle, reason)) this.#projectTerminalStatus(sessionId);
		}
	}
	private async handleExternalCancel(command: CommandFrame, owner: ExternalRuntimeOwner): Promise<CommandOutcome> {
		const sessionId = command.sessionId!;
		const lifecycle = this.#promptLifecycles.get(sessionId);
		await owner.session.cancel();
		if (this.#promptLifecycles.get(sessionId) === lifecycle && lifecycle) {
			lifecycle.cancelRequested = true;
			this.cancelExternalPermissions(sessionId);
		}
		return { frame: response(this.hostId, command, true, { cancelled: Boolean(lifecycle) }) };
	}
	private respondExternalPermission(command: CommandFrame): CommandOutcome | undefined {
		const sessionId = command.sessionId!;
		const requestId = command.args.requestId;
		if (typeof requestId !== "string") throw new Error("UI request ID is invalid");
		const request = this.#externalPermissions.get(sessionId)?.get(requestId);
		if (!request) return undefined;
		let selected: string | undefined;
		if (command.args.cancelled !== true) {
			if (typeof command.args.confirmed !== "boolean")
				throw new Error("UI response kind does not match the pending request");
			selected = command.args.confirmed ? request.allowOptionId : request.rejectOptionId;
		}
		request.resolve(selected ? { outcome: "selected", optionId: selected } : { outcome: "cancelled" });
		return { frame: response(this.hostId, command, true, { accepted: true }) };
	}

	private async resolveProjectRoot(value: unknown): Promise<string> {
		if (!this.#projectRootForProject) throw new Error("project resolver is unavailable");
		if (typeof value !== "string") throw new Error("projectId is invalid");
		const requestedProject = projectId(value);
		const requestedCwd = await this.#projectRootForProject(requestedProject);
		if (typeof requestedCwd !== "string" || !requestedCwd.startsWith("/"))
			throw new Error("project resolver returned an invalid local root");
		let canonical: string;
		try {
			canonical = await realpath(requestedCwd);
			if (!(await fsStat(canonical)).isDirectory()) throw new Error("not a directory");
		} catch {
			throw new Error("project resolver returned an unavailable local root");
		}
		if (stableProjectId(canonical) !== requestedProject)
			throw new Error("project resolver returned a mismatched local root");
		return canonical;
	}
	private workspaceProjection(record: WorkspaceRecord): Record<string, unknown> {
		return {
			repositoryId: record.repositoryId,
			instanceId: record.instanceId,
			ownership: record.ownership,
			branch: record.branch,
			sourceCommit: record.sourceCommit,
			expectedHead: record.expectedHead,
			lifecycle: record.lifecycle,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			...(record.archivedAt === undefined ? {} : { archivedAt: record.archivedAt }),
		};
	}

	private async handleRuntimeList(command: CommandFrame): Promise<CommandOutcome> {
		const runtimes = await Promise.all(
			this.#runtimeAdapters!.list().map(async manifest => {
				try {
					return { ...manifest, availability: await this.#runtimeAdapters!.availability(manifest.id) };
				} catch {
					return { ...manifest, availability: { state: "unknown" as const } };
				}
			}),
		);
		return { frame: response(this.hostId, command, true, { runtimes }) };
	}
	private async workspaceCommand(
		command: CommandFrame,
		action: () => Promise<Record<string, unknown>> | Record<string, unknown>,
	): Promise<CommandOutcome> {
		try {
			return { frame: response(this.hostId, command, true, await action()) };
		} catch (cause) {
			const code = cause instanceof WorkspaceAuthorityError ? cause.code : "workspace-command-failed";
			const message = cause instanceof WorkspaceAuthorityError ? cause.message : "workspace command failed";
			return { frame: response(this.hostId, command, false, undefined, { code, message }) };
		}
	}
	private handleWorkspaceList(command: CommandFrame): Promise<CommandOutcome> {
		return this.workspaceCommand(command, () => ({
			workspaces: this.#workspaceAuthority!.list().map(record => this.workspaceProjection(record)),
		}));
	}
	private handleWorkspaceCreate(command: CommandFrame): Promise<CommandOutcome> {
		return this.workspaceCommand(command, async () => {
			const repositoryId = projectId(command.args.projectId as string);
			const repositoryPath = await this.resolveProjectRoot(repositoryId);
			const targetPath = await this.#workspaceTargetPathForProject!(repositoryId, command.args.name as string);
			if (!isAbsolute(targetPath))
				throw new WorkspaceAuthorityError("invalid-path", "Workspace target resolver returned a non-absolute path");
			const workspace = await this.#workspaceAuthority!.create({
				repositoryId,
				repositoryPath,
				targetPath,
				branch: command.args.branch as string,
				sourceCommit: command.args.sourceCommit as string,
			});
			return { workspace: this.workspaceProjection(workspace) };
		});
	}
	private handleWorkspaceImport(command: CommandFrame): Promise<CommandOutcome> {
		return this.workspaceCommand(command, async () => {
			const repositoryId = projectId(command.args.projectId as string);
			const repositoryPath = await this.resolveProjectRoot(repositoryId);
			const workspacePath = await this.#workspaceTargetPathForProject!(repositoryId, command.args.name as string);
			if (!isAbsolute(workspacePath))
				throw new WorkspaceAuthorityError("invalid-path", "Workspace target resolver returned a non-absolute path");
			const workspace = await this.#workspaceAuthority!.import({ repositoryId, repositoryPath, workspacePath });
			return { workspace: this.workspaceProjection(workspace) };
		});
	}
	private handleWorkspaceArchive(command: CommandFrame): Promise<CommandOutcome> {
		return this.workspaceCommand(command, async () => {
			const instanceId = command.args.instanceId as string;
			const authority = this.#workspaceAuthority!;
			const workspace = authority.get(instanceId);
			if (!workspace) throw new WorkspaceAuthorityError("worktree-not-found", "Workspace record was not found");
			if (workspace.ownership === "repository-root")
				throw new WorkspaceAuthorityError("repository-root-protected", "Repository root worktrees cannot be archived");
			if (workspace.ownership !== "managed")
				throw new WorkspaceAuthorityError(
					"ownership-protected",
					"Imported and detected worktrees are never deleted by the authority",
				);
			if (this.#archivingWorkspaces.has(instanceId))
				throw new WorkspaceAuthorityError("mutation-in-progress", "Workspace archive is already in progress");
			if (this.#workspaceHasExternalRuntimeOwner(instanceId))
				throw new WorkspaceAuthorityError("mutation-in-progress", "Workspace is owned by a live external runtime");
			this.#archivingWorkspaces.add(instanceId);
			try {
				const sealed = await authority.seal({ instanceId });
				return { workspace: this.workspaceProjection(await authority.archive({ instanceId: sealed.instanceId })) };
			} finally {
				this.#archivingWorkspaces.delete(instanceId);
			}
		});
	}
	private handleWorkspaceRecover(command: CommandFrame): Promise<CommandOutcome> {
		return this.workspaceCommand(command, async () => ({
			workspaces: (await this.#workspaceAuthority!.recover()).map(record => this.workspaceProjection(record)),
		}));
	}
	private async handleProjectReveal(command: CommandFrame): Promise<CommandOutcome> {
		if (!this.#projectRevealer) throw new Error("project reveal is unavailable");
		const root = await this.resolveProjectRoot(command.args.projectId);
		const revealed = await this.#projectRevealer(root);
		return { frame: response(this.hostId, command, true, { revealed }) };
	}
	private async handleCreate(command: CommandFrame): Promise<CommandOutcome> {
		const created = await this.createSession(command.args);
		const projection = this.#projections.get(created.sessionId as SessionId)!;
		await this.broadcastIndex(projection.indexUpsert());
		return {
			frame: response(this.hostId, command, true, {
				session: projection.value.ref,
			}),
		};
	}
	private async handleClose(command: CommandFrame): Promise<CommandOutcome> {
		const sessionId = command.sessionId!;
		if (this.#lifecycleMutations.has(sessionId))
			return this.lifecycleBusyOutcome(command, "session lifecycle mutation is already in progress");
		this.#lifecycleMutations.add(sessionId);
		let supervisor: RpcChildSupervisor | undefined;
		let alreadyExplicitlyClosed = false;
		try {
			const projection = this.#projections.get(sessionId)!;
			alreadyExplicitlyClosed = this.#closedSessions.has(sessionId) && projection.value.ref.status === "closed";
			this.#closedSessions.add(sessionId);
			await this.#imageUploads.cleanupSession(sessionId);
			const pending = this.#startPromises.get(sessionId);
			if (pending) await pending.catch(() => undefined);
			supervisor = this.#supervisors.get(sessionId);
			if (!(await this.quiesceSessionRuntime(sessionId))) {
				if (!alreadyExplicitlyClosed) {
					this.#closedSessions.delete(sessionId);
					if (supervisor) this.markSupervisorCrashed(sessionId, supervisor);
				}
				return this.lifecycleBusyOutcome(command, "session runtime did not stop cleanly");
			}
			this.cleanupObserverState(sessionId);
			this.#releaseAllMessageLifecycles(sessionId, "cancelled");
			this.#stateRefreshGenerations.delete(sessionId);
			this.#transcripts.delete(sessionId);
			this.disposeSubagentState(sessionId);
			if (alreadyExplicitlyClosed)
				return { frame: response(this.hostId, command, true, { closed: true, sessionId }) };
			this.updateStatus(sessionId, "closed");
			this.broadcast(sessionId, projection.appendEvent({ type: "session_closed" }));
			return { frame: response(this.hostId, command, true, { closed: true, sessionId }) };
		} catch (error) {
			if (!alreadyExplicitlyClosed) {
				this.#closedSessions.delete(sessionId);
				if (supervisor) this.markSupervisorCrashed(sessionId, supervisor);
			}
			throw error;
		} finally {
			this.#lifecycleMutations.delete(sessionId);
		}
	}
	private async deletePreflight(
		command: CommandFrame,
		ignoreLifecycleFence = false,
	): Promise<SessionLifecycleFailure | undefined> {
		const sessionId = command.sessionId;
		if (!sessionId) return { code: "unknown_session", message: "session is not indexed" };
		const external = this.#records.get(sessionId)?.runtime !== undefined;
		if (!external && !this.#authority)
			return { code: "unsupported", message: "session lifecycle management is unavailable" };
		const revisionFailure = this.lifecycleRevisionFailure(command);
		if (revisionFailure) return revisionFailure;
		const record = this.#records.get(sessionId);
		if (!record) return { code: "unknown_session", message: "session is not indexed" };
		if (this.sessionLifecycleBusy(sessionId, ignoreLifecycleFence))
			return { code: "session_busy", message: "session has active or pending work" };
		if (!external && !this.#supervisors.has(sessionId)) {
			try {
				await this.#lockCheck(record);
			} catch {
				return { code: "session_locked", message: "session is locked by another process" };
			}
		}
		return undefined;
	}
	private sessionArchived(sessionId: SessionId): boolean {
		return Boolean(
			this.#records.get(sessionId)?.archivedAt || this.#projections.get(sessionId)?.value.ref.archivedAt,
		);
	}
	private observerBarrierBlocks(command: CommandFrame): boolean {
		if (!command.sessionId) return false;
		if (this.#externalRuntimes.has(command.sessionId)) return false;
		if (command.command !== "session.state.get" && OBSERVER_READ_COMMANDS.has(command.command)) return false;
		return (
			this.#observers.has(command.sessionId) ||
			this.#projections.get(command.sessionId)?.value.ref.liveState?.sessionControl !== undefined
		);
	}
	private observerBarrierOutcome(command: CommandFrame): CommandOutcome {
		return {
			frame: response(this.hostId, command, false, undefined, {
				code: "session_locked",
				message: "session is locked by another process",
			}),
		};
	}
	private beginSessionOperation(sessionId: SessionId): boolean {
		if (this.#draining || this.#stopping || this.#lifecycleMutations.has(sessionId)) return false;
		this.#inflightSessionOperations.set(sessionId, (this.#inflightSessionOperations.get(sessionId) ?? 0) + 1);
		return true;
	}
	private endSessionOperation(sessionId: SessionId): void {
		const count = this.#inflightSessionOperations.get(sessionId) ?? 0;
		if (count <= 1) this.#inflightSessionOperations.delete(sessionId);
		else this.#inflightSessionOperations.set(sessionId, count - 1);
	}
	private sessionLifecycleBusy(sessionId: SessionId, ignoreLifecycleFence = false): boolean {
		const ref = this.#projections.get(sessionId)?.value.ref;
		const liveState = ref?.liveState;
		return (
			(!ignoreLifecycleFence && this.#lifecycleMutations.has(sessionId)) ||
			(this.#inflightSessionOperations.get(sessionId) ?? 0) > 0 ||
			this.#startPromises.has(sessionId) ||
			this.#supervisors.get(sessionId)?.hasPendingCalls() === true ||
			this.#pendingMessageCount(sessionId) > 0 ||
			(this.#transcripts.get(sessionId)?.pendingUiRequests().length ?? 0) > 0 ||
			ref?.status === "active" ||
			ref?.pendingApproval === true ||
			ref?.pendingUserInput === true ||
			liveState?.isStreaming === true ||
			liveState?.isCompacting === true ||
			liveState?.pendingApproval === true ||
			liveState?.pendingUserInput === true ||
			queuedLifecycleWork(liveState)
		);
	}
	private lifecycleRevisionFailure(command: CommandFrame): SessionLifecycleFailure | undefined {
		const projection = command.sessionId ? this.#projections.get(command.sessionId) : undefined;
		if (!projection) return { code: "unknown_session", message: "session is not indexed" };
		if (command.expectedRevision === undefined)
			return { code: "stale_revision", message: "expectedRevision is required" };
		if (command.expectedRevision === projection.value.revision) return undefined;
		return {
			code: "stale_revision",
			message: "session revision is stale",
			details: { expectedRevision: command.expectedRevision, actualRevision: projection.value.revision },
		};
	}
	private lifecycleBusyOutcome(command: CommandFrame, message: string): CommandOutcome {
		return { frame: response(this.hostId, command, false, undefined, { code: "session_busy", message }) };
	}
	private lifecycleFailureOutcome(command: CommandFrame, failure: SessionLifecycleFailure): CommandOutcome {
		return { frame: response(this.hostId, command, false, undefined, failure) };
	}
	private async childExitedWithinLifecycleTimeout(child: ChildHandle): Promise<boolean> {
		return Promise.race([
			child.exited.then(() => true).catch(() => false),
			Bun.sleep(this.#lifecycleQuiesceTimeoutMs).then(() => false),
		]);
	}
	private async quiesceSupervisor(sessionId: SessionId): Promise<boolean> {
		const supervisor = this.#supervisors.get(sessionId);
		if (!supervisor) {
			this.#stateRefreshGenerations.delete(sessionId);
			return true;
		}
		const child = supervisor.child();
		if (!child) return false;
		supervisor.stop("SIGTERM");
		if (!(await this.childExitedWithinLifecycleTimeout(child))) {
			// A lifecycle mutation may proceed only after the process itself exits,
			// not merely after the supervisor has rejected its pending RPC calls.
			supervisor.stop("SIGKILL");
			if (!(await this.childExitedWithinLifecycleTimeout(child))) return false;
		}
		const current = this.#supervisors.get(sessionId);
		if (current && current !== supervisor) return false;
		this.#supervisors.delete(sessionId);
		this.#releaseAllMessageLifecycles(sessionId, "cancelled");
		this.#stateRefreshGenerations.delete(sessionId);
		this.#transcripts.delete(sessionId);
		this.disposeSubagentState(sessionId);
		const cleared = this.#projections.get(sessionId)?.clearPendingAttention();
		if (cleared) this.broadcast(sessionId, cleared);
		return true;
	}
	private releaseSupervisorAfterExit(sessionId: SessionId, supervisor: RpcChildSupervisor): void {
		const release = () => {
			if (this.#supervisors.get(sessionId) !== supervisor) return;
			this.#supervisors.delete(sessionId);
			if (this.#stopping || this.#closedSessions.has(sessionId)) return;
			this.#transcripts.delete(sessionId);
			this.disposeSubagentState(sessionId);
			const cleared = this.#projections.get(sessionId)?.clearPendingAttention();
			if (cleared) this.broadcast(sessionId, cleared);
			const restartable = this.#projections.get(sessionId)?.markRuntimeRestartable();
			if (restartable) this.broadcast(sessionId, restartable);
		};
		const child = supervisor.child();
		if (child) void child.exited.then(release, release);
		else release();
	}
	private markSupervisorCrashed(sessionId: SessionId, supervisor: RpcChildSupervisor): void {
		if (this.#supervisors.get(sessionId) !== supervisor) return;
		this.advanceStateRefreshGeneration(sessionId);
		this.#releaseAllMessageLifecycles(sessionId, "failed");
		const at = this.#clock.now().toISOString();
		const crashed = this.#projections.get(sessionId)?.markRuntimeCrashed({
			id: `runtime:failed:${at}`,
			kind: "failed",
			at,
			summary: "Agent runtime stopped unexpectedly.",
		});
		this.#persistAttentionOutcome(sessionId, {
			id: `runtime:failed:${at}`,
			kind: "failed",
			at,
			summary: "Agent runtime stopped unexpectedly.",
		});
		if (crashed) this.broadcast(sessionId, crashed);
		this.#stateRefreshGenerations.delete(sessionId);
		this.#transcripts.delete(sessionId);
		this.disposeSubagentState(sessionId);
		this.releaseSupervisorAfterExit(sessionId, supervisor);
	}
	private disposeSubagentState(sessionId: SessionId): void {
		this.#subagents.delete(sessionId);
		this.#agentTranscripts.get(sessionId)?.dispose();
		this.#agentTranscripts.delete(sessionId);
	}
	private async quiesceSessionRuntime(sessionId: SessionId): Promise<boolean> {
		if (this.#operations?.hasOpenTerminals(sessionId)) {
			const controller = new AbortController();
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const closed = await Promise.race([
					this.#operations
						.closeSessionTerminals(sessionId, controller.signal)
						.then(() => true)
						.catch(() => false),
					new Promise<false>(resolve => {
						timer = setTimeout(() => {
							controller.abort();
							resolve(false);
						}, this.#lifecycleQuiesceTimeoutMs);
					}),
				]);
				if (!closed) return false;
			} finally {
				if (timer) clearTimeout(timer);
			}
		}
		const owner = this.#externalRuntimes.get(sessionId);
		if (!owner) return this.quiesceSupervisor(sessionId);
		this.cancelExternalPermissions(sessionId);
		try {
			await owner.session.dispose();
		} catch {
			return false;
		}
		if (this.#externalRuntimes.get(sessionId) !== owner) return false;
		this.#externalRuntimes.delete(sessionId);
		this.#releaseAllMessageLifecycles(sessionId, "cancelled");
		this.#stateRefreshGenerations.delete(sessionId);
		return true;
	}
	private async handleArchive(command: CommandFrame): Promise<CommandOutcome> {
		const sessionId = command.sessionId!;
		if (this.#lifecycleMutations.has(sessionId))
			return this.lifecycleBusyOutcome(command, "session lifecycle mutation is already in progress");
		this.#lifecycleMutations.add(sessionId);
		try {
			if (!this.#authority)
				return this.lifecycleFailureOutcome(command, {
					code: "unsupported",
					message: "session lifecycle management is unavailable",
				});
			const revisionFailure = this.lifecycleRevisionFailure(command);
			if (revisionFailure) return this.lifecycleFailureOutcome(command, revisionFailure);
			const projection = this.#projections.get(sessionId)!;
			const record = this.#records.get(sessionId)!;
			if (record.runtime)
				return this.lifecycleFailureOutcome(command, {
					code: "unsupported",
					message: "external runtime sessions cannot be archived",
				});
			if (record.archivedAt) return { frame: response(this.hostId, command, true, { archived: true }) };
			if (this.sessionLifecycleBusy(sessionId, true))
				return this.lifecycleBusyOutcome(command, "sessions with active or pending work cannot be archived");
			if (!(await this.quiesceSessionRuntime(sessionId)))
				return this.lifecycleBusyOutcome(command, "session runtime did not stop cleanly");
			try {
				await this.#lockCheck(record);
			} catch {
				return {
					frame: response(this.hostId, command, false, undefined, {
						code: "session_locked",
						message: "session is locked by another process",
					}),
				};
			}
			const archivedAt = this.#clock.now().toISOString();
			await this.#imageUploads.cleanupSession(sessionId);
			await this.#authority.archive(record, archivedAt);
			record.archivedAt = archivedAt;
			this.scheduleTranscriptSearchReconcile();
			await this.broadcastAttachedOrdered(
				sessionId,
				projection.appendEvent({ type: "session_archived", archivedAt }),
			);
			const delta = projection.updateArchivedAt(archivedAt);
			if (delta) await this.broadcastIndex(delta);
			return { frame: response(this.hostId, command, true, { archived: true }) };
		} catch {
			return {
				frame: response(this.hostId, command, false, undefined, {
					code: "session_lifecycle_failed",
					message: "session archive failed",
				}),
			};
		} finally {
			this.#lifecycleMutations.delete(sessionId);
		}
	}
	private async handleRestore(command: CommandFrame): Promise<CommandOutcome> {
		const sessionId = command.sessionId!;
		if (this.#lifecycleMutations.has(sessionId))
			return this.lifecycleBusyOutcome(command, "session lifecycle mutation is already in progress");
		this.#lifecycleMutations.add(sessionId);
		try {
			if (!this.#authority)
				return this.lifecycleFailureOutcome(command, {
					code: "unsupported",
					message: "session lifecycle management is unavailable",
				});
			const revisionFailure = this.lifecycleRevisionFailure(command);
			if (revisionFailure) return this.lifecycleFailureOutcome(command, revisionFailure);
			const projection = this.#projections.get(sessionId)!;
			const record = this.#records.get(sessionId)!;
			if (record.runtime)
				return this.lifecycleFailureOutcome(command, {
					code: "unsupported",
					message: "external runtime sessions cannot be restored",
				});
			if (!record.archivedAt) return { frame: response(this.hostId, command, true, { restored: true }) };
			await this.#imageUploads.cleanupSession(sessionId);
			await this.#authority.restore(record);
			delete record.archivedAt;
			this.scheduleTranscriptSearchReconcile();
			await this.broadcastAttachedOrdered(sessionId, projection.appendEvent({ type: "session_restored" }));
			const delta = projection.updateArchivedAt();
			if (delta) await this.broadcastIndex(delta);
			return { frame: response(this.hostId, command, true, { restored: true }) };
		} catch {
			return {
				frame: response(this.hostId, command, false, undefined, {
					code: "session_lifecycle_failed",
					message: "session restore failed",
				}),
			};
		} finally {
			this.#lifecycleMutations.delete(sessionId);
		}
	}
	private async handleDelete(command: CommandFrame): Promise<CommandOutcome> {
		const sessionId = command.sessionId!;
		if (this.#lifecycleMutations.has(sessionId))
			return this.lifecycleBusyOutcome(command, "session lifecycle mutation is already in progress");
		this.#lifecycleMutations.add(sessionId);
		try {
			const projection = this.#projections.get(sessionId);
			const record = this.#records.get(sessionId);
			if (!projection || !record)
				return this.lifecycleFailureOutcome(command, {
					code: "unknown_session",
					message: "session is not indexed",
				});
			const guarded = await this.deletePreflight(command, true);
			if (guarded && guarded.code !== "session_busy") return this.lifecycleFailureOutcome(command, guarded);
			if (guarded)
				return this.lifecycleBusyOutcome(command, "session became busy while deletion was being confirmed");
			if (!(await this.quiesceSessionRuntime(sessionId)))
				return this.lifecycleBusyOutcome(command, "session runtime did not stop cleanly");
			const finalGuard = await this.deletePreflight(command, true);
			if (finalGuard) return this.lifecycleFailureOutcome(command, finalGuard);
			await this.#imageUploads.cleanupSession(sessionId);
			if (!record.runtime) await this.#authority!.delete(record);
			await this.#transcriptSearch?.deleteSession(sessionId);
			this.cleanupObserverState(sessionId);
			await this.broadcastAttachedOrdered(sessionId, projection.appendEvent({ type: "session_deleted" }));
			await this.broadcastIndex(projection.remove());
			this.#records.delete(sessionId);
			this.#projections.delete(sessionId);
			await this.#attentionOutcomes?.delete(sessionId);
			this.#closedSessions.delete(sessionId);
			this.#releaseAllMessageLifecycles(sessionId, "completed-without-entry");
			this.#stateRefreshGenerations.delete(sessionId);
			this.#transcripts.delete(sessionId);
			this.disposeSubagentState(sessionId);
			for (const sessions of this.#attached.values()) sessions.delete(sessionId);
			return { frame: response(this.hostId, command, true, { deleted: true }) };
		} catch {
			return {
				frame: response(this.hostId, command, false, undefined, {
					code: "session_lifecycle_failed",
					message: "session deletion failed",
				}),
			};
		} finally {
			this.#lifecycleMutations.delete(sessionId);
		}
	}
	private finish(
		command: CommandFrame,
		outcome: CommandOutcome,
		idempotency: IdempotencyStore | undefined,
	): CommandOutcome {
		if (!idempotency) return outcome;
		const cached: CommandOutcome = { ...outcome };
		delete cached.attachOutput;
		idempotency.complete(command.commandId, command, cached);
		return outcome;
	}
	#pendingMessageCount(sessionId: SessionId): number {
		return this.#messageLifecycles.get(sessionId)?.length ?? 0;
	}
	#hasMessageLifecycle(sessionId: SessionId, lifecycle: PromptLifecycle): boolean {
		return this.#messageLifecycles.get(sessionId)?.includes(lifecycle) === true;
	}
	#registerMessageLifecycle(sessionId: SessionId, lifecycle: PromptLifecycle): boolean {
		const current = this.#messageLifecycles.get(sessionId) ?? [];
		if (current.length >= MAX_PENDING_PROMPTS || this.#messageLifecyclesByCommandId.has(lifecycle.commandId))
			return false;
		this.#messageLifecycles.set(sessionId, [...current, lifecycle]);
		this.#messageLifecyclesByCommandId.set(lifecycle.commandId, lifecycle);
		this.advanceStateRefreshGeneration(sessionId);
		return true;
	}
	#findMessageLifecycle(sessionId: SessionId, internalId: string | undefined): PromptLifecycle | undefined {
		if (internalId === undefined) return undefined;
		return this.#messageLifecycles.get(sessionId)?.find(lifecycle => lifecycle.internalId === internalId);
	}
	#removeMessageLifecycle(sessionId: SessionId, lifecycle: PromptLifecycle): boolean {
		const current = this.#messageLifecycles.get(sessionId);
		if (!current?.includes(lifecycle)) return false;
		const next = current.filter(candidate => candidate !== lifecycle);
		if (next.length > 0) this.#messageLifecycles.set(sessionId, next);
		else this.#messageLifecycles.delete(sessionId);
		if (this.#messageLifecyclesByCommandId.get(lifecycle.commandId) === lifecycle)
			this.#messageLifecyclesByCommandId.delete(lifecycle.commandId);
		if (this.#promptLifecycles.get(sessionId) === lifecycle) this.#promptLifecycles.delete(sessionId);
		this.advanceStateRefreshGeneration(sessionId);
		return true;
	}
	#emitPromptTransient(
		sessionId: SessionId,
		command: CommandFrame,
		lifecycle: PromptLifecycle,
		message: string,
		attachmentCount: number,
	): void {
		if (!this.#hasMessageLifecycle(sessionId, lifecycle) || lifecycle.transientEntryId) return;
		const transientEntryId = `user:${createHash("sha256").update(command.commandId).digest("hex").slice(0, 32)}`;
		lifecycle.transientEntryId = transientEntryId;
		const projection = this.#projections.get(sessionId);
		if (!projection) return;
		const at = this.#clock.now().toISOString();
		const pending = projection.addPendingPrompt({
			entryId: transientEntryId,
			text: projectMessageText(message, PENDING_PROMPT_TEXT_BYTES),
			attachmentCount,
			at,
		});
		if (pending) this.broadcast(sessionId, pending);
		this.broadcast(
			sessionId,
			projection.appendEvent(
				asAppWireEvent({
					type: "message.update",
					entryId: transientEntryId,
					role: "user",
					text: projectMessageText(message, PENDING_PROMPT_EVENT_TEXT_BYTES),
					reasoning: "",
					attachmentCount,
					at,
				}),
			),
		);
	}
	#settlePromptTransient(sessionId: SessionId, lifecycle: PromptLifecycle | undefined, entryId: string): void {
		const transientEntryId = lifecycle?.transientEntryId;
		if (!lifecycle || !this.#hasMessageLifecycle(sessionId, lifecycle) || !transientEntryId) return;
		lifecycle.transientEntryId = undefined;
		const projection = this.#projections.get(sessionId);
		if (!projection) return;
		this.broadcast(
			sessionId,
			projection.appendEvent(
				asAppWireEvent({
					type: "message.settled",
					transientEntryId,
					entryId,
					at: this.#clock.now().toISOString(),
				}),
			),
		);
		const pending = projection.clearPendingPrompt(transientEntryId);
		if (pending) this.broadcast(sessionId, pending);
		if (lifecycle.kind !== "prompt") this.#removeMessageLifecycle(sessionId, lifecycle);
	}
	#discardPromptTransient(sessionId: SessionId, lifecycle: PromptLifecycle, reason: PromptDiscardReason): void {
		const transientEntryId = lifecycle.transientEntryId;
		if (!transientEntryId) return;
		lifecycle.transientEntryId = undefined;
		const projection = this.#projections.get(sessionId);
		if (!projection) return;
		this.broadcast(
			sessionId,
			projection.appendEvent(
				asAppWireEvent({
					type: "message.discarded",
					transientEntryId,
					reason,
					at: this.#clock.now().toISOString(),
				}),
			),
		);
		const pending = projection.clearPendingPrompt(transientEntryId);
		if (pending) this.broadcast(sessionId, pending);
	}
	#releaseMessageLifecycle(
		sessionId: SessionId,
		lifecycle?: PromptLifecycle,
		reason: PromptDiscardReason = "completed-without-entry",
	): boolean {
		if (!lifecycle || !this.#hasMessageLifecycle(sessionId, lifecycle)) return false;
		this.#discardPromptTransient(sessionId, lifecycle, reason);
		return this.#removeMessageLifecycle(sessionId, lifecycle);
	}
	#releaseAllMessageLifecycles(sessionId: SessionId, reason: PromptDiscardReason): boolean {
		const lifecycles = [...(this.#messageLifecycles.get(sessionId) ?? [])];
		let released = false;
		for (const lifecycle of lifecycles)
			if (this.#releaseMessageLifecycle(sessionId, lifecycle, reason)) released = true;
		return released;
	}
	#projectTerminalStatus(
		sessionId: SessionId,
		supervisor = this.#supervisors.get(sessionId),
		requestId = "terminal",
	): void {
		if (this.#closedSessions.has(sessionId)) return;
		if (this.#pendingMessageCount(sessionId) > 0) this.updateStatus(sessionId, "active");
		if (supervisor) {
			this.scheduleStateRefresh(sessionId, supervisor, requestId);
			return;
		}
		if (this.#projections.get(sessionId)?.value.ref.liveState?.isStreaming !== true)
			this.updateStatus(sessionId, "idle");
	}
	private advanceStateRefreshGeneration(sessionId: SessionId): number {
		const generation = (this.#stateRefreshGenerations.get(sessionId) ?? 0) + 1;
		this.#stateRefreshGenerations.set(sessionId, generation);
		return generation;
	}
	private updateStatus(sessionId: SessionId, status: SessionRef["status"]): void {
		const frame = this.#projections.get(sessionId)?.updateStatus(status);
		if (frame) this.broadcast(sessionId, frame);
	}
	#projectAttentionEvent(
		sessionId: SessionId,
		transcript: TranscriptEventTranslator,
		event: AppserverEvent,
		authoritativeTurnError = false,
	): void {
		const projection = this.#projections.get(sessionId);
		if (!projection) return;
		let frame: ServerFrame | undefined;
		if (event.type === "ask.request") {
			const pending = transcript.pendingUiRequest(event.askId);
			frame = projection.setPendingAttention(
				pending?.attention ?? {
					kind: "question",
					id: event.askId,
					question: event.question,
					options: event.options ?? [],
					allowText: event.allowText,
					requestedAt: event.at,
				},
			);
		} else if (event.type === "approval.request") {
			const pending = transcript.pendingUiRequest(event.approvalId);
			frame = projection.setPendingAttention(
				pending?.attention ?? {
					kind: "approval",
					id: event.approvalId,
					title: event.title,
					summary: event.message || event.title,
					requestedAt: event.at,
				},
			);
		} else if (event.type === "ask.resolved") frame = projection.removePendingAttention(event.askId);
		else if (event.type === "approval.resolved") frame = projection.removePendingAttention(event.approvalId);
		else if (event.type === "agent.end") {
			const summary =
				event.status === "completed"
					? "Agent completed work."
					: event.status === "cancelled"
						? "Agent work was cancelled."
						: "Agent stopped with an error.";
			const outcome: AttentionOutcome = {
				id: `agent:${event.status}:${event.at}`,
				kind: event.status,
				at: event.at,
				summary,
			};
			frame = projection.settleAttentionOutcome(outcome);
			this.#persistAttentionOutcome(sessionId, outcome);
		} else if (event.type === "turn.error" && authoritativeTurnError) {
			const outcome: AttentionOutcome = {
				id: `turn:failed:${event.at}`,
				kind: "failed",
				at: event.at,
				summary: safeAttentionDisplay(event.message, 1_024, "The turn stopped with an error."),
			};
			frame = projection.settleAttentionOutcome(outcome);
			this.#persistAttentionOutcome(sessionId, outcome);
		}
		if (frame) this.broadcast(sessionId, frame);
	}
	#persistAttentionOutcome(sessionId: SessionId, outcome: AttentionOutcome): void {
		void this.#attentionOutcomes?.set(sessionId, outcome).catch(() => undefined);
	}
	private async refreshState(
		sessionId: SessionId,
		supervisor: RpcChildSupervisor,
		requestId: string,
		preserveProjectedStatus = false,
		signal?: AbortSignal,
	): Promise<SessionStateResult> {
		const generation = this.advanceStateRefreshGeneration(sessionId);
		const result = await supervisor.call({ type: "get_state" }, `${requestId}:state`, signal);
		if (!result.success || !("data" in result)) throw new Error("rpc state query failed");
		const state = safeSessionState(result.data);
		const providerTransport = safeProviderTransport(result.data);
		const projection = this.#projections.get(sessionId);
		if (!projection) throw new Error("unknown session");
		if (this.#stateRefreshGenerations.get(sessionId) !== generation) return state;
		const statusOverride = preserveProjectedStatus
			? projection.value.ref.status
			: this.#pendingMessageCount(sessionId) > 0
				? "active"
				: undefined;
		const frame = projection.updateState(
			state,
			statusOverride,
			!this.#closedSessions.has(sessionId),
			providerTransport,
		);
		if (frame) await this.broadcastIndex(frame);
		return state;
	}
	private scheduleStateRefresh(
		sessionId: SessionId,
		supervisor: RpcChildSupervisor,
		requestId: string,
		preserveProjectedStatus = false,
	): void {
		void this.refreshState(sessionId, supervisor, requestId, preserveProjectedStatus).catch(() => undefined);
	}
	private async ensureSupervisor(sessionId: SessionId): Promise<RpcChildSupervisor> {
		if (this.#externalRuntimes.has(sessionId)) throw new ExternalRuntimeCommandError();
		if (this.#draining) throw new Error("appserver is draining");
		if (this.#stopping) throw new Error("appserver is stopping");
		if (this.#closedSessions.has(sessionId)) throw new Error("session is closed");
		if (this.#lifecycleMutations.has(sessionId)) throw new Error("session lifecycle mutation is in progress");
		if (this.sessionArchived(sessionId)) throw new Error("session is archived");
		const pending = this.#startPromises.get(sessionId);
		if (pending) return pending;
		const existing = this.#supervisors.get(sessionId);
		if (existing) return existing;
		const start = Promise.resolve().then(() => this.startSupervisor(sessionId));
		this.#startPromises.set(sessionId, start);
		try {
			return await start;
		} finally {
			this.#startPromises.delete(sessionId);
		}
	}
	private async startSupervisor(sessionId: SessionId): Promise<RpcChildSupervisor> {
		const existing = this.#supervisors.get(sessionId);
		if (existing) return existing;
		if (this.#stopping || this.#closedSessions.has(sessionId)) throw new Error("session is closed");
		if (this.#lifecycleMutations.has(sessionId)) throw new Error("session lifecycle mutation is in progress");
		const record = this.#records.get(sessionId);
		if (!record) throw new Error("unknown session");
		if (this.sessionArchived(sessionId)) throw new Error("session is archived");
		await this.#lockCheck(record);
		if (this.#stopping || this.#closedSessions.has(sessionId)) throw new Error("session is closed");
		if (this.#lifecycleMutations.has(sessionId) || this.sessionArchived(sessionId))
			throw new Error("session lifecycle changed while starting");
		const projection = this.#projections.get(sessionId)!;
		const transcript = new TranscriptEventTranslator();
		transcript.observeKnownEntries(projection.value.entries);
		this.#transcripts.set(sessionId, transcript);
		const subagents = new SubagentProjection(this.hostId, sessionId);
		this.#subagents.set(sessionId, subagents);
		const projector = new SessionEntryProjector(this.hostId, sessionId, "live", projection.value.entries, id =>
			artifactDescriptorForRoot(record.path.slice(0, -".jsonl".length), id),
		);
		let supervisor: RpcChildSupervisor;
		const agentTranscripts = new AgentTranscriptProjection({
			hostId: this.hostId,
			sessionId,
			epoch: this.epoch,
			read: async (agent, fromByte): Promise<RpcSubagentMessagesResult> => {
				const result = await supervisor.call(
					{
						type: "get_subagent_messages",
						subagentId: agent,
						fromByte,
						maxBytes: SUBAGENT_TRANSCRIPT_RPC_BYTES,
						includeMessages: false,
					},
					`agent-transcript:${agent}`,
				);
				if (!result.success || result.command !== "get_subagent_messages")
					throw new Error(result.success ? "subagent transcript response mismatch" : result.error);
				return rpcSubagentMessagesResult(result.data);
			},
			revision: () => projection.value.revision,
			emit: frame => this.broadcast(sessionId, frame),
		});
		this.#agentTranscripts.set(sessionId, agentTranscripts);
		supervisor = new RpcChildSupervisor(
			this.#factory,
			record,
			{
				entry: frame => {
					const value: unknown = frame.entry;
					const raw =
						value && typeof value === "object" && !Array.isArray(value)
							? (value as Record<string, unknown>)
							: undefined;
					if (!raw) return;
					const entries = projector.project(raw);
					const settlementEvents = transcript.observeSessionEntry(raw, entries);
					const lifecycle = this.#findMessageLifecycle(sessionId, promptEntryCorrelationId(frame.entry));
					const correlatedPromptEntry = lifecycle !== undefined;
					let durableUserEntryId: string | undefined;
					for (const entry of entries) {
						const output = projection.appendEntry(entry);
						if (output) this.broadcast(sessionId, output);
						if (
							correlatedPromptEntry &&
							entry.kind === "message" &&
							entry.data.role === "user" &&
							durableUserEntryId === undefined
						)
							durableUserEntryId = entry.id;
					}
					if (durableUserEntryId) this.#settlePromptTransient(sessionId, lifecycle, durableUserEntryId);
					const projectedTitle =
						projector.titleChange ??
						(projection.value.ref.title === "Session" || projection.value.ref.title === "Untitled"
							? fallbackSessionTitle(projector.firstUserText)
							: undefined);
					if (projectedTitle) {
						record.title = projectedTitle;
						const output = projection.updateTitle(projectedTitle);
						if (output) this.broadcast(sessionId, output);
					}
					for (const event of settlementEvents)
						this.broadcast(sessionId, projection.appendEvent(asAppWireEvent(event)));
				},
				event: frame => {
					const agentFrame = subagents.applyFrame(frame);
					if (agentFrame) this.broadcast(sessionId, agentFrame);
					const transcriptAgentId = subagentIdFromFrame(frame);
					if (transcriptAgentId) agentTranscripts.refresh(transcriptAgentId);
					const terminalPromptResult =
						frame.type === "prompt_result" &&
						(typeof frame.agentInvoked === "boolean" || typeof frame.error === "string");
					const terminalLifecycle =
						terminalPromptResult && typeof frame.id === "string"
							? this.#findMessageLifecycle(sessionId, frame.id)
							: undefined;
					const currentPromptResult = terminalLifecycle !== undefined;
					for (const event of transcript.translate(frame, { currentPromptResult })) {
						this.broadcast(sessionId, projection.appendEvent(asAppWireEvent(event)));
						this.#projectAttentionEvent(
							sessionId,
							transcript,
							event,
							frame.type === "turn_end" || (frame.type === "prompt_result" && currentPromptResult),
						);
						if (event.type === "turn.start" || event.type === "agent.start")
							this.updateStatus(sessionId, "active");
					}
					if (terminalLifecycle) {
						const reason =
							typeof frame.error === "string"
								? "failed"
								: frame.agentInvoked === false
									? "local-only"
									: "completed-without-entry";
						if (this.#releaseMessageLifecycle(sessionId, terminalLifecycle, reason))
							this.#projectTerminalStatus(sessionId, supervisor, `${frame.id}:terminal`);
					}
					if (frame.type === "agent_end") this.scheduleStateRefresh(sessionId, supervisor, "agent-end");
					if (frame.type === "thinking_level_changed")
						this.scheduleStateRefresh(sessionId, supervisor, "thinking-level-changed");
				},
				crashed: () => {
					this.markSupervisorCrashed(sessionId, supervisor);
				},
			},
			this.#factory.argv(record.path),
		);
		this.#supervisors.set(sessionId, supervisor);
		try {
			await supervisor.start();
			if (this.#supervisors.get(sessionId) !== supervisor) throw new Error("rpc child exited during startup");
			this.releaseSupervisorAfterExit(sessionId, supervisor);
			return supervisor;
		} catch (error) {
			if (this.#supervisors.get(sessionId) === supervisor) this.#supervisors.delete(sessionId);
			this.#releaseAllMessageLifecycles(sessionId, "failed");
			this.#transcripts.delete(sessionId);
			this.disposeSubagentState(sessionId);
			supervisor.stop();
			throw error;
		}
	}
	private async message(ws: AppWs, raw: string | Uint8Array): Promise<void> {
		this.#inflightMessages += 1;
		let attachingSessionId: SessionId | undefined;
		try {
			if (this.#draining || this.#stopping) {
				ws.close(1012, "appserver maintenance");
				return;
			}
			if (typeof raw !== "string") throw new Error("binary websocket frames are not supported");
			const frame = decodeClientFrame(parseBounded(raw));
			if (frame.type === "command" && frame.command === "session.attach") attachingSessionId = frame.sessionId;
			if (frame.type === "hello") {
				if (this.#hello.has(ws)) throw new Error("hello already received");
				let decision: RemoteHelloDecision | undefined;
				if (ws.remote) {
					const connection = this.#remoteConnections.get(ws);
					if (!connection || !this.#remotePolicy) throw new Error("remote connection is unavailable");
					decision = await this.#remotePolicy.authenticate(connection, frame);
					if (!decision.authenticated && decision.authentication !== "pairing-required") {
						ws.close(1008, "remote authentication denied");
						return;
					}
					this.#remoteDecisions.set(ws, decision);
				}
				this.#hello.add(ws);
				await this.hello(ws, frame, decision);
				return;
			}
			if (frame.type === "pair.start") {
				if (!this.#hello.has(ws) || !ws.remote) throw new Error("pairing requires remote hello");
				const connection = this.#remoteConnections.get(ws);
				if (!connection || !this.#remotePolicy?.pairStart) throw new Error("pairing unavailable");
				const result = await this.#remotePolicy.pairStart(connection, frame);
				if (!result) {
					await this.#sendFrame(ws, {
						v: "omp-app/1",
						type: "pair.error",
						code: "pairing_denied",
						message: "pairing denied",
						requestId: frame.requestId,
					});
					return;
				}
				await this.#sendFrame(ws, result);
				return;
			}
			if (!this.#hello.has(ws)) throw new Error("hello required before commands");
			if (ws.remote) {
				const connection = this.#remoteConnections.get(ws);
				if (!connection || !this.#remotePolicy) throw new Error("remote connection is unavailable");
				const remoteProjection =
					frame.type === "command" &&
					COMMAND_DESCRIPTORS[frame.command]?.scope === "session" &&
					frame.sessionId !== undefined
						? this.#projections.get(frame.sessionId)
						: undefined;
				const allowed = await this.#remotePolicy.authorize(connection, frame, {
					connectionId: ws.connectionId,
					peer: connection.peer,
					...(frame.type === "command" ? { command: frame } : {}),
					...(remoteProjection ? { sessionRevision: remoteProjection.value.revision } : {}),
				});
				if (!allowed) {
					if (!this.#remotePolicy.isClosed?.(connection)) ws.close(1008, "remote policy denied");
					return;
				}
			}
			if (ws.remote && frame.type === "command") {
				const connection = this.#remoteConnections.get(ws);
				const handled =
					connection && this.#remotePolicy?.handleCommand
						? await this.#remotePolicy.handleCommand(connection, frame)
						: undefined;
				if (handled) {
					await this.#sendFrame(ws, handled);
					return;
				}
			}
			if (frame.type === "ping") {
				await this.#sendFrame(ws, {
					v: "omp-app/1",
					type: "pong",
					nonce: frame.nonce,
					timestamp: this.#clock.now().toISOString(),
				});
				return;
			}
			if (frame.type === "confirm") {
				await this.#sendFrame(ws, (await this.confirm(ws, frame)).frame);
				return;
			}
			if (frame.type === "terminal.input" || frame.type === "terminal.resize" || frame.type === "terminal.close") {
				if (this.#projections.get(frame.sessionId)?.value.ref.liveState?.sessionControl) {
					await this.#sendFrame(ws, {
						v: "omp-app/1",
						type: "error",
						code: "SESSION_LOCKED",
						message: "session is locked by another process",
					});
					return;
				}
				if (!this.#operations) {
					await this.#sendFrame(ws, {
						v: "omp-app/1",
						type: "error",
						code: "unsupported",
						message: "terminal operations are unsupported",
					});
					return;
				}
				const session = this.#projections.get(frame.sessionId);
				if (this.sessionArchived(frame.sessionId) && frame.type !== "terminal.close") {
					await this.#sendFrame(ws, {
						v: "omp-app/1",
						type: "error",
						code: "SESSION_ARCHIVED",
						message: "archived sessions are read-only",
					});
					return;
				}
				if (!this.beginSessionOperation(frame.sessionId)) {
					await this.#sendFrame(ws, {
						v: "omp-app/1",
						type: "error",
						code: "SESSION_BUSY",
						message: "session lifecycle mutation is in progress",
					});
					return;
				}
				const controller = new AbortController();
				this.#abortControllers.get(ws)?.add(controller);
				try {
					await this.#operations.routeTerminal(frame, {
						hostId: this.hostId,
						sessionId: frame.sessionId,
						deviceId: ws.deviceId,
						connectionId: ws.connectionId,
						capabilities: (this.#clientCapabilities.get(ws) ?? new Set()) as OperationContext["capabilities"],
						currentRevision: session?.value.revision,
						abortSignal: controller.signal,
					});
				} catch (error) {
					const rawCode =
						error && typeof error === "object" && "code" in error && typeof error.code === "string"
							? error.code.toUpperCase()
							: "OPERATION_FAILED";
					const code = new Set([
						"FORBIDDEN",
						"NOT_FOUND",
						"STALE_REVISION",
						"UNSUPPORTED",
						"ABORTED",
						"CONFLICT",
						"OPERATION_FAILED",
					]).has(rawCode)
						? rawCode
						: "OPERATION_FAILED";
					await this.#sendFrame(ws, { v: "omp-app/1", type: "error", code, message: "terminal operation failed" });
				} finally {
					this.#abortControllers.get(ws)?.delete(controller);
					this.endSessionOperation(frame.sessionId);
				}
				return;
			}
			if (frame.type !== "command") {
				await this.#sendFrame(ws, {
					v: "omp-app/1",
					type: "error",
					code: "unsupported",
					message: "frame is not supported",
				});
				return;
			}
			const descriptor = COMMAND_DESCRIPTORS[frame.command];
			if (this.observerBarrierBlocks(frame)) {
				await this.#sendFrame(ws, this.observerBarrierOutcome(frame).frame);
				return;
			}
			if (descriptor?.confirmation === "challenge") {
				if (frame.confirmationId !== undefined) {
					await this.#sendFrame(
						ws,
						response(this.hostId, frame, false, undefined, {
							code: "confirmation_invalid",
							message: "command confirmation must be approved through a confirm frame",
						}),
					);
					return;
				}
				if (frame.command === "session.delete") {
					const failure = await this.deletePreflight(frame);
					if (failure) {
						await this.#sendFrame(ws, response(this.hostId, frame, false, undefined, failure));
						return;
					}
				}
				await this.#sendFrame(ws, this.challenge(ws, frame));
				return;
			}
			const outcome = await this.#command(frame, ws);
			const outputFrames = [outcome.frame];
			if (
				frame.command === "session.attach" &&
				frame.sessionId &&
				outcome.frame.type === "response" &&
				outcome.frame.ok
			) {
				const attached = this.#attached.get(ws);
				const projection = this.#projections.get(frame.sessionId);
				if (!attached || !projection) throw new Error("attach output is incomplete");
				// Re-check ownership for every delivery, including a cached
				// idempotent attach replay. The snapshot sent below must already
				// carry observer/reconciling control; a later timer is too late.
				await this.enqueueExternalRefresh(frame.sessionId);
				const cursor = frame.args.cursor;
				const prepared = prepareAttachOutput(projection, cursor === undefined ? undefined : decodeCursor(cursor));
				// A replayed command outcome carries the baseline from its first
				// delivery, while its bulk attach output is deliberately rebuilt.
				// Keep the acknowledgement cursor aligned with the freshly prepared
				// snapshot/replay that immediately follows it.
				outputFrames[0] = response(this.hostId, frame, true, {
					attached: true,
					cursor: prepared.baseline,
				});
				attached.add(frame.sessionId);
				this.startExternalObserver(frame.sessionId);
				try {
					outputFrames.push(...completeAttachOutput(prepared, projection, this.#subagents.get(frame.sessionId)));
					if (this.#clientFeatures.get(ws)?.has("agent.transcript"))
						outputFrames.push(...(this.#agentTranscripts.get(frame.sessionId)?.frames() ?? []));
				} catch (error) {
					attached.delete(frame.sessionId);
					throw error;
				}
			}
			await Promise.all(outputFrames.map(output => this.#sendFrame(ws, output)));
		} catch {
			if (attachingSessionId) {
				this.#attached.get(ws)?.delete(attachingSessionId);
				if (!this.hasAttachedClient(attachingSessionId)) this.cleanupObserverState(attachingSessionId);
			}
			if (ws.remote) {
				ws.close(1008, "invalid frame");
				return;
			}
			await this.#sendFrame(ws, { v: "omp-app/1", type: "error", code: "invalid_frame", message: "invalid frame" });
			ws.close(1008, "invalid frame");
		} finally {
			this.#inflightMessages -= 1;
		}
	}
	private challenge(ws: AppWs, command: CommandFrame): ConfirmationChallenge {
		const hash = createHash("sha256")
			.update(JSON.stringify({ ...command, confirmationId: undefined }))
			.digest("hex");
		const confirmationId = randomUUID() as never;
		const expiresAt = Date.now() + 60_000;
		this.#challenges.set(String(confirmationId), { command, ws, expiresAt, hash });
		return {
			v: "omp-app/1",
			type: "confirmation",
			confirmationId,
			commandId: command.commandId,
			hostId: this.hostId,
			sessionId: command.sessionId,
			commandHash: hash,
			revision: (command.expectedRevision ??
				this.#projections.get(command.sessionId!)?.value.revision ??
				"host") as never,
			expiresAt: new Date(expiresAt).toISOString(),
			summary: command.command,
		};
	}
	private async confirm(ws: AppWs, frame: ConfirmFrame): Promise<CommandOutcome> {
		const pending = this.#challenges.get(String(frame.confirmationId));
		if (
			!pending ||
			pending.ws !== ws ||
			pending.expiresAt < Date.now() ||
			pending.command.commandId !== frame.commandId ||
			pending.command.hostId !== frame.hostId ||
			pending.command.sessionId !== frame.sessionId
		)
			return {
				frame: response(
					this.hostId,
					{
						...(pending?.command ?? frame),
						requestId: frame.requestId,
						commandId: frame.commandId,
						hostId: this.hostId,
					} as CommandFrame,
					false,
					undefined,
					{ code: "confirmation_invalid", message: "confirmation is invalid or expired" },
				),
			};
		this.#challenges.delete(String(frame.confirmationId));
		if (frame.decision === "deny")
			return {
				frame: response(this.hostId, pending.command, false, undefined, {
					code: "confirmation_denied",
					message: "command was denied",
				}),
			};
		return this.#command({ ...pending.command, confirmationId: frame.confirmationId }, ws, true);
	}
	private async disconnectClient(ws: AppWs): Promise<void> {
		if (!this.#clients.has(ws)) return;
		const detachedSessions = [...(this.#attached.get(ws) ?? [])];
		const controllers = this.#abortControllers.get(ws);
		for (const controller of controllers ?? []) controller.abort();
		if (this.#operations) {
			const contextBase = {
				hostId: this.hostId,
				deviceId: ws.deviceId,
				capabilities: (this.#clientCapabilities.get(ws) ?? new Set()) as OperationContext["capabilities"],
				abortSignal: AbortSignal.abort(),
			};
			try {
				await this.#operations.disconnectConnection(ws.connectionId, contextBase);
			} catch {
				/* owner cleanup is best effort; registry always releases */
			}
		}
		await this.#imageUploads.cleanupConnection(ws.connectionId);
		this.#clients.delete(ws);
		this.#hello.delete(ws);
		this.#clientCapabilities.delete(ws);
		this.#clientFeatures.delete(ws);
		this.#attached.delete(ws);
		for (const sessionId of detachedSessions)
			if (!this.hasAttachedClient(sessionId)) this.cleanupObserverState(sessionId);
		this.#deviceIds.delete(ws);
		this.#abortControllers.delete(ws);
		this.#remoteDecisions.delete(ws);
		this.#remoteConnections.delete(ws);
		this.#remoteTransports.delete(ws.connectionId);
		this.#connectionIdempotency.delete(ws);
		for (const [confirmationId, pending] of this.#challenges)
			if (pending.ws === ws) this.#challenges.delete(confirmationId);
		for (const [socket, transport] of this.#localTransports)
			if (transport === ws) this.#localTransports.delete(socket);
	}
	private async hello(ws: AppWs, frame: HelloFrame, decision?: RemoteHelloDecision): Promise<void> {
		if (!ws.remote && frame.authentication !== undefined)
			throw new Error("device authentication is not accepted on local transport");
		const capabilityCeiling = decision?.grantedCapabilities
			? new Set(decision.grantedCapabilities)
			: this.#supportedCapabilities;
		const requestedCapabilities = new Set(frame.capabilities?.client ?? this.#supportedCapabilities);
		const grantedCapabilities = [...this.#supportedCapabilities].filter(
			capability => requestedCapabilities.has(capability) && capabilityCeiling.has(capability),
		);
		const supportedFeatures = ws.remote ? this.#remoteSupportedFeatures : this.#supportedFeatures;
		const featureCeiling = decision?.grantedFeatures ? new Set(decision.grantedFeatures) : supportedFeatures;
		const grantedFeatures = frame.requestedFeatures.filter(
			feature => supportedFeatures.has(feature) && featureCeiling.has(feature),
		);
		this.#clientCapabilities.set(ws, new Set(grantedCapabilities));
		this.#clientFeatures.set(ws, new Set(grantedFeatures));
		const welcome = {
			v: "omp-app/1",
			type: "welcome",
			selectedProtocol: "omp-app/1",
			hostId: this.hostId,
			ompVersion: this.#ompVersion,
			ompBuild: this.#ompBuild,
			appserverVersion: this.#appserverVersion,
			appserverBuild: this.#appserverBuild,
			epoch: this.epoch,
			grantedCapabilities,
			grantedFeatures,
			negotiatedLimits: { maxPayloadLength: 1024 * 1024, ringSize: this.#ringSize },
			authentication: decision?.authentication ?? (ws.remote ? "remote" : "local"),
			resumed: frame.savedCursors.some(
				cursor => cursor.hostId === this.hostId && cursor.cursor.epoch === this.epoch,
			),
		};
		await this.#sendFrame(ws, welcome as ServerFrame);
		if (decision?.authentication === "pairing-required") return;
		try {
			await this.refreshSessions();
		} catch {
			await this.#sendFrame(ws, {
				v: "omp-app/1",
				type: "error",
				code: "session_inventory_unavailable",
				message: "session history is unavailable",
			});
			ws.close(1011, "session history unavailable");
			return;
		}
		if (this.#stopping || !this.#hello.has(ws)) return;
		await this.#sendFrame(ws, this.sessionsFrame());
	}
	#createLocalTransport(ws: LocalWs): AppWs {
		let closed = false;
		const transport: AppWs = {
			connectionId: randomUUID(),
			deviceId: randomUUID(),
			remote: false,
			send: text => {
				if (closed) return false;
				try {
					const result = ws.send(text);
					return typeof result === "number" ? result > 0 : true;
				} catch {
					return false;
				}
			},
			close: (code, reason) => {
				if (closed) return;
				closed = true;
				try {
					ws.close(code, reason);
				} catch {}
			},
		};
		return transport;
	}
	#remoteConnected(connection: RemoteConnection): void {
		if (this.#draining || this.#stopping) {
			connection.socket.close(1012, "appserver maintenance");
			return;
		}
		let closed = false;
		const transport: AppWs = {
			connectionId: connection.connectionId,
			deviceId: connection.peer.identity.nodeId,
			remote: true,
			send: text => connection.socket.send(text),
			close: (code, reason) => {
				if (closed) return;
				closed = true;
				connection.socket.close(code, reason);
			},
		};
		this.#remoteConnections.set(transport, connection);
		this.#remoteTransports.set(transport.connectionId, transport);
		this.#clients.add(transport);
		this.#clientCapabilities.set(transport, new Set());
		this.#clientFeatures.set(transport, new Set());
		this.#attached.set(transport, new Set());
		this.#deviceIds.set(transport, transport.deviceId);
		this.#abortControllers.set(transport, new Set());
		this.#connectionIdempotency.set(transport, new IdempotencyStore());
	}
	async #remoteMessage(connection: RemoteConnection, message: string | Uint8Array): Promise<void> {
		const transport = this.#remoteTransports.get(connection.connectionId);
		if (transport) await this.message(transport, typeof message === "string" ? message : new Uint8Array(message));
	}
	async #remoteDisconnected(connection: RemoteConnection): Promise<void> {
		this.#inflightLifecycleMutations += 1;
		try {
			const transport = this.#remoteTransports.get(connection.connectionId);
			if (transport) await this.disconnectClient(transport);
			if (this.#remotePolicy?.disconnected) await this.#remotePolicy.disconnected(connection);
		} finally {
			this.#inflightLifecycleMutations -= 1;
		}
	}
	async #sendFrame(transport: AppWs, frame: ServerFrame): Promise<boolean> {
		const previous = this.#outboundTails.get(transport) ?? Promise.resolve();
		const send = previous.then(() => this.#sendFrameNow(transport, frame));
		const tail = send.then(
			() => undefined,
			() => undefined,
		);
		this.#outboundTails.set(transport, tail);
		try {
			return await send;
		} finally {
			if (this.#outboundTails.get(transport) === tail) this.#outboundTails.delete(transport);
		}
	}
	async #sendFrameNow(transport: AppWs, frame: ServerFrame): Promise<boolean> {
		if (transport.remote) {
			const connection = this.#remoteConnections.get(transport);
			if (!connection || !this.#remotePolicy) return false;
			let transformed: ServerFrame | string | undefined;
			try {
				transformed = this.#remotePolicy.transformOutbound
					? await boundedRemoteTransform(this.#remotePolicy.transformOutbound(connection, frame))
					: frame;
			} catch {
				connection.socket.close(1011, "remote policy failed");
				return false;
			}
			if (transformed === undefined) return false;
			return transport.send(typeof transformed === "string" ? transformed : JSON.stringify(transformed));
		}
		return transport.send(JSON.stringify(frame));
	}
	private refreshSessions(): Promise<void> {
		if (this.#sessionRefresh) return this.#sessionRefresh;
		const refresh = this.refreshSessionsOnce(this.#inventoryGeneration);
		this.#sessionRefresh = refresh;
		const clear = () => {
			if (this.#sessionRefresh === refresh) this.#sessionRefresh = undefined;
		};
		void refresh.then(clear, clear);
		return refresh;
	}
	private async refreshSessionsOnce(generation: number): Promise<void> {
		const discovered = await this.#discovery.list();
		if (generation !== this.#inventoryGeneration || this.#stopping || !this.#started) return;
		const publishChanges = this.#inventoryLoaded;
		const discoveredIds = new Set<SessionId>();
		for (const record of discovered) {
			if (discoveredIds.has(record.sessionId)) throw new Error(`duplicate session id: ${record.sessionId}`);
			discoveredIds.add(record.sessionId);
		}
		for (const discoveredRecord of discovered) {
			const previous = this.#records.get(discoveredRecord.sessionId);
			let record: SessionRecord =
				previous?.archivedAt && !discoveredRecord.archivedAt
					? { ...discoveredRecord, archivedAt: previous.archivedAt }
					: discoveredRecord;
			if (
				previous !== undefined &&
				previous.entriesLoaded !== false &&
				record.entriesLoaded === false &&
				previous.path === record.path &&
				previous.updatedAt === record.updatedAt
			)
				record = previous;
			this.#records.set(record.sessionId, record);
			this.#discoveryMisses.delete(record.sessionId);
			this.#createdPending.delete(record.sessionId);
			const projection = this.#projections.get(record.sessionId);
			if (!projection) {
				const inserted = new SessionProjection(this.hostId, record, this.epoch, this.#ringSize);
				const outcome = this.#attentionOutcomes?.get(record.sessionId);
				if (outcome) inserted.setLatestOutcome(outcome);
				this.#projections.set(record.sessionId, inserted);
				if (publishChanges) await this.broadcastIndex(inserted.indexUpsert());
			} else {
				const output = projection.value.ref.liveState?.sessionControl
					? projection.reconcileObserverRecord(record)
					: projection.reconcileRecord(record);
				if (output && publishChanges) await this.broadcastIndex(output);
			}
		}
		for (const [sessionId, pending] of this.#createdPending) {
			if (discoveredIds.has(sessionId)) {
				this.#createdPending.delete(sessionId);
				continue;
			}
			if (pending.refreshesRemaining > 0) pending.refreshesRemaining -= 1;
			else {
				this.#createdPending.delete(sessionId);
				this.#discoveryMisses.delete(sessionId);
				const projection = this.#projections.get(sessionId);
				if (projection) await this.broadcastIndex(projection.remove());
				this.cleanupObserverState(sessionId);
				await this.#imageUploads.cleanupSession(sessionId);
				this.#records.delete(sessionId);
				this.#projections.delete(sessionId);
				await this.#attentionOutcomes?.delete(sessionId);
				this.#stateRefreshGenerations.delete(sessionId);
			}
		}
		for (const sessionId of this.#records.keys()) {
			if (discoveredIds.has(sessionId) || this.#createdPending.has(sessionId)) continue;
			if (this.#lifecycleMutations.has(sessionId)) continue;
			const misses = (this.#discoveryMisses.get(sessionId) ?? 0) + 1;
			if (misses < 2) {
				this.#discoveryMisses.set(sessionId, misses);
				continue;
			}
			this.#discoveryMisses.delete(sessionId);
			this.#lifecycleMutations.add(sessionId);
			try {
				if (!(await this.quiesceSessionRuntime(sessionId))) {
					this.#discoveryMisses.set(sessionId, 1);
					continue;
				}
				const projection = this.#projections.get(sessionId);
				if (projection) await this.broadcastIndex(projection.remove());
				this.cleanupObserverState(sessionId);
				await this.#imageUploads.cleanupSession(sessionId);
				this.#records.delete(sessionId);
				await this.#transcriptSearch?.deleteSession(sessionId);
				this.#projections.delete(sessionId);
				await this.#attentionOutcomes?.delete(sessionId);
				this.#closedSessions.delete(sessionId);
				this.#releaseAllMessageLifecycles(sessionId, "completed-without-entry");
				this.#stateRefreshGenerations.delete(sessionId);
				this.#transcripts.delete(sessionId);
				this.disposeSubagentState(sessionId);
				for (const sessions of this.#attached.values()) sessions.delete(sessionId);
			} finally {
				this.#lifecycleMutations.delete(sessionId);
			}
		}
		this.#inventoryLoaded = true;
		this.scheduleTranscriptSearchReconcile();
	}
	private loadSession(sessionId: SessionId): Promise<void> {
		const pending = this.#sessionLoads.get(sessionId);
		if (pending) return pending;
		const record = this.#records.get(sessionId);
		const loader = this.#discovery.load?.bind(this.#discovery);
		if (record?.entriesLoaded !== false || !loader) return Promise.resolve();
		const generation = this.#inventoryGeneration;
		const load = this.loadSessionOnce(record, generation, loader);
		this.#sessionLoads.set(sessionId, load);
		const clear = () => {
			if (this.#sessionLoads.get(sessionId) === load) this.#sessionLoads.delete(sessionId);
		};
		void load.then(clear, clear);
		return load;
	}
	private async loadSessionOnce(
		record: SessionRecord,
		generation: number,
		loader: (session: SessionRecord) => Promise<SessionRecord>,
	): Promise<void> {
		const loaded = await loader(record);
		if (generation !== this.#inventoryGeneration || this.#stopping || !this.#started) return;
		if (loaded.sessionId !== record.sessionId || loaded.path !== record.path)
			throw new Error("session identity changed while loading transcript");
		this.#records.set(loaded.sessionId, loaded);
		const projection = new SessionProjection(this.hostId, loaded, this.epoch, this.#ringSize);
		const outcome = this.#attentionOutcomes?.get(loaded.sessionId);
		if (outcome) projection.setLatestOutcome(outcome);
		this.#projections.set(loaded.sessionId, projection);
	}
	private async refreshTranscriptSearch(): Promise<void> {
		if (!this.#transcriptSearch) return;
		// Mark the current coverage as building immediately, then coalesce any
		// discovery changes into one follow-up pass. Search waits for the complete
		// chain, but ordinary startup and session-list refreshes remain background work.
		this.scheduleTranscriptSearchReconcile();
		await this.refreshSessions();
		this.scheduleTranscriptSearchReconcile();
		while (this.#transcriptSearchReconcile) {
			const reconcile = this.#transcriptSearchReconcile;
			await reconcile;
			// The scheduler's completion handler starts a requested follow-up pass.
			// Yield one microtask so the loop observes that replacement promise.
			await Promise.resolve();
		}
	}
	private scheduleTranscriptSearchReconcile(): void {
		if (!this.#transcriptSearch || this.#stopping) return;
		if (this.#transcriptSearchReconcile) {
			this.#transcriptSearchRerun = true;
			return;
		}
		const authority = this.#transcriptSearch;
		const records = [...this.#records.values()];
		const reconcile = authority.reconcile(records);
		this.#transcriptSearchReconcile = reconcile;
		void reconcile
			.catch(() => undefined)
			.finally(() => {
				if (this.#transcriptSearchReconcile === reconcile) this.#transcriptSearchReconcile = undefined;
				if (!this.#transcriptSearchRerun) return;
				this.#transcriptSearchRerun = false;
				this.scheduleTranscriptSearchReconcile();
			});
	}
	private cleanupObserverState(sessionId: SessionId): void {
		const timer = this.#observerTimers.get(sessionId);
		if (timer) clearInterval(timer);
		this.#observerTimers.delete(sessionId);
		this.#observers.delete(sessionId);
		this.#promotionFailures.delete(sessionId);
	}
	private hasAttachedClient(sessionId: SessionId): boolean {
		for (const sessions of this.#attached.values()) if (sessions.has(sessionId)) return true;
		return false;
	}
	private observerIsCurrent(
		sessionId: SessionId,
		observer: SessionTranscriptObserver,
		record: SessionRecord,
		projection: SessionProjection,
	): boolean {
		return (
			this.#observers.get(sessionId) === observer &&
			this.#records.get(sessionId)?.path === record.path &&
			this.#projections.get(sessionId) === projection
		);
	}
	private async applyObserverPoll(
		sessionId: SessionId,
		projection: SessionProjection,
		poll: SessionTranscriptPoll,
	): Promise<void> {
		if (!poll.record) return;
		const current = this.#records.get(sessionId);
		const record: SessionRecord = {
			...(current ?? poll.record),
			...poll.record,
			...(current?.archivedAt && !poll.record.archivedAt ? { archivedAt: current.archivedAt } : {}),
		};
		this.#records.set(sessionId, record);
		const transcriptFrames = projection.rebaseEntries(record.entries);
		for (const frame of transcriptFrames) this.broadcast(sessionId, frame);
		const metadata = projection.reconcileObserverRecord(record);
		if (metadata) await this.broadcastIndex(metadata);
		else if (transcriptFrames.length > 0) await this.broadcastIndex(projection.indexUpsert());
	}
	private async discardPromotionSupervisor(sessionId: SessionId, supervisor: RpcChildSupervisor): Promise<void> {
		const child = supervisor.child();
		supervisor.stop("SIGTERM");
		if (child && !(await this.childExitedWithinLifecycleTimeout(child))) {
			supervisor.stop("SIGKILL");
			await child.exited.catch(() => undefined);
		}
		if (this.#supervisors.get(sessionId) === supervisor) this.#supervisors.delete(sessionId);
		this.#releaseAllMessageLifecycles(sessionId, "failed");
		this.#stateRefreshGenerations.delete(sessionId);
		this.#transcripts.delete(sessionId);
		this.disposeSubagentState(sessionId);
	}
	private enqueueExternalRefresh(sessionId: SessionId): Promise<void> {
		const existing = this.#observerRefreshes.get(sessionId);
		if (existing) {
			existing.rerun = true;
			return existing.promise;
		}
		const state = { promise: Promise.resolve(), rerun: false };
		const run = async (): Promise<void> => {
			do {
				state.rerun = false;
				await this.refreshExternalSession(sessionId);
			} while (state.rerun);
		};
		state.promise = run().finally(() => {
			if (this.#observerRefreshes.get(sessionId) === state) this.#observerRefreshes.delete(sessionId);
		});
		this.#observerRefreshes.set(sessionId, state);
		return state.promise;
	}
	private promotionFingerprint(
		record: SessionRecord,
		projection: SessionProjection,
		poll: SessionTranscriptPoll,
	): string {
		return JSON.stringify([
			record.path,
			poll.watermark.entryCount,
			poll.watermark.lastEntryId,
			projection.value.revision,
		]);
	}
	private async refreshExternalSession(sessionId: SessionId): Promise<void> {
		const record = this.#records.get(sessionId);
		const projection = this.#projections.get(sessionId);
		if (!record || !projection) return;
		// A local child owns the session. Never let external bytes rebase it.
		if (this.#supervisors.has(sessionId)) return;
		let status: SessionLockStatus;
		try {
			status = await this.#lockStatus(record);
		} catch {
			status = "malformed";
		}
		if (status === "live" || status === "suspect" || status === "malformed") {
			this.#promotionFailures.delete(sessionId);
			let observer = this.#observers.get(sessionId);
			if (!observer) {
				observer = new SessionTranscriptObserver(record.path, this.hostId);
				this.#observers.set(sessionId, observer);
			}
			const poll = await observer.poll();
			const transcript = poll.record && poll.record.sessionId !== sessionId ? "snapshot" : poll.transcript;
			if (this.#supervisors.has(sessionId) || this.#startPromises.has(sessionId)) return;
			if (!this.observerIsCurrent(sessionId, observer, record, projection)) return;
			if (poll.record?.sessionId === sessionId) await this.applyObserverPoll(sessionId, projection, poll);
			if (!this.observerIsCurrent(sessionId, observer, record, projection)) return;
			const control = projection.setSessionControl({
				mode: "observer",
				lockStatus: status,
				transcript,
			});
			if (control) await this.broadcastIndex(control);
			return;
		}
		let observer = this.#observers.get(sessionId);
		if (!observer) {
			const lockless = status === "missing" && !projection.value.ref.liveState?.sessionControl;
			observer = new SessionTranscriptObserver(record.path, this.hostId);
			this.#observers.set(sessionId, observer);
			if (lockless) this.#locklessObservers.add(observer);
		}
		const lockless = this.#locklessObservers.has(observer);
		const establishingLocklessBaseline = lockless && !this.#locklessObserverBaselines.has(observer);
		const poll = await observer.poll();
		if (this.#supervisors.has(sessionId) || this.#startPromises.has(sessionId)) return;
		if (!this.observerIsCurrent(sessionId, observer, record, projection)) return;
		const pollRecordMatches = poll.record?.sessionId === sessionId;
		if (establishingLocklessBaseline) {
			if (!pollRecordMatches || !poll.stable) return;
			this.#locklessObserverBaselines.add(observer);
		}
		if (pollRecordMatches && (!lockless || establishingLocklessBaseline || poll.changed))
			await this.applyObserverPoll(sessionId, projection, poll);
		if (!this.observerIsCurrent(sessionId, observer, record, projection)) return;
		const reconciling = projection.setSessionControl({
			mode: "reconciling",
			transcript: pollRecordMatches ? poll.transcript : "snapshot",
		});
		if (reconciling) await this.broadcastIndex(reconciling);
		if (!this.observerIsCurrent(sessionId, observer, record, projection)) return;
		if (lockless) return;
		if (!this.hasAttachedClient(sessionId)) return;
		if (!pollRecordMatches || !poll.stable || poll.transcript !== "live") return;
		if (poll.unresolvedPendingCount !== 0) return;
		let promotionLockStatus: SessionLockStatus;
		try {
			promotionLockStatus = await this.#lockStatus(record);
		} catch {
			promotionLockStatus = "malformed";
		}
		if (promotionLockStatus !== "missing" && promotionLockStatus !== "stale") return;
		const attemptFingerprint = this.promotionFingerprint(record, projection, poll);
		if (this.#promotionFailures.get(sessionId) === attemptFingerprint) return;
		let supervisor: RpcChildSupervisor;
		if (this.#supervisors.has(sessionId) || this.#startPromises.has(sessionId)) return;
		try {
			// startSupervisor performs the final write-lock gate immediately before spawn.
			supervisor = await this.ensureSupervisor(sessionId);
		} catch {
			this.#promotionFailures.set(sessionId, this.promotionFingerprint(record, projection, poll));
			return;
		}
		if (this.#supervisors.get(sessionId) !== supervisor) {
			this.#promotionFailures.set(sessionId, this.promotionFingerprint(record, projection, poll));
			return;
		}
		const final = await observer.poll();
		if (!this.observerIsCurrent(sessionId, observer, record, projection)) {
			await this.discardPromotionSupervisor(sessionId, supervisor);
			return;
		}
		if (final.record?.sessionId !== sessionId) {
			await this.discardPromotionSupervisor(sessionId, supervisor);
			this.#promotionFailures.set(sessionId, this.promotionFingerprint(record, projection, final));
			return;
		}
		await this.applyObserverPoll(sessionId, projection, final);
		const loaded = supervisor.loadedWatermark();
		if (!this.observerIsCurrent(sessionId, observer, record, projection)) {
			await this.discardPromotionSupervisor(sessionId, supervisor);
			return;
		}
		const matches =
			final.record?.sessionId === sessionId &&
			final.stable &&
			final.transcript === "live" &&
			final.unresolvedPendingCount === 0 &&
			loaded !== undefined &&
			loaded.entryCount === final.watermark.entryCount &&
			loaded.lastEntryId === final.watermark.lastEntryId;
		if (!matches) {
			await this.discardPromotionSupervisor(sessionId, supervisor);
			this.#promotionFailures.set(sessionId, this.promotionFingerprint(record, projection, final));
			return;
		}
		if (this.#supervisors.get(sessionId) !== supervisor) return;
		const control = projection.setSessionControl();
		if (control) await this.broadcastIndex(control);
		this.cleanupObserverState(sessionId);
	}
	private startExternalObserver(sessionId: SessionId): void {
		if (this.#observerTimers.has(sessionId)) return;
		const timer = setInterval(() => {
			void this.enqueueExternalRefresh(sessionId).catch(() => undefined);
		}, 250);
		this.#observerTimers.set(sessionId, timer);
	}

	private sessionListResult(): { sessions: SessionRef[]; totalCount: number; truncated: boolean } {
		const allSessions = [...this.#projections.values()].map(value => value.value.ref);
		allSessions.sort((a, b) => {
			if (a.updatedAt < b.updatedAt) return 1;
			if (a.updatedAt > b.updatedAt) return -1;
			if (a.sessionId < b.sessionId) return -1;
			if (a.sessionId > b.sessionId) return 1;
			return 0;
		});
		const totalCount = allSessions.length;
		const pendingBudget: SessionListBudget = {
			pendingBytes: 0,
			pendingEntries: 0,
			attentionBytes: 0,
			attentionEntries: 0,
		};
		const sessions: SessionRef[] = [];
		let refsBytes = 2; // JSON array brackets
		let refNodes = 1; // JSON array node
		for (const current of allSessions.slice(0, 1000)) {
			const ref = projectSessionListAttention(
				projectSessionListPendingPrompts(current, pendingBudget),
				pendingBudget,
			);
			const separatorBytes = sessions.length === 0 ? 0 : 1;
			const bytes = encodedJsonBytes(ref) + separatorBytes;
			const nodes = jsonNodeCount(ref, SESSION_LIST_REF_NODES - refNodes);
			if (refsBytes + bytes > SESSION_LIST_REFS_BYTES || refNodes + nodes > SESSION_LIST_REF_NODES) break;
			sessions.push(ref);
			refsBytes += bytes;
			refNodes += nodes;
		}
		return { sessions, totalCount, truncated: totalCount > sessions.length };
	}
	private sessionsFrame(): ServerFrame {
		return {
			v: "omp-app/1",
			type: "sessions",
			hostId: this.hostId,
			cursor: { epoch: this.epoch, seq: 0 },
			...this.sessionListResult(),
		};
	}
	private broadcast(sessionId: SessionId, frame: ServerFrame): void {
		if (frame.type === "session.delta") {
			void this.broadcastIndex(frame);
			return;
		}
		for (const [client, sessions] of this.#attached) {
			if (!sessions.has(sessionId)) continue;
			if (frame.type === "agent.transcript" && !this.#clientFeatures.get(client)?.has("agent.transcript")) continue;
			void this.#sendFrame(client, frame);
		}
	}
	private async broadcastAttachedOrdered(sessionId: SessionId, frame: ServerFrame): Promise<void> {
		for (const [client, sessions] of this.#attached)
			if (sessions.has(sessionId)) await this.#sendFrame(client, frame);
	}
	private async broadcastIndex(frame: ServerFrame): Promise<void> {
		const sends: Array<Promise<boolean>> = [];
		for (const client of this.#clients) {
			if (!this.#hello.has(client) || !this.#clientCapabilities.get(client)?.has("sessions.read")) continue;
			sends.push(this.#sendFrame(client, frame));
		}
		await Promise.all(sends);
	}
	#emptyDrainBusy(): AppserverDrainBusy {
		return {
			connections: 0,
			inflightMessages: 0,
			startingSupervisors: 0,
			lifecycleMutations: 0,
			sessionOperations: 0,
			activePrompts: 0,
			rpcSupervisorsWithPendingCalls: 0,
			busySessions: 0,
			openTerminalSessions: 0,
			pendingConfirmations: 0,
			outboundSends: 0,
		};
	}
	#drainBusy(): AppserverDrainBusy {
		const now = Date.now();
		for (const [confirmationId, pending] of this.#challenges)
			if (pending.expiresAt < now || !this.#clients.has(pending.ws)) this.#challenges.delete(confirmationId);
		let sessionOperations = 0;
		for (const count of this.#inflightSessionOperations.values()) sessionOperations += count;
		let rpcSupervisorsWithPendingCalls = 0;
		for (const supervisor of this.#supervisors.values())
			if (supervisor.hasPendingCalls()) rpcSupervisorsWithPendingCalls += 1;
		let busySessions = 0;
		let openTerminalSessions = 0;
		for (const sessionId of this.#records.keys()) {
			if (this.sessionLifecycleBusy(sessionId)) busySessions += 1;
			if (this.#operations?.hasOpenTerminals(sessionId)) openTerminalSessions += 1;
		}
		return {
			connections: this.#clients.size,
			inflightMessages: this.#inflightMessages,
			startingSupervisors: this.#startPromises.size,
			lifecycleMutations: this.#lifecycleMutations.size + this.#inflightLifecycleMutations,
			sessionOperations,
			activePrompts: [...this.#messageLifecycles.values()].reduce(
				(count, lifecycles) => count + lifecycles.length,
				0,
			),
			rpcSupervisorsWithPendingCalls,
			busySessions,
			openTerminalSessions,
			pendingConfirmations: this.#challenges.size,
			outboundSends: this.#outboundTails.size,
		};
	}
	#tryDrainIfIdle(expectedHostId: string, expectedEpoch: string): AppserverDrainResult {
		const health = { ok: true as const, hostId: this.hostId, epoch: this.epoch };
		if (expectedHostId !== this.hostId || expectedEpoch !== this.epoch)
			return { state: "identity_mismatch", health, busy: this.#drainBusy() };
		if (this.#draining) return { state: "draining", health, busy: this.#emptyDrainBusy() };
		this.#draining = true;
		const busy = this.#drainBusy();
		if (Object.values(busy).some(count => count > 0)) {
			this.#draining = false;
			return { state: "busy", health, busy };
		}
		return { state: "draining", health, busy };
	}
	private async fetch(request: Request, server: Bun.Server<ServerWebSocketData>): Promise<Response | undefined> {
		const url = new URL(request.url);
		if (url.pathname === "/health" && request.method === "GET")
			return Response.json({ ok: true, hostId: this.hostId, epoch: this.epoch, draining: this.#draining });
		if (url.pathname === "/admin/drain-if-idle") return this.#adminDrainIfIdle(request);
		if (url.pathname === "/admin/pair-ticket") return this.adminPairTicket(request);
		if (url.pathname === "/admin/devices") return this.adminDevices(request);
		if (url.pathname === "/admin/revoke") return this.adminRevoke(request);
		if (url.pathname === "/admin/test/seed") return this.#adminTestSeed(request);
		if (url.pathname === "/admin/test/status") return this.#adminTestStatus(request);
		if (url.pathname === "/admin/test/cleanup") return this.#adminTestCleanup(request);
		if (
			url.pathname !== "/ws" ||
			request.method !== "GET" ||
			request.headers.get("upgrade")?.toLowerCase() !== "websocket"
		)
			return new Response("Not Found", { status: 404 });
		if (this.#draining || this.#stopping) return new Response("Service Unavailable", { status: 503 });
		if (server.upgrade(request, { data: { socket: {} } })) return undefined;
		return new Response("Upgrade Required", { status: 426 });
	}
	private adminError(status = 400): Response {
		return Response.json({ error: "invalid admin request" }, { status });
	}
	private async adminJson(request: Request, keys: readonly string[]): Promise<Record<string, unknown> | Response> {
		if (request.method !== "POST" || request.headers.get("content-type") !== "application/json")
			return this.adminError(405);
		const length = request.headers.get("content-length");
		if (length !== null && (!/^\d+$/u.test(length) || Number(length) > 16_384)) return this.adminError(413);
		let bytes: ArrayBuffer;
		try {
			bytes = await request.arrayBuffer();
		} catch {
			return this.adminError();
		}
		if (bytes.byteLength > 16_384) return this.adminError(413);
		let value: unknown;
		try {
			value = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			return this.adminError();
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) return this.adminError();
		const body = value as Record<string, unknown>;
		if (Object.keys(body).some(key => !keys.includes(key))) return this.adminError();
		return body;
	}
	async #adminDrainIfIdle(request: Request): Promise<Response> {
		if (this.#stopping) return this.adminError(503);
		const body = await this.adminJson(request, ["expectedHostId", "expectedEpoch"]);
		if (body instanceof Response) return body;
		if (this.#stopping) return this.adminError(503);
		if (
			typeof body.expectedHostId !== "string" ||
			body.expectedHostId.length === 0 ||
			body.expectedHostId.length > 1024 ||
			typeof body.expectedEpoch !== "string" ||
			body.expectedEpoch.length === 0 ||
			body.expectedEpoch.length > 1024
		)
			return this.adminError();
		return Response.json(this.#tryDrainIfIdle(body.expectedHostId, body.expectedEpoch));
	}
	private async adminPairTicket(request: Request): Promise<Response> {
		if (!this.#admin || request.method !== "POST") return this.adminError(404);
		if (this.#draining || this.#stopping) return this.adminError(503);
		this.#inflightLifecycleMutations += 1;
		try {
			const body = await this.adminJson(request, ["capabilities", "ttlMs", "expectedNodeId"]);
			if (body instanceof Response) return body;
			if (this.#draining || this.#stopping) return this.adminError(503);
			const capabilities = body.capabilities;
			if (
				!Array.isArray(capabilities) ||
				capabilities.length === 0 ||
				capabilities.length > 32 ||
				capabilities.some(value => typeof value !== "string" || value.length === 0 || value.length > 128)
			)
				return this.adminError();
			const ttl = body.ttlMs;
			if (ttl !== undefined && (typeof ttl !== "number" || !Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 600_000))
				return this.adminError();
			const nodeId = body.expectedNodeId;
			if (nodeId !== undefined && (typeof nodeId !== "string" || nodeId.length === 0 || nodeId.length > 512))
				return this.adminError();
			try {
				return Response.json(this.#admin.issuePairingTicket(capabilities, ttl, nodeId));
			} catch {
				return this.adminError();
			}
		} finally {
			this.#inflightLifecycleMutations -= 1;
		}
	}
	private adminDevices(request: Request): Response {
		if (!this.#admin || request.method !== "GET") return this.adminError(404);
		try {
			return Response.json({ devices: this.#admin.listDevices() });
		} catch {
			return this.adminError(500);
		}
	}
	private async adminRevoke(request: Request): Promise<Response> {
		if (!this.#admin || request.method !== "POST") return this.adminError(404);
		if (this.#draining || this.#stopping) return this.adminError(503);
		this.#inflightLifecycleMutations += 1;
		try {
			const body = await this.adminJson(request, ["deviceId"]);
			if (body instanceof Response) return body;
			if (this.#draining || this.#stopping) return this.adminError(503);
			if (typeof body.deviceId !== "string" || body.deviceId.length === 0 || body.deviceId.length > 512)
				return this.adminError();
			try {
				return Response.json(this.#admin.revokeDevice(body.deviceId));
			} catch {
				return this.adminError();
			}
		} finally {
			this.#inflightLifecycleMutations -= 1;
		}
	}
	async #quiesceTestSessions(control: AppserverTestControl, runId: string): Promise<void> {
		for (const id of await control.sessionIds(runId)) {
			clearInterval(this.#observerTimers.get(id));
			this.#observerTimers.delete(id);
			await this.#observerRefreshes.get(id)?.promise.catch(() => undefined);
			await this.#startPromises.get(id)?.catch(() => undefined);
			const supervisor = this.#supervisors.get(id);
			if (supervisor) await this.discardPromotionSupervisor(id, supervisor);
			this.#observers.delete(id);
			this.#promotionFailures.delete(id);
		}
	}
	async #evictTestSession(sessionId: SessionId): Promise<void> {
		const projection = this.#projections.get(sessionId);
		if (projection) await this.broadcastIndex(projection.remove());
		this.cleanupObserverState(sessionId);
		await this.#imageUploads.cleanupSession(sessionId);
		this.#records.delete(sessionId);
		await this.#transcriptSearch?.deleteSession(sessionId);
		this.#projections.delete(sessionId);
		await this.#attentionOutcomes?.delete(sessionId);
		this.#closedSessions.delete(sessionId);
		this.#releaseAllMessageLifecycles(sessionId, "completed-without-entry");
		this.#stateRefreshGenerations.delete(sessionId);
		this.#transcripts.delete(sessionId);
		this.#sessionLoads.delete(sessionId);
		this.#createdPending.delete(sessionId);
		this.#discoveryMisses.delete(sessionId);
		this.disposeSubagentState(sessionId);
		for (const sessions of this.#attached.values()) sessions.delete(sessionId);
	}
	async #runTestControlMutation(operation: () => Promise<Response>): Promise<Response> {
		if (this.#draining || this.#stopping) return this.adminError(503);
		this.#inflightLifecycleMutations += 1;
		const pending = operation();
		this.#testControlMutations.add(pending);
		try {
			return await pending;
		} finally {
			this.#testControlMutations.delete(pending);
			this.#inflightLifecycleMutations -= 1;
		}
	}
	#authorizedTestControl(request: Request): AppserverOptions["testControl"] | undefined {
		const control = this.#testControl;
		if (!control || request.headers.get("authorization") !== `Bearer ${control.token}`) return undefined;
		return control;
	}
	async #testControlStatus(
		control: AppserverTestControl,
		runId: string,
		status: AppserverTestControlStatus,
	): Promise<AppserverTestControlStatus> {
		const sessionIds = await control.sessionIds(runId);
		let supervisors = 0;
		let starting = 0;
		let pendingRpc = 0;
		for (const sessionId of sessionIds) {
			const supervisor = this.#supervisors.get(sessionId);
			if (supervisor) {
				supervisors += 1;
				if (supervisor.hasPendingCalls()) pendingRpc += 1;
			}
			if (this.#startPromises.has(sessionId)) starting += 1;
		}
		return {
			...status,
			workers: { supervisors, starting, pendingRpc },
		};
	}
	async #adminTestSeed(request: Request): Promise<Response> {
		const control = this.#authorizedTestControl(request);
		if (!control) return this.adminError(404);
		if (this.#draining || this.#stopping) return this.adminError(503);
		const body = await this.adminJson(request, ["runId", "projectRoot", "sessionCount", "historyEntries"]);
		if (body instanceof Response) return body;
		if (
			typeof body.runId !== "string" ||
			body.runId.length === 0 ||
			body.runId.length > 128 ||
			typeof body.projectRoot !== "string" ||
			body.projectRoot.length === 0 ||
			body.projectRoot.length > 4096 ||
			typeof body.sessionCount !== "number" ||
			!Number.isSafeInteger(body.sessionCount) ||
			body.sessionCount < 1 ||
			body.sessionCount > 100 ||
			typeof body.historyEntries !== "number" ||
			!Number.isSafeInteger(body.historyEntries) ||
			body.historyEntries < 0 ||
			body.historyEntries > 10_000
		)
			return this.adminError();
		const seedRequest: AppserverTestSeedRequest = {
			runId: body.runId,
			projectRoot: body.projectRoot,
			sessionCount: body.sessionCount,
			historyEntries: body.historyEntries,
		};
		return this.#runTestControlMutation(async () => {
			try {
				await control.seed(seedRequest);
				await this.refreshSessions();
				const status = await this.#testControlStatus(
					control,
					seedRequest.runId,
					await control.status(seedRequest.runId),
				);
				return Response.json(status);
			} catch {
				return this.adminError(500);
			}
		});
	}
	async #adminTestStatus(request: Request): Promise<Response> {
		const control = this.#authorizedTestControl(request);
		if (!control) return this.adminError(404);
		const body = await this.adminJson(request, ["runId"]);
		if (body instanceof Response) return body;
		if (typeof body.runId !== "string" || body.runId.length === 0 || body.runId.length > 128)
			return this.adminError();
		try {
			return Response.json(await this.#testControlStatus(control, body.runId, await control.status(body.runId)));
		} catch {
			return this.adminError(500);
		}
	}
	async #adminTestCleanup(request: Request): Promise<Response> {
		const control = this.#authorizedTestControl(request);
		if (!control) return this.adminError(404);
		if (this.#draining || this.#stopping) return this.adminError(503);
		const body = await this.adminJson(request, ["runId"]);
		if (body instanceof Response) return body;
		if (typeof body.runId !== "string" || body.runId.length === 0 || body.runId.length > 128)
			return this.adminError();
		const runId = body.runId;
		return this.#runTestControlMutation(async () => {
			try {
				const sessionIds = await control.sessionIds(runId);
				await this.#quiesceTestSessions(control, runId);
				const result = await control.cleanup(runId);
				for (const sessionId of sessionIds) await this.#evictTestSession(sessionId);
				await this.refreshSessions();
				return Response.json(await this.#testControlStatus(control, runId, result));
			} catch {
				return this.adminError(500);
			}
		});
	}
}
interface ServerWebSocketData {
	socket: Record<string, never>;
}
export function createAppserver(options: AppserverOptions = {}): LocalAppserver {
	return new LocalAppserver(options);
}
