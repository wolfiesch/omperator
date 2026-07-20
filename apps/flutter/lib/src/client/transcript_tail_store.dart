import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../protocol/protocol.dart';

const String transcriptTailStorageKey =
    't4-code:secure-transcript-tail:index:v1';
const String _recordKeyPrefix = 't4-code:secure-transcript-tail:record:v1:';
const int _maxCachedSessions = 8;
const int _maxCachedEntries = 64;
const int _maxCachedTailBytes = 128 * 1024;

final class CachedTranscriptTail {
  const CachedTranscriptTail({required this.entries, required this.generation});

  final List<DurableEntry> entries;
  final String generation;
}

abstract interface class TranscriptTailStore {
  Future<CachedTranscriptTail?> load({
    required String hostId,
    required String sessionId,
  });

  Future<void> save({
    required String hostId,
    required String sessionId,
    required String generation,
    required List<DurableEntry> entries,
  });
}

abstract interface class TranscriptTailStorage {
  Future<String?> getString(String key);

  Future<void> setString(String key, String value);

  Future<void> delete(String key);
}

final class InMemoryTranscriptTailStore implements TranscriptTailStore {
  final Map<String, CachedTranscriptTail> _tails =
      <String, CachedTranscriptTail>{};

  @override
  Future<CachedTranscriptTail?> load({
    required String hostId,
    required String sessionId,
  }) async => _tails[_cacheId(hostId, sessionId)];

  @override
  Future<void> save({
    required String hostId,
    required String sessionId,
    required String generation,
    required List<DurableEntry> entries,
  }) async {
    _tails[_cacheId(hostId, sessionId)] = CachedTranscriptTail(
      entries: List<DurableEntry>.unmodifiable(entries),
      generation: generation,
    );
  }
}

/// A bounded, encrypted display cache for recently opened transcripts.
///
/// Each session is stored separately so opening one conversation does not read
/// every cached transcript. Live and backward-page cursors are never stored;
/// the host remains authoritative after every reconnect.
final class PersistentTranscriptTailStore implements TranscriptTailStore {
  PersistentTranscriptTailStore({TranscriptTailStorage? storage})
    : _storage = storage ?? _SecureTranscriptTailStorage();

  final TranscriptTailStorage _storage;
  Future<void> _writes = Future<void>.value();

  @override
  Future<CachedTranscriptTail?> load({
    required String hostId,
    required String sessionId,
  }) async {
    await _writes;
    final encoded = await _storage.getString(_recordKey(hostId, sessionId));
    if (encoded == null) return null;
    try {
      final decoded = jsonDecode(encoded);
      if (decoded is! Map<String, Object?> ||
          decoded['version'] != 1 ||
          decoded['hostId'] != hostId ||
          decoded['sessionId'] != sessionId) {
        return null;
      }
      final result = WireDecoder.decodeTranscriptPageResult(<String, Object?>{
        'entries': decoded['entries'],
        'hasMore': false,
        'generation': decoded['generation'],
      });
      if (result.entries.any(
        (entry) => entry.hostId != hostId || entry.sessionId != sessionId,
      )) {
        return null;
      }
      return CachedTranscriptTail(
        entries: result.entries,
        generation: result.generation,
      );
    } on Object {
      return null;
    }
  }

  @override
  Future<void> save({
    required String hostId,
    required String sessionId,
    required String generation,
    required List<DurableEntry> entries,
  }) {
    final operation = _writes.then(
      (_) => _saveNow(
        hostId: hostId,
        sessionId: sessionId,
        generation: generation,
        entries: entries,
      ),
    );
    _writes = operation.then<void>((_) {}, onError: (_, _) {});
    return operation;
  }

  Future<void> _saveNow({
    required String hostId,
    required String sessionId,
    required String generation,
    required List<DurableEntry> entries,
  }) async {
    final bounded = entries.length <= _maxCachedEntries
        ? entries.toList(growable: true)
        : entries.sublist(entries.length - _maxCachedEntries);
    while (bounded.isNotEmpty &&
        utf8
                .encode(jsonEncode(bounded.map((entry) => entry.raw).toList()))
                .length >
            _maxCachedTailBytes) {
      bounded.removeAt(0);
    }

    final key = _recordKey(hostId, sessionId);
    final index = await _readIndex();
    index.removeWhere((record) => record.key == key);
    if (bounded.isEmpty) {
      await _storage.delete(key);
    } else {
      final updatedAt = DateTime.now().toUtc().toIso8601String();
      await _storage.setString(
        key,
        jsonEncode(<String, Object?>{
          'version': 1,
          'hostId': hostId,
          'sessionId': sessionId,
          'generation': generation,
          'entries': bounded.map((entry) => entry.raw).toList(growable: false),
        }),
      );
      index.add((key: key, updatedAt: updatedAt));
    }

    index.sort((left, right) => right.updatedAt.compareTo(left.updatedAt));
    if (index.length > _maxCachedSessions) {
      final removed = index.sublist(_maxCachedSessions);
      index.removeRange(_maxCachedSessions, index.length);
      for (final record in removed) {
        await _storage.delete(record.key);
      }
    }
    await _storage.setString(
      transcriptTailStorageKey,
      jsonEncode(<String, Object?>{
        'version': 1,
        'records': [
          for (final record in index)
            <String, Object?>{'key': record.key, 'updatedAt': record.updatedAt},
        ],
      }),
    );
  }

  Future<List<({String key, String updatedAt})>> _readIndex() async {
    final encoded = await _storage.getString(transcriptTailStorageKey);
    if (encoded == null) return <({String key, String updatedAt})>[];
    try {
      final decoded = jsonDecode(encoded);
      if (decoded is! Map<String, Object?> || decoded['version'] != 1) {
        return <({String key, String updatedAt})>[];
      }
      final values = decoded['records'];
      if (values is! List<Object?>) {
        return <({String key, String updatedAt})>[];
      }
      return <({String key, String updatedAt})>[
        for (final value in values.take(_maxCachedSessions))
          if (value is Map<String, Object?> &&
              value['key'] is String &&
              (value['key']! as String).startsWith(_recordKeyPrefix) &&
              value['updatedAt'] is String)
            (
              key: value['key']! as String,
              updatedAt: value['updatedAt']! as String,
            ),
      ];
    } on Object {
      return <({String key, String updatedAt})>[];
    }
  }
}

String _cacheId(String hostId, String sessionId) => '$hostId\u0000$sessionId';

String _recordKey(String hostId, String sessionId) =>
    '$_recordKeyPrefix${sha256.convert(utf8.encode(_cacheId(hostId, sessionId)))}';

final class _SecureTranscriptTailStorage implements TranscriptTailStorage {
  _SecureTranscriptTailStorage() : _storage = const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  @override
  Future<String?> getString(String key) => _storage.read(key: key);

  @override
  Future<void> setString(String key, String value) =>
      _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}
