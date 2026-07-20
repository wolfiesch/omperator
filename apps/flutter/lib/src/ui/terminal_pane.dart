part of 't4_app.dart';

const int _terminalScrollbackLines = 5000;
const int _terminalOutputOverlapProbeLength = 64;
const int _terminalPastePreviewCharacters = 1000;
const int _terminalPastePreviewLines = 8;

final class _TerminalPane extends StatefulWidget {
  const _TerminalPane({required this.state, required this.actions});

  final T4ViewState state;
  final T4Actions actions;

  @override
  State<_TerminalPane> createState() => _TerminalPaneState();
}

final class _TerminalPaneState extends State<_TerminalPane> {
  final Map<String, _TerminalBinding> _bindings = <String, _TerminalBinding>{};
  String? _selectedTerminalId;
  bool _opening = false;
  bool _reconnecting = false;

  @override
  void initState() {
    super.initState();
    _selectedTerminalId = _preferredTerminalId(widget.state);
    _synchronizeBindings();
  }

  @override
  void didUpdateWidget(covariant _TerminalPane oldWidget) {
    super.didUpdateWidget(oldWidget);
    _synchronizeBindings();

    final availableIds = widget.state.terminals
        .map((terminal) => terminal.terminalId)
        .toSet();
    final selectedStillExists = availableIds.contains(_selectedTerminalId);
    final activeId = widget.state.activeTerminalId;
    final activeWasAdded =
        activeId != null &&
        !oldWidget.state.terminals.any(
          (terminal) => terminal.terminalId == activeId,
        );

    if (!selectedStillExists || activeWasAdded) {
      _selectedTerminalId = _preferredTerminalId(widget.state);
    }
  }

  String? _preferredTerminalId(T4ViewState state) {
    final activeId = state.activeTerminalId;
    if (activeId != null &&
        state.terminals.any((terminal) => terminal.terminalId == activeId)) {
      return activeId;
    }
    return state.terminals.isEmpty ? null : state.terminals.first.terminalId;
  }

  void _synchronizeBindings() {
    final currentIds = widget.state.terminals
        .map((terminal) => terminal.terminalId)
        .toSet();
    final removedIds = _bindings.keys
        .where((terminalId) => !currentIds.contains(terminalId))
        .toList(growable: false);
    for (final terminalId in removedIds) {
      _bindings.remove(terminalId)?.dispose();
    }

    for (final session in widget.state.terminals) {
      final binding = _bindings.putIfAbsent(
        session.terminalId,
        () => _TerminalBinding(
          terminalId: session.terminalId,
          onOutput: _forwardOutput,
          onResize: _forwardResize,
        ),
      );
      _appendUnseenOutput(binding, session.output);
    }
  }

  void _appendUnseenOutput(_TerminalBinding binding, String output) {
    final initialSynchronization = !binding.hasSynchronizedOutput;
    final previous = binding.modelOutput;
    if (output == previous) {
      binding.hasSynchronizedOutput = true;
      return;
    }

    var unseenStart = 0;
    var resetBaseline = false;
    if (output.startsWith(previous)) {
      unseenStart = previous.length;
    } else {
      unseenStart = _terminalOutputOverlap(previous, output);
      resetBaseline = unseenStart == 0 && previous.isNotEmpty;
    }

    final unseen = output.substring(unseenStart);
    binding.modelOutput = output;
    binding.hasSynchronizedOutput = true;
    if (unseen.isEmpty && !resetBaseline) return;

    binding.replayingInitialOutput = initialSynchronization || resetBaseline;
    try {
      if (resetBaseline) _clearTerminal(binding.terminal);
      binding.terminal.write(unseen);
    } finally {
      binding.replayingInitialOutput = false;
    }
  }

  void _clearTerminal(Terminal terminal) {
    terminal.useMainBuffer();
    terminal.mainBuffer.clear();
    terminal.clearAltBuffer();
    terminal.setCursor(0, 0);
    terminal.resetCursorStyle();
  }

  int _terminalOutputOverlap(String previous, String current) {
    final maximum = previous.length < current.length
        ? previous.length
        : current.length;
    if (maximum == 0) return 0;

    final probeLength = maximum < _terminalOutputOverlapProbeLength
        ? maximum
        : _terminalOutputOverlapProbeLength;
    final probe = current.substring(0, probeLength);
    var candidate = previous.indexOf(probe, previous.length - maximum);
    while (candidate >= 0) {
      final overlap = previous.length - candidate;
      if (overlap <= current.length &&
          _regionsMatch(previous, candidate, current, overlap)) {
        return overlap;
      }
      candidate = previous.indexOf(probe, candidate + 1);
    }
    for (var overlap = probeLength - 1; overlap > 0; overlap -= 1) {
      if (_regionsMatch(
        previous,
        previous.length - overlap,
        current,
        overlap,
      )) {
        return overlap;
      }
    }
    return 0;
  }

  bool _regionsMatch(
    String previous,
    int previousStart,
    String current,
    int length,
  ) {
    for (var index = 0; index < length; index += 1) {
      if (previous.codeUnitAt(previousStart + index) !=
          current.codeUnitAt(index)) {
        return false;
      }
    }
    return true;
  }

  TerminalSession? _sessionFor(String terminalId) {
    for (final session in widget.state.terminals) {
      if (session.terminalId == terminalId) return session;
    }
    return null;
  }

  TerminalSession? get _selectedSession {
    final terminalId = _selectedTerminalId;
    return terminalId == null ? null : _sessionFor(terminalId);
  }

  bool _canInput(TerminalSession session) =>
      session.running &&
      widget.state.connectionPhase == ConnectionPhase.ready &&
      widget.state.grantedCapabilities.contains('term.input');

  bool _canResize(TerminalSession session) =>
      session.running &&
      widget.state.connectionPhase == ConnectionPhase.ready &&
      widget.state.grantedCapabilities.contains('term.resize');

  bool get _canOpen =>
      widget.state.selectedSession != null &&
      widget.state.connectionPhase == ConnectionPhase.ready &&
      widget.state.grantedCapabilities.contains('term.open') &&
      !widget.state.developerOperationPending &&
      !_opening;

  void _forwardOutput(String terminalId, String data) {
    final binding = _bindings[terminalId];
    final session = _sessionFor(terminalId);
    if (binding == null ||
        binding.replayingInitialOutput ||
        session == null ||
        !_canInput(session)) {
      return;
    }
    widget.actions.sendTerminalInput(terminalId, data);
  }

  void _forwardResize(String terminalId, int columns, int rows) {
    final binding = _bindings[terminalId];
    final session = _sessionFor(terminalId);
    if (binding == null ||
        session == null ||
        !_canResize(session) ||
        (binding.lastColumns == columns && binding.lastRows == rows)) {
      return;
    }
    binding
      ..lastColumns = columns
      ..lastRows = rows;
    widget.actions.resizeTerminal(terminalId, columns, rows);
  }

  Future<void> _openTerminal() async {
    if (!_canOpen) return;
    setState(() => _opening = true);
    try {
      final terminalId = await widget.actions.openTerminal();
      if (mounted) setState(() => _selectedTerminalId = terminalId);
    } on Object catch (error) {
      if (mounted) {
        _showFailure(
          _actionErrorMessage(error, 'Could not open a terminal. Try again.'),
        );
      }
    } finally {
      if (mounted) setState(() => _opening = false);
    }
  }

  Future<void> _reconnect() async {
    if (_reconnecting ||
        (widget.state.connectionPhase != ConnectionPhase.disconnected &&
            widget.state.connectionPhase != ConnectionPhase.failed)) {
      return;
    }
    setState(() => _reconnecting = true);
    try {
      await widget.actions.connect();
    } on Object catch (error) {
      if (mounted) {
        _showFailure(
          _actionErrorMessage(error, 'Could not reconnect. Try again.'),
        );
      }
    } finally {
      if (mounted) setState(() => _reconnecting = false);
    }
  }

  String _actionErrorMessage(Object error, String fallback) {
    final message = error.toString().replaceFirst('Bad state: ', '').trim();
    return message.isEmpty ? fallback : message;
  }

  void _showFailure(String message) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  void _closeSelectedTerminal() {
    final terminalId = _selectedTerminalId;
    if (terminalId == null) return;
    widget.actions.closeTerminal(terminalId);
  }

  KeyEventResult _handleTerminalKey(
    TerminalSession session,
    _TerminalBinding binding,
    KeyEvent event,
  ) {
    final keyboard = HardwareKeyboard.instance;
    final platform = Theme.of(context).platform;
    final isApple =
        platform == TargetPlatform.iOS || platform == TargetPlatform.macOS;
    final pasteShortcut =
        event.logicalKey == LogicalKeyboardKey.keyV &&
        (isApple ? keyboard.isMetaPressed : keyboard.isControlPressed);
    if (!pasteShortcut) return KeyEventResult.ignored;

    if (event is KeyDownEvent && _canInput(session)) {
      unawaited(_guardedPaste(session.terminalId, binding));
    }
    return KeyEventResult.handled;
  }

  Future<void> _guardedPaste(
    String terminalId,
    _TerminalBinding binding,
  ) async {
    final session = _sessionFor(terminalId);
    if (session == null || !_canInput(session)) return;

    ClipboardData? clipboard;
    try {
      clipboard = await Clipboard.getData(Clipboard.kTextPlain);
    } on Object {
      if (mounted) _showFailure('Could not read the clipboard.');
      return;
    }
    if (!mounted) return;
    final text = clipboard?.text;
    if (text == null || text.isEmpty) {
      _showFailure('The clipboard does not contain text.');
      return;
    }

    final lineCount = '\n'.allMatches(text).length + 1;
    final preview = text.length > _terminalPastePreviewCharacters
        ? '${text.substring(0, _terminalPastePreviewCharacters)}…'
        : text;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Paste into terminal?'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              lineCount == 1
                  ? '${text.length} characters may execute immediately.'
                  : '$lineCount lines may execute immediately.',
            ),
            const SizedBox(height: _T4Space.sm),
            SingleChildScrollView(
              child: SelectableText(
                preview,
                maxLines: _terminalPastePreviewLines,
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Paste'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    final current = _sessionFor(terminalId);
    if (current == null || !_canInput(current)) {
      _showFailure('The terminal is no longer writable.');
      return;
    }
    binding.terminal.paste(text);
  }

  @override
  void dispose() {
    for (final binding in _bindings.values) {
      binding.dispose();
    }
    _bindings.clear();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final selected = _selectedSession;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _TerminalTabStrip(
          sessions: widget.state.terminals,
          selectedTerminalId: selected?.terminalId,
          canOpen: _canOpen,
          opening: _opening,
          onSelected: (terminalId) {
            setState(() => _selectedTerminalId = terminalId);
            _bindings[terminalId]?.focusNode.requestFocus();
          },
          onOpen: _openTerminal,
          onClose: selected == null ? null : _closeSelectedTerminal,
        ),
        const Divider(height: _T4Size.divider),
        Expanded(
          child: selected == null
              ? _TerminalEmptyState(
                  state: widget.state,
                  canOpen: _canOpen,
                  opening: _opening,
                  reconnecting: _reconnecting,
                  onOpen: _openTerminal,
                  onReconnect: _reconnect,
                )
              : _buildTerminal(selected),
        ),
      ],
    );
  }

  Widget _buildTerminal(TerminalSession session) {
    final binding = _bindings[session.terminalId]!;
    final writable = _canInput(session);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _TerminalStatusBar(
          session: session,
          phase: widget.state.connectionPhase,
          writable: writable,
          reconnecting: _reconnecting,
          onReconnect:
              widget.state.connectionPhase == ConnectionPhase.disconnected ||
                  widget.state.connectionPhase == ConnectionPhase.failed
              ? _reconnect
              : null,
          onPaste: writable
              ? () => _guardedPaste(session.terminalId, binding)
              : null,
        ),
        Expanded(
          child: Semantics(
            container: true,
            label: 'Terminal output for ${_terminalTitle(session)}',
            child: TerminalView(
              binding.terminal,
              key: ValueKey<String>(session.terminalId),
              controller: binding.controller,
              scrollController: binding.scrollController,
              focusNode: binding.focusNode,
              theme: _terminalTheme(Theme.of(context).colorScheme),
              autofocus: true,
              readOnly: !writable,
              padding: const EdgeInsets.all(_T4Space.sm),
              onKeyEvent: (focusNode, event) =>
                  _handleTerminalKey(session, binding, event),
            ),
          ),
        ),
      ],
    );
  }
}

final class _TerminalBinding {
  _TerminalBinding({
    required this.terminalId,
    required void Function(String terminalId, String data) onOutput,
    required void Function(String terminalId, int columns, int rows) onResize,
  }) : terminal = Terminal(maxLines: _terminalScrollbackLines) {
    terminal.onOutput = (data) => onOutput(terminalId, data);
    terminal.onResize = (columns, rows, pixelWidth, pixelHeight) =>
        onResize(terminalId, columns, rows);
  }

  final String terminalId;
  final Terminal terminal;
  final TerminalController controller = TerminalController();
  final ScrollController scrollController = ScrollController();
  final FocusNode focusNode = FocusNode();
  String modelOutput = '';
  bool hasSynchronizedOutput = false;
  bool replayingInitialOutput = false;
  int? lastColumns;
  int? lastRows;

  void dispose() {
    terminal
      ..onOutput = null
      ..onResize = null;
    controller.dispose();
    scrollController.dispose();
    focusNode.dispose();
  }
}

final class _TerminalTabStrip extends StatelessWidget {
  const _TerminalTabStrip({
    required this.sessions,
    required this.selectedTerminalId,
    required this.canOpen,
    required this.opening,
    required this.onSelected,
    required this.onOpen,
    required this.onClose,
  });

  final List<TerminalSession> sessions;
  final String? selectedTerminalId;
  final bool canOpen;
  final bool opening;
  final ValueChanged<String> onSelected;
  final Future<void> Function() onOpen;
  final VoidCallback? onClose;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: scheme.surfaceContainerLow,
      child: SizedBox(
        height: _T4Layout.minimumTouchTarget,
        child: Row(
          children: [
            Expanded(
              child: LayoutBuilder(
                builder: (context, constraints) => Semantics(
                  container: true,
                  explicitChildNodes: true,
                  label: 'Terminal tabs',
                  child: SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: Row(
                      children: [
                        for (var index = 0; index < sessions.length; index += 1)
                          ConstrainedBox(
                            constraints: BoxConstraints(
                              maxWidth: constraints.maxWidth,
                              minHeight: _T4Layout.minimumTouchTarget,
                            ),
                            child: _TerminalTab(
                              session: sessions[index],
                              index: index,
                              count: sessions.length,
                              selected:
                                  sessions[index].terminalId ==
                                  selectedTerminalId,
                              onTap: () =>
                                  onSelected(sessions[index].terminalId),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
            IconButton(
              onPressed: canOpen ? () => unawaited(onOpen()) : null,
              tooltip: canOpen
                  ? 'New terminal'
                  : 'Connect with terminal access to open a terminal',
              icon: opening
                  ? const SizedBox.square(
                      dimension: _T4Size.indicator,
                      child: CircularProgressIndicator(
                        strokeWidth: _T4Size.thinStroke,
                      ),
                    )
                  : const Icon(Icons.add),
            ),
            IconButton(
              onPressed: onClose,
              tooltip: onClose == null
                  ? 'No terminal to close'
                  : 'Close terminal',
              icon: const Icon(Icons.close),
            ),
          ],
        ),
      ),
    );
  }
}

final class _TerminalTab extends StatelessWidget {
  const _TerminalTab({
    required this.session,
    required this.index,
    required this.count,
    required this.selected,
    required this.onTap,
  });

  final TerminalSession session;
  final int index;
  final int count;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final status = session.running ? 'running' : _terminalExitLabel(session);
    return Semantics(
      button: true,
      selected: selected,
      label:
          'Terminal tab ${index + 1} of $count: ${_terminalTitle(session)}, $status',
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        child: AnimatedContainer(
          duration: _T4Motion.short,
          curve: _T4Motion.standard,
          padding: const EdgeInsets.symmetric(horizontal: _T4Space.md),
          decoration: BoxDecoration(
            color: selected ? scheme.secondaryContainer : Colors.transparent,
            border: Border(
              bottom: BorderSide(
                color: selected ? scheme.primary : Colors.transparent,
                width: _T4Size.thinStroke,
              ),
            ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                session.running ? Icons.terminal : Icons.stop_circle_outlined,
                size: _T4Size.indicator,
                color: selected
                    ? scheme.onSecondaryContainer
                    : scheme.onSurfaceVariant,
              ),
              const SizedBox(width: _T4Space.xs),
              Flexible(
                child: Text(
                  _terminalTitle(session),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.labelLarge?.copyWith(
                    color: selected
                        ? scheme.onSecondaryContainer
                        : scheme.onSurfaceVariant,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

final class _TerminalStatusBar extends StatelessWidget {
  const _TerminalStatusBar({
    required this.session,
    required this.phase,
    required this.writable,
    required this.reconnecting,
    required this.onReconnect,
    required this.onPaste,
  });

  final TerminalSession session;
  final ConnectionPhase phase;
  final bool writable;
  final bool reconnecting;
  final Future<void> Function()? onReconnect;
  final Future<void> Function()? onPaste;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final semantic = T4SemanticColors.of(context);
    final status = _terminalStatus(
      session,
      phase,
      writable,
      reconnecting,
      scheme,
      semantic,
    );
    return Material(
      color: scheme.surfaceContainerLowest,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          _T4Space.md,
          _T4Space.xxs,
          _T4Space.xs,
          _T4Space.xxs,
        ),
        child: Wrap(
          spacing: _T4Space.sm,
          runSpacing: _T4Space.xxs,
          crossAxisAlignment: WrapCrossAlignment.center,
          alignment: WrapAlignment.spaceBetween,
          children: [
            Semantics(
              liveRegion: true,
              label: 'Terminal status: ${status.label}',
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    status.icon,
                    size: _T4Size.indicator,
                    color: status.color,
                  ),
                  const SizedBox(width: _T4Space.xs),
                  Text(
                    status.label,
                    style: Theme.of(context).textTheme.labelMedium?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (onReconnect != null)
                  TextButton.icon(
                    onPressed: reconnecting
                        ? null
                        : () => unawaited(onReconnect!()),
                    icon: reconnecting
                        ? const SizedBox.square(
                            dimension: _T4Size.indicator,
                            child: CircularProgressIndicator(
                              strokeWidth: _T4Size.thinStroke,
                            ),
                          )
                        : const Icon(Icons.refresh),
                    label: const Text('Reconnect'),
                  ),
                TextButton.icon(
                  onPressed: onPaste == null
                      ? null
                      : () => unawaited(onPaste!()),
                  icon: const Icon(Icons.content_paste_outlined),
                  label: const Text('Paste'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

final class _TerminalEmptyState extends StatelessWidget {
  const _TerminalEmptyState({
    required this.state,
    required this.canOpen,
    required this.opening,
    required this.reconnecting,
    required this.onOpen,
    required this.onReconnect,
  });

  final T4ViewState state;
  final bool canOpen;
  final bool opening;
  final bool reconnecting;
  final Future<void> Function() onOpen;
  final Future<void> Function() onReconnect;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final offline =
        state.connectionPhase == ConnectionPhase.disconnected ||
        state.connectionPhase == ConnectionPhase.failed;
    final message = offline
        ? 'Reconnect to open a terminal for this session.'
        : !state.grantedCapabilities.contains('term.open')
        ? 'Terminal access was not granted for this host.'
        : state.selectedSession == null
        ? 'Choose a session before opening a terminal.'
        : 'Open a terminal to run commands and inspect their output.';

    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(_T4Space.lg),
        child: ConstrainedBox(
          constraints: const BoxConstraints(
            maxWidth: _T4Layout.contentMaxWidth,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.terminal,
                size: _T4Size.emptyIcon,
                color: scheme.outline,
              ),
              const SizedBox(height: _T4Space.md),
              Text(
                'No terminal open',
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
              const SizedBox(height: _T4Space.md),
              if (offline)
                FilledButton.icon(
                  onPressed: reconnecting
                      ? null
                      : () => unawaited(onReconnect()),
                  icon: reconnecting
                      ? const SizedBox.square(
                          dimension: _T4Size.indicator,
                          child: CircularProgressIndicator(
                            strokeWidth: _T4Size.thinStroke,
                          ),
                        )
                      : const Icon(Icons.refresh),
                  label: const Text('Reconnect'),
                )
              else
                FilledButton.icon(
                  onPressed: canOpen ? () => unawaited(onOpen()) : null,
                  icon: opening
                      ? const SizedBox.square(
                          dimension: _T4Size.indicator,
                          child: CircularProgressIndicator(
                            strokeWidth: _T4Size.thinStroke,
                          ),
                        )
                      : const Icon(Icons.add),
                  label: const Text('New terminal'),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

final class _TerminalStatus {
  const _TerminalStatus(this.label, this.icon, this.color);

  final String label;
  final IconData icon;
  final Color color;
}

_TerminalStatus _terminalStatus(
  TerminalSession session,
  ConnectionPhase phase,
  bool writable,
  bool reconnecting,
  ColorScheme scheme,
  T4SemanticColors semantic,
) {
  if (!session.running) {
    return _TerminalStatus(
      _terminalExitLabel(session),
      Icons.stop_circle_outlined,
      scheme.outline,
    );
  }
  if (reconnecting || phase == ConnectionPhase.retrying) {
    return _TerminalStatus('Reconnecting', Icons.sync, semantic.statusWorking);
  }
  if (phase == ConnectionPhase.connecting ||
      phase == ConnectionPhase.synchronizing) {
    return _TerminalStatus('Connecting', Icons.sync, semantic.statusWorking);
  }
  if (phase != ConnectionPhase.ready) {
    return _TerminalStatus(
      'Offline',
      Icons.cloud_off_outlined,
      semantic.statusError,
    );
  }
  if (!writable) {
    return _TerminalStatus(
      'Read-only',
      Icons.lock_outline,
      semantic.warningForeground,
    );
  }
  return _TerminalStatus('Connected', Icons.circle, semantic.statusDone);
}

String _terminalTitle(TerminalSession session) {
  final title = session.title.trim();
  return title.isEmpty ? 'Terminal' : title;
}

String _terminalExitLabel(TerminalSession session) {
  final signal = session.signal?.trim();
  if (signal != null && signal.isNotEmpty) return 'Exited · $signal';
  final exitCode = session.exitCode;
  return exitCode == null ? 'Exited' : 'Exited · code $exitCode';
}

TerminalTheme _terminalTheme(ColorScheme scheme) {
  return TerminalTheme(
    cursor: scheme.primary,
    selection: scheme.secondaryContainer,
    foreground: scheme.onSurface,
    background: scheme.surfaceContainerLowest,
    black: scheme.shadow,
    white: scheme.surfaceContainerHighest,
    red: scheme.error,
    green: scheme.primary,
    yellow: scheme.tertiary,
    blue: scheme.primary,
    magenta: scheme.secondary,
    cyan: scheme.tertiary,
    brightBlack: scheme.outline,
    brightRed: scheme.onErrorContainer,
    brightGreen: scheme.onPrimaryContainer,
    brightYellow: scheme.onTertiaryContainer,
    brightBlue: scheme.onPrimaryContainer,
    brightMagenta: scheme.onSecondaryContainer,
    brightCyan: scheme.onTertiaryContainer,
    brightWhite: scheme.onSurface,
    searchHitBackground: scheme.tertiaryContainer,
    searchHitBackgroundCurrent: scheme.primaryContainer,
    searchHitForeground: scheme.onTertiaryContainer,
  );
}
