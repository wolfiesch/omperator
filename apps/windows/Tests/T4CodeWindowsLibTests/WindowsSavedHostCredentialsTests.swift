import Foundation
import Testing
@testable import T4CodeWindowsLib

@Suite("Windows saved-host credential model")
struct WindowsSavedHostCredentialModelTests {
    @Test("In-memory backend saves, reads, updates, removes, and orders multiple hosts")
    func inMemoryLifecycle() throws {
        let backend = WindowsInMemorySavedHostCredentialStore()
        let first = try makeCredential(endpoint: "ws://FIRST.Example:8787/v1/ws")
        let second = try makeCredential(
            endpoint: "wss://second.example:8788/v1/ws",
            certificatePin: String(repeating: "ab", count: 32)
        )

        backend.save(first)
        backend.save(second)
        #expect(backend.allCredentials() == [second, first])
        #expect(backend.credential(id: first.id) == first)

        let updatedFirst = try WindowsSavedHostCredential(
            endpoint: first.endpoint,
            deviceID: "device-\(UUID().uuidString)",
            deviceToken: UUID().uuidString,
            certificatePin: nil
        )
        backend.save(updatedFirst)
        #expect(backend.allCredentials() == [updatedFirst, second])
        #expect(backend.credential(id: first.id) == updatedFirst)

        backend.remove(id: first.id)
        #expect(backend.allCredentials() == [second])
        #expect(backend.credential(id: first.id) == nil)
    }

    @Test("Credential codec round-trips all connection fields without descriptive disclosure")
    func codecAndRedaction() throws {
        let pin = String(repeating: "cd", count: 32)
        let credential = try makeCredential(
            endpoint: "wss://host.example:8788/v1/ws",
            certificatePin: pin
        )

        let encoded = try WindowsSavedHostCredentialCodec.encode(credential)
        #expect(try WindowsSavedHostCredentialCodec.decode(encoded) == credential)
        #expect(!credential.description.contains(credential.deviceID))
        #expect(!credential.description.contains(credential.deviceToken))
        #expect(!credential.description.contains(pin))
        #expect(credential.description.contains("<redacted>"))
    }

    @Test("Secure endpoints require a normalized SHA-256 certificate pin")
    func secureEndpointPinValidation() throws {
        let colonSeparatedPin = Array(repeating: "AB", count: 32).joined(separator: ":")
        let credential = try makeCredential(
            endpoint: "WSS://HOST.EXAMPLE:8788",
            certificatePin: colonSeparatedPin
        )

        #expect(credential.endpoint == "wss://host.example:8788/v1/ws")
        #expect(credential.certificatePin == String(repeating: "ab", count: 32))

        do {
            _ = try makeCredential(endpoint: "wss://host.example:8788/v1/ws")
            Issue.record("Expected a secure endpoint without a certificate pin to fail")
        } catch {
            #expect(error as? WindowsSavedHostCredentialError == .missingCertificatePin)
        }
    }

    @Test("Demo, fixture, pairing, and complete launch profiles disable persistent credentials")
    func persistencePolicy() {
        let executable = "T4CodeWindows.exe"
        let deviceID = "device-\(UUID().uuidString)"
        let deviceToken = UUID().uuidString
        let launchProfile = [
            executable,
            "-T4Endpoint=ws://127.0.0.1:8787/v1/ws",
            "-T4DeviceId=\(deviceID)",
            "-T4DeviceToken=\(deviceToken)",
        ]

        #expect(WindowsCredentialAccessPolicy.allowsPersistentCredentials(arguments: [executable]))
        #expect(!WindowsCredentialAccessPolicy.allowsPersistentCredentials(arguments: [executable, "-T4Demo"]))
        #expect(!WindowsCredentialAccessPolicy.allowsPersistentCredentials(arguments: [executable, "-T4BrowserFixture"]))
        #expect(!WindowsCredentialAccessPolicy.allowsPersistentCredentials(arguments: [executable, "-T4PairCode", "123456"]))
        #expect(!WindowsCredentialAccessPolicy.allowsPersistentCredentials(arguments: launchProfile))
        let description = String(describing: EphemeralConnectionCredentials(arguments: launchProfile))
        #expect(!description.contains(deviceID))
        #expect(!description.contains(deviceToken))
    }

    private func makeCredential(
        endpoint: String,
        certificatePin: String? = nil
    ) throws -> WindowsSavedHostCredential {
        try WindowsSavedHostCredential(
            endpoint: endpoint,
            deviceID: "device-\(UUID().uuidString)",
            deviceToken: UUID().uuidString.replacingOccurrences(of: "-", with: ""),
            certificatePin: certificatePin
        )
    }
}

@Suite("Windows Credential Manager saved-host backend", .serialized)
struct WindowsCredentialManagerSavedHostStoreTests {
    @Test("Real backend round-trips, updates, enumerates, and removes isolated test credentials")
    func realCredentialManagerLifecycle() throws {
        let testID = UUID().uuidString
        let backend = WindowsCredentialManagerSavedHostStore(
            namespace: "net.t4code.app/Omperator/Tests/SavedHost/\(testID)"
        )
        defer { try? backend.removeAll() }

        let first = try WindowsSavedHostCredential(
            endpoint: "ws://credential-test-\(testID.lowercased()).invalid:8787/v1/ws",
            deviceID: "device-\(UUID().uuidString)",
            deviceToken: UUID().uuidString,
            certificatePin: nil
        )
        try backend.save(first)
        #expect(try backend.credential(id: first.id) == first)
        #expect(try backend.allCredentials() == [first])

        let updated = try WindowsSavedHostCredential(
            endpoint: first.endpoint,
            deviceID: "device-\(UUID().uuidString)",
            deviceToken: UUID().uuidString,
            certificatePin: nil
        )
        try backend.save(updated)
        #expect(try backend.credential(id: first.id) == updated)
        #expect(try backend.allCredentials() == [updated])

        let second = try WindowsSavedHostCredential(
            endpoint: "wss://credential-test-\(UUID().uuidString.lowercased()).invalid:8788/v1/ws",
            deviceID: "device-\(UUID().uuidString)",
            deviceToken: UUID().uuidString,
            certificatePin: String(repeating: "ef", count: 32)
        )
        try backend.save(second)
        #expect(Set(try backend.allCredentials().map(\.id)) == Set([updated.id, second.id]))

        try backend.remove(id: updated.id)
        #expect(try backend.credential(id: updated.id) == nil)
        #expect(try backend.allCredentials() == [second])

        try backend.remove(id: second.id)
        #expect(try backend.allCredentials().isEmpty)
    }
}
