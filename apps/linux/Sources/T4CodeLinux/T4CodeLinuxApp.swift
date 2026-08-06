import Foundation
import GtkBackend
import SwiftCrossUI
import T4CodeLinuxLib

@main
struct T4CodeLinuxApp: App {
    init() { T4Perf.mark("app-init") }

    /// Capture seam: -T4WindowSize=1920x1080 launches at exact capture
    /// geometry — resizing a realized WebKitGTK view on Xvfb races its
    /// compositor and can leave the browser pane unpainted.
    private static var launchSize: (width: Int, height: Int) {
        guard let raw = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("-T4WindowSize=") }) else {
            return (1280, 800)
        }
        let parts = raw.dropFirst("-T4WindowSize=".count).split(separator: "x")
        guard parts.count == 2, let w = Int(parts[0]), let h = Int(parts[1]) else {
            return (1280, 800)
        }
        return (w, h)
    }

    var body: some Scene {
        WindowGroup("T4 Code") {
            RootView()
        }
        .defaultSize(width: Self.launchSize.width, height: Self.launchSize.height)
    }
}
