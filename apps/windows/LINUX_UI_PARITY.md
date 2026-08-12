# Windows / Linux UI migration parity

## Authority and scope

- Migration branch: `shlummi/windows-linux-ui-migration`
- Synchronized Linux source: `origin/linux-port` at `f58729c7fac5216e567c38deaf57386bcb1c5910`
- Structural Windows baseline: `98da2dd`
- Authoritative implementation: `apps/linux/Sources/T4CodeLinuxLib/Views/`
- Authoritative palette and view helpers: `Theme.swift` and `ViewExtras.swift` in that directory
- Authoritative images: `apps/site/public/screenshots/linux-*.png`
- Generated review artifacts: `apps/windows/.build/linux-ui-migration/`

The Windows workspace now routes through the shared Linux views. Windows owns only the platform seams required for WinUI, WebView2, xterm.js, Windows Credential Manager, HostWire transport, launch configuration, and deterministic headless capture. The discarded neutral/macOS-derived Windows rail, session detail, transcript, plan, ask, and core-style implementations have no remaining source files or callsites.

This document records implementation and capture evidence. It does not declare 1:1 visual parity; maintainer approval remains required.

## Shared visual routing

| Surface | Linux source | Windows integration point | Reference | Observed mismatch before correction | Correction | Capture | Status | Genuine backend limitation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Workspace | `T4SessionsView.swift`, `T4SessionDetailView.swift`, `T4TranscriptView.swift`, `ComposerParts.swift` | `T4WorkspaceView.detail` | `linux-workspace-{moon,dawn}.png` | Windows had an independent neutral rail/chat composition; rail, transcript origin, toolbar, wrapping, scroll, and composer geometry diverged. | Restored the shared rail/detail/transcript/composer route; added Windows-only density, line-height, scroll anchoring, intrinsic-size, and bottom-layout adaptations. | `captures/workspace-{moon,dawn}-1600x900.png` | Captured; approval pending | None |
| Palette | `T4PaletteView.swift` | `T4WorkspaceView` palette overlay | `linux-palette-{moon,dawn}.png` | Windows menu geometry and overlay scale did not match the Linux command palette. | Mounted the shared palette with normalized Windows overlay sizing and the shared theme. | `captures/palette-{moon,dawn}-1600x900.png` | Captured; approval pending | None |
| Ask | `T4AskCard.swift` | `T4SessionDetailView.pendingAskCard` | `linux-ask-{moon,dawn}.png` | Windows used a separate ask card with different spacing, selection rows, and editor treatment. | Removed the Windows card and routed the shared card; normalized WinUI text height and padding. | `captures/ask-{moon,dawn}-1600x900.png` | Captured; approval pending | None |
| Files | `T4FilesPane.swift` | `T4SessionDetailView.paneSidebar(.files)` | `linux-files-{moon,dawn}.png` | List density, row height, pane sizing, and toolbar spacing were too loose. | Routed the shared pane; compacted WinUI list-row negotiation and normalized the fixed pane width. | `captures/files-{moon,dawn}-1600x900.png` | Captured; approval pending | None |
| Agents | `T4AgentsPane.swift` | `T4SessionDetailView.paneSidebar(.agents)` | `linux-agents-{moon,dawn}.png` | WinUI rows expanded vertically and progress/detail text produced taller cards. | Routed the shared pane; applied compact list-row padding and Windows-only row stacking/padding corrections. | `captures/agents-{moon,dawn}-1600x900.png` | Captured; approval pending | None |
| Browser | Linux `T4BrowserPaneView.swift` composition | `T4BrowserPaneView` in `T4WindowsBrowserPane.swift`; `T4WindowsWebView2` renderer | `linux-browser-{moon,dawn}.png` | Placeholder browser behavior or the independent Windows shell could not match the Linux right pane and toolbar. | Preserved the WebView2 session model/lifecycle and mounted the real renderer in the shared pane geometry; added deterministic local fixture and isolated failure rendering. | `captures/browser-{moon,dawn}-1600x900.png` | Captured; approval pending | Renderer identity: WebView2 instead of WebKitGTK |
| Terminal | Linux bottom-drawer geometry and shared `T4TerminalModel` | `T4WindowsTerminalDrawer` and `T4WindowsTerminalWebView2` | `linux-terminal-{moon,dawn}.png` | Placeholder/deferred terminal behavior and Windows-only chat chrome did not match the Linux drawer. | Preserved xterm.js, per-session lifecycle, tabs, input, resize, reconnect, and capability gates; mounted them in the Linux-style bottom drawer. | `captures/terminal-{moon,dawn}-1600x900.png` | Captured; approval pending | Renderer identity: xterm.js instead of VTE |
| Plan | `T4PlanStrip.swift` | `T4SessionDetailView` transcript/composer stack | `linux-plan-{moon,dawn}.png` | Windows used a separate plan strip with different expansion and spacing. | Removed the Windows strip and routed the shared plan view; corrected compact WinUI stacking. | `captures/plan-{moon,dawn}-1600x900.png` | Captured; approval pending | None |
| Inbox | `T4InboxView.swift` | `T4WorkspaceView` right-side inbox route | `linux-inbox-{moon,dawn}.png` | Native list rows were taller and the independent Windows shell changed the pane relationship. | Routed the shared inbox and compacted list-row negotiation while retaining the in-window pane. | `captures/inbox-{moon,dawn}-1600x900.png` | Captured; approval pending | None |
| Search / Diff | `T4SearchPane.swift` | `T4SessionDetailView.paneSidebar(.searchDiff)` | `linux-search-{moon,dawn}.png` | WinUI fixed-frame negotiation stretched/clipped the search sheet and did not preserve its centered content. | Routed the shared pane with normalized width/height and a Windows-only full-height centering wrapper. | `captures/search-{moon,dawn}-1600x900.png` | Captured; approval pending | None |
| Review | `T4ReviewPane` in `T4PanesView.swift` | `T4SessionDetailView.paneSidebar(.review)` | `linux-review-{moon,dawn}.png` | Review list density and action/header spacing were too large. | Routed the shared pane and compacted list rows, header padding, and action sizing. | `captures/review-{moon,dawn}-1600x900.png` | Captured; approval pending | None |
| Usage | `T4UsagePane` in `T4PanesView.swift` | `T4SessionDetailView.paneSidebar(.usage)` | `linux-usage-{moon,dawn}.png` | Native progress/list negotiation made rows and controls taller than the reference. | Routed the shared pane; normalized list rows, progress height, and platform padding. | `captures/usage-{moon,dawn}-1600x900.png` | Captured; approval pending | None |
| Artifacts | `T4ArtifactsPane` in `T4PanesView.swift` | `T4SessionDetailView.paneSidebar(.artifacts)` | `linux-artifacts-{moon,dawn}.png` | Artifact rows and pane width diverged in the Windows-only design. | Routed the shared pane and compacted native list-row padding. | `captures/artifacts-{moon,dawn}-1600x900.png` | Captured; approval pending | None |
| Settings | `T4SettingsPane` in `T4PanesView.swift` | `T4SessionDetailView.paneSidebar(.settings)` | `linux-settings-{moon,dawn}.png` | Windows controls had oversized intrinsic widths/heights and loose group spacing. | Routed the shared settings pane; compacted native WinUI picker minima, padding, typography, and menu geometry while preserving picker semantics and responsive pane width. | `captures/settings-{moon,dawn}-1600x900.png` | Captured; approval pending | Native WinUI menu chrome remains platform-specific |

## Capture matrix and comparison outputs

Each authoritative surface above has Moon and Dawn captures at:

- Primary comparison: `1600x900`
- Responsive verification: `1280x800`
- Compact verification: `900x600`

Canonical file pattern:

- Windows capture: `apps/windows/.build/linux-ui-migration/captures/<surface>-<moon|dawn>-<size>.png`
- Normalized Linux reference: `apps/windows/.build/linux-ui-migration/normalized/linux/<surface>-<moon|dawn>-1600x900.png`
- Normalized Windows capture: `apps/windows/.build/linux-ui-migration/normalized/windows/<surface>-<moon|dawn>-1600x900.png`
- Side by side: `apps/windows/.build/linux-ui-migration/comparisons/<surface>-<moon|dawn>-side-by-side.png`
- 50% overlay: `apps/windows/.build/linux-ui-migration/comparisons/<surface>-<moon|dawn>-overlay-50.png`
- Absolute difference: `apps/windows/.build/linux-ui-migration/comparisons/<surface>-<moon|dawn>-absolute-difference.png`
- Stable-region mask: `apps/windows/.build/linux-ui-migration/masks/<surface>-stable-mask-1600x900.png`
- Masked absolute difference: `apps/windows/.build/linux-ui-migration/comparisons/<surface>-<moon|dawn>-masked-absolute-difference.png`
- Pixel metrics: `apps/windows/.build/linux-ui-migration/metrics/authoritative-primary-pixel-metrics.{json,csv}`
- Indexed authoritative contact sheet: `apps/windows/.build/linux-ui-migration/contact-sheets/authoritative-linux-windows-index.png`
- Indexed masked-difference sheet: `apps/windows/.build/linux-ui-migration/contact-sheets/authoritative-masked-difference-index.png`

Captures use deterministic launch arguments, offscreen `SWP_NOACTIVATE` placement, and `PrintWindow`. Every completed capture reports an unchanged foreground window and `applicationForeground=false`.

## Native typography evidence

The native comparison fixture renders eight representative roles through GTK/Pango and WinUI/DirectWrite: display title, assistant and user paragraphs, constrained and natural-width transcript text, tool output, rail subtitle, and settings body. It does not replace either platform renderer.

- Linux Pango resolves shared sans text to `Cantarell` Regular/Bold and monospaced text to `DejaVu Sans Mono`; WinUI resolves bundled byte-identical font files with matching faces and reports no fallback.
- Byte-identical files: `Cantarell-Regular.otf` (`c4d47d7f…df260`), `Cantarell-Bold.otf` (`02792458…d0c4fa4`), and `DejaVuSansMono.ttf` (`c805f943…04d88`).
- All eight probes match the requested family, face, weight, style, and normalized font size. Occupied height matches for the shared body probes; the display-title native WinUI line box is `0.833333` px shorter.
- Native renderer differences remain observable: the constrained GTK assistant/user probes ellipsize to one line while WinUI uses the two-line allocation; tool-result break points and rail/settings occupied widths differ; DirectWrite occupies about `29.77` px more normalized width for the 204-character natural-width transcript probe.
- Windows-only renderer compensation uses the `2/3` density projection, block line-height stacking, `30/1000 em` DirectWrite character spacing for sans roles, and `116/1000 em` for monospaced roles. Linux/Pango metrics remain unmodified.
- Native-property and image-metric report: `reports/typography-parity-final.json`.
- Indexed review sheet: `contact-sheets/typography-parity-contact-sheet.png`.
- Moon/Dawn side-by-side, 50% overlay, and absolute-difference artifacts use the `comparisons/typography-fixture-current-*` prefix.

Typography acceptance criterion: family, bundled file identity, face, weight, style, normalized size, or fallback changes are regressions. Native wrapping, occupied width, line-box rounding, hinting, and antialiasing remain renderer-specific and must be judged against the application comparisons rather than treated as exact cross-renderer metrics.

## Fixed differences

- Removed the independent neutral/macOS-derived Windows core visual layer.
- Restored the shared Linux rail, detail, transcript, composer, ask, plan, palette, inbox, and secondary-pane views.
- Matched the normalized 250 px rail boundary at the 1600 px comparison width, restored compact 32-point session rows, and kept status labels readable inside WinUI fixed-size negotiation.
- Kept every toolbar action visible by removing the duplicate model picker from the shared Windows detail header and constraining native picker and text-button minima.
- Restored the composer at `1600x900`, `1280x800`, and `900x600`; aligned its bottom docking, field proportion, hint row, and plan/ask stacking.
- Corrected transcript viewport sizing, top/bottom insets, message-bubble padding, text line boxes, bottom anchoring, and explicit release/reacquisition after user scrolling.
- Corrected WinUI list minima, row padding, fixed-frame negotiation, native menu/picker density, control padding, and responsive secondary-pane widths.
- Bundled and registered the authoritative Cantarell faces plus DejaVu Sans Mono; retained native Pango and DirectWrite rendering with measured Windows-only advance and line-box compensation.
- Preserved Windows saved-host credentials, restore/disconnect/reconnect/Forget behavior, prompt streaming, HostWire transport, capability gates, and per-session browser/terminal lifecycle.

## Remaining visual differences

These remain visible in the generated comparisons and require maintainer judgment rather than a parity claim:

1. Windows and the authoritative Linux capture resolve the same Cantarell sans and DejaVu Sans Mono files, but WinUI/DirectWrite/ClearType and GTK/Pango/FreeType rasterize, hint, kern, and round glyph metrics differently. The measured fixture also retains renderer-specific constrained wrapping, break points, and occupied widths.
2. Native WinUI pickers, checkboxes, text fields, and buttons retain Windows chevrons, focus affordances, and corner rendering. Their occupied geometry is constrained, but their platform chrome is not replaced with fake GTK controls.
3. Symbol glyphs in rail and pane toolbars differ slightly between the native text renderers.
4. The Windows Moon workspace is byte-reproducible, but the authoritative Linux assets contain a different deterministic demo-stream slice. Transcript rows, progress counters, timestamps, and the topmost visible line can therefore differ while both transcripts remain bottom-anchored.
5. Web content is rendered by WebView2 rather than WebKitGTK, so page font rasterization and scrollbar chrome differ.
6. Terminal content is rendered by xterm.js rather than VTE, so fixture text, monospace rasterization, cursor, selection, and scrollbar chrome differ.
7. Hover, pressed, keyboard-focus, selection, drag, and animated transition frames are not represented by the static `PrintWindow` matrix.
8. WinUI layout quantization still moves a few lower-surface bounds by approximately 1–5 px: the ask card, expanded plan header/body, composer field, and hint-strip edges are the visible cases.
9. Native intrinsic text/control measurement leaves small row-packing and label/value-gap differences inside some secondary panes, especially at responsive widths.
10. Windows color conversion/compositing rounds a few shared sRGB tokens by one channel level (for example, `(42,39,64)` to `(43,40,64)`).
11. The authoritative 1920x1080 Linux assets are Lanczos-normalized to 1600x900 while Windows is captured natively at 1600x900, so resampling contributes one-pixel edge and antialiasing differences.
12. The Windows rail footer exposes `Pair`/`Saved hosts` so the retained Windows Credential Manager host flow remains reachable. The authoritative Linux screenshots show connection status only; this is an intentional Windows-only functional control.

## Genuine backend limitations

- Browser engine parity is behavioral, not renderer identity: Windows must use WebView2 and Linux uses WebKitGTK.
- Terminal engine parity is behavioral, not renderer identity: Windows must use xterm.js and Linux uses VTE.
- SourceKit-LSP on this Windows checkout does not consistently load package context for every SwiftCrossUI-importing entrypoint. `apps/windows/.../RootView.swift` and Linux `T4BrowserPaneView.swift` report `No such module 'SwiftCrossUI'`; the changed shared views and all other native Windows files report no diagnostics, and `swift build` compiles the same entrypoints and shared sources successfully. This is a project-association limitation in the diagnostic tool, not a compiler failure.

## States without authoritative Linux references

These are captured separately and must not be labeled visual parity:

| State | Windows capture |
| --- | --- |
| Saved Hosts | `captures/saved-hosts-moon-1600x900.png` |
| Pairing | `captures/pairing-moon-1600x900.png` |
| Offline | `captures/offline-unreferenced-moon-1600x900.png` |
| Reconnecting | `captures/reconnecting-moon-1600x900.png` |
| Browser failure | `captures/browser-failure-moon-1600x900.png` |
| Terminal failure | `captures/terminal-failure-moon-1600x900.png` |

Indexed sheet: `apps/windows/.build/linux-ui-migration/contact-sheets/windows-only-and-unreferenced-index.png`.

Saved-host captures use an in-memory fixture summary and never read or display credential secrets. Pairing captures contain only deterministic non-secret fixture values, including the fixed device label `Windows workstation`.

## Verification evidence

- Windows `swift build`: passed with the existing Swift 6 actor-isolation warnings.
- Windows `swift test --skip-build`: 47 tests in 7 suites passed.
- Browser-focused suite: 9 tests passed.
- Terminal-focused suite: 14 tests passed.
- Credential-focused suites: 7 tests passed, including the real Windows Credential Manager lifecycle.
- Fixture verification: 10 Windows HostWire/store integration tests and 47 `@t4-code/fixture-server` package tests passed.
- Linux `swift build`: passed after repairing the tracked scroll-anchor dependency patch and aligning the Linux ephemeral certificate-pin seam.
- Linux focused credential test: 1 test passed for endpoint/device/token/certificate-pin parsing.
- Full Linux `swift test --skip-build` was also attempted in the capture container: 3 merge/parser tests passed; the remaining keyring and fixture tests were blocked by that container's missing Secret Service and `bun`, not by assertion failures in the migrated views.
- SourceKit diagnostics: every changed shared view, native Windows source, Linux credential seam, and Linux credential test reports no issues; the two entrypoint/project-association failures are recorded above.
- Headless evidence: all 84 authoritative Moon/Dawn captures exist at `1600x900`, `1280x800`, and `900x600`; dimensions, opacity, and non-empty entropy were validated in `reports/authoritative-capture-matrix-validation.json`.
- Canonical reproducibility: two independent final Moon workspace captures have SHA-256 `b314935a19984ebd2fffd3fb91d1c5062d07524bb2c3727900d03da9805bd7f1`.
- Comparison evidence: 28 normalized Linux references, 28 normalized Windows captures, side-by-side, 50% overlay, raw absolute-difference, stable masks, masked absolute-difference, JSON/CSV metrics, and indexed sheets were generated.
- Stable masks exclude only the WebView2/WebKitGTK page viewport and xterm.js/VTE terminal viewport; the corrected comparable regions are `70.795833%` and `64.214028%` respectively, with all surrounding shared chrome included.
- Dependency preparation: tracked SwiftCrossUI WinUI WebView2 STA and density/list/control patches apply cleanly through `Scripts/prepare-dependencies.ps1`; the Linux scroll-anchor patch also reverse-checks exactly against the prepared checkout.
- Repository-wide affected verification was attempted. Its Windows runner stopped before the first selected command because Node could not spawn the installed `pnpm.cmd` shim (`spawnSync pnpm ENOENT`).
- Direct repository checks confirmed release consistency, provenance, and the portable-platform baseline, then stopped because this workstation has no `cargo`. `pnpm lint` is also unavailable because the installed dependency tree lacks the Windows `tsgolint` executable.
- Direct `pnpm typecheck` reached the site package and reported the existing `apps/site/src/linux/LinuxLanding.tsx:13` `TS18048` error; that file is unchanged from `origin/linux-port`.

## Final manual interaction review

One maintainer pass is still required for interaction-only states that static headless captures cannot prove:

- Keyboard traversal and visible focus order across rail, toolbar, transcript, composer, and secondary panes.
- Mouse hover/pressed states and wheel scrolling in rail, transcript, pane lists, WebView2, and terminal.
- Composer typing, multiline growth, send/cancel, and transcript auto-scroll release/reacquisition.
- Browser address entry, back/forward/reload/home, popup handling, history isolation, and session switching.
- Terminal focus, text input, paste, special keys, resize, tabs, close, disconnect, and reconnect.
- Saved-host validation, reconnect, disconnect, Forget, and pairing submission/error states.
- Palette dismissal, ask responses, plan expansion, pane close actions, and responsive resize transitions.
