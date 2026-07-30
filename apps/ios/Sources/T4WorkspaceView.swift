//  T4WorkspaceView.swift
//  Desktop-parity shell: the session workspace fills the screen and the
//  session rail is a slide-over drawer — exactly like the T4 desktop app's
//  narrow-width rail overlay. Swipe right from the left edge (or tap the
//  sidebar button) to reveal sessions; tap the scrim or swipe left to dismiss.
//
//  Mechanics: the drawer is ALWAYS mounted, parked off-screen. One source of
//  truth — `railProgress` (0…1) — drives the drawer offset, the scrim, and a
//  subtle workspace parallax. Drags scrub the progress directly; release
//  settles with an interpolating spring seeded with the finger's velocity, so
//  a fling carries momentum like the iOS back gesture. (A conditionally
//  inserted drawer + .animation(value:) can't interpolate — it snaps.)

import SwiftUI
import HostWire

struct T4WorkspaceView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var store: T4SessionStore
    @State private var railProgress: CGFloat = 0   // 0 = closed, 1 = open
    @State private var showConnect = false
    /// Prefilled pair from a t4-code://pair/... deep link; handed to the
    /// connect sheet when it opens.
    @State private var pendingPair: PendingPair?
    @State private var showInbox = false
    @State private var showPalette = false
    @StateObject private var notifier = T4Notifier()
    private var t: Theme { theme.t }

    private var railOpen: Bool { railProgress > 0.5 }
    private func railWidth(for screen: CGFloat) -> CGFloat { min(320, screen * 0.84) }

    var body: some View {
        #if os(macOS)
        sharedModifiers(macBody)
        #else
        sharedModifiers(drawerBody)
        #endif
    }

    /// Sheets, deep links, and UI-test task seams shared by both platforms so
    /// the iOS drawer and the macOS split view stay in lockstep.
    @ViewBuilder
    private func sharedModifiers(_ content: some View) -> some View {
        content
            .sheet(isPresented: $showConnect) {
                T4ConnectView(store: store, pendingPair: pendingPair)
                    .environmentObject(theme)
                    #if os(macOS)
                    .frame(minWidth: 520, minHeight: 480)
                    #endif
            }
            .sheet(isPresented: $showInbox) {
                T4InboxView(store: store, isPresented: $showInbox)
                    .environmentObject(theme)
            }
            .overlay {
                if showPalette {
                    T4PaletteView(isPresented: $showPalette)
                        .environmentObject(theme)
                        .environmentObject(store)
                        .transition(.opacity)
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .t4PaletteRequestConnect)) { _ in
                showConnect = true
            }
            .onOpenURL { url in handleDeepLink(url) }
            .onAppear {
                store.selectDefaultVisibleSessionIfNeeded()
                // UI-test seam: launch with -T4RailOpen to boot with the rail open.
                if ProcessInfo.processInfo.arguments.contains("-T4RailOpen") { railProgress = 1 }
                // UI-test seam: launch with -T4ShowInbox to boot with the inbox open.
                if ProcessInfo.processInfo.arguments.contains("-T4ShowInbox") { showInbox = true }
            }
            .task {
                notifier.attach(store)
                await store.restore()
            }
            #if DEBUG
            .task {
                if ProcessInfo.processInfo.arguments.contains("-T4StreamingProof") {
                    if store.selectedSession == nil { store.select(store.sessions.first) }
                    await store.runStreamingProofFixture()
                }
            }
            #endif
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
                // path once connected (proves the Swift lease flow end-to-end
                // without touch injection).
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

    // MARK: - iOS root (drawer)

    private var drawerBody: some View {
        GeometryReader { geo in
            let width = railWidth(for: geo.size.width)

            ZStack(alignment: .leading) {
                workspace
                    .offset(x: railProgress * 12)            // parallax nudge
                    .allowsHitTesting(railProgress < 0.02)

                // Scrim tracks the drawer; hit-testable only when visible.
                Color.black.opacity(0.5 * railProgress)
                    .ignoresSafeArea()
                    .allowsHitTesting(railProgress > 0.02)
                    .onTapGesture { closeRail() }
                    .gesture(closeDrag(width: width))

                // Edge hot zone: only hit-testable while the drawer is closed,
                // so the workspace keeps its own horizontal gestures.
                if railProgress == 0 {
                    Color.clear
                        .frame(width: 28)
                        .frame(maxHeight: .infinity)
                        .contentShape(Rectangle())
                        .gesture(openDrag(width: width))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                rail(width: width)
                    .offset(x: (railProgress - 1) * width)
                    .gesture(closeDrag(width: width))
                    .accessibilityHidden(railProgress == 0)
            }
        }
        .background(t.bg.ignoresSafeArea())
    }

    #if os(macOS)
    // MARK: - macOS root (NavigationSplitView)

    @EnvironmentObject private var macCommands: MacCommandsModel
    @FocusState private var railSearchFocused: Bool
    @State private var renameTarget: SessionRef?
    @State private var renameText = ""

    private var macBody: some View {
        NavigationSplitView(columnVisibility: $macCommands.columnVisibility) {
            macRail
        } detail: {
            macDetail
        }
        .focusedSceneValue(\.t4SessionStore, store)
        .focusedSceneValue(\.macCommands, macCommands)
        .onChange(of: macCommands.focusSearchTick) { _, _ in railSearchFocused = true }
        .onChange(of: macCommands.dismissTick) { _, _ in
            showConnect = false
            showInbox = false
            showPalette = false
        }
        .onChange(of: macCommands.connectTick) { _, _ in showConnect = true }
        .onChange(of: macCommands.paletteTick) { _, _ in showPalette = true }
        .onChange(of: macCommands.renameTarget) { _, target in
            renameTarget = target
            renameText = target?.title ?? ""
        }
        .alert("Rename Session", isPresented: Binding(
            get: { renameTarget != nil },
            set: { if !$0 { renameTarget = nil; macCommands.renameTarget = nil } }
        )) {
            TextField("Session name", text: $renameText)
            Button("Rename") {
                if let s = renameTarget {
                    Task { await store.renameSession(sessionId: s.sessionId, name: renameText) }
                }
                renameTarget = nil
                macCommands.renameTarget = nil
            }
            Button("Cancel", role: .cancel) {
                renameTarget = nil
                macCommands.renameTarget = nil
            }
        } message: {
            Text("Enter a new title for this session.")
        }
    }

    /// Sidebar column: rail header (title + theme + live status), search field,
    /// the session list, and the shared connect bar.
    private var macRail: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text("T4 Code")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(t.txt)
                Spacer()
                Button { theme.toggle() } label: {
                    Image(systemName: theme.effective == .dark ? "sun.max" : "moon")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(t.txtMuted)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Toggle dark mode")
                if store.connected {
                    HStack(spacing: 5) {
                        LiveDot(t: t)
                        Text("Live").font(.system(size: 11, weight: .semibold)).foregroundStyle(t.diffAdd)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            TextField("Search sessions", text: $store.query)
                .textFieldStyle(.roundedBorder)
                .focused($railSearchFocused)
                .padding(.horizontal, 12)
                .padding(.bottom, 8)

            T4SessionsView(store: store) { session in store.select(session) }

            connectBar
        }
        .frame(minWidth: 240)
        .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 460)
        .navigationTitle("T4 Code")
    }

    /// Detail column: the workspace content (boot splash / onboarding / session
    /// detail / empty state) with the sidebar-toggle, model, and inbox toolbar.
    private var macDetail: some View {
        Group {
            if !store.hasLiveInventory && !T4SessionStore.demoMode && store.hasSavedConnection {
                bootSplash
            } else if !store.hasLiveInventory && !T4SessionStore.demoMode {
                onboarding
            } else if let session = store.selectedSession {
                T4SessionDetailView(session: session, store: store)
                    .environmentObject(theme)
            } else {
                macEmptyState
            }
        }
        .navigationTitle(store.selectedSession?.title ?? "T4 Code")
        .toolbar {
            // No custom sidebar toggle here: NavigationSplitView already
            // provides the anchored system one (a second button moved with
            // the column — the duplication the user flagged).
            ToolbarItem(placement: platformTrailingPlacement) {
                if let session = store.selectedSession {
                    T4ModelMenuButton(session: session, store: store, theme: t) {
                        T4ModelLabel(selector: session.model ?? "choose model", theme: t, size: 12)
                            .frame(minHeight: 28)
                    }
                    .accessibilityLabel("Model and session controls")
                }
            }
            ToolbarItem(placement: platformTrailingPlacement) {
                Button { showInbox = true } label: {
                    ZStack(alignment: .topTrailing) {
                        Image(systemName: "bell")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(t.txt)
                        if !store.attentionSessions.isEmpty {
                            Text("\(store.attentionSessions.count)")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundStyle(t.bg)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(t.cAdvisor, in: Capsule())
                                .offset(x: 4, y: 2)
                        }
                    }
                }
                .accessibilityLabel("Attention inbox")
            }
        }
        .tint(t.interactiveAccent)
    }

    private var macEmptyState: some View {
        VStack(spacing: 18) {
            Image(systemName: "sidebar.left")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(t.txtGhost)
            Text("No session selected")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(t.txtBody)
            Text("Pick a session from the sidebar, or press \u{2309}B to show it.")
                .font(.system(size: 13))
                .foregroundStyle(t.txtMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 260)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(t.bg)
    }
    #endif

    /// Bottom bar: where you're plugged in, one obvious action. Shared by the
    /// iOS drawer rail and the macOS sidebar.
    @ViewBuilder
    private var connectBar: some View {
        if store.connected {
            HStack(spacing: 10) {
                Circle().fill(t.diffAdd).frame(width: 8, height: 8)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Connected").font(.system(size: 13, weight: .semibold)).foregroundStyle(t.txt)
                    if let endpoint = store.pairedEndpoint {
                        Text(endpoint.replacingOccurrences(of: "ws://", with: "").replacingOccurrences(of: "/v1/ws", with: ""))
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(t.txtMuted)
                            .lineLimit(1)
                    }
                }
                Spacer()
                Button { Task { await store.disconnect() } } label: {
                    Text("Disconnect").font(.system(size: 13, weight: .semibold))
                }
                .buttonStyle(.bordered)
                .tint(t.diffDel)
                .accessibilityLabel("Disconnect from host")
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 28)
            .overlay(alignment: .top) { Rectangle().fill(t.lineFaint).frame(height: 1) }
        } else {
            // No Connect button here — onboarding and the palette own that.
            // The rail bar only manages an EXISTING connection.
            HStack(spacing: 10) {
                Circle().fill(t.txtGhost).frame(width: 8, height: 8)
                Text("Not connected")
                    .font(.system(size: 13))
                    .foregroundStyle(t.txtMuted)
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 28)
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

    // MARK: - Workspace (center column)

    private var workspace: some View {
        NavigationStack {
            Group {
                if !store.hasLiveInventory && !T4SessionStore.demoMode && store.hasSavedConnection {
                    bootSplash
                } else if !store.hasLiveInventory && !T4SessionStore.demoMode {
                    onboarding
                } else if let session = store.selectedSession {
                    T4SessionDetailView(session: session, store: store)
                        .environmentObject(theme)
                } else {
                    emptyState
                }
            }
            .navigationTitle(store.selectedSession?.title ?? "T4 Code")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: platformLeadingPlacement) {
                    Button { toggleRail() } label: {
                        Image(systemName: "sidebar.left")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(t.txt)
                            .frame(width: 38, height: 38)
                    }
                    .press()
                    .accessibilityLabel("Show sessions")
                }
                ToolbarItem(placement: platformTrailingPlacement) {
                    if let session = store.selectedSession {
                        T4ModelMenuButton(session: session, store: store, theme: t) {
                            T4ModelLabel(selector: session.model ?? "choose model", theme: t, size: 12)
                                .frame(minHeight: 38)
                        }
                        .accessibilityLabel("Model and session controls")
                    }
                }
                #if os(iOS)
                ToolbarItem(placement: platformTrailingPlacement) {
                    Button { showPalette = true } label: {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(t.txt)
                            .frame(width: 38, height: 38)
                    }
                    .press()
                    .accessibilityLabel("Command palette")
                }
                #endif
                ToolbarItem(placement: platformTrailingPlacement) {
                    Button { showInbox = true } label: {
                        ZStack(alignment: .topTrailing) {
                            Image(systemName: "bell")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(t.txt)
                                .frame(width: 38, height: 38)
                            if !store.attentionSessions.isEmpty {
                                Text("\(store.attentionSessions.count)")
                                    .font(.system(size: 10, weight: .bold))
                                    .foregroundStyle(t.bg)
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 1)
                                    .background(t.cAdvisor, in: Capsule())
                                    .offset(x: 4, y: 2)
                            }
                        }
                    }
                    .press()
                    .accessibilityLabel("Attention inbox")
                }
            }
        }
        .tint(t.interactiveAccent)
    }

    /// Fresh device, nothing configured: honest onboarding, never fake data.
    private var onboarding: some View {
        VStack(spacing: 18) {
            Text("T4 Code")
                .font(.term(44))
                .foregroundStyle(t.accent)
            Text("Your agents, from your pocket.")
                .font(.system(size: 15))
                .foregroundStyle(t.txtMuted)
            Button { showConnect = true } label: {
                Label("Pair a host", systemImage: "link.badge.plus")
                    .font(.system(size: 16, weight: .semibold))
                    .frame(maxWidth: 260)
            }
            .buttonStyle(.borderedProminent)
            .tint(t.interactiveAccent)
            .controlSize(.large)
            .padding(.top, 8)
            Text("Run `t4-host pair` on your Mac and enter the 6-digit code.")
                .font(.system(size: 12))
                .foregroundStyle(t.txtLabel)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(t.bg)
    }

    /// Boot state for saved-connection devices: connecting, never fake chat.
    private var bootSplash: some View {
        VStack(spacing: 16) {
            ProgressView().scaleEffect(1.2).tint(t.interactiveAccent)
            Text("Connecting to your T4 host\u{2026}")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(t.txtBody)
            if let error = store.lastError {
                Text(error).font(.system(size: 12)).foregroundStyle(t.diffDel)
                    .multilineTextAlignment(.center).padding(.horizontal, 32)
                Button { showConnect = true } label: {
                    Text("Pair a different host").font(.system(size: 13, weight: .semibold))
                }
                .buttonStyle(.bordered)
                .tint(t.interactiveAccent)
                .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(t.bg)
    }

    private var emptyState: some View {
        VStack(spacing: 18) {
            Image(systemName: "sidebar.left")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(t.txtGhost)
            Text("No session selected")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(t.txtBody)
            Text("Swipe right from the left edge — or tap the sidebar button — to pick a session.")
                .font(.system(size: 13))
                .foregroundStyle(t.txtMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 260)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(t.bg)
    }

    // MARK: - Rail drawer (session list)

    private func rail(width: CGFloat) -> some View {
        VStack(spacing: 0) {
            NavigationStack {
                T4SessionsView(store: store) { session in
                    store.select(session)
                    closeRail()
                }
                .navigationTitle("T4 Code")
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                .searchable(text: $store.query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search sessions")
                #else
                .searchable(text: $store.query, placement: .toolbar, prompt: "Search sessions")
                #endif
                .toolbar {
                    ToolbarItem(placement: platformLeadingPlacement) {
                        Button { theme.toggle() } label: {
                            Image(systemName: theme.effective == .dark ? "sun.max" : "moon")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(t.txtMuted)
                        }
                        .accessibilityLabel("Toggle dark mode")
                    }
                    if store.connected {
                        ToolbarItem(placement: platformTrailingPlacement) {
                            HStack(spacing: 5) {
                                LiveDot(t: t)
                                Text("Live").font(.system(size: 11, weight: .semibold)).foregroundStyle(t.diffAdd)
                            }
                        }
                    }
                }
            }

            // Bottom bar: where you're plugged in, one obvious action.
            connectBar
        }
        .frame(width: width)
        .frame(maxHeight: .infinity)
        .background(t.bg)
        .overlay(alignment: .trailing) {
            Rectangle().fill(t.line).frame(width: 1)
        }
        .shadow(color: .black.opacity(0.18 * railProgress), radius: 12, x: 4, y: 0)
        .ignoresSafeArea(.container, edges: .bottom)
    }

    // MARK: - Gestures

    /// Velocity-aware settle: fling keeps its momentum (progress/sec), a slow
    /// release past the 40% mark coasts open, anything else falls back closed.
    private func settle(velocity: CGFloat, width: CGFloat) {
        let target: CGFloat = railProgress + velocity / width * 0.12 > 0.4 ? 1 : 0
        withAnimation(.interpolatingSpring(mass: 1, stiffness: 170, damping: 22, initialVelocity: velocity / width)) {
            railProgress = target
        }
    }

    private func openDrag(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                railProgress = min(1, max(0, value.translation.width / width))
            }
            .onEnded { value in settle(velocity: value.velocity.width, width: width) }
    }

    private func closeDrag(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                guard value.translation.width < 0,
                      abs(value.translation.width) > abs(value.translation.height) else { return }
                railProgress = min(1, max(0, 1 + value.translation.width / width))
            }
            .onEnded { value in settle(velocity: value.velocity.width, width: width) }
    }

    private func toggleRail() {
        withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) {
            railProgress = railOpen ? 0 : 1
        }
    }

    private func closeRail() {
        withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) {
            railProgress = 0
        }
    }
}
