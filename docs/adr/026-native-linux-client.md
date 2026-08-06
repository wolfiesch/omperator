# ADR 026: Native Linux client via SwiftCrossUI (GTK4)

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

The Linux client lives in `apps/linux/` as a SwiftPM executable:

- UI: SwiftCrossUI (`moreSwift/swift-cross-ui`, pinned by revision) on the
  GTK4 backend. Depends on the `GtkBackend` product directly; `DefaultBackend`
  drags the Windows-only WinUIBackend into the build graph on Linux.
- Store + observation: OpenCombine (1:1 Combine API clone) so
  `T4SessionStore` ports with minimal edits; a thin adapter forwards
  `objectWillChange` to SwiftCrossUI's observation publisher.
- Wire: the same `HostWire` SwiftPM package (apps/ios/HostWire), shared
  source. Its Linux shims (`os` → stderr logger, `FoundationNetworking`)
  are additive and guarded; the Apple build is untouched.
- Native widget seams are GTK representables: WebKitGTK (webkitgtk-6.0) for
  the browser pane, VTE (vte-2.91-gtk4) for the terminal pane, libsecret for
  credentials, libnotify for notifications, swift-crypto (or libgcrypt) for
  the SHA-256 cert-pin fingerprint.
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
- `apps/linux` scaffold builds and opens a GTK window (verified by launch +
  window enumeration; visual verification requires a vision-capable session).
- **Store layer**: the shared `T4SessionStore` + domain models (apps/ios
  sources, symlinked into `apps/linux/Sources/T4CodeLinux/Store/`) compile on
  Linux with guarded imports (SwiftUI/Combine/CryptoKit/os → canImport
  branches). Zero Apple behavior change. Observation bridge (OpenCombine
  `objectWillChange` → SwiftCrossUI `Publisher`) proven by unit probe.
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

## Identity (post-parity)

After the structural port, a distinct identity replaced visual-parity pursuit:

- **Rosé Pine**: dark = Rosé Pine Moon, light = Rosé Pine Dawn. The gold
  "voice" (terminal/live accent) is the identity line across both modes.
- **Selection is highlighted text**, never rounded pills — the rail filter
  uses a sharp accent-dim text highlight; select backgrounds elsewhere are
  action buttons (legitimate fill), not select-pills.
- **VT323 terminal voice**: fontconfig `monospace` alias + explicit
  `vte_terminal_set_font("VT323 14")`.
- **No mid-word wraps**: short structural labels use `.lineLimit(1)`;
  SwiftCrossUI's text views use Pango word-char wrap, so this is where
  breaks would otherwise look bad.
- **Accent edge**: a 3px accent stripe anchors the rail's left edge (leading
  HStack child, strict width).
- **Package layout**: `T4CodeLinuxLib` library (testable) + `T4CodeLinux`
  executable, so SwiftPM test targets can import the store/views.

Tests: 12/12 across 4 suites (fixture wire integration, store prompt flow,
keychain, Merge compat) + HostWire 21/21. Tests spawn the fixture server
headless; no display needed. Release build starts in 1.58s (debug 2.89s).

## Remaining work (visual verification)

The view layer is now **ported and integrated**. What remains is visual
polish + verification, which needs a vision-capable session:

- Visual parity is structural-only. `LINUX-GAP:` comments mark every
  macOS-only construct (animations, context menus — replaced with `Menu`,
  scroll-to-bottom, custom fonts, PhotosPicker/dictation attachments).
- Theme glass materials (GlassBG/EtchedBG) are GTK background/overlay
  approximations via `Views/ViewExtras.swift` (`glass`/`etched`/`press`/
  `LiveDot` — single declaration point).
- Native widget seams are **integrated, not stubbed**: the drawer uses the
  real VTE terminal (`Seams/TerminalPane.swift`, commit-signal input +
  char-size resize, runtime-probed against live X); the browser sheet uses
  the full WebKitGTK pane (`Seams/BrowserPane.swift` extended with
  back/forward/reload + notify::uri/is-loading signals, plus
  `Views/T4BrowserPaneView.swift` toolbar + URL field).
- `defaultSize(1280×800)` is honored by GtkBackend (`window.defaultSize = Size`)
  but the window manager applies `_NET_WM_STATE_MAXIMIZED_VERT` on this KDE
  setup, forcing full height — width comes out ~1280 as requested. Not an app
  bug; the size request reaches GTK correctly.
- The VTE echo round-trip (type → host echo → render) is component-probed but
  not driven end-to-end through the real drawer keyboard path (VTE keyboard
  capture is hard to drive via xdotool).
- Windows/macOS (Linux-GAP) behavior I cannot verify without a vision session:
  all structural ports need a pixel-level parity review against the macOS app.
