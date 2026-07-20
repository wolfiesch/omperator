import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../host/app_preferences.dart';
import '../host/host_profile.dart';
import '../protocol/protocol.dart';
import 'app_state.dart';
import 'model_labels.dart';
import 'web_socket_connector.dart';

String _secureToken(int byteLength) {
  final random = Random.secure();
  final bytes = List<int>.generate(byteLength, (_) => random.nextInt(256));
  return base64Url.encode(bytes).replaceAll('=', '');
}

final class T4ClientController extends ChangeNotifier implements T4Actions {
  T4ClientController({
    required this.hostDirectoryStore,
    required this.hostCredentialStore,
    AppPreferenceStore? appPreferenceStore,
    WebSocketConnector? webSocketConnector,
    this.developmentEndpoint,
  }) : appPreferenceStore = appPreferenceStore ?? InMemoryAppPreferenceStore(),
       _webSocketConnector = webSocketConnector ?? connectPlatformWebSocket;

  final HostDirectoryStore hostDirectoryStore;
  final HostCredentialStore hostCredentialStore;
  final AppPreferenceStore appPreferenceStore;
  final WebSocketConnector _webSocketConnector;
  final Uri? developmentEndpoint;

  final LinkedHashMap<String, TranscriptMessage> _messages = LinkedHashMap();
  final Map<String, TranscriptCursor> _savedCursors =
      <String, TranscriptCursor>{};
  List<DurableEntry> _pagedTranscriptEntries = const <DurableEntry>[];
  String? _transcriptPageGeneration;
  String? _transcriptPageCursor;
  bool _transcriptPageLoading = false;
  bool _transcriptPageHasMore = false;
  String? _transcriptPageError;
  String? _transcriptRecoverySessionId;
  final Map<String, _PendingCommand> _pendingCommands =
      <String, _PendingCommand>{};
  final Map<String, _PendingCommand> _pendingSessionOperations =
      <String, _PendingCommand>{};
  final Map<String, _SessionAttention> _attentionBySession =
      <String, _SessionAttention>{};
  final Map<String, ConfirmationFrame> _attentionConfirmations =
      <String, ConfirmationFrame>{};
  final Map<String, AgentActivity> _agentActivities = <String, AgentActivity>{};
  final LinkedHashMap<String, DeveloperActivity> _activities = LinkedHashMap();
  final Map<String, TerminalSession> _terminals = <String, TerminalSession>{};
  final Map<String, TranscriptCursor> _terminalCursors =
      <String, TranscriptCursor>{};
  final Map<String, PreviewWorkspaceState> _previews =
      <String, PreviewWorkspaceState>{};
  final Map<String, Uint8List> _previewCaptures = <String, Uint8List>{};
  final Map<String, ReviewWorkspaceItem> _reviews =
      <String, ReviewWorkspaceItem>{};

  HostDirectory _hostDirectory = const HostDirectory.empty();
  WebSocketChannel? _channel;
  StreamSubscription<Object?>? _subscription;
  WebSocketChannel? _hostProbe;
  Timer? _reconnectTimer;
  List<SessionSummary> _sessions = const <SessionSummary>[];
  ConnectionPhase _phase = ConnectionPhase.disconnected;
  AuthenticationPhase _authenticationPhase = AuthenticationPhase.unknown;
  String? _selectedSessionId;
  String? _errorMessage;
  String? _hostId;
  _PendingPair? _pendingPair;
  Set<String> _grantedCapabilities = const <String>{};
  Set<String> _grantedFeatures = const <String>{};
  List<CatalogItem> _catalogItems = const <CatalogItem>[];
  CatalogFrame? _catalogFrame;
  SettingsFrame? _settingsFrame;
  HostSettingsState _settingsState = const HostSettingsState();
  T4ThemePreference _themePreference = T4ThemePreference.system;
  T4LifecyclePhase _lifecyclePhase = T4LifecyclePhase.resumed;
  bool _settingsOperationPending = false;
  bool _resumeConnectionOwed = false;
  Completer<void>? _settingsRefreshCompleter;
  bool _settingsRefreshSawCatalog = false;
  bool _settingsRefreshSawSettings = false;
  Timer? _settingsRefreshTimer;
  int _settingsBootstrapGeneration = -1;
  FileWorkspaceState _fileWorkspace = const FileWorkspaceState();
  String? _activeTerminalId;
  String? _activePreviewId;
  Future<void>? _initialization;
  bool _initialized = false;
  bool _hostOperationPending = false;
  bool _submitting = false;
  bool _sessionOperationPending = false;
  bool _developerOperationPending = false;
  bool _directoryLoaded = false;
  bool _disposed = false;
  int _connectionGeneration = 0;
  int _hostOperationGeneration = 0;
  int? _hostProbeOperation;
  bool _reconnectEnabled = true;
  int _bootstrapGeneration = -1;
  int _commandOrdinal = 0;
  final String _commandNamespace = _secureToken(12);
  int _localPromptOrdinal = 0;
  String? _sessionIndexEpoch;
  int? _sessionIndexSeq;
  int _reconnectAttempt = 0;

  T4ViewState get state => T4ViewState(
    connectionPhase: _phase,
    sessions: List<SessionSummary>.unmodifiable(_sessions),
    selectedSessionId: _selectedSessionId,
    messages: List<TranscriptMessage>.unmodifiable(_messages.values),
    transcriptHistoryLoading: _transcriptPageLoading,
    transcriptHistoryHasMore: _transcriptPageHasMore,
    transcriptHistoryError: _transcriptPageError,
    errorMessage: _errorMessage,
    hostDirectory: _hostDirectory,
    authenticationPhase: _authenticationPhase,
    grantedCapabilities: Set<String>.unmodifiable(_grantedCapabilities),
    grantedFeatures: Set<String>.unmodifiable(_grantedFeatures),
    targetConfigured: developmentEndpoint != null || _activeProfile != null,
    hostOperationPending: _hostOperationPending,
    submitting: _submitting,
    sessionOperationPending: _sessionOperationPending,
    composer: _composerState,
    attentionItems: _allAttentionItems,
    agentActivities: _allAgentActivities,
    attentionPartial: _attentionBySession.values.any(
      (attention) => attention.malformed || attention.truncated,
    ),
    omittedAttentionCount: _attentionBySession.values.fold(
      0,
      (total, attention) => total + attention.omittedCount,
    ),
    activities: List<DeveloperActivity>.unmodifiable(
      _activities.values.toList(growable: false).reversed,
    ),
    terminals: List<TerminalSession>.unmodifiable(
      _terminals.values.where(
        (terminal) => terminal.sessionId == _selectedSessionId,
      ),
    ),
    activeTerminalId: _activeTerminalId,
    fileWorkspace: _fileWorkspace,
    previews: List<PreviewWorkspaceState>.unmodifiable(
      _previews.values.where(
        (preview) => preview.sessionId == _selectedSessionId,
      ),
    ),
    reviews: List<ReviewWorkspaceItem>.unmodifiable(
      _reviews.values.where((review) => review.sessionId == _selectedSessionId),
    ),
    activePreviewId: _activePreviewId,
    developerOperationPending: _developerOperationPending,
    themePreference: _themePreference,
    settings: _settingsState,
    lifecyclePhase: _lifecyclePhase,
    settingsOperationPending: _settingsOperationPending,
  );

  SessionComposerState get _composerState {
    final session = _sessions
        .where((candidate) => candidate.sessionId == _selectedSessionId)
        .firstOrNull;
    if (session == null) return const SessionComposerState();
    final choices = <ComposerModelChoice>[];
    final seen = <String>{};
    final slashCommands = <ComposerSlashCommand>[];
    for (final item in _catalogItems) {
      if (item.kind == 'model') {
        final selector = modelItemSelector(item);
        if (selector == null || !seen.add(selector)) continue;
        final label = modelLabelFor(item);
        choices.add(
          ComposerModelChoice(
            label: label.label,
            selector: label.selector,
            provider: label.provider,
            providerLabel: label.providerLabel,
            supported: item.supported != false,
            reason: item.reason,
          ),
        );
        continue;
      }
      if (item.kind != 'command') continue;
      final bareName = item.name.replaceFirst(RegExp(r'^/+'), '');
      final missingCapability = item.capabilities
          ?.where((capability) => !_grantedCapabilities.contains(capability))
          .firstOrNull;
      final disabledReason = item.supported == false
          ? item.reason ?? 'Not available on this host'
          : missingCapability == null
          ? null
          : 'Not granted on this host';
      slashCommands.add(
        ComposerSlashCommand(
          name: '/$bareName',
          description: item.description ?? '',
          insert: '/$bareName ',
          disabledReason: disabledReason,
        ),
      );
    }
    final groups = groupModelChoices(_catalogItems);
    // The host reports concrete effort levels for the selected model and a
    // thinkingSupported flag. Off and Auto are client-side bookends the host
    // never lists; the menu is Off, Auto, then the model's concrete efforts in
    // host-reported order. When the model cannot reason the menu is empty.
    final levels = <String>[];
    if (session.thinkingSupported != false) {
      levels.addAll(<String>['off', 'auto']);
      for (final level in session.thinkingLevels) {
        if (level != 'off' && level != 'auto' && !levels.contains(level)) {
          levels.add(level);
        }
      }
      // Keep a still-valid configured value selectable even before the host
      // reports concrete efforts (e.g. a resumed session set to "high"). The
      // host already accepted this level, so it is advertised for the model.
      final configured = session.thinking;
      if (configured != null &&
          configured != 'off' &&
          configured != 'auto' &&
          configured != 'inherit' &&
          !levels.contains(configured)) {
        levels.add(configured);
      }
    }
    return SessionComposerState(
      modelLabel: sessionModelLabel(
        session.modelSelector,
        session.modelDisplayName,
        _catalogItems,
      ),
      modelSelector: session.modelSelector,
      modelChoices: List<ComposerModelChoice>.unmodifiable(choices),
      modelGroups: List<ModelProviderGroup>.unmodifiable(groups),
      slashCommands: List<ComposerSlashCommand>.unmodifiable(slashCommands),
      thinking: session.thinking,
      thinkingLevels: List<String>.unmodifiable(levels),
      fastEnabled: session.fast,
      fastAvailable: session.fastAvailable,
      turnActive: session.turnActive || _submitting,
      queuedFollowUpCount: session.queuedFollowUpCount,
    );
  }

  List<AttentionItem> get _allAttentionItems {
    final items = <AttentionItem>[
      for (final attention in _attentionBySession.values) ...attention.items,
      for (final frame in _attentionConfirmations.values)
        if (DateTime.tryParse(
              frame.expiresAt,
            )?.isAfter(DateTime.now().toUtc()) ==
            true)
          AttentionItem(
            key:
                'confirmation:${frame.sessionId ?? 'host'}:${frame.confirmationId}',
            kind: AttentionKind.confirmation,
            sessionId: frame.sessionId ?? '',
            sessionTitle: frame.sessionId == null
                ? (_activeProfile?.label ?? 'Host')
                : _sessions
                          .where(
                            (session) => session.sessionId == frame.sessionId,
                          )
                          .firstOrNull
                          ?.title ??
                      'Session',
            revision: frame.revision,
            title: 'Security confirmation',
            summary: frame.preview ?? frame.summary,
            at: DateTime.now().toUtc(),
            requestId: frame.confirmationId,
            confirmationId: frame.confirmationId,
            commandId: frame.commandId,
            expiresAt: DateTime.tryParse(frame.expiresAt)?.toUtc(),
            actionable: true,
          ),
    ];
    items.sort((left, right) {
      if (left.needsResponse != right.needsResponse) {
        return left.needsResponse ? -1 : 1;
      }
      return right.at.compareTo(left.at);
    });
    return List<AttentionItem>.unmodifiable(items);
  }

  List<AgentActivity> get _allAgentActivities {
    final activities = _agentActivities.values.toList(growable: false)
      ..sort((left, right) => right.updatedAt.compareTo(left.updatedAt));
    return List<AgentActivity>.unmodifiable(activities);
  }

  Future<void> initialize() => _initialization ??= _initialize();

  Future<void> _initialize() async {
    try {
      final storedTheme = await appPreferenceStore.loadThemePreference();
      if (_disposed) return;
      _themePreference =
          T4ThemePreference.values
              .where((preference) => preference.name == storedTheme)
              .firstOrNull ??
          T4ThemePreference.system;
    } on Object {
      if (_disposed) return;
      _themePreference = T4ThemePreference.system;
    }
    _publish();

    try {
      final directory = await hostDirectoryStore.load();
      if (_disposed) return;
      _hostDirectory = directory;
      _initialized = true;
      _directoryLoaded = true;
      _errorMessage = null;
      _publish();
      if (_lifecyclePhase == T4LifecyclePhase.resumed && _reconnectEnabled) {
        await _connectCurrent();
      }
    } on Object catch (error) {
      if (_disposed) return;
      _initialized = true;
      _fail('Could not load saved hosts: $error');
    }
  }

  @override
  Future<void> connect() async {
    _reconnectEnabled = true;
    if (_lifecyclePhase == T4LifecyclePhase.background) {
      _resumeConnectionOwed = true;
      _publish();
      return;
    }
    if (!_initialized) {
      await initialize();
      return;
    }
    await _connectCurrent();
  }

  @override
  Future<void> setThemePreference(T4ThemePreference preference) async {
    if (_themePreference == preference) return;
    _themePreference = preference;
    _publish();
    try {
      await appPreferenceStore.saveThemePreference(preference.name);
    } on Object catch (error) {
      _errorMessage = 'Could not save appearance preference: $error';
      _publish();
      rethrow;
    }
  }

  @override
  Future<void> refreshSettings() {
    _requireSettingsReadAccess();
    final completer = Completer<void>();
    _beginSettingsRefresh(completer: completer);
    return completer.future;
  }

  @override
  Future<void> writeSetting(
    String path,
    String scope, {
    Object? value,
    bool reset = false,
  }) async {
    if (_settingsOperationPending) {
      throw StateError('another settings change is already running');
    }
    if (_phase != ConnectionPhase.ready || _hostId == null) {
      throw StateError('connect before changing settings');
    }
    if (!_grantedCapabilities.contains('config.write')) {
      throw StateError('this device was not granted config.write');
    }
    final revision = _settingsFrame?.revision;
    if (revision == null) {
      throw StateError('refresh settings before changing them');
    }
    final entry = _settingsState.entries
        .where((candidate) => candidate.path == path)
        .firstOrNull;
    if (entry == null) {
      throw ArgumentError.value(path, 'path', 'is not a published setting');
    }
    if (!entry.available ||
        entry.sensitive ||
        entry.control == HostSettingControlKind.secret ||
        entry.control == HostSettingControlKind.unsupported) {
      throw StateError('this setting is not writable');
    }
    if ((scope != 'global' && scope != 'session') ||
        !entry.writableScopes.contains(scope)) {
      throw ArgumentError.value(scope, 'scope', 'is not writable for $path');
    }
    if (!reset && !_settingValueMatches(entry, value)) {
      throw ArgumentError.value(value, 'value', 'does not match $path');
    }
    if (reset && value != null) {
      throw ArgumentError.value(value, 'value', 'must be omitted when reset');
    }

    final edit = <String, Object?>{
      'path': path,
      'scope': scope,
      if (reset) 'reset': true else 'value': _copySettingValue(value),
    };
    _settingsOperationPending = true;
    _settingsState = HostSettingsState(
      revision: _settingsState.revision,
      entries: _settingsState.entries,
      loading: _settingsState.loading,
      issues: _settingsState.issues,
    );
    _publish();
    try {
      final frame = await _runHostCommand(
        prefix: 'settings-write',
        command: 'settings.write',
        expectedRevision: revision,
        args: <String, Object?>{
          'edits': <Map<String, Object?>>[edit],
          'expectedRevision': revision,
        },
        confirmationExpected: true,
      );
      if (!frame.ok) {
        throw StateError(frame.error?.message ?? 'settings.write failed');
      }
      await refreshSettings();
    } on Object catch (error) {
      _settingsState = HostSettingsState(
        revision: _settingsState.revision,
        entries: _settingsState.entries,
        error: 'Settings change failed: $error',
        issues: _settingsState.issues,
      );
      _publish();
      rethrow;
    } finally {
      _settingsOperationPending = false;
      _publish();
    }
  }

  void _requireSettingsReadAccess() {
    if (_hostId == null || _phase == ConnectionPhase.disconnected) {
      throw StateError('connect before refreshing settings');
    }
    if (!_grantedCapabilities.contains('catalog.read') ||
        !_grantedFeatures.contains('catalog.metadata') ||
        !_grantedCapabilities.contains('config.read') ||
        !_grantedFeatures.contains('settings.metadata')) {
      throw StateError('this host did not grant live settings metadata');
    }
  }

  void _beginSettingsRefresh({Completer<void>? completer}) {
    _settingsRefreshCompleter?.completeError(
      StateError('settings refresh was replaced'),
    );
    _settingsRefreshCompleter = completer;
    _settingsRefreshSawCatalog = false;
    _settingsRefreshSawSettings = false;
    _settingsRefreshTimer?.cancel();
    _settingsState = HostSettingsState(
      revision: _settingsState.revision,
      entries: _settingsState.entries,
      loading: true,
      issues: _settingsState.issues,
    );
    _publish();
    _sendHostProduct('catalog.get');
    _sendHostProduct('settings.read');
    _settingsRefreshTimer = Timer(const Duration(seconds: 10), () {
      if (!_settingsState.loading) return;
      final error = TimeoutException('settings refresh timed out');
      _settingsState = HostSettingsState(
        revision: _settingsState.revision,
        entries: _settingsState.entries,
        error: error.message,
        issues: _settingsState.issues,
      );
      final pending = _settingsRefreshCompleter;
      _settingsRefreshCompleter = null;
      if (pending != null && !pending.isCompleted) pending.completeError(error);
      _publish();
    });
  }

  void _sendHostProduct(String command) {
    final hostId = _hostId;
    if (hostId == null) throw StateError('host identity is unavailable');
    final ids = _nextCommandIds(command.replaceAll('.', '-'));
    _pendingCommands[ids.requestId] = _PendingCommand(
      commandId: ids.commandId,
      command: command,
    );
    _send(
      WireEncoder.command(
        requestId: ids.requestId,
        commandId: ids.commandId,
        hostId: hostId,
        command: command,
        args: const <String, Object?>{},
      ),
    );
  }

  Future<ResponseFrame> _runHostCommand({
    required String prefix,
    required String command,
    required Map<String, Object?> args,
    String? expectedRevision,
    bool confirmationExpected = false,
  }) async {
    final hostId = _hostId;
    if (hostId == null) throw StateError('host identity is unavailable');
    final ids = _nextCommandIds(prefix);
    final completer = Completer<ResponseFrame>();
    _pendingCommands[ids.requestId] = _PendingCommand(
      commandId: ids.commandId,
      command: command,
      completer: completer,
      expectedRevision: expectedRevision,
      confirmationExpected: confirmationExpected,
    );
    try {
      _send(
        WireEncoder.command(
          requestId: ids.requestId,
          commandId: ids.commandId,
          hostId: hostId,
          command: command,
          expectedRevision: expectedRevision,
          args: args,
        ),
      );
      return await completer.future.timeout(
        const Duration(seconds: 30),
        onTimeout: () => throw TimeoutException('$command timed out'),
      );
    } finally {
      _pendingCommands.remove(ids.requestId);
    }
  }

  void _projectHostSettings() {
    final catalog = _catalogFrame;
    final settings = _settingsFrame;
    if (catalog != null &&
        settings != null &&
        catalog.hostId == _hostId &&
        settings.hostId == _hostId) {
      final projection = _buildHostSettings(catalog, settings);
      final complete =
          _settingsRefreshSawCatalog && _settingsRefreshSawSettings;
      _settingsState = HostSettingsState(
        revision: settings.revision,
        entries: projection.entries,
        loading: !complete,
        issues: projection.issues,
      );
      if (complete) {
        _settingsRefreshTimer?.cancel();
        _settingsRefreshTimer = null;
        final pending = _settingsRefreshCompleter;
        _settingsRefreshCompleter = null;
        if (pending != null && !pending.isCompleted) pending.complete();
      }
    }
    _publish();
  }

  void _clearSettingsProjection() {
    _catalogFrame = null;
    _settingsFrame = null;
    _settingsState = const HostSettingsState();
    _settingsOperationPending = false;
    _settingsRefreshTimer?.cancel();
    _settingsRefreshTimer = null;
    final pending = _settingsRefreshCompleter;
    _settingsRefreshCompleter = null;
    if (pending != null && !pending.isCompleted) {
      pending.completeError(StateError('settings projection was cleared'));
    }
    _settingsRefreshSawCatalog = false;
    _settingsRefreshSawSettings = false;
    _settingsBootstrapGeneration = -1;
  }

  @override
  Future<void> handleLifecyclePhase(T4LifecyclePhase phase) async {
    if (_lifecyclePhase == phase) return;
    _lifecyclePhase = phase;
    if (phase == T4LifecyclePhase.background) {
      final active =
          _channel != null ||
          _subscription != null ||
          _reconnectTimer != null ||
          _phase == ConnectionPhase.connecting ||
          _phase == ConnectionPhase.synchronizing ||
          _phase == ConnectionPhase.ready ||
          _phase == ConnectionPhase.retrying;
      if (!active || !_reconnectEnabled) {
        _publish();
        return;
      }
      _resumeConnectionOwed = true;
      _reconnectEnabled = false;
      _connectionGeneration += 1;
      _reconnectTimer?.cancel();
      _reconnectTimer = null;
      final previousSubscription = _subscription;
      final previousChannel = _channel;
      _subscription = null;
      _channel = null;
      _cancelPendingCommands(StateError('app moved to the background'));
      _settingsOperationPending = false;
      _settingsRefreshTimer?.cancel();
      _settingsRefreshTimer = null;
      final refresh = _settingsRefreshCompleter;
      _settingsRefreshCompleter = null;
      if (refresh != null && !refresh.isCompleted) {
        refresh.completeError(StateError('app moved to the background'));
      }
      _settingsState = HostSettingsState(
        revision: _settingsState.revision,
        entries: _settingsState.entries,
        issues: _settingsState.issues,
      );
      _phase = ConnectionPhase.disconnected;
      _authenticationPhase = AuthenticationPhase.unknown;
      _errorMessage = null;
      _publish();
      await previousSubscription?.cancel();
      await previousChannel?.sink.close();
      return;
    }

    final reconnect = _resumeConnectionOwed;
    _resumeConnectionOwed = false;
    if (!reconnect) {
      _publish();
      return;
    }
    _reconnectEnabled = true;
    _publish();
    if (_initialized) await _connectCurrent();
  }

  @override
  Future<void> disconnect() async {
    _reconnectEnabled = false;
    _resumeConnectionOwed = false;
    _connectionGeneration += 1;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    final previousSubscription = _subscription;
    final previousChannel = _channel;
    _subscription = null;
    _channel = null;
    _cancelPendingCommands(
      StateError('connection closed before the command completed'),
    );
    _pendingPair = null;
    _submitting = false;
    _sessionOperationPending = false;
    _hostId = null;
    _grantedCapabilities = const <String>{};
    _grantedFeatures = const <String>{};
    _catalogItems = const <CatalogItem>[];
    _clearSettingsProjection();
    _bootstrapGeneration = -1;
    _reconnectAttempt = 0;
    _phase = ConnectionPhase.disconnected;
    _authenticationPhase = AuthenticationPhase.unknown;
    _errorMessage = null;
    _publish();
    await previousSubscription?.cancel();
    await previousChannel?.sink.close();
  }

  @override
  void cancelHostProbe() {
    final operation = _hostProbeOperation;
    if (operation == null) return;
    _hostOperationGeneration += 1;
    _hostProbeOperation = null;
    final probe = _hostProbe;
    _hostProbe = null;
    _hostOperationPending = false;
    _errorMessage = null;
    _publish();
    if (probe != null) unawaited(probe.sink.close());
  }

  Future<void> _connectCurrent() async {
    final profile = developmentEndpoint == null ? _activeProfile : null;
    final target = developmentEndpoint ?? profile?.webSocketUrl;
    final generation = ++_connectionGeneration;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    final previousSubscription = _subscription;
    final previousChannel = _channel;
    _subscription = null;
    _channel = null;
    await previousSubscription?.cancel();
    await previousChannel?.sink.close();
    if (_disposed || generation != _connectionGeneration) return;

    if (target == null) {
      _phase = ConnectionPhase.disconnected;
      _authenticationPhase = AuthenticationPhase.unknown;
      _errorMessage = 'Add a host to connect.';
      _publish();
      return;
    }

    _phase = _reconnectAttempt == 0
        ? ConnectionPhase.connecting
        : ConnectionPhase.retrying;
    _authenticationPhase = AuthenticationPhase.unknown;
    _grantedCapabilities = const <String>{};
    _grantedFeatures = const <String>{};
    _errorMessage = null;
    _publish();

    WebSocketChannel? connectingChannel;
    try {
      final credentials = profile == null
          ? null
          : await hostCredentialStore.read(profile);
      if (_disposed || generation != _connectionGeneration) return;

      connectingChannel = await _webSocketConnector(target);
      await connectingChannel.ready;
      if (_disposed || generation != _connectionGeneration) {
        await connectingChannel.sink.close();
        return;
      }
      _channel = connectingChannel;
      _subscription = connectingChannel.stream.listen(
        (message) => unawaited(_handlePayload(generation, message)),
        onError: (Object error, StackTrace stackTrace) =>
            _handleTransportLoss(generation, error),
        onDone: () => _handleTransportLoss(generation),
        cancelOnError: true,
      );
      _phase = ConnectionPhase.synchronizing;
      _publish();
      connectingChannel.sink.add(_hello(credentials));
    } on Object catch (error) {
      if (connectingChannel != null && connectingChannel != _channel) {
        unawaited(_closeChannelQuietly(connectingChannel));
      }
      _handleTransportLoss(generation, error);
    }
  }

  Future<void> _closeChannelQuietly(WebSocketChannel channel) async {
    try {
      await channel.sink.close().timeout(const Duration(seconds: 1));
    } on Object {
      // Failed handshakes can leave close futures unresolved.
    }
  }

  String _hello(DeviceCredentials? credentials) => WireEncoder.hello(
    client: ClientIdentity(
      name: 'T4 Code',
      version: '0.1.30',
      build: 'flutter',
      platform: defaultTargetPlatform.name,
    ),
    requestedFeatures: t4RequestedFeatures,
    capabilities: t4RequestedCapabilities,
    authentication: credentials == null
        ? null
        : DeviceAuthentication(
            deviceId: credentials.deviceId,
            deviceToken: credentials.deviceToken,
          ),
    savedCursors: _savedCursors.entries
        .map((entry) {
          final session = _sessions
              .where((candidate) => candidate.sessionId == entry.key)
              .firstOrNull;
          return SavedCursor(
            hostId: session?.hostId ?? _hostId ?? '',
            sessionId: entry.key,
            cursor: entry.value,
          );
        })
        .where((cursor) => cursor.hostId.isNotEmpty),
  );

  HostProfile? get _activeProfile => _hostDirectory.activeProfile;

  @override
  Future<void> addHost(
    String address, {
    String profileId = defaultHostProfileId,
  }) async {
    if (!_initialized) await initialize();
    if (_disposed || !_directoryLoaded) {
      throw StateError('Saved hosts are unavailable.');
    }
    if (_hostOperationPending) return;
    final operation = ++_hostOperationGeneration;
    _hostProbeOperation = operation;
    _hostOperationPending = true;
    _errorMessage = null;
    _publish();
    WebSocketChannel? probe;
    try {
      final profile = HostProfile.parseTailnetAddress(
        address,
        profileId: profileId,
      );
      probe = await _webSocketConnector(profile.webSocketUrl);
      if (!_acceptHostOperation(operation)) {
        await probe.sink.close();
        return;
      }
      _hostProbe = probe;
      await probe.ready;
      await probe.sink.close();
      probe = null;
      _hostProbe = null;
      if (!_acceptHostOperation(operation)) return;

      final next = _hostDirectory.upsert(profile);
      await hostDirectoryStore.save(next);
      if (!_acceptHostOperation(operation)) return;
      final switched = _hostDirectory.activeEndpointKey != profile.endpointKey;
      _hostDirectory = next;
      if (switched) _clearTargetProjection();
      _hostOperationPending = false;
      _reconnectEnabled = true;
      _publish();
      await _connectCurrent();
    } on Object catch (error) {
      if (probe != null) await probe.sink.close();
      if (!_acceptHostOperation(operation)) return;
      _hostOperationPending = false;
      _errorMessage = 'Could not add host: $error';
      _publish();
      rethrow;
    } finally {
      if (_hostProbeOperation == operation) _hostProbeOperation = null;
      if (identical(_hostProbe, probe)) _hostProbe = null;
    }
  }

  @override
  Future<void> activateHost(String endpointKey) async {
    if (!_initialized) await initialize();
    if (_disposed || !_directoryLoaded) {
      throw StateError('Saved hosts are unavailable.');
    }
    if (_hostOperationPending ||
        endpointKey == _hostDirectory.activeEndpointKey) {
      return;
    }
    final operation = ++_hostOperationGeneration;
    _hostOperationPending = true;
    _errorMessage = null;
    _publish();
    try {
      final next = _hostDirectory.activate(endpointKey);
      await hostDirectoryStore.save(next);
      if (!_acceptHostOperation(operation)) return;
      _hostDirectory = next;
      _clearTargetProjection();
      _hostOperationPending = false;
      _publish();
      _reconnectEnabled = true;
      await _connectCurrent();
    } on Object catch (error) {
      if (!_acceptHostOperation(operation)) return;
      _hostOperationPending = false;
      _errorMessage = 'Could not switch hosts: $error';
      _publish();
      rethrow;
    }
  }

  @override
  Future<void> removeHost(String endpointKey) async {
    if (!_initialized) await initialize();
    if (_disposed || !_directoryLoaded) {
      throw StateError('Saved hosts are unavailable.');
    }
    if (_hostOperationPending) return;
    HostProfile? profile;
    for (final candidate in _hostDirectory.profiles) {
      if (candidate.endpointKey == endpointKey) profile = candidate;
    }
    if (profile == null) return;

    final operation = ++_hostOperationGeneration;
    final previous = _hostDirectory;
    final next = previous.remove(endpointKey);
    final removedActive = previous.activeEndpointKey == endpointKey;
    _hostOperationPending = true;
    _errorMessage = null;
    _publish();
    try {
      await hostDirectoryStore.save(next);
      if (!_acceptHostOperation(operation)) return;
      try {
        await hostCredentialStore.delete(profile);
      } on Object {
        await hostDirectoryStore.save(previous);
        if (!_acceptHostOperation(operation)) return;
        throw StateError(
          'Could not remove host credentials; the host was restored.',
        );
      }
      if (!_acceptHostOperation(operation)) return;
      _hostDirectory = next;
      if (removedActive) _clearTargetProjection();
      _hostOperationPending = false;
      _publish();
      if (removedActive) await _connectCurrent();
    } on Object catch (error) {
      if (!_acceptHostOperation(operation)) return;
      _hostOperationPending = false;
      _errorMessage = 'Could not remove host: $error';
      _publish();
      rethrow;
    }
  }

  bool _acceptHostOperation(int operation) =>
      !_disposed && operation == _hostOperationGeneration;

  @override
  Future<void> pairHost(String code) async {
    if (!RegExp(r'^\d{6}$').hasMatch(code)) {
      _errorMessage = 'Enter the six-digit pairing code.';
      _publish();
      return;
    }
    final profile = developmentEndpoint == null ? _activeProfile : null;
    if (profile == null ||
        _authenticationPhase != AuthenticationPhase.pairingRequired ||
        _pendingPair != null) {
      return;
    }
    final ids = _nextCommandIds('pair');
    final deviceId = _newDeviceId();
    final pending = _PendingPair(
      requestId: ids.requestId,
      endpointKey: profile.endpointKey,
      deviceId: deviceId,
      deviceName: 'T4 Code',
      platform: defaultTargetPlatform.name,
      requestedCapabilities: t4RequestedCapabilities,
    );
    _pendingPair = pending;
    _authenticationPhase = AuthenticationPhase.pairing;
    _errorMessage = null;
    _publish();
    _send(
      WireEncoder.pairStart(
        requestId: pending.requestId,
        code: code,
        deviceId: pending.deviceId,
        deviceName: pending.deviceName,
        platform: pending.platform,
        requestedCapabilities: pending.requestedCapabilities,
      ),
    );
  }

  String _newDeviceId() => _secureToken(24);

  @override
  Future<void> selectSession(String sessionId) async {
    if (_selectedSessionId == sessionId && _phase == ConnectionPhase.ready) {
      return;
    }
    final known = _sessions.any((session) => session.sessionId == sessionId);
    if (!known) return;
    _selectedSessionId = sessionId;
    _selectDeveloperSessionProjection(sessionId);
    _resetTranscriptPage();
    _messages.clear();
    _phase = ConnectionPhase.synchronizing;
    _errorMessage = null;
    _publish();
    _primeTranscriptTailThenAttach(sessionId);
  }

  @override
  Future<void> createSession(String projectId, {String? title}) async {
    final normalizedProjectId = projectId.trim();
    if (normalizedProjectId.isEmpty) {
      throw ArgumentError.value(projectId, 'projectId', 'must not be empty');
    }
    final normalizedTitle = title?.trim();
    final frame = await _runSessionOperation(
      prefix: 'create-session',
      command: 'session.create',
      capability: 'sessions.manage',
      args: <String, Object?>{
        'projectId': normalizedProjectId,
        if (normalizedTitle != null && normalizedTitle.isNotEmpty)
          'title': normalizedTitle,
      },
    );
    final result = frame.result;
    if (result is! Map<String, Object?> || !result.containsKey('session')) {
      throw const FormatException('session.create result is missing');
    }
    final created = WireDecoder.decodeSessionRef(result['session']);
    if (created.hostId != _hostId ||
        created.project['projectId'] != normalizedProjectId) {
      throw const FormatException('session.create returned another project');
    }
    _upsertSession(created);
    await selectSession(created.sessionId);
  }

  @override
  Future<void> renameSession(String sessionId, String title) async {
    final normalized = title.trim();
    if (normalized.isEmpty) {
      throw ArgumentError.value(title, 'title', 'must not be empty');
    }
    await _runLifecycleCommand(
      sessionId,
      command: 'session.rename',
      args: <String, Object?>{'name': normalized},
    );
  }

  @override
  Future<void> terminateSession(String sessionId) => _runLifecycleCommand(
    sessionId,
    command: 'session.close',
    confirmationExpected: true,
  );

  @override
  Future<void> archiveSession(String sessionId) async {
    await _runLifecycleCommand(sessionId, command: 'session.archive');
    if (_selectedSessionId == sessionId) {
      final replacement = _sessions
          .where((session) => !session.archived)
          .firstOrNull;
      if (replacement == null) {
        _selectedSessionId = null;
        _selectDeveloperSessionProjection(null);
        _messages.clear();
        _publish();
      } else {
        await selectSession(replacement.sessionId);
      }
    }
  }

  @override
  Future<void> restoreSession(String sessionId) =>
      _runLifecycleCommand(sessionId, command: 'session.restore');

  @override
  Future<void> deleteSession(String sessionId) => _runLifecycleCommand(
    sessionId,
    command: 'session.delete',
    confirmationExpected: true,
  );

  @override
  Future<void> cancelAgent(String agentId) async {
    final activity = _agentActivities[agentId];
    if (activity == null) {
      throw ArgumentError.value(agentId, 'agentId', 'is not projected');
    }
    if (const {'completed', 'failed', 'cancelled'}.contains(activity.status)) {
      throw StateError('this agent has already stopped');
    }
    final session = _sessions
        .where((candidate) => candidate.sessionId == activity.sessionId)
        .firstOrNull;
    if (session == null) {
      throw StateError('the agent session is no longer indexed');
    }
    await _runSessionOperation(
      prefix: 'agent-cancel',
      command: 'agent.cancel',
      capability: 'agents.control',
      session: session,
      args: <String, Object?>{'agentId': agentId},
      confirmationExpected: true,
    );
  }

  @override
  Future<TranscriptSearchResult> searchTranscripts({
    required String query,
    String? cursor,
    String? projectId,
    List<TranscriptSearchRole>? roles,
    String archived = 'include',
    DateTime? from,
    DateTime? to,
  }) async {
    final normalizedQuery = query.trim();
    if (normalizedQuery.isEmpty) {
      throw ArgumentError.value(query, 'query', 'must not be blank');
    }
    if (_phase != ConnectionPhase.ready || _hostId == null) {
      throw StateError('connect before searching transcripts');
    }
    if (!_grantedCapabilities.contains('sessions.read')) {
      throw StateError('this device was not granted sessions.read');
    }
    if (!const {'include', 'only', 'exclude'}.contains(archived)) {
      throw ArgumentError.value(archived, 'archived', 'is not supported');
    }
    if (roles != null &&
        (roles.isEmpty || roles.toSet().length != roles.length)) {
      throw ArgumentError.value(roles, 'roles', 'must be non-empty and unique');
    }
    final fromUtc = from?.toUtc();
    final toUtc = to?.toUtc();
    if (fromUtc != null && toUtc != null && fromUtc.isAfter(toUtc)) {
      throw ArgumentError.value(from, 'from', 'must not be later than to');
    }
    final frame = await _runHostCommand(
      prefix: 'transcript-search',
      command: 'transcript.search',
      args: <String, Object?>{
        'query': normalizedQuery,
        'limit': 25,
        'archived': archived,
        'cursor': ?cursor,
        'projectId': ?projectId,
        if (roles != null)
          'roles': roles.map((role) => role.name).toList(growable: false),
        if (fromUtc != null) 'from': fromUtc.toIso8601String(),
        if (toUtc != null) 'to': toUtc.toIso8601String(),
      },
    );
    if (!frame.ok) {
      throw StateError(frame.error?.message ?? 'transcript search failed');
    }
    final result = frame.result;
    if (result is! TranscriptSearchResult) {
      throw const WireFormatException(
        'transcript.search returned an invalid result',
        'result',
      );
    }
    return result;
  }

  @override
  Future<TranscriptContextResult> loadTranscriptContext({
    required String sessionId,
    required String anchorId,
    int before = 8,
    int after = 8,
  }) async {
    if (sessionId.isEmpty) {
      throw ArgumentError.value(sessionId, 'sessionId', 'must not be empty');
    }
    if (anchorId.isEmpty) {
      throw ArgumentError.value(anchorId, 'anchorId', 'must not be empty');
    }
    if (before < 0 || before > 20 || after < 0 || after > 20) {
      throw ArgumentError('context bounds must be between 0 and 20');
    }
    final frame = await _runSessionReadCommand(
      prefix: 'transcript-context',
      command: 'transcript.context',
      sessionId: sessionId,
      args: <String, Object?>{
        'anchorId': anchorId,
        'before': before,
        'after': after,
      },
    );
    final result = frame.result;
    if (result is! TranscriptContextResult) {
      throw const WireFormatException(
        'transcript.context returned an invalid result',
        'result',
      );
    }
    return result;
  }

  @override
  Future<void> loadEarlierTranscript() async {
    final sessionId = _selectedSessionId;
    final before = _transcriptPageCursor;
    if (_transcriptPageLoading ||
        !_transcriptPageSupported ||
        sessionId == null ||
        before == null) {
      return;
    }
    final connectionGeneration = _connectionGeneration;
    final pageGeneration = _transcriptPageGeneration;
    _transcriptPageLoading = true;
    _transcriptPageError = null;
    _publish();
    try {
      final frame = await _runSessionReadCommand(
        prefix: 'transcript-page-older',
        command: 'transcript.page',
        sessionId: sessionId,
        args: <String, Object?>{
          'before': before,
          'limit': 128,
          'maxBytes': 512 * 1024,
        },
      );
      if (connectionGeneration != _connectionGeneration ||
          sessionId != _selectedSessionId) {
        return;
      }
      final page = frame.transcriptPageResult;
      if (page == null) {
        throw const WireFormatException(
          'transcript.page returned an invalid result',
          'result',
        );
      }
      if (pageGeneration != null && page.generation != pageGeneration) {
        throw StateError(
          'The transcript changed while older history was loading.',
        );
      }
      final existingIds = _pagedTranscriptEntries
          .map((entry) => entry.id)
          .toSet();
      final added = page.entries
          .where((entry) => existingIds.add(entry.id))
          .toList(growable: false);
      _pagedTranscriptEntries = <DurableEntry>[
        ...added,
        ..._pagedTranscriptEntries,
      ];
      _transcriptPageGeneration = page.generation;
      _transcriptPageCursor = page.nextCursor;
      _transcriptPageHasMore = page.hasMore && page.nextCursor != null;
      final visible = _messages.values.toList(growable: false);
      _messages.clear();
      for (final entry in added) {
        _upsertEntry(entry);
      }
      for (final message in visible) {
        _messages[message.id] = message;
      }
    } on Object catch (error) {
      if (connectionGeneration == _connectionGeneration &&
          sessionId == _selectedSessionId) {
        _transcriptPageError = error is StateError
            ? error.message
            : 'Older transcript history could not be loaded.';
      }
    } finally {
      if (connectionGeneration == _connectionGeneration &&
          sessionId == _selectedSessionId) {
        _transcriptPageLoading = false;
        _publish();
      }
    }
  }

  @override
  Future<UsageReadResult> readUsage() async {
    final frame = await _runHostReadCommand(
      prefix: 'usage-read',
      command: 'usage.read',
      capability: 'usage.read',
    );
    final result = frame.result;
    if (result is! UsageReadResult) {
      throw const WireFormatException(
        'usage.read returned an invalid result',
        'result',
      );
    }
    return result;
  }

  @override
  Future<BrokerStatusResult> readBrokerStatus() async {
    final frame = await _runHostReadCommand(
      prefix: 'broker-status',
      command: 'broker.status',
      capability: 'broker.read',
    );
    final result = frame.result;
    if (result is! BrokerStatusResult) {
      throw const WireFormatException(
        'broker.status returned an invalid result',
        'result',
      );
    }
    return result;
  }

  Future<ResponseFrame> _runHostReadCommand({
    required String prefix,
    required String command,
    required String capability,
  }) async {
    if (_phase != ConnectionPhase.ready || _hostId == null) {
      throw StateError('connect before reading host status');
    }
    if (!_grantedCapabilities.contains(capability)) {
      throw StateError('this device was not granted $capability');
    }
    final frame = await _runHostCommand(
      prefix: prefix,
      command: command,
      args: const <String, Object?>{},
    );
    if (!frame.ok) {
      throw StateError(frame.error?.message ?? '$command failed');
    }
    return frame;
  }

  Future<ResponseFrame> _runSessionReadCommand({
    required String prefix,
    required String command,
    required String sessionId,
    required Map<String, Object?> args,
  }) async {
    final hostId = _hostId;
    if (_channel == null ||
        hostId == null ||
        _phase == ConnectionPhase.disconnected ||
        _phase == ConnectionPhase.retrying ||
        _phase == ConnectionPhase.failed) {
      throw StateError('connect before reading a session');
    }
    if (!_grantedCapabilities.contains('sessions.read')) {
      throw StateError('this device was not granted sessions.read');
    }
    final ids = _nextCommandIds(prefix);
    final completer = Completer<ResponseFrame>();
    _pendingCommands[ids.requestId] = _PendingCommand(
      commandId: ids.commandId,
      command: command,
      sessionId: sessionId,
      completer: completer,
    );
    try {
      _send(
        WireEncoder.command(
          requestId: ids.requestId,
          commandId: ids.commandId,
          hostId: hostId,
          sessionId: sessionId,
          command: command,
          args: args,
        ),
      );
      final frame = await completer.future.timeout(
        const Duration(seconds: 30),
        onTimeout: () => throw TimeoutException('$command timed out'),
      );
      if (!frame.ok) {
        throw StateError(frame.error?.message ?? '$command failed');
      }
      return frame;
    } finally {
      _pendingCommands.remove(ids.requestId);
    }
  }

  Future<ResponseFrame> _runLifecycleCommand(
    String sessionId, {
    required String command,
    Map<String, Object?> args = const <String, Object?>{},
    bool confirmationExpected = false,
  }) {
    final session = _sessions
        .where((candidate) => candidate.sessionId == sessionId)
        .firstOrNull;
    if (session == null) {
      throw ArgumentError.value(sessionId, 'sessionId', 'is not indexed');
    }
    return _runSessionOperation(
      prefix: command.replaceAll('.', '-'),
      command: command,
      capability: 'sessions.manage',
      session: session,
      args: args,
      confirmationExpected: confirmationExpected,
    );
  }

  Future<ResponseFrame> _runSessionOperation({
    required String prefix,
    required String command,
    required String capability,
    SessionSummary? session,
    Map<String, Object?> args = const <String, Object?>{},
    bool confirmationExpected = false,
    String? expectedRevision,
  }) async {
    if (_sessionOperationPending) {
      throw StateError('another session action is already running');
    }
    final hostId = _hostId;
    if (_phase != ConnectionPhase.ready || hostId == null) {
      throw StateError('connect before managing sessions');
    }
    if (!_grantedCapabilities.contains(capability)) {
      throw StateError('this device was not granted $capability');
    }
    final operationRevision = expectedRevision ?? session?.revision;
    final ids = _nextCommandIds(prefix);
    final completer = Completer<ResponseFrame>();
    final pending = _PendingCommand(
      commandId: ids.commandId,
      command: command,
      sessionId: session?.sessionId,
      completer: completer,
      expectedRevision: operationRevision,
      confirmationExpected: confirmationExpected,
    );
    _pendingSessionOperations[ids.requestId] = pending;
    _sessionOperationPending = true;
    _errorMessage = null;
    _publish();
    try {
      _send(
        WireEncoder.command(
          requestId: ids.requestId,
          commandId: ids.commandId,
          hostId: hostId,
          sessionId: session?.sessionId,
          command: command,
          expectedRevision: operationRevision,
          args: args,
        ),
      );
      final frame = await completer.future.timeout(
        const Duration(seconds: 10),
        onTimeout: () => throw TimeoutException('$command timed out'),
      );
      if (!frame.ok) {
        throw StateError(frame.error?.message ?? '$command failed');
      }
      return frame;
    } on Object catch (error) {
      _errorMessage = 'Session action failed: $error';
      _publish();
      rethrow;
    } finally {
      _pendingSessionOperations.remove(ids.requestId);
      _sessionOperationPending = false;
      _publish();
    }
  }

  @override
  Future<bool> submitPrompt(
    String message, {
    List<PromptImageAttachment> images = const <PromptImageAttachment>[],
  }) async {
    final text = message.trim();
    final session = state.selectedSession;
    if (session == null || _phase != ConnectionPhase.ready) return false;
    if (text.isEmpty && images.isEmpty) return false;
    if (state.composer.turnActive) {
      if (images.isNotEmpty) {
        throw StateError('Images cannot be added while a turn is active.');
      }
      return _sendPromptText('session.steer', text);
    }
    if (images.length > 8) {
      throw ArgumentError.value(images.length, 'images', 'maximum is 8');
    }

    final optimisticId =
        'local-prompt:${session.sessionId}:${_localPromptOrdinal++}';
    _messages[optimisticId] = TranscriptMessage(
      id: optimisticId,
      role: MessageRole.user,
      text: text,
    );
    _submitting = true;
    _publish();
    final uploaded = <String>[];
    try {
      for (final image in images) {
        uploaded.add(await _uploadImage(session, image));
      }
      final frame = await _runPromptLeasedCommand(
        prefix: 'prompt',
        command: 'session.prompt',
        session: session,
        expectedRevision: session.revision,
        args: <String, Object?>{
          'message': text,
          if (uploaded.isNotEmpty)
            'images': <Map<String, String>>[
              for (final imageId in uploaded)
                <String, String>{'imageId': imageId},
            ],
        },
      );
      final result = frame.result;
      return result is Map<String, Object?> && result['accepted'] == true;
    } on Object {
      await _discardUploadedImages(session, uploaded);
      _messages.remove(optimisticId);
      _submitting = false;
      _publish();
      rethrow;
    }
  }

  @override
  Future<bool> queuePrompt(String message) =>
      _sendPromptText('session.followUp', message.trim());

  Future<bool> _sendPromptText(String command, String text) async {
    final session = state.selectedSession;
    if (text.isEmpty || session == null || _phase != ConnectionPhase.ready) {
      return false;
    }
    final frame = await _runPromptLeasedCommand(
      prefix: command.replaceAll('.', '-'),
      command: command,
      session: session,
      expectedRevision: session.revision,
      args: <String, Object?>{'message': text},
    );
    final result = frame.result;
    return result is Map<String, Object?> && result['accepted'] == true;
  }

  @override
  Future<void> cancelTurn() async {
    final session = state.selectedSession;
    if (session == null || !state.composer.turnActive) return;
    await _runSessionOperation(
      prefix: 'session-cancel',
      command: 'session.cancel',
      capability: 'sessions.control',
      session: session,
      confirmationExpected: true,
    );
  }

  @override
  Future<void> setSessionModel(String selector) async {
    final session = state.selectedSession;
    if (session == null) return;
    await _runSessionOperation(
      prefix: 'session-model',
      command: 'session.model.set',
      capability: 'sessions.manage',
      session: session,
      args: <String, Object?>{'selector': selector, 'persistence': 'session'},
    );
  }

  @override
  Future<void> setSessionThinking(String level) async {
    final session = state.selectedSession;
    if (session == null) return;
    await _runSessionOperation(
      prefix: 'session-thinking',
      command: 'session.thinking.set',
      capability: 'sessions.manage',
      session: session,
      args: <String, Object?>{'level': level},
    );
  }

  @override
  Future<void> setSessionFast(bool enabled) async {
    final session = state.selectedSession;
    if (session == null) return;
    await _runSessionOperation(
      prefix: 'session-fast',
      command: 'session.fast.set',
      capability: 'sessions.manage',
      session: session,
      args: <String, Object?>{'enabled': enabled},
    );
  }

  @override
  Future<bool> respondToAttention(
    AttentionItem item,
    AttentionResponse response,
  ) async {
    final current = _allAttentionItems
        .where(
          (candidate) =>
              candidate.key == item.key &&
              candidate.revision == item.revision &&
              candidate.needsResponse,
        )
        .firstOrNull;
    if (current == null) {
      throw StateError('This attention item was already resolved or replaced.');
    }
    if (_phase != ConnectionPhase.ready) {
      throw StateError('Connect before responding to attention items.');
    }
    if (current.kind == AttentionKind.confirmation) {
      final confirmationId = current.confirmationId;
      final commandId = current.commandId;
      final hostId = _hostId;
      if (confirmationId == null || commandId == null || hostId == null) {
        throw StateError('The confirmation is incomplete.');
      }
      final expiresAt = current.expiresAt;
      if (expiresAt == null || !expiresAt.isAfter(DateTime.now().toUtc())) {
        _attentionConfirmations.remove(confirmationId);
        _publish();
        throw StateError('The confirmation expired.');
      }
      final ids = _nextCommandIds('attention-confirm');
      _send(
        WireEncoder.confirm(
          requestId: ids.requestId,
          confirmationId: confirmationId,
          commandId: commandId,
          hostId: hostId,
          sessionId: current.sessionId.isEmpty ? null : current.sessionId,
          decision: response.decision == AttentionDecision.approve
              ? 'approve'
              : 'deny',
        ),
      );
      _attentionConfirmations.remove(confirmationId);
      _publish();
      return true;
    }
    if (!_grantedCapabilities.contains('sessions.prompt')) {
      throw StateError('This device cannot answer session requests.');
    }
    final requestId = current.requestId;
    final session = _sessions
        .where((candidate) => candidate.sessionId == current.sessionId)
        .firstOrNull;
    if (requestId == null || session == null) {
      throw StateError('The attention item no longer belongs to this host.');
    }
    final args = <String, Object?>{'requestId': requestId};
    switch (current.kind) {
      case AttentionKind.approval:
        args['confirmed'] = response.decision == AttentionDecision.approve;
      case AttentionKind.question:
        final value = response.text.trim().isNotEmpty
            ? response.text.trim()
            : response.optionIds.join(', ');
        if (value.isEmpty) throw ArgumentError('Choose or enter an answer.');
        args['value'] = value;
      case AttentionKind.plan:
        switch (response.decision) {
          case AttentionDecision.approve:
            args['confirmed'] = true;
          case AttentionDecision.reject:
          case AttentionDecision.deny:
            args['confirmed'] = false;
          case AttentionDecision.revise:
            args['value'] = response.text.trim();
        }
      case AttentionKind.confirmation:
      case AttentionKind.completed:
      case AttentionKind.failed:
      case AttentionKind.cancelled:
        throw StateError('This attention item cannot be answered.');
    }
    final frame = await _runPromptLeasedCommand(
      prefix: 'attention-response',
      command: 'session.ui.respond',
      session: session,
      expectedRevision: current.revision,
      args: args,
      stillCurrent: () => _allAttentionItems.any(
        (candidate) =>
            candidate.key == current.key &&
            candidate.revision == current.revision,
      ),
    );
    final result = frame.result;
    return result is Map<String, Object?> && result['accepted'] == true;
  }

  @override
  Future<void> retrySession(String sessionId) async {
    final session = _sessions
        .where((candidate) => candidate.sessionId == sessionId)
        .firstOrNull;
    if (session == null) throw StateError('The session no longer exists.');
    await _runSessionOperation(
      prefix: 'session-retry',
      command: 'session.retry',
      capability: 'sessions.control',
      session: session,
    );
  }

  void _selectDeveloperSessionProjection(String? sessionId) {
    _fileWorkspace = const FileWorkspaceState();
    _activeTerminalId = sessionId == null
        ? null
        : _terminals.values
              .where((terminal) => terminal.sessionId == sessionId)
              .firstOrNull
              ?.terminalId;
    _activePreviewId = sessionId == null
        ? null
        : _previews.values
              .where((preview) => preview.sessionId == sessionId)
              .firstOrNull
              ?.previewId;
  }

  SessionSummary _developerSession() =>
      state.selectedSession ??
      (throw StateError('Choose a session before opening developer tools.'));

  Future<T> _runDeveloperOperation<T>(Future<T> Function() operation) async {
    if (_developerOperationPending) {
      throw StateError('Another developer action is already running.');
    }
    _developerOperationPending = true;
    _publish();
    try {
      return await operation();
    } finally {
      _developerOperationPending = false;
      _publish();
    }
  }

  @override
  Future<void> refreshActivity() => _runDeveloperOperation(() async {
    final frame = await _runSessionOperation(
      prefix: 'audit-read',
      command: 'audit.read',
      capability: 'audit.read',
    );
    final result = frame.result;
    if (result is! Map<String, Object?> || result['events'] is! List<Object?>) {
      throw const FormatException('audit.read result is invalid');
    }
    for (final raw in result['events']! as List<Object?>) {
      if (raw is Map<String, Object?>) _recordAuditMap(raw);
    }
    _publish();
  });

  @override
  Future<String> openTerminal({String? cwd}) => _runDeveloperOperation(
    () async {
      final session = _developerSession();
      final frame = await _runSessionOperation(
        prefix: 'terminal-open',
        command: 'term.open',
        capability: 'term.open',
        session: session,
        args: <String, Object?>{
          if (cwd != null && cwd.trim().isNotEmpty) 'cwd': cwd.trim(),
          'cols': 80,
          'rows': 24,
        },
        confirmationExpected: true,
      );
      final result = frame.result;
      if (result is! Map<String, Object?> || result['terminalId'] is! String) {
        throw const FormatException('term.open result is invalid');
      }
      final terminalId = result['terminalId']! as String;
      _terminals[terminalId] = TerminalSession(
        terminalId: terminalId,
        sessionId: session.sessionId,
        title: cwd?.trim().isNotEmpty == true ? cwd!.trim() : 'Terminal',
      );
      _activeTerminalId = terminalId;
      _recordActivity(
        category: 'shell',
        title: 'Terminal opened',
        detail: cwd ?? session.projectName,
        raw: result,
      );
      return terminalId;
    },
  );

  @override
  void sendTerminalInput(String terminalId, String data) {
    final terminal = _terminals[terminalId];
    final hostId = _hostId;
    if (terminal == null ||
        !terminal.running ||
        hostId == null ||
        _phase != ConnectionPhase.ready ||
        !_grantedCapabilities.contains('term.input')) {
      return;
    }
    _send(
      WireEncoder.terminalInput(
        hostId: hostId,
        sessionId: terminal.sessionId,
        terminalId: terminalId,
        data: data,
      ),
    );
  }

  @override
  void resizeTerminal(String terminalId, int cols, int rows) {
    final terminal = _terminals[terminalId];
    final hostId = _hostId;
    if (terminal == null ||
        !terminal.running ||
        hostId == null ||
        _phase != ConnectionPhase.ready ||
        !_grantedCapabilities.contains('term.resize')) {
      return;
    }
    _send(
      WireEncoder.terminalResize(
        hostId: hostId,
        sessionId: terminal.sessionId,
        terminalId: terminalId,
        cols: cols,
        rows: rows,
      ),
    );
  }

  @override
  void closeTerminal(String terminalId) {
    final terminal = _terminals[terminalId];
    final hostId = _hostId;
    if (terminal == null || hostId == null) return;
    if (_phase == ConnectionPhase.ready) {
      _send(
        WireEncoder.terminalClose(
          hostId: hostId,
          sessionId: terminal.sessionId,
          terminalId: terminalId,
          reason: 'user',
        ),
      );
    }
    _terminals.remove(terminalId);
    _terminalCursors.remove(terminalId);
    _activeTerminalId = _terminals.keys.lastOrNull;
    _publish();
  }

  @override
  Future<void> listFiles([String path = '']) =>
      _runDeveloperOperation(() async {
        final session = _developerSession();
        _fileWorkspace = FileWorkspaceState(
          path: path,
          loading: true,
          content: _fileWorkspace.content,
          diff: _fileWorkspace.diff,
        );
        _publish();
        final frame = await _runComposerCommand(
          prefix: 'files-list',
          command: 'files.list',
          session: session,
          capability: 'files.list',
          args: <String, Object?>{if (path.isNotEmpty) 'path': path},
        );
        final result = frame.result;
        if (result is! Map<String, Object?> ||
            result['entries'] is! List<Object?>) {
          throw const FormatException('files.list result is invalid');
        }
        final entries = <DeveloperFileEntry>[];
        for (final raw in result['entries']! as List<Object?>) {
          if (raw is! Map<String, Object?> ||
              raw['path'] is! String ||
              raw['kind'] is! String) {
            throw const FormatException('files.list entry is invalid');
          }
          entries.add(
            DeveloperFileEntry(
              path: raw['path']! as String,
              kind: raw['kind']! as String,
              size: raw['size'] is int ? raw['size']! as int : null,
              revision: raw['revision'] is String
                  ? raw['revision']! as String
                  : null,
            ),
          );
        }
        _fileWorkspace = FileWorkspaceState(
          path: path,
          entries: List<DeveloperFileEntry>.unmodifiable(entries),
          revision: result['revision'] is String
              ? result['revision']! as String
              : null,
        );
      });

  @override
  Future<void> readFile(String path) => _runDeveloperOperation(() async {
    final session = _developerSession();
    final frame = await _runComposerCommand(
      prefix: 'files-read',
      command: 'files.read',
      session: session,
      capability: 'files.read',
      args: <String, Object?>{'path': path},
    );
    final result = frame.result;
    if (result is! Map<String, Object?> || result['content'] is! String) {
      throw const FormatException('files.read result is invalid');
    }
    _fileWorkspace = FileWorkspaceState(
      path: path,
      entries: _fileWorkspace.entries,
      content: result['content']! as String,
      revision: result['revision'] is String
          ? result['revision']! as String
          : null,
    );
  });

  @override
  Future<void> loadSessionDiff() => _runDeveloperOperation(() async {
    final session = _developerSession();
    final path = _fileWorkspace.path;
    if (path.isEmpty) {
      throw StateError('Choose a file before loading its diff.');
    }
    final frame = await _runComposerCommand(
      prefix: 'files-diff',
      command: 'files.diff',
      session: session,
      capability: 'files.diff',
      args: <String, Object?>{'path': path},
    );
    final result = frame.result;
    if (result is! Map<String, Object?> || result['diff'] is! String) {
      throw const FormatException('files.diff result is invalid');
    }
    _fileWorkspace = FileWorkspaceState(
      path: path,
      entries: _fileWorkspace.entries,
      content: _fileWorkspace.content,
      diff: result['diff']! as String,
      revision: result['toRevision'] is String
          ? result['toRevision']! as String
          : _fileWorkspace.revision,
    );
  });

  @override
  Future<void> writeFile(String path, String content) =>
      _runDeveloperOperation(() async {
        final session = _developerSession();
        if (path != _fileWorkspace.path || _fileWorkspace.content == null) {
          throw StateError('Read this file again before saving it.');
        }
        final revision = _fileWorkspace.revision;
        if (revision == null) {
          throw StateError('Waiting for the file revision before saving.');
        }
        final frame = await _runSessionOperation(
          prefix: 'files-write',
          command: 'files.write',
          capability: 'files.write',
          session: session,
          expectedRevision: revision,
          args: <String, Object?>{'path': path, 'content': content},
          confirmationExpected: true,
        );
        final result = frame.result;
        final nextRevision =
            result is Map<String, Object?> && result['revision'] is String
            ? result['revision']! as String
            : _fileWorkspace.revision;
        _fileWorkspace = FileWorkspaceState(
          path: path,
          entries: _fileWorkspace.entries,
          content: content,
          revision: nextRevision,
        );
      });

  @override
  Future<void> refreshReview(String reviewId) =>
      _runDeveloperOperation(() async {
        final review = _reviews[reviewId];
        if (review == null) {
          throw ArgumentError.value(reviewId, 'reviewId', 'is not projected');
        }
        final session = _developerSession();
        if (session.sessionId != review.sessionId) {
          throw StateError('Open the review session before refreshing it.');
        }
        await _runComposerCommand(
          prefix: 'review-read',
          command: 'review.read',
          session: session,
          capability: 'files.read',
          expectedRevision: session.revision,
          args: <String, Object?>{'reviewId': reviewId},
        );
      });

  @override
  Future<void> applyReview(String reviewId) => _runDeveloperOperation(() async {
    final review = _reviews[reviewId];
    if (review == null) {
      throw ArgumentError.value(reviewId, 'reviewId', 'is not projected');
    }
    if (review.status == 'applied' || review.status == 'discarded') {
      throw StateError('This review is no longer pending.');
    }
    final session = _developerSession();
    if (session.sessionId != review.sessionId) {
      throw StateError('Open the review session before applying it.');
    }
    await _runSessionOperation(
      prefix: 'review-apply',
      command: 'review.apply',
      capability: 'files.write',
      session: session,
      args: <String, Object?>{'reviewId': reviewId},
      confirmationExpected: true,
    );
  });

  @override
  Future<String> launchPreview(String url) => _runDeveloperOperation(() async {
    final session = _developerSession();
    final frame = await _runSessionOperation(
      prefix: 'preview-launch',
      command: 'preview.launch',
      capability: 'preview.control',
      session: session,
      args: <String, Object?>{'url': url.trim(), 'authorityId': 'omp-session'},
      confirmationExpected: true,
    );
    final preview = _previewResult(frame, session.sessionId);
    _activePreviewId = preview.previewId;
    return preview.previewId;
  });

  @override
  Future<void> selectPreview(String previewId) =>
      _runPreviewMutation(previewId, 'preview.activate');

  @override
  Future<void> navigatePreview(String previewId, String url) =>
      _runPreviewMutation(
        previewId,
        'preview.navigate',
        extraArgs: <String, Object?>{'url': url.trim()},
        confirmationExpected: true,
      );

  @override
  Future<void> runPreviewAction(String previewId, String action) {
    if (!const <String>{
      'back',
      'forward',
      'reload',
      'close',
    }.contains(action)) {
      throw ArgumentError.value(
        action,
        'action',
        'is not a safe preview action',
      );
    }
    return _runPreviewMutation(previewId, 'preview.$action');
  }

  @override
  Future<void> runPreviewInteraction(
    String previewId,
    String action,
    Map<String, Object?> args,
  ) {
    const inputActions = <String>{
      'click',
      'fill',
      'scroll',
      'type',
      'select',
      'press',
      'upload',
    };
    if (!inputActions.contains(action) && action != 'handoff') {
      throw ArgumentError.value(
        action,
        'action',
        'is not a supported preview interaction',
      );
    }
    if (args.containsKey('previewId')) {
      throw ArgumentError.value(args, 'args', 'must not override previewId');
    }
    return _runPreviewMutation(
      previewId,
      'preview.$action',
      capability: action == 'handoff' ? 'preview.control' : 'preview.input',
      extraArgs: args,
      confirmationExpected: action == 'upload',
    );
  }

  Future<void> _runPreviewMutation(
    String previewId,
    String command, {
    Map<String, Object?> extraArgs = const <String, Object?>{},
    String capability = 'preview.control',
    bool confirmationExpected = false,
  }) => _runDeveloperOperation(() async {
    final session = _developerSession();
    final frame = confirmationExpected
        ? await _runSessionOperation(
            prefix: command.replaceAll('.', '-'),
            command: command,
            capability: capability,
            session: session,
            args: <String, Object?>{...extraArgs, 'previewId': previewId},
            confirmationExpected: true,
          )
        : await _runComposerCommand(
            prefix: command.replaceAll('.', '-'),
            command: command,
            session: session,
            capability: capability,
            args: <String, Object?>{...extraArgs, 'previewId': previewId},
          );
    final preview = _previewResult(frame, session.sessionId);
    if (command == 'preview.close' || preview.state == 'closed') {
      _previews.remove(previewId);
      _previewCaptures.remove(previewId);
      _activePreviewId = _previews.keys.lastOrNull;
    } else {
      _activePreviewId = previewId;
    }
  });

  @override
  Future<void> capturePreview(String previewId) =>
      _runDeveloperOperation(() async {
        final session = _developerSession();
        final captureFrame = await _runComposerCommand(
          prefix: 'preview-capture',
          command: 'preview.capture',
          session: session,
          capability: 'preview.read',
          args: <String, Object?>{'previewId': previewId},
        );
        final preview = _previewResult(captureFrame, session.sessionId);
        final rawPreview =
            (captureFrame.result! as Map<String, Object?>)['preview'];
        final capture = rawPreview is Map<String, Object?>
            ? rawPreview['capture']
            : null;
        if (capture is! Map<String, Object?> ||
            capture['captureId'] is! String ||
            capture['size'] is! int ||
            capture['sha256'] is! String ||
            capture['mimeType'] is! String) {
          throw const FormatException('preview capture metadata is invalid');
        }
        final bytes = BytesBuilder(copy: false);
        var offset = 0;
        final size = capture['size']! as int;
        while (offset < size) {
          final chunkFrame = await _runComposerCommand(
            prefix: 'preview-capture-read',
            command: 'preview.capture.read',
            session: session,
            capability: 'preview.read',
            args: <String, Object?>{
              'previewId': previewId,
              'captureId': capture['captureId']! as String,
              'offset': offset,
            },
          );
          final chunk = chunkFrame.result;
          if (chunk is! Map<String, Object?> ||
              chunk['offset'] != offset ||
              chunk['nextOffset'] is! int ||
              chunk['content'] is! String) {
            throw const FormatException('preview capture chunk is invalid');
          }
          final decoded = base64Decode(chunk['content']! as String);
          final nextOffset = chunk['nextOffset']! as int;
          if (nextOffset - offset != decoded.length || nextOffset <= offset) {
            throw const FormatException('preview capture offsets are invalid');
          }
          bytes.add(decoded);
          offset = nextOffset;
        }
        final content = bytes.takeBytes();
        if (content.length != size ||
            sha256.convert(content).toString() != capture['sha256']) {
          throw const FormatException('preview capture integrity check failed');
        }
        _previewCaptures[previewId] = content;
        _previews[previewId] = PreviewWorkspaceState(
          previewId: preview.previewId,
          sessionId: preview.sessionId,
          state: preview.state,
          url: preview.url,
          revision: preview.revision,
          title: preview.title,
          canGoBack: preview.canGoBack,
          canGoForward: preview.canGoForward,
          capture: content,
          captureMimeType: capture['mimeType']! as String,
        );
      });

  @override
  Future<Uint8List> readTranscriptImage(
    String entryId,
    TranscriptImageMetadata image,
  ) async {
    final session = state.selectedSession;
    if (session == null) {
      throw StateError('choose a session before loading transcript images');
    }
    final bytes = BytesBuilder(copy: false);
    var offset = 0;
    int? expectedSize;
    while (true) {
      final frame = await _runComposerCommand(
        prefix: 'image-read',
        command: 'session.image.read',
        session: session,
        capability: 'sessions.read',
        args: <String, Object?>{
          'entryId': entryId,
          'sha256': image.sha256,
          'offset': offset,
        },
      );
      final result = frame.result;
      if (result is! Map<String, Object?> ||
          result['sha256'] != image.sha256 ||
          result['mimeType'] != image.mimeType ||
          result['size'] is! int ||
          result['offset'] != offset ||
          result['nextOffset'] is! int ||
          result['complete'] is! bool ||
          result['content'] is! String) {
        throw const FormatException('session.image.read result is invalid');
      }
      final size = result['size']! as int;
      expectedSize ??= size;
      if (size != expectedSize || size <= 0 || size > 20 * 1024 * 1024) {
        throw const FormatException('transcript image size changed');
      }
      final nextOffset = result['nextOffset']! as int;
      final chunk = base64Decode(result['content']! as String);
      if (nextOffset <= offset || nextOffset - offset != chunk.length) {
        throw const FormatException('transcript image offsets are invalid');
      }
      bytes.add(chunk);
      offset = nextOffset;
      final complete = result['complete']! as bool;
      if (complete != (offset == size)) {
        throw const FormatException('transcript image completion is invalid');
      }
      if (complete) break;
    }
    final value = bytes.takeBytes();
    if (value.length != expectedSize ||
        sha256.convert(value).toString() != image.sha256) {
      throw const FormatException('transcript image integrity check failed');
    }
    return value;
  }

  Future<String> _uploadImage(
    SessionSummary session,
    PromptImageAttachment attachment,
  ) async {
    if (!const <String>{
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
    }.contains(attachment.mimeType)) {
      throw ArgumentError.value(
        attachment.mimeType,
        'mimeType',
        'is not supported',
      );
    }
    if (attachment.bytes.isEmpty ||
        attachment.bytes.length > 20 * 1024 * 1024) {
      throw ArgumentError.value(
        attachment.bytes.length,
        'bytes',
        'image must be between 1 byte and 20 MiB',
      );
    }
    final begin = await _runComposerCommand(
      prefix: 'image-begin',
      command: 'session.image.begin',
      session: session,
      args: <String, Object?>{
        'mimeType': attachment.mimeType,
        'size': attachment.bytes.length,
        'sha256': sha256.convert(attachment.bytes).toString(),
      },
    );
    final beginResult = begin.result;
    if (beginResult is! Map<String, Object?> ||
        beginResult['imageId'] is! String ||
        beginResult['chunkBytes'] is! int) {
      throw const FormatException('session.image.begin result is invalid');
    }
    final imageId = beginResult['imageId']! as String;
    final chunkBytes = beginResult['chunkBytes']! as int;
    if (chunkBytes <= 0) {
      throw const FormatException('session.image.begin chunk size is invalid');
    }
    for (
      var offset = 0;
      offset < attachment.bytes.length;
      offset += chunkBytes
    ) {
      final end = min(offset + chunkBytes, attachment.bytes.length);
      final chunk = Uint8List.sublistView(attachment.bytes, offset, end);
      final response = await _runComposerCommand(
        prefix: 'image-chunk',
        command: 'session.image.chunk',
        session: session,
        args: <String, Object?>{
          'imageId': imageId,
          'offset': offset,
          'content': base64Encode(chunk),
        },
      );
      final result = response.result;
      if (result is! Map<String, Object?> ||
          result['imageId'] != imageId ||
          result['received'] != end ||
          result['complete'] != (end == attachment.bytes.length)) {
        throw const FormatException('session.image.chunk result is invalid');
      }
    }
    return imageId;
  }

  Future<void> _discardUploadedImages(
    SessionSummary session,
    List<String> imageIds,
  ) async {
    for (final imageId in imageIds) {
      try {
        await _runComposerCommand(
          prefix: 'image-discard',
          command: 'session.image.discard',
          session: session,
          args: <String, Object?>{'imageId': imageId},
        );
      } on Object {
        // The original upload failure remains the actionable error.
      }
    }
  }

  Future<ResponseFrame> _runPromptLeasedCommand({
    required String prefix,
    required String command,
    required SessionSummary session,
    required String expectedRevision,
    required Map<String, Object?> args,
    bool Function()? stillCurrent,
  }) async {
    if (!_grantedFeatures.contains('prompt.lease')) {
      return _runComposerCommand(
        prefix: prefix,
        command: command,
        session: session,
        expectedRevision: expectedRevision,
        args: args,
      );
    }
    final acquisition = await _runComposerCommand(
      prefix: 'prompt-lease-acquire',
      command: 'prompt.lease.acquire',
      session: session,
      expectedRevision: expectedRevision,
      args: const <String, Object?>{'ownerId': 't4-code-flutter'},
    );
    final result = acquisition.result;
    if (result is! Map<String, Object?> ||
        result['accepted'] == false ||
        result['leaseId'] is! String ||
        (result['leaseId']! as String).isEmpty) {
      throw const FormatException('prompt lease acquisition was rejected');
    }
    final currentSession = _sessions
        .where((candidate) => candidate.sessionId == session.sessionId)
        .firstOrNull;
    if (currentSession?.revision != expectedRevision ||
        stillCurrent?.call() == false) {
      throw StateError('The session request changed before it could be sent.');
    }
    return _runComposerCommand(
      prefix: prefix,
      command: command,
      session: currentSession!,
      expectedRevision: expectedRevision,
      args: <String, Object?>{...args, 'leaseId': result['leaseId']! as String},
    );
  }

  Future<ResponseFrame> _runComposerCommand({
    required String prefix,
    required String command,
    required SessionSummary session,
    required Map<String, Object?> args,
    String? expectedRevision,
    String capability = 'sessions.prompt',
  }) async {
    if (_phase != ConnectionPhase.ready || _hostId == null) {
      throw StateError('connect before sending a prompt');
    }
    if (!_grantedCapabilities.contains(capability)) {
      throw StateError('this device was not granted $capability');
    }
    final ids = _nextCommandIds(prefix);
    final completer = Completer<ResponseFrame>();
    _pendingCommands[ids.requestId] = _PendingCommand(
      commandId: ids.commandId,
      command: command,
      sessionId: session.sessionId,
      completer: completer,
    );
    _errorMessage = null;
    _publish();
    try {
      _send(
        WireEncoder.command(
          requestId: ids.requestId,
          commandId: ids.commandId,
          hostId: session.hostId,
          sessionId: session.sessionId,
          command: command,
          expectedRevision: expectedRevision,
          args: args,
        ),
      );
      final frame = await completer.future.timeout(
        const Duration(seconds: 30),
        onTimeout: () => throw TimeoutException('$command timed out'),
      );
      if (!frame.ok) {
        throw StateError(frame.error?.message ?? '$command failed');
      }
      return frame;
    } finally {
      _pendingCommands.remove(ids.requestId);
    }
  }

  Future<void> _handlePayload(int generation, Object? payload) async {
    if (_disposed || generation != _connectionGeneration) return;
    try {
      final encoded = switch (payload) {
        String value => value,
        List<int> value => utf8.decode(value, allowMalformed: false),
        _ => throw const FormatException('unsupported websocket payload'),
      };
      final frame = WireDecoder.decode(encoded);
      if (frame case PairOkFrame()) {
        await _applyPairOk(generation, frame);
      } else {
        _applyFrame(frame);
      }
    } on Object catch (error) {
      if (_disposed || generation != _connectionGeneration) return;
      _connectionGeneration += 1;
      _reconnectTimer?.cancel();
      _fail('Protocol error: $error');
      unawaited(_subscription?.cancel());
      unawaited(_channel?.sink.close());
    }
  }

  void _applyFrame(WireFrame frame) {
    switch (frame) {
      case WelcomeFrame():
        _hostId = frame.hostId;
        _reconnectAttempt = 0;
        _authenticationPhase = switch (frame.authentication) {
          'local' => AuthenticationPhase.local,
          'pairing-required' => AuthenticationPhase.pairingRequired,
          'paired' => AuthenticationPhase.paired,
          _ => throw const FormatException('unknown authentication state'),
        };
        _grantedCapabilities = frame.grantedCapabilities.toSet();
        _grantedFeatures = frame.grantedFeatures.toSet();
        if (_authenticationPhase != AuthenticationPhase.pairingRequired &&
            _settingsBootstrapGeneration != _connectionGeneration) {
          final canReadCatalog =
              _grantedCapabilities.contains('catalog.read') &&
              _grantedFeatures.contains('catalog.metadata');
          final canReadSettings =
              _grantedCapabilities.contains('config.read') &&
              _grantedFeatures.contains('settings.metadata');
          if (canReadCatalog || canReadSettings) {
            _settingsBootstrapGeneration = _connectionGeneration;
            final needsCatalog = canReadCatalog && _catalogFrame == null;
            final needsSettings = canReadSettings && _settingsFrame == null;
            if (needsCatalog && needsSettings) {
              _beginSettingsRefresh();
            } else {
              if (needsCatalog) {
                _sendHostProduct('catalog.get');
              }
              if (needsSettings) {
                _sendHostProduct('settings.read');
              }
            }
          }
        }
        if (_authenticationPhase != AuthenticationPhase.pairingRequired &&
            !_grantedCapabilities.contains('sessions.read')) {
          _phase = ConnectionPhase.ready;
          _errorMessage =
              'This device cannot read sessions. Pair again with '
              'sessions.read permission.';
          _publish();
          return;
        }
        _publish();
        if (_grantedCapabilities.contains('sessions.read') &&
            _authenticationPhase != AuthenticationPhase.pairingRequired &&
            _bootstrapGeneration != _connectionGeneration) {
          _bootstrapGeneration = _connectionGeneration;
          _sendSessionList();
        }
      case SessionsFrame():
        _applySessions(frame);
      case SnapshotFrame():
        if (frame.hostId == _hostId && frame.sessionId == _selectedSessionId) {
          _applySnapshot(frame);
        }
      case EntryFrame():
        if (frame.hostId == _hostId &&
            frame.sessionId == _selectedSessionId &&
            _acceptTranscriptCursor(frame.sessionId, frame.cursor)) {
          _upsertEntry(frame.entry);
          _publish();
        }
      case EventFrame():
        if (frame.hostId == _hostId &&
            frame.sessionId == _selectedSessionId &&
            _acceptTranscriptCursor(frame.sessionId, frame.cursor)) {
          _applyEvent(frame.event, frame.cursor);
          _publish();
        }
      case TerminalOutputFrame():
        _applyTerminalOutput(frame);
      case TerminalExitFrame():
        _applyTerminalExit(frame);
      case FilesAdditiveFrame():
        _applyFilesFrame(frame);
      case ReviewFrame():
        _applyReviewFrame(frame);
      case AuditTailFrame():
        _applyAuditEvents(frame.events);
      case AuditEventFrame():
        _applyAuditEvents(<AuditEvent>[frame.event]);
      case PreviewFrame():
        _applyPreviewFrame(frame);
      case ResponseFrame():
        _applyResponse(frame);
      case SessionDeltaFrame():
        _applySessionDelta(frame);
      case ConfirmationFrame():
        _applyConfirmation(frame);
      case AgentFrame():
        _applyLegacyAgentFrame(frame);
      case AgentAdditiveFrame():
        _applyAgentFrame(frame);
      case PairErrorFrame():
        _applyPairError(frame);
      case CatalogFrame():
        if (frame.hostId == _hostId) {
          _catalogFrame = frame;
          _catalogItems = List<CatalogItem>.unmodifiable(frame.items);
          _settingsRefreshSawCatalog = true;
          _projectHostSettings();
        }
      case SettingsFrame():
        if (frame.hostId == _hostId) {
          _settingsFrame = frame;
          _settingsRefreshSawSettings = true;
          _projectHostSettings();
        }
      case ErrorFrame():
        _errorMessage = frame.message;
        _submitting = false;
        _publish();
      case GapFrame():
        if (frame.hostId == _hostId && frame.sessionId == _selectedSessionId) {
          _transcriptRecoverySessionId = frame.sessionId;
          _savedCursors.remove(frame.sessionId);
          _phase = ConnectionPhase.synchronizing;
          _errorMessage = 'Recovering transcript continuity…';
          _publish();
          _sendAttach(frame.sessionId);
        }
      default:
        break;
    }
  }

  Future<void> _applyPairOk(int generation, PairOkFrame frame) async {
    final pending = _pendingPair;
    if (pending == null || frame.requestId != pending.requestId) {
      throw const FormatException('pairing response correlation mismatch');
    }
    final requested = pending.requestedCapabilities.toSet();
    final expiration = DateTime.tryParse(frame.expiresAt);
    if (frame.deviceId != pending.deviceId ||
        frame.deviceName != pending.deviceName ||
        frame.platform != pending.platform ||
        frame.requestedCapabilities.any(
          (value) => !requested.contains(value),
        ) ||
        frame.grantedCapabilities.any((value) => !requested.contains(value)) ||
        expiration == null ||
        !expiration.isAfter(DateTime.now().toUtc())) {
      throw const FormatException('pairing response identity mismatch');
    }
    final profile = _activeProfile;
    if (profile == null || profile.endpointKey != pending.endpointKey) return;
    _pendingPair = null;
    await hostCredentialStore.write(
      profile,
      DeviceCredentials(
        deviceId: frame.deviceId,
        deviceToken: frame.deviceToken,
      ),
    );
    if (_disposed ||
        generation != _connectionGeneration ||
        _activeProfile?.endpointKey != pending.endpointKey) {
      return;
    }
    _authenticationPhase = AuthenticationPhase.paired;
    _publish();
    await _connectCurrent();
  }

  void _applyPairError(PairErrorFrame frame) {
    final pending = _pendingPair;
    if (pending == null ||
        (frame.requestId != null && frame.requestId != pending.requestId)) {
      throw const FormatException('pairing error correlation mismatch');
    }
    _pendingPair = null;
    _authenticationPhase = AuthenticationPhase.pairingRequired;
    _errorMessage =
        'Pairing failed (${frame.code}). Check the code and try again.';
    _publish();
  }

  void _applySessions(SessionsFrame frame) {
    _applySessionListCursor(frame.cursor);
    _applySessionRefs(frame.sessions);
  }

  void _applySessionListCursor(SessionIndexCursor cursor) {
    _sessionIndexEpoch = cursor.epoch;
    _sessionIndexSeq = cursor.seq;
  }

  void _applySessionRefs(List<SessionRef> sessions) {
    final previousSelectedSessionId = _selectedSessionId;
    _sessions = sessions.map(_summaryFromRef).toList(growable: false)
      ..sort(_compareSessions);
    _attentionBySession
      ..clear()
      ..addEntries(
        sessions.map(
          (session) =>
              MapEntry(session.sessionId, _decodeSessionAttention(session)),
        ),
      );
    final selectedStillExists = _sessions.any(
      (session) => session.sessionId == _selectedSessionId,
    );
    if (!selectedStillExists) {
      _selectedSessionId =
          _sessions
              .where((session) => !session.archived)
              .firstOrNull
              ?.sessionId ??
          _sessions.firstOrNull?.sessionId;
      _selectDeveloperSessionProjection(_selectedSessionId);
    }
    final selected = _selectedSessionId;
    if (selected == null) {
      _phase = ConnectionPhase.ready;
      _publish();
      return;
    }
    final selectionChanged = selected != previousSelectedSessionId;
    if (selectionChanged) {
      _resetTranscriptPage();
      _messages.clear();
    }
    _publish();
    final cursor = selectionChanged ? null : _savedCursors[selected];
    if (cursor == null) {
      _primeTranscriptTailThenAttach(selected);
    } else {
      _sendAttach(selected, cursor: cursor);
    }
  }

  SessionSummary _summaryFromRef(SessionRef session) {
    final projectId = session.project['projectId'];
    final projectName = session.project['name'];
    final archivedAt = session.raw['archivedAt'];
    final pendingApproval = session.raw['pendingApproval'];
    final pendingUserInput = session.raw['pendingUserInput'];
    final rawLiveState = session.raw['liveState'];
    final liveState = rawLiveState is Map<String, Object?>
        ? rawLiveState
        : const <String, Object?>{};
    final rawModel = liveState['model'];
    String? modelSelector;
    String? modelDisplayName;
    if (rawModel is String && rawModel.isNotEmpty) {
      modelSelector = rawModel;
    } else if (rawModel is Map<String, Object?>) {
      final selector = rawModel['selector'];
      final provider = rawModel['provider'];
      final id = rawModel['id'];
      if (selector is String && selector.isNotEmpty) {
        modelSelector = selector;
      } else if (provider is String &&
          provider.isNotEmpty &&
          id is String &&
          id.isNotEmpty) {
        modelSelector = '$provider/$id';
      }
      final displayName = rawModel['displayName'];
      if (displayName is String && displayName.isNotEmpty) {
        modelDisplayName = displayName;
      }
    }
    final refModel = session.raw['model'];
    if (modelSelector == null && refModel is String && refModel.isNotEmpty) {
      modelSelector = refModel;
    }
    final rawThinking = liveState['thinking'] ?? session.raw['thinking'];
    final thinking = rawThinking is String ? rawThinking : null;
    final thinkingSupported = liveState['thinkingSupported'] == true;
    final thinkingLevels = switch (liveState['thinkingLevels']) {
      final List<Object?> values => values.whereType<String>().toList(
        growable: false,
      ),
      _ => const <String>[],
    };
    final queuedCount = switch (liveState['queuedMessageCount']) {
      final int count when count >= 0 => count,
      _ => _queuedMessageCount(liveState['queuedMessages']),
    };
    final streaming = liveState['isStreaming'] == true;
    return SessionSummary(
      hostId: session.hostId,
      sessionId: session.sessionId,
      title: session.title,
      revision: session.revision,
      status: session.status,
      projectId: projectId is String ? projectId : 'unknown-project',
      projectName: projectName is String && projectName.trim().isNotEmpty
          ? projectName
          : 'Project',
      updatedAt: session.updatedAt,
      archivedAt: archivedAt is String ? archivedAt : null,
      working:
          session.status == 'active' ||
          pendingApproval == true ||
          pendingUserInput == true ||
          streaming,
      modelSelector: modelSelector,
      modelDisplayName: modelDisplayName,
      thinking: thinking,
      thinkingSupported: thinkingSupported,
      thinkingLevels: thinkingLevels,
      fast: liveState['fast'] == true,
      fastAvailable: liveState['fastAvailable'] == true,
      turnActive:
          streaming || pendingApproval == true || pendingUserInput == true,
      queuedFollowUpCount: queuedCount,
    );
  }

  _SessionAttention _decodeSessionAttention(SessionRef session) {
    final raw = session.raw['attention'];
    if (raw == null) return const _SessionAttention();
    if (raw is! Map<String, Object?>) {
      return const _SessionAttention(malformed: true);
    }
    final pending = raw['pending'];
    final pendingCount = raw['pendingCount'];
    final truncated = raw['truncated'];
    if (pending is! List<Object?> ||
        pending.length > 8 ||
        pendingCount is! int ||
        pendingCount < pending.length ||
        truncated is! bool ||
        truncated != (pendingCount > pending.length)) {
      return const _SessionAttention(malformed: true);
    }
    final items = <AttentionItem>[];
    for (final value in pending) {
      if (value is! Map<String, Object?> ||
          value['kind'] is! String ||
          value['id'] is! String ||
          value['requestedAt'] is! String) {
        return const _SessionAttention(malformed: true);
      }
      final kind = switch (value['kind']) {
        'approval' => AttentionKind.approval,
        'question' => AttentionKind.question,
        'plan' => AttentionKind.plan,
        _ => null,
      };
      final at = DateTime.tryParse(value['requestedAt']! as String);
      final requestId = value['id']! as String;
      if (kind == null || requestId.isEmpty || at == null) {
        return const _SessionAttention(malformed: true);
      }
      var title = '';
      var summary = '';
      var allowText = false;
      var choices = const <AttentionChoice>[];
      if (kind == AttentionKind.question) {
        final question = value['question'];
        final options = value['options'];
        if (question is! String ||
            options is! List<Object?> ||
            options.length > 32 ||
            value['allowText'] is! bool) {
          return const _SessionAttention(malformed: true);
        }
        final parsed = <AttentionChoice>[];
        for (final option in options) {
          if (option is! Map<String, Object?> ||
              option['id'] is! String ||
              option['label'] is! String) {
            return const _SessionAttention(malformed: true);
          }
          parsed.add(
            AttentionChoice(
              id: option['id']! as String,
              label: option['label']! as String,
            ),
          );
        }
        title = 'Question';
        summary = question;
        allowText = value['allowText']! as bool;
        choices = List<AttentionChoice>.unmodifiable(parsed);
      } else {
        if (value['title'] is! String || value['summary'] is! String) {
          return const _SessionAttention(malformed: true);
        }
        title = value['title']! as String;
        summary = value['summary']! as String;
      }
      items.add(
        AttentionItem(
          key: '${session.sessionId}:${kind.name}:$requestId',
          kind: kind,
          sessionId: session.sessionId,
          sessionTitle: session.title,
          revision: session.revision,
          title: title,
          summary: summary,
          at: at.toUtc(),
          requestId: requestId,
          choices: choices,
          allowText: allowText,
          actionable: true,
        ),
      );
    }
    final latest = raw['latestOutcome'];
    if (latest != null) {
      if (latest is! Map<String, Object?> ||
          latest['id'] is! String ||
          latest['kind'] is! String ||
          latest['at'] is! String ||
          latest['summary'] is! String) {
        return const _SessionAttention(malformed: true);
      }
      final kind = switch (latest['kind']) {
        'completed' => AttentionKind.completed,
        'failed' => AttentionKind.failed,
        'cancelled' => AttentionKind.cancelled,
        _ => null,
      };
      final at = DateTime.tryParse(latest['at']! as String);
      if (kind == null || at == null) {
        return const _SessionAttention(malformed: true);
      }
      final outcomeId = latest['id']! as String;
      items.add(
        AttentionItem(
          key: '${session.sessionId}:${kind.name}:$outcomeId',
          kind: kind,
          sessionId: session.sessionId,
          sessionTitle: session.title,
          revision: session.revision,
          title: switch (kind) {
            AttentionKind.completed => 'Completed',
            AttentionKind.failed => 'Failed',
            AttentionKind.cancelled => 'Cancelled',
            _ => 'Update',
          },
          summary: latest['summary']! as String,
          at: at.toUtc(),
        ),
      );
    }
    return _SessionAttention(
      items: List<AttentionItem>.unmodifiable(items),
      omittedCount: pendingCount - pending.length,
      truncated: truncated,
    );
  }

  int _queuedMessageCount(Object? value) {
    if (value is! Map<String, Object?>) return 0;
    var count = 0;
    for (final messages in value.values) {
      if (messages is List<Object?>) count += messages.length;
    }
    return count;
  }

  int _compareSessions(SessionSummary left, SessionSummary right) {
    final updated = right.updatedAt.compareTo(left.updatedAt);
    return updated != 0 ? updated : left.sessionId.compareTo(right.sessionId);
  }

  void _upsertSession(SessionRef ref) {
    final next = _summaryFromRef(ref);
    final index = _sessions.indexWhere(
      (session) => session.sessionId == next.sessionId,
    );
    final sessions = _sessions.toList(growable: true);
    if (index < 0) {
      sessions.add(next);
    } else {
      sessions[index] = next;
    }
    sessions.sort(_compareSessions);
    _sessions = List<SessionSummary>.unmodifiable(sessions);
    _attentionBySession[ref.sessionId] = _decodeSessionAttention(ref);
    _publish();
  }

  void _applySessionDelta(SessionDeltaFrame frame) {
    final cursor = frame.cursor;
    final currentEpoch = _sessionIndexEpoch;
    final currentSeq = _sessionIndexSeq;
    if (currentEpoch != null && currentSeq != null) {
      if (cursor.epoch == currentEpoch && cursor.seq <= currentSeq) return;
      if (cursor.epoch != currentEpoch || cursor.seq != currentSeq + 1) {
        _sendSessionList();
        return;
      }
    }
    _sessionIndexEpoch = cursor.epoch;
    _sessionIndexSeq = cursor.seq;
    final upsert = frame.upsert;
    if (upsert != null) {
      _upsertSession(upsert);
      return;
    }
    final removed = frame.remove;
    if (removed == null) return;
    final wasSelected = _selectedSessionId == removed;
    _sessions = _sessions
        .where((session) => session.sessionId != removed)
        .toList(growable: false);
    _attentionBySession.remove(removed);
    _attentionConfirmations.removeWhere(
      (_, frame) => frame.sessionId == removed,
    );
    _agentActivities.removeWhere(
      (_, activity) => activity.sessionId == removed,
    );
    _reviews.removeWhere((_, review) => review.sessionId == removed);
    _savedCursors.remove(removed);
    if (!wasSelected) {
      _publish();
      return;
    }
    _messages.clear();
    final replacement =
        _sessions.where((session) => !session.archived).firstOrNull ??
        _sessions.firstOrNull;
    _selectedSessionId = replacement?.sessionId;
    _selectDeveloperSessionProjection(_selectedSessionId);
    if (replacement == null) {
      _phase = ConnectionPhase.ready;
      _publish();
      return;
    }
    _phase = ConnectionPhase.synchronizing;
    _publish();
    _sendAttach(replacement.sessionId);
  }

  void _applyConfirmation(ConfirmationFrame frame) {
    if (frame.hostId != _hostId ||
        (frame.sessionId != null &&
            !_sessions.any(
              (session) => session.sessionId == frame.sessionId,
            ))) {
      return;
    }
    final expiresAt = DateTime.tryParse(frame.expiresAt);
    if (expiresAt == null || !expiresAt.isAfter(DateTime.now().toUtc())) {
      throw const FormatException('confirmation is expired');
    }
    final sessionPending = _pendingSessionOperations.values
        .where((candidate) => candidate.commandId == frame.commandId)
        .firstOrNull;
    if (sessionPending != null) {
      if (!sessionPending.confirmationExpected ||
          sessionPending.confirmationSent ||
          frame.sessionId != sessionPending.sessionId ||
          frame.summary != sessionPending.command ||
          frame.revision != sessionPending.expectedRevision) {
        throw const FormatException('confirmation correlation mismatch');
      }
      sessionPending.confirmationSent = true;
      final ids = _nextCommandIds('confirm');
      _send(
        WireEncoder.confirm(
          requestId: ids.requestId,
          confirmationId: frame.confirmationId,
          commandId: frame.commandId,
          hostId: frame.hostId,
          sessionId: frame.sessionId,
          decision: 'approve',
        ),
      );
      _attentionConfirmations.remove(frame.confirmationId);
      return;
    }

    final hostPending = _pendingCommands.values
        .where((candidate) => candidate.commandId == frame.commandId)
        .firstOrNull;
    if (hostPending != null &&
        (!hostPending.confirmationExpected ||
            hostPending.confirmationSent ||
            frame.sessionId != hostPending.sessionId ||
            frame.revision != hostPending.expectedRevision)) {
      throw const FormatException('confirmation correlation mismatch');
    }
    if (hostPending != null) hostPending.confirmationSent = true;
    _attentionConfirmations[frame.confirmationId] = frame;
    _publish();
  }

  void _applyLegacyAgentFrame(AgentFrame frame) {
    if (frame.hostId != _hostId) return;
    final detail = frame.detail;
    String? text(String key) => switch (detail?[key]) {
      final String value when value.trim().isNotEmpty => value.trim(),
      _ => null,
    };
    final parentAgentId = text('parentId');
    _agentActivities[frame.agentId] = AgentActivity(
      agentId: frame.agentId,
      sessionId: frame.sessionId,
      label: text('title') ?? text('name') ?? frame.agentId,
      status: frame.state,
      progress: frame.progress,
      updatedAt: DateTime.now().toUtc(),
      parentAgentId: parentAgentId == frame.agentId ? null : parentAgentId,
      description: text('description'),
      model: text('model'),
      currentTool: text('currentTool') ?? text('tool'),
      evidence: text('evidence'),
    );
    _recordActivity(
      category: 'agent',
      title: _agentActivities[frame.agentId]!.label,
      detail: frame.state,
      raw: frame.raw,
    );
    _publish();
  }

  void _applyAgentFrame(AgentAdditiveFrame frame) {
    if (frame.hostId != _hostId || frame.frameType == 'agent.transcript') {
      return;
    }
    final previous = _agentActivities[frame.agentId];
    final status =
        frame.lifecycle ??
        frame.state ??
        frame.event ??
        previous?.status ??
        'active';
    final detail = frame.detail;
    final label = switch (detail?['title'] ??
        detail?['label'] ??
        detail?['message']) {
      final String value when value.trim().isNotEmpty => value.trim(),
      _ => previous?.label ?? 'Background agent ${frame.agentId}',
    };
    _agentActivities[frame.agentId] = AgentActivity(
      agentId: frame.agentId,
      sessionId: frame.sessionId,
      label: label,
      status: status,
      progress: frame.progress ?? previous?.progress,
      updatedAt: DateTime.now().toUtc(),
      parentAgentId: previous?.parentAgentId,
      description: previous?.description,
      model: previous?.model,
      currentTool: previous?.currentTool,
      evidence: previous?.evidence,
    );
    _recordActivity(
      category: 'agent',
      title: label,
      detail: status,
      raw: frame.raw,
    );
    _publish();
  }

  void _applyTerminalOutput(TerminalOutputFrame frame) {
    if (frame.hostId != _hostId) return;
    final terminal = _terminals[frame.terminalId];
    if (terminal == null || terminal.sessionId != frame.sessionId) return;
    final current = _terminalCursors[frame.terminalId];
    if (current != null &&
        current.epoch == frame.cursor.epoch &&
        frame.cursor.seq <= current.seq) {
      return;
    }
    _terminalCursors[frame.terminalId] = frame.cursor;
    final chunk = frame.encoding == 'base64'
        ? utf8.decode(base64Decode(frame.data), allowMalformed: true)
        : frame.data;
    final combined =
        '${current == null || current.epoch == frame.cursor.epoch ? terminal.output : ''}$chunk';
    final output = combined.length > 1000000
        ? combined.substring(combined.length - 1000000)
        : combined;
    _terminals[frame.terminalId] = TerminalSession(
      terminalId: terminal.terminalId,
      sessionId: terminal.sessionId,
      title: terminal.title,
      output: output,
      running: terminal.running,
      exitCode: terminal.exitCode,
      signal: terminal.signal,
    );
    _publish();
  }

  void _applyTerminalExit(TerminalExitFrame frame) {
    if (frame.hostId != _hostId) return;
    final terminal = _terminals[frame.terminalId];
    if (terminal == null || terminal.sessionId != frame.sessionId) return;
    _terminalCursors[frame.terminalId] = frame.cursor;
    _terminals[frame.terminalId] = TerminalSession(
      terminalId: terminal.terminalId,
      sessionId: terminal.sessionId,
      title: terminal.title,
      output: terminal.output,
      running: false,
      exitCode: frame.exitCode,
      signal: frame.signal,
    );
    _recordActivity(
      category: 'shell',
      title: 'Terminal exited',
      detail: frame.signal ?? 'Exit code ${frame.exitCode}',
      raw: frame.raw,
    );
    _publish();
  }

  void _applyFilesFrame(FilesAdditiveFrame frame) {
    if (frame.hostId != _hostId || frame.sessionId != _selectedSessionId) {
      return;
    }
    _fileWorkspace = FileWorkspaceState(
      path: frame.path,
      entries: frame.entries == null
          ? _fileWorkspace.entries
          : <DeveloperFileEntry>[
              for (final entry in frame.entries!)
                DeveloperFileEntry(
                  path: entry.path,
                  kind: entry.kind,
                  size: entry.size,
                  revision: entry.revision,
                ),
            ],
      content: frame.content ?? _fileWorkspace.content,
      diff: frame.diff ?? frame.patch ?? _fileWorkspace.diff,
      revision: frame.revision ?? frame.toRevision ?? _fileWorkspace.revision,
    );
    _recordActivity(
      category: 'files',
      title: frame.frameType,
      detail: frame.path,
      raw: frame.raw,
    );
    _publish();
  }

  void _applyReviewFrame(ReviewFrame frame) {
    if (frame.hostId != _hostId) return;
    _reviews[frame.reviewId] = ReviewWorkspaceItem(
      reviewId: frame.reviewId,
      sessionId: frame.sessionId,
      status: frame.status,
      path: frame.path,
      findings: frame.findings,
    );
    _recordActivity(
      category: 'review',
      title: 'Review ${frame.status}',
      detail: frame.path ?? frame.reviewId,
      raw: frame.raw,
    );
    _publish();
  }

  void _applyAuditEvents(List<AuditEvent> events) {
    for (final event in events) {
      _recordActivity(
        id: event.eventId,
        category: 'audit',
        title: event.action,
        detail: event.actor,
        at: DateTime.tryParse(event.timestamp)?.toUtc(),
        raw: event.raw,
      );
    }
    _publish();
  }

  void _recordAuditMap(Map<String, Object?> raw) {
    final eventId = raw['eventId'];
    final action = raw['action'];
    final actor = raw['actor'];
    final timestamp = raw['timestamp'];
    if (eventId is! String || action is! String || actor is! String) return;
    _recordActivity(
      id: eventId,
      category: 'audit',
      title: action,
      detail: actor,
      at: timestamp is String ? DateTime.tryParse(timestamp)?.toUtc() : null,
      raw: raw,
    );
  }

  void _recordActivity({
    String? id,
    required String category,
    required String title,
    required String detail,
    required Map<String, Object?> raw,
    DateTime? at,
  }) {
    final timestamp = at ?? DateTime.now().toUtc();
    final key = id ?? '$category:${timestamp.microsecondsSinceEpoch}';
    _activities[key] = DeveloperActivity(
      id: key,
      category: category,
      title: title,
      detail: detail,
      at: timestamp,
      raw: const JsonEncoder.withIndent('  ').convert(_redact(raw)),
    );
    while (_activities.length > 1000) {
      _activities.remove(_activities.keys.first);
    }
  }

  Object? _redact(Object? value) {
    if (value is List<Object?>) return value.map(_redact).toList();
    if (value is! Map<String, Object?>) return value;
    return <String, Object?>{
      for (final entry in value.entries)
        entry.key:
            RegExp(
              r'token|password|secret|authorization|cookie',
              caseSensitive: false,
            ).hasMatch(entry.key)
            ? '<redacted>'
            : _redact(entry.value),
    };
  }

  PreviewWorkspaceState _previewResult(ResponseFrame frame, String sessionId) {
    final result = frame.result;
    if (result is! Map<String, Object?> ||
        result['preview'] is! Map<String, Object?>) {
      throw const FormatException('preview command result is invalid');
    }
    return _applyPreviewMap(
      result['preview']! as Map<String, Object?>,
      sessionId,
    );
  }

  PreviewWorkspaceState _applyPreviewMap(
    Map<String, Object?> raw,
    String sessionId,
  ) {
    if (raw['previewId'] is! String ||
        raw['state'] is! String ||
        raw['url'] is! String ||
        raw['revision'] is! String) {
      throw const FormatException('preview snapshot is invalid');
    }
    final previewId = raw['previewId']! as String;
    final preview = PreviewWorkspaceState(
      previewId: previewId,
      sessionId: sessionId,
      state: raw['state']! as String,
      url: raw['url']! as String,
      revision: raw['revision']! as String,
      title: raw['title'] is String ? raw['title']! as String : null,
      canGoBack: raw['canGoBack'] == true,
      canGoForward: raw['canGoForward'] == true,
      capture: _previewCaptures[previewId],
      captureMimeType: raw['capture'] is Map<String, Object?>
          ? (raw['capture']! as Map<String, Object?>)['mimeType'] as String?
          : null,
    );
    _previews[previewId] = preview;
    _activePreviewId ??= previewId;
    return preview;
  }

  void _applyPreviewFrame(PreviewFrame frame) {
    if (frame.hostId != _hostId) return;
    final snapshot = frame.snapshot;
    if (snapshot != null) {
      final preview = PreviewWorkspaceState(
        previewId: snapshot.previewId,
        sessionId: frame.sessionId,
        state: snapshot.state,
        url: snapshot.url,
        revision: snapshot.revision,
        title: snapshot.title,
        canGoBack: snapshot.canGoBack ?? false,
        canGoForward: snapshot.canGoForward ?? false,
        capture: _previewCaptures[snapshot.previewId],
        captureMimeType: snapshot.capture?['mimeType'] as String?,
      );
      _previews[preview.previewId] = preview;
      _activePreviewId ??= preview.previewId;
    } else if (_previews[frame.previewId] case final previous?) {
      _previews[frame.previewId] = PreviewWorkspaceState(
        previewId: previous.previewId,
        sessionId: previous.sessionId,
        state: previous.state,
        url: previous.url,
        revision: frame.revision,
        title: previous.title,
        canGoBack: previous.canGoBack,
        canGoForward: previous.canGoForward,
        capture: previous.capture,
        captureMimeType: previous.captureMimeType,
        error: frame.message ?? frame.error ?? frame.code,
      );
    }
    _recordActivity(
      category: 'preview',
      title: frame.frameType,
      detail: frame.message ?? frame.error ?? frame.previewId,
      raw: frame.raw,
    );
    _publish();
  }

  void _applySnapshot(SnapshotFrame frame) {
    if (_selectedSessionId != frame.sessionId) return;
    _transcriptRecoverySessionId = null;
    final liveIds = frame.entries.map((entry) => entry.id).toSet();
    final firstOverlap = _pagedTranscriptEntries.indexWhere(
      (entry) => liveIds.contains(entry.id),
    );
    final pagedPrefix = firstOverlap < 0
        ? _pagedTranscriptEntries
        : _pagedTranscriptEntries.take(firstOverlap);
    _messages.clear();
    for (final entry in pagedPrefix) {
      _upsertEntry(entry);
    }
    for (final entry in frame.entries) {
      _upsertEntry(entry);
    }
    _savedCursors[frame.sessionId] = frame.cursor;
    _sessions = _sessions
        .map(
          (session) => session.sessionId == frame.sessionId
              ? SessionSummary(
                  hostId: session.hostId,
                  sessionId: session.sessionId,
                  title: session.title,
                  revision: frame.revision,
                  status: session.status,
                  projectId: session.projectId,
                  projectName: session.projectName,
                  updatedAt: session.updatedAt,
                  archivedAt: session.archivedAt,
                  working: session.working,
                  modelSelector: session.modelSelector,
                  modelDisplayName: session.modelDisplayName,
                  thinking: session.thinking,
                  thinkingSupported: session.thinkingSupported,
                  thinkingLevels: session.thinkingLevels,
                  fast: session.fast,
                  fastAvailable: session.fastAvailable,
                  turnActive: session.turnActive,
                  queuedFollowUpCount: session.queuedFollowUpCount,
                )
              : session,
        )
        .toList(growable: false);
    _phase = ConnectionPhase.ready;
    _errorMessage = null;
    _publish();
  }

  bool _acceptTranscriptCursor(String sessionId, TranscriptCursor next) {
    final current = _savedCursors[sessionId];
    if (current == null) {
      _savedCursors[sessionId] = next;
      return true;
    }
    if (next.epoch == current.epoch && next.seq <= current.seq) return false;
    if (next.epoch != current.epoch || next.seq != current.seq + 1) {
      _phase = ConnectionPhase.synchronizing;
      _errorMessage = 'Transcript continuity changed; waiting for a snapshot.';
      _publish();
      return false;
    }
    _savedCursors[sessionId] = next;
    return true;
  }

  void _upsertEntry(DurableEntry entry) {
    final data = entry.data;
    if (entry.kind == 'message') {
      final text = data['text'];
      if (text is! String) return;
      _messages[entry.id] = TranscriptMessage(
        id: entry.id,
        role: _messageRole(data['role']),
        text: text,
        reasoning: data['reasoning'] is String
            ? data['reasoning']! as String
            : '',
        images: _entryImages(data['images']),
      );
      return;
    }
    if (entry.kind == 'tool-use') {
      final result = data['result'];
      final resultMap = result is Map<String, Object?> ? result : null;
      final output = resultMap?['output'];
      final isError = resultMap?['isError'];
      _messages[entry.id] = TranscriptMessage(
        id: entry.id,
        role: MessageRole.tool,
        kind: TranscriptKind.tool,
        text: '',
        toolName: data['tool'] is String ? data['tool']! as String : 'tool',
        toolTitle: data['title'] is String ? data['title']! as String : null,
        toolArguments: _jsonDisplay(data['args']),
        toolOutput: output is String ? output : _jsonDisplay(result),
        toolSucceeded: isError is bool ? !isError : data['ok'] as bool?,
        images: _entryImages(data['images']),
      );
      return;
    }
    if (entry.kind == 'compaction') {
      final summary = data['summary'];
      if (summary is! String) return;
      _messages[entry.id] = TranscriptMessage(
        id: entry.id,
        role: MessageRole.system,
        kind: TranscriptKind.compaction,
        text: summary,
      );
    }
  }

  List<TranscriptImageMetadata> _entryImages(Object? value) {
    if (value is! List<Object?>) return const <TranscriptImageMetadata>[];
    final images = <TranscriptImageMetadata>[];
    for (final item in value) {
      if (item is! Map<String, Object?>) continue;
      final sha256 = item['sha256'];
      final mimeType = item['mimeType'];
      if (sha256 is String && mimeType is String) {
        images.add(TranscriptImageMetadata(sha256: sha256, mimeType: mimeType));
      }
    }
    return List<TranscriptImageMetadata>.unmodifiable(images);
  }

  String? _jsonDisplay(Object? value) {
    if (value == null) return null;
    if (value is String) return value;
    try {
      return const JsonEncoder.withIndent('  ').convert(value);
    } on Object {
      return value.toString();
    }
  }

  String _eventItemId(TranscriptCursor cursor, String suffix) =>
      'event-${cursor.epoch}-${cursor.seq}-$suffix';

  void _applyEvent(Map<String, Object?> event, TranscriptCursor cursor) {
    final eventType = event['type'];
    _recordActivity(
      id: 'runtime:${cursor.epoch}:${cursor.seq}',
      category: eventType is String && eventType.startsWith('tool.')
          ? 'tool'
          : 'runtime',
      title: eventType is String ? eventType : 'Unknown event',
      detail:
          _jsonDisplay(event['message'] ?? event['title'] ?? event['note']) ??
          '',
      raw: event,
    );
    switch (event['type']) {
      case 'message.update':
        final entryId = event['entryId'];
        final text = event['text'];
        if (entryId is String && text is String) {
          if (event['role'] == 'user') {
            _messages.removeWhere(
              (id, message) => id.startsWith('local-prompt:'),
            );
          }
          _messages[entryId] = TranscriptMessage(
            id: entryId,
            role: _messageRole(event['role']),
            text: text,
            reasoning: event['reasoning'] is String
                ? event['reasoning']! as String
                : '',
            streaming: true,
          );
        }
      case 'message.settled':
        final transientEntryId = event['transientEntryId'];
        if (transientEntryId is String) _messages.remove(transientEntryId);
      case 'message.discarded':
        final transientEntryId = event['transientEntryId'];
        if (transientEntryId is String) _messages.remove(transientEntryId);
      case 'tool.start':
        final callId = event['callId'];
        if (callId is String) {
          _messages['tool:$callId'] = TranscriptMessage(
            id: 'tool:$callId',
            role: MessageRole.tool,
            kind: TranscriptKind.tool,
            text: '',
            toolName: event['tool'] is String
                ? event['tool']! as String
                : 'tool',
            toolTitle: event['title'] is String
                ? event['title']! as String
                : null,
            toolArguments: _jsonDisplay(event['args']),
            toolRunning: true,
          );
        }
      case 'tool.progress':
        final callId = event['callId'];
        final current = callId is String ? _messages['tool:$callId'] : null;
        if (callId is String && current != null) {
          final note = event['note'];
          final chunk = event['chunk'];
          final appended = <String>[
            if (current.toolOutput case final output? when output.isNotEmpty)
              output,
            if (chunk is String && chunk.isNotEmpty) chunk,
          ].join();
          _messages['tool:$callId'] = TranscriptMessage(
            id: current.id,
            role: current.role,
            kind: current.kind,
            text: note is String && note.isNotEmpty ? note : current.text,
            toolName: current.toolName,
            toolTitle: current.toolTitle,
            toolArguments: current.toolArguments,
            toolOutput: appended.isEmpty ? null : appended,
            toolRunning: true,
            toolProgress: switch (event['progress']) {
              final num progress => progress.toDouble().clamp(0, 1),
              _ => current.toolProgress,
            },
          );
        }
      case 'tool.result':
        final callId = event['callId'];
        final current = callId is String ? _messages['tool:$callId'] : null;
        if (callId is String) {
          _messages['tool:$callId'] = TranscriptMessage(
            id: 'tool:$callId',
            role: MessageRole.tool,
            kind: TranscriptKind.tool,
            text: current?.text ?? '',
            toolName: current?.toolName ?? 'tool',
            toolTitle: current?.toolTitle,
            toolArguments: current?.toolArguments,
            toolOutput: _jsonDisplay(event['result']),
            toolSucceeded: event['ok'] is bool ? event['ok']! as bool : null,
          );
        }
      case 'turn.start':
      case 'agent.start':
        _submitting = true;
      case 'turn.end':
      case 'agent.end':
        _submitting = false;
      case 'turn.error':
        _submitting = false;
        final message = event['message'];
        final text = message is String ? message : 'The agent turn failed.';
        _errorMessage = text;
        _messages[_eventItemId(cursor, 'error')] = TranscriptMessage(
          id: _eventItemId(cursor, 'error'),
          role: MessageRole.system,
          kind: TranscriptKind.notice,
          text: text,
        );
      case 'notice':
        final message = event['message'];
        if (message is String) {
          _messages[_eventItemId(cursor, 'notice')] = TranscriptMessage(
            id: _eventItemId(cursor, 'notice'),
            role: MessageRole.system,
            kind: TranscriptKind.notice,
            text: message,
          );
        }
    }
  }

  void _applyResponse(ResponseFrame frame) {
    final operation = _pendingSessionOperations.remove(frame.requestId);
    if (operation != null) {
      if (operation.commandId != frame.commandId ||
          operation.command != frame.command ||
          operation.sessionId != frame.sessionId) {
        throw const FormatException('session operation correlation mismatch');
      }
      operation.completer!.complete(frame);
      return;
    }
    final pending = _pendingCommands.remove(frame.requestId);
    if (pending == null) {
      throw FormatException(
        'unexpected response for ${frame.command ?? 'unknown command'}',
      );
    }
    if (pending.commandId != frame.commandId) {
      throw const FormatException('response command ID mismatch');
    }
    if (pending.command != frame.command) {
      throw const FormatException('response command mismatch');
    }
    if (pending.sessionId != frame.sessionId) {
      throw const FormatException('response session mismatch');
    }
    final completer = pending.completer;
    if (completer != null) {
      completer.complete(frame);
      return;
    }
    if (pending.command == 'session.attach' &&
        pending.sessionId != _selectedSessionId) {
      return;
    }
    if (!frame.ok) {
      if (pending.command == 'session.state.get' &&
          frame.error?.code == 'session_locked') {
        _publish();
        return;
      }
      if (frame.command == 'catalog.get' || frame.command == 'settings.read') {
        final error = StateError(
          frame.error?.message ?? '${frame.command} failed',
        );
        _settingsRefreshTimer?.cancel();
        _settingsRefreshTimer = null;
        _settingsState = HostSettingsState(
          revision: _settingsState.revision,
          entries: _settingsState.entries,
          error: error.message,
          issues: _settingsState.issues,
        );
        final refresh = _settingsRefreshCompleter;
        _settingsRefreshCompleter = null;
        if (refresh != null && !refresh.isCompleted) {
          refresh.completeError(error);
        }
      }
      _submitting = false;
      _errorMessage = frame.error?.message ?? 'Command failed.';
      _publish();
      return;
    }
    if (frame.command == 'catalog.get') {
      final result = frame.catalogResult;
      if (result == null) {
        throw const FormatException('catalog.get result is missing');
      }
      _catalogFrame = CatalogFrame(
        hostId: frame.hostId,
        revision: result.revision,
        items: result.items,
        raw: frame.raw,
      );
      _catalogItems = List<CatalogItem>.unmodifiable(result.items);
      _settingsRefreshSawCatalog = true;
      _projectHostSettings();
      return;
    }
    if (frame.command == 'settings.read') {
      final result = frame.settingsResult;
      if (result == null) {
        throw const FormatException('settings.read result is missing');
      }
      _settingsFrame = SettingsFrame(
        hostId: frame.hostId,
        revision: result.revision,
        settings: result.settings,
        raw: frame.raw,
      );
      _settingsRefreshSawSettings = true;
      _projectHostSettings();
      return;
    }
    if (frame.command == 'session.list') {
      final sessions = frame.sessionListResult;
      if (sessions == null) {
        throw const FormatException('session.list result is missing');
      }
      _applySessionListCursor(sessions.cursor);
      _applySessionRefs(sessions.sessions);
      if (_grantedFeatures.contains('host.watch')) {
        _sendHostWatch(sessions.cursor);
      }
      return;
    }
    if (frame.command == 'session.state.get') {
      final result = frame.sessionStateResult;
      if (result == null || pending.sessionId == null) {
        throw const FormatException('session.state.get result is missing');
      }
      _applySessionStateResult(pending.sessionId!, result);
      return;
    }
    if (frame.command == 'session.attach' &&
        pending.sessionId == _selectedSessionId &&
        _transcriptRecoverySessionId != pending.sessionId &&
        (_messages.isNotEmpty ||
            _savedCursors.containsKey(_selectedSessionId))) {
      _phase = ConnectionPhase.ready;
    }
    if (frame.command == 'session.attach' &&
        pending.sessionId == _selectedSessionId) {
      _sendSessionStateGet(pending.sessionId!);
    }
    _publish();
  }

  void _applySessionStateResult(String sessionId, SessionStateResult result) {
    _sessions = _sessions
        .map((session) {
          if (session.sessionId != sessionId) return session;
          final model = result.model;
          final modelSelector =
              model?.selector ??
              (model == null ? null : '${model.provider}/${model.id}');
          return SessionSummary(
            hostId: session.hostId,
            sessionId: session.sessionId,
            title: session.title,
            revision: session.revision,
            status: session.status,
            projectId: session.projectId,
            projectName: session.projectName,
            updatedAt: session.updatedAt,
            archivedAt: session.archivedAt,
            working:
                session.status == 'active' ||
                session.working ||
                result.isStreaming,
            modelSelector: modelSelector ?? session.modelSelector,
            modelDisplayName: model?.displayName ?? session.modelDisplayName,
            thinking: result.thinking ?? session.thinking,
            thinkingSupported:
                result.thinkingSupported ?? session.thinkingSupported,
            thinkingLevels: result.thinkingLevels ?? session.thinkingLevels,
            fast: result.fastActive ?? result.fast ?? session.fast,
            fastAvailable: result.fastAvailable ?? session.fastAvailable,
            turnActive: result.isStreaming || session.turnActive,
            queuedFollowUpCount: result.queuedMessageCount,
          );
        })
        .toList(growable: false);
    _publish();
  }

  void _sendSessionList() {
    final hostId = _hostId;
    if (hostId == null ||
        _pendingCommands.values.any(
          (pending) => pending.command == 'session.list',
        )) {
      return;
    }
    final ids = _nextCommandIds('session-list');
    _pendingCommands[ids.requestId] = _PendingCommand(
      commandId: ids.commandId,
      command: 'session.list',
    );
    _send(
      WireEncoder.sessionList(
        requestId: ids.requestId,
        commandId: ids.commandId,
        hostId: hostId,
      ),
    );
  }

  void _sendHostWatch(SessionIndexCursor cursor) {
    final hostId = _hostId;
    if (hostId == null) return;
    final ids = _nextCommandIds('host-watch');
    _pendingCommands[ids.requestId] = _PendingCommand(
      commandId: ids.commandId,
      command: 'host.watch',
    );
    _send(
      WireEncoder.hostWatch(
        requestId: ids.requestId,
        commandId: ids.commandId,
        hostId: hostId,
        cursor: cursor,
      ),
    );
  }

  void _resetTranscriptPage() {
    _pagedTranscriptEntries = const <DurableEntry>[];
    _transcriptPageGeneration = null;
    _transcriptPageCursor = null;
    _transcriptPageLoading = false;
    _transcriptPageHasMore = false;
    _transcriptPageError = null;
    _transcriptRecoverySessionId = null;
  }

  bool get _transcriptPageSupported =>
      _grantedCapabilities.contains('sessions.read') &&
      _grantedFeatures.contains('transcript.page');

  void _primeTranscriptTailThenAttach(String sessionId) {
    if (_pendingCommands.values.any(
      (pending) =>
          pending.command == 'transcript.page' &&
          pending.sessionId == sessionId,
    )) {
      return;
    }
    if (!_transcriptPageSupported) {
      _sendAttach(sessionId);
      return;
    }
    final generation = _connectionGeneration;
    unawaited(
      _loadInitialTranscriptPage(sessionId).whenComplete(() {
        if (_disposed ||
            generation != _connectionGeneration ||
            sessionId != _selectedSessionId ||
            _channel == null) {
          return;
        }
        _sendAttach(sessionId);
      }),
    );
  }

  Future<void> _loadInitialTranscriptPage(String sessionId) async {
    try {
      final frame = await _runSessionReadCommand(
        prefix: 'transcript-page',
        command: 'transcript.page',
        sessionId: sessionId,
        args: const <String, Object?>{'limit': 64, 'maxBytes': 256 * 1024},
      );
      if (sessionId != _selectedSessionId) return;
      final page = frame.transcriptPageResult;
      if (page == null) {
        throw const WireFormatException(
          'transcript.page returned an invalid result',
          'result',
        );
      }
      _pagedTranscriptEntries = page.entries;
      _transcriptPageGeneration = page.generation;
      _transcriptPageCursor = page.nextCursor;
      _transcriptPageHasMore = page.hasMore && page.nextCursor != null;
      _transcriptPageError = null;
      _messages.clear();
      for (final entry in page.entries) {
        _upsertEntry(entry);
      }
      _publish();
    } on Object {
      // Bounded history is an optional read lane. Live attach remains the
      // authority and must proceed when paging is unavailable or stale.
    }
  }

  void _sendSessionStateGet(String sessionId) {
    final hostId = _hostId;
    if (hostId == null ||
        !_grantedCapabilities.contains('sessions.read') ||
        _pendingCommands.values.any(
          (pending) =>
              pending.command == 'session.state.get' &&
              pending.sessionId == sessionId,
        )) {
      return;
    }
    final ids = _nextCommandIds('session-state');
    _pendingCommands[ids.requestId] = _PendingCommand(
      commandId: ids.commandId,
      command: 'session.state.get',
      sessionId: sessionId,
    );
    _send(
      WireEncoder.command(
        requestId: ids.requestId,
        commandId: ids.commandId,
        hostId: hostId,
        sessionId: sessionId,
        command: 'session.state.get',
        args: const <String, Object?>{},
      ),
    );
  }

  void _sendAttach(String sessionId, {TranscriptCursor? cursor}) {
    final session = _sessions
        .where((item) => item.sessionId == sessionId)
        .firstOrNull;
    if (session == null ||
        _pendingCommands.values.any(
          (pending) =>
              pending.command == 'session.attach' &&
              pending.sessionId == sessionId,
        )) {
      return;
    }
    final ids = _nextCommandIds('attach');
    _pendingCommands[ids.requestId] = _PendingCommand(
      commandId: ids.commandId,
      command: 'session.attach',
      sessionId: sessionId,
    );
    _send(
      WireEncoder.sessionAttach(
        requestId: ids.requestId,
        commandId: ids.commandId,
        hostId: session.hostId,
        sessionId: session.sessionId,
        cursor: cursor,
      ),
    );
  }

  ({String requestId, String commandId}) _nextCommandIds(String prefix) {
    final ordinal = ++_commandOrdinal;
    return (
      requestId: '$prefix-$_commandNamespace-request-$ordinal',
      commandId: '$prefix-$_commandNamespace-command-$ordinal',
    );
  }

  void _send(String encoded) {
    final channel = _channel;
    if (channel == null) throw StateError('websocket is not connected');
    channel.sink.add(encoded);
  }

  void _clearTargetProjection() {
    _connectionGeneration += 1;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    unawaited(_subscription?.cancel());
    unawaited(_channel?.sink.close());
    _subscription = null;
    _channel = null;
    _sessions = const <SessionSummary>[];
    _messages.clear();
    _resetTranscriptPage();
    _savedCursors.clear();
    _attentionBySession.clear();
    _attentionConfirmations.clear();
    _agentActivities.clear();
    _activities.clear();
    _terminals.clear();
    _terminalCursors.clear();
    _previews.clear();
    _previewCaptures.clear();
    _reviews.clear();
    _fileWorkspace = const FileWorkspaceState();
    _activeTerminalId = null;
    _activePreviewId = null;
    _developerOperationPending = false;
    _cancelPendingCommands(StateError('active host changed'));
    _pendingPair = null;
    _selectedSessionId = null;
    _hostId = null;
    _submitting = false;
    _sessionOperationPending = false;
    _grantedCapabilities = const <String>{};
    _sessionIndexEpoch = null;
    _sessionIndexSeq = null;
    _grantedFeatures = const <String>{};
    _catalogItems = const <CatalogItem>[];
    _clearSettingsProjection();
    _bootstrapGeneration = -1;
    _reconnectAttempt = 0;
    _phase = ConnectionPhase.disconnected;
    _authenticationPhase = AuthenticationPhase.unknown;
  }

  void _handleTransportLoss(int generation, [Object? error]) {
    if (_disposed || generation != _connectionGeneration) return;
    _subscription = null;
    _channel = null;
    _cancelPendingCommands(StateError('connection lost'));
    _pendingPair = null;
    _submitting = false;
    _sessionOperationPending = false;
    if (!_reconnectEnabled) {
      _phase = ConnectionPhase.disconnected;
      _authenticationPhase = AuthenticationPhase.unknown;
      _errorMessage = null;
      _publish();
      return;
    }
    _reconnectAttempt += 1;
    final exponent = (_reconnectAttempt - 1).clamp(0, 4);
    final delay = Duration(milliseconds: 500 * (1 << exponent));
    _phase = ConnectionPhase.retrying;
    _authenticationPhase = AuthenticationPhase.unknown;
    _errorMessage = error == null
        ? 'Connection closed. Retrying…'
        : 'Connection lost: $error';
    _publish();
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(delay, () {
      if (!_disposed &&
          _reconnectEnabled &&
          generation == _connectionGeneration) {
        unawaited(_connectCurrent());
      }
    });
  }

  MessageRole _messageRole(Object? role) => switch (role) {
    'user' => MessageRole.user,
    'system' => MessageRole.system,
    'tool' => MessageRole.tool,
    _ => MessageRole.assistant,
  };

  void _cancelPendingCommands(Object error) {
    for (final pending in _pendingSessionOperations.values) {
      final completer = pending.completer;
      if (completer != null && !completer.isCompleted) {
        completer.completeError(error);
      }
    }
    for (final pending in _pendingCommands.values) {
      final completer = pending.completer;
      if (completer != null && !completer.isCompleted) {
        completer.completeError(error);
      }
    }
    _pendingSessionOperations.clear();
    _pendingCommands.clear();
  }

  void _fail(String message) {
    _cancelPendingCommands(StateError(message));
    _phase = ConnectionPhase.failed;
    _errorMessage = message;
    _submitting = false;
    _sessionOperationPending = false;
    _publish();
  }

  void _publish() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    final settingsRefresh = _settingsRefreshCompleter;
    _settingsRefreshCompleter = null;
    if (settingsRefresh != null && !settingsRefresh.isCompleted) {
      settingsRefresh.completeError(StateError('controller disposed'));
    }
    _disposed = true;
    _reconnectEnabled = false;
    _hostProbeOperation = null;
    final hostProbe = _hostProbe;
    _hostProbe = null;
    if (hostProbe != null) unawaited(hostProbe.sink.close());
    _connectionGeneration += 1;
    _hostOperationGeneration += 1;
    _reconnectTimer?.cancel();
    _settingsRefreshTimer?.cancel();
    _cancelPendingCommands(StateError('controller disposed'));
    unawaited(_subscription?.cancel());
    unawaited(_channel?.sink.close());
    super.dispose();
  }
}

const Set<String> _knownSettingItemKeys = <String>{
  'path',
  'label',
  'description',
  'controlType',
  'options',
  'min',
  'max',
  'step',
  'unit',
  'scopes',
  'restartRequired',
  'platform',
  'availability',
  'maxItems',
  'maxEntries',
  'default',
  'effective',
  'effectiveSource',
  'configured',
  'sensitive',
  'tab',
  'group',
};

final Set<String> _knownSettingValueKeys = _knownSettingItemKeys
    .where(
      (key) =>
          key != 'path' &&
          key != 'label' &&
          key != 'description' &&
          key != 'tab' &&
          key != 'group',
    )
    .toSet();

final RegExp _settingControlCharacters = RegExp(
  r'[\u0000-\u001f\u007f-\u009f]',
);

({List<HostSettingEntry> entries, List<String> issues}) _buildHostSettings(
  CatalogFrame catalog,
  SettingsFrame settings,
) {
  final issues = <String>[];
  final rows = <({HostSettingEntry entry, String group})>[];
  final seen = <String>{};
  for (final item in catalog.items.where((item) => item.kind == 'setting')) {
    final metadata = item.metadata;
    final fallbackPath = _safeSettingText(item.name, 128) ?? item.id;
    if (metadata == null) {
      issues.add('${item.id}: setting item carries no metadata');
      if (seen.add(fallbackPath)) {
        rows.add((
          entry: _unsupportedSetting(
            path: fallbackPath,
            section: 'advanced',
            label: _humanizeSettingPath(fallbackPath),
            help: '',
          ),
          group: '',
        ));
      }
      continue;
    }
    final path =
        _safeSettingText(metadata['path'], 128) ??
        _safeSettingText(item.name, 128);
    if (path == null || path.startsWith('/') || path.startsWith('~')) {
      issues.add('${item.id}: setting item has no usable path');
      continue;
    }
    if (!seen.add(path)) {
      issues.add('$path: duplicate setting path ignored');
      continue;
    }
    final section = _safeSettingText(metadata['tab'], 64) ?? 'advanced';
    final group = _safeSettingText(metadata['group'], 64) ?? '';
    final hostLabel = _safeSettingText(metadata['label'], 200);
    final label = hostLabel != null && hostLabel != path
        ? hostLabel
        : _humanizeSettingPath(path);
    final help = _safeSettingText(metadata['description'], 2000) ?? '';
    final unknown = metadata.keys
        .where((key) => !_knownSettingItemKeys.contains(key))
        .toList(growable: false);
    if (unknown.isNotEmpty) {
      issues.add('$path: unrecognized metadata (${unknown.join(', ')})');
      rows.add((
        entry: _unsupportedSetting(
          path: path,
          section: section,
          label: label,
          help: help,
        ),
        group: group,
      ));
      continue;
    }

    final rawValues = settings.settings[path];
    final values = rawValues is Map<String, Object?> ? rawValues : null;
    if (rawValues != null && values == null) {
      issues.add('$path: value metadata is not a record');
      rows.add((
        entry: _unsupportedSetting(
          path: path,
          section: section,
          label: label,
          help: help,
        ),
        group: group,
      ));
      continue;
    }
    final unknownValues = values?.keys
        .where((key) => !_knownSettingValueKeys.contains(key))
        .toList(growable: false);
    if (unknownValues != null && unknownValues.isNotEmpty) {
      issues.add(
        '$path: unrecognized value metadata (${unknownValues.join(', ')})',
      );
      rows.add((
        entry: _unsupportedSetting(
          path: path,
          section: section,
          label: label,
          help: help,
        ),
        group: group,
      ));
      continue;
    }

    final source = values ?? metadata;
    final sensitive =
        metadata['sensitive'] == true || values?['sensitive'] == true;
    final configured =
        metadata['configured'] == true || values?['configured'] == true;
    final restartRequired = metadata['restartRequired'] == true;
    final available = metadata['availability'] != false;
    if (sensitive) {
      final delivered =
          metadata.containsKey('default') ||
          metadata.containsKey('effective') ||
          (values?.containsKey('default') ?? false) ||
          (values?.containsKey('effective') ?? false);
      if (delivered) {
        issues.add('$path: sensitive setting arrived with a value');
      }
      rows.add((
        entry: HostSettingEntry(
          path: path,
          section: section,
          label: label,
          help: help,
          control: delivered
              ? HostSettingControlKind.unsupported
              : HostSettingControlKind.secret,
          configured: configured,
          options: const <HostSettingOption>[],
          writableScopes: const <String>[],
          restartRequired: restartRequired,
          available: available,
          sensitive: true,
        ),
        group: group,
      ));
      continue;
    }

    final combined = <String, Object?>{...metadata, ...?values};
    final controlProjection = _settingControl(combined);
    if (controlProjection.issue case final issue?) {
      issues.add('$path: $issue');
      rows.add((
        entry: _unsupportedSetting(
          path: path,
          section: section,
          label: label,
          help: help,
          configured: configured,
          restartRequired: restartRequired,
          available: available,
        ),
        group: group,
      ));
      continue;
    }
    if (source.containsKey('default') &&
        _copySafeSettingValue(source['default']) == null) {
      issues.add('$path: default value has a shape this app cannot edit');
      rows.add((
        entry: _unsupportedSetting(
          path: path,
          section: section,
          label: label,
          help: help,
          configured: configured,
          restartRequired: restartRequired,
          available: available,
        ),
        group: group,
      ));
      continue;
    }
    final hasEffective = source.containsKey('effective');
    final effective = hasEffective
        ? _copySafeSettingValue(source['effective'])
        : null;
    if (hasEffective && effective == null) {
      issues.add('$path: effective value has a shape this app cannot edit');
      rows.add((
        entry: _unsupportedSetting(
          path: path,
          section: section,
          label: label,
          help: help,
          configured: configured,
          restartRequired: restartRequired,
          available: available,
        ),
        group: group,
      ));
      continue;
    }
    final effectiveSource = source['effectiveSource'];
    if (effective != null &&
        (effectiveSource is! String ||
            !const <String>{
              'override',
              'configOverlay',
              'project',
              'global',
              'default',
            }.contains(effectiveSource))) {
      issues.add('$path: unrecognized effective source $effectiveSource');
      rows.add((
        entry: _unsupportedSetting(
          path: path,
          section: section,
          label: label,
          help: help,
          configured: configured,
          restartRequired: restartRequired,
          available: available,
        ),
        group: group,
      ));
      continue;
    }
    final scopeProjection = _settingScopes(metadata['scopes']);
    if (scopeProjection.issue case final issue?) {
      issues.add('$path: $issue');
      rows.add((
        entry: _unsupportedSetting(
          path: path,
          section: section,
          label: label,
          help: help,
          configured: configured,
          restartRequired: restartRequired,
          available: available,
        ),
        group: group,
      ));
      continue;
    }
    rows.add((
      entry: HostSettingEntry(
        path: path,
        section: section,
        label: label,
        help: help,
        control: controlProjection.kind,
        effectiveValue: effective,
        configured: configured,
        effectiveSource: effective == null ? null : effectiveSource as String,
        options: controlProjection.options,
        min: controlProjection.min,
        max: controlProjection.max,
        unit: controlProjection.unit,
        writableScopes: available ? scopeProjection.scopes : const <String>[],
        restartRequired: restartRequired,
        available: available,
        sensitive: false,
      ),
      group: group,
    ));
  }
  rows.sort((left, right) {
    final section = left.entry.section.compareTo(right.entry.section);
    if (section != 0) return section;
    final group = left.group.compareTo(right.group);
    if (group != 0) return group;
    return left.entry.path.compareTo(right.entry.path);
  });
  return (
    entries: List<HostSettingEntry>.unmodifiable(rows.map((row) => row.entry)),
    issues: List<String>.unmodifiable(issues),
  );
}

HostSettingEntry _unsupportedSetting({
  required String path,
  required String section,
  required String label,
  required String help,
  bool configured = false,
  bool restartRequired = false,
  bool available = true,
}) => HostSettingEntry(
  path: path,
  section: section,
  label: label,
  help: help,
  control: HostSettingControlKind.unsupported,
  configured: configured,
  options: const <HostSettingOption>[],
  writableScopes: const <String>[],
  restartRequired: restartRequired,
  available: available,
  sensitive: false,
);

({
  HostSettingControlKind kind,
  List<HostSettingOption> options,
  num? min,
  num? max,
  String? unit,
  String? issue,
})
_settingControl(Map<String, Object?> metadata) {
  final declared = metadata['controlType'];
  switch (declared) {
    case 'boolean':
      return (
        kind: HostSettingControlKind.boolean,
        options: const <HostSettingOption>[],
        min: null,
        max: null,
        unit: null,
        issue: null,
      );
    case 'number':
      final min = _finiteSettingNumber(metadata['min']);
      final max = _finiteSettingNumber(metadata['max']);
      if ((metadata['min'] != null && min == null) ||
          (metadata['max'] != null && max == null)) {
        return _unsupportedControl('number bounds are malformed');
      }
      return (
        kind: HostSettingControlKind.number,
        options: const <HostSettingOption>[],
        min: min,
        max: max,
        unit: _safeSettingText(metadata['unit'], 16),
        issue: null,
      );
    case 'string':
      return (
        kind: HostSettingControlKind.text,
        options: const <HostSettingOption>[],
        min: null,
        max: null,
        unit: null,
        issue: null,
      );
    case 'enum':
      final options = _settingOptions(metadata['options']);
      if (options == null) {
        return _unsupportedControl('enum options are malformed');
      }
      return (
        kind: HostSettingControlKind.enumeration,
        options: options,
        min: null,
        max: null,
        unit: null,
        issue: null,
      );
    case 'array':
      return (
        kind: HostSettingControlKind.list,
        options: const <HostSettingOption>[],
        min: null,
        max: null,
        unit: null,
        issue: null,
      );
    case 'record':
      return (
        kind: HostSettingControlKind.map,
        options: const <HostSettingOption>[],
        min: null,
        max: null,
        unit: null,
        issue: null,
      );
    default:
      return _unsupportedControl(
        declared == null
            ? 'setting control is missing'
            : 'unrecognized setting control $declared',
      );
  }
}

({
  HostSettingControlKind kind,
  List<HostSettingOption> options,
  num? min,
  num? max,
  String? unit,
  String? issue,
})
_unsupportedControl(String issue) => (
  kind: HostSettingControlKind.unsupported,
  options: const <HostSettingOption>[],
  min: null,
  max: null,
  unit: null,
  issue: issue,
);

List<HostSettingOption>? _settingOptions(Object? raw) {
  if (raw is! List<Object?> || raw.isEmpty) return null;
  final options = <HostSettingOption>[];
  for (final option in raw) {
    if (option is String) {
      final value = _safeSettingText(option, 200);
      if (value == null) return null;
      options.add(HostSettingOption(value: value, label: value));
      continue;
    }
    if (option is! Map<String, Object?>) return null;
    final rawValue = option['value'];
    final value =
        _safeSettingText(rawValue, 200) ??
        (rawValue is num && _finiteSettingNumber(rawValue) != null
            ? rawValue.toString()
            : null);
    if (value == null) return null;
    options.add(
      HostSettingOption(
        value: value,
        label: _safeSettingText(option['label'], 200) ?? value,
        help: _safeSettingText(option['description'], 2000),
      ),
    );
  }
  return List<HostSettingOption>.unmodifiable(options);
}

({List<String> scopes, String? issue}) _settingScopes(Object? raw) {
  if (raw == null) {
    return (scopes: const <String>['global'], issue: null);
  }
  if (raw is! List<Object?> || raw.any((scope) => scope is! String)) {
    return (scopes: const <String>[], issue: 'writable scopes are malformed');
  }
  final scopes = raw
      .cast<String>()
      .where((scope) => scope == 'global' || scope == 'session')
      .toSet()
      .toList(growable: false);
  return (
    scopes: scopes.isEmpty
        ? const <String>['global']
        : List<String>.unmodifiable(scopes),
    issue: null,
  );
}

String? _safeSettingText(Object? value, int maximumLength) {
  if (value is! String ||
      value.isEmpty ||
      value.length > maximumLength ||
      _settingControlCharacters.hasMatch(value)) {
    return null;
  }
  return value;
}

num? _finiteSettingNumber(Object? value) {
  if (value is int) return value;
  if (value is double && value.isFinite) return value;
  return null;
}

Object? _copySafeSettingValue(Object? value) {
  if (value is bool) return value;
  if (value is num) return _finiteSettingNumber(value);
  if (value is String) {
    if (value.isEmpty) return value;
    return _safeSettingText(value, 4096);
  }
  if (value is List<Object?>) {
    final result = <String>[];
    for (final item in value) {
      if (item is! String || _settingControlCharacters.hasMatch(item)) {
        return null;
      }
      result.add(item);
    }
    return List<String>.unmodifiable(result);
  }
  if (value is Map<String, Object?>) {
    final result = <String, String>{};
    for (final entry in value.entries) {
      if (entry.value is! String ||
          _settingControlCharacters.hasMatch(entry.key) ||
          _settingControlCharacters.hasMatch(entry.value! as String)) {
        return null;
      }
      result[entry.key] = entry.value! as String;
    }
    return Map<String, String>.unmodifiable(result);
  }
  return null;
}

Object? _copySettingValue(Object? value) => _copySafeSettingValue(value);

bool _settingValueMatches(HostSettingEntry entry, Object? value) {
  final safe = _copySafeSettingValue(value);
  if (safe == null) return false;
  return switch (entry.control) {
    HostSettingControlKind.boolean => safe is bool,
    HostSettingControlKind.number =>
      safe is num &&
          (entry.min == null || safe >= entry.min!) &&
          (entry.max == null || safe <= entry.max!),
    HostSettingControlKind.text => safe is String,
    HostSettingControlKind.enumeration =>
      safe is String && entry.options.any((option) => option.value == safe),
    HostSettingControlKind.list => safe is List<String>,
    HostSettingControlKind.map => safe is Map<String, String>,
    HostSettingControlKind.secret ||
    HostSettingControlKind.unsupported => false,
  };
}

String _humanizeSettingPath(String path) => path
    .split('.')
    .map(
      (segment) => segment
          .replaceAllMapped(
            RegExp(r'([a-z0-9])([A-Z])'),
            (match) => '${match[1]} ${match[2]}',
          )
          .split(RegExp(r'[-_\s]+'))
          .where((word) => word.isNotEmpty)
          .map(
            (word) =>
                '${word.substring(0, 1).toUpperCase()}${word.substring(1)}',
          )
          .join(' '),
    )
    .join(' · ');

final class _PendingCommand {
  _PendingCommand({
    required this.commandId,
    required this.command,
    this.sessionId,
    this.completer,
    this.expectedRevision,
    this.confirmationExpected = false,
  });

  final String commandId;
  final String command;
  final String? sessionId;
  final Completer<ResponseFrame>? completer;
  final String? expectedRevision;
  final bool confirmationExpected;
  bool confirmationSent = false;
}

final class _PendingPair {
  const _PendingPair({
    required this.requestId,
    required this.endpointKey,
    required this.deviceId,
    required this.deviceName,
    required this.platform,
    required this.requestedCapabilities,
  });

  final String requestId;
  final String endpointKey;
  final String deviceId;
  final String deviceName;
  final String platform;
  final List<String> requestedCapabilities;
}

final class _SessionAttention {
  const _SessionAttention({
    this.items = const <AttentionItem>[],
    this.omittedCount = 0,
    this.truncated = false,
    this.malformed = false,
  });

  final List<AttentionItem> items;
  final int omittedCount;
  final bool truncated;
  final bool malformed;
}
