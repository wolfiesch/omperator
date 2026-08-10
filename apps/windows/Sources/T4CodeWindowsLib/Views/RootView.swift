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
            T4WorkspaceView(theme: theme, store: store)
                .environment(\.t4WindowWidth, geometry.size.width)
                // WINDOWS-GAP: WinUIBackend does not reliably propagate an
                // unconstrained root proposal through nested infinity frames.
                // Pin only the realized window extent; child geometry remains
                // identical to the Linux two-column workspace.
                .frame(
                    width: geometry.size.width,
                    height: geometry.size.height
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
