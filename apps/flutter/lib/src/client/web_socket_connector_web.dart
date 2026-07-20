import 'package:web_socket_channel/html.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

Future<WebSocketChannel> connectPlatformWebSocket(Uri endpoint) async =>
    HtmlWebSocketChannel.connect(endpoint);
