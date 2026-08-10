import Foundation
import HostWire

// Keep the shared Linux/iOS store vocabulary intact while routing identity and
// transport behavior through the established Windows seams.
let platformClientName = T4WindowsPlatform.clientName
let platformClientPlatform = T4WindowsPlatform.clientPlatform
let platformDeviceIdPrefix = T4WindowsPlatform.deviceIdPrefix

func platformDeviceName() -> String {
    T4WindowsPlatform.deviceName()
}

func makePlatformHostWireTransport(
    endpoint: URL
) -> any HostWireTransport {
    WindowsURLSessionHostWireTransport(endpoint: endpoint)
}

struct EphemeralConnectionCredentials: Equatable {
    let endpoint: String
    let deviceId: String
    let deviceToken: String

    init(endpoint: String, deviceId: String, deviceToken: String) {
        self.endpoint = endpoint
        self.deviceId = deviceId
        self.deviceToken = deviceToken
    }

    init?(arguments: [String] = ProcessInfo.processInfo.arguments) {
        var endpoint: String?
        var deviceId: String?
        var deviceToken: String?
        for argument in arguments {
            if argument.hasPrefix("-T4Endpoint=") {
                endpoint = String(argument.dropFirst("-T4Endpoint=".count))
            } else if argument.hasPrefix("-T4DeviceId=") {
                deviceId = String(argument.dropFirst("-T4DeviceId=".count))
            } else if argument.hasPrefix("-T4DeviceToken=") {
                deviceToken = String(argument.dropFirst("-T4DeviceToken=".count))
            }
        }
        guard let endpoint, let deviceId, let deviceToken else { return nil }
        self.init(
            endpoint: endpoint,
            deviceId: deviceId,
            deviceToken: deviceToken
        )
    }
}

/// WINDOWS-GAP: Windows Credential Manager integration is deliberately outside
/// this UI-port milestone. Preserve the shared API with process-local storage;
/// no credential is written to disk or to an unrelated platform facility.
enum Keychain {
    private static var values: [String: String] = [:]

    static func usesPersistentStore(
        arguments: [String] = ProcessInfo.processInfo.arguments
    ) -> Bool {
        !arguments.contains("-T4NoRestore")
    }

    @discardableResult
    static func set(_ value: String?, forKey key: String) -> Bool {
        if let value, !value.isEmpty {
            values[key] = value
        } else {
            values.removeValue(forKey: key)
        }
        return true
    }

    static func get(_ key: String) -> String? {
        values[key]
    }

    @discardableResult
    static func remove(forKey key: String) -> Bool {
        values.removeValue(forKey: key)
        return true
    }
}
