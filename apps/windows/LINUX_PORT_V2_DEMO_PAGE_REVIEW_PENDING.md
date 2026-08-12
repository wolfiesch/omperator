# Linux Port v2 Demo-Page Review Pending

## Code-first baseline

- Authoritative branch: `origin/linux-port`
- Pinned Linux commit: `d4fb75ff3cf24dbd4981948dc4c2d1a685c9b887`
- Previous approved Linux baseline: `f58729c7fac5216e567c38deaf57386bcb1c5910`
- Audit and adaptation ledger: `apps/windows/LINUX_PORT_V2_MIGRATION.md`
- Code-derived UI contract: `apps/windows/LINUX_V2_UI_CONTRACT.md`

## Implemented before demo assets exist

The Windows-owned WinUI/SwiftCrossUI client implements the pinned native GTK hierarchy and behavior: account onboarding; rendezvous discovery and pair-code connection; local-gateway and saved-connection precedence; friendly rail titles and relative timestamps; slim top bar; Moon/Dawn themes; compact and rail/sidebar modes; right-aligned user messages; live-tail settlement; first-open bottom anchoring; per-session scroll memory and follow reacquisition; native-parser-equivalent Markdown emphasis, lists, fenced code, syntax, tool, and advisory presentation; fixed composer behavior; Browser-only ordinary sidebar; plain-language settings; and disconnected/reconnecting projections.

WebView2, xterm.js, Terminal, Files, Search, Diff, Agents, Review, Usage, Artifacts, Windows Credential Manager, and their protocol/store/test paths remain compiled. Only Browser is exposed by the ordinary pinned-Linux sidebar.

## Generated native references

All artifacts are local and ignored under `apps/windows/.build/linux-v2-parity/`:

- Pinned native Linux captures: `linux/`
- Native Windows captures: `windows/`
- Per-state normalized, side-by-side, 50% overlay, and absolute-difference images: `comparisons/<state>/`
- Indexed comparison manifest: `comparison-index.json`
- Indexed contact sheet: `linux-windows-contact-sheet.png`

The complete matched matrix contains onboarding, workspace, friendly rail, user message, streaming, Markdown, Browser, settings closed/open, sidebar shown/hidden, compact/normal, Moon/Dawn, and narrow/standard/wide captures. Linux ran only in private Xvfb from the pinned read-only source archive. Windows launched offscreen, moved with `SWP_NOACTIVATE`, rendered with `PrintWindow(PW_RENDERFULLCONTENT)`, and terminated after every capture.

## States not captured

No requested deterministic state is missing. Real external rendezvous credentials, a live public-relay outage, and an interactive WebView2 navigation session are not embedded in visual artifacts because doing so would depend on secrets or mutable network services. Injected account clients, fixture transports, browser lifecycle tests, and reconnect integration tests cover those behaviors without exposing credentials.

## Demo-page validation checklist

Alexis confirmed that no current example screenshots exist. When current demo assets are published:

1. Download the assets without altering this pinned baseline.
2. Confirm the exact source commit represented by each asset.
3. Reject old Vertical Rectangle, SwiftCrossUI Linux, and macOS screenshots as current authority.
4. Compare each demo state with the pinned Linux capture and matching Windows capture.
5. Correct only demonstrated residual visual deltas; do not replace the completed architecture with another visual rewrite.
6. Re-run the complete native matrix and regenerate normalized, overlay, difference, manifest, and contact-sheet artifacts.
7. Record native GTK/WinUI differences separately from defects.
8. Request final visual-delta approval.
