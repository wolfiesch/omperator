library;

import 'dart:async';
import 'dart:convert';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart' show defaultTargetPlatform;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:xterm/xterm.dart';

import 'transcript_markdown.dart';
import '../client/app_state.dart';
import '../client/model_labels.dart';
import '../platform/platform_lifecycle.dart';
import '../protocol/protocol.dart';
import '../platform/platform_lifecycle_controller.dart';

part 'adaptive_session_shell.dart';
part 'access_mode_selector.dart';
part 'command_palette.dart';
part 'attention_pane.dart';
part 'conversation_pane.dart';
part 'context_panel.dart';
part 'developer_surfaces.dart';
part 'host_management.dart';
part 'quick_open_dialog.dart';
part 'transcript_search_pane.dart';
part 'usage_status_pane.dart';
part 'settings_pane.dart';
part 't4_theme.dart';
part 'session_navigation.dart';
part 'terminal_pane.dart';

/// Material 3 application shell for T4.
///
/// Protocol and connection behavior stay behind [T4Actions]; this widget only
/// renders the immutable [T4ViewState] supplied by its owner.
final class T4App extends StatelessWidget {
  const T4App({
    required this.state,
    required this.actions,
    required this.credentialsAreVolatile,
    this.demoMode = false,
    this.platformState = const PlatformLifecycleViewState.initial(),
    this.platformActions,
    super.key,
  });

  final T4ViewState state;
  final T4Actions actions;
  final bool credentialsAreVolatile;
  final bool demoMode;
  final PlatformLifecycleViewState platformState;
  final PlatformLifecycleActions? platformActions;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'T4',
      theme: _T4Theme.light(),
      darkTheme: _T4Theme.dark(),
      themeMode: switch (state.themePreference) {
        T4ThemePreference.system => ThemeMode.system,
        T4ThemePreference.light => ThemeMode.light,
        T4ThemePreference.dark => ThemeMode.dark,
      },
      home: demoMode
          ? _DemoModeShell(
              child: _AdaptiveSessionShell(
                state: state,
                actions: actions,
                platformState: platformState,
                platformActions: platformActions,
              ),
            )
          : credentialsAreVolatile
          ? _VolatileCredentialsShell(
              child: _AdaptiveSessionShell(
                state: state,
                actions: actions,
                platformState: platformState,
                platformActions: platformActions,
              ),
            )
          : _AdaptiveSessionShell(
              state: state,
              actions: actions,
              platformState: platformState,
              platformActions: platformActions,
            ),
    );
  }
}

final class _DemoModeShell extends StatelessWidget {
  const _DemoModeShell({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      children: [
        Semantics(
          container: true,
          label: 'Public preview using sample data. Actions are disabled.',
          child: Material(
            color: colors.secondaryContainer,
            child: SafeArea(
              bottom: false,
              child: SizedBox(
                height: 32,
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      Icons.visibility_outlined,
                      size: 16,
                      color: colors.onSecondaryContainer,
                    ),
                    const SizedBox(width: 8),
                    Flexible(
                      child: Text(
                        'Public preview · sample data · actions disabled',
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.labelMedium
                            ?.copyWith(color: colors.onSecondaryContainer),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
        Expanded(child: child),
      ],
    );
  }
}

final class _VolatileCredentialsShell extends StatelessWidget {
  const _VolatileCredentialsShell({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      children: [
        Semantics(
          container: true,
          label:
              'Unsigned development mode. Credentials reset when the app quits.',
          child: Material(
            color: colors.tertiaryContainer,
            child: SafeArea(
              bottom: false,
              child: SizedBox(
                height: 32,
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      Icons.lock_open_outlined,
                      size: 16,
                      color: colors.onTertiaryContainer,
                    ),
                    const SizedBox(width: 8),
                    Flexible(
                      child: Text(
                        'Unsigned development · credentials reset on quit',
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.labelMedium
                            ?.copyWith(color: colors.onTertiaryContainer),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
        Expanded(child: child),
      ],
    );
  }
}
