part of 't4_app.dart';

final class _UsageStatusPane extends StatefulWidget {
  const _UsageStatusPane({
    required this.state,
    required this.actions,
    required this.showHeader,
    required this.onDone,
  });

  final T4ViewState state;
  final T4Actions actions;
  final bool showHeader;
  final VoidCallback onDone;

  @override
  State<_UsageStatusPane> createState() => _UsageStatusPaneState();
}

final class _UsageStatusPaneState extends State<_UsageStatusPane> {
  UsageReadResult? _usage;
  BrokerStatusResult? _broker;
  String? _usageError;
  String? _brokerError;
  bool _loadingUsage = false;
  bool _loadingBroker = false;

  bool get _canReadUsage =>
      widget.state.connectionPhase == ConnectionPhase.ready &&
      widget.state.grantedCapabilities.contains('usage.read');

  bool get _canReadBroker =>
      widget.state.connectionPhase == ConnectionPhase.ready &&
      widget.state.grantedCapabilities.contains('broker.read');

  @override
  void initState() {
    super.initState();
    unawaited(_refresh());
  }

  Future<void> _refresh() async {
    if (_loadingUsage || _loadingBroker) return;
    setState(() {
      _loadingUsage = _canReadUsage;
      _loadingBroker = _canReadBroker;
      _usageError = null;
      _brokerError = null;
    });
    await Future.wait<void>([
      if (_canReadUsage) _refreshUsage(),
      if (_canReadBroker) _refreshBroker(),
    ]);
  }

  Future<void> _refreshUsage() async {
    try {
      final usage = await widget.actions.readUsage();
      if (mounted) setState(() => _usage = usage);
    } on Object {
      if (mounted) setState(() => _usageError = 'Usage could not be loaded.');
    } finally {
      if (mounted) setState(() => _loadingUsage = false);
    }
  }

  Future<void> _refreshBroker() async {
    try {
      final broker = await widget.actions.readBrokerStatus();
      if (mounted) setState(() => _broker = broker);
    } on Object {
      if (mounted) {
        setState(
          () => _brokerError = 'Account broker status could not be loaded.',
        );
      }
    } finally {
      if (mounted) setState(() => _loadingBroker = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final horizontal = widget.showHeader ? _T4Space.xl : _T4Space.md;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
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
                    'Usage & accounts',
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                ),
                IconButton(
                  onPressed: widget.onDone,
                  tooltip: 'Close usage',
                  icon: const Icon(Icons.close),
                ),
              ],
            ),
          ),
        if (_loadingUsage || _loadingBroker)
          const LinearProgressIndicator(
            semanticsLabel: 'Loading usage and account status',
          ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: _refresh,
            child: ListView(
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
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _buildBroker(context),
                        const SizedBox(height: _T4Space.xl),
                        _buildUsage(context),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildBroker(BuildContext context) {
    final broker = _broker;
    return _StatusSection(
      title: 'Account source',
      trailing: IconButton(
        onPressed: _loadingBroker ? null : () => unawaited(_refresh()),
        tooltip: 'Refresh usage and account status',
        icon: const Icon(Icons.refresh),
      ),
      child: !_canReadBroker
          ? const _StatusNotice(
              icon: Icons.lock_outline,
              title: 'Broker status unavailable',
              message: 'This host did not grant broker.read.',
            )
          : _brokerError != null
          ? _StatusNotice(
              icon: Icons.error_outline,
              title: 'Broker status unavailable',
              message: _brokerError!,
            )
          : broker == null
          ? const _StatusNotice(
              icon: Icons.hourglass_empty,
              title: 'Loading account source',
              message: 'Waiting for the connected host.',
            )
          : _BrokerStatusCard(status: broker),
    );
  }

  Widget _buildUsage(BuildContext context) {
    final usage = _usage;
    return _StatusSection(
      title: 'Usage limits',
      child: !_canReadUsage
          ? const _StatusNotice(
              icon: Icons.lock_outline,
              title: 'Usage unavailable',
              message: 'This host did not grant usage.read.',
            )
          : _usageError != null
          ? _StatusNotice(
              icon: Icons.error_outline,
              title: 'Usage unavailable',
              message: _usageError!,
            )
          : usage == null
          ? const _StatusNotice(
              icon: Icons.hourglass_empty,
              title: 'Loading usage',
              message: 'Waiting for provider reports.',
            )
          : _UsageReportList(result: usage),
    );
  }
}

final class _StatusSection extends StatelessWidget {
  const _StatusSection({
    required this.title,
    required this.child,
    this.trailing,
  });

  final String title;
  final Widget child;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Row(
        children: [
          Expanded(
            child: Text(title, style: Theme.of(context).textTheme.titleLarge),
          ),
          ?trailing,
        ],
      ),
      const SizedBox(height: _T4Space.sm),
      child,
    ],
  );
}

final class _StatusNotice extends StatelessWidget {
  const _StatusNotice({
    required this.icon,
    required this.title,
    required this.message,
  });

  final IconData icon;
  final String title;
  final String message;

  @override
  Widget build(BuildContext context) => Card(
    margin: EdgeInsets.zero,
    child: ListTile(
      leading: Icon(icon),
      title: Text(title),
      subtitle: Text(message),
    ),
  );
}

final class _BrokerStatusCard extends StatelessWidget {
  const _BrokerStatusCard({required this.status});

  final BrokerStatusResult status;

  @override
  Widget build(BuildContext context) {
    final (icon, title, message) = switch (status.state) {
      BrokerState.local => (
        Icons.computer,
        'Local accounts',
        'Provider accounts are configured on this OMP host.',
      ),
      BrokerState.connected => (
        Icons.cloud_done_outlined,
        'Broker connected',
        status.endpoint ?? 'The remote account broker is connected.',
      ),
      BrokerState.missingToken => (
        Icons.key_off_outlined,
        'Broker token missing',
        status.endpoint ?? 'The host needs a broker token.',
      ),
      BrokerState.unreachable => (
        Icons.cloud_off_outlined,
        'Broker unreachable',
        status.endpoint ?? 'The configured broker cannot be reached.',
      ),
    };
    return Card(
      margin: EdgeInsets.zero,
      child: ListTile(
        leading: Icon(icon),
        title: Text(title),
        subtitle: Text(message),
      ),
    );
  }
}

final class _UsageReportList extends StatelessWidget {
  const _UsageReportList({required this.result});

  final UsageReadResult result;

  @override
  Widget build(BuildContext context) {
    final generated = DateTime.fromMillisecondsSinceEpoch(result.generatedAt);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Updated ${_formatActivityTime(generated)}',
          style: Theme.of(context).textTheme.labelSmall,
        ),
        const SizedBox(height: _T4Space.sm),
        if (result.reports.isEmpty)
          const _StatusNotice(
            icon: Icons.data_usage,
            title: 'No usage reports',
            message: 'No provider returned a usage report.',
          )
        else
          for (final report in result.reports) ...[
            _UsageProviderCard(report: report),
            const SizedBox(height: _T4Space.sm),
          ],
        if (result.accountsWithoutUsage.isNotEmpty) ...[
          const SizedBox(height: _T4Space.sm),
          Text(
            'Accounts without usage data',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: _T4Space.xs),
          for (final account in result.accountsWithoutUsage)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.account_circle_outlined),
              title: Text(account.provider),
              subtitle: Text(
                account.email ?? account.orgName ?? account.type.name,
              ),
            ),
        ],
      ],
    );
  }
}

final class _UsageProviderCard extends StatelessWidget {
  const _UsageProviderCard({required this.report});

  final UsageReport report;

  @override
  Widget build(BuildContext context) => Card(
    margin: EdgeInsets.zero,
    child: Padding(
      padding: const EdgeInsets.all(_T4Space.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  report.provider,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              if (report.availableResetCredits case final credits?)
                Chip(label: Text('$credits reset credits')),
            ],
          ),
          if (report.limits.isEmpty)
            const Padding(
              padding: EdgeInsets.only(top: _T4Space.sm),
              child: Text('No limits reported.'),
            )
          else
            for (final limit in report.limits) ...[
              const SizedBox(height: _T4Space.md),
              _UsageLimitMeter(limit: limit),
            ],
          for (final note in report.notes)
            Padding(
              padding: const EdgeInsets.only(top: _T4Space.xs),
              child: Text(note, style: Theme.of(context).textTheme.bodySmall),
            ),
        ],
      ),
    ),
  );
}

final class _UsageLimitMeter extends StatelessWidget {
  const _UsageLimitMeter({required this.limit});

  final UsageLimit limit;

  @override
  Widget build(BuildContext context) {
    final amount = limit.amount;
    final fraction = _usageFraction(amount);
    final detail = _usageAmountLabel(amount);
    final scheme = Theme.of(context).colorScheme;
    final color = switch (limit.status) {
      UsageStatus.exhausted => scheme.error,
      UsageStatus.warning => scheme.tertiary,
      _ => scheme.primary,
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(child: Text(limit.label)),
            Text(detail, style: Theme.of(context).textTheme.labelMedium),
          ],
        ),
        const SizedBox(height: _T4Space.xs),
        LinearProgressIndicator(
          value: fraction,
          color: color,
          semanticsLabel: '${limit.label}: $detail',
        ),
        if (limit.window case final window?)
          Padding(
            padding: const EdgeInsets.only(top: _T4Space.xxs),
            child: Text(
              window.resetsAt == null
                  ? window.label
                  : '${window.label} · resets ${_formatActivityTime(DateTime.fromMillisecondsSinceEpoch(window.resetsAt!))}',
              style: Theme.of(context).textTheme.labelSmall,
            ),
          ),
        for (final note in limit.notes)
          Padding(
            padding: const EdgeInsets.only(top: _T4Space.xxs),
            child: Text(note, style: Theme.of(context).textTheme.bodySmall),
          ),
      ],
    );
  }
}

double? _usageFraction(UsageAmount amount) {
  final explicit =
      amount.usedFraction ??
      (amount.remainingFraction == null ? null : 1 - amount.remainingFraction!);
  final calculated =
      amount.used != null && amount.limit != null && amount.limit != 0
      ? amount.used! / amount.limit!
      : null;
  final value = explicit ?? calculated;
  return value?.clamp(0, 1).toDouble();
}

String _usageAmountLabel(UsageAmount amount) {
  final unit = switch (amount.unit) {
    UsageUnit.percent => '%',
    UsageUnit.usd => ' USD',
    UsageUnit.tokens => ' tokens',
    UsageUnit.requests => ' requests',
    UsageUnit.minutes => ' min',
    UsageUnit.bytes => ' bytes',
    UsageUnit.unknown => '',
  };
  if (amount.used != null && amount.limit != null) {
    return '${_compactNumber(amount.used!)} / ${_compactNumber(amount.limit!)}$unit';
  }
  if (amount.remaining != null) {
    return '${_compactNumber(amount.remaining!)}$unit remaining';
  }
  final fraction = _usageFraction(amount);
  return fraction == null ? 'Reported' : '${(fraction * 100).round()}% used';
}

String _compactNumber(double value) => value == value.roundToDouble()
    ? value.toInt().toString()
    : value.toStringAsFixed(2);
