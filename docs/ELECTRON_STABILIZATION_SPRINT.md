# Electron recovery and stabilization sprint

- Status: active; source standardization, automated proof, and unsigned macOS candidate proof complete
- Baseline: `origin/main` at `49442848e0e07558de8033d894e647eb68691ddb`
- Primary product: Electron shell plus the React renderer
- Primary platform: macOS
- Supported release platform: Linux desktop
- Compatibility surfaces: Tailnet browser/PWA and React/Capacitor Android
- Deferred: native Swift macOS and iOS clients

## Outcome

Restore one unambiguous, releasable T4 product around the existing Electron and
React implementation. Preserve the current T4-owned host, OMP authority boundary,
wire protocol, browser workspace, and recent product work. Port only validated
client behavior that Electron missed, prove the installed application against a
real runtime, remove the abandoned Flutter product path, and prepare a new stable
Electron release.

This is a recovery sprint, not a visual rewrite or a new-client project. Swift
planning resumes only after the Electron release and rollback are stable.

## Execution evidence

- Exact baseline `49442848e0e07558de8033d894e647eb68691ddb` completed all required GitHub CI
  jobs successfully.
- PRs #130 and #146 were closed as superseded; independent heartbeat PR #145 was rebased,
  reverified, and merged as `0eb07497f4345254134965e666d337dff438058a`.
- Node 24.13.1 and pnpm 11.10.0 pass `pnpm check`, the full 16-workspace test and build graph,
  32 Playwright scenarios, 49 packaging contracts, the bounded 10k-history proof, and 20
  consecutive reconnect cycles.
- Electron/React is now the sole active desktop product graph. Flutter source, duplicate CI lanes,
  build commands, and demo deployment were removed; the historical migration material is archived.
- The public demo builds from the same React renderer used by Electron and validates its `/demo/`
  containment contract.
- Exact-head CI for `59f1926b3e800eaf692ebaefcd790655a814dc04` passed core, Android debug,
  tooling, cluster, official OMP proof on Linux x64, Linux arm64, and macOS arm64, legacy bridge
  continuity, and the aggregate verifier.
- The unsigned arm64 v0.1.31 candidate produced a 189 MB DMG and 184 MB ZIP, passed ZIP package
  inspection with 956 ASAR entries, and bundled executable arm64 `t4-host` and `omp` binaries.
  Its exact app bundle reports v0.1.31, launched with native macOS window chrome, connected to
  Local OMP, and loaded the live 1,000-session inventory and host controls.
- Remaining evidence is release-bound: protected signed artifacts, a real prompt round trip, Linux
  package launch, Android native smoke, and physical Tailnet Safari proof. No release or tag is
  authorized by this document.

## Current state at planning time

| Evidence | Current state | Sprint consequence |
|---|---|---|
| Public release | v0.1.28 is the latest GitHub release and contains Electron macOS/Linux, React/Capacitor Android, updater metadata, and checksums | Use it as installed-product rollback evidence, not as source to reset onto |
| Current main | Electron, React, Flutter, standalone `t4-host`, and the current OMP wire coexist | Keep current host/protocol work; remove only obsolete client duplication |
| Release workflow | Main still builds Electron macOS/Linux and React/Capacitor Android | Repair and strengthen this existing route rather than adopting PR #146 |
| Draft PR #146 | Deletes Electron and makes Flutter the desktop release | Close as superseded before the sprint PR becomes reviewable |
| PR #130 | Mixes a Flutter macOS launcher with a Flutter endpoint-precedence fix and a small host-contract edit | Do not merge wholesale; salvage only independently valid non-Flutter behavior |
| PR #145 | Focused remote-heartbeat host policy fix | May merge independently; rebase the sprint afterward |
| PR #144 | Site and deployment replacement touching release/site consistency | Coordinate its final site copy and release metadata with this sprint |
| Main CI | `465f0fa` was the last observed complete green main run; `4944284` was still running when this plan was written | Begin implementation only from an exact green main commit |
| Version tags | v0.1.29 and v0.1.30 exist only as local tags in this checkout, not public origin tags/releases | Prefer a fresh unambiguous stabilization version, currently expected to be v0.1.31 |

The primary checkout contains unrelated host-contract edits and is not a sprint
workspace. Use a clean worktree and preserve those edits.

## Product authority after the sprint

```text
macOS / Linux
  Electron shell
      |
      +-- React workspace renderer
      +-- native window, browser, terminal, files, updates, secure storage
      +-- local Unix WebSocket transport
      |
      v
    t4-host  --->  pinned OMP authority

iPhone / iPad / Android / browser compatibility
  React responsive client over a paired Tailnet host
```

The client never becomes runtime authority. `t4-host` continues to own the generic
host and wire boundary, while OMP remains authoritative for sessions, locks,
execution, credentials, tools, and durable transcript truth.

## Sprint guardrails

- Do not implement Swift during this sprint.
- Do not reset to v0.1.28 or discard host/protocol changes made after it.
- Do not merge PR #146 or delete Electron before installed Electron proof passes.
- Do not continue Flutter feature development except a security fix required for
  an already distributed artifact.
- Do not port Flutter code line by line. Recover observable behavior and tests.
- Do not adopt an unmerged Flutter-only feature unless current main's product
  contracts or `FEATURE_MATRIX.md` require it.
- Do not weaken local Unix-socket, credential, browser-profile, path-containment,
  prompt-lease, or runtime-ownership boundaries to simplify recovery.
- Do not call daemon health a verified user experience without a real session
  round trip in an installed app.
- Production release and tag creation remain a separate authorized boundary.

## Delivery shape

Use one long-running draft pull request for the coherent Electron recovery. Keep
the branch checkpointed with focused commits, but avoid multiple overlapping
client PRs. Flutter deletion belongs near the end of the same draft only after the
Electron gates pass on that exact branch.

Focused independent changes such as PR #145 may merge first. Rebase the sprint
after each such merge and require fresh exact-head CI before final review.

## Work packages

### E0 - Freeze direction and establish a clean baseline

1. Wait for exact current-main CI to complete successfully or diagnose it before
   branching implementation work.
2. Close PR #146 as superseded by the Electron recovery direction.
3. Split, close, or supersede PR #130. Retain only a host or compatibility fix that
   reproduces outside Flutter and passes its own focused test.
4. Record the disposition of PRs #144 and #145 and rebase after any merge.
5. Open the Electron stabilization draft from exact green `origin/main`.
6. Run the unmodified baseline with Node 24.13.1 and pnpm 11.10.0:

```sh
mise exec node@24.13.1 -- pnpm install --frozen-lockfile
mise exec node@24.13.1 -- pnpm check
mise exec node@24.13.1 -- pnpm test
mise exec node@24.13.1 -- pnpm build:web
mise exec node@24.13.1 -- pnpm build:desktop
mise exec node@24.13.1 -- pnpm test:e2e
mise exec node@24.13.1 -- pnpm test:packaging
```

Gate E0: the exact baseline commit, tool versions, raw command results, cache state,
and failures are recorded under `.artifacts/electron-stabilization/<commit>/`.
Failures become tracker rows; they are not hidden by changing the test first.

### E1 - Turn the feature map into a parity ledger

Audit current main, not every historical Flutter branch. For each capability:

1. Identify the host/wire authority and required capability.
2. Identify current Electron/React implementation and tests.
3. Inspect Flutter only for a user-visible contract or failure case worth keeping.
4. Classify the row as verified, missing, stale claim, intentional compatibility
   limitation, or obsolete Flutter-only behavior.
5. Add an exact automated and physical proof requirement.

Start with `docs/ELECTRON_STABILIZATION_TRACKER.csv`. The highest-risk audit targets
are:

- host selection, local discovery, pairing, reconnect, and profile precedence;
- tail-first transcript pagination, wheel/scroll anchoring, and encrypted cache;
- capability-derived slash commands, modes, models, reasoning, fast tier, and
  prompt/operation gating;
- session create/rename/archive/restore/delete and stale revision handling;
- approvals, user questions, plans, confirmations, attention, and agent control;
- files, review, terminal, browser, working set, settings, usage, broker status,
  diagnostics, and update lifecycle;
- wide desktop, narrow touch browser, and Android compatibility behavior.

Gate E1: every launch-priority `FEATURE_MATRIX.md` row has a stable Electron gap ID,
current source evidence, status, and next proof. A roadmap row alone is not treated
as shipped behavior.

### E2 - Restore product and documentation authority

Make the repository describe one active product before deleting code:

- `PRODUCT_BRIEF.md`, `README.md`, `PRODUCT.md`, `DESIGN.md`, and development docs
  identify Electron/React as the primary client.
- Flutter is labeled frozen and pending removal until the final cleanup commit.
- Root `dev`, build, package, performance, and release commands point to Electron.
- The public site and release metadata describe the artifacts that are actually
  built from the branch.
- The Android and browser paths are labeled compatibility clients with explicit
  reduced/unavailable states rather than desktop parity.
- The Swift proposal is retained outside the active product contract as deferred
  follow-up material.

Gate E2: release-consistency mutation tests fail when any product surface, package
version, download record, command, or client identity drifts back to Flutter.

### E3 - Stabilize Electron host and connection lifecycle

Exercise and repair the complete local-first path:

- discover the bundled `t4-host` and compatible OMP authority;
- install/start/inspect/restart/stop the per-user service safely;
- connect through the local Unix WebSocket without opening a public listener;
- preserve exact profile and root ownership; fail closed on conflicts;
- support paired remote hosts without silently replacing the selected host;
- reconnect after transport loss and host restart without duplicate commands;
- preserve prompt leases, revision checks, command correlation, and outcome-unknown
  behavior;
- show actionable redacted diagnostics for missing, incompatible, starting,
  unhealthy, and version-skewed runtimes;
- keep the long real-profile cold-start window distinct from a deadlock.

Gate E3: focused desktop lifecycle tests, host integration tests, the legacy bridge
continuity gate, official OMP packaged proof, and a real local Mac session round
trip all pass from the same commit.

### E4 - Converge the React workspace on current contracts

Repair only validated gaps, in dependency order:

1. Host/profile and project/session inventory.
2. Transcript open, paging, live stream, reconnect, cache, and scroll anchoring.
3. Composer, attachments, command/model/mode controls, dispatch, steering, and
   cancellation.
4. Approval/question/plan/confirmation and attention settlement.
5. Agent view, activity, usage, and status truthfulness.
6. Files, turn review, artifacts, transcript search, and export.
7. Universal Working Set and the shared action/Quick Open registry.

Use existing host-wire fixtures and production commands. Do not reimplement a
Flutter decoder or introduce a second client protocol.

Gate E4: focused unit/integration tests and Playwright exercise loading, empty,
offline, observer, read-only, stale, streaming, completed, cancelled, failed, and
reconnected states. A 10k-history run remains bounded and does not stall the
composer or session switch.

### E5 - Prove native desktop surfaces

Treat the Electron main process and native surfaces as product work, not packaging
plumbing:

- Browser workspace: trusted profiles, navigation, capture, input, downloads,
  uploads, permission dialogs, handoff, crashes, and bounded context capture.
- Terminal: PTY lifecycle, tabs, resize, backpressure, paste guard, reconnect, and
  exact session authority.
- Files and review: native pickers, remote-safe paths, save conflicts, diff/comment
  actions, confirmations, and artifact reads.
- Application shell: traffic lights, titlebar, menus, shortcuts, multi-window
  focus, deep links, notifications, accessibility, and state restoration.
- Security: context isolation, narrow preload/IPC, origin checks, navigation and
  popup policy, no wildcard `postMessage`, redaction, and no credential exposure.
- Updates: signed metadata, download/apply/restart, rollback, and failure recovery.

Gate E5: unit tests plus a real macOS Electron window verify OS-drawn chrome and
native interactions. Browser-only screenshots are insufficient for these checks.

### E6 - Stabilize compatibility clients

Keep the shared React client usable without expanding mobile scope:

- Tailnet-only Safari/PWA on iPhone and iPad;
- React/Capacitor Android APK with secure credentials and signed-update checks;
- paired-host selection takes precedence over unavailable local runtime state;
- touch controls remain reachable at 320, 360, and 390 pixel widths;
- file/image pickers, safe areas, resume/reconnect, model selection, prompt round
  trip, and shared transcript convergence work on physical or native clients;
- Funnel remains disabled.

Gate E6: Android debug CI, signed APK inspection in the protected release lane,
physical/native Android smoke, and Tailnet Safari touch proof pass. Desktop-only
features show an explicit unavailable reason.

### E7 - Remove Flutter and simplify the repository

Only after E3 through E6 pass on the branch:

- remove `apps/flutter` and the Dart/Flutter lockfiles, packages, generated native
  runners, tests, coverage tooling, and build scripts;
- remove Flutter CI classifiers and the `flutter`, `flutter-android`, and
  `flutter-apple` jobs;
- remove Flutter packaging, demo, site, release, and maintainer paths; remove live
  Flutter provenance requirements while preserving historical provenance records;
- retire `docs/FLUTTER_MIGRATION_GOAL.md` and `docs/FLUTTER_STAGE1_PROOF.md` while
  preserving useful behavioral contracts in the parity tracker and Git history;
- remove Flutter-specific product copy and compatibility assertions;
- keep the React/Capacitor Android path and public site;
- ensure no active source imports or invokes deleted Flutter artifacts.

Gate E7: an active-tree scan, release consistency, provenance, CI classification,
documentation commands, and package manager checks contain no live Flutter product
reference. Historical changelogs and provenance may retain clearly historical
references.

### E8 - Make Electron release proof required in CI

The final required check set should include:

- core lint, typecheck, all non-Flutter tests, production builds, Playwright, and
  packaging contracts;
- T4/OMP bridge continuity and official packaged OMP gates;
- tooling, provenance, release-consistency, and security mutation tests;
- Android compatibility debug build;
- Linux Electron package build and inspection;
- macOS Electron unsigned package/smoke on pull requests when desktop, packaging,
  runtime, or release paths change;
- the existing cluster lanes only where path classification selects them;
- a fail-closed aggregate `verify` check over every selected lane.

Gate E8: fresh exact-head CI passes after the Flutter deletion commit. No required
check may be green merely because its deleted Flutter job was skipped.

### E9 - Installed release candidate and stabilization

Prepare a fresh release version, expected to be v0.1.31 unless the public version
sequence changes before cutover. Do not reuse ambiguous local-only v0.1.29 or
v0.1.30 tags.

Run the complete release contract:

1. Build and install the signed/notarized macOS DMG and ZIP.
2. Download the DMG through a browser, copy the app to Applications, and launch it
   under Gatekeeper without clearing quarantine.
3. Prove local discovery, session inventory, transcript, prompt, stream,
   cancellation, reconnect, restart recovery, browser, terminal, files/review, and
   update behavior from the installed app.
4. Prove a large real profile separately from a disposable lifecycle profile.
5. Build and inspect Linux `.deb`, AppImage, and updater metadata.
6. Build and inspect the signed Android compatibility APK.
7. Prove two-client convergence between installed Electron and a Tailnet touch
   client.
8. Verify the exact public artifact set, checksums, immutable source commit,
   compatibility matrix, site metadata, and download links.
9. Retain the v0.1.28 public artifacts and the immediately previous known-good
   runtime pair as rollback.

Gate E9: Wolfgang explicitly authorizes production release/tag publication after
reviewing the installed-artifact evidence. Merge readiness alone is not release
authorization.

## Critical path and parallel lanes

```text
E0 baseline and PR disposition
        |
        v
E1 parity ledger -----> E2 product authority
        |
        +-------> E3 host/lifecycle --------+
        +-------> E4 React workspace -------+--> E7 Flutter removal
        +-------> E5 native surfaces -------+          |
        +-------> E6 compatibility clients -+          v
                                                   E8 exact-head CI
                                                         |
                                                         v
                                                   E9 release candidate
```

E3 through E6 can proceed independently once E1 fixes their contracts. E7 is the
convergence point; no lane deletes shared Flutter material early.

## Definition of stable

The sprint is complete only when all of the following are true:

- Electron/React is the sole primary product client in source, docs, CI, packages,
  release metadata, and the public site.
- Every launch-priority capability is verified or carries an explicit accepted
  limitation with a user-visible reason.
- The exact branch passes focused and full tests, builds, packaging checks, OMP
  continuity, official packaged-runtime proof, performance/soak, and exact-head CI.
- A signed installed Mac app completes a real user session round trip and native
  browser/terminal/file workflows.
- Linux packages and Android compatibility artifacts pass their native inspection
  and smoke paths.
- Tailnet-only iPhone/iPad access and multi-client convergence are verified.
- Flutter is absent from the active product tree and required CI.
- No credential, local identity path, private host detail, or secret-like value is
  present in diffs or evidence.
- The release has an exact rollback pair and does not depend on local unpushed tags.
- Swift work remains deferred and has not complicated the stabilization branch.

## Sprint artifacts

- `docs/ELECTRON_STABILIZATION_TRACKER.csv`: live capability and proof ledger.
- `.artifacts/electron-stabilization/<commit>/baseline.json`: exact tools and source.
- `.artifacts/electron-stabilization/<commit>/test-results/`: raw bounded results.
- `.artifacts/electron-stabilization/<commit>/installed-macos/`: package and UI proof.
- `.artifacts/electron-stabilization/<commit>/compatibility/`: Tailnet and Android proof.
- Updated PR description: scope, completed gates, exact commands, unresolved risks,
  and release boundary.
