//  RootView.swift (Linux)
//  App shell root: owns the app-lifetime store + theme and hosts the ported
//  T4WorkspaceView (desktop-parity two-column shell). Matches the macOS
//  T4CodeApp → RootView → workspace shape; the workspace receives the
//  observables as plain properties (SwiftCrossUI re-renders the subtree on
//  @State-observed changes).

import Foundation
import SwiftCrossUI

public struct RootView: View {
    public init() {}
    @State var store = T4SessionStore()
    @State var theme = ThemeStore()

    public var body: some View {
        T4WorkspaceView(theme: theme, store: store)
            // Theme-aware defaults: SwiftCrossUI falls back to the color
            // scheme's default foreground (black in .light) for any view
            // without an explicit color — "Inbox" and friends rendered black
            // in the dark theme. Pin both the scheme and the Rosé Pine ink
            // at the root so uncolored text always matches the palette.
            .colorScheme(theme.effective == .dark ? .dark : .light)
            .foregroundColor(theme.t.txt)
            .task {
                T4Perf.mark("rootview-task-start")
                // Appearance detection spawns gsettings synchronously — do it
                // off the main actor so the first frame isn't stalled.
                T4Perf.mark("before-appearance")
                let dark = await Task.detached(priority: .utility) {
                    Self.detectSystemDark()
                }.value
                theme.systemDark = dark
                T4Perf.mark("after-appearance")
                T4GtkTheme.apply(theme.effective)
                if !store.connectionModel.connected {
                    await store.restore()
                }
                T4Perf.mark("after-restore")
            }
            // Native Gtk widgets (entries, menus, buttons) follow the theme.
            .onChange(of: theme.effective) {
                T4GtkTheme.apply(theme.effective)
            }
    }

    // MARK: - System appearance

    nonisolated private static func detectSystemDark() -> Bool {
        // GTK prefers-dark: read the theme preference via gsettings when
        // available; default to light otherwise.
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/gsettings")
        p.arguments = ["get", "org.gnome.desktop.interface", "color-scheme"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = Pipe()
        do {
            try p.run()
            p.waitUntilExit()
            let text = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            return text.contains("dark")
        } catch {
            return false
        }
    }
}
