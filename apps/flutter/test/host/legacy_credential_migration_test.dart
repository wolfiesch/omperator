import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:t4code/src/host/host_profile.dart';
import 'package:t4code/src/host/persistent_host_stores.dart';

void main() {
  group('legacy Android credential migration', () {
    test(
      'migrates a discovered keyed endpoint into endpoint storage',
      () async {
        final profile = _profile();
        final storage = _MemoryCredentialStorage();
        final legacy = _MemoryLegacySource(
          credentials: const LegacyHostCredentials(
            deviceId: 'legacy-device',
            deviceToken: 'legacy-token',
            source: 'opaque-keyed-source',
          ),
        );
        final store = SecureHostCredentialStore(
          storage: storage,
          legacySource: legacy,
        );

        final credentials = await store.read(profile);

        expect(credentials!.deviceId, 'legacy-device');
        expect(legacy.hostKeyRequests, <List<String>>[
          <String>[profile.endpointKey, profile.origin],
        ]);
        expect(legacy.includeUnkeyedRequests, <bool>[true]);
        expect(legacy.clearedSources, <String>['opaque-keyed-source']);
        expect(
          jsonDecode(storage.values[_credentialKey(profile.endpointKey)]!),
          <String, Object?>{
            'deviceId': 'legacy-device',
            'deviceToken': 'legacy-token',
          },
        );
      },
    );

    test(
      'checks endpoint, origin, then requests the unkeyed fallback',
      () async {
        final profile = _profile();
        final storage = _MemoryCredentialStorage();
        final legacy = _MemoryLegacySource();
        final store = SecureHostCredentialStore(
          storage: storage,
          legacySource: legacy,
        );
        storage.values[_credentialKey(profile.origin)] = jsonEncode(
          <String, String>{
            'deviceId': 'origin-device',
            'deviceToken': 'origin-token',
          },
        );

        expect((await store.read(profile))!.deviceId, 'origin-device');
        expect(storage.readKeys, <String>[
          _credentialKey(profile.endpointKey),
          _credentialKey(profile.origin),
        ]);
        expect(legacy.hostKeyRequests, isEmpty);

        storage.values.clear();
        storage.readKeys.clear();
        expect(await store.read(profile), isNull);
        expect(storage.readKeys, <String>[
          _credentialKey(profile.endpointKey),
          _credentialKey(profile.origin),
        ]);
        expect(legacy.hostKeyRequests.single, <String>[
          profile.endpointKey,
          profile.origin,
        ]);
        expect(legacy.includeUnkeyedRequests.single, isTrue);
      },
    );

    test(
      'named profiles never request origin or unkeyed credentials',
      () async {
        final profile = _profile(profileId: 'work');
        final storage = _MemoryCredentialStorage();
        final legacy = _MemoryLegacySource();
        storage.values[_credentialKey(profile.origin)] = jsonEncode(
          <String, String>{
            'deviceId': 'default-device',
            'deviceToken': 'default-token',
          },
        );
        final store = SecureHostCredentialStore(
          storage: storage,
          legacySource: legacy,
        );

        expect(await store.read(profile), isNull);
        expect(storage.readKeys, <String>[_credentialKey(profile.endpointKey)]);
        expect(legacy.hostKeyRequests.single, <String>[profile.endpointKey]);
        expect(legacy.includeUnkeyedRequests.single, isFalse);
        expect(storage.values, contains(_credentialKey(profile.origin)));
      },
    );

    test(
      'failed endpoint write preserves the discovered legacy source',
      () async {
        final profile = _profile();
        final currentKey = _credentialKey(profile.endpointKey);
        final storage = _MemoryCredentialStorage()
          ..failingWriteKey = currentKey;
        final legacy = _MemoryLegacySource(
          credentials: const LegacyHostCredentials(
            deviceId: 'legacy-device',
            deviceToken: 'legacy-token',
            source: 'opaque-source',
          ),
        );
        final store = SecureHostCredentialStore(
          storage: storage,
          legacySource: legacy,
        );

        await expectLater(store.read(profile), throwsStateError);

        expect(storage.values, isNot(contains(currentKey)));
        expect(legacy.clearedSources, isEmpty);
        expect(legacy.credentials, isNotNull);
      },
    );

    test('failed legacy clear rolls back and never reports success', () async {
      final profile = _profile();
      final currentKey = _credentialKey(profile.endpointKey);
      final storage = _MemoryCredentialStorage();
      final legacy = _MemoryLegacySource(
        credentials: const LegacyHostCredentials(
          deviceId: 'legacy-device',
          deviceToken: 'legacy-token',
          source: 'opaque-source',
        ),
      )..failClear = true;
      final store = SecureHostCredentialStore(
        storage: storage,
        legacySource: legacy,
      );

      await expectLater(store.read(profile), throwsStateError);

      expect(storage.values, isNot(contains(currentKey)));
      expect(storage.deletedKeys, contains(currentKey));
      expect(legacy.credentials, isNotNull);
      expect(legacy.clearedSources, isEmpty);
      await expectLater(store.read(profile), throwsStateError);
    });

    test(
      'validates discovered credentials before writing or clearing',
      () async {
        final profile = _profile();
        final storage = _MemoryCredentialStorage();
        final legacy = _MemoryLegacySource(
          credentials: const LegacyHostCredentials(
            deviceId: '',
            deviceToken: 'legacy-token',
            source: 'opaque-source',
          ),
        );
        final store = SecureHostCredentialStore(
          storage: storage,
          legacySource: legacy,
        );

        await expectLater(store.read(profile), throwsFormatException);

        expect(storage.values, isEmpty);
        expect(legacy.clearedSources, isEmpty);
      },
    );
  });
}

HostProfile _profile({String profileId = defaultHostProfileId}) =>
    HostProfile.parseTailnetAddress(
      'https://workstation.example.ts.net',
      profileId: profileId,
    );

String _credentialKey(String hostKey) =>
    't4-code:device-credentials:v1:'
    '${base64Url.encode(utf8.encode(hostKey)).replaceAll('=', '')}';

final class _MemoryCredentialStorage implements HostCredentialStorage {
  final Map<String, String> values = <String, String>{};
  final List<String> readKeys = <String>[];
  final List<String> deletedKeys = <String>[];
  String? failingWriteKey;

  @override
  Future<String?> read(String key) async {
    readKeys.add(key);
    return values[key];
  }

  @override
  Future<void> write(String key, String value) async {
    if (key == failingWriteKey) throw StateError('injected write failure');
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    deletedKeys.add(key);
    values.remove(key);
  }
}

final class _MemoryLegacySource implements LegacyHostCredentialSource {
  _MemoryLegacySource({this.credentials});

  LegacyHostCredentials? credentials;
  bool failClear = false;
  final List<List<String>> hostKeyRequests = <List<String>>[];
  final List<bool> includeUnkeyedRequests = <bool>[];
  final List<String> clearedSources = <String>[];

  @override
  Future<LegacyHostCredentials?> discover({
    required List<String> hostKeys,
    required bool includeUnkeyed,
  }) async {
    hostKeyRequests.add(List<String>.of(hostKeys));
    includeUnkeyedRequests.add(includeUnkeyed);
    return credentials;
  }

  @override
  Future<void> clear(String source) async {
    if (failClear) throw StateError('injected clear failure');
    if (credentials?.source != source) throw StateError('wrong source');
    clearedSources.add(source);
    credentials = null;
  }
}
