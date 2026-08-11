import Foundation
import HostWire
import SwiftCrossUI

/// Windows-owned terminal drawer. The shared T4TerminalModel remains the tab
/// and output authority; this view only projects it into the native WebView2
/// xterm surface and routes renderer events through HostWire.
struct T4WindowsTerminalDrawer: View {
    let session: SessionRef
    let store: T4SessionStore
    let theme: ThemeStore
    let workspace: T4WindowsTerminalWorkspaceModel
    let isOpen: Bool

    @Environment(\.t4WindowWidth) private var windowWidth
    private let terminalModel: T4TerminalModel
    private var t: Theme { theme.t }
    private var drawerHeight: Double {
        if windowWidth < 800 { return 180 }
        if windowWidth < 1_100 { return 240 }
        return 330
    }
    private var terminalIDs: [String] { terminalModel.openIdsBySession[session.sessionId] ?? [] }
    private var activeTerminalID: String? {
        let preferred = terminalModel.activeIdBySession[session.sessionId]
        if let preferred, terminalIDs.contains(preferred) { return preferred }
        return terminalIDs.first
    }
    private var lifecycleID: String {
        "\(session.sessionId):\(activeTerminalID ?? "none"):\(isOpen)"
    }
    private var captureFailure: Bool {
        T4SessionStore.demoMode
            && ProcessInfo.processInfo.arguments.contains("-T4TerminalFailure")
    }


    init(
        session: SessionRef,
        store: T4SessionStore,
        theme: ThemeStore,
        workspace: T4WindowsTerminalWorkspaceModel,
        isOpen: Bool
    ) {
        self.session = session
        self.store = store
        self.theme = theme
        self.workspace = workspace
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
                .frame(height: drawerHeight)
                .background(t.bg2)
                .overlay(alignment: .top) {
                    Rectangle().fill(t.line).frame(height: 0.5)
                }
            }
        }
        .task(id: lifecycleID) {
            await runLifecycle()
        }
        .onChange(of: theme.effective) {
            synchronizeActive(requestFocus: false)
        }
        .onChange(of: isOpen) {
            if isOpen {
                workspace.requestFocus(sessionID: session.sessionId)
            } else {
                workspace.unmount(sessionID: session.sessionId)
            }
        }
        .onDisappear {
            workspace.unmount(sessionID: session.sessionId)
        }
    }

    private var tabBar: some View {
        HStack(spacing: 6) {
            ForEach(Array(terminalIDs.enumerated()), id: \.element) { index, terminalID in
                let selected = terminalID == activeTerminalID
                let exited = terminalModel.exits[terminalID]
                let title = exited.map { "exit \($0)" } ?? "Terminal \(index + 1)"
                HStack(spacing: 5) {
                    Text(title)
                        .font(.system(size: 11, weight: selected ? .semibold : .regular))
                        .foregroundColor(selected ? t.accent : t.txtMuted)
                        .lineLimit(1)
                    if selected {
                        T4TextButton("✕") {
                            Task {
                                await workspace.close(identity: .init(
                                    sessionID: session.sessionId,
                                    terminalID: terminalID
                                ))
                            }
                        }
                        .font(.system(size: 9, weight: .bold))
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background {
                    RoundedRectangle(cornerRadius: 6)
                        .fill(selected ? t.accent.opacity(0.14) : Color.clear)
                }
                .background {
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(selected ? t.accentLine : t.line, style: StrokeStyle(width: 0.5))
                }
                .onTapGesture {
                    terminalModel.activeIdBySession[session.sessionId] = terminalID
                    workspace.requestFocus(sessionID: session.sessionId)
                    synchronizeActive(requestFocus: false)
                }
            }

            if terminalIDs.count < T4WindowsTerminalLimits.maxTerminalsPerSession {
                T4TextButton("+") {
                    Task { _ = await workspace.ensureOpen(sessionID: session.sessionId) }
                }
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(canOpenAnotherTerminal ? t.txtMuted : t.txtGhost)
                .frame(width: 24, height: 24)
                .background {
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(t.line, style: StrokeStyle(width: 0.5))
                }
                .disabled(!canOpenAnotherTerminal)
            }
            Spacer(minLength: 4)
            if let error = workspace.errors[session.sessionId], activeTerminalID == nil {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundColor(t.diffDel)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 0)
        .overlay(alignment: .bottom) {
            Rectangle().fill(t.line).frame(height: 0.5)
        }
    }


    @ViewBuilder
    private var terminalContent: some View {
        let state = workspace.hostState(sessionID: session.sessionId)
        if captureFailure {
            unsupportedState(
                title: "Terminal renderer unavailable",
                detail: "WebView2 could not initialize the xterm.js surface."
            )
        } else if !state.capabilities.canOpen, state.connection == .online {
            unsupportedState(
                title: "Terminal capability unavailable",
                detail: "This host did not grant term.open. Omperator will not present an interactive terminal."
            )
        } else if let terminalID = activeTerminalID {
            terminalSurface(terminalID: terminalID)
        } else {
            emptyTerminalState(state)
        }
    }

    private func terminalSurface(terminalID: String) -> some View {
        let identity = T4WindowsTerminalIdentity(
            sessionID: session.sessionId,
            terminalID: terminalID
        )
        let snapshot = workspace.surfaces[identity]
        return ZStack {
            T4WindowsTerminalWebView2(bridge: workspace.surfaceBridge)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(theme.effective == .dark ? T4WindowsTerminalTheme.moon.backgroundColor : T4WindowsTerminalTheme.dawn.backgroundColor)

            if case .unavailable(let message) = snapshot?.state {
                unsupportedState(title: "Terminal renderer unavailable", detail: message)
            }
        }
    }

    private func emptyTerminalState(_ state: T4WindowsTerminalHostState) -> some View {
        VStack(spacing: 8) {
            Text(state.connection == .offline ? "Terminal detached" : "No terminal is open")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(t.txt)
            Text(emptyDetail(state))
                .font(.system(size: 10))
                .foregroundColor(t.txtMuted)
                .multilineTextAlignment(.center)
            T4TextButton("Open host terminal") {
                Task { _ = await workspace.ensureOpen(sessionID: session.sessionId) }
            }
            .font(.system(size: 10, weight: .semibold))
            .foregroundColor(canOpenAnotherTerminal ? t.accent : t.txtGhost)
            .disabled(!canOpenAnotherTerminal)
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(t.bg2)
    }

    private func unsupportedState(title: String, detail: String) -> some View {
        VStack(spacing: 7) {
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(t.txt)
            Text(detail)
                .font(.system(size: 10))
                .foregroundColor(t.txtMuted)
                .multilineTextAlignment(.center)
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(t.bg2)
    }

    private var canOpenAnotherTerminal: Bool {
        let state = workspace.hostState(sessionID: session.sessionId)
        return terminalIDs.count < T4WindowsTerminalLimits.maxTerminalsPerSession
            && state.connection == .online
            && state.capabilities.canOpen
    }



    private func emptyDetail(_ state: T4WindowsTerminalHostState) -> String {
        if let error = workspace.errors[session.sessionId] { return error }
        if let detail = state.detail { return detail }
        return "The terminal process remains owned by t4-host."
    }

    private func runLifecycle() async {
        guard isOpen else { return }
        var state = await workspace.refreshHostState(sessionID: session.sessionId)
        if terminalIDs.isEmpty, state.connection == .online, state.capabilities.canOpen {
            _ = await workspace.ensureOpen(sessionID: session.sessionId)
        }
        synchronizeActive(requestFocus: true)

        while !Task.isCancelled, isOpen {
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            state = await workspace.refreshHostState(sessionID: session.sessionId)
            synchronizeActive(requestFocus: false)
        }
    }

    private func synchronizeActive(requestFocus: Bool) {
        guard isOpen, let terminalID = activeTerminalID else { return }
        workspace.activate(
            identity: .init(sessionID: session.sessionId, terminalID: terminalID),
            output: terminalModel.output[terminalID] ?? "",
            exited: terminalModel.exits[terminalID],
            appearance: theme.effective,
            requestFocus: requestFocus
        )
    }
}

private extension T4WindowsTerminalTheme {
    var backgroundColor: Color {
        Color(hex: UInt32(background.dropFirst(), radix: 16) ?? 0x232136)
    }
}
