import Foundation
import HostWire

/// Windows-specific identity values sent during the existing t4-host handshake.
/// This client never embeds or owns an OMP runtime.
public enum T4WindowsPlatform {
    public static let clientName = "t4-windows"
    public static let clientPlatform = "windows"
    public static let deviceIdPrefix = "windows"

    public static func deviceName(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fallback: String = ProcessInfo.processInfo.hostName
    ) -> String {
        if let computerName = environment["COMPUTERNAME"]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !computerName.isEmpty
        {
            return computerName
        }
        return fallback
    }

    public static func clientIdentity(
        version: String = "0.1",
        build: String = "dev"
    ) -> ClientIdentity {
        ClientIdentity(
            name: clientName,
            version: version,
            build: build,
            platform: clientPlatform
        )
    }
}
