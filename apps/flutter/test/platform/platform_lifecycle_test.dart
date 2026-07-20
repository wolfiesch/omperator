import 'package:flutter_test/flutter_test.dart';
import 'package:t4code/src/platform/platform_lifecycle.dart';

void main() {
  test('runtime inspection accepts the bounded native contract', () {
    final status = RuntimeServiceStatus.fromMap(<Object?, Object?>{
      'available': true,
      'executable': '/usr/local/bin/omp',
      'definition': 'current',
      'service': 'running',
      'diagnostics': 'OMP appserver is healthy.',
    });

    expect(status.supported, isTrue);
    expect(status.available, isTrue);
    expect(status.definition, RuntimeDefinitionState.current);
    expect(status.service, RuntimeServicePhase.running);
    expect(status.executable, '/usr/local/bin/omp');
  });

  test('runtime inspection rejects unknown native states', () {
    expect(
      () => RuntimeServiceStatus.fromMap(<Object?, Object?>{
        'available': true,
        'definition': 'installed-ish',
        'service': 'running',
        'diagnostics': 'invalid',
      }),
      throwsFormatException,
    );
  });

  test('Android update state accepts progress and installer phases', () {
    final status = PlatformUpdateStatus.fromMap(<Object?, Object?>{
      'currentVersion': '0.1.24',
      'latestVersion': '0.1.25',
      'phase': 'downloading',
      'checkedAt': 1,
      'revision': 25,
      'progressPercent': 42.5,
      'message': 'Downloading verified package.',
    });

    expect(status.supported, isTrue);
    expect(status.phase, PlatformUpdatePhase.downloading);
    expect(status.progressPercent, 42.5);
  });

  test('update state rejects unbounded progress and messages', () {
    expect(
      () => PlatformUpdateStatus.fromMap(<Object?, Object?>{
        'currentVersion': '0.1.24',
        'phase': 'downloading',
        'progressPercent': 101,
      }),
      throwsFormatException,
    );
    expect(
      () => PlatformUpdateStatus.fromMap(<Object?, Object?>{
        'currentVersion': '0.1.24',
        'phase': 'error',
        'message': 'x' * 513,
      }),
      throwsFormatException,
    );
  });
}
