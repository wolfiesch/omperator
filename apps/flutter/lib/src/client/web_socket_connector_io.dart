import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

Future<WebSocketChannel> connectPlatformWebSocket(Uri endpoint) async =>
    IOWebSocketChannel.connect(
      endpoint,
      headers: const <String, String>{'Origin': 'https://localhost'},
    );
