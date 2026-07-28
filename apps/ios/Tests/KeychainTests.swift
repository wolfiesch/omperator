import XCTest
import HostWire
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

    func testCompleteEphemeralCredentialsDisablePersistentKeychain() {
        let arguments = [
            "T4Code",
            "-T4Endpoint=wss://example.test/v1/ws",
            "-T4DeviceId=device-id",
            "-T4DeviceToken=device-token",
        ]

        XCTAssertFalse(Keychain.usesPersistentStore(arguments: arguments))
        XCTAssertEqual(
            EphemeralConnectionCredentials(arguments: arguments),
            EphemeralConnectionCredentials(
                endpoint: "wss://example.test/v1/ws",
                deviceId: "device-id",
                deviceToken: "device-token"
            )
        )
    }

    func testIncompleteEphemeralCredentialsKeepPersistentKeychainEnabled() {
        XCTAssertTrue(
            Keychain.usesPersistentStore(arguments: [
                "T4Code",
                "-T4Endpoint=wss://example.test/v1/ws",
                "-T4DeviceId=device-id",
            ])
        )
    }

    @MainActor
    func testSuccessfulConnectionClearsStaleEndpointError() {
        let store = T4SessionStore()
        store.lastError = """
        Error Domain=NSURLErrorDomain Code=-1004 \
        "Could not connect to the server."
        """

        store.clearErrorAfterSuccessfulConnection()

        XCTAssertNil(store.lastError)
    }

    func testPendingTranscriptQueueKeepsEveryAssistantEntry() throws {
        var queue = PendingTranscriptQueue()

        queue.enqueue(try transcriptEntry(id: "assistant-1", kind: "message"))
        queue.enqueue(try transcriptEntry(id: "assistant-2", kind: "message"))

        XCTAssertEqual(queue.entries.map(\.id), ["assistant-1", "assistant-2"])
    }

    func testPendingTranscriptQueueDrainsOnlyReadyOrderedPrefix() throws {
        var queue = PendingTranscriptQueue()
        queue.enqueue(try transcriptEntry(id: "assistant-1", kind: "message"))
        queue.enqueue(try transcriptEntry(id: "tool-1", kind: "tool-use", toolCallId: "call-1"))
        queue.enqueue(try transcriptEntry(id: "assistant-2", kind: "message"))

        var ready: Set<String> = ["tool-1"]
        XCTAssertTrue(queue.drainReadyPrefix { ready.contains($0.id) }.isEmpty)

        ready.insert("assistant-1")
        XCTAssertEqual(
            queue.drainReadyPrefix { ready.contains($0.id) }.map(\.id),
            ["assistant-1", "tool-1"]
        )
        XCTAssertEqual(queue.entries.map(\.id), ["assistant-2"])
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

    @MainActor
    func testEphemeralCredentialsPreserveLegacyCredentialsForLaterMigration() {
        let suiteName = "KeychainTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set("wss://saved.example/v1/ws", forKey: "t4.endpoint")
        defaults.set("saved-device-id", forKey: "t4.deviceId")
        defaults.set("saved-device-token", forKey: "t4.deviceToken")

        T4SessionStore.migrateCredentialsToKeychainIfNeeded(
            arguments: [
                "T4Code",
                "-T4Endpoint=wss://ephemeral.example/v1/ws",
                "-T4DeviceId=ephemeral-device-id",
                "-T4DeviceToken=ephemeral-device-token",
            ],
            defaults: defaults
        )

        XCTAssertEqual(defaults.string(forKey: "t4.endpoint"), "wss://saved.example/v1/ws")
        XCTAssertEqual(defaults.string(forKey: "t4.deviceId"), "saved-device-id")
        XCTAssertEqual(defaults.string(forKey: "t4.deviceToken"), "saved-device-token")
        let migrationMarkerKey = ["t4", "keychainMigrated"].joined(separator: ".")
        XCTAssertFalse(defaults.bool(forKey: migrationMarkerKey))
    }

    private func transcriptEntry(
        id: String,
        kind: String,
        toolCallId: String? = nil
    ) throws -> TranscriptEntry {
        var entryData: [String: Any] = ["role": "assistant", "text": id]
        if let toolCallId {
            entryData = ["toolCallId": toolCallId, "tool": "write", "ok": true]
        }
        let payload: [String: Any] = [
            "id": id,
            "parentId": NSNull(),
            "hostId": "host-1",
            "sessionId": "session-1",
            "turnId": "turn-1",
            "kind": kind,
            "timestamp": "2026-07-27T00:00:00.000Z",
            "data": entryData,
        ]
        return try TranscriptEntry.decode(JSONSerialization.data(withJSONObject: payload))
    }
}
