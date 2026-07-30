## Native iPhone companion and host preview work (unreleased)

The current integration branch adds a candidate native SwiftUI iPhone
companion, plus a shared macOS target used as an integration harness. It does
not change the shipped desktop product: Electron and the canonical React
renderer remain authoritative.

The native client speaks the authoritative `omp-app/1` wire through the new
HostWire Swift package. The implemented surfaces include the session rail,
transcript, composer, files, agents, terminal, review, usage, settings, pairing,
notifications, and a Browser pane. The exact integrated head compiles and
passes the five current iOS UI tests; a production release decision and
device-level proof remain separate work.

The branch also adds the bounded host Browser Preview service and an optional
WSS listener. `--remote-tls-port 8788` serves a per-profile self-signed
certificate, and the native client pins the leaf SHA-256 in the Keychain on
first use, rejects mismatches, and fails closed if it cannot persist the pin.
Plain `ws://` inside the tailnet remains supported.

---

## Current independently owned release

Omperator v0.2.1 is the current release published from
[`wolfiesch/omperator`](https://github.com/wolfiesch/omperator). Its Android package uses the
project's new `net.t4code.app` signing key, and its macOS packages use Michael Schoenberger's pinned
Developer ID certificate and notarization credentials. GitHub Releases is the authoritative
download surface, and the protected release workflow publishes the same immutable release manifest
and checksums to `t4code.net`.

This patch release corrects the composer explanation shown during backend
recovery. A session whose inventory has not finished reconciling now says that
Omperator is reconnecting or connected and syncing; only a genuinely
disconnected transport says that the host is unreachable. The transcript
remains readable throughout recovery.

The signed upgrade preserves the `net.t4code.app` application identifier,
`t4-code://`, `@t4-code/*`, `t4-omp`, service labels, and the existing
Application Support and log paths, so installed credentials, runtime state,
pairing links, and background services continue without migration.

## Electron and React are the product authority

Omperator has standardized on the Electron desktop shell and canonical React renderer. The abandoned
Flutter migration, its duplicate platform targets, and its CI and release plumbing have been
removed. macOS is the primary desktop target, Linux remains supported, and React/Capacitor Android
plus the responsive Tailnet browser/PWA remain compatibility clients for paired hosts.

The standardization preserves T4's standalone host, typed wire, OMP authority boundary, current
session and transcript behavior, native Browser workspace, terminal, files, review, secure
credentials, and signed update path. The public demo now builds from the same React client shipped
inside Electron, eliminating a second product implementation.

## A session rail built for large libraries

The current app makes a large session library easier to navigate. The rail supports text search, activity filters, newest/oldest sorting, grouped and flat layouts, collapsible project folders, and saved display preferences. Those controls follow the Codex desktop organization model while keeping OMP as the source of truth.

Project menus can create a session in that folder, reveal the folder in the system file manager, collapse the group, or hide it from the rail. Hidden projects are not deleted and can be restored from the filter menu. The reveal action is deliberately narrow: the host accepts only project paths already present in its session catalog.

## Faster transcripts and easier context sharing

Opening a large session paints its newest saved transcript entries before older history finishes loading. The composer can insert bounded file references from the active workspace, and the session menu can export a transcript without exposing hidden host state. Session activity labels now follow authoritative runtime events, so a settled session no longer appears busy because of stale client-side timing.

## Workspace polish and stable empty panes

The workspace shell, transcript, home pane, composer, and supporting panes now share a clearer and denser visual hierarchy. Empty activity, agent, file, review, and terminal panes keep their normal header and close control visible, so an empty result never traps the user in a pane without navigation.

## More reliable macOS upgrades

Signed macOS builds now use Electron's native updater against the owned GitHub release feed. The
release includes `latest-mac.yml`, the signed ZIP, and its blockmap; publication fails unless the
metadata references the exact ZIP and DMG names, sizes, and SHA-512 digests. The app downloads only
after the user chooses, then offers an explicit restart into the verified update.

When a bundled OMP upgrade temporarily fails to stop the existing macOS service, Omperator retries the stop-and-replace sequence. This avoids leaving the installed backend half-updated during normal desktop upgrades while preserving the existing signed-runtime checks.

The bundled backend now also recovers from an inactive Unix socket when the crashed owner's process ID still appears alive, and after a restart that renumbers the disk identifiers recorded in the leftover ownership files. Previously such a reboot could leave the backend permanently unable to reclaim its own socket, so the app opened with an empty session list. Recovery still confirms the endpoint is unreachable more than once and revalidates every ownership file before reclaiming it, while leaving a responsive backend untouched.

## T4 now owns the host service

Omperator now packages its own standalone `t4-host` executable instead of running the network host inside OMP. The desktop replaces the old service definition directly and automatically repairs a stopped default service when the local connection falls back to reconnecting. The service label and local socket stay stable, so ordinary local clients and administrative commands keep using the same connection point.

OMP remains the authority for session files, locks, agent execution, credentials, and takeover decisions. The smaller `omp bridge --stdio` command exposes only the versioned authority operations T4 needs. T4 validates the exact `t4-omp-authority/1` bridge before accepting an OMP installation and rejects older appserver-only runtimes.

New sessions created by the paired runtime persist that exact authority protocol in their transcript
header. Once a short-lived terminal writer has released its lock, Omperator can therefore prove the
session is compatible and resume it writable; transcripts without the marker remain read-only.

## Native Browser workspace

The desktop app now includes a built-in Browser workspace that is distinct from the existing host-backed Browser Preview workspace. Its tabs expose stable native surface state for navigation and rendering. New tabs use the credential-isolated `isolated-session` profile. Authenticated profiles are never selected automatically: each use requires the exact user-selected profile with explicit opt-in.

Native Browser automation is bounded to its surface contract. Touch input is currently unsupported and returns a capability error. The desktop closes native Browser surfaces and releases their supporting controllers when the renderer reloads, the window closes, or the app stops.

## Host Browser Preview workspace

Session-linked Host Browser Previews continue to open in their dedicated workspace. The client projects bounded, sanitized preview state from the host, maps pointer and keyboard input through explicit permission gates, and uses leases so two clients cannot silently control the same preview at once. Preview activity records origins and paths without storing query strings, page pixels, credentials, or backend error text.

## Runtime provenance

Omperator v0.2.1 vendors app-wire 0.7.0 from integration commit [796bb7dc](https://github.com/lyc-aon/oh-my-pi/commit/796bb7dca45027bd4b7b94017cdf41ef214a11f2), source tree `0c195a01ba0bb98fbf4d4863aee59bf23a6e81b7`. The frozen package remains compatibility evidence; T4 owns the active `omp-app/1` wire schema.

The verified OMP 17.0.5 runtime is built from commit [d83b6888](https://github.com/wolfiesch/oh-my-pi/commit/d83b688817651d39bfab00676db6109a2d1ccec5) and tagged [t4code-17.0.5-appserver-19](https://github.com/wolfiesch/oh-my-pi/tree/t4code-17.0.5-appserver-19). It provides the bounded authority bridge used by T4's standalone host and no longer exposes the old public appserver launchers. It pages snapshot-consistent session inventories across bounded frames, marks over-limit inventories partial, and allows lifecycle actions only when a lock is missing or provably stale. It also keeps session-list metadata sparse before bridge encoding, projects the durable authority marker only after verifying it from the transcript on disk, publishes `xd://` mounts atomically with their transport tools, preserves bounded newest-first transcript paging, stale-owner recovery, privacy-safe local project reveal, lazy session indexing, cross-session attention and transcript search, and the negotiated browser-preview command surface. Its release includes the five platform binaries, two provenance-bound Linux native addons, and their manifest. It also lets a copied historic session use a caller-selected existing working directory when its recorded directory is gone. Unsupported optional capabilities remain hidden when the host does not advertise them.

The integration is based on the official upstream [v17.0.5 tag](https://github.com/can1357/oh-my-pi/tree/v17.0.5), commit [9fd6e971](https://github.com/can1357/oh-my-pi/commit/9fd6e97113f5ed3a847e66d346970efdf8afcad9). Official upstream OMP v17.0.5 has no `appserver` command and cannot host Omperator.

## Packages

The Android APK is signed and supports Android 7.0 or later. Linux packages target x86_64. macOS packages target Apple Silicon and are signed and notarized. Verify downloads with `SHA256SUMS.txt`.
