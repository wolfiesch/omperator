import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

const String t4PlatformLifecycleChannel =
    'com.lycaonsolutions.t4code/platform_lifecycle';

enum RuntimeDefinitionState { missing, current, drifted }

enum RuntimeServicePhase { stopped, starting, running, failed, unknown }

enum PlatformUpdatePhase {
  unsupported,
  idle,
  checking,
  current,
  available,
  manual,
  downloading,
  installer,
  ready,
  error,
}

final class RuntimeServiceStatus {
  const RuntimeServiceStatus({
    required this.supported,
    required this.available,
    required this.definition,
    required this.service,
    required this.diagnostics,
    this.executable,
    this.issueCode,
    this.message,
  });

  const RuntimeServiceStatus.unsupported()
    : supported = false,
      available = false,
      definition = RuntimeDefinitionState.missing,
      service = RuntimeServicePhase.unknown,
      diagnostics = 'Local OMP service management is available on macOS only.',
      executable = null,
      issueCode = 'unsupported_platform',
      message = null;

  final bool supported;
  final bool available;
  final RuntimeDefinitionState definition;
  final RuntimeServicePhase service;
  final String diagnostics;
  final String? executable;
  final String? issueCode;
  final String? message;

  factory RuntimeServiceStatus.fromMap(Map<Object?, Object?> value) {
    final definition = _enumByName(
      RuntimeDefinitionState.values,
      value['definition'],
      'definition',
    );
    final service = _enumByName(
      RuntimeServicePhase.values,
      value['service'],
      'service',
    );
    return RuntimeServiceStatus(
      supported: true,
      available: _requiredBool(value, 'available'),
      definition: definition,
      service: service,
      diagnostics: _boundedText(value['diagnostics'], 'diagnostics', 4096),
      executable: _optionalText(value['executable'], 'executable', 1024),
      issueCode: _optionalText(value['issueCode'], 'issueCode', 128),
      message: _optionalText(value['message'], 'message', 512),
    );
  }
}

final class PlatformUpdateStatus {
  const PlatformUpdateStatus({
    required this.supported,
    required this.currentVersion,
    required this.phase,
    this.latestVersion,
    this.checkedAt,
    this.revision,
    this.progressPercent,
    this.error,
    this.message,
  });

  const PlatformUpdateStatus.unsupported()
    : supported = false,
      currentVersion = '',
      phase = PlatformUpdatePhase.unsupported,
      latestVersion = null,
      checkedAt = null,
      revision = null,
      progressPercent = null,
      error = null,
      message = 'Updates are managed outside this app on this platform.';

  final bool supported;
  final String currentVersion;
  final PlatformUpdatePhase phase;
  final String? latestVersion;
  final int? checkedAt;
  final int? revision;
  final double? progressPercent;
  final String? error;
  final String? message;

  factory PlatformUpdateStatus.fromMap(Map<Object?, Object?> value) {
    final phaseName = _boundedText(value['phase'], 'phase', 32);
    final phase = PlatformUpdatePhase.values
        .where((candidate) => candidate.name == phaseName)
        .firstOrNull;
    if (phase == null || phase == PlatformUpdatePhase.unsupported) {
      throw FormatException('unsupported update phase: $phaseName');
    }
    final checkedAt = value['checkedAt'];
    if (checkedAt != null && (checkedAt is! int || checkedAt < 0)) {
      throw const FormatException('checkedAt must be a positive integer');
    }
    final revision = value['revision'];
    if (revision != null &&
        (revision is! int || revision < 0 || revision > 9007199254740991)) {
      throw const FormatException('revision must be a positive safe integer');
    }
    final progress = value['progressPercent'];
    if (progress != null &&
        (progress is! num ||
            !progress.isFinite ||
            progress < 0 ||
            progress > 100)) {
      throw const FormatException('progressPercent must be between 0 and 100');
    }
    return PlatformUpdateStatus(
      supported: true,
      currentVersion: _boundedText(
        value['currentVersion'],
        'currentVersion',
        64,
      ),
      phase: phase,
      latestVersion: _optionalText(value['latestVersion'], 'latestVersion', 64),
      checkedAt: checkedAt as int?,
      revision: revision as int?,
      progressPercent: (progress as num?)?.toDouble(),
      error: _optionalText(value['error'], 'error', 128),
      message: _optionalText(value['message'], 'message', 512),
    );
  }
}

abstract interface class PlatformLifecycleBridge {
  bool get supportsRuntimeService;
  bool get supportsUpdates;

  Future<RuntimeServiceStatus> inspectRuntime();
  Future<RuntimeServiceStatus> installRuntime();
  Future<RuntimeServiceStatus> startRuntime();
  Future<RuntimeServiceStatus> stopRuntime();
  Future<RuntimeServiceStatus> restartRuntime();
  Future<RuntimeServiceStatus> uninstallRuntime();

  Future<PlatformUpdateStatus> getUpdateState();
  Future<PlatformUpdateStatus> checkForUpdates();
  Future<PlatformUpdateStatus> downloadUpdate();
  Future<PlatformUpdateStatus> installUpdate();
}

final class MethodChannelPlatformLifecycleBridge
    implements PlatformLifecycleBridge {
  const MethodChannelPlatformLifecycleBridge({
    this._channel = const MethodChannel(t4PlatformLifecycleChannel),
  });

  final MethodChannel _channel;

  @override
  bool get supportsRuntimeService =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.macOS;

  @override
  bool get supportsUpdates =>
      !kIsWeb &&
      (defaultTargetPlatform == TargetPlatform.android ||
          defaultTargetPlatform == TargetPlatform.macOS);

  @override
  Future<RuntimeServiceStatus> inspectRuntime() => _runtime('runtime.inspect');

  @override
  Future<RuntimeServiceStatus> installRuntime() => _runtime('runtime.install');

  @override
  Future<RuntimeServiceStatus> startRuntime() => _runtime('runtime.start');

  @override
  Future<RuntimeServiceStatus> stopRuntime() => _runtime('runtime.stop');

  @override
  Future<RuntimeServiceStatus> restartRuntime() => _runtime('runtime.restart');

  @override
  Future<RuntimeServiceStatus> uninstallRuntime() =>
      _runtime('runtime.uninstall');

  @override
  Future<PlatformUpdateStatus> getUpdateState() => _update('update.getState');

  @override
  Future<PlatformUpdateStatus> checkForUpdates() => _update('update.check');

  @override
  Future<PlatformUpdateStatus> downloadUpdate() => _update('update.download');

  @override
  Future<PlatformUpdateStatus> installUpdate() => _update('update.install');

  Future<RuntimeServiceStatus> _runtime(String method) async {
    if (!supportsRuntimeService) {
      return const RuntimeServiceStatus.unsupported();
    }
    final value = await _channel.invokeMethod<Object?>(method);
    return RuntimeServiceStatus.fromMap(_map(value, method));
  }

  Future<PlatformUpdateStatus> _update(String method) async {
    if (!supportsUpdates) return const PlatformUpdateStatus.unsupported();
    final value = await _channel.invokeMethod<Object?>(method);
    return PlatformUpdateStatus.fromMap(_map(value, method));
  }
}

Map<Object?, Object?> _map(Object? value, String field) {
  if (value is! Map<Object?, Object?>) {
    throw FormatException('$field result must be an object');
  }
  return value;
}

T _enumByName<T extends Enum>(List<T> values, Object? value, String field) {
  final name = _boundedText(value, field, 32);
  final match = values.where((candidate) => candidate.name == name).firstOrNull;
  if (match == null) throw FormatException('unsupported $field: $name');
  return match;
}

bool _requiredBool(Map<Object?, Object?> value, String field) {
  final result = value[field];
  if (result is! bool) throw FormatException('$field must be a boolean');
  return result;
}

String _boundedText(Object? value, String field, int maxLength) {
  if (value is! String || value.isEmpty || value.length > maxLength) {
    throw FormatException('$field must be non-empty bounded text');
  }
  if (value.runes.any((rune) => rune < 0x20 && rune != 0x09 && rune != 0x0a)) {
    throw FormatException('$field contains control characters');
  }
  return value;
}

String? _optionalText(Object? value, String field, int maxLength) {
  if (value == null) return null;
  return _boundedText(value, field, maxLength);
}
