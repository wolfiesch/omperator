//  EnclaveApp.swift
//  App entry. One ThemeStore for the whole app. RootView hosts the native TabView.
//
//  Wiring the engine (when EnclaveCore.xcframework is linked): create an
//  EngineBridge, connect to the mock host, and feed EditorView from bridge.turns
//  instead of the SessionVM mock. See scaffold/RUN.md.
//
//    @StateObject var engine = EngineBridge()
//    …onAppear { engine.connect(url: "ws://localhost:8787", token: "dev", joinCode: "8F2K-A3F2") }
//
//  The SessionVM mock and the engine expose the same `turns` shape, so the swap is
//  a data-source change, not a view change.

import SwiftUI

@main
struct EnclaveApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var theme = ThemeStore()
    @StateObject private var app = AppModel()
    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(theme).environmentObject(app)
                .preferredColorScheme(theme.preferredScheme)   // applied above RootView so its colorScheme read stays true to the OS
        }
    }
}
