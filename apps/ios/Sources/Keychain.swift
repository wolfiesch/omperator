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
import Security

enum Keychain {
    /// Service prefix shared by every T4 Code keychain item (matches the
    /// `sh.t4code.ios` logger subsystem).
    static let service = "sh.t4code.ios"

    /// Store `value` under `key`. Replaces any existing item. A nil or empty
    /// value deletes the item, so callers can treat "clear" as "set nil".
    /// Returns true on success.
    @discardableResult
    static func set(_ value: String?, forKey key: String) -> Bool {
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
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrSynchronizable as String: false,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnData as String: true,
            // Never pop the macOS consent dialog: unsigned/adhoc dev builds
            // shift signatures, and the prompt blocks the main thread forever
            // when the SecurityAgent UI can't appear. Failing fast (nil) lets
            // callers fall back instead of hanging the app before first paint.
            kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail,
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
