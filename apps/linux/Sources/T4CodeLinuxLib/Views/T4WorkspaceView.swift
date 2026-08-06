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

    @State private var showConnect = false
    /// Prefilled pair from a t4-code://pair/... deep link; handed to the
    /// connect sheet when it opens.
    @State private var pendingPair: PendingPair?
    @State private var showInbox = false
    @State private var showPalette = false
    /// Created lazily in the attach task: SwiftCrossUI's @State deprecates
    /// non-ObservableObject classes, and the notifier is never observed —
    /// only driven from the attach task (LINUX-GAP: @StateObject).
    @State private var notifier: T4Notifier?

    private var t: Theme { theme.t }

    init(theme: ThemeStore, store: T4SessionStore) {
        self.theme = theme
        self.store = store
    }

    var body: some View {
        ZStack {
            t.bg

            HStack(spacing: 0) {
                rail
                Divider(t.line)
                detail
                // Inbox lives in-window too: a right-side panel (no floating
                // sheet window, no modal grab).
                if showInbox {
                    Divider(t.line)
                    T4InboxView(store: store, theme: theme, isPresented: $showInbox)
                        .frame(width: 380)
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
        .onAppear {
            store.selectDefaultVisibleSessionIfNeeded()
            store.startDemoStreamIfNeeded()
            // UI-test seam: launch with -T4ShowInbox to boot with the inbox open.
            // (LINUX-GAP: -T4RailOpen — the rail is always visible here.)
            if ProcessInfo.processInfo.arguments.contains("-T4ShowInbox") { showInbox = true }
            // Capture seam: launch with -T4ShowPalette to boot with the palette open.
            if ProcessInfo.processInfo.arguments.contains("-T4ShowPalette") { showPalette = true }
        }
        .task {
            if notifier == nil { notifier = T4Notifier() }
            notifier?.attach(to: store)
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
                    Text("T4 Code")
                        .lineLimit(1)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(t.txt)
                    Spacer()
                    // LINUX-GAP: sun.max/moon SF Symbols → ☀/☾ glyphs
                    T4TextButton(theme.effective == .dark ? "☀" : "☾") { theme.toggle() }
                        .font(.system(size: 13, weight: .semibold))
                    if store.connected {
                        HStack(spacing: 5) {
                            LiveDot(t: t)
                            Text("Live").font(.system(size: 11, weight: .semibold)).foregroundColor(t.diffAdd)
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)

            TextField("Search sessions", text: Binding(
                get: { store.query },
                set: { store.query = $0 }
            ))
            .padding(.horizontal, 12)
            .padding(.bottom, 8)

            T4SessionsView(store: store, theme: theme) { session in
                store.select(session)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            connectBar
        }
        .frame(width: 300)
        .background(t.bg)
    }

    // MARK: - Detail column

    /// Detail header (toolbar replacement): model/session-control menu and
    /// the attention-inbox bell.
    private var detail: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                if let session = store.selectedSession {
                    // Cross-agent type (TranscriptAgent): String-label form.
                    T4ModelMenuButton(
                        session: session,
                        store: store,
                        theme: t,
                        label: T4ModelLabel.labelString(session.model ?? "choose model")
                    )
                }
                Spacer()
                // LINUX-GAP: bell SF Symbol + badge → short label with count
                T4TextButton(inboxButtonLabel) { showInbox = true }
                // LINUX-GAP: magnifyingglass toolbar item — the palette is
                // reachable from the detail header on Linux.
                T4TextButton("⌕") { showPalette = true }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)

            Divider(t.line)

            Group {
                if ProcessInfo.processInfo.environment["T4_STUB_DETAIL"] == "1" {
                    // Perf-bisect seam: stub the detail to isolate rail cost.
                    Text("stub detail")
                } else if !store.hasLiveInventory && !T4SessionStore.demoMode && store.hasSavedConnection {
                    bootSplash
                } else if !store.hasLiveInventory && !T4SessionStore.demoMode {
                    onboarding
                } else if let session = store.selectedSession {
                    // Cross-agent type (TranscriptAgent): T4SessionDetailView(session:store:theme:)
                    T4SessionDetailView(session: session, store: store, theme: theme)
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

    /// Boot state for saved-connection devices: connecting, never fake chat.
    private var bootSplash: some View {
        VStack(spacing: 16) {
            ProgressView()
            Text("Connecting to your T4 host\u{2026}")
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(t.txtBody)
            if let error = store.lastError {
                Text(error).font(.system(size: 12)).foregroundColor(t.diffDel)
                    .multilineTextAlignment(.center).padding(.horizontal, 32)
                T4TextButton("Pair a different host") { showConnect = true }
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
        if store.connected {
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
            // No Connect button here — onboarding and the palette own that.
            // The rail bar only manages an EXISTING connection.
            HStack(spacing: 10) {
                Circle().fill(t.txtGhost).frame(width: 8, height: 8)
                Text("Not connected")
                    .font(.system(size: 13))
                    .foregroundColor(t.txtMuted)
                Spacer()
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
        guard let pair = Pairing.parseDeepLink(
            url.absoluteString,
            issuedAtMs: Date().timeIntervalSince1970 * 1000
        ) else { return }
        pendingPair = pair
        showConnect = true
    }
}
