## Flutter permanent foundations (development)

The local migration branch now contains the Flutter/Dart Stage 2 foundations for macOS, iOS,
Android, and Web, with generated Windows and Linux targets. The client strictly decodes and
encodes the pinned `omp-app/1` corpus, correlates commands, restores typed transcript and
session-index cursors, negotiates host watching, and handles reconnect, resume, and continuity
gaps without moving protocol logic into widgets.

Saved Tailnet hosts, active-host selection, device pairing, host switching, and credential removal
now use shared Dart contracts. Host metadata is stored separately from device credentials; Android
uses encrypted storage and migrates the released app's keyed credentials without exposing them to
Dart, while Apple targets use Keychain-backed storage. Compact and wide layouts share the same
immutable state and command surface, including onboarding, pairing, and host management.

This is still a development migration, not a release cutover. The deterministic fixture suite,
exact 390x844 and 1440x900 browser checks, iOS and Android target smokes, and an authenticated
disposable T4 host connection backed by OMP's authority bridge pass locally. The existing Electron,
React, browser, and Capacitor clients remain the released implementation until the complete feature
matrix, packaging, update, migration, security, and release gates pass.

Stage 3 host parity is now complete on the local migration branch. The Flutter client presents
negotiated device permissions, deliberate disconnect/reconnect controls, cancellable pre-save host
checks, an exact least-authority pairing command, pairing failures, and confirmed host removal that
deletes only the device-local address and credential.

Stage 3 project and session parity is also complete locally. The shared session rail consumes the
canonical session index, groups and searches current or archived sessions, creates and selects
sessions, and exposes rename, runtime termination, archive, restore, and confirmed permanent
deletion through revisioned app-wire commands. Compact drawers and wide rails share the same state
and actions.

Stage 3 transcript and composer parity is complete locally. Durable and live transcript events now
render Markdown, reasoning, tool progress/results, streaming state, and integrity-checked images.
The composer preserves a separate draft and attachment set per session, uploads bounded images
through the chunked app-wire protocol, exposes catalog-backed slash and model choices, applies
thinking and fast-mode controls, and supports steering, queued follow-ups, and confirmed turn
cancellation. Focused protocol, controller, and compact/wide widget coverage passes alongside the
Web release build and fixture-connected macOS, iOS Simulator, and Android emulator smokes.

Stage 3 decisions and attention parity is complete locally. The shared inbox groups approvals,
questions, plans, security confirmations, failures, completions, and background-agent progress.
Actions remain bound to the host session revision, acquire a negotiated prompt lease before
dispatch, and reject replaced or expired requests. The full Flutter suite, Web release build,
compact widget coverage, and an interactive compact-browser decision smoke pass.

Stage 3 developer surfaces are complete locally. A shared developer workspace exposes redacted
activity with filters and pause/copy controls, file browsing and source inspection, selected-file
diff review, and protocol-backed PTY tabs with bounded scrollback, resize/input forwarding, exit
state, and guarded paste. Preview navigation stays host-authoritative: Flutter renders only
integrity-checked capture bytes and never executes page HTML or JavaScript. Focused controller and
compact widget coverage, the full Flutter suite, and fixture-connected Web, iOS Simulator, and
Android emulator smokes exercise the new path.

## A session rail built for large libraries

T4 Code v0.1.30 makes a large session library easier to navigate. The rail now supports text search, activity filters, newest/oldest sorting, grouped and flat layouts, collapsible project folders, and saved display preferences. Those controls follow the Codex desktop organization model while keeping OMP as the source of truth.

Project menus can create a session in that folder, reveal the folder in the system file manager, collapse the group, or hide it from the rail. Hidden projects are not deleted and can be restored from the filter menu. The reveal action is deliberately narrow: the host accepts only project paths already present in its session catalog.

## Faster transcripts and easier context sharing

Opening a large session paints its newest saved transcript entries before older history finishes loading. The composer can insert bounded file references from the active workspace, and the session menu can export a transcript without exposing hidden host state. Session activity labels now follow authoritative runtime events, so a settled session no longer appears busy because of stale client-side timing.

## Workspace polish and stable empty panes

The workspace shell, transcript, home pane, composer, and supporting panes now share a clearer and denser visual hierarchy. Empty activity, agent, file, review, and terminal panes keep their normal header and close control visible, so an empty result never traps the user in a pane without navigation.

## More reliable macOS upgrades

When a bundled OMP upgrade temporarily fails to stop the existing macOS service, T4 Code now retries the stop-and-replace sequence. This avoids leaving the installed backend half-updated during normal desktop upgrades while preserving the existing signed-runtime checks.

The bundled backend now also recovers from an inactive Unix socket when the crashed owner's process ID still appears alive. It confirms the endpoint is unreachable more than once and revalidates every ownership file before reclaiming it, while leaving a responsive backend untouched.

## T4 now owns the host service

T4 Code now packages its own standalone `t4-host` executable instead of running the network host inside OMP. The desktop replaces the old service definition directly and automatically repairs a stopped default service when the local connection falls back to reconnecting. The service label and local socket stay stable, so ordinary local clients and administrative commands keep using the same connection point.

OMP remains the authority for session files, locks, agent execution, credentials, and takeover decisions. The smaller `omp bridge --stdio` command exposes only the versioned authority operations T4 needs. T4 validates the exact `t4-omp-authority/1` bridge before accepting an OMP installation and rejects older appserver-only runtimes.

## Native Browser workspace

The desktop app now includes a built-in Browser workspace that is distinct from the existing host-backed Browser Preview workspace. Its tabs expose stable native surface state for navigation and rendering. New tabs use the credential-isolated `isolated-session` profile. Authenticated profiles are never selected automatically: each use requires the exact user-selected profile with explicit opt-in.

Native Browser automation is bounded to its surface contract. Touch input is currently unsupported and returns a capability error. The desktop closes native Browser surfaces and releases their supporting controllers when the renderer reloads, the window closes, or the app stops.

## Host Browser Preview workspace

Session-linked Host Browser Previews continue to open in their dedicated workspace. The client projects bounded, sanitized preview state from the host, maps pointer and keyboard input through explicit permission gates, and uses leases so two clients cannot silently control the same preview at once. Preview activity records origins and paths without storing query strings, page pixels, credentials, or backend error text.

## Runtime provenance

T4 Code v0.1.30 vendors app-wire 0.7.0 from integration commit [796bb7dc](https://github.com/lyc-aon/oh-my-pi/commit/796bb7dca45027bd4b7b94017cdf41ef214a11f2), source tree `0c195a01ba0bb98fbf4d4863aee59bf23a6e81b7`. The frozen package remains compatibility evidence; T4 owns the active `omp-app/1` wire schema.

The verified OMP 17.0.5 runtime is built from commit [8476f445](https://github.com/lyc-aon/oh-my-pi/commit/8476f4451ed95c5d5401785d279a93d3c659fac4) and tagged [t4code-17.0.5-appserver-10](https://github.com/lyc-aon/oh-my-pi/tree/t4code-17.0.5-appserver-10). It provides the bounded authority bridge used by T4's standalone host and no longer exposes the old public appserver launchers. It preserves bounded newest-first transcript paging, stale-owner recovery, privacy-safe local project reveal, lazy session indexing, cross-session attention and transcript search, and the negotiated browser-preview command surface. Unsupported optional capabilities remain hidden when the host does not advertise them.

The integration is based on the official upstream [v17.0.5 tag](https://github.com/can1357/oh-my-pi/tree/v17.0.5), commit [9fd6e971](https://github.com/can1357/oh-my-pi/commit/9fd6e97113f5ed3a847e66d346970efdf8afcad9). Official upstream OMP v17.0.5 has no `appserver` command and cannot host T4 Code.

## Packages

The Android APK is signed and supports Android 7.0 or later. Linux packages target x86_64. macOS packages target Apple Silicon and are signed and notarized. Verify downloads with `SHA256SUMS.txt`.
