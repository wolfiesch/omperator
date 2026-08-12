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
            let viewportWidth = geometry.size.width
            let viewportHeight = geometry.size.height
            T4WorkspaceView(
                theme: theme,
                store: store,
                configuration: configuration
            )
                .environment(\.t4WindowWidth, viewportWidth)
                .environment(\.t4WindowHeight, viewportHeight)
                // WinUIBackend reports this geometry in XAML DIPs after its
                // native scale-factor conversion. Pin that realized extent
                // directly so the workspace fills the client area.
                .frame(
                    width: viewportWidth,
                    height: viewportHeight
                )
        }
        .colorScheme(theme.effective == .dark ? .dark : .light)
        .foregroundColor(theme.t.txt)
        .frame(
            minWidth: 440,
            maxWidth: .infinity,
            minHeight: 560,
            maxHeight: .infinity
        )
        .onAppear {
            syncSystemAppearance()
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
