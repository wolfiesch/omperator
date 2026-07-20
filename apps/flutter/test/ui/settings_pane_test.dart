import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:t4code/src/client/app_state.dart';
import 'package:t4code/src/host/host_profile.dart';
import 'package:t4code/src/platform/platform_lifecycle.dart';
import 'package:t4code/src/platform/platform_lifecycle_controller.dart';
import 'package:t4code/src/ui/t4_app.dart';

void main() {
  const phone = Size(390, 844);
  const wide = Size(1440, 900);

  Future<void> pumpApp(
    WidgetTester tester, {
    required T4ViewState state,
    required _FakeActions actions,
    required Size size,
    PlatformLifecycleViewState platformState =
        const PlatformLifecycleViewState.initial(),
    PlatformLifecycleActions? platformActions,
  }) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = size;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      T4App(
        state: state,
        actions: actions,
        credentialsAreVolatile: false,
        platformState: platformState,
        platformActions: platformActions,
      ),
    );
    await tester.pump();
  }

  Future<void> openSettings(WidgetTester tester, Size size) async {
    if (size.width < 980) {
      await tester.tap(find.byTooltip('Open navigation'));
      await tester.pumpAndSettle();
    }
    await tester.tap(find.text('Settings').last);
    await tester.pumpAndSettle();
  }

  Future<void> selectSettingsCategory(
    WidgetTester tester,
    Size size,
    String label,
  ) async {
    if (size.width >= 980) {
      await tester.tap(find.text(label).last);
    } else {
      await tester.tap(find.byKey(const Key('settings-category-picker')));
      await tester.pumpAndSettle();
      await tester.tap(find.text(label).last);
    }
    await tester.pumpAndSettle();
  }

  testWidgets('phone navigation changes the live theme preference', (
    tester,
  ) async {
    final actions = _FakeActions();
    final state = _state(
      capabilities: const <String>{
        'catalog.read',
        'config.read',
        'config.write',
      },
    );
    await pumpApp(tester, state: state, actions: actions, size: phone);

    await openSettings(tester, phone);

    expect(find.byKey(const Key('settings-category-picker')), findsOneWidget);
    expect(find.text('Appearance'), findsWidgets);
    expect(
      find.text('Choose how T4 follows your device appearance.'),
      findsOneWidget,
    );
    expect(
      find.text(
        'Changes are staged here. Save sends them to the host, where host-scoped changes may require inbox approval.',
      ),
      findsNothing,
    );
    await tester.tap(find.text('Dark'));
    await tester.pump();

    expect(actions.themePreferences, <T4ThemePreference>[
      T4ThemePreference.dark,
    ]);

    await tester.pumpWidget(
      T4App(
        state: _state(
          themePreference: T4ThemePreference.dark,
          capabilities: const <String>{
            'catalog.read',
            'config.read',
            'config.write',
          },
        ),
        actions: actions,
        credentialsAreVolatile: false,
      ),
    );
    await tester.pump();

    expect(
      tester.widget<MaterialApp>(find.byType(MaterialApp)).themeMode,
      ThemeMode.dark,
    );
  });

  testWidgets(
    'wide settings shows permission, unavailable, secret, and restart states',
    (tester) async {
      final actions = _FakeActions();
      final state = _state(
        capabilities: const <String>{'catalog.read', 'config.read'},
        entries: <HostSettingEntry>[
          _entry(
            path: 'runtime.enabled',
            label: 'Runtime enabled',
            control: HostSettingControlKind.boolean,
            effectiveValue: true,
          ),
          _entry(
            path: 'runtime.preview',
            label: 'Preview runtime',
            control: HostSettingControlKind.boolean,
            effectiveValue: false,
            available: false,
            restartRequired: true,
          ),
          _entry(
            path: 'provider.token',
            label: 'Provider token',
            control: HostSettingControlKind.secret,
            configured: true,
            sensitive: true,
          ),
        ],
      );
      await pumpApp(tester, state: state, actions: actions, size: wide);

      await openSettings(tester, wide);
      await selectSettingsCategory(tester, wide, 'OMP settings');

      expect(find.byTooltip('Close settings'), findsOneWidget);
      expect(find.text('Permission denied'), findsOneWidget);
      expect(find.text('Unavailable'), findsOneWidget);
      expect(find.text('Restart required'), findsOneWidget);
      expect(find.text('Configured'), findsOneWidget);
      expect(
        find.text('A value is configured. Its contents are hidden.'),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('setting-control-runtime.enabled')),
        findsNothing,
      );
      expect(find.byType(Drawer), findsNothing);
    },
  );

  testWidgets('OMP settings renders only the selected setting group', (
    tester,
  ) async {
    final actions = _FakeActions();
    final state = _state(
      capabilities: const <String>{
        'catalog.read',
        'config.read',
        'config.write',
      },
      entries: <HostSettingEntry>[
        _entry(
          path: 'runtime.enabled',
          label: 'Runtime · Enabled',
          control: HostSettingControlKind.boolean,
          effectiveValue: true,
        ),
        _entry(
          path: 'provider.enabled',
          label: 'Provider · Enabled',
          control: HostSettingControlKind.boolean,
          effectiveValue: false,
        ),
      ],
    );
    await pumpApp(tester, state: state, actions: actions, size: wide);
    await openSettings(tester, wide);
    await selectSettingsCategory(tester, wide, 'OMP settings');

    expect(find.byKey(const Key('host-settings-group-picker')), findsOneWidget);
    expect(find.text('Runtime · Enabled'), findsOneWidget);
    expect(find.text('Provider · Enabled'), findsNothing);

    await tester.tap(find.byKey(const Key('host-settings-group-picker')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Provider (1)').last);
    await tester.pumpAndSettle();

    expect(find.text('Runtime · Enabled'), findsNothing);
    expect(find.text('Provider · Enabled'), findsOneWidget);
  });

  testWidgets(
    'phone controls stage changes and require Save for write and reset',
    (tester) async {
      final actions = _FakeActions();
      final state = _state(
        capabilities: const <String>{
          'catalog.read',
          'config.read',
          'config.write',
        },
        entries: <HostSettingEntry>[
          _entry(
            path: 'runtime.enabled',
            label: 'Runtime enabled',
            control: HostSettingControlKind.boolean,
            effectiveValue: true,
            configured: true,
          ),
        ],
      );
      await pumpApp(tester, state: state, actions: actions, size: phone);
      await openSettings(tester, phone);
      await selectSettingsCategory(tester, phone, 'OMP settings');

      final control = find.byKey(const Key('setting-control-runtime.enabled'));
      await tester.ensureVisible(control);
      await tester.tap(control);
      await tester.pumpAndSettle();

      expect(actions.settingWrites, isEmpty);
      expect(find.text('1 staged change'), findsOneWidget);
      await tester.tap(find.byKey(const Key('save-settings')));
      await tester.pumpAndSettle();

      expect(actions.settingWrites, <_SettingWrite>[
        const _SettingWrite(
          path: 'runtime.enabled',
          scope: 'host',
          value: false,
          reset: false,
        ),
      ]);

      final reset = find.widgetWithText(TextButton, 'Reset');
      await tester.ensureVisible(reset);
      await tester.tap(reset);
      await tester.pumpAndSettle();
      expect(find.text('Reset staged'), findsOneWidget);
      expect(actions.settingWrites, hasLength(1));

      await tester.tap(find.byKey(const Key('save-settings')));
      await tester.pumpAndSettle();
      expect(
        actions.settingWrites.last,
        const _SettingWrite(
          path: 'runtime.enabled',
          scope: 'host',
          value: null,
          reset: true,
        ),
      );
    },
  );

  testWidgets('host revision changes surface a staged-edit conflict', (
    tester,
  ) async {
    final actions = _FakeActions();
    final entry = _entry(
      path: 'runtime.enabled',
      label: 'Runtime enabled',
      control: HostSettingControlKind.boolean,
      effectiveValue: true,
      configured: true,
    );
    await pumpApp(
      tester,
      state: _state(
        revision: 'revision-1',
        capabilities: const <String>{
          'catalog.read',
          'config.read',
          'config.write',
        },
        entries: <HostSettingEntry>[entry],
      ),
      actions: actions,
      size: wide,
    );
    await openSettings(tester, wide);
    await selectSettingsCategory(tester, wide, 'OMP settings');
    await tester.tap(find.byKey(const Key('setting-control-runtime.enabled')));
    await tester.pump();

    await tester.pumpWidget(
      T4App(
        state: _state(
          revision: 'revision-2',
          capabilities: const <String>{
            'catalog.read',
            'config.read',
            'config.write',
          },
          entries: <HostSettingEntry>[entry],
        ),
        actions: actions,
        credentialsAreVolatile: false,
      ),
    );
    await tester.pump();

    expect(find.text('Settings changed on the host'), findsOneWidget);
    expect(
      tester
          .widget<FilledButton>(find.byKey(const Key('save-settings')))
          .onPressed,
      isNull,
    );
  });

  testWidgets('native runtime and update controls dispatch explicit actions', (
    tester,
  ) async {
    final actions = _FakeActions();
    final platformActions = _FakePlatformActions();
    await pumpApp(
      tester,
      state: _state(),
      actions: actions,
      size: wide,
      platformState: _nativePlatformState(),
      platformActions: platformActions,
    );
    await openSettings(tester, wide);
    await selectSettingsCategory(tester, wide, 'App and runtime');

    final runtimeRestart = find.byKey(const Key('runtime-restart'));
    await tester.ensureVisible(runtimeRestart);
    await tester.tap(runtimeRestart);
    await tester.pumpAndSettle();
    expect(platformActions.calls, <String>['runtime.restart']);

    final updateCheck = find.byKey(const Key('update-check'));
    await tester.ensureVisible(updateCheck);
    await tester.tap(updateCheck);
    await tester.pumpAndSettle();
    expect(platformActions.calls, <String>['runtime.restart', 'update.check']);
    expect(find.text('1.2.4'), findsWidgets);
    expect(find.text('1.2.5'), findsOneWidget);
  });

  test('diagnostics export includes only allowlisted redacted values', () {
    final state = _state(
      revision: 'revision-safe',
      capabilities: const <String>{
        'catalog.read',
        'config.write',
        'config.read',
      },
      entries: <HostSettingEntry>[
        _entry(
          path: 'ui.scale',
          label: 'UI scale',
          control: HostSettingControlKind.number,
          effectiveValue: 1.25,
        ),
        _entry(
          path: 'provider.token',
          label: 'Provider token',
          control: HostSettingControlKind.secret,
          effectiveValue: 'HOST-CREDENTIAL-DO-NOT-EXPORT',
          configured: true,
          sensitive: true,
        ),
        _entry(
          path: 'private.note',
          label: 'Private note',
          control: HostSettingControlKind.text,
          effectiveValue: 'DEVICE-TOKEN-DO-NOT-EXPORT',
          sensitive: true,
        ),
      ],
      issues: const <String>['settings frame omitted optional metadata'],
    );

    final encoded = buildT4DiagnosticsJson(
      state,
      generatedAt: DateTime.utc(2026, 7, 19),
      platformState: _nativePlatformState(),
    );
    final decoded = jsonDecode(encoded) as Map<String, Object?>;
    final settings = decoded['settings']! as List<Object?>;

    expect(encoded, isNot(contains('HOST-CREDENTIAL-DO-NOT-EXPORT')));
    expect(encoded, isNot(contains('DEVICE-TOKEN-DO-NOT-EXPORT')));
    expect(encoded, isNot(contains('rawFrame')));
    expect(encoded, isNot(contains('transcript')));
    expect(encoded, isNot(contains('PRIVATE-HOME')));
    expect(decoded['kind'], 't4-code.flutter-diagnostics');
    expect(decoded['hostLabel'], 'T4 on alpha');
    expect(decoded['capabilityNames'], <Object?>[
      'catalog.read',
      'config.read',
      'config.write',
    ]);
    final platform = decoded['platform']! as Map<String, Object?>;
    expect(
      (platform['runtime']! as Map<String, Object?>)['service'],
      'running',
    );
    expect((platform['update']! as Map<String, Object?>)['phase'], 'available');
    expect(settings.cast<Map<String, Object?>>().first['effectiveValue'], 1.25);
    expect(
      settings.cast<Map<String, Object?>>()[1].containsKey('effectiveValue'),
      isFalse,
    );
    expect(
      settings.cast<Map<String, Object?>>()[2].containsKey('effectiveValue'),
      isFalse,
    );
  });
}

T4ViewState _state({
  T4ThemePreference themePreference = T4ThemePreference.system,
  Set<String> capabilities = const <String>{},
  List<HostSettingEntry> entries = const <HostSettingEntry>[],
  List<String> issues = const <String>[],
  String revision = 'revision-1',
}) {
  final profile = HostProfile.parseTailnetAddress(
    'https://alpha.tailnet-name.ts.net',
  );
  return T4ViewState(
    connectionPhase: ConnectionPhase.ready,
    authenticationPhase: AuthenticationPhase.paired,
    hostDirectory: HostDirectory.empty().upsert(profile),
    targetConfigured: true,
    grantedCapabilities: capabilities,
    grantedFeatures: const <String>{'catalog.metadata', 'settings.metadata'},
    themePreference: themePreference,
    settings: HostSettingsState(
      revision: revision,
      entries: entries,
      issues: issues,
    ),
  );
}

PlatformLifecycleViewState _nativePlatformState() =>
    const PlatformLifecycleViewState(
      runtime: RuntimeServiceStatus(
        supported: true,
        available: true,
        definition: RuntimeDefinitionState.current,
        service: RuntimeServicePhase.running,
        diagnostics: '',
        executable: '/Users/PRIVATE-HOME/bin/omp',
      ),
      update: PlatformUpdateStatus(
        supported: true,
        currentVersion: '1.2.4',
        phase: PlatformUpdatePhase.available,
        latestVersion: '1.2.5',
        checkedAt: 1784419200000,
        revision: 7,
      ),
    );

HostSettingEntry _entry({
  required String path,
  required String label,
  required HostSettingControlKind control,
  Object? effectiveValue,
  bool configured = false,
  bool restartRequired = false,
  bool available = true,
  bool sensitive = false,
}) => HostSettingEntry(
  path: path,
  section: 'Runtime',
  label: label,
  help: 'Published by the connected host.',
  control: control,
  effectiveValue: effectiveValue,
  configured: configured,
  effectiveSource: 'host',
  options: const <HostSettingOption>[],
  writableScopes: const <String>['host'],
  restartRequired: restartRequired,
  available: available,
  sensitive: sensitive,
);

final class _FakeActions implements T4Actions {
  final List<T4ThemePreference> themePreferences = <T4ThemePreference>[];
  final List<_SettingWrite> settingWrites = <_SettingWrite>[];
  int refreshCalls = 0;

  @override
  Future<void> setThemePreference(T4ThemePreference preference) async {
    themePreferences.add(preference);
  }

  @override
  Future<void> refreshSettings() async {
    refreshCalls += 1;
  }

  @override
  Future<void> writeSetting(
    String path,
    String scope, {
    Object? value,
    bool reset = false,
  }) async {
    settingWrites.add(
      _SettingWrite(path: path, scope: scope, value: value, reset: reset),
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

final class _FakePlatformActions implements PlatformLifecycleActions {
  final List<String> calls = <String>[];

  @override
  Future<void> refreshPlatformState() async {
    calls.add('platform.refresh');
  }

  @override
  Future<void> installRuntime() async {
    calls.add('runtime.install');
  }

  @override
  Future<void> startRuntime() async {
    calls.add('runtime.start');
  }

  @override
  Future<void> stopRuntime() async {
    calls.add('runtime.stop');
  }

  @override
  Future<void> restartRuntime() async {
    calls.add('runtime.restart');
  }

  @override
  Future<void> uninstallRuntime() async {
    calls.add('runtime.uninstall');
  }

  @override
  Future<void> checkForUpdates() async {
    calls.add('update.check');
  }

  @override
  Future<void> downloadUpdate() async {
    calls.add('update.download');
  }

  @override
  Future<void> installUpdate() async {
    calls.add('update.install');
  }
}

final class _SettingWrite {
  const _SettingWrite({
    required this.path,
    required this.scope,
    required this.value,
    required this.reset,
  });

  final String path;
  final String scope;
  final Object? value;
  final bool reset;

  @override
  bool operator ==(Object other) =>
      other is _SettingWrite &&
      path == other.path &&
      scope == other.scope &&
      value == other.value &&
      reset == other.reset;

  @override
  int get hashCode => Object.hash(path, scope, value, reset);

  @override
  String toString() =>
      '_SettingWrite(path: $path, scope: $scope, value: $value, reset: $reset)';
}
