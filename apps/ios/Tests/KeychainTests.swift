import XCTest
@testable import T4Code

final class KeychainTests: XCTestCase {
    func testNoRestoreArgumentDisablesPersistentKeychain() {
        XCTAssertFalse(
            Keychain.usesPersistentStore(arguments: ["T4Code", "-T4NoRestore"])
        )
    }

    func testNormalLaunchKeepsPersistentKeychainEnabled() {
        XCTAssertTrue(Keychain.usesPersistentStore(arguments: ["T4Code"]))
    }

    @MainActor
    func testNoRestorePreservesLegacyCredentialsForLaterMigration() {
        let suiteName = "KeychainTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set("wss://example.test/v1/ws", forKey: "t4.endpoint")
        defaults.set("device-id", forKey: "t4.deviceId")
        defaults.set("device-token", forKey: "t4.deviceToken")

        T4SessionStore.migrateCredentialsToKeychainIfNeeded(
            arguments: ["T4Code", "-T4NoRestore"],
            defaults: defaults
        )

        XCTAssertEqual(defaults.string(forKey: "t4.endpoint"), "wss://example.test/v1/ws")
        XCTAssertEqual(defaults.string(forKey: "t4.deviceId"), "device-id")
        XCTAssertEqual(defaults.string(forKey: "t4.deviceToken"), "device-token")
        let migrationMarkerKey = ["t4", "keychainMigrated"].joined(separator: ".")
        XCTAssertFalse(defaults.bool(forKey: migrationMarkerKey))
    }
}
