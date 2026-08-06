//  Keychain.swift (Linux)
//  Parity seam for apps/ios/Sources/Keychain.swift: libsecret-backed
//  credential store with the exact same API surface the shared store calls.
//  Uses the `secret-tool` CLI (part of libsecret, installed) via
//  Foundation.Process — no C bindings needed. Items live in the Secret
//  Service (GNOME Keyring/KWallet) under service=sh.t4code.linux.

import Foundation

struct EphemeralConnectionCredentials: Equatable {
    let endpoint: String
    let deviceId: String
    let deviceToken: String

    init(endpoint: String, deviceId: String, deviceToken: String) {
        self.endpoint = endpoint
        self.deviceId = deviceId
        self.deviceToken = deviceToken
    }

    /// Parse `-T4Endpoint=`, `-T4DeviceId=`, `-T4DeviceToken=` launch
    /// overrides (the pairing/QA seam; mirrors the Apple version).
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
        self.init(endpoint: endpoint, deviceId: deviceId, deviceToken: deviceToken)
    }
}

enum Keychain {
    /// Service prefix for every T4 Code Linux keyring item.
    static let service = "sh.t4code.linux"

    /// `-T4NoRestore` is the fresh-state test seam: the process must not
    /// touch the user's real Secret Service collection.
    static func usesPersistentStore(
        arguments: [String] = ProcessInfo.processInfo.arguments
    ) -> Bool {
        !arguments.contains("-T4NoRestore")
    }

    /// In-memory fallback for -T4NoRestore (mirrors the Apple seam where the
    /// keychain is skipped entirely for test runs).
    private static var ephemeral: [String: String] = [:]

    @discardableResult
    static func set(_ value: String?, forKey key: String) -> Bool {
        guard usesPersistentStore() else {
            if let value, !value.isEmpty {
                ephemeral[key] = value
            } else {
                ephemeral.removeValue(forKey: key)
            }
            return true
        }
        guard let value, !value.isEmpty else {
            return remove(forKey: key)
        }
        // `secret-tool store` reads the secret from stdin.
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/secret-tool")
        process.arguments = ["store", "--label=\(service) \(key)", "service", service, "key", key]
        let pipe = Pipe()
        process.standardInput = pipe
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        do {
            try process.run()
            pipe.fileHandleForWriting.write(Data((value + "\n").utf8))
            pipe.fileHandleForWriting.closeFile()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }

    static func get(_ key: String) -> String? {
        guard usesPersistentStore() else {
            return ephemeral[key]
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/secret-tool")
        process.arguments = ["lookup", "service", service, "key", key]
        let out = Pipe()
        process.standardOutput = out
        process.standardError = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            let data = out.fileHandleForReading.readDataToEndOfFile()
            let text = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return (text?.isEmpty ?? true) ? nil : text
        } catch {
            return nil
        }
    }

    @discardableResult
    static func remove(forKey key: String) -> Bool {
        guard usesPersistentStore() else {
            ephemeral.removeValue(forKey: key)
            return true
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/secret-tool")
        process.arguments = ["clear", "service", service, "key", key]
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
            // exit 0 = cleared, exit 1 = no such item (already gone) — both fine.
            return process.terminationStatus == 0 || process.terminationStatus == 1
        } catch {
            return false
        }
    }
}
