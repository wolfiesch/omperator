# T4 Code — Native Linux Client

> **Swift + pure GTK4** port of the macOS/iOS app lineage in `apps/ios/`. The
> UI is imperative GTK4 (via the `CT4Gtk` C shim) driven by the shared
> `T4SessionStore` — no SwiftCrossUI in the build graph.

| | |
|---|---|
| **Decision record** | [ADR 026 — Native Linux client](../../docs/adr/026-native-linux-client.md) |
| **Product boundary** | ADR 020: companion to an existing `t4-host`, never a second runtime authority |
| **Ship status** | Electron remains the shipped desktop product until a separate release decision |

---

## Status — pure-GTK4 app wired to the shared store

| Component | State |
|---|---|
| **HostWire** (shared package, `apps/ios/HostWire`) | ✅ Builds + 21/21 tests on Linux |
| **Store layer** (`T4SessionStore` + domain models) | ✅ Shared sources in `T4CodeLinuxLib/Store`; the GTK window drives them through the public `T4GtkBridge` facade |
| **UI** | ✅ Pure-GTK4 widgets — rail, transcript (markdown + syntax highlighting), composer, onboarding/login, settings, mini mode, compositor pinning |
| **Wire transport** | ✅ `LinuxWebSocketTransport` (RFC 6455 client — distro libcurl can't do WebSockets); ws:// works, wss:// pending |
| **VTE terminal** | ✅ `PanesFactory` terminal pane — commit-signal input, char-size resize, host-PTY feed |
| **WebKitGTK browser** | ✅ `PanesFactory` browser pane — back/forward/reload + URL field (notify::uri/is-loading signals) |
| **Keychain** | ✅ libsecret via `secret-tool` |
| **Notifications** | ✅ `notify-send` + T4Notifier (byte-faithful to macOS) |
| **Themes** | ✅ Bundled CSS (`Sources/T4CodeLinux/themes/`), loaded via `Bundle.module` — no absolute paths |
| **Composer** | ✅ Multiline wrapping text view (Enter sends, Shift+Enter newline, auto-grow to ~6 lines) with image attachments — file picker (📎), clipboard paste, drag & drop; chips preview on click |
| **Copy** | ✅ Per-element copy: ⧉ button (top-right of every entry) + right-click menu — Copy Text / Copy Markdown for messages and cards, Copy Image (PNG) for images, captures, chips, and the lightbox |
| **Image previews** | ✅ Transcript artifact rows (chunked `artifact.read` → `GdkTexture`), preview-capture rows, files-pane thumbnails; click opens a lightbox (Esc/click closes) |
| **Demo mode** | ✅ Renders rail + detail with exact Rosé Pine tokens (`-T4Demo`) |
| **Live fixture host** | ✅ Full wire flow (hello→welcome→catalog→attach→transcript) verified |

### Identity

**Rosé Pine.** Dark = **Rosé Pine Moon**, light = **Rosé Pine Dawn**. The
gold "voice" (terminal/live accent) is the identity line across both modes
(Moon gold `#F6C177` ↔ Dawn gold `#EA9D34`). Selection is **highlighted
text**, never rounded pills. A 3px accent stripe anchors the rail's left
edge. VT323 is the terminal voice (fontconfig monospace alias + explicit
VTE font). Short structural labels never wrap mid-word.

### Tests

`swift test` in `apps/linux` — **13/13 across 4 suites**:

- **Fixture wire integration** (5): handshake/welcome (local auth), catalog.get,
  session.attach, invalid-token rejection, restore-to-last-session — all
  against the live fixture server.
- **Store prompt flow** (2): connect → session inventory; select → attach →
  sendPrompt → streaming transcript entries land in projection models.
- **Keychain seam** (3): ephemeral round-trip, persistent round-trip
  (skipped when no Secret Service daemon), launch-arg credential parsing.
- **Merge compat** (3): the OpenCombine 0.14 Merge gap the store's
  objectWillChange chain needs.

Plus `apps/ios/HostWire` — 21/21 (wire-fixture corpus). Tests spawn the
fixture server (`bun scripts/run-fixture-host.mts`) on an ephemeral port and
shut it down after; no display needed.

### Performance

Release builds of the pure-GTK4 app start faster than the SwiftCrossUI
stack they replaced (imperative widgets, no declarative diffing). Streaming
transcript updates paint on a main-loop frame tick with scroll-follow
pinning; the store's `objectWillChange` churn is read directly per tick
rather than forwarded through an observation bridge.

### Verification gaps (need a vision-capable session)

`LINUX-GAP:` comments still mark every macOS-only construct (animations,
context menus, custom fonts, PhotosPicker/dictation attachments). Theme
glass materials are GTK background/overlay approximations. The VTE echo
round-trip (type → host echo → render) is driven end-to-end through the
real drawer keyboard path against the fixture (`stream-v1` + `realTime`).

### Headless UI sweep

```sh
Xvfb :99 -screen 0 1600x1000x24 &          # plus a WM (i3) for entry focus
bun scripts/run-fixture-host.mts 18790 stream-v1   # realTime: streams play live
DISPLAY=:99 GDK_BACKEND=x11 GSK_RENDERER=cairo \
  ./.build/debug/T4CodeLinux -T4NoRestore \
  -T4Endpoint=ws://127.0.0.1:18790/fixture -T4DeviceId=sweep \
  -T4DeviceToken=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA -T4Theme=dark
```

Seams used: `-T4Theme=dark|light` (forces appearance; default dark),
`-T4WindowSize=1920x1080` (exact capture geometry — resizing a realized
WebKitGTK view on Xvfb races its compositor), the existing `-T4Show*`/
`-T4Send`/`-T4Demo` set, and `FIXTURE_LOG_FRAMES=1` on the fixture host to
trace incoming frames.

---

## Environment setup (this machine)

```sh
# Swift 6.3.3 rootless toolchain (UBI9 tarball, ~/.local/swift):
. ~/.local/swift/env.sh        # PATH + LD_LIBRARY_PATH
cd apps/linux && swift build && ./.build/debug/T4CodeLinux

# For screenshots/display from a non-session shell:
export DISPLAY=:0 XAUTHORITY=/run/user/1000/xauth_wCjaKU
```

---

## Architecture

### Package layout (`apps/linux/Package.swift`)

- `T4CodeLinuxLib` — the library: shared store (`Store/`), seams
  (`Seams/`), OpenCombine compat. Testable from SwiftPM test targets.
- `T4CodeLinux` — the pure-GTK4 executable: `AppWindow.swift` (window +
  rail + composer + onboarding/settings), `TranscriptWidgets.swift`
  (per-entry transcript cards), `PanesFactory.swift` (terminal/browser/
  files panes), `MarkdownRenderer.swift` + `SyntaxHighlighter.swift`
  (styled transcript text), `CompositorPin.swift` (mini-mode pinning),
  `GtkSupport.swift` (signal plumbing + main-actor pump).
- `CT4Gtk` / `CVTE` / `CWebKit` — `systemLibrary` shims for GTK4, VTE
  (vte-2.91-gtk4), and WebKitGTK (webkitgtk-6.0).
- `themes/` under the executable target is copied into the module bundle;
  both `main.swift` and `AppWindow.applyTheme()` load CSS via
  `Bundle.module.url(forResource:subdirectory:)`.

### Store access

The executable never touches `T4SessionStore` directly — `T4GtkBridge`
exposes the surface the window needs in public HostWire/Foundation types,
and `AppWindow` polls it on a main-loop refresh tick plus event-driven
refreshes (streaming frames, send, selection).

### Launch seams (parsed from `CommandLine.arguments`)

| Seam | Effect |
|---|---|
| `-T4Endpoint=` / `-T4DeviceId=` / `-T4DeviceToken=` | pairing/QA overrides (Keychain seam) |
| `-T4NoRestore` | fresh-state run; no Secret Service access |
| `-T4Theme=dark\|light` | force appearance for headless sweeps |
| `-T4WindowSize=WxH` | exact launch geometry (captures) |
| `-T4Demo` / `-T4DemoStream` | store-level demo rail + streaming driver |
| `-T4Attach=/path.png` | stage a composer attachment at startup (QA for the attachment strip) |

---

## Verification

```sh
. ~/.local/swift/env.sh && cd apps/linux && swift build   # compile
./.build/debug/T4CodeLinux -T4Demo                        # demo rail, no host
# Live host: run `t4-host` or the fixture server, then connect from the UI.
```
