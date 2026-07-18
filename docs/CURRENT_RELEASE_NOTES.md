## File edits protect newer work

T4 Code v0.1.23 pins every file draft to the host revision that produced it. If another process changes the file before Save reaches OMP, T4 keeps the draft and marks it **Conflict**. It does not overwrite the newer host copy. After a successful save, T4 reloads the confirmed revision before accepting another edit.

## Hosts and profiles use one registry

The Hosts screen, settings, desktop service manager, and mobile connections now resolve the same remote-target records. Switching an Android connection to another OMP profile returns to that profile's session list instead of leaving a stale session open.

Settings includes a capability explorer for the selected host. It shows the commands and features negotiated from the live appserver, so unavailable controls have a concrete reason. The read-only setup doctor reports OMP discovery, profile counts, service state, and Tailnet reachability without printing tokens or private paths.

## Useful while OMP reconnects

Desktop builds retain the recent session inventory on disk. The last confirmed list appears during startup or a network interruption, marked as cached and read-only. A fresh appserver snapshot replaces it after reconnect; cached data never authorizes a write.

Retryable connections continue with bounded backoff, and profile changes return to an authoritative session list. Two clients still receive the same session revisions and lifecycle results.

## Read responses aloud

A completed assistant response has **Read response aloud** when the device provides both speech and stop controls. Reading starts only after a tap, fenced code is omitted, a second response replaces the first, and leaving the session stops playback.

## Runtime provenance

T4 Code v0.1.23 vendors app-wire 0.5.9 from integration commit [5633bdd7](https://github.com/lyc-aon/oh-my-pi/commit/5633bdd7e5f9062d1822eeeddb9311b2d942bf6f), source tree `4d8794bad6fc57d86058a46dc4698fcca14263e5`. The client contract remains `omp-app/1`.

The matching OMP 17.0.4 runtime is built from commit [be0301f5](https://github.com/lyc-aon/oh-my-pi/commit/be0301f566ef172b6a7e1864853b3f04d6545758) and tagged [t4code-17.0.4-appserver-4](https://github.com/lyc-aon/oh-my-pi/tree/t4code-17.0.4-appserver-4). It adds the versioned Agent View lifecycle contract, session-owned cancellation, macOS system-temp aliases, workspace-native build artifacts, retry-safe release metadata, lock-aware session observation, complete transcript reconciliation, missing-lock-only promotion, and the cooperative `/continue-in-t4` handoff.

The integration is based on the official upstream [v17.0.4 tag](https://github.com/can1357/oh-my-pi/tree/v17.0.4), commit [3fdd85ab](https://github.com/can1357/oh-my-pi/commit/3fdd85ab6c6bab6c0cdee80abbbec0981740a5c0). Official upstream OMP v17.0.4 has no `appserver` command and cannot host T4 Code.

## Packages

The Android APK is signed and supports Android 7.0 or later. Linux packages target x86_64. macOS packages target Apple Silicon.

The macOS build is unsigned and unnotarized. Gatekeeper will block the first launch. After copying T4 Code to Applications, run:

```sh
xattr -dr com.apple.quarantine "/Applications/T4 Code.app"
```

Verify downloads with `SHA256SUMS.txt`.
