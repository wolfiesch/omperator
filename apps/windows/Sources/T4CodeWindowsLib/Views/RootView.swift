import SwiftCrossUI

/// Windows port of the Linux app shell root. The app-lifetime store and theme
/// are the same source-aligned models used by the Linux SwiftCrossUI client.
struct RootView: View {
    let configuration: T4WindowsLaunchConfiguration

    @State private var store = T4SessionStore()
    @State private var theme = ThemeStore()
    @Environment(\.colorScheme) private var systemColorScheme

    var body: some View {
        GeometryReader { geometry in
            let viewportScale = t4WindowsViewportScale()
            let viewportWidth = geometry.size.width * viewportScale
            let viewportHeight = geometry.size.height * viewportScale
            T4WorkspaceView(
                theme: theme,
                store: store,
                browserFixtureEnabled: configuration.browserFixtureEnabled
            )
                .environment(\.t4WindowWidth, viewportWidth)
                .environment(\.t4WindowHeight, viewportHeight)
                // WINDOWS-GAP: WinUIBackend forwards post-resize Win32 pixels
                // while XAML lays out in DIPs. Pin the corrected realized
                // extent; the shared workspace remains unchanged.
                .frame(
                    width: viewportWidth,
                    height: viewportHeight
                )
        }
        .colorScheme(theme.effective == .dark ? .dark : .light)
        .foregroundColor(theme.t.txt)
        .frame(
            minWidth: 900,
            maxWidth: .infinity,
            minHeight: 600,
            maxHeight: .infinity
        )
        .task {
            syncSystemAppearance()
            if !store.connectionModel.connected {
                await store.restore()
            }
        }
        .onChange(of: systemColorScheme) {
            syncSystemAppearance()
        }
    }

    private func syncSystemAppearance() {
        switch configuration.themeMode {
        case .system:
            theme.systemDark = systemColorScheme == .dark
        case .dark:
            theme.systemDark = true
        case .light:
            theme.systemDark = false
        }
    }
}
