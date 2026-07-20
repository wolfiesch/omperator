# T4 Code Flutter client

Native Android, iOS, and macOS client for an OMP `omp-app/1` host. The Flutter
shell owns the responsive UI and typed wire projection; platform channels are
limited to credentials, lifecycle, runtime-service management, and signed
application updates.

## Run and verify

From this directory:

```sh
flutter run -d android
flutter run -d ios
pnpm --dir ../.. dev:flutter -- -d macos
flutter test
flutter analyze
flutter test integration_test/app_smoke_test.dart -d <device-id>
```

`--dart-define=T4_DEVELOPMENT_ENDPOINT=wss://…` connects an unsigned development
build directly to a host. Development credentials are intentionally volatile.
Release builds use platform secure storage.

The device smoke harness launches the real native shell, waits for persistent
storage and platform initialization, and opens host management. CI runs it on
an Android emulator and an iOS simulator; local device IDs come from
`flutter devices`.

## Platform lifecycle

- Android reports foreground/resume events and performs user-driven updates
  only after validating the canonical T4 manifest, APK package, version, and
  signer.
- iOS uses the Flutter lifecycle and App Store-managed updates.
- macOS bundles the standalone `t4-host`, manages its per-user LaunchAgent,
  connects it to OMP's authority bridge, and validates canonical signed DMG
  updates before opening the installer.

The Settings surface is generated from host `catalog.get` and `settings.read`
frames. Non-secret values may be staged and written only with negotiated
capabilities and explicit host confirmation; secret values are never projected
to the client. Diagnostics exports contain a fixed redacted allowlist.

Transcript search uses the bounded `transcript.search` and
`transcript.context` commands. Results expose display-safe snippets and inline
historical context without projecting transcript paths or full session files.

Usage and account status use the bounded `usage.read` and `broker.status`
commands. The client renders provider limits and sanitized broker endpoints;
credentials and unrecognized metadata are rejected at the wire boundary.

The Inbox projects host-reported parent/child agent relationships and live
progress. Active agents can be cancelled only with `agents.control`, the latest
session revision, and the host's correlated confirmation challenge.

Files are edited against host-provided authority revisions. Writes and review
applications use the wire protocol's correlated confirmation challenge.
Preview controls cover navigation, capture, click, fill, type, select, key
press, scroll, upload, and handoff without executing page code in the client.
