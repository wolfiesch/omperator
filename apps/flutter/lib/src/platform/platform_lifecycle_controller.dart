import 'dart:async';

import 'package:flutter/foundation.dart';

import 'platform_lifecycle.dart';

final class PlatformLifecycleViewState {
  const PlatformLifecycleViewState({
    required this.runtime,
    required this.update,
    this.initializing = false,
    this.runtimeOperationPending = false,
    this.updateOperationPending = false,
    this.errorMessage,
  });

  const PlatformLifecycleViewState.initial()
    : runtime = const RuntimeServiceStatus.unsupported(),
      update = const PlatformUpdateStatus.unsupported(),
      initializing = true,
      runtimeOperationPending = false,
      updateOperationPending = false,
      errorMessage = null;

  final RuntimeServiceStatus runtime;
  final PlatformUpdateStatus update;
  final bool initializing;
  final bool runtimeOperationPending;
  final bool updateOperationPending;
  final String? errorMessage;

  PlatformLifecycleViewState copyWith({
    RuntimeServiceStatus? runtime,
    PlatformUpdateStatus? update,
    bool? initializing,
    bool? runtimeOperationPending,
    bool? updateOperationPending,
    String? errorMessage,
    bool clearError = false,
  }) => PlatformLifecycleViewState(
    runtime: runtime ?? this.runtime,
    update: update ?? this.update,
    initializing: initializing ?? this.initializing,
    runtimeOperationPending:
        runtimeOperationPending ?? this.runtimeOperationPending,
    updateOperationPending:
        updateOperationPending ?? this.updateOperationPending,
    errorMessage: clearError ? null : errorMessage ?? this.errorMessage,
  );
}

abstract interface class PlatformLifecycleActions {
  Future<void> refreshPlatformState();
  Future<void> installRuntime();
  Future<void> startRuntime();
  Future<void> stopRuntime();
  Future<void> restartRuntime();
  Future<void> uninstallRuntime();
  Future<void> checkForUpdates();
  Future<void> downloadUpdate();
  Future<void> installUpdate();
}

final class PlatformLifecycleController extends ChangeNotifier
    implements PlatformLifecycleActions {
  PlatformLifecycleController()
    : _bridge = const MethodChannelPlatformLifecycleBridge();

  @visibleForTesting
  PlatformLifecycleController.withBridge(this._bridge);

  final PlatformLifecycleBridge _bridge;
  PlatformLifecycleViewState _state =
      const PlatformLifecycleViewState.initial();
  bool _disposed = false;

  PlatformLifecycleViewState get state => _state;

  Future<void> initialize() async {
    final results = await Future.wait<Object?>(
      [
        _bridge.supportsRuntimeService
            ? _bridge.inspectRuntime()
            : Future<RuntimeServiceStatus>.value(
                const RuntimeServiceStatus.unsupported(),
              ),
        _bridge.supportsUpdates
            ? _bridge.getUpdateState()
            : Future<PlatformUpdateStatus>.value(
                const PlatformUpdateStatus.unsupported(),
              ),
      ].map((future) async {
        try {
          return await future;
        } on Object catch (error) {
          return error;
        }
      }),
    );
    if (_disposed) return;
    final runtime = results[0];
    final update = results[1];
    final errors = <String>[
      if (runtime is! RuntimeServiceStatus) _safeError(runtime),
      if (update is! PlatformUpdateStatus) _safeError(update),
    ];
    _state = PlatformLifecycleViewState(
      runtime: runtime is RuntimeServiceStatus
          ? runtime
          : _bridge.supportsRuntimeService
          ? const RuntimeServiceStatus(
              supported: true,
              available: false,
              definition: RuntimeDefinitionState.missing,
              service: RuntimeServicePhase.unknown,
              diagnostics: '',
              issueCode: 'runtime_status_unavailable',
              message: 'The desktop OMP runtime status could not be loaded.',
            )
          : const RuntimeServiceStatus.unsupported(),
      update: update is PlatformUpdateStatus
          ? update
          : _bridge.supportsUpdates
          ? const PlatformUpdateStatus(
              supported: true,
              currentVersion: 'unknown',
              phase: PlatformUpdatePhase.error,
              error: 'update_status_unavailable',
              message: 'The app update status could not be loaded.',
            )
          : const PlatformUpdateStatus.unsupported(),
      errorMessage: errors.isEmpty ? null : errors.join(' '),
    );
    _notify();
  }

  @override
  Future<void> refreshPlatformState() => _runBoth(
    runtime: _bridge.supportsRuntimeService ? _bridge.inspectRuntime : null,
    update: _bridge.supportsUpdates ? _bridge.getUpdateState : null,
  );

  @override
  Future<void> installRuntime() => _runRuntime(_bridge.installRuntime);

  @override
  Future<void> startRuntime() => _runRuntime(_bridge.startRuntime);

  @override
  Future<void> stopRuntime() => _runRuntime(_bridge.stopRuntime);

  @override
  Future<void> restartRuntime() => _runRuntime(_bridge.restartRuntime);

  @override
  Future<void> uninstallRuntime() => _runRuntime(_bridge.uninstallRuntime);

  @override
  Future<void> checkForUpdates() => _runUpdate(_bridge.checkForUpdates);

  @override
  Future<void> downloadUpdate() => _runUpdate(_bridge.downloadUpdate);

  @override
  Future<void> installUpdate() => _runUpdate(_bridge.installUpdate);

  Future<void> _runBoth({
    Future<RuntimeServiceStatus> Function()? runtime,
    Future<PlatformUpdateStatus> Function()? update,
  }) async {
    if (_state.runtimeOperationPending || _state.updateOperationPending) return;
    _state = _state.copyWith(
      runtimeOperationPending: runtime != null,
      updateOperationPending: update != null,
      clearError: true,
    );
    _notify();
    try {
      final runtimeFuture = runtime?.call();
      final updateFuture = update?.call();
      final runtimeResult = runtimeFuture == null ? null : await runtimeFuture;
      final updateResult = updateFuture == null ? null : await updateFuture;
      if (_disposed) return;
      _state = _state.copyWith(
        runtime: runtimeResult,
        update: updateResult,
        runtimeOperationPending: false,
        updateOperationPending: false,
        clearError: true,
      );
    } on Object catch (error) {
      if (_disposed) return;
      _state = _state.copyWith(
        runtimeOperationPending: false,
        updateOperationPending: false,
        errorMessage: _safeError(error),
      );
    }
    _notify();
  }

  Future<void> _runRuntime(
    Future<RuntimeServiceStatus> Function() operation,
  ) async {
    if (!_bridge.supportsRuntimeService || _state.runtimeOperationPending) {
      return;
    }
    _state = _state.copyWith(runtimeOperationPending: true, clearError: true);
    _notify();
    try {
      final runtime = await operation();
      if (_disposed) return;
      _state = _state.copyWith(
        runtime: runtime,
        runtimeOperationPending: false,
        clearError: true,
      );
    } on Object catch (error) {
      if (_disposed) return;
      _state = _state.copyWith(
        runtimeOperationPending: false,
        errorMessage: _safeError(error),
      );
    }
    _notify();
  }

  Future<void> _runUpdate(
    Future<PlatformUpdateStatus> Function() operation,
  ) async {
    if (!_bridge.supportsUpdates || _state.updateOperationPending) return;
    _state = _state.copyWith(updateOperationPending: true, clearError: true);
    _notify();
    try {
      final update = await operation();
      if (_disposed) return;
      _state = _state.copyWith(
        update: update,
        updateOperationPending: false,
        clearError: true,
      );
    } on Object catch (error) {
      if (_disposed) return;
      _state = _state.copyWith(
        updateOperationPending: false,
        errorMessage: _safeError(error),
      );
    }
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

String _safeError(Object? error) {
  var message = error.toString().replaceAll(
    RegExp(r'[\u0000-\u0008\u000b\u000c\u000e-\u001f]'),
    '',
  );
  message = message.replaceAllMapped(
    RegExp(
      r'(authorization|cookie|password|passphrase|secret|token|api[_-]?key|credential)(\s*[:=]\s*)(\S+)',
      caseSensitive: false,
    ),
    (match) => '${match.group(1)}${match.group(2)}[REDACTED]',
  );
  message = message.replaceAll(
    RegExp(r'Bearer\s+\S+', caseSensitive: false),
    'Bearer [REDACTED]',
  );
  return message.length <= 512 ? message : message.substring(0, 512);
}
