import Foundation
import HostWire
import Testing
@testable import T4CodeWindowsLib

@Suite("Windows shared store fixture integration", .serialized)
@MainActor
struct T4SessionStoreFixtureIntegrationTests {
    @Test("Store connects, attaches, streams a prompt, and recovers after a drop")
    func liveHostFlowAndReconnect() async throws {
        let fixture = try await WindowsFixtureServer.spawn(scenario: "stream-v1")
        defer { fixture.stop() }

        let store = T4SessionStore()
        let browserModel = T4WindowsBrowserWorkspaceModel()
        _ = browserModel.mount(
            sessionID: "session-stream",
            initialURL: "https://browser.example/kept"
        )
        _ = browserModel.apply(.init(
            sessionID: "session-stream",
            event: .surfaceReady
        ))
        let browserBeforeDrop = browserModel.apply(.init(
            sessionID: "session-stream",
            event: .navigationState(
                url: "https://browser.example/kept",
                title: "Independent browser",
                canGoBack: true,
                canGoForward: false,
                isLoading: false,
                failure: nil
            )
        ))
        let identity = ClientIdentity(
            name: T4WindowsPlatform.clientName,
            version: "0.1",
            build: "store-fixture-test",
            platform: T4WindowsPlatform.clientPlatform
        )

        do {
            await store.connect(
                endpoint: fixture.url,
                identity: identity,
                authentication: nil
            )
            try await waitForStore("live session inventory") {
                store.connected
                    && store.hostId == "host-stream"
                    && store.sessions.count == 1
                    && !store.catalogModels.isEmpty
            }

            guard let session = store.sessions.first else {
                throw StoreFixtureAssertionError.expectedSession
            }
            #expect(session.sessionId == "session-stream")
            #expect(session.project.projectId == "project-stream")
            #expect(!store.catalogModels.isEmpty)

            store.select(session)
            try await waitForStore("attached transcript snapshot") {
                !store.transcript(for: session.sessionId).isEmpty
            }

            await store.sendPrompt(
                sessionId: session.sessionId,
                text: "Stream a deterministic fixture response."
            )
            try await waitForStore("live streaming projection", timeout: 2) {
                guard let buffer = store.streamingMessages[session.sessionId] else {
                    return false
                }
                return !buffer.isEmpty
            }
            try await waitForStore("first streamed response") {
                store.transcript(for: session.sessionId)
                    .contains(where: { $0.body == "Hello world" })
            }
            let responseCountBeforeDrop = store.transcript(for: session.sessionId)
                .count(where: { $0.body == "Hello world" })
            #expect(responseCountBeforeDrop == 1)
            #expect(store.lastError == nil)

            try await fixture.dropConnections()
            try await fixture.waitForConnectionCount(atLeast: 2, timeout: 20)
            try await waitForStore("reconnected HostWire client", timeout: 20) {
                await store.client?.isReady == true
            }

            await store.refresh()
            #expect(store.connected)
            #expect(store.sessions.first?.sessionId == session.sessionId)
            #expect(
                browserModel.snapshot(
                    sessionID: session.sessionId,
                    initialURL: "https://ignored.example"
                ) == browserBeforeDrop
            )

            await store.sendPrompt(
                sessionId: session.sessionId,
                text: "Prove the recovered connection still streams."
            )
            try await waitForStore("post-reconnect streamed response") {
                store.transcript(for: session.sessionId)
                    .count(where: { $0.body == "Hello world" })
                    > responseCountBeforeDrop
            }
            #expect(store.lastError == nil)

            await store.disconnect()
            #expect(!store.connected)
            #expect(store.client == nil)
            #expect(store.transcript(for: session.sessionId).isEmpty)
            #expect(
                browserModel.snapshot(
                    sessionID: session.sessionId,
                    initialURL: "https://ignored.example"
                ) == browserBeforeDrop
            )
        } catch {
            await store.disconnect()
            throw error
        }
    }
}

@MainActor
private func waitForStore(
    _ operation: String,
    timeout: TimeInterval = 10,
    condition: @MainActor () async -> Bool
) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() {
            return
        }
        try await Task.sleep(for: .milliseconds(50))
    }
    throw WindowsFixtureProbeError.timeout(operation)
}

private enum StoreFixtureAssertionError: Error {
    case expectedSession
}
