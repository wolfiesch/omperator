## Native iOS and macOS apps, host Browser Preview service (unreleased, `t4code-ios` branch)

T4 Code gains two first-party native clients and a host-side browser preview pipeline, and sheds the
compatibility shims that stood in for them.

### Native iOS and macOS clients

A single SwiftUI codebase (`apps/ios`) ships the full T4 interface on iPhone and Mac: the session rail
(swipe-right drawer, project grouping, search, status pills, context meters), live transcript with plan
panels and ask cards, composer with dictation, and desktop-parity panes — files, agents, terminal
(host PTY, four tabs per session), review, usage, artifacts, settings, search/diff, and a Browser pane
(WKWebView with opportunistic host `preview.launch`). Pairing works by code, QR, or `t4-code://pair`
deep link, with credentials in the Keychain and automatic reconnect. Local notifications fire on turn
end and approval requests.

Both clients speak the authoritative `omp-app/1` wire through **HostWire**, a new Swift package porting
the complete frame vocabulary — every command, result, and push frame the desktop uses, verified
against the live host.

### Removed and simplified

The native apps replace Enclave's collab-guest foundation. Removed as guest fiction that the
authoritative host-wire cannot and should not back:

- the collab-guest client and its `/collab` link seam (`ENCLAVE_COLLAB_LINK`), which could not even
  enumerate host sessions;
- the mock session library and its slash commands;
- edit→rewind (host-only by design);
- the model-routing editor and the paired-devices/fingerprint UI fiction;
- `EngineBridge` and the `AppModel` layer — one `T4SessionStore` (host-wire inventory) plus one
  `ThemeStore` is the whole client state;
- wake-word speech, dropped in favor of on-device dictation.

On iOS, the responsive Tailnet PWA is superseded as the primary experience; it remains a fallback for
unpaired browsers.

### Host Browser Preview service

The host now runs a bounded headless-Chromium preview service (playwright-core, pinned runtime,
localhost/tailnet URL policy, two-context bound, idle reap) implementing all 22 `preview.*` commands —
launch, navigate, capture, click/type/scroll automation, leases, and policy checks. The native apps
render captures inline: a capture view in the Browser pane with zoom, and capture rows in the
transcript, with sha256-verified chunked reassembly. Preview commands are confirmation-challenged like
other lifecycle mutations.

### Host hardening

The standalone host gained structured NDJSON logging (rotating; connections, pairings, denials,
supervisors, watchdog), a boot reaper for stale session locks and zombie supervisors, a richer
`/healthz` (version, uptime, sessions, supervisors, watchdog stats), and Keychain-backed device
credentials on both native clients.

### Pinned wss transport

Hosts can serve a second, TLS listener alongside the plain tailnet one: `t4-host serve --remote-tls-port
8788` generates a per-profile self-signed certificate (persisted under the profile's `remote/tls/`, RSA
after BoringSSL rejected LibreSSL-written EC keys) and publishes its sha256 fingerprint as
`tlsFingerprint` on `/healthz`. The native apps pin that fingerprint (TOFU, stored in the Keychain) and
refuse mismatches — authenticating the host against rogue tailnet peers without depending on Tailscale
Serve, which is plan-gated on this tailnet. Plain `ws://` inside the tailnet remains supported and is
already WireGuard-encrypted; iOS keeps `NSAllowsArbitraryLoads` because iOS 26 honors no narrower ATS
key for WebSocket tasks.

---

## First independently owned release

T4 Code v0.1.33 is the first release published from
[`wolfiesch/omperator`](https://github.com/wolfiesch/omperator). Its Android package uses the
project's new `net.t4code.app` signing key, and its macOS packages use Michael Schoenberger's pinned
Developer ID certificate and notarization credentials. GitHub Releases is the authoritative
download surface, and the protected release workflow publishes the same immutable release manifest
and checksums to `t4code.net`.

## Electron and React are the product authority

T4 Code has standardized on the Electron desktop shell and canonical React renderer. The abandoned
Flutter migration, its duplicate platform targets, and its CI and release plumbing have been
removed. macOS is the primary desktop target, Linux remains supported, and React/Capacitor Android
plus the responsive Tailnet browser/PWA remain compatibility clients for paired hosts.

The standardization preserves T4's standalone host, typed wire, OMP authority boundary, current
session and transcript behavior, native Browser workspace, terminal, files, review, secure
credentials, and signed update path. The public demo now builds from the same React client shipped
inside Electron, eliminating a second product implementation.

## A session rail built for large libraries

T4 Code v0.1.33 makes a large session library easier to navigate. The rail now supports text search, activity filters, newest/oldest sorting, grouped and flat layouts, collapsible project folders, and saved display preferences. Those controls follow the Codex desktop organization model while keeping OMP as the source of truth.

Project menus can create a session in that folder, reveal the folder in the system file manager, collapse the group, or hide it from the rail. Hidden projects are not deleted and can be restored from the filter menu. The reveal action is deliberately narrow: the host accepts only project paths already present in its session catalog.

## Faster transcripts and easier context sharing

Opening a large session paints its newest saved transcript entries before older history finishes loading. The composer can insert bounded file references from the active workspace, and the session menu can export a transcript without exposing hidden host state. Session activity labels now follow authoritative runtime events, so a settled session no longer appears busy because of stale client-side timing.

## Workspace polish and stable empty panes

The workspace shell, transcript, home pane, composer, and supporting panes now share a clearer and denser visual hierarchy. Empty activity, agent, file, review, and terminal panes keep their normal header and close control visible, so an empty result never traps the user in a pane without navigation.

## More reliable macOS upgrades

When a bundled OMP upgrade temporarily fails to stop the existing macOS service, T4 Code now retries the stop-and-replace sequence. This avoids leaving the installed backend half-updated during normal desktop upgrades while preserving the existing signed-runtime checks.

The bundled backend now also recovers from an inactive Unix socket when the crashed owner's process ID still appears alive, and after a restart that renumbers the disk identifiers recorded in the leftover ownership files. Previously such a reboot could leave the backend permanently unable to reclaim its own socket, so the app opened with an empty session list. Recovery still confirms the endpoint is unreachable more than once and revalidates every ownership file before reclaiming it, while leaving a responsive backend untouched.

## T4 now owns the host service

T4 Code now packages its own standalone `t4-host` executable instead of running the network host inside OMP. The desktop replaces the old service definition directly and automatically repairs a stopped default service when the local connection falls back to reconnecting. The service label and local socket stay stable, so ordinary local clients and administrative commands keep using the same connection point.

OMP remains the authority for session files, locks, agent execution, credentials, and takeover decisions. The smaller `omp bridge --stdio` command exposes only the versioned authority operations T4 needs. T4 validates the exact `t4-omp-authority/1` bridge before accepting an OMP installation and rejects older appserver-only runtimes.

## Native Browser workspace

The desktop app now includes a built-in Browser workspace that is distinct from the existing host-backed Browser Preview workspace. Its tabs expose stable native surface state for navigation and rendering. New tabs use the credential-isolated `isolated-session` profile. Authenticated profiles are never selected automatically: each use requires the exact user-selected profile with explicit opt-in.

Native Browser automation is bounded to its surface contract. Touch input is currently unsupported and returns a capability error. The desktop closes native Browser surfaces and releases their supporting controllers when the renderer reloads, the window closes, or the app stops.

## Host Browser Preview workspace

Session-linked Host Browser Previews continue to open in their dedicated workspace. The client projects bounded, sanitized preview state from the host, maps pointer and keyboard input through explicit permission gates, and uses leases so two clients cannot silently control the same preview at once. Preview activity records origins and paths without storing query strings, page pixels, credentials, or backend error text.

## Runtime provenance

T4 Code v0.1.33 vendors app-wire 0.7.0 from integration commit [796bb7dc](https://github.com/lyc-aon/oh-my-pi/commit/796bb7dca45027bd4b7b94017cdf41ef214a11f2), source tree `0c195a01ba0bb98fbf4d4863aee59bf23a6e81b7`. The frozen package remains compatibility evidence; T4 owns the active `omp-app/1` wire schema.

The verified OMP 17.0.5 runtime is built from commit [ca2902bc](https://github.com/wolfiesch/oh-my-pi/commit/ca2902bc095a0b17067f4b8b34ecf454390f85ff) and tagged [t4code-17.0.5-appserver-15](https://github.com/wolfiesch/oh-my-pi/tree/t4code-17.0.5-appserver-15). It provides the bounded authority bridge used by T4's standalone host and no longer exposes the old public appserver launchers. It pages snapshot-consistent session inventories across bounded frames, marks over-limit inventories partial, and allows lifecycle actions only when a lock is missing or provably stale. It also keeps session-list metadata sparse before bridge encoding, publishes `xd://` mounts atomically with their transport tools, and preserves bounded newest-first transcript paging, stale-owner recovery, privacy-safe local project reveal, lazy session indexing, cross-session attention and transcript search, and the negotiated browser-preview command surface. Unsupported optional capabilities remain hidden when the host does not advertise them.

The integration is based on the official upstream [v17.0.5 tag](https://github.com/can1357/oh-my-pi/tree/v17.0.5), commit [9fd6e971](https://github.com/can1357/oh-my-pi/commit/9fd6e97113f5ed3a847e66d346970efdf8afcad9). Official upstream OMP v17.0.5 has no `appserver` command and cannot host T4 Code.

## Packages

The Android APK is signed and supports Android 7.0 or later. Linux packages target x86_64. macOS packages target Apple Silicon and are signed and notarized. Verify downloads with `SHA256SUMS.txt`.
