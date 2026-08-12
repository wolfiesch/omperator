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
            // WinUIBackend reports the realized extent in XAML DIPs. Keep the
            // fixture on the same viewport contract as RootView.
            GeometryReader { geometry in
                T4TypographyFixtureView()
                    .frame(
                        width: geometry.size.width,
                        height: geometry.size.height
                    )
            }
        } else {
            RootView(configuration: configuration)
        }
    }
}
