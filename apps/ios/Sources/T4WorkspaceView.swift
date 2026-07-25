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
    @State private var showControls = false
    /// Prefilled pair from a t4-code://pair/... deep link; handed to the
    /// connect sheet when it opens.
    @State private var pendingPair: PendingPair?
    private var t: Theme { theme.t }

    private var railOpen: Bool { railProgress > 0.5 }
    private func railWidth(for screen: CGFloat) -> CGFloat { min(320, screen * 0.84) }

    var body: some View {
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
        .sheet(isPresented: $showConnect) {
            T4ConnectView(store: store, pendingPair: pendingPair)
                .environmentObject(theme)
        }
        .sheet(isPresented: $showControls) {
            if let session = store.selectedSession {
                T4ControlsSheet(session: session, store: store).environmentObject(theme)
            }
        }
        .onOpenURL { url in handleDeepLink(url) }
        .onAppear {
            if store.selectedSession == nil { store.select(store.sessions.first) }
            // UI-test seam: launch with -T4RailOpen to boot with the rail open.
            if ProcessInfo.processInfo.arguments.contains("-T4RailOpen") { railProgress = 1 }
        }
        .task { await store.restore() }
        .task {
            // UI-test seam: launch with -T4PairCode <code> [-T4PairHost <host[:port]>]
            // to run the pair handshake on first boot. Default host is the
            // tailnet IP (the sim has no MagicDNS resolver).
            let args = ProcessInfo.processInfo.arguments
            if let index = args.firstIndex(of: "-T4PairCode"), args.indices.contains(index + 1) {
                var host = "100.98.34.4"
                if let hIndex = args.firstIndex(of: "-T4PairHost"), args.indices.contains(hIndex + 1) {
                    host = args[hIndex + 1]
                }
                if let endpoint = URL(string: "ws://\(host):8787/v1/ws") {
                    await store.pairAndConnect(endpoint: endpoint, code: args[index + 1], deviceName: "sim-ui-test")
                }
            }
        }
        .task {
            // UI-test seam: launch with -T4Send <message> to send one prompt
            // from the app's own send path once connected (proves the Swift
            // lease flow end-to-end without touch injection).
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
            guard store.connected, let session = store.selectedSession ?? store.sessions.first else { return }
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
                if let session = store.selectedSession {
                    T4SessionDetailView(session: session, store: store)
                        .environmentObject(theme)
                } else {
                    emptyState
                }
            }
            .navigationTitle(store.selectedSession?.title ?? "T4 Code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { toggleRail() } label: {
                        Image(systemName: "sidebar.left")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(t.txt)
                            .frame(width: 38, height: 38)
                    }
                    .press()
                    .accessibilityLabel("Show sessions")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 4) {
                        if let session = store.selectedSession {
                            Button { showControls = true } label: {
                                T4ModelLabel(selector: session.model ?? "choose model", theme: t, size: 12)
                                    .frame(minHeight: 38)
                            }
                            .press()
                            .accessibilityLabel("Model and session controls")
                        }
                        Button { theme.toggle() } label: {
                            Image(systemName: theme.effective == .dark ? "sun.max" : "moon")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(t.txt)
                                .frame(width: 38, height: 38)
                        }
                        .press()
                    }
                }
            }
        }
        .tint(t.accent)
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
                .navigationBarTitleDisplayMode(.inline)
                .searchable(text: $store.query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search sessions")
                .toolbar {
                    if store.connected {
                        ToolbarItem(placement: .topBarTrailing) {
                            HStack(spacing: 5) {
                                LiveDot(t: t)
                                Text("Live").font(.system(size: 11, weight: .semibold)).foregroundStyle(t.diffAdd)
                            }
                        }
                    }
                }
            }

            // Bottom bar: where you're plugged in, one obvious action.
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
                HStack(spacing: 10) {
                    Button { showConnect = true } label: {
                        Label("Connect to T4 Code", systemImage: "plus.circle.fill")
                            .font(.system(size: 15, weight: .semibold))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(t.accent)
                    .controlSize(.large)
                    .accessibilityLabel("Connect to a T4 Code host")
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 28)
                .overlay(alignment: .top) { Rectangle().fill(t.lineFaint).frame(height: 1) }
            }
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
