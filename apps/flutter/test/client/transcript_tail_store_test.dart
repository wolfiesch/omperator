import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:t4code/src/client/transcript_tail_store.dart';
import 'package:t4code/src/protocol/protocol.dart';

void main() {
  test('persistent tail cache keeps only the newest bounded entries', () async {
    final storage = _MemoryStorage();
    final store = PersistentTranscriptTailStore(storage: storage);
    final entries = <DurableEntry>[
      for (var index = 0; index < 70; index++)
        _entry(index, hostId: 'host-a', sessionId: 'session-a'),
    ];

    await store.save(
      hostId: 'host-a',
      sessionId: 'session-a',
      generation: 'generation-a',
      entries: entries,
    );
    final loaded = await store.load(hostId: 'host-a', sessionId: 'session-a');

    expect(loaded?.entries, hasLength(64));
    expect(loaded?.entries.first.id, 'entry-6');
    expect(loaded?.entries.last.id, 'entry-69');
    expect(loaded?.generation, 'generation-a');
    expect(storage.values.values.join(), isNot(contains('nextCursor')));
  });

  test(
    'persistent tail cache prunes old sessions and ignores damage',
    () async {
      final storage = _MemoryStorage();
      final store = PersistentTranscriptTailStore(storage: storage);
      for (var index = 0; index < 9; index++) {
        await Future<void>.delayed(const Duration(milliseconds: 1));
        await store.save(
          hostId: 'host-a',
          sessionId: 'session-$index',
          generation: 'generation-$index',
          entries: <DurableEntry>[
            _entry(index, hostId: 'host-a', sessionId: 'session-$index'),
          ],
        );
      }

      expect(
        await store.load(hostId: 'host-a', sessionId: 'session-0'),
        isNull,
      );
      expect(
        await store.load(hostId: 'host-a', sessionId: 'session-8'),
        isNotNull,
      );

      await store.save(
        hostId: 'host-a',
        sessionId: 'damaged',
        generation: 'generation-damaged',
        entries: <DurableEntry>[
          _entry(99, hostId: 'host-a', sessionId: 'damaged'),
        ],
      );
      final damagedKey = storage.values.entries
          .where((entry) => entry.key != transcriptTailStorageKey)
          .singleWhere((entry) {
            final decoded = jsonDecode(entry.value);
            return decoded is Map<String, Object?> &&
                decoded['sessionId'] == 'damaged';
          })
          .key;
      storage.values[damagedKey] = jsonEncode(<String, Object?>{
        'version': 1,
        'hostId': 'host-a',
        'sessionId': 'damaged',
        'generation': 'generation-damaged',
        'entries': <Object?>[
          <String, Object?>{'id': 'missing-required-fields'},
        ],
      });
      expect(await store.load(hostId: 'host-a', sessionId: 'damaged'), isNull);
    },
  );
}

DurableEntry _entry(
  int index, {
  required String hostId,
  required String sessionId,
}) {
  final raw = <String, Object?>{
    'id': 'entry-$index',
    'parentId': index == 0 ? null : 'entry-${index - 1}',
    'hostId': hostId,
    'sessionId': sessionId,
    'kind': 'message',
    'timestamp': DateTime.utc(
      2026,
      7,
      20,
      8,
    ).add(Duration(minutes: index)).toIso8601String(),
    'data': <String, Object?>{
      'role': index.isEven ? 'assistant' : 'user',
      'text': 'message $index',
    },
  };
  return DurableEntry(
    id: raw['id']! as String,
    parentId: raw['parentId'] as String?,
    hostId: hostId,
    sessionId: sessionId,
    kind: 'message',
    timestamp: raw['timestamp']! as String,
    data: raw['data']! as Map<String, Object?>,
    raw: raw,
  );
}

final class _MemoryStorage implements TranscriptTailStorage {
  final Map<String, String> values = <String, String>{};

  @override
  Future<String?> getString(String key) async => values[key];

  @override
  Future<void> setString(String key, String value) async {
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    values.remove(key);
  }
}
