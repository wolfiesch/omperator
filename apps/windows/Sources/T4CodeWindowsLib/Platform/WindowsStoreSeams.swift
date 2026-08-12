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
/// Normal launches route every account token, relay link, and direct-host
/// credential through Windows Credential Manager. Demo, fixture, and
/// ephemeral launches receive a process-local store and never touch the vault.
enum Keychain {
    private static let store: any WindowsSecretStoring = WindowsSecretStoreFactory.make()

    static func usesPersistentStore(
        arguments: [String] = ProcessInfo.processInfo.arguments
    ) -> Bool {
        WindowsCredentialAccessPolicy.allowsPersistentCredentials(arguments: arguments)
    }

    @discardableResult
    static func set(_ value: String?, forKey key: String) -> Bool {
        do {
            if let value, !value.isEmpty {
                try store.set(value, forKey: key)
            } else {
                try store.remove(forKey: key)
            }
            return true
        } catch {
            return false
        }
    }

    static func setOrThrow(_ value: String, forKey key: String) throws {
        try store.set(value, forKey: key)
    }

    static func get(_ key: String) -> String? {
        try? store.value(forKey: key)
    }

    static func getOrThrow(_ key: String) throws -> String? {
        try store.value(forKey: key)
    }

    @discardableResult
    static func remove(forKey key: String) -> Bool {
        do {
            try store.remove(forKey: key)
            return true
        } catch {
            return false
        }
    }
}
