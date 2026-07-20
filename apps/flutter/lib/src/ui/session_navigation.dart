part of 't4_app.dart';

enum _SessionNavigationMode { rail, drawer }

enum _SessionListView { current, archived }

extension on ConnectionPhase {
  String get label => switch (this) {
    ConnectionPhase.disconnected => 'Disconnected',
    ConnectionPhase.connecting => 'Connecting',
    ConnectionPhase.synchronizing => 'Synchronizing',
    ConnectionPhase.ready => 'Ready',
    ConnectionPhase.retrying => 'Retrying',
    ConnectionPhase.failed => 'Connection failed',
  };

  bool get isActive => switch (this) {
    ConnectionPhase.connecting ||
    ConnectionPhase.synchronizing ||
    ConnectionPhase.retrying => true,
    ConnectionPhase.disconnected ||
    ConnectionPhase.ready ||
    ConnectionPhase.failed => false,
  };

  bool get canDisconnect => switch (this) {
    ConnectionPhase.disconnected || ConnectionPhase.failed => false,
    ConnectionPhase.connecting ||
    ConnectionPhase.synchronizing ||
    ConnectionPhase.ready ||
    ConnectionPhase.retrying => true,
  };

  String get actionLabel => canDisconnect
      ? 'Disconnect'
      : switch (this) {
          ConnectionPhase.disconnected => 'Connect',
          ConnectionPhase.failed => 'Retry',
          ConnectionPhase.connecting ||
          ConnectionPhase.synchronizing ||
          ConnectionPhase.ready ||
          ConnectionPhase.retrying => throw StateError(
            'disconnectable phase has no connection action',
          ),
        };
}

String _displaySessionTitle(SessionSummary? session) {
  final title = session?.title.trim();
  return title == null || title.isEmpty ? 'No session selected' : title;
}

final class _SessionNavigation extends StatefulWidget {
  const _SessionNavigation({
    required this.state,
    required this.actions,
    required this.mode,
    required this.connecting,
    required this.selectingSessionId,
    required this.disconnecting,
    required this.showingHostManager,
    required this.onConnect,
    required this.onDisconnect,
    required this.onManageHosts,
    required this.onSelectSession,
    this.onClose,
  });

  final T4ViewState state;
  final T4Actions actions;
  final _SessionNavigationMode mode;
  final bool disconnecting;
  final bool connecting;
  final String? selectingSessionId;
  final bool showingHostManager;
  final Future<void> Function() onDisconnect;
  final Future<void> Function() onConnect;
  final VoidCallback onManageHosts;
  final Future<void> Function(String sessionId) onSelectSession;
  final VoidCallback? onClose;

  @override
  State<_SessionNavigation> createState() => _SessionNavigationState();
}

final class _SessionNavigationState extends State<_SessionNavigation> {
  final TextEditingController _searchController = TextEditingController();
  _SessionListView _view = _SessionListView.current;

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  Future<void> _createSession() async {
    final projects = <String, String>{};
    for (final session in widget.state.sessions) {
      projects.putIfAbsent(session.projectId, () => session.projectName);
    }
    if (projects.isEmpty) return;
    final created = await showDialog<bool>(
      context: context,
      builder: (context) =>
          _CreateSessionDialog(actions: widget.actions, projects: projects),
    );
    if (created == true && widget.mode == _SessionNavigationMode.drawer) {
      widget.onClose?.call();
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final activeProfile = widget.state.hostDirectory.activeProfile;
    final query = _searchController.text.trim().toLowerCase();
    final visible = widget.state.sessions
        .where((session) {
          if (session.archived != (_view == _SessionListView.archived)) {
            return false;
          }
          if (query.isEmpty) return true;
          return session.title.toLowerCase().contains(query) ||
              session.projectName.toLowerCase().contains(query);
        })
        .toList(growable: false);
    final groups = <String, List<SessionSummary>>{};
    for (final session in visible) {
      groups
          .putIfAbsent(session.projectId, () => <SessionSummary>[])
          .add(session);
    }
    final canCreate =
        widget.state.connectionPhase == ConnectionPhase.ready &&
        widget.state.grantedCapabilities.contains('sessions.manage') &&
        !widget.state.sessionOperationPending &&
        widget.state.sessions.isNotEmpty;

    return Material(
      color: widget.mode == _SessionNavigationMode.rail
          ? scheme.surfaceContainerLowest
          : scheme.surface,
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(
                _T4Space.md,
                _T4Space.sm,
                _T4Space.xs,
                _T4Space.xs,
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      widget.mode == _SessionNavigationMode.rail
                          ? 'T4'
                          : 'Navigation',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                  ),
                  if (widget.onClose case final close?)
                    IconButton(
                      onPressed: close,
                      tooltip: 'Close navigation',
                      icon: const Icon(Icons.close),
                    ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: _T4Space.md),
              child: _ConnectionStatus(
                phase: widget.state.connectionPhase,
                actionPending: widget.connecting || widget.disconnecting,
                onConnect: widget.onConnect,
                onDisconnect: widget.onDisconnect,
              ),
            ),
            if (activeProfile != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  _T4Space.md,
                  _T4Space.xs,
                  _T4Space.md,
                  _T4Space.sm,
                ),
                child: Text(
                  activeProfile.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: scheme.onSurfaceVariant,
                  ),
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(
                _T4Space.xs,
                _T4Space.sm,
                _T4Space.xs,
                0,
              ),
              child: Semantics(
                button: true,
                selected: widget.showingHostManager,
                label: 'Manage hosts',
                child: ListTile(
                  selected: widget.showingHostManager,
                  selectedTileColor: scheme.secondaryContainer,
                  leading: const Icon(Icons.dns_outlined),
                  title: const Text('Manage hosts'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: widget.onManageHosts,
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(
                _T4Space.md,
                _T4Space.md,
                _T4Space.xs,
                _T4Space.xs,
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      'SESSIONS',
                      style: Theme.of(context).textTheme.labelSmall?.copyWith(
                        color: scheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                  IconButton(
                    onPressed: canCreate
                        ? () => unawaited(_createSession())
                        : null,
                    tooltip: canCreate
                        ? 'New session'
                        : 'Connect with session management permission to create',
                    icon: const Icon(Icons.add),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: _T4Space.md),
              child: TextField(
                controller: _searchController,
                onChanged: (_) => setState(() {}),
                textInputAction: TextInputAction.search,
                decoration: InputDecoration(
                  hintText: 'Search sessions',
                  prefixIcon: const Icon(Icons.search),
                  suffixIcon: query.isEmpty
                      ? null
                      : IconButton(
                          onPressed: () {
                            _searchController.clear();
                            setState(() {});
                          },
                          tooltip: 'Clear search',
                          icon: const Icon(Icons.close),
                        ),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(
                _T4Space.md,
                _T4Space.sm,
                _T4Space.md,
                _T4Space.xs,
              ),
              child: SegmentedButton<_SessionListView>(
                segments: const [
                  ButtonSegment(
                    value: _SessionListView.current,
                    label: Text('Current'),
                  ),
                  ButtonSegment(
                    value: _SessionListView.archived,
                    label: Text('Archived'),
                  ),
                ],
                selected: <_SessionListView>{_view},
                showSelectedIcon: false,
                onSelectionChanged: (selection) {
                  setState(() => _view = selection.single);
                },
              ),
            ),
            Expanded(
              child: Semantics(
                label: 'Sessions',
                explicitChildNodes: true,
                child: visible.isEmpty
                    ? _EmptySessions(
                        phase: widget.state.connectionPhase,
                        filtered: widget.state.sessions.isNotEmpty,
                      )
                    : ListView(
                        padding: const EdgeInsets.fromLTRB(
                          _T4Space.xs,
                          0,
                          _T4Space.xs,
                          _T4Space.md,
                        ),
                        children: [
                          for (final entry in groups.entries) ...[
                            Padding(
                              padding: const EdgeInsets.fromLTRB(
                                _T4Space.sm,
                                _T4Space.sm,
                                _T4Space.sm,
                                _T4Space.xxs,
                              ),
                              child: Text(
                                entry.value.first.projectName,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: Theme.of(context).textTheme.labelMedium
                                    ?.copyWith(color: scheme.onSurfaceVariant),
                              ),
                            ),
                            for (final session in entry.value)
                              Padding(
                                padding: const EdgeInsets.only(
                                  bottom: _T4Space.xxs,
                                ),
                                child: _SessionTile(
                                  session: session,
                                  state: widget.state,
                                  actions: widget.actions,
                                  selected:
                                      session.sessionId ==
                                      widget.state.selectedSessionId,
                                  pending:
                                      session.sessionId ==
                                      widget.selectingSessionId,
                                  onTap: () =>
                                      widget.onSelectSession(session.sessionId),
                                ),
                              ),
                          ],
                        ],
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

final class _ConnectionStatus extends StatelessWidget {
  const _ConnectionStatus({
    required this.phase,
    required this.actionPending,
    required this.onConnect,
    required this.onDisconnect,
  });

  final ConnectionPhase phase;
  final bool actionPending;
  final Future<void> Function() onConnect;
  final Future<void> Function() onDisconnect;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final actionLabel = phase.actionLabel;
    final action = phase.canDisconnect ? onDisconnect : onConnect;
    final active = phase.isActive || actionPending;

    return Semantics(
      container: true,
      label: 'Connection status: ${phase.label}',
      child: Row(
        children: [
          SizedBox.square(
            dimension: _T4Size.indicator,
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
          Expanded(
            child: Text(
              phase.label,
              style: Theme.of(
                context,
              ).textTheme.bodyMedium?.copyWith(color: scheme.onSurfaceVariant),
            ),
          ),
          TextButton(
            onPressed: actionPending ? null : () => unawaited(action()),
            child: Text(actionPending ? 'Working…' : actionLabel),
          ),
        ],
      ),
    );
  }
}

final class _EmptySessions extends StatelessWidget {
  const _EmptySessions({required this.phase, this.filtered = false});

  final ConnectionPhase phase;
  final bool filtered;

  @override
  Widget build(BuildContext context) {
    final ready = phase == ConnectionPhase.ready;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(_T4Space.lg),
        child: Text(
          filtered
              ? 'No matching sessions.'
              : ready
              ? 'No sessions are available.'
              : 'Connect to load your sessions.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
        ),
      ),
    );
  }
}

final class _SessionTile extends StatefulWidget {
  const _SessionTile({
    required this.session,
    required this.state,
    required this.actions,
    required this.selected,
    required this.pending,
    required this.onTap,
  });

  final SessionSummary session;
  final T4ViewState state;
  final T4Actions actions;
  final bool selected;
  final bool pending;
  final Future<void> Function() onTap;

  @override
  State<_SessionTile> createState() => _SessionTileState();
}

enum _SessionAction { rename, terminate, archive, restore, delete }

final class _SessionTileState extends State<_SessionTile> {
  bool get _canManage =>
      widget.state.connectionPhase == ConnectionPhase.ready &&
      widget.state.grantedCapabilities.contains('sessions.manage') &&
      !widget.state.sessionOperationPending;

  Future<void> _run(_SessionAction action) async {
    try {
      switch (action) {
        case _SessionAction.rename:
          await _rename();
        case _SessionAction.terminate:
          if (await _confirm(
            title: 'Terminate runtime?',
            message:
                'This stops the running agent for “${widget.session.title}”. '
                'The session and transcript remain available.',
            actionLabel: 'Terminate',
          )) {
            await widget.actions.terminateSession(widget.session.sessionId);
          }
        case _SessionAction.archive:
          await widget.actions.archiveSession(widget.session.sessionId);
        case _SessionAction.restore:
          await widget.actions.restoreSession(widget.session.sessionId);
        case _SessionAction.delete:
          if (await _confirmDelete()) {
            await widget.actions.deleteSession(widget.session.sessionId);
          }
      }
    } on Object catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(content: Text('Session action failed: $error')),
        );
    }
  }

  Future<void> _rename() async {
    final controller = TextEditingController(text: widget.session.title);
    final title = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Rename session'),
        content: TextField(
          controller: controller,
          autofocus: true,
          maxLength: 512,
          decoration: const InputDecoration(labelText: 'Session title'),
          onSubmitted: (value) {
            if (value.trim().isNotEmpty) {
              Navigator.of(context).pop(value.trim());
            }
          },
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () {
              final value = controller.text.trim();
              if (value.isNotEmpty) Navigator.of(context).pop(value);
            },
            child: const Text('Rename'),
          ),
        ],
      ),
    );
    controller.dispose();
    if (title != null && title != widget.session.title) {
      await widget.actions.renameSession(widget.session.sessionId, title);
    }
  }

  Future<bool> _confirm({
    required String title,
    required String message,
    required String actionLabel,
  }) async {
    return await showDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
            title: Text(title),
            content: Text(message),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(context).pop(false),
                child: const Text('Cancel'),
              ),
              FilledButton(
                onPressed: () => Navigator.of(context).pop(true),
                child: Text(actionLabel),
              ),
            ],
          ),
        ) ??
        false;
  }

  Future<bool> _confirmDelete() async {
    final controller = TextEditingController();
    final confirmationText = widget.session.title.trim().isEmpty
        ? 'delete'
        : widget.session.title;
    var valid = false;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Permanently delete session?'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text(
                'This permanently deletes the session and its transcript. '
                'This cannot be undone.',
              ),
              const SizedBox(height: _T4Space.md),
              Text('Type “$confirmationText” to confirm.'),
              const SizedBox(height: _T4Space.xs),
              TextField(
                controller: controller,
                autofocus: true,
                decoration: const InputDecoration(labelText: 'Session title'),
                onChanged: (value) {
                  setDialogState(
                    () => valid = value.trim() == confirmationText,
                  );
                },
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: valid ? () => Navigator.of(context).pop(true) : null,
              style: FilledButton.styleFrom(
                backgroundColor: Theme.of(context).colorScheme.error,
                foregroundColor: Theme.of(context).colorScheme.onError,
              ),
              child: const Text('Delete permanently'),
            ),
          ],
        ),
      ),
    );
    controller.dispose();
    return confirmed ?? false;
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final session = widget.session;
    final title = session.title.trim().isEmpty
        ? 'Untitled session'
        : session.title;
    final canArchiveOrDelete = _canManage && !session.working;

    return Semantics(
      button: true,
      selected: widget.selected,
      label:
          '$title, ${session.projectName}, '
          '${session.archived ? 'archived, ' : ''}${session.status}',
      child: ListTile(
        selected: widget.selected,
        selectedTileColor: scheme.secondaryContainer,
        title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
        subtitle: Text(
          session.status.trim().isEmpty ? 'idle' : session.status,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        trailing: widget.pending
            ? const SizedBox.square(
                dimension: _T4Size.indicator,
                child: CircularProgressIndicator(
                  strokeWidth: _T4Size.thinStroke,
                  semanticsLabel: 'Selecting session',
                ),
              )
            : PopupMenuButton<_SessionAction>(
                tooltip: 'Session actions',
                enabled: _canManage,
                onSelected: (action) => unawaited(_run(action)),
                itemBuilder: (context) => [
                  if (!session.archived)
                    const PopupMenuItem(
                      value: _SessionAction.rename,
                      child: Text('Rename'),
                    ),
                  if (!session.archived && session.status != 'closed')
                    const PopupMenuItem(
                      value: _SessionAction.terminate,
                      child: Text('Terminate runtime'),
                    ),
                  if (!session.archived)
                    PopupMenuItem(
                      value: _SessionAction.archive,
                      enabled: canArchiveOrDelete,
                      child: Text(
                        session.working
                            ? 'Archive (terminate runtime first)'
                            : 'Archive',
                      ),
                    ),
                  if (session.archived)
                    const PopupMenuItem(
                      value: _SessionAction.restore,
                      child: Text('Restore'),
                    ),
                  PopupMenuItem(
                    value: _SessionAction.delete,
                    enabled: canArchiveOrDelete,
                    child: Text(
                      session.working
                          ? 'Delete (terminate runtime first)'
                          : 'Delete permanently',
                    ),
                  ),
                ],
                icon: widget.selected
                    ? const Icon(Icons.more_horiz)
                    : const Icon(Icons.more_vert),
              ),
        onTap: widget.pending ? null : () => unawaited(widget.onTap()),
      ),
    );
  }
}

final class _CreateSessionDialog extends StatefulWidget {
  const _CreateSessionDialog({required this.actions, required this.projects});

  final T4Actions actions;
  final Map<String, String> projects;

  @override
  State<_CreateSessionDialog> createState() => _CreateSessionDialogState();
}

final class _CreateSessionDialogState extends State<_CreateSessionDialog> {
  final TextEditingController _titleController = TextEditingController();
  late String _projectId = widget.projects.keys.first;
  bool _pending = false;
  String? _error;

  @override
  void dispose() {
    _titleController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_pending) return;
    setState(() {
      _pending = true;
      _error = null;
    });
    try {
      await widget.actions.createSession(
        _projectId,
        title: _titleController.text,
      );
      if (mounted) Navigator.of(context).pop(true);
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _pending = false;
        _error = 'Could not create session: $error';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('New session'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          DropdownButtonFormField<String>(
            initialValue: _projectId,
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Project'),
            items: [
              for (final entry in widget.projects.entries)
                DropdownMenuItem(
                  value: entry.key,
                  child: Text(
                    entry.value,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
            ],
            onChanged: _pending
                ? null
                : (value) {
                    if (value != null) setState(() => _projectId = value);
                  },
          ),
          const SizedBox(height: _T4Space.md),
          TextField(
            controller: _titleController,
            enabled: !_pending,
            autofocus: true,
            maxLength: 512,
            textInputAction: TextInputAction.done,
            decoration: const InputDecoration(
              labelText: 'Title',
              hintText: 'Session',
            ),
            onSubmitted: (_) => unawaited(_submit()),
          ),
          if (_error case final error?) ...[
            const SizedBox(height: _T4Space.xs),
            Text(
              error,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.error,
              ),
            ),
          ],
        ],
      ),
      actions: [
        TextButton(
          onPressed: _pending ? null : () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _pending ? null : () => unawaited(_submit()),
          child: Text(_pending ? 'Creating…' : 'Create'),
        ),
      ],
    );
  }
}
