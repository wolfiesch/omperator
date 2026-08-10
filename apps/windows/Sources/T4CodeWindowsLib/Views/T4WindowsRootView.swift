import SwiftCrossUI

/// Stable entry-point wrapper retained for the WinUI executable and tests.
/// The rendered hierarchy is the Linux-source-aligned RootView, not the former
/// Windows feasibility demo.
public struct T4WindowsRootView: View {
    private let configuration: T4WindowsLaunchConfiguration

    public init(
        configuration: T4WindowsLaunchConfiguration = T4WindowsLaunchConfiguration()
    ) {
        self.configuration = configuration
    }

    public var body: some View {
        RootView(configuration: configuration)
    }
}
