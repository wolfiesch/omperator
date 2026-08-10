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

    @Test("Embedded terminal routes live HostWire open, ANSI output, input, resize, tabs, close, and reconnect")
    func liveTerminalFlowAndReconnect() async throws {
        let fixture = try await WindowsFixtureServer.spawn(scenario: "basic-v1")
        defer { fixture.stop() }

        let store = T4SessionStore()
        let workspace = T4WindowsTerminalWorkspaceModel(router: store)
        let identity = ClientIdentity(
            name: T4WindowsPlatform.clientName,
            version: "0.1",
            build: "terminal-fixture-test",
            platform: T4WindowsPlatform.clientPlatform
        )

        do {
            await store.connect(endpoint: fixture.url, identity: identity, authentication: nil)
            try await waitForStore("terminal-capable host") {
                store.connected
                    && store.sessions.count == 1
                    && store.grantedCapabilities.contains("term.open")
                    && store.grantedCapabilities.contains("term.input")
                    && store.grantedCapabilities.contains("term.resize")
            }
            let session = try #require(store.sessions.first)
            store.select(session)
            await store.attach(sessionId: session.sessionId)

            let firstOpen = Task {
                await workspace.ensureOpen(sessionID: session.sessionId, columns: 80, rows: 24)
            }
            try await waitForStore("first terminal confirmation") {
                store.pendingConfirmation?.summary == "term.open"
            }
            await store.confirm(.approve)
            let firstID = try #require(await firstOpen.value)
            try await waitForStore("initial ANSI terminal output") {
                let output = store.terminalModel.output[firstID] ?? ""
                return output.contains("\u{1b}[1;35m")
                    && output.contains("\r\u{1b}[2Kprogress 100%")
            }

            let firstIdentity = T4WindowsTerminalIdentity(
                sessionID: session.sessionId,
                terminalID: firstID
            )
            _ = await workspace.refreshHostState(sessionID: session.sessionId)
            await workspace.routeInput(identity: firstIdentity, data: "echo windows\r")
            try await waitForStore("fixture command echo") {
                (store.terminalModel.output[firstID] ?? "").contains("fixture output: echo windows")
            }

            let resized = T4WindowsTerminalGridSize(columns: 132, rows: 41)
            await workspace.routeResize(identity: firstIdentity, size: resized)
            try await waitForStore("fixture resize observation") {
                let observations = try? await fixture.terminalObservations()
                return observations?.contains(where: {
                    $0.kind == "resize"
                        && $0.terminalId == firstID
                        && $0.cols == 132
                        && $0.rows == 41
                }) == true
            }

            let secondOpen = Task {
                await workspace.ensureOpen(sessionID: session.sessionId, columns: 100, rows: 30)
            }
            try await waitForStore("second terminal confirmation") {
                store.pendingConfirmation?.summary == "term.open"
            }
            await store.confirm(.approve)
            let secondID = try #require(await secondOpen.value)
            #expect(secondID != firstID)
            #expect(store.terminalModel.openIdsBySession[session.sessionId] == [firstID, secondID])
            #expect(store.terminalModel.activeIdBySession[session.sessionId] == secondID)

            let firstBeforeSecondInput = store.terminalModel.output[firstID]
            let secondIdentity = T4WindowsTerminalIdentity(
                sessionID: session.sessionId,
                terminalID: secondID
            )
            await workspace.routeInput(identity: secondIdentity, data: "second tab\r")
            try await waitForStore("second terminal output") {
                (store.terminalModel.output[secondID] ?? "").contains("fixture output: second tab")
            }
            #expect(store.terminalModel.output[firstID] == firstBeforeSecondInput)

            await workspace.close(identity: secondIdentity, reason: "integration complete")
            #expect(store.terminalModel.openIdsBySession[session.sessionId] == [firstID])
            #expect(store.terminalModel.activeIdBySession[session.sessionId] == firstID)
            try await waitForStore("fixture terminal close") {
                let observations = try? await fixture.terminalObservations()
                return observations?.contains(where: {
                    $0.kind == "close" && $0.terminalId == secondID
                }) == true
            }

            try await fixture.dropConnections()
            try await waitForStore("honest terminal reconnect state", timeout: 5) {
                let state = await workspace.refreshHostState(sessionID: session.sessionId)
                return state.connection != .online
            }
            try await fixture.waitForConnectionCount(atLeast: 2, timeout: 20)
            try await waitForStore("terminal HostWire reconnect", timeout: 20) {
                await store.client?.isReady == true
            }
            let recovered = await workspace.refreshHostState(sessionID: session.sessionId)
            #expect(recovered.connection == .online)
            #expect(workspace.notices[session.sessionId]?.contains("Reconnected") == true)

            await workspace.routeInput(identity: firstIdentity, data: "after reconnect\r")
            try await waitForStore("reattached terminal input") {
                (store.terminalModel.output[firstID] ?? "").contains("fixture output: after reconnect")
            }
            #expect(store.terminalModel.openIdsBySession[session.sessionId] == [firstID])

            await workspace.close(identity: firstIdentity, reason: "integration complete")
            await store.disconnect()
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
