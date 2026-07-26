# T4 Code native SwiftUI client candidates

This directory contains a candidate native SwiftUI iPhone companion for T4 Code,
built from the [Enclave](https://github.com/verticalrectangle/Enclave) SwiftUI
lineage. It speaks T4's authoritative wire protocol and connects to an existing
host. It is not part of the current release.

The shared source tree also builds a macOS target for development and
cross-platform integration checks. Electron and the canonical React renderer
remain Omperator's primary desktop product; the Swift macOS target is not a
second shipped desktop application or an implicit replacement.

See [ADR 020](../../docs/adr/020-native-ios-companion.md) for the product boundary
and release-proof requirements.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| iOS approach | **Native SwiftUI**, ported from Enclave | Keeps Enclave's native lineage; best fit for a control-room tool. |
| Wire protocol | **Port `@t4-code/host-wire` (`omp-app/1`) to Swift** | The collab-guest `/collab` protocol Enclave uses is read-mostly and *cannot enumerate host sessions* — it can't back "the whole interface". The authoritative host-wire can. |
| Combine mechanics | **Vendor Enclave sources into `apps/ios`** in this repo | Branch lives in omperator. |
| Product role | **iPhone companion candidate; macOS integration harness** | Avoids creating two competing desktop products without a deliberate cutover. |

iOS **cannot bundle a host**; it connects to an **existing** `t4-host` over the
network (Tailnet address or pairing link), exactly like the Android client.

## New-user flow (pairing)

1. On the host machine: `t4-host pair` — mints a one-time 6-digit ticket from
   the running host and prints the code, a `t4-code://pair/<host>/<code>` deep
   link, and a terminal QR for it.
2. On the phone: scan the QR (or open the link) — the app opens the Connect
   sheet prefilled and pairs immediately; or enter host + code manually. Raw
   endpoint + device credentials live under Advanced for already-paired
   devices.
3. Pairing grants a device token (`sessions.read`/`sessions.prompt`/
   `sessions.manage`); the app persists it and auto-connects on every launch.

Tailscale is the transport; the 6-digit code is the trust boundary. The host's
remote listener only accepts Tailnet addresses, and mutations additionally
require the `prompt.lease` feature + a per-session prompt lease.

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

## Build and verify

The complete verification requires macOS, a compatible Xcode simulator SDK,
and XcodeGen.

```sh
# From the repository root: generate the project, compile the iOS app,
# and run its XCUITest bundle on a discovered compatible simulator.
node scripts/verify-ios.mjs
```

Protocol correctness is cross-checked against the real wire fixtures in
`packages/host-wire/fixtures/v1/` (decode + round-trip), the same corpus the TS
package tests against.

## Status

- [x] Enclave app sources vendored into `apps/ios/`.
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

## Current state (2026-07-26)

**iOS + macOS native apps, one SwiftUI source tree.**

| Surface | Status |
|---|---|
| Session rail (search, project groups, live status) | ✅ both platforms (drawer on iOS, split view on macOS) |
| Live transcript (markdown, code cards, tool cards, token streaming) | ✅ both |
| Composer (attachments, dictation, send/stop) | ✅ both |
| Model/thinking/fast/plan-mode controls (provider-labeled) | ✅ both |
| Plan mode (`session.mode.set`, prompt-shaped at host) | ✅ both — ahead of desktop web |
| Ask/confirmation banners | ✅ both |
| Plan strip (todoPhases over session.state.get) | ✅ both |
| Attention inbox + agents pane | ✅ both |
| Usage/review/artifacts/settings panes + Host info section | ✅ both |
| Files pane (FilesAuthority on the standalone host) | ✅ both |
| Terminal drawer (host PTY, 4 tabs/session) | ✅ both |
| Browser pane (WKWebView, opportunistic preview.launch) | ✅ both |
| Command palette (⌘K macOS, magnifier iOS) | ✅ both |
| Pairing (code/QR/deep link), persisted creds, auto-reconnect | ✅ both |
| Notifications (turn end, approvals) | ✅ both |
| Prompt/controller leases, revision handling | ✅ both |
| files.search + files.diff | ✅ both |
| Preview captures | ✅ implementation present; current-head integration proof required |
| Cluster operator | ⛔ deferred — needs protocol scoping |
| Speech (wake-word) | ⛔ dropped (dictation ships instead) |

The branch previously passed five XCUITest cases and a macOS live-host check.
Those results are historical until rerun on the current integrated head. Demo
data is opt-in (`-T4Demo`); fresh installs get real onboarding.
