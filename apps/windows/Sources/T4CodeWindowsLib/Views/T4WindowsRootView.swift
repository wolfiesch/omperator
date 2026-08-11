import SwiftCrossUI

/// Stable entry-point wrapper retained for the WinUI executable and tests.
/// The rendered hierarchy is the Linux-source-aligned RootView, not the former
/// Windows feasibility demo.
public struct T4WindowsRootView: View {
    private let configuration: T4WindowsLaunchConfiguration

    public init(
        configuration: T4WindowsLaunchConfiguration = T4WindowsLaunchConfiguration()
    ) {
        precondition(
            T4WindowsFonts.areBundledFontsRegistered,
            "Bundled fonts must be registered before the WinUI view graph is created"
        )
        self.configuration = configuration
    }

    @ViewBuilder
    public var body: some View {
        if configuration.typographyFixtureEnabled {
            // WinUIBackend reports the realized Win32 pixel extent while XAML
            // lays out in DIPs. Keep the fixture on the same corrected viewport
            // contract as RootView so its normalized Linux/Windows coordinates
            // compare directly at non-96-DPI desktop scales.
            GeometryReader { geometry in
                let viewportScale = t4WindowsViewportScale()
                T4TypographyFixtureView()
                    .frame(
                        width: geometry.size.width * viewportScale,
                        height: geometry.size.height * viewportScale
                    )
            }
        } else {
            RootView(configuration: configuration)
        }
    }
}
