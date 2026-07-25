//  RootView.swift
//  T4 Code root: the authoritative session rail, a Connect sheet for a t4-host,
//  and push navigation into a session detail. T4-only — no collab guest path.

import SwiftUI
import HostWire

struct RootView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var store: T4SessionStore
    @Environment(\.colorScheme) private var colorScheme
    @State private var showConnect = false
    private var t: Theme { theme.t }

    var body: some View {
        NavigationStack {
            T4SessionsView(store: store) { session in
                store.selectedSession = session
            }
            .background(t.bg.ignoresSafeArea())
            .navigationTitle("T4 Code")
            .searchable(text: $store.query, prompt: "Search sessions")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { theme.toggle() } label: {
                        Image(systemName: theme.effective == .dark ? "sun.max" : "moon")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(t.txt)
                            .frame(width: 38, height: 38)
                    }
                    .press()
                }
                DefaultToolbarItem(kind: .search, placement: .bottomBar)
                ToolbarSpacer(.flexible, placement: .bottomBar)
                ToolbarItem(placement: .bottomBar) {
                    Button { showConnect = true } label: {
                        Label("Connect", systemImage: "plus")
                            .font(.system(size: 17, weight: .semibold))
                    }
                    .buttonStyle(.glassProminent)
                    .tint(t.accent)
                    .accessibilityLabel("Connect a T4 host")
                }
            }
            .navigationDestination(isPresented: Binding(
                get: { store.selectedSession != nil },
                set: { if !$0 { store.selectedSession = nil } }
            )) {
                if let session = store.selectedSession {
                    T4SessionDetailView(session: session, store: store)
                        .environmentObject(theme)
                }
            }
        }
        .tint(t.accent)
        .onChange(of: colorScheme, initial: true) { _, new in theme.systemDark = (new == .dark) }
        .sheet(isPresented: $showConnect) {
            T4ConnectView(store: store).environmentObject(theme)
        }
    }
}
