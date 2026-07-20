import 'package:flutter_test/flutter_test.dart';
import 'package:t4code/src/platform/platform_lifecycle.dart';
import 'package:t4code/src/platform/platform_lifecycle_controller.dart';

void main() {
  test('initializes supported runtime and updater state', () async {
    final bridge = _FakeBridge(runtimeSupported: true, updatesSupported: true);
    final controller = PlatformLifecycleController.withBridge(bridge);

    await controller.initialize();

    expect(controller.state.initializing, isFalse);
    expect(controller.state.runtime.service, RuntimeServicePhase.stopped);
    expect(controller.state.update.phase, PlatformUpdatePhase.idle);
    expect(bridge.runtimeInspections, 1);
    expect(bridge.updateReads, 1);
  });

  test(
    'keeps supported controls recoverable after initialization errors',
    () async {
      final bridge = _FakeBridge(runtimeSupported: true, updatesSupported: true)
        ..runtimeInspectionFailure = StateError('runtime unavailable')
        ..updateReadFailure = StateError('update unavailable');
      final controller = PlatformLifecycleController.withBridge(bridge);

      await controller.initialize();

      expect(controller.state.runtime.supported, isTrue);
      expect(controller.state.runtime.service, RuntimeServicePhase.unknown);
      expect(controller.state.runtime.issueCode, 'runtime_status_unavailable');
      expect(controller.state.update.supported, isTrue);
      expect(controller.state.update.phase, PlatformUpdatePhase.error);
      expect(controller.state.update.error, 'update_status_unavailable');
      expect(controller.state.errorMessage, contains('runtime unavailable'));
    },
  );

  test('serializes runtime actions and publishes the returned state', () async {
    final bridge = _FakeBridge(runtimeSupported: true);
    final controller = PlatformLifecycleController.withBridge(bridge);
    await controller.initialize();

    await controller.startRuntime();
    await controller.restartRuntime();

    expect(bridge.runtimeStarts, 1);
    expect(bridge.runtimeRestarts, 1);
    expect(controller.state.runtime.service, RuntimeServicePhase.running);
    expect(controller.state.runtimeOperationPending, isFalse);
  });

  test('keeps unsupported operations inert', () async {
    final bridge = _FakeBridge();
    final controller = PlatformLifecycleController.withBridge(bridge);
    await controller.initialize();

    await controller.startRuntime();
    await controller.checkForUpdates();

    expect(bridge.runtimeStarts, 0);
    expect(bridge.updateChecks, 0);
    expect(controller.state.runtime.supported, isFalse);
    expect(controller.state.update.supported, isFalse);
  });

  test(
    'reports bounded platform errors without leaving a pending action',
    () async {
      final bridge = _FakeBridge(runtimeSupported: true)
        ..runtimeFailure = StateError('failed token=super-secret');
      final controller = PlatformLifecycleController.withBridge(bridge);
      await controller.initialize();

      await controller.startRuntime();

      expect(controller.state.runtimeOperationPending, isFalse);
      expect(controller.state.errorMessage, contains('failed'));
      expect(controller.state.errorMessage, isNot(contains('super-secret')));
      expect(controller.state.errorMessage, contains('token=[REDACTED]'));
    },
  );
}

final class _FakeBridge implements PlatformLifecycleBridge {
  _FakeBridge({this.runtimeSupported = false, this.updatesSupported = false});

  final bool runtimeSupported;
  final bool updatesSupported;
  int runtimeInspections = 0;
  int runtimeStarts = 0;
  int runtimeRestarts = 0;
  int updateReads = 0;
  int updateChecks = 0;
  Object? runtimeFailure;
  Object? runtimeInspectionFailure;
  Object? updateReadFailure;

  @override
  bool get supportsRuntimeService => runtimeSupported;

  @override
  bool get supportsUpdates => updatesSupported;

  RuntimeServiceStatus get _stopped => const RuntimeServiceStatus(
    supported: true,
    available: true,
    definition: RuntimeDefinitionState.current,
    service: RuntimeServicePhase.stopped,
    diagnostics: 'Stopped.',
    executable: '/usr/local/bin/omp',
  );

  RuntimeServiceStatus get _running => const RuntimeServiceStatus(
    supported: true,
    available: true,
    definition: RuntimeDefinitionState.current,
    service: RuntimeServicePhase.running,
    diagnostics: 'Running.',
    executable: '/usr/local/bin/omp',
  );

  @override
  Future<RuntimeServiceStatus> inspectRuntime() async {
    runtimeInspections += 1;
    if (runtimeInspectionFailure case final Object error) throw error;
    return _stopped;
  }

  @override
  Future<RuntimeServiceStatus> installRuntime() async => _stopped;

  @override
  Future<RuntimeServiceStatus> startRuntime() async {
    runtimeStarts += 1;
    if (runtimeFailure case final Object error) throw error;
    return _running;
  }

  @override
  Future<RuntimeServiceStatus> stopRuntime() async => _stopped;

  @override
  Future<RuntimeServiceStatus> restartRuntime() async {
    runtimeRestarts += 1;
    return _running;
  }

  @override
  Future<RuntimeServiceStatus> uninstallRuntime() async => _stopped;

  PlatformUpdateStatus get _update => const PlatformUpdateStatus(
    supported: true,
    currentVersion: '0.1.24',
    phase: PlatformUpdatePhase.idle,
  );

  @override
  Future<PlatformUpdateStatus> getUpdateState() async {
    updateReads += 1;
    if (updateReadFailure case final Object error) throw error;
    return _update;
  }

  @override
  Future<PlatformUpdateStatus> checkForUpdates() async {
    updateChecks += 1;
    return _update;
  }

  @override
  Future<PlatformUpdateStatus> downloadUpdate() async => _update;

  @override
  Future<PlatformUpdateStatus> installUpdate() async => _update;
}
