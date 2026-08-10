import Foundation
import HostWire
import Testing
@testable import T4CodeWindowsLib

@MainActor
extension T4SessionStoreFixtureIntegrationTests {
    @Test("Saved host survives restart, disconnects without deletion, reconnects, and forgets alone")
    func saveRestartReconnectAndForget() async throws {
        let fixture = try await WindowsFixtureServer.spawn(scenario: "basic-v1")
        defer { fixture.stop() }

        let backend = WindowsInMemorySavedHostCredentialStore()
        let identity = ClientIdentity(
            name: T4WindowsPlatform.clientName,
            version: "0.1",
            build: "saved-host-lifecycle-test",
            platform: T4WindowsPlatform.clientPlatform
        )
        let authentication = makeFixtureAuthentication()
        let launchArguments = ["T4CodeWindows.exe"]
        let firstStore = T4SessionStore(
            savedHostCredentialStore: backend,
            launchArguments: launchArguments
        )

        await firstStore.connect(
            endpoint: fixture.url,
            identity: identity,
            authentication: authentication
        )
        try await waitForSavedHostStore("initial saved-host connection") {
            firstStore.connected && firstStore.savedHosts.count == 1
        }
        let saved = try #require(backend.allCredentials().first)
        #expect(saved.endpoint == fixture.url.absoluteString)
        #expect(saved.deviceID == authentication.deviceId)
        #expect(saved.deviceToken == authentication.deviceToken)
        #expect(firstStore.activeSavedHostID == saved.id)

        await firstStore.disconnect()
        #expect(!firstStore.connected)
        #expect(backend.allCredentials() == [saved])
        #expect(firstStore.savedHosts == [WindowsSavedHostSummary(id: saved.id, endpoint: saved.endpoint)])

        let replacementAuthentication = makeFixtureAuthentication()
        await firstStore.connect(
            endpoint: fixture.url,
            identity: identity,
            authentication: replacementAuthentication
        )
        try await waitForSavedHostStore("updated saved-host connection") {
            firstStore.connected
        }
        let updated = try #require(backend.allCredentials().first)
        #expect(backend.allCredentials().count == 1)
        #expect(updated.id == saved.id)
        #expect(updated.deviceID == replacementAuthentication.deviceId)
        #expect(updated.deviceToken == replacementAuthentication.deviceToken)
        #expect(updated.deviceToken != saved.deviceToken)
        await firstStore.disconnect()

        let restartedStore = T4SessionStore(
            savedHostCredentialStore: backend,
            launchArguments: launchArguments
        )
        #expect(restartedStore.savedHosts.count == 1)
        await restartedStore.restore()
        try await waitForSavedHostStore("restored saved-host connection") {
            restartedStore.connected && restartedStore.activeSavedHostID == updated.id
        }

        await restartedStore.disconnect()
        #expect(backend.allCredentials() == [updated])
        await restartedStore.connectSavedHost(id: updated.id)
        try await waitForSavedHostStore("explicit saved-host reconnect") {
            restartedStore.connected
        }

        await restartedStore.forgetSavedHost(id: updated.id)
        #expect(!restartedStore.connected)
        #expect(restartedStore.savedHosts.isEmpty)
        #expect(backend.allCredentials().isEmpty)
        #expect(restartedStore.activeSavedHostID == nil)
    }

    @Test("Real Credential Manager persists the full store lifecycle across store recreation")
    func realCredentialManagerStoreLifecycle() async throws {
        let fixture = try await WindowsFixtureServer.spawn(scenario: "basic-v1")
        defer { fixture.stop() }
        let backend = WindowsCredentialManagerSavedHostStore(
            namespace: "net.t4code.app/Omperator/Tests/StoreLifecycle/\(UUID().uuidString)"
        )
        defer { try? backend.removeAll() }

        let launchArguments = ["T4CodeWindows.exe"]
        let authentication = makeFixtureAuthentication()
        let firstStore = T4SessionStore(
            savedHostCredentialStore: backend,
            launchArguments: launchArguments
        )
        await firstStore.connect(
            endpoint: fixture.url,
            identity: ClientIdentity(
                name: T4WindowsPlatform.clientName,
                version: "0.1",
                build: "real-credential-lifecycle-test",
                platform: T4WindowsPlatform.clientPlatform
            ),
            authentication: authentication
        )
        try await waitForSavedHostStore("real credential save") {
            firstStore.connected && firstStore.savedHosts.count == 1
        }
        let saved = try #require(try backend.allCredentials().first)
        await firstStore.disconnect()
        #expect(try backend.credential(id: saved.id) == saved)

        let restartedStore = T4SessionStore(
            savedHostCredentialStore: backend,
            launchArguments: launchArguments
        )
        await restartedStore.restore()
        try await waitForSavedHostStore("real credential restart restore") {
            restartedStore.connected
        }
        await restartedStore.disconnect()
        #expect(try backend.credential(id: saved.id) == saved)

        await restartedStore.connectSavedHost(id: saved.id)
        try await waitForSavedHostStore("real credential reconnect") {
            restartedStore.connected
        }
        await restartedStore.forgetSavedHost(id: saved.id)
        #expect(!restartedStore.connected)
        #expect(try backend.credential(id: saved.id) == nil)
        #expect(try backend.allCredentials().isEmpty)
    }

    @Test("Successful connection reports a credential persistence failure without dropping the live host")
    func persistenceFailureIsHonest() async throws {
        let fixture = try await WindowsFixtureServer.spawn(scenario: "basic-v1")
        defer { fixture.stop() }

        let backend = RecordingSavedHostCredentialStore(failure: .save)
        let store = T4SessionStore(
            savedHostCredentialStore: backend,
            launchArguments: ["T4CodeWindows.exe"]
        )
        await store.connect(
            endpoint: fixture.url,
            identity: ClientIdentity(
                name: T4WindowsPlatform.clientName,
                version: "0.1",
                build: "saved-host-error-test",
                platform: T4WindowsPlatform.clientPlatform
            ),
            authentication: makeFixtureAuthentication()
        )

        #expect(store.connected)
        #expect(store.lastError?.contains("credentials could not be saved") == true)
        #expect(backend.saveCount == 1)
        await store.disconnect()
    }

    @Test("Restoration failures are visible and do not disclose credential values")
    func restorationFailureIsHonestAndRedacted() {
        let backend = RecordingSavedHostCredentialStore(failure: .list)
        let store = T4SessionStore(
            savedHostCredentialStore: backend,
            launchArguments: ["T4CodeWindows.exe"]
        )

        #expect(store.savedHosts.isEmpty)
        #expect(store.lastError?.contains("Could not load saved hosts") == true)
        #expect(backend.listCount == 1)
    }

    @Test("Demo and fixture launches neither read nor persist saved credentials")
    func nonPersistentLaunchModesDoNotAccessBackend() async throws {
        let demoBackend = RecordingSavedHostCredentialStore()
        let demoStore = T4SessionStore(
            savedHostCredentialStore: demoBackend,
            launchArguments: ["T4CodeWindows.exe", "-T4Demo"]
        )
        await demoStore.restore()
        #expect(demoBackend.totalAccessCount == 0)

        let fixture = try await WindowsFixtureServer.spawn(scenario: "basic-v1")
        defer { fixture.stop() }
        let fixtureBackend = RecordingSavedHostCredentialStore()
        let fixtureStore = T4SessionStore(
            savedHostCredentialStore: fixtureBackend,
            launchArguments: ["T4CodeWindows.exe", "-T4BrowserFixture"]
        )
        await fixtureStore.connect(
            endpoint: fixture.url,
            identity: ClientIdentity(
                name: T4WindowsPlatform.clientName,
                version: "0.1",
                build: "fixture-no-persistence-test",
                platform: T4WindowsPlatform.clientPlatform
            ),
            authentication: makeFixtureAuthentication()
        )
        #expect(fixtureStore.connected)
        #expect(fixtureBackend.totalAccessCount == 0)
        await fixtureStore.disconnect()
    }
}

private enum RecordingSavedHostFailure {
    case list
    case save
}

private final class RecordingSavedHostCredentialStore: WindowsSavedHostCredentialStoring, @unchecked Sendable {
    private let lock = NSLock()
    private let failure: RecordingSavedHostFailure?
    private var credentials: [String: WindowsSavedHostCredential] = [:]
    private var accesses = (list: 0, read: 0, save: 0, remove: 0)

    init(failure: RecordingSavedHostFailure? = nil) {
        self.failure = failure
    }

    var listCount: Int { withLock { accesses.list } }
    var saveCount: Int { withLock { accesses.save } }
    var totalAccessCount: Int {
        withLock { accesses.list + accesses.read + accesses.save + accesses.remove }
    }

    func allCredentials() throws -> [WindowsSavedHostCredential] {
        try withLock {
            accesses.list += 1
            if failure == .list { throw RecordingSavedHostError.unavailable }
            return Array(credentials.values)
        }
    }

    func credential(id: String) throws -> WindowsSavedHostCredential? {
        withLock {
            accesses.read += 1
            return credentials[id]
        }
    }

    func save(_ credential: WindowsSavedHostCredential) throws {
        try withLock {
            accesses.save += 1
            if failure == .save { throw RecordingSavedHostError.unavailable }
            credentials[credential.id] = credential
        }
    }

    func remove(id: String) {
        withLock {
            accesses.remove += 1
            credentials.removeValue(forKey: id)
        }
    }

    private func withLock<T>(_ operation: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try operation()
    }
}

private enum RecordingSavedHostError: Error {
    case unavailable
}

private func makeFixtureAuthentication() -> DeviceAuthentication {
    let randomPrefix = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    let validToken = randomPrefix + String(repeating: "a", count: 10) + "A"
    return DeviceAuthentication(
        deviceId: "device-\(UUID().uuidString.lowercased())",
        deviceToken: validToken
    )
}

@MainActor
private func waitForSavedHostStore(
    _ operation: String,
    timeout: TimeInterval = 10,
    condition: @MainActor () async -> Bool
) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() { return }
        try await Task.sleep(for: .milliseconds(50))
    }
    throw WindowsFixtureProbeError.timeout(operation)
}
