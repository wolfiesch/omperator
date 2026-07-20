import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter/foundation.dart';

import 'src/client/app_state.dart';
import 'src/client/t4_client_controller.dart';
import 'src/host/app_preferences.dart';
import 'src/host/persistent_host_stores.dart';
import 'src/platform/platform_lifecycle_controller.dart';
import 'src/ui/t4_app.dart';

void main() {
  runApp(T4Bootstrap(developmentEndpoint: _developmentEndpoint()));
}

Uri? _developmentEndpoint() {
  const configured = String.fromEnvironment('T4_DEVELOPMENT_ENDPOINT');
  if (configured.isEmpty) return null;
  final endpoint = Uri.tryParse(configured);
  if (endpoint == null ||
      (endpoint.scheme != 'ws' && endpoint.scheme != 'wss')) {
    return null;
  }
  return endpoint;
}

final class T4Bootstrap extends StatefulWidget {
  const T4Bootstrap({this.developmentEndpoint, super.key});

  final Uri? developmentEndpoint;

  @override
  State<T4Bootstrap> createState() => _T4BootstrapState();
}

final class _T4BootstrapState extends State<T4Bootstrap>
    with WidgetsBindingObserver {
  late final T4ClientController _controller;
  late final PlatformLifecycleController _platformController;
  late final bool _credentialsAreVolatile;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _credentialsAreVolatile =
        kDebugMode && defaultTargetPlatform == TargetPlatform.macOS;
    _controller = T4ClientController(
      hostDirectoryStore: PersistentHostDirectoryStore(),
      hostCredentialStore: _credentialsAreVolatile
          ? VolatileHostCredentialStore()
          : SecureHostCredentialStore(),
      appPreferenceStore: PersistentAppPreferenceStore(),
      developmentEndpoint: widget.developmentEndpoint,
    );
    _platformController = PlatformLifecycleController();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(_controller.initialize());
      unawaited(_platformController.initialize());
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.resumed:
        unawaited(_controller.handleLifecyclePhase(T4LifecyclePhase.resumed));
        unawaited(_platformController.refreshPlatformState());
      case AppLifecycleState.hidden:
      case AppLifecycleState.paused:
      case AppLifecycleState.detached:
        unawaited(
          _controller.handleLifecyclePhase(T4LifecyclePhase.background),
        );
      case AppLifecycleState.inactive:
        break;
    }
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: Listenable.merge(<Listenable>[
        _controller,
        _platformController,
      ]),
      builder: (context, _) => T4App(
        state: _controller.state,
        actions: _controller,
        credentialsAreVolatile: _credentialsAreVolatile,
        platformState: _platformController.state,
        platformActions: _platformController,
      ),
    );
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _controller.dispose();
    _platformController.dispose();
    super.dispose();
  }
}
