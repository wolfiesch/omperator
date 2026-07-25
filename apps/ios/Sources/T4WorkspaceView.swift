//  T4WorkspaceView.swift
//  Desktop-parity shell: the session workspace fills the screen and the
//  session rail is a slide-over drawer — exactly like the T4 desktop app's
//  narrow-width rail overlay. Swipe right from the left edge (or tap the
//  sidebar button) to reveal sessions; tap the backdrop or swipe left to
//  dismiss. The drawer tracks the finger interactively and settles with a
//  spring, mirroring the desktop Sheet's drag-to-dismiss.

import SwiftUI
import HostWire

struct T4WorkspaceView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var store: T4SessionStore
    @State private var railOpen = false
    @State private var railDrag: CGFloat = 0   // live finger translation while dragging
    @State private var showConnect = false
    private var t: Theme { theme.t }

    private func railWidth(for screen: CGFloat) -> CGFloat { min(320, screen * 0.84) }

    var body: some View {
        GeometryReader { geo in
            let width = railWidth(for: geo.size.width)
            // Drawer rest position: 0 when open, -width when closed, plus the
            // in-progress drag translation (clamped so it never overshoots).
            let base: CGFloat = railOpen ? 0 : -width
            let offset = min(width, max(-width, base + railDrag))

            ZStack(alignment: .leading) {
                workspace

                // Edge hot zone: only hit-testable while the drawer is closed,
                // so the workspace keeps its own horizontal gestures.
                if !railOpen {
                    Color.clear
                        .frame(width: 28)
                        .frame(maxHeight: .infinity)
                        .contentShape(Rectangle())
                        .gesture(openDrag(width: width))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                if railOpen || offset > -width {
                    // Backdrop dims the workspace as the drawer slides in.
                    t.bg.opacity(backdropOpacity(offset: offset, width: width))
                        .ignoresSafeArea()
                        .onTapGesture { closeRail() }
                        .gesture(closeDrag(width: width))
                        .offset(x: max(0, offset + width))

                    rail(width: width)
                        .offset(x: offset)
                        .gesture(closeDrag(width: width))
                }
            }
            .animation(.spring(response: 0.32, dampingFraction: 0.86), value: railOpen)
        }
        .background(t.bg.ignoresSafeArea())
        .sheet(isPresented: $showConnect) {
            T4ConnectView(store: store).environmentObject(theme)
        }
        .onAppear {
            if store.selectedSession == nil { store.select(store.sessions.first) }
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
            // Rail header: product mark + actions, like the desktop rail top.
            HStack(spacing: 10) {
                Text("T4 Code")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(t.txt)
                Spacer()
                if store.connected {
                    LiveDot(t: t)
                    Text("Live").font(.system(size: 11, weight: .semibold)).foregroundStyle(t.diffAdd)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 10)

            // Search — same inventory filter as the desktop rail's filter box.
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 13))
                    .foregroundStyle(t.txtLabel)
                TextField("Search sessions", text: $store.query)
                    .font(.system(size: 14))
                    .foregroundStyle(t.txt)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                if !store.query.isEmpty {
                    Button { store.query = "" } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 13))
                            .foregroundStyle(t.txtLabel)
                    }
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(t.glassFill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .padding(.horizontal, 12)
            .padding(.bottom, 8)

            T4SessionsView(store: store) { session in
                store.select(session)
                closeRail()
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
            .padding(.vertical, 12)
        }
        .frame(width: width)
        .frame(maxHeight: .infinity)
        .background(t.bg2)
        .overlay(alignment: .trailing) {
            Rectangle().fill(t.line).frame(width: 1)
        }
        .shadow(color: .black.opacity(0.35), radius: 24, x: 8, y: 0)
        .ignoresSafeArea(.container, edges: .bottom)
    }

    // MARK: - Gestures

    private func openDrag(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                railDrag = min(width, max(0, value.translation.width))
            }
            .onEnded { value in
                let predicted = value.predictedEndTranslation.width
                let shouldOpen = railDrag + predicted * 0.4 > width * 0.4 || value.velocity.width > 400
                railDrag = 0
                railOpen = shouldOpen
            }
    }

    private func closeDrag(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                guard value.translation.width < 0,
                      abs(value.translation.width) > abs(value.translation.height) else { return }
                railDrag = max(-width, value.translation.width)
            }
            .onEnded { value in
                let closed = -railDrag + -value.predictedEndTranslation.width * 0.4 > width * 0.4
                    || value.velocity.width < -400
                railDrag = 0
                if closed { railOpen = false }
            }
    }

    private func backdropOpacity(offset: CGFloat, width: CGFloat) -> Double {
        0.45 * Double((offset + width) / width)
    }

    private func toggleRail() {
        railDrag = 0
        railOpen.toggle()
    }

    private func closeRail() {
        railDrag = 0
        railOpen = false
    }
}
