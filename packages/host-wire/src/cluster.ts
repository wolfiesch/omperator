import { type Cursor, decodeCursor } from "./cursor.js";
import { fail } from "./errors.js";
import { boundedMap, controlFree, inputObject, safeSeq } from "./guards.js";
import { type HostId, hostId, type Revision, revision } from "./ids.js";
import { PROTOCOL_VERSION } from "./limits.js";

export const CLUSTER_OPERATOR_FEATURE = "cluster.operator" as const;
export const CI_TRIGGER_CAPABILITY = "ci.trigger" as const;
export const CLUSTER_MAX_WORKSPACES = 256;
export const CLUSTER_MAX_CONDITION_MESSAGE_BYTES = 2_048;
export const CLUSTER_MAX_REFERENCE_BYTES = 256;
export const CLUSTER_MAX_REPOSITORY_ID_BYTES = 128;

export const CLUSTER_CONDITION_STATUSES = ["True", "False", "Unknown"] as const;
export type ClusterConditionStatus = (typeof CLUSTER_CONDITION_STATUSES)[number];
export interface ClusterCondition {
	readonly type: string;
	readonly status: ClusterConditionStatus;
	readonly reason: string;
	readonly message: string;
	readonly observedGeneration: number;
}

export const WORKSPACE_PHASES = ["Pending", "Ready", "Failed", "Terminating", "Unknown"] as const;
export type WorkspacePhase = (typeof WORKSPACE_PHASES)[number];
export const WORKSPACE_RETENTION_POLICIES = ["Retain", "Delete"] as const;
export type WorkspaceRetentionPolicy = (typeof WORKSPACE_RETENTION_POLICIES)[number];
export interface WorkspaceInfrastructureProjection {
	readonly id: string;
	readonly displayName: string;
	readonly phase: WorkspacePhase;
	readonly retentionPolicy: WorkspaceRetentionPolicy;
	readonly storageClass?: string;
	readonly capacity?: string;
	readonly accessMode: "ReadWriteMany";
	readonly revision: Revision;
	readonly condition?: ClusterCondition;
}

interface WorkspaceStateBase {
	readonly v: typeof PROTOCOL_VERSION;
	readonly type: "workspace.state";
	readonly hostId: HostId;
	readonly workspaceId: string;
	readonly cursor: Cursor;
	readonly revision: Revision;
}
export interface WorkspaceStateUpsertFrame extends WorkspaceStateBase {
	readonly upsert: WorkspaceInfrastructureProjection;
	readonly remove?: never;
}
export interface WorkspaceStateRemoveFrame extends WorkspaceStateBase {
	readonly upsert?: never;
	readonly remove: string;
}
export type WorkspaceStateFrame = WorkspaceStateUpsertFrame | WorkspaceStateRemoveFrame;

export const SESSION_INFRASTRUCTURE_PHASES = ["Pending", "Running", "Failed", "Terminating", "Unknown"] as const;
export type SessionInfrastructurePhase = (typeof SESSION_INFRASTRUCTURE_PHASES)[number];
export const SESSION_GUI_STATES = ["Unavailable", "Starting", "Ready", "Failed"] as const;
export type SessionGuiState = (typeof SESSION_GUI_STATES)[number];
export interface SessionClusterState {
	readonly workspaceId: string;
	readonly phase: SessionInfrastructurePhase;
	readonly condition?: ClusterCondition;
	readonly gui: {
		readonly state: SessionGuiState;
		readonly previewId?: string;
		readonly reason?: string;
	};
}

export const CI_PIPELINE_STATUSES = ["queued", "running", "success", "failure", "killed", "unknown"] as const;
export type CiPipelineStatus = (typeof CI_PIPELINE_STATUSES)[number];
export interface SessionCiState {
	readonly provider: "woodpecker";
	readonly correlation: "exact" | "unknown";
	readonly repositoryId: string;
	readonly branch?: string;
	readonly ref: string;
	readonly commit: string;
	readonly pipelineNumber?: number;
	readonly status?: CiPipelineStatus;
	readonly currentStage?: string;
	readonly createdAt?: string;
	readonly startedAt?: string;
	readonly finishedAt?: string;
	readonly link?: string;
}

export interface LegacyWorkspaceResultItem {
	readonly repositoryId: string;
	readonly instanceId: string;
	readonly ownership: "managed" | "imported-user" | "detected-external" | "repository-root";
	readonly branch: string;
	readonly sourceCommit: string;
	readonly expectedHead: string;
	readonly lifecycle: "creating" | "active" | "archiving" | "archived" | "recovery-required";
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly archivedAt?: number;
}
export type WorkspaceListItem = LegacyWorkspaceResultItem | WorkspaceInfrastructureProjection;
export interface WorkspaceListResult {
	readonly workspaces: readonly WorkspaceListItem[];
	readonly cursor?: Cursor;
}

export interface ClusterRepositorySelection {
	readonly repositoryId: string;
	readonly ref?: string;
	readonly commit?: string;
}
export interface ClusterWorkspaceCreateArguments {
	readonly displayName: string;
	readonly retentionPolicy: WorkspaceRetentionPolicy;
	readonly capacity: string;
	readonly repository?: ClusterRepositorySelection;
}
export interface ClusterSessionCiSelection {
	readonly provider: "woodpecker";
	readonly repositoryId: string;
	readonly ref: string;
	readonly commit: string;
}
export interface ClusterSessionCreateArguments {
	readonly workspaceId: string;
	readonly title?: string;
	readonly runtimeProfile: string;
	readonly guiEnabled: boolean;
	readonly ci?: ClusterSessionCiSelection;
}
export interface CiRunArguments {
	readonly provider: "woodpecker";
	readonly action: "run";
	readonly repositoryId: string;
	readonly ref: string;
	readonly commit: string;
}
export interface CiRunResult {
	readonly triggered: boolean;
	readonly pipelineNumber?: number;
	readonly status?: CiPipelineStatus;
}

function exact(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
	const result = boundedMap(value, path);
	const allowed = new Set(keys);
	for (const key of Object.keys(result))
		if (!allowed.has(key)) fail("INVALID_FRAME", "unknown cluster field", `${path}.${key}`);
	return result;
}
function oneOf<const T extends readonly string[]>(value: unknown, path: string, values: T): T[number] {
	if (typeof value !== "string" || !(values as readonly string[]).includes(value)) fail("INVALID_FRAME", "unknown categorical state", path);
	return value as T[number];
}
function identifier(value: unknown, path: string, max = 256): string {
	const result = controlFree(value, path, max);
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(result)) fail("INVALID_FRAME", "invalid cluster identifier", path);
	return result;
}
function kubernetesName(value: unknown, path: string, max = 253): string {
	const result = controlFree(value, path, max);
	if (!/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/u.test(result)) fail("INVALID_FRAME", "invalid Kubernetes resource name", path);
	return result;
}
function runtimeProfile(value: unknown, path: string): string {
	const result = controlFree(value, path, 64);
	if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(result)) fail("INVALID_FRAME", "invalid runtime profile", path);
	return result;
}
function nonEmptyText(value: unknown, path: string, max: number): string {
	const result = controlFree(value, path, max);
	if (result.length === 0) fail("INVALID_FRAME", "value must not be empty", path);
	return result;
}
function repositoryId(value: unknown, path: string): string {
	const result = nonEmptyText(value, path, CLUSTER_MAX_REPOSITORY_ID_BYTES);
	if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(result) || result.includes("..") || result.includes("://"))
		fail("INVALID_FRAME", "invalid repository identifier", path);
	return result;
}
function reference(value: unknown, path: string): string {
	return nonEmptyText(value, path, CLUSTER_MAX_REFERENCE_BYTES);
}
function commit(value: unknown, path: string): string {
	const result = nonEmptyText(value, path, 64);
	if (!/^[0-9a-fA-F]{7,64}$/u.test(result)) fail("INVALID_FRAME", "commit must be 7 to 64 hexadecimal characters", path);
	return result;
}
function quantity(value: unknown, path: string): string {
	const result = nonEmptyText(value, path, 32);
	if (!/^[1-9][0-9]*(?:Ei|Pi|Ti|Gi|Mi|Ki|E|P|T|G|M|K)$/u.test(result)) fail("INVALID_FRAME", "invalid positive Kubernetes storage quantity", path);
	return result;
}
function canonicalTimestamp(value: unknown, path: string): string {
	const result = controlFree(value, path, 128);
	const milliseconds = Date.parse(result);
	if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== result)
		fail("INVALID_FRAME", "timestamp must be canonical ISO", path);
	return result;
}
function httpsUrl(value: unknown, path: string): string {
	const text = controlFree(value, path, 2_048);
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		fail("INVALID_FRAME", "invalid HTTPS URL", path);
	}
	if (url!.protocol !== "https:" || url!.username || url!.password)
		fail("INVALID_FRAME", "URL must use HTTPS without credentials", path);
	return url!.href;
}

export function decodeClusterCondition(value: unknown, path = "condition"): ClusterCondition {
	const input = exact(value, path, ["type", "status", "reason", "message", "observedGeneration"]);
	return {
		type: identifier(input.type, `${path}.type`, 128),
		status: oneOf(input.status, `${path}.status`, CLUSTER_CONDITION_STATUSES),
		reason: identifier(input.reason, `${path}.reason`, 128),
		message: controlFree(input.message, `${path}.message`, CLUSTER_MAX_CONDITION_MESSAGE_BYTES),
		observedGeneration: safeSeq(input.observedGeneration, `${path}.observedGeneration`),
	};
}

export function decodeWorkspaceInfrastructureProjection(
	value: unknown,
	path = "workspace",
): WorkspaceInfrastructureProjection {
	const input = exact(value, path, [
		"id", "displayName", "phase", "retentionPolicy", "storageClass", "capacity", "accessMode", "revision", "condition",
	]);
	const currentRevision = revision(input.revision, `${path}.revision`);
	if (input.accessMode !== "ReadWriteMany") fail("INVALID_FRAME", "workspace access mode must be ReadWriteMany", `${path}.accessMode`);
	return {
		id: kubernetesName(input.id, `${path}.id`),
		displayName: nonEmptyText(input.displayName, `${path}.displayName`, 128),
		phase: oneOf(input.phase, `${path}.phase`, WORKSPACE_PHASES),
		retentionPolicy: oneOf(input.retentionPolicy, `${path}.retentionPolicy`, WORKSPACE_RETENTION_POLICIES),
		...(input.storageClass === undefined ? {} : { storageClass: kubernetesName(input.storageClass, `${path}.storageClass`, 63) }),
		...(input.capacity === undefined ? {} : { capacity: quantity(input.capacity, `${path}.capacity`) }),
		accessMode: "ReadWriteMany",
		revision: currentRevision,
		...(input.condition === undefined ? {} : { condition: decodeClusterCondition(input.condition, `${path}.condition`) }),
	};
}

export function decodeWorkspaceState(value: unknown): WorkspaceStateFrame {
	const input = inputObject(value);
	if (input.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
	if (input.type !== "workspace.state") fail("INVALID_FRAME", "expected workspace.state frame", "type");
	const keys = ["v", "type", "hostId", "workspaceId", "cursor", "revision", "upsert", "remove"];
	for (const key of Object.keys(input)) if (!keys.includes(key)) fail("INVALID_FRAME", "unknown workspace state field", key);
	const host = hostId(input.hostId);
	const workspace = identifier(input.workspaceId, "workspaceId");
	const cursor = decodeCursor(input.cursor);
	const currentRevision = revision(input.revision);
	if ((input.upsert === undefined) === (input.remove === undefined))
		fail("INVALID_FRAME", "workspace state requires exactly one upsert or remove", "frame");
	if (input.upsert !== undefined) {
		const upsert = decodeWorkspaceInfrastructureProjection(input.upsert, "upsert");
		if (upsert.id !== workspace || upsert.revision !== currentRevision)
			fail("INVALID_FRAME", "workspace state address mismatch", "upsert");
		return { v: PROTOCOL_VERSION, type: "workspace.state", hostId: host, workspaceId: workspace, cursor, revision: currentRevision, upsert };
	}
	if (input.remove !== workspace) fail("INVALID_FRAME", "workspace removal must match workspaceId", "remove");
	return { v: PROTOCOL_VERSION, type: "workspace.state", hostId: host, workspaceId: workspace, cursor, revision: currentRevision, remove: workspace };
}

export function decodeSessionClusterState(value: unknown, path = "cluster"): SessionClusterState {
	const input = exact(value, path, ["workspaceId", "phase", "condition", "gui"]);
	const gui = exact(input.gui, `${path}.gui`, ["state", "previewId", "reason"]);
	return {
		workspaceId: identifier(input.workspaceId, `${path}.workspaceId`),
		phase: oneOf(input.phase, `${path}.phase`, SESSION_INFRASTRUCTURE_PHASES),
		...(input.condition === undefined ? {} : { condition: decodeClusterCondition(input.condition, `${path}.condition`) }),
		gui: {
			state: oneOf(gui.state, `${path}.gui.state`, SESSION_GUI_STATES),
			...(gui.previewId === undefined ? {} : { previewId: identifier(gui.previewId, `${path}.gui.previewId`) }),
			...(gui.reason === undefined ? {} : { reason: controlFree(gui.reason, `${path}.gui.reason`, 512) }),
		},
	};
}

export function decodeSessionCiState(value: unknown, path = "ci"): SessionCiState {
	const input = exact(value, path, [
		"provider", "correlation", "repositoryId", "branch", "ref", "commit", "pipelineNumber", "status", "currentStage",
		"createdAt", "startedAt", "finishedAt", "link",
	]);
	if (input.provider !== "woodpecker") fail("INVALID_FRAME", "unknown CI provider", `${path}.provider`);
	if (input.correlation !== "exact" && input.correlation !== "unknown")
		fail("INVALID_FRAME", "unknown CI correlation", `${path}.correlation`);
	const output: SessionCiState = {
		provider: "woodpecker",
		correlation: input.correlation,
		repositoryId: repositoryId(input.repositoryId, `${path}.repositoryId`),
		...(input.branch === undefined ? {} : { branch: reference(input.branch, `${path}.branch`) }),
		ref: reference(input.ref, `${path}.ref`),
		commit: reference(input.commit, `${path}.commit`),
		...(input.pipelineNumber === undefined ? {} : { pipelineNumber: safeSeq(input.pipelineNumber, `${path}.pipelineNumber`) }),
		...(input.status === undefined ? {} : { status: oneOf(input.status, `${path}.status`, CI_PIPELINE_STATUSES) }),
		...(input.currentStage === undefined ? {} : { currentStage: controlFree(input.currentStage, `${path}.currentStage`, 256) }),
		...(input.createdAt === undefined ? {} : { createdAt: canonicalTimestamp(input.createdAt, `${path}.createdAt`) }),
		...(input.startedAt === undefined ? {} : { startedAt: canonicalTimestamp(input.startedAt, `${path}.startedAt`) }),
		...(input.finishedAt === undefined ? {} : { finishedAt: canonicalTimestamp(input.finishedAt, `${path}.finishedAt`) }),
		...(input.link === undefined ? {} : { link: httpsUrl(input.link, `${path}.link`) }),
	};
	if (
		output.correlation === "unknown" &&
		(output.pipelineNumber !== undefined || output.status !== undefined || output.currentStage !== undefined ||
			output.createdAt !== undefined || output.startedAt !== undefined || output.finishedAt !== undefined || output.link !== undefined)
	)
		fail("INVALID_FRAME", "unknown CI correlation cannot carry pipeline state", path);
	return output;
}

function decodeRepository(value: unknown, path: string, requireRefCommit: boolean): ClusterRepositorySelection {
	const input = exact(value, path, ["repositoryId", "ref", "commit"]);
	if (requireRefCommit && (input.ref === undefined || input.commit === undefined))
		fail("INVALID_FRAME", "CI repository requires ref and commit", path);
	if (input.commit !== undefined && input.ref === undefined)
		fail("INVALID_FRAME", "repository commit requires an explicit ref", path);
	return {
		repositoryId: repositoryId(input.repositoryId, `${path}.repositoryId`),
		...(input.ref === undefined ? {} : { ref: reference(input.ref, `${path}.ref`) }),
		...(input.commit === undefined ? {} : { commit: commit(input.commit, `${path}.commit`) }),
	};
}

export function decodeClusterWorkspaceCreateArguments(value: unknown): ClusterWorkspaceCreateArguments {
	const input = exact(value, "args", ["displayName", "retentionPolicy", "capacity", "repository"]);
	return {
		displayName: nonEmptyText(input.displayName, "args.displayName", 128),
		retentionPolicy: oneOf(input.retentionPolicy, "args.retentionPolicy", WORKSPACE_RETENTION_POLICIES),
		capacity: quantity(input.capacity, "args.capacity"),
		...(input.repository === undefined ? {} : { repository: decodeRepository(input.repository, "args.repository", false) }),
	};
}

export function decodeClusterSessionCreateArguments(value: unknown): ClusterSessionCreateArguments {
	const input = exact(value, "args", ["workspaceId", "title", "runtimeProfile", "guiEnabled", "ci"]);
	let ci: ClusterSessionCiSelection | undefined;
	if (input.ci !== undefined) {
		const raw = exact(input.ci, "args.ci", ["provider", "repositoryId", "ref", "commit"]);
		if (raw.provider !== "woodpecker") fail("INVALID_FRAME", "unknown CI provider", "args.ci.provider");
		const repository = decodeRepository({ repositoryId: raw.repositoryId, ref: raw.ref, commit: raw.commit }, "args.ci", true);
		ci = { provider: "woodpecker", repositoryId: repository.repositoryId, ref: repository.ref!, commit: repository.commit! };
	}
	if (typeof input.guiEnabled !== "boolean") fail("INVALID_FRAME", "guiEnabled must be boolean", "args.guiEnabled");
	return {
		workspaceId: kubernetesName(input.workspaceId, "args.workspaceId"),
		...(input.title === undefined ? {} : { title: nonEmptyText(input.title, "args.title", 128) }),
		runtimeProfile: runtimeProfile(input.runtimeProfile, "args.runtimeProfile"),
		guiEnabled: input.guiEnabled,
		...(ci === undefined ? {} : { ci }),
	};
}

export function decodeCiRunArguments(value: unknown): CiRunArguments {
	const input = exact(value, "args", ["provider", "action", "repositoryId", "ref", "commit"]);
	if (input.provider !== "woodpecker") fail("INVALID_FRAME", "unknown CI provider", "args.provider");
	if (input.action !== "run") fail("INVALID_FRAME", "unknown CI action", "args.action");
	return {
		provider: "woodpecker",
		action: "run",
		repositoryId: repositoryId(input.repositoryId, "args.repositoryId"),
		ref: reference(input.ref, "args.ref"),
		commit: commit(input.commit, "args.commit"),
	};
}

export function decodeCiRunResult(value: unknown): CiRunResult {
	const input = exact(value, "result", ["triggered", "pipelineNumber", "status"]);
	if (typeof input.triggered !== "boolean") fail("INVALID_FRAME", "triggered must be boolean", "result.triggered");
	return {
		triggered: input.triggered,
		...(input.pipelineNumber === undefined ? {} : { pipelineNumber: safeSeq(input.pipelineNumber, "result.pipelineNumber") }),
		...(input.status === undefined ? {} : { status: oneOf(input.status, "result.status", CI_PIPELINE_STATUSES) }),
	};
}
