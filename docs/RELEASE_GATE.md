# T4 Code release gate

T4 Code is a client for a separate runtime. A green UI fixture suite proves that the renderer understands its fixtures; it does not prove that a released desktop build can discover OMP, load real history, survive a reconnect, or work through the Tailnet gateway.

Every release must pass the layers below. Destructive lifecycle checks use a disposable OMP profile and disposable session root. They never run against a person's normal sessions.

## Required automated checks

1. Protocol distribution
   - Decode every golden app-wire fixture from the vendored package.
   - Reject stale or locally reimplemented command shapes.
   - Verify the vendored tarball, source tree, fixture corpus, and recorded hashes.
2. OMP runtime packages
   - Run app-wire compatibility, authority-bridge, and coding-agent type checks and focused tests.
   - Cover cursor-domain separation, ordered delivery, bounded replay, lifecycle revision conflicts, busy-session refusal, operation and terminal drain, path containment, deletion recovery, and external discovery deltas.
3. T4 workspaces
   - Run lint, type checks, unit/integration suites, production builds, packaging/tooling checks, and Playwright.
   - Exercise a complete inventory, a truncated inventory, reconnects, authoritative empty state, stale routes, and two clients observing the same session changes.
   - Run the separate unsigned Android job with pinned Java 21, Android platform 36, and build tools 36.0.0. It must complete `testDebugUnitTest`, `assembleDebug`, and `lintDebug` without release-signing secrets.
   - Build macOS release artifacts only in the protected release job. The ZIP and DMG must contain an app signed with the pinned Developer ID certificate and Team ID, hardened runtime, a secure timestamp, Apple notarization, and a stapled ticket. Gatekeeper must accept the app from both artifacts.
4. Touch layouts
   - Use real CDP touch input at 320 pixels for model-list drag scrolling and selection. Check Send and session-management control reachability at 320, 360, and 390 pixels, including a short 390 x 500 viewport.
   - Open and close the session rail, create a session, reach the Send control, drag-scroll the model list, and select its last available model.

## OMP bridge continuity proof

Run the deterministic historical compatibility gate from the T4 repository root with Node 24.13.1 and the pinned migration-era OMP source:

```sh
T4_OMP_SOURCE_DIR=/path/to/lycaon-oh-my-pi pnpm test:legacy-bridge-continuity
```

The gate builds and launches T4's standalone `t4-host`, connects it to the migration-era authority source, and starts a real OMP TUI plus multiple production T4 clients. Its historical command name still says `legacy-bridge`. The gate proves that the host migration did not regress bounded transcript loading, live ownership refusal, concurrent profile isolation, reconnect after an in-flight transport loss, host restart recovery, transcript search/read-around, stale-revision rejection, recovered control, and cleanup. It does not prove compatibility with the currently published OMP release pair.

CI retains that historical gate by resolving its exact authority commit from `provenance/omp-host-migration.json`. A separate required `current-bridge-continuity` job resolves both repository and commit from `compat/omp-app-matrix.json#verifiedRuntime`, builds the current OMP native addon, runs the focused authority tests, and launches the exact current OMP source through T4's `t4-omp-authority/1` bridge client. The aggregate `verify` check requires both proof boundaries. Each job checks out the exact T4 pull-request head and attaches evidence to that commit's check run.

Each successful run writes machine-readable evidence under the historical `artifacts/legacy-bridge-continuity/<run>/` path: `report.json`, sanitized `wire-events.ndjson`, `failure-matrix.json`, `cleanup-status.json`, and an executable `rollback.sh`. The report names the host implementation, records both source commits and dirty-state fingerprints, and captures bounded snapshot sizes, failure codes, delivered cursor integrity, profile overlap, restart persistence, search/context results, and cleanup state. These artifacts are local and ignored by Git.

For a manual failure investigation, rerun with `T4_KEEP_CONTINUITY_SANDBOX=1`. The failed run retains its disposable profile and writes `report.json` plus sanitized `wire-events.ndjson`; successful runs also include `rollback.sh`, which documents the authenticated cleanup request for an explicitly test-mode appserver. Never point the gate or rollback helper at a normal OMP profile.

## Required release-operator proof

1. Start a freshly built `t4-host` with an exact released OMP bridge and isolated config, state, socket, and session directories.
2. Connect two independent T4 clients. Create a disposable session and confirm both clients receive it.
3. Send a prompt, wait for the durable transcript, reconnect both clients, and confirm the history appears once in the same order.
4. Rename, archive, restore, and permanently delete the disposable session. Confirm both clients converge after every change and that archived sessions reject writes.
5. Build and install the Linux desktop package. Launch the installed executable, not a development Electron process, and confirm the expected T4 host service, socket, host identity, session list, transcript, and composer state.
6. Open the actual Tailscale Serve HTTPS URL in a touch browser. Confirm connected state, shared history, model selection, prompt round-trip, reload recovery, and usable controls at the narrowest viewport.
7. Confirm the route is Tailscale Serve only. Funnel must be off.
8. Verify the exact nine-asset GitHub bundle: five installable packages, `latest-linux.yml`, `latest-mac.yml`, the macOS zip blockmap, and `SHA256SUMS.txt`. The checksum file must contain exactly the five package digests plus the Linux updater-metadata digest; the native macOS feed carries and verifies the signed zip's SHA-512. When the website owner has delegated production deployment authority, fetch `https://t4code.net/releases/latest.json` and match its schema, version, tag, release URL, five canonical package records, sizes, immutable URLs, and SHA-256 digests against that GitHub release. Until that authority exists, record the website handoff as deferred and do not claim that the website reflects the current release.
9. On macOS, download the public DMG through a browser, copy T4 Code to Applications, and open it without a quarantine-removal command. Confirm Gatekeeper reports the pinned Developer ID publisher and launches the app normally.

Release sequencing is enforced by the workflows. The branch-required `verify` check is a fail-closed aggregate of the check, unit-test, build and end-to-end, tooling, maintainer, cluster, current-bridge, and unsigned Android jobs. It deliberately excludes the deferred release gates, the legacy bridge continuity proof and the three-platform official OMP matrix, which are skipped on pull requests and aggregated by the separate `release-gates` job so a queued macOS or arm64 runner cannot hold the required check. Both aggregates decide the workflow run conclusion, and the release authority check reads that conclusion, so a deferred gate that fails on `main` still blocks publication. Main-branch runs are keyed by commit and are not cancelled by a later push; pull requests still cancel stale runs. A release tag must match the package version at its immutable commit and resolve to a commit reachable from `main`; a manual rerun may therefore repair an older valid release after `main` advances. The workflow itself must still be dispatched from current `main`, so historical source cannot replace release-control logic. After that source check, the platform builds and the CI authority check run in parallel. The authority check accepts only a successful, completed `push` run of `.github/workflows/ci.yml` on `main` for the exact release SHA. Its wait budget exceeds the longest required CI leg, and publication waits for that run and all three platform builds.

An ordinary main-branch site run defers only when the exact GitHub release lookup returns HTTP 404. Authentication, network, malformed-release, validation, and incomplete-asset failures fail the job. The tag must remain fixed to the verified commit while every platform builds. On a rerun, an already healthy exact nine-file bundle is preserved as an idempotent no-op. Only an incomplete or mismatched bundle is cleared before repair publication, so an unrelated rerun failure cannot take working downloads offline. The publisher then verifies the remote release contains the exact bundle and nothing else. When `T4_RELEASE_SITE_DEPLOY_ENABLED` is explicitly `true`, it dispatches the production workflow from the immutable release tag and waits for that exact deployment run to succeed. The site workflow confirms its tag ref, resolves the published tag back to the same immutable commit, builds the site, writes `/releases/latest.json` from the GitHub release and checksums, and deploys both together. A failed or missing enabled site run fails the release workflow. When deployment authority has not been delegated, the release workflow records the site handoff as deferred without weakening the GitHub artifact checks.

## Why this gate exists

Earlier releases over-weighted fixture coverage and treated a product-surface roadmap as a completion contract. That left gaps at the boundaries between OMP, the client cache, Electron, the gateway, and a real touch browser. It also let single-client tests pass without proving desktop/phone convergence.

Fixture proof is enough to merge code. A release still needs installed-runtime and Tailnet proof.
