part of 't4_app.dart';

final class _DeveloperSurfacesPane extends StatefulWidget {
  const _DeveloperSurfacesPane({
    required this.state,
    required this.actions,
    required this.onDone,
    required this.showHeader,
  });

  final T4ViewState state;
  final T4Actions actions;
  final VoidCallback onDone;
  final bool showHeader;

  @override
  State<_DeveloperSurfacesPane> createState() => _DeveloperSurfacesPaneState();
}

final class _DeveloperSurfacesPaneState extends State<_DeveloperSurfacesPane>
    with SingleTickerProviderStateMixin {
  late final TabController _tabs;
  late List<DeveloperActivity> _activitySnapshot;
  final TextEditingController _launchUrlController = TextEditingController();
  final TextEditingController _navigationUrlController =
      TextEditingController();
  final FocusNode _navigationUrlFocus = FocusNode();
  final TextEditingController _fileEditorController = TextEditingController();

  String? _activityCategory;
  String? _busyAction;
  String? _actionError;
  String? _selectedFilePath;
  String _directoryPath = '';
  String? _editedFilePath;
  bool _fileDirty = false;
  bool _activityPaused = false;

  bool get _connected => widget.state.connectionPhase == ConnectionPhase.ready;

  bool _hasCapability(String capability) =>
      widget.state.grantedCapabilities.contains(capability);

  bool get _busy =>
      _busyAction != null || widget.state.developerOperationPending;

  @override
  void initState() {
    super.initState();
    _tabs = TabController(length: 5, vsync: this);
    _activitySnapshot = List<DeveloperActivity>.of(widget.state.activities);
    final workspace = widget.state.fileWorkspace;
    if (workspace.content != null && workspace.path.isNotEmpty) {
      _selectedFilePath = workspace.path;
      _directoryPath = _parentPath(workspace.path);
    } else {
      _directoryPath = workspace.path;
    }
    _syncPreviewAddress(force: true);
    _syncFileEditor(force: true);
  }

  @override
  void didUpdateWidget(covariant _DeveloperSurfacesPane oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!_activityPaused &&
        !identical(oldWidget.state.activities, widget.state.activities)) {
      _activitySnapshot = List<DeveloperActivity>.of(widget.state.activities);
    }
    final oldPreview = oldWidget.state.activePreview;
    final preview = widget.state.activePreview;
    if (oldPreview?.previewId != preview?.previewId ||
        oldPreview?.url != preview?.url) {
      _syncPreviewAddress();
    }
    final oldWorkspace = oldWidget.state.fileWorkspace;
    final workspace = widget.state.fileWorkspace;
    if (oldWorkspace.path != workspace.path ||
        oldWorkspace.content != workspace.content) {
      _syncFileEditor();
    }
  }

  @override
  void dispose() {
    _tabs.dispose();
    _launchUrlController.dispose();
    _navigationUrlController.dispose();
    _navigationUrlFocus.dispose();
    _fileEditorController.dispose();
    super.dispose();
  }

  void _syncPreviewAddress({bool force = false}) {
    if (!force && _navigationUrlFocus.hasFocus) return;
    final url = widget.state.activePreview?.url ?? '';
    _navigationUrlController.value = TextEditingValue(
      text: url,
      selection: TextSelection.collapsed(offset: url.length),
    );
  }

  void _syncFileEditor({bool force = false}) {
    final workspace = widget.state.fileWorkspace;
    final content = workspace.content;
    if (content == null || workspace.path.isEmpty) return;
    if (!force && _fileDirty && _editedFilePath == workspace.path) return;
    _editedFilePath = workspace.path;
    _fileDirty = false;
    _fileEditorController.value = TextEditingValue(
      text: content,
      selection: TextSelection.collapsed(offset: content.length),
    );
  }

  Future<bool> _confirmDiscardFileChanges() async {
    if (!_fileDirty) return true;
    final discard = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Discard unsaved changes?'),
        content: Text(
          'Your edits to ${_editedFilePath ?? 'this file'} have not been saved.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Keep editing'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Discard'),
          ),
        ],
      ),
    );
    if (discard == true && mounted) {
      setState(() => _fileDirty = false);
    }
    return discard == true;
  }

  void _onFileChanged(String content) {
    final workspace = widget.state.fileWorkspace;
    final dirty =
        _editedFilePath == workspace.path && content != workspace.content;
    if (dirty != _fileDirty) setState(() => _fileDirty = dirty);
  }

  Future<void> _saveFile() async {
    final path = _editedFilePath;
    if (path == null || !_fileDirty) return;
    await _runAction('files-write', 'Could not save the file.', () async {
      await widget.actions.writeFile(path, _fileEditorController.text);
      if (mounted) setState(() => _fileDirty = false);
    });
  }

  Future<void> _runAction(
    String key,
    String failureMessage,
    Future<void> Function() action,
  ) async {
    if (_busy) return;
    setState(() {
      _busyAction = key;
      _actionError = null;
    });
    try {
      await action();
    } on Object catch (error) {
      if (!mounted) return;
      final detail = error.toString().replaceFirst('Bad state: ', '').trim();
      setState(() {
        _actionError = detail.isEmpty ? failureMessage : detail;
      });
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(failureMessage)));
    } finally {
      if (mounted) setState(() => _busyAction = null);
    }
  }

  void _toggleActivityPause() {
    setState(() {
      _activityPaused = !_activityPaused;
      if (!_activityPaused) {
        _activitySnapshot = List<DeveloperActivity>.of(widget.state.activities);
      }
    });
  }

  Future<void> _listDirectory(String path) async {
    if (!await _confirmDiscardFileChanges() || !mounted) return;
    setState(() {
      _directoryPath = path;
      _selectedFilePath = null;
      _editedFilePath = null;
      _fileEditorController.clear();
    });
    await _runAction(
      'files-list',
      'Could not list that directory.',
      () => widget.actions.listFiles(path),
    );
  }

  Future<void> _selectFile(String path) async {
    if (path != _editedFilePath &&
        (!await _confirmDiscardFileChanges() || !mounted)) {
      return;
    }
    setState(() => _selectedFilePath = path);
    await _runAction(
      'files-read',
      'Could not read that file.',
      () => widget.actions.readFile(path),
    );
  }

  Future<void> _launchPreview() async {
    final url = _launchUrlController.text.trim();
    if (url.isEmpty) return;
    await _runAction(
      'preview-launch',
      'Could not launch the preview.',
      () async {
        await widget.actions.launchPreview(url);
        _launchUrlController.clear();
      },
    );
  }

  Future<void> _navigatePreview(PreviewWorkspaceState preview) async {
    final url = _navigationUrlController.text.trim();
    if (url.isEmpty || url == preview.url) return;
    await _runAction(
      'preview-navigate',
      'Could not navigate the preview.',
      () => widget.actions.navigatePreview(preview.previewId, url),
    );
  }

  Future<void> _previewAction(PreviewWorkspaceState preview, String action) =>
      _runAction(
        'preview-$action',
        'Could not $action the preview.',
        () => widget.actions.runPreviewAction(preview.previewId, action),
      );

  Future<void> _openPreviewInteraction(
    PreviewWorkspaceState preview, {
    required bool allowInput,
    required bool allowHandoff,
  }) async {
    final request = await showModalBottomSheet<_PreviewInteractionRequest>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (context) => _PreviewInteractionSheet(
        allowInput: allowInput,
        allowHandoff: allowHandoff,
      ),
    );
    if (request == null || !mounted) return;
    await _runAction(
      'preview-${request.action}',
      'Could not ${request.action} in the preview.',
      () => widget.actions.runPreviewInteraction(
        preview.previewId,
        request.action,
        request.args,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        if (widget.showHeader) _DeveloperSurfacesHeader(onDone: widget.onDone),
        if (_actionError case final error?)
          _DeveloperErrorBanner(
            message: error,
            onDismiss: () => setState(() => _actionError = null),
          ),
        if (_busy)
          const LinearProgressIndicator(
            minHeight: _T4Size.thinStroke,
            semanticsLabel: 'Developer operation in progress',
          ),
        TabBar(
          controller: _tabs,
          isScrollable: true,
          tabAlignment: TabAlignment.start,
          tabs: const [
            Tab(icon: Icon(Icons.receipt_long_outlined), text: 'Activity'),
            Tab(icon: Icon(Icons.folder_outlined), text: 'Files'),
            Tab(icon: Icon(Icons.difference_outlined), text: 'Review'),
            Tab(icon: Icon(Icons.terminal), text: 'Terminal'),
            Tab(icon: Icon(Icons.preview_outlined), text: 'Preview'),
          ],
        ),
        Expanded(
          child: TabBarView(
            controller: _tabs,
            children: [
              _buildActivity(),
              _buildFiles(),
              _buildReview(),
              _TerminalPane(state: widget.state, actions: widget.actions),
              _buildPreview(),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildActivity() {
    if (!_connected && _activitySnapshot.isEmpty) {
      return const _DeveloperUnavailable(
        icon: Icons.cloud_off_outlined,
        title: 'Activity is offline',
        message: 'Connect to a host to inspect protocol activity.',
      );
    }
    if (!_hasCapability('audit.read')) {
      return const _DeveloperUnavailable(
        icon: Icons.lock_outline,
        title: 'Activity is unavailable',
        message: 'The paired host did not grant the audit.read capability.',
      );
    }

    final categories =
        _activitySnapshot
            .map((activity) => activity.category.trim())
            .where((category) => category.isNotEmpty)
            .toSet()
            .toList(growable: false)
          ..sort();
    if (_activityCategory != null && !categories.contains(_activityCategory)) {
      _activityCategory = null;
    }
    final activities =
        _activitySnapshot
            .where(
              (activity) =>
                  _activityCategory == null ||
                  activity.category == _activityCategory,
            )
            .toList(growable: false)
          ..sort((a, b) => b.at.compareTo(a.at));

    return Column(
      children: [
        _ActivityToolbar(
          categories: categories,
          selectedCategory: _activityCategory,
          paused: _activityPaused,
          busy: _busy,
          onSelectCategory: (category) =>
              setState(() => _activityCategory = category),
          onTogglePause: _toggleActivityPause,
          onRefresh: !_connected
              ? null
              : () => _runAction(
                  'activity-refresh',
                  'Could not refresh activity.',
                  widget.actions.refreshActivity,
                ),
        ),
        if (_activityPaused)
          const _DeveloperNotice(
            icon: Icons.pause_circle_outline,
            message: 'Activity is paused. New rows are held until you resume.',
          ),
        Expanded(
          child: activities.isEmpty
              ? _DeveloperUnavailable(
                  icon: Icons.filter_alt_off_outlined,
                  title: _activitySnapshot.isEmpty
                      ? 'No activity yet'
                      : 'No matching activity',
                  message: _activitySnapshot.isEmpty
                      ? 'Refresh to request the latest host activity.'
                      : 'Choose a different category filter.',
                )
              : ListView.separated(
                  padding: const EdgeInsets.all(_T4Space.md),
                  itemCount: activities.length,
                  separatorBuilder: (_, _) =>
                      const SizedBox(height: _T4Space.xs),
                  itemBuilder: (context, index) =>
                      _ActivityRow(activity: activities[index]),
                ),
        ),
      ],
    );
  }

  Widget _buildFiles() {
    final canList = _hasCapability('files.list');
    final canRead = _hasCapability('files.read');
    if (!_connected && widget.state.fileWorkspace.entries.isEmpty) {
      return const _DeveloperUnavailable(
        icon: Icons.cloud_off_outlined,
        title: 'Files are offline',
        message: 'Connect to a host to browse the selected session workspace.',
      );
    }
    if (!canList || !canRead) {
      return _DeveloperUnavailable(
        icon: Icons.lock_outline,
        title: 'Files are unavailable',
        message:
            'Browsing requires ${!canList ? 'files.list' : 'files.read'} access from the paired host.',
      );
    }

    final workspace = widget.state.fileWorkspace;
    final filePath =
        _selectedFilePath ??
        (workspace.content == null ? null : workspace.path);
    final content = filePath == workspace.path ? workspace.content : null;
    return LayoutBuilder(
      builder: (context, constraints) {
        final list = _FileBrowser(
          directoryPath: _directoryPath,
          entries: workspace.entries,
          selectedPath: filePath,
          busy: _busy || workspace.loading,
          error: workspace.error,
          onRefresh: _connected && !_busy
              ? () => _listDirectory(_directoryPath)
              : null,
          onParent: _connected && !_busy && _directoryPath.isNotEmpty
              ? () => _listDirectory(_parentPath(_directoryPath))
              : null,
          onOpenDirectory: _connected && !_busy ? _listDirectory : null,
          onOpenFile: _connected && !_busy ? _selectFile : null,
        );
        final viewer = _SourceViewer(
          path: filePath,
          content: content,
          loading: _busyAction == 'files-read',
          controller: _fileEditorController,
          editable: _hasCapability('files.write') && _connected && !_busy,
          dirty: _fileDirty,
          onChanged: _onFileChanged,
          onSave: _fileDirty && !_busy ? _saveFile : null,
          onDiscard: _fileDirty
              ? () => setState(() {
                  _fileEditorController.text =
                      widget.state.fileWorkspace.content ?? '';
                  _fileDirty = false;
                })
              : null,
        );
        if (constraints.maxWidth >= _T4Layout.contentMaxWidth) {
          return Row(
            children: [
              SizedBox(width: _T4Layout.sessionRailWidth, child: list),
              const VerticalDivider(width: _T4Size.divider),
              Expanded(child: viewer),
            ],
          );
        }
        return Column(
          children: [
            Flexible(child: list),
            const Divider(height: _T4Size.divider),
            Expanded(child: viewer),
          ],
        );
      },
    );
  }

  Widget _buildReview() {
    final workspace = widget.state.fileWorkspace;
    final reviews = widget.state.reviews;
    final selectedPath =
        _selectedFilePath ??
        (workspace.content == null ? null : workspace.path);
    if (!_connected && workspace.diff == null && reviews.isEmpty) {
      return const _DeveloperUnavailable(
        icon: Icons.cloud_off_outlined,
        title: 'Review is offline',
        message: 'Connect to load reviews and file diffs.',
      );
    }

    final canReadReview = _hasCapability('files.read');
    final canApplyReview = _hasCapability('files.write');
    final canLoadDiff = _hasCapability('files.diff');
    final diff = selectedPath != null && workspace.path == selectedPath
        ? workspace.diff
        : null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (reviews.isNotEmpty) ...[
          SizedBox(
            height: (112 + reviews.length * 96).clamp(0, 300).toDouble(),
            child: _ReviewQueue(
              reviews: reviews,
              busy: _busy,
              canRead: _connected && canReadReview,
              canApply: _connected && canApplyReview,
              onRefresh: (review) => _runAction(
                'review-read-${review.reviewId}',
                'Could not refresh the review.',
                () => widget.actions.refreshReview(review.reviewId),
              ),
              onApply: (review) => _runAction(
                'review-apply-${review.reviewId}',
                'Could not apply the review.',
                () => widget.actions.applyReview(review.reviewId),
              ),
            ),
          ),
          const Divider(height: _T4Size.divider),
        ],
        if (selectedPath == null || selectedPath.isEmpty)
          Expanded(
            child: _DeveloperUnavailable(
              icon: Icons.find_in_page_outlined,
              title: reviews.isEmpty
                  ? 'Choose a file first'
                  : 'No file diff selected',
              message: 'Select a file in Files to inspect its current diff.',
              action: TextButton.icon(
                onPressed: () => _tabs.animateTo(1),
                icon: const Icon(Icons.folder_open_outlined),
                label: const Text('Open files'),
              ),
            ),
          )
        else if (!canLoadDiff)
          const Expanded(
            child: _DeveloperUnavailable(
              icon: Icons.lock_outline,
              title: 'File diff unavailable',
              message: 'The paired host did not grant files.diff access.',
            ),
          )
        else ...[
          Padding(
            padding: const EdgeInsets.all(_T4Space.md),
            child: Wrap(
              spacing: _T4Space.sm,
              runSpacing: _T4Space.xs,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Icon(
                  Icons.description_outlined,
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
                Text(
                  selectedPath,
                  style: Theme.of(context).textTheme.titleSmall,
                ),
                FilledButton.tonalIcon(
                  onPressed: _connected && !_busy
                      ? () => _runAction(
                          'files-diff',
                          'Could not load the file diff.',
                          widget.actions.loadSessionDiff,
                        )
                      : null,
                  icon: const Icon(Icons.refresh),
                  label: Text(diff == null ? 'Load diff' : 'Reload diff'),
                ),
              ],
            ),
          ),
          const Divider(height: _T4Size.divider),
          Expanded(
            child: diff == null
                ? const _DeveloperUnavailable(
                    icon: Icons.difference_outlined,
                    title: 'Diff not loaded',
                    message: 'Load the selected file diff to begin review.',
                  )
                : diff.trim().isEmpty
                ? const _DeveloperUnavailable(
                    icon: Icons.check_circle_outline,
                    title: 'No changes',
                    message: 'The selected file has no changes to review.',
                  )
                : _CodeViewer(
                    text: diff,
                    semanticsLabel: 'Diff for $selectedPath',
                  ),
          ),
        ],
      ],
    );
  }

  Widget _buildPreview() {
    final canRead = _hasCapability('preview.read');
    final canControl = _hasCapability('preview.control');
    final canInput = _hasCapability('preview.input');
    if (!_connected && widget.state.previews.isEmpty) {
      return const _DeveloperUnavailable(
        icon: Icons.cloud_off_outlined,
        title: 'Preview is offline',
        message: 'Connect to a host to open a protocol-rendered preview.',
      );
    }
    if (!canRead && !canControl && !canInput) {
      return const _DeveloperUnavailable(
        icon: Icons.lock_outline,
        title: 'Preview is unavailable',
        message:
            'The paired host did not grant preview.read, preview.control, or preview.input.',
      );
    }

    final preview = widget.state.activePreview;
    return Column(
      children: [
        _PreviewLaunchBar(
          controller: _launchUrlController,
          enabled: _connected && canControl && !_busy,
          onLaunch: _launchPreview,
        ),
        if (widget.state.previews.isNotEmpty)
          _PreviewSelector(
            previews: widget.state.previews,
            activePreviewId: preview?.previewId,
            enabled: _connected && canControl && !_busy,
            onSelected: (previewId) => _runAction(
              'preview-select',
              'Could not select the preview.',
              () => widget.actions.selectPreview(previewId),
            ),
          ),
        const Divider(height: _T4Size.divider),
        Expanded(
          child: preview == null
              ? const _DeveloperUnavailable(
                  icon: Icons.preview_outlined,
                  title: 'No preview open',
                  message:
                      'Enter a URL above. T4 will display only captured image bytes returned by the host protocol.',
                )
              : _buildActivePreview(preview, canRead, canControl, canInput),
        ),
      ],
    );
  }

  Widget _buildActivePreview(
    PreviewWorkspaceState preview,
    bool canRead,
    bool canControl,
    bool canInput,
  ) {
    final controlsEnabled = _connected && canControl && !_busy;
    return Column(
      children: [
        _PreviewNavigationBar(
          preview: preview,
          controller: _navigationUrlController,
          focusNode: _navigationUrlFocus,
          controlsEnabled: controlsEnabled,
          captureEnabled: _connected && canRead && !_busy,
          interactionEnabled: _connected && (canInput || canControl) && !_busy,
          onNavigate: () => _navigatePreview(preview),
          onAction: (action) => _previewAction(preview, action),
          onInteract: () => _openPreviewInteraction(
            preview,
            allowInput: canInput,
            allowHandoff: canControl,
          ),
          onCapture: () => _runAction(
            'preview-capture',
            'Could not capture the preview.',
            () => widget.actions.capturePreview(preview.previewId),
          ),
        ),
        _PreviewStatus(preview: preview),
        if (preview.error case final error?)
          _DeveloperErrorBanner(message: error),
        const _DeveloperNotice(
          icon: Icons.verified_user_outlined,
          message:
              'Safe preview: page code never runs in this app. Only capture bytes delivered by the paired host protocol are rendered.',
        ),
        Expanded(child: _PreviewCapture(preview: preview)),
      ],
    );
  }
}

final class _DeveloperSurfacesHeader extends StatelessWidget {
  const _DeveloperSurfacesHeader({required this.onDone});

  final VoidCallback onDone;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        border: Border(
          bottom: BorderSide(
            color: Theme.of(context).colorScheme.outlineVariant,
          ),
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: _T4Space.sm,
          vertical: _T4Space.xs,
        ),
        child: Row(
          children: [
            IconButton(
              onPressed: onDone,
              tooltip: 'Close developer tools',
              icon: const Icon(Icons.arrow_back),
            ),
            const SizedBox(width: _T4Space.xs),
            Expanded(
              child: Text(
                'Developer tools',
                style: Theme.of(context).textTheme.titleLarge,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

final class _DeveloperErrorBanner extends StatelessWidget {
  const _DeveloperErrorBanner({required this.message, this.onDismiss});

  final String message;
  final VoidCallback? onDismiss;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      container: true,
      liveRegion: true,
      label: 'Developer tools error: $message',
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
              if (onDismiss != null)
                IconButton(
                  onPressed: onDismiss,
                  tooltip: 'Dismiss error',
                  color: scheme.onErrorContainer,
                  icon: const Icon(Icons.close),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

final class _DeveloperNotice extends StatelessWidget {
  const _DeveloperNotice({required this.icon, required this.message});

  final IconData icon;
  final String message;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return ColoredBox(
      color: scheme.surfaceContainerLow,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: _T4Space.md,
          vertical: _T4Space.xs,
        ),
        child: Row(
          children: [
            Icon(icon, size: _T4Space.md, color: scheme.onSurfaceVariant),
            const SizedBox(width: _T4Space.xs),
            Expanded(
              child: Text(
                message,
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

final class _DeveloperUnavailable extends StatelessWidget {
  const _DeveloperUnavailable({
    required this.icon,
    required this.title,
    required this.message,
    this.action,
  });

  final IconData icon;
  final String title;
  final String message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(_T4Space.xl),
        child: Semantics(
          container: true,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: _T4Size.emptyIcon, color: scheme.outline),
              const SizedBox(height: _T4Space.md),
              Text(
                title,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: _T4Space.xs),
              ConstrainedBox(
                constraints: const BoxConstraints(
                  maxWidth: _T4Layout.contentMaxWidth,
                ),
                child: Text(
                  message,
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: scheme.onSurfaceVariant,
                  ),
                ),
              ),
              if (action != null) ...[
                const SizedBox(height: _T4Space.md),
                action!,
              ],
            ],
          ),
        ),
      ),
    );
  }
}

final class _ActivityToolbar extends StatelessWidget {
  const _ActivityToolbar({
    required this.categories,
    required this.selectedCategory,
    required this.paused,
    required this.busy,
    required this.onSelectCategory,
    required this.onTogglePause,
    required this.onRefresh,
  });

  final List<String> categories;
  final String? selectedCategory;
  final bool paused;
  final bool busy;
  final ValueChanged<String?> onSelectCategory;
  final VoidCallback onTogglePause;
  final VoidCallback? onRefresh;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(_T4Space.sm),
      child: Row(
        children: [
          Expanded(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Wrap(
                spacing: _T4Space.xs,
                children: [
                  FilterChip(
                    label: const Text('All'),
                    selected: selectedCategory == null,
                    onSelected: (_) => onSelectCategory(null),
                  ),
                  for (final category in categories)
                    FilterChip(
                      label: Text(category),
                      selected: selectedCategory == category,
                      onSelected: (_) => onSelectCategory(category),
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(width: _T4Space.xs),
          IconButton(
            onPressed: busy ? null : onTogglePause,
            tooltip: paused ? 'Resume activity' : 'Pause activity',
            icon: Icon(paused ? Icons.play_arrow : Icons.pause),
          ),
          IconButton(
            onPressed: busy ? null : onRefresh,
            tooltip: 'Refresh activity',
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
    );
  }
}

final class _ActivityRow extends StatelessWidget {
  const _ActivityRow({required this.activity});

  final DeveloperActivity activity;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final raw = _redactActivityRaw(activity.raw);
    return Material(
      color: scheme.surfaceContainerLow,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(_T4Radius.sm),
      ),
      clipBehavior: Clip.antiAlias,
      child: ExpansionTile(
        key: ValueKey(activity.id),
        leading: const Icon(Icons.data_object),
        title: Text(activity.title),
        subtitle: Text(
          '${_formatActivityTime(activity.at)} · ${activity.category}\n${activity.detail}',
          maxLines: 3,
          overflow: TextOverflow.ellipsis,
        ),
        expandedCrossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Divider(height: _T4Size.divider),
          Padding(
            padding: const EdgeInsets.all(_T4Space.md),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        'Redacted protocol JSON',
                        style: Theme.of(context).textTheme.labelLarge,
                      ),
                    ),
                    IconButton(
                      onPressed: () async {
                        await Clipboard.setData(ClipboardData(text: raw));
                        if (!context.mounted) return;
                        ScaffoldMessenger.of(context)
                          ..hideCurrentSnackBar()
                          ..showSnackBar(
                            const SnackBar(
                              content: Text('Redacted activity JSON copied.'),
                            ),
                          );
                      },
                      tooltip: 'Copy redacted JSON',
                      icon: const Icon(Icons.copy_outlined),
                    ),
                  ],
                ),
                _CodeViewer(
                  text: raw.isEmpty ? '{}' : raw,
                  semanticsLabel:
                      'Redacted protocol JSON for ${activity.title}',
                  expand: false,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

final class _ReviewQueue extends StatelessWidget {
  const _ReviewQueue({
    required this.reviews,
    required this.busy,
    required this.canRead,
    required this.canApply,
    required this.onRefresh,
    required this.onApply,
  });

  final List<ReviewWorkspaceItem> reviews;
  final bool busy;
  final bool canRead;
  final bool canApply;
  final ValueChanged<ReviewWorkspaceItem> onRefresh;
  final ValueChanged<ReviewWorkspaceItem> onApply;

  @override
  Widget build(BuildContext context) {
    return ListView.separated(
      padding: const EdgeInsets.all(_T4Space.sm),
      itemCount: reviews.length,
      separatorBuilder: (_, _) => const SizedBox(height: _T4Space.xs),
      itemBuilder: (context, index) {
        final review = reviews[index];
        final complete =
            review.status == 'applied' || review.status == 'discarded';
        final finding = review.findings
            .map(_reviewFindingLabel)
            .where((label) => label.isNotEmpty)
            .firstOrNull;
        return Card(
          margin: EdgeInsets.zero,
          child: Padding(
            padding: const EdgeInsets.all(_T4Space.sm),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  complete
                      ? Icons.task_alt_outlined
                      : Icons.rate_review_outlined,
                  color: complete
                      ? Theme.of(context).colorScheme.primary
                      : Theme.of(context).colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: _T4Space.sm),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        review.path ?? review.reviewId,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                      Text(
                        '${review.status} · ${review.findings.length} ${review.findings.length == 1 ? 'finding' : 'findings'}',
                        style: Theme.of(context).textTheme.labelSmall?.copyWith(
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                      ),
                      if (finding != null)
                        Text(
                          finding,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                    ],
                  ),
                ),
                const SizedBox(width: _T4Space.sm),
                Column(
                  children: [
                    IconButton(
                      tooltip: 'Refresh review',
                      onPressed: canRead && !busy
                          ? () => onRefresh(review)
                          : null,
                      icon: const Icon(Icons.refresh),
                    ),
                    IconButton.filledTonal(
                      tooltip: complete ? 'Review complete' : 'Apply review',
                      onPressed: canApply && !busy && !complete
                          ? () => onApply(review)
                          : null,
                      icon: const Icon(Icons.done_all),
                    ),
                  ],
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

String _reviewFindingLabel(Map<String, Object?> finding) {
  for (final key in const ['message', 'summary', 'title', 'description']) {
    final value = finding[key];
    if (value is String && value.trim().isNotEmpty) return value.trim();
  }
  return '';
}

final class _FileBrowser extends StatelessWidget {
  const _FileBrowser({
    required this.directoryPath,
    required this.entries,
    required this.selectedPath,
    required this.busy,
    required this.error,
    required this.onRefresh,
    required this.onParent,
    required this.onOpenDirectory,
    required this.onOpenFile,
  });

  final String directoryPath;
  final List<DeveloperFileEntry> entries;
  final String? selectedPath;
  final bool busy;
  final String? error;
  final VoidCallback? onRefresh;
  final VoidCallback? onParent;
  final ValueChanged<String>? onOpenDirectory;
  final ValueChanged<String>? onOpenFile;

  @override
  Widget build(BuildContext context) {
    final sorted = List<DeveloperFileEntry>.of(entries)
      ..sort((a, b) {
        final aDirectory = _isDirectory(a);
        final bDirectory = _isDirectory(b);
        if (aDirectory != bDirectory) return aDirectory ? -1 : 1;
        return a.path.toLowerCase().compareTo(b.path.toLowerCase());
      });
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.all(_T4Space.sm),
          child: Row(
            children: [
              IconButton(
                onPressed: onParent,
                tooltip: 'Open parent directory',
                icon: const Icon(Icons.arrow_upward),
              ),
              const SizedBox(width: _T4Space.xs),
              Expanded(
                child: Tooltip(
                  message: directoryPath.isEmpty
                      ? 'Workspace root'
                      : directoryPath,
                  child: Text(
                    directoryPath.isEmpty ? 'Workspace root' : directoryPath,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                ),
              ),
              IconButton(
                onPressed: onRefresh,
                tooltip: 'Refresh directory',
                icon: const Icon(Icons.refresh),
              ),
            ],
          ),
        ),
        if (error case final message?) _DeveloperErrorBanner(message: message),
        Expanded(
          child: busy && sorted.isEmpty
              ? const Center(
                  child: CircularProgressIndicator(
                    semanticsLabel: 'Loading files',
                  ),
                )
              : sorted.isEmpty
              ? const _DeveloperUnavailable(
                  icon: Icons.folder_off_outlined,
                  title: 'Directory is empty',
                  message: 'Refresh to check for workspace files.',
                )
              : ListView.builder(
                  padding: const EdgeInsets.symmetric(horizontal: _T4Space.xs),
                  itemCount: sorted.length,
                  itemBuilder: (context, index) {
                    final entry = sorted[index];
                    final directory = _isDirectory(entry);
                    return ListTile(
                      selected: entry.path == selectedPath,
                      enabled: directory
                          ? onOpenDirectory != null
                          : onOpenFile != null,
                      leading: Icon(
                        directory
                            ? Icons.folder_outlined
                            : Icons.insert_drive_file_outlined,
                      ),
                      title: Text(
                        _baseName(entry.path),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: directory
                          ? const Text('Directory')
                          : entry.size == null
                          ? null
                          : Text(_formatByteCount(entry.size!)),
                      trailing: directory
                          ? const Icon(Icons.chevron_right)
                          : null,
                      onTap: () => directory
                          ? onOpenDirectory?.call(entry.path)
                          : onOpenFile?.call(entry.path),
                    );
                  },
                ),
        ),
      ],
    );
  }
}

final class _SourceViewer extends StatelessWidget {
  const _SourceViewer({
    required this.path,
    required this.content,
    required this.loading,
    required this.controller,
    required this.editable,
    required this.dirty,
    required this.onChanged,
    this.onSave,
    this.onDiscard,
  });

  final String? path;
  final String? content;
  final bool loading;
  final TextEditingController controller;
  final bool editable;
  final bool dirty;
  final ValueChanged<String> onChanged;
  final VoidCallback? onSave;
  final VoidCallback? onDiscard;

  @override
  Widget build(BuildContext context) {
    if (loading) {
      return const Center(
        child: CircularProgressIndicator(semanticsLabel: 'Reading file'),
      );
    }
    if (path == null) {
      return const _DeveloperUnavailable(
        icon: Icons.code_outlined,
        title: 'Select a source file',
        message: 'Choose a file to inspect its protocol-provided contents.',
      );
    }
    if (content == null) {
      return const _DeveloperUnavailable(
        icon: Icons.error_outline,
        title: 'Source unavailable',
        message: 'Select the file again to read its contents.',
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.all(_T4Space.md),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  path!,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.titleSmall,
                ),
              ),
              if (dirty)
                TextButton(onPressed: onDiscard, child: const Text('Discard')),
              FilledButton.tonalIcon(
                onPressed: onSave,
                icon: const Icon(Icons.save_outlined),
                label: Text(dirty ? 'Save' : 'Saved'),
              ),
            ],
          ),
        ),
        const Divider(height: _T4Size.divider),
        Expanded(
          child: ColoredBox(
            color: Theme.of(context).colorScheme.surfaceContainerLowest,
            child: Semantics(
              label: 'Source editor for $path',
              textField: true,
              child: TextField(
                controller: controller,
                enabled: editable,
                readOnly: !editable,
                expands: true,
                minLines: null,
                maxLines: null,
                textAlignVertical: TextAlignVertical.top,
                keyboardType: TextInputType.multiline,
                onChanged: onChanged,
                decoration: const InputDecoration(
                  border: InputBorder.none,
                  contentPadding: EdgeInsets.all(_T4Space.md),
                ),
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  fontFamily: _T4Typography.monoFamily,
                  color: Theme.of(context).colorScheme.onSurface,
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

final class _CodeViewer extends StatelessWidget {
  const _CodeViewer({
    required this.text,
    required this.semanticsLabel,
    this.expand = true,
  });

  final String text;
  final String semanticsLabel;
  final bool expand;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final viewer = ColoredBox(
      color: scheme.surfaceContainerLowest,
      child: Scrollbar(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(_T4Space.md),
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: SelectionArea(
              child: Text(
                text,
                semanticsLabel: semanticsLabel,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  fontFamily: _T4Typography.monoFamily,
                  color: scheme.onSurface,
                ),
              ),
            ),
          ),
        ),
      ),
    );
    return expand ? SizedBox.expand(child: viewer) : viewer;
  }
}

final class _PreviewLaunchBar extends StatelessWidget {
  const _PreviewLaunchBar({
    required this.controller,
    required this.enabled,
    required this.onLaunch,
  });

  final TextEditingController controller;
  final bool enabled;
  final Future<void> Function() onLaunch;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(_T4Space.sm),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: controller,
              enabled: enabled,
              keyboardType: TextInputType.url,
              textInputAction: TextInputAction.go,
              autocorrect: false,
              decoration: const InputDecoration(
                labelText: 'Launch URL',
                hintText: 'https://localhost:3000',
                prefixIcon: Icon(Icons.add_link),
              ),
              onSubmitted: enabled ? (_) => onLaunch() : null,
            ),
          ),
          const SizedBox(width: _T4Space.sm),
          FilledButton.icon(
            onPressed: enabled ? onLaunch : null,
            icon: const Icon(Icons.rocket_launch_outlined),
            label: const Text('Launch'),
          ),
        ],
      ),
    );
  }
}

final class _PreviewSelector extends StatelessWidget {
  const _PreviewSelector({
    required this.previews,
    required this.activePreviewId,
    required this.enabled,
    required this.onSelected,
  });

  final List<PreviewWorkspaceState> previews;
  final String? activePreviewId;
  final bool enabled;
  final ValueChanged<String> onSelected;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: _T4Layout.minimumTouchTarget + _T4Space.sm,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: _T4Space.sm),
        itemCount: previews.length,
        separatorBuilder: (_, _) => const SizedBox(width: _T4Space.xs),
        itemBuilder: (context, index) {
          final preview = previews[index];
          final title = preview.title?.trim();
          return ChoiceChip(
            label: Text(
              title == null || title.isEmpty ? preview.url : title,
              overflow: TextOverflow.ellipsis,
            ),
            selected: preview.previewId == activePreviewId,
            onSelected: enabled ? (_) => onSelected(preview.previewId) : null,
          );
        },
      ),
    );
  }
}

final class _PreviewNavigationBar extends StatelessWidget {
  const _PreviewNavigationBar({
    required this.preview,
    required this.controller,
    required this.focusNode,
    required this.controlsEnabled,
    required this.captureEnabled,
    required this.interactionEnabled,
    required this.onNavigate,
    required this.onAction,
    required this.onInteract,
    required this.onCapture,
  });

  final PreviewWorkspaceState preview;
  final TextEditingController controller;
  final FocusNode focusNode;
  final bool controlsEnabled;
  final bool captureEnabled;
  final bool interactionEnabled;
  final Future<void> Function() onNavigate;
  final ValueChanged<String> onAction;
  final VoidCallback onInteract;
  final VoidCallback onCapture;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(_T4Space.sm),
      child: Column(
        children: [
          Row(
            children: [
              IconButton(
                onPressed: controlsEnabled && preview.canGoBack
                    ? () => onAction('back')
                    : null,
                tooltip: 'Preview back',
                icon: const Icon(Icons.arrow_back),
              ),
              IconButton(
                onPressed: controlsEnabled && preview.canGoForward
                    ? () => onAction('forward')
                    : null,
                tooltip: 'Preview forward',
                icon: const Icon(Icons.arrow_forward),
              ),
              IconButton(
                onPressed: controlsEnabled ? () => onAction('reload') : null,
                tooltip: 'Reload preview',
                icon: const Icon(Icons.refresh),
              ),
              const SizedBox(width: _T4Space.xs),
              Expanded(
                child: TextField(
                  controller: controller,
                  focusNode: focusNode,
                  enabled: controlsEnabled,
                  keyboardType: TextInputType.url,
                  textInputAction: TextInputAction.go,
                  autocorrect: false,
                  decoration: const InputDecoration(
                    labelText: 'Preview address',
                    prefixIcon: Icon(Icons.link),
                  ),
                  onSubmitted: controlsEnabled ? (_) => onNavigate() : null,
                ),
              ),
              const SizedBox(width: _T4Space.xs),
              IconButton.filledTonal(
                onPressed: controlsEnabled ? onNavigate : null,
                tooltip: 'Navigate preview',
                icon: const Icon(Icons.arrow_forward),
              ),
            ],
          ),
          const SizedBox(height: _T4Space.xs),
          Wrap(
            alignment: WrapAlignment.end,
            spacing: _T4Space.xs,
            children: [
              TextButton.icon(
                onPressed: interactionEnabled ? onInteract : null,
                icon: const Icon(Icons.touch_app_outlined),
                label: const Text('Interact'),
              ),
              TextButton.icon(
                onPressed: captureEnabled ? onCapture : null,
                icon: const Icon(Icons.camera_alt_outlined),
                label: const Text('Capture'),
              ),
              TextButton.icon(
                onPressed: controlsEnabled ? () => onAction('close') : null,
                icon: const Icon(Icons.close),
                label: const Text('Close'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

final class _PreviewInteractionRequest {
  const _PreviewInteractionRequest({required this.action, required this.args});

  final String action;
  final Map<String, Object?> args;
}

final class _PreviewInteractionSheet extends StatefulWidget {
  const _PreviewInteractionSheet({
    required this.allowInput,
    required this.allowHandoff,
  });

  final bool allowInput;
  final bool allowHandoff;

  @override
  State<_PreviewInteractionSheet> createState() =>
      _PreviewInteractionSheetState();
}

final class _PreviewInteractionSheetState
    extends State<_PreviewInteractionSheet> {
  static const _templates = <String, String>{
    'click': '{"selector":"button"}',
    'fill': '{"selector":"input","text":"value"}',
    'type': '{"selector":"input","text":"value"}',
    'select': '{"selector":"select","value":"option"}',
    'press': '{"key":"Enter"}',
    'scroll': '{"deltaX":0,"deltaY":480}',
    'upload': '{"selector":"input[type=file]","path":"relative/file.txt"}',
    'handoff': '{"message":"Complete this step","mode":"manual"}',
  };

  late final List<String> _actions;
  late String _action;
  late final TextEditingController _argumentsController;
  String? _error;

  @override
  void initState() {
    super.initState();
    _actions = <String>[
      if (widget.allowInput) ...const [
        'click',
        'fill',
        'type',
        'select',
        'press',
        'scroll',
        'upload',
      ],
      if (widget.allowHandoff) 'handoff',
    ];
    _action = _actions.first;
    _argumentsController = TextEditingController(text: _templates[_action]);
  }

  @override
  void dispose() {
    _argumentsController.dispose();
    super.dispose();
  }

  void _selectAction(String? action) {
    if (action == null) return;
    setState(() {
      _action = action;
      _argumentsController.text = _templates[action] ?? '{}';
      _error = null;
    });
  }

  void _submit() {
    try {
      final decoded = jsonDecode(_argumentsController.text);
      if (decoded is! Map<String, dynamic>) {
        throw const FormatException('Arguments must be a JSON object.');
      }
      Navigator.pop(
        context,
        _PreviewInteractionRequest(
          action: _action,
          args: Map<String, Object?>.from(decoded),
        ),
      );
    } on FormatException catch (error) {
      setState(() => _error = error.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: EdgeInsets.fromLTRB(
        _T4Space.md,
        _T4Space.md,
        _T4Space.md,
        MediaQuery.viewInsetsOf(context).bottom + _T4Space.md,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'Preview interaction',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: _T4Space.md),
          DropdownButtonFormField<String>(
            initialValue: _action,
            decoration: const InputDecoration(labelText: 'Action'),
            items: [
              for (final action in _actions)
                DropdownMenuItem(value: action, child: Text(action)),
            ],
            onChanged: _selectAction,
          ),
          const SizedBox(height: _T4Space.md),
          TextField(
            controller: _argumentsController,
            minLines: 5,
            maxLines: 10,
            autocorrect: false,
            enableSuggestions: false,
            decoration: InputDecoration(
              labelText: 'Arguments (JSON)',
              alignLabelWithHint: true,
              errorText: _error,
            ),
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              fontFamily: _T4Typography.monoFamily,
            ),
          ),
          const SizedBox(height: _T4Space.md),
          FilledButton.icon(
            onPressed: _submit,
            icon: const Icon(Icons.play_arrow),
            label: Text('Run $_action'),
          ),
        ],
      ),
    );
  }
}

final class _PreviewStatus extends StatelessWidget {
  const _PreviewStatus({required this.preview});

  final PreviewWorkspaceState preview;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final captured = preview.capture != null;
    return Semantics(
      container: true,
      label:
          'Preview status ${preview.state}. ${captured ? 'Capture available' : 'No capture available'}',
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: _T4Space.md,
          vertical: _T4Space.xs,
        ),
        child: Row(
          children: [
            Icon(
              preview.error == null ? Icons.circle : Icons.error,
              size: _T4Space.xs,
              color: preview.error == null ? scheme.primary : scheme.error,
            ),
            const SizedBox(width: _T4Space.xs),
            Expanded(
              child: Text(
                '${preview.state} · ${captured ? 'Protocol capture ready' : 'Capture required'}',
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
              ),
            ),
            if (preview.captureMimeType case final mimeType?)
              Text(
                mimeType,
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  color: scheme.onSurfaceVariant,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

final class _PreviewCapture extends StatelessWidget {
  const _PreviewCapture({required this.preview});

  final PreviewWorkspaceState preview;

  @override
  Widget build(BuildContext context) {
    final capture = preview.capture;
    if (capture == null || capture.isEmpty) {
      return const _DeveloperUnavailable(
        icon: Icons.photo_outlined,
        title: 'No protocol capture',
        message:
            'Capture this preview to request rendered image bytes from the host. T4 does not execute the page or its HTML.',
      );
    }
    return Semantics(
      container: true,
      label: 'Protocol capture of ${preview.title ?? preview.url}',
      image: true,
      child: ColoredBox(
        color: Theme.of(context).colorScheme.surfaceContainerLowest,
        child: Padding(
          padding: const EdgeInsets.all(_T4Space.sm),
          child: Center(
            child: Image.memory(
              capture,
              fit: BoxFit.contain,
              gaplessPlayback: true,
              semanticLabel:
                  'Captured preview of ${preview.title ?? preview.url}',
              errorBuilder: (context, error, stackTrace) =>
                  const _DeveloperUnavailable(
                    icon: Icons.broken_image_outlined,
                    title: 'Capture could not be displayed',
                    message:
                        'The host returned image bytes that this device cannot decode.',
                  ),
            ),
          ),
        ),
      ),
    );
  }
}

bool _isDirectory(DeveloperFileEntry entry) {
  final kind = entry.kind.toLowerCase();
  return kind == 'directory' || kind == 'dir' || kind == 'folder';
}

String _parentPath(String path) {
  final normalized = path.replaceAll('\\', '/').replaceAll(RegExp(r'/+$'), '');
  final separator = normalized.lastIndexOf('/');
  return separator <= 0 ? '' : normalized.substring(0, separator);
}

String _baseName(String path) {
  final normalized = path.replaceAll('\\', '/').replaceAll(RegExp(r'/+$'), '');
  final separator = normalized.lastIndexOf('/');
  return separator < 0 ? normalized : normalized.substring(separator + 1);
}

String _formatByteCount(int bytes) {
  if (bytes < 1024) return '$bytes B';
  final kibibytes = bytes / 1024;
  if (kibibytes < 1024) return '${kibibytes.toStringAsFixed(1)} KiB';
  return '${(kibibytes / 1024).toStringAsFixed(1)} MiB';
}

String _formatActivityTime(DateTime value) {
  final local = value.toLocal();
  String twoDigits(int number) => number.toString().padLeft(2, '0');
  return '${local.year}-${twoDigits(local.month)}-${twoDigits(local.day)} '
      '${twoDigits(local.hour)}:${twoDigits(local.minute)}:${twoDigits(local.second)}';
}

String _redactActivityRaw(String raw) {
  const sensitiveKeys =
      r'authorization|cookie|password|passphrase|secret|token|api[_-]?key|credential|pairingCode';
  final keyedValue = RegExp(
    '("(?:$sensitiveKeys)"\\s*:\\s*)("(?:\\\\.|[^"\\\\])*"|[^,}\\s]+)',
    caseSensitive: false,
  );
  final bearer = RegExp(r'Bearer\s+[A-Za-z0-9._~+/=-]+', caseSensitive: false);
  return raw
      .replaceAllMapped(keyedValue, (match) => '${match.group(1)}"[REDACTED]"')
      .replaceAll(bearer, 'Bearer [REDACTED]');
}
