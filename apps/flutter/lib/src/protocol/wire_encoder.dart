import 'dart:convert';

import 'models.dart';

const int _maxSafeInteger = 9007199254740991;
const int _maxSavedCursors = 128;

/// Explicit builders for every outbound omp-app/1 top-level frame family.
abstract final class WireEncoder {
  static String hello({
    required ClientIdentity client,
    Iterable<String> requestedFeatures = const <String>[],
    Iterable<SavedCursor> savedCursors = const <SavedCursor>[],
    Iterable<String> capabilities = const <String>[],
    DeviceAuthentication? authentication,
  }) {
    final features = requestedFeatures.toList(growable: false);
    final cursors = savedCursors.toList(growable: false);
    final requestedCapabilities = capabilities.toList(growable: false);
    _boundedStrings(features, 'requestedFeatures', 128);
    _capabilityStrings(requestedCapabilities, 'capabilities');
    if (cursors.length > _maxSavedCursors) {
      throw ArgumentError.value(
        cursors.length,
        'savedCursors',
        'must contain at most $_maxSavedCursors cursors',
      );
    }

    final clientJson = <String, Object?>{
      'name': _controlString(client.name, 'client.name', 128),
      'version': _controlString(client.version, 'client.version', 64),
      'build': _controlString(client.build, 'client.build', 128),
      'platform': _controlString(client.platform, 'client.platform', 128),
    };
    final cursorJson = <Map<String, Object?>>[];
    for (var index = 0; index < cursors.length; index++) {
      final saved = cursors[index];
      cursorJson.add(<String, Object?>{
        'hostId': _id(saved.hostId, 'savedCursors[$index].hostId'),
        'sessionId': _id(saved.sessionId, 'savedCursors[$index].sessionId'),
        'cursor': _cursorJson(saved.cursor, 'savedCursors[$index].cursor'),
      });
    }

    final frame = <String, Object?>{
      'v': ompAppProtocolVersion,
      'type': 'hello',
      'protocol': <String, String>{
        'min': ompAppProtocolVersion,
        'max': ompAppProtocolVersion,
      },
      'client': clientJson,
      'requestedFeatures': features,
      'savedCursors': cursorJson,
      if (requestedCapabilities.isNotEmpty)
        'capabilities': <String, Object?>{'client': requestedCapabilities},
      if (authentication != null)
        'authentication': <String, String>{
          'deviceId': _id(authentication.deviceId, 'authentication.deviceId'),
          'deviceToken': _deviceToken(authentication.deviceToken),
        },
    };
    return jsonEncode(frame);
  }

  static String sessionList({
    required String requestId,
    required String commandId,
    required String hostId,
  }) {
    return command(
      requestId: requestId,
      commandId: commandId,
      hostId: hostId,
      command: 'session.list',
      args: const <String, Object?>{},
    );
  }

  static String hostWatch({
    required String requestId,
    required String commandId,
    required String hostId,
    required SessionIndexCursor cursor,
  }) {
    return command(
      requestId: requestId,
      commandId: commandId,
      hostId: hostId,
      command: 'host.watch',
      args: <String, Object?>{
        'cursor': _sessionIndexCursorJson(cursor, 'cursor'),
      },
    );
  }

  static String sessionAttach({
    required String requestId,
    required String commandId,
    required String hostId,
    required String sessionId,
    TranscriptCursor? cursor,
  }) {
    return command(
      requestId: requestId,
      commandId: commandId,
      hostId: hostId,
      sessionId: sessionId,
      command: 'session.attach',
      args: <String, Object?>{
        if (cursor != null) 'cursor': _cursorJson(cursor, 'cursor'),
      },
    );
  }

  static String sessionPrompt({
    required String requestId,
    required String commandId,
    required String hostId,
    required String sessionId,
    required String expectedRevision,
    required String text,
    List<String> imageIds = const <String>[],
  }) {
    if (imageIds.length > 8) {
      throw ArgumentError.value(imageIds.length, 'imageIds', 'maximum is 8');
    }
    if (text.isEmpty && imageIds.isEmpty) {
      throw ArgumentError.value(
        text,
        'text',
        'must not be empty without images',
      );
    }
    return command(
      requestId: requestId,
      commandId: commandId,
      hostId: hostId,
      sessionId: sessionId,
      command: 'session.prompt',
      expectedRevision: _id(expectedRevision, 'expectedRevision'),
      args: <String, Object?>{
        'message': _boundedText(text, 'text', 65536),
        if (imageIds.isNotEmpty)
          'images': <Map<String, String>>[
            for (final imageId in imageIds)
              <String, String>{'imageId': _id(imageId, 'imageId')},
          ],
      },
    );
  }

  /// Encodes the package-level command envelope for every pinned command.
  ///
  /// The command descriptor's host/session scope, revision policy, and
  /// confirmation policy are enforced here. Command-specific argument
  /// convenience methods may add narrower validation.
  static String command({
    required String requestId,
    required String commandId,
    required String hostId,
    required String command,
    required Map<String, Object?> args,
    String? sessionId,
    String? expectedRevision,
    String? confirmationId,
  }) {
    if (!_knownCommands.contains(command)) {
      throw ArgumentError.value(command, 'command', 'is not a pinned command');
    }
    final hostScoped = _hostCommands.contains(command);
    if (hostScoped && sessionId != null) {
      throw ArgumentError.value(
        sessionId,
        'sessionId',
        'is forbidden for a host command',
      );
    }
    if (!hostScoped && sessionId == null) {
      throw ArgumentError.notNull('sessionId');
    }
    if (_noRevisionCommands.contains(command) && expectedRevision != null) {
      throw ArgumentError.value(
        expectedRevision,
        'expectedRevision',
        'is forbidden for this command',
      );
    }
    if (_requiredRevisionCommands.contains(command) &&
        expectedRevision == null) {
      throw ArgumentError.notNull('expectedRevision');
    }
    if (!_confirmationCommands.contains(command) && confirmationId != null) {
      throw ArgumentError.value(
        confirmationId,
        'confirmationId',
        'is forbidden for this command',
      );
    }
    return jsonEncode(<String, Object?>{
      'v': ompAppProtocolVersion,
      'type': 'command',
      'requestId': _id(requestId, 'requestId'),
      'commandId': _id(commandId, 'commandId'),
      'hostId': _id(hostId, 'hostId'),
      if (sessionId != null) 'sessionId': _id(sessionId, 'sessionId'),
      'command': command,
      if (expectedRevision != null)
        'expectedRevision': _id(expectedRevision, 'expectedRevision'),
      if (confirmationId != null)
        'confirmationId': _id(confirmationId, 'confirmationId'),
      'args': args,
    });
  }

  static String confirm({
    required String requestId,
    required String confirmationId,
    required String commandId,
    required String hostId,
    required String decision,
    String? sessionId,
  }) {
    if (decision != 'approve' && decision != 'deny') {
      throw ArgumentError.value(
        decision,
        'decision',
        'must be approve or deny',
      );
    }
    return jsonEncode(<String, Object?>{
      'v': ompAppProtocolVersion,
      'type': 'confirm',
      'requestId': _id(requestId, 'requestId'),
      'confirmationId': _id(confirmationId, 'confirmationId'),
      'commandId': _id(commandId, 'commandId'),
      'hostId': _id(hostId, 'hostId'),
      if (sessionId != null) 'sessionId': _id(sessionId, 'sessionId'),
      'decision': decision,
    });
  }

  static String pairStart({
    required String requestId,
    required String code,
    required String deviceId,
    required String deviceName,
    required String platform,
    Iterable<String> requestedCapabilities = const <String>[],
  }) {
    if (!RegExp(r'^\d{6}$').hasMatch(code)) {
      throw ArgumentError.value(code, 'code', 'must be exactly six digits');
    }
    final capabilities = requestedCapabilities.toList(growable: false);
    _capabilityStrings(capabilities, 'requestedCapabilities');
    return jsonEncode(<String, Object?>{
      'v': ompAppProtocolVersion,
      'type': 'pair.start',
      'requestId': _id(requestId, 'requestId'),
      'code': code,
      'deviceId': _id(deviceId, 'deviceId'),
      'deviceName': _controlString(deviceName, 'deviceName', 256),
      'platform': _controlString(platform, 'platform', 128),
      'requestedCapabilities': capabilities,
    });
  }

  static String terminalInput({
    required String hostId,
    required String sessionId,
    required String terminalId,
    required String data,
    String? encoding,
  }) {
    if (encoding != null && encoding != 'utf8' && encoding != 'base64') {
      throw ArgumentError.value(encoding, 'encoding', 'must be utf8 or base64');
    }
    final payload = encoding == 'base64'
        ? _base64(data, 'data', 256000)
        : _boundedText(data, 'data', 256000);
    return jsonEncode(<String, Object?>{
      'v': ompAppProtocolVersion,
      'type': 'terminal.input',
      'hostId': _id(hostId, 'hostId'),
      'sessionId': _id(sessionId, 'sessionId'),
      'terminalId': _id(terminalId, 'terminalId'),
      'data': payload,
      'encoding': ?encoding,
    });
  }

  static String terminalResize({
    required String hostId,
    required String sessionId,
    required String terminalId,
    required int cols,
    required int rows,
  }) {
    if (cols < 1 || cols > 1000) {
      throw ArgumentError.value(cols, 'cols', 'must be between 1 and 1000');
    }
    if (rows < 1 || rows > 500) {
      throw ArgumentError.value(rows, 'rows', 'must be between 1 and 500');
    }
    return jsonEncode(<String, Object?>{
      'v': ompAppProtocolVersion,
      'type': 'terminal.resize',
      'hostId': _id(hostId, 'hostId'),
      'sessionId': _id(sessionId, 'sessionId'),
      'terminalId': _id(terminalId, 'terminalId'),
      'cols': cols,
      'rows': rows,
    });
  }

  static String terminalClose({
    required String hostId,
    required String sessionId,
    required String terminalId,
    String? reason,
  }) {
    return jsonEncode(<String, Object?>{
      'v': ompAppProtocolVersion,
      'type': 'terminal.close',
      'hostId': _id(hostId, 'hostId'),
      'sessionId': _id(sessionId, 'sessionId'),
      'terminalId': _id(terminalId, 'terminalId'),
      if (reason != null) 'reason': _controlString(reason, 'reason', 256),
    });
  }

  static String ping({required String nonce, required String timestamp}) {
    return jsonEncode(<String, Object?>{
      'v': ompAppProtocolVersion,
      'type': 'ping',
      'nonce': _controlString(nonce, 'nonce', 128),
      'timestamp': _controlString(timestamp, 'timestamp', 128),
    });
  }
}

const Set<String> _knownCommands = {
  'host.list',
  'session.list',
  'transcript.search',
  'transcript.context',
  'transcript.page',
  'session.create',
  'session.attach',
  'session.prompt',
  'session.image.begin',
  'session.image.chunk',
  'session.image.discard',
  'session.image.read',
  'session.state.get',
  'session.steer',
  'session.followUp',
  'session.rename',
  'session.retry',
  'session.compact',
  'session.pause',
  'session.resume',
  'session.archive',
  'session.restore',
  'session.delete',
  'session.model.set',
  'session.thinking.set',
  'session.fast.set',
  'session.ui.respond',
  'session.cancel',
  'session.close',
  'files.read',
  'files.write',
  'files.patch',
  'files.list',
  'files.diff',
  'review.read',
  'review.apply',
  'agent.cancel',
  'bash.run',
  'term.open',
  'audit.read',
  'audit.tail',
  'config.write',
  'settings.read',
  'settings.write',
  'catalog.get',
  'broker.status',
  'usage.read',
  'host.watch',
  'session.watch',
  'controller.lease.acquire',
  'controller.lease.renew',
  'controller.lease.release',
  'prompt.lease.acquire',
  'prompt.lease.renew',
  'prompt.lease.release',
  'preview.launch',
  'preview.state',
  'preview.activate',
  'preview.navigate',
  'preview.back',
  'preview.forward',
  'preview.reload',
  'preview.close',
  'preview.capture',
  'preview.capture.read',
  'preview.click',
  'preview.fill',
  'preview.scroll',
  'preview.type',
  'preview.select',
  'preview.press',
  'preview.upload',
  'preview.policy.check',
  'preview.lease.acquire',
  'preview.lease.renew',
  'preview.lease.release',
  'preview.handoff',
};

const Set<String> _hostCommands = {
  'host.list',
  'session.list',
  'transcript.search',
  'session.create',
  'audit.read',
  'audit.tail',
  'settings.read',
  'catalog.get',
  'broker.status',
  'usage.read',
  'host.watch',
  'config.write',
  'settings.write',
};

const Set<String> _noRevisionCommands = {
  'host.list',
  'session.list',
  'transcript.search',
  'session.create',
  'audit.read',
  'audit.tail',
  'settings.read',
  'catalog.get',
  'broker.status',
  'usage.read',
  'host.watch',
  'transcript.context',
  'transcript.page',
  'session.attach',
  'session.image.begin',
  'session.image.chunk',
  'session.image.discard',
  'session.image.read',
  'session.state.get',
  'session.watch',
  'preview.capture.read',
  'preview.policy.check',
};

const Set<String> _requiredRevisionCommands = {
  'session.rename',
  'session.retry',
  'session.compact',
  'session.pause',
  'session.resume',
  'session.archive',
  'session.restore',
  'session.model.set',
  'session.thinking.set',
  'session.fast.set',
  'controller.lease.acquire',
  'controller.lease.renew',
  'controller.lease.release',
  'prompt.lease.acquire',
  'prompt.lease.renew',
  'prompt.lease.release',
  'session.delete',
  'session.close',
  'files.write',
  'files.patch',
  'review.apply',
  'config.write',
  'settings.write',
};

const Set<String> _confirmationCommands = {
  'session.delete',
  'session.close',
  'files.write',
  'files.patch',
  'review.apply',
  'session.cancel',
  'agent.cancel',
  'bash.run',
  'term.open',
  'preview.launch',
  'preview.navigate',
  'preview.upload',
  'config.write',
  'settings.write',
};

const Set<String> _deviceCapabilities = {
  'sessions.read',
  'sessions.prompt',
  'sessions.control',
  'sessions.manage',
  'bash.run',
  'term.open',
  'term.input',
  'term.resize',
  'files.read',
  'files.write',
  'files.list',
  'files.diff',
  'agents.control',
  'audit.read',
  'config.read',
  'catalog.read',
  'config.write',
  'broker.read',
  'usage.read',
  'preview.read',
  'preview.control',
  'preview.input',
};

Map<String, Object?> _cursorJson(TranscriptCursor cursor, String path) {
  if (cursor.seq < 0 || cursor.seq > _maxSafeInteger) {
    throw ArgumentError.value(
      cursor.seq,
      '$path.seq',
      'must be a safe nonnegative integer',
    );
  }
  return <String, Object?>{
    'epoch': _controlString(cursor.epoch, '$path.epoch', 128),
    'seq': cursor.seq,
  };
}

Map<String, Object?> _sessionIndexCursorJson(
  SessionIndexCursor cursor,
  String path,
) {
  if (cursor.seq < 0 || cursor.seq > _maxSafeInteger) {
    throw ArgumentError.value(
      cursor.seq,
      '$path.seq',
      'must be a safe nonnegative integer',
    );
  }
  return <String, Object?>{
    'epoch': _controlString(cursor.epoch, '$path.epoch', 128),
    'seq': cursor.seq,
  };
}

void _boundedStrings(List<String> values, String path, int maxItems) {
  if (values.length > maxItems) {
    throw ArgumentError.value(
      values.length,
      path,
      'must contain at most $maxItems values',
    );
  }
  for (var index = 0; index < values.length; index++) {
    _controlString(values[index], '$path[$index]', 256);
  }
}

void _capabilityStrings(List<String> values, String path) {
  _boundedStrings(values, path, 128);
  for (var index = 0; index < values.length; index++) {
    if (!_deviceCapabilities.contains(values[index])) {
      throw ArgumentError.value(
        values[index],
        '$path[$index]',
        'is not a pinned device capability',
      );
    }
  }
}

String _base64(String value, String path, int maxDecodedBytes) {
  _boundedText(value, path, ((maxDecodedBytes * 4) / 3).ceil() + 4);
  final valid = RegExp(
    r'^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$',
  );
  if (value.length % 4 != 0 || !valid.hasMatch(value)) {
    throw ArgumentError.value(value, path, 'must be canonical base64');
  }
  late final List<int> decoded;
  try {
    decoded = base64.decode(value);
  } on FormatException {
    throw ArgumentError.value(value, path, 'must be canonical base64');
  }
  if (decoded.length > maxDecodedBytes) {
    throw ArgumentError.value(value, path, 'decoded payload exceeds limit');
  }
  return value;
}

String _id(String value, String path) => _controlString(value, path, 256);

String _deviceToken(String value) {
  final canonical = RegExp(r'^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$');
  if (!canonical.hasMatch(value)) {
    throw ArgumentError.value(
      value,
      'authentication.deviceToken',
      'must be canonical base64url for exactly 32 bytes',
    );
  }
  return value;
}

String _controlString(String value, String path, int maxBytes) {
  if (value.isEmpty ||
      !_utf8LengthAtMost(value, maxBytes) ||
      _hasControlCharacter(value)) {
    throw ArgumentError.value(
      value,
      path,
      'must be a bounded non-empty string',
    );
  }
  return value;
}

String _boundedText(String value, String path, int maxBytes) {
  if (!_utf8LengthAtMost(value, maxBytes)) {
    throw ArgumentError.value(value, path, 'exceeds the UTF-8 byte limit');
  }
  return value;
}

bool _hasControlCharacter(String value) {
  for (final codeUnit in value.codeUnits) {
    if (codeUnit <= 0x1f || codeUnit == 0x7f) {
      return true;
    }
  }
  return false;
}

bool _utf8LengthAtMost(String value, int maximum) {
  var bytes = 0;
  for (var index = 0; index < value.length; index++) {
    final codeUnit = value.codeUnitAt(index);
    if (codeUnit <= 0x7f) {
      bytes++;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 < value.length) {
        final next = value.codeUnitAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          index++;
        } else {
          bytes += 3;
        }
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > maximum) {
      return false;
    }
  }
  return true;
}
