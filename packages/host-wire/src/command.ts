import {
	decodeAuditEvent,
	decodeCatalogItem,
	decodeOperationCapability,
	decodeFileListEntry,
	decodePreviewSnapshot,
	PREVIEW_ACTIONS,
	type PreviewAction,
	type PreviewSnapshot,
} from "./additive.js";
import {
	decodeCiRunArguments,
	decodeCiRunResult,
	decodeClusterSessionCreateArguments,
	decodeClusterWorkspaceCreateArguments,
	decodeWorkspaceInfrastructureProjection,
} from "./cluster.js";
import { decodeBrokerStatusResult } from "./broker.js";
import type { DeviceCapability } from "./capabilities.js";
import { decodeCursor } from "./cursor.js";
import { fail } from "./errors.js";
import { decodeTurnReviewSnapshot } from "./files-review.js";
import {
	boundedArray,
	boundedBase64,
	boundedMap,
	boundedMetadata,
	boundedSettings,
	boundedText,
	controlFree,
	finiteNumber,
	inputObject,
	isSecretLikeKey,
	safeRelativePath,
	safeSeq,
} from "./guards.js";
import {
	type ArtifactId,
	artifactId,
	type CommandId,
	type ConfirmationId,
	commandId,
	confirmationId,
	type EntryId,
	entryId,
	type HostId,
	hostId,
	type ImageId,
	imageId,
	type LeaseId,
	leaseId,
	type PreviewCaptureId,
	type PreviewId,
	previewCaptureId,
	previewId,
	projectId,
	type RequestId,
	type Revision,
	requestId,
	revision,
	type SessionId,
	sessionId,
	type TurnId,
	terminalId,
	turnId,
} from "./ids.js";
import {
	ARTIFACT_CHUNK_BASE64_BYTES,
	ARTIFACT_CHUNK_BYTES,
	ARTIFACT_MAX_BYTES,
	IMAGE_UPLOAD_CHUNK_BASE64_BYTES,
	IMAGE_UPLOAD_CHUNK_BYTES,
	IMAGE_UPLOAD_MAX_BYTES,
	MAX_FILE_BYTES,
	MAX_STRING_BYTES,
	PREVIEW_CAPTURE_CHUNK_BYTES,
	PREVIEW_CAPTURE_MAX_BYTES,
	PREVIEW_HANDOFF_MESSAGE_BYTES,
	PREVIEW_HANDOFF_TIMEOUT_MAX_MS,
	PREVIEW_LEASE_TTL_MAX_MS,
	PREVIEW_MAX_PER_SESSION,
	PREVIEW_SCROLL_DELTA_LIMIT,
	PREVIEW_SELECTOR_BYTES,
	PREVIEW_TEXT_INPUT_BYTES,
	PROMPT_IMAGE_MAX_COUNT,
	PROTOCOL_VERSION,
	TRANSCRIPT_IMAGE_CHUNK_BASE64_BYTES,
	TRANSCRIPT_IMAGE_CHUNK_BYTES,
	TRANSCRIPT_IMAGE_MAX_BYTES,
} from "./limits.js";
import { decodeSessionListResult, decodeSessionRef, type SessionListResult } from "./session-index.js";
import { decodeSessionStateResult } from "./session-state.js";
import {
	decodeProjectFileSearchArguments,
	decodeProjectFileSearchResult,
} from "./project-file-search.js";
import {
	decodeTranscriptContextArguments,
	decodeTranscriptContextResult,
	decodeTranscriptSearchArguments,
	decodeTranscriptSearchResult,
} from "./transcript-search.js";
import { decodeTranscriptPageArguments, decodeTranscriptPageResult } from "./transcript-page.js";
import { decodeUsageReadResult } from "./usage.js";
export type RevisionOwner = "none" | "session" | "authority";
export interface CommandDescriptor {
	capability: DeviceCapability;
	scope: "host" | "session";
	revision: "none" | "optional" | "required";
	revisionOwner: RevisionOwner;
	confirmation: "none" | "challenge";
	desktopCatalog?: true;
}
export const COMMAND_DESCRIPTORS: Readonly<Record<string, CommandDescriptor>> = {
	"runtime.list": {
		capability: "sessions.read",
		scope: "host",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	},
	"workspace.list": {
		capability: "sessions.read",
		scope: "host",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	},
	"workspace.create": {
		capability: "sessions.manage",
		scope: "host",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	},
	"workspace.import": {
		capability: "sessions.manage",
		scope: "host",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	},
	"workspace.archive": {
		capability: "sessions.manage",
		scope: "host",
		revision: "none",
		revisionOwner: "none",
		confirmation: "challenge",
	},
	"workspace.recover": {
		capability: "sessions.manage",
		scope: "host",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	},
	"host.list": {
		capability: "sessions.read",
		scope: "host",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	},
	"session.list": {
		capability: "sessions.read",
		scope: "host",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	},
	"transcript.search": {
		capability: "sessions.read",
		scope: "host",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	},
	"transcript.context": {
		capability: "sessions.read",
		scope: "session",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	},
	"transcript.page": {
		capability: "sessions.read",
		scope: "session",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	},
	"project.reveal": {
		capability: "sessions.manage",
		scope: "host",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
		desktopCatalog: true,
	},
	"session.create": {
		capability: "sessions.manage",
		scope: "host",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
		desktopCatalog: true,
	},
	"session.attach": {
		capability: "sessions.read",
		scope: "session",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	},
	"session.prompt": {
		capability: "sessions.prompt",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "none",
	},
	"session.image.begin": {
		capability: "sessions.prompt",
		scope: "session",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	},
	"session.image.chunk": {
		capability: "sessions.prompt",
		scope: "session",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	},
	"session.image.discard": {
		capability: "sessions.prompt",
		scope: "session",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	},
	"session.image.read": {
		capability: "sessions.read",
		scope: "session",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	},
	"artifact.read": {
		capability: "sessions.read",
		scope: "session",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	},
	"session.state.get": {
		capability: "sessions.read",
		scope: "session",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	},
	"session.steer": {
		capability: "sessions.prompt",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "none",
	},
	"session.followUp": {
		capability: "sessions.prompt",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "none",
	},
	"session.rename": {
		capability: "sessions.manage",
		scope: "session",
		revision: "required",
		revisionOwner: "session",
		confirmation: "none",
		desktopCatalog: true,
	},
	"session.retry": {
		capability: "sessions.control",
		scope: "session",
		revision: "required",
		revisionOwner: "session",
		confirmation: "none",
	},
	"session.compact": {
		capability: "sessions.control",
		scope: "session",
		revision: "required",
		revisionOwner: "session",
		confirmation: "none",
	},
	"session.pause": {
		capability: "sessions.control",
		scope: "session",
		revision: "required",
		revisionOwner: "session",
		confirmation: "none",
	},
	"session.resume": {
		capability: "sessions.control",
		scope: "session",
		revision: "required",
		revisionOwner: "session",
		confirmation: "none",
	},
	"session.archive": {
		capability: "sessions.manage",
		scope: "session",
		revision: "required",
		revisionOwner: "session",
		confirmation: "none",
		desktopCatalog: true,
	},
	"session.restore": {
		capability: "sessions.manage",
		scope: "session",
		revision: "required",
		revisionOwner: "session",
		confirmation: "none",
		desktopCatalog: true,
	},
	"session.delete": {
		capability: "sessions.manage",
		scope: "session",
		revision: "required",
		revisionOwner: "session",
		confirmation: "challenge",
		desktopCatalog: true,
	},
	"session.model.set": {
		capability: "sessions.manage",
		scope: "session",
		revision: "required",
		revisionOwner: "session",
		confirmation: "none",
		desktopCatalog: true,
	},
	"session.thinking.set": {
		capability: "sessions.manage",
		scope: "session",
		revision: "required",
		revisionOwner: "session",
		confirmation: "none",
		desktopCatalog: true,
	},
	"session.fast.set": {
		capability: "sessions.manage",
		scope: "session",
		revision: "required",
		revisionOwner: "session",
		confirmation: "none",
		desktopCatalog: true,
	},
	"session.ui.respond": {
		capability: "sessions.prompt",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "none",
	},
	"session.cancel": {
		capability: "sessions.control",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "challenge",
		desktopCatalog: true,
	},
	"session.close": {
		capability: "sessions.manage",
		scope: "session",
		revision: "required",
		revisionOwner: "session",
		confirmation: "challenge",
		desktopCatalog: true,
	},
	"files.read": {
		capability: "files.read",
		scope: "session",
		revision: "optional",
		revisionOwner: "authority",
		confirmation: "none",
	},
	"files.write": {
		capability: "files.write",
		scope: "session",
		revision: "required",
		revisionOwner: "authority",
		confirmation: "challenge",
	},
	"files.patch": {
		capability: "files.write",
		scope: "session",
		revision: "required",
		revisionOwner: "authority",
		confirmation: "challenge",
	},
	"files.list": {
		capability: "files.list",
		scope: "session",
		revision: "optional",
		revisionOwner: "authority",
		confirmation: "none",
	},
	"files.search": {
		capability: "files.list",
		scope: "session",
		revision: "optional",
		revisionOwner: "authority",
		confirmation: "none",
	},
	"files.diff": {
		capability: "files.diff",
		scope: "session",
		revision: "optional",
		revisionOwner: "authority",
		confirmation: "none",
	},
	"review.read": {
		capability: "files.read",
		scope: "session",
		revision: "optional",
		revisionOwner: "authority",
		confirmation: "none",
	},
	"review.apply": {
		capability: "files.write",
		scope: "session",
		revision: "required",
		revisionOwner: "authority",
		confirmation: "challenge",
	},
	"agent.cancel": {
		capability: "agents.control",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "challenge",
	},
	"bash.run": {
		capability: "bash.run",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "challenge",
	},
	"term.open": {
		capability: "term.open",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "challenge",
	},
	"audit.read": {
		capability: "audit.read",
		scope: "host",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	},
	"audit.tail": {
		capability: "audit.read",
		scope: "host",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	},
	"config.write": {
		capability: "config.write",
		scope: "host",
		revision: "required",
		revisionOwner: "authority",
		confirmation: "challenge",
	},
	"settings.read": {
		capability: "config.read",
		scope: "host",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	},
	"settings.write": {
		capability: "config.write",
		scope: "host",
		revision: "required",
		revisionOwner: "authority",
		confirmation: "challenge",
	},
	"catalog.get": {
		capability: "catalog.read",
		scope: "host",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	},
	"broker.status": {
		capability: "broker.read",
		scope: "host",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
		desktopCatalog: true,
	},
	"usage.read": {
		capability: "usage.read",
		scope: "host",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
		desktopCatalog: true,
	},
	"host.watch": {
		capability: "sessions.read",
		scope: "host",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	},
	"session.watch": {
		capability: "sessions.read",
		scope: "session",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	},
	"controller.lease.acquire": {
		capability: "sessions.control",
		scope: "session",
		revision: "required",
		revisionOwner: "session",
		confirmation: "none",
	},
	"controller.lease.renew": {
		capability: "sessions.control",
		scope: "session",
		revision: "required",
		revisionOwner: "session",
		confirmation: "none",
	},
	"controller.lease.release": {
		capability: "sessions.control",
		scope: "session",
		revision: "required",
		revisionOwner: "session",
		confirmation: "none",
	},
	"prompt.lease.acquire": {
		capability: "sessions.prompt",
		scope: "session",
		revision: "required",
		revisionOwner: "session",
		confirmation: "none",
	},
	"prompt.lease.renew": {
		capability: "sessions.prompt",
		scope: "session",
		revision: "required",
		revisionOwner: "session",
		confirmation: "none",
	},
	"prompt.lease.release": {
		capability: "sessions.prompt",
		scope: "session",
		revision: "required",
		revisionOwner: "session",
		confirmation: "none",
	},
	"preview.launch": {
		capability: "preview.control",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "challenge",
	},
	"preview.state": {
		capability: "preview.read",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "none",
	},
	"preview.activate": {
		capability: "preview.control",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "none",
	},
	"preview.navigate": {
		capability: "preview.control",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "challenge",
	},
	"preview.back": {
		capability: "preview.control",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "none",
	},
	"preview.forward": {
		capability: "preview.control",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "none",
	},
	"preview.reload": {
		capability: "preview.control",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "none",
	},
	"preview.close": {
		capability: "preview.control",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "none",
	},
	"preview.capture": {
		capability: "preview.read",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "none",
	},
	"preview.capture.read": {
		capability: "preview.read",
		scope: "session",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	},
	"preview.click": {
		capability: "preview.input",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "none",
	},
	"preview.fill": {
		capability: "preview.input",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "none",
	},
	"preview.scroll": {
		capability: "preview.input",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "none",
	},
	"preview.type": {
		capability: "preview.input",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "none",
	},
	"preview.select": {
		capability: "preview.input",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "none",
	},
	"preview.press": {
		capability: "preview.input",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "none",
	},
	"preview.upload": {
		capability: "preview.input",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "challenge",
	},
	"preview.policy.check": {
		capability: "preview.read",
		scope: "session",
		revision: "none",
		revisionOwner: "none",
		confirmation: "none",
	},
	"preview.lease.acquire": {
		capability: "preview.control",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "none",
	},
	"preview.lease.renew": {
		capability: "preview.control",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "none",
	},
	"preview.lease.release": {
		capability: "preview.control",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "none",
	},
	"preview.handoff": {
		capability: "preview.control",
		scope: "session",
		revision: "optional",
		revisionOwner: "session",
		confirmation: "none",
	},
	"ci.run": {
		capability: "ci.trigger",
		scope: "session",
		revision: "required",
		revisionOwner: "session",
		confirmation: "none",
	},
};
export const DESKTOP_CATALOG_COMMANDS: readonly string[] = Object.freeze(
	Object.entries(COMMAND_DESCRIPTORS)
		.filter(([, descriptor]) => descriptor.desktopCatalog === true)
		.map(([name]) => name),
);
export const COMMAND_CAPABILITIES: Readonly<Record<string, DeviceCapability>> = Object.fromEntries(
	Object.entries(COMMAND_DESCRIPTORS).map(([name, descriptor]) => [name, descriptor.capability]),
);
export interface CommandFrame {
	v: typeof PROTOCOL_VERSION;
	type: "command";
	requestId: RequestId;
	commandId: CommandId;
	hostId: HostId;
	sessionId?: SessionId;
	command: string;
	expectedRevision?: Revision;
	confirmationId?: ConfirmationId;
	args: Record<string, unknown>;
}
export interface SessionPromptArguments {
	readonly message: string;
	readonly leaseId?: LeaseId;
	readonly images?: readonly PromptImageReference[];
}
export const PROMPT_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type PromptImageMimeType = (typeof PROMPT_IMAGE_MIME_TYPES)[number];
export interface PromptImageReference {
	readonly imageId: ImageId;
}
export interface SessionImageBeginArguments {
	readonly mimeType: PromptImageMimeType;
	readonly size: number;
	readonly sha256: string;
}
export interface SessionImageChunkArguments {
	readonly imageId: ImageId;
	readonly offset: number;
	readonly content: string;
}
export interface SessionImageDiscardArguments {
	readonly imageId: ImageId;
}
export interface SessionImageReadArguments {
	readonly entryId: EntryId;
	readonly sha256: string;
	readonly offset: number;
}
export interface SessionImageReadResult {
	readonly sha256: string;
	readonly mimeType: PromptImageMimeType;
	readonly size: number;
	readonly offset: number;
	readonly nextOffset: number;
	readonly complete: boolean;
	readonly content: string;
}
export interface ArtifactReadArguments {
	readonly artifactId: ArtifactId;
	readonly offset: number;
}
export interface ArtifactReadChunk {
	readonly artifactId: ArtifactId;
	readonly kind: "image" | "text" | "patch" | "binary";
	readonly mediaType: string;
	readonly size: number;
	readonly offset: number;
	readonly nextOffset: number;
	readonly complete: boolean;
	readonly content: string;
}
export type ArtifactReadResult = ArtifactReadChunk;
export interface TurnReviewApplyArguments {
	readonly turnId: TurnId;
	readonly path: string;
	readonly action: "keep" | "discard";
}
export interface TurnReviewApplyResult extends TurnReviewApplyArguments {
	readonly state: "applied" | "discarded";
	readonly resultingRevision: string;
}
export interface PreviewLaunchArguments {
	readonly url: string;
	readonly authorityId?: string;
}
export interface PreviewTargetArguments {
	readonly previewId: PreviewId;
	readonly leaseId?: LeaseId;
}
export interface PreviewClickArguments extends PreviewTargetArguments {
	readonly x?: number;
	readonly y?: number;
	readonly selector?: string;
	readonly button?: "left" | "middle" | "right";
	readonly clickCount?: number;
}
export interface PreviewScrollArguments extends PreviewTargetArguments {
	readonly deltaX: number;
	readonly deltaY: number;
	readonly selector?: string;
}
export interface PreviewTypeArguments extends PreviewTargetArguments {
	readonly text: string;
	readonly selector?: string;
}
export interface PreviewFillArguments extends PreviewTargetArguments {
	readonly text: string;
	readonly selector?: string;
}
export interface PreviewSelectArguments extends PreviewTargetArguments {
	readonly selector: string;
	readonly value: string;
}
export interface PreviewUploadArguments extends PreviewTargetArguments {
	readonly selector: string;
	readonly path: string;
}
export interface PreviewPressArguments extends PreviewTargetArguments {
	readonly key: string;
}
export interface PreviewCaptureReadArguments extends PreviewTargetArguments {
	readonly captureId: PreviewCaptureId;
	readonly offset: number;
}
export interface PreviewPolicyCheckArguments {
	readonly action: PreviewAction;
	readonly previewId?: PreviewId;
	readonly url?: string;
	readonly authorityId?: string;
}
export interface PreviewLeaseAcquireArguments {
	readonly previewId: PreviewId;
	readonly ttlMs?: number;
}
export interface PreviewLeaseRenewArguments {
	readonly previewId: PreviewId;
	readonly leaseId: LeaseId;
	readonly ttlMs?: number;
}
export interface PreviewLeaseReleaseArguments {
	readonly previewId: PreviewId;
	readonly leaseId: LeaseId;
}
export type PreviewHandoffMode = "manual" | "selector" | "url" | "text";
export interface PreviewHandoffArguments extends PreviewTargetArguments {
	readonly message: string;
	readonly mode?: PreviewHandoffMode;
	readonly selector?: string;
	readonly urlSubstring?: string;
	readonly text?: string;
	readonly timeoutMs?: number;
}
export interface PreviewStateResult {
	readonly previews: readonly PreviewSnapshot[];
}
export interface PreviewMutationResult {
	readonly preview: PreviewSnapshot;
}
export interface PreviewPolicyCheckResult {
	readonly allowed: boolean;
	readonly confirmationRequired: boolean;
	readonly reason?: string;
}
export interface PreviewLeaseResult {
	readonly previewId: PreviewId;
	readonly leaseId: LeaseId;
	readonly expiresAt: number;
}
export interface PreviewLeaseReleaseResult {
	readonly previewId: PreviewId;
	readonly released: boolean;
}
export interface PreviewCaptureReadResult {
	readonly previewId: PreviewId;
	readonly captureId: PreviewCaptureId;
	readonly size: number;
	readonly offset: number;
	readonly nextOffset: number;
	readonly complete: boolean;
	readonly content: string;
}
export function validateCommandDescriptor(command: string, descriptor: CommandDescriptor): void {
	const validRevision =
		descriptor.revision === "none" || descriptor.revision === "optional" || descriptor.revision === "required";
	const validOwner =
		descriptor.revisionOwner === "none" ||
		descriptor.revisionOwner === "session" ||
		descriptor.revisionOwner === "authority";
	const ownerMatchesRevision =
		descriptor.revision === "none" ? descriptor.revisionOwner === "none" : descriptor.revisionOwner !== "none";
	if (!validRevision || !validOwner || !ownerMatchesRevision)
		fail("INVALID_FRAME", "invalid command revision descriptor", `command.${command}`);
}
for (const [command, descriptor] of Object.entries(COMMAND_DESCRIPTORS)) validateCommandDescriptor(command, descriptor);
export function decodeCommand(input: unknown): CommandFrame {
	const frame = inputObject(input);
	if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
	if (frame.type !== "command") fail("INVALID_FRAME", "expected command frame", "type");
	requestId(frame.requestId);
	commandId(frame.commandId);
	const host = hostId(frame.hostId);
	const command = controlFree(frame.command, "command", 128);
	const descriptor = COMMAND_DESCRIPTORS[command];
	if (descriptor === undefined) fail("INVALID_FRAME", "unknown command", "command");
	validateCommandDescriptor(command, descriptor);
	const session = frame.sessionId === undefined ? undefined : sessionId(frame.sessionId);
	if (descriptor.scope === "session" && session === undefined)
		fail("INVALID_FRAME", "sessionId is required for session command", "sessionId");
	if (descriptor.scope === "host" && session !== undefined)
		fail("INVALID_FRAME", "sessionId is forbidden for host command", "sessionId");
	if (descriptor.revision === "none" && frame.expectedRevision !== undefined)
		fail("STALE_REVISION", "expectedRevision is forbidden", "expectedRevision");
	if (descriptor.revision === "required" && frame.expectedRevision === undefined)
		fail("STALE_REVISION", "expectedRevision is required", "expectedRevision");
	if (frame.expectedRevision !== undefined) revision(frame.expectedRevision);
	if (descriptor.confirmation === "none" && frame.confirmationId !== undefined)
		fail("CONFIRMATION_INVALID", "confirmationId is not valid", "confirmationId");
	if (frame.confirmationId !== undefined) confirmationId(frame.confirmationId);
	const args = decodeCommandArguments(command, frame.args === undefined ? {} : frame.args);
	return { ...frame, hostId: host, sessionId: session, command, args } as unknown as CommandFrame;
}
export function requiredCapability(command: string): DeviceCapability | undefined {
	return COMMAND_DESCRIPTORS[command]?.capability;
}
export type CommandArguments = Record<string, unknown>;
export type CommandResult = Record<string, unknown>;
function args(value: unknown, path = "args"): Record<string, unknown> {
	return boundedMap(value, path);
}
function result(value: unknown): Record<string, unknown> {
	return boundedMap(value, "result");
}
function strictArgs(value: unknown, allowed: readonly string[]): Record<string, unknown> {
	const out = args(value);
	const expected = new Set(allowed);
	for (const key of Object.keys(out))
		if (!expected.has(key)) fail("INVALID_FRAME", "unknown command argument", `args.${key}`);
	return out;
}
function strictMap(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
	const out = boundedMap(value, path);
	const expected = new Set(allowed);
	for (const key of Object.keys(out))
		if (!expected.has(key)) fail("INVALID_FRAME", "unknown object field", `${path}.${key}`);
	return out;
}
function strictResult(value: unknown, allowed: readonly string[]): Record<string, unknown> {
	return strictMap(value, "result", allowed);
}
const runtimeSupports = new Set(["native", "emulated", "unavailable"]);
const workspaceOwnerships = new Set(["managed", "imported-user", "detected-external", "repository-root"]);
const workspaceLifecycles = new Set(["creating", "active", "archiving", "archived", "recovery-required"]);
function decodeRuntimeResultItem(value: unknown, path: string): Record<string, unknown> {
	const item = strictMap(value, path, ["id", "displayName", "command", "capabilities", "availability"]);
	const id = controlFree(item.id, `${path}.id`, 64);
	if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) fail("INVALID_FRAME", "invalid runtime adapter id", `${path}.id`);
	const displayName = controlFree(item.displayName, `${path}.displayName`, 128);
	const command = strictMap(item.command, `${path}.command`, ["executable", "arguments", "cwdArgument"]);
	const executable = controlFree(command.executable, `${path}.command.executable`, 512);
	const arguments_ = boundedArray(command.arguments, `${path}.command.arguments`, 64).map((argument, index) =>
		boundedText(argument, `${path}.command.arguments[${index}]`, 4096),
	);
	const cwdArgument =
		command.cwdArgument === undefined
			? undefined
			: controlFree(command.cwdArgument, `${path}.command.cwdArgument`, 128);
	const capabilities = boundedMap(item.capabilities, `${path}.capabilities`);
	const decodedCapabilities: Record<string, string> = {};
	for (const [capability, support] of Object.entries(capabilities)) {
		controlFree(capability, `${path}.capabilities`, 128);
		if (typeof support !== "string" || !runtimeSupports.has(support))
			fail("INVALID_FRAME", "invalid runtime capability support", `${path}.capabilities.${capability}`);
		decodedCapabilities[capability] = support;
	}
	const availability = boundedMap(item.availability, `${path}.availability`);
	const state = availability.state;
	let decodedAvailability: Record<string, unknown>;
	if (state === "available") {
		strictMap(availability, `${path}.availability`, ["state"]);
		decodedAvailability = { state };
	} else if (state === "unavailable") {
		strictMap(availability, `${path}.availability`, ["state", "executable"]);
		decodedAvailability = {
			state,
			executable: controlFree(availability.executable, `${path}.availability.executable`, 512),
		};
	} else if (state === "unknown") {
		strictMap(availability, `${path}.availability`, ["state"]);
		decodedAvailability = { state };
	} else fail("INVALID_FRAME", "invalid runtime availability", `${path}.availability.state`);
	return {
		id,
		displayName,
		command: { executable, arguments: arguments_, ...(cwdArgument === undefined ? {} : { cwdArgument }) },
		capabilities: decodedCapabilities,
		availability: decodedAvailability!,
	};
}
function decodeWorkspaceResultItem(value: unknown, path: string): Record<string, unknown> {
	const candidate = boundedMap(value, path);
	if (Object.hasOwn(candidate, "id"))
		return decodeWorkspaceInfrastructureProjection(candidate, path) as unknown as Record<string, unknown>;
	const item = strictMap(candidate, path, [
		"repositoryId",
		"instanceId",
		"ownership",
		"branch",
		"sourceCommit",
		"expectedHead",
		"lifecycle",
		"createdAt",
		"updatedAt",
		"archivedAt",
	]);
	const repositoryId = projectId(item.repositoryId, `${path}.repositoryId`);
	const instanceId = controlFree(item.instanceId, `${path}.instanceId`, 128);
	const ownership = item.ownership;
	if (typeof ownership !== "string" || !workspaceOwnerships.has(ownership))
		fail("INVALID_FRAME", "invalid workspace ownership", `${path}.ownership`);
	const lifecycle = item.lifecycle;
	if (typeof lifecycle !== "string" || !workspaceLifecycles.has(lifecycle))
		fail("INVALID_FRAME", "invalid workspace lifecycle", `${path}.lifecycle`);
	const createdAt = finiteNumber(item.createdAt, `${path}.createdAt`);
	const updatedAt = finiteNumber(item.updatedAt, `${path}.updatedAt`);
	if (createdAt < 0 || updatedAt < 0) fail("INVALID_FRAME", "workspace timestamps must be non-negative", path);
	const archivedAt = item.archivedAt === undefined ? undefined : finiteNumber(item.archivedAt, `${path}.archivedAt`);
	if (archivedAt !== undefined && archivedAt < 0)
		fail("INVALID_FRAME", "workspace archivedAt must be non-negative", `${path}.archivedAt`);
	return {
		repositoryId,
		instanceId,
		ownership,
		branch: controlFree(item.branch, `${path}.branch`, 256),
		sourceCommit: controlFree(item.sourceCommit, `${path}.sourceCommit`, 256),
		expectedHead: controlFree(item.expectedHead, `${path}.expectedHead`, 256),
		lifecycle,
		createdAt,
		updatedAt,
		...(archivedAt === undefined ? {} : { archivedAt }),
	};
}
function leasedArgs(value: unknown, allowed: readonly string[]): Record<string, unknown> {
	const x = strictArgs(value, [...allowed, "leaseId"]);
	if (x.leaseId !== undefined) leaseId(x.leaseId, "args.leaseId");
	return x;
}
function noArgs(value: unknown): CommandArguments {
	return strictArgs(value, []);
}
function decodeMessage(value: unknown): CommandArguments {
	const x = leasedArgs(value, ["message"]);
	boundedText(x.message, "args.message", MAX_STRING_BYTES);
	return x;
}
function decodeSessionUiResponse(value: unknown): CommandArguments {
	const x = args(value);
	const keys = Object.keys(x);
	if (
		!Object.hasOwn(x, "requestId") ||
		(keys.length !== 2 && keys.length !== 3) ||
		(keys.length === 3 && !Object.hasOwn(x, "leaseId"))
	)
		fail("INVALID_FRAME", "ui response requires requestId and exactly one payload", "args");
	if (x.leaseId !== undefined) leaseId(x.leaseId, "args.leaseId");
	controlFree(x.requestId, "args.requestId", 256);
	const payload = keys.filter(key => key !== "requestId" && key !== "leaseId");
	const key = payload[0];
	if (key === "value") boundedText(x.value, "args.value", MAX_STRING_BYTES);
	else if (key === "confirmed") {
		if (typeof x.confirmed !== "boolean") fail("INVALID_FRAME", "confirmed must be boolean", "args.confirmed");
	} else if (key === "cancelled") {
		if (x.cancelled !== true) fail("INVALID_FRAME", "cancelled must be true", "args.cancelled");
	} else fail("INVALID_FRAME", "unknown ui response payload", `args.${key}`);
	return x;
}
function url(value: unknown, path: string): string {
	const text = controlFree(value, path, 4096);
	let parsed: URL;
	try {
		parsed = new URL(text);
	} catch {
		fail("INVALID_FRAME", "invalid URL", path);
	}
	if (
		(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
		parsed.username !== "" ||
		parsed.password !== ""
	)
		fail("INVALID_FRAME", "URL must be http(s) without credentials", path);
	return text;
}
function previewAuthorityId(value: unknown, path: string): string {
	return controlFree(value, path, 128);
}
function previewSelector(value: unknown, path: string): string {
	return controlFree(value, path, PREVIEW_SELECTOR_BYTES);
}
function previewTtl(value: unknown, path: string): number {
	const ttl = safeSeq(value, path);
	if (ttl === 0 || ttl > PREVIEW_LEASE_TTL_MAX_MS) fail("BOUNDS", "preview lease TTL exceeds limit", path);
	return ttl;
}

function previewTarget(value: unknown, allowed: readonly string[] = []): Record<string, unknown> {
	const x = strictArgs(value, ["previewId", "leaseId", ...allowed]);
	previewId(x.previewId, "args.previewId");
	if (x.leaseId !== undefined) leaseId(x.leaseId, "args.leaseId");
	return x;
}
function decodePreviewStateArguments(value: unknown): CommandArguments {
	const x = strictArgs(value, ["previewId"]);
	if (x.previewId !== undefined) previewId(x.previewId, "args.previewId");
	return x;
}
function decodePreviewLaunchArguments(value: unknown): CommandArguments {
	const x = strictArgs(value, ["url", "authorityId"]);
	url(x.url, "args.url");
	if (x.authorityId !== undefined) previewAuthorityId(x.authorityId, "args.authorityId");
	return x;
}
function decodePreviewNavigateArguments(value: unknown): CommandArguments {
	const x = previewTarget(value, ["url"]);
	url(x.url, "args.url");
	return x;
}
function decodePreviewClickArguments(value: unknown): CommandArguments {
	const x = previewTarget(value, ["x", "y", "selector", "button", "clickCount"]);
	const hasCoordinates = x.x !== undefined || x.y !== undefined;
	const hasSelector = x.selector !== undefined;
	if (hasCoordinates === hasSelector || (hasCoordinates && (x.x === undefined || x.y === undefined)))
		fail("INVALID_FRAME", "preview click requires either x/y coordinates or one selector", "args");
	if (hasCoordinates) {
		const px = finiteNumber(x.x, "args.x");
		const py = finiteNumber(x.y, "args.y");
		if (px < 0 || py < 0 || px > PREVIEW_SCROLL_DELTA_LIMIT || py > PREVIEW_SCROLL_DELTA_LIMIT)
			fail("BOUNDS", "preview click coordinate exceeds limit", "args");
	} else {
		previewSelector(x.selector, "args.selector");
	}
	if (x.button !== undefined && !["left", "middle", "right"].includes(String(x.button)))
		fail("INVALID_FRAME", "preview click button is invalid", "args.button");
	if (x.clickCount !== undefined) {
		const count = safeSeq(x.clickCount, "args.clickCount");
		if (count < 1 || count > 3) fail("BOUNDS", "preview click count exceeds limit", "args.clickCount");
	}
	return x;
}
function decodePreviewScrollArguments(value: unknown): CommandArguments {
	const x = previewTarget(value, ["deltaX", "deltaY", "selector"]);
	for (const key of ["deltaX", "deltaY"] as const) {
		const delta = finiteNumber(x[key], `args.${key}`);
		if (Math.abs(delta) > PREVIEW_SCROLL_DELTA_LIMIT)
			fail("BOUNDS", "preview scroll delta exceeds limit", `args.${key}`);
	}
	if (x.selector !== undefined) previewSelector(x.selector, "args.selector");
	return x;
}
function decodePreviewTextArguments(value: unknown): CommandArguments {
	const x = previewTarget(value, ["text", "selector"]);
	boundedText(x.text, "args.text", PREVIEW_TEXT_INPUT_BYTES);
	if (x.selector !== undefined) previewSelector(x.selector, "args.selector");
	return x;
}
function decodePreviewSelectArguments(value: unknown): CommandArguments {
	const x = previewTarget(value, ["selector", "value"]);
	previewSelector(x.selector, "args.selector");
	boundedText(x.value, "args.value", PREVIEW_TEXT_INPUT_BYTES);
	return x;
}
function decodePreviewUploadArguments(value: unknown): CommandArguments {
	const x = previewTarget(value, ["selector", "path"]);
	previewSelector(x.selector, "args.selector");
	safeRelativePath(x.path, "args.path");
	return x;
}
function decodePreviewPressArguments(value: unknown): CommandArguments {
	const x = previewTarget(value, ["key"]);
	controlFree(x.key, "args.key", 128);
	return x;
}
function decodePreviewCaptureReadArguments(value: unknown): CommandArguments {
	const x = previewTarget(value, ["captureId", "offset"]);
	previewCaptureId(x.captureId, "args.captureId");
	safeSeq(x.offset, "args.offset");
	return x;
}
function decodePreviewPolicyCheckArguments(value: unknown): CommandArguments {
	const x = strictArgs(value, ["action", "previewId", "url", "authorityId"]);
	const action = controlFree(x.action, "args.action", 64);
	if (!(PREVIEW_ACTIONS as readonly string[]).includes(action))
		fail("INVALID_FRAME", "preview policy action is invalid", "args.action");
	if (x.previewId !== undefined) previewId(x.previewId, "args.previewId");
	if (x.url !== undefined) url(x.url, "args.url");
	if (x.authorityId !== undefined) previewAuthorityId(x.authorityId, "args.authorityId");
	return x;
}
function decodePreviewLeaseAcquireArguments(value: unknown): CommandArguments {
	const x = strictArgs(value, ["previewId", "ttlMs"]);
	previewId(x.previewId, "args.previewId");
	if (x.ttlMs !== undefined) previewTtl(x.ttlMs, "args.ttlMs");
	return x;
}
function decodePreviewLeaseRenewArguments(value: unknown): CommandArguments {
	const x = strictArgs(value, ["previewId", "leaseId", "ttlMs"]);
	previewId(x.previewId, "args.previewId");
	leaseId(x.leaseId, "args.leaseId");
	if (x.ttlMs !== undefined) previewTtl(x.ttlMs, "args.ttlMs");
	return x;
}
function decodePreviewLeaseReleaseArguments(value: unknown): CommandArguments {
	const x = strictArgs(value, ["previewId", "leaseId"]);
	previewId(x.previewId, "args.previewId");
	leaseId(x.leaseId, "args.leaseId");
	return x;
}
function decodePreviewHandoffArguments(value: unknown): CommandArguments {
	const x = previewTarget(value, ["message", "mode", "selector", "urlSubstring", "text", "timeoutMs"]);
	boundedText(x.message, "args.message", PREVIEW_HANDOFF_MESSAGE_BYTES);
	const mode = x.mode === undefined ? "manual" : controlFree(x.mode, "args.mode", 16);
	if (!["manual", "selector", "url", "text"].includes(mode))
		fail("INVALID_FRAME", "preview handoff mode is invalid", "args.mode");
	const conditions = {
		selector: x.selector !== undefined,
		url: x.urlSubstring !== undefined,
		text: x.text !== undefined,
	};
	if (mode === "manual") {
		if (conditions.selector || conditions.url || conditions.text)
			fail("INVALID_FRAME", "manual preview handoff cannot include a completion condition", "args");
	} else if (!conditions[mode as keyof typeof conditions] || Object.values(conditions).filter(Boolean).length !== 1) {
		fail("INVALID_FRAME", "preview handoff requires exactly one matching completion condition", "args");
	}
	if (x.selector !== undefined) previewSelector(x.selector, "args.selector");
	if (x.urlSubstring !== undefined) controlFree(x.urlSubstring, "args.urlSubstring", 4096);
	if (x.text !== undefined) controlFree(x.text, "args.text", PREVIEW_TEXT_INPUT_BYTES);
	if (x.timeoutMs !== undefined) {
		const timeoutMs = safeSeq(x.timeoutMs, "args.timeoutMs");
		if (timeoutMs === 0 || timeoutMs > PREVIEW_HANDOFF_TIMEOUT_MAX_MS)
			fail("BOUNDS", "preview handoff timeout exceeds limit", "args.timeoutMs");
	}
	return x;
}
function metadata(value: unknown, path: string): Record<string, unknown> {
	return boundedMetadata(value, path, isSecretLikeKey);
}
function decodeSessions(value: unknown): CommandResult {
	const result: SessionListResult = decodeSessionListResult(value);
	return result as unknown as CommandResult;
}
function decodeCreate(value: unknown): CommandResult {
	const x = result(value);
	return { ...x, session: decodeSessionRef(x.session, "result.session") };
}
function decodeAttach(value: unknown): CommandResult {
	const x = result(value);
	if (typeof x.attached !== "boolean") fail("INVALID_FRAME", "attached must be boolean", "result.attached");
	return { ...x, attached: x.attached, cursor: decodeCursor(x.cursor, "result.cursor") };
}
function boolField(value: unknown, key: string): CommandResult {
	const x = result(value);
	if (typeof x[key] !== "boolean") fail("INVALID_FRAME", `${key} must be boolean`, `result.${key}`);
	return { ...x, [key]: x[key] };
}
function decodeEntries(value: unknown): CommandResult {
	const x = result(value),
		values = boundedArray(x.entries, "result.entries").map((value, i) =>
			decodeFileListEntry(value, `result.entries[${i}]`),
		);
	return { ...x, entries: values };
}
function decodeAuditResult(value: unknown): CommandResult {
	const x = result(value),
		events = boundedArray(x.events, "result.events").map((event, i) =>
			decodeAuditEvent(event, `result.events[${i}]`),
		);
	return { ...x, events };
}
function decodeCatalogResult(value: unknown): CommandResult {
	const x = result(value);
	const decoded: CommandResult = {
		...x,
		revision: revision(x.revision, "result.revision"),
		items: boundedArray(x.items, "result.items").map((item, i) => decodeCatalogItem(item, `result.items[${i}]`)),
	};
	if (x.operations !== undefined)
		decoded.operations = boundedArray(x.operations, "result.operations").map((item, i) =>
			decodeOperationCapability(item, `result.operations[${i}]`),
		);
	return decoded;
}
function decodeTerminalResult(value: unknown): CommandResult {
	const x = result(value);
	terminalId(x.terminalId, "result.terminalId");
	return x;
}
function decodeLeaseResult(value: unknown): CommandResult {
	const x = result(value);
	leaseId(x.leaseId, "result.leaseId");
	if (x.cursor !== undefined) decodeCursor(x.cursor, "result.cursor");
	return x;
}
function decodeWatchResult(value: unknown): CommandResult {
	const x = result(value);
	controlFree(x.watchId, "result.watchId", 256);
	decodeCursor(x.cursor, "result.cursor");
	return x;
}
function decodePreviewMutationResult(value: unknown): CommandResult {
	const x = result(value);
	return { ...x, preview: decodePreviewSnapshot(x.preview, "result.preview") };
}
function decodePreviewStateResult(value: unknown): CommandResult {
	const x = result(value);
	return {
		...x,
		previews: boundedArray(x.previews, "result.previews", PREVIEW_MAX_PER_SESSION).map((preview, index) =>
			decodePreviewSnapshot(preview, `result.previews[${index}]`),
		),
	};
}
function decodePreviewCaptureReadResult(value: unknown): CommandResult {
	const x = result(value);
	const size = safeSeq(x.size, "result.size");
	const offset = safeSeq(x.offset, "result.offset");
	const nextOffset = safeSeq(x.nextOffset, "result.nextOffset");
	if (size === 0 || size > PREVIEW_CAPTURE_MAX_BYTES)
		fail("BOUNDS", "preview capture size exceeds limit", "result.size");
	if (offset > nextOffset || nextOffset > size) fail("INVALID_FRAME", "preview capture offsets are invalid", "result");
	if (typeof x.complete !== "boolean")
		fail("INVALID_FRAME", "preview capture completion must be boolean", "result.complete");
	if (x.complete !== (nextOffset === size))
		fail("INVALID_FRAME", "preview capture completion disagrees with offsets", "result.complete");
	if (!x.complete && nextOffset === offset)
		fail("INVALID_FRAME", "preview capture read must advance while incomplete", "result.nextOffset");
	previewId(x.previewId, "result.previewId");
	previewCaptureId(x.captureId, "result.captureId");
	const content = boundedBase64(x.content, "result.content", PREVIEW_CAPTURE_CHUNK_BYTES);
	const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	if (
		(padding === 2 && (alphabet.indexOf(content[content.length - 3]!) & 0x0f) !== 0) ||
		(padding === 1 && (alphabet.indexOf(content[content.length - 2]!) & 0x03) !== 0)
	)
		fail("INVALID_FRAME", "preview capture content has non-canonical padding bits", "result.content");
	const decodedBytes = (content.length / 4) * 3 - padding;
	if (decodedBytes !== nextOffset - offset)
		fail("INVALID_FRAME", "preview capture content does not match its offsets", "result.content");
	return x;
}
function decodePreviewPolicyCheckResult(value: unknown): CommandResult {
	const x = result(value);
	if (typeof x.allowed !== "boolean")
		fail("INVALID_FRAME", "preview policy allowed must be boolean", "result.allowed");
	if (typeof x.confirmationRequired !== "boolean")
		fail("INVALID_FRAME", "preview policy confirmationRequired must be boolean", "result.confirmationRequired");
	if (x.reason !== undefined) controlFree(x.reason, "result.reason", 256);
	return x;
}
function decodePreviewLeaseResult(value: unknown): CommandResult {
	const x = result(value);
	previewId(x.previewId, "result.previewId");
	leaseId(x.leaseId, "result.leaseId");
	safeSeq(x.expiresAt, "result.expiresAt");
	return x;
}
function decodePreviewLeaseReleaseResult(value: unknown): CommandResult {
	const x = result(value);
	previewId(x.previewId, "result.previewId");
	if (typeof x.released !== "boolean")
		fail("INVALID_FRAME", "preview lease released must be boolean", "result.released");
	return x;
}
function decodeSettingsResult(value: unknown): CommandResult {
	const x = result(value);
	revision(x.revision, "result.revision");
	return { ...x, settings: boundedSettings(x.settings, "result.settings") };
}
export function decodeSessionPromptArguments(value: unknown): SessionPromptArguments {
	const x = args(value);
	const keys = Object.keys(x);
	if (!Object.hasOwn(x, "message") || keys.some(key => key !== "message" && key !== "leaseId" && key !== "images"))
		fail("INVALID_FRAME", "session.prompt accepts only message, leaseId, and images", "args");
	const message = boundedText(x.message, "args.message", MAX_STRING_BYTES);
	const images =
		x.images === undefined
			? undefined
			: boundedArray(x.images, "args.images", PROMPT_IMAGE_MAX_COUNT).map((value, index) => {
					const ref = boundedMap(value, `args.images[${index}]`);
					if (Object.keys(ref).length !== 1 || !Object.hasOwn(ref, "imageId"))
						fail("INVALID_FRAME", "image reference must contain only imageId", `args.images[${index}]`);
					return { imageId: imageId(ref.imageId, `args.images[${index}].imageId`) };
				});
	if (images?.length === 0) fail("BOUNDS", "prompt images must not be empty", "args.images");
	if (message.length === 0 && images === undefined)
		fail("BOUNDS", "prompt message must be non-empty without images", "args.message");
	const lease = x.leaseId === undefined ? undefined : leaseId(x.leaseId, "args.leaseId");
	return {
		message,
		...(lease === undefined ? {} : { leaseId: lease }),
		...(images === undefined ? {} : { images }),
	};
}
function decodeImageMimeType(value: unknown, path: string): PromptImageMimeType {
	const mimeType = controlFree(value, path, 32);
	if (!(PROMPT_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType))
		fail("INVALID_FRAME", "unsupported prompt image MIME type", path);
	return mimeType as PromptImageMimeType;
}
function decodeSha256(value: unknown, path: string): string {
	const sha256 = controlFree(value, path, 64);
	if (!/^[a-f0-9]{64}$/u.test(sha256)) fail("INVALID_FRAME", "sha256 must be lowercase hexadecimal", path);
	return sha256;
}
function decodeImageBegin(value: unknown): SessionImageBeginArguments {
	const x = strictArgs(value, ["mimeType", "size", "sha256"]);
	const size = x.size;
	if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 || size > IMAGE_UPLOAD_MAX_BYTES)
		fail("BOUNDS", "image size exceeds the upload limit", "args.size");
	return {
		mimeType: decodeImageMimeType(x.mimeType, "args.mimeType"),
		size,
		sha256: decodeSha256(x.sha256, "args.sha256"),
	};
}
function decodeImageChunk(value: unknown): SessionImageChunkArguments {
	const x = strictArgs(value, ["imageId", "offset", "content"]);
	const offset = safeSeq(x.offset, "args.offset");
	if (offset > IMAGE_UPLOAD_MAX_BYTES) fail("BOUNDS", "image chunk offset exceeds the upload limit", "args.offset");
	const content = boundedText(x.content, "args.content", IMAGE_UPLOAD_CHUNK_BASE64_BYTES);
	if (content.length === 0 || content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(content))
		fail("INVALID_FRAME", "image chunk content must be canonical base64", "args.content");
	const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	if (
		(padding === 2 && (alphabet.indexOf(content[content.length - 3]!) & 0x0f) !== 0) ||
		(padding === 1 && (alphabet.indexOf(content[content.length - 2]!) & 0x03) !== 0)
	)
		fail("INVALID_FRAME", "image chunk content has non-canonical padding bits", "args.content");
	const decodedBytes = (content.length / 4) * 3 - padding;
	if (decodedBytes <= 0 || decodedBytes > IMAGE_UPLOAD_CHUNK_BYTES)
		fail("BOUNDS", "decoded image chunk exceeds the raw chunk limit", "args.content");
	return { imageId: imageId(x.imageId, "args.imageId"), offset, content };
}
function decodeImageDiscard(value: unknown): SessionImageDiscardArguments {
	const x = strictArgs(value, ["imageId"]);
	return { imageId: imageId(x.imageId, "args.imageId") };
}
function decodeArtifactRead(value: unknown): ArtifactReadArguments {
	const x = strictArgs(value, ["artifactId", "offset"]);
	const offset = safeSeq(x.offset, "args.offset");
	if (offset >= ARTIFACT_MAX_BYTES) fail("BOUNDS", "artifact offset exceeds the artifact limit", "args.offset");
	return { artifactId: artifactId(x.artifactId, "args.artifactId"), offset };
}
export function decodeArtifactReadChunk(value: unknown): ArtifactReadChunk {
	const x = result(value);
	const expected = ["artifactId", "kind", "mediaType", "size", "offset", "nextOffset", "complete", "content"];
	if (Object.keys(x).length !== expected.length || expected.some(key => !Object.hasOwn(x, key)))
		fail("INVALID_FRAME", "invalid artifact read result", "result");
	artifactId(x.artifactId, "result.artifactId");
	const kind = controlFree(x.kind, "result.kind", 16);
	if (!["image", "text", "patch", "binary"].includes(kind))
		fail("INVALID_FRAME", "unsupported artifact kind", "result.kind");
	const mediaType = controlFree(x.mediaType, "result.mediaType", 128);
	if (!/^[!#$&^_.+*/-]+\/[!#$&^_.+*/-]+$/u.test(mediaType))
		fail("INVALID_FRAME", "artifact mediaType must be a MIME type", "result.mediaType");
	const size = safeSeq(x.size, "result.size");
	if (size <= 0 || size > ARTIFACT_MAX_BYTES)
		fail("BOUNDS", "artifact size exceeds the artifact limit", "result.size");
	const offset = safeSeq(x.offset, "result.offset");
	const nextOffset = safeSeq(x.nextOffset, "result.nextOffset");
	if (offset >= size || nextOffset <= offset || nextOffset > size)
		fail("INVALID_FRAME", "artifact result offsets are invalid", "result.nextOffset");
	if (typeof x.complete !== "boolean" || x.complete !== (nextOffset === size))
		fail("INVALID_FRAME", "artifact completion does not match its offsets", "result.complete");
	const content = boundedText(x.content, "result.content", ARTIFACT_CHUNK_BASE64_BYTES);
	if (content.length === 0 || content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(content))
		fail("INVALID_FRAME", "artifact content must be canonical base64", "result.content");
	const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	if (
		(padding === 2 && (alphabet.indexOf(content[content.length - 3]!) & 0x0f) !== 0) ||
		(padding === 1 && (alphabet.indexOf(content[content.length - 2]!) & 0x03) !== 0)
	)
		fail("INVALID_FRAME", "artifact content has non-canonical padding bits", "result.content");
	const decodedBytes = (content.length / 4) * 3 - padding;
	if (decodedBytes <= 0 || decodedBytes > ARTIFACT_CHUNK_BYTES || nextOffset - offset !== decodedBytes)
		fail("INVALID_FRAME", "artifact content does not match its offsets", "result.content");
	return x as unknown as ArtifactReadChunk;
}
export function decodeTurnReviewApplyResult(value: unknown): TurnReviewApplyResult {
	const x = result(value);
	const expected = ["turnId", "path", "action", "state", "resultingRevision"];
	if (Object.keys(x).length !== expected.length || expected.some(key => !Object.hasOwn(x, key)))
		fail("INVALID_FRAME", "invalid turn review action result", "result");
	const decodedTurnId = turnId(x.turnId, "result.turnId");
	const path = safeRelativePath(x.path, "result.path");
	if (x.action !== "keep" && x.action !== "discard")
		fail("INVALID_FRAME", "invalid turn review action", "result.action");
	if (x.state !== "applied" && x.state !== "discarded")
		fail("INVALID_FRAME", "invalid turn review action state", "result.state");
	const resultingRevision = controlFree(x.resultingRevision, "result.resultingRevision", 128);
	return {
		turnId: decodedTurnId,
		path,
		action: x.action,
		state: x.state,
		resultingRevision,
	};
}
function decodeImageRead(value: unknown): SessionImageReadArguments {
	const x = strictArgs(value, ["entryId", "sha256", "offset"]);
	const offset = safeSeq(x.offset, "args.offset");
	if (offset >= TRANSCRIPT_IMAGE_MAX_BYTES)
		fail("BOUNDS", "transcript image offset exceeds the image limit", "args.offset");
	return {
		entryId: entryId(x.entryId, "args.entryId"),
		sha256: decodeSha256(x.sha256, "args.sha256"),
		offset,
	};
}

function decodeImageReadResult(value: unknown): CommandResult {
	const x = result(value);
	const expected = ["sha256", "mimeType", "size", "offset", "nextOffset", "complete", "content"];
	if (Object.keys(x).length !== expected.length || expected.some(key => !Object.hasOwn(x, key)))
		fail("INVALID_FRAME", "invalid transcript image read result", "result");
	decodeSha256(x.sha256, "result.sha256");
	decodeImageMimeType(x.mimeType, "result.mimeType");
	const size = safeSeq(x.size, "result.size");
	if (size <= 0 || size > TRANSCRIPT_IMAGE_MAX_BYTES)
		fail("BOUNDS", "transcript image size exceeds the image limit", "result.size");
	const offset = safeSeq(x.offset, "result.offset");
	const nextOffset = safeSeq(x.nextOffset, "result.nextOffset");
	if (offset >= size || nextOffset <= offset || nextOffset > size)
		fail("INVALID_FRAME", "transcript image result offsets are invalid", "result.nextOffset");
	if (typeof x.complete !== "boolean" || x.complete !== (nextOffset === size))
		fail("INVALID_FRAME", "transcript image completion does not match its offsets", "result.complete");
	const content = boundedText(x.content, "result.content", TRANSCRIPT_IMAGE_CHUNK_BASE64_BYTES);
	if (content.length === 0 || content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(content))
		fail("INVALID_FRAME", "transcript image content must be canonical base64", "result.content");
	const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	if (
		(padding === 2 && (alphabet.indexOf(content[content.length - 3]!) & 0x0f) !== 0) ||
		(padding === 1 && (alphabet.indexOf(content[content.length - 2]!) & 0x03) !== 0)
	)
		fail("INVALID_FRAME", "transcript image content has non-canonical padding bits", "result.content");
	const decodedBytes = (content.length / 4) * 3 - padding;
	if (decodedBytes <= 0 || decodedBytes > TRANSCRIPT_IMAGE_CHUNK_BYTES || nextOffset - offset !== decodedBytes)
		fail("INVALID_FRAME", "transcript image content does not match its offsets", "result.content");
	return x;
}
function decodeBooleanResult(value: unknown, key: string): CommandResult {
	const x = result(value);
	const keys = Object.keys(x);
	if (keys.length !== 1 || keys[0] !== key || typeof x[key] !== "boolean")
		fail("INVALID_FRAME", "invalid command result", `result.${key}`);
	return { [key]: x[key] };
}
function decodeAcceptedResult(value: unknown): CommandResult {
	return decodeBooleanResult(value, "accepted");
}
function decodeSessionState(value: unknown): CommandResult {
	return decodeSessionStateResult(value) as unknown as CommandResult;
}
function decodePauseResult(value: unknown): CommandResult {
	const x = result(value);
	if (Object.keys(x).length !== 2 || typeof x.paused !== "boolean" || typeof x.changed !== "boolean")
		fail("INVALID_FRAME", "invalid pause result", "result");
	return { paused: x.paused, changed: x.changed };
}
export const COMMAND_ARGUMENT_DECODERS: Readonly<Record<string, (value: unknown) => CommandArguments>> = {
	"runtime.list": noArgs,
	"workspace.list": noArgs,
	"workspace.create": value => {
		const candidate = boundedMap(value, "args");
		if (Object.hasOwn(candidate, "displayName"))
			return decodeClusterWorkspaceCreateArguments(candidate) as unknown as CommandArguments;
		const x = strictArgs(candidate, ["projectId", "name", "branch", "sourceCommit"]);
		projectId(x.projectId, "args.projectId");
		controlFree(x.name, "args.name", 128);
		controlFree(x.branch, "args.branch", 256);
		controlFree(x.sourceCommit, "args.sourceCommit", 256);
		return x;
	},
	"workspace.import": value => {
		const x = strictArgs(value, ["projectId", "name"]);
		projectId(x.projectId, "args.projectId");
		controlFree(x.name, "args.name", 128);
		return x;
	},
	"workspace.archive": value => {
		const x = strictArgs(value, ["instanceId"]);
		controlFree(x.instanceId, "args.instanceId", 128);
		return x;
	},
	"workspace.recover": noArgs,
	"host.list": args,
	"session.list": args,
	"transcript.search": value => decodeTranscriptSearchArguments(value) as unknown as CommandArguments,
	"transcript.context": value => decodeTranscriptContextArguments(value) as unknown as CommandArguments,
	"transcript.page": value => decodeTranscriptPageArguments(value) as unknown as CommandArguments,
	"project.reveal": value => {
		const x = strictArgs(value, ["projectId"]);
		projectId(x.projectId, "args.projectId");
		return x;
	},
	"session.create": value => {
		const candidate = boundedMap(value, "args");
		if (Object.hasOwn(candidate, "workspaceId"))
			return decodeClusterSessionCreateArguments(candidate) as unknown as CommandArguments;
		const x = strictArgs(candidate, ["projectId", "title", "runtimeId", "workspaceInstanceId"]);
		projectId(x.projectId, "args.projectId");
		if (x.title !== undefined) boundedText(x.title, "args.title", 512);
		const runtimeId = x.runtimeId === undefined ? undefined : controlFree(x.runtimeId, "args.runtimeId", 64);
		const workspaceInstanceId =
			x.workspaceInstanceId === undefined
				? undefined
				: controlFree(x.workspaceInstanceId, "args.workspaceInstanceId", 128);
		if ((runtimeId === undefined) !== (workspaceInstanceId === undefined))
			fail("INVALID_FRAME", "runtimeId and workspaceInstanceId must be provided together", "args");
		return x;
	},
	"session.attach": value => {
		const x = args(value);
		if (x.cursor !== undefined) decodeCursor(x.cursor, "args.cursor");
		return x;
	},
	"session.prompt": value => decodeSessionPromptArguments(value) as unknown as CommandArguments,
	"session.image.begin": value => decodeImageBegin(value) as unknown as CommandArguments,
	"session.image.chunk": value => decodeImageChunk(value) as unknown as CommandArguments,
	"session.image.discard": value => decodeImageDiscard(value) as unknown as CommandArguments,
	"session.image.read": value => decodeImageRead(value) as unknown as CommandArguments,
	"artifact.read": value => decodeArtifactRead(value) as unknown as CommandArguments,
	"session.state.get": noArgs,
	"session.steer": decodeMessage,
	"session.followUp": decodeMessage,
	"session.rename": value => {
		const x = leasedArgs(value, ["name"]);
		controlFree(x.name, "args.name", 512);
		return x;
	},
	"session.retry": value => leasedArgs(value, []),
	"session.compact": value => {
		const x = leasedArgs(value, ["instructions"]);
		if (x.instructions !== undefined) boundedText(x.instructions, "args.instructions", MAX_STRING_BYTES);
		return x;
	},
	"session.pause": value => leasedArgs(value, []),
	"session.resume": value => leasedArgs(value, []),
	"session.archive": noArgs,
	"session.restore": noArgs,
	"session.delete": noArgs,
	"session.model.set": value => {
		const x = leasedArgs(value, ["selector", "role", "persistence"]);
		const selector = x.selector === undefined ? undefined : controlFree(x.selector, "args.selector", 512);
		const role = x.role === undefined ? undefined : controlFree(x.role, "args.role", 256);
		if ((selector === undefined) === (role === undefined))
			fail("INVALID_FRAME", "provide exactly one selector or role", "args");
		const persistence = controlFree(x.persistence, "args.persistence", 32);
		if (persistence !== "session" && persistence !== "settings")
			fail("INVALID_FRAME", "invalid model persistence", "args.persistence");
		return x;
	},
	"session.thinking.set": value => {
		const x = leasedArgs(value, ["level"]);
		const level = controlFree(x.level, "args.level", 64);
		if (!["inherit", "off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level))
			fail("INVALID_FRAME", "invalid thinking level", "args.level");
		return x;
	},
	"session.fast.set": value => {
		const x = leasedArgs(value, ["enabled"]);
		if (typeof x.enabled !== "boolean") fail("INVALID_FRAME", "enabled must be boolean", "args.enabled");
		return x;
	},
	"session.ui.respond": decodeSessionUiResponse,
	"session.cancel": value => leasedArgs(value, []),
	"session.close": value => leasedArgs(value, []),
	"files.read": value => {
		const x = args(value);
		safeRelativePath(x.path);
		return x;
	},
	"files.write": value => {
		const x = args(value);
		safeRelativePath(x.path);
		boundedText(x.content, "args.content", MAX_FILE_BYTES);
		return x;
	},
	"files.patch": value => {
		const x = args(value);
		safeRelativePath(x.path);
		boundedText(x.patch, "args.patch", MAX_FILE_BYTES);
		return x;
	},
	"files.list": value => {
		const x = args(value);
		if (x.path !== undefined) safeRelativePath(x.path, "args.path");
		return x;
	},
	"files.search": value => decodeProjectFileSearchArguments(value) as unknown as CommandArguments,
	"files.diff": value => {
		const x = args(value);
		if (x.turnId !== undefined) {
			if (Object.keys(x).length !== 1) fail("INVALID_FRAME", "turn diff accepts only turnId", "args");
			turnId(x.turnId, "args.turnId");
			return x;
		}
		safeRelativePath(x.path);
		return x;
	},
	"review.read": value => {
		const x = strictArgs(value, ["reviewId"]);
		controlFree(x.reviewId, "args.reviewId", 256);
		return x;
	},
	"review.apply": value => {
		const x = args(value);
		if (x.turnId === undefined) {
			if (Object.keys(x).length !== 1) fail("INVALID_FRAME", "legacy review apply accepts only reviewId", "args");
			controlFree(x.reviewId, "args.reviewId", 256);
			return x;
		}
		if (Object.keys(x).length !== 3) fail("INVALID_FRAME", "turn review action has invalid fields", "args");
		turnId(x.turnId, "args.turnId");
		safeRelativePath(x.path, "args.path");
		if (x.action !== "keep" && x.action !== "discard")
			fail("INVALID_FRAME", "turn review action must be keep or discard", "args.action");
		return x;
	},
	"agent.cancel": value => {
		const x = args(value);
		controlFree(x.agentId, "args.agentId", 256);
		return x;
	},
	"bash.run": value => {
		const x = args(value);
		boundedText(x.command, "args.command", MAX_FILE_BYTES);
		return x;
	},
	"term.open": value => {
		const x = args(value);
		if (x.cwd !== undefined) safeRelativePath(x.cwd, "args.cwd");
		if (x.shell !== undefined) controlFree(x.shell, "args.shell", 256);
		if (x.env !== undefined) {
			const env = boundedMap(x.env, "args.env");
			for (const [key, val] of Object.entries(env)) {
				controlFree(key, `args.env.${key}`, 128);
				boundedText(val, `args.env.${key}`, 4096);
			}
		}
		if (x.cols !== undefined) {
			const cols = safeSeq(x.cols, "args.cols");
			if (cols === 0 || cols > 1000) fail("BOUNDS", "invalid cols", "args.cols");
		}
		if (x.rows !== undefined) {
			const rows = safeSeq(x.rows, "args.rows");
			if (rows === 0 || rows > 500) fail("BOUNDS", "invalid rows", "args.rows");
		}
		return x;
	},
	"audit.read": args,
	"audit.tail": value => {
		const x = args(value);
		decodeCursor(x.cursor, "args.cursor");
		return x;
	},
	"config.write": value => metadata(value, "args"),
	"settings.read": args,
	"settings.write": value => metadata(value, "args"),
	"catalog.get": args,
	"broker.status": noArgs,
	"usage.read": noArgs,
	"host.watch": value => {
		const x = args(value);
		decodeCursor(x.cursor, "args.cursor");
		return x;
	},
	"session.watch": value => {
		const x = args(value);
		decodeCursor(x.cursor, "args.cursor");
		return x;
	},
	"controller.lease.acquire": value => {
		const x = args(value);
		controlFree(x.ownerId, "args.ownerId", 256);
		return x;
	},
	"controller.lease.renew": value => {
		const x = args(value);
		leaseId(x.leaseId, "args.leaseId");
		return x;
	},
	"controller.lease.release": value => {
		const x = args(value);
		leaseId(x.leaseId, "args.leaseId");
		return x;
	},
	"prompt.lease.acquire": value => {
		const x = args(value);
		controlFree(x.ownerId, "args.ownerId", 256);
		return x;
	},
	"prompt.lease.renew": value => {
		const x = args(value);
		leaseId(x.leaseId, "args.leaseId");
		return x;
	},
	"prompt.lease.release": value => {
		const x = args(value);
		leaseId(x.leaseId, "args.leaseId");
		return x;
	},
	"preview.launch": decodePreviewLaunchArguments,
	"preview.state": decodePreviewStateArguments,
	"preview.activate": previewTarget,
	"preview.navigate": decodePreviewNavigateArguments,
	"preview.back": previewTarget,
	"preview.forward": previewTarget,
	"preview.reload": previewTarget,
	"preview.close": previewTarget,
	"preview.capture": previewTarget,
	"preview.capture.read": decodePreviewCaptureReadArguments,
	"preview.click": decodePreviewClickArguments,
	"preview.fill": decodePreviewTextArguments,
	"preview.scroll": decodePreviewScrollArguments,
	"preview.type": decodePreviewTextArguments,
	"preview.select": decodePreviewSelectArguments,
	"preview.press": decodePreviewPressArguments,
	"preview.upload": decodePreviewUploadArguments,
	"preview.policy.check": decodePreviewPolicyCheckArguments,
	"preview.lease.acquire": decodePreviewLeaseAcquireArguments,
	"preview.lease.renew": decodePreviewLeaseRenewArguments,
	"preview.lease.release": decodePreviewLeaseReleaseArguments,
	"preview.handoff": decodePreviewHandoffArguments,
	"ci.run": value => decodeCiRunArguments(value) as unknown as CommandArguments,
};
export const COMMAND_RESULT_DECODERS: Readonly<Record<string, (value: unknown) => CommandResult>> = {
	"runtime.list": value => {
		const x = strictResult(value, ["runtimes"]);
		return {
			runtimes: boundedArray(x.runtimes, "result.runtimes", 64).map((runtime, index) =>
				decodeRuntimeResultItem(runtime, `result.runtimes[${index}]`),
			),
		};
	},
	"workspace.list": value => {
		const x = strictResult(value, ["workspaces", "cursor"]);
		return {
			workspaces: boundedArray(x.workspaces, "result.workspaces", 256).map((workspace, index) =>
				decodeWorkspaceResultItem(workspace, `result.workspaces[${index}]`),
			),
			...(x.cursor === undefined ? {} : { cursor: decodeCursor(x.cursor, "result.cursor") }),
		};
	},
	"workspace.create": value => {
		const x = strictResult(value, ["workspace"]);
		return { workspace: decodeWorkspaceResultItem(x.workspace, "result.workspace") };
	},
	"workspace.import": value => {
		const x = strictResult(value, ["workspace"]);
		return { workspace: decodeWorkspaceResultItem(x.workspace, "result.workspace") };
	},
	"workspace.archive": value => {
		const x = strictResult(value, ["workspace"]);
		return { workspace: decodeWorkspaceResultItem(x.workspace, "result.workspace") };
	},
	"workspace.recover": value => {
		const x = strictResult(value, ["workspaces"]);
		return {
			workspaces: boundedArray(x.workspaces, "result.workspaces", 256).map((workspace, index) =>
				decodeWorkspaceResultItem(workspace, `result.workspaces[${index}]`),
			),
		};
	},
	"host.list": decodeSessions,
	"session.list": decodeSessions,
	"transcript.search": value => decodeTranscriptSearchResult(value) as unknown as CommandResult,
	"transcript.context": value => decodeTranscriptContextResult(value) as unknown as CommandResult,
	"transcript.page": value => decodeTranscriptPageResult(value) as unknown as CommandResult,
	"project.reveal": value => boolField(value, "revealed"),
	"session.create": decodeCreate,
	"session.attach": decodeAttach,
	"session.prompt": value => boolField(value, "accepted"),
	"session.image.begin": value => {
		const x = result(value);
		if (Object.keys(x).length !== 2 || !Object.hasOwn(x, "imageId") || !Object.hasOwn(x, "chunkBytes"))
			fail("INVALID_FRAME", "invalid image begin result", "result");
		imageId(x.imageId, "result.imageId");
		if (x.chunkBytes !== IMAGE_UPLOAD_CHUNK_BYTES)
			fail("INVALID_FRAME", "image begin result has an invalid chunk size", "result.chunkBytes");
		return x;
	},
	"session.image.chunk": value => {
		const x = result(value);
		if (
			Object.keys(x).length !== 3 ||
			!Object.hasOwn(x, "imageId") ||
			!Object.hasOwn(x, "received") ||
			!Object.hasOwn(x, "complete")
		)
			fail("INVALID_FRAME", "invalid image chunk result", "result");
		imageId(x.imageId, "result.imageId");
		const received = safeSeq(x.received, "result.received");
		if (received > IMAGE_UPLOAD_MAX_BYTES) fail("BOUNDS", "received exceeds the upload limit", "result.received");
		if (typeof x.complete !== "boolean") fail("INVALID_FRAME", "complete must be boolean", "result.complete");
		return x;
	},
	"session.image.discard": value => decodeBooleanResult(value, "discarded"),
	"session.image.read": decodeImageReadResult,
	"artifact.read": value => decodeArtifactReadChunk(value) as unknown as CommandResult,
	"session.state.get": decodeSessionState,
	"session.steer": decodeAcceptedResult,
	"session.followUp": decodeAcceptedResult,
	"session.rename": value => decodeBooleanResult(value, "renamed"),
	"session.retry": value => decodeBooleanResult(value, "retried"),
	"session.compact": value => decodeBooleanResult(value, "compacted"),
	"session.pause": decodePauseResult,
	"session.resume": value => {
		const x = result(value);
		if (Object.keys(x).length !== 2 || typeof x.resumed !== "boolean" || typeof x.paused !== "boolean")
			fail("INVALID_FRAME", "invalid resume result", "result");
		return { resumed: x.resumed, paused: x.paused };
	},
	"session.archive": value => decodeBooleanResult(value, "archived"),
	"session.restore": value => decodeBooleanResult(value, "restored"),
	"session.delete": value => decodeBooleanResult(value, "deleted"),
	"session.model.set": decodeAcceptedResult,
	"session.thinking.set": decodeAcceptedResult,
	"session.fast.set": decodeAcceptedResult,
	"session.ui.respond": decodeAcceptedResult,
	"session.cancel": value => boolField(value, "cancelled"),
	"session.close": value => boolField(value, "closed"),
	"files.read": value => {
		const x = result(value);
		boundedText(x.content, "result.content", MAX_FILE_BYTES);
		return x;
	},
	"files.write": result,
	"files.patch": result,
	"files.list": decodeEntries,
	"files.search": value => decodeProjectFileSearchResult(value) as unknown as CommandResult,
	"files.diff": value => {
		const x = result(value);
		if (x.turnId !== undefined) return decodeTurnReviewSnapshot(x, "result") as unknown as CommandResult;
		boundedText(x.diff, "result.diff", MAX_FILE_BYTES);
		return x;
	},
	"review.read": result,
	"review.apply": value => {
		const x = result(value);
		return x.turnId === undefined ? x : (decodeTurnReviewApplyResult(x) as unknown as CommandResult);
	},
	"agent.cancel": value => boolField(value, "cancelled"),
	"bash.run": result,
	"term.open": decodeTerminalResult,
	"audit.read": decodeAuditResult,
	"audit.tail": decodeAuditResult,
	"config.write": value => metadata(value, "result"),
	"settings.read": decodeSettingsResult,
	"settings.write": value => metadata(value, "result"),
	"catalog.get": decodeCatalogResult,
	"broker.status": value => decodeBrokerStatusResult(value) as unknown as CommandResult,
	"usage.read": value => decodeUsageReadResult(value) as unknown as CommandResult,
	"host.watch": decodeWatchResult,
	"session.watch": decodeWatchResult,
	"controller.lease.acquire": decodeLeaseResult,
	"controller.lease.renew": decodeLeaseResult,
	"controller.lease.release": decodeLeaseResult,
	"prompt.lease.acquire": decodeLeaseResult,
	"prompt.lease.renew": decodeLeaseResult,
	"prompt.lease.release": decodeLeaseResult,
	"preview.launch": decodePreviewMutationResult,
	"preview.state": decodePreviewStateResult,
	"preview.activate": decodePreviewMutationResult,
	"preview.navigate": decodePreviewMutationResult,
	"preview.back": decodePreviewMutationResult,
	"preview.forward": decodePreviewMutationResult,
	"preview.reload": decodePreviewMutationResult,
	"preview.close": decodePreviewMutationResult,
	"preview.capture": decodePreviewMutationResult,
	"preview.capture.read": decodePreviewCaptureReadResult,
	"preview.click": decodePreviewMutationResult,
	"preview.fill": decodePreviewMutationResult,
	"preview.scroll": decodePreviewMutationResult,
	"preview.type": decodePreviewMutationResult,
	"preview.select": decodePreviewMutationResult,
	"preview.press": decodePreviewMutationResult,
	"preview.upload": decodePreviewMutationResult,
	"preview.policy.check": decodePreviewPolicyCheckResult,
	"preview.lease.acquire": decodePreviewLeaseResult,
	"preview.lease.renew": decodePreviewLeaseResult,
	"preview.lease.release": decodePreviewLeaseReleaseResult,
	"preview.handoff": decodePreviewMutationResult,
	"ci.run": value => decodeCiRunResult(value) as unknown as CommandResult,
};
export function decodeCommandArguments(command: string, value: unknown): CommandArguments {
	const decoder = COMMAND_ARGUMENT_DECODERS[command];
	if (decoder === undefined) fail("INVALID_FRAME", "command has no typed argument decoder", "command");
	return decoder(value);
}
export function decodeCommandResult(command: string, value: unknown): CommandResult {
	const decoder = COMMAND_RESULT_DECODERS[command];
	if (decoder === undefined) fail("INVALID_FRAME", "command has no typed result decoder", "command");
	return decoder(value);
}
