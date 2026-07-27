//  RootView.swift
//  T4 Code root: the desktop-parity workspace (session detail + slide-over
//  session rail). T4-only — no collab guest path. The rail drawer, gestures,
//  and connect sheet live in T4WorkspaceView.

import SwiftUI

struct RootView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var store: T4SessionStore
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        T4WorkspaceView()
            .onChange(of: colorScheme, initial: true) { _, new in theme.systemDark = (new == .dark) }
    }
}
