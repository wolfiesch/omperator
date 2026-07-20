const int hostProfileSchemaVersion = 3;
const int maximumSavedHosts = 16;
const int maximumHostUrlLength = 2048;
const int maximumHostLabelLength = 128;
const int maximumProfileIdLength = 64;
const int maximumDeviceIdLength = 256;
const int maximumDeviceTokenLength = 512;
const String defaultHostProfileId = 'default';

final RegExp _profileIdPattern = RegExp(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$');

final class HostProfile {
  const HostProfile._({
    required this.endpointKey,
    required this.origin,
    required this.profileId,
    required this.webSocketUrl,
    required this.label,
  });

  factory HostProfile.parseTailnetAddress(
    String value, {
    String profileId = defaultHostProfileId,
  }) {
    final trimmed = value.trim();
    if (trimmed.isEmpty) {
      throw const FormatException(
        'Enter the HTTPS address shown by T4 on your computer.',
      );
    }
    if (trimmed.length > maximumHostUrlLength) {
      throw const FormatException('That address is too long.');
    }

    final normalizedProfileId = normalizeHostProfileId(profileId);
    final candidate = trimmed.contains('://') ? trimmed : 'https://$trimmed';
    final parsed = Uri.tryParse(candidate);
    if (parsed == null || !parsed.hasAuthority || parsed.scheme != 'https') {
      throw const FormatException('Enter a valid HTTPS Tailnet address.');
    }
    if (parsed.userInfo.isNotEmpty) {
      throw const FormatException('The address cannot contain credentials.');
    }
    if ((parsed.path.isNotEmpty && parsed.path != '/') ||
        parsed.hasQuery ||
        parsed.hasFragment) {
      throw const FormatException(
        'Enter the host address only, without a path, query, or fragment.',
      );
    }

    final hostname = parsed.host.toLowerCase();
    if (hostname == 'ts.net' || !hostname.endsWith('.ts.net')) {
      throw const FormatException(
        'Use the full Tailscale hostname ending in .ts.net.',
      );
    }

    final explicitPort = parsed.hasPort && parsed.port != 443
        ? ':${parsed.port}'
        : '';
    final origin = 'https://$hostname$explicitPort';
    final encodedProfileId = Uri.encodeComponent(normalizedProfileId);
    final path = normalizedProfileId == defaultHostProfileId
        ? '/v1/ws'
        : '/v1/profiles/$encodedProfileId/ws';
    final endpointKey = '$origin#profile=$normalizedProfileId';
    final label = 'T4 on ${hostname.substring(0, hostname.indexOf('.'))}';

    return HostProfile._(
      endpointKey: endpointKey,
      origin: origin,
      profileId: normalizedProfileId,
      webSocketUrl: Uri.parse('wss://$hostname$explicitPort$path'),
      label: _boundedText(label, 'host label', maximumHostLabelLength),
    );
  }

  factory HostProfile.fromJson(Object? value) {
    final data = _jsonObject(value, 'saved host');
    if (data['version'] != hostProfileSchemaVersion) {
      throw const FormatException(
        'The saved host is from an unsupported app version.',
      );
    }

    final origin = _boundedText(
      data['origin'],
      'host origin',
      maximumHostUrlLength,
    );
    final profileId = normalizeHostProfileId(
      _boundedText(data['profileId'], 'profile ID', maximumProfileIdLength),
    );
    final canonical = HostProfile.parseTailnetAddress(
      origin,
      profileId: profileId,
    );
    if (data['endpointKey'] != canonical.endpointKey ||
        data['wsUrl'] != canonical.webSocketUrl.toString() ||
        data['label'] != canonical.label) {
      throw const FormatException(
        'The saved host is inconsistent. Add the host again.',
      );
    }
    return canonical;
  }

  final String endpointKey;
  final String origin;
  final String profileId;
  final Uri webSocketUrl;
  final String label;

  Map<String, Object> toJson() => <String, Object>{
    'version': hostProfileSchemaVersion,
    'endpointKey': endpointKey,
    'origin': origin,
    'profileId': profileId,
    'wsUrl': webSocketUrl.toString(),
    'label': label,
  };
}

final class HostDirectory {
  HostDirectory._({
    required List<HostProfile> profiles,
    required this.activeEndpointKey,
  }) : profiles = List<HostProfile>.unmodifiable(profiles);

  const HostDirectory.empty()
    : profiles = const <HostProfile>[],
      activeEndpointKey = null;

  factory HostDirectory.fromJson(Object? value) {
    final data = _jsonObject(value, 'saved host list');
    if (data['version'] != hostProfileSchemaVersion ||
        data['activeEndpointKey'] is! String ||
        data['backends'] is! List<Object?>) {
      throw const FormatException(
        'The saved host list is from an unsupported app version.',
      );
    }

    final rawProfiles = data['backends']! as List<Object?>;
    if (rawProfiles.isEmpty || rawProfiles.length > maximumSavedHosts) {
      throw const FormatException(
        'The saved host list is from an unsupported app version.',
      );
    }
    final profiles = rawProfiles.map(HostProfile.fromJson).toList();
    final keys = profiles.map((profile) => profile.endpointKey).toSet();
    final activeEndpointKey = data['activeEndpointKey']! as String;
    if (keys.length != profiles.length || !keys.contains(activeEndpointKey)) {
      throw const FormatException(
        'The saved host list is inconsistent. Add the host again.',
      );
    }
    return HostDirectory._(
      profiles: profiles,
      activeEndpointKey: activeEndpointKey,
    );
  }

  final List<HostProfile> profiles;
  final String? activeEndpointKey;

  HostProfile? get activeProfile {
    final activeKey = activeEndpointKey;
    if (activeKey == null) return null;
    for (final profile in profiles) {
      if (profile.endpointKey == activeKey) return profile;
    }
    return null;
  }

  HostDirectory upsert(HostProfile profile) {
    final existing = profiles
        .where((candidate) => candidate.endpointKey != profile.endpointKey)
        .toList();
    if (existing.length >= maximumSavedHosts) {
      throw StateError('This device can save up to 16 T4 hosts.');
    }
    return HostDirectory._(
      profiles: <HostProfile>[...existing, profile],
      activeEndpointKey: profile.endpointKey,
    );
  }

  HostDirectory activate(String endpointKey) {
    if (!profiles.any((profile) => profile.endpointKey == endpointKey)) {
      throw ArgumentError.value(endpointKey, 'endpointKey', 'Unknown host.');
    }
    return HostDirectory._(profiles: profiles, activeEndpointKey: endpointKey);
  }

  HostDirectory remove(String endpointKey) {
    final remaining = profiles
        .where((profile) => profile.endpointKey != endpointKey)
        .toList();
    if (remaining.length == profiles.length) return this;
    final nextActive = activeEndpointKey == endpointKey
        ? (remaining.isEmpty ? null : remaining.first.endpointKey)
        : activeEndpointKey;
    return HostDirectory._(profiles: remaining, activeEndpointKey: nextActive);
  }

  Map<String, Object> toJson() {
    final activeKey = activeEndpointKey;
    if (profiles.isEmpty || activeKey == null) {
      throw StateError('An empty host directory is not persisted.');
    }
    return <String, Object>{
      'version': hostProfileSchemaVersion,
      'activeEndpointKey': activeKey,
      'backends': profiles.map((profile) => profile.toJson()).toList(),
    };
  }
}

final class DeviceCredentials {
  DeviceCredentials({required String deviceId, required String deviceToken})
    : deviceId = _boundedText(deviceId, 'device ID', maximumDeviceIdLength),
      deviceToken = _boundedText(
        deviceToken,
        'device token',
        maximumDeviceTokenLength,
      );

  final String deviceId;
  final String deviceToken;
}

abstract interface class HostDirectoryStore {
  Future<HostDirectory> load();

  Future<void> save(HostDirectory directory);
}

abstract interface class HostCredentialStore {
  Future<DeviceCredentials?> read(HostProfile profile);

  Future<void> write(HostProfile profile, DeviceCredentials credentials);

  Future<void> delete(HostProfile profile);
}

String normalizeHostProfileId(String value) {
  final trimmed = value.trim();
  if (trimmed.isEmpty) return defaultHostProfileId;
  if (trimmed.length > maximumProfileIdLength ||
      !_profileIdPattern.hasMatch(trimmed)) {
    throw const FormatException(
      'Use a profile ID made of ASCII letters, numbers, dot, dash, or underscore.',
    );
  }
  return trimmed;
}

Map<String, Object?> _jsonObject(Object? value, String name) {
  if (value is! Map<Object?, Object?>) {
    throw FormatException('The $name is damaged.');
  }
  final result = <String, Object?>{};
  for (final entry in value.entries) {
    if (entry.key is! String) {
      throw FormatException('The $name is damaged.');
    }
    result[entry.key! as String] = entry.value;
  }
  return result;
}

String _boundedText(Object? value, String name, int maximumLength) {
  if (value is! String ||
      value.isEmpty ||
      value.length > maximumLength ||
      value.codeUnits.any((code) => code <= 0x1f || code == 0x7f)) {
    throw FormatException('Invalid $name.');
  }
  return value;
}
