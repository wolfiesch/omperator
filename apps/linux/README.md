# T4 Code — Native Linux Client

> **Swift + SwiftCrossUI (GTK4 backend)** port of the macOS/iOS app lineage in `apps/ios/`.

| | |
|---|---|
| **Decision record** | [ADR 026 — Native Linux client](../../docs/adr/026-native-linux-client.md) |
| **Product boundary** | ADR 020: companion to an existing `t4-host`, never a second runtime authority |
| **Ship status** | Electron remains the shipped desktop product until a separate release decision |

---

## Status — views ported and integrated

| Component | State |
|---|---|
| **HostWire** (shared package, `apps/ios/HostWire`) | ✅ Builds + 21/21 tests on Linux |
| **Store layer** (`T4SessionStore` + domain models) | ✅ SHARED sources symlinked into `Sources/T4CodeLinux/Store/`; guarded imports keep the Apple build byte-identical |
| **Observation bridge** | ✅ OpenCombine `objectWillChange` → SwiftCrossUI `Publisher` via `T4UIObservation` (dual-stack, proven pattern) |
| **Wire transport** | ✅ `LinuxWebSocketTransport` (RFC 6455 client — distro libcurl can't do WebSockets); ws:// works, wss:// pending |
| **Views** | ✅ All 19 ported: rail, workspace, transcript, composer, detail, 4 panes, palette, inbox, connect, search, plan strip, ask card, model menu |
| **VTE terminal** | ✅ In the drawer — commit-signal input, char-size resize, host-PTY feed |
| **WebKitGTK browser** | ✅ Full pane — back/forward/reload + URL field (notify::uri/is-loading signals) |
| **Keychain** | ✅ libsecret via `secret-tool` |
| **Notifications** | ✅ `notify-send` + T4Notifier (byte-faithful to macOS) |
| **Demo mode** | ✅ Renders rail + detail with exact Rosé Pine Dawn tokens |
| **Live fixture host** | ✅ Full wire flow (hello→welcome→catalog→attach→transcript) verified |

### Identity

**Rosé Pine.** Dark = **Rosé Pine Moon**, light = **Rosé Pine Dawn**. The
gold "voice" (terminal/live accent) is the identity line across both modes
(Moon gold `#F6C177` ↔ Dawn gold `#EA9D34`). Selection is **highlighted
text**, never rounded pills. A 3px accent stripe anchors the rail's left
edge. VT323 is the terminal voice (fontconfig monospace alias + explicit
VTE font). Short structural labels are `.lineLimit(1)` — no mid-word wraps.

### Tests

`swift test` in `apps/linux` — **12/12 across 4 suites**:

- **Fixture wire integration** (4): handshake/welcome (local auth), catalog.get,
  session.attach, invalid-token rejection — all against the live fixture server.
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

`swift build -c release`: **1.58s** startup to window (debug: 2.89s, −45%),
79MB binary (debug: 107MB). Observation bridge coalesces store
`objectWillChange` bursts into one UI update per main-loop pass.

### Verification gaps (need a vision-capable session)

~~Visual parity is structural-only right now.~~ A headless Xvfb + xdotool +
ImageMagick sweep has since driven the live wire flow end to end with
screenshot verification (see below). `LINUX-GAP:` comments still mark every
macOS-only construct (animations, context menus, scroll-to-bottom, custom
fonts, PhotosPicker/dictation attachments). Theme glass materials are GTK
background/overlay approximations. The VTE echo round-trip (type → host echo
→ render) is now driven end-to-end through the real drawer keyboard path
against the fixture (`stream-v1` + `realTime`): keystrokes reach the host and
echoed output paints in the VTE.

### Headless UI sweep

```sh
Xvfb :99 -screen 0 1600x1000x24 &          # plus a WM (i3) for entry focus
bun scripts/run-fixture-host.mts 18790 stream-v1   # realTime: streams play live
DISPLAY=:99 GDK_BACKEND=x11 GSK_RENDERER=cairo \
  ./.build/debug/T4CodeLinux -T4NoRestore \
  -T4Endpoint=ws://127.0.0.1:18790/fixture -T4DeviceId=sweep \
  -T4DeviceToken=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA -T4Theme=dark
```

Seams used: `-T4Theme=dark|light|system` (forces appearance), the existing
`-T4Show*`/`-T4Send`/`-T4Demo` set, and `FIXTURE_LOG_FRAMES=1` on the fixture
host to trace incoming frames. Panes (files, agents, search, review,
artifacts, usage, settings, browser) render in-window as a right sidebar
beside the transcript — macOS split style, no separate top-levels; the
connect/pair and rename sheets are the only remaining separate windows.
Three framework quirks surfaced and fixed: overlay strokes ate entry focus
(glass/etched now draw background rings), `RepresentingWidget` never
re-receives representable values after mount (terminal output now pushes
through `T4TerminalFeeds`), and a WebKitWebView's natural size is the page
height (it now sits inside a GtkScrolledWindow so the host window stays
bounded and the page scrolls internally). An exact `.frame(height:)` on a
VTE representable suppresses text paint — the drawer uses `minHeight`.

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

## Architecture for view ports — read this first

### Import discipline

| File kind | Imports | Never |
|---|---|---|
| Store / model | `OpenCombine` | SwiftCrossUI |
| View | `SwiftCrossUI` | OpenCombine |
| Bridge | qualifies `SwiftCrossUI.ObservableObject` fully | — |

### Observation

```swift
@State var store = T4SessionStore()
```

Works because `T4UIObservation` exposes `didChange` on every model. Views observe exactly like SwiftUI: `@State` for owned observables, plain properties for passed-in ones.

### Missing SwiftUI APIs

Verify before reaching for these:

`ScrollViewReader` · `contextMenu` · `toolbar` · `FocusState` · `hidden` · `zIndex` · `onKeyPress` · `withAnimation` (no-op shim exists) · `.custom` fonts · `NavigationSplitView`

**Substitutes:** `SplitView` for panes · `List` for the rail · `.alert` / `.sheet` exist · `onTapGesture` / `onHover` exist

### Native widgets

| Pane / service | File | Backend |
|---|---|---|
| Browser | `Seams/BrowserPane.swift` | WebKitGTK via CWebKit |
| Terminal | `Seams/TerminalPane.swift` | VTE via CVTE |
| Notifications | `Seams/Notify.swift` | — |
| Credentials | `Seams/Keychain.swift` | libsecret via `secret-tool` |
| Native widget theme | `Seams/GtkTheme.swift` | display-wide CSS provider (USER priority) |

### Theme

`Views/Theme.swift` holds the exact macOS token values:

- **Dark** — Rosé Pine dark = VR mono + amber
- **Light** — Rosé Pine Dawn + gold

Port the glass materials (`GlassBG` / `EtchedBG`) as background/overlay approximations — GTK4 has no materials; hairline borders + translucent fills are the target look. VT323 terminal voice: install the font and map via CSS if exact parity is needed.

---

## Reference files — source of truth for 1:1 ports

| Linux file | Port from (`apps/ios/Sources`) |
|---|---|
| `Views/Rail.swift` *(todo)* | `T4SessionsView.swift` |
| `Views/SessionDetail.swift` *(todo)* | `T4SessionDetailView.swift` |
| `Views/Transcript.swift` *(todo)* | `T4TranscriptView.swift` |
| `Views/Workspace.swift` *(todo)* | `T4WorkspaceView.swift` |
| `Views/Panes.swift` *(todo)* | `T4PanesView.swift`, `T4FilesPane.swift`, `T4SearchPane.swift`, `T4InboxView.swift`, `T4AgentsPane.swift` |
| `Views/Palette.swift` *(todo)* | `T4PaletteView.swift` |
| `Views/Connect.swift` *(todo)* | `T4ConnectView.swift` |

The store API is identical to the macOS app's — same method names, same published properties. Port view bodies; when a modifier doesn't exist, pick the closest SwiftCrossUI construct and note the substitution in a comment.

---

## Verification

```sh
. ~/.local/swift/env.sh && cd apps/linux && swift build   # compile
./.build/debug/T4CodeLinux -T4Demo                        # demo rail, no host
# Live host: run `t4-host` or the fixture server, then connect from the UI.
```
