import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:t4code/src/protocol/protocol.dart';

const _corpusPath =
    '../../packages/client/test/fixtures/protocol/omp-app-v1-corpus.json';

void main() {
  final corpus = _loadCorpus();

  group('inbound wire conformance', () {
    final supportedFamilies = <String, Matcher>{
      'welcome': isA<WelcomeFrame>(),
      'successful-response': isA<ResponseFrame>(),
      'authorization-error': isA<ErrorFrame>(),
      'session-list': isA<SessionsFrame>(),
      'transcript-snapshot': isA<SnapshotFrame>(),
      'streaming-event': isA<EventFrame>(),
      'confirmation-challenge': isA<ConfirmationFrame>(),
      'terminal-output': isA<TerminalOutputFrame>(),
      'continuity-gap': isA<GapFrame>(),
      'heartbeat-pong': isA<PongFrame>(),
      'pair-ok': isA<PairOkFrame>(),
    };

    for (final entry in supportedFamilies.entries) {
      test('${entry.key} decodes to its sealed frame family', () {
        final fixture = _namedCase(corpus, 'inbound', entry.key);

        expect(
          WireDecoder.decode(jsonEncode(fixture['wire'])),
          entry.value,
          reason: entry.key,
        );
      });
    }

    test('every canonical invalidInbound case is rejected', () {
      final invalidCases = _caseList(corpus, 'invalidInbound');

      expect(invalidCases, isNotEmpty);
      for (final fixture in invalidCases) {
        final name = fixture['name']! as String;
        expect(
          () => WireDecoder.decode(jsonEncode(fixture['wire'])),
          throwsA(isA<WireFormatException>()),
          reason: name,
        );
      }
    });

    test('every canonical inbound case rejects a missing required field', () {
      const requiredFields = <String, String>{
        'welcome': 'hostId',
        'successful-response': 'requestId',
        'authorization-error': 'code',
        'session-list': 'cursor',
        'transcript-snapshot': 'entries',
        'streaming-event': 'event',
        'confirmation-challenge': 'confirmationId',
        'terminal-output': 'data',
        'continuity-gap': 'from',
        'heartbeat-pong': 'nonce',
        'pair-ok': 'pairingId',
      };
      for (final entry in requiredFields.entries) {
        final fixture = _namedCase(corpus, 'inbound', entry.key);
        final malformed = _cloneMap(fixture['wire'])..remove(entry.value);
        expect(
          () => WireDecoder.decode(jsonEncode(malformed)),
          throwsA(isA<WireFormatException>()),
          reason: '${entry.key} requires ${entry.value}',
        );
      }
    });

    test('additive and unknown event data is preserved but immutable', () {
      final fixture = _namedCase(corpus, 'inbound', 'streaming-event');
      final wire = _cloneMap(fixture['wire']);
      final event = _asMap(wire['event']);
      event['type'] = 'future.message.decorated';
      event['futureData'] = <String, Object?>{
        'enabled': true,
        'labels': <Object?>['preserved'],
      };
      wire['futureEnvelopeData'] = <String, Object?>{'generation': 2};
      final expectedEvent = _cloneMap(event);

      final frame = WireDecoder.decode(jsonEncode(wire));

      expect(frame, isA<EventFrame>());
      final eventFrame = frame as EventFrame;
      expect(eventFrame.event, expectedEvent);
      expect(eventFrame.raw['futureEnvelopeData'], <String, Object?>{
        'generation': 2,
      });
      expect(() => eventFrame.event['added'] = true, throwsUnsupportedError);
      final futureData = _asMap(eventFrame.event['futureData']);
      expect(() => futureData['enabled'] = false, throwsUnsupportedError);
      final labels = futureData['labels']! as List<Object?>;
      expect(() => labels.add('changed'), throwsUnsupportedError);
      expect(
        () => eventFrame.raw['futureEnvelopeData'] = null,
        throwsUnsupportedError,
      );
    });

    test('transcript image metadata survives durable entry decoding', () {
      final fixture = _namedCase(corpus, 'inbound', 'transcript-snapshot');
      final wire = _cloneMap(fixture['wire']);
      final entries = (wire['entries']! as List<Object?>)
          .map(_cloneMap)
          .toList(growable: false);
      wire['entries'] = entries;
      final data = _asMap(entries.first['data']);
      data['images'] = <Object?>[
        <String, Object?>{
          'sha256': ''.padRight(64, 'a'),
          'mimeType': 'image/png',
        },
      ];
      entries.first['data'] = data;

      final frame = WireDecoder.decode(jsonEncode(wire)) as SnapshotFrame;

      expect(frame.entries.first.data['images'], <Object?>[
        <String, Object?>{
          'sha256': ''.padRight(64, 'a'),
          'mimeType': 'image/png',
        },
      ]);
    });

    test('wrong protocol version fails at the version boundary', () {
      final fixture = _namedCase(corpus, 'inbound', 'welcome');
      final wire = _cloneMap(fixture['wire'])..['v'] = 'omp-app/2';

      expect(
        () => WireDecoder.decode(jsonEncode(wire)),
        throwsA(
          isA<WireFormatException>()
              .having((error) => error.path, 'path', 'v')
              .having(
                (error) => error.message,
                'message',
                'protocol version must be exactly omp-app/1',
              ),
        ),
      );
    });

    test('unknown top-level frame family fails at the type boundary', () {
      final fixture = _namedCase(corpus, 'inbound', 'heartbeat-pong');
      final wire = _cloneMap(fixture['wire'])..['type'] = 'future.frame';

      expect(
        () => WireDecoder.decode(jsonEncode(wire)),
        throwsA(
          isA<WireFormatException>()
              .having((error) => error.path, 'path', 'type')
              .having(
                (error) => error.message,
                'message',
                'unknown top-level frame family',
              ),
        ),
      );
    });

    test('inbound frames larger than 4 MiB are rejected before parsing', () {
      final oversizedFrame = ''.padRight(4 * 1024 * 1024 + 1, 'x');

      expect(
        () => WireDecoder.decode(oversizedFrame),
        throwsA(
          isA<WireFormatException>().having(
            (error) => error.message,
            'message',
            'inbound frame exceeds the 4 MiB UTF-8 limit',
          ),
        ),
      );
    });

    test('exact pinned ServerFrame union has typed sealed dispatch', () {
      final frames = _authoritativeServerFrames(corpus);
      final matchers = _authoritativeServerMatchers();

      expect(frames.keys, unorderedEquals(matchers.keys));
      for (final entry in frames.entries) {
        final decoded = WireDecoder.decode(jsonEncode(entry.value));
        expect(decoded, matchers[entry.key], reason: entry.key);
        expect(() => decoded.raw['changed'] = true, throwsUnsupportedError);
      }
    });

    test(
      'every non-corpus ServerFrame branch rejects a missing requirement',
      () {
        const requiredFields = <String, String>{
          'entry': 'entry',
          'agent': 'state',
          'terminal': 'stream',
          'files': 'path',
          'review': 'findings',
          'audit': 'actor',
          'pair.error': 'message',
          'bye': 'retryable',
          'host.watch': 'watchId',
          'session.watch': 'watchId',
          'session.state': 'state',
          'session.delta': 'remove',
          'lease': 'kind',
          'prompt.lease': 'kind',
          'agent.state': 'state',
          'agent.lifecycle': 'lifecycle',
          'agent.progress': 'progress',
          'agent.event': 'event',
          'agent.transcript': 'entries',
          'terminal.exit': 'exitCode',
          'files.list': 'entries',
          'files.read': 'content',
          'files.write': 'revision',
          'files.patch': 'patch',
          'files.diff': 'diff',
          'audit.tail': 'events',
          'audit.event': 'event',
          'catalog': 'items',
          'settings': 'settings',
          'preview.launch': 'url',
          'preview.state': 'state',
          'preview.navigation': 'cursor',
          'preview.capture': 'capture',
          'preview.error': 'code',
        };
        final frames = _authoritativeServerFrames(corpus);
        for (final entry in requiredFields.entries) {
          final malformed = _cloneMap(frames[entry.key])..remove(entry.value);
          expect(
            () => WireDecoder.decode(jsonEncode(malformed)),
            throwsA(isA<WireFormatException>()),
            reason: '${entry.key} requires ${entry.value}',
          );
        }
      },
    );

    test('usage and broker command results decode to strict typed models', () {
      final responseFixture = _namedCase(
        corpus,
        'inbound',
        'successful-response',
      );
      final usageWire = _cloneMap(responseFixture['wire']);
      usageWire['command'] = 'usage.read';
      usageWire['result'] = <String, Object?>{
        'generatedAt': 1720000000000,
        'reports': <Object?>[
          <String, Object?>{
            'provider': 'openai',
            'fetchedAt': 1720000000000,
            'limits': <Object?>[
              <String, Object?>{
                'id': 'requests',
                'label': 'Requests',
                'scope': <String, Object?>{'provider': 'openai'},
                'amount': <String, Object?>{
                  'used': 4,
                  'limit': 10,
                  'unit': 'requests',
                },
                'status': 'ok',
              },
            ],
            'notes': <Object?>[],
          },
        ],
        'accountsWithoutUsage': <Object?>[],
        'capacity': <String, Object?>{
          'openai': <Object?>[
            <String, Object?>{
              'window': 'team',
              'accounts': 2,
              'usedAccounts': 1.5,
              'remainingAccounts': 0.5,
            },
          ],
        },
      };
      final usage = WireDecoder.decode(jsonEncode(usageWire)) as ResponseFrame;

      expect(usage.usageReadResult?.reports.single.provider, 'openai');
      expect(
        usage.usageReadResult?.reports.single.limits.single.amount.limit,
        10,
      );
      expect(
        usage.usageReadResult?.capacity['openai']?.single.usedAccounts,
        1.5,
      );

      final brokerWire = _cloneMap(responseFixture['wire']);
      brokerWire['command'] = 'broker.status';
      brokerWire['result'] = <String, Object?>{
        'state': 'connected',
        'endpoint': 'https://broker.example.test',
        'generation': 3,
      };
      final broker =
          WireDecoder.decode(jsonEncode(brokerWire)) as ResponseFrame;

      expect(broker.brokerStatusResult?.state, BrokerState.connected);
      expect(broker.brokerStatusResult?.generation, 3);
    });

    test('usage and broker results reject unsafe additive data', () {
      final responseFixture = _namedCase(
        corpus,
        'inbound',
        'successful-response',
      );
      final malformedUsage = _cloneMap(responseFixture['wire']);
      malformedUsage['command'] = 'usage.read';
      malformedUsage['result'] = <String, Object?>{
        'generatedAt': 1,
        'reports': <Object?>[],
        'accountsWithoutUsage': <Object?>[],
        'capacity': <String, Object?>{},
        'token': 'secret',
      };
      expect(
        () => WireDecoder.decode(jsonEncode(malformedUsage)),
        throwsA(isA<WireFormatException>()),
      );

      final malformedBroker = _cloneMap(responseFixture['wire']);
      malformedBroker['command'] = 'broker.status';
      malformedBroker['result'] = <String, Object?>{
        'state': 'connected',
        'endpoint': 'https://user:secret@broker.example.test',
        'generation': 1,
      };
      expect(
        () => WireDecoder.decode(jsonEncode(malformedBroker)),
        throwsA(isA<WireFormatException>()),
      );

      final malformedLocalBroker = _cloneMap(responseFixture['wire']);
      malformedLocalBroker['command'] = 'broker.status';
      malformedLocalBroker['result'] = <String, Object?>{
        'state': 'local',
        'endpoint': 'https://broker.example.test',
        'generation': 1,
      };
      expect(
        () => WireDecoder.decode(jsonEncode(malformedLocalBroker)),
        throwsA(isA<WireFormatException>()),
      );
    });

    test('ping is client-only and rejected by server dispatch', () {
      final fixture = _namedCase(corpus, 'outbound', 'heartbeat-ping');
      expect(
        () => WireDecoder.decode(jsonEncode(fixture['wire'])),
        throwsA(isA<WireFormatException>()),
      );
    });
  });

  group('outbound wire conformance', () {
    test('hello matches the canonical correlated frame without mutation', () {
      final fixture = _namedCase(
        corpus,
        'outbound',
        'hello-with-resume-and-authentication',
      );
      final message = _asMap(fixture['message']);
      final client = _asMap(message['client']);
      final authentication = _asMap(message['authentication']);
      final requestedFeatures = _strings(message['requestedFeatures']);
      final capabilities = _strings(message['capabilities']);
      final savedCursors = (_asList(message['savedCursors'])).map((value) {
        final saved = _asMap(value);
        final cursor = _asMap(saved['cursor']);
        return SavedCursor(
          hostId: saved['hostId']! as String,
          sessionId: saved['sessionId']! as String,
          cursor: TranscriptCursor(
            epoch: cursor['epoch']! as String,
            seq: cursor['seq']! as int,
          ),
        );
      }).toList();
      final requestedFeaturesBefore = List<String>.of(requestedFeatures);
      final capabilitiesBefore = List<String>.of(capabilities);
      final savedCursorsBefore = List<SavedCursor>.of(savedCursors);

      final encoded = WireEncoder.hello(
        client: ClientIdentity(
          name: client['name']! as String,
          version: client['version']! as String,
          build: client['build']! as String,
          platform: client['platform']! as String,
        ),
        requestedFeatures: requestedFeatures,
        savedCursors: savedCursors,
        capabilities: capabilities,
        authentication: DeviceAuthentication(
          deviceId: authentication['deviceId']! as String,
          deviceToken: authentication['deviceToken']! as String,
        ),
      );

      expect(
        jsonDecode(encoded),
        fixture['wire'],
        reason: fixture['name']! as String,
      );
      expect(requestedFeatures, requestedFeaturesBefore);
      expect(capabilities, capabilitiesBefore);
      expect(savedCursors, savedCursorsBefore);
    });

    test('session prompt matches the canonical correlated command', () {
      final fixture = _namedCase(corpus, 'outbound', 'session-prompt-command');
      final message = _asMap(fixture['message']);
      final args = _asMap(message['args']);
      final before = jsonEncode(message);

      final encoded = WireEncoder.sessionPrompt(
        requestId: message['requestId']! as String,
        commandId: message['commandId']! as String,
        hostId: message['hostId']! as String,
        sessionId: message['sessionId']! as String,
        expectedRevision: message['expectedRevision']! as String,
        text: args['text']! as String,
      );

      expect(
        jsonDecode(encoded),
        fixture['wire'],
        reason: fixture['name']! as String,
      );
      expect(jsonEncode(message), before);
    });

    test('session prompt includes uploaded image references', () {
      final encoded = WireEncoder.sessionPrompt(
        requestId: 'request-image',
        commandId: 'command-image',
        hostId: 'host-image',
        sessionId: 'session-image',
        expectedRevision: 'revision-image',
        text: 'Inspect these',
        imageIds: const <String>['image-one', 'image-two'],
      );

      final frame = jsonDecode(encoded) as Map<String, Object?>;
      expect(frame['args'], <String, Object?>{
        'message': 'Inspect these',
        'images': <Object?>[
          <String, Object?>{'imageId': 'image-one'},
          <String, Object?>{'imageId': 'image-two'},
        ],
      });
    });

    test(
      'session attach uses canonical command correlation and cursor JSON',
      () {
        final commandFixture = _namedCase(
          corpus,
          'outbound',
          'session-prompt-command',
        );
        final snapshotFixture = _namedCase(
          corpus,
          'inbound',
          'transcript-snapshot',
        );
        final command = _asMap(commandFixture['message']);
        final snapshotWire = _asMap(snapshotFixture['wire']);
        final cursorJson = _asMap(snapshotWire['cursor']);
        final cursor = TranscriptCursor(
          epoch: cursorJson['epoch']! as String,
          seq: cursorJson['seq']! as int,
        );
        final commandBefore = jsonEncode(command);
        final cursorBefore = _cloneMap(cursorJson);
        final expected = _cloneMap(commandFixture['wire']);
        expected
          ..remove('expectedRevision')
          ..['command'] = 'session.attach'
          ..['args'] = <String, Object?>{'cursor': _cloneMap(cursorJson)};

        final encoded = WireEncoder.sessionAttach(
          requestId: command['requestId']! as String,
          commandId: command['commandId']! as String,
          hostId: command['hostId']! as String,
          sessionId: command['sessionId']! as String,
          cursor: cursor,
        );

        expect(jsonDecode(encoded), expected);
        expect(jsonEncode(command), commandBefore);
        expect(cursorJson, cursorBefore);
        expect(
          cursor,
          TranscriptCursor(
            epoch: cursorBefore['epoch']! as String,
            seq: cursorBefore['seq']! as int,
          ),
        );
      },
    );

    test('approved-confirmation matches canonical wire without mutation', () {
      final fixture = _namedCase(corpus, 'outbound', 'approved-confirmation');
      final message = _asMap(fixture['message']);
      final before = jsonEncode(message);
      final encoded = WireEncoder.confirm(
        requestId: message['requestId']! as String,
        confirmationId: message['confirmationId']! as String,
        commandId: message['commandId']! as String,
        hostId: message['hostId']! as String,
        sessionId: message['sessionId']! as String,
        decision: message['decision']! as String,
      );
      expect(
        jsonDecode(encoded),
        fixture['wire'],
        reason: fixture['name']! as String,
      );
      expect(jsonEncode(message), before);
    });

    test('pair-start matches canonical wire without mutation', () {
      final fixture = _namedCase(corpus, 'outbound', 'pair-start');
      final message = _asMap(fixture['message']);
      final capabilities = _strings(message['requestedCapabilities']);
      final before = jsonEncode(message);
      final capabilitiesBefore = List<String>.of(capabilities);
      final encoded = WireEncoder.pairStart(
        requestId: message['requestId']! as String,
        code: message['code']! as String,
        deviceId: message['deviceId']! as String,
        deviceName: message['deviceName']! as String,
        platform: message['platform']! as String,
        requestedCapabilities: capabilities,
      );
      expect(
        jsonDecode(encoded),
        fixture['wire'],
        reason: fixture['name']! as String,
      );
      expect(jsonEncode(message), before);
      expect(capabilities, capabilitiesBefore);
    });

    test('terminal-input-base64 matches canonical wire without mutation', () {
      final fixture = _namedCase(corpus, 'outbound', 'terminal-input-base64');
      final message = _asMap(fixture['message']);
      final before = jsonEncode(message);
      final encoded = WireEncoder.terminalInput(
        hostId: message['hostId']! as String,
        sessionId: message['sessionId']! as String,
        terminalId: message['terminalId']! as String,
        data: message['data']! as String,
        encoding: message['encoding']! as String,
      );
      expect(
        jsonDecode(encoded),
        fixture['wire'],
        reason: fixture['name']! as String,
      );
      expect(jsonEncode(message), before);
    });

    test('terminal-resize matches canonical wire without mutation', () {
      final fixture = _namedCase(corpus, 'outbound', 'terminal-resize');
      final message = _asMap(fixture['message']);
      final before = jsonEncode(message);
      final encoded = WireEncoder.terminalResize(
        hostId: message['hostId']! as String,
        sessionId: message['sessionId']! as String,
        terminalId: message['terminalId']! as String,
        cols: message['cols']! as int,
        rows: message['rows']! as int,
      );
      expect(
        jsonDecode(encoded),
        fixture['wire'],
        reason: fixture['name']! as String,
      );
      expect(jsonEncode(message), before);
    });

    test('terminal-close matches canonical wire without mutation', () {
      final fixture = _namedCase(corpus, 'outbound', 'terminal-close');
      final message = _asMap(fixture['message']);
      final before = jsonEncode(message);
      final encoded = WireEncoder.terminalClose(
        hostId: message['hostId']! as String,
        sessionId: message['sessionId']! as String,
        terminalId: message['terminalId']! as String,
        reason: message['reason']! as String,
      );
      expect(
        jsonDecode(encoded),
        fixture['wire'],
        reason: fixture['name']! as String,
      );
      expect(jsonEncode(message), before);
    });

    test('heartbeat-ping matches canonical wire without mutation', () {
      final fixture = _namedCase(corpus, 'outbound', 'heartbeat-ping');
      final message = _asMap(fixture['message']);
      final before = jsonEncode(message);
      final encoded = WireEncoder.ping(
        nonce: message['nonce']! as String,
        timestamp: message['timestamp']! as String,
      );
      expect(
        jsonDecode(encoded),
        fixture['wire'],
        reason: fixture['name']! as String,
      );
      expect(jsonEncode(message), before);
    });

    test('bootstrap command encoders keep cursor domains distinct', () {
      final promptFixture = _namedCase(
        corpus,
        'outbound',
        'session-prompt-command',
      );
      final sessionsFixture = _namedCase(corpus, 'inbound', 'session-list');
      final command = _asMap(promptFixture['message']);
      final sessionWire = _asMap(sessionsFixture['wire']);
      final cursorWire = _asMap(sessionWire['cursor']);
      final cursor = SessionIndexCursor(
        epoch: cursorWire['epoch']! as String,
        seq: cursorWire['seq']! as int,
      );

      expect(
        jsonDecode(
          WireEncoder.sessionList(
            requestId: command['requestId']! as String,
            commandId: command['commandId']! as String,
            hostId: command['hostId']! as String,
          ),
        ),
        <String, Object?>{
          'v': ompAppProtocolVersion,
          'type': 'command',
          'requestId': command['requestId'],
          'commandId': command['commandId'],
          'hostId': command['hostId'],
          'command': 'session.list',
          'args': <String, Object?>{},
        },
      );
      expect(
        jsonDecode(
          WireEncoder.hostWatch(
            requestId: command['requestId']! as String,
            commandId: command['commandId']! as String,
            hostId: command['hostId']! as String,
            cursor: cursor,
          ),
        ),
        <String, Object?>{
          'v': ompAppProtocolVersion,
          'type': 'command',
          'requestId': command['requestId'],
          'commandId': command['commandId'],
          'hostId': command['hostId'],
          'command': 'host.watch',
          'args': <String, Object?>{'cursor': cursorWire},
        },
      );
    });

    test('session-list result decoder is strict, typed, and immutable', () {
      final fixture = _namedCase(corpus, 'inbound', 'session-list');
      final wire = _asMap(fixture['wire']);
      final source = <String, Object?>{
        'cursor': _cloneMap(wire['cursor']),
        'sessions': jsonDecode(jsonEncode(wire['sessions'])),
      };
      final before = jsonEncode(source);

      final decoded = WireDecoder.decodeSessionListResult(source);

      expect(decoded.cursor, isA<SessionIndexCursor>());
      expect(decoded.sessions, hasLength(1));
      expect(decoded.totalCount, 1);
      expect(decoded.truncated, isFalse);
      expect(jsonEncode(source), before);
      expect(() => decoded.raw['changed'] = true, throwsUnsupportedError);
      expect(
        () => decoded.sessions.add(decoded.sessions.single),
        throwsUnsupportedError,
      );

      final responseFixture = _namedCase(
        corpus,
        'inbound',
        'successful-response',
      );
      final responseWire = _cloneMap(responseFixture['wire'])
        ..['command'] = 'session.list'
        ..['result'] = source;
      final response =
          WireDecoder.decode(jsonEncode(responseWire)) as ResponseFrame;
      expect(response.sessionListResult, isA<SessionListResult>());
      expect(response.sessionListResult?.cursor, decoded.cursor);

      final malformed = _cloneMap(source)..['totalCount'] = 0;
      expect(
        () => WireDecoder.decodeSessionListResult(malformed),
        throwsA(isA<WireFormatException>()),
      );
    });

    test(
      'transcript search response is decoded into bounded typed results',
      () {
        final responseWire =
            _cloneMap(
                _namedCase(corpus, 'inbound', 'successful-response')['wire'],
              )
              ..['command'] = 'transcript.search'
              ..['result'] = <String, Object?>{
                'items': <Object?>[
                  <String, Object?>{
                    'sessionId': 'session-1',
                    'projectId': 'project-1',
                    'sessionTitle': 'Search fixture',
                    'anchorId': 'entry-1',
                    'role': 'assistant',
                    'timestamp': '2026-07-19T12:00:00.000Z',
                    'snippet': 'fixed the parser',
                    'highlights': <Object?>[
                      <String, Object?>{'start': 0, 'end': 5},
                    ],
                  },
                ],
                'incomplete': false,
                'index': <String, Object?>{
                  'state': 'ready',
                  'indexedSessions': 4,
                  'knownSessions': 4,
                  'generation': 'generation-1',
                },
              };

        final response =
            WireDecoder.decode(jsonEncode(responseWire)) as ResponseFrame;
        final result = response.transcriptSearchResult;

        expect(result, isNotNull);
        expect(result?.items.single.sessionTitle, 'Search fixture');
        expect(result?.items.single.role, TranscriptSearchRole.assistant);
        expect(result?.items.single.highlights.single.end, 5);
        expect(result?.index.state, TranscriptSearchIndexState.ready);
        expect(
          () => result?.items.add(result.items.single),
          throwsUnsupportedError,
        );

        final malformed = _cloneMap(responseWire);
        final malformedResult = _cloneMap(malformed['result']);
        final malformedItems = _asList(malformedResult['items']);
        final malformedItem = _cloneMap(malformedItems.single);
        malformedItem['highlights'] = <Object?>[
          <String, Object?>{'start': 0, 'end': 100},
        ];
        malformedResult['items'] = <Object?>[malformedItem];
        malformed['result'] = malformedResult;
        expect(
          () => WireDecoder.decode(jsonEncode(malformed)),
          throwsA(isA<WireFormatException>()),
        );
      },
    );

    test('transcript context response validates its anchor row', () {
      final responseWire =
          _cloneMap(
              _namedCase(corpus, 'inbound', 'successful-response')['wire'],
            )
            ..['command'] = 'transcript.context'
            ..['sessionId'] = 'session-1'
            ..['result'] = <String, Object?>{
              'anchorId': 'entry-2',
              'rows': <Object?>[
                <String, Object?>{
                  'anchorId': 'entry-1',
                  'role': 'user',
                  'timestamp': '2026-07-19T11:59:00.000Z',
                  'text': 'Please fix the parser.',
                },
                <String, Object?>{
                  'anchorId': 'entry-2',
                  'role': 'assistant',
                  'timestamp': '2026-07-19T12:00:00.000Z',
                  'text': 'Fixed the parser.',
                },
              ],
              'anchorIndex': 1,
              'hasBefore': true,
              'hasAfter': false,
              'generation': 'generation-1',
            };

      final response =
          WireDecoder.decode(jsonEncode(responseWire)) as ResponseFrame;
      final context = response.transcriptContextResult;

      expect(context?.rows, hasLength(2));
      expect(context?.rows[context.anchorIndex].anchorId, 'entry-2');
      expect(context?.hasBefore, isTrue);

      final malformed = _cloneMap(responseWire);
      final malformedResult = _cloneMap(malformed['result'])
        ..['anchorIndex'] = 0;
      malformed['result'] = malformedResult;
      expect(
        () => WireDecoder.decode(jsonEncode(malformed)),
        throwsA(isA<WireFormatException>()),
      );
    });

    test('transcript page response is bounded, typed, and immutable', () {
      final entry = <String, Object?>{
        'id': 'entry-latest',
        'parentId': null,
        'hostId': 'host-test',
        'sessionId': 'session-1',
        'kind': 'message',
        'timestamp': '2026-07-20T09:00:00.000Z',
        'data': <String, Object?>{
          'role': 'assistant',
          'text': 'Latest durable response',
        },
      };
      final responseWire =
          _cloneMap(
              _namedCase(corpus, 'inbound', 'successful-response')['wire'],
            )
            ..['command'] = 'transcript.page'
            ..['sessionId'] = 'session-1'
            ..['result'] = <String, Object?>{
              'entries': <Object?>[entry],
              'nextCursor': 'older-page',
              'hasMore': true,
              'generation': 'generation-1',
            };

      final response =
          WireDecoder.decode(jsonEncode(responseWire)) as ResponseFrame;
      final page = response.transcriptPageResult;

      expect(page?.entries.single.id, 'entry-latest');
      expect(page?.entries.single.data['text'], 'Latest durable response');
      expect(page?.nextCursor, 'older-page');
      expect(page?.hasMore, isTrue);
      expect(page?.generation, 'generation-1');
      expect(
        () => page?.entries.add(page.entries.single),
        throwsUnsupportedError,
      );

      final malformed = _cloneMap(responseWire);
      final malformedResult = _cloneMap(malformed['result'])
        ..['entries'] = List<Object?>.filled(129, entry);
      malformed['result'] = malformedResult;
      expect(
        () => WireDecoder.decode(jsonEncode(malformed)),
        throwsA(isA<WireFormatException>()),
      );

      final inconsistent = _cloneMap(responseWire);
      inconsistent['result'] = <String, Object?>{
        ..._cloneMap(inconsistent['result']),
        'hasMore': false,
      };
      expect(
        () => WireDecoder.decode(jsonEncode(inconsistent)),
        throwsA(isA<WireFormatException>()),
      );
    });
  });
}

Map<String, Matcher> _authoritativeServerMatchers() => <String, Matcher>{
  'welcome': isA<WelcomeFrame>(),
  'sessions': isA<SessionsFrame>(),
  'snapshot': isA<SnapshotFrame>(),
  'entry': isA<EntryFrame>(),
  'event': isA<EventFrame>(),
  'agent': isA<AgentFrame>(),
  'terminal': isA<TerminalFrame>(),
  'files': isA<FilesFrame>(),
  'review': isA<ReviewFrame>(),
  'audit': isA<AuditFrame>(),
  'pair.ok': isA<PairOkFrame>(),
  'pair.error': isA<PairErrorFrame>(),
  'confirmation': isA<ConfirmationFrame>(),
  'response': isA<ResponseFrame>(),
  'gap': isA<GapFrame>(),
  'error': isA<ErrorFrame>(),
  'pong': isA<PongFrame>(),
  'bye': isA<ByeFrame>(),
  'host.watch': isA<HostWatchFrame>(),
  'session.watch': isA<SessionWatchFrame>(),
  'session.state': isA<SessionStateFrame>(),
  'session.delta': isA<SessionDeltaFrame>(),
  'lease': isA<LeaseFrame>(),
  'prompt.lease': isA<LeaseFrame>(),
  'agent.state': isA<AgentAdditiveFrame>(),
  'agent.lifecycle': isA<AgentAdditiveFrame>(),
  'agent.progress': isA<AgentAdditiveFrame>(),
  'agent.event': isA<AgentAdditiveFrame>(),
  'agent.transcript': isA<AgentAdditiveFrame>(),
  'terminal.output': isA<TerminalOutputFrame>(),
  'terminal.exit': isA<TerminalExitFrame>(),
  'files.list': isA<FilesAdditiveFrame>(),
  'files.read': isA<FilesAdditiveFrame>(),
  'files.write': isA<FilesAdditiveFrame>(),
  'files.patch': isA<FilesAdditiveFrame>(),
  'files.diff': isA<FilesAdditiveFrame>(),
  'audit.tail': isA<AuditTailFrame>(),
  'audit.event': isA<AuditEventFrame>(),
  'catalog': isA<CatalogFrame>(),
  'settings': isA<SettingsFrame>(),
  'preview.launch': isA<PreviewFrame>(),
  'preview.state': isA<PreviewFrame>(),
  'preview.navigation': isA<PreviewFrame>(),
  'preview.capture': isA<PreviewFrame>(),
  'preview.error': isA<PreviewFrame>(),
};

Map<String, Map<String, Object?>> _authoritativeServerFrames(
  Map<String, Object?> corpus,
) {
  final frames = <String, Map<String, Object?>>{};
  for (final fixture in _caseList(corpus, 'inbound')) {
    final wire = _cloneMap(fixture['wire']);
    frames[wire['type']! as String] = wire;
  }
  const cursor = <String, Object?>{'epoch': 'epoch-union', 'seq': 7};
  const hostId = 'host-union';
  const sessionId = 'session-union';
  const revision = 'revision-union';
  const entry = <String, Object?>{
    'id': 'entry-union',
    'parentId': null,
    'hostId': hostId,
    'sessionId': sessionId,
    'kind': 'message',
    'timestamp': '2030-01-01T00:00:00.000Z',
    'data': <String, Object?>{'role': 'assistant', 'text': 'union'},
  };

  Map<String, Object?> frame(
    String type, [
    Map<String, Object?> fields = const <String, Object?>{},
  ]) => <String, Object?>{'v': ompAppProtocolVersion, 'type': type, ...fields};

  Map<String, Object?> owned([Map<String, Object?> fields = const {}]) =>
      <String, Object?>{'hostId': hostId, 'sessionId': sessionId, ...fields};

  frames.addAll(<String, Map<String, Object?>>{
    'entry': frame(
      'entry',
      owned(<String, Object?>{
        'cursor': cursor,
        'revision': revision,
        'entry': entry,
      }),
    ),
    'agent': frame(
      'agent',
      owned(<String, Object?>{
        'agentId': 'agent-union',
        'state': 'running',
        'progress': 0.5,
        'detail': <String, Object?>{'step': 'decode'},
      }),
    ),
    'terminal': frame(
      'terminal',
      owned(<String, Object?>{
        'terminalId': 'terminal-union',
        'stream': 'stdout',
        'data': 'output',
      }),
    ),
    'files': frame(
      'files',
      owned(<String, Object?>{
        'path': 'src/main.dart',
        'content': 'void main() {}',
        'truncated': false,
      }),
    ),
    'review': frame(
      'review',
      owned(<String, Object?>{
        'reviewId': 'review-union',
        'status': 'complete',
        'findings': <Object?>[
          <String, Object?>{'severity': 'info'},
        ],
      }),
    ),
    'audit': frame('audit', <String, Object?>{
      'hostId': hostId,
      'sessionId': sessionId,
      'action': 'session.read',
      'actor': 'device-union',
      'timestamp': '2030-01-01T00:00:00.000Z',
    }),
    'pair.error': frame('pair.error', <String, Object?>{
      'code': 'PAIRING_INVALID',
      'message': 'pairing rejected',
      'requestId': 'request-union',
    }),
    'bye': frame('bye', <String, Object?>{
      'code': 'shutdown',
      'reason': 'maintenance',
      'retryable': true,
    }),
    'host.watch': frame('host.watch', <String, Object?>{
      'watchId': 'watch-host',
      'hostId': hostId,
      'cursor': cursor,
      'state': 'ready',
      'revision': revision,
      'metadata': <String, Object?>{'source': 'union'},
    }),
    'session.watch': frame(
      'session.watch',
      owned(<String, Object?>{
        'watchId': 'watch-session',
        'cursor': cursor,
        'state': 'started',
        'revision': revision,
      }),
    ),
    'session.state': frame(
      'session.state',
      owned(<String, Object?>{
        'cursor': cursor,
        'revision': revision,
        'state': 'working',
      }),
    ),
    'session.delta': frame(
      'session.delta',
      owned(<String, Object?>{
        'cursor': cursor,
        'revision': revision,
        'remove': sessionId,
      }),
    ),
    'lease': frame(
      'lease',
      owned(<String, Object?>{
        'leaseId': 'lease-controller',
        'cursor': cursor,
        'kind': 'controller',
        'state': 'acquired',
        'owner': 'device-union',
        'expiresAt': '2030-01-01T00:10:00.000Z',
      }),
    ),
    'prompt.lease': frame(
      'prompt.lease',
      owned(<String, Object?>{
        'leaseId': 'lease-prompt',
        'cursor': cursor,
        'kind': 'prompt',
        'state': 'renewed',
        'owner': 'device-union',
        'expiresAt': '2030-01-01T00:10:00.000Z',
        'revision': revision,
      }),
    ),
    'agent.state': frame(
      'agent.state',
      owned(<String, Object?>{
        'agentId': 'agent-union',
        'cursor': cursor,
        'state': 'running',
        'revision': revision,
      }),
    ),
    'agent.lifecycle': frame(
      'agent.lifecycle',
      owned(<String, Object?>{
        'agentId': 'agent-union',
        'cursor': cursor,
        'lifecycle': 'completed',
        'revision': revision,
      }),
    ),
    'agent.progress': frame(
      'agent.progress',
      owned(<String, Object?>{
        'agentId': 'agent-union',
        'cursor': cursor,
        'progress': 0.75,
        'revision': revision,
      }),
    ),
    'agent.event': frame(
      'agent.event',
      owned(<String, Object?>{
        'agentId': 'agent-union',
        'cursor': cursor,
        'event': 'tool.started',
        'revision': revision,
        'data': <String, Object?>{'tool': 'read'},
      }),
    ),
    'agent.transcript': frame(
      'agent.transcript',
      owned(<String, Object?>{
        'agentId': 'agent-union',
        'cursor': cursor,
        'entries': <Object?>[entry],
        'revision': revision,
      }),
    ),
    'terminal.exit': frame(
      'terminal.exit',
      owned(<String, Object?>{
        'terminalId': 'terminal-union',
        'cursor': cursor,
        'exitCode': 0,
        'signal': 'SIGTERM',
      }),
    ),
    'files.list': frame(
      'files.list',
      owned(<String, Object?>{
        'path': 'src',
        'entries': <Object?>[
          <String, Object?>{
            'path': 'src/main.dart',
            'kind': 'file',
            'size': 64,
            'revision': revision,
          },
        ],
        'cursor': cursor,
        'revision': revision,
      }),
    ),
    'files.read': frame(
      'files.read',
      owned(<String, Object?>{
        'path': 'src/main.dart',
        'content': 'void main() {}',
        'revision': revision,
      }),
    ),
    'files.write': frame(
      'files.write',
      owned(<String, Object?>{
        'path': 'src/main.dart',
        'content': 'void main() {}',
        'revision': revision,
      }),
    ),
    'files.patch': frame(
      'files.patch',
      owned(<String, Object?>{
        'path': 'src/main.dart',
        'patch': '@@ -1 +1 @@',
        'revision': revision,
      }),
    ),
    'files.diff': frame(
      'files.diff',
      owned(<String, Object?>{
        'path': 'src/main.dart',
        'diff': '@@ -1 +1 @@',
        'fromRevision': 'revision-before',
        'toRevision': revision,
      }),
    ),
  });

  final auditEvent = <String, Object?>{
    'eventId': 'operation-union',
    'hostId': hostId,
    'sessionId': sessionId,
    'action': 'session.read',
    'actor': 'device-union',
    'timestamp': '2030-01-01T00:00:00.000Z',
  };
  frames.addAll(<String, Map<String, Object?>>{
    'audit.tail': frame('audit.tail', <String, Object?>{
      'hostId': hostId,
      'cursor': cursor,
      'events': <Object?>[auditEvent],
    }),
    'audit.event': frame('audit.event', <String, Object?>{
      'hostId': hostId,
      'cursor': cursor,
      'event': auditEvent,
    }),
    'catalog': frame('catalog', <String, Object?>{
      'hostId': hostId,
      'revision': revision,
      'items': <Object?>[
        <String, Object?>{
          'id': 'catalog-union',
          'kind': 'tool',
          'name': 'Read',
          'capabilities': <String>['files.read'],
          'supported': true,
        },
      ],
    }),
    'settings': frame('settings', <String, Object?>{
      'hostId': hostId,
      'revision': revision,
      'settings': <String, Object?>{},
    }),
  });

  final preview = <String, Object?>{
    'hostId': hostId,
    'sessionId': sessionId,
    'previewId': 'preview-union',
    'state': 'ready',
    'url': 'https://example.test/',
    'revision': revision,
    'cursor': cursor,
    'title': 'Preview',
    'canGoBack': false,
    'canGoForward': true,
    'viewport': <String, Object?>{
      'width': 1280,
      'height': 720,
      'deviceScaleFactor': 2,
    },
    'authority': <String, Object?>{
      'id': 'isolated',
      'label': 'Isolated',
      'kind': 'isolated-session',
      'requiresExplicitOptIn': false,
    },
    'availableActions': <String>['navigate', 'capture'],
  };
  final capture = <String, Object?>{
    'captureId': 'capture-union',
    'mimeType': 'image/png',
    'size': 1024,
    'width': 1280,
    'height': 720,
    'capturedAt': 1893456000000,
    'sha256': ''.padRight(64, 'a'),
  };
  frames.addAll(<String, Map<String, Object?>>{
    'preview.launch': frame('preview.launch', preview),
    'preview.state': frame('preview.state', <String, Object?>{
      ...preview,
      'error': 'recoverable',
    }),
    'preview.navigation': frame('preview.navigation', preview),
    'preview.capture': frame('preview.capture', <String, Object?>{
      ...preview,
      'capture': capture,
    }),
    'preview.error': frame(
      'preview.error',
      owned(<String, Object?>{
        'previewId': 'preview-union',
        'cursor': cursor,
        'revision': revision,
        'code': 'capture_failed',
        'message': 'capture failed',
      }),
    ),
  });
  return frames;
}

Map<String, Object?> _loadCorpus() {
  final file = File(_corpusPath);
  if (!file.existsSync()) {
    throw StateError('Canonical protocol corpus not found at $_corpusPath');
  }
  return jsonDecode(file.readAsStringSync()) as Map<String, Object?>;
}

List<Map<String, Object?>> _caseList(
  Map<String, Object?> corpus,
  String section,
) => _asList(corpus[section]).map(_asMap).toList(growable: false);

Map<String, Object?> _namedCase(
  Map<String, Object?> corpus,
  String section,
  String name,
) => _caseList(
  corpus,
  section,
).singleWhere((fixture) => fixture['name'] == name);

Map<String, Object?> _cloneMap(Object? value) =>
    jsonDecode(jsonEncode(value)) as Map<String, Object?>;

Map<String, Object?> _asMap(Object? value) => value! as Map<String, Object?>;

List<Object?> _asList(Object? value) => value! as List<Object?>;

List<String> _strings(Object? value) => _asList(value).cast<String>().toList();
