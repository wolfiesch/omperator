//  T4CodeApp.swift
//  Native T4 Code iOS client. One ThemeStore + one T4SessionStore (the
//  authoritative host-wire inventory). No collab guest client, no AppModel.
//  On macOS a MacCommandsModel drives the sidebar + menu shortcuts.

import SwiftUI

@main
struct T4CodeApp: App {
    @StateObject private var theme = ThemeStore()
    @StateObject private var store = T4SessionStore()
    #if os(macOS)
    @StateObject private var macCommands = MacCommandsModel()
    #endif

    var body: some Scene {
        WindowGroup {
            RootView()
                #if os(macOS)
                .frame(minWidth: 900, minHeight: 560)
                #endif
                .environmentObject(theme)
                .environmentObject(store)
                #if os(macOS)
                .environmentObject(macCommands)
                #endif
                .preferredColorScheme(theme.preferredScheme)
        }
        #if os(macOS)
        .defaultSize(width: 1100, height: 720)
        .windowResizability(.contentMinSize)
        .commands { MacCommands() }
        #endif
    }
}
