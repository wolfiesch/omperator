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

struct EphemeralConnectionCredentials: Equatable, CustomStringConvertible, CustomDebugStringConvertible {
    let endpoint: String
    let deviceId: String
    let deviceToken: String
    let certificatePin: String?

    init(
        endpoint: String,
        deviceId: String,
        deviceToken: String,
        certificatePin: String? = nil
    ) {
        self.endpoint = endpoint
        self.deviceId = deviceId
        self.deviceToken = deviceToken
        self.certificatePin = certificatePin
    }

    init?(arguments: [String] = ProcessInfo.processInfo.arguments) {
        func value(_ name: String) -> String? {
            let prefix = "-\(name)="
            guard let argument = arguments.first(where: { $0.hasPrefix(prefix) }) else {
                return nil
            }
            let value = String(argument.dropFirst(prefix.count))
            return value.isEmpty ? nil : value
        }

        guard let endpoint = value("T4Endpoint"),
              let deviceId = value("T4DeviceId"),
              let deviceToken = value("T4DeviceToken")
        else {
            return nil
        }
        self.init(
            endpoint: endpoint,
            deviceId: deviceId,
            deviceToken: deviceToken,
            certificatePin: value("T4CertificatePin")
        )
    }

    var description: String {
        "EphemeralConnectionCredentials(endpoint: \(endpoint), deviceId: <redacted>, deviceToken: <redacted>, certificatePin: <redacted>)"
    }

    var debugDescription: String { description }
}

/// Compatibility surface for the source-linked store's Apple/Linux key names.
/// Windows saved-host records use `WindowsSavedHostCredentialStoring`; this
/// process-local map is used only by launch seams that explicitly disable it.
enum Keychain {
    private static var values: [String: String] = [:]

    static func usesPersistentStore(
        arguments: [String] = ProcessInfo.processInfo.arguments
    ) -> Bool {
        WindowsCredentialAccessPolicy.allowsPersistentCredentials(arguments: arguments)
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
