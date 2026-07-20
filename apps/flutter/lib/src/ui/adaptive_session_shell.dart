part of 't4_app.dart';

final class _AdaptiveSessionShell extends StatefulWidget {
  const _AdaptiveSessionShell({
    required this.state,
    required this.actions,
    required this.platformState,
    required this.platformActions,
  });

  final T4ViewState state;
  final T4Actions actions;
  final PlatformLifecycleViewState platformState;
  final PlatformLifecycleActions? platformActions;

  @override
  State<_AdaptiveSessionShell> createState() => _AdaptiveSessionShellState();
}

final class _AdaptiveSessionShellState extends State<_AdaptiveSessionShell> {
  final GlobalKey<ScaffoldState> _scaffoldKey = GlobalKey<ScaffoldState>();
  String? _selectingSessionId;
  bool _connecting = false;
  bool _disconnecting = false;
  bool _showHostManager = false;
  bool _showAttention = false;
  bool _showDeveloper = false;
  bool _showSettings = false;
  bool _showSearch = false;
  bool _showUsage = false;

  Future<void> _connect() async {
    if (_connecting) return;
    setState(() => _connecting = true);
    try {
      await widget.actions.connect();
    } on Object {
      if (!mounted) return;
      _showActionFailure('Could not connect. Try again.');
    } finally {
      if (mounted) setState(() => _connecting = false);
    }
  }

  Future<void> _disconnect() async {
    if (_disconnecting) return;
    setState(() => _disconnecting = true);
    try {
      await widget.actions.disconnect();
    } on Object {
      if (!mounted) return;
      _showActionFailure('Could not disconnect. Try again.');
    } finally {
      if (mounted) setState(() => _disconnecting = false);
    }
  }

  Future<void> _runConnectionAction() =>
      widget.state.connectionPhase.canDisconnect ? _disconnect() : _connect();

  Future<void> _selectSession(
    String sessionId, {
    required bool closeDrawer,
  }) async {
    if (_selectingSessionId != null) return;
    if (sessionId == widget.state.selectedSessionId) {
      setState(() {
        _showHostManager = false;
        _showAttention = false;
        _showDeveloper = false;
        _showSettings = false;
        _showSearch = false;
        _showUsage = false;
      });
      if (closeDrawer) _scaffoldKey.currentState?.closeDrawer();
      return;
    }

    setState(() {
      _showHostManager = false;
      _showAttention = false;
      _showDeveloper = false;
      _showSettings = false;
      _showSearch = false;
      _showUsage = false;
      _selectingSessionId = sessionId;
    });
    try {
      await widget.actions.selectSession(sessionId);
      if (!mounted) return;
      if (closeDrawer) _scaffoldKey.currentState?.closeDrawer();
    } on Object {
      if (!mounted) return;
      _showActionFailure('Could not open that session. Try again.');
    } finally {
      if (mounted) setState(() => _selectingSessionId = null);
    }
  }

  void _showActionFailure(String message) {
    final messenger = ScaffoldMessenger.of(context);
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  void _openNavigation() => _scaffoldKey.currentState?.openDrawer();

  void _openHostManager({required bool closeDrawer}) {
    setState(() {
      _showHostManager = true;
      _showAttention = false;
      _showDeveloper = false;
      _showSettings = false;
      _showSearch = false;
      _showUsage = false;
    });
    if (closeDrawer) _scaffoldKey.currentState?.closeDrawer();
  }

  void _closeHostManager() => setState(() => _showHostManager = false);

  void _openAttention() => setState(() {
    _showHostManager = false;
    _showDeveloper = false;
    _showSettings = false;
    _showSearch = false;
    _showUsage = false;
    _showAttention = true;
  });

  void _closeAttention() => setState(() => _showAttention = false);

  void _openDeveloper() => setState(() {
    _showHostManager = false;
    _showAttention = false;
    _showDeveloper = true;
    _showSettings = false;
    _showSearch = false;
    _showUsage = false;
  });

  void _closeDeveloper() => setState(() => _showDeveloper = false);

  void _openSettings({required bool closeDrawer}) {
    setState(() {
      _showHostManager = false;
      _showAttention = false;
      _showDeveloper = false;
      _showSettings = true;
      _showSearch = false;
      _showUsage = false;
    });
    if (closeDrawer) _scaffoldKey.currentState?.closeDrawer();
  }

  void _closeSettings() => setState(() => _showSettings = false);

  void _openSearch({required bool closeDrawer}) {
    setState(() {
      _showHostManager = false;
      _showAttention = false;
      _showDeveloper = false;
      _showSettings = false;
      _showUsage = false;
      _showSearch = true;
    });
    if (closeDrawer) _scaffoldKey.currentState?.closeDrawer();
  }

  void _closeSearch() => setState(() => _showSearch = false);

  void _openUsage({required bool closeDrawer}) {
    setState(() {
      _showHostManager = false;
      _showAttention = false;
      _showDeveloper = false;
      _showSettings = false;
      _showSearch = false;
      _showUsage = true;
    });
    if (closeDrawer) _scaffoldKey.currentState?.closeDrawer();
  }

  void _closeUsage() => setState(() => _showUsage = false);

  Widget _surfaceNavigationEntries({
    required bool closeDrawer,
    required bool rail,
  }) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: rail ? scheme.surfaceContainerLowest : scheme.surface,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            _T4Space.xs,
            _T4Space.xxs,
            _T4Space.xs,
            _T4Space.sm,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Semantics(
                button: true,
                selected: _showSearch,
                label: 'Search transcripts',
                child: ListTile(
                  selected: _showSearch,
                  selectedTileColor: scheme.secondaryContainer,
                  leading: const Icon(Icons.manage_search),
                  title: const Text('Search'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => _openSearch(closeDrawer: closeDrawer),
                ),
              ),
              Semantics(
                button: true,
                selected: _showUsage,
                label: 'Open usage and accounts',
                child: ListTile(
                  selected: _showUsage,
                  selectedTileColor: scheme.secondaryContainer,
                  leading: const Icon(Icons.data_usage_outlined),
                  title: const Text('Usage'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => _openUsage(closeDrawer: closeDrawer),
                ),
              ),
              Semantics(
                button: true,
                selected: _showSettings,
                label: 'Open settings',
                child: ListTile(
                  selected: _showSettings,
                  selectedTileColor: scheme.secondaryContainer,
                  leading: const Icon(Icons.settings_outlined),
                  title: const Text('Settings'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => _openSettings(closeDrawer: closeDrawer),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _primaryContent({required bool showHeader}) {
    if (_showSearch) {
      return _TranscriptSearchPane(
        actions: widget.actions,
        showHeader: showHeader,
        onDone: _closeSearch,
        onOpenSession: (sessionId) async {
          await _selectSession(sessionId, closeDrawer: false);
          if (mounted) _closeSearch();
        },
      );
    }
    if (_showUsage) {
      return _UsageStatusPane(
        state: widget.state,
        actions: widget.actions,
        showHeader: showHeader,
        onDone: _closeUsage,
      );
    }
    if (_showSettings) {
      return _SettingsPane(
        state: widget.state,
        actions: widget.actions,
        platformState: widget.platformState,
        platformActions: widget.platformActions,
        showHeader: showHeader,
        onDone: _closeSettings,
      );
    }
    if (_showAttention) {
      return _AttentionPane(
        state: widget.state,
        actions: widget.actions,
        onDone: _closeAttention,
        onOpenSession: (sessionId) async {
          await _selectSession(sessionId, closeDrawer: false);
          if (mounted) _closeAttention();
        },
      );
    }
    if (_showHostManager) {
      return _HostManagerPane(
        state: widget.state,
        actions: widget.actions,
        onDone: _closeHostManager,
      );
    }

    if (widget.state.authenticationPhase ==
            AuthenticationPhase.pairingRequired ||
        widget.state.authenticationPhase == AuthenticationPhase.pairing) {
      return _PairingPane(state: widget.state, actions: widget.actions);
    }

    if (_showDeveloper) {
      return _DeveloperSurfacesPane(
        state: widget.state,
        actions: widget.actions,
        showHeader: showHeader,
        onDone: _closeDeveloper,
      );
    }

    return _ConversationPane(
      state: widget.state,
      actions: widget.actions,
      showHeader: showHeader,
      onConnect: _connect,
      onOpenSessions: showHeader ? null : _openNavigation,
      onOpenAttention: _openAttention,
      onOpenDeveloper: _openDeveloper,
    );
  }

  @override
  Widget build(BuildContext context) {
    final needsOnboarding =
        !widget.state.targetConfigured &&
        widget.state.hostDirectory.profiles.isEmpty &&
        widget.state.connectionPhase == ConnectionPhase.disconnected;
    if (needsOnboarding) {
      return _HostOnboardingPage(state: widget.state, actions: widget.actions);
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth >= _T4Breakpoints.wide) {
          return _buildWide(context);
        }
        return _buildCompact(context);
      },
    );
  }

  Widget _buildWide(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Row(
          children: [
            SizedBox(
              width: _T4Layout.sessionRailWidth,
              child: Column(
                children: [
                  Expanded(
                    child: _SessionNavigation(
                      state: widget.state,
                      actions: widget.actions,
                      mode: _SessionNavigationMode.rail,
                      connecting: _connecting,
                      disconnecting: _disconnecting,
                      selectingSessionId: _selectingSessionId,
                      showingHostManager: _showHostManager,
                      onConnect: _connect,
                      onDisconnect: _disconnect,
                      onManageHosts: () => _openHostManager(closeDrawer: false),
                      onSelectSession: (sessionId) =>
                          _selectSession(sessionId, closeDrawer: false),
                    ),
                  ),
                  _surfaceNavigationEntries(closeDrawer: false, rail: true),
                ],
              ),
            ),
            const VerticalDivider(width: _T4Size.divider),
            Expanded(child: _primaryContent(showHeader: true)),
          ],
        ),
      ),
    );
  }

  Widget _buildCompact(BuildContext context) {
    final phase = widget.state.connectionPhase;
    final actionLabel = phase.actionLabel;

    return Scaffold(
      key: _scaffoldKey,
      appBar: AppBar(
        toolbarHeight: _T4Layout.compactToolbarHeight,
        leading: IconButton(
          onPressed: _openNavigation,
          tooltip: 'Open navigation',
          icon: const Icon(Icons.menu),
        ),
        titleSpacing: 0,
        title: _showSearch
            ? Text('Search', style: Theme.of(context).textTheme.titleMedium)
            : _showUsage
            ? Text('Usage', style: Theme.of(context).textTheme.titleMedium)
            : _showSettings
            ? Text('Settings', style: Theme.of(context).textTheme.titleMedium)
            : _showHostManager
            ? Text('Hosts', style: Theme.of(context).textTheme.titleMedium)
            : _showDeveloper
            ? Text(
                'Developer tools',
                style: Theme.of(context).textTheme.titleMedium,
              )
            : Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    _displaySessionTitle(widget.state.selectedSession),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: _T4Space.xxs),
                  _CompactConnectionLabel(
                    phase: phase,
                    actionPending: _connecting,
                  ),
                ],
              ),
        actions: [
          if (_showSearch || _showUsage || _showSettings)
            IconButton(
              onPressed: _showSearch
                  ? _closeSearch
                  : _showUsage
                  ? _closeUsage
                  : _closeSettings,
              tooltip: _showSearch
                  ? 'Close search'
                  : _showUsage
                  ? 'Close usage'
                  : 'Close settings',
              icon: const Icon(Icons.close),
            )
          else ...[
            if (!_showHostManager &&
                !_showAttention &&
                !_showDeveloper &&
                !_showSearch &&
                !_showUsage)
              Badge(
                isLabelVisible: widget.state.urgentAttentionCount > 0,
                label: Text('${widget.state.urgentAttentionCount}'),
                child: IconButton(
                  onPressed: _openAttention,
                  tooltip: 'Open inbox',
                  icon: const Icon(Icons.inbox_outlined),
                ),
              ),
            if (!_showHostManager &&
                !_showAttention &&
                !_showSearch &&
                !_showUsage)
              IconButton(
                onPressed: _showDeveloper ? _closeDeveloper : _openDeveloper,
                tooltip: _showDeveloper
                    ? 'Close developer tools'
                    : 'Open developer tools',
                icon: Icon(_showDeveloper ? Icons.close : Icons.code),
              ),
            if (!_showHostManager && !_showSearch && !_showUsage)
              IconButton(
                onPressed: _connecting || _disconnecting
                    ? null
                    : () => unawaited(_runConnectionAction()),
                tooltip: actionLabel,
                icon: Icon(
                  phase.canDisconnect
                      ? Icons.link_off
                      : phase == ConnectionPhase.failed
                      ? Icons.refresh
                      : Icons.power_settings_new,
                ),
              ),
          ],
        ],
      ),
      drawerEnableOpenDragGesture: true,
      drawerEdgeDragWidth: _T4Layout.minimumTouchTarget,
      drawer: Drawer(
        child: Column(
          children: [
            Expanded(
              child: _SessionNavigation(
                state: widget.state,
                actions: widget.actions,
                mode: _SessionNavigationMode.drawer,
                connecting: _connecting,
                selectingSessionId: _selectingSessionId,
                disconnecting: _disconnecting,
                showingHostManager: _showHostManager,
                onConnect: _connect,
                onDisconnect: _disconnect,
                onManageHosts: () => _openHostManager(closeDrawer: true),
                onSelectSession: (sessionId) =>
                    _selectSession(sessionId, closeDrawer: true),
                onClose: () => _scaffoldKey.currentState?.closeDrawer(),
              ),
            ),
            _surfaceNavigationEntries(closeDrawer: true, rail: false),
          ],
        ),
      ),
      body: _primaryContent(showHeader: false),
    );
  }
}

final class _CompactConnectionLabel extends StatelessWidget {
  const _CompactConnectionLabel({
    required this.phase,
    required this.actionPending,
  });

  final ConnectionPhase phase;
  final bool actionPending;

  @override
  Widget build(BuildContext context) {
    final active = phase.isActive || actionPending;
    final scheme = Theme.of(context).colorScheme;

    return Semantics(
      label: 'Connection status: ${phase.label}',
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox.square(
            dimension: _T4Space.sm,
            child: active
                ? CircularProgressIndicator(
                    strokeWidth: _T4Size.thinStroke,
                    color: scheme.primary,
                    semanticsLabel: phase.label,
                  )
                : Icon(
                    Icons.circle,
                    size: _T4Space.xs,
                    color: phase == ConnectionPhase.ready
                        ? scheme.primary
                        : scheme.outline,
                  ),
          ),
          const SizedBox(width: _T4Space.xs),
          Text(
            phase.label,
            style: Theme.of(
              context,
            ).textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}
