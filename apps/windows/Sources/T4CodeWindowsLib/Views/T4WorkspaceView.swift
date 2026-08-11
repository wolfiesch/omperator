//  T4WorkspaceView.swift (Linux port of apps/ios/Sources/T4WorkspaceView.swift)
//  Desktop-parity shell: the session workspace fills the screen with the
//  session rail pinned on the left and the detail column beside it — the
//  macOS app splits into a slide-over drawer on iOS and a
//  NavigationSplitView on macOS; the Linux client is a fixed two-column
//  layout like the macOS sidebar form.
//
//  Linux port notes:
//  • Drawer gestures, springs, and parallax are dropped — the rail is always
//    mounted (LINUX-GAP: Gesture/animation systems).
//  • @EnvironmentObject → init parameters; @StateObject → @State.
//  • .onReceive(NotificationCenter…) for the palette connect request is
//    replaced by an onRequestConnect closure on T4PaletteView.
//  • Toolbars/navigation titles are plain header rows.
//  • Cross-agent types (TranscriptAgent): T4SessionDetailView,
//    T4ModelMenuButton, T4ModelLabel.labelString, T4Notifier.

import Foundation
import SwiftCrossUI
import HostWire

struct T4WorkspaceView: View {
    let theme: ThemeStore
    let store: T4SessionStore
    let browserFixtureEnabled: Bool

    @State private var showConnect = false
    /// WINDOWS-GAP: Swift 6.3 on Windows crashes while instantiating
    /// `State<PendingPair?>` metadata. Store the wire-safe source values in
    /// primitive state and reconstruct the immutable HostWire value.
    @State private var pendingPairURL = ""
    @State private var pendingPairIssuedAt = 0.0
    @State private var showInbox = false
    @State private var showPalette = false
    @State private var browserModel = T4WindowsBrowserWorkspaceModel()
    @State private var terminalWorkspace = T4WindowsTerminalWorkspaceModel()

    @Environment(\.t4WindowWidth) private var windowWidth
    @Environment(\.t4WindowHeight) private var windowHeight
    private var t: Theme { theme.t }
    private var railWidth: Double {
        if windowWidth < 800 { return 145 }
        if windowWidth < 1_100 { return 160 }
        return 200
    }
    private var inboxWidth: Double {
        380.0 * (2.0 / 3.0)
    }
    private var detailWidth: Double {
        max(windowWidth - railWidth - 1 - (showInbox ? inboxWidth + 1 : 0), 320)
    }
    private var browserSessionIDs: [String] {
        store.sessions.map(\.sessionId).sorted()
    }

    private var pendingPair: PendingPair? {
        guard !pendingPairURL.isEmpty else { return nil }
        return Pairing.parseDeepLink(
            pendingPairURL,
            issuedAtMs: pendingPairIssuedAt
        )
    }
    private var captureReconnecting: Bool {
        T4SessionStore.demoMode
            && ProcessInfo.processInfo.arguments.contains("-T4ShowReconnecting")
    }


    init(
        theme: ThemeStore,
        store: T4SessionStore,
        browserFixtureEnabled: Bool
    ) {
        self.theme = theme
        self.store = store
        self.browserFixtureEnabled = browserFixtureEnabled
    }

    var body: some View {
        ZStack {
            t.bg

            HStack(spacing: 0) {
                rail
                Divider(t.line)
                detail.frame(width: detailWidth, height: windowHeight, alignment: .top)
                // Inbox lives in-window too: a right-side panel (no floating
                // sheet window, no modal grab).
                if showInbox {
                    Divider(t.line)
                    T4InboxView(store: store, theme: theme, isPresented: $showInbox)
                        .frame(width: inboxWidth, height: windowHeight, alignment: .top)
                }
            }

            // Palette overlay (macOS: .overlay + transition).
            if showPalette {
                T4PaletteView(
                    store: store,
                    theme: theme,
                    isPresented: $showPalette,
                    onRequestConnect: { showConnect = true }
                )
            }
        }
        .sheet(isPresented: $showConnect) {
            T4ConnectView(store: store, theme: theme, isPresented: $showConnect, pendingPair: pendingPair)
        }
        .onOpenURL { url in handleDeepLink(url) }
        .onChange(of: browserSessionIDs) {
            browserModel.prune(keeping: Set(browserSessionIDs))
            _ = terminalWorkspace.prune(keeping: Set(browserSessionIDs))
        }
        .onAppear {
            terminalWorkspace.bind(router: store)
            store.selectDefaultVisibleSessionIfNeeded()
            store.startDemoStreamIfNeeded()
            let arguments = ProcessInfo.processInfo.arguments
            // UI-test seams: deterministic, credential-free secondary states.
            if arguments.contains("-T4ShowInbox") { showInbox = true }
            if arguments.contains("-T4ShowPalette") { showPalette = true }
            if arguments.contains("-T4ShowPairing") {
                pendingPairURL = "t4-code://pair/studio-host/123456"
                pendingPairIssuedAt = Date().timeIntervalSince1970 * 1000
                Task {
                    try? await Task.sleep(for: .milliseconds(500))
                    showConnect = true
                }
            } else if arguments.contains("-T4ShowConnect") {
                Task {
                    try? await Task.sleep(for: .milliseconds(500))
                    showConnect = true
                }
            }
        }
        .task {
            await store.restore()
        }
        .task {
            // UI-test seam: launch with
            // -T4PairCode <code> -T4PairEndpoint <ws-or-wss-url>
            // to run the pair handshake on first boot. The endpoint is
            // always explicit so test builds never embed a private host.
            let args = ProcessInfo.processInfo.arguments
            if let codeIndex = args.firstIndex(of: "-T4PairCode"),
               args.indices.contains(codeIndex + 1),
               let endpointIndex = args.firstIndex(of: "-T4PairEndpoint"),
               args.indices.contains(endpointIndex + 1),
               let endpoint = URL(string: args[endpointIndex + 1]),
               endpoint.scheme == "ws" || endpoint.scheme == "wss" {
                await store.pairAndConnect(
                    endpoint: endpoint,
                    code: args[codeIndex + 1],
                    deviceName: platformDeviceName()
                )
            }
        }
        .task {
            // UI-test seam: launch with -T4Send <message> and optionally
            // -T4SendSession <id> to send one prompt from the app's own
            // path once connected (proves the Swift lease flow end-to-end).
            let args = ProcessInfo.processInfo.arguments
            guard let index = args.firstIndex(of: "-T4Send"), args.indices.contains(index + 1) else { return }
            let text = args[index + 1]
            for _ in 0..<40 where !store.connected { try? await Task.sleep(for: .milliseconds(500)) }
            // connected flips before the live inventory lands — wait for real
            // sessions (sample rows carry the fake "studio-mac" host), else the
            // lease acquire goes out with a sample revision and is rejected.
            for _ in 0..<40 where !store.sessions.contains(where: { $0.hostId != "studio-mac" }) {
                try? await Task.sleep(for: .milliseconds(500))
            }
            let requestedSessionId = args.firstIndex(of: "-T4SendSession")
                .flatMap { args.indices.contains($0 + 1) ? args[$0 + 1] : nil }
            let session = requestedSessionId
                .flatMap { id in store.sessions.first(where: { $0.sessionId == id }) }
                ?? store.selectedSession.flatMap { selected in
                    store.sessions.first(where: { $0.sessionId == selected.sessionId })
                }
                ?? store.sessions.first(where: { $0.hostId != "studio-mac" })
            guard store.connected, let session else { return }
            store.select(session)
            // The socket can be mid-reconnect when we get here; retry a few
            // times before giving up (errors surface via store.lastError).
            for attempt in 0..<3 {
                let before = store.lastError
                await store.sendPrompt(sessionId: session.sessionId, text: text)
                if store.lastError == before { return }   // no new error → sent
                try? await Task.sleep(for: .seconds(2))
                if attempt == 2 { return }
            }
        }
    }


    // MARK: - Sidebar column

    /// Rail header (title + theme toggle + live status), search field,
    /// the session list, and the shared connect bar.
    private var rail: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                // WINDOWS-GAP: WinUI shrinks a single Text ahead of Spacer.
                // Two intrinsic runs preserve the Linux title geometry.
                HStack(spacing: 4) {
                    Text("T4").fixedSize()
                    Text("Code").fixedSize()
                }
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(t.txt)
                .frame(width: 100, alignment: .leading)
                Spacer()
                T4TextButton(theme.effective == .dark ? "☀" : "☾") { theme.toggle() }
                    .font(.system(size: 13, weight: .semibold))
                if store.connected {
                    HStack(spacing: 5) {
                        LiveDot(t: t)
                        Text("Live")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(t.diffAdd)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 4)

            TextField("Search sessions", text: Binding(
                get: { store.query },
                set: { store.query = $0 }
            ))
            .padding(.leading, 12)
            .padding(.trailing, 4)
            .padding(.bottom, 4)

            T4SessionsView(store: store, theme: theme) { session in
                store.select(session)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            connectBar
        }
        .frame(width: railWidth)
        .background(t.bg)
    }

    // MARK: - Detail column

    /// Detail header (toolbar replacement): model/session-control menu and
    /// the attention-inbox bell.
    private var detail: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                if let session = store.selectedSession {
                    T4ModelMenuButton(
                        session: session,
                        store: store,
                        theme: t,
                        label: T4ModelLabel.labelString(session.model ?? "choose model")
                    )
                }
                Spacer()
                T4TextButton(inboxButtonLabel) { showInbox = true }
                T4TextButton("⌕") { showPalette = true }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 5)

            Divider(t.line)

            Group {
                if captureReconnecting {
                    reconnectingCaptureState
                } else if ProcessInfo.processInfo.environment["T4_STUB_DETAIL"] == "1" {
                    Text("stub detail")
                } else if !store.hasLiveInventory && !T4SessionStore.demoMode && store.hasSavedConnection {
                    bootSplash
                } else if !store.hasLiveInventory && !T4SessionStore.demoMode {
                    onboarding
                } else if let session = store.selectedSession {
                    T4SessionDetailView(
                        session: session,
                        store: store,
                        theme: theme,
                        inboxPresented: $showInbox,
                        browserModel: browserModel,
                        browserFixtureEnabled: browserFixtureEnabled,
                        terminalWorkspace: terminalWorkspace
                    )
                } else {
                    emptyState
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(t.bg)
    }

    private var inboxButtonLabel: String {
        store.attentionSessions.isEmpty
            ? "Inbox"
            : "Inbox (\(store.attentionSessions.count))"
    }

    private var emptyState: some View {
        VStack(spacing: 18) {
            // LINUX-GAP: sidebar.left SF Symbol → "▤" glyph
            Text("▤")
                .font(.system(size: 44, weight: .light))
                .foregroundColor(t.txtGhost)
            Text("No session selected")
                .font(.system(size: 17, weight: .semibold))
                .foregroundColor(t.txtBody)
            Text("Pick a session from the sidebar.")
                .font(.system(size: 13))
                .foregroundColor(t.txtMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 260)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(t.bg)
    }

    /// Fresh device, nothing configured: honest onboarding, never fake data.
    private var onboarding: some View {
        VStack(spacing: 18) {
            Text("T4 Code")
                        .lineLimit(1)
                .font(.term(44))
                .foregroundColor(t.accent)
            Text("Your agents, from your pocket.")
                .font(.system(size: 15))
                .foregroundColor(t.txtMuted)
            if let error = store.lastError {
                Text(error)
                    .font(.system(size: 12))
                    .foregroundColor(t.diffDel)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }
            T4TextButton("Pair a host") { showConnect = true }
                .padding(12)
                .frame(maxWidth: 260)
                .background { RoundedRectangle(cornerRadius: 12).fill(t.interactiveAccent) }
                .foregroundColor(t.bg)
                .padding(.top, 8)
            Text("Run `t4-host pair` on your Mac and enter the 6-digit code.")
                .font(.system(size: 12))
                .foregroundColor(t.txtLabel)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(t.bg)
    }
    private var reconnectingCaptureState: some View {
        VStack(spacing: t4PlatformMetric(16)) {
            ProgressView()
            Text("Reconnecting to saved host\u{2026}")
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(t.txtBody)
            Text("studio-host.example.test")
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(t.txtMuted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(t.bg)
    }


    /// Saved-host state: connecting during restore, actionable after disconnect.
    private var bootSplash: some View {
        VStack(spacing: 16) {
            if store.connecting {
                ProgressView()
                Text("Connecting to your saved host\u{2026}")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(t.txtBody)
            } else {
                Text("Saved host disconnected")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(t.txtBody)
            }
            if let error = store.lastError {
                Text(error)
                    .font(.system(size: 12))
                    .foregroundColor(t.diffDel)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }
            if !store.connecting {
                HStack(spacing: 12) {
                    T4TextButton("Reconnect") {
                        Task { await store.restore() }
                    }
                    T4TextButton("Saved hosts") {
                        showConnect = true
                    }
                }
                .font(.system(size: 13, weight: .semibold))
                .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(t.bg)
    }

    // MARK: - Connect bar

    /// Bottom bar: where you're plugged in, one obvious action.
    @ViewBuilder
    private var connectBar: some View {
        if captureReconnecting {
            HStack(spacing: 10) {
                ProgressView()
                Text("Reconnecting")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(t.txt)
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 16)
            .overlay(alignment: .top) { Rectangle().fill(t.lineFaint).frame(height: 1) }
        } else if store.connected {
            HStack(spacing: 10) {
                Circle().fill(t.diffAdd).frame(width: 8, height: 8)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Connected").font(.system(size: 13, weight: .semibold)).foregroundColor(t.txt)
                    if let endpoint = store.pairedEndpoint {
                        Text(endpoint.replacingOccurrences(of: "ws://", with: "").replacingOccurrences(of: "/v1/ws", with: ""))
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(t.txtMuted)
                            .lineLimit(1)
                    }
                }
                Spacer()
                T4TextButton("Disconnect") { Task { await store.disconnect() } }
                    .font(.system(size: 13, weight: .semibold))
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 16)
            .overlay(alignment: .top) { Rectangle().fill(t.lineFaint).frame(height: 1) }
        } else {
            HStack(spacing: 10) {
                Circle().fill(t.txtGhost).frame(width: 8, height: 8)
                Text("Not connected")
                    .font(.system(size: 13))
                    .foregroundColor(t.txtMuted)
                Spacer()
                T4TextButton(store.hasSavedConnection ? "Saved hosts" : "Pair") {
                    showConnect = true
                }
                .font(.system(size: 12, weight: .semibold))
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 16)
            .overlay(alignment: .top) { Rectangle().fill(t.lineFaint).frame(height: 1) }
        }
    }

    // MARK: - Deep links

    /// Open the connect sheet prefilled from a `t4-code://pair/<host>/<code>`
    /// link. Ignored when already connected — the user is paired already.
    private func handleDeepLink(_ url: URL) {
        guard !store.connected else { return }
        let issuedAt = Date().timeIntervalSince1970 * 1000
        guard Pairing.parseDeepLink(
            url.absoluteString,
            issuedAtMs: issuedAt
        ) != nil else { return }
        pendingPairURL = url.absoluteString
        pendingPairIssuedAt = issuedAt
        showConnect = true
    }
}
