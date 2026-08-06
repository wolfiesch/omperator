//  StorePromptTests.swift
//  Store-level integration: T4SessionStore connect → select → attach →
//  sendPrompt → streaming transcript entries land in the projection models.

import Foundation
import Testing
import HostWire
@testable import T4CodeLinuxLib

@Suite("Store prompt flow", .serialized)
struct StorePromptTests {
    private static let token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

    @MainActor
    private static func identity() -> ClientIdentity {
        ClientIdentity(name: platformClientName, version: "0.1", build: "test", platform: platformClientPlatform)
    }

    private static func auth() -> DeviceAuthentication {
        DeviceAuthentication(deviceId: "fixture-test", deviceToken: token)
    }

    /// Connect to the basic-v1 fixture and assert the session inventory lands.
    @Test
    @MainActor
    func connectLoadsSessionInventory() async throws {
        let fixture = try await FixtureServer.spawn(scenario: "basic-v1", repoPath: t4RepoRoot)
        defer { fixture.stop() }

        let store = T4SessionStore()
        await store.connect(endpoint: fixture.url, identity: Self.identity(), authentication: Self.auth())

        #expect(store.connectionModel.connected, "store should be connected: \(store.connectionModel.lastError ?? "")")
        try await waitUntil("session inventory") { !store.connectionModel.sessions.isEmpty }
        #expect(store.connectionModel.sessions.contains { $0.sessionId == "session-basic" })

        await store.disconnect()
    }

    /// Full prompt flow: select the seeded session, attach, send a prompt,
    /// and assert the fixture's streaming deltas land as transcript entries.
    @Test
    @MainActor
    func promptStreamsTranscriptEntries() async throws {
        let fixture = try await FixtureServer.spawn(scenario: "stream-v1", repoPath: t4RepoRoot)
        defer { fixture.stop() }

        let store = T4SessionStore()
        await store.connect(endpoint: fixture.url, identity: Self.identity(), authentication: Self.auth())
        #expect(store.connectionModel.connected, "store should be connected: \(store.connectionModel.lastError ?? "")")

        try await waitUntil("session inventory") {
            store.connectionModel.sessions.contains { $0.sessionId == "session-stream" }
        }
        guard let session = store.connectionModel.sessions.first(where: { $0.sessionId == "session-stream" }) else {
            Issue.record("session-stream not in inventory")
            return
        }
        store.selectedSession = session
        await store.attach(sessionId: session.sessionId)

        await store.sendPrompt(sessionId: session.sessionId, text: "hello fixture")

        // stream-v1 emits deltas at 10/20/30ms settling into one entry
        // whose text is "Hello world".
        try await waitUntil("transcript entries", timeout: 20) {
            guard let entries = store.transcriptModel.entries[session.sessionId] else { return false }
            return entries.contains { entry in
                String(describing: entry).contains("Hello world") ||
                String(describing: entry).lowercased().contains("hello")
            }
        }

        await store.disconnect()
    }
}
