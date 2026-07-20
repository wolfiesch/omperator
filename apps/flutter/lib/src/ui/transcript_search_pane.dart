part of 't4_app.dart';

final class _TranscriptSearchPane extends StatefulWidget {
  const _TranscriptSearchPane({
    required this.actions,
    required this.showHeader,
    required this.onDone,
    required this.onOpenSession,
  });

  final T4Actions actions;
  final bool showHeader;
  final VoidCallback onDone;
  final Future<void> Function(String sessionId) onOpenSession;

  @override
  State<_TranscriptSearchPane> createState() => _TranscriptSearchPaneState();
}

final class _TranscriptSearchPaneState extends State<_TranscriptSearchPane> {
  final TextEditingController _query = TextEditingController();
  final TextEditingController _project = TextEditingController();
  final Set<TranscriptSearchRole> _roles = <TranscriptSearchRole>{};
  final Map<String, TranscriptContextResult> _contexts =
      <String, TranscriptContextResult>{};
  final Set<String> _loadingContexts = <String>{};
  TranscriptSearchResult? _result;
  String _archived = 'include';
  String? _error;
  bool _searching = false;
  int _requestGeneration = 0;

  @override
  void dispose() {
    _query.dispose();
    _project.dispose();
    super.dispose();
  }

  Future<void> _search({bool append = false}) async {
    final query = _query.text.trim();
    if (query.isEmpty || _searching) return;
    final generation = ++_requestGeneration;
    setState(() {
      _searching = true;
      _error = null;
      if (!append) {
        _result = null;
        _contexts.clear();
        _loadingContexts.clear();
      }
    });
    try {
      final next = await widget.actions.searchTranscripts(
        query: query,
        cursor: append ? _result?.nextCursor : null,
        projectId: _project.text.trim().isEmpty ? null : _project.text.trim(),
        roles: _roles.isEmpty ? null : _roles.toList(growable: false),
        archived: _archived,
      );
      if (!mounted || generation != _requestGeneration) return;
      final current = _result;
      setState(() {
        if (append && current != null) {
          _result = TranscriptSearchResult(
            items: List<TranscriptSearchItem>.unmodifiable(
              <TranscriptSearchItem>[...current.items, ...next.items],
            ),
            nextCursor: next.nextCursor,
            incomplete: next.incomplete,
            index: next.index,
          );
        } else {
          _result = next;
        }
      });
    } on Object catch (error) {
      if (!mounted || generation != _requestGeneration) return;
      setState(() => _error = 'Search failed: $error');
    } finally {
      if (mounted && generation == _requestGeneration) {
        setState(() => _searching = false);
      }
    }
  }

  Future<void> _loadContext(TranscriptSearchItem item) async {
    if (_loadingContexts.contains(item.anchorId)) return;
    setState(() {
      _loadingContexts.add(item.anchorId);
      _error = null;
    });
    try {
      final context = await widget.actions.loadTranscriptContext(
        sessionId: item.sessionId,
        anchorId: item.anchorId,
      );
      if (!mounted) return;
      setState(() => _contexts[item.anchorId] = context);
    } on Object catch (error) {
      if (!mounted) return;
      setState(() => _error = 'Context failed: $error');
    } finally {
      if (mounted) setState(() => _loadingContexts.remove(item.anchorId));
    }
  }

  @override
  Widget build(BuildContext context) {
    final result = _result;
    return Column(
      children: [
        if (widget.showHeader)
          Padding(
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
                    'Search transcripts',
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                ),
                IconButton(
                  onPressed: widget.onDone,
                  tooltip: 'Close search',
                  icon: const Icon(Icons.close),
                ),
              ],
            ),
          ),
        Expanded(
          child: CustomScrollView(
            slivers: [
              SliverPadding(
                padding: const EdgeInsets.all(_T4Space.lg),
                sliver: SliverList.list(
                  children: [
                    TextField(
                      controller: _query,
                      autofocus: true,
                      textInputAction: TextInputAction.search,
                      onSubmitted: (_) => unawaited(_search()),
                      decoration: InputDecoration(
                        labelText: 'Search transcripts',
                        hintText: 'Error text, decision, command…',
                        prefixIcon: const Icon(Icons.search),
                        suffixIcon: IconButton(
                          tooltip: 'Search',
                          onPressed: _searching
                              ? null
                              : () => unawaited(_search()),
                          icon: _searching
                              ? const SizedBox.square(
                                  dimension: _T4Size.indicator,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                )
                              : const Icon(Icons.arrow_forward),
                        ),
                      ),
                    ),
                    const SizedBox(height: _T4Space.sm),
                    TextField(
                      controller: _project,
                      textInputAction: TextInputAction.done,
                      onSubmitted: (_) => unawaited(_search()),
                      decoration: const InputDecoration(
                        labelText: 'Project ID (optional)',
                        prefixIcon: Icon(Icons.folder_outlined),
                      ),
                    ),
                    const SizedBox(height: _T4Space.sm),
                    Wrap(
                      spacing: _T4Space.xs,
                      runSpacing: _T4Space.xs,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        for (final role in TranscriptSearchRole.values)
                          FilterChip(
                            label: Text(_roleLabel(role)),
                            selected: _roles.contains(role),
                            onSelected: (selected) => setState(() {
                              if (selected) {
                                _roles.add(role);
                              } else {
                                _roles.remove(role);
                              }
                            }),
                          ),
                        Tooltip(
                          message: 'Archived sessions',
                          child: DropdownButton<String>(
                            value: _archived,
                            items: const [
                              DropdownMenuItem(
                                value: 'include',
                                child: Text('All sessions'),
                              ),
                              DropdownMenuItem(
                                value: 'exclude',
                                child: Text('Current only'),
                              ),
                              DropdownMenuItem(
                                value: 'only',
                                child: Text('Archived only'),
                              ),
                            ],
                            onChanged: _searching
                                ? null
                                : (value) => setState(() => _archived = value!),
                          ),
                        ),
                      ],
                    ),
                    if (_error case final error?) ...[
                      const SizedBox(height: _T4Space.sm),
                      Card(
                        color: Theme.of(context).colorScheme.errorContainer,
                        child: ListTile(
                          leading: const Icon(Icons.error_outline),
                          title: const Text('Search unavailable'),
                          subtitle: Text(error),
                        ),
                      ),
                    ],
                    if (result != null) ...[
                      const SizedBox(height: _T4Space.md),
                      _SearchIndexStatus(status: result.index),
                      if (result.items.isEmpty)
                        const Padding(
                          padding: EdgeInsets.symmetric(vertical: _T4Space.xl),
                          child: Column(
                            children: [
                              Icon(Icons.search_off, size: _T4Size.emptyIcon),
                              SizedBox(height: _T4Space.sm),
                              Text('No matching transcripts'),
                              SizedBox(height: _T4Space.xxs),
                              Text('Try fewer filters or a different phrase.'),
                            ],
                          ),
                        ),
                    ],
                  ],
                ),
              ),
              if (result != null)
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(
                    _T4Space.lg,
                    0,
                    _T4Space.lg,
                    _T4Space.xl,
                  ),
                  sliver: SliverList.separated(
                    itemCount: result.items.length,
                    separatorBuilder: (_, _) =>
                        const SizedBox(height: _T4Space.sm),
                    itemBuilder: (context, index) {
                      final item = result.items[index];
                      return _TranscriptSearchCard(
                        item: item,
                        contextResult: _contexts[item.anchorId],
                        loadingContext: _loadingContexts.contains(
                          item.anchorId,
                        ),
                        onLoadContext: () => unawaited(_loadContext(item)),
                        onOpenSession: item.archivedAt == null
                            ? () => unawaited(
                                widget.onOpenSession(item.sessionId),
                              )
                            : null,
                      );
                    },
                  ),
                ),
              if (result?.nextCursor != null)
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(
                    _T4Space.lg,
                    0,
                    _T4Space.lg,
                    _T4Space.xl,
                  ),
                  sliver: SliverToBoxAdapter(
                    child: OutlinedButton.icon(
                      onPressed: _searching
                          ? null
                          : () => unawaited(_search(append: true)),
                      icon: const Icon(Icons.expand_more),
                      label: const Text('Load more'),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

final class _SearchIndexStatus extends StatelessWidget {
  const _SearchIndexStatus({required this.status});

  final TranscriptSearchIndexStatus status;

  @override
  Widget build(BuildContext context) {
    final indexed = status.indexedSessions;
    final known = status.knownSessions;
    final label = switch (status.state) {
      TranscriptSearchIndexState.ready => '$known sessions indexed',
      TranscriptSearchIndexState.building =>
        'Indexing $indexed of $known sessions',
      TranscriptSearchIndexState.stale =>
        'Results may be incomplete while the index refreshes',
    };
    return Row(
      children: [
        Icon(
          status.state == TranscriptSearchIndexState.ready
              ? Icons.check_circle_outline
              : Icons.sync,
          size: _T4Size.indicator,
        ),
        const SizedBox(width: _T4Space.xs),
        Expanded(
          child: Text(label, style: Theme.of(context).textTheme.bodySmall),
        ),
      ],
    );
  }
}

final class _TranscriptSearchCard extends StatelessWidget {
  const _TranscriptSearchCard({
    required this.item,
    required this.contextResult,
    required this.loadingContext,
    required this.onLoadContext,
    required this.onOpenSession,
  });

  final TranscriptSearchItem item;
  final TranscriptContextResult? contextResult;
  final bool loadingContext;
  final VoidCallback onLoadContext;
  final VoidCallback? onOpenSession;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(_T4Space.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    item.sessionTitle.isEmpty
                        ? 'Untitled session'
                        : item.sessionTitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                ),
                if (item.archivedAt != null)
                  const Padding(
                    padding: EdgeInsets.only(left: _T4Space.xs),
                    child: Chip(label: Text('Archived')),
                  ),
              ],
            ),
            const SizedBox(height: _T4Space.xxs),
            Text(
              '${_roleLabel(item.role)} · ${_formatTranscriptTime(item.timestamp)}',
              style: Theme.of(
                context,
              ).textTheme.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
            ),
            const SizedBox(height: _T4Space.sm),
            SelectionArea(child: _HighlightedSnippet(item: item)),
            const SizedBox(height: _T4Space.sm),
            Wrap(
              spacing: _T4Space.xs,
              runSpacing: _T4Space.xs,
              children: [
                TextButton.icon(
                  onPressed: loadingContext || contextResult != null
                      ? null
                      : onLoadContext,
                  icon: loadingContext
                      ? const SizedBox.square(
                          dimension: _T4Size.indicator,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.history),
                  label: Text(
                    contextResult == null ? 'Show context' : 'Context loaded',
                  ),
                ),
                if (onOpenSession != null)
                  TextButton.icon(
                    onPressed: onOpenSession,
                    icon: const Icon(Icons.open_in_new),
                    label: const Text('Open session'),
                  ),
              ],
            ),
            if (contextResult case final contextResult?) ...[
              const Divider(),
              for (var index = 0; index < contextResult.rows.length; index++)
                _TranscriptContextRowView(
                  row: contextResult.rows[index],
                  anchor: index == contextResult.anchorIndex,
                ),
              if (contextResult.hasBefore || contextResult.hasAfter)
                Padding(
                  padding: const EdgeInsets.only(top: _T4Space.xs),
                  child: Text(
                    'More transcript exists outside this context window.',
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }
}

final class _HighlightedSnippet extends StatelessWidget {
  const _HighlightedSnippet({required this.item});

  final TranscriptSearchItem item;

  @override
  Widget build(BuildContext context) {
    final base = Theme.of(context).textTheme.bodyMedium;
    final highlight = base?.copyWith(
      fontWeight: FontWeight.w700,
      backgroundColor: Theme.of(context).colorScheme.tertiaryContainer,
    );
    final spans = <TextSpan>[];
    var offset = 0;
    for (final range in item.highlights) {
      if (range.end <= offset) continue;
      final start = range.start < offset ? offset : range.start;
      if (start > offset) {
        spans.add(TextSpan(text: item.snippet.substring(offset, start)));
      }
      spans.add(
        TextSpan(
          text: item.snippet.substring(start, range.end),
          style: highlight,
        ),
      );
      offset = range.end;
    }
    if (offset < item.snippet.length) {
      spans.add(TextSpan(text: item.snippet.substring(offset)));
    }
    return Text.rich(TextSpan(style: base, children: spans));
  }
}

final class _TranscriptContextRowView extends StatelessWidget {
  const _TranscriptContextRowView({required this.row, required this.anchor});

  final TranscriptContextRow row;
  final bool anchor;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: _T4Space.xs),
      padding: const EdgeInsets.all(_T4Space.sm),
      decoration: BoxDecoration(
        color: anchor ? scheme.secondaryContainer : scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(_T4Radius.sm),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '${_roleLabel(row.role)} · ${_formatTranscriptTime(row.timestamp)}',
            style: Theme.of(context).textTheme.labelSmall,
          ),
          const SizedBox(height: _T4Space.xxs),
          SelectionArea(child: Text(row.text)),
        ],
      ),
    );
  }
}

String _roleLabel(TranscriptSearchRole role) => switch (role) {
  TranscriptSearchRole.user => 'User',
  TranscriptSearchRole.assistant => 'Assistant',
  TranscriptSearchRole.summary => 'Summary',
};

String _formatTranscriptTime(String value) {
  final parsed = DateTime.tryParse(value);
  return parsed == null ? value : _formatActivityTime(parsed);
}
