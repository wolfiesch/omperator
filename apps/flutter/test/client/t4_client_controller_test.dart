import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:t4code/src/client/app_state.dart';
import 'package:t4code/src/client/t4_client_controller.dart';
import 'package:t4code/src/client/transcript_tail_store.dart';
import 'package:t4code/src/client/web_socket_connector.dart';
import 'package:t4code/src/host/host_profile.dart';
import 'package:t4code/src/host/app_preferences.dart';
import 'package:t4code/src/protocol/protocol.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

void main() {
  test(
    'loads credentials before connecting and sends authenticated hello',
    () async {
      final profile = _profile('alpha');
      final events = <String>[];
      final directory = _MemoryDirectoryStore(
        directory: const HostDirectory.empty().upsert(profile),
        events: events,
      );
      final credentials = _MemoryCredentialStore(events: events)
        ..values[profile.endpointKey] = DeviceCredentials(
          deviceId: 'device-alpha',
          deviceToken: _token,
        );
      final connector = _FakeConnector(events: events);
      final controller = _controller(directory, credentials, connector);
      addTearDown(controller.dispose);

      await controller.initialize();
      await _flush();

      expect(events.take(3), <String>[
        'load',
        'read:${profile.endpointKey}',
        'connect:${profile.webSocketUrl}',
      ]);
      final hello = connector.channels.single.sentJson.single;
      expect(hello['type'], 'hello');
      expect(hello['capabilities'], <String, Object?>{
        'client': t4RequestedCapabilities,
      });
      expect(hello['authentication'], <String, Object?>{
        'deviceId': 'device-alpha',
        'deviceToken': _token,
      });
    },
  );

  test(
    'probes before saving a host and then connects to the saved profile',
    () async {
      final events = <String>[];
      final directory = _MemoryDirectoryStore(events: events);
      final credentials = _MemoryCredentialStore(events: events);
      final connector = _FakeConnector(events: events);
      final controller = _controller(directory, credentials, connector);
      addTearDown(controller.dispose);
      await controller.initialize();

      await controller.addHost('alpha.example.ts.net');

      final saveIndex = events.indexWhere((event) => event.startsWith('save:'));
      final probeIndex = events.indexOf(
        'connect:wss://alpha.example.ts.net/v1/ws',
      );
      final probeCloseIndex = events.indexOf('close:0');
      expect(probeIndex, greaterThanOrEqualTo(0));
      expect(probeCloseIndex, greaterThan(probeIndex));
      expect(saveIndex, greaterThan(probeCloseIndex));
      expect(connector.uris, hasLength(2));
      expect(
        directory.directory.activeProfile?.webSocketUrl,
        connector.uris.last,
      );
    },
  );

  test(
    'welcome bootstraps session.list then host.watch with index cursor',
    () async {
      final profile = _profile('alpha');
      final directory = _MemoryDirectoryStore(
        directory: const HostDirectory.empty().upsert(profile),
      );
      final credentials = _MemoryCredentialStore();
      final connector = _FakeConnector();
      final controller = _controller(directory, credentials, connector);
      addTearDown(controller.dispose);
      await controller.initialize();
      final channel = connector.channels.single;

      final hello = channel.sentJson.single;
      final requestedFeatures = (hello['requestedFeatures']! as List<Object?>)
          .cast<String>();
      expect(requestedFeatures, t4RequestedFeatures);
      channel.emit(_welcome('host-alpha', features: requestedFeatures));
      await _flush();
      expect(
        controller.state.grantedCapabilities,
        containsAll(<String>['sessions.read']),
      );
      expect(controller.state.grantedFeatures, containsAll(requestedFeatures));
      final list = channel.sentJson.last;
      expect(list, containsPair('command', 'session.list'));

      channel.emit(
        _response(
          list,
          command: 'session.list',
          result: _sessionListResult(
            'host-alpha',
            epoch: 'index-epoch',
            seq: 7,
          ),
        ),
      );
      await _flush();

      final watch = channel.sentJson.lastWhere(
        (frame) => frame['command'] == 'host.watch',
      );
      expect(watch, containsPair('command', 'host.watch'));
      expect(watch['args'], <String, Object?>{
        'cursor': <String, Object?>{'epoch': 'index-epoch', 'seq': 7},
      });
      expect(controller.state.sessions.single.sessionId, 'session-alpha');
    },
  );

  test(
    'pages a cold transcript before attach and prepends older history separately',
    () async {
      final profile = _profile('alpha');
      final directory = _MemoryDirectoryStore(
        directory: const HostDirectory.empty().upsert(profile),
      );
      final connector = _FakeConnector();
      final cache = InMemoryTranscriptTailStore();
      await cache.save(
        hostId: 'host-alpha',
        sessionId: 'session-alpha',
        generation: 'cached-generation',
        entries: <DurableEntry>[
          _durableMessage(
            'cached-entry',
            hostId: 'host-alpha',
            sessionId: 'session-alpha',
            text: 'saved recent answer',
          ),
        ],
      );
      final controller = _controller(
        directory,
        _MemoryCredentialStore(),
        connector,
        transcriptTailStore: cache,
      );
      addTearDown(controller.dispose);
      await controller.initialize();
      final channel = connector.channels.single;
      Map<String, Object?> entry(String id, String text) => <String, Object?>{
        'id': id,
        'parentId': null,
        'hostId': 'host-alpha',
        'sessionId': 'session-alpha',
        'kind': 'message',
        'timestamp': '2026-07-20T09:00:00.000Z',
        'data': <String, Object?>{'role': 'assistant', 'text': text},
      };

      channel.emit(
        _welcome('host-alpha', features: const <String>['transcript.page']),
      );
      await _flush();
      final list = channel.sentJson.last;
      channel.emit(
        _response(
          list,
          command: 'session.list',
          result: _sessionListResult('host-alpha'),
        ),
      );
      channel.emit(_sessions('host-alpha'));
      await _until(
        () => channel.sentJson.any(
          (frame) => frame['command'] == 'transcript.page',
        ),
      );

      expect(controller.state.messages.single.id, 'cached-entry');
      expect(controller.state.transcriptTailFromCache, isTrue);
      expect(
        channel.sentJson.where(
          (frame) => frame['command'] == 'transcript.page',
        ),
        hasLength(1),
      );

      final page = channel.sentJson.lastWhere(
        (frame) => frame['command'] == 'transcript.page',
      );
      expect(
        channel.sentJson.where(
          (frame) => frame['command'] == 'transcript.page',
        ),
        hasLength(1),
      );
      expect(
        channel.sentJson.where((frame) => frame['command'] == 'session.attach'),
        isEmpty,
      );
      expect(page['command'], 'transcript.page');
      expect(page['args'], <String, Object?>{
        'limit': 64,
        'maxBytes': 256 * 1024,
      });
      expect(
        channel.sentJson.where((frame) => frame['command'] == 'session.attach'),
        isEmpty,
      );
      channel.emit(
        _response(
          page,
          command: 'transcript.page',
          result: <String, Object?>{
            'entries': <Object?>[
              entry('page-1', 'paged one'),
              entry('page-2', 'paged two'),
            ],
            'nextCursor': 'older-page',
            'hasMore': true,
            'generation': 'page-generation',
          },
        ),
      );
      await _flush();

      final attach = channel.sentJson.last;
      expect(attach['command'], 'session.attach');
      expect(controller.state.messages.map((message) => message.id), <String>[
        'page-1',
        'page-2',
      ]);
      expect(controller.state.transcriptHistoryHasMore, isTrue);
      expect(controller.state.transcriptTailFromCache, isFalse);

      channel.emit(<String, Object?>{
        ..._snapshot(
          'host-alpha',
          'session-alpha',
          revision: 'revision-session-alpha',
        ),
        'entries': <Object?>[
          entry('page-2', 'paged two'),
          entry('live-3', 'live three'),
        ],
      });
      await _flush();
      expect(controller.state.messages.map((message) => message.id), <String>[
        'page-1',
        'page-2',
        'live-3',
      ]);

      final loadOlder = controller.loadEarlierTranscript();
      await _flush();
      final older = channel.sentJson.last;
      expect(older['command'], 'transcript.page');
      expect(older['args'], <String, Object?>{
        'before': 'older-page',
        'limit': 128,
        'maxBytes': 512 * 1024,
      });
      channel.emit(
        _response(
          older,
          command: 'transcript.page',
          result: <String, Object?>{
            'entries': <Object?>[entry('older-0', 'older zero')],
            'hasMore': false,
            'generation': 'page-generation',
          },
        ),
      );
      await loadOlder;

      expect(controller.state.messages.map((message) => message.id), <String>[
        'older-0',
        'page-1',
        'page-2',
        'live-3',
      ]);
      expect(controller.state.transcriptHistoryHasMore, isFalse);
      expect(controller.state.transcriptHistoryLoading, isFalse);
    },
  );

  test(
    'hydrates Fast availability after attaching an existing session',
    () async {
      final profile = _profile('alpha');
      final directory = _MemoryDirectoryStore(
        directory: const HostDirectory.empty().upsert(profile),
      );
      final connector = _FakeConnector();
      final controller = _controller(
        directory,
        _MemoryCredentialStore(),
        connector,
      );
      addTearDown(controller.dispose);
      await controller.initialize();
      final channel = connector.channels.single;

      channel.emit(_welcome('host-alpha'));
      await _flush();
      final list = channel.sentJson.last;
      channel.emit(
        _response(
          list,
          command: 'session.list',
          result: _sessionListResult('host-alpha'),
        ),
      );
      await _flush();
      final attach = channel.sentJson.singleWhere(
        (frame) => frame['command'] == 'session.attach',
      );
      channel.emit(
        _response(
          attach,
          command: 'session.attach',
          result: const <String, Object?>{},
        ),
      );
      await _flush();

      final stateGet = channel.sentJson.last;
      expect(stateGet['command'], 'session.state.get');
      expect(stateGet['sessionId'], 'session-alpha');
      channel.emit(
        _response(
          stateGet,
          command: 'session.state.get',
          result: <String, Object?>{
            'isStreaming': false,
            'isCompacting': false,
            'isPaused': false,
            'messageCount': 99,
            'queuedMessageCount': 0,
            'steeringMode': 'one-at-a-time',
            'followUpMode': 'one-at-a-time',
            'interruptMode': 'immediate',
            'model': <String, Object?>{
              'id': 'gpt-5.6-sol',
              'provider': 'openai-codex',
              'displayName': 'GPT-5.6-Sol',
              'selector': 'openai-codex/gpt-5.6-sol:high',
              'role': 'default',
            },
            'thinking': 'high',
            'thinkingLevels': <Object?>[
              'low',
              'medium',
              'high',
              'xhigh',
              'max',
            ],
            'thinkingSupported': true,
            'fast': false,
            'fastAvailable': true,
            'fastActive': false,
          },
        ),
      );
      await _flush();

      expect(controller.state.composer.fastAvailable, isTrue);
      expect(controller.state.composer.fastEnabled, isFalse);
      expect(controller.state.composer.modelLabel, 'GPT-5.6-Sol');
      expect(controller.state.composer.thinking, 'high');
    },
  );

  test(
    'keeps observer sessions ready when state hydration is locked',
    () async {
      final profile = _profile('alpha');
      final directory = _MemoryDirectoryStore(
        directory: const HostDirectory.empty().upsert(profile),
      );
      final connector = _FakeConnector();
      final controller = _controller(
        directory,
        _MemoryCredentialStore(),
        connector,
      );
      addTearDown(controller.dispose);
      await controller.initialize();
      final channel = connector.channels.single;

      channel.emit(_welcome('host-alpha'));
      await _flush();
      final list = channel.sentJson.last;
      channel.emit(
        _response(
          list,
          command: 'session.list',
          result: _sessionListResult('host-alpha'),
        ),
      );
      await _flush();
      final attach = channel.sentJson.singleWhere(
        (frame) => frame['command'] == 'session.attach',
      );
      channel.emit(
        _response(
          attach,
          command: 'session.attach',
          result: const <String, Object?>{},
        ),
      );
      await _flush();
      final stateGet = channel.sentJson.last;
      expect(stateGet['command'], 'session.state.get');

      channel.emit(
        _snapshot(
          'host-alpha',
          'session-alpha',
          revision: 'revision-session-alpha',
        ),
      );
      channel.emit(<String, Object?>{
        'v': 'omp-app/1',
        'type': 'response',
        'requestId': stateGet['requestId'],
        'commandId': stateGet['commandId'],
        'hostId': stateGet['hostId'],
        'sessionId': stateGet['sessionId'],
        'command': 'session.state.get',
        'ok': false,
        'error': <String, Object?>{
          'code': 'session_locked',
          'message': 'session is locked by another process',
        },
      });
      await _flush();

      expect(controller.state.connectionPhase, ConnectionPhase.ready);
      expect(controller.state.errorMessage, isNull);
      expect(controller.state.composer.fastAvailable, isFalse);
    },
  );

  test('command ids are unique across controller restarts', () async {
    final profile = _profile('alpha');
    final directory = _MemoryDirectoryStore(
      directory: const HostDirectory.empty().upsert(profile),
    );
    final firstConnector = _FakeConnector();
    final secondConnector = _FakeConnector();
    final first = _controller(
      directory,
      _MemoryCredentialStore(),
      firstConnector,
    );
    final second = _controller(
      directory,
      _MemoryCredentialStore(),
      secondConnector,
    );
    addTearDown(first.dispose);
    addTearDown(second.dispose);

    await first.initialize();
    await second.initialize();
    final firstChannel = firstConnector.channels.single;
    final secondChannel = secondConnector.channels.single;
    firstChannel.emit(_welcome('host-alpha'));
    secondChannel.emit(_welcome('host-alpha'));
    await _flush();

    expect(
      firstChannel.sentJson.last['commandId'],
      isNot(secondChannel.sentJson.last['commandId']),
    );
  });

  test(
    'duplicate inventories share an attach while a new selection stays isolated',
    () async {
      final profile = _profile('alpha');
      final directory = _MemoryDirectoryStore(
        directory: const HostDirectory.empty().upsert(profile),
      );
      final connector = _FakeConnector();
      final controller = _controller(
        directory,
        _MemoryCredentialStore(),
        connector,
      );
      addTearDown(controller.dispose);
      await controller.initialize();
      final channel = connector.channels.single;

      channel.emit(_welcome('host-alpha'));
      await _flush();
      final list = channel.sentJson.last;
      final inventory = _sessionListResultFor('host-alpha', const <String>[
        'session-alpha',
        'session-beta',
      ]);
      channel.emit(<String, Object?>{
        'v': 'omp-app/1',
        'type': 'sessions',
        'hostId': 'host-alpha',
        ...inventory,
      });
      await _flush();
      final firstAttach = channel.sentJson.singleWhere(
        (frame) =>
            frame['command'] == 'session.attach' &&
            frame['sessionId'] == 'session-alpha',
      );

      channel.emit(_response(list, command: 'session.list', result: inventory));
      await _flush();
      expect(
        channel.sentJson.where(
          (frame) =>
              frame['command'] == 'session.attach' &&
              frame['sessionId'] == 'session-alpha',
        ),
        hasLength(1),
      );

      await controller.selectSession('session-beta');
      expect(
        channel.sentJson.where((frame) => frame['command'] == 'session.attach'),
        hasLength(2),
      );
      expect(channel.sentJson.last['sessionId'], 'session-beta');
      expect(controller.state.connectionPhase, ConnectionPhase.synchronizing);

      channel.emit(
        _response(
          firstAttach,
          command: 'session.attach',
          result: const <String, Object?>{},
        ),
      );
      await _flush();
      expect(controller.state.selectedSessionId, 'session-beta');
      expect(controller.state.connectionPhase, ConnectionPhase.synchronizing);
    },
  );

  test(
    'ignores transcript frames from a previously selected session',
    () async {
      final profile = _profile('alpha');
      final directory = _MemoryDirectoryStore(
        directory: const HostDirectory.empty().upsert(profile),
      );
      final connector = _FakeConnector();
      final controller = _controller(
        directory,
        _MemoryCredentialStore(),
        connector,
      );
      addTearDown(controller.dispose);
      await controller.initialize();
      final channel = connector.channels.single;

      channel.emit(_welcome('host-alpha'));
      await _flush();
      channel.emit(<String, Object?>{
        'v': 'omp-app/1',
        'type': 'sessions',
        'hostId': 'host-alpha',
        ..._sessionListResultFor('host-alpha', const <String>[
          'session-alpha',
          'session-beta',
        ]),
      });
      await _flush();
      channel.emit(
        _snapshot('host-alpha', 'session-alpha', revision: 'revision-alpha'),
      );
      await _flush();

      await controller.selectSession('session-beta');
      channel.emit(
        _snapshot('host-alpha', 'session-beta', revision: 'revision-beta'),
      );
      channel.emit(
        _transcriptEvent(
          'host-alpha',
          'session-beta',
          seq: 1,
          event: const <String, Object?>{
            'type': 'message.update',
            'entryId': 'live-message',
            'role': 'assistant',
            'text': 'Beta response',
          },
        ),
      );
      await _flush();
      expect(controller.state.messages.single.text, 'Beta response');

      channel.emit(
        _transcriptMessageEntry(
          'host-alpha',
          'session-alpha',
          seq: 1,
          entryId: 'stale-durable-system',
          role: 'system',
          text: 'Stale durable system prompt',
        ),
      );
      channel.emit(
        _transcriptEvent(
          'host-alpha',
          'session-alpha',
          seq: 2,
          event: const <String, Object?>{
            'type': 'message.update',
            'entryId': 'live-message',
            'role': 'system',
            'text': 'Stale system prompt',
          },
        ),
      );
      channel.emit(
        _transcriptEvent(
          'host-alpha',
          'session-alpha',
          seq: 3,
          event: const <String, Object?>{
            'type': 'tool.start',
            'callId': 'alpha-tool',
            'tool': 'bash',
          },
        ),
      );
      channel.emit(<String, Object?>{
        'v': 'omp-app/1',
        'type': 'gap',
        'hostId': 'host-alpha',
        'sessionId': 'session-alpha',
        'from': <String, Object?>{'epoch': 'transcript', 'seq': 4},
        'to': <String, Object?>{'epoch': 'transcript', 'seq': 5},
        'reason': 'stale alpha gap',
      });
      await _flush();

      expect(controller.state.selectedSessionId, 'session-beta');
      expect(controller.state.connectionPhase, ConnectionPhase.ready);
      expect(controller.state.messages, hasLength(1));
      expect(controller.state.messages.single.role, MessageRole.assistant);
      expect(controller.state.messages.single.text, 'Beta response');
    },
  );

  test(
    'gap recovery requests a cursorless snapshot before returning ready',
    () async {
      final profile = _profile('alpha');
      final directory = _MemoryDirectoryStore(
        directory: const HostDirectory.empty().upsert(profile),
      );
      final connector = _FakeConnector();
      final controller = _controller(
        directory,
        _MemoryCredentialStore(),
        connector,
      );
      addTearDown(controller.dispose);
      await controller.initialize();
      final channel = connector.channels.single;

      channel.emit(_welcome('host-alpha'));
      await _flush();
      final list = channel.sentJson.last;
      channel.emit(
        _response(
          list,
          command: 'session.list',
          result: _sessionListResult('host-alpha'),
        ),
      );
      await _flush();
      final initialAttach = channel.sentJson.singleWhere(
        (frame) => frame['command'] == 'session.attach',
      );
      channel.emit(
        _response(
          initialAttach,
          command: 'session.attach',
          result: const <String, Object?>{},
        ),
      );
      channel.emit(
        _snapshot('host-alpha', 'session-alpha', revision: 'revision-initial'),
      );
      await _flush();
      expect(controller.state.connectionPhase, ConnectionPhase.ready);

      channel.emit(<String, Object?>{
        'v': 'omp-app/1',
        'type': 'gap',
        'hostId': 'host-alpha',
        'sessionId': 'session-alpha',
        'from': <String, Object?>{'epoch': 'transcript', 'seq': 1},
        'to': <String, Object?>{'epoch': 'transcript', 'seq': 5},
        'reason': 'rebase_budget_exceeded',
      });
      await _flush();

      final recoveryAttach = channel.sentJson.lastWhere(
        (frame) =>
            frame['command'] == 'session.attach' &&
            frame['requestId'] != initialAttach['requestId'],
      );
      expect(recoveryAttach['args'], isEmpty);
      expect(controller.state.connectionPhase, ConnectionPhase.synchronizing);
      expect(
        controller.state.errorMessage,
        'Recovering transcript continuity…',
      );

      channel.emit(
        _response(
          recoveryAttach,
          command: 'session.attach',
          result: const <String, Object?>{},
        ),
      );
      await _flush();
      expect(controller.state.connectionPhase, ConnectionPhase.synchronizing);
      channel.emit(<String, Object?>{
        ..._snapshot(
          'host-alpha',
          'session-alpha',
          revision: 'revision-recovered',
        ),
        'cursor': <String, Object?>{'epoch': 'transcript', 'seq': 5},
      });
      await _flush();

      expect(controller.state.connectionPhase, ConnectionPhase.ready);
      expect(controller.state.errorMessage, isNull);
    },
  );

  test('returning to a session requests its complete transcript', () async {
    final profile = _profile('alpha');
    final directory = _MemoryDirectoryStore(
      directory: const HostDirectory.empty().upsert(profile),
    );
    final connector = _FakeConnector();
    final controller = _controller(
      directory,
      _MemoryCredentialStore(),
      connector,
    );
    addTearDown(controller.dispose);
    await controller.initialize();
    final channel = connector.channels.single;

    channel.emit(_welcome('host-alpha'));
    await _flush();
    channel.emit(<String, Object?>{
      'v': 'omp-app/1',
      'type': 'sessions',
      'hostId': 'host-alpha',
      ..._sessionListResultFor('host-alpha', const <String>[
        'session-alpha',
        'session-beta',
      ]),
    });
    await _flush();
    final firstSessionId = controller.state.selectedSessionId!;
    final secondSessionId = controller.state.sessions
        .firstWhere((session) => session.sessionId != firstSessionId)
        .sessionId;
    final firstAttach = channel.sentJson.last;
    channel.emit(
      _response(
        firstAttach,
        command: 'session.attach',
        result: const <String, Object?>{},
      ),
    );
    channel.emit(
      _snapshot('host-alpha', firstSessionId, revision: 'revision-first'),
    );
    await _flush();

    await controller.selectSession(secondSessionId);
    expect(controller.state.selectedSessionId, secondSessionId);
    final secondAttach = channel.sentJson.last;
    channel.emit(
      _response(
        secondAttach,
        command: 'session.attach',
        result: const <String, Object?>{},
      ),
    );
    channel.emit(
      _snapshot('host-alpha', secondSessionId, revision: 'revision-second'),
    );
    await _flush();
    expect(controller.state.selectedSessionId, secondSessionId);
    expect(
      controller.state.sessions.map((session) => session.sessionId),
      contains(firstSessionId),
    );
    await controller.selectSession(firstSessionId);
    expect(controller.state.selectedSessionId, firstSessionId);

    final attach = channel.sentJson.last;
    expect(attach, containsPair('command', 'session.attach'));
    expect(attach, containsPair('sessionId', firstSessionId));
    expect(attach['args'], isEmpty);
  });

  test(
    'switching hosts clears projections without deleting credentials',
    () async {
      final alpha = _profile('alpha');
      final beta = _profile('beta');
      final directory = _MemoryDirectoryStore(
        directory: const HostDirectory.empty().upsert(beta).upsert(alpha),
      );
      final credentials = _MemoryCredentialStore();
      final connector = _FakeConnector();
      final controller = _controller(directory, credentials, connector);
      addTearDown(controller.dispose);
      await controller.initialize();
      final first = connector.channels.single;
      first.emit(_welcome('host-alpha'));
      first.emit(_sessions('host-alpha'));
      await _flush();
      expect(controller.state.sessions, isNotEmpty);

      await controller.activateHost(beta.endpointKey);

      expect(
        controller.state.hostDirectory.activeEndpointKey,
        beta.endpointKey,
      );
      expect(controller.state.sessions, isEmpty);
      expect(controller.state.messages, isEmpty);
      expect(controller.state.selectedSessionId, isNull);
      expect(credentials.deleted, isEmpty);
      expect(connector.uris.last, beta.webSocketUrl);
    },
  );

  testWidgets('failed handshake close cannot stall automatic reconnect', (
    tester,
  ) async {
    final readyGate = Completer<void>();
    final connector = _FakeConnector(
      readyGate: readyGate,
      hangFirstClose: true,
    );
    final controller = _controller(
      _MemoryDirectoryStore(
        directory: const HostDirectory.empty().upsert(_profile('alpha')),
      ),
      _MemoryCredentialStore(),
      connector,
    );
    addTearDown(controller.dispose);
    final initialization = controller.initialize();
    await tester.pump();
    expect(connector.channels, hasLength(1));

    readyGate.completeError(StateError('server unavailable'));
    await initialization;
    expect(controller.state.connectionPhase, ConnectionPhase.retrying);
    await tester.pump(const Duration(milliseconds: 600));

    expect(connector.channels.length, greaterThan(1));
    await controller.disconnect();
    await tester.pump(const Duration(seconds: 1));
  });

  test('deliberate disconnect cancels an automatic reconnect', () async {
    final profile = _profile('alpha');
    final directory = _MemoryDirectoryStore(
      directory: const HostDirectory.empty().upsert(profile),
    );
    final connector = _FakeConnector();
    final controller = _controller(
      directory,
      _MemoryCredentialStore(),
      connector,
    );
    addTearDown(controller.dispose);
    await controller.initialize();
    final first = connector.channels.single;
    first.fail(StateError('network lost'));
    await _flush();
    expect(controller.state.connectionPhase, ConnectionPhase.retrying);

    await controller.disconnect();
    await Future<void>.delayed(const Duration(milliseconds: 600));

    expect(controller.state.connectionPhase, ConnectionPhase.disconnected);
    expect(connector.channels, hasLength(1));
    await controller.connect();
    expect(connector.channels, hasLength(2));
  });

  test('cancelling a pending host probe never saves it', () async {
    final readyGate = Completer<void>();
    final directory = _MemoryDirectoryStore();
    final connector = _FakeConnector(readyGate: readyGate);
    final controller = _controller(
      directory,
      _MemoryCredentialStore(),
      connector,
    );
    addTearDown(controller.dispose);
    await controller.initialize();

    final adding = controller.addHost('alpha.example.ts.net');
    await _until(() => connector.channels.isNotEmpty);
    expect(controller.state.hostOperationPending, isTrue);
    controller.cancelHostProbe();
    readyGate.complete();
    await adding;

    expect(controller.state.hostOperationPending, isFalse);
    expect(directory.saved, isEmpty);
    expect(directory.directory.profiles, isEmpty);
  });

  test('credential deletion failure rolls host metadata back', () async {
    final alpha = _profile('alpha');
    final beta = _profile('beta');
    final original = const HostDirectory.empty().upsert(beta).upsert(alpha);
    final events = <String>[];
    final directory = _MemoryDirectoryStore(
      directory: original,
      events: events,
    );
    final credentials = _MemoryCredentialStore(events: events)
      ..deleteError = StateError('vault unavailable');
    final connector = _FakeConnector();
    final controller = _controller(directory, credentials, connector);
    addTearDown(controller.dispose);
    await controller.initialize();

    await expectLater(
      controller.removeHost(beta.endpointKey),
      throwsA(isA<StateError>()),
    );

    expect(directory.saved, hasLength(2));
    expect(directory.saved.first.profiles, isNot(contains(beta)));
    expect(directory.saved.last.activeEndpointKey, original.activeEndpointKey);
    final firstSave = events.indexWhere((event) => event.startsWith('save:'));
    final deletion = events.indexOf('delete:${beta.endpointKey}');
    final rollbackSave = events.lastIndexWhere(
      (event) => event.startsWith('save:'),
    );
    expect(deletion, greaterThan(firstSave));
    expect(rollbackSave, greaterThan(deletion));
    expect(
      directory.directory.profiles.map((item) => item.endpointKey),
      original.profiles.map((item) => item.endpointKey),
    );
    expect(controller.state.hostDirectory.profiles, original.profiles);
    expect(controller.state.errorMessage, contains('host was restored'));
  });

  test(
    'pairing persists scoped credentials and reconnects authenticated',
    () async {
      final profile = _profile('alpha');
      final directory = _MemoryDirectoryStore(
        directory: const HostDirectory.empty().upsert(profile),
      );
      final credentials = _MemoryCredentialStore();
      final connector = _FakeConnector();
      final controller = _controller(directory, credentials, connector);
      addTearDown(controller.dispose);
      await controller.initialize();
      final first = connector.channels.single;
      first.emit(
        _welcome(
          'host-alpha',
          authentication: 'pairing-required',
          capabilities: const <String>[],
        ),
      );
      await _flush();

      await controller.pairHost('12345');
      expect(controller.state.errorMessage, contains('six-digit'));
      final sentBeforePair = first.sent.length;
      await controller.pairHost('123456');
      final pair = first.sentJson.last;
      expect(first.sent, hasLength(sentBeforePair + 1));
      expect(pair['type'], 'pair.start');
      expect(pair['code'], '123456');
      expect(pair['deviceId'], matches(RegExp(r'^[A-Za-z0-9_-]{32}$')));

      first.emit(<String, Object?>{
        'v': 'omp-app/1',
        'type': 'pair.ok',
        'requestId': pair['requestId'],
        'pairingId': 'pair-alpha',
        'deviceId': pair['deviceId'],
        'deviceName': pair['deviceName'],
        'platform': pair['platform'],
        'requestedCapabilities': pair['requestedCapabilities'],
        'grantedCapabilities': pair['requestedCapabilities'],
        'deviceToken': _token,
        'expiresAt': DateTime.now()
            .toUtc()
            .add(const Duration(hours: 1))
            .toIso8601String(),
      });
      await _until(() => connector.channels.length == 2);

      final saved = credentials.values[profile.endpointKey];
      expect(saved?.deviceId, pair['deviceId']);
      expect(saved?.deviceToken, _token);
      final authenticatedHello = connector.channels.last.sentJson.single;
      expect(authenticatedHello['authentication'], <String, Object?>{
        'deviceId': pair['deviceId'],
        'deviceToken': _token,
      });
    },
  );

  test(
    'stale credential read cannot connect the previous active host',
    () async {
      final alpha = _profile('alpha');
      final beta = _profile('beta');
      final directory = _MemoryDirectoryStore(
        directory: const HostDirectory.empty().upsert(beta).upsert(alpha),
      );
      final delayedRead = Completer<DeviceCredentials?>();
      final credentials = _MemoryCredentialStore()
        ..delayedReads[alpha.endpointKey] = delayedRead;
      final connector = _FakeConnector();
      final controller = _controller(directory, credentials, connector);
      addTearDown(controller.dispose);
      final initializing = controller.initialize();
      await _until(() => credentials.readProfiles.contains(alpha.endpointKey));

      await controller.activateHost(beta.endpointKey);
      delayedRead.complete(null);
      await initializing;
      await _flush();

      expect(connector.uris, <Uri>[beta.webSocketUrl]);
      expect(
        controller.state.hostDirectory.activeEndpointKey,
        beta.endpointKey,
      );
    },
  );
  test('uploads prompt images and reads transcript image chunks', () async {
    final profile = _profile('alpha');
    final directory = _MemoryDirectoryStore(
      directory: const HostDirectory.empty().upsert(profile),
    );
    final connector = _FakeConnector();
    final controller = _controller(
      directory,
      _MemoryCredentialStore(),
      connector,
    );
    addTearDown(controller.dispose);
    await controller.initialize();
    final channel = connector.channels.single;

    channel.emit(
      _welcome(
        'host-alpha',
        capabilities: const <String>[
          'sessions.read',
          'sessions.prompt',
          'sessions.control',
          'sessions.manage',
        ],
      ),
    );
    await _flush();
    final list = channel.sentJson.last;
    channel.emit(
      _response(
        list,
        command: 'session.list',
        result: _sessionListResultFor('host-alpha', const <String>[
          'session-alpha',
        ]),
      ),
    );
    await _flush();
    channel.emit(
      _snapshot(
        'host-alpha',
        'session-alpha',
        revision: 'revision-session-alpha-2',
      ),
    );
    await _flush();
    expect(controller.state.connectionPhase, ConnectionPhase.ready);

    final sending = controller.submitPrompt(
      'Inspect this image',
      images: <PromptImageAttachment>[
        PromptImageAttachment(
          id: 'local-image',
          name: 'fixture.png',
          mimeType: 'image/png',
          bytes: Uint8List.fromList(<int>[1, 2, 3]),
        ),
      ],
    );
    await _flush();
    final begin = channel.sentJson.last;
    expect(begin['command'], 'session.image.begin');
    expect(begin['args'], <String, Object?>{
      'mimeType': 'image/png',
      'size': 3,
      'sha256': isA<String>(),
    });
    channel.emit(
      _response(
        begin,
        command: 'session.image.begin',
        result: <String, Object?>{
          'imageId': 'uploaded-image',
          'chunkBytes': 2,
          'expiresAt': '2030-01-01T00:00:00.000Z',
        },
      ),
    );
    await _flush();

    final firstChunk = channel.sentJson.last;
    expect(firstChunk['command'], 'session.image.chunk');
    expect(firstChunk['args'], <String, Object?>{
      'imageId': 'uploaded-image',
      'offset': 0,
      'content': 'AQI=',
    });
    channel.emit(
      _response(
        firstChunk,
        command: 'session.image.chunk',
        result: <String, Object?>{
          'imageId': 'uploaded-image',
          'received': 2,
          'complete': false,
        },
      ),
    );
    await _flush();

    final finalChunk = channel.sentJson.last;
    expect(finalChunk['command'], 'session.image.chunk');
    expect(finalChunk['args'], <String, Object?>{
      'imageId': 'uploaded-image',
      'offset': 2,
      'content': 'Aw==',
    });
    channel.emit(
      _response(
        finalChunk,
        command: 'session.image.chunk',
        result: <String, Object?>{
          'imageId': 'uploaded-image',
          'received': 3,
          'complete': true,
        },
      ),
    );
    await _flush();

    final prompt = channel.sentJson.last;
    expect(prompt['command'], 'session.prompt');
    expect(prompt['expectedRevision'], 'revision-session-alpha-2');
    expect(prompt['args'], <String, Object?>{
      'message': 'Inspect this image',
      'images': <Object?>[
        <String, Object?>{'imageId': 'uploaded-image'},
      ],
    });
    channel.emit(
      _response(
        prompt,
        command: 'session.prompt',
        result: <String, Object?>{'accepted': true},
      ),
    );
    expect(await sending, isTrue);

    const contentSha256 =
        '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81';
    final reading = controller.readTranscriptImage(
      'entry-image',
      TranscriptImageMetadata(sha256: contentSha256, mimeType: 'image/png'),
    );
    await _flush();
    final firstRead = channel.sentJson.last;
    expect(firstRead['command'], 'session.image.read');
    expect(firstRead['args'], <String, Object?>{
      'entryId': 'entry-image',
      'sha256': contentSha256,
      'offset': 0,
    });
    channel.emit(
      _response(
        firstRead,
        command: 'session.image.read',
        result: <String, Object?>{
          'sha256': contentSha256,
          'mimeType': 'image/png',
          'size': 3,
          'offset': 0,
          'nextOffset': 2,
          'complete': false,
          'content': 'AQI=',
        },
      ),
    );
    await _flush();
    final finalRead = channel.sentJson.last;
    expect(finalRead['args'], <String, Object?>{
      'entryId': 'entry-image',
      'sha256': contentSha256,
      'offset': 2,
    });
    channel.emit(
      _response(
        finalRead,
        command: 'session.image.read',
        result: <String, Object?>{
          'sha256': contentSha256,
          'mimeType': 'image/png',
          'size': 3,
          'offset': 2,
          'nextOffset': 3,
          'complete': true,
          'content': 'Aw==',
        },
      ),
    );
    expect(await reading, <int>[1, 2, 3]);

    final queueing = controller.queuePrompt('Follow up later');
    await _flush();
    final followUp = channel.sentJson.last;
    expect(followUp['command'], 'session.followUp');
    expect(followUp['args'], <String, Object?>{'message': 'Follow up later'});
    channel.emit(
      _response(
        followUp,
        command: 'session.followUp',
        result: <String, Object?>{'accepted': true},
      ),
    );
    expect(await queueing, isTrue);

    final settingModel = controller.setSessionModel('fixture/model-pro');
    await _flush();
    final model = channel.sentJson.last;
    expect(model['command'], 'session.model.set');
    expect(model['args'], <String, Object?>{
      'selector': 'fixture/model-pro',
      'persistence': 'session',
    });
    channel.emit(
      _response(
        model,
        command: 'session.model.set',
        result: <String, Object?>{'updated': true},
      ),
    );
    await settingModel;

    final settingThinking = controller.setSessionThinking('high');
    await _flush();
    final thinking = channel.sentJson.last;
    expect(thinking['command'], 'session.thinking.set');
    expect(thinking['args'], <String, Object?>{'level': 'high'});
    channel.emit(
      _response(
        thinking,
        command: 'session.thinking.set',
        result: <String, Object?>{'updated': true},
      ),
    );
    await settingThinking;

    final settingFast = controller.setSessionFast(true);
    await _flush();
    final fast = channel.sentJson.last;
    expect(fast['command'], 'session.fast.set');
    expect(fast['args'], <String, Object?>{'enabled': true});
    channel.emit(
      _response(
        fast,
        command: 'session.fast.set',
        result: <String, Object?>{'updated': true},
      ),
    );
    await settingFast;
  });

  test(
    'creates and manages sessions through index deltas and confirmations',
    () async {
      final profile = _profile('alpha');
      final directory = _MemoryDirectoryStore(
        directory: const HostDirectory.empty().upsert(profile),
      );
      final connector = _FakeConnector();
      final controller = _controller(
        directory,
        _MemoryCredentialStore(),
        connector,
      );
      addTearDown(controller.dispose);
      await controller.initialize();
      final channel = connector.channels.single;

      channel.emit(
        _welcome(
          'host-alpha',
          capabilities: const <String>[
            'sessions.read',
            'sessions.control',
            'sessions.manage',
          ],
          features: const <String>['host.watch'],
        ),
      );
      await _flush();
      final list = channel.sentJson.last;
      channel.emit(
        _response(
          list,
          command: 'session.list',
          result: _sessionListResultFor('host-alpha', const <String>[
            'session-alpha',
            'session-beta',
          ]),
        ),
      );
      await _flush();
      channel.emit(
        _snapshot(
          'host-alpha',
          'session-alpha',
          revision: 'revision-session-alpha-2',
        ),
      );
      await _flush();
      expect(controller.state.connectionPhase, ConnectionPhase.ready);
      expect(controller.state.sessions.first.projectName, 'Project Alpha');

      final creating = controller.createSession(
        'project-session-alpha',
        title: 'New investigation',
      );
      await _flush();
      final create = channel.sentJson.last;
      expect(create['command'], 'session.create');
      expect(create['args'], <String, Object?>{
        'projectId': 'project-session-alpha',
        'title': 'New investigation',
      });
      final createdRef = _sessionRef(
        'host-alpha',
        'session-created',
        projectId: 'project-session-alpha',
        projectName: 'Project Alpha',
        revision: 'revision-created',
        title: 'New investigation',
      );
      channel.emit(
        _sessionDelta(
          'host-alpha',
          'session-created',
          revision: 'revision-created',
          upsert: createdRef,
          seq: 2,
        ),
      );
      channel.emit(
        _response(
          create,
          command: 'session.create',
          result: <String, Object?>{'session': createdRef},
        ),
      );
      await creating;
      expect(controller.state.selectedSessionId, 'session-created');
      expect(controller.state.selectedSession?.title, 'New investigation');
      expect(channel.sentJson.last, containsPair('command', 'session.attach'));
      channel.emit(
        _snapshot(
          'host-alpha',
          'session-created',
          revision: 'revision-created-2',
        ),
      );
      await _flush();

      final renaming = controller.renameSession(
        'session-created',
        'Renamed investigation',
      );
      await _flush();
      final rename = channel.sentJson.last;
      expect(rename['command'], 'session.rename');
      expect(rename['expectedRevision'], 'revision-created-2');
      final renamedRef = _sessionRef(
        'host-alpha',
        'session-created',
        projectId: 'project-session-alpha',
        projectName: 'Project Alpha',
        revision: 'revision-created-3',
        title: 'Renamed investigation',
      );
      channel.emit(
        _sessionDelta(
          'host-alpha',
          'session-created',
          revision: 'revision-created-3',
          upsert: renamedRef,
          seq: 3,
        ),
      );
      channel.emit(
        _response(
          rename,
          command: 'session.rename',
          result: <String, Object?>{'renamed': true},
        ),
      );
      await renaming;
      expect(controller.state.selectedSession?.title, 'Renamed investigation');

      final archiving = controller.archiveSession('session-created');
      await _flush();
      final archive = channel.sentJson.last;
      final archivedRef = <String, Object?>{
        ...renamedRef,
        'revision': 'revision-created-4',
        'archivedAt': '2026-07-19T01:00:00.000Z',
      };
      channel.emit(
        _sessionDelta(
          'host-alpha',
          'session-created',
          revision: 'revision-created-4',
          upsert: archivedRef,
          seq: 4,
        ),
      );
      channel.emit(
        _response(
          archive,
          command: 'session.archive',
          result: <String, Object?>{'archived': true},
        ),
      );
      await archiving;
      expect(
        controller.state.sessions
            .singleWhere((session) => session.sessionId == 'session-created')
            .archived,
        isTrue,
      );
      expect(controller.state.selectedSessionId, isNot('session-created'));
      channel.emit(
        _snapshot(
          'host-alpha',
          controller.state.selectedSessionId!,
          revision: 'revision-replacement',
        ),
      );
      await _flush();

      final restoring = controller.restoreSession('session-created');
      await _flush();
      final restore = channel.sentJson.last;
      final restoredRef = <String, Object?>{
        ...renamedRef,
        'revision': 'revision-created-5',
      };
      channel.emit(
        _sessionDelta(
          'host-alpha',
          'session-created',
          revision: 'revision-created-5',
          upsert: restoredRef,
          seq: 5,
        ),
      );
      channel.emit(
        _response(
          restore,
          command: 'session.restore',
          result: <String, Object?>{'restored': true},
        ),
      );
      await restoring;

      final terminating = controller.terminateSession('session-created');
      await _flush();
      final terminate = channel.sentJson.last;
      expect(terminate['command'], 'session.close');
      channel.emit(_confirmation(terminate, 'confirmation-close'));
      await _flush();
      final closeConfirmation = channel.sentJson.last;
      expect(closeConfirmation, containsPair('type', 'confirm'));
      expect(closeConfirmation, containsPair('decision', 'approve'));
      final closedRef = <String, Object?>{
        ...restoredRef,
        'revision': 'revision-created-6',
        'status': 'closed',
      };
      channel.emit(
        _sessionDelta(
          'host-alpha',
          'session-created',
          revision: 'revision-created-6',
          upsert: closedRef,
          seq: 6,
        ),
      );
      channel.emit(
        _response(
          terminate,
          command: 'session.close',
          result: <String, Object?>{
            'closed': true,
            'sessionId': 'session-created',
          },
        ),
      );
      await terminating;

      final deleting = controller.deleteSession('session-created');
      await _flush();
      final delete = channel.sentJson.last;
      expect(delete['command'], 'session.delete');
      channel.emit(_confirmation(delete, 'confirmation-delete'));
      await _flush();
      channel.emit(
        _sessionDelta(
          'host-alpha',
          'session-created',
          revision: 'revision-created-7',
          remove: 'session-created',
          seq: 7,
        ),
      );
      channel.emit(
        _response(
          delete,
          command: 'session.delete',
          result: <String, Object?>{'deleted': true},
        ),
      );
      await deleting;
      expect(
        controller.state.sessions.any(
          (session) => session.sessionId == 'session-created',
        ),
        isFalse,
      );
      expect(controller.state.sessionOperationPending, isFalse);
    },
  );

  test('projects attention, responds, retries, and tracks agents', () async {
    final profile = _profile('alpha');
    final directory = _MemoryDirectoryStore(
      directory: const HostDirectory.empty().upsert(profile),
    );
    final connector = _FakeConnector();
    final controller = _controller(
      directory,
      _MemoryCredentialStore(),
      connector,
    );
    addTearDown(controller.dispose);
    await controller.initialize();
    final channel = connector.channels.single;

    channel.emit(
      _welcome(
        'host-alpha',
        capabilities: const <String>[
          'sessions.read',
          'sessions.prompt',
          'sessions.control',
        ],
        features: const <String>['prompt.lease'],
      ),
    );
    await _flush();
    final list = channel.sentJson.last;
    channel.emit(
      _response(
        list,
        command: 'session.list',
        result: _sessionListResultFor(
          'host-alpha',
          const <String>['session-alpha'],
          attention: <String, Object?>{
            'pending': <Object?>[
              <String, Object?>{
                'kind': 'question',
                'id': 'question-1',
                'question': 'Which environment?',
                'options': <Object?>[
                  <String, Object?>{'id': 'staging', 'label': 'Staging'},
                  <String, Object?>{'id': 'production', 'label': 'Production'},
                ],
                'allowText': true,
                'requestedAt': '2026-07-19T00:00:00.000Z',
              },
            ],
            'pendingCount': 1,
            'truncated': false,
            'latestOutcome': <String, Object?>{
              'id': 'outcome-1',
              'kind': 'failed',
              'at': '2026-07-19T00:01:00.000Z',
              'summary': 'The last turn failed.',
            },
          },
        ),
      ),
    );
    await _flush();
    channel.emit(
      _snapshot(
        'host-alpha',
        'session-alpha',
        revision: 'revision-session-alpha',
      ),
    );
    await _flush();

    expect(controller.state.urgentAttentionCount, 1);
    expect(controller.state.attentionItems, hasLength(2));
    final question = controller.state.attentionItems.firstWhere(
      (item) => item.kind == AttentionKind.question,
    );
    expect(question.choices.map((choice) => choice.id), <String>[
      'staging',
      'production',
    ]);

    final responding = controller.respondToAttention(
      question,
      const AttentionResponse(
        decision: AttentionDecision.approve,
        optionIds: <String>['staging'],
      ),
    );
    await _flush();
    final acquisition = channel.sentJson.last;
    expect(acquisition['command'], 'prompt.lease.acquire');
    expect(acquisition['args'], <String, Object?>{
      'ownerId': 't4-code-flutter',
    });
    channel.emit(
      _response(
        acquisition,
        command: 'prompt.lease.acquire',
        result: <String, Object?>{
          'accepted': true,
          'leaseId': 'prompt-lease-1',
          'expiresAt': '2030-01-01T00:00:00.000Z',
        },
      ),
    );
    await _flush();
    final responseCommand = channel.sentJson.last;
    expect(responseCommand['command'], 'session.ui.respond');
    expect(responseCommand['expectedRevision'], 'revision-session-alpha');
    expect(responseCommand['args'], <String, Object?>{
      'requestId': 'question-1',
      'value': 'staging',
      'leaseId': 'prompt-lease-1',
    });
    channel.emit(
      _response(
        responseCommand,
        command: 'session.ui.respond',
        result: <String, Object?>{'accepted': true},
      ),
    );
    expect(await responding, isTrue);

    final retrying = controller.retrySession('session-alpha');
    await _flush();
    final retry = channel.sentJson.last;
    expect(retry['command'], 'session.retry');
    channel.emit(
      _response(
        retry,
        command: 'session.retry',
        result: <String, Object?>{'retried': true},
      ),
    );
    await retrying;

    channel.emit(<String, Object?>{
      'v': 'omp-app/1',
      'type': 'agent.progress',
      'hostId': 'host-alpha',
      'sessionId': 'session-alpha',
      'agentId': 'agent-1',
      'cursor': <String, Object?>{'epoch': 'agent', 'seq': 1},
      'revision': 'revision-session-alpha',
      'progress': 0.5,
      'detail': <String, Object?>{'title': 'Reviewing changes'},
    });
    await _flush();
    expect(controller.state.agentActivities.single.label, 'Reviewing changes');
    expect(controller.state.agentActivities.single.progress, 0.5);

    channel.emit(
      _confirmation(<String, Object?>{
        'commandId': 'remote-command',
        'hostId': 'host-alpha',
        'sessionId': 'session-alpha',
        'expectedRevision': 'revision-session-alpha',
        'command': 'files.write',
      }, 'confirmation-remote'),
    );
    await _flush();
    final confirmation = controller.state.attentionItems.firstWhere(
      (item) => item.kind == AttentionKind.confirmation,
    );
    expect(controller.state.urgentAttentionCount, 2);
    expect(
      await controller.respondToAttention(
        confirmation,
        const AttentionResponse(decision: AttentionDecision.deny),
      ),
      isTrue,
    );
    expect(channel.sentJson.last, containsPair('type', 'confirm'));
    expect(channel.sentJson.last, containsPair('decision', 'deny'));
  });

  test(
    'projects terminal, files, audit, and preview developer state',
    () async {
      final profile = _profile('alpha');
      final connector = _FakeConnector();
      final controller = _controller(
        _MemoryDirectoryStore(
          directory: const HostDirectory.empty().upsert(profile),
        ),
        _MemoryCredentialStore(),
        connector,
      );
      addTearDown(controller.dispose);
      await controller.initialize();
      final channel = connector.channels.single;
      channel.emit(
        _welcome('host-alpha', capabilities: t4RequestedCapabilities),
      );
      await _flush();
      final list = channel.sentJson.last;
      channel.emit(
        _response(
          list,
          command: 'session.list',
          result: _sessionListResultFor('host-alpha', const <String>[
            'session-alpha',
          ]),
        ),
      );
      await _flush();
      channel.emit(
        _snapshot(
          'host-alpha',
          'session-alpha',
          revision: 'revision-session-alpha',
        ),
      );
      await _flush();

      final opening = controller.openTerminal(cwd: 'packages/client');
      await _flush();
      final open = channel.sentJson.last;
      expect(open['command'], 'term.open');
      expect(open['args'], containsPair('cwd', 'packages/client'));
      channel.emit(_confirmation(open, 'confirmation-terminal'));
      await _flush();
      expect(channel.sentJson.last, containsPair('decision', 'approve'));
      channel.emit(
        _response(
          open,
          command: 'term.open',
          result: <String, Object?>{'terminalId': 'terminal-alpha'},
        ),
      );
      expect(await opening, 'terminal-alpha');
      channel.emit(<String, Object?>{
        'v': 'omp-app/1',
        'type': 'terminal.output',
        'hostId': 'host-alpha',
        'sessionId': 'session-alpha',
        'terminalId': 'terminal-alpha',
        'cursor': <String, Object?>{'epoch': 'terminal', 'seq': 1},
        'stream': 'stdout',
        'data': r'$ ready',
      });
      await _flush();
      expect(controller.state.activeTerminal?.output, r'$ ready');
      controller.sendTerminalInput('terminal-alpha', 'pwd\n');
      expect(channel.sentJson.last, containsPair('type', 'terminal.input'));
      expect(channel.sentJson.last, containsPair('data', 'pwd\n'));
      controller.resizeTerminal('terminal-alpha', 120, 40);
      expect(channel.sentJson.last, containsPair('type', 'terminal.resize'));
      expect(channel.sentJson.last, containsPair('cols', 120));
      channel.emit(<String, Object?>{
        'v': 'omp-app/1',
        'type': 'terminal.exit',
        'hostId': 'host-alpha',
        'sessionId': 'session-alpha',
        'terminalId': 'terminal-alpha',
        'cursor': <String, Object?>{'epoch': 'terminal', 'seq': 2},
        'exitCode': 0,
      });
      await _flush();
      expect(controller.state.activeTerminal?.running, isFalse);
      controller.closeTerminal('terminal-alpha');
      expect(channel.sentJson.last, containsPair('type', 'terminal.close'));
      expect(controller.state.activeTerminal, isNull);

      final listing = controller.listFiles();
      await _flush();
      final filesCommand = channel.sentJson.last;
      expect(filesCommand['command'], 'files.list');
      channel.emit(
        _response(
          filesCommand,
          command: 'files.list',
          result: <String, Object?>{
            'entries': <Object?>[
              <String, Object?>{
                'path': 'lib/main.dart',
                'kind': 'file',
                'size': 42,
                'revision': 'revision-file',
              },
            ],
            'revision': 'revision-files',
          },
        ),
      );
      await listing;
      expect(
        controller.state.fileWorkspace.entries.single.path,
        'lib/main.dart',
      );

      final refreshing = controller.refreshActivity();
      await _flush();
      final auditCommand = channel.sentJson.last;
      expect(auditCommand['command'], 'audit.read');
      channel.emit(
        _response(
          auditCommand,
          command: 'audit.read',
          result: <String, Object?>{
            'events': <Object?>[
              <String, Object?>{
                'eventId': 'operation-audit-1',
                'hostId': 'host-alpha',
                'sessionId': 'session-alpha',
                'action': 'files.read',
                'actor': 'fixture',
                'timestamp': '2026-07-19T00:00:00.000Z',
                'detail': <String, Object?>{'token': 'must-not-render'},
              },
            ],
          },
        ),
      );
      await refreshing;
      final audit = controller.state.activities.firstWhere(
        (activity) => activity.id == 'operation-audit-1',
      );
      expect(audit.raw, contains('<redacted>'));
      expect(audit.raw, isNot(contains('must-not-render')));

      final launching = controller.launchPreview('https://example.test');
      await _flush();
      final launch = channel.sentJson.last;
      expect(launch['command'], 'preview.launch');
      channel.emit(_confirmation(launch, 'confirmation-preview'));
      await _flush();
      channel.emit(
        _response(
          launch,
          command: 'preview.launch',
          result: <String, Object?>{
            'preview': <String, Object?>{
              'previewId': 'preview-alpha',
              'state': 'ready',
              'url': 'https://example.test/',
              'revision': 'revision-preview',
              'cursor': <String, Object?>{'epoch': 'preview', 'seq': 1},
              'title': 'Fixture preview',
              'canGoBack': false,
              'canGoForward': false,
            },
          },
        ),
      );
      expect(await launching, 'preview-alpha');
      expect(controller.state.activePreview?.title, 'Fixture preview');
      expect(controller.state.developerOperationPending, isFalse);
    },
  );

  test('IO transport sends the exact native Origin', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final origin = Completer<String?>();
    final accepted = Completer<WebSocket>();
    server.listen((request) async {
      if (!origin.isCompleted) {
        origin.complete(request.headers.value('origin'));
      }
      final socket = await WebSocketTransformer.upgrade(request);
      accepted.complete(socket);
    });
    addTearDown(() async {
      if (accepted.isCompleted) (await accepted.future).close();
      await server.close(force: true);
    });

    final channel = await connectPlatformWebSocket(
      Uri.parse('ws://127.0.0.1:${server.port}/v1/ws'),
    );
    await channel.ready;
    expect(await origin.future, 'https://localhost');
    await channel.sink.close();
  });
  test('loads and saves the injected theme preference', () async {
    final preferences = InMemoryAppPreferenceStore(themePreference: 'dark');
    final controller = T4ClientController(
      hostDirectoryStore: _MemoryDirectoryStore(),
      hostCredentialStore: _MemoryCredentialStore(),
      appPreferenceStore: preferences,
      webSocketConnector: _FakeConnector().call,
    );
    addTearDown(controller.dispose);

    await controller.initialize();
    expect(controller.state.themePreference, T4ThemePreference.dark);

    await controller.setThemePreference(T4ThemePreference.light);
    expect(controller.state.themePreference, T4ThemePreference.light);
    expect(preferences.themePreference, 'light');
  });

  test(
    'projects live settings defensively and explicitly confirms exact writes',
    () async {
      final profile = _profile('settings');
      final connector = _FakeConnector();
      final controller = _controller(
        _MemoryDirectoryStore(
          directory: const HostDirectory.empty().upsert(profile),
        ),
        _MemoryCredentialStore(),
        connector,
      );
      addTearDown(controller.dispose);
      await controller.initialize();
      final channel = connector.channels.single;
      channel.emit(
        _welcome(
          'host-settings',
          capabilities: const <String>[
            'sessions.read',
            'catalog.read',
            'config.read',
            'config.write',
          ],
          features: const <String>['catalog.metadata', 'settings.metadata'],
        ),
      );
      await _flush();
      expect(
        channel.sentJson.map((frame) => frame['command']),
        containsAll(<String>['catalog.get', 'settings.read']),
      );
      channel.emit(<String, Object?>{
        'v': 'omp-app/1',
        'type': 'sessions',
        'hostId': 'host-settings',
        ..._sessionListResultFor('host-settings', const <String>[]),
      });
      channel.emit(_settingsCatalog());
      channel.emit(_settingsValues());
      await _flush();

      final compact = controller.state.settings.entries.singleWhere(
        (entry) => entry.path == 'appearance.compact',
      );
      expect(compact.control, HostSettingControlKind.boolean);
      expect(compact.effectiveValue, false);
      final secret = controller.state.settings.entries.singleWhere(
        (entry) => entry.path == 'provider.token',
      );
      expect(secret.sensitive, isTrue);
      expect(secret.configured, isTrue);
      expect(secret.effectiveValue, isNull);
      expect(secret.control, HostSettingControlKind.unsupported);
      expect(
        controller.state.settings.issues,
        contains('provider.token: sensitive setting arrived with a value'),
      );
      expect(
        controller.state.settings.entries
            .singleWhere((entry) => entry.path == 'future.setting')
            .control,
        HostSettingControlKind.unsupported,
      );

      final write = controller.writeSetting(
        'appearance.compact',
        'global',
        value: true,
      );
      await _flush();
      final writeFrame = channel.sentJson.lastWhere(
        (frame) => frame['command'] == 'settings.write',
      );
      expect(writeFrame['expectedRevision'], 'settings-rev-1');
      expect(writeFrame.containsKey('sessionId'), isFalse);
      expect(writeFrame['args'], <String, Object?>{
        'edits': <Object?>[
          <String, Object?>{
            'path': 'appearance.compact',
            'scope': 'global',
            'value': true,
          },
        ],
        'expectedRevision': 'settings-rev-1',
      });

      channel.emit(_confirmation(writeFrame, 'confirm-settings'));
      await _flush();
      expect(
        channel.sentJson.where((frame) => frame['type'] == 'confirm'),
        isEmpty,
      );
      final confirmation = controller.state.attentionItems.singleWhere(
        (item) => item.confirmationId == 'confirm-settings',
      );
      expect(confirmation.sessionId, isEmpty);
      await controller.respondToAttention(
        confirmation,
        const AttentionResponse(decision: AttentionDecision.approve),
      );
      final confirmFrame = channel.sentJson.last;
      expect(confirmFrame['type'], 'confirm');
      expect(confirmFrame.containsKey('sessionId'), isFalse);
      expect(confirmFrame['decision'], 'approve');

      channel.emit(
        _response(
          writeFrame,
          command: 'settings.write',
          result: const <String, Object?>{
            'accepted': true,
            'revision': 'settings-rev-2',
          },
        ),
      );
      await _flush();
      expect(
        channel.sentJson
            .where(
              (frame) =>
                  frame['command'] == 'catalog.get' ||
                  frame['command'] == 'settings.read',
            )
            .length,
        4,
      );
      channel.emit(_settingsCatalog(revision: 'catalog-rev-2'));
      channel.emit(_settingsValues(revision: 'settings-rev-2'));
      await write;
      expect(controller.state.settings.revision, 'settings-rev-2');
      expect(controller.state.settingsOperationPending, isFalse);

      final conflict = controller.writeSetting(
        'appearance.compact',
        'global',
        value: false,
      );
      await _flush();
      final conflictFrame = channel.sentJson.lastWhere(
        (frame) => frame['command'] == 'settings.write',
      );
      channel.emit(<String, Object?>{
        'v': 'omp-app/1',
        'type': 'response',
        'requestId': conflictFrame['requestId'],
        'commandId': conflictFrame['commandId'],
        'hostId': 'host-settings',
        'command': 'settings.write',
        'ok': false,
        'error': <String, Object?>{
          'code': 'revision_conflict',
          'message': 'settings changed on the host',
        },
      });
      await expectLater(conflict, throwsStateError);
      expect(
        controller.state.settings.error,
        contains('settings changed on the host'),
      );

      final reset = controller.writeSetting(
        'appearance.compact',
        'session',
        reset: true,
      );
      await _flush();
      final resetFrame = channel.sentJson.lastWhere(
        (frame) => frame['command'] == 'settings.write',
      );
      expect(resetFrame['args'], <String, Object?>{
        'edits': <Object?>[
          <String, Object?>{
            'path': 'appearance.compact',
            'scope': 'session',
            'reset': true,
          },
        ],
        'expectedRevision': 'settings-rev-2',
      });
      channel.emit(<String, Object?>{
        'v': 'omp-app/1',
        'type': 'response',
        'requestId': resetFrame['requestId'],
        'commandId': resetFrame['commandId'],
        'hostId': 'host-settings',
        'command': 'settings.write',
        'ok': false,
        'error': <String, Object?>{'code': 'denied', 'message': 'reset denied'},
      });
      await expectLater(reset, throwsStateError);
    },
  );

  test('settings writes require granted permission', () async {
    final profile = _profile('readonly');
    final connector = _FakeConnector();
    final controller = _controller(
      _MemoryDirectoryStore(
        directory: const HostDirectory.empty().upsert(profile),
      ),
      _MemoryCredentialStore(),
      connector,
    );
    addTearDown(controller.dispose);
    await controller.initialize();
    final channel = connector.channels.single;
    channel.emit(
      _welcome(
        'host-readonly',
        capabilities: const <String>[
          'sessions.read',
          'catalog.read',
          'config.read',
        ],
        features: const <String>['catalog.metadata', 'settings.metadata'],
      ),
    );
    channel.emit(<String, Object?>{
      'v': 'omp-app/1',
      'type': 'sessions',
      'hostId': 'host-readonly',
      ..._sessionListResultFor('host-readonly', const <String>[]),
    });
    channel.emit(_settingsCatalog(hostId: 'host-readonly'));
    channel.emit(_settingsValues(hostId: 'host-readonly'));
    await _flush();

    await expectLater(
      controller.writeSetting('appearance.compact', 'global', value: true),
      throwsStateError,
    );
  });

  testWidgets('settings refresh settles with a bounded timeout', (
    tester,
  ) async {
    final profile = _profile('refresh-timeout');
    final connector = _FakeConnector();
    final controller = _controller(
      _MemoryDirectoryStore(
        directory: const HostDirectory.empty().upsert(profile),
      ),
      _MemoryCredentialStore(),
      connector,
    );
    addTearDown(controller.dispose);
    await controller.initialize();
    final channel = connector.channels.single;
    channel.emit(
      _welcome(
        'host-timeout',
        capabilities: const <String>[
          'sessions.read',
          'catalog.read',
          'config.read',
        ],
        features: const <String>['catalog.metadata', 'settings.metadata'],
      ),
    );
    channel.emit(<String, Object?>{
      'v': 'omp-app/1',
      'type': 'sessions',
      'hostId': 'host-timeout',
      ..._sessionListResultFor('host-timeout', const <String>[]),
    });
    channel.emit(_settingsCatalog(hostId: 'host-timeout'));
    channel.emit(_settingsValues(hostId: 'host-timeout'));
    await tester.pump();
    expect(controller.state.settings.loading, isFalse);

    final expectation = expectLater(
      controller.refreshSettings(),
      throwsA(isA<TimeoutException>()),
    );
    expect(controller.state.settings.loading, isTrue);
    await tester.pump(const Duration(seconds: 11));
    await expectation;
    expect(controller.state.settings.loading, isFalse);
    expect(controller.state.settings.error, contains('timed out'));
  });

  test('background resume reuses the loaded settings projection', () async {
    final profile = _profile('settings-resume');
    final connector = _FakeConnector();
    final controller = _controller(
      _MemoryDirectoryStore(
        directory: const HostDirectory.empty().upsert(profile),
      ),
      _MemoryCredentialStore(),
      connector,
    );
    addTearDown(controller.dispose);
    await controller.initialize();
    final initialChannel = connector.channels.single;
    const capabilities = <String>[
      'sessions.read',
      'catalog.read',
      'config.read',
    ];
    const features = <String>['catalog.metadata', 'settings.metadata'];
    initialChannel.emit(
      _welcome(
        'host-settings-resume',
        capabilities: capabilities,
        features: features,
      ),
    );
    await _flush();
    initialChannel.emit(<String, Object?>{
      'v': 'omp-app/1',
      'type': 'sessions',
      'hostId': 'host-settings-resume',
      ..._sessionListResultFor('host-settings-resume', const <String>[]),
    });
    initialChannel.emit(_settingsCatalog(hostId: 'host-settings-resume'));
    initialChannel.emit(_settingsValues(hostId: 'host-settings-resume'));
    await _flush();
    expect(controller.state.settings.entries, isNotEmpty);
    expect(controller.state.settings.loading, isFalse);

    await controller.handleLifecyclePhase(T4LifecyclePhase.background);
    await controller.handleLifecyclePhase(T4LifecyclePhase.resumed);
    final resumedChannel = connector.channels.last;
    resumedChannel.emit(
      _welcome(
        'host-settings-resume',
        capabilities: capabilities,
        features: features,
      ),
    );
    await _flush();

    expect(
      resumedChannel.sentJson.where(
        (frame) =>
            frame['command'] == 'catalog.get' ||
            frame['command'] == 'settings.read',
      ),
      isEmpty,
    );
    expect(controller.state.settings.loading, isFalse);
  });

  test(
    'background resume reconnects once but deliberate disconnect stays closed',
    () async {
      final profile = _profile('lifecycle');
      final connector = _FakeConnector();
      final controller = _controller(
        _MemoryDirectoryStore(
          directory: const HostDirectory.empty().upsert(profile),
        ),
        _MemoryCredentialStore(),
        connector,
      );
      addTearDown(controller.dispose);
      await controller.initialize();
      expect(connector.channels, hasLength(1));

      await controller.handleLifecyclePhase(T4LifecyclePhase.background);
      expect(controller.state.lifecyclePhase, T4LifecyclePhase.background);
      expect(controller.state.connectionPhase, ConnectionPhase.disconnected);
      await controller.handleLifecyclePhase(T4LifecyclePhase.resumed);
      expect(connector.channels, hasLength(2));
      await controller.handleLifecyclePhase(T4LifecyclePhase.resumed);
      expect(connector.channels, hasLength(2));

      await controller.handleLifecyclePhase(T4LifecyclePhase.background);
      await controller.disconnect();
      await controller.handleLifecyclePhase(T4LifecyclePhase.resumed);
      expect(connector.channels, hasLength(2));
      expect(
        controller.state.hostDirectory.activeEndpointKey,
        profile.endpointKey,
      );
    },
  );
  test(
    'thinking menu exposes advertised levels and keeps a valid current value',
    () async {
      final profile = _profile('alpha');
      final directory = _MemoryDirectoryStore(
        directory: const HostDirectory.empty().upsert(profile),
      );
      final connector = _FakeConnector();
      final controller = _controller(
        directory,
        _MemoryCredentialStore(),
        connector,
      );
      addTearDown(controller.dispose);
      await controller.initialize();
      final channel = connector.channels.single;
      channel.emit(
        _welcome('host-alpha', capabilities: t4RequestedCapabilities),
      );
      await _flush();

      Map<String, Object?> sessionFrame({
        required String? thinking,
        required bool? thinkingSupported,
        required List<String> thinkingLevels,
      }) => <String, Object?>{
        'v': 'omp-app/1',
        'type': 'sessions',
        'hostId': 'host-alpha',
        'cursor': <String, Object?>{'epoch': 'index', 'seq': 1},
        'sessions': <Object?>[
          <String, Object?>{
            'hostId': 'host-alpha',
            'sessionId': 'session-alpha',
            'project': <String, Object?>{
              'projectId': 'project-alpha',
              'name': 'Project Alpha',
            },
            'revision': 'revision-alpha',
            'title': 'session-alpha title',
            'status': 'idle',
            'updatedAt': '2026-07-19T00:00:00.000Z',
            'liveState': <String, Object?>{
              'thinking': ?thinking,
              'thinkingSupported': ?thinkingSupported,
              if (thinkingLevels.isNotEmpty) 'thinkingLevels': thinkingLevels,
            },
          },
        ],
        'totalCount': 1,
        'truncated': false,
      };

      // Model advertises off/low/medium/high/auto; current value is high.
      channel.emit(
        sessionFrame(
          thinking: 'high',
          thinkingSupported: true,
          thinkingLevels: const <String>['low', 'medium', 'high'],
        ),
      );
      await _flush();
      await controller.selectSession('session-alpha');
      await _flush();
      channel.emit(
        _snapshot('host-alpha', 'session-alpha', revision: 'revision-alpha'),
      );
      await _flush();

      var composer = controller.state.composer;
      expect(composer.thinking, 'high');
      expect(composer.thinkingLevels, <String>[
        'off',
        'auto',
        'low',
        'medium',
        'high',
      ]);

      // Capability refresh arrives without concrete efforts yet: the still-valid
      // current value (high) must remain selectable rather than collapsing to
      // off/auto only.
      channel.emit(
        sessionFrame(
          thinking: 'high',
          thinkingSupported: true,
          thinkingLevels: const <String>[],
        ),
      );
      await _flush();
      composer = controller.state.composer;
      expect(composer.thinking, 'high');
      expect(composer.thinkingLevels, contains('off'));
      expect(composer.thinkingLevels, contains('auto'));
      expect(composer.thinkingLevels, contains('high'));
      expect(composer.thinkingLevels, isNot(contains('low')));
      expect(composer.thinkingLevels, isNot(contains('medium')));

      // A model that cannot reason exposes no levels.
      channel.emit(
        sessionFrame(
          thinking: 'high',
          thinkingSupported: false,
          thinkingLevels: const <String>['low', 'medium', 'high'],
        ),
      );
      await _flush();
      composer = controller.state.composer;
      expect(composer.thinkingLevels, isEmpty);

      // Submitting the current level sends the canonical raw value.
      channel.emit(
        sessionFrame(
          thinking: 'high',
          thinkingSupported: true,
          thinkingLevels: const <String>['low', 'medium', 'high'],
        ),
      );
      await _flush();
      final setting = controller.setSessionThinking('high');
      await _flush();
      final sent = channel.sentJson.lastWhere(
        (frame) => frame['command'] == 'session.thinking.set',
      );
      expect(sent['args'], <String, Object?>{'level': 'high'});
      channel.emit(
        _response(
          sent,
          command: 'session.thinking.set',
          result: <String, Object?>{'updated': true},
        ),
      );
      await setting;
    },
  );
}

const String _token = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
Map<String, Object?> _settingsCatalog({
  String hostId = 'host-settings',
  String revision = 'catalog-rev-1',
}) => <String, Object?>{
  'v': 'omp-app/1',
  'type': 'catalog',
  'hostId': hostId,
  'revision': revision,
  'items': <Object?>[
    <String, Object?>{
      'id': 'setting:appearance.compact',
      'kind': 'setting',
      'name': 'appearance.compact',
      'metadata': <String, Object?>{
        'path': 'appearance.compact',
        'label': 'Compact appearance',
        'description': 'Use less space.',
        'controlType': 'boolean',
        'scopes': <Object?>['global', 'session'],
        'tab': 'appearance',
      },
    },
    <String, Object?>{
      'id': 'setting:provider.token',
      'kind': 'setting',
      'name': 'provider.token',
      'metadata': <String, Object?>{
        'path': 'provider.token',
        'label': 'Provider token',
        'controlType': 'string',
        'sensitive': true,
        'configured': true,
        'tab': 'providers',
      },
    },
    <String, Object?>{
      'id': 'setting:future.setting',
      'kind': 'setting',
      'name': 'future.setting',
      'metadata': <String, Object?>{
        'path': 'future.setting',
        'label': 'Future setting',
        'controlType': 'boolean',
        'unreviewedKey': true,
      },
    },
  ],
};

Map<String, Object?> _settingsValues({
  String hostId = 'host-settings',
  String revision = 'settings-rev-1',
}) => <String, Object?>{
  'v': 'omp-app/1',
  'type': 'settings',
  'hostId': hostId,
  'revision': revision,
  'settings': <String, Object?>{
    'appearance.compact': <String, Object?>{
      'effective': false,
      'effectiveSource': 'global',
      'configured': true,
    },
    'provider.token': <String, Object?>{
      'sensitive': true,
      'configured': true,
      'effective': 'must-never-render',
      'effectiveSource': 'global',
    },
  },
};

T4ClientController _controller(
  HostDirectoryStore directory,
  HostCredentialStore credentials,
  _FakeConnector connector, {
  TranscriptTailStore? transcriptTailStore,
}) => T4ClientController(
  hostDirectoryStore: directory,
  hostCredentialStore: credentials,
  transcriptTailStore: transcriptTailStore,
  webSocketConnector: connector.call,
);

DurableEntry _durableMessage(
  String id, {
  required String hostId,
  required String sessionId,
  required String text,
}) {
  final raw = <String, Object?>{
    'id': id,
    'parentId': null,
    'hostId': hostId,
    'sessionId': sessionId,
    'kind': 'message',
    'timestamp': '2026-07-20T08:00:00.000Z',
    'data': <String, Object?>{'role': 'assistant', 'text': text},
  };
  return DurableEntry(
    id: id,
    parentId: null,
    hostId: hostId,
    sessionId: sessionId,
    kind: 'message',
    timestamp: raw['timestamp']! as String,
    data: raw['data']! as Map<String, Object?>,
    raw: raw,
  );
}

HostProfile _profile(String name) =>
    HostProfile.parseTailnetAddress('$name.example.ts.net');

Map<String, Object?> _welcome(
  String hostId, {
  String authentication = 'paired',
  List<String> capabilities = const <String>['sessions.read'],
  List<String> features = const <String>[],
}) => <String, Object?>{
  'v': 'omp-app/1',
  'type': 'welcome',
  'selectedProtocol': 'omp-app/1',
  'hostId': hostId,
  'ompVersion': 'test',
  'ompBuild': 'test',
  'appserverVersion': 'test',
  'appserverBuild': 'test',
  'epoch': 'host-epoch',
  'authentication': authentication,
  'grantedCapabilities': capabilities,
  'grantedFeatures': features,
  'negotiatedLimits': <String, Object?>{},
  'resumed': false,
};

Map<String, Object?> _sessions(String hostId) => <String, Object?>{
  'v': 'omp-app/1',
  'type': 'sessions',
  'hostId': hostId,
  ..._sessionListResult(hostId),
};

Map<String, Object?> _sessionListResult(
  String hostId, {
  String epoch = 'index',
  int seq = 1,
}) => _sessionListResultFor(
  hostId,
  const <String>['session-alpha'],
  epoch: epoch,
  seq: seq,
);

Map<String, Object?> _sessionListResultFor(
  String hostId,
  List<String> sessionIds, {
  String epoch = 'index',
  Map<String, Object?>? attention,
  int seq = 1,
}) => <String, Object?>{
  'cursor': <String, Object?>{'epoch': epoch, 'seq': seq},
  'sessions': sessionIds
      .map(
        (sessionId) => _sessionRef(
          hostId,
          sessionId,
          projectId: 'project-$sessionId',
          projectName: sessionId == 'session-alpha'
              ? 'Project Alpha'
              : 'Project Beta',
          revision: 'revision-$sessionId',
          title: '$sessionId title',
          attention: sessionId == 'session-alpha' ? attention : null,
        ),
      )
      .toList(growable: false),
  'totalCount': sessionIds.length,
  'truncated': false,
};

Map<String, Object?> _response(
  Map<String, Object?> request, {
  required String command,
  required Object? result,
}) => <String, Object?>{
  'v': 'omp-app/1',
  'type': 'response',
  'requestId': request['requestId'],
  'commandId': request['commandId'],
  'hostId': request['hostId'],
  if (request['sessionId'] != null) 'sessionId': request['sessionId'],
  'command': command,
  'ok': true,
  'result': result,
};

Map<String, Object?> _sessionRef(
  String hostId,
  String sessionId, {
  required String projectId,
  required String projectName,
  required String revision,
  required String title,
  String status = 'idle',
  Map<String, Object?>? attention,
}) => <String, Object?>{
  'hostId': hostId,
  'sessionId': sessionId,
  'project': <String, Object?>{'projectId': projectId, 'name': projectName},
  'revision': revision,
  'title': title,
  'status': status,
  'updatedAt': '2026-07-19T00:00:00.000Z',
  'attention': ?attention,
};

Map<String, Object?> _snapshot(
  String hostId,
  String sessionId, {
  required String revision,
}) => <String, Object?>{
  'v': 'omp-app/1',
  'type': 'snapshot',
  'hostId': hostId,
  'sessionId': sessionId,
  'cursor': <String, Object?>{'epoch': 'transcript', 'seq': 0},
  'revision': revision,
  'entries': <Object?>[],
};

Map<String, Object?> _transcriptEvent(
  String hostId,
  String sessionId, {
  required int seq,
  required Map<String, Object?> event,
}) => <String, Object?>{
  'v': 'omp-app/1',
  'type': 'event',
  'hostId': hostId,
  'sessionId': sessionId,
  'cursor': <String, Object?>{'epoch': 'transcript', 'seq': seq},
  'event': event,
};

Map<String, Object?> _transcriptMessageEntry(
  String hostId,
  String sessionId, {
  required int seq,
  required String entryId,
  required String role,
  required String text,
}) => <String, Object?>{
  'v': 'omp-app/1',
  'type': 'entry',
  'hostId': hostId,
  'sessionId': sessionId,
  'cursor': <String, Object?>{'epoch': 'transcript', 'seq': seq},
  'revision': 'revision-$seq',
  'entry': <String, Object?>{
    'id': entryId,
    'parentId': null,
    'hostId': hostId,
    'sessionId': sessionId,
    'kind': 'message',
    'timestamp': '2026-07-20T00:00:00.000Z',
    'data': <String, Object?>{'role': role, 'text': text},
  },
};

Map<String, Object?> _sessionDelta(
  String hostId,
  String sessionId, {
  required String revision,
  required int seq,
  Map<String, Object?>? upsert,
  String? remove,
}) => <String, Object?>{
  'v': 'omp-app/1',
  'type': 'session.delta',
  'hostId': hostId,
  'sessionId': sessionId,
  'cursor': <String, Object?>{'epoch': 'index', 'seq': seq},
  'revision': revision,
  'upsert': ?upsert,
  'remove': ?remove,
};

Map<String, Object?> _confirmation(
  Map<String, Object?> command,
  String confirmationId,
) => <String, Object?>{
  'v': 'omp-app/1',
  'type': 'confirmation',
  'confirmationId': confirmationId,
  'commandId': command['commandId'],
  'hostId': command['hostId'],
  if (command['sessionId'] != null) 'sessionId': command['sessionId'],
  'commandHash': 'sha256:test',
  'revision': command['expectedRevision'],
  'expiresAt': '2030-01-01T00:00:00.000Z',
  'summary': command['command'],
};

Future<void> _flush() async {
  await Future<void>.delayed(Duration.zero);
  await Future<void>.delayed(Duration.zero);
}

Future<void> _until(bool Function() predicate) async {
  for (var attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Future<void>.delayed(Duration.zero);
  }
  fail('condition was not reached');
}

final class _MemoryDirectoryStore implements HostDirectoryStore {
  _MemoryDirectoryStore({
    this.directory = const HostDirectory.empty(),
    List<String>? events,
  }) : events = events ?? <String>[];

  HostDirectory directory;
  final List<String> events;
  final List<HostDirectory> saved = <HostDirectory>[];

  @override
  Future<HostDirectory> load() async {
    events.add('load');
    return directory;
  }

  @override
  Future<void> save(HostDirectory directory) async {
    events.add('save:${directory.activeEndpointKey}');
    saved.add(directory);
    this.directory = directory;
  }
}

final class _MemoryCredentialStore implements HostCredentialStore {
  _MemoryCredentialStore({List<String>? events})
    : events = events ?? <String>[];

  final List<String> events;
  final Map<String, DeviceCredentials> values = <String, DeviceCredentials>{};
  final Map<String, Completer<DeviceCredentials?>> delayedReads =
      <String, Completer<DeviceCredentials?>>{};
  final List<String> readProfiles = <String>[];
  final List<String> deleted = <String>[];
  Object? deleteError;

  @override
  Future<DeviceCredentials?> read(HostProfile profile) async {
    events.add('read:${profile.endpointKey}');
    readProfiles.add(profile.endpointKey);
    final delayed = delayedReads[profile.endpointKey];
    if (delayed != null) return delayed.future;
    return values[profile.endpointKey];
  }

  @override
  Future<void> write(HostProfile profile, DeviceCredentials credentials) async {
    values[profile.endpointKey] = credentials;
  }

  @override
  Future<void> delete(HostProfile profile) async {
    deleted.add(profile.endpointKey);
    events.add('delete:${profile.endpointKey}');
    final error = deleteError;
    if (error != null) throw error;
    values.remove(profile.endpointKey);
  }
}

final class _FakeConnector {
  _FakeConnector({
    List<String>? events,
    this.readyGate,
    this.hangFirstClose = false,
  }) : events = events ?? <String>[];

  final Completer<void>? readyGate;
  final bool hangFirstClose;
  // Constructor is declared above so tests can delay a probe handshake.

  final List<String> events;
  final List<Uri> uris = <Uri>[];
  final List<_FakeWebSocketChannel> channels = <_FakeWebSocketChannel>[];

  Future<WebSocketChannel> call(Uri uri) async {
    events.add('connect:$uri');
    uris.add(uri);
    final channel = _FakeWebSocketChannel(
      channels.length,
      events,
      readyGate: readyGate,
      hangClose: hangFirstClose && channels.isEmpty,
    );
    channels.add(channel);
    return channel;
  }
}

final class _FakeWebSocketChannel implements WebSocketChannel {
  _FakeWebSocketChannel(
    this.index,
    this.events, {
    this.readyGate,
    bool hangClose = false,
  }) : sink = _FakeWebSocketSink(index, events, hangClose: hangClose);

  final int index;
  final List<String> events;
  final Completer<void>? readyGate;
  final StreamController<Object?> _incoming = StreamController<Object?>();
  @override
  final _FakeWebSocketSink sink;

  List<String> get sent => sink.sent.cast<String>();
  List<Map<String, Object?>> get sentJson => sent
      .map((value) => (jsonDecode(value) as Map<String, Object?>))
      .toList(growable: false);

  void emit(Map<String, Object?> frame) => _incoming.add(jsonEncode(frame));
  void fail(Object error) => _incoming.addError(error);

  @override
  Future<void> get ready => readyGate?.future ?? Future<void>.value();
  @override
  Stream<Object?> get stream => _incoming.stream;
  @override
  String? get protocol => null;
  @override
  int? get closeCode => null;
  @override
  String? get closeReason => null;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

final class _FakeWebSocketSink implements WebSocketSink {
  _FakeWebSocketSink(this.index, this.events, {this.hangClose = false});

  final int index;
  final List<String> events;
  final bool hangClose;
  final List<Object?> sent = <Object?>[];
  final Completer<void> _done = Completer<void>();

  @override
  void add(Object? data) => sent.add(data);
  @override
  void addError(Object error, [StackTrace? stackTrace]) =>
      _done.completeError(error, stackTrace);
  @override
  Future<void> addStream(Stream<Object?> stream) async =>
      sent.addAll(await stream.toList());
  @override
  Future<void> close([int? closeCode, String? closeReason]) async {
    events.add('close:$index');
    if (hangClose) return Completer<void>().future;
    if (!_done.isCompleted) _done.complete();
  }

  @override
  Future<void> get done => _done.future;
}
