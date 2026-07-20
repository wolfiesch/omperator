part of 't4_app.dart';

const int _pairingCodeLength = 6;

String _hostActionError(Object error, String fallback) {
  final Object? message = switch (error) {
    FormatException() => error.message,
    StateError() => error.message,
    ArgumentError() => error.message,
    _ => null,
  };
  if (message case final String text when text.trim().isNotEmpty) {
    return text.trim();
  }
  return fallback;
}

extension on AuthenticationPhase {
  String get label => switch (this) {
    AuthenticationPhase.unknown => 'Authentication pending',
    AuthenticationPhase.local => 'Local access',
    AuthenticationPhase.pairingRequired => 'Pairing required',
    AuthenticationPhase.pairing => 'Pairing',
    AuthenticationPhase.paired => 'Paired',
  };
}

final class _HostOnboardingPage extends StatelessWidget {
  const _HostOnboardingPage({required this.state, required this.actions});

  final T4ViewState state;
  final T4Actions actions;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
          padding: const EdgeInsets.all(_T4Space.lg),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(
                maxWidth: _T4Layout.contentMaxWidth,
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: _T4Space.xl),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Connect to T4',
                      style: Theme.of(context).textTheme.headlineSmall,
                    ),
                    const SizedBox(height: _T4Space.sm),
                    Text(
                      'Add the private Tailnet address shown by T4 on your computer. '
                      'The app will remember this host on this device.',
                      style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ),
                    const SizedBox(height: _T4Space.xl),
                    _HostForm(
                      actions: actions,
                      operationPending: state.hostOperationPending,
                      submitLabel: 'Add host',
                      clearOnSuccess: false,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

final class _HostManagerPane extends StatefulWidget {
  const _HostManagerPane({
    required this.state,
    required this.actions,
    required this.onDone,
  });

  final T4ViewState state;
  final T4Actions actions;
  final VoidCallback onDone;

  @override
  State<_HostManagerPane> createState() => _HostManagerPaneState();
}

final class _HostManagerPaneState extends State<_HostManagerPane> {
  String? _pendingProfileKey;

  Future<void> _runProfileAction({
    required String endpointKey,
    required Future<void> Function() action,
    required String failureMessage,
  }) async {
    if (_pendingProfileKey != null || widget.state.hostOperationPending) return;
    setState(() => _pendingProfileKey = endpointKey);
    try {
      await action();
    } on Object catch (error) {
      if (!mounted) return;
      final messenger = ScaffoldMessenger.of(context);
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(content: Text(_hostActionError(error, failureMessage))),
        );
    } finally {
      if (mounted) setState(() => _pendingProfileKey = null);
    }
  }

  Future<void> _confirmRemove({
    required String endpointKey,
    required String label,
  }) async {
    if (_pendingProfileKey != null || widget.state.hostOperationPending) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Remove $label?'),
        content: const Text(
          'This removes the saved address and pairing credential from this '
          'device. The host and its sessions are not changed.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Keep host'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Remove host'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    await _runProfileAction(
      endpointKey: endpointKey,
      action: () => widget.actions.removeHost(endpointKey),
      failureMessage: 'Could not remove this host. Try again.',
    );
  }

  Widget _buildProfile(BuildContext context, int index) {
    final profile = widget.state.hostDirectory.profiles[index];
    final active =
        profile.endpointKey == widget.state.hostDirectory.activeEndpointKey;
    final pending =
        widget.state.hostOperationPending ||
        _pendingProfileKey == profile.endpointKey;
    final scheme = Theme.of(context).colorScheme;
    final status = active
        ? 'Current host · ${widget.state.connectionPhase.label} · '
              '${widget.state.authenticationPhase.label}'
        : 'Saved host';

    return Semantics(
      container: true,
      label: '${profile.label}, $status',
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: _T4Space.sm),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        profile.label,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: _T4Space.xxs),
                      Text(
                        profile.origin,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: scheme.onSurfaceVariant,
                        ),
                      ),
                      const SizedBox(height: _T4Space.xxs),
                      Text(
                        'Profile: ${profile.profileId}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: scheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
                if (active)
                  Padding(
                    padding: const EdgeInsets.only(left: _T4Space.sm),
                    child: Icon(
                      Icons.check_circle,
                      color: scheme.primary,
                      semanticLabel: 'Current host',
                    ),
                  ),
              ],
            ),
            const SizedBox(height: _T4Space.xs),
            Text(
              status,
              style: Theme.of(context).textTheme.labelMedium?.copyWith(
                color: active ? scheme.primary : scheme.onSurfaceVariant,
              ),
            ),
            if (active &&
                widget.state.authenticationPhase !=
                    AuthenticationPhase.unknown) ...[
              const SizedBox(height: _T4Space.xxs),
              _HostPermissionSummary(state: widget.state),
            ],
            const SizedBox(height: _T4Space.xs),
            Wrap(
              spacing: _T4Space.xs,
              runSpacing: _T4Space.xs,
              children: [
                if (!active)
                  Semantics(
                    button: true,
                    label: 'Switch to ${profile.label}',
                    child: OutlinedButton(
                      onPressed: pending
                          ? null
                          : () => unawaited(
                              _runProfileAction(
                                endpointKey: profile.endpointKey,
                                action: () => widget.actions.activateHost(
                                  profile.endpointKey,
                                ),
                                failureMessage:
                                    'Could not switch hosts. Try again.',
                              ),
                            ),
                      child: const Text('Switch'),
                    ),
                  ),
                Semantics(
                  button: true,
                  label: 'Remove ${profile.label}',
                  child: TextButton(
                    onPressed: pending
                        ? null
                        : () => unawaited(
                            _confirmRemove(
                              endpointKey: profile.endpointKey,
                              label: profile.label,
                            ),
                          ),
                    child: pending
                        ? const SizedBox.square(
                            dimension: _T4Size.indicator,
                            child: CircularProgressIndicator(
                              strokeWidth: _T4Size.thinStroke,
                              semanticsLabel: 'Updating saved host',
                            ),
                          )
                        : const Text('Remove'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final profiles = widget.state.hostDirectory.profiles;
    return SafeArea(
      top: false,
      child: CustomScrollView(
        keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
        slivers: [
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(
              _T4Space.lg,
              _T4Space.md,
              _T4Space.lg,
              _T4Space.xl,
            ),
            sliver: SliverToBoxAdapter(
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(
                    maxWidth: _T4Layout.contentMaxWidth,
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              'Saved hosts',
                              style: Theme.of(context).textTheme.headlineSmall,
                            ),
                          ),
                          TextButton(
                            onPressed: widget.onDone,
                            child: const Text('Done'),
                          ),
                        ],
                      ),
                      const SizedBox(height: _T4Space.sm),
                      Text(
                        'Choose which T4 host this app connects to.',
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                      ),
                      const SizedBox(height: _T4Space.lg),
                      for (var index = 0; index < profiles.length; index++) ...[
                        if (index > 0) const Divider(),
                        _buildProfile(context, index),
                      ],
                      const SizedBox(height: _T4Space.xl),
                      const Divider(),
                      const SizedBox(height: _T4Space.lg),
                      Text(
                        'Add another host',
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      const SizedBox(height: _T4Space.md),
                      _HostForm(
                        actions: widget.actions,
                        operationPending: widget.state.hostOperationPending,
                        submitLabel: 'Add host',
                        clearOnSuccess: true,
                      ),
                    ],
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

final class _HostPermissionSummary extends StatelessWidget {
  const _HostPermissionSummary({required this.state});

  final T4ViewState state;

  @override
  Widget build(BuildContext context) {
    final granted = state.grantedCapabilities;
    final missing = t4RequestedCapabilities
        .where((capability) => !granted.contains(capability))
        .toList(growable: false);
    final colors = Theme.of(context).colorScheme;
    return Semantics(
      container: true,
      label:
          'Granted ${granted.length} of '
          '${t4RequestedCapabilities.length} requested permissions',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Permissions: ${granted.length} of '
            '${t4RequestedCapabilities.length} granted',
            style: Theme.of(
              context,
            ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
          ),
          if (missing.isNotEmpty)
            Text(
              'Not granted: ${missing.join(', ')}',
              style: Theme.of(
                context,
              ).textTheme.bodySmall?.copyWith(color: colors.error),
            ),
        ],
      ),
    );
  }
}

final class _HostForm extends StatefulWidget {
  const _HostForm({
    required this.actions,
    required this.operationPending,
    required this.submitLabel,
    required this.clearOnSuccess,
  });

  final T4Actions actions;
  final bool operationPending;
  final String submitLabel;
  final bool clearOnSuccess;

  @override
  State<_HostForm> createState() => _HostFormState();
}

final class _HostFormState extends State<_HostForm> {
  final TextEditingController _addressController = TextEditingController();
  final TextEditingController _profileController = TextEditingController();
  final FocusNode _profileFocusNode = FocusNode(debugLabel: 'Host profile ID');
  String? _errorMessage;
  bool _submitting = false;

  bool get _pending => widget.operationPending || _submitting;

  Future<void> _submit() async {
    if (_pending) return;
    setState(() {
      _submitting = true;
      _errorMessage = null;
    });
    try {
      final profileId = _profileController.text;
      if (profileId.trim().isEmpty) {
        await widget.actions.addHost(_addressController.text);
      } else {
        await widget.actions.addHost(
          _addressController.text,
          profileId: profileId,
        );
      }
      if (!mounted) return;
      if (widget.clearOnSuccess) {
        _addressController.clear();
        _profileController.clear();
      }
    } on Object catch (error) {
      if (!mounted) return;
      setState(
        () => _errorMessage = _hostActionError(
          error,
          'Could not add this host. Check the address and try again.',
        ),
      );
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  void dispose() {
    widget.actions.cancelHostProbe();
    _addressController.dispose();
    _profileController.dispose();
    _profileFocusNode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final error = _errorMessage;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          textField: true,
          label: 'Tailnet HTTPS address',
          child: TextField(
            controller: _addressController,
            enabled: !_pending,
            keyboardType: TextInputType.url,
            textInputAction: TextInputAction.next,
            autofillHints: const [AutofillHints.url],
            onSubmitted: (_) => _profileFocusNode.requestFocus(),
            decoration: const InputDecoration(
              labelText: 'Tailnet HTTPS address',
              hintText: 'https://your-host.your-tailnet.ts.net',
            ),
          ),
        ),
        const SizedBox(height: _T4Space.md),
        Semantics(
          textField: true,
          label: 'Profile ID, optional',
          child: TextField(
            controller: _profileController,
            focusNode: _profileFocusNode,
            enabled: !_pending,
            textInputAction: TextInputAction.done,
            onSubmitted: (_) => unawaited(_submit()),
            decoration: const InputDecoration(
              labelText: 'Profile ID (optional)',
              hintText: 'default',
            ),
          ),
        ),
        if (error != null) ...[
          const SizedBox(height: _T4Space.sm),
          Semantics(
            liveRegion: true,
            label: 'Host error: $error',
            child: Text(
              error,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: Theme.of(context).colorScheme.error,
              ),
            ),
          ),
        ],
        const SizedBox(height: _T4Space.lg),
        Semantics(
          button: true,
          label: _pending ? 'Adding host' : widget.submitLabel,
          child: FilledButton(
            onPressed: _pending ? null : () => unawaited(_submit()),
            child: _pending
                ? const SizedBox.square(
                    dimension: _T4Size.indicator,
                    child: CircularProgressIndicator(
                      strokeWidth: _T4Size.thinStroke,
                      semanticsLabel: 'Adding host',
                    ),
                  )
                : Text(widget.submitLabel),
          ),
        ),
      ],
    );
  }
}

final class _PairingPane extends StatefulWidget {
  const _PairingPane({required this.state, required this.actions});

  final T4ViewState state;
  final T4Actions actions;

  @override
  State<_PairingPane> createState() => _PairingPaneState();
}

final class _PairingPaneState extends State<_PairingPane> {
  final TextEditingController _codeController = TextEditingController();
  final FocusNode _focusNode = FocusNode(debugLabel: 'Pairing code');
  bool _hasCompleteCode = false;
  bool _submitting = false;
  String? _errorMessage;
  bool _copiedCommand = false;

  bool get _pending =>
      widget.state.authenticationPhase == AuthenticationPhase.pairing ||
      widget.state.hostOperationPending ||
      _submitting;

  @override
  void initState() {
    super.initState();
    _codeController.addListener(_handleCodeChanged);
  }

  void _handleCodeChanged() {
    final complete = _codeController.text.length == _pairingCodeLength;
    if (complete == _hasCompleteCode) return;
    setState(() => _hasCompleteCode = complete);
  }

  Future<void> _submit() async {
    if (_pending || !_hasCompleteCode) return;
    final code = _codeController.text;
    _codeController.clear();
    setState(() {
      _submitting = true;
      _errorMessage = null;
    });
    try {
      await widget.actions.pairHost(code);
    } on Object {
      if (!mounted) return;
      setState(
        () => _errorMessage = 'Pairing failed. Check the code and try again.',
      );
      _focusNode.requestFocus();
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _copyPairCommand() async {
    await Clipboard.setData(ClipboardData(text: t4PairCommand));
    if (!mounted) return;
    setState(() => _copiedCommand = true);
  }

  @override
  void dispose() {
    _codeController
      ..removeListener(_handleCodeChanged)
      ..dispose();
    _focusNode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final error =
        _errorMessage ??
        (widget.state.authenticationPhase == AuthenticationPhase.pairingRequired
            ? widget.state.errorMessage
            : null);
    return SafeArea(
      top: false,
      child: SingleChildScrollView(
        keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
        padding: const EdgeInsets.all(_T4Space.lg),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              maxWidth: _T4Layout.contentMaxWidth,
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: _T4Space.xl),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Pair this device',
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  const SizedBox(height: _T4Space.sm),
                  Text(
                    'Enter the six-digit code shown by T4 on your computer.',
                    style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                  ),
                  Text(
                    'On the host computer, run this command to create a '
                    'one-time code:',
                    style: Theme.of(context).textTheme.bodyMedium,
                  ),
                  const SizedBox(height: _T4Space.sm),
                  DecoratedBox(
                    decoration: BoxDecoration(
                      color: Theme.of(
                        context,
                      ).colorScheme.surfaceContainerHighest,
                      borderRadius: BorderRadius.circular(_T4Radius.md),
                    ),
                    child: Padding(
                      padding: const EdgeInsets.all(_T4Space.sm),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(
                            child: SelectableText(
                              t4PairCommand,
                              style: Theme.of(context).textTheme.bodySmall
                                  ?.copyWith(
                                    fontFamily: _T4Typography.monoFamily,
                                  ),
                            ),
                          ),
                          IconButton(
                            onPressed: _copyPairCommand,
                            tooltip: 'Copy pair command',
                            icon: Icon(
                              _copiedCommand ? Icons.check : Icons.copy,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  Semantics(
                    liveRegion: true,
                    child: Text(
                      _copiedCommand ? 'Pair command copied.' : '',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ),
                  const SizedBox(height: _T4Space.lg),
                  const SizedBox(height: _T4Space.xl),
                  Semantics(
                    textField: true,
                    label: 'Six-digit pairing code',
                    child: TextField(
                      controller: _codeController,
                      focusNode: _focusNode,
                      enabled: !_pending,
                      autofocus: true,
                      obscureText: true,
                      obscuringCharacter: '•',
                      keyboardType: TextInputType.number,
                      textInputAction: TextInputAction.done,
                      autofillHints: const [AutofillHints.oneTimeCode],
                      inputFormatters: [
                        FilteringTextInputFormatter.digitsOnly,
                        LengthLimitingTextInputFormatter(_pairingCodeLength),
                      ],
                      onSubmitted: (_) => unawaited(_submit()),
                      decoration: const InputDecoration(
                        labelText: 'Pairing code',
                        hintText: '6 digits',
                      ),
                    ),
                  ),
                  if (error != null) ...[
                    const SizedBox(height: _T4Space.sm),
                    Semantics(
                      liveRegion: true,
                      label: error,
                      child: Text(
                        error,
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
                    ),
                  ],
                  const SizedBox(height: _T4Space.lg),
                  Semantics(
                    button: true,
                    label: _pending ? 'Pairing device' : 'Pair device',
                    child: FilledButton(
                      onPressed: _hasCompleteCode && !_pending
                          ? () => unawaited(_submit())
                          : null,
                      child: _pending
                          ? const SizedBox.square(
                              dimension: _T4Size.indicator,
                              child: CircularProgressIndicator(
                                strokeWidth: _T4Size.thinStroke,
                                semanticsLabel: 'Pairing device',
                              ),
                            )
                          : const Text('Pair device'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
