import 'package:web_socket_channel/web_socket_channel.dart';

Future<WebSocketChannel> connectPlatformWebSocket(Uri endpoint) =>
    Future<WebSocketChannel>.error(
      UnsupportedError('WebSocket transport is unavailable on this platform.'),
    );
