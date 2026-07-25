import type {
  Cursor,
  DurableEntry,
  OmpServerFrame,
  SessionRef,
  WorkspaceInfrastructureProjection,
} from "@t4-code/protocol";
import type { PublicOmpServerEvent } from "./omp-protocol-provider.ts";
import type { PreviewCaptureMetadata } from "./preview.ts";

export type ProjectionFrame = Exclude<OmpServerFrame, Extract<OmpServerFrame, { type: "pair.ok" }>>;
type ProjectionEventFrameFromEvent<Event extends PublicOmpServerEvent> =
  Event extends PublicOmpServerEvent ? Readonly<{ type: Event["kind"] } & Event["payload"]> : never;
export type ProjectionEventFrame = ProjectionEventFrameFromEvent<PublicOmpServerEvent>;
export type ProjectionInputFrame = ProjectionFrame | ProjectionEventFrame;
export type ProjectionInput<Kind extends ProjectionInputFrame["type"]> = Extract<
  ProjectionInputFrame,
  { type: Kind }
>;
export type ProjectionAgentFrame = ProjectionInput<"agent">;
export type ProjectionAgentTranscriptFrame = ProjectionInput<"agent.transcript">;
export type ProjectionAuditFrame = ProjectionInput<"audit">;
export type ProjectionConfirmationFrame = ProjectionInput<"confirmation">;
export type ProjectionFileFrame = ProjectionInput<"files">;
export type ProjectionGapFrame = ProjectionInput<"gap">;
export type ProjectionLiveEventFrame = ProjectionInput<"event">;
export type ProjectionResultFrame = ProjectionInput<"response">;
export type ProjectionPreviewFrame = Extract<
  ProjectionInputFrame,
  {
    type:
      | "preview.launch"
      | "preview.state"
      | "preview.navigation"
      | "preview.capture"
      | "preview.error";
  }
>;
export type ProjectionReviewFrame = ProjectionInput<"review">;
export type ProjectionFreshness = "fresh" | "catching-up" | "cached";
export type PreviewFreshness = ProjectionFreshness | "stale";
export type PreviewAction =
  | "activate"
  | "navigate"
  | "back"
  | "forward"
  | "reload"
  | "close"
  | "capture"
  | "click"
  | "fill"
  | "type"
  | "press"
  | "scroll"
  | "select"
  | "upload"
  | "handoff";

export interface PreviewAuthorityProjection {
  readonly id: string;
  readonly label: string;
  readonly kind: "isolated-session" | "authenticated-profile";
  readonly requiresExplicitOptIn: boolean;
}

export interface PreviewEventProjection {
  readonly type: "launch" | "navigation" | "capture" | "error";
  readonly previewId: string;
  readonly cursor: Cursor;
  readonly url?: Readonly<{ origin: string; pathname: string; hasQuery: boolean }>;
  readonly timestamp?: number;
  readonly captureId?: string;
  readonly errorCode?: string;
}

export interface PreviewProjection {
  readonly hostId: string;
  readonly sessionId: string;
  readonly previewId: string;
  readonly state?: "launching" | "ready" | "running" | "stopped" | "failed";
  readonly url?: string;
  readonly revision: string;
  readonly cursor: Cursor;
  readonly title?: string;
  readonly canGoBack?: boolean;
  readonly canGoForward?: boolean;
  readonly viewport?: Readonly<{ width: number; height: number; deviceScaleFactor?: number }>;
  readonly capture?: PreviewCaptureMetadata;
  /** Labels and trust class only; no browser credential or profile state. */
  readonly authority?: PreviewAuthorityProjection;
  readonly availableActions?: readonly PreviewAction[];
  readonly error?: Readonly<{ code: string; message: string }>;
  readonly freshness: PreviewFreshness;
}

export interface TerminalProjection {
  readonly terminalId: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number;
  readonly closed: boolean;
}

export interface ResultProjection {
  readonly requestId: string;
  readonly commandId?: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface AgentTranscriptProjection {
  readonly entries: readonly DurableEntry[];
  readonly entryIds: ReadonlySet<string>;
  readonly cursor: Cursor;
  readonly revision: string;
  readonly freshness: ProjectionFreshness;
  readonly historyTruncated?: boolean;
}

export interface SessionProjection {
  readonly hostId: string;
  readonly sessionId: string;
  readonly ref?: SessionRef;
  readonly entries: readonly DurableEntry[];
  readonly events: readonly ProjectionLiveEventFrame[];
  readonly agents: ReadonlyMap<string, ProjectionAgentFrame>;
  readonly agentTranscripts: ReadonlyMap<string, AgentTranscriptProjection>;
  readonly terminals: ReadonlyMap<string, TerminalProjection>;
  readonly files: ReadonlyMap<string, ProjectionFileFrame>;
  readonly reviews: ReadonlyMap<string, ProjectionReviewFrame>;
  readonly audit: readonly ProjectionAuditFrame[];
  readonly confirmations: ReadonlyMap<string, ProjectionConfirmationFrame>;
  readonly results: ReadonlyMap<string, ResultProjection>;
  /** Preview metadata only. Decoded pixels and object URLs belong to PreviewCaptureResource. */
  readonly previews: ReadonlyMap<string, PreviewProjection>;
  /** Bounded, cursor-deduplicated activity metadata for the preview workspace. */
  readonly previewEvents: readonly PreviewEventProjection[];
  readonly revision?: string;
  readonly cursor?: Cursor;
  readonly epoch?: string;
  readonly freshness: ProjectionFreshness;
  /** Local receive order of the newest accepted session event. */
  readonly transcriptEventArrivalOrdinal: number;
  /** Local receive order of the newest context-maintenance event. */
  readonly contextMaintenanceEventArrivalOrdinal: number;
  readonly gap?: ProjectionGapFrame | undefined;
  readonly historyTruncated?: boolean;
  readonly entryIds: ReadonlySet<string>;
}

export interface SessionIndexMetadata {
  readonly totalCount: number;
  readonly truncated: boolean;
}

export interface ProjectionSnapshot {
  readonly version: 1;
  readonly sessions: ReadonlyMap<string, SessionProjection>;
  readonly activeSessionKey?: string | undefined;
  readonly sessionIndex: ReadonlyMap<string, SessionRef>;
  readonly sessionIndexMetadata: ReadonlyMap<string, SessionIndexMetadata>;
  readonly sessionRefArrivalOrdinals: ReadonlyMap<string, number>;
  readonly sessionDeltaCursors: ReadonlyMap<string, Cursor>;
  readonly sessionInventoryCursors: ReadonlyMap<string, Cursor>;
  readonly workspaces: ReadonlyMap<string, WorkspaceInfrastructureProjection>;
  readonly workspaceCursors: ReadonlyMap<string, Cursor>;
  readonly lru: readonly string[];
  readonly cursor?: Cursor;
  readonly epoch?: string;
  readonly freshness: ProjectionFreshness;
  readonly arrivalOrdinal: number;
}

export interface ProjectionOptions {
  readonly maxWarmSessions?: number;
  readonly maxIndexedSessions?: number;
  readonly maxWorkspaces?: number;
  readonly maxEntries?: number;
  readonly maxTranscriptBytes?: number;
  readonly maxEntryBytes?: number;
  readonly maxEvents?: number;
  readonly maxEventsBytes?: number;
  readonly maxEventBytes?: number;
  readonly maxAudit?: number;
  readonly maxAgentTranscripts?: number;
  readonly maxAgentTranscriptEntries?: number;
  readonly maxAgentTranscriptBytes?: number;
  readonly maxTerminals?: number;
  readonly maxTerminalBytes?: number;
  readonly maxTerminalBytesPerTerminal?: number;
  readonly maxFiles?: number;
  readonly maxFilesBytes?: number;
  readonly maxFileBytes?: number;
  readonly maxPreviews?: number;
  readonly maxPreviewEvents?: number;
}

export interface ProjectionSubscription {
  (snapshot: ProjectionSnapshot, input?: ProjectionFrame | PublicOmpServerEvent): void;
}

export const MAX_INDEXED_SESSION_REFS = 1000;
export const MAX_INDEXED_WORKSPACES = 1000;
export const MAX_RETAINED_TERMINALS = 64;
export const MAX_RETAINED_TERMINAL_BYTES = 1024 * 1024;
export const MAX_RETAINED_TERMINAL_BYTES_PER_TERMINAL = 256 * 1024;
export const MAX_RETAINED_FILES = 256;
export const MAX_RETAINED_FILES_BYTES = 4 * 1024 * 1024;
export const MAX_RETAINED_FILE_BYTES = 768 * 1024;
export const MAX_RETAINED_PREVIEWS = 32;
export const MAX_RETAINED_PREVIEW_EVENTS = 128;
