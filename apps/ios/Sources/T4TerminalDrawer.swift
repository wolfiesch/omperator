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

    var body: some View {
        Group {
            if isOpen {
                VStack(spacing: 0) {
                    drawerHeader
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

    /// Header row: title + exit/close state. Shows the exit code when the pty
    /// has exited; otherwise a Close button sends terminal.close and clears
    /// the drawer's open state upstream via the binding the owner manages.
    private var drawerHeader: some View {
        let terminalId = store.openTerminalId[session.sessionId]
        let exited = terminalId.flatMap { store.terminalExits[$0] }
        let error = store.terminalErrors[session.sessionId]
        return HStack(spacing: 8) {
            Image(systemName: "terminal")
                .font(.system(size: 12))
                .foregroundStyle(t.cBash)
            Text("Terminal")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(t.txtLabel)
            if let error {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundStyle(t.diffDel)
                    .lineLimit(1)
            } else if let code = exited {
                Text("exited (\(code))")
                    .font(.system(size: 11))
                    .foregroundStyle(t.txtMuted)
            }
            Spacer()
            if terminalId != nil && exited == nil {
                Button {
                    Task { await store.closeTerminal(sessionId: session.sessionId) }
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(t.txtMuted)
                }
                .press()
                .accessibilityLabel("Close terminal")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    /// The terminal surface, or a status row when there is no terminal yet.
    @ViewBuilder private var terminalContent: some View {
        let terminalId = store.openTerminalId[session.sessionId]
        let error = store.terminalErrors[session.sessionId]
        if let error {
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

    /// Ensure a terminal is open for the session (idempotent in the store).
    private func ensureOpen() async {
        guard store.openTerminalId[session.sessionId] == nil,
              store.terminalErrors[session.sessionId] == nil else { return }
        await store.openTerminal(sessionId: session.sessionId)
    }
}

/// SwiftUI bridge to SwiftTerm's UIKit `TerminalView`. Feeds buffered output
/// (only the newly appended tail each update), forwards keystrokes via
/// `onInput`, and reports pixel→cell resizes via `onResize`. The underlying
/// `TerminalView` is created once and reused across updates.
struct T4TerminalSurface: UIViewRepresentable {
    let terminalId: String
    let output: String
    let exited: Int?
    let theme: Theme
    let onInput: (String) -> Void
    let onResize: (Int, Int) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onInput: onInput, onResize: onResize)
    }

    func makeUIView(context: Context) -> TerminalView {
        let tv = TerminalView(frame: .zero, font: UIFont.monospacedSystemFont(ofSize: 12, weight: .regular))
        tv.terminalDelegate = context.coordinator
        tv.backgroundColor = uiColor(theme.bg2)
        // Keep the surface non-interactive once the pty has exited.
        tv.isUserInteractionEnabled = exited == nil
        // Track the last fed length so we only feed the appended tail.
        context.coordinator.lastFedLength = 0
        // Seed any output already buffered before the view existed.
        feedTail(tv: tv, coordinator: context.coordinator)
        return tv
    }

    func updateUIView(_ tv: TerminalView, context: Context) {
        feedTail(tv: tv, coordinator: context.coordinator)
        tv.isUserInteractionEnabled = exited == nil
        // Reflect theme background on appearance changes.
        tv.backgroundColor = uiColor(theme.bg2)
    }

    /// Feed only the bytes appended since the last feed (the store buffer is
    /// append-only until the ~200KB cap trims the oldest half, at which point
    /// `output.count` shrinks below `lastFedLength` and we re-seed from zero).
    private func feedTail(tv: TerminalView, coordinator: Coordinator) {
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
        let tail = String(output.utf8[start...])
        tv.feed(text: tail)
        coordinator.lastFedLength = count
    }

    private func uiColor(_ c: SwiftUI.Color) -> UIColor {
        UIColor(c)
    }

    final class Coordinator: NSObject, TerminalViewDelegate {
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
}
