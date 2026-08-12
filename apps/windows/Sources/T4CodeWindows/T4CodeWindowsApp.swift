import SwiftCrossUI
import T4CodeWindowsLib
import WinUIBackend

@main
struct T4CodeWindowsApp: App {
    private let configuration = T4WindowsLaunchConfiguration()

    init() {
        T4WindowsFonts.registerBundledFonts()
        print("T4CodeWindows: starting native WinUI window")
    }

    var body: some Scene {
        WindowGroup("Omperator") {
            T4WindowsRootView(configuration: configuration)
        }
        .defaultSize(
            width: configuration.windowWidth,
            height: configuration.windowHeight
        )
    }
}
