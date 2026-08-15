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

    /// Auto-rc: select() remembers the open session, explicit disconnect()
    /// forgets it, and a fresh store with no in-memory selection returns to
    /// the persisted session once the inventory lands (the relaunch/reconnect
    /// flow) instead of the default visible row.
    @Test
    @MainActor
    func restoreReturnsToLastSession() async throws {
        let fixture = try await FixtureServer.spawn(scenario: "basic-v1", repoPath: t4RepoRoot)
        defer { fixture.stop() }

        let store = T4SessionStore()
        await store.connect(endpoint: fixture.url, identity: Self.identity(), authentication: Self.auth())
        #expect(store.connectionModel.connected, "store should be connected: \(store.connectionModel.lastError ?? "")")

        try await waitUntil("session inventory") { !store.connectionModel.sessions.isEmpty }
        guard let session = store.connectionModel.sessions.first(where: { $0.sessionId == "session-basic" }) else {
            Issue.record("session-basic not in inventory")
            return
        }

        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: "t4.lastSessionId")
        defer { defaults.removeObject(forKey: "t4.lastSessionId") }

        store.select(session)
        #expect(store.selectedSession?.sessionId == "session-basic")
        #expect(defaults.string(forKey: "t4.lastSessionId") == session.sessionId, "select() must persist the open session")
        await store.disconnect()
        #expect(defaults.string(forKey: "t4.lastSessionId") == nil, "explicit disconnect forgets the host and the session memory")

        // The returning-user shape: the app quit without disconnecting, so
        // the persisted id survives. A fresh store has no selection; the
        // inventory landing must bring it back to the same session.
        defaults.set(session.sessionId, forKey: "t4.lastSessionId")
        let restored = T4SessionStore()
        #expect(restored.selectedSession == nil)
        await restored.connect(endpoint: fixture.url, identity: Self.identity(), authentication: Self.auth())
        #expect(restored.connectionModel.connected, "restored store should be connected: \(restored.connectionModel.lastError ?? "")")
        try await waitUntil("restored selection") {
            restored.selectedSession?.sessionId == "session-basic"
        }

        await restored.disconnect()
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

    /// Draft session flow: startDraftSession opens a local draft instantly
    /// (no host round trip); the first prompt stages the optimistic bubble,
    /// creates the real session in the background, migrates the bubble onto
    /// it, and selects it.
    @Test
    @MainActor
    func draftSessionPromptsInstantly() async throws {
        let fixture = try await FixtureServer.spawn(scenario: "basic-v1", repoPath: t4RepoRoot)
        defer { fixture.stop() }

        let store = T4SessionStore()
        await store.connect(endpoint: fixture.url, identity: Self.identity(), authentication: Self.auth())
        #expect(store.connectionModel.connected, "store should be connected: \(store.connectionModel.lastError ?? "")")
        try await waitUntil("session inventory") { !store.connectionModel.sessions.isEmpty }

        store.startDraftSession()
        guard let draft = store.selectedSession, draft.sessionId.hasPrefix("draft-") else {
            Issue.record("startDraftSession did not select a draft")
            return
        }
        #expect(store.connectionModel.sessions.first?.sessionId == draft.sessionId)

        await store.sendPrompt(sessionId: draft.sessionId, text: "hello draft")

        // The real session is created and selected; the bubble migrated.
        try await waitUntil("real session selected", timeout: 20) {
            store.selectedSession != nil && !store.selectedSession!.sessionId.hasPrefix("draft-")
        }
        let realId = store.selectedSession!.sessionId
        let migrated = store.transcriptModel.entries[realId] ?? []
        #expect(migrated.contains { $0.kind == .message && $0.role == "user" && $0.body.contains("hello draft") },
                "optimistic bubble should migrate to the real session")
        #expect(!store.connectionModel.sessions.contains { $0.sessionId == draft.sessionId },
                "the draft row is replaced by the real session")

        await store.disconnect()
    }
}
