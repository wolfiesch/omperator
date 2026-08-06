//  T4TerminalDrawer.swift (Linux port of apps/ios/Sources/T4TerminalDrawer.swift)
//  Bottom terminal drawer for a session, desktop-parity. On macOS a SwiftTerm
//  `TerminalView` is wrapped in a representable, fed by the store's
//  per-terminal output buffer, sending keystrokes back via
//  `sendTerminalInput`. Resize/close are wired through the store. The drawer
//  docks above the composer in the session detail view and is hidden unless
//  `isOpen` is true. A fixed 280pt height keeps it predictable.
//
//  Linux port notes (per the shared porting contract):
//   • The native VTE terminal widget is a wave-3 representable; this port
//     keeps the drawer STRUCTURE (tabs, open/close states, store terminal
//     model wiring) and a placeholder `T4TerminalSurface` (last output line)
//     that the VTE representable will replace. No GTK interop in this task.
//   • @ObservedObject terminalModel + @EnvironmentObject theme → plain `let`
//     properties passed via init.
//   • .press() / .accessibility* / .id(terminalId) → dropped (LINUX-GAP).

import SwiftCrossUI
import HostWire

/// Bottom drawer hosting a live terminal for one session. Opens on demand
/// (the header terminal button toggles `isOpen`); the first open triggers
/// `store.openTerminal`, which sends `term.open` and records the terminalId.
/// Output frames routed in the store's `observe()` populate
/// `terminalOutput[terminalId]`, which this view feeds to the surface.
struct T4TerminalDrawer: View {
    let session: SessionRef
    let store: T4SessionStore
    let theme: ThemeStore
    let isOpen: Bool
    let terminalModel: T4TerminalModel
    private var t: Theme { theme.t }
    /// Per-session terminal cap (matches the desktop drawer).
    private static let maxTerminals = 4

    init(session: SessionRef, store: T4SessionStore, theme: ThemeStore, isOpen: Bool) {
        self.session = session
        self.store = store
        self.theme = theme
        self.terminalModel = store.terminalModel
        self.isOpen = isOpen
    }

    var body: some View {
        Group {
            if isOpen {
                VStack(spacing: 0) {
                    tabBar
                    terminalContent
                }
                .frame(minHeight: 280)
                // LINUX-FIX: was .frame(height: 280) — an exact/max frame
                // makes SCUI pin the VTE's size request, and VTE then never
                // paints text (bg only). minHeight keeps the paint path
                // alive (verified via FocusProbe A/B).
                .background(t.bg2)
                .overlay(alignment: .top) { Rectangle().fill(t.line).frame(height: 0.5) }
            }
        }
        .task(id: session.sessionId) {
            if isOpen { await ensureOpen() }
        }
        .onChange(of: isOpen) {
            if isOpen { Task { await ensureOpen() } }
        }
    }

    /// Tab row across the drawer's top: one rounded tab per open terminal
    /// (max 4), a `+` button to open another (disabled at the cap), and a
    /// close `×` on the active tab. The active tab is tinted with the accent;
    /// inactive tabs are muted. Tapping a tab switches the active terminal
    /// instantly via `store.selectTerminal`.
    private var tabBar: some View {
        let sessionId = session.sessionId
        let ids = terminalModel.openIdsBySession[sessionId] ?? []
        let active = terminalModel.activeIdBySession[sessionId]
        return HStack(spacing: 6) {
            // LINUX-GAP: tuple keypaths (\.offset / \.element) don't
            // typecheck in SwiftCrossUI's ForEach, and `ids.indices`
            // resolves to Swift 6.3's new `indices(where:)` (RangeSet) —
            // use an explicit index range instead.
            ForEach(0..<ids.count, id: \.self) { index in
                terminalTab(index: index + 1, terminalId: ids[index], isActive: ids[index] == active)
            }
            addButton(count: ids.count)
            Spacer(minLength: 4)
            if let error = terminalModel.errors[sessionId], active == nil {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundColor(t.diffDel)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .overlay(alignment: .bottom) { Rectangle().fill(t.line).frame(height: 0.5) }
    }

    /// One tab: title (`Terminal N`, or `exit <code>` once the pty exits) with
    /// active accent tint, and a close `×` shown only on the active tab.
    private func terminalTab(index: Int, terminalId: String, isActive: Bool) -> some View {
        let exited = terminalModel.exits[terminalId]
        let title = exited.map { "exit \($0)" } ?? "Terminal \(index)"
        return HStack(spacing: 5) {
            Text(title)
                .font(.system(size: 11, weight: isActive ? .semibold : .regular))
                .foregroundColor(isActive ? t.accent : t.txtMuted)
                .lineLimit(1)
            if isActive {
                // LINUX-GAP: Image(systemName: "xmark") — text glyph; .press()
                // dropped (no-op on SwiftCrossUI).
                T4TextButton("✕") {
                    Task { await store.closeTerminal(terminalId: terminalId) }
                }
                .font(.system(size: 9, weight: .bold))
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        // LINUX-GAP: `.background(in: RoundedRectangle(...))` shape fill with
        // `.continuous` style → cornerRadius + fill view. Ring lives in the
        // background too — an overlay stroke would eat the tab's tap gesture.
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(isActive ? t.accent.opacity(0.14) : Color.clear)
        )
        .background(
            RoundedRectangle(cornerRadius: 6)
                .stroke(isActive ? t.accentLine : t.line, style: StrokeStyle(width: 0.5))
        )
        .onTapGesture {
            store.selectTerminal(sessionId: session.sessionId, terminalId: terminalId)
        }
    }

    /// The `+` button: opens another terminal when below the cap, disabled
    /// at 4. A failed open surfaces via `terminalErrors`, shown in the tab
    /// row's trailing slot.
    private func addButton(count: Int) -> some View {
        let full = count >= Self.maxTerminals
        return T4TextButton("+") {
            Task { await store.openTerminal(sessionId: session.sessionId) }
        }
        .font(.system(size: 11, weight: .semibold))
        .foregroundColor(full ? t.txtGhost : t.txtMuted)
        .frame(width: 24, height: 24)
        .background {
            RoundedRectangle(cornerRadius: 6)
                .stroke(t.line, style: StrokeStyle(width: 0.5))
        }
        .disabled(full)
    }

    /// The active terminal's surface, or a status row when there is no
    /// terminal yet / an open error left none open. Switching tabs changes
    /// `activeTerminalId` and re-renders this instantly.
    @ViewBuilder private var terminalContent: some View {
        let sessionId = session.sessionId
        let terminalId = terminalModel.activeIdBySession[sessionId]
        let error = terminalModel.errors[sessionId]
        if let error, terminalId == nil {
            HStack {
                Spacer()
                VStack(spacing: 6) {
                    // LINUX-GAP: Image(systemName: "exclamationmark.triangle")
                    // — text glyph.
                    Text("⚠")
                        .font(.system(size: 18))
                        .foregroundColor(t.diffDel)
                    Text(error)
                        .font(.system(size: 12))
                        .foregroundColor(t.txtMuted)
                        .multilineTextAlignment(.center)
                }
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let terminalId {
            // Real VTE surface (Seams/TerminalPane.swift): feeds host-PTY
            // output and forwards keystrokes + resizes back over the wire.
            T4TerminalPane(
                terminalId: terminalId,
                output: terminalModel.output[terminalId] ?? "",
                exited: terminalModel.exits[terminalId],
                onInput: { data in
                    Task { await store.sendTerminalInput(sessionId: session.sessionId, data: data) }
                },
                onResize: { cols, rows in
                    Task { await store.resizeTerminal(sessionId: session.sessionId, cols: cols, rows: rows) }
                }
            )
            // The representable never re-receives `output` after mount
            // (SwiftCrossUI keeps the initial representable value), so live
            // output is pushed straight into the VTE coordinator.
            .onChange(of: terminalModel.output[terminalId] ?? "") {
                T4TerminalFeeds.push(terminalId, full: terminalModel.output[terminalId] ?? "")
            }
            // LINUX-GAP: macOS keys the surface `.id(terminalId)` so the VTE
            // state survives tab switches; no `.id` modifier in SwiftCrossUI.
        } else {
            HStack {
                Spacer()
                // LINUX-GAP: .controlSize(.small) on ProgressView.
                ProgressView()
                Text("Opening terminal…")
                    .font(.system(size: 12))
                    .foregroundColor(t.txtMuted)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// Ensure at least one terminal is open for the session (idempotent). The
    /// drawer's first open triggers `openTerminal`; subsequent `+` taps add
    /// tabs. If an active terminal already exists, do nothing.
    private func ensureOpen() async {
        guard terminalModel.activeIdBySession[session.sessionId] == nil,
              terminalModel.errors[session.sessionId] == nil else { return }
        await store.openTerminal(sessionId: session.sessionId)
    }
}
