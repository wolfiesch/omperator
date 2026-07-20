import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:t4code/src/host/host_profile.dart';
import 'package:t4code/src/host/persistent_host_stores.dart';

void main() {
  group('PersistentHostDirectoryStore', () {
    test('returns an empty directory when storage is absent', () async {
      final preferences = _MemoryPreferences();
      final store = PersistentHostDirectoryStore(preferences: preferences);

      final directory = await store.load();

      expect(directory.profiles, isEmpty);
      expect(directory.activeEndpointKey, isNull);
    });

    test('round trips through the canonical preference key', () async {
      final preferences = _MemoryPreferences();
      final store = PersistentHostDirectoryStore(preferences: preferences);
      final profile = _profile();

      await store.save(const HostDirectory.empty().upsert(profile));
      final restored = await store.load();

      expect(preferences.values.keys, <String>[hostDirectoryStorageKey]);
      expect(restored.activeEndpointKey, profile.endpointKey);
      expect(restored.profiles.single.endpointKey, profile.endpointKey);
    });

    test('deletes storage when the directory becomes empty', () async {
      final preferences = _MemoryPreferences();
      final store = PersistentHostDirectoryStore(preferences: preferences);
      final populated = const HostDirectory.empty().upsert(_profile());
      await store.save(populated);

      await store.save(populated.remove(populated.activeEndpointKey!));

      expect(preferences.values, isEmpty);
      expect(preferences.removedKeys, <String>[hostDirectoryStorageKey]);
    });

    test('surfaces malformed and structurally damaged data', () async {
      final preferences = _MemoryPreferences();
      final store = PersistentHostDirectoryStore(preferences: preferences);

      preferences.values[hostDirectoryStorageKey] = '{';
      await expectLater(store.load(), throwsFormatException);

      preferences.values[hostDirectoryStorageKey] = jsonEncode(<String, Object>{
        'version': hostProfileSchemaVersion,
        'activeEndpointKey': 'missing',
        'backends': <Object>[],
      });
      await expectLater(store.load(), throwsFormatException);
      expect(preferences.values, contains(hostDirectoryStorageKey));
    });
  });

  group('VolatileHostCredentialStore', () {
    test(
      'keeps credentials only in the owning process-local instance',
      () async {
        final profile = _profile();
        final store = VolatileHostCredentialStore();
        await store.write(profile, _credentials('volatile-device'));

        expect((await store.read(profile))!.deviceId, 'volatile-device');
        expect(await VolatileHostCredentialStore().read(profile), isNull);

        await store.delete(profile);
        expect(await store.read(profile), isNull);
      },
    );
  });

  group('SecureHostCredentialStore', () {
    test('round trips credentials and isolates profiles by endpoint', () async {
      final storage = _MemoryCredentialStorage();
      final store = SecureHostCredentialStore(storage: storage);
      final defaultProfile = _profile();
      final workProfile = _profile(profileId: 'work');
      final defaultCredentials = _credentials('default-device');
      final workCredentials = _credentials('work-device');

      await store.write(defaultProfile, defaultCredentials);
      await store.write(workProfile, workCredentials);

      expect((await store.read(defaultProfile))!.deviceId, 'default-device');
      expect((await store.read(workProfile))!.deviceId, 'work-device');
      expect(
        storage.values.keys,
        containsAll(<String>[
          _credentialKey(defaultProfile.endpointKey),
          _credentialKey(workProfile.endpointKey),
        ]),
      );
      expect(storage.values, hasLength(2));
    });

    test('surfaces malformed and non-exact credential records', () async {
      final storage = _MemoryCredentialStorage();
      final store = SecureHostCredentialStore(storage: storage);
      final profile = _profile(profileId: 'work');
      final key = _credentialKey(profile.endpointKey);

      for (final damaged in <String>[
        '{',
        jsonEncode(<String, Object>{'deviceId': 'device'}),
        jsonEncode(<String, Object>{
          'deviceId': 'device',
          'deviceToken': 'token',
          'unexpected': true,
        }),
        jsonEncode(<String, Object>{'deviceId': 7, 'deviceToken': 'token'}),
        jsonEncode(<String, Object>{'deviceId': '', 'deviceToken': 'token'}),
      ]) {
        storage.values[key] = damaged;
        await expectLater(store.read(profile), throwsFormatException);
      }
      expect(storage.values, contains(key));
    });

    test('deletes only the selected endpoint credentials', () async {
      final storage = _MemoryCredentialStorage();
      final store = SecureHostCredentialStore(storage: storage);
      final first = _profile(profileId: 'first');
      final second = _profile(profileId: 'second');
      await store.write(first, _credentials('first-device'));
      await store.write(second, _credentials('second-device'));

      await store.delete(first);

      expect(await store.read(first), isNull);
      expect((await store.read(second))!.deviceId, 'second-device');
    });

    test(
      'migrates the default origin key within the same secure-storage backend',
      () async {
        final storage = _MemoryCredentialStorage();
        final store = SecureHostCredentialStore(storage: storage);
        final profile = _profile();
        final legacyKey = _credentialKey(profile.origin);
        final currentKey = _credentialKey(profile.endpointKey);
        storage.values[legacyKey] = jsonEncode(<String, String>{
          'deviceId': 'legacy-device',
          'deviceToken': 'legacy-token',
        });

        final restored = await store.read(profile);

        expect(restored!.deviceId, 'legacy-device');
        expect(jsonDecode(storage.values[currentKey]!), <String, Object?>{
          'deviceId': 'legacy-device',
          'deviceToken': 'legacy-token',
        });
        expect(storage.values, isNot(contains(legacyKey)));
        expect(storage.deletedKeys, contains(legacyKey));
      },
    );

    test('keeps the legacy key when migration write fails', () async {
      final storage = _MemoryCredentialStorage();
      final store = SecureHostCredentialStore(storage: storage);
      final profile = _profile();
      final legacyKey = _credentialKey(profile.origin);
      final currentKey = _credentialKey(profile.endpointKey);
      storage.values[legacyKey] = jsonEncode(<String, String>{
        'deviceId': 'legacy-device',
        'deviceToken': 'legacy-token',
      });
      storage.failingWriteKey = currentKey;

      await expectLater(store.read(profile), throwsStateError);

      expect(storage.values, contains(legacyKey));
      expect(storage.values, isNot(contains(currentKey)));
      expect(storage.deletedKeys, isNot(contains(legacyKey)));
    });

    test('does not use an origin fallback for named profiles', () async {
      final storage = _MemoryCredentialStorage();
      final store = SecureHostCredentialStore(storage: storage);
      final profile = _profile(profileId: 'work');
      storage.values[_credentialKey(profile.origin)] = jsonEncode(
        <String, String>{
          'deviceId': 'legacy-device',
          'deviceToken': 'legacy-token',
        },
      );

      expect(await store.read(profile), isNull);
    });
  });
}

HostProfile _profile({String profileId = defaultHostProfileId}) =>
    HostProfile.parseTailnetAddress(
      'https://workstation.example.ts.net',
      profileId: profileId,
    );

DeviceCredentials _credentials(String deviceId) =>
    DeviceCredentials(deviceId: deviceId, deviceToken: 'device-token');

String _credentialKey(String hostKey) =>
    't4-code:device-credentials:v1:'
    '${base64Url.encode(utf8.encode(hostKey)).replaceAll('=', '')}';

final class _MemoryPreferences implements HostDirectoryPreferences {
  final Map<String, String> values = <String, String>{};
  final List<String> removedKeys = <String>[];

  @override
  Future<String?> getString(String key) async => values[key];

  @override
  Future<void> setString(String key, String value) async {
    values[key] = value;
  }

  @override
  Future<void> remove(String key) async {
    removedKeys.add(key);
    values.remove(key);
  }
}

final class _MemoryCredentialStorage implements HostCredentialStorage {
  final Map<String, String> values = <String, String>{};
  final List<String> deletedKeys = <String>[];
  String? failingWriteKey;

  @override
  Future<String?> read(String key) async => values[key];

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
