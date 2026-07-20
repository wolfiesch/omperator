import 'dart:typed_data';

import '../host/host_profile.dart';
import '../protocol/models.dart';
import 'model_labels.dart';

enum ConnectionPhase {
  disconnected,
  connecting,
  synchronizing,
  ready,
  retrying,
  failed,
}

enum AuthenticationPhase { unknown, local, pairingRequired, pairing, paired }

const List<String> t4RequestedFeatures = <String>[
  'resume',
  'host.watch',
  'session.watch',
  'session.state',
  'session.delta',
  'session.observer',
  'controller.lease',
  'prompt.lease',
  'prompt.images',
  'transcript.images',
  'transcript.search',
  'transcript.page',
  'agent.lifecycle',
  'agent.progress',
  'agent.event',
  'agent.transcript',
  'terminal.io',
  'files.list',
  'files.diff',
  'audit.tail',
  'catalog.metadata',
  'settings.metadata',
  'preview.control',
];

const List<String> t4RequestedCapabilities = <String>[
  'sessions.read',
  'sessions.prompt',
  'sessions.control',
  'sessions.manage',
  'term.open',
  'term.input',
  'term.resize',
  'files.read',
  'files.write',
  'files.list',
  'files.diff',
  'agents.control',
  'audit.read',
  'config.read',
  'catalog.read',
  'config.write',
  'broker.read',
  'usage.read',
  'preview.read',
  'preview.control',
  'preview.input',
];

final String t4PairCommand = <String>[
  'omp appserver pair',
  for (final capability in t4RequestedCapabilities) '--capability $capability',
].join(' ');

enum MessageRole { user, assistant, system, tool }

enum TranscriptKind { message, tool, compaction, notice }

final class TranscriptImageMetadata {
  const TranscriptImageMetadata({required this.sha256, required this.mimeType});

  final String sha256;
  final String mimeType;
}

final class SessionSummary {
  const SessionSummary({
    required this.hostId,
    required this.sessionId,
    required this.title,
    required this.revision,
    required this.status,
    this.projectId = 'unknown-project',
    this.projectName = 'Project',
    this.updatedAt = '',
    this.archivedAt,
    this.working = false,
    this.modelSelector,
    this.modelDisplayName,
    this.thinking,
    this.thinkingSupported,
    this.thinkingLevels = const <String>[],
    this.fast = false,
    this.fastAvailable = false,
    this.turnActive = false,
    this.queuedFollowUpCount = 0,
  });

  final String hostId;
  final String sessionId;
  final String title;
  final String revision;
  final String status;
  final String projectId;
  final String projectName;
  final String updatedAt;
  final String? archivedAt;
  final bool working;
  final String? modelSelector;
  final String? modelDisplayName;
  final String? thinking;
  final bool? thinkingSupported;
  final List<String> thinkingLevels;
  final bool fast;
  final bool fastAvailable;
  final bool turnActive;
  final int queuedFollowUpCount;

  bool get archived => archivedAt != null;
}

final class TranscriptMessage {
  const TranscriptMessage({
    required this.id,
    required this.role,
    required this.text,
    this.kind = TranscriptKind.message,
    this.reasoning = '',
    this.streaming = false,
    this.toolName,
    this.toolTitle,
    this.toolArguments,
    this.toolOutput,
    this.toolSucceeded,
    this.toolRunning = false,
    this.toolProgress,
    this.images = const <TranscriptImageMetadata>[],
  });

  final String id;
  final MessageRole role;
  final String text;
  final TranscriptKind kind;
  final String reasoning;
  final bool streaming;
  final String? toolName;
  final String? toolTitle;
  final String? toolArguments;
  final String? toolOutput;
  final bool? toolSucceeded;
  final bool toolRunning;
  final double? toolProgress;
  final List<TranscriptImageMetadata> images;
}

final class ComposerModelChoice {
  const ComposerModelChoice({
    required this.label,
    required this.selector,
    this.provider = '',
    this.providerLabel = '',
    this.supported = true,
    this.reason,
  });

  final String label;
  final String selector;

  /// Raw provider id (empty when the model has no provider).
  final String provider;

  /// Friendly provider name (empty when none).
  final String providerLabel;
  final bool supported;
  final String? reason;
}

final class ComposerSlashCommand {
  const ComposerSlashCommand({
    required this.name,
    required this.description,
    required this.insert,
    this.disabledReason,
  });

  final String name;
  final String description;
  final String insert;
  final String? disabledReason;
}

final class SessionComposerState {
  const SessionComposerState({
    this.modelLabel,
    this.modelSelector,
    this.modelChoices = const <ComposerModelChoice>[],
    this.modelGroups = const <ModelProviderGroup>[],
    this.slashCommands = const <ComposerSlashCommand>[],
    this.thinking,
    this.thinkingLevels = const <String>[],
    this.fastEnabled = false,
    this.fastAvailable = false,
    this.turnActive = false,
    this.queuedFollowUpCount = 0,
  });

  final String? modelLabel;
  final String? modelSelector;
  final List<ComposerModelChoice> modelChoices;

  /// Provider-grouped choices for the navigable model selector.
  final List<ModelProviderGroup> modelGroups;
  final List<ComposerSlashCommand> slashCommands;
  final String? thinking;
  final List<String> thinkingLevels;
  final bool fastEnabled;
  final bool fastAvailable;
  final bool turnActive;
  final int queuedFollowUpCount;
}

final class PromptImageAttachment {
  const PromptImageAttachment({
    required this.id,
    required this.name,
    required this.mimeType,
    required this.bytes,
  });

  final String id;
  final String name;
  final String mimeType;
  final Uint8List bytes;
}

enum AttentionKind {
  approval,
  question,
  plan,
  confirmation,
  completed,
  failed,
  cancelled,
}

enum AttentionDecision { approve, deny, revise, reject }

final class AttentionChoice {
  const AttentionChoice({required this.id, required this.label});

  final String id;
  final String label;
}

final class AttentionItem {
  const AttentionItem({
    required this.key,
    required this.kind,
    required this.sessionId,
    required this.sessionTitle,
    required this.revision,
    required this.title,
    required this.summary,
    required this.at,
    this.requestId,
    this.confirmationId,
    this.commandId,
    this.expiresAt,
    this.choices = const <AttentionChoice>[],
    this.allowText = false,
    this.actionable = false,
  });

  final String key;
  final AttentionKind kind;
  final String sessionId;
  final String sessionTitle;
  final String revision;
  final String title;
  final String summary;
  final DateTime at;
  final String? requestId;
  final String? confirmationId;
  final String? commandId;
  final DateTime? expiresAt;
  final List<AttentionChoice> choices;
  final bool allowText;
  final bool actionable;

  bool get needsResponse =>
      kind == AttentionKind.approval ||
      kind == AttentionKind.question ||
      kind == AttentionKind.plan ||
      kind == AttentionKind.confirmation;

  bool get isProblem =>
      kind == AttentionKind.failed || kind == AttentionKind.cancelled;
}

final class AgentActivity {
  const AgentActivity({
    required this.agentId,
    required this.sessionId,
    required this.label,
    required this.status,
    required this.updatedAt,
    this.progress,
    this.parentAgentId,
    this.description,
    this.model,
    this.currentTool,
    this.evidence,
  });

  final String agentId;
  final String sessionId;
  final String label;
  final String status;
  final DateTime updatedAt;
  final double? progress;
  final String? parentAgentId;
  final String? description;
  final String? model;
  final String? currentTool;
  final String? evidence;
}

final class AttentionResponse {
  const AttentionResponse({
    required this.decision,
    this.optionIds = const <String>[],
    this.text = '',
  });

  final AttentionDecision decision;
  final List<String> optionIds;
  final String text;
}

enum DeveloperSurface { activity, files, review, terminal, preview }

final class DeveloperActivity {
  const DeveloperActivity({
    required this.id,
    required this.category,
    required this.title,
    required this.detail,
    required this.at,
    required this.raw,
  });

  final String id;
  final String category;
  final String title;
  final String detail;
  final DateTime at;
  final String raw;
}

final class TerminalSession {
  const TerminalSession({
    required this.terminalId,
    required this.sessionId,
    required this.title,
    this.output = '',
    this.running = true,
    this.exitCode,
    this.signal,
  });

  final String terminalId;
  final String sessionId;
  final String title;
  final String output;
  final bool running;
  final int? exitCode;
  final String? signal;
}

final class DeveloperFileEntry {
  const DeveloperFileEntry({
    required this.path,
    required this.kind,
    this.size,
    this.revision,
  });

  final String path;
  final String kind;
  final int? size;
  final String? revision;
}

final class FileWorkspaceState {
  const FileWorkspaceState({
    this.path = '',
    this.entries = const <DeveloperFileEntry>[],
    this.content,
    this.diff,
    this.revision,
    this.loading = false,
    this.error,
  });

  final String path;
  final List<DeveloperFileEntry> entries;
  final String? content;
  final String? diff;
  final String? revision;
  final bool loading;
  final String? error;
}

final class ReviewWorkspaceItem {
  const ReviewWorkspaceItem({
    required this.reviewId,
    required this.sessionId,
    required this.status,
    required this.findings,
    this.path,
  });

  final String reviewId;
  final String sessionId;
  final String status;
  final String? path;
  final List<Map<String, Object?>> findings;
}

final class PreviewWorkspaceState {
  const PreviewWorkspaceState({
    required this.previewId,
    required this.sessionId,
    required this.state,
    required this.url,
    required this.revision,
    this.title,
    this.canGoBack = false,
    this.canGoForward = false,
    this.capture,
    this.captureMimeType,
    this.error,
  });

  final String previewId;
  final String sessionId;
  final String state;
  final String url;
  final String revision;
  final String? title;
  final bool canGoBack;
  final bool canGoForward;
  final Uint8List? capture;
  final String? captureMimeType;
  final String? error;
}

enum T4ThemePreference { system, light, dark }

enum T4LifecyclePhase { resumed, background }

enum HostSettingControlKind {
  boolean,
  number,
  text,
  enumeration,
  list,
  map,
  secret,
  unsupported,
}

final class HostSettingOption {
  const HostSettingOption({
    required this.value,
    required this.label,
    this.help,
  });

  final String value;
  final String label;
  final String? help;
}

final class HostSettingEntry {
  const HostSettingEntry({
    required this.path,
    required this.section,
    required this.label,
    required this.help,
    required this.control,
    required this.configured,
    required this.options,
    required this.writableScopes,
    required this.restartRequired,
    required this.available,
    required this.sensitive,
    this.effectiveValue,
    this.effectiveSource,
    this.min,
    this.max,
    this.unit,
  });

  final String path;
  final String section;
  final String label;
  final String help;
  final HostSettingControlKind control;
  final Object? effectiveValue;
  final bool configured;
  final String? effectiveSource;
  final List<HostSettingOption> options;
  final num? min;
  final num? max;
  final String? unit;
  final List<String> writableScopes;
  final bool restartRequired;
  final bool available;
  final bool sensitive;
}

final class HostSettingsState {
  const HostSettingsState({
    this.revision,
    this.entries = const <HostSettingEntry>[],
    this.loading = false,
    this.error,
    this.issues = const <String>[],
  });

  final String? revision;
  final List<HostSettingEntry> entries;
  final bool loading;
  final String? error;
  final List<String> issues;
}

final class T4ViewState {
  const T4ViewState({
    required this.connectionPhase,
    this.sessions = const <SessionSummary>[],
    this.selectedSessionId,
    this.messages = const <TranscriptMessage>[],
    this.transcriptHistoryLoading = false,
    this.transcriptHistoryHasMore = false,
    this.transcriptHistoryError,
    this.transcriptTailFromCache = false,
    this.errorMessage,
    this.hostDirectory = const HostDirectory.empty(),
    this.authenticationPhase = AuthenticationPhase.unknown,
    this.grantedCapabilities = const <String>{},
    this.grantedFeatures = const <String>{},
    this.targetConfigured = false,
    this.hostOperationPending = false,
    this.submitting = false,
    this.sessionOperationPending = false,
    this.composer = const SessionComposerState(),
    this.attentionItems = const <AttentionItem>[],
    this.agentActivities = const <AgentActivity>[],
    this.attentionPartial = false,
    this.omittedAttentionCount = 0,
    this.activities = const <DeveloperActivity>[],
    this.terminals = const <TerminalSession>[],
    this.activeTerminalId,
    this.fileWorkspace = const FileWorkspaceState(),
    this.previews = const <PreviewWorkspaceState>[],
    this.reviews = const <ReviewWorkspaceItem>[],
    this.activePreviewId,
    this.developerOperationPending = false,
    this.themePreference = T4ThemePreference.system,
    this.settings = const HostSettingsState(),
    this.lifecyclePhase = T4LifecyclePhase.resumed,
    this.settingsOperationPending = false,
  });

  const T4ViewState.disconnected()
    : this(connectionPhase: ConnectionPhase.disconnected);

  final ConnectionPhase connectionPhase;
  final List<SessionSummary> sessions;
  final String? selectedSessionId;
  final List<TranscriptMessage> messages;
  final bool transcriptHistoryLoading;
  final bool transcriptHistoryHasMore;
  final String? transcriptHistoryError;
  final bool transcriptTailFromCache;
  final String? errorMessage;
  final HostDirectory hostDirectory;
  final AuthenticationPhase authenticationPhase;
  final Set<String> grantedCapabilities;
  final Set<String> grantedFeatures;
  final bool targetConfigured;
  final bool hostOperationPending;
  final bool submitting;
  final bool sessionOperationPending;
  final SessionComposerState composer;
  final List<AttentionItem> attentionItems;
  final List<AgentActivity> agentActivities;
  final bool attentionPartial;
  final int omittedAttentionCount;
  final List<DeveloperActivity> activities;
  final List<TerminalSession> terminals;
  final String? activeTerminalId;
  final FileWorkspaceState fileWorkspace;
  final List<PreviewWorkspaceState> previews;
  final List<ReviewWorkspaceItem> reviews;
  final String? activePreviewId;
  final bool developerOperationPending;
  final T4ThemePreference themePreference;
  final HostSettingsState settings;
  final T4LifecyclePhase lifecyclePhase;
  final bool settingsOperationPending;

  TerminalSession? get activeTerminal => terminals
      .where((terminal) => terminal.terminalId == activeTerminalId)
      .firstOrNull;

  PreviewWorkspaceState? get activePreview => previews
      .where((preview) => preview.previewId == activePreviewId)
      .firstOrNull;

  int get urgentAttentionCount =>
      attentionItems.where((item) => item.needsResponse).length +
      omittedAttentionCount;

  SessionSummary? get selectedSession {
    for (final session in sessions) {
      if (session.sessionId == selectedSessionId) return session;
    }
    return null;
  }
}

abstract interface class T4Actions {
  Future<void> connect();
  Future<void> disconnect();
  Future<void> setThemePreference(T4ThemePreference preference);
  Future<void> refreshSettings();
  Future<void> writeSetting(
    String path,
    String scope, {
    Object? value,
    bool reset = false,
  });
  Future<void> handleLifecyclePhase(T4LifecyclePhase phase);

  void cancelHostProbe();

  Future<void> addHost(
    String address, {
    String profileId = defaultHostProfileId,
  });

  Future<void> activateHost(String endpointKey);

  Future<void> removeHost(String endpointKey);

  Future<void> pairHost(String code);

  Future<void> selectSession(String sessionId);
  Future<void> createSession(String projectId, {String? title});

  Future<void> renameSession(String sessionId, String title);

  Future<void> terminateSession(String sessionId);

  Future<void> archiveSession(String sessionId);

  Future<void> restoreSession(String sessionId);

  Future<void> deleteSession(String sessionId);
  Future<TranscriptSearchResult> searchTranscripts({
    required String query,
    String? cursor,
    String? projectId,
    List<TranscriptSearchRole>? roles,
    String archived = 'include',
    DateTime? from,
    DateTime? to,
  });

  Future<TranscriptContextResult> loadTranscriptContext({
    required String sessionId,
    required String anchorId,
    int before = 8,
    int after = 8,
  });

  Future<void> loadEarlierTranscript();

  Future<UsageReadResult> readUsage();
  Future<BrokerStatusResult> readBrokerStatus();

  Future<bool> submitPrompt(
    String message, {
    List<PromptImageAttachment> images = const <PromptImageAttachment>[],
  });

  Future<bool> queuePrompt(String message);

  Future<void> cancelTurn();

  Future<void> setSessionModel(String selector);

  Future<void> setSessionThinking(String level);

  Future<void> setSessionFast(bool enabled);

  Future<bool> respondToAttention(
    AttentionItem item,
    AttentionResponse response,
  );

  Future<void> retrySession(String sessionId);

  Future<void> refreshActivity();

  Future<String> openTerminal({String? cwd});
  void sendTerminalInput(String terminalId, String data);
  void resizeTerminal(String terminalId, int cols, int rows);

  Future<void> cancelAgent(String agentId);
  void closeTerminal(String terminalId);

  Future<void> listFiles([String path = '']);
  Future<void> readFile(String path);
  Future<void> loadSessionDiff();
  Future<void> writeFile(String path, String content);
  Future<void> refreshReview(String reviewId);
  Future<void> applyReview(String reviewId);

  Future<String> launchPreview(String url);
  Future<void> selectPreview(String previewId);
  Future<void> navigatePreview(String previewId, String url);
  Future<void> runPreviewAction(String previewId, String action);
  Future<void> runPreviewInteraction(
    String previewId,
    String action,
    Map<String, Object?> args,
  );
  Future<void> capturePreview(String previewId);

  Future<Uint8List> readTranscriptImage(
    String entryId,
    TranscriptImageMetadata image,
  );
}
