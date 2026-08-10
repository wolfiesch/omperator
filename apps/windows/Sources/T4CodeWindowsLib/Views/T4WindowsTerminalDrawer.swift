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
    private var palette: WindowsCorePalette { WindowsCorePalette(theme.effective) }
    private var drawerHeight: Double {
        if windowWidth < 1_050 { return 160 }
        if windowWidth < 1_350 { return 220 }
        return 280
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
                    statusBar
                    terminalContent
                }
                .frame(height: drawerHeight)
                .background(palette.surface)
                .overlay(alignment: .top) {
                    Rectangle().fill(palette.lineStrong).frame(height: 1)
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
        HStack(spacing: 0) {
            ForEach(Array(terminalIDs.enumerated()), id: \.element) { index, terminalID in
                let selected = terminalID == activeTerminalID
                HStack(spacing: 2) {
                    T4TextButton("Shell \(index + 1)") {
                        terminalModel.activeIdBySession[session.sessionId] = terminalID
                        workspace.requestFocus(sessionID: session.sessionId)
                        synchronizeActive(requestFocus: false)
                    }
                    .font(.system(size: 10, weight: selected ? .semibold : .regular))
                    .foregroundColor(selected ? palette.text : palette.textMuted)
                    .padding(.leading, 10)
                    .frame(height: 33)

                    T4TextButton("×") {
                        Task {
                            await workspace.close(identity: .init(
                                sessionID: session.sessionId,
                                terminalID: terminalID
                            ))
                        }
                    }
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(selected ? palette.textMuted : palette.textFaint)
                    .padding(.trailing, 7)
                    .frame(height: 33)
                }
                .background(selected ? palette.surfaceSubtle : palette.surface)
                .overlay(alignment: .bottom) {
                    Rectangle()
                        .fill(selected ? palette.accent : palette.line)
                        .frame(height: selected ? 2 : 1)
                }
            }

            if terminalIDs.count < T4WindowsTerminalLimits.maxTerminalsPerSession {
                T4TextButton("+") {
                    Task {
                        _ = await workspace.ensureOpen(sessionID: session.sessionId)
                    }
                }
                .font(.system(size: 15, weight: .medium))
                .foregroundColor(canOpenAnotherTerminal ? palette.textMuted : palette.textFaint)
                .frame(width: 33, height: 33)
                .disabled(!canOpenAnotherTerminal)
            }
            Spacer()
            Text("HOST PTY")
                .font(.system(size: 8, weight: .bold, design: .monospaced))
                .foregroundColor(palette.textFaint)
                .padding(.trailing, 10)
        }
        .frame(height: 34)
        .background(palette.surface)
    }

    private var statusBar: some View {
        let state = workspace.hostState(sessionID: session.sessionId)
        return HStack(spacing: 6) {
            Circle()
                .fill(statusColor(state))
                .frame(width: 6, height: 6)
            Text(statusTitle(state))
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                .foregroundColor(palette.textMuted)
            if let error = workspace.errors[session.sessionId] {
                Text(error)
                    .font(.system(size: 9))
                    .foregroundColor(palette.warning)
                    .lineLimit(1)
            } else if let notice = workspace.notices[session.sessionId] ?? state.detail {
                Text(notice)
                    .font(.system(size: 9))
                    .foregroundColor(palette.textFaint)
                    .lineLimit(1)
            }
            if let exit = activeTerminalID.flatMap({ terminalModel.exits[$0] }) {
                Text("Exited \(exit)")
                    .font(.system(size: 9, weight: .semibold, design: .monospaced))
                    .foregroundColor(exit == 0 ? palette.success : palette.warning)
            }
            Spacer()
            Text("Scrollback \(T4WindowsTerminalLimits.scrollbackLines)")
                .font(.system(size: 8, design: .monospaced))
                .foregroundColor(palette.textFaint)
        }
        .padding(.horizontal, 10)
        .frame(height: 24)
        .background(palette.surfaceSubtle)
        .overlay(alignment: .bottom) { Rectangle().fill(palette.line).frame(height: 1) }
    }

    @ViewBuilder
    private var terminalContent: some View {
        let state = workspace.hostState(sessionID: session.sessionId)
        if !state.capabilities.canOpen, state.connection == .online {
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
        return ZStack(alignment: .top) {
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
                .foregroundColor(palette.text)
            Text(emptyDetail(state))
                .font(.system(size: 10))
                .foregroundColor(palette.textMuted)
                .multilineTextAlignment(.center)
            T4TextButton("Open host terminal") {
                Task { _ = await workspace.ensureOpen(sessionID: session.sessionId) }
            }
            .font(.system(size: 10, weight: .semibold))
            .foregroundColor(canOpenAnotherTerminal ? palette.accent : palette.textFaint)
            .disabled(!canOpenAnotherTerminal)
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(palette.surface)
    }

    private func unsupportedState(title: String, detail: String) -> some View {
        VStack(spacing: 7) {
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(palette.text)
            Text(detail)
                .font(.system(size: 10))
                .foregroundColor(palette.textMuted)
                .multilineTextAlignment(.center)
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(palette.surface)
    }

    private var canOpenAnotherTerminal: Bool {
        let state = workspace.hostState(sessionID: session.sessionId)
        return terminalIDs.count < T4WindowsTerminalLimits.maxTerminalsPerSession
            && state.connection == .online
            && state.capabilities.canOpen
    }

    private func statusTitle(_ state: T4WindowsTerminalHostState) -> String {
        if workspace.errors[session.sessionId] != nil { return "ERROR" }
        switch state.connection {
        case .online: return state.inputEnabled ? "LIVE" : "READ ONLY"
        case .reconnecting: return "RECONNECTING"
        case .offline: return "DETACHED"
        }
    }

    private func statusColor(_ state: T4WindowsTerminalHostState) -> Color {
        if workspace.errors[session.sessionId] != nil { return palette.warning }
        switch state.connection {
        case .online: return state.inputEnabled ? palette.success : palette.warning
        case .reconnecting: return palette.warning
        case .offline: return palette.textFaint
        }
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
