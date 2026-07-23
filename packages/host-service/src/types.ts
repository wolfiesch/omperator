import type { ChildProcess } from "node:child_process";
import type {
	ClientFrame,
	CommandFrame,
	Cursor,
	DurableEntry,
	HelloFrame,
	HostId,
	PairStartFrame,
	ProjectId,
	Revision,
	ServerFrame,
	SessionEvent,
	SessionId,
	SessionRef,
	TranscriptContextArguments,
	TranscriptContextResult,
	TranscriptPageArguments,
	TranscriptPageResult,
	TranscriptSearchArguments,
	TranscriptSearchIndexStatus,
	TranscriptSearchResult,
	UsageReadResult,
} from "@t4-code/host-wire";
import type { DesktopOperationsAuthority } from "./operations/dispatcher.ts";
import type { BunRemoteListener } from "./remote/listener.ts";
import type {
	ListenerPeerContext,
	RemoteConnection,
	RemoteListenerConfig,
	RemotePeerIdentity,
} from "./remote/types.ts";
import type { RuntimeAdapterRegistry } from "./runtime-adapter.ts";
import type { RpcChildInvocation } from "./rpc-child.ts";
import type { WorkspaceAuthority } from "./workspace-authority.ts";

export interface ConnectionTransport {
	readonly connectionId: string;
	readonly deviceId: string;
	readonly remote: boolean;
	send(text: string): boolean;
	close(code?: number, reason?: string): void;
}
export interface RemoteHelloDecision {
	authenticated: boolean;
	grantedCapabilities?: readonly string[];
	grantedFeatures?: readonly string[];
	authentication?: string;
	deviceId?: string;
}
export interface RemoteAuthorizationContext {
	readonly connectionId: string;
	readonly peer: ListenerPeerContext;
	readonly command?: CommandFrame;
	readonly sessionRevision?: Revision;
}
export interface RemoteConnectionPolicy {
	/** Optional decoder used only by a policy-bound internal listener; public remote listeners retain the canonical wire decoder. */
	decodeClientFrame?(input: unknown): ClientFrame;
	authenticate(connection: RemoteConnection, hello: HelloFrame): RemoteHelloDecision | Promise<RemoteHelloDecision>;
	pairStart?(
		connection: RemoteConnection,
		frame: PairStartFrame,
	): ServerFrame | undefined | Promise<ServerFrame | undefined>;
	handleCommand?(
		connection: RemoteConnection,
		frame: CommandFrame,
	): ServerFrame | undefined | Promise<ServerFrame | undefined>;
	authorize(
		connection: RemoteConnection,
		frame: ClientFrame,
		context: RemoteAuthorizationContext,
	): boolean | Promise<boolean>;
	transformOutbound?(
		connection: RemoteConnection,
		frame: ServerFrame,
	): ServerFrame | string | undefined | Promise<ServerFrame | string | undefined>;
	isClosed?(connection: RemoteConnection): boolean;
	disconnected?(connection: RemoteConnection): void | Promise<void>;
}

export interface Clock {
	now(): Date;
}
export interface FileSystem {
	mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
	chmod(path: string, mode: number): Promise<void>;
	unlink(path: string): Promise<void>;
	stat(path: string): Promise<{
		isFile(): boolean;
		isDirectory(): boolean;
		mode: number;
		mtimeMs: number;
		size: number;
		ctimeMs?: number;
		dev?: number;
		ino?: number;
	}>;
	readdir(path: string): Promise<string[]>;
	readFile(path: string): Promise<string | Uint8Array>;
}
export interface SessionRecord {
	sessionId: SessionId;
	path: string;
	cwd: string;
	projectId: ProjectId;
	projectName?: string;
	title: string;
	updatedAt: string;
	status: SessionRef["status"];
	archivedAt?: string;
	model?: string;
	thinking?: string;
	runtime?: { readonly id: string; readonly workspaceInstanceId?: string };
	/** False when discovery intentionally deferred loading the transcript body. */
	entriesLoaded?: boolean;
	entries: DurableEntry[];
}
export interface SessionAuthoritySession {
	sessionId: SessionId;
	path: string;
	cwd: string;
	title?: string;
	entries: DurableEntry[];
}
export interface SessionAuthority {
	create(cwd: string, title?: string): Promise<SessionAuthoritySession>;
	list(): Promise<SessionRecord[]>;
	archive(session: SessionRecord, archivedAt: string): Promise<void>;
	restore(session: SessionRecord): Promise<void>;
	delete(session: SessionRecord): Promise<void>;
}
export interface SessionDiscovery {
	list(): Promise<SessionRecord[]>;
	/** Whether the most recent successful list proved the inventory complete. */
	inventoryComplete?(): boolean;
	/** Authoritative total for the most recent successful list, including omitted rows. */
	inventoryTotalCount?(): number;
	/** Load the bounded transcript snapshot for one lazily discovered session. */
	load?(session: SessionRecord): Promise<SessionRecord>;
	/** Read one bounded chronological page backward from the authoritative JSONL file. */
	page?(session: SessionRecord, args: TranscriptPageArguments): Promise<TranscriptPageResult>;
}
export interface ChildHandle {
	stdin: { write(data: string): Promise<void> | void };
	stderr?: AsyncIterable<string | Uint8Array>;
	stdout: AsyncIterable<string | Uint8Array>;
	exited: Promise<number>;
	kill(signal?: string): void;
}

export type SessionLockStatus = "missing" | "live" | "suspect" | "stale" | "malformed";
export type SessionLockInspector = (session: SessionRecord) => SessionLockStatus | Promise<SessionLockStatus>;
export type LockCheckHook = (session: SessionRecord) => Promise<void> | void;
export interface RpcChildFactory {
	spawn(spec: { session: SessionRecord; argv: string[]; cwd: string }): ChildHandle;
	argv(sessionPath: string): string[];
}
export interface AppserverAdminCallbacks {
	issuePairingTicket(
		capabilities: readonly string[],
		ttlMs?: number,
		expectedNodeId?: string,
	): { readonly code: string; readonly expiresAt: number };
	listDevices(): readonly {
		readonly deviceId: string;
		readonly label: string;
		readonly platform?: string;
		readonly capabilities: readonly string[];
		readonly createdAt: number;
		readonly lastSeenAt: number | null;
		readonly revokedAt: number | null;
	}[];
	revokeDevice(deviceId: string): { readonly revoked: true };
}
export interface AppserverUsageAuthority {
	read(signal: AbortSignal): Promise<UsageReadResult>;
}
export interface AppserverTranscriptSearchAuthority {
	initialize(): Promise<void>;
	reconcile(
		records: readonly SessionRecord[],
		options?: { readonly pruneMissing?: boolean },
	): Promise<TranscriptSearchIndexStatus>;
	search(
		args: TranscriptSearchArguments,
		signal: AbortSignal,
	): Promise<TranscriptSearchResult> | TranscriptSearchResult;
	context(
		sessionId: SessionId,
		args: TranscriptContextArguments,
		signal: AbortSignal,
	): Promise<TranscriptContextResult> | TranscriptContextResult;
	deleteSession(sessionId: SessionId): Promise<void> | void;
	close(): Promise<void> | void;
}
export interface AppserverTestSeedRequest {
	readonly runId: string;
	readonly projectRoot: string;
	readonly sessionCount: number;
	readonly historyEntries: number;
}
export interface AppserverTestControlStatus {
	readonly v: 1;
	readonly runId: string;
	readonly profile: string;
	readonly state: "seeded" | "clean";
	readonly sessions: { readonly seeded: number; readonly indexed: number };
	readonly locks: {
		readonly live: number;
		readonly suspect: number;
		readonly stale: number;
		readonly malformed: number;
	};
	readonly workers: {
		readonly supervisors: number;
		readonly starting: number;
		readonly pendingRpc: number;
	};
	readonly remainingFiles: number;
	readonly errors: readonly string[];
}
export interface AppserverTestControl {
	readonly token: string;
	sessionIds(runId: string): Promise<readonly SessionId[]>;
	seed(request: AppserverTestSeedRequest): Promise<AppserverTestControlStatus>;
	status(runId: string): Promise<AppserverTestControlStatus>;
	cleanup(runId: string): Promise<AppserverTestControlStatus>;
}

export interface AppserverOptions {
	hostId?: HostId;
	/** Persistent host identity path. Omitted to preserve the default OMP identity location. */
	hostIdPath?: string;
	/** Private latest-outcome ledger path. Defaults beside the persistent host identity unless hostId is explicit. */
	attentionOutcomePath?: string;
	/** Private profile-local ledger of exact sessions created through T4. */
	sessionOwnershipPath?: string;
	epoch?: string;
	clock?: Clock;
	discovery?: SessionDiscovery;
	sessionAuthority?: SessionAuthority;
	operationsAuthority?: DesktopOperationsAuthority;
	usageAuthority?: AppserverUsageAuthority;
	/** Rebuildable, profile-local index for bounded transcript search and read-around. */
	transcriptSearchAuthority?: AppserverTranscriptSearchAuthority;
	/** Maximum time allowed for one account-usage snapshot read. */
	usageReadTimeoutMs?: number;
	projectRootForProject?: (projectId: ProjectId) => Promise<string> | string;
	/** Host-native reveal action. Local transports only; absolute paths never cross the wire. */
	projectRevealer?: (root: string) => Promise<boolean> | boolean;
	/** Categorizes external ownership without weakening the write lock gate. */
	lockStatus?: SessionLockInspector;
	/** Final write-lock gate, retained for every child/lifecycle mutation. */ lockCheck?: LockCheckHook;
	/** Permit promotion of lockless transcripts only when their whole profile root is exclusively T4-owned. */
	claimLocklessSessions?: boolean;
	runtimeAdapters?: RuntimeAdapterRegistry;
	workspaceAuthority?: WorkspaceAuthority;
	workspaceTargetPathForProject?: (projectId: ProjectId, name: string) => Promise<string> | string;
	/** Runs after exclusive appserver ownership is acquired and before transports start. */
	onOwnerAcquired?: () => Promise<void> | void;
	socketPath?: string;
	ompVersion?: string;
	ompBuild?: string;
	childFactory?: RpcChildFactory;
	/** OMP RPC executable used when the host owns the generic child factory. */
	rpcChildInvocation?: RpcChildInvocation;
	/** Bounded profile environment applied only to per-session OMP children. */
	rpcChildEnvironment?: Readonly<Record<string, string>>;
	/** Exact child RPC command dialect; official OMP intentionally exposes a narrower command set. */
	rpcDialect?: "fork" | "official-17.0.9";
	appserverVersion?: string;
	appserverBuild?: string;
	supportedFeatures?: readonly string[];
	supportedCapabilities?: readonly string[];
	/** Absolute content-addressed blob root used for metadata-authorized transcript image reads. */
	transcriptImageRoot?: string;
	ringSize?: number;
	/** Maximum time lifecycle mutations wait for terminal and child shutdown. */
	lifecycleQuiesceTimeoutMs?: number;
	now?: () => Date;
	remoteEndpoint?: RemoteListenerConfig;
	remotePolicy?: RemoteConnectionPolicy;
	remoteResolver?: { resolve(address: string): Promise<RemotePeerIdentity> };
	remoteListener?: BunRemoteListener;
	admin?: AppserverAdminCallbacks;
	/** Local-UDS-only deterministic integration control. Omitted outside explicit test mode. */
	testControl?: AppserverTestControl;
}
export interface AppserverDrainBusy {
	readonly connections: number;
	readonly inflightMessages: number;
	readonly startingSupervisors: number;
	readonly lifecycleMutations: number;
	readonly sessionOperations: number;
	readonly activePrompts: number;
	readonly rpcSupervisorsWithPendingCalls: number;
	readonly busySessions: number;
	readonly openTerminalSessions: number;
	readonly pendingConfirmations: number;
	readonly outboundSends: number;
}
export interface AppserverDrainHealth {
	readonly ok: true;
	readonly hostId: HostId;
	readonly epoch: string;
}
export type AppserverDrainResult =
	| { readonly state: "draining"; readonly health: AppserverDrainHealth; readonly busy: AppserverDrainBusy }
	| { readonly state: "busy"; readonly health: AppserverDrainHealth; readonly busy: AppserverDrainBusy }
	| { readonly state: "identity_mismatch"; readonly health: AppserverDrainHealth; readonly busy: AppserverDrainBusy };
export interface Projection {
	hostId: HostId;
	sessionId: SessionId;
	revision: Revision;
	/** Cursor for attach replay of transcript entry/event frames. */
	cursor: Cursor;
	/** Independent cursor for host-wide session index deltas. */
	indexCursor: Cursor;
	entries: DurableEntry[];
	ref: SessionRef;
	/** Transcript entry/event replay ring; session.delta frames are never stored here. */
	ring: ServerFrame[];
}
export interface PreparedAttachOutput {
	/** Snapshot or replay frames built before a successful attach response can be emitted. */
	initialFrames: readonly ServerFrame[];
	/** Transcript cursor covered by the initial frames. */
	baseline: Cursor;
}
export interface CommandOutcome {
	frame: ServerFrame;
	/** Per-delivery attach output. finish() strips this bulk data before idempotency caching. */
	attachOutput?: PreparedAttachOutput;
	unknown?: boolean;
}
export interface AppserverHandle {
	readonly hostId: HostId;
	readonly epoch: string;
	readonly socketPath: string;
	start(): Promise<void>;
	stop(): Promise<void>;
	snapshot(sessionId: SessionId): Projection | undefined;
	replay(sessionId: SessionId, cursor: Cursor): ServerFrame[];
	childFor(sessionId: SessionId): ChildHandle | undefined;
}
export type {
	ChildProcess,
	CommandFrame,
	Cursor,
	DurableEntry,
	HostId,
	ProjectId,
	Revision,
	ServerFrame,
	SessionEvent,
	SessionId,
	SessionRef,
};
