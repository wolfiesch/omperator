# Linux Port v2 Migration

## Migration baseline

- Previous approved Linux baseline: `f58729c7fac5216e567c38deaf57386bcb1c5910`
- Authoritative branch fetched: `origin/linux-port`
- Pinned authoritative commit: `d4fb75ff3cf24dbd4981948dc4c2d1a685c9b887`
- Audited range: `f58729c7fac5216e567c38deaf57386bcb1c5910..d4fb75ff3cf24dbd4981948dc4c2d1a685c9b887`
- Audit date: 2026-08-12
- Range summary: 17 commits; 132 paths changed; 13,647 insertions and 7,547 deletions.
- Authority rule: the pinned Linux code wins over assumptions in the preserved Windows migration.

## Commit audit

### `268a42b7da27ed768b9b76ec3134d14098612ffc` — feat(control): public-relay control rooms + rendezvous pairing broker

- **Store/protocol impact:** Adds relay pairing frames to `HostWire`, a discovery client and relay pipe on Apple platforms, reconnect return-code handling, desktop pairing IPC, and host-service collaboration bridge/link changes. The Linux store pointer changes to the corresponding shared-store revision.
- **Relay/pairing impact:** Introduces public relay control rooms and a rendezvous broker with six-digit, TTL-bound, single-use, attempt-capped, SHA-256-hashed pairing codes. Adds relay/gateway environment wiring and host announcements.
- **UI impact:** Replaces endpoint-oriented phone setup with a pairing-code flow in desktop, web, and Apple connection surfaces.
- **Required Windows adaptation:** Use the current `HostWire` pairing codec and relay pipe semantics; expose the current pairing/account state rather than the preserved port's raw host or tailnet assumptions. Keep fixture and ephemeral launch seams deterministic.
- **Tests affected:** `apps/desktop/test/phone-setup.test.ts`; `apps/ios/HostWire/Tests/HostWireTests/T4RelayCodecTests.swift`; `packages/host-service/test/collab-guest.test.ts`; `packages/protocol/test/desktop-ipc.test.ts`; `scripts/relay-control.test.mjs`; `scripts/rendezvous.test.mjs`; the then-current gateway/service tests.
- **Migration status:** Implemented. Windows uses `T4RelayPipe`, rendezvous account discovery, pair-code connection, and deterministic ephemeral seams; covered by `T4LinuxV2BehaviorTests` and connection/store integration tests.

### `3fd1be9084784712b0d47f19f9deaa3b43b10c2d` — refactor(control): remove all tailscale/tailnet functionality — clean public relay model

- **Store/protocol impact:** Deletes Tailscale policy, resolver, security, remote-runtime, addressing, daemon flags, direct-connect paths, and tailnet-specific IPC/model branches. Retains the gateway local transport and public relay as the supported remote path.
- **Relay/pairing impact:** Establishes the final public model: rendezvous pairing joins a sealed relay control room, and the gateway reaches appserver only over its local transport. Renames `tailnet-service` to `gateway-service` and permits ordinary public HTTPS origins.
- **UI impact:** Removes tailnet modes, `.ts.net` expectations, direct Tailscale connection copy, owner auto-approval, and tailnet target/onboarding choices across desktop, web, Apple, and Linux.
- **Required Windows adaptation:** Remove all visible tailnet terminology and choices. Do not import the preserved Windows connection UI unchanged. Keep raw endpoint input only if it remains an explicit test/developer seam outside the ordinary product surface.
- **Tests affected:** Desktop doctor/setup/lifecycle; Apple HostWire and connection fixtures; Linux transport/store; web browser/mobile/onboarding/target suites; cluster and remote E2E; host-daemon pair/CLI; host-service preview/remote transport; protocol/client; remote registry/target; gateway and maintainer tests. Tailnet policy/runtime/security tests are deleted.
- **Migration status:** Implemented. The ordinary Windows surface contains no tailnet/Tailscale mode or terminology; remote connection is rendezvous/public relay only.

### `438885aa55c11e6875d4d98d7a6d4c98dba3acf8` — feat(linux): auto-connect to the local gateway when no saved connection exists

- **Store/protocol impact:** `T4SessionStore.restore()` falls back to `ws://127.0.0.1:4194/v1/ws` as an open `.local` host after saved credentials and `-T4…` launch seams have been considered.
- **Relay/pairing impact:** Avoids rendezvous onboarding when a local gateway is available; does not change relay wire formats.
- **UI impact:** Prevents a first-launch onboarding flash for a working local setup.
- **Required Windows adaptation:** Preserve the same precedence: deterministic launch seams, saved account/host state, local gateway fallback, then onboarding only when connection logic actually requires it.
- **Tests affected:** No test file changed in this commit; Windows needs onboarding-visibility and local-auto-connect coverage.
- **Migration status:** Implemented. Restore attempts persisted account state, then the local gateway, and presents onboarding only after both fail.

### `a4db4af2f952ce663e19745bfdfae9891bd732d5` — feat(host): core composer leases — prompt.lease/controller.lease for every transport

- **Store/protocol impact:** Moves prompt/controller lease acquire, renew, release, TTL sweeping, disconnect cleanup, and revision verification into the appserver core for every transport. Restores `lease_busy`, `lease_verify_failed`, and `stale_revision` wire outcomes expected by Swift clients.
- **Relay/pairing impact:** Relay and local clients now receive the same lease contract; no rendezvous endpoint changes.
- **UI impact:** Composer availability and send behavior must reflect lease ownership and reconnect outcomes rather than transport type.
- **Required Windows adaptation:** Keep the preserved Windows composer transport, but align lease acquisition, renewal, release, error mapping, and disabled state with the current store/protocol.
- **Tests affected:** `packages/host-service/test/appserver-capabilities.test.ts`; new `lease-flow.test.ts` and `leases.test.ts`.
- **Migration status:** Implemented. The current Windows store retains prompt lease acquisition/release and maps connection/lease availability into composer state.

### `aee3672088e3a467341bf9df63f22131219e7354` — fix(linux): transport frame corruption — dangling Data pointer, unsynchronized writes

- **Store/protocol impact:** Fixes Linux WebSocket frame writes so bytes remain inside `withUnsafeBytes`, serializes send/pong/close writes, and resets the closed flag on reopen.
- **Relay/pairing impact:** Stabilizes relay/local reconnects without changing pairing or frame schemas.
- **UI impact:** Removes periodic disconnect/reconnecting churn caused by corrupt frames.
- **Required Windows adaptation:** Do not compile or copy the GTK/Linux transport. Verify the preserved Windows `HostWire` transport already owns write buffers, serializes writes, and resets reconnect state.
- **Tests affected:** No automated test path changed; commit records a 3.5-minute live stability check.
- **Migration status:** Reviewed. Windows keeps its native `URLSessionWebSocketTask` transport and actor-isolated relay pipe; no GTK pointer or write path is compiled on Windows.

### `faeebc5e6fbf56db0c2b347cdc05fcd8ea28795a` — spike: pure GTK4 Linux app proof-of-concept (Rosé Pine + streaming at 60+fps)

- **Store/protocol impact:** None; this is a standalone synthetic GTK/C-shim spike.
- **Relay/pairing impact:** None.
- **UI impact:** Proves a native GTK session rail, incremental transcript, composer, Moon theme, and high-frequency streaming path.
- **Required Windows adaptation:** Treat only as implementation lineage. Do not use the spike executable, old screenshots, or its synthetic layout as current authority.
- **Tests affected:** No automated tests; standalone spike build/run assets only.
- **Migration status:** Audited; intentionally not imported.

### `06e944069ab0f4aebf88ccabbe1efbd9ff6b7a17` — feat(linux): pure-GTK4 app — Swift store wired to real widgets, no SwiftCrossUI

- **Store/protocol impact:** Adds `T4GtkBridge` as a public facade over the existing Linux store without changing its SwiftCrossUI conformance or backend authority. Wires real sessions, selection, streaming, composer leases, and the Swift-concurrency pump into GTK.
- **Relay/pairing impact:** Uses the store's existing connection behavior; no new relay schema.
- **UI impact:** Establishes the direct native GTK application, real session rail, tagged transcript, composer, bottom streaming anchor, Fira Sans/JetBrains Mono, and Moon/Dawn styles.
- **Required Windows adaptation:** This is the architectural source: use Windows-owned WinUI/SwiftCrossUI presentation over the current store and preserved native engines. Never compile or share GTK files on Windows.
- **Tests affected:** No test paths changed; Linux package target/build coverage is affected.
- **Migration status:** Implemented as a Windows-owned WinUI/SwiftCrossUI shell; no GTK source is shared or compiled.

### `98725e493a84bcb1011da6414a4e9ddeeaa778a2` — feat(linux): full pure-GTK4 app — panes, markdown transcript, theme-aware code

- **Store/protocol impact:** Extends `T4GtkBridge` with pane APIs while leaving the store authoritative. Adds no wire changes.
- **Relay/pairing impact:** None.
- **UI impact:** Adds Markdown rendering, theme-aware tags, terminal/browser/files panes, sidebar stack, and real-user-scroll-aware bottom pinning. Later commits deliberately hide ordinary Terminal/Files access.
- **Required Windows adaptation:** Preserve WebView2, xterm, and file/store engines from the Windows branch. Port the current Markdown semantics and scroll behavior, but expose only Browser in the current sidebar.
- **Tests affected:** No test paths changed; Linux package build and deterministic Windows engine suites remain relevant.
- **Migration status:** Implemented. WebView2, xterm, and file/store engines remain compiled and tested; only Browser is ordinarily exposed.

### `e6f28ac97874c0483b7424bc81fffc8bacc308b3` — feat(linux): widget-based transcript — Enclave formatting system on pure GTK4

- **Store/protocol impact:** No wire changes; replaces one flat text buffer with per-entry widgets while retaining store-driven entries.
- **Relay/pairing impact:** None.
- **UI impact:** Adds the current message hierarchy: right-side user card intent, prose, collapsible-capable code/tool/advisory cards, multi-language syntax highlighting, diff tints, and Moon/Dawn token families.
- **Required Windows adaptation:** Replace the old Windows transcript composition with equivalent WinUI-owned entry widgets and syntax presentation while keeping durable/store state separate from renderer state.
- **Tests affected:** No tests changed; Windows transcript/Markdown behavior needs deterministic coverage.
- **Migration status:** Implemented with WinUI rich-text entry widgets, role-specific surfaces, collapsible cards, and syntax/diff styling.

### `e4275be17ebf6902ab59c485c1a8ddd03b14c739` — feat(linux): sharp corners + hideable rail for the GTK4 transcript

- **Store/protocol impact:** None.
- **Relay/pairing impact:** None.
- **UI impact:** Sets both themes to zero border radius and adds `☰` rail and `▤` pane-sidebar visibility controls.
- **Required Windows adaptation:** Use exact current corner and visibility rules from the pinned source, translated to WinUI controls and accessibility labels rather than transplanted GTK widgets.
- **Tests affected:** No test paths changed.
- **Migration status:** Implemented. Current zero-radius shell/card rules and independent rail/sidebar visibility controls replace the preserved visual composition.

### `6bb5cb03e588c9d601cf623e8eea79fbd6ccceca` — feat(linux): mini mode, compositor pinning, wrap fix, flat chrome, reading sizes

- **Store/protocol impact:** None.
- **Relay/pairing impact:** None.
- **UI impact:** Adds compact/mini mode, compositor-specific topmost behavior, correct transcript rewrap, flat hairline-divided chrome, 18 px assistant prose, 15 px user text, and compact UI typography.
- **Required Windows adaptation:** Implement compact-window geometry and equivalent WinUI topmost/window-state behavior without importing X11/niri/Hyprland/Sway/KWin code. Preserve reflow at every sidebar/rail transition and match exact current pinned constants.
- **Tests affected:** No automated test paths changed; native window and wrap smoke checks required.
- **Migration status:** Implemented. Compact mode uses `440 × 560`, hides rail/browser, saves the prior client extent, and maps GTK pinning to WinUI always-on-top.

### `1541b02f96ccd2387461e814b3ba1ee35260ed9d` — feat(linux): collapsible transcript cards, bigger title, glyph order, normal open

- **Store/protocol impact:** None.
- **Relay/pairing impact:** None.
- **UI impact:** Makes tool/code/advisory bodies collapsible from one-line headers, keeps Copy independent, sets the top-bar title to 17 px, orders compact then sidebar glyphs, and removes custom initial floating placement.
- **Required Windows adaptation:** Port card expansion state, independent Copy action, exact title size/control order, and ordinary initial Windows placement. Do not preserve old oversized toolbar composition.
- **Tests affected:** No test paths changed.
- **Migration status:** Implemented. The top bar uses the current title scale and `◑`, `▤`, `☰` order; transcript cards expand independently and retain Copy.

### `69b1e0b783a8d0c2eb71ad0d1c5ac6446e018aea` — feat(rendezvous): username+password accounts with account-scoped host directory

- **Store/protocol impact:** Adds account registration/login endpoints, salted SHA-256 password records, atomic account-store writes, 30-day bearer tokens stored only as SHA-256 hashes, token sweeping, authenticated host announcement, and account-scoped host listing.
- **Relay/pairing impact:** Account authentication scopes rendezvous discovery; unauthenticated clients retain only the public host list. Pair-code wire behavior is unchanged.
- **UI impact:** Enables username/password onboarding and account-scoped discovery.
- **Required Windows adaptation:** Update Credential Manager records to current account/token and paired-host lifecycle; implement login with registration fallback, redacted friendly errors, and authenticated host discovery without logging credentials or bearer material.
- **Tests affected:** `scripts/rendezvous.test.mjs` account registration, login, token, and host-scoping coverage.
- **Migration status:** Implemented. Credential Manager stores normalized account identity and bearer token; login-register-login fallback and bounded redacted errors are covered.

### `347e707fae71143cfa8e9687548d821a4aaf98d3` — feat(linux): usability pass — account onboarding, friendly rail, browser-only panes, settings

- **Store/protocol impact:** Extends `T4GtkBridge` with account onboarding and user-facing session projections; preserves the store as authority. Enables command-line launch seams through `G_APPLICATION_HANDLES_COMMAND_LINE`.
- **Relay/pairing impact:** Implements login with register fallback, token persistence, friendly account errors, and onboarding only when no saved/local connection can work.
- **UI impact:** Introduces the simplified current product surface: username/password overlay; friendly rail titles and relative recency; no IDs/revisions/status codes/fingerprints; Browser-only ordinary sidebar; plain `Dark mode`, `Compact window`, `Show sidebar` settings; slim top bar with title and right-side glyphs.
- **Required Windows adaptation:** Port this hierarchy and state model deliberately. Retain Windows engines underneath, but remove old rail, pane menu, settings, onboarding, endpoint/tailnet assumptions, and internal metadata from ordinary visible UI.
- **Tests affected:** No test paths changed in this commit; Windows needs onboarding, friendly projection, relative-time, browser-only exposure, settings, and launch-seam coverage.
- **Migration status:** Implemented. Windows now uses the simplified onboarding, friendly rail, browser-only pane, and three-toggle settings surface.

### `6f06ef98ebae3d725cd6837489b250ee74054426` — fix(linux): right-aligned user bubbles + live streaming transcript

- **Store/protocol impact:** Exposes `streamingMessages[sessionId]` through `T4GtkBridge.streamingText(for:)`; durable transcript entries remain authoritative after settlement.
- **Relay/pairing impact:** None.
- **UI impact:** Correctly pushes user cards to the right and renders an incrementally updated live tail that disappears when the durable entry replaces it.
- **Required Windows adaptation:** Model user alignment explicitly and render a non-durable streaming tail keyed by session. Reconcile it atomically when the settled durable event arrives.
- **Tests affected:** No tests changed; Windows needs alignment and streaming-tail lifecycle coverage.
- **Migration status:** Implemented. User bubbles are explicitly trailing-aligned and the per-session non-durable live tail is reconciled on durable settlement.

### `5d33f15f6ecf821dfb918aa7faa6a3e44866725b` — feat(linux): per-session scroll memory + first-open at bottom

- **Store/protocol impact:** No wire changes; adds renderer-owned per-session scroll offsets and deferred restoration after layout.
- **Relay/pairing impact:** None.
- **UI impact:** First visit starts at the newest content; A-B-A session switching restores each session's prior position.
- **Required Windows adaptation:** Store scroll state per session in Windows presentation state, restore only after WinUI content measurement, and distinguish first-open bottom anchoring from later restoration.
- **Tests affected:** No tests changed; Windows needs deterministic first-open and per-session restoration tests.
- **Migration status:** Implemented. `T4LinuxV2ScrollMemory` records per-session offsets and first-open bottom state; the patched native scroll view restores after layout.

### `d4fb75ff3cf24dbd4981948dc4c2d1a685c9b887` — fix(linux): markdown coverage, scroll-follow pin, theme-switch crash

- **Store/protocol impact:** No wire changes.
- **Relay/pairing impact:** None.
- **UI impact:** Expands Markdown to nested/indented and ordered lists plus asterisk/underscore bold, italic, and bold-italic runs; follows the true bottom while pinned as content grows; weak-references prose labels so theme switching cannot touch freed transcript widgets.
- **Required Windows adaptation:** Match the native parser's run-length/list behavior and current emphasis colors; implement follow release/reacquisition against the measured WinUI extent; ensure theme changes never retain or mutate disposed message elements.
- **Tests affected:** No test paths changed; Windows needs Markdown emphasis/list, scroll-follow, and repeated theme-switch coverage.
- **Migration status:** Implemented. Native-parser-equivalent list/emphasis coverage, measured follow release/reacquisition, and value-driven theme rendering are covered by Linux v2 behavior tests and native capture sweeps.

## Required feature-to-commit index

| Required behavior | Implementing commit(s) |
| --- | --- |
| Public relay and rendezvous pairing | `268a42b7da27ed768b9b76ec3134d14098612ffc` |
| Removal of Tailscale/tailnet behavior | `3fd1be9084784712b0d47f19f9deaa3b43b10c2d` |
| Direct native GTK application | `06e944069ab0f4aebf88ccabbe1efbd9ff6b7a17` (preceded by spike `faeebc5e6fbf56db0c2b347cdc05fcd8ea28795a`) |
| Simplified UI/usability pass | `347e707fae71143cfa8e9687548d821a4aaf98d3` |
| Username/password onboarding | Service: `69b1e0b783a8d0c2eb71ad0d1c5ac6446e018aea`; Linux UI: `347e707fae71143cfa8e9687548d821a4aaf98d3` |
| Friendly session titles | `347e707fae71143cfa8e9687548d821a4aaf98d3` |
| Relative session timestamps | `347e707fae71143cfa8e9687548d821a4aaf98d3` |
| Browser-only pane sidebar | `347e707fae71143cfa8e9687548d821a4aaf98d3` |
| Plain-language settings | `347e707fae71143cfa8e9687548d821a4aaf98d3` |
| Right-aligned user messages | `6f06ef98ebae3d725cd6837489b250ee74054426` |
| Live transcript streaming | `6f06ef98ebae3d725cd6837489b250ee74054426` |
| Per-session scroll memory | `5d33f15f6ecf821dfb918aa7faa6a3e44866725b` |
| First-open bottom anchoring | `5d33f15f6ecf821dfb918aa7faa6a3e44866725b` |
| Scroll-follow pinning | Initial behavior: `98725e493a84bcb1011da6414a4e9ddeeaa778a2`; widget path: `e6f28ac97874c0483b7424bc81fffc8bacc308b3`; true-bottom correction: `d4fb75ff3cf24dbd4981948dc4c2d1a685c9b887` |
| Markdown expansion | Initial renderer: `98725e493a84bcb1011da6414a4e9ddeeaa778a2`; current list/emphasis coverage: `d4fb75ff3cf24dbd4981948dc4c2d1a685c9b887` |
| Theme-switch crash correction | `d4fb75ff3cf24dbd4981948dc4c2d1a685c9b887` |

## Windows platform systems retained

The selective import retains the native Swift package and WinUI executable; `Scripts/prepare-dependencies.ps1`, the nonactivating capture scripts, and the pinned SwiftCrossUI/WinUI patches; Windows HostWire transport and launch configuration; the WebView2 renderer, app-lifetime per-session browser model, deterministic HTML fixture, native lifecycle/error handling, and browser tests; the xterm.js renderer, bundled resources, per-session terminal model, lifecycle handling, and terminal tests; Windows Credential Manager, saved-host/account validation, cleanup, migration, and in-memory test seams; fixture-server integration tests; `SWP_NOACTIVATE`/`PrintWindow` capture tooling; and bundled Cantarell/DejaVu font registration.

Verification: the Windows native executable builds and launches; the Linux native target builds in the pinned Docker capture image; the affected Swift tests, fixture integrations, browser/terminal tests, account/redaction tests, and code-driven capture matrix are recorded below.

## Hidden retained capabilities

The pinned Linux ordinary sidebar exposes Browser only. Windows retains Terminal, Files, Search, Diff, Agents, Review, Usage, Artifacts, and their underlying store/protocol and rendering implementations for architecture and test coverage. `T4LinuxV2PaneAvailability.visibleOrdinaryPanes` returns only `.browser`, and the v2 top bar/settings expose no legacy pane selector or hidden-engine control.

## Current Linux behavior not implemented

None identified in the requested code-first surface. GTK compositor detection itself is intentionally not ported: WinUI's `OverlappedPresenter.isAlwaysOnTop` is the native counterpart. GTK widget ownership and weak-label bookkeeping are also not shared; Windows recomputes value views, so theme changes do not address disposed GTK objects.

## Code-driven visual verification

- Pinned Linux SHA: `d4fb75ff3cf24dbd4981948dc4c2d1a685c9b887`.
- Linux captures: `apps/windows/.build/linux-v2-parity/linux/`.
- Windows captures: `apps/windows/.build/linux-v2-parity/windows/`.
- Per-state normalized, side-by-side, 50% overlay, and absolute-difference outputs: `apps/windows/.build/linux-v2-parity/comparisons/<state>/`.
- Indexed contact sheet: `apps/windows/.build/linux-v2-parity/linux-windows-contact-sheet.png`.
- Comparison manifest: `apps/windows/.build/linux-v2-parity/comparison-index.json`.
- Pending future demo-page review ledger: `apps/windows/LINUX_PORT_V2_DEMO_PAGE_REVIEW_PENDING.md`.
- States: onboarding, workspace, friendly rail, user message, streaming, Markdown, Browser, settings closed/open, sidebar shown/hidden, compact/normal, Moon/Dawn, and narrow/standard/wide.
- Linux capture is private Xvfb with the pinned source archive mounted read-only. Windows capture starts offscreen, uses `SWP_NOACTIVATE` plus `PrintWindow(PW_RENDERFULLCONTENT)`, and terminates each process.

The code-first pass intentionally does not claim pixel identity between GTK and WinUI. Remaining visible differences are native widget/compositor details: window frame metrics, WinUI text antialiasing and glyph rasterization, GTK versus WebView2 surface painting, and platform-native input/toggle chrome. No manual QA interaction is required for the deterministic matrix; onboarding submission and real external relay pairing still require credentials/network and are covered through injected clients and integration tests rather than coordinate automation.

## Demo-page validation pending

Alexis confirmed no current example screenshots exist. When the demo page is published, validate its represented commit, compare its current assets against the pinned native captures and Windows output, and correct demonstrated residual visual deltas only. Do not use the old Vertical Rectangle, SwiftCrossUI Linux, or macOS screenshots as substitutes.
