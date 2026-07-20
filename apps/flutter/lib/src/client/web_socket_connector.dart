import 'package:web_socket_channel/web_socket_channel.dart';

import 'web_socket_connector_stub.dart'
    if (dart.library.io) 'web_socket_connector_io.dart'
    if (dart.library.html) 'web_socket_connector_web.dart'
    as platform;

typedef WebSocketConnector = Future<WebSocketChannel> Function(Uri endpoint);

Future<WebSocketChannel> connectPlatformWebSocket(Uri endpoint) =>
    platform.connectPlatformWebSocket(endpoint);
