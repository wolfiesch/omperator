import Foundation

public enum T4WindowsThemeMode: String, Equatable, Sendable {
    case system
    case dark
    case light
}

enum T4WindowsCaptureState: String, Equatable, Sendable {
    case onboarding
    case workspace
    case settings
    case browser
    case compact
    case railHidden = "rail-hidden"
    case streaming
}

/// Parsed once at process launch so window creation and the testable view layer
/// consume the same command-line contract.
public struct T4WindowsLaunchConfiguration: Equatable, Sendable {
    public static let defaultWindowWidth = 1180
    public static let defaultWindowHeight = 760

    public let demoMode: Bool
    public let browserFixtureEnabled: Bool
    public let typographyFixtureEnabled: Bool
    public let themeMode: T4WindowsThemeMode
    public let windowWidth: Int
    public let windowHeight: Int
    let captureState: T4WindowsCaptureState?

    public init(arguments: [String] = ProcessInfo.processInfo.arguments) {
        let demoMode = arguments.contains("-T4Demo")
        self.demoMode = demoMode
        captureState = arguments
            .first(where: { $0.hasPrefix("-T4CaptureState=") })
            .flatMap { T4WindowsCaptureState(rawValue: String($0.dropFirst("-T4CaptureState=".count))) }
        browserFixtureEnabled = demoMode
            && (arguments.contains("-T4BrowserFixture") || captureState == .browser)
        typographyFixtureEnabled = arguments.contains("-T4TypographyFixture")
        themeMode = arguments
            .first(where: { $0.hasPrefix("-T4Theme=") })
            .flatMap { T4WindowsThemeMode(rawValue: String($0.dropFirst("-T4Theme=".count))) }
            ?? .system

        let parsedSize = arguments
            .first(where: { $0.hasPrefix("-T4WindowSize=") })
            .flatMap(Self.parseWindowSize)
        windowWidth = parsedSize?.width ?? (captureState == .compact ? 440 : Self.defaultWindowWidth)
        windowHeight = parsedSize?.height ?? (captureState == .compact ? 560 : Self.defaultWindowHeight)
    }

    var initialShellState: T4LinuxV2ShellState {
        var state = T4LinuxV2ShellState()
        switch captureState {
        case .settings:
            state.settingsPresented = true
        case .browser:
            state.browserVisible = true
        case .compact:
            state.setCompact(true)
        case .railHidden:
            state.railVisible = false
        case .onboarding, .workspace, .streaming, nil:
            break
        }
        return state
    }

    private static func parseWindowSize(_ argument: String) -> (width: Int, height: Int)? {
        let value = argument.dropFirst("-T4WindowSize=".count)
        let dimensions = value.split(separator: "x", omittingEmptySubsequences: false)
        guard dimensions.count == 2,
              let width = Int(dimensions[0]), width > 0,
              let height = Int(dimensions[1]), height > 0
        else {
            return nil
        }
        return (width, height)
    }
}
