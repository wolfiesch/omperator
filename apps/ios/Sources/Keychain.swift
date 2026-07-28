//  Keychain.swift
//  Minimal Security-framework Keychain wrapper for the T4 Code app's
//  persisted connection credentials (endpoint, deviceId, deviceToken).
//
//  Items are stored as `kSecClassGenericPassword` under a fixed service, with
//  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` — device-local, never
//  synced to iCloud Keychain (`kSecAttrSynchronizable = false`). This replaces
//  the prior dev-grade UserDefaults store, which left the device token in the
//  plist unencrypted.
//
//  Cross-platform: the Security framework symbols used here
//  (SecItemAdd/CopyMatching/Delete, kSecClassGenericPassword, the accessible
//  constant) are available unchanged on both iOS and macOS, so the core
//  read/write/delete path needs no `#if os()` guards.

import Foundation
import LocalAuthentication
import Security

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
        else { return nil }
        self.endpoint = endpoint
        self.deviceId = deviceId
        self.deviceToken = deviceToken
    }
}

enum Keychain {
    /// Service prefix shared by every T4 Code keychain item (matches the
    /// `sh.t4code.ios` logger subsystem).
    static let service = "sh.t4code.ios"

    /// `-T4NoRestore` is the app's fresh-state test seam. In that mode the
    /// process must not touch the developer's real login Keychain: unsigned
    /// and ad-hoc test builds have changing identities, so macOS otherwise
    /// asks for permission to read credentials written by an earlier build.
    static func usesPersistentStore(
        arguments: [String] = ProcessInfo.processInfo.arguments
    ) -> Bool {
        !arguments.contains("-T4NoRestore")
            && EphemeralConnectionCredentials(arguments: arguments) == nil
    }

    /// Store `value` under `key`. Replaces any existing item. A nil or empty
    /// value deletes the item, so callers can treat "clear" as "set nil".
    /// Returns true on success.
    @discardableResult
    static func set(_ value: String?, forKey key: String) -> Bool {
        guard usesPersistentStore() else { return true }
        guard let value, !value.isEmpty else {
            return remove(forKey: key)
        }
        let data = Data(value.utf8)
        // Upsert via delete-then-add: idempotent and avoids the
        // errSecDuplicateItem update-query dance.
        remove(forKey: key)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrSynchronizable as String: false,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: data,
        ]
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    /// Read the string stored under `key`, or nil if absent/unreadable.
    static func get(_ key: String) -> String? {
        guard usesPersistentStore() else { return nil }
        let authenticationContext = LAContext()
        authenticationContext.interactionNotAllowed = true
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrSynchronizable as String: false,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnData as String: true,
            // Ad-hoc macOS builds change signing identities frequently. Never
            // block first paint on an interactive SecurityAgent consent sheet;
            // an unreadable item behaves exactly like a missing item.
            kSecUseAuthenticationContext as String: authenticationContext,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let string = String(data: data, encoding: .utf8)
        else { return nil }
        return string
    }

    /// Remove the item under `key`. Returns true if it is now gone (deleted
    /// or already absent); false only on an unexpected error.
    @discardableResult
    static func remove(forKey key: String) -> Bool {
        guard usesPersistentStore() else { return true }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrSynchronizable as String: false,
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
