part of 't4_app.dart';

const String _settingsReadCapability = 'config.read';
const String _settingsWriteCapability = 'config.write';
const String _diagnosticsKind = 't4-code.flutter-diagnostics';

enum _SettingsCategory {
  appearance('Appearance', Icons.palette_outlined),
  host('OMP settings', Icons.tune_outlined),
  app('App and runtime', Icons.system_update_alt_outlined),
  diagnostics('Diagnostics', Icons.monitor_heart_outlined);

  const _SettingsCategory(this.label, this.icon);

  final String label;
  final IconData icon;
}

/// Builds the allowlisted, redacted diagnostics payload used by the settings UI.
///
/// This deliberately does not serialize [T4ViewState]. Credentials, raw wire
/// frames, transcripts, terminal contents, and file contents therefore cannot
/// enter the export by accident as new state fields are added.
String buildT4DiagnosticsJson(
  T4ViewState state, {
  DateTime? generatedAt,
  PlatformLifecycleViewState? platformState,
}) {
  final capabilities = state.grantedCapabilities.toList()..sort();
  final features = state.grantedFeatures.toList()..sort();
  final settings = <Map<String, Object?>>[];
  for (final entry in state.settings.entries) {
    final redacted =
        entry.sensitive || entry.control == HostSettingControlKind.secret;
    final diagnostic = <String, Object?>{
      'path': entry.path,
      'section': entry.section,
      'control': entry.control.name,
      'configured': entry.configured,
      'effectiveSource': entry.effectiveSource,
      'restartRequired': entry.restartRequired,
      'available': entry.available,
      'redacted': redacted,
    };
    if (!redacted && _isSafeDiagnosticValue(entry.effectiveValue)) {
      diagnostic['effectiveValue'] = _copySafeDiagnosticValue(
        entry.effectiveValue,
      );
    }
    settings.add(diagnostic);
  }

  final payload = <String, Object?>{
    'kind': _diagnosticsKind,
    'schemaVersion': 1,
    'generatedAt': (generatedAt ?? DateTime.now().toUtc()).toIso8601String(),
    'connection': state.connectionPhase.name,
    'authentication': state.authenticationPhase.name,
    'hostLabel': state.hostDirectory.activeProfile?.label,
    'settingsRevision': state.settings.revision,
    'lifecycle': state.lifecyclePhase.name,
    'capabilityNames': capabilities,
    'featureNames': features,
    'protocolIssues': List<String>.of(state.settings.issues),
    'settings': settings,
    if (platformState != null)
      'platform': <String, Object?>{
        'runtime': <String, Object?>{
          'supported': platformState.runtime.supported,
          'available': platformState.runtime.available,
          'definition': platformState.runtime.definition.name,
          'service': platformState.runtime.service.name,
          'issueCode': platformState.runtime.issueCode,
        },
        'update': <String, Object?>{
          'supported': platformState.update.supported,
          'currentVersion': platformState.update.currentVersion,
          'phase': platformState.update.phase.name,
          'latestVersion': platformState.update.latestVersion,
          'checkedAt': platformState.update.checkedAt,
          'revision': platformState.update.revision,
          'error': platformState.update.error,
        },
      },
  };
  return const JsonEncoder.withIndent('  ').convert(payload);
}

bool _isSafeDiagnosticValue(Object? value) {
  if (value == null || value is bool || value is String) return true;
  if (value case final num number) return number.isFinite;
  if (value case final List<Object?> values) {
    return values.every(_isSafeDiagnosticValue);
  }
  if (value case final Map<Object?, Object?> values) {
    return values.entries.every(
      (entry) => entry.key is String && _isSafeDiagnosticValue(entry.value),
    );
  }
  return false;
}

Object? _copySafeDiagnosticValue(Object? value) {
  if (value case final List<Object?> values) {
    return values.map(_copySafeDiagnosticValue).toList(growable: false);
  }
  if (value case final Map<Object?, Object?> values) {
    return <String, Object?>{
      for (final entry in values.entries)
        entry.key as String: _copySafeDiagnosticValue(entry.value),
    };
  }
  return value;
}

final class _SettingsPane extends StatefulWidget {
  const _SettingsPane({
    required this.state,
    required this.actions,
    required this.showHeader,
    required this.platformState,
    required this.platformActions,
    required this.onDone,
  });

  final T4ViewState state;
  final T4Actions actions;
  final bool showHeader;
  final VoidCallback onDone;
  final PlatformLifecycleViewState platformState;
  final PlatformLifecycleActions? platformActions;

  @override
  State<_SettingsPane> createState() => _SettingsPaneState();
}

final class _SettingsPaneState extends State<_SettingsPane> {
  final Map<String, _StagedSetting> _staged = <String, _StagedSetting>{};
  final Map<String, String> _scopeByPath = <String, String>{};
  final Map<String, String> _validationErrors = <String, String>{};
  String? _baseRevision;
  String? _hostKey;
  int _draftGeneration = 0;
  bool _saving = false;
  bool _refreshing = false;
  bool _themePending = false;
  late T4ThemePreference _themeSelection;
  _SettingsCategory _activeCategory = _SettingsCategory.appearance;
  String? _activeHostGroup;

  @override
  void initState() {
    super.initState();
    _baseRevision = widget.state.settings.revision;
    _hostKey = widget.state.hostDirectory.activeProfile?.endpointKey;
    _themeSelection = widget.state.themePreference;
    if (_canReadHostSettings(widget.state)) unawaited(_refresh(silent: true));
  }

  @override
  void didUpdateWidget(covariant _SettingsPane oldWidget) {
    super.didUpdateWidget(oldWidget);
    final nextHostKey = widget.state.hostDirectory.activeProfile?.endpointKey;
    if (nextHostKey != _hostKey) {
      _hostKey = nextHostKey;
      _activeHostGroup = null;
      _discardDrafts();
      _baseRevision = widget.state.settings.revision;
    } else if (_staged.isEmpty && !_saving) {
      _baseRevision = widget.state.settings.revision;
    }
    if (!_themePending) _themeSelection = widget.state.themePreference;
  }

  bool get _hasConflict =>
      _staged.isNotEmpty &&
      _baseRevision != null &&
      widget.state.settings.revision != null &&
      _baseRevision != widget.state.settings.revision;

  bool get _operationPending =>
      _saving || widget.state.settingsOperationPending;

  Future<void> _refresh({bool silent = false}) async {
    if (_refreshing) return;
    setState(() => _refreshing = true);
    try {
      await widget.actions.refreshSettings();
    } on Object {
      if (!silent && mounted) {
        _showMessage('Could not refresh host settings. Try again.');
      }
    } finally {
      if (mounted) setState(() => _refreshing = false);
    }
  }

  Future<void> _setTheme(T4ThemePreference preference) async {
    if (_themePending || preference == _themeSelection) return;
    setState(() {
      _themeSelection = preference;
      _themePending = true;
    });
    try {
      await widget.actions.setThemePreference(preference);
    } on Object {
      if (!mounted) return;
      setState(() => _themeSelection = widget.state.themePreference);
      _showMessage('Could not update appearance. Try again.');
    } finally {
      if (mounted) setState(() => _themePending = false);
    }
  }

  void _stage(HostSettingEntry entry, {Object? value, bool reset = false}) {
    ScaffoldMessenger.of(context).hideCurrentSnackBar();
    final scope = _scopeByPath[entry.path] ?? entry.writableScopes.first;
    setState(() {
      _validationErrors.remove(entry.path);
      _staged[entry.path] = _StagedSetting(
        scope: scope,
        value: value,
        reset: reset,
      );
    });
  }

  void _setValidationError(String path, String? message) {
    setState(() {
      if (message == null) {
        _validationErrors.remove(path);
      } else {
        _validationErrors[path] = message;
        _staged.remove(path);
      }
    });
  }

  void _undo(String path) {
    setState(() {
      _staged.remove(path);
      _validationErrors.remove(path);
      _draftGeneration += 1;
    });
  }

  void _discardDrafts() {
    setState(() {
      _staged.clear();
      _validationErrors.clear();
      _scopeByPath.clear();
      _draftGeneration += 1;
      _baseRevision = widget.state.settings.revision;
    });
  }

  Future<void> _save() async {
    if (_operationPending || _staged.isEmpty || _hasConflict) return;
    if (_validationErrors.isNotEmpty) {
      _showMessage('Resolve invalid values before saving.');
      return;
    }
    final changes = List<MapEntry<String, _StagedSetting>>.of(_staged.entries);
    setState(() => _saving = true);
    try {
      for (final change in changes) {
        await widget.actions.writeSetting(
          change.key,
          change.value.scope,
          value: change.value.value,
          reset: change.value.reset,
        );
      }
      if (!mounted) return;
      setState(() {
        _staged.clear();
        _validationErrors.clear();
        _draftGeneration += 1;
        _baseRevision = widget.state.settings.revision;
      });
      _showMessage(
        'Saved. Host-scoped changes may still need approval in the inbox.',
      );
    } on Object {
      if (mounted) _showMessage('Could not save settings. No draft was lost.');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _exportDiagnostics() async {
    final contents = buildT4DiagnosticsJson(
      widget.state,
      platformState: widget.platformState,
    );
    final bytes = Uint8List.fromList(utf8.encode(contents));
    try {
      final location = await getSaveLocation(
        suggestedName: 't4-diagnostics.json',
        acceptedTypeGroups: const <XTypeGroup>[
          XTypeGroup(
            label: 'JSON',
            extensions: <String>['json'],
            mimeTypes: <String>['application/json'],
          ),
        ],
      );
      if (location == null) return;
      final file = XFile.fromData(
        bytes,
        mimeType: 'application/json',
        name: 't4-diagnostics.json',
      );
      await file.saveTo(location.path);
      if (mounted) _showMessage('Redacted diagnostics saved.');
      return;
    } on Object {
      // Save dialogs are not available on every Flutter target. The clipboard
      // fallback preserves the same allowlisted payload.
    }

    try {
      await Clipboard.setData(ClipboardData(text: contents));
      if (mounted) _showMessage('Redacted diagnostics copied to clipboard.');
    } on Object {
      if (mounted) _showMessage('Could not export diagnostics on this device.');
    }
  }

  Future<void> _runPlatformAction(
    Future<void> Function() operation,
    String failureMessage,
  ) async {
    try {
      await operation();
    } on Object {
      if (mounted) _showMessage(failureMessage);
    }
  }

  void _showMessage(String message) {
    final messenger = ScaffoldMessenger.of(context);
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final horizontal = widget.showHeader ? _T4Space.xl : _T4Space.md;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (widget.showHeader) _buildHeader(context),
        if (widget.state.settings.loading ||
            _refreshing ||
            widget.platformState.runtimeOperationPending ||
            widget.platformState.updateOperationPending)
          const LinearProgressIndicator(
            semanticsLabel: 'Loading settings and platform status',
          ),
        Expanded(child: _buildCategoryLayout(context, horizontal)),
        if (_staged.isNotEmpty || _validationErrors.isNotEmpty)
          _buildSaveBar(context),
      ],
    );
  }

  Widget _buildCategoryLayout(BuildContext context, double horizontal) {
    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth >= _T4Breakpoints.wide) {
          return Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SizedBox(
                width: 240,
                child: NavigationRail(
                  key: const Key('settings-category-rail'),
                  extended: true,
                  minExtendedWidth: 240,
                  groupAlignment: -1,
                  selectedIndex: _activeCategory.index,
                  onDestinationSelected: (index) {
                    setState(() {
                      _activeCategory = _SettingsCategory.values[index];
                    });
                  },
                  destinations: [
                    for (final category in _SettingsCategory.values)
                      NavigationRailDestination(
                        icon: Icon(category.icon),
                        label: Text(category.label),
                      ),
                  ],
                ),
              ),
              const VerticalDivider(width: 1),
              Expanded(
                child: _buildActiveCategory(context, horizontal: horizontal),
              ),
            ],
          );
        }
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: EdgeInsets.fromLTRB(
                horizontal,
                _T4Space.md,
                horizontal,
                0,
              ),
              child: DropdownButtonFormField<_SettingsCategory>(
                key: const Key('settings-category-picker'),
                initialValue: _activeCategory,
                decoration: const InputDecoration(labelText: 'Category'),
                isExpanded: true,
                items: [
                  for (final category in _SettingsCategory.values)
                    DropdownMenuItem(
                      value: category,
                      child: Row(
                        children: [
                          Icon(category.icon, size: 20),
                          const SizedBox(width: _T4Space.sm),
                          Text(category.label),
                        ],
                      ),
                    ),
                ],
                onChanged: (category) {
                  if (category == null || category == _activeCategory) return;
                  setState(() => _activeCategory = category);
                },
              ),
            ),
            Expanded(
              child: _buildActiveCategory(context, horizontal: horizontal),
            ),
          ],
        );
      },
    );
  }

  Widget _buildActiveCategory(
    BuildContext context, {
    required double horizontal,
  }) {
    final section = switch (_activeCategory) {
      _SettingsCategory.appearance => _buildAppearance(context),
      _SettingsCategory.host => _buildHostSettings(context),
      _SettingsCategory.app => _buildAppStatus(context),
      _SettingsCategory.diagnostics => _buildDiagnostics(context),
    };
    return ListView(
      key: PageStorageKey<String>(
        'settings-pane-${_activeCategory.name}-scroll',
      ),
      padding: EdgeInsets.fromLTRB(
        horizontal,
        _T4Space.lg,
        horizontal,
        _T4Space.xl,
      ),
      children: [
        Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              maxWidth: _T4Layout.contentMaxWidth,
            ),
            child: section,
          ),
        ),
      ],
    );
  }

  Widget _buildHeader(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        _T4Space.xl,
        _T4Space.lg,
        _T4Space.md,
        _T4Space.sm,
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              'Settings',
              style: Theme.of(context).textTheme.headlineSmall,
            ),
          ),
          IconButton(
            onPressed: widget.onDone,
            tooltip: 'Close settings',
            icon: const Icon(Icons.close),
          ),
        ],
      ),
    );
  }

  Widget _buildAppearance(BuildContext context) {
    return _SettingsSection(
      title: 'Appearance',
      description: 'Choose how T4 follows your device appearance.',
      child: Semantics(
        label: 'Theme preference',
        child: SegmentedButton<T4ThemePreference>(
          segments: const [
            ButtonSegment(
              value: T4ThemePreference.system,
              icon: Icon(Icons.brightness_auto_outlined),
              label: Text('System'),
            ),
            ButtonSegment(
              value: T4ThemePreference.light,
              icon: Icon(Icons.light_mode_outlined),
              label: Text('Light'),
            ),
            ButtonSegment(
              value: T4ThemePreference.dark,
              icon: Icon(Icons.dark_mode_outlined),
              label: Text('Dark'),
            ),
          ],
          selected: <T4ThemePreference>{_themeSelection},
          showSelectedIcon: false,
          onSelectionChanged: _themePending
              ? null
              : (selection) => unawaited(_setTheme(selection.single)),
        ),
      ),
    );
  }

  Widget _buildAppStatus(BuildContext context) {
    final platform = widget.platformState;
    final actions = widget.platformActions;
    final runtime = platform.runtime;
    final update = platform.update;
    final runtimeBusy = platform.runtimeOperationPending;
    final updateBusy = platform.updateOperationPending;
    final hasNativeSurface = runtime.supported || update.supported;

    return _SettingsSection(
      title: 'App and runtime',
      description:
          'Inspect app lifecycle, the desktop OMP service, and signed release updates.',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _DiagnosticLine(
            label: 'App lifecycle',
            value: widget.state.lifecyclePhase.name,
          ),
          if (platform.errorMessage case final error?)
            _SettingsNotice(
              icon: Icons.error_outline,
              title: 'Platform operation failed',
              message: error,
              error: true,
            ),
          if (!hasNativeSurface)
            const _SettingsNotice(
              icon: Icons.info_outline,
              title: 'Managed by this platform',
              message:
                  'Desktop runtime controls and direct update controls are not available on this target.',
            ),
          if (runtime.supported) ...[
            const Divider(),
            Text('OMP runtime', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: _T4Space.xs),
            _DiagnosticLine(
              label: 'Executable',
              value: runtime.available ? 'Compatible' : 'Not available',
            ),
            _DiagnosticLine(label: 'Service', value: runtime.service.name),
            _DiagnosticLine(
              label: 'Definition',
              value: runtime.definition.name,
            ),
            if (runtime.message case final message? when message.isNotEmpty)
              _SettingsNotice(
                icon: runtime.issueCode == null
                    ? Icons.info_outline
                    : Icons.warning_amber_outlined,
                title: runtime.issueCode == null
                    ? 'Runtime status'
                    : 'Runtime needs attention',
                message: message,
                error: runtime.issueCode != null,
              ),
            if (runtime.diagnostics.isNotEmpty)
              _SettingsNotice(
                icon: Icons.terminal_outlined,
                title: 'Runtime diagnostic',
                message: runtime.diagnostics,
              ),
            Wrap(
              spacing: _T4Space.xs,
              runSpacing: _T4Space.xs,
              children: [
                OutlinedButton.icon(
                  key: const Key('runtime-check'),
                  onPressed: actions == null || runtimeBusy
                      ? null
                      : () => unawaited(
                          _runPlatformAction(
                            actions.refreshPlatformState,
                            'Could not inspect the OMP runtime.',
                          ),
                        ),
                  icon: const Icon(Icons.refresh),
                  label: const Text('Check'),
                ),
                if (runtime.available &&
                    runtime.definition != RuntimeDefinitionState.current)
                  FilledButton.icon(
                    key: const Key('runtime-install'),
                    onPressed: actions == null || runtimeBusy
                        ? null
                        : () => unawaited(
                            _runPlatformAction(
                              actions.installRuntime,
                              'Could not install the OMP service.',
                            ),
                          ),
                    icon: const Icon(Icons.install_desktop_outlined),
                    label: const Text('Install service'),
                  ),
                if (runtime.available &&
                    runtime.definition == RuntimeDefinitionState.current &&
                    runtime.service != RuntimeServicePhase.running &&
                    runtime.service != RuntimeServicePhase.starting)
                  FilledButton.icon(
                    key: const Key('runtime-start'),
                    onPressed: actions == null || runtimeBusy
                        ? null
                        : () => unawaited(
                            _runPlatformAction(
                              actions.startRuntime,
                              'Could not start the OMP service.',
                            ),
                          ),
                    icon: const Icon(Icons.play_arrow),
                    label: const Text('Start'),
                  ),
                if (runtime.service == RuntimeServicePhase.running ||
                    runtime.service == RuntimeServicePhase.starting)
                  OutlinedButton.icon(
                    key: const Key('runtime-stop'),
                    onPressed: actions == null || runtimeBusy
                        ? null
                        : () => unawaited(
                            _runPlatformAction(
                              actions.stopRuntime,
                              'Could not stop the OMP service.',
                            ),
                          ),
                    icon: const Icon(Icons.stop),
                    label: const Text('Stop'),
                  ),
                if (runtime.service == RuntimeServicePhase.running)
                  OutlinedButton.icon(
                    key: const Key('runtime-restart'),
                    onPressed: actions == null || runtimeBusy
                        ? null
                        : () => unawaited(
                            _runPlatformAction(
                              actions.restartRuntime,
                              'Could not restart the OMP service.',
                            ),
                          ),
                    icon: const Icon(Icons.restart_alt),
                    label: const Text('Restart'),
                  ),
                if (runtime.definition != RuntimeDefinitionState.missing)
                  TextButton.icon(
                    key: const Key('runtime-uninstall'),
                    onPressed: actions == null || runtimeBusy
                        ? null
                        : () => unawaited(
                            _runPlatformAction(
                              actions.uninstallRuntime,
                              'Could not remove the OMP service.',
                            ),
                          ),
                    icon: const Icon(Icons.delete_outline),
                    label: const Text('Remove service'),
                  ),
              ],
            ),
          ],
          if (update.supported) ...[
            const Divider(),
            Text('App updates', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: _T4Space.xs),
            _DiagnosticLine(
              label: 'Current version',
              value: update.currentVersion,
            ),
            _DiagnosticLine(label: 'Status', value: update.phase.name),
            if (update.latestVersion case final version?)
              _DiagnosticLine(label: 'Latest version', value: version),
            if (update.progressPercent case final progress?)
              _DiagnosticLine(
                label: 'Download',
                value: '${progress.toStringAsFixed(0)}%',
              ),
            if (update.message case final message? when message.isNotEmpty)
              _SettingsNotice(
                icon: update.phase == PlatformUpdatePhase.error
                    ? Icons.error_outline
                    : Icons.info_outline,
                title: update.phase == PlatformUpdatePhase.error
                    ? 'Update failed'
                    : 'Update status',
                message: message,
                error: update.phase == PlatformUpdatePhase.error,
              ),
            Wrap(
              spacing: _T4Space.xs,
              runSpacing: _T4Space.xs,
              children: [
                OutlinedButton.icon(
                  key: const Key('update-check'),
                  onPressed: actions == null || updateBusy
                      ? null
                      : () => unawaited(
                          _runPlatformAction(
                            actions.checkForUpdates,
                            'Could not check for updates.',
                          ),
                        ),
                  icon: const Icon(Icons.system_update_alt),
                  label: const Text('Check for updates'),
                ),
                if (update.phase == PlatformUpdatePhase.available ||
                    update.phase == PlatformUpdatePhase.manual)
                  FilledButton.icon(
                    key: const Key('update-download'),
                    onPressed: actions == null || updateBusy
                        ? null
                        : () => unawaited(
                            _runPlatformAction(
                              actions.downloadUpdate,
                              'Could not download the update.',
                            ),
                          ),
                    icon: const Icon(Icons.download),
                    label: const Text('Download'),
                  ),
                if (update.phase == PlatformUpdatePhase.installer ||
                    update.phase == PlatformUpdatePhase.manual)
                  OutlinedButton.icon(
                    key: const Key('update-install'),
                    onPressed: actions == null || updateBusy
                        ? null
                        : () => unawaited(
                            _runPlatformAction(
                              actions.installUpdate,
                              'Could not open the update installer.',
                            ),
                          ),
                    icon: const Icon(Icons.install_mobile_outlined),
                    label: Text(
                      update.phase == PlatformUpdatePhase.manual
                          ? 'Installation help'
                          : 'Install',
                    ),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildHostSettings(BuildContext context) {
    final state = widget.state;
    final settings = state.settings;
    final hasReadPermission = state.grantedCapabilities.contains(
      _settingsReadCapability,
    );
    final canRead = _canReadHostSettings(state);
    final groups = <String, List<HostSettingEntry>>{};
    for (final entry in settings.entries) {
      final group = _hostSettingGroupLabel(entry);
      groups.putIfAbsent(group, () => <HostSettingEntry>[]).add(entry);
    }
    final selectedGroup = groups.containsKey(_activeHostGroup)
        ? _activeHostGroup
        : groups.isEmpty
        ? null
        : groups.keys.first;
    final selectedEntries = selectedGroup == null
        ? const <HostSettingEntry>[]
        : groups[selectedGroup]!;

    return _SettingsSection(
      title: 'OMP settings',
      description:
          'Changes are staged here. Save sends them to the host, where host-scoped changes may require inbox approval.',
      trailing: IconButton(
        onPressed: _refreshing || !_canReadHostSettings(state)
            ? null
            : () => unawaited(_refresh()),
        tooltip: 'Refresh settings',
        icon: const Icon(Icons.refresh),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_hasConflict)
            _SettingsNotice(
              icon: Icons.sync_problem_outlined,
              title: 'Settings changed on the host',
              message:
                  'Discard the staged changes and review the latest values before saving.',
              actionLabel: 'Discard draft',
              onAction: _discardDrafts,
            ),
          if (settings.error case final error?)
            _SettingsNotice(
              icon: Icons.error_outline,
              title: 'Could not load settings',
              message: error,
              actionLabel: canRead ? 'Retry' : null,
              onAction: canRead ? () => unawaited(_refresh()) : null,
              error: true,
            ),
          if (state.connectionPhase != ConnectionPhase.ready)
            const _SettingsNotice(
              icon: Icons.link_off,
              title: 'Host settings unavailable',
              message: 'Connect to a host to review and change its settings.',
            )
          else if (!hasReadPermission)
            const _SettingsNotice(
              icon: Icons.lock_outline,
              title: 'Permission denied',
              message: 'This device was not granted config.read on this host.',
              error: true,
            )
          else if (!canRead)
            const _SettingsNotice(
              icon: Icons.tune_outlined,
              title: 'Settings metadata unavailable',
              message:
                  'This host did not grant the catalog and settings metadata required for live controls.',
            )
          else if (settings.entries.isEmpty &&
              !settings.loading &&
              settings.error == null)
            const _SettingsNotice(
              icon: Icons.tune_outlined,
              title: 'No settings published',
              message: 'Refresh after the host publishes its settings catalog.',
            )
          else ...[
            DropdownButtonFormField<String>(
              key: const Key('host-settings-group-picker'),
              initialValue: selectedGroup,
              decoration: const InputDecoration(labelText: 'Setting group'),
              isExpanded: true,
              items: [
                for (final group in groups.entries)
                  DropdownMenuItem<String>(
                    value: group.key,
                    child: Text('${group.key} (${group.value.length})'),
                  ),
              ],
              onChanged: (group) {
                if (group == null || group == selectedGroup) return;
                setState(() => _activeHostGroup = group);
              },
            ),
            const SizedBox(height: _T4Space.sm),
            for (final entry in selectedEntries) ...[
              _buildSettingRow(context, entry),
              const Divider(),
            ],
          ],
        ],
      ),
    );
  }

  Widget _buildSettingRow(BuildContext context, HostSettingEntry entry) {
    final scheme = Theme.of(context).colorScheme;
    final metadataValid = _settingMetadataIsValid(entry);
    final writeGranted = widget.state.grantedCapabilities.contains(
      _settingsWriteCapability,
    );
    final sensitive =
        entry.sensitive || entry.control == HostSettingControlKind.secret;
    final canEdit =
        entry.available &&
        entry.writableScopes.isNotEmpty &&
        writeGranted &&
        metadataValid &&
        !sensitive &&
        entry.control != HostSettingControlKind.unsupported;
    final staged = _staged[entry.path];
    final error = _validationErrors[entry.path];

    final status = switch ((
      entry.available,
      metadataValid,
      writeGranted,
      entry.writableScopes.isNotEmpty,
      sensitive,
      entry.control,
    )) {
      (false, _, _, _, _, _) => 'Unavailable',
      (_, false, _, _, _, _) => 'Invalid metadata',
      (_, _, _, _, true, _) =>
        entry.configured ? 'Configured' : 'Not configured',
      (_, _, false, _, _, _) => 'Permission denied',
      (_, _, _, false, _, _) => 'Read only',
      (_, _, _, _, _, HostSettingControlKind.unsupported) => 'Unsupported',
      _ => null,
    };

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: _T4Space.sm),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      entry.label,
                      style: Theme.of(context).textTheme.titleSmall,
                    ),
                    if (entry.help.isNotEmpty) ...[
                      const SizedBox(height: _T4Space.xxs),
                      Text(
                        entry.help,
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: scheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: _T4Space.sm),
              Wrap(
                spacing: _T4Space.xs,
                runSpacing: _T4Space.xxs,
                alignment: WrapAlignment.end,
                children: [
                  if (entry.restartRequired)
                    const _SettingsStatus(
                      label: 'Restart required',
                      warning: true,
                    ),
                  if (status != null)
                    _SettingsStatus(
                      label: status,
                      error:
                          status == 'Permission denied' ||
                          status == 'Invalid metadata',
                    ),
                ],
              ),
            ],
          ),
          const SizedBox(height: _T4Space.sm),
          if (sensitive)
            Text(
              entry.configured
                  ? 'A value is configured. Its contents are hidden.'
                  : 'No value is configured.',
              style: Theme.of(context).textTheme.bodyMedium,
            )
          else ...[
            Text(
              _effectiveDescription(entry),
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(
                context,
              ).textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
            ),
            if (canEdit) ...[
              const SizedBox(height: _T4Space.sm),
              if (staged?.reset ?? false)
                _SettingsNotice(
                  icon: Icons.restore,
                  title: 'Reset staged',
                  message:
                      'Save to remove the configured value and use the inherited value.',
                  actionLabel: 'Undo',
                  onAction: () => _undo(entry.path),
                )
              else
                _buildControl(context, entry, staged),
              if (error != null) ...[
                const SizedBox(height: _T4Space.xs),
                Text(
                  error,
                  style: Theme.of(
                    context,
                  ).textTheme.bodySmall?.copyWith(color: scheme.error),
                ),
              ],
              const SizedBox(height: _T4Space.xs),
              Row(
                children: [
                  if (entry.writableScopes.length > 1)
                    Expanded(child: _buildScopeSelector(entry)),
                  if (entry.writableScopes.length > 1)
                    const SizedBox(width: _T4Space.sm),
                  if (entry.configured && !(staged?.reset ?? false))
                    TextButton.icon(
                      onPressed: _operationPending
                          ? null
                          : () => _stage(entry, reset: true),
                      icon: const Icon(Icons.restore),
                      label: const Text('Reset'),
                    ),
                  if (staged != null && !staged.reset)
                    TextButton(
                      onPressed: _operationPending
                          ? null
                          : () => _undo(entry.path),
                      child: const Text('Undo'),
                    ),
                ],
              ),
            ] else if (status != null) ...[
              const SizedBox(height: _T4Space.xs),
              Text(
                _disabledReason(status),
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
              ),
            ],
          ],
        ],
      ),
    );
  }

  Widget _buildControl(
    BuildContext context,
    HostSettingEntry entry,
    _StagedSetting? staged,
  ) {
    final current = staged?.value ?? entry.effectiveValue;
    final fieldKey = ValueKey<String>(
      'setting-${entry.path}-$_draftGeneration',
    );
    switch (entry.control) {
      case HostSettingControlKind.boolean:
        final enabled = current is bool && current;
        return Semantics(
          label: entry.label,
          child: Row(
            children: [
              Expanded(child: Text(enabled ? 'Enabled' : 'Disabled')),
              Switch(
                key: Key('setting-control-${entry.path}'),
                value: enabled,
                onChanged: _operationPending
                    ? null
                    : (value) => _stage(entry, value: value),
              ),
            ],
          ),
        );
      case HostSettingControlKind.number:
        return TextFormField(
          key: fieldKey,
          initialValue: current?.toString() ?? '',
          enabled: !_operationPending,
          keyboardType: const TextInputType.numberWithOptions(
            decimal: true,
            signed: true,
          ),
          decoration: InputDecoration(
            labelText: entry.unit == null
                ? entry.label
                : '${entry.label} (${entry.unit})',
          ),
          onChanged: (raw) {
            final value = num.tryParse(raw.trim());
            if (value == null) {
              _setValidationError(entry.path, 'Enter a valid number.');
            } else if (entry.min case final minimum? when value < minimum) {
              _setValidationError(entry.path, 'Enter ${entry.min} or greater.');
            } else if (entry.max case final maximum? when value > maximum) {
              _setValidationError(entry.path, 'Enter ${entry.max} or less.');
            } else {
              _stage(entry, value: value);
            }
          },
        );
      case HostSettingControlKind.text:
        return TextFormField(
          key: fieldKey,
          initialValue: current as String? ?? '',
          enabled: !_operationPending,
          decoration: InputDecoration(labelText: entry.label),
          onChanged: (value) => _stage(entry, value: value),
        );
      case HostSettingControlKind.enumeration:
        final selected =
            current is String &&
                entry.options.any((option) => option.value == current)
            ? current
            : null;
        return DropdownButtonFormField<String>(
          key: fieldKey,
          initialValue: selected,
          isExpanded: true,
          decoration: InputDecoration(labelText: entry.label),
          items: [
            for (final option in entry.options)
              DropdownMenuItem<String>(
                value: option.value,
                child: Text(option.label, overflow: TextOverflow.ellipsis),
              ),
          ],
          onChanged: _operationPending
              ? null
              : (value) {
                  if (value != null) _stage(entry, value: value);
                },
        );
      case HostSettingControlKind.list:
      case HostSettingControlKind.map:
        return TextFormField(
          key: fieldKey,
          initialValue: _jsonEditorValue(current, entry.control),
          enabled: !_operationPending,
          minLines: 2,
          maxLines: 6,
          keyboardType: TextInputType.multiline,
          decoration: InputDecoration(
            labelText: entry.control == HostSettingControlKind.list
                ? '${entry.label} (JSON list)'
                : '${entry.label} (JSON object)',
            alignLabelWithHint: true,
          ),
          onChanged: (raw) {
            try {
              final value = jsonDecode(raw);
              final valid = entry.control == HostSettingControlKind.list
                  ? value is List<Object?>
                  : value is Map<String, Object?>;
              if (!valid || !_isSafeDiagnosticValue(value)) {
                _setValidationError(
                  entry.path,
                  entry.control == HostSettingControlKind.list
                      ? 'Enter a valid JSON list.'
                      : 'Enter a valid JSON object.',
                );
                return;
              }
              _stage(entry, value: _copySafeDiagnosticValue(value));
            } on FormatException {
              _setValidationError(
                entry.path,
                entry.control == HostSettingControlKind.list
                    ? 'Enter a valid JSON list.'
                    : 'Enter a valid JSON object.',
              );
            }
          },
        );
      case HostSettingControlKind.secret:
      case HostSettingControlKind.unsupported:
        return const SizedBox.shrink();
    }
  }

  Widget _buildScopeSelector(HostSettingEntry entry) {
    final scope = _scopeByPath[entry.path] ?? entry.writableScopes.first;
    return DropdownButtonFormField<String>(
      initialValue: scope,
      isExpanded: true,
      decoration: const InputDecoration(labelText: 'Write scope'),
      items: [
        for (final candidate in entry.writableScopes)
          DropdownMenuItem(value: candidate, child: Text(candidate)),
      ],
      onChanged: _operationPending
          ? null
          : (value) {
              if (value == null) return;
              setState(() {
                _scopeByPath[entry.path] = value;
                final staged = _staged[entry.path];
                if (staged != null) {
                  _staged[entry.path] = staged.withScope(value);
                }
              });
            },
    );
  }

  Widget _buildDiagnostics(BuildContext context) {
    final state = widget.state;
    final profile = state.hostDirectory.activeProfile;
    final capabilities = state.grantedCapabilities.toList()..sort();
    final features = state.grantedFeatures.toList()..sort();
    return _SettingsSection(
      title: 'Diagnostics',
      description:
          'Safe connection metadata for troubleshooting. Exports are allowlisted and redact sensitive setting values.',
      trailing: OutlinedButton.icon(
        key: const Key('export-diagnostics'),
        onPressed: _exportDiagnostics,
        icon: const Icon(Icons.ios_share_outlined),
        label: const Text('Export'),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _DiagnosticLine(
            label: 'Connection',
            value: state.connectionPhase.label,
          ),
          _DiagnosticLine(
            label: 'Authentication',
            value: state.authenticationPhase.label,
          ),
          _DiagnosticLine(
            label: 'Host',
            value: profile?.label ?? 'Not configured',
          ),
          _DiagnosticLine(
            label: 'Settings revision',
            value: state.settings.revision ?? 'Not received',
          ),
          _DiagnosticLine(label: 'Lifecycle', value: state.lifecyclePhase.name),
          const SizedBox(height: _T4Space.md),
          Text('Capabilities', style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: _T4Space.xs),
          _NameWrap(names: capabilities, emptyLabel: 'None granted'),
          const SizedBox(height: _T4Space.md),
          Text(
            'Negotiated features',
            style: Theme.of(context).textTheme.titleSmall,
          ),
          const SizedBox(height: _T4Space.xs),
          _NameWrap(names: features, emptyLabel: 'None published'),
          const SizedBox(height: _T4Space.md),
          Text(
            'Protocol issues',
            style: Theme.of(context).textTheme.titleSmall,
          ),
          const SizedBox(height: _T4Space.xs),
          if (state.settings.issues.isEmpty)
            Text(
              'No protocol issues reported.',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            )
          else
            for (final issue in state.settings.issues)
              Padding(
                padding: const EdgeInsets.only(bottom: _T4Space.xs),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(Icons.warning_amber_outlined, size: _T4Space.lg),
                    const SizedBox(width: _T4Space.xs),
                    Expanded(child: Text(issue)),
                  ],
                ),
              ),
        ],
      ),
    );
  }

  Widget _buildSaveBar(BuildContext context) {
    final count = _staged.length;
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: scheme.surfaceContainer,
      child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Divider(),
            Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(
                  maxWidth: _T4Layout.contentMaxWidth,
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: _T4Space.md,
                    vertical: _T4Space.sm,
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          _hasConflict
                              ? 'Review the host conflict before saving.'
                              : _validationErrors.isNotEmpty
                              ? 'Resolve invalid values before saving.'
                              : '$count staged ${count == 1 ? 'change' : 'changes'}',
                          style: Theme.of(context).textTheme.bodyMedium,
                        ),
                      ),
                      TextButton(
                        onPressed: _operationPending ? null : _discardDrafts,
                        child: const Text('Discard'),
                      ),
                      const SizedBox(width: _T4Space.xs),
                      FilledButton.icon(
                        key: const Key('save-settings'),
                        onPressed:
                            _operationPending ||
                                _hasConflict ||
                                _validationErrors.isNotEmpty ||
                                count == 0
                            ? null
                            : () => unawaited(_save()),
                        icon: _operationPending
                            ? const SizedBox.square(
                                dimension: _T4Size.indicator,
                                child: CircularProgressIndicator(
                                  strokeWidth: _T4Size.thinStroke,
                                ),
                              )
                            : const Icon(Icons.save_outlined),
                        label: const Text('Save'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

final class _StagedSetting {
  const _StagedSetting({
    required this.scope,
    required this.value,
    required this.reset,
  });

  final String scope;
  final Object? value;
  final bool reset;

  _StagedSetting withScope(String scope) =>
      _StagedSetting(scope: scope, value: value, reset: reset);
}

final class _SettingsSection extends StatelessWidget {
  const _SettingsSection({
    required this.title,
    required this.description,
    required this.child,
    this.trailing,
  });

  final String title;
  final String description;
  final Widget child;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      container: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: Theme.of(context).textTheme.titleLarge),
                    const SizedBox(height: _T4Space.xxs),
                    Text(
                      description,
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: scheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              if (trailing case final widget?) ...[
                const SizedBox(width: _T4Space.sm),
                widget,
              ],
            ],
          ),
          const SizedBox(height: _T4Space.md),
          child,
        ],
      ),
    );
  }
}

final class _SettingsNotice extends StatelessWidget {
  const _SettingsNotice({
    required this.icon,
    required this.title,
    required this.message,
    this.actionLabel,
    this.onAction,
    this.error = false,
  });

  final IconData icon;
  final String title;
  final String message;
  final String? actionLabel;
  final VoidCallback? onAction;
  final bool error;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final background = error ? scheme.errorContainer : scheme.surfaceContainer;
    final foreground = error ? scheme.onErrorContainer : scheme.onSurface;
    return Padding(
      padding: const EdgeInsets.only(bottom: _T4Space.sm),
      child: Material(
        color: background,
        borderRadius: BorderRadius.circular(_T4Radius.sm),
        child: Padding(
          padding: const EdgeInsets.all(_T4Space.sm),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(icon, color: foreground),
              const SizedBox(width: _T4Space.sm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: Theme.of(
                        context,
                      ).textTheme.titleSmall?.copyWith(color: foreground),
                    ),
                    const SizedBox(height: _T4Space.xxs),
                    Text(
                      message,
                      style: Theme.of(
                        context,
                      ).textTheme.bodySmall?.copyWith(color: foreground),
                    ),
                  ],
                ),
              ),
              if (actionLabel != null && onAction != null) ...[
                const SizedBox(width: _T4Space.xs),
                TextButton(onPressed: onAction, child: Text(actionLabel!)),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

final class _SettingsStatus extends StatelessWidget {
  const _SettingsStatus({
    required this.label,
    this.warning = false,
    this.error = false,
  });

  final String label;
  final bool warning;
  final bool error;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final background = error
        ? scheme.errorContainer
        : warning
        ? scheme.tertiaryContainer
        : scheme.secondaryContainer;
    final foreground = error
        ? scheme.onErrorContainer
        : warning
        ? scheme.onTertiaryContainer
        : scheme.onSecondaryContainer;
    return Semantics(
      label: label,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: background,
          borderRadius: BorderRadius.circular(_T4Radius.sm),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: _T4Space.xs,
            vertical: _T4Space.xxs,
          ),
          child: Text(
            label,
            style: Theme.of(
              context,
            ).textTheme.labelSmall?.copyWith(color: foreground),
          ),
        ),
      ),
    );
  }
}

final class _DiagnosticLine extends StatelessWidget {
  const _DiagnosticLine({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: _T4Space.xs),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(child: Text(label)),
          const SizedBox(width: _T4Space.md),
          Expanded(
            child: Text(
              value,
              textAlign: TextAlign.end,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

final class _NameWrap extends StatelessWidget {
  const _NameWrap({required this.names, required this.emptyLabel});

  final List<String> names;
  final String emptyLabel;

  @override
  Widget build(BuildContext context) {
    if (names.isEmpty) {
      return Text(
        emptyLabel,
        style: Theme.of(context).textTheme.bodySmall?.copyWith(
          color: Theme.of(context).colorScheme.onSurfaceVariant,
        ),
      );
    }
    return Wrap(
      spacing: _T4Space.xs,
      runSpacing: _T4Space.xs,
      children: [for (final name in names) Chip(label: Text(name))],
    );
  }
}

bool _canReadHostSettings(T4ViewState state) =>
    state.connectionPhase == ConnectionPhase.ready &&
    state.grantedCapabilities.contains('catalog.read') &&
    state.grantedFeatures.contains('catalog.metadata') &&
    state.grantedCapabilities.contains(_settingsReadCapability) &&
    state.grantedFeatures.contains('settings.metadata');
String _hostSettingGroupLabel(HostSettingEntry entry) {
  final separator = entry.label.indexOf(' · ');
  if (separator > 0) return entry.label.substring(0, separator);
  final section = entry.section.trim();
  if (section.isEmpty) return 'General';
  return '${section[0].toUpperCase()}${section.substring(1)}';
}

bool _settingMetadataIsValid(HostSettingEntry entry) {
  if (entry.path.trim().isEmpty ||
      entry.section.trim().isEmpty ||
      entry.label.trim().isEmpty) {
    return false;
  }
  if (entry.min != null && !entry.min!.isFinite) return false;
  if (entry.max != null && !entry.max!.isFinite) return false;
  if (entry.min != null && entry.max != null && entry.min! > entry.max!) {
    return false;
  }
  final value = entry.effectiveValue;
  return switch (entry.control) {
    HostSettingControlKind.boolean => value == null || value is bool,
    HostSettingControlKind.number =>
      value == null ||
          value is num &&
              value.isFinite &&
              (entry.min == null || value >= entry.min!) &&
              (entry.max == null || value <= entry.max!),
    HostSettingControlKind.text => value == null || value is String,
    HostSettingControlKind.enumeration =>
      entry.options.isNotEmpty &&
          entry.options.every((option) => option.value.isNotEmpty) &&
          entry.options.map((option) => option.value).toSet().length ==
              entry.options.length &&
          (value == null ||
              value is String &&
                  entry.options.any((option) => option.value == value)),
    HostSettingControlKind.list =>
      (value == null || value is List<Object?>) &&
          _isSafeDiagnosticValue(value),
    HostSettingControlKind.map =>
      (value == null || value is Map<String, Object?>) &&
          _isSafeDiagnosticValue(value),
    HostSettingControlKind.secret => true,
    HostSettingControlKind.unsupported => false,
  };
}

String _effectiveDescription(HostSettingEntry entry) {
  final value = entry.effectiveValue;
  final formatted = value == null
      ? 'Not set'
      : value is String
      ? value
      : const JsonEncoder.withIndent('  ').convert(value);
  final source = entry.effectiveSource;
  return source == null
      ? 'Effective: $formatted'
      : 'Effective: $formatted · Source: $source';
}

String _jsonEditorValue(Object? value, HostSettingControlKind control) {
  if (value != null) return const JsonEncoder.withIndent('  ').convert(value);
  return control == HostSettingControlKind.list ? '[]' : '{}';
}

String _disabledReason(String status) => switch (status) {
  'Unavailable' => 'This setting is unavailable on the connected host.',
  'Invalid metadata' =>
    'The host published metadata that cannot be edited safely.',
  'Permission denied' =>
    'This device was not granted settings.write on this host.',
  'Read only' => 'The host did not publish a writable scope for this setting.',
  'Unsupported' => 'This version of T4 cannot edit the published control type.',
  _ => '',
};
