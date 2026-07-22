part of 't4_app.dart';

final class _ConversationPane extends StatelessWidget {
  const _ConversationPane({
    required this.state,
    required this.actions,
    required this.showHeader,
    required this.onConnect,
    this.onOpenSessions,
    required this.onOpenAttention,
    required this.onOpenDeveloper,
    required this.onOpenQuickOpen,
    required this.onSelectSession,
  });

  final T4ViewState state;
  final T4Actions actions;
  final bool showHeader;
  final Future<void> Function() onConnect;
  final VoidCallback? onOpenSessions;
  final VoidCallback onOpenAttention;
  final VoidCallback onOpenDeveloper;
  final Future<void> Function() onOpenQuickOpen;
  final Future<void> Function(String sessionId) onSelectSession;

  @override
  Widget build(BuildContext context) {
    final error = state.errorMessage?.trim();
    final showError =
        (error != null && error.isNotEmpty) ||
        state.connectionPhase == ConnectionPhase.failed;

    return Column(
      children: [
        if (showHeader)
          _ConversationHeader(
            state: state,
            actions: actions,
            onOpenDeveloper: onOpenDeveloper,
            onOpenQuickOpen: onOpenQuickOpen,
            onSelectSession: onSelectSession,
          ),
        if (showError)
          _ConnectionErrorBanner(
            message: error == null || error.isEmpty
                ? 'The connection could not be established.'
                : error,
            canRetry: state.connectionPhase == ConnectionPhase.failed,
            onRetry: onConnect,
          ),
        Expanded(
          child: _TranscriptView(
            state: state,
            actions: actions,
            onOpenSessions: onOpenSessions,
            onOpenAttention: onOpenAttention,
            onOpenDeveloper: onOpenDeveloper,
          ),
        ),
        _PromptComposer(state: state, actions: actions),
      ],
    );
  }
}

/// Wide-layout conversation header. Only the wide shell renders this widget
/// (compact keeps the app bar), so the inbox button anchors a 400 px flyout
/// here instead of toggling the full-screen attention takeover.
final class _ConversationHeader extends StatefulWidget {
  const _ConversationHeader({
    required this.state,
    required this.actions,
    required this.onOpenDeveloper,
    required this.onOpenQuickOpen,
    required this.onSelectSession,
  });

  final T4ViewState state;
  final T4Actions actions;
  final VoidCallback onOpenDeveloper;
  final Future<void> Function() onOpenQuickOpen;
  final Future<void> Function(String sessionId) onSelectSession;

  @override
  State<_ConversationHeader> createState() => _ConversationHeaderState();
}

final class _ConversationHeaderState extends State<_ConversationHeader> {
  final MenuController _inboxMenu = MenuController();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final state = widget.state;
    final session = state.selectedSession;
    final streaming = state.composer.turnActive;

    return DecoratedBox(
      decoration: BoxDecoration(
        color: scheme.surface,
        border: Border(bottom: BorderSide(color: scheme.outlineVariant)),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: _T4Space.lg,
          vertical: _T4Space.md,
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    _displaySessionTitle(session),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  if (session != null && session.status.trim().isNotEmpty) ...[
                    const SizedBox(height: _T4Space.xxs),
                    Text(
                      session.status,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: scheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            IconButton(
              onPressed:
                  state.connectionPhase == ConnectionPhase.ready &&
                      state.grantedFeatures.contains('files.search') &&
                      state.grantedCapabilities.contains('files.list') &&
                      state.grantedCapabilities.contains('files.read') &&
                      session != null
                  ? () => unawaited(widget.onOpenQuickOpen())
                  : null,
              tooltip: 'Quick open project file',
              icon: const Icon(Icons.search),
            ),
            IconButton(
              onPressed: widget.onOpenDeveloper,
              tooltip: 'Open developer tools',
              icon: const Icon(Icons.code),
            ),
            Badge(
              isLabelVisible: state.urgentAttentionCount > 0,
              label: Text('${state.urgentAttentionCount}'),
              child: MenuAnchor(
                controller: _inboxMenu,
                alignmentOffset: const Offset(0, _T4Space.xs),
                menuChildren: <Widget>[
                  SizedBox(
                    width: 400,
                    height: 480,
                    child: InboxFlyoutContent(
                      state: state,
                      actions: widget.actions,
                      showTitle: false,
                      onDone: _inboxMenu.close,
                      onOpenSession: (sessionId) async {
                        await widget.onSelectSession(sessionId);
                        if (mounted) _inboxMenu.close();
                      },
                    ),
                  ),
                ],
                builder: (context, controller, child) => IconButton(
                  onPressed: () => _toggleMenu(controller),
                  tooltip: 'Open inbox',
                  icon: const Icon(Icons.inbox_outlined),
                ),
              ),
            ),
            const SizedBox(width: _T4Space.sm),
            if (streaming) const _StreamingLabel(),
          ],
        ),
      ),
    );
  }
}

final class _StreamingLabel extends StatelessWidget {
  const _StreamingLabel();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      liveRegion: true,
      label: 'Assistant is streaming a response',
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox.square(
            dimension: _T4Size.indicator,
            child: CircularProgressIndicator(
              strokeWidth: _T4Size.thinStroke,
              color: scheme.primary,
            ),
          ),
          const SizedBox(width: _T4Space.xs),
          Text(
            'Streaming',
            style: Theme.of(
              context,
            ).textTheme.labelMedium?.copyWith(color: scheme.primary),
          ),
        ],
      ),
    );
  }
}

final class _ConnectionErrorBanner extends StatelessWidget {
  const _ConnectionErrorBanner({
    required this.message,
    required this.canRetry,
    required this.onRetry,
  });

  final String message;
  final bool canRetry;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      container: true,
      liveRegion: true,
      label: 'Connection error: $message',
      child: ColoredBox(
        color: scheme.errorContainer,
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: _T4Space.md,
            vertical: _T4Space.xs,
          ),
          child: Row(
            children: [
              Icon(Icons.error_outline, color: scheme.onErrorContainer),
              const SizedBox(width: _T4Space.sm),
              Expanded(
                child: Text(
                  message,
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: scheme.onErrorContainer,
                  ),
                ),
              ),
              if (canRetry) ...[
                const SizedBox(width: _T4Space.xs),
                TextButton(
                  onPressed: () => unawaited(onRetry()),
                  style: TextButton.styleFrom(
                    foregroundColor: scheme.onErrorContainer,
                  ),
                  child: const Text('Retry'),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

final class _TranscriptView extends StatefulWidget {
  const _TranscriptView({
    required this.state,
    required this.actions,
    required this.onOpenAttention,
    this.onOpenSessions,
    this.onOpenDeveloper,
  });

  final T4ViewState state;
  final T4Actions actions;
  final VoidCallback onOpenAttention;
  final VoidCallback? onOpenSessions;
  final VoidCallback? onOpenDeveloper;

  @override
  State<_TranscriptView> createState() => _TranscriptViewState();
}

final class _TranscriptViewState extends State<_TranscriptView> {
  final ScrollController _scrollController = ScrollController();
  final Set<String> _expandedWorkGroups = <String>{};
  final Set<String> _respondingAttention = <String>{};
  bool _followEnd = true;
  bool _userScrolling = false;

  @override
  void initState() {
    super.initState();
    _scheduleScrollToEnd(animate: false);
  }

  @override
  void didUpdateWidget(covariant _TranscriptView oldWidget) {
    super.didUpdateWidget(oldWidget);
    final sessionChanged =
        oldWidget.state.selectedSessionId != widget.state.selectedSessionId;
    final messagesChanged = _visibleMessagesChanged(
      oldWidget.state.messages,
      widget.state.messages,
    );
    final historyPrepended =
        !sessionChanged &&
        !_followEnd &&
        _historyWasPrepended(oldWidget.state.messages, widget.state.messages);
    if (historyPrepended && _scrollController.hasClients) {
      final position = _scrollController.position;
      _restoreHistoryDistanceFromEnd(
        position.maxScrollExtent - position.pixels,
      );
    }
    if (!sessionChanged && !messagesChanged) return;
    if (sessionChanged) _followEnd = true;

    final shouldFollow = sessionChanged || _followEnd;
    if (shouldFollow) _scheduleScrollToEnd(animate: !sessionChanged);
  }

  bool get _isNearEnd {
    if (!_scrollController.hasClients) return true;
    final position = _scrollController.position;
    return position.maxScrollExtent - position.pixels <=
        _T4Layout.followScrollThreshold;
  }

  bool _trackScroll(ScrollNotification notification) {
    if (notification is UserScrollNotification) {
      if (notification.direction == ScrollDirection.idle) {
        _followEnd = _isNearEnd;
        _userScrolling = false;
      } else {
        _userScrolling = true;
        _followEnd = false;
      }
    } else if (notification is ScrollStartNotification &&
        notification.dragDetails != null) {
      _userScrolling = true;
      _followEnd = false;
    } else if (_userScrolling && notification is ScrollEndNotification) {
      _followEnd = _isNearEnd;
      _userScrolling = false;
    }
    return false;
  }

  bool _trackScrollMetrics(ScrollMetricsNotification notification) {
    if (_followEnd) _scheduleScrollToEnd(animate: false);
    return false;
  }

  bool _visibleMessagesChanged(
    List<TranscriptMessage> previous,
    List<TranscriptMessage> current,
  ) {
    if (previous.length != current.length) return true;
    if (previous.isEmpty) return false;
    final oldLast = previous.last;
    final newLast = current.last;
    return oldLast.id != newLast.id ||
        oldLast.text != newLast.text ||
        oldLast.streaming != newLast.streaming;
  }

  bool _historyWasPrepended(
    List<TranscriptMessage> previous,
    List<TranscriptMessage> current,
  ) {
    if (previous.isEmpty || current.length <= previous.length) return false;
    final offset = current.indexWhere(
      (message) => message.id == previous.first.id,
    );
    if (offset <= 0 || current.length < offset + previous.length) return false;
    for (var index = 0; index < previous.length; index++) {
      if (current[offset + index].id != previous[index].id) return false;
    }
    return true;
  }

  void _restoreHistoryDistanceFromEnd(
    double distanceFromEnd, {
    int framesRemaining = 3,
  }) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scrollController.hasClients) return;
      final position = _scrollController.position;
      final target = (position.maxScrollExtent - distanceFromEnd).clamp(
        position.minScrollExtent,
        position.maxScrollExtent,
      );
      if ((position.pixels - target).abs() > 0.5) {
        position.jumpTo(target);
      }
      if (framesRemaining > 1) {
        _restoreHistoryDistanceFromEnd(
          distanceFromEnd,
          framesRemaining: framesRemaining - 1,
        );
      }
    });
  }

  void _scheduleScrollToEnd({required bool animate}) {
    _followEnd = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scrollController.hasClients || !_followEnd) return;
      final end = _scrollController.position.maxScrollExtent;
      if (animate) {
        unawaited(
          _scrollController.animateTo(
            end,
            duration: _T4Motion.short,
            curve: _T4Motion.standard,
          ),
        );
      } else {
        _scrollController.jumpTo(end);
      }
    });
  }

  /// Collapses each maximal run of two or more completed tool/reasoning
  /// steps between chat messages into one collapsible work group. The
  /// trailing run of the currently streaming turn stays expanded/ungrouped.
  List<_TranscriptEntry> _transcriptEntries() {
    final messages = widget.state.messages;
    final entries = <_TranscriptEntry>[];
    var index = 0;
    while (index < messages.length) {
      if (!_isWorkedMessage(messages[index])) {
        entries.add(_SingleTranscriptEntry(messages[index]));
        index += 1;
        continue;
      }
      var end = index;
      while (end < messages.length && _isWorkedMessage(messages[end])) {
        end += 1;
      }
      final run = messages.sublist(index, end);
      final trailingActiveRun =
          end == messages.length && widget.state.composer.turnActive;
      if (run.length < 2 || trailingActiveRun) {
        entries.addAll(run.map(_SingleTranscriptEntry.new));
      } else {
        entries.add(_WorkGroupTranscriptEntry(_TranscriptWorkGroup(run)));
      }
      index = end;
    }
    return entries;
  }

  void _toggleWorkGroup(String key) {
    setState(() {
      if (!_expandedWorkGroups.remove(key)) _expandedWorkGroups.add(key);
    });
  }

  void _showError(String message) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  /// Mirrors the inbox pane's respond wiring (busy set, acceptance check,
  /// error surfacing) for the inline approval cards.
  Future<void> _respondAttention(
    AttentionItem item,
    AttentionResponse response,
  ) async {
    if (!_respondingAttention.add(item.key)) return;
    setState(() {});
    try {
      final accepted = await widget.actions.respondToAttention(item, response);
      if (!mounted) return;
      if (!accepted) _showError('The host did not accept that response.');
    } on Object catch (error) {
      if (mounted) _showError(error.toString().replaceFirst('Bad state: ', ''));
    } finally {
      if (mounted) setState(() => _respondingAttention.remove(item.key));
    }
  }

  Future<String?> _askForText({
    required String title,
    String hint = 'Add a note',
  }) async {
    final controller = TextEditingController();
    final result = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: TextField(
          controller: controller,
          autofocus: true,
          minLines: 2,
          maxLines: 6,
          decoration: InputDecoration(hintText: hint),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, controller.text.trim()),
            child: const Text('Send'),
          ),
        ],
      ),
    );
    controller.dispose();
    return result;
  }

  Future<void> _reviseAttention(AttentionItem item) async {
    final note = await _askForText(
      title: 'Request plan changes',
      hint: 'What should change?',
    );
    if (note != null) {
      await _respondAttention(
        item,
        AttentionResponse(decision: AttentionDecision.revise, text: note),
      );
    }
  }

  Future<void> _customAnswerAttention(AttentionItem item) async {
    final answer = await _askForText(
      title: item.title,
      hint: 'Type your answer',
    );
    if (answer != null && answer.isNotEmpty) {
      await _respondAttention(
        item,
        AttentionResponse(decision: AttentionDecision.approve, text: answer),
      );
    }
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final session = widget.state.selectedSession;
    if (session == null) {
      return _TranscriptEmptyState(
        title: 'Choose a session',
        message: widget.onOpenSessions == null
            ? 'Select a session from the session rail.'
            : 'Open sessions to choose a conversation.',
        actionLabel: widget.onOpenSessions == null ? null : 'Open sessions',
        onAction: widget.onOpenSessions,
      );
    }

    if (widget.state.messages.isEmpty) {
      final ready = widget.state.connectionPhase == ConnectionPhase.ready;
      return _TranscriptEmptyState(
        title: 'Start the conversation',
        message: ready
            ? 'Send a prompt when you’re ready.'
            : 'You can send a prompt once the connection is ready.',
      );
    }

    final showHistoryControl =
        widget.state.transcriptHistoryLoading ||
        widget.state.transcriptHistoryHasMore ||
        widget.state.transcriptHistoryError != null;
    final messageOffset = showHistoryControl ? 1 : 0;
    final entries = _transcriptEntries();
    final inlineAttention = widget.state.attentionItems
        .where(
          (item) =>
              item.sessionId == widget.state.selectedSessionId &&
              item.needsResponse &&
              item.actionable,
        )
        .toList(growable: false);

    return Column(
      children: [
        if (widget.state.transcriptTailFromCache)
          const _CachedTranscriptNotice(),
        Expanded(
          child: NotificationListener<ScrollMetricsNotification>(
            onNotification: _trackScrollMetrics,
            child: NotificationListener<ScrollNotification>(
              onNotification: _trackScroll,
              child: Scrollbar(
                controller: _scrollController,
                child: ListView.separated(
                  controller: _scrollController,
                  keyboardDismissBehavior:
                      ScrollViewKeyboardDismissBehavior.onDrag,
                  padding: const EdgeInsets.fromLTRB(
                    _T4Space.md,
                    _T4Space.lg,
                    _T4Space.md,
                    _T4Space.xl,
                  ),
                  itemCount:
                      entries.length + messageOffset + inlineAttention.length,
                  separatorBuilder: (context, index) =>
                      const SizedBox(height: _T4Space.lg),
                  itemBuilder: (context, index) {
                    final Widget item;
                    if (showHistoryControl && index == 0) {
                      item = _TranscriptHistoryControl(
                        loading: widget.state.transcriptHistoryLoading,
                        hasMore: widget.state.transcriptHistoryHasMore,
                        error: widget.state.transcriptHistoryError,
                        onLoad: widget.actions.loadEarlierTranscript,
                      );
                    } else if (index - messageOffset < entries.length) {
                      item = switch (entries[index - messageOffset]) {
                        _SingleTranscriptEntry(:final message) =>
                          _TranscriptMessageView(
                            message: message,
                            actions: widget.actions,
                          ),
                        _WorkGroupTranscriptEntry(:final group) =>
                          _WorkGroupView(
                            group: group,
                            expanded: _expandedWorkGroups.contains(group.key),
                            onToggle: () => _toggleWorkGroup(group.key),
                            actions: widget.actions,
                            onReview: widget.onOpenDeveloper,
                          ),
                      };
                    } else {
                      final attention =
                          inlineAttention[index -
                              messageOffset -
                              entries.length];
                      item = InlineApprovalCard(
                        item: attention,
                        busy: _respondingAttention.contains(attention.key),
                        canRespond:
                            widget.state.connectionPhase ==
                                ConnectionPhase.ready &&
                            attention.actionable,
                        onRespond: (response) =>
                            unawaited(_respondAttention(attention, response)),
                        onRevise: () => unawaited(_reviseAttention(attention)),
                        onCustomAnswer: () =>
                            unawaited(_customAnswerAttention(attention)),
                        onOpenInbox: widget.onOpenAttention,
                      );
                    }
                    // Share one centered column axis with the composer: the
                    // transcript content is capped at the same
                    // [_T4Layout.contentMaxWidth] the composer uses.
                    return Center(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(
                          maxWidth: _T4Layout.contentMaxWidth,
                        ),
                        child: SizedBox(width: double.infinity, child: item),
                      ),
                    );
                  },
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// A transcript row: either one message or a collapsed run of work steps.
sealed class _TranscriptEntry {
  const _TranscriptEntry();
}

final class _SingleTranscriptEntry extends _TranscriptEntry {
  const _SingleTranscriptEntry(this.message);

  final TranscriptMessage message;
}

final class _WorkGroupTranscriptEntry extends _TranscriptEntry {
  const _WorkGroupTranscriptEntry(this.group);

  final _TranscriptWorkGroup group;
}

final class _TranscriptWorkGroup {
  _TranscriptWorkGroup(this.messages)
    : editedFiles = _editedFilePaths(messages);

  final List<TranscriptMessage> messages;

  /// Best-effort file paths touched by file-mutating tool calls in the group.
  final List<String> editedFiles;

  String get key => messages.first.id;
}

/// Whether a message renders as pure background work (a completed tool card
/// or a text-less reasoning disclosure) and may collapse into a work group.
bool _isWorkedMessage(TranscriptMessage message) {
  if (message.streaming) return false;
  if (message.kind == TranscriptKind.tool) return !message.toolRunning;
  return message.kind == TranscriptKind.message &&
      message.role == MessageRole.assistant &&
      message.text.isEmpty &&
      message.images.isEmpty &&
      message.reasoning.isNotEmpty;
}

/// Matches the file-mutating wire commands (`files.write`, `files.patch`,
/// `review.apply`, apply_patch-style names) without inventing new ones.
bool _isFileMutatingToolName(String? name) {
  if (name == null) return false;
  final lower = name.toLowerCase();
  if (lower == 'review.apply' || lower.contains('apply_patch')) return true;
  if (!lower.startsWith('files.')) return false;
  final verb = lower.substring('files.'.length);
  return verb.startsWith('write') ||
      verb.startsWith('patch') ||
      verb.startsWith('apply');
}

/// Derives file paths from tool-call argument JSON ('path'/'file'/'files').
List<String> _editedFilePaths(List<TranscriptMessage> messages) {
  final paths = <String>{};
  for (final message in messages) {
    if (message.kind != TranscriptKind.tool) continue;
    if (!_isFileMutatingToolName(message.toolName)) continue;
    final raw = message.toolArguments;
    if (raw == null || raw.isEmpty) continue;
    Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } on FormatException {
      continue;
    }
    if (decoded is! Map<String, Object?>) continue;
    void addPath(Object? value) {
      if (value is String && value.trim().isNotEmpty) paths.add(value.trim());
    }

    addPath(decoded['path']);
    addPath(decoded['file']);
    if (decoded['files'] case final List<Object?> files) {
      for (final entry in files) {
        if (entry is Map<String, Object?>) {
          addPath(entry['path']);
          addPath(entry['file']);
        } else {
          addPath(entry);
        }
      }
    }
  }
  return paths.toList(growable: false);
}

/// Collapsible 'Worked · N steps' row wrapping a run of completed steps.
/// Expanded rendering is identical to the ungrouped transcript.
final class _WorkGroupView extends StatelessWidget {
  const _WorkGroupView({
    required this.group,
    required this.expanded,
    required this.onToggle,
    required this.actions,
    this.onReview,
  });

  final _TranscriptWorkGroup group;
  final bool expanded;
  final VoidCallback onToggle;
  final T4Actions actions;
  final VoidCallback? onReview;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final labelStyle = Theme.of(
      context,
    ).textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant);
    final steps = group.messages.length;
    final edited = group.editedFiles;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: _T4Space.xxs),
          child: Semantics(
            button: true,
            label:
                'Worked · $steps steps, ${expanded ? 'expanded' : 'collapsed'}',
            child: InkWell(
              borderRadius: BorderRadius.circular(_T4Radius.sm),
              onTap: onToggle,
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: _T4Space.xxs,
                  vertical: _T4Space.xxs,
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      expanded ? Icons.expand_more : Icons.chevron_right,
                      size: 14,
                      color: scheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: _T4Space.xxs),
                    Text('Worked · $steps steps', style: labelStyle),
                  ],
                ),
              ),
            ),
          ),
        ),
        if (edited.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(
              left: _T4Space.xxs,
              bottom: _T4Space.xxs,
            ),
            child: Wrap(
              spacing: _T4Space.xs,
              runSpacing: _T4Space.xxs,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Text(
                  edited.length == 1
                      ? 'Edited 1 file'
                      : 'Edited ${edited.length} files',
                  style: labelStyle,
                ),
                for (final path in edited.take(3)) _EditedFileChip(path: path),
                if (edited.length > 3)
                  Text('+${edited.length - 3} more', style: labelStyle),
                if (onReview != null)
                  TextButton(
                    onPressed: onReview,
                    style: TextButton.styleFrom(
                      foregroundColor: scheme.onSurfaceVariant,
                      textStyle: const TextStyle(fontSize: 12),
                      visualDensity: VisualDensity.compact,
                      padding: const EdgeInsets.symmetric(
                        horizontal: _T4Space.xs,
                      ),
                      minimumSize: Size.zero,
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                    child: const Text('Review'),
                  ),
              ],
            ),
          ),
        if (expanded) ...[
          const SizedBox(height: _T4Space.xs),
          for (var index = 0; index < group.messages.length; index++) ...[
            if (index > 0) const SizedBox(height: _T4Space.lg),
            _TranscriptMessageView(
              message: group.messages[index],
              actions: actions,
            ),
          ],
        ],
      ],
    );
  }
}

final class _EditedFileChip extends StatelessWidget {
  const _EditedFileChip({required this.path});

  final String path;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final basename = path.split('/').last.split('\\').last;
    return Tooltip(
      message: path,
      child: Container(
        padding: const EdgeInsets.symmetric(
          horizontal: _T4Space.xs,
          vertical: 1,
        ),
        decoration: BoxDecoration(
          color: scheme.surfaceContainerHigh,
          borderRadius: BorderRadius.circular(_T4Radius.sm),
        ),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 140),
          child: Text(
            basename,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontFamily: _T4Typography.monoFamily,
              fontSize: 11,
              color: scheme.onSurfaceVariant,
            ),
          ),
        ),
      ),
    );
  }
}

final class _CachedTranscriptNotice extends StatelessWidget {
  const _CachedTranscriptNotice();

  @override
  Widget build(BuildContext context) => Semantics(
    liveRegion: true,
    child: Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(
        horizontal: _T4Space.md,
        vertical: _T4Space.xs,
      ),
      color: Theme.of(context).colorScheme.surfaceContainerLow,
      child: Text(
        'Showing encrypted saved messages while the live transcript connects.',
        textAlign: TextAlign.center,
        style: Theme.of(context).textTheme.bodySmall?.copyWith(
          color: Theme.of(context).colorScheme.onSurfaceVariant,
        ),
      ),
    ),
  );
}

final class _TranscriptHistoryControl extends StatelessWidget {
  const _TranscriptHistoryControl({
    required this.loading,
    required this.hasMore,
    required this.error,
    required this.onLoad,
  });

  final bool loading;
  final bool hasMore;
  final String? error;
  final Future<void> Function() onLoad;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      label: loading
          ? 'Loading earlier messages'
          : 'Earlier transcript history',
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: _T4Space.xs),
              child: Text(
                error!,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: Theme.of(context).colorScheme.error,
                ),
              ),
            ),
          OutlinedButton.icon(
            onPressed: loading || !hasMore ? null : () => unawaited(onLoad()),
            icon: loading
                ? const SizedBox.square(
                    dimension: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.history, size: 18),
            label: Text(
              loading ? 'Loading earlier messages' : 'Load earlier messages',
            ),
          ),
        ],
      ),
    );
  }
}

final class _TranscriptEmptyState extends StatelessWidget {
  const _TranscriptEmptyState({
    required this.title,
    required this.message,
    this.actionLabel,
    this.onAction,
  });

  final String title;
  final String message;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: _T4Layout.contentMaxWidth),
        child: Padding(
          padding: const EdgeInsets.all(_T4Space.xl),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.chat_bubble_outline,
                size: _T4Size.emptyIcon,
                color: scheme.outline,
              ),
              const SizedBox(height: _T4Space.md),
              Text(
                title,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: _T4Space.xs),
              Text(
                message,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: scheme.onSurfaceVariant,
                ),
              ),
              if (actionLabel case final label?) ...[
                const SizedBox(height: _T4Space.lg),
                TextButton(onPressed: onAction, child: Text(label)),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

extension on MessageRole {
  String get label => switch (this) {
    MessageRole.user => 'You',
    MessageRole.assistant => 'Assistant',
    MessageRole.system => 'System',
    MessageRole.tool => 'Tool',
  };
}

final class _TranscriptMessageView extends StatelessWidget {
  const _TranscriptMessageView({required this.message, required this.actions});

  final TranscriptMessage message;
  final T4Actions actions;

  @override
  Widget build(BuildContext context) {
    if (message.kind == TranscriptKind.tool) {
      return _ToolTranscriptCard(message: message);
    }
    final scheme = Theme.of(context).colorScheme;
    final isUser = message.role == MessageRole.user;
    final isAuxiliary = message.role == MessageRole.system;
    final label = message.kind == TranscriptKind.compaction
        ? 'Earlier chat summary'
        : message.role.label;
    // User and assistant messages carry no visible role text; screen readers
    // still announce the role through the enclosing [Semantics] label.
    final showVisualLabel =
        isAuxiliary || message.kind == TranscriptKind.compaction;
    final background = isUser
        ? scheme.surfaceContainerHigh
        : isAuxiliary
        ? scheme.surfaceContainerLow
        : Colors.transparent;

    Widget block = DecoratedBox(
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(_T4Radius.md),
        border: isAuxiliary ? Border.all(color: scheme.outlineVariant) : null,
      ),
      child: Padding(
        padding: isUser || isAuxiliary
            ? const EdgeInsets.all(_T4Space.md)
            : const EdgeInsets.symmetric(vertical: _T4Space.xs),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (showVisualLabel)
              Text(
                label.toUpperCase(),
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  color: scheme.onSurfaceVariant,
                ),
              ),
            if (message.reasoning.isNotEmpty) ...[
              if (showVisualLabel) const SizedBox(height: _T4Space.xs),
              _ReasoningDisclosure(
                reasoning: message.reasoning,
                streaming: message.streaming,
              ),
            ],
            if (message.text.isNotEmpty) ...[
              if (showVisualLabel || message.reasoning.isNotEmpty)
                const SizedBox(height: _T4Space.xs),
              TranscriptMarkdown(data: message.text),
            ],
            if (message.images.isNotEmpty) ...[
              const SizedBox(height: _T4Space.sm),
              Wrap(
                spacing: _T4Space.sm,
                runSpacing: _T4Space.sm,
                children: [
                  for (final image in message.images)
                    _TranscriptImage(
                      entryId: message.id,
                      image: image,
                      actions: actions,
                    ),
                ],
              ),
            ],
            if (message.streaming) ...[
              const SizedBox(height: _T4Space.sm),
              const _StreamingLabel(),
            ],
          ],
        ),
      ),
    );
    if (message.role == MessageRole.assistant &&
        message.kind == TranscriptKind.message &&
        message.text.isNotEmpty) {
      block = _MessageCopyAffordance(markdown: message.text, child: block);
    }

    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: _T4Layout.contentMaxWidth),
        child: Semantics(
          container: true,
          label: '$label message${message.streaming ? ', streaming' : ''}',
          child: block,
        ),
      ),
    );
  }
}

/// Hover-revealed (or long-press-revealed on touch) copy affordance for an
/// assistant message; copies the raw markdown source. Icon swaps to a check
/// briefly, matching the [CodeBlock] copy pattern.
final class _MessageCopyAffordance extends StatefulWidget {
  const _MessageCopyAffordance({required this.markdown, required this.child});

  final String markdown;
  final Widget child;

  @override
  State<_MessageCopyAffordance> createState() => _MessageCopyAffordanceState();
}

final class _MessageCopyAffordanceState extends State<_MessageCopyAffordance> {
  static const Duration _copiedFeedback = Duration(milliseconds: 1500);
  static const Duration _longPressReveal = Duration(seconds: 4);

  bool _hovering = false;
  bool _revealed = false;
  bool _copied = false;
  Timer? _copyTimer;
  Timer? _revealTimer;

  @override
  void dispose() {
    _copyTimer?.cancel();
    _revealTimer?.cancel();
    super.dispose();
  }

  void _revealFromLongPress() {
    setState(() => _revealed = true);
    _revealTimer?.cancel();
    _revealTimer = Timer(_longPressReveal, () {
      if (mounted) setState(() => _revealed = false);
    });
  }

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.markdown));
    if (!mounted) return;
    setState(() => _copied = true);
    _copyTimer?.cancel();
    _copyTimer = Timer(_copiedFeedback, () {
      if (mounted) setState(() => _copied = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final visible = _hovering || _revealed || _copied;
    return MouseRegion(
      onEnter: (_) => setState(() => _hovering = true),
      onExit: (_) => setState(() => _hovering = false),
      child: GestureDetector(
        behavior: HitTestBehavior.translucent,
        onLongPress: _revealFromLongPress,
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            widget.child,
            if (visible)
              Positioned(
                top: 0,
                right: 0,
                child: IconButton(
                  onPressed: () => unawaited(_copy()),
                  tooltip: _copied ? 'Copied' : 'Copy message',
                  iconSize: 14,
                  visualDensity: VisualDensity.compact,
                  icon: Icon(
                    _copied ? Icons.check_rounded : Icons.copy_rounded,
                    color: _copied ? scheme.primary : scheme.onSurfaceVariant,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

final class _ReasoningDisclosure extends StatelessWidget {
  const _ReasoningDisclosure({
    required this.reasoning,
    required this.streaming,
  });

  final String reasoning;
  final bool streaming;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(_T4Radius.sm),
      ),
      child: ExpansionTile(
        dense: true,
        shape: const Border(),
        collapsedShape: const Border(),
        leading: Icon(
          streaming ? Icons.psychology_alt_outlined : Icons.psychology_outlined,
          size: 20,
        ),
        title: Text(streaming ? 'Reasoning · streaming' : 'Reasoning'),
        childrenPadding: const EdgeInsets.fromLTRB(
          _T4Space.md,
          0,
          _T4Space.md,
          _T4Space.md,
        ),
        children: [TranscriptMarkdown(data: reasoning)],
      ),
    );
  }
}

final class _ToolTranscriptCard extends StatelessWidget {
  const _ToolTranscriptCard({required this.message});

  final TranscriptMessage message;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final semantic = T4SemanticColors.of(context);
    final statusIcon = message.toolRunning
        ? Icons.sync
        : message.toolSucceeded == false
        ? Icons.error_outline
        : Icons.check_circle_outline;
    final statusColor = message.toolRunning
        ? semantic.statusWorking
        : message.toolSucceeded == false
        ? semantic.statusError
        : semantic.statusDone;
    return Align(
      alignment: Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: _T4Layout.contentMaxWidth),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: scheme.surfaceContainerLow,
            border: Border.all(color: scheme.outlineVariant),
            borderRadius: BorderRadius.circular(_T4Radius.md),
          ),
          child: ExpansionTile(
            shape: const Border(),
            collapsedShape: const Border(),
            leading: Icon(statusIcon, color: statusColor),
            title: Text(message.toolTitle ?? message.toolName ?? 'Tool'),
            subtitle: message.text.isEmpty ? null : Text(message.text),
            trailing: message.toolRunning
                ? SizedBox.square(
                    dimension: _T4Size.indicator,
                    child: CircularProgressIndicator(
                      value: message.toolProgress,
                      strokeWidth: _T4Size.thinStroke,
                    ),
                  )
                : null,
            childrenPadding: const EdgeInsets.fromLTRB(
              _T4Space.md,
              0,
              _T4Space.md,
              _T4Space.md,
            ),
            children: [
              if (message.toolArguments case final arguments?)
                _ToolPayload(label: 'Arguments', value: arguments),
              if (message.toolOutput case final output?)
                _ToolPayload(label: 'Result', value: output),
            ],
          ),
        ),
      ),
    );
  }
}

final class _ToolPayload extends StatelessWidget {
  const _ToolPayload({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(top: _T4Space.sm),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            label.toUpperCase(),
            style: Theme.of(context).textTheme.labelSmall,
          ),
          const SizedBox(height: _T4Space.xs),
          DecoratedBox(
            decoration: BoxDecoration(
              color: scheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(_T4Radius.sm),
            ),
            child: Padding(
              padding: const EdgeInsets.all(_T4Space.sm),
              child: SelectionArea(
                child: Text(
                  value,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    fontFamily: _T4Typography.monoFamily,
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

final class _TranscriptImage extends StatefulWidget {
  const _TranscriptImage({
    required this.entryId,
    required this.image,
    required this.actions,
  });

  final String entryId;
  final TranscriptImageMetadata image;
  final T4Actions actions;

  @override
  State<_TranscriptImage> createState() => _TranscriptImageState();
}

final class _TranscriptImageState extends State<_TranscriptImage> {
  late Future<Uint8List> _image;

  @override
  void initState() {
    super.initState();
    _image = widget.actions.readTranscriptImage(widget.entryId, widget.image);
  }

  @override
  void didUpdateWidget(covariant _TranscriptImage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.entryId != widget.entryId ||
        oldWidget.image.sha256 != widget.image.sha256) {
      _image = widget.actions.readTranscriptImage(widget.entryId, widget.image);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return FutureBuilder<Uint8List>(
      future: _image,
      builder: (context, snapshot) {
        if (snapshot.hasData) {
          return ClipRRect(
            borderRadius: BorderRadius.circular(_T4Radius.sm),
            child: Image.memory(
              snapshot.data!,
              width: 160,
              height: 120,
              fit: BoxFit.cover,
              semanticLabel: 'Transcript image',
            ),
          );
        }
        return Container(
          width: 160,
          height: 120,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: scheme.surfaceContainerLow,
            border: Border.all(color: scheme.outlineVariant),
            borderRadius: BorderRadius.circular(_T4Radius.sm),
          ),
          child: snapshot.hasError
              ? IconButton(
                  tooltip: 'Retry image',
                  onPressed: () => setState(() {
                    _image = widget.actions.readTranscriptImage(
                      widget.entryId,
                      widget.image,
                    );
                  }),
                  icon: const Icon(Icons.refresh),
                )
              : const CircularProgressIndicator(),
        );
      },
    );
  }
}

final class _PromptComposer extends StatefulWidget {
  const _PromptComposer({required this.state, required this.actions});

  final T4ViewState state;
  final T4Actions actions;

  @override
  State<_PromptComposer> createState() => _PromptComposerState();
}

final class _PromptComposerState extends State<_PromptComposer> {
  static const int _maximumImages = 8;
  static const int _maximumImageBytes = 20 * 1024 * 1024;

  final TextEditingController _textController = TextEditingController();
  final FocusNode _focusNode = FocusNode(debugLabel: 'Prompt composer');
  final Map<String, String> _drafts = <String, String>{};
  final Map<String, List<PromptImageAttachment>> _attachments =
      <String, List<PromptImageAttachment>>{};
  String? _sessionId;
  bool _hasText = false;
  bool _sending = false;

  List<PromptImageAttachment> get _currentAttachments => _sessionId == null
      ? const <PromptImageAttachment>[]
      : _attachments[_sessionId] ?? const <PromptImageAttachment>[];

  bool get _ready =>
      widget.state.connectionPhase == ConnectionPhase.ready &&
      widget.state.selectedSession != null &&
      widget.state.grantedCapabilities.contains('sessions.prompt') &&
      !widget.state.composer.isPaused &&
      !_sending;

  bool get _canSubmit =>
      _ready &&
      (_hasText || _currentAttachments.isNotEmpty) &&
      (!widget.state.composer.turnActive || _currentAttachments.isEmpty);

  bool get _canQueue => _ready && widget.state.composer.turnActive && _hasText;

  @override
  void initState() {
    super.initState();
    _sessionId = widget.state.selectedSessionId;
    _textController.addListener(_handleTextChanged);
  }

  @override
  void didUpdateWidget(covariant _PromptComposer oldWidget) {
    super.didUpdateWidget(oldWidget);
    final nextSessionId = widget.state.selectedSessionId;
    if (nextSessionId == _sessionId) return;
    final previousSessionId = _sessionId;
    if (previousSessionId != null) {
      _drafts[previousSessionId] = _textController.text;
    }
    _sessionId = nextSessionId;
    _textController.text = nextSessionId == null
        ? ''
        : _drafts[nextSessionId] ?? '';
    _textController.selection = TextSelection.collapsed(
      offset: _textController.text.length,
    );
  }

  void _handleTextChanged() {
    final sessionId = _sessionId;
    if (sessionId != null) _drafts[sessionId] = _textController.text;
    final hasText = _textController.text.trim().isNotEmpty;
    if (hasText != _hasText && mounted) {
      setState(() => _hasText = hasText);
    } else if (mounted && _textController.text.startsWith('/')) {
      setState(() {});
    }
  }

  void _showError(String message) {
    final messenger = ScaffoldMessenger.of(context);
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _submit() async {
    if (!_canSubmit) return;
    final message = _textController.text.trim();
    final attachments = List<PromptImageAttachment>.of(_currentAttachments);
    final draftAtSubmission = _textController.text;
    setState(() => _sending = true);
    try {
      final accepted = await widget.actions.submitPrompt(
        message,
        images: attachments,
      );
      if (!mounted || !accepted) return;
      if (_textController.text == draftAtSubmission) _textController.clear();
      final sessionId = _sessionId;
      if (sessionId != null) _attachments.remove(sessionId);
      _focusNode.requestFocus();
    } on Object {
      if (mounted) _showError('Could not send the prompt. Try again.');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _queue() async {
    if (!_canQueue) return;
    final message = _textController.text.trim();
    try {
      final accepted = await widget.actions.queuePrompt(message);
      if (!mounted || !accepted) return;
      _textController.clear();
      _focusNode.requestFocus();
    } on Object {
      if (mounted) _showError('Could not queue the follow-up.');
    }
  }

  Future<void> _pickImages() async {
    final available = _maximumImages - _currentAttachments.length;
    if (!_ready || available <= 0) return;
    try {
      final files = await openFiles(
        acceptedTypeGroups: const <XTypeGroup>[
          XTypeGroup(
            label: 'Images',
            extensions: <String>['png', 'jpg', 'jpeg', 'gif', 'webp'],
          ),
        ],
      );
      if (!mounted || files.isEmpty) return;
      final selected = <PromptImageAttachment>[];
      for (final file in files.take(available)) {
        final size = await file.length();
        if (size <= 0) continue;
        if (size > _maximumImageBytes) {
          _showError('${file.name} is larger than 20 MB.');
          continue;
        }
        final extension = file.name.split('.').last.toLowerCase();
        final mimeType = switch (extension) {
          'png' => 'image/png',
          'jpg' || 'jpeg' => 'image/jpeg',
          'gif' => 'image/gif',
          'webp' => 'image/webp',
          _ => null,
        };
        if (mimeType == null) continue;
        final bytes = await file.readAsBytes();
        selected.add(
          PromptImageAttachment(
            id: '${DateTime.now().microsecondsSinceEpoch}-${file.name}',
            name: file.name,
            mimeType: mimeType,
            bytes: bytes,
          ),
        );
      }
      final sessionId = _sessionId;
      if (sessionId != null && selected.isNotEmpty) {
        setState(() {
          _attachments[sessionId] = <PromptImageAttachment>[
            ..._currentAttachments,
            ...selected,
          ];
        });
      }
    } on Object {
      if (mounted) _showError('Could not open the selected image.');
    }
  }

  void _removeAttachment(String id) {
    final sessionId = _sessionId;
    if (sessionId == null) return;
    setState(() {
      _attachments[sessionId] = _currentAttachments
          .where((attachment) => attachment.id != id)
          .toList(growable: false);
    });
  }

  void _selectSlashCommand(ComposerSlashCommand command) {
    if (command.disabledReason != null) return;
    _textController
      ..text = command.insert
      ..selection = TextSelection.collapsed(offset: command.insert.length);
    _focusNode.requestFocus();
  }

  Future<void> _runControl(Future<void> Function() operation) async {
    try {
      await operation();
    } on Object {
      if (mounted) _showError('Could not update the session control.');
    }
  }

  @override
  void dispose() {
    _textController
      ..removeListener(_handleTextChanged)
      ..dispose();
    _focusNode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final composer = widget.state.composer;
    final showControls =
        widget.state.selectedSession != null &&
        widget.state.grantedCapabilities.contains('sessions.control');
    final canControl =
        showControls &&
        widget.state.connectionPhase == ConnectionPhase.ready &&
        widget.state.grantedCapabilities.contains('sessions.control') &&
        !widget.state.sessionOperationPending;
    final slashQuery = _textController.text.startsWith('/')
        ? _textController.text.split(RegExp(r'\s')).first.toLowerCase()
        : '';
    final slashCommands = slashQuery.isEmpty
        ? const <ComposerSlashCommand>[]
        : composer.slashCommands
              .where(
                (command) =>
                    command.name.toLowerCase().contains(slashQuery) ||
                    command.aliases.any(
                      (alias) => alias.toLowerCase().contains(slashQuery),
                    ),
              )
              .take(5)
              .toList(growable: false);

    return DecoratedBox(
      decoration: BoxDecoration(color: scheme.surface),
      child: SafeArea(
        top: false,
        minimum: const EdgeInsets.fromLTRB(
          _T4Space.md,
          _T4Space.sm,
          _T4Space.md,
          _T4Space.sm,
        ),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              maxWidth: _T4Layout.contentMaxWidth,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (slashCommands.isNotEmpty)
                  Card(
                    margin: const EdgeInsets.only(bottom: _T4Space.xs),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        for (final command in slashCommands)
                          ListTile(
                            dense: true,
                            visualDensity: VisualDensity.compact,
                            enabled: command.disabledReason == null,
                            title: Text(
                              command.name,
                              style: const TextStyle(fontSize: 12),
                            ),
                            subtitle: Text(
                              command.disabledReason ??
                                  (command.aliases.isEmpty
                                      ? command.description
                                      : '${command.description} · ${command.aliases.join(' ')}'),
                              style: const TextStyle(fontSize: 12),
                            ),
                            onTap: command.disabledReason == null
                                ? () => _selectSlashCommand(command)
                                : null,
                          ),
                      ],
                    ),
                  ),
                // Single Codex-style composer container: text field on top,
                // controls embedded along the bottom edge.
                Container(
                  decoration: BoxDecoration(
                    color: scheme.surface,
                    borderRadius: BorderRadius.circular(_composerRadius),
                    border: Border.all(color: scheme.outlineVariant),
                  ),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (_currentAttachments.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.fromLTRB(
                            _T4Space.sm,
                            _T4Space.xs,
                            _T4Space.sm,
                            0,
                          ),
                          child: SizedBox(
                            height: 72,
                            child: ListView.separated(
                              scrollDirection: Axis.horizontal,
                              itemCount: _currentAttachments.length,
                              separatorBuilder: (context, index) =>
                                  const SizedBox(width: _T4Space.xs),
                              itemBuilder: (context, index) {
                                final attachment = _currentAttachments[index];
                                return InputChip(
                                  visualDensity: VisualDensity.compact,
                                  labelStyle: const TextStyle(fontSize: 12),
                                  avatar: ClipRRect(
                                    borderRadius: BorderRadius.circular(
                                      _T4Radius.sm,
                                    ),
                                    child: Image.memory(
                                      attachment.bytes,
                                      width: 40,
                                      height: 40,
                                      fit: BoxFit.cover,
                                    ),
                                  ),
                                  label: ConstrainedBox(
                                    constraints: const BoxConstraints(
                                      maxWidth: 120,
                                    ),
                                    child: Text(
                                      attachment.name,
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  ),
                                  onDeleted: _sending
                                      ? null
                                      : () => _removeAttachment(attachment.id),
                                );
                              },
                            ),
                          ),
                        ),
                      CallbackShortcuts(
                        bindings: <ShortcutActivator, VoidCallback>{
                          const SingleActivator(LogicalKeyboardKey.enter): () =>
                              unawaited(_submit()),
                        },
                        child: Semantics(
                          textField: true,
                          label: 'Prompt message',
                          child: TextField(
                            controller: _textController,
                            focusNode: _focusNode,
                            readOnly: _sending,
                            minLines: 1,
                            maxLines: 6,
                            keyboardType: TextInputType.multiline,
                            textInputAction: TextInputAction.newline,
                            decoration: InputDecoration(
                              hintText: widget.state.selectedSession == null
                                  ? 'Choose a session to begin'
                                  : composer.isPaused
                                  ? 'Resume the session to continue'
                                  : composer.turnActive
                                  ? 'Steer the active turn'
                                  : 'Message T4',
                              isDense: true,
                              filled: false,
                              border: InputBorder.none,
                              enabledBorder: InputBorder.none,
                              focusedBorder: InputBorder.none,
                              disabledBorder: InputBorder.none,
                              contentPadding: const EdgeInsets.fromLTRB(
                                _T4Space.md,
                                _T4Space.sm,
                                _T4Space.md,
                                _T4Space.xs,
                              ),
                            ),
                          ),
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.fromLTRB(
                          _T4Space.xxs,
                          0,
                          _T4Space.xs,
                          _T4Space.xxs,
                        ),
                        child: Wrap(
                          alignment: WrapAlignment.spaceBetween,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          runSpacing: _T4Space.xxs,
                          children: [
                            Wrap(
                              spacing: _T4Space.xxs,
                              runSpacing: _T4Space.xxs,
                              crossAxisAlignment: WrapCrossAlignment.center,
                              children: [
                                IconButton(
                                  tooltip: 'Attach image',
                                  visualDensity: VisualDensity.compact,
                                  iconSize: 18,
                                  onPressed:
                                      _ready &&
                                          _currentAttachments.length <
                                              _maximumImages
                                      ? () => unawaited(_pickImages())
                                      : null,
                                  icon: const Icon(Icons.attach_file),
                                ),
                                if (showControls && composer.isPaused)
                                  _ComposerQuietButton(
                                    icon: Icons.play_arrow,
                                    label: 'Resume',
                                    onPressed: canControl
                                        ? () => unawaited(
                                            _runControl(
                                              widget.actions.resumeSession,
                                            ),
                                          )
                                        : null,
                                  )
                                else if (showControls && composer.turnActive)
                                  _ComposerQuietButton(
                                    icon: Icons.pause,
                                    label: 'Pause',
                                    onPressed: canControl
                                        ? () => unawaited(
                                            _runControl(
                                              widget.actions.pauseSession,
                                            ),
                                          )
                                        : null,
                                  ),
                                if (composer.turnActive) ...[
                                  _ComposerQuietButton(
                                    icon: Icons.stop,
                                    label: 'Stop',
                                    onPressed: () => unawaited(
                                      _runControl(widget.actions.cancelTurn),
                                    ),
                                  ),
                                  _ComposerQuietButton(
                                    icon: Icons.playlist_add,
                                    label: composer.queuedFollowUpCount == 0
                                        ? 'Queue'
                                        : 'Queue (${composer.queuedFollowUpCount})',
                                    onPressed: _canQueue
                                        ? () => unawaited(_queue())
                                        : null,
                                  ),
                                ],
                              ],
                            ),
                            Wrap(
                              spacing: _T4Space.xxs,
                              runSpacing: _T4Space.xxs,
                              crossAxisAlignment: WrapCrossAlignment.center,
                              children: [
                                _AccessSummaryPill(state: widget.state),
                                _ThinkingSelectorMenu(
                                  composer: composer,
                                  onSelect: (level) => unawaited(
                                    _runControl(
                                      () => widget.actions.setSessionThinking(
                                        level,
                                      ),
                                    ),
                                  ),
                                ),
                                _ModelSelectorMenu(
                                  composer: composer,
                                  onSelect: (selector) => unawaited(
                                    _runControl(
                                      () => widget.actions.setSessionModel(
                                        selector,
                                      ),
                                    ),
                                  ),
                                  onToggleFast: (enabled) => unawaited(
                                    _runControl(
                                      () => widget.actions.setSessionFast(
                                        enabled,
                                      ),
                                    ),
                                  ),
                                  showCompact:
                                      showControls &&
                                      !composer.isPaused &&
                                      !composer.turnActive,
                                  onCompact: canControl
                                      ? () => unawaited(
                                          _runControl(
                                            widget.actions.compactSession,
                                          ),
                                        )
                                      : null,
                                ),
                                SizedBox.square(
                                  dimension: _composerSendSize,
                                  child: IconButton.filled(
                                    tooltip: composer.turnActive
                                        ? 'Steer'
                                        : 'Send',
                                    style: IconButton.styleFrom(
                                      minimumSize: const Size.square(
                                        _composerSendSize,
                                      ),
                                      fixedSize: const Size.square(
                                        _composerSendSize,
                                      ),
                                      padding: EdgeInsets.zero,
                                      tapTargetSize:
                                          MaterialTapTargetSize.shrinkWrap,
                                    ),
                                    iconSize: 16,
                                    onPressed: _canSubmit
                                        ? () => unawaited(_submit())
                                        : null,
                                    icon: _sending
                                        ? const SizedBox.square(
                                            dimension: 14,
                                            child: CircularProgressIndicator(
                                              strokeWidth: _T4Size.thinStroke,
                                              semanticsLabel: 'Sending',
                                            ),
                                          )
                                        : const Icon(Icons.arrow_upward),
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Composer control metrics shared by the redesigned prompt container.
const double _composerRadius = 12;
const double _composerSendSize = 32;

/// Shared style for composer selector menus. The pills sit on the bottom edge
/// of a bottom-docked composer, so the menu layout always flips the surface
/// upward above the anchor (with the [Offset] gap) instead of clipping below
/// or overlapping the text field row.
const MenuStyle _composerMenuStyle = MenuStyle(
  visualDensity: VisualDensity.compact,
  maximumSize: WidgetStatePropertyAll<Size?>(Size(280, 360)),
);
const Offset _composerMenuOffset = Offset(0, _T4Space.xs);

final ButtonStyle _composerMenuItemStyle = MenuItemButton.styleFrom(
  visualDensity: VisualDensity.compact,
  textStyle: const TextStyle(fontSize: 12),
  minimumSize: const Size.fromHeight(36),
);

/// Quiet 12 px text control for the composer's turn controls
/// (pause/resume/stop/queue).
final class _ComposerQuietButton extends StatelessWidget {
  const _ComposerQuietButton({
    required this.icon,
    required this.label,
    required this.onPressed,
  });

  final IconData icon;
  final String label;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return TextButton(
      onPressed: onPressed,
      style: TextButton.styleFrom(
        foregroundColor: scheme.onSurfaceVariant,
        textStyle: const TextStyle(fontSize: 12),
        visualDensity: VisualDensity.compact,
        padding: const EdgeInsets.symmetric(
          horizontal: _T4Space.xs,
          vertical: _T4Space.xxs,
        ),
        minimumSize: Size.zero,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        shape: const StadiumBorder(),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14),
          const SizedBox(width: _T4Space.xxs),
          Flexible(
            child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis),
          ),
        ],
      ),
    );
  }
}

/// Quiet pill anchor shared by the thinking and model selector menus.
final class _ComposerPill extends StatelessWidget {
  const _ComposerPill({
    required this.label,
    required this.onTap,
    this.maxLabelWidth,
    this.tooltip,
  });

  final String label;
  final VoidCallback? onTap;
  final double? maxLabelWidth;
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final enabled = onTap != null;
    final color = enabled ? scheme.onSurfaceVariant : scheme.outline;
    Widget pill = Material(
      color: Colors.transparent,
      shape: const StadiumBorder(),
      child: InkWell(
        customBorder: const StadiumBorder(),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: _T4Space.xs,
            vertical: _T4Space.xxs + 1,
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              ConstrainedBox(
                constraints: BoxConstraints(
                  maxWidth: maxLabelWidth ?? double.infinity,
                ),
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12, color: color),
                ),
              ),
              const SizedBox(width: 2),
              Icon(Icons.keyboard_arrow_up, size: 14, color: color),
            ],
          ),
        ),
      ),
    );
    if (tooltip case final message?) {
      pill = Tooltip(message: message, child: pill);
    }
    return pill;
  }
}

/// Thinking-level selector as a quiet pill; the menu opens upward above the
/// pill and never overlaps the text field.
final class _ThinkingSelectorMenu extends StatelessWidget {
  const _ThinkingSelectorMenu({required this.composer, required this.onSelect});

  final SessionComposerState composer;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final enabled = composer.thinkingLevels.isNotEmpty;
    return Semantics(
      label: 'Thinking: ${composer.thinking ?? 'Default'}',
      button: true,
      child: MenuAnchor(
        style: _composerMenuStyle,
        alignmentOffset: _composerMenuOffset,
        menuChildren: <Widget>[
          for (final level in composer.thinkingLevels)
            MenuItemButton(
              key: ValueKey<String>('thinking-$level'),
              style: _composerMenuItemStyle,
              leadingIcon: composer.thinking == level
                  ? Icon(
                      Icons.check,
                      size: 16,
                      color: theme.colorScheme.primary,
                    )
                  : null,
              onPressed: () => onSelect(level),
              child: Text(level),
            ),
        ],
        builder: (context, controller, child) => _ComposerPill(
          label: composer.thinking ?? 'Thinking',
          maxLabelWidth: 88,
          tooltip: 'Choose thinking level',
          onTap: enabled ? () => _toggleMenu(controller) : null,
        ),
      ),
    );
  }
}

void _toggleMenu(MenuController controller) {
  if (controller.isOpen) {
    controller.close();
  } else {
    controller.open();
  }
}

/// Provider-grouped model selector for the composer.
///
/// Replaces the giant flat catalog list with a navigable provider → model menu
/// that mirrors the Electron/web T4 model picker. Human model names render as
/// the primary label; raw `provider/modelId` selectors are carried through as
/// the submitted values. Unknown providers/models stay selectable under an
/// 'Other models' group. A single-provider host collapses to a flat list so
/// the user is never forced through a one-item submenu.
///
/// The menu also hosts the session's Fast toggle (checkable item) and the
/// manual Compact action, so the pill stays enabled whenever any of those
/// entries are present.
final class _ModelSelectorMenu extends StatelessWidget {
  const _ModelSelectorMenu({
    required this.composer,
    required this.onSelect,
    this.onToggleFast,
    this.showCompact = false,
    this.onCompact,
  });

  final SessionComposerState composer;
  final ValueChanged<String> onSelect;

  /// Receives the requested Fast state; the item only renders when the host
  /// advertises Fast availability.
  final ValueChanged<bool>? onToggleFast;
  final bool showCompact;
  final VoidCallback? onCompact;

  @override
  Widget build(BuildContext context) {
    final groups = composer.modelGroups;
    final hasModels = groups.any((group) => group.choices.isNotEmpty);
    final showFast = composer.fastAvailable && onToggleFast != null;
    final enabled = hasModels || showFast || showCompact;
    final theme = Theme.of(context);
    return Semantics(
      label: 'Model: ${composer.modelLabel ?? 'None'}',
      button: true,
      child: MenuAnchor(
        style: _composerMenuStyle,
        alignmentOffset: _composerMenuOffset,
        menuChildren: <Widget>[
          if (groups.length == 1)
            for (final choice in groups.single.choices)
              _modelItem(choice, theme)
          else
            for (final group in groups)
              if (group.choices.isNotEmpty)
                SubmenuButton(
                  key: ValueKey<String>('model-provider-${group.provider}'),
                  style: _composerMenuItemStyle,
                  menuStyle: _composerMenuStyle,
                  leadingIcon: const Icon(Icons.folder_outlined, size: 18),
                  menuChildren: <Widget>[
                    for (final choice in group.choices)
                      _modelItem(choice, theme),
                  ],
                  child: Text(group.label, overflow: TextOverflow.ellipsis),
                ),
          if (hasModels && (showFast || showCompact)) const Divider(height: 1),
          if (showFast)
            CheckboxMenuButton(
              value: composer.fastEnabled,
              style: _composerMenuItemStyle,
              onChanged: (checked) => onToggleFast!(checked ?? false),
              child: const Text('Fast'),
            ),
          if (showCompact)
            MenuItemButton(
              style: _composerMenuItemStyle,
              leadingIcon: const Icon(Icons.compress, size: 16),
              onPressed: onCompact,
              child: const Text('Compact'),
            ),
        ],
        builder: (context, controller, child) => _ComposerPill(
          label: composer.modelLabel ?? 'Model',
          maxLabelWidth: 120,
          tooltip: 'Choose model',
          onTap: enabled ? () => _toggleMenu(controller) : null,
        ),
      ),
    );
  }

  Widget _modelItem(ResolvedModelChoice choice, ThemeData theme) {
    final selected = composer.modelSelector == choice.selector;
    final label = choice.supported
        ? choice.label
        : '${choice.label} · ${choice.reason ?? 'Unavailable'}';
    return MenuItemButton(
      key: ValueKey<String>('model-${choice.selector}'),
      style: _composerMenuItemStyle,
      onPressed: choice.supported ? () => onSelect(choice.selector) : null,
      leadingIcon: selected
          ? Icon(Icons.check, size: 18, color: theme.colorScheme.primary)
          : null,
      child: Text(label, overflow: TextOverflow.ellipsis),
    );
  }
}

/// Informational access pill for the composer controls: summarizes the
/// capabilities the host actually granted. Selection is a no-op — the wire
/// protocol has no capability-mutation command.
final class _AccessSummaryPill extends StatelessWidget {
  const _AccessSummaryPill({required this.state});

  final T4ViewState state;

  /// Display order and labels for the summarized capability groups, keyed by
  /// the capability prefix used on the wire (`term.input`, `files.write`, …).
  static const Map<String, String> _groupLabels = <String, String>{
    'files': 'Files',
    'term': 'Terminal',
    'preview': 'Preview',
    'sessions': 'Sessions',
    'usage': 'Usage',
  };

  static List<AccessModeOption> _options(Set<String> granted) {
    final byGroup = <String, List<String>>{};
    for (final capability in granted) {
      final prefix = capability.split('.').first;
      if (!_groupLabels.containsKey(prefix)) continue;
      byGroup.putIfAbsent(prefix, () => <String>[]).add(capability);
    }
    return <AccessModeOption>[
      for (final entry in _groupLabels.entries)
        if (byGroup[entry.key] case final capabilities?)
          AccessModeOption(
            id: entry.key,
            label: entry.value,
            detail: (capabilities..sort()).join(', '),
            selected: true,
          ),
    ];
  }

  @override
  Widget build(BuildContext context) {
    final granted = state.grantedCapabilities;
    final canWriteFiles = granted.contains('files.write');
    final label = canWriteFiles && granted.contains('term.input')
        ? 'Full access'
        : canWriteFiles
        ? 'Write access'
        : 'Read only';
    return Tooltip(
      message: 'Granted permissions',
      child: AccessModeSelector(
        label: label,
        options: _options(granted),
        onSelected: (_) {},
        enabled: state.connectionPhase == ConnectionPhase.ready,
        readOnly: true,
      ),
    );
  }
}
