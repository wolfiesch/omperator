export { OmpClient, createOmpClient } from "./omp-client-runtime.ts";
export {
  ompAppV1ProtocolProvider,
} from "./omp-app-v1-protocol-provider.ts";
export {
  defaultOmpProtocolProviderRegistry,
  OmpProtocolProviderRegistry,
} from "./omp-protocol-provider-registry.ts";
export type {
  OmpClientMessage,
  OmpPairOk,
  OmpProtocolProvider,
  OmpResponse,
  OmpServerEventOf,
  OmpServerPayload,
  OmpServerEvent,
  PublicOmpServerEvent,
} from "./omp-protocol-provider.ts";
export { isConfirmationDecisionConsumed } from "./omp-client-response.ts";
export {
  OmpClientError,
  DefaultClock,
  DefaultIds,
  DefaultTimers,
  MAX_SAVED,
  MAX_PENDING,
  MAX_INBOUND_FRAMES,
  MAX_INBOUND_BYTES,
} from "./omp-client-contracts.ts";
export type {
  OmpClientState,
  ClientErrorCode,
  OmpClientErrorOptions,
  OmpTransport,
  OmpTransportFactory,
  Unsubscribe,
  CursorRecord,
  CursorStore,
  Clock,
  TimerScheduler,
  IdFactory,
  OmpClientOptions,
  OmpStateSnapshot,
  OmpResourceSnapshot,
  CommandIntent,
  CommandOptions,
  ConfirmIntent,
  PairStartIntent,
  TerminalInputIntent,
  TerminalResizeIntent,
  TerminalCloseIntent,
  PublicServerFrame,
} from "./omp-client-contracts.ts";
export {
  PROJECTION_CACHE_VERSION,
  MAX_PROJECTION_CACHE_BYTES,
  MAX_PROJECTION_CACHE_SESSIONS,
  encodeProjectionCache,
  decodeProjectionCache,
  decodeProjectionCacheValue,
} from "./projection-cache.ts";
export type { ProjectionCacheStore, ProjectionCacheEnvelope } from "./projection-cache.ts";
export {
  createProjectionSnapshot,
  applyPublicEvent,
  applyPublicFrame,
  ProjectionStore,
  createProjectionStore,
  MAX_RETAINED_TERMINALS,
  MAX_RETAINED_TERMINAL_BYTES,
  MAX_RETAINED_TERMINAL_BYTES_PER_TERMINAL,
  MAX_RETAINED_FILES,
  MAX_RETAINED_FILES_BYTES,
  MAX_RETAINED_FILE_BYTES,
} from "./projection.ts";
export type {
  ProjectionFrame,
  ProjectionEventFrame,
  ProjectionFreshness,
  TerminalProjection,
  ResultProjection,
  AgentTranscriptProjection,
  SessionProjection,
  ProjectionSnapshot,
  SessionIndexMetadata,
  ProjectionOptions,
  ProjectionSubscription,
} from "./projection.ts";
export {
  MAX_RETAINED_TRANSCRIPT_ENTRIES,
  MAX_RETAINED_TRANSCRIPT_BYTES,
  MAX_RETAINED_TRANSCRIPT_ENTRY_BYTES,
  MAX_RETAINED_AGENT_TRANSCRIPTS,
  MAX_RETAINED_AGENT_TRANSCRIPT_ENTRIES,
  MAX_RETAINED_AGENT_TRANSCRIPT_BYTES,
  MAX_RETAINED_SESSION_EVENTS,
  MAX_RETAINED_SESSION_EVENTS_BYTES,
  MAX_RETAINED_SESSION_EVENT_BYTES,
  MAX_RETAINED_LIVE_MESSAGE_BYTES,
  MAX_RETAINED_LIVE_MESSAGES,
  MAX_RETAINED_TOOL_CALLS,
  MAX_RETAINED_TOOL_VALUE_BYTES,
  MAX_RETAINED_PROGRESS_LINE_BYTES,
  retainedJsonBytes,
  retainedText,
  sanitizeRetainedValue,
  sanitizeRetainedRecord,
  sanitizeRetainedDurableEntry,
  retainDurableEntries,
  appendRetainedDurableEntry,
  appendRetainedValue,
  sanitizeRetainedTranscriptFrame,
} from "./transcript-retention.ts";
export type {
  RetainedDurableEntries,
  RetainDurableEntryOptions,
  RetainedTranscriptFrame,
} from "./transcript-retention.ts";
export {
  DesktopRuntimeError,
  DesktopRuntimeController,
  createDesktopRuntimeController,
} from "./desktop-runtime.ts";
export type {
  DesktopUpdateOpenEvent,
  DesktopUpdatePhase,
  DesktopUpdateState,
  LocalProfile,
  LocalProfileAddRequest,
  LocalProfileListResult,
  LocalProfileRemoveResult,
  LocalProfileRequest,
  LocalProfileResult,
  LocalProfileUpdateRequest,
} from "@t4-code/protocol/desktop-ipc";
export { redactedMessage } from "./desktop-runtime-contracts.ts";
export type {
  DesktopShellPort,
  DesktopRuntimeStartState,
  DesktopHostMetadata,
  DesktopRuntimeErrorEntry,
  DesktopServerEventFilter,
  DesktopServerEventSubscription,
  DesktopRuntimeSnapshot,
  DesktopRuntimeSnapshotListener,
  DesktopRuntimeOptions,
  DesktopRuntimeTimerScheduler,
  DesktopControllerLease,
  DesktopControllerLeaseAcquireResult,
  DesktopControllerLeaseResult,
  DesktopControllerLeaseOperationResult,
  DesktopControllerLeaseOptions,
} from "./desktop-runtime.ts";
