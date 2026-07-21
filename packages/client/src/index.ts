export { OmpClient, createOmpClient } from "./omp-client-runtime.ts";
export {
  DEFAULT_CLUSTER_OPERATOR_ENABLED,
  OMP_RUNTIME_INTEGRATION,
  OMP_RUNTIME_KIND,
  T4_RUNTIME_FEATURES,
  availableRuntimeFeature,
  runtimeIdentityKey,
  clusterOperatorRequestedCapabilities,
  clusterOperatorRequestedFeatures,
  unavailableRuntimeFeature,
} from "./runtime-integration.ts";
export type {
  KnownRuntimeFeature,
  RuntimeFeature,
  RuntimeFeatureMap,
  RuntimeFeatureSupport,
  RuntimeIdentity,
  RuntimeIntegrationDescriptor,
  RuntimeIntegrationLevel,
  RuntimeKind,
} from "./runtime-integration.ts";
export type {
  PreviewCommandTarget,
  PreviewLaunchIntent,
  PreviewNavigateIntent,
  PreviewClickIntent,
  PreviewScrollIntent,
  PreviewTypeIntent,
  PreviewFillIntent,
  PreviewSelectIntent,
  PreviewUploadIntent,
  PreviewPressIntent,
  PreviewPolicyCheckIntent,
  PreviewHandoffIntent,
} from "./omp-client-runtime.ts";
export { ompAppV1ProtocolProvider } from "./omp-app-v1-protocol-provider.ts";
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
  MAX_INDEXED_WORKSPACES,
  MAX_RETAINED_TERMINALS,
  MAX_RETAINED_TERMINAL_BYTES,
  MAX_RETAINED_TERMINAL_BYTES_PER_TERMINAL,
  MAX_RETAINED_FILES,
  MAX_RETAINED_FILES_BYTES,
  MAX_RETAINED_FILE_BYTES,
  MAX_RETAINED_PREVIEWS,
  MAX_RETAINED_PREVIEW_EVENTS,
} from "./projection.ts";
export {
  PreviewCaptureResource,
  PreviewLeaseManager,
  previewKey,
  PREVIEW_CAPTURE_MAX_BYTES,
  PREVIEW_CAPTURE_MAX_PIXELS,
  PREVIEW_CAPTURE_READ_CHUNK_BYTES,
} from "./preview.ts";
export type {
  PreviewIdentity,
  PreviewLeaseIdentity,
  PreviewCaptureMetadata,
  PreviewCaptureReadResult,
  PreviewCaptureResourceOptions,
  PreviewLeaseManagerClient,
  PreviewLeaseManagerOptions,
} from "./preview.ts";
export type {
  ProjectionFrame,
  ProjectionEventFrame,
  ProjectionFreshness,
  PreviewFreshness,
  PreviewProjection,
  PreviewAuthorityProjection,
  PreviewEventProjection,
  TerminalProjection,
  ResultProjection,
  AgentTranscriptProjection,
  SessionProjection,
  ProjectionSnapshot,
  SessionIndexMetadata,
  ProjectionOptions,
  ProjectionSubscription,
} from "./projection.ts";
export type { WorkspaceInfrastructureProjection } from "@t4-code/protocol";
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
export { deriveAttentionInbox, readSessionAttention } from "./attention-projection.ts";
export {
  ProjectFileSearchError,
  searchProjectFiles,
} from "./project-file-search.ts";
export type {
  ProjectFileSearchAddress,
  ProjectFileSearchArguments,
  ProjectFileSearchMatch,
  ProjectFileSearchResult,
  ProjectFileSearchRuntime,
} from "./project-file-search.ts";
export type {
  AttentionActionability,
  AttentionActionabilityInputs,
  AttentionActionStatus,
  AttentionApprovalItem,
  AttentionConfirmationItem,
  AttentionGroup,
  AttentionIdentity,
  AttentionInboxItem,
  AttentionInboxProjection,
  AttentionInventoryIssue,
  AttentionInventoryReason,
  AttentionInventoryState,
  AttentionNeedsYouItem,
  AttentionOutcomeItem,
  AttentionOutcomeKind,
  AttentionPendingKind,
  AttentionPlanItem,
  AttentionQuestionItem,
  AttentionQuestionOption,
  AttentionSessionContext,
  AttentionUnavailableReason,
  DeriveAttentionInboxOptions,
  SessionAttentionRead,
} from "./attention-projection.ts";
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
export {
  browserErrorMessage,
  browserMethodIsMutation,
  isBrowserShellPort,
  requireExplicitBrowserProfile,
} from "./browser-runtime-contracts.ts";
export type {
  BrowserShellEventListener,
  BrowserShellPort,
  BrowserShellSubscription,
} from "./browser-runtime-contracts.ts";
export type {
  BrowserCall,
  BrowserCallError,
  BrowserCallResult,
  BrowserEvent,
  BrowserMethod,
  BrowserProfile,
  OwnerSessionId,
} from "@t4-code/protocol/browser-ipc";
export {
  createTranscriptSearchCoordinator,
  decodeTranscriptContextResult,
  decodeTranscriptSearchResult,
  TranscriptSearchCoordinator,
  TranscriptSearchError,
} from "./transcript-search.ts";
export type {
  HostedTranscriptSearchItem,
  TranscriptContextArguments,
  TranscriptContextResult,
  TranscriptContextRow,
  TranscriptSearchArchivedFilter,
  TranscriptSearchArguments,
  TranscriptSearchHighlight,
  TranscriptSearchHostState,
  TranscriptSearchHostStatus,
  TranscriptSearchIndexState,
  TranscriptSearchIndexStatus,
  TranscriptSearchItem,
  TranscriptSearchListener,
  TranscriptSearchOptions,
  TranscriptSearchResult,
  TranscriptSearchRole,
  TranscriptSearchRuntime,
  TranscriptSearchSnapshot,
} from "./transcript-search.ts";
export { readTranscriptPage, TranscriptPageClientError } from "./transcript-page.ts";
export type {
  TranscriptPageAddress,
  TranscriptPageArguments,
  TranscriptPageResult,
  TranscriptPageRuntime,
} from "./transcript-page.ts";
