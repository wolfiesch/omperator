import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'host_profile.dart';

const String hostDirectoryStorageKey = 't4-code:mobile-backends:v3';
const String _credentialStoragePrefix = 't4-code:device-credentials:v1:';

abstract interface class HostDirectoryPreferences {
  Future<String?> getString(String key);

  Future<void> setString(String key, String value);

  Future<void> remove(String key);
}

abstract interface class HostCredentialStorage {
  Future<String?> read(String key);

  Future<void> write(String key, String value);

  Future<void> delete(String key);
}

abstract interface class LegacyHostCredentialSource {
  Future<LegacyHostCredentials?> discover({
    required List<String> hostKeys,
    required bool includeUnkeyed,
  });

  Future<void> clear(String source);
}

final class LegacyHostCredentials {
  const LegacyHostCredentials({
    required this.deviceId,
    required this.deviceToken,
    required this.source,
  });

  final String deviceId;
  final String deviceToken;
  final String source;
}

final class PersistentHostDirectoryStore implements HostDirectoryStore {
  PersistentHostDirectoryStore({HostDirectoryPreferences? preferences})
    : _preferences = preferences ?? _SharedPreferencesAdapter();

  final HostDirectoryPreferences _preferences;

  @override
  Future<HostDirectory> load() async {
    final encoded = await _preferences.getString(hostDirectoryStorageKey);
    if (encoded == null) return const HostDirectory.empty();
    return HostDirectory.fromJson(jsonDecode(encoded));
  }

  @override
  Future<void> save(HostDirectory directory) {
    if (directory.profiles.isEmpty) {
      return _preferences.remove(hostDirectoryStorageKey);
    }
    return _preferences.setString(
      hostDirectoryStorageKey,
      jsonEncode(directory.toJson()),
    );
  }
}

/// Process-local credentials for unsigned macOS development builds.
///
/// Values are intentionally lost when the app exits and never cross into a
/// platform channel or persistent store.
final class VolatileHostCredentialStore implements HostCredentialStore {
  final Map<String, DeviceCredentials> _credentials =
      <String, DeviceCredentials>{};

  @override
  Future<DeviceCredentials?> read(HostProfile profile) async =>
      _credentials[profile.endpointKey];

  @override
  Future<void> write(HostProfile profile, DeviceCredentials credentials) async {
    _credentials[profile.endpointKey] = credentials;
  }

  @override
  Future<void> delete(HostProfile profile) async {
    _credentials.remove(profile.endpointKey);
  }
}

final class SecureHostCredentialStore implements HostCredentialStore {
  SecureHostCredentialStore({
    HostCredentialStorage? storage,
    LegacyHostCredentialSource? legacySource,
  }) : _storage = storage ?? _FlutterSecureStorageAdapter(),
       _legacySource =
           legacySource ??
           (storage == null
               ? const _MethodChannelLegacyCredentialSource()
               : const _AbsentLegacyCredentialSource());

  final HostCredentialStorage _storage;
  final LegacyHostCredentialSource _legacySource;

  @override
  Future<DeviceCredentials?> read(HostProfile profile) async {
    final currentKey = _credentialKey(profile.endpointKey);
    final current = await _storage.read(currentKey);
    if (current != null) return _decodeCredentials(current);

    if (profile.profileId == defaultHostProfileId) {
      final originKey = _credentialKey(profile.origin);
      final origin = await _storage.read(originKey);
      if (origin != null) {
        final credentials = _decodeCredentials(origin);
        await _migrate(
          currentKey,
          credentials,
          () => _storage.delete(originKey),
        );
        return credentials;
      }
    }

    final isDefault = profile.profileId == defaultHostProfileId;
    final legacy = await _legacySource.discover(
      hostKeys: <String>[profile.endpointKey, if (isDefault) profile.origin],
      includeUnkeyed: isDefault,
    );
    if (legacy == null) return null;
    final credentials = DeviceCredentials(
      deviceId: legacy.deviceId,
      deviceToken: legacy.deviceToken,
    );
    await _migrate(
      currentKey,
      credentials,
      () => _legacySource.clear(legacy.source),
    );
    return credentials;
  }

  Future<void> _migrate(
    String currentKey,
    DeviceCredentials credentials,
    Future<void> Function() clearLegacy,
  ) async {
    await _storage.write(currentKey, _encodeCredentials(credentials));
    try {
      await clearLegacy();
    } catch (error, stackTrace) {
      try {
        await _storage.delete(currentKey);
      } catch (_) {
        // Preserve the clear failure that explains why migration did not commit.
      }
      Error.throwWithStackTrace(error, stackTrace);
    }
  }

  @override
  Future<void> write(HostProfile profile, DeviceCredentials credentials) async {
    await _storage.write(
      _credentialKey(profile.endpointKey),
      _encodeCredentials(credentials),
    );
    if (profile.profileId == defaultHostProfileId) {
      await _storage.delete(_credentialKey(profile.origin));
    }
  }

  @override
  Future<void> delete(HostProfile profile) async {
    await _storage.delete(_credentialKey(profile.endpointKey));
    if (profile.profileId == defaultHostProfileId) {
      await _storage.delete(_credentialKey(profile.origin));
    }
  }
}

final class _SharedPreferencesAdapter implements HostDirectoryPreferences {
  _SharedPreferencesAdapter() : _preferences = SharedPreferencesAsync();

  final SharedPreferencesAsync _preferences;

  @override
  Future<String?> getString(String key) => _preferences.getString(key);

  @override
  Future<void> setString(String key, String value) =>
      _preferences.setString(key, value);

  @override
  Future<void> remove(String key) => _preferences.remove(key);
}

final class _FlutterSecureStorageAdapter implements HostCredentialStorage {
  _FlutterSecureStorageAdapter() : _storage = const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) =>
      _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}

final class _AbsentLegacyCredentialSource
    implements LegacyHostCredentialSource {
  const _AbsentLegacyCredentialSource();

  @override
  Future<LegacyHostCredentials?> discover({
    required List<String> hostKeys,
    required bool includeUnkeyed,
  }) async => null;

  @override
  Future<void> clear(String source) async {}
}

final class _MethodChannelLegacyCredentialSource
    implements LegacyHostCredentialSource {
  const _MethodChannelLegacyCredentialSource();

  static const MethodChannel _channel = MethodChannel(
    'com.lycaonsolutions.t4code/legacy_credentials',
  );

  @override
  Future<LegacyHostCredentials?> discover({
    required List<String> hostKeys,
    required bool includeUnkeyed,
  }) async {
    Map<Object?, Object?>? value;
    try {
      value = await _channel.invokeMapMethod<Object?, Object?>(
        'discoverCredentials',
        <String, Object>{
          'hostKeys': hostKeys,
          'includeUnkeyed': includeUnkeyed,
        },
      );
    } on MissingPluginException {
      return null;
    }
    if (value == null) return null;
    if (value.length != 3 ||
        value['deviceId'] is! String ||
        value['deviceToken'] is! String ||
        value['source'] is! String) {
      throw const FormatException('The legacy device credentials are damaged.');
    }
    final source = value['source']! as String;
    if (source.isEmpty ||
        source.length > 256 ||
        source.codeUnits.any((code) => code <= 0x1f || code == 0x7f)) {
      throw const FormatException('The legacy device credentials are damaged.');
    }
    return LegacyHostCredentials(
      deviceId: value['deviceId']! as String,
      deviceToken: value['deviceToken']! as String,
      source: source,
    );
  }

  @override
  Future<void> clear(String source) => _channel.invokeMethod<void>(
    'clearCredentials',
    <String, String>{'source': source},
  );
}

String _credentialKey(String hostKey) {
  final encodedHostKey = base64Url
      .encode(utf8.encode(hostKey))
      .replaceAll('=', '');
  return '$_credentialStoragePrefix$encodedHostKey';
}

String _encodeCredentials(DeviceCredentials credentials) =>
    jsonEncode(<String, String>{
      'deviceId': credentials.deviceId,
      'deviceToken': credentials.deviceToken,
    });

DeviceCredentials _decodeCredentials(String encoded) {
  final value = jsonDecode(encoded);
  if (value is! Map<String, Object?> ||
      value.length != 2 ||
      value['deviceId'] is! String ||
      value['deviceToken'] is! String) {
    throw const FormatException('The saved device credentials are damaged.');
  }
  return DeviceCredentials(
    deviceId: value['deviceId']! as String,
    deviceToken: value['deviceToken']! as String,
  );
}
