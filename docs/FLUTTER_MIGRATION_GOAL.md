# T4 Flutter Rewrite Goal Prompt

Use this prompt to start or resume the T4 Flutter rewrite in OMP goal mode.

```text
Create and activate an OMP goal for the complete objective below. Keep that goal active until every deliverable and cutover gate has current verification evidence.

Work in the T4 repository root on the local branch `feat/flutter-rewrite`; the OMP fork is the sibling `../oh-my-pi` checkout. Keep `main` untouched. Do not push, create a PR, comment on GitHub, publish artifacts, or change either remote unless the user explicitly asks. Local commits are allowed only at verified milestones and must use the repository-local configured contributor identity. Never expose credentials, private repository content, or Codex screenshots outside this workstation.

MIGRATION REFERENCE

- The frozen pre-Flutter behavior reference is T4 Code 0.1.24 at commit `0309cc069980b2f82e604c9b25fb674b6b560dbb`.
- Flutter Stage 1 begins at commit `a606d5399802f6353509eb6eb9a8a6e59c6c80af`.
- The legacy product remains active on `origin/main`; never mistake the frozen baseline for the current product.
- Before each Stage 3 slice, fetch `origin/main`, record the last audited legacy commit, and compare every intervening change that affects the slice's observable behavior.
- Last audited legacy main on 2026-07-19: T4 Code 0.1.28 at commit `f773b4fcf1b32d9b1be0c434a67a8b58b3d86429`.

OBJECTIVE

Replace T4's installed product applications with one Flutter/Dart implementation targeting macOS, Windows, Linux, iOS, Android, and Flutter Web. Flutter Web replaces the authenticated Tailnet browser/PWA client; the public marketing/documentation site remains in its current stack. OMP remains the agent runtime and authority, while T4's standalone host owns the `omp-app/1` network boundary and connects to OMP through its versioned authority bridge. Preserve that WebSocket boundary and port T4's client behavior to Dart rather than embedding the old TypeScript client or a hidden JavaScript runtime.

The rewrite is complete only when the Flutter implementation reaches the existing T4 feature and release gates on every supported target, the old Electron/React/Capacitor product clients can be removed, and deterministic parity evidence exists. Do not relabel a partial proof as the rewrite.

PRODUCT AND DESIGN DIRECTION

- Build a new product structure; do not mechanically translate the current desktop UI.
- Use the locally inspected Codex desktop app only as interaction and information-architecture reference. Do not copy Codex assets, branding, proprietary text, or implementation.
- Preserve T4's own tokenized design identity and light/dark themes.
- Share behavior, state, and most Flutter widgets. Adapt layout and interaction to the screen and input model instead of forcing desktop pixels onto phones.
- Wide desktop: persistent project/session navigation, primary conversation, optional detail pane, compact command controls.
- Compact phone: one primary surface at a time, full-screen routes or drawers for session navigation, a compact native app bar, composer pinned above the safe area, and sheets for secondary actions.
- Tablet/narrow desktop: adaptive intermediate layout.
- Minimum layout checks: 390 x 844 phone, 768 x 1024 tablet/narrow, 1440 x 900 desktop.
- Preserve the observable workflows captured in FEATURE_MATRIX.md, DESIGN.md, PRODUCT.md, PRODUCT_BRIEF.md, docs/OWNERSHIP.md, docs/RELEASE_GATE.md, and the local Codex reference captures.

ARCHITECTURAL BOUNDARIES

1. Keep OMP and the omp-app/1 protocol boundary stable. Change OMP only when a demonstrated protocol defect or missing contract makes the client impossible; Sol must review any such change.
2. Keep packages/fixture-server as the independent deterministic test host. Do not port it to Dart.
3. Build a Dart protocol package that accepts every canonical app-wire fixture, rejects every *.invalid.json fixture, preserves unknown fields safely, enforces bounded history and payload limits, and produces deterministic state.
4. Build a Dart client/state layer for authentication, host profiles, WebSocket lifecycle, reconnect/backoff, revision handling, session and transcript projection, commands, approvals/questions, search, settings, and attention state.
5. Build the Flutter UI above typed state and commands. Widgets must not decode wire frames or own transport policy.
6. Prefer maintained Flutter/Dart packages and Flutter lifecycle APIs for OS capabilities such as Keychain/Keystore-backed storage, background/resume notifications, speech, files/share/open, updates, deep links, tray/window controls, and desktop process integration. Write a custom native plugin only when a focused proof shows that Dart APIs cannot preserve an existing T4 contract.
7. Migrate Android credentials from the existing Capacitor storage into native Flutter storage before deleting the old bridge. Preserve the gateway-origin/authentication contract for Android, iOS, and Flutter Web.
8. No stubs, no hidden JavaScript compatibility runtime, no permanent dual state model, and no second hand-maintained protocol schema.

EXECUTION ORDER

Stage 0 - Grounding and toolchain
- Read the smallest relevant sections of the existing contracts and implementation before editing.
- Confirm the active branch, clean baseline, repository-local identity, and no remote operations.
- Confirm TypeScript, Dart, Kotlin, and Swift language servers are available through OMP. LSP use is mandatory throughout.
- Scaffold the Flutter workspace and define package boundaries only after the protocol and proof contracts are explicit.

Stage 1 - End-to-end technical proof
- Connect to the existing deterministic fixture server.
- Decode and validate representative omp-app/1 frames.
- Render one session list, one long transcript, a streaming response, and a composer.
- Exercise reconnect, revision conflict, authentication failure, cancellation, and bounded 10k-history behavior.
- Run the proof on macOS, iOS, Android, and Flutter Web. The desktop proof must also establish a viable Windows/Linux path without introducing macOS-only core code.
- Build both compact and wide layouts from the start. A desktop-only proof is not sufficient.

Stage 2 - Permanent foundations
- Finalize protocol types and validation, connection lifecycle, immutable state projections, secure host storage, design tokens, adaptive navigation, diagnostics, and fixture-conformance infrastructure.
- Define observable screen states and commands before delegating feature work.

Status: complete on the local migration branch. The permanent client now owns the complete pinned
wire corpus, lifecycle and resume projection, secure host directory and credentials, pairing and
host switching, adaptive host management, shared screen-state/action contracts, and deterministic
real-fixture coverage. Release authority remains with the existing clients until Stages 3 and 4 pass.


Stage 3 - Vertical feature slices
Implement and verify one complete user-visible slice at a time across compact and wide layouts:
1. Host connection, authentication, saved hosts, pairing, connection status, and reconnect.
2. Projects, workspaces, sessions, session lifecycle, grouping, archive/delete/terminate, search, and navigation.
3. Transcript projection, streaming, tool cards, composer, markdown/code, attachments, model/options, cancel, queue, and stop.
4. Approvals, questions, plans, errors/retries, attention inbox, and background/subagent status.
5. Files, review/diff, terminal, browser preview, agents/tasks, activity, diagnostics, and secondary developer surfaces.
6. Settings, themes, OMP settings, updates, desktop runtime discovery/process lifecycle, and mobile lifecycle.

Status: slices 1 through 5 are complete on the local migration branch. The shared client now
negotiates permissions, supports deliberate disconnect/reconnect without fighting the automatic
retry loop, cancels abandoned host probes before persistence, presents the exact pairing command
and host rejection, and requires host-specific confirmation before deleting saved credentials.
It projects the canonical session index, groups sessions by project, supports current and archived
search, creates and selects sessions, and implements rename, terminate, archive, restore, and
permanent deletion through revisioned app-wire commands. The transcript projection renders
streaming messages, Markdown, reasoning disclosures, structured tool progress/results, and
integrity-checked transcript images. The per-session composer preserves drafts, uploads bounded
image attachments through the chunked app-wire flow, presents catalog-backed slash/model controls,
applies thinking and fast-mode changes, and exposes steering, queued follow-ups, and cancellation.
The shared inbox projects host-authoritative approvals, questions, plans, confirmations, outcomes,
and background-agent status; responses revalidate the indexed request and acquire the negotiated
prompt lease before dispatch. The developer workspace now projects redacted activity, file and diff
inspection, protocol-backed PTY tabs with guarded paste, and capture-only previews without running
page code in the Flutter process. Focused protocol, controller, and compact/wide widget tests pass;
the Web release build and fixture-connected compact browser, macOS, iOS Simulator, and Android
emulator smokes are current. Slice 6 remains.

For every slice: identify the existing observable behavior and app-wire messages; run the existing fixture; implement shared Dart state; implement the shared Flutter surface plus compact/wide arrangements; run focused tests; smoke test the actual target; compare iOS, Android, desktop, and Web behavior before moving on.

Stage 4 - Release and cutover
- Meet docs/RELEASE_GATE.md, FEATURE_MATRIX.md, accessibility, performance, security, update/signing, packaging, and migration requirements.
- Prove macOS, Windows, Linux, iOS, Android, and Flutter Web builds through the real release paths.
- Remove replaced Electron/React/Capacitor product code only after parity and rollback gates pass. Keep the public site and independent fixture infrastructure.

LSP REQUIREMENT

- Begin each session with lsp status and diagnostics on representative files for every language being edited.
- Use LSP definition, type definition, hover, references, implementations, code actions, and rename for symbol-aware work. Run references before changing any exported symbol. Never substitute grep or hand-edited cross-file renames when the language server can answer.
- Keep .omp/lsp.json and the installed SDK/server versions working as the Flutter workspace evolves.
- After edits, request diagnostics for every touched source area. Treat a server that is absent, stale, or crashing as a blocker to further edits in that language until repaired.
- TypeScript remains required while the fixture server and legacy behavior reference exist. Dart is required for all Flutter work. SourceKit/Swift is required only when custom iOS code is touched. Defer Kotlin tooling unless a proven Android platform gap requires custom Kotlin code; Flutter/Dart remains the application and UI implementation.

MODEL AND AGENT ROUTING

The main session is GPT-5.6 Sol. Keep the advisor disabled.

Sol owns:
- top-level decomposition and cross-slice contracts;
- Flutter package/module architecture;
- omp-app/1 semantics and protocol evolution;
- reconnect, ordering, replay, revision, and persistence invariants;
- authentication, secure storage, filesystem paths, deep links, updates, lifecycle, and release behavior;
- adaptive navigation and shared state architecture;
- review, integration, fixture selection, smoke tests, commit gates, and any eventual PR description.

Use Sol high for normal orchestration and integration, xhigh for protocol/security/release/architecture decisions, and medium for bounded review. Do not leave Sol on max for routine work.

Use devin/glm-5-2-max as the primary implementation worker. Use devin/glm-5-2-none only for strictly mechanical edits or data collection. Use devin/glm-5-2-max-1m only for a genuinely repo-wide audit that cannot be scoped to 200K context.

Delegate only after Sol defines exact files, interfaces, observable states, acceptance commands, and non-goals. Batch genuinely independent vertical slices in parallel; do not have two agents edit the same core contract. Each worker must investigate and implement its bounded slice in one pass, skip project-wide formatters/test suites, run only focused checks, and return changed paths, contract evidence, command output, risks, and unresolved questions. Sol reviews every worker change and runs integration-level verification once.

GLM is appropriate for:
- mechanical Dart models and validators after the schema is fixed;
- bounded protocol decoders and fixture cases;
- isolated Flutter screens/components from explicit state and interaction specs;
- accessibility labels, keyboard handling, and responsive edge cases;
- platform adapters after the interface and security contract are fixed;
- focused tests and parity repairs.

GLM must not independently decide protocol semantics, authentication/storage policy, reconnect behavior, release/signing policy, adaptive navigation architecture, exported shared-state APIs, or cutover criteria.

VERIFICATION GATES

- Protocol: every canonical golden fixture accepted, every invalid fixture rejected, deterministic expected state, checksum/version drift detected.
- Behavior: focused Dart/Flutter tests defend observable state transitions and plausible failures, not source text or plumbing.
- Static: flutter analyze plus clean OMP LSP diagnostics for touched Dart/Kotlin/Swift/TypeScript areas.
- UI: real Flutter Web browser drive and actual app smoke tests; verify compact and wide layouts, safe areas, keyboard/focus, loading/empty/error/running/completed states, light/dark themes, and accessibility semantics.
- Platforms: build and exercise the changed path on the platforms affected by each slice. Before cutover, prove all six targets through their release build paths.
- Performance: exercise streaming, reconnect storms, multiple clients, large transcripts, and 10k-history without unbounded memory or UI stalls.
- Security: verify credentials never enter logs, screenshots, fixtures, or repository files; native stores and gateway origin checks preserve current boundaries.

OPERATING RULES

- Fix sources, not symptoms. Reuse one convention; delete obsolete code at cutover rather than adding compatibility shims.
- Do not invent extra scope. Do not silently shrink the full rewrite.
- Do not create remote branches, pushes, PRs, comments, releases, or deployments without explicit user instruction.
- Never claim a target works from compilation alone. Smoke test the changed user path and retain exact evidence.
- Maintain an explicit phased todo list. Mark a milestone complete only when every acceptance gate has current evidence.

Start by auditing the current toolchain/LSP status and writing a concise Stage 1 proof contract. Then implement the smallest end-to-end proof that exercises the real fixture server and both compact and wide Flutter UI. Continue until the complete objective and cutover gates are satisfied; do not stop at scaffolding.
```
