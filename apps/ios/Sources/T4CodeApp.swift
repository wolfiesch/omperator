//  T4CodeApp.swift
//  Native T4 Code iOS client. One ThemeStore + one T4SessionStore (the
//  authoritative host-wire inventory). No collab guest client, no AppModel.

import SwiftUI

@main
struct T4CodeApp: App {
    @StateObject private var theme = ThemeStore()
    @StateObject private var store = T4SessionStore()
    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(theme)
                .environmentObject(store)
                .preferredColorScheme(theme.preferredScheme)
        }
        #if os(macOS)
        .windowDefaultSize(width: 1100, height: 720)
        .windowResizability(.contentSize)
        #endif
    }
}
