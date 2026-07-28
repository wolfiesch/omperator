import type { PreviewAction, PreviewSnapshot } from "../additive.js";
import type { ArtifactId, EntryId, HostId, ImageId, LeaseId, PreviewCaptureId, PreviewId, RequestId, Revision, SessionId, TurnId, CommandId, ConfirmationId } from "../ids.js";
import { PROTOCOL_VERSION } from "../limits.js";

export type CommandArguments = Record<string, unknown>;
export type CommandResult = Record<string, unknown>;

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
