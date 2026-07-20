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
  });

  final T4ViewState state;
  final T4Actions actions;
  final bool showHeader;
  final Future<void> Function() onConnect;
  final VoidCallback? onOpenSessions;
  final VoidCallback onOpenAttention;
  final VoidCallback onOpenDeveloper;

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
            onOpenAttention: onOpenAttention,
            onOpenDeveloper: onOpenDeveloper,
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
          ),
        ),
        _PromptComposer(state: state, actions: actions),
      ],
    );
  }
}

final class _ConversationHeader extends StatelessWidget {
  const _ConversationHeader({
    required this.state,
    required this.onOpenAttention,
    required this.onOpenDeveloper,
  });

  final T4ViewState state;
  final VoidCallback onOpenAttention;
  final VoidCallback onOpenDeveloper;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
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
              onPressed: onOpenDeveloper,
              tooltip: 'Open developer tools',
              icon: const Icon(Icons.code),
            ),
            Badge(
              isLabelVisible: state.urgentAttentionCount > 0,
              label: Text('${state.urgentAttentionCount}'),
              child: IconButton(
                onPressed: onOpenAttention,
                tooltip: 'Open inbox',
                icon: const Icon(Icons.inbox_outlined),
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
    this.onOpenSessions,
  });

  final T4ViewState state;
  final T4Actions actions;
  final VoidCallback? onOpenSessions;

  @override
  State<_TranscriptView> createState() => _TranscriptViewState();
}

final class _TranscriptViewState extends State<_TranscriptView> {
  final ScrollController _scrollController = ScrollController();
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
    if (notification is ScrollStartNotification &&
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
                  itemCount: widget.state.messages.length + messageOffset,
                  separatorBuilder: (context, index) =>
                      const SizedBox(height: _T4Space.lg),
                  itemBuilder: (context, index) {
                    if (showHistoryControl && index == 0) {
                      return _TranscriptHistoryControl(
                        loading: widget.state.transcriptHistoryLoading,
                        hasMore: widget.state.transcriptHistoryHasMore,
                        error: widget.state.transcriptHistoryError,
                        onLoad: widget.actions.loadEarlierTranscript,
                      );
                    }
                    return _TranscriptMessageView(
                      message: widget.state.messages[index - messageOffset],
                      actions: widget.actions,
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
    final background = isUser
        ? scheme.surfaceContainerHigh
        : isAuxiliary
        ? scheme.surfaceContainerLow
        : Colors.transparent;

    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: _T4Layout.contentMaxWidth),
        child: Semantics(
          container: true,
          label: '$label message${message.streaming ? ', streaming' : ''}',
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: background,
              borderRadius: BorderRadius.circular(_T4Radius.md),
              border: isAuxiliary
                  ? Border.all(color: scheme.outlineVariant)
                  : null,
            ),
            child: Padding(
              padding: isUser || isAuxiliary
                  ? const EdgeInsets.all(_T4Space.md)
                  : const EdgeInsets.symmetric(vertical: _T4Space.xs),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    label.toUpperCase(),
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                  if (message.reasoning.isNotEmpty) ...[
                    const SizedBox(height: _T4Space.xs),
                    _ReasoningDisclosure(
                      reasoning: message.reasoning,
                      streaming: message.streaming,
                    ),
                  ],
                  if (message.text.isNotEmpty) ...[
                    const SizedBox(height: _T4Space.xs),
                    MarkdownBody(data: message.text, selectable: true),
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
          ),
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
        children: [MarkdownBody(data: reasoning, selectable: true)],
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
    final slashQuery = _textController.text.startsWith('/')
        ? _textController.text.split(RegExp(r'\s')).first.toLowerCase()
        : '';
    final slashCommands = slashQuery.isEmpty
        ? const <ComposerSlashCommand>[]
        : composer.slashCommands
              .where(
                (command) => command.name.toLowerCase().contains(slashQuery),
              )
              .take(5)
              .toList(growable: false);

    return DecoratedBox(
      decoration: BoxDecoration(
        color: scheme.surface,
        border: Border(top: BorderSide(color: scheme.outlineVariant)),
      ),
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
                            enabled: command.disabledReason == null,
                            title: Text(command.name),
                            subtitle: Text(
                              command.disabledReason ?? command.description,
                            ),
                            onTap: command.disabledReason == null
                                ? () => _selectSlashCommand(command)
                                : null,
                          ),
                      ],
                    ),
                  ),
                if (_currentAttachments.isNotEmpty)
                  SizedBox(
                    height: 72,
                    child: ListView.separated(
                      scrollDirection: Axis.horizontal,
                      itemCount: _currentAttachments.length,
                      separatorBuilder: (context, index) =>
                          const SizedBox(width: _T4Space.xs),
                      itemBuilder: (context, index) {
                        final attachment = _currentAttachments[index];
                        return InputChip(
                          avatar: ClipRRect(
                            borderRadius: BorderRadius.circular(_T4Radius.sm),
                            child: Image.memory(
                              attachment.bytes,
                              width: 40,
                              height: 40,
                              fit: BoxFit.cover,
                            ),
                          ),
                          label: ConstrainedBox(
                            constraints: const BoxConstraints(maxWidth: 120),
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
                Wrap(
                  spacing: _T4Space.xs,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    _ModelSelectorMenu(
                      composer: composer,
                      onSelect: (selector) => unawaited(
                        _runControl(
                          () => widget.actions.setSessionModel(selector),
                        ),
                      ),
                    ),
                    PopupMenuButton<String>(
                      tooltip: 'Choose thinking level',
                      enabled: composer.thinkingLevels.isNotEmpty,
                      onSelected: (level) => unawaited(
                        _runControl(
                          () => widget.actions.setSessionThinking(level),
                        ),
                      ),
                      itemBuilder: (context) => [
                        for (final level in composer.thinkingLevels)
                          PopupMenuItem<String>(
                            value: level,
                            child: Text(level),
                          ),
                      ],
                      child: Chip(
                        avatar: const Icon(Icons.psychology_outlined, size: 20),
                        label: Text(composer.thinking ?? 'Thinking'),
                      ),
                    ),
                    if (composer.fastAvailable)
                      FilterChip(
                        label: Text(
                          'Fast',
                          style: TextStyle(
                            color: composer.fastEnabled
                                ? null
                                : scheme.onSurfaceVariant,
                          ),
                        ),
                        selected: composer.fastEnabled,
                        onSelected: (enabled) => unawaited(
                          _runControl(
                            () => widget.actions.setSessionFast(enabled),
                          ),
                        ),
                      ),
                    if (composer.turnActive) ...[
                      ActionChip(
                        avatar: const Icon(Icons.stop, size: 20),
                        label: const Text('Stop'),
                        onPressed: () =>
                            unawaited(_runControl(widget.actions.cancelTurn)),
                      ),
                      ActionChip(
                        avatar: const Icon(Icons.playlist_add, size: 20),
                        label: Text(
                          composer.queuedFollowUpCount == 0
                              ? 'Queue'
                              : 'Queue (${composer.queuedFollowUpCount})',
                        ),
                        onPressed: _canQueue ? () => unawaited(_queue()) : null,
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: _T4Space.xs),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    IconButton(
                      tooltip: 'Attach image',
                      onPressed:
                          _ready && _currentAttachments.length < _maximumImages
                          ? () => unawaited(_pickImages())
                          : null,
                      icon: const Icon(Icons.attach_file),
                    ),
                    Expanded(
                      child: CallbackShortcuts(
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
                                  : composer.turnActive
                                  ? 'Steer the active turn'
                                  : 'Message T4',
                            ),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: _T4Space.xs),
                    FilledButton(
                      onPressed: _canSubmit ? () => unawaited(_submit()) : null,
                      child: _sending
                          ? const SizedBox.square(
                              dimension: _T4Size.indicator,
                              child: CircularProgressIndicator(
                                strokeWidth: _T4Size.thinStroke,
                                semanticsLabel: 'Sending',
                              ),
                            )
                          : Text(composer.turnActive ? 'Steer' : 'Send'),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
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
final class _ModelSelectorMenu extends StatelessWidget {
  const _ModelSelectorMenu({required this.composer, required this.onSelect});

  final SessionComposerState composer;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    final groups = composer.modelGroups;
    final enabled = groups.any((group) => group.choices.isNotEmpty);
    final theme = Theme.of(context);
    final menuStyle = MenuStyle(
      visualDensity: VisualDensity.compact,
      maximumSize: const WidgetStatePropertyAll<Size?>(Size(280, 360)),
    );
    final itemStyle = MenuItemButton.styleFrom(
      visualDensity: VisualDensity.compact,
      minimumSize: const Size.fromHeight(44),
    );
    return Semantics(
      label: 'Model: ${composer.modelLabel ?? 'None'}',
      button: true,
      child: MenuAnchor(
        style: menuStyle,
        alignmentOffset: const Offset(0, 8),
        menuChildren: <Widget>[
          if (groups.length == 1)
            for (final choice in groups.single.choices)
              _modelItem(choice, theme, itemStyle)
          else
            for (final group in groups)
              if (group.choices.isNotEmpty)
                SubmenuButton(
                  key: ValueKey<String>('model-provider-${group.provider}'),
                  style: itemStyle,
                  menuStyle: menuStyle,
                  leadingIcon: const Icon(Icons.folder_outlined, size: 18),
                  menuChildren: <Widget>[
                    for (final choice in group.choices)
                      _modelItem(choice, theme, itemStyle),
                  ],
                  child: Text(group.label, overflow: TextOverflow.ellipsis),
                ),
        ],
        builder: (context, controller, child) {
          return ActionChip(
            avatar: const Icon(Icons.memory, size: 20),
            label: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 140),
              child: Text(
                composer.modelLabel ?? 'Model',
                overflow: TextOverflow.ellipsis,
              ),
            ),
            onPressed: enabled ? () => _open(controller) : null,
          );
        },
      ),
    );
  }

  void _open(MenuController controller) {
    if (controller.isOpen) {
      controller.close();
    } else {
      controller.open();
    }
  }

  Widget _modelItem(
    ResolvedModelChoice choice,
    ThemeData theme,
    ButtonStyle itemStyle,
  ) {
    final selected = composer.modelSelector == choice.selector;
    final label = choice.supported
        ? choice.label
        : '${choice.label} · ${choice.reason ?? 'Unavailable'}';
    return MenuItemButton(
      key: ValueKey<String>('model-${choice.selector}'),
      style: itemStyle,
      onPressed: choice.supported ? () => onSelect(choice.selector) : null,
      leadingIcon: selected
          ? Icon(Icons.check, size: 18, color: theme.colorScheme.primary)
          : null,
      child: Text(label, overflow: TextOverflow.ellipsis),
    );
  }
}
