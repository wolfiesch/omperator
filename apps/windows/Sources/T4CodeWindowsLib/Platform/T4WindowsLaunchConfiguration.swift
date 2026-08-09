import Foundation

public enum T4WindowsThemeMode: String, Equatable, Sendable {
    case system
    case dark
    case light
}

/// Parsed once at process launch so window creation and the testable view layer
/// consume the same command-line contract.
public struct T4WindowsLaunchConfiguration: Equatable, Sendable {
    public static let defaultWindowWidth = 1280
    public static let defaultWindowHeight = 800

    public let demoMode: Bool
    public let themeMode: T4WindowsThemeMode
    public let windowWidth: Int
    public let windowHeight: Int

    public init(arguments: [String] = ProcessInfo.processInfo.arguments) {
        demoMode = arguments.contains("-T4Demo")
        themeMode = arguments
            .first(where: { $0.hasPrefix("-T4Theme=") })
            .flatMap { T4WindowsThemeMode(rawValue: String($0.dropFirst("-T4Theme=".count))) }
            ?? .system

        let parsedSize = arguments
            .first(where: { $0.hasPrefix("-T4WindowSize=") })
            .flatMap(Self.parseWindowSize)
        windowWidth = parsedSize?.width ?? Self.defaultWindowWidth
        windowHeight = parsedSize?.height ?? Self.defaultWindowHeight
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
