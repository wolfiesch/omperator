import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:t4code/src/client/t4_client_controller.dart';
import 'package:t4code/src/client/app_state.dart';
import 'package:t4code/src/host/host_profile.dart';
import 'package:t4code/src/protocol/protocol.dart';

const _startupTimeout = Duration(seconds: 10);
const _operationTimeout = Duration(seconds: 5);

void main() {
  test(
    'streams, settles, and resumes against the real stream-v1 fixture',
    () async {
      final fixture = await _FixtureProcess.start();
      final controller = T4ClientController(
        hostDirectoryStore: _MemoryDirectoryStore(),
        hostCredentialStore: _MemoryCredentialStore(),
        developmentEndpoint: fixture.wsUrl,
      );
      addTearDown(() async {
        controller.dispose();
        await fixture.stop();
      });

      await controller.initialize().timeout(_operationTimeout);
      final initiallyReady = await _waitForState(
        controller,
        (state) => state.connectionPhase == ConnectionPhase.ready,
        description: 'the initial snapshot to become ready',
      );

      expect(initiallyReady.errorMessage, isNull);
      expect(initiallyReady.submitting, isFalse);
      expect(initiallyReady.sessions, hasLength(1));
      expect(initiallyReady.selectedSessionId, 'session-stream');
      expect(initiallyReady.messages, hasLength(1));
      final snapshotMessage = initiallyReady.messages.single;
      expect(snapshotMessage.role, MessageRole.assistant);
      expect(snapshotMessage.text, 'Hello world');
      expect(snapshotMessage.streaming, isFalse);
      final session = initiallyReady.selectedSession;
      expect(session, isNotNull);
      expect(session!.hostId, 'host-stream');
      expect(session.sessionId, 'session-stream');
      expect(session.title, 'stream-v1 fixture');
      expect(session.revision, 'rev-stream-1');

      const prompt = 'Flutter fixture prompt';
      final promptAccepted = _waitForState(
        controller,
        (state) =>
            state.submitting &&
            state.messages.any(
              (message) =>
                  message.role == MessageRole.user && message.text == prompt,
            ),
        description: 'the fixture to accept the prompt',
      );
      await controller.submitPrompt(prompt).timeout(_operationTimeout);
      final submitting = await promptAccepted;
      expect(submitting.errorMessage, isNull);
      expect(
        submitting.messages.where((message) => message.text == prompt),
        hasLength(1),
      );

      final settledFuture = _waitForState(
        controller,
        (state) =>
            !state.submitting &&
            state.messages.any(
              (message) =>
                  message.id != snapshotMessage.id &&
                  message.role == MessageRole.assistant &&
                  message.text == 'Hello world' &&
                  !message.streaming,
            ),
        description: 'the streamed response to settle durably',
      );
      final advance = await fixture.advanceBy(30);
      expect(advance, containsPair('ok', true));
      expect(advance, containsPair('nowMs', 30));
      final settled = await settledFuture;

      expect(settled.connectionPhase, ConnectionPhase.ready);
      expect(settled.errorMessage, isNull);
      expect(
        settled.messages,
        hasLength(2),
        reason: settled.messages
            .map(
              (message) =>
                  '${message.id}|${message.role.name}|${message.text}|${message.streaming}',
            )
            .join(', '),
      );
      expect(
        settled.messages
            .where(
              (message) =>
                  message.role == MessageRole.assistant &&
                  message.text == 'Hello world',
            )
            .length,
        2,
      );
      expect(settled.messages.where((message) => message.streaming), isEmpty);
      expect(
        settled.messages.map((message) => message.id).toSet(),
        hasLength(settled.messages.length),
      );

      final retainedTranscript = settled.messages
          .map(
            (message) => (
              id: message.id,
              role: message.role,
              text: message.text,
              streaming: message.streaming,
            ),
          )
          .toList(growable: false);

      final retryingFuture = _waitForState(
        controller,
        (state) => state.connectionPhase == ConnectionPhase.retrying,
        description: 'the forced disconnect to enter retrying',
      );
      await fixture.disconnectClients();
      final retrying = await retryingFuture;
      expect(
        retrying.messages.map((message) => message.id),
        retainedTranscript.map((message) => message.id),
      );

      final reconnected = await _waitForState(
        controller,
        (state) => state.connectionPhase == ConnectionPhase.ready,
        description: 'the controller to reconnect automatically',
      );
      expect(reconnected.errorMessage, isNull);
      expect(reconnected.submitting, isFalse);
      expect(
        reconnected.messages
            .map(
              (message) => (
                id: message.id,
                role: message.role,
                text: message.text,
                streaming: message.streaming,
              ),
            )
            .toList(growable: false),
        retainedTranscript,
      );
      expect(
        reconnected.messages.where((message) => message.streaming),
        isEmpty,
      );
      expect(
        reconnected.messages.where((message) => message.text == 'Hello world'),
        hasLength(2),
      );

      final fixtureState = await fixture.state();
      expect(fixtureState, containsPair('scenario', 'stream-v1'));
      expect(fixtureState, containsPair('clients', 1));
      expect(fixtureState, containsPair('connections', 2));
    },
  );
  test(
    'reads and explicitly confirms settings writes against the real fixture',
    () async {
      final fixture = await _FixtureProcess.start();
      final controller = T4ClientController(
        hostDirectoryStore: _MemoryDirectoryStore(),
        hostCredentialStore: _MemoryCredentialStore(),
        developmentEndpoint: fixture.wsUrl,
      );
      addTearDown(() async {
        controller.dispose();
        await fixture.stop();
      });

      await controller.initialize().timeout(_operationTimeout);
      final settingsReady = await _waitForState(
        controller,
        (state) =>
            state.connectionPhase == ConnectionPhase.ready &&
            !state.settings.loading &&
            state.settings.entries.any(
              (entry) => entry.path == 'appearance.mode',
            ),
        description: 'fixture settings metadata to load',
      );
      final appearance = settingsReady.settings.entries.singleWhere(
        (entry) => entry.path == 'appearance.mode',
      );
      expect(appearance.effectiveValue, 'system');
      expect(appearance.restartRequired, isTrue);
      expect(appearance.writableScopes, contains('global'));
      final secret = settingsReady.settings.entries.singleWhere(
        (entry) => entry.path == 'provider.apiKey',
      );
      expect(secret.sensitive, isTrue);
      expect(secret.effectiveValue, isNull);

      final write = controller.writeSetting(
        'appearance.mode',
        'global',
        value: 'dark',
      );
      final challenged = await _waitForState(
        controller,
        (state) => state.attentionItems.any(
          (item) =>
              item.kind == AttentionKind.confirmation &&
              item.sessionId.isEmpty &&
              item.needsResponse,
        ),
        description: 'fixture settings confirmation',
      );
      final confirmation = challenged.attentionItems.singleWhere(
        (item) =>
            item.kind == AttentionKind.confirmation &&
            item.sessionId.isEmpty &&
            item.needsResponse,
      );
      await controller.respondToAttention(
        confirmation,
        const AttentionResponse(decision: AttentionDecision.approve),
      );
      await write.timeout(_operationTimeout);

      final applied = controller.state.settings.entries.singleWhere(
        (entry) => entry.path == 'appearance.mode',
      );
      expect(applied.effectiveValue, 'dark');
      expect(applied.effectiveSource, 'global');
      expect(controller.state.settings.error, isNull);
      expect(controller.state.settingsOperationPending, isFalse);

      final resumeWrite = controller.writeSetting(
        'session.autoResume',
        'global',
        value: false,
      );
      final resumeChallenge = await _waitForState(
        controller,
        (state) => state.attentionItems.any(
          (item) =>
              item.kind == AttentionKind.confirmation &&
              item.sessionId.isEmpty &&
              item.needsResponse,
        ),
        description: 'fixture resume setting confirmation',
      );
      final resumeConfirmation = resumeChallenge.attentionItems.singleWhere(
        (item) =>
            item.kind == AttentionKind.confirmation &&
            item.sessionId.isEmpty &&
            item.needsResponse,
      );
      await controller.respondToAttention(
        resumeConfirmation,
        const AttentionResponse(decision: AttentionDecision.approve),
      );
      await resumeWrite.timeout(_operationTimeout);
      expect(
        controller.state.settings.entries
            .singleWhere((entry) => entry.path == 'session.autoResume')
            .effectiveValue,
        false,
      );
    },
  );
  test(
    'runs implemented session and developer workflows against the real fixture',
    () async {
      final fixture = await _FixtureProcess.start();
      final controller = T4ClientController(
        hostDirectoryStore: _MemoryDirectoryStore(),
        hostCredentialStore: _MemoryCredentialStore(),
        developmentEndpoint: fixture.wsUrl,
      );
      addTearDown(() async {
        controller.dispose();
        await fixture.stop();
      });

      await controller.initialize().timeout(_operationTimeout);
      await _waitForState(
        controller,
        (state) => state.connectionPhase == ConnectionPhase.ready,
        description: 'fixture session to become ready',
      );
      const sessionId = 'session-stream';

      final search = await controller
          .searchTranscripts(
            query: 'fixture',
            roles: const <TranscriptSearchRole>[TranscriptSearchRole.assistant],
          )
          .timeout(_operationTimeout);
      expect(search.items.single.sessionId, sessionId);
      expect(search.items.single.snippet, contains('transcript search'));
      expect(search.index.state, TranscriptSearchIndexState.ready);
      final context = await controller
          .loadTranscriptContext(
            sessionId: sessionId,
            anchorId: search.items.single.anchorId,
          )
          .timeout(_operationTimeout);
      expect(context.rows, hasLength(2));
      expect(context.rows[context.anchorIndex].anchorId, context.anchorId);

      final usage = await controller.readUsage().timeout(_operationTimeout);
      expect(usage.reports.single.provider, 'fixture-provider');
      expect(usage.reports.single.limits.single.amount.used, 4);
      final broker = await controller.readBrokerStatus().timeout(
        _operationTimeout,
      );
      expect(broker.state, BrokerState.connected);
      expect(broker.endpoint, 'https://broker.fixture.invalid');

      await _waitForState(
        controller,
        (state) => state.agentActivities.any(
          (activity) =>
              activity.agentId == 'agent-fixture' &&
              activity.parentAgentId == 'agent-parent' &&
              activity.currentTool == 'read',
        ),
        description: 'fixture agent hierarchy projection',
      );
      await controller.cancelAgent('agent-fixture').timeout(_operationTimeout);
      await _waitForState(
        controller,
        (state) => state.agentActivities.any(
          (activity) =>
              activity.agentId == 'agent-fixture' &&
              activity.status == 'cancelled',
        ),
        description: 'cancelled fixture child agent',
      );

      await controller
          .renameSession(sessionId, 'Renamed fixture')
          .timeout(_operationTimeout);
      await _waitForState(
        controller,
        (state) =>
            state.sessions
                .where((session) => session.sessionId == sessionId)
                .single
                .title ==
            'Renamed fixture',
        description: 'renamed session projection',
      );

      await controller.refreshActivity().timeout(_operationTimeout);
      await controller.listFiles().timeout(_operationTimeout);
      expect(controller.state.fileWorkspace.entries, isEmpty);
      await controller.readFile('README.md').timeout(_operationTimeout);
      expect(controller.state.fileWorkspace.path, 'README.md');
      expect(controller.state.fileWorkspace.content, '');
      await controller.loadSessionDiff().timeout(_operationTimeout);
      expect(controller.state.fileWorkspace.diff, '');
      expect(controller.state.fileWorkspace.revision, isNotNull);
      expect(controller.state.reviews.single.reviewId, 'review-fixture');
      await controller
          .writeFile('README.md', 'fixture edit')
          .timeout(_operationTimeout);
      expect(controller.state.fileWorkspace.content, 'fixture edit');
      await controller.applyReview('review-fixture').timeout(_operationTimeout);
      await _waitForState(
        controller,
        (state) => state.reviews.single.status == 'applied',
        description: 'applied fixture review projection',
      );

      final terminalId = await controller
          .openTerminal(cwd: 'src')
          .timeout(_operationTimeout);
      expect(terminalId, 'terminal-fixture');
      expect(controller.state.activeTerminalId, terminalId);
      expect(controller.state.terminals.single.running, isTrue);
      controller.sendTerminalInput(terminalId, 'pwd\n');
      controller.resizeTerminal(terminalId, 100, 30);
      controller.closeTerminal(terminalId);
      expect(controller.state.terminals, isEmpty);

      final previewId = await controller
          .launchPreview('http://127.0.0.1/fixture')
          .timeout(_operationTimeout);
      expect(controller.state.activePreviewId, previewId);
      await controller.capturePreview(previewId).timeout(_operationTimeout);
      expect(controller.state.activePreview?.capture, isNotEmpty);
      await controller
          .runPreviewInteraction(previewId, 'press', <String, Object?>{
            'key': 'Enter',
          })
          .timeout(_operationTimeout);
      expect(controller.state.activePreviewId, previewId);
      await controller
          .navigatePreview(previewId, 'http://127.0.0.1/next')
          .timeout(_operationTimeout);
      expect(controller.state.activePreview?.url, 'http://127.0.0.1/next');
      await controller
          .runPreviewAction(previewId, 'close')
          .timeout(_operationTimeout);
      expect(controller.state.previews, isEmpty);

      await controller.archiveSession(sessionId).timeout(_operationTimeout);
      await _waitForState(
        controller,
        (state) => state.sessions
            .where((session) => session.sessionId == sessionId)
            .single
            .archived,
        description: 'archived session projection',
      );
      await controller.restoreSession(sessionId).timeout(_operationTimeout);
      await _waitForState(
        controller,
        (state) => !state.sessions
            .where((session) => session.sessionId == sessionId)
            .single
            .archived,
        description: 'restored session projection',
      );

      await controller.deleteSession(sessionId).timeout(_operationTimeout);
      await _waitForState(
        controller,
        (state) =>
            state.sessions.every((session) => session.sessionId != sessionId),
        description: 'deleted session projection',
      );
    },
  );
}

Future<T4ViewState> _waitForState(
  T4ClientController controller,
  bool Function(T4ViewState state) predicate, {
  required String description,
}) {
  final completer = Completer<T4ViewState>();
  late void Function() listener;

  listener = () {
    if (completer.isCompleted) return;
    final state = controller.state;
    if (!predicate(state)) return;
    controller.removeListener(listener);
    completer.complete(state);
  };

  controller.addListener(listener);
  listener();
  return completer.future.timeout(
    _operationTimeout,
    onTimeout: () {
      controller.removeListener(listener);
      final state = controller.state;
      throw TimeoutException(
        'Timed out waiting for $description; '
        'phase=${state.connectionPhase.name}, '
        'messages=${state.messages.map((message) => '${message.id}:${message.text}:${message.streaming}').toList()}, '
        'error=${state.errorMessage}',
      );
    },
  );
}

final class _MemoryDirectoryStore implements HostDirectoryStore {
  HostDirectory directory = const HostDirectory.empty();

  @override
  Future<HostDirectory> load() async => directory;

  @override
  Future<void> save(HostDirectory directory) async {
    this.directory = directory;
  }
}

final class _MemoryCredentialStore implements HostCredentialStore {
  @override
  Future<void> delete(HostProfile profile) async {}

  @override
  Future<DeviceCredentials?> read(HostProfile profile) async => null;

  @override
  Future<void> write(
    HostProfile profile,
    DeviceCredentials credentials,
  ) async {}
}

final class _FixtureProcess {
  _FixtureProcess._({
    required this._process,
    required this.wsUrl,
    required this._controlUrl,
    required this._stdoutSubscription,
    required this._stderrSubscription,
  });

  final Process _process;
  final Uri wsUrl;
  final Uri _controlUrl;
  final StreamSubscription<String> _stdoutSubscription;
  final StreamSubscription<String> _stderrSubscription;
  final HttpClient _httpClient = HttpClient();
  bool _stopped = false;

  static Future<_FixtureProcess> start() async {
    final process = await Process.start(
      '../../node_modules/.bin/jiti',
      const <String>['../../e2e/fixture-process.ts'],
      environment: const <String, String>{'T4_FIXTURE_SCENARIO': 'stream-v1'},
    ).timeout(_operationTimeout);
    final stderr = StringBuffer();
    final ready = Completer<({Uri wsUrl, Uri controlUrl})>();

    final stdoutSubscription = process.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen(
          (line) {
            const prefix = 'T4_FIXTURE_READY ';
            if (ready.isCompleted || !line.startsWith(prefix)) return;
            try {
              final decoded = jsonDecode(line.substring(prefix.length));
              if (decoded is! Map<String, dynamic>) {
                throw const FormatException(
                  'fixture ready payload is not an object',
                );
              }
              final wsUrl = Uri.parse(decoded['wsUrl'] as String);
              final controlUrl = Uri.parse(decoded['controlUrl'] as String);
              if (wsUrl.scheme != 'ws' || wsUrl.host.isEmpty) {
                throw FormatException('invalid fixture WebSocket URL: $wsUrl');
              }
              if (controlUrl.scheme != 'http' || controlUrl.host.isEmpty) {
                throw FormatException(
                  'invalid fixture control URL: $controlUrl',
                );
              }
              ready.complete((wsUrl: wsUrl, controlUrl: controlUrl));
            } on Object catch (error, stackTrace) {
              ready.completeError(error, stackTrace);
            }
          },
          onError: (Object error, StackTrace stackTrace) {
            if (!ready.isCompleted) ready.completeError(error, stackTrace);
          },
        );
    final stderrSubscription = process.stderr
        .transform(utf8.decoder)
        .listen(stderr.write);

    unawaited(
      process.exitCode.then((exitCode) {
        if (!ready.isCompleted) {
          ready.completeError(
            StateError(
              'Fixture process exited before ready with code $exitCode. '
              'stderr: $stderr',
            ),
          );
        }
      }),
    );

    try {
      final endpoints = await ready.future.timeout(
        _startupTimeout,
        onTimeout: () => throw TimeoutException(
          'Fixture process did not become ready. stderr: $stderr',
          _startupTimeout,
        ),
      );
      return _FixtureProcess._(
        process: process,
        wsUrl: endpoints.wsUrl,
        controlUrl: endpoints.controlUrl,
        stdoutSubscription: stdoutSubscription,
        stderrSubscription: stderrSubscription,
      );
    } on Object {
      await _terminate(process);
      await Future.wait<void>([
        stdoutSubscription.cancel(),
        stderrSubscription.cancel(),
      ]).timeout(_operationTimeout);
      rethrow;
    }
  }

  Future<Map<String, dynamic>> advanceBy(int milliseconds) => _request(
    'POST',
    _controlUrl
        .resolve('/advance')
        .replace(queryParameters: <String, String>{'ms': '$milliseconds'}),
  );

  Future<Map<String, dynamic>> disconnectClients() =>
      _request('POST', _controlUrl.resolve('/disconnect'));

  Future<Map<String, dynamic>> state() =>
      _request('GET', _controlUrl.resolve('/state'));

  Future<Map<String, dynamic>> _request(String method, Uri uri) async {
    final request = await _httpClient
        .openUrl(method, uri)
        .timeout(_operationTimeout);
    final response = await request.close().timeout(_operationTimeout);
    final body = await response
        .transform(utf8.decoder)
        .join()
        .timeout(_operationTimeout);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw HttpException(
        'Fixture control $method $uri failed with ${response.statusCode}: $body',
        uri: uri,
      );
    }
    final decoded = jsonDecode(body);
    if (decoded is! Map<String, dynamic>) {
      throw FormatException('Fixture control response is not an object: $body');
    }
    return decoded;
  }

  Future<void> stop() async {
    if (_stopped) return;
    _stopped = true;
    _httpClient.close(force: true);
    try {
      await _terminate(_process);
    } finally {
      await Future.wait<void>([
        _stdoutSubscription.cancel(),
        _stderrSubscription.cancel(),
      ]).timeout(_operationTimeout);
    }
  }

  static Future<void> _terminate(Process process) async {
    process.kill(ProcessSignal.sigterm);
    await process.exitCode.timeout(
      _operationTimeout,
      onTimeout: () async {
        process.kill(ProcessSignal.sigkill);
        return process.exitCode.timeout(_operationTimeout);
      },
    );
  }
}
