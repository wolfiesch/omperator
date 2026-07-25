# T4 Code — native iOS client (from Enclave)

This directory is a **native SwiftUI iOS client for T4 Code**, built on the
[Enclave](https://github.com/verticalrectangle/Enclave) SwiftUI app. T4 Code
ships desktop (Electron), web (canonical React renderer), and an Android
React/Capacitor compatibility client — but **no native iOS app** (iOS currently
uses the responsive Tailnet PWA). This closes that gap with a real native client
that speaks T4's authoritative wire protocol and implements the full T4
interface.

> Plan of record. Edit here as decisions change; do not keep a second copy.

## Decisions (confirmed)

| Decision | Choice | Why |
|---|---|---|
| iOS approach | **Native SwiftUI**, ported from Enclave | Keeps Enclave's native lineage; best fit for a control-room tool. |
| Wire protocol | **Port `@t4-code/host-wire` (`omp-app/1`) to Swift** | The collab-guest `/collab` protocol Enclave uses is read-mostly and *cannot enumerate host sessions* — it can't back "the whole interface". The authoritative host-wire can. |
| Combine mechanics | **Vendor Enclave sources into `apps/ios`** in this repo | Branch lives in omperator. |
| First deliverable | **Branch + scaffold + start protocol port** | Foundation first; UI rework after the wire is real. |

iOS **cannot bundle a host**; it connects to an **existing** `t4-host` over the
network (Tailnet address or pairing link), exactly like the Android client.

## What's vendored from Enclave

Copied verbatim into `apps/ios/`:

- `Sources/` — the SwiftUI app (21 files). `EngineBridge.swift` is the collab
  guest client; it is **replaced** by the Swift host-wire client (see below).
- `Shared/`, `WidgetSources/`, `Resources/`, `*-Info.plist`, `project.yml`,
  `build-mac.sh`.

**Not** vendored: Enclave's vendored `oh-my-pi-main/` Rust tree and its
`target/` build artifacts, screenshots, and session HTML captures.

## The two replacements

1. **Protocol.** `EngineBridge.swift` (collab `/collab` guest, AES-256-GCM) → a
   Swift port of `@t4-code/host-wire` (`omp-app/1`) in `HostWire/`. This is the
   load-bearing change: it is what makes session enumeration, control,
   subagents, terminals, files, and reviews possible on iOS.

2. **Session view.** Enclave's `SessionsView.swift` is a **collab-guest,
   on-device list of joined `/collab` rooms** (the protocol can't enumerate a
   host's sessions). It is replaced by T4's **authoritative session rail**:
   sessions grouped by working folder/project, create/rename/terminate/archive,
   search/filter/sort — backed by the host-wire session inventory.

## Wire protocol — what we're porting (`HostWire/`)

JSON-over-WebSocket, protocol id `omp-app/1`, one frame per WebSocket message.
Path `/v1/ws` (default profile) or `/v1/profiles/{profileId}/ws`. No
subprotocol. Exchange: `hello` → `welcome` → commands/responses + events.
Cursor-based sequencing per session. Frames discriminated by `type`. Commands
correlate via `requestId`/`commandId`. Binary (captures, images, file contents)
is chunked base64 ≤ 256 KiB.

Sources of truth: `packages/host-wire/src` (frames + bounded decoders),
`packages/client/src` (`OmpClient` runtime: connection, handshake, heartbeat,
reconnect, dispatch), `packages/protocol/src` (`pair-link`, `server-event`).

### Port order (each step compiles + tests against `packages/host-wire/fixtures/v1`)

1. **Foundation** ✅ in progress — `Limits`, `Bounded` (validators), `IDs`,
   `Cursor`, `Capabilities`, `Authentication`, `Hello`/`Welcome`, `Heartbeat`
   (ping/pong/bye), `Result`/`Error`, `Pairing` (deep link + pair/confirm
   frames), `Envelope` (client/server frame decode for the ported types).
2. **Commands** (`command.ts`, 2055 ln, 80+ commands) → `HostWire/Commands`.
   Group by domain: session, agent, terminal, file, review, artifact, settings,
   host, usage, preview, cluster.
3. **Events + entries** (`event.ts`, `additive.ts` 1138 ln, `entry.ts`) →
   `HostWire/Events`, `HostWire/Transcript` — the streaming transcript + agent
   tree + tool rows.
4. **Session inventory** (`session-index.ts`, `session-state.ts`, `snapshot.ts`,
   `gap.ts`) → `HostWire/Sessions` — the authoritative rail model.
5. **Client runtime** → `HostWireClient`: WebSocket connect, hello/welcome
   handshake, heartbeat, cursor-based resume, reconnect with backoff, command
   dispatch + response correlation. Ports `packages/client/src/omp-client-*`.
6. **Projections** → map inbound frames to view models the SwiftUI app consumes
   (mirrors `packages/client/src/projection*.ts`, but only the surfaces iOS
   ships).

## Surface mapping — T4 web (`apps/web/src/features`) → iOS SwiftUI

| T4 surface | Enclave file (reuse) | Net |
|---|---|---|
| Session rail | `SessionsView.swift` | **Replace** (guest list → authoritative rail) |
| Transcript + composer | `EditorView.swift`, `TranscriptViews.swift`, `ComposerParts.swift` | **Adapt** to host-wire transcript/entries |
| Agent view (fan-out) | `Screens.swift` (Activity) | **Adapt** to host-wire agents |
| Panes (files, terminals, reviews, artifacts) | (new) | **New** SwiftUI panes |
| Hosts & usage | `TrustView.swift` | **Adapt** to host-wire hosts/usage |
| Settings | (new) | **New** |
| Pairing/connect | `QRScanner.swift`, `Screens.swift` (Pair) | **Adapt** to `t4-code://pair/` deep link + `/v1/ws` |

## Deletions (collab-guest-only, not host-reachable)

Per Enclave's own README, these are guest-fiction and get removed as the
host-wire port lands: the mock session library + slash commands, edit→rewind
(host-only), model-routing editor, paired-devices/fingerprint fiction, the
`/collab` link seam (`ENCLAVE_COLLAB_LINK`), and `EngineBridge.swift` itself.

## Build & verify

We build on a Mac over SSH (`macbookpro.local`: Swift 6.2.4, Xcode 26.3,
xcodegen). There is no Swift toolchain on the Linux dev box.

```sh
# HostWire package (model layer + client) — builds + tests on macOS:
cd apps/ios/HostWire
swift test

# Full app (requires Xcode + xcodegen):
cd apps/ios
xcodegen generate
xcodebuild -scheme Enclave -destination 'platform=iOS Simulator,name=iPhone 16' build
```

Protocol correctness is cross-checked against the real wire fixtures in
`packages/host-wire/fixtures/v1/` (decode + round-trip), the same corpus the TS
package tests against.

## Status

- [x] Branch `t4code-ios` created.
- [x] Enclave app sources vendored into `apps/ios/`.
- [x] Plan of record (this file).
- [x] HostWire foundation (envelope/handshake/pairing/result, bounded validators) — compiles + passes fixture tests.
- [x] Session inventory (`SessionsFrame`/`SessionListResult`/`SessionRef`) + `CommandFrame` envelope (rail + core session descriptors).
- [x] Client runtime (`HostClient`: connect/handshake, command dispatch + correlation, projection stream, heartbeat, reconnect) — 10/10 tests green.
- [x] `HostWire` linked into the Xcode app project; `xcodegen` + iOS Simulator `xcodebuild` BUILD SUCCEEDED.
- [x] Full server frame vocabulary ported (welcome/sessions/snapshot/entry/event/agent×6/terminal×3/files×6/review/audit×3/catalog/settings/preview×5/watch×4/lease×2/pair/confirmation/response/error/pong/bye/gap) — verified across ~25 wire fixtures.
- [ ] Remaining protocol depth: per-command argument/result payload decoders (`command.ts` result bodies) and transcript entry `data` shapes (message/tool rows); today these decode as opaque `JSONValue`.
- [x] Session rail (`T4SessionsView` + `T4SessionStore`) replaces the collab-guest `SessionsView`; verified rendering in the iOS Simulator.
- [x] Desktop-parity workspace: session detail is the root surface; the rail is a slide-over drawer opened by swiping right from the left edge (or the sidebar button), closed by backdrop tap or swiping left — mirrors the desktop narrow-width Sheet overlay. Flat, no card stacking.
- [x] Composer ported from Enclave: glass capsule, photo attachments (session.image.begin/chunk upload → session.prompt image refs), on-device dictation, send/stop (session.cancel), cycling tips.
- [x] Transcript matches the desktop web renderer: user messages right-aligned bubbles, assistant messages full-width markdown with fenced-code cards, tool/review rows as accent-rail cards.
