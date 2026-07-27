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
}
