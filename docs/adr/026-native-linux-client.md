# ADR 026: Native Linux client (pure GTK4)

- Status: accepted; under construction; not shipped.

## Context

The native Swift app in `apps/ios/` (one SwiftUI source tree for iOS + macOS,
per ADR 020) has no Linux build: SwiftUI is Apple-only and never compiles on
Linux. Electron + the canonical React renderer remains the desktop product
(ADR 020), including its existing Linux deb/AppImage release leg.

A maintainer decision: build a native Linux client that matches the macOS
Swift app 1:1 in appearance and function. Swift on Linux keeps the lineage —
the `HostWire` protocol port (`omp-app/1`) and the Combine-backed
`T4SessionStore` — rather than paying a second wire port in another language.

## Decision

The Linux client lives in `apps/linux/` as a SwiftPM package:

- UI: **pure GTK4**, imperative widgets through a thin C shim
  (`CT4Gtk`, pkg-config `gtk4`). The original SwiftCrossUI
  (`moreSwift/swift-cross-ui` on the GtkBackend) view layer was removed
  during construction: it never shipped and the imperative GTK4 layer it
  seeded became the production surface (window, rail, transcript cards,
  composer, onboarding/settings, mini mode, compositor pinning).
- Store + reactive layer: OpenCombine (1:1 Combine API clone) so
  `T4SessionStore` ports with minimal edits. The SwiftCrossUI observation
  bridge (`T4UIObservation`/`ObservationBridge`) was deleted with the view
  layer; the GTK window drives the store through the public `T4GtkBridge`
  facade on a main-loop refresh tick.
- Wire: the same `HostWire` SwiftPM package (apps/ios/HostWire), shared
  source. Its Linux shims (`os` → stderr logger, `FoundationNetworking`)
  are additive and guarded; the Apple build is untouched.
- Native widget surfaces are GTK4 widgets in `PanesFactory`: WebKitGTK
  (webkitgtk-6.0) for the browser pane, VTE (vte-2.91-gtk4) for the
  terminal pane, libsecret for credentials, libnotify for notifications,
  swift-crypto for the SHA-256 cert-pin fingerprint.
- Themes are bundled CSS (`Sources/T4CodeLinux/themes/`), loaded via
  `Bundle.module` — no absolute paths or runtime file lookup.
- Product role: candidate native Linux companion, same boundary as ADR 020 —
  it never embeds or replaces OMP or `t4-host`; it connects to an existing
  host over the Tailnet route.

This does not change Electron's status as the shipped desktop product. A
Linux release decision (channels, signing, updates) is separate and follows
after parity is proven.

## Verification so far (development only)

- Swift 6.3.3 (UBI9 tarball, rootless install) compiles and runs on CachyOS.
- `HostWire`: `swift build` + `swift test` green on Linux — 21/21, including
  the real wire-fixture corpus from `packages/host-wire/fixtures/v1`.
- `apps/linux` builds and opens a GTK window (verified by launch + window
  enumeration; visual verification requires a vision-capable session).
- **Store layer**: the shared `T4SessionStore` + domain models
  (`T4CodeLinuxLib/Store/`) compile on Linux with guarded imports
  (SwiftUI/Combine/CryptoKit/os → canImport branches). Zero Apple behavior
  change. The executable reaches it only through `T4GtkBridge`.
- **Wire transport**: FoundationNetworking's WebSocket is unusable on distro
  libcurl ("WebSockets not supported by libcurl"), so the Linux client ships
  `LinuxWebSocketTransport` — a compact RFC 6455 client (TCP + masking +
  framing + ping/pong/close) behind HostWire's `HostWireTransport` seam.
  `wss://` is not yet implemented (clear error; ws:// inside the Tailnet is
  the supported route, matching the Android/web clients).
- **Live smoke test**: app ↔ fixture-server (packages/fixture-server,
  scenario basic-v1) — hello/welcome, catalog.get, session.attach, snapshot
  + transcript entry streaming, graceful bye all work end to end; the window
  renders the session inventory from the live host (histogram-verified:
  theme bg #FAF4ED, rail #FFFAF3, ink text #575279).
- OpenCombine 0.14 gap: no Merge/MergeMany — the store's objectWillChange
  merge chain is supplied by a Linux-only `Publishers.Merge` compat in
  Compat.swift (unit-verified, incl. the 6-way chain shape).

## Identity

- **Rosé Pine**: dark = Rosé Pine Moon, light = Rosé Pine Dawn. The gold
  "voice" (terminal/live accent) is the identity line across both modes.
- **Selection is highlighted text**, never rounded pills.
- **VT323 terminal voice**: fontconfig `monospace` alias + explicit
  `vte_terminal_set_font("VT323 14")`.
- **No mid-word wraps** on short structural labels.
- **Accent edge**: a 3px accent stripe anchors the rail's left edge.
- **Package layout**: `T4CodeLinuxLib` library (testable) + `T4CodeLinux`
  pure-GTK4 executable, so SwiftPM test targets can import the store.

Tests: 13/13 across 4 suites (fixture wire integration, store prompt flow,
keychain, Merge compat) + HostWire 21/21. Tests spawn the fixture server
headless; no display needed.

## Remaining work (visual verification)

The GTK4 surface is the production UI. What remains is visual polish +
verification, which needs a vision-capable session:

- Visual parity is structural-only. `LINUX-GAP:` comments mark every
  macOS-only construct (animations, context menus, custom fonts,
  PhotosPicker/dictation attachments).
- Theme glass materials are GTK background/overlay approximations.
- Native panes are **integrated, not stubbed**: `PanesFactory` builds the
  real VTE terminal (commit-signal input + char-size resize) and the full
  WebKitGTK pane (back/forward/reload + notify::uri/is-loading signals).
- The VTE echo round-trip (type → host echo → render) is driven end-to-end
  through the real pane keyboard path (VTE keyboard capture is hard to
  drive via xdotool).
- Windows/macOS (Linux-GAP) behavior I cannot verify without a vision
  session: all structural ports need a pixel-level parity review against
  the macOS app.
