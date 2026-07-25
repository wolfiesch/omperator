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
            T4ConnectView(store: store).environmentObject(theme)
        }
        .onAppear {
            if store.selectedSession == nil { store.select(store.sessions.first) }
            // UI-test seam: launch with -T4RailOpen to boot with the rail open.
            if ProcessInfo.processInfo.arguments.contains("-T4RailOpen") { railProgress = 1 }
        }
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
                        Button { theme.toggle() } label: {
                            Image(systemName: theme.effective == .dark ? "sun.max" : "moon")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(t.txt)
                                .frame(width: 38, height: 38)
                        }
                        .press()
                        Button { showConnect = true } label: {
                            Image(systemName: "plus")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(t.accent)
                                .frame(width: 38, height: 38)
                        }
                        .press()
                        .accessibilityLabel("Connect a T4 host")
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

            // Bottom bar: connect / connection state.
            HStack(spacing: 10) {
                Button { showConnect = true } label: {
                    Label(store.connected ? "Host" : "Connect", systemImage: store.connected ? "checkmark.circle.fill" : "plus.circle.fill")
                        .font(.system(size: 15, weight: .semibold))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(t.accent)
                .controlSize(.large)
                .accessibilityLabel("Connect a T4 host")
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 28)
            .overlay(alignment: .top) { Rectangle().fill(t.lineFaint).frame(height: 1) }
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
