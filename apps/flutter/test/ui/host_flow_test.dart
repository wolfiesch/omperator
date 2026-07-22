import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:t4code/src/client/app_state.dart';
import 'package:t4code/src/host/host_profile.dart';
import 'package:t4code/src/protocol/protocol.dart';
import 'package:t4code/src/ui/t4_app.dart';

void main() {
  const compactPhone = Size(390, 844);
  const compactDesktop = Size(979, 800);
  const wideDesktop = Size(980, 800);

  Future<void> pumpApp(
    WidgetTester tester, {
    required T4ViewState state,
    required _FakeActions actions,
    required Size size,
    bool credentialsAreVolatile = false,
  }) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = size;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      T4App(
        state: state,
        actions: actions,
        credentialsAreVolatile: credentialsAreVolatile,
      ),
    );
    await tester.pump();
  }

  T4ViewState keyboardTranscriptState({
    List<TranscriptMessage>? messages,
    bool transcriptHistoryHasMore = false,
    bool transcriptHistoryLoading = false,
    String? transcriptHistoryError,
    bool transcriptTailFromCache = false,
  }) {
    final profile = HostProfile.parseTailnetAddress(
      'https://alpha.tailnet-name.ts.net',
    );
    return T4ViewState(
      connectionPhase: ConnectionPhase.ready,
      hostDirectory: HostDirectory.empty().upsert(profile),
      authenticationPhase: AuthenticationPhase.paired,
      grantedCapabilities: t4RequestedCapabilities.toSet(),
      selectedSessionId: 'session-alpha',
      sessions: const <SessionSummary>[
        SessionSummary(
          hostId: 'host-alpha',
          sessionId: 'session-alpha',
          projectId: 'project-alpha',
          projectName: 'Project Alpha',
          title: 'Keyboard inset test',
          revision: 'revision-alpha',
          status: 'idle',
        ),
      ],
      transcriptHistoryHasMore: transcriptHistoryHasMore,
      transcriptHistoryLoading: transcriptHistoryLoading,
      transcriptHistoryError: transcriptHistoryError,
      transcriptTailFromCache: transcriptTailFromCache,
      messages:
          messages ??
          List<TranscriptMessage>.generate(
            24,
            (index) => TranscriptMessage(
              id: 'message-$index',
              role: index.isEven ? MessageRole.user : MessageRole.assistant,
              text: 'Transcript message ${index + 1}',
            ),
          ),
    );
  }

  Finder transcriptList() => find.byWidgetPredicate(
    (widget) =>
        widget is ListView &&
        widget.keyboardDismissBehavior ==
            ScrollViewKeyboardDismissBehavior.onDrag,
  );

  group('shared T4 theme', () {
    testWidgets('applies canonical neutral light tokens and typography', (
      tester,
    ) async {
      await pumpApp(
        tester,
        state: const T4ViewState(
          connectionPhase: ConnectionPhase.disconnected,
          themePreference: T4ThemePreference.light,
        ),
        actions: _FakeActions(),
        size: compactPhone,
      );

      final theme = Theme.of(tester.element(find.byType(Scaffold).first));
      final semantic = theme.extension<T4SemanticColors>()!;
      expect(theme.colorScheme.primary, const Color(0xffb8245b));
      expect(theme.colorScheme.surface, const Color(0xffffffff));
      expect(theme.colorScheme.onSurface, const Color(0xff262626));
      expect(theme.textTheme.bodyMedium?.fontFamily, 'DM Sans');
      expect(semantic.brand, const Color(0xffe83174));
      expect(semantic.statusDone, const Color(0xff009966));
    });

    testWidgets('applies canonical neutral dark tokens', (tester) async {
      await pumpApp(
        tester,
        state: const T4ViewState(
          connectionPhase: ConnectionPhase.disconnected,
          themePreference: T4ThemePreference.dark,
        ),
        actions: _FakeActions(),
        size: compactPhone,
      );

      final theme = Theme.of(tester.element(find.byType(Scaffold).first));
      final semantic = theme.extension<T4SemanticColors>()!;
      expect(theme.colorScheme.primary, const Color(0xfff67399));
      expect(theme.colorScheme.surface, const Color(0xff161616));
      expect(theme.colorScheme.onSurface, const Color(0xfff5f5f5));
      expect(semantic.brand, const Color(0xffe83174));
      expect(semantic.statusDone, const Color(0xff00d492));
    });
  });

  testWidgets('labels compaction entries as earlier chat summaries', (
    tester,
  ) async {
    await pumpApp(
      tester,
      state: keyboardTranscriptState(
        messages: const <TranscriptMessage>[
          TranscriptMessage(
            id: 'compaction',
            role: MessageRole.system,
            kind: TranscriptKind.compaction,
            text: 'Recovered compacted history',
          ),
        ],
      ),
      actions: _FakeActions(),
      size: compactPhone,
    );

    expect(find.text('EARLIER CHAT SUMMARY'), findsOneWidget);
    expect(find.text('SYSTEM'), findsNothing);
  });

  group('host onboarding', () {
    testWidgets('shows an empty-host onboarding form', (tester) async {
      await pumpApp(
        tester,
        state: const T4ViewState.disconnected(),
        actions: _FakeActions(),
        size: compactPhone,
      );

      expect(find.text('Connect to T4'), findsOneWidget);
      expect(find.text('Tailnet HTTPS address'), findsOneWidget);
      expect(find.text('Profile ID (optional)'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Add host'), findsOneWidget);
      expect(find.byType(SafeArea), findsWidgets);
    });

    testWidgets('surfaces the controller validation error', (tester) async {
      final actions = _FakeActions(
        addHostError: const FormatException(
          'Use the full Tailscale hostname ending in .ts.net.',
        ),
      );
      await pumpApp(
        tester,
        state: const T4ViewState.disconnected(),
        actions: actions,
        size: compactPhone,
      );

      await tester.enterText(
        find.byType(TextField).first,
        'https://not-a-tailnet.example',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Add host'));
      await tester.pumpAndSettle();

      expect(
        find.text('Use the full Tailscale hostname ending in .ts.net.'),
        findsOneWidget,
      );
      expect(actions.addedAddresses, ['https://not-a-tailnet.example']);
    });

    testWidgets('shows progress while adding a host', (tester) async {
      final completion = Completer<void>();
      final actions = _FakeActions(addHostCompletion: completion);
      await pumpApp(
        tester,
        state: const T4ViewState.disconnected(),
        actions: actions,
        size: compactPhone,
      );

      await tester.enterText(
        find.byType(TextField).first,
        'https://alpha.tailnet-name.ts.net',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Add host'));
      await tester.pump();

      expect(find.bySemanticsLabel('Adding host'), findsWidgets);
      final button = tester.widget<FilledButton>(find.byType(FilledButton));
      expect(button.onPressed, isNull);

      completion.complete();
      await tester.pumpAndSettle();
    });
  });

  testWidgets('host manager switches and removes saved hosts', (tester) async {
    final beta = HostProfile.parseTailnetAddress(
      'https://beta.tailnet-name.ts.net',
    );
    final alpha = HostProfile.parseTailnetAddress(
      'https://alpha.tailnet-name.ts.net',
    );
    final directory = HostDirectory.empty().upsert(beta).upsert(alpha);
    final actions = _FakeActions();
    await pumpApp(
      tester,
      state: T4ViewState(
        connectionPhase: ConnectionPhase.ready,
        hostDirectory: directory,
        authenticationPhase: AuthenticationPhase.paired,
        grantedCapabilities: t4RequestedCapabilities.toSet(),
      ),
      actions: actions,
      size: wideDesktop,
    );

    await tester.tap(find.byTooltip('Host menu'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Manage hosts'));
    await tester.pumpAndSettle();

    expect(find.text('Saved hosts'), findsOneWidget);
    expect(find.text(alpha.origin), findsOneWidget);
    expect(find.text(beta.origin), findsOneWidget);
    expect(find.text('Current host · Ready · Paired'), findsOneWidget);

    await tester.tap(find.bySemanticsLabel('Switch to ${beta.label}'));
    await tester.pumpAndSettle();
    expect(actions.activatedEndpointKeys, [beta.endpointKey]);

    await tester.ensureVisible(find.widgetWithText(TextButton, 'Remove').last);
    await tester.pump();
    expect(
      find.byWidgetPredicate(
        (widget) =>
            widget is Semantics &&
            widget.properties.label == 'Remove ${alpha.label}',
      ),
      findsOneWidget,
    );
    await tester.tap(find.widgetWithText(TextButton, 'Remove').last);
    await tester.pumpAndSettle();
    expect(find.text('Remove ${alpha.label}?'), findsOneWidget);
    expect(
      find.textContaining('pairing credential from this device'),
      findsOneWidget,
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Remove host'));
    await tester.pumpAndSettle();
    expect(actions.removedEndpointKeys, [alpha.endpointKey]);
  });

  testWidgets('pairing-required state submits six digits and clears the form', (
    tester,
  ) async {
    final profile = HostProfile.parseTailnetAddress(
      'https://alpha.tailnet-name.ts.net',
    );
    final actions = _FakeActions();
    await pumpApp(
      tester,
      state: T4ViewState(
        connectionPhase: ConnectionPhase.synchronizing,
        hostDirectory: HostDirectory.empty().upsert(profile),
        authenticationPhase: AuthenticationPhase.pairingRequired,
      ),
      actions: actions,
      size: compactPhone,
    );

    expect(find.text('Pair this device'), findsOneWidget);
    expect(find.text(t4PairCommand), findsOneWidget);
    final code = List<String>.filled(6, '1').join();
    await tester.enterText(find.byType(TextField), code);
    await tester.pump();
    await tester.ensureVisible(
      find.widgetWithText(FilledButton, 'Pair device'),
    );
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Pair device'));
    await tester.pump();

    expect(actions.pairingCodes, [code]);
    final codeField = tester.widget<TextField>(find.byType(TextField));
    expect(codeField.controller?.text, isEmpty);
    expect(find.text(code), findsNothing);
  });

  testWidgets('pairing-required state surfaces the host rejection', (
    tester,
  ) async {
    final profile = HostProfile.parseTailnetAddress(
      'https://alpha.tailnet-name.ts.net',
    );
    await pumpApp(
      tester,
      state: T4ViewState(
        connectionPhase: ConnectionPhase.synchronizing,
        hostDirectory: HostDirectory.empty().upsert(profile),
        authenticationPhase: AuthenticationPhase.pairingRequired,
        errorMessage:
            'Pairing failed (INVALID_CODE). Check the code and try again.',
      ),
      actions: _FakeActions(),
      size: compactPhone,
    );

    expect(
      find.textContaining('Pairing failed (INVALID_CODE)'),
      findsOneWidget,
    );
  });

  testWidgets('connected host can be deliberately disconnected', (
    tester,
  ) async {
    final profile = HostProfile.parseTailnetAddress(
      'https://alpha.tailnet-name.ts.net',
    );
    final actions = _FakeActions();
    await pumpApp(
      tester,
      state: T4ViewState(
        connectionPhase: ConnectionPhase.ready,
        hostDirectory: HostDirectory.empty().upsert(profile),
        authenticationPhase: AuthenticationPhase.paired,
        grantedCapabilities: t4RequestedCapabilities.toSet(),
      ),
      actions: actions,
      size: wideDesktop,
    );

    await tester.tap(find.byTooltip('Host menu'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Disconnect'));
    await tester.pumpAndSettle();
    expect(actions.disconnectCalls, 1);
  });

  testWidgets(
    'configured endpoint can reconnect after a deliberate disconnect',
    (tester) async {
      final actions = _FakeActions();
      await pumpApp(
        tester,
        state: const T4ViewState(
          connectionPhase: ConnectionPhase.disconnected,
          targetConfigured: true,
        ),
        actions: actions,
        size: compactPhone,
      );

      expect(find.byTooltip('Connect'), findsOneWidget);
      expect(find.text('Connect to T4'), findsNothing);
      await tester.tap(find.byTooltip('Connect'));
      await tester.pumpAndSettle();
      expect(actions.connectCalls, 1);
    },
  );

  testWidgets('compact layout exposes host manager in the drawer', (
    tester,
  ) async {
    final profile = HostProfile.parseTailnetAddress(
      'https://alpha.tailnet-name.ts.net',
    );
    await pumpApp(
      tester,
      state: T4ViewState(
        connectionPhase: ConnectionPhase.disconnected,
        hostDirectory: HostDirectory.empty().upsert(profile),
      ),
      actions: _FakeActions(),
      size: compactPhone,
    );

    expect(find.byTooltip('Open navigation'), findsOneWidget);
    await tester.tap(find.byTooltip('Open navigation'));
    await tester.pumpAndSettle();

    expect(find.text('Navigation'), findsOneWidget);
    expect(find.byTooltip('Host menu'), findsOneWidget);
    expect(find.byType(Drawer), findsOneWidget);
  });

  testWidgets('left-edge swipe opens compact session navigation', (
    tester,
  ) async {
    final profile = HostProfile.parseTailnetAddress(
      'https://alpha.tailnet-name.ts.net',
    );
    await pumpApp(
      tester,
      state: T4ViewState(
        connectionPhase: ConnectionPhase.ready,
        hostDirectory: HostDirectory.empty().upsert(profile),
        authenticationPhase: AuthenticationPhase.paired,
      ),
      actions: _FakeActions(),
      size: compactPhone,
    );

    await tester.dragFrom(const Offset(36, 420), const Offset(260, 0));
    await tester.pumpAndSettle();

    expect(find.text('Navigation'), findsOneWidget);
    expect(find.byTooltip('Host menu'), findsOneWidget);
  });

  testWidgets('unsigned macOS development mode is visibly identified', (
    tester,
  ) async {
    await pumpApp(
      tester,
      state: const T4ViewState.disconnected(),
      actions: _FakeActions(),
      size: compactPhone,
      credentialsAreVolatile: true,
    );

    expect(
      find.text('Unsigned development · credentials reset on quit'),
      findsOneWidget,
    );
  });

  testWidgets('responsive split changes from drawer to rail at 980 pixels', (
    tester,
  ) async {
    final profile = HostProfile.parseTailnetAddress(
      'https://alpha.tailnet-name.ts.net',
    );
    final state = T4ViewState(
      connectionPhase: ConnectionPhase.ready,
      hostDirectory: HostDirectory.empty().upsert(profile),
      authenticationPhase: AuthenticationPhase.paired,
    );
    final actions = _FakeActions();

    await pumpApp(tester, state: state, actions: actions, size: compactDesktop);
    expect(find.byTooltip('Open navigation'), findsOneWidget);

    tester.view.physicalSize = wideDesktop;
    await tester.pumpWidget(
      T4App(state: state, actions: actions, credentialsAreVolatile: false),
    );
    await tester.pumpAndSettle();

    expect(find.byTooltip('Open navigation'), findsNothing);
    expect(find.byTooltip('Host menu'), findsOneWidget);
    expect(find.text('T4'), findsOneWidget);
  });
  testWidgets(
    'session rail groups projects, searches, creates, archives, and restores',
    (tester) async {
      final profile = HostProfile.parseTailnetAddress(
        'https://alpha.tailnet-name.ts.net',
      );
      final actions = _FakeActions();
      final state = T4ViewState(
        connectionPhase: ConnectionPhase.ready,
        hostDirectory: HostDirectory.empty().upsert(profile),
        authenticationPhase: AuthenticationPhase.paired,
        grantedCapabilities: t4RequestedCapabilities.toSet(),
        selectedSessionId: 'session-alpha',
        sessions: const <SessionSummary>[
          SessionSummary(
            hostId: 'host-alpha',
            sessionId: 'session-alpha',
            projectId: 'project-alpha',
            projectName: 'Project Alpha',
            title: 'First investigation',
            revision: 'revision-alpha',
            status: 'idle',
          ),
          SessionSummary(
            hostId: 'host-alpha',
            sessionId: 'session-beta',
            projectId: 'project-beta',
            projectName: 'Project Beta',
            title: 'Second investigation',
            revision: 'revision-beta',
            status: 'idle',
          ),
          SessionSummary(
            hostId: 'host-alpha',
            sessionId: 'session-archived',
            projectId: 'project-alpha',
            projectName: 'Project Alpha',
            title: 'Archived investigation',
            revision: 'revision-archived',
            status: 'closed',
            archivedAt: '2026-07-18T00:00:00.000Z',
          ),
        ],
      );
      await pumpApp(tester, state: state, actions: actions, size: wideDesktop);

      expect(find.text('PROJECT ALPHA'), findsOneWidget);
      expect(find.text('PROJECT BETA'), findsOneWidget);
      expect(find.text('Archived investigation'), findsNothing);

      await tester.enterText(
        find.widgetWithText(TextField, 'Search sessions'),
        'second',
      );
      await tester.pump();
      expect(
        find.ancestor(
          of: find.text('First investigation'),
          matching: find.byType(ListTile),
        ),
        findsNothing,
      );
      expect(
        find.ancestor(
          of: find.text('Second investigation'),
          matching: find.byType(ListTile),
        ),
        findsOneWidget,
      );
      await tester.tap(find.byTooltip('Clear search'));
      await tester.pump();

      await tester.tap(find.byTooltip('New session'));
      await tester.pumpAndSettle();
      expect(find.text('New session'), findsOneWidget);
      await tester.enterText(find.byType(TextField).last, 'Fresh session');
      await tester.tap(find.widgetWithText(FilledButton, 'Create'));
      await tester.pumpAndSettle();
      expect(actions.createdSessions, <({String projectId, String? title})>[
        (projectId: 'project-alpha', title: 'Fresh session'),
      ]);

      await tester.tap(find.byTooltip('Session actions').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Archive').last);
      await tester.pumpAndSettle();
      expect(actions.archivedSessionIds, <String>['session-alpha']);

      await tester.tap(find.text('Archived'));
      await tester.pumpAndSettle();
      expect(find.text('Archived investigation'), findsOneWidget);
      await tester.tap(find.byTooltip('Session actions').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Restore').last);
      await tester.pumpAndSettle();
      expect(actions.restoredSessionIds, <String>['session-archived']);
    },
  );
  testWidgets('new-session dialog fits compact phones', (tester) async {
    final profile = HostProfile.parseTailnetAddress(
      'https://alpha.tailnet-name.ts.net',
    );
    final actions = _FakeActions();
    await pumpApp(
      tester,
      state: T4ViewState(
        connectionPhase: ConnectionPhase.ready,
        hostDirectory: HostDirectory.empty().upsert(profile),
        authenticationPhase: AuthenticationPhase.paired,
        grantedCapabilities: t4RequestedCapabilities.toSet(),
        sessions: const <SessionSummary>[
          SessionSummary(
            hostId: 'host-alpha',
            sessionId: 'session-alpha',
            projectId: 'project-alpha',
            projectName: 'Project Alpha',
            title: 'First investigation',
            revision: 'revision-alpha',
            status: 'idle',
          ),
        ],
      ),
      actions: actions,
      size: compactPhone,
    );

    await tester.tap(find.byTooltip('Open navigation'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('New session'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.enterText(
      find.byType(TextField).last,
      'T4_IOS_SIM_ACCEPTANCE_20260719',
    );
    await tester.pump();
    expect(tester.takeException(), isNull);
    await tester.tap(find.widgetWithText(FilledButton, 'Create'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
  testWidgets(
    'composer preserves per-session drafts and exposes turn controls',
    (tester) async {
      final profile = HostProfile.parseTailnetAddress(
        'https://alpha.tailnet-name.ts.net',
      );
      final actions = _FakeActions();
      T4ViewState stateFor(
        String selectedSessionId, {
        bool turnActive = false,
      }) => T4ViewState(
        connectionPhase: ConnectionPhase.ready,
        hostDirectory: HostDirectory.empty().upsert(profile),
        authenticationPhase: AuthenticationPhase.paired,
        grantedCapabilities: t4RequestedCapabilities.toSet(),
        selectedSessionId: selectedSessionId,
        sessions: const <SessionSummary>[
          SessionSummary(
            hostId: 'host-alpha',
            sessionId: 'session-alpha',
            projectId: 'project-alpha',
            projectName: 'Project Alpha',
            title: 'T4_IOS_SIM_ACCEPTANCE_20260719',
            revision: 'revision-alpha',
            status: 'idle',
          ),
          SessionSummary(
            hostId: 'host-alpha',
            sessionId: 'session-beta',
            projectId: 'project-alpha',
            projectName: 'Project Alpha',
            title: 'Second investigation',
            revision: 'revision-beta',
            status: 'idle',
          ),
        ],
        composer: SessionComposerState(
          modelLabel: 'openai-codex/gpt-5.6-sol',
          modelSelector: 'fixture/model',
          modelChoices: const <ComposerModelChoice>[
            ComposerModelChoice(
              label: 'Fixture model',
              selector: 'fixture/model',
            ),
          ],
          thinking: 'medium',
          thinkingLevels: const <String>['off', 'medium', 'high'],
          fastAvailable: true,
          turnActive: turnActive,
          queuedFollowUpCount: turnActive ? 2 : 0,
        ),
      );

      await pumpApp(
        tester,
        state: stateFor('session-alpha'),
        actions: actions,
        size: compactPhone,
      );
      await tester.enterText(find.byType(TextField).last, 'Alpha draft');

      await tester.pumpWidget(
        T4App(
          state: stateFor('session-beta'),
          actions: actions,
          credentialsAreVolatile: false,
        ),
      );
      await tester.pumpAndSettle();
      expect(find.widgetWithText(TextField, 'Alpha draft'), findsNothing);
      await tester.enterText(find.byType(TextField).last, 'Beta draft');

      await tester.pumpWidget(
        T4App(
          state: stateFor('session-alpha', turnActive: true),
          actions: actions,
          credentialsAreVolatile: false,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.widgetWithText(TextField, 'Alpha draft'), findsOneWidget);
      expect(find.text('openai-codex/gpt-5.6-sol'), findsOneWidget);
      expect(find.text('medium'), findsOneWidget);
      expect(find.text('Stop'), findsOneWidget);
      expect(find.text('Queue (2)'), findsOneWidget);

      // The circular send button doubles as the steer affordance while a
      // turn is active.
      await tester.tap(find.byTooltip('Steer'));
      await tester.pumpAndSettle();
      expect(actions.submittedPrompts, <String>['Alpha draft']);
    },
  );
  testWidgets(
    'composer stays disabled when prompt permission was not granted',
    (tester) async {
      final profile = HostProfile.parseTailnetAddress(
        'https://alpha.tailnet-name.ts.net',
      );
      final state = T4ViewState(
        connectionPhase: ConnectionPhase.ready,
        hostDirectory: HostDirectory.empty().upsert(profile),
        authenticationPhase: AuthenticationPhase.paired,
        grantedCapabilities: const <String>{'sessions.read', 'catalog.read'},
        selectedSessionId: 'session-alpha',
        sessions: const <SessionSummary>[
          SessionSummary(
            hostId: 'host-alpha',
            sessionId: 'session-alpha',
            projectId: 'project-alpha',
            projectName: 'Project Alpha',
            title: 'Read-only session',
            revision: 'revision-alpha',
            status: 'idle',
          ),
        ],
      );

      await pumpApp(
        tester,
        state: state,
        actions: _FakeActions(),
        size: compactPhone,
      );
      await tester.enterText(find.byType(TextField).last, 'Cannot send');
      await tester.pump();
      final send = tester.widget<IconButton>(
        find.ancestor(
          of: find.byIcon(Icons.arrow_upward),
          matching: find.byType(IconButton),
        ),
      );
      expect(send.onPressed, isNull);
    },
  );
  testWidgets(
    'Fast toggles from the model selector menu and reflects the current state',
    (tester) async {
      final profile = HostProfile.parseTailnetAddress(
        'https://alpha.tailnet-name.ts.net',
      );
      final actions = _FakeActions();
      T4ViewState stateFor({required bool fastEnabled}) => T4ViewState(
        connectionPhase: ConnectionPhase.ready,
        hostDirectory: HostDirectory.empty().upsert(profile),
        authenticationPhase: AuthenticationPhase.paired,
        grantedCapabilities: t4RequestedCapabilities.toSet(),
        selectedSessionId: 'session-alpha',
        sessions: const <SessionSummary>[
          SessionSummary(
            hostId: 'host-alpha',
            sessionId: 'session-alpha',
            projectId: 'project-alpha',
            projectName: 'Project Alpha',
            title: 'Fast toggle state',
            revision: 'revision-alpha',
            status: 'idle',
          ),
        ],
        composer: SessionComposerState(
          modelLabel: 'Fixture model',
          modelSelector: 'fixture/model',
          modelChoices: const <ComposerModelChoice>[
            ComposerModelChoice(
              label: 'Fixture model',
              selector: 'fixture/model',
            ),
          ],
          thinking: 'medium',
          thinkingLevels: const <String>['off', 'medium', 'high'],
          fastAvailable: true,
          fastEnabled: fastEnabled,
        ),
      );

      // Fast lives inside the model selector menu as a checkable item; it has
      // no standalone chip in the composer row.
      await pumpApp(
        tester,
        state: stateFor(fastEnabled: false),
        actions: actions,
        size: compactPhone,
      );
      await tester.pumpAndSettle();
      expect(find.text('Fast'), findsNothing);

      await tester.tap(find.text('Fixture model'));
      await tester.pumpAndSettle();
      final offItem = tester.widget<CheckboxMenuButton>(
        find.widgetWithText(CheckboxMenuButton, 'Fast'),
      );
      expect(offItem.value, isFalse);

      // Activating the unchecked item requests enabling Fast.
      await tester.tap(find.text('Fast'));
      await tester.pumpAndSettle();
      expect(actions.selectedFastModes, <bool>[true]);

      // On: the menu item reads as checked.
      await tester.pumpWidget(
        T4App(
          state: stateFor(fastEnabled: true),
          actions: actions,
          credentialsAreVolatile: false,
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Fixture model'));
      await tester.pumpAndSettle();
      final onItem = tester.widget<CheckboxMenuButton>(
        find.widgetWithText(CheckboxMenuButton, 'Fast'),
      );
      expect(onItem.value, isTrue);
    },
  );

  testWidgets('slash menu finds aliases and explains terminal-only commands', (
    tester,
  ) async {
    final profile = HostProfile.parseTailnetAddress(
      'https://alpha.tailnet-name.ts.net',
    );
    final state = T4ViewState(
      connectionPhase: ConnectionPhase.ready,
      hostDirectory: HostDirectory.empty().upsert(profile),
      authenticationPhase: AuthenticationPhase.paired,
      grantedCapabilities: t4RequestedCapabilities.toSet(),
      selectedSessionId: 'session-alpha',
      sessions: const <SessionSummary>[
        SessionSummary(
          hostId: 'host-alpha',
          sessionId: 'session-alpha',
          projectId: 'project-alpha',
          projectName: 'Project Alpha',
          title: 'Capability-aware slash menu',
          revision: 'revision-alpha',
          status: 'idle',
        ),
      ],
      composer: const SessionComposerState(
        slashCommands: <ComposerSlashCommand>[
          ComposerSlashCommand(
            name: '/compact',
            aliases: <String>['/compress'],
            description: 'Compact the active conversation',
            insert: '/compact ',
          ),
          ComposerSlashCommand(
            name: '/plan',
            description: 'Toggle plan mode',
            insert: '/plan ',
            disabledReason: '/plan requires the OMP terminal interface.',
          ),
        ],
      ),
    );

    await pumpApp(
      tester,
      state: state,
      actions: _FakeActions(),
      size: compactPhone,
    );
    await tester.enterText(find.byType(TextField).last, '/');
    await tester.pump();
    expect(find.text('/compact'), findsOneWidget);
    expect(find.text('/plan'), findsOneWidget);
    expect(
      find.text('/plan requires the OMP terminal interface.'),
      findsOneWidget,
    );

    await tester.enterText(find.byType(TextField).last, '/compress');
    await tester.pump();
    expect(find.text('/compact'), findsOneWidget);
    expect(find.text('/plan'), findsNothing);
  });
  testWidgets('keeps the latest message visible when the keyboard opens', (
    tester,
  ) async {
    await pumpApp(
      tester,
      state: keyboardTranscriptState(),
      actions: _FakeActions(),
      size: compactPhone,
    );
    await tester.pumpAndSettle();

    final list = transcriptList();
    final scrollable = tester.state<ScrollableState>(
      find.descendant(of: list, matching: find.byType(Scrollable)).first,
    );
    expect(
      scrollable.position.pixels,
      greaterThanOrEqualTo(scrollable.position.maxScrollExtent - 0.5),
    );

    tester.view.viewInsets = const FakeViewPadding(bottom: 320);
    await tester.pump();
    await tester.pump();

    final resizedScrollable = tester.state<ScrollableState>(
      find.descendant(of: list, matching: find.byType(Scrollable)).first,
    );
    expect(
      resizedScrollable.position.pixels,
      greaterThanOrEqualTo(resizedScrollable.position.maxScrollExtent - 0.5),
    );
  });

  testWidgets('a user drag cancels bottom follow before viewport changes', (
    tester,
  ) async {
    await pumpApp(
      tester,
      state: keyboardTranscriptState(),
      actions: _FakeActions(),
      size: compactPhone,
    );
    await tester.pumpAndSettle();

    final list = transcriptList();
    final scrollable = tester.state<ScrollableState>(
      find.descendant(of: list, matching: find.byType(Scrollable)).first,
    );
    final gesture = await tester.startGesture(tester.getCenter(list));
    await gesture.moveBy(const Offset(0, 48));
    await tester.pump();
    await gesture.moveBy(const Offset(0, 48));
    await tester.pump();
    final positionAfterDrag = scrollable.position.pixels;
    expect(
      scrollable.position.maxScrollExtent - positionAfterDrag,
      greaterThan(0),
    );

    tester.view.viewInsets = const FakeViewPadding(bottom: 80);
    await tester.pump();
    await tester.pump();

    expect(scrollable.position.pixels, closeTo(positionAfterDrag, 0.5));
    await gesture.up();
  });

  testWidgets('a desktop wheel scroll cancels bottom follow', (tester) async {
    await pumpApp(
      tester,
      state: keyboardTranscriptState(),
      actions: _FakeActions(),
      size: compactDesktop,
    );
    await tester.pumpAndSettle();

    final list = transcriptList();
    final scrollable = tester.state<ScrollableState>(
      find.descendant(of: list, matching: find.byType(Scrollable)).first,
    );
    await tester.sendEventToBinding(
      PointerScrollEvent(
        position: tester.getCenter(list),
        scrollDelta: const Offset(0, -320),
      ),
    );
    await tester.pump();
    final positionAfterWheel = scrollable.position.pixels;
    expect(
      scrollable.position.maxScrollExtent - positionAfterWheel,
      greaterThan(96),
    );

    tester.view.viewInsets = const FakeViewPadding(bottom: 80);
    await tester.pump();
    await tester.pump();

    expect(scrollable.position.pixels, closeTo(positionAfterWheel, 0.5));
  });

  testWidgets('preserves transcript history position when the keyboard opens', (
    tester,
  ) async {
    await pumpApp(
      tester,
      state: keyboardTranscriptState(),
      actions: _FakeActions(),
      size: compactPhone,
    );
    await tester.pumpAndSettle();

    final list = transcriptList();
    await tester.drag(list, const Offset(0, 320));
    await tester.pumpAndSettle();
    final scrollable = tester.state<ScrollableState>(
      find.descendant(of: list, matching: find.byType(Scrollable)).first,
    );
    final positionBeforeKeyboard = scrollable.position.pixels;
    expect(
      scrollable.position.maxScrollExtent - positionBeforeKeyboard,
      greaterThan(96),
    );

    tester.view.viewInsets = const FakeViewPadding(bottom: 320);
    await tester.pump();
    await tester.pump();

    final resizedScrollable = tester.state<ScrollableState>(
      find.descendant(of: list, matching: find.byType(Scrollable)).first,
    );
    expect(
      resizedScrollable.position.pixels,
      closeTo(positionBeforeKeyboard, 0.5),
    );
  });

  testWidgets('older transcript pages preserve the visible history anchor', (
    tester,
  ) async {
    final actions = _FakeActions();
    final current = List<TranscriptMessage>.generate(
      24,
      (index) => TranscriptMessage(
        id: 'message-$index',
        role: index.isEven ? MessageRole.user : MessageRole.assistant,
        text: 'Transcript message ${index + 1}',
      ),
    );
    await pumpApp(
      tester,
      state: keyboardTranscriptState(
        messages: current,
        transcriptHistoryHasMore: true,
      ),
      actions: actions,
      size: compactPhone,
    );
    await tester.pumpAndSettle();

    final list = transcriptList();
    await tester.drag(list, const Offset(0, 320));
    await tester.pumpAndSettle();
    final scrollable = tester.state<ScrollableState>(
      find.descendant(of: list, matching: find.byType(Scrollable)).first,
    );
    final distanceFromEnd =
        scrollable.position.maxScrollExtent - scrollable.position.pixels;
    expect(distanceFromEnd, greaterThan(96));

    final older = List<TranscriptMessage>.generate(
      4,
      (index) => TranscriptMessage(
        id: 'older-$index',
        role: MessageRole.assistant,
        text: 'Older transcript message ${index + 1}',
      ),
    );
    await pumpApp(
      tester,
      state: keyboardTranscriptState(
        messages: <TranscriptMessage>[...older, ...current],
        transcriptHistoryHasMore: true,
      ),
      actions: actions,
      size: compactPhone,
    );
    await tester.pumpAndSettle();

    expect(
      scrollable.position.maxScrollExtent - scrollable.position.pixels,
      closeTo(distanceFromEnd, 0.5),
    );
    await tester.drag(list, const Offset(0, 2000));
    await tester.pumpAndSettle();
    expect(find.text('Load earlier messages'), findsOneWidget);
    await tester.tap(find.text('Load earlier messages'));
    await tester.pump();
    expect(actions.loadEarlierCalls, 1);
  });

  testWidgets('labels a cached transcript until the live refresh arrives', (
    tester,
  ) async {
    await pumpApp(
      tester,
      state: keyboardTranscriptState(transcriptTailFromCache: true),
      actions: _FakeActions(),
      size: compactPhone,
    );

    expect(
      find.text(
        'Showing encrypted saved messages while the live transcript connects.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('collapses completed tool runs into a work group', (
    tester,
  ) async {
    await pumpApp(
      tester,
      state: keyboardTranscriptState(
        messages: const <TranscriptMessage>[
          TranscriptMessage(
            id: 'message-user',
            role: MessageRole.user,
            text: 'Fix the flaky test.',
          ),
          TranscriptMessage(
            id: 'message-write',
            role: MessageRole.tool,
            kind: TranscriptKind.tool,
            text: '',
            toolName: 'files.write',
            toolTitle: 'Write lib/main.dart',
            toolArguments: '{"path": "lib/main.dart", "content": ""}',
            toolSucceeded: true,
          ),
          TranscriptMessage(
            id: 'message-test',
            role: MessageRole.tool,
            kind: TranscriptKind.tool,
            text: '',
            toolName: 'terminal.run',
            toolTitle: 'Run flutter test',
            toolArguments: '{"command": "flutter test"}',
            toolSucceeded: true,
          ),
          TranscriptMessage(
            id: 'message-assistant',
            role: MessageRole.assistant,
            text: 'Done.',
          ),
        ],
      ),
      actions: _FakeActions(),
      size: compactPhone,
    );

    expect(find.text('Worked · 2 steps'), findsOneWidget);
    expect(find.text('Edited 1 file'), findsOneWidget);
    expect(find.text('main.dart'), findsOneWidget);
    expect(find.text('Write lib/main.dart'), findsNothing);
    expect(find.text('Run flutter test'), findsNothing);

    await tester.tap(find.text('Worked · 2 steps'));
    await tester.pumpAndSettle();
    expect(find.text('Write lib/main.dart'), findsOneWidget);
    expect(find.text('Run flutter test'), findsOneWidget);
  });

  testWidgets('renders actionable approvals inline below the transcript', (
    tester,
  ) async {
    final profile = HostProfile.parseTailnetAddress(
      'https://alpha.tailnet-name.ts.net',
    );
    final actions = _FakeActions();
    final approval = AttentionItem(
      key: 'session-alpha:approval:approval-inline',
      kind: AttentionKind.approval,
      sessionId: 'session-alpha',
      sessionTitle: 'First investigation',
      revision: 'revision-alpha',
      title: 'Allow file write?',
      summary: 'OMP wants to update lib/main.dart.',
      at: DateTime.utc(2026, 7, 21),
      requestId: 'approval-inline',
      actionable: true,
    );
    await pumpApp(
      tester,
      state: T4ViewState(
        connectionPhase: ConnectionPhase.ready,
        hostDirectory: HostDirectory.empty().upsert(profile),
        authenticationPhase: AuthenticationPhase.paired,
        grantedCapabilities: t4RequestedCapabilities.toSet(),
        selectedSessionId: 'session-alpha',
        sessions: const <SessionSummary>[
          SessionSummary(
            hostId: 'host-alpha',
            sessionId: 'session-alpha',
            projectId: 'project-alpha',
            projectName: 'Project Alpha',
            title: 'First investigation',
            revision: 'revision-alpha',
            status: 'active',
          ),
        ],
        messages: const <TranscriptMessage>[
          TranscriptMessage(
            id: 'message-user',
            role: MessageRole.user,
            text: 'Please update main.dart.',
          ),
          TranscriptMessage(
            id: 'message-assistant',
            role: MessageRole.assistant,
            text: 'Requesting write access now.',
          ),
        ],
        attentionItems: <AttentionItem>[approval],
      ),
      actions: actions,
      size: compactPhone,
    );

    expect(find.text('Allow file write?'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Approve'));
    await tester.pump();
    expect(actions.attentionResponses, hasLength(1));
    expect(
      actions.attentionResponses.single.response.decision,
      AttentionDecision.approve,
    );
  });

  testWidgets('attention inbox exposes decisions and agent updates', (
    tester,
  ) async {
    final profile = HostProfile.parseTailnetAddress(
      'https://alpha.tailnet-name.ts.net',
    );
    final actions = _FakeActions();
    final approval = AttentionItem(
      key: 'session-alpha:approval:approval-1',
      kind: AttentionKind.approval,
      sessionId: 'session-alpha',
      sessionTitle: 'First investigation',
      revision: 'revision-alpha',
      title: 'Allow file write?',
      summary: 'OMP wants to update lib/main.dart.',
      at: DateTime.utc(2026, 7, 19),
      requestId: 'approval-1',
      actionable: true,
    );
    await pumpApp(
      tester,
      state: T4ViewState(
        connectionPhase: ConnectionPhase.ready,
        hostDirectory: HostDirectory.empty().upsert(profile),
        authenticationPhase: AuthenticationPhase.paired,
        grantedCapabilities: t4RequestedCapabilities.toSet(),
        selectedSessionId: 'session-alpha',
        sessions: const <SessionSummary>[
          SessionSummary(
            hostId: 'host-alpha',
            sessionId: 'session-alpha',
            projectId: 'project-alpha',
            projectName: 'Project Alpha',
            title: 'First investigation',
            revision: 'revision-alpha',
            status: 'active',
          ),
        ],
        attentionItems: <AttentionItem>[approval],
        agentActivities: <AgentActivity>[
          AgentActivity(
            agentId: 'agent-parent',
            sessionId: 'session-alpha',
            label: 'Coordinator',
            status: 'running',
            progress: 0.75,
            updatedAt: DateTime.utc(2026, 7, 19),
          ),
          AgentActivity(
            agentId: 'agent-child',
            sessionId: 'session-alpha',
            label: 'Review child',
            status: 'running',
            progress: 0.5,
            updatedAt: DateTime.utc(2026, 7, 19, 0, 1),
            parentAgentId: 'agent-parent',
            description: 'Reviewing changes',
            model: 'fixture-model',
            currentTool: 'read',
          ),
        ],
      ),
      actions: actions,
      size: compactPhone,
    );

    await tester.tap(find.byTooltip('Open inbox'));
    await tester.pumpAndSettle();
    expect(find.text('Inbox · 1 waiting'), findsOneWidget);
    expect(find.text('Needs you (1)'), findsOneWidget);
    expect(find.text('Allow file write?'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, 'Approve'));
    await tester.pumpAndSettle();
    expect(actions.attentionResponses, hasLength(1));
    expect(
      actions.attentionResponses.single.response.decision,
      AttentionDecision.approve,
    );

    await tester.tap(find.text('Agents (2)'));
    await tester.pumpAndSettle();
    expect(find.text('Coordinator'), findsOneWidget);
    expect(find.text('Review child'), findsOneWidget);
    expect(find.text('Reviewing changes'), findsOneWidget);
    expect(find.text('running · fixture-model · read'), findsOneWidget);

    await tester.tap(find.byTooltip('Stop Review child'));
    await tester.pumpAndSettle();
    expect(find.text('Stop background agent?'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Stop agent'));
    await tester.pumpAndSettle();
    expect(actions.cancelledAgentIds, <String>['agent-child']);
  });
  testWidgets('phone transcript search loads highlighted historical context', (
    tester,
  ) async {
    const searchResult = TranscriptSearchResult(
      items: <TranscriptSearchItem>[
        TranscriptSearchItem(
          sessionId: 'session-history',
          projectId: 'project-history',
          sessionTitle: 'Parser investigation',
          anchorId: 'entry-anchor',
          role: TranscriptSearchRole.assistant,
          timestamp: '2026-07-19T12:00:00.000Z',
          snippet: 'Fixed the parser boundary',
          highlights: <TranscriptSearchHighlight>[
            TranscriptSearchHighlight(start: 0, end: 5),
          ],
        ),
      ],
      incomplete: false,
      index: TranscriptSearchIndexStatus(
        state: TranscriptSearchIndexState.ready,
        indexedSessions: 3,
        knownSessions: 3,
        generation: 'generation-1',
      ),
    );
    const contextResult = TranscriptContextResult(
      anchorId: 'entry-anchor',
      rows: <TranscriptContextRow>[
        TranscriptContextRow(
          anchorId: 'entry-before',
          role: TranscriptSearchRole.user,
          timestamp: '2026-07-19T11:59:00.000Z',
          text: 'Please inspect the parser boundary.',
        ),
        TranscriptContextRow(
          anchorId: 'entry-anchor',
          role: TranscriptSearchRole.assistant,
          timestamp: '2026-07-19T12:00:00.000Z',
          text: 'The parser boundary is fixed.',
        ),
      ],
      anchorIndex: 1,
      hasBefore: false,
      hasAfter: false,
      generation: 'generation-1',
    );
    final actions = _FakeActions(
      transcriptSearchResult: searchResult,
      transcriptContextResult: contextResult,
    );
    await pumpApp(
      tester,
      state: const T4ViewState(
        connectionPhase: ConnectionPhase.ready,
        authenticationPhase: AuthenticationPhase.paired,
        targetConfigured: true,
      ),
      actions: actions,
      size: compactPhone,
    );

    await tester.tap(find.byTooltip('Open navigation'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Search').last);
    await tester.pumpAndSettle();
    await tester.enterText(
      find.widgetWithText(TextField, 'Search transcripts'),
      'parser',
    );
    await tester.tap(find.byTooltip('Search'));
    await tester.pumpAndSettle();

    expect(actions.transcriptQueries, <String>['parser']);
    expect(find.text('Parser investigation'), findsOneWidget);
    expect(find.text('Fixed the parser boundary'), findsOneWidget);
    expect(find.text('3 sessions indexed'), findsOneWidget);

    await tester.tap(find.text('Show context'));
    await tester.pumpAndSettle();
    expect(actions.contextAnchors, <String>['entry-anchor']);
    expect(find.text('Please inspect the parser boundary.'), findsOneWidget);
    expect(find.text('The parser boundary is fixed.'), findsOneWidget);
  });

  testWidgets('phone usage surface shows provider and broker status', (
    tester,
  ) async {
    const usage = UsageReadResult(
      generatedAt: 1720000000000,
      reports: <UsageReport>[
        UsageReport(
          provider: 'OpenAI',
          fetchedAt: 1720000000000,
          limits: <UsageLimit>[
            UsageLimit(
              id: 'requests',
              label: 'Requests',
              scope: UsageScope(provider: 'OpenAI'),
              amount: UsageAmount(used: 4, limit: 10, unit: UsageUnit.requests),
              status: UsageStatus.ok,
              notes: <String>[],
            ),
          ],
          notes: <String>[],
          metadata: <String, Object?>{},
        ),
      ],
      accountsWithoutUsage: <UsageAccountWithoutReport>[],
      capacity: <String, List<UsageCapacityWindow>>{},
    );
    final actions = _FakeActions(
      usageReadResult: usage,
      brokerStatusResult: const BrokerStatusResult(
        state: BrokerState.connected,
        generation: 1,
        endpoint: 'https://broker.example.test',
      ),
    );
    await pumpApp(
      tester,
      state: T4ViewState(
        connectionPhase: ConnectionPhase.ready,
        authenticationPhase: AuthenticationPhase.paired,
        targetConfigured: true,
        grantedCapabilities: const {'usage.read', 'broker.read'},
      ),
      actions: actions,
      size: compactPhone,
    );

    await tester.tap(find.byTooltip('Open navigation'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Usage').last);
    await tester.pumpAndSettle();

    expect(find.text('Broker connected'), findsOneWidget);
    expect(find.text('https://broker.example.test'), findsOneWidget);
    expect(find.text('OpenAI'), findsOneWidget);
    expect(find.text('Requests'), findsOneWidget);
    expect(find.text('4 / 10 requests'), findsOneWidget);
  });

  testWidgets('developer tools expose activity, files, and review on phones', (
    tester,
  ) async {
    final profile = HostProfile.parseTailnetAddress(
      'https://alpha.tailnet-name.ts.net',
    );
    final actions = _FakeActions();
    await pumpApp(
      tester,
      state: T4ViewState(
        connectionPhase: ConnectionPhase.ready,
        hostDirectory: HostDirectory.empty().upsert(profile),
        authenticationPhase: AuthenticationPhase.paired,
        grantedCapabilities: t4RequestedCapabilities.toSet(),
        selectedSessionId: 'session-alpha',
        sessions: const <SessionSummary>[
          SessionSummary(
            hostId: 'host-alpha',
            sessionId: 'session-alpha',
            projectId: 'project-alpha',
            projectName: 'Project Alpha',
            title: 'First investigation',
            revision: 'revision-alpha',
            status: 'active',
          ),
        ],
        activities: <DeveloperActivity>[
          DeveloperActivity(
            id: 'activity-1',
            category: 'tool',
            title: 'files.read',
            detail: 'lib/main.dart',
            at: DateTime.utc(2026, 7, 19),
            raw: '{"path":"lib/main.dart"}',
          ),
        ],
        fileWorkspace: const FileWorkspaceState(
          path: 'lib/main.dart',
          entries: <DeveloperFileEntry>[
            DeveloperFileEntry(
              path: 'lib/main.dart',
              kind: 'file',
              size: 42,
              revision: 'revision-file',
            ),
          ],
          content: 'void main() {}',
          diff: '-void old() {}\n+void main() {}',
          revision: 'revision-file',
        ),
        reviews: const <ReviewWorkspaceItem>[
          ReviewWorkspaceItem(
            reviewId: 'review-1',
            sessionId: 'session-alpha',
            status: 'pending',
            path: 'lib/main.dart',
            findings: <Map<String, Object?>>[
              <String, Object?>{'message': 'Avoid an empty main body.'},
            ],
          ),
        ],
        previews: const <PreviewWorkspaceState>[
          PreviewWorkspaceState(
            previewId: 'preview-1',
            sessionId: 'session-alpha',
            state: 'ready',
            url: 'https://preview.example.test',
            revision: 'revision-preview',
            title: 'Fixture preview',
            canGoBack: false,
            canGoForward: false,
          ),
        ],
        activePreviewId: 'preview-1',
      ),
      actions: actions,
      size: compactPhone,
    );

    await tester.tap(find.byTooltip('Open developer tools'));
    await tester.pumpAndSettle();
    expect(find.text('Activity'), findsOneWidget);
    expect(find.text('files.read'), findsOneWidget);

    await tester.tap(find.text('Files'));
    await tester.pumpAndSettle();
    expect(find.text('lib/main.dart'), findsWidgets);
    expect(find.text('void main() {}'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'void main() { run(); }');
    await tester.pump();
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    expect(actions.fileWrites, <({String path, String content})>[
      (path: 'lib/main.dart', content: 'void main() { run(); }'),
    ]);

    await tester.tap(find.text('Review'));
    await tester.pumpAndSettle();
    expect(find.text('Reload diff'), findsOneWidget);
    expect(find.textContaining('+void main() {}'), findsOneWidget);
    expect(find.text('Avoid an empty main body.'), findsOneWidget);
    await tester.tap(find.byTooltip('Apply review'));
    await tester.pumpAndSettle();
    expect(actions.appliedReviewIds, <String>['review-1']);

    await tester.drag(find.byType(TabBar), const Offset(-300, 0));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Preview'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Interact'));
    await tester.pumpAndSettle();
    expect(find.text('Preview interaction'), findsOneWidget);
    await tester.tap(find.text('Run click'));
    await tester.pumpAndSettle();
    expect(actions.previewInteractions.single.previewId, 'preview-1');
    expect(actions.previewInteractions.single.action, 'click');
    expect(actions.previewInteractions.single.args, <String, Object?>{
      'selector': 'button',
    });
  });

  testWidgets('quick open searches the selected project and opens its file', (
    tester,
  ) async {
    final profile = HostProfile.parseTailnetAddress(
      'https://alpha.tailnet-name.ts.net',
    );
    final actions = _FakeActions(
      projectFileSearchResult: const ProjectFileSearchResult(
        paths: <String>['lib/main.dart', 'test/main_test.dart'],
        truncated: false,
      ),
    );
    await pumpApp(
      tester,
      state: T4ViewState(
        connectionPhase: ConnectionPhase.ready,
        hostDirectory: HostDirectory.empty().upsert(profile),
        authenticationPhase: AuthenticationPhase.paired,
        grantedCapabilities: t4RequestedCapabilities.toSet(),
        grantedFeatures: const <String>{'files.search'},
        selectedSessionId: 'session-alpha',
        sessions: const <SessionSummary>[
          SessionSummary(
            hostId: 'host-alpha',
            sessionId: 'session-alpha',
            projectId: 'project-alpha',
            projectName: 'Project Alpha',
            title: 'Quick open fixture',
            revision: 'revision-alpha',
            status: 'idle',
          ),
        ],
      ),
      actions: actions,
      size: compactPhone,
    );

    await tester.tap(find.byTooltip('Quick open project file'));
    await tester.pumpAndSettle();
    expect(find.text('Quick open'), findsOneWidget);

    await tester.enterText(
      find.widgetWithText(TextField, 'Find a project file'),
      'main',
    );
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pumpAndSettle();
    expect(actions.projectFileQueries, <String>['main']);
    expect(find.text('lib/main.dart'), findsOneWidget);

    await tester.tap(find.text('lib/main.dart'));
    await tester.pumpAndSettle();
    expect(actions.readFilePaths, <String>['lib/main.dart']);
    expect(find.text('Developer tools'), findsOneWidget);
    expect(find.text('Files'), findsOneWidget);
  });

  testWidgets('composer exposes pause, resume, and manual compaction', (
    tester,
  ) async {
    final profile = HostProfile.parseTailnetAddress(
      'https://alpha.tailnet-name.ts.net',
    );
    final actions = _FakeActions();
    T4ViewState stateFor({required bool turnActive, required bool isPaused}) =>
        T4ViewState(
          connectionPhase: ConnectionPhase.ready,
          hostDirectory: HostDirectory.empty().upsert(profile),
          authenticationPhase: AuthenticationPhase.paired,
          grantedCapabilities: t4RequestedCapabilities.toSet(),
          selectedSessionId: 'session-alpha',
          sessions: <SessionSummary>[
            SessionSummary(
              hostId: 'host-alpha',
              sessionId: 'session-alpha',
              projectId: 'project-alpha',
              projectName: 'Project Alpha',
              title: 'Control fixture',
              revision: 'revision-alpha',
              status: turnActive ? 'active' : 'idle',
              turnActive: turnActive,
              isPaused: isPaused,
            ),
          ],
          composer: SessionComposerState(
            turnActive: turnActive,
            isPaused: isPaused,
          ),
        );

    await pumpApp(
      tester,
      state: stateFor(turnActive: true, isPaused: false),
      actions: actions,
      size: compactPhone,
    );
    expect(find.text('Pause'), findsOneWidget);
    expect(find.text('Stop'), findsOneWidget);
    await tester.tap(find.text('Pause'));
    await tester.pumpAndSettle();
    expect(actions.pauseSessionCalls, 1);

    await tester.pumpWidget(
      T4App(
        state: stateFor(turnActive: false, isPaused: true),
        actions: actions,
        credentialsAreVolatile: false,
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Resume'), findsOneWidget);
    expect(find.text('Resume the session to continue'), findsOneWidget);
    await tester.tap(find.text('Resume'));
    await tester.pumpAndSettle();
    expect(actions.resumeSessionCalls, 1);

    await tester.pumpWidget(
      T4App(
        state: stateFor(turnActive: false, isPaused: false),
        actions: actions,
        credentialsAreVolatile: false,
      ),
    );
    await tester.pumpAndSettle();
    // Manual compaction moved into the model selector menu.
    await tester.tap(find.text('Model'));
    await tester.pumpAndSettle();
    expect(find.text('Compact'), findsOneWidget);
    await tester.tap(find.text('Compact'));
    await tester.pumpAndSettle();
    expect(actions.compactSessionCalls, 1);
  });
}

final class _FakeActions implements T4Actions {
  _FakeActions({
    this.addHostError,
    this.addHostCompletion,
    this.transcriptSearchResult,
    this.transcriptContextResult,
    this.usageReadResult,
    this.brokerStatusResult,
    this.projectFileSearchResult,
  });

  final Object? addHostError;
  final Completer<void>? addHostCompletion;
  final TranscriptSearchResult? transcriptSearchResult;
  final TranscriptContextResult? transcriptContextResult;
  final UsageReadResult? usageReadResult;
  final BrokerStatusResult? brokerStatusResult;
  final ProjectFileSearchResult? projectFileSearchResult;
  final List<String> transcriptQueries = <String>[];
  final List<String> contextAnchors = <String>[];
  final List<String> addedAddresses = <String>[];
  final List<String> addedProfileIds = <String>[];
  final List<String> activatedEndpointKeys = <String>[];
  int connectCalls = 0;
  final List<String> removedEndpointKeys = <String>[];
  final List<String> pairingCodes = <String>[];
  int cancelHostProbeCalls = 0;
  int disconnectCalls = 0;
  final List<({String projectId, String? title})> createdSessions =
      <({String projectId, String? title})>[];
  final List<({String sessionId, String title})> renamedSessions =
      <({String sessionId, String title})>[];
  final List<String> terminatedSessionIds = <String>[];
  final List<String> archivedSessionIds = <String>[];
  final List<String> restoredSessionIds = <String>[];
  final List<String> submittedPrompts = <String>[];
  final List<String> queuedPrompts = <String>[];
  int cancelTurnCalls = 0;
  int pauseSessionCalls = 0;
  int resumeSessionCalls = 0;
  int compactSessionCalls = 0;
  int loadEarlierCalls = 0;
  final List<String> selectedModels = <String>[];
  final List<String> selectedThinkingLevels = <String>[];
  final List<bool> selectedFastModes = <bool>[];
  final List<String> deletedSessionIds = <String>[];
  final List<({AttentionItem item, AttentionResponse response})>
  attentionResponses = <({AttentionItem item, AttentionResponse response})>[];
  final List<String> retriedSessionIds = <String>[];
  final List<String> cancelledAgentIds = <String>[];
  final List<String> projectFileQueries = <String>[];
  final List<String> readFilePaths = <String>[];
  final List<({String path, String content})> fileWrites =
      <({String path, String content})>[];
  final List<String> refreshedReviewIds = <String>[];
  final List<String> appliedReviewIds = <String>[];
  final List<({String previewId, String action, Map<String, Object?> args})>
  previewInteractions =
      <({String previewId, String action, Map<String, Object?> args})>[];

  @override
  Future<void> setThemePreference(T4ThemePreference preference) async {}

  @override
  Future<void> refreshSettings() async {}

  @override
  Future<void> writeSetting(
    String path,
    String scope, {
    Object? value,
    bool reset = false,
  }) async {}

  @override
  Future<void> handleLifecyclePhase(T4LifecyclePhase phase) async {}

  @override
  Future<void> addHost(
    String address, {
    String profileId = defaultHostProfileId,
  }) async {
    addedAddresses.add(address);
    addedProfileIds.add(profileId);
    final error = addHostError;
    if (error != null) throw error;
    await addHostCompletion?.future;
  }

  @override
  void cancelHostProbe() {
    cancelHostProbeCalls += 1;
  }

  @override
  Future<void> activateHost(String endpointKey) async {
    activatedEndpointKeys.add(endpointKey);
  }

  @override
  Future<void> createSession(String projectId, {String? title}) async {
    createdSessions.add((projectId: projectId, title: title));
  }

  @override
  Future<void> renameSession(String sessionId, String title) async {
    renamedSessions.add((sessionId: sessionId, title: title));
  }

  @override
  Future<void> terminateSession(String sessionId) async {
    terminatedSessionIds.add(sessionId);
  }

  @override
  Future<void> archiveSession(String sessionId) async {
    archivedSessionIds.add(sessionId);
  }

  @override
  Future<void> restoreSession(String sessionId) async {
    restoredSessionIds.add(sessionId);
  }

  @override
  Future<void> deleteSession(String sessionId) async {
    deletedSessionIds.add(sessionId);
  }

  @override
  Future<TranscriptSearchResult> searchTranscripts({
    required String query,
    String? cursor,
    String? projectId,
    List<TranscriptSearchRole>? roles,
    String archived = 'include',
    DateTime? from,
    DateTime? to,
  }) async {
    transcriptQueries.add(query);
    return transcriptSearchResult ??
        (throw UnsupportedError('transcript search is not configured'));
  }

  @override
  Future<TranscriptContextResult> loadTranscriptContext({
    required String sessionId,
    required String anchorId,
    int before = 8,
    int after = 8,
  }) async {
    contextAnchors.add(anchorId);
    return transcriptContextResult ??
        (throw UnsupportedError('transcript context is not configured'));
  }

  @override
  Future<void> loadEarlierTranscript() async {
    loadEarlierCalls += 1;
  }

  @override
  Future<UsageReadResult> readUsage() async =>
      usageReadResult ?? (throw UnsupportedError('usage is not configured'));

  @override
  Future<BrokerStatusResult> readBrokerStatus() async =>
      brokerStatusResult ??
      (throw UnsupportedError('broker status is not configured'));

  @override
  Future<void> cancelAgent(String agentId) async {
    cancelledAgentIds.add(agentId);
  }

  @override
  Future<void> connect() async {
    connectCalls += 1;
  }

  @override
  Future<void> disconnect() async {
    disconnectCalls += 1;
  }

  @override
  Future<void> pairHost(String code) async {
    pairingCodes.add(code);
  }

  @override
  Future<void> removeHost(String endpointKey) async {
    removedEndpointKeys.add(endpointKey);
  }

  @override
  Future<void> selectSession(String sessionId) async {}

  @override
  Future<bool> submitPrompt(
    String message, {
    List<PromptImageAttachment> images = const <PromptImageAttachment>[],
  }) async {
    submittedPrompts.add(message);
    return true;
  }

  @override
  Future<bool> queuePrompt(String message) async {
    queuedPrompts.add(message);
    return true;
  }

  @override
  Future<void> cancelTurn() async {
    cancelTurnCalls += 1;
  }

  @override
  Future<void> pauseSession() async {
    pauseSessionCalls += 1;
  }

  @override
  Future<void> resumeSession() async {
    resumeSessionCalls += 1;
  }

  @override
  Future<void> compactSession({String? instructions}) async {
    compactSessionCalls += 1;
  }

  @override
  Future<void> setSessionModel(String selector) async {
    selectedModels.add(selector);
  }

  @override
  Future<void> setSessionThinking(String level) async {
    selectedThinkingLevels.add(level);
  }

  @override
  Future<void> setSessionFast(bool enabled) async {
    selectedFastModes.add(enabled);
  }

  @override
  Future<bool> respondToAttention(
    AttentionItem item,
    AttentionResponse response,
  ) async {
    attentionResponses.add((item: item, response: response));
    return true;
  }

  @override
  Future<void> retrySession(String sessionId) async {
    retriedSessionIds.add(sessionId);
  }

  @override
  Future<void> refreshActivity() async {}

  @override
  Future<String> openTerminal({String? cwd}) async => 'terminal-test';

  @override
  void sendTerminalInput(String terminalId, String data) {}

  @override
  void resizeTerminal(String terminalId, int cols, int rows) {}

  @override
  void closeTerminal(String terminalId) {}

  @override
  Future<void> listFiles([String path = '']) async {}

  @override
  Future<ProjectFileSearchResult> searchProjectFiles(
    String query, {
    int limit = 12,
  }) async {
    projectFileQueries.add(query);
    return projectFileSearchResult ??
        (throw UnsupportedError('project file search is not configured'));
  }

  @override
  Future<void> readFile(String path) async {
    readFilePaths.add(path);
  }

  @override
  Future<void> loadSessionDiff() async {}

  @override
  Future<void> writeFile(String path, String content) async {
    fileWrites.add((path: path, content: content));
  }

  @override
  Future<void> refreshReview(String reviewId) async {
    refreshedReviewIds.add(reviewId);
  }

  @override
  Future<void> applyReview(String reviewId) async {
    appliedReviewIds.add(reviewId);
  }

  @override
  Future<void> runPreviewInteraction(
    String previewId,
    String action,
    Map<String, Object?> args,
  ) async {
    previewInteractions.add((previewId: previewId, action: action, args: args));
  }

  @override
  Future<String> launchPreview(String url) async => 'preview-test';

  @override
  Future<void> selectPreview(String previewId) async {}

  @override
  Future<void> navigatePreview(String previewId, String url) async {}

  @override
  Future<void> runPreviewAction(String previewId, String action) async {}

  @override
  Future<void> capturePreview(String previewId) async {}

  @override
  Future<Uint8List> readTranscriptImage(
    String entryId,
    TranscriptImageMetadata image,
  ) async => Uint8List(0);
}
