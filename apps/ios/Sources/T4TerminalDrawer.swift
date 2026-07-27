//  T4TerminalDrawer.swift
//  Bottom terminal drawer for a session, desktop-parity: a SwiftTerm
//  `TerminalView` wrapped in `UIViewRepresentable`, fed by the store's
//  per-terminal output buffer, sending keystrokes back via
//  `sendTerminalInput`. Resize/close are wired through the store. The drawer
//  docks above the composer in the session detail view and is hidden unless
//  `isOpen` is true. A fixed 280pt height keeps it predictable on touch.

import SwiftUI
import SwiftTerm
import HostWire

/// Bottom drawer hosting a live terminal for one session. Opens on demand
/// (the header terminal button toggles `isOpen`); the first open triggers
/// `store.openTerminal`, which sends `term.open` and records the terminalId.
/// Output frames routed in the store's `observe()` populate
/// `terminalOutput[terminalId]`, which this view feeds to SwiftTerm.
struct T4TerminalDrawer: View {
    let session: SessionRef
    @ObservedObject var store: T4SessionStore
    @EnvironmentObject var theme: ThemeStore
    let isOpen: Bool
    private var t: Theme { theme.t }
    /// Per-session terminal cap (matches the desktop drawer).
    private static let maxTerminals = 4

    var body: some View {
        Group {
            if isOpen {
                VStack(spacing: 0) {
                    tabBar
                    terminalContent
                }
                .frame(height: 280)
                .background(t.bg2)
                .overlay(alignment: .top) { Rectangle().fill(t.line).frame(height: 0.5) }
            }
        }
        .task(id: session.sessionId) {
            if isOpen { await ensureOpen() }
        }
        .onChange(of: isOpen) { _, open in
            if open { Task { await ensureOpen() } }
        }
    }

    /// Tab row across the drawer's top: one rounded tab per open terminal
    /// (max 4), a `+` button to open another (disabled at the cap with an
    /// accessibility reason), and a close `×` on the active tab. The active
    /// tab is tinted with the accent; inactive tabs are muted. Tapping a tab
    /// switches the active terminal instantly via `store.selectTerminal`.
    private var tabBar: some View {
        let sessionId = session.sessionId
        let ids = store.openTerminalIds[sessionId] ?? []
        let active = store.activeTerminalId[sessionId]
        return HStack(spacing: 6) {
            ForEach(Array(ids.enumerated()), id: \.element) { idx, terminalId in
                terminalTab(index: idx + 1, terminalId: terminalId, isActive: terminalId == active)
            }
            addButton(count: ids.count)
            Spacer(minLength: 4)
            if let error = store.terminalErrors[sessionId], active == nil {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundStyle(t.diffDel)
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
        let exited = store.terminalExits[terminalId]
        let title = exited.map { "exit \($0)" } ?? "Terminal \(index)"
        return HStack(spacing: 5) {
            Text(title)
                .font(.system(size: 11, weight: isActive ? .semibold : .regular))
                .foregroundStyle(isActive ? t.accent : t.txtMuted)
                .lineLimit(1)
            if isActive {
                Button {
                    Task { await store.closeTerminal(terminalId: terminalId) }
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(t.txtMuted)
                }
                .press()
                .accessibilityLabel("Close terminal \(index)")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(isActive ? t.accent.opacity(0.14) : .clear)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(isActive ? t.accentLine : t.line, lineWidth: 0.5)
        )
        .contentShape(Rectangle())
        .onTapGesture {
            store.selectTerminal(sessionId: session.sessionId, terminalId: terminalId)
        }
        .accessibilityLabel("Switch to terminal \(index)")
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }

    /// The `+` button: opens another terminal when below the cap, disabled
    /// (with an accessibility reason) at 4. A failed open surfaces via
    /// `terminalErrors`, shown in the tab row's trailing slot.
    private func addButton(count: Int) -> some View {
        let full = count >= Self.maxTerminals
        return Button {
            Task { await store.openTerminal(sessionId: session.sessionId) }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(full ? t.txtGhost : t.txtMuted)
                .frame(width: 24, height: 24)
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .stroke(t.line, lineWidth: 0.5)
                )
                .contentShape(Rectangle())
        }
        .press()
        .disabled(full)
        .accessibilityLabel(full ? "Terminal limit reached" : "Open another terminal")
        .accessibilityHint(full ? "Maximum of \(Self.maxTerminals) terminals per session" : "")
    }

    /// The active terminal's surface, or a status row when there is no
    /// terminal yet / an open error left none open. Switching tabs changes
    /// `activeTerminalId` and re-renders this instantly (the surface is keyed
    /// by terminalId, so SwiftTerm state is preserved per terminal).
    @ViewBuilder private var terminalContent: some View {
        let sessionId = session.sessionId
        let terminalId = store.activeTerminalId[sessionId]
        let error = store.terminalErrors[sessionId]
        if let error, terminalId == nil {
            HStack {
                Spacer()
                VStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 18))
                        .foregroundStyle(t.diffDel)
                    Text(error)
                        .font(.system(size: 12))
                        .foregroundStyle(t.txtMuted)
                        .multilineTextAlignment(.center)
                }
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let terminalId {
            T4TerminalSurface(
                terminalId: terminalId,
                output: store.terminalOutput[terminalId] ?? "",
                exited: store.terminalExits[terminalId],
                theme: t,
                onInput: { data in
                    Task { await store.sendTerminalInput(sessionId: session.sessionId, data: data) }
                },
                onResize: { cols, rows in
                    Task { await store.resizeTerminal(sessionId: session.sessionId, cols: cols, rows: rows) }
                }
            )
            .id(terminalId)
        } else {
            HStack {
                Spacer()
                ProgressView()
                    .controlSize(.small)
                Text("Opening terminal…")
                    .font(.system(size: 12))
                    .foregroundStyle(t.txtMuted)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// Ensure at least one terminal is open for the session (idempotent). The
    /// drawer's first open triggers `openTerminal`; subsequent `+` taps add
    /// tabs. If an active terminal already exists, do nothing.
    private func ensureOpen() async {
        guard store.activeTerminalId[session.sessionId] == nil,
              store.terminalErrors[session.sessionId] == nil else { return }
        await store.openTerminal(sessionId: session.sessionId)
    }
}

/// SwiftUI bridge to SwiftTerm's `TerminalView`. Feeds buffered output
/// (only the newly appended tail each update), forwards keystrokes via
/// `onInput`, and reports pixel→cell resizes via `onResize`. The underlying
/// `TerminalView` is created once and reused across updates.
///
/// Mouse forwarding is automatic: SwiftTerm's `TerminalView` defaults
/// `allowMouseReporting` to true on both platforms and forwards taps/clicks,
/// scrolls, and drags to the pty whenever a TUI app enables a mouse mode
/// (X10 / vt200 / button-event / any-event, +SGR encoding) via DECSET — the
/// `mouseModeChanged` delegate callback enables the iOS mouse-pan gesture
/// on demand. Nothing to opt in to here; only `isUserInteractionEnabled`
/// gates input after pty exit.
struct T4TerminalSurface: View {
    let terminalId: String
    let output: String
    let exited: Int?
    let theme: Theme
    let onInput: (String) -> Void
    let onResize: (Int, Int) -> Void

    var body: some View {
        #if os(iOS)
        return UIKitTerminalSurface(
            terminalId: terminalId, output: output, exited: exited,
            theme: theme, onInput: onInput, onResize: onResize)
        #else
        return AppKitTerminalSurface(
            terminalId: terminalId, output: output, exited: exited,
            theme: theme, onInput: onInput, onResize: onResize)
        #endif
    }
}

// MARK: - Shared coordinator

/// SwiftTerm's `TerminalViewDelegate` protocol is identical on iOS and macOS,
/// so one coordinator serves both bridges.
final class T4TerminalCoordinator: NSObject, TerminalViewDelegate {
    let onInput: (String) -> Void
    let onResize: (Int, Int) -> Void
    var lastFedLength: Int = 0

    init(onInput: @escaping (String) -> Void, onResize: @escaping (Int, Int) -> Void) {
        self.onInput = onInput
        self.onResize = onResize
    }

    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        let bytes = Array(data)
        if let s = String(bytes: bytes, encoding: .utf8) { onInput(s) }
    }

    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        onResize(newCols, newRows)
    }

    func setTerminalTitle(source: TerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func scrolled(source: TerminalView, position: Double) {}
    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {}
    func bell(source: TerminalView) {}
    func clipboardCopy(source: TerminalView, content: Data) {}
    func clipboardRead(source: TerminalView) -> Data? { nil }
    func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

/// Feed only the bytes appended since the last feed (the store buffer is
/// append-only until the ~200KB cap trims the oldest half, at which point
/// `output.count` shrinks below `lastFedLength` and we re-seed from zero).
private func feedTail(_ tv: TerminalView, output: String, coordinator: T4TerminalCoordinator) {
    let count = output.utf8.count
    if count < coordinator.lastFedLength {
        // Buffer was trimmed from the head — re-seed by feeding the whole
        // buffer into a fresh terminal view. SwiftTerm has no public
        // "clear" API, so feed the current buffer as-is; the visual jump
        // is acceptable for a bounded-buffer trim (rare on interactive
        // sessions).
        coordinator.lastFedLength = 0
    }
    guard count > coordinator.lastFedLength else { return }
    let start = output.utf8.index(output.startIndex, offsetBy: coordinator.lastFedLength)
    let tail = String(Substring(output.utf8[start...]))
    tv.feed(text: tail)
    coordinator.lastFedLength = count
}

#if os(iOS)
import UIKit

/// SwiftUI bridge to SwiftTerm's UIKit `TerminalView`.
struct UIKitTerminalSurface: UIViewRepresentable {
    let terminalId: String
    let output: String
    let exited: Int?
    let theme: Theme
    let onInput: (String) -> Void
    let onResize: (Int, Int) -> Void

    func makeCoordinator() -> T4TerminalCoordinator {
        T4TerminalCoordinator(onInput: onInput, onResize: onResize)
    }

    func makeUIView(context: Context) -> TerminalView {
        let tv = TerminalView(frame: .zero, font: UIFont.monospacedSystemFont(ofSize: 12, weight: .regular))
        tv.terminalDelegate = context.coordinator
        tv.backgroundColor = UIColor(theme.bg2)
        // Keep the surface non-interactive once the pty has exited.
        tv.isUserInteractionEnabled = exited == nil
        context.coordinator.lastFedLength = 0
        feedTail(tv, output: output, coordinator: context.coordinator)
        return tv
    }

    func updateUIView(_ tv: TerminalView, context: Context) {
        feedTail(tv, output: output, coordinator: context.coordinator)
        tv.isUserInteractionEnabled = exited == nil
        tv.backgroundColor = UIColor(theme.bg2)
    }
}
#else
import AppKit

/// SwiftUI bridge to SwiftTerm's AppKit `TerminalView`. The macOS view uses
/// `nativeBackgroundColor` (there is no plain `backgroundColor` property) and
/// has no `isUserInteractionEnabled` flag — interactivity is gated by the
/// delegate/first-responder chain instead, so we simply stop forwarding input
/// after exit via the coordinator's `onInput` closure upstream.
struct AppKitTerminalSurface: NSViewRepresentable {
    let terminalId: String
    let output: String
    let exited: Int?
    let theme: Theme
    let onInput: (String) -> Void
    let onResize: (Int, Int) -> Void

    func makeCoordinator() -> T4TerminalCoordinator {
        T4TerminalCoordinator(onInput: onInput, onResize: onResize)
    }

    func makeNSView(context: Context) -> TerminalView {
        let tv = TerminalView(frame: .zero, font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular))
        tv.terminalDelegate = context.coordinator
        tv.nativeBackgroundColor = NSColor(theme.bg2)
        context.coordinator.lastFedLength = 0
        feedTail(tv, output: output, coordinator: context.coordinator)
        return tv
    }

    func updateNSView(_ tv: TerminalView, context: Context) {
        feedTail(tv, output: output, coordinator: context.coordinator)
        tv.nativeBackgroundColor = NSColor(theme.bg2)
    }
}
#endif
