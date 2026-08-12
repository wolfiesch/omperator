import Foundation
import HostWire
import SwiftCrossUI
import Testing
@testable import T4CodeWindowsLib

@Suite("Windows terminal bridge and lifecycle", .serialized)
@MainActor
struct T4WindowsTerminalTests {
    @Test("Capability gates prevent unsupported terminal commands")
    func capabilityGating() async {
        let router = TerminalRouter()
        router.state = .init(
            connection: .online,
            capabilities: .unavailable,
            detail: "No terminal capabilities"
        )
        let model = T4WindowsTerminalWorkspaceModel(router: router)

        #expect(await model.ensureOpen(sessionID: "session-a") == nil)
        #expect(router.openCalls.isEmpty)
        #expect(model.errors["session-a"]?.contains("term.open") == true)

        let identity = T4WindowsTerminalIdentity(sessionID: "session-a", terminalID: "term-a")
        await model.routeInput(identity: identity, data: "blocked")
        await model.routeResize(identity: identity, size: .init(columns: 80, rows: 24))
        #expect(router.inputCalls.isEmpty)
        #expect(router.resizeCalls.isEmpty)
    }

    @Test("term.open routes dimensions and returns the host terminal identity")
    func openRouting() async {
        let router = TerminalRouter()
        router.openResults = ["host-terminal-41"]
        let model = T4WindowsTerminalWorkspaceModel(router: router)

        let terminalID = await model.ensureOpen(sessionID: "session-a", columns: 132, rows: 41)

        #expect(terminalID == "host-terminal-41")
        #expect(router.openCalls == [.init(sessionID: "session-a", columns: 132, rows: 41)])
    }

    @Test("Input and paste route through term.input in bounded UTF-8 chunks")
    func inputAndPasteRouting() async {
        let router = TerminalRouter()
        let model = T4WindowsTerminalWorkspaceModel(router: router)
        let identity = T4WindowsTerminalIdentity(sessionID: "session-a", terminalID: "term-a")
        _ = await model.refreshHostState(sessionID: "session-a")

        let longInput = String(repeating: "é", count: 4_500)
        await model.routeInput(identity: identity, data: longInput)
        #expect(router.inputCalls.count == 3)
        #expect(router.inputCalls.allSatisfy { $0.data.utf8.count <= T4WindowsTerminalLimits.maxInputChunkBytes })
        #expect(router.inputCalls.map(\.data).joined() == longInput)

        router.inputCalls.removeAll()
        await model.routePaste(identity: identity, text: "pasted\ntext")
        #expect(router.inputCalls == [.init(identity: identity, data: "pasted\ntext")])
    }

    @Test("Input chunking preserves Unicode scalar boundaries")
    func inputChunking() {
        let chunks = T4WindowsTerminalInputChunker.chunks("ab😀cd😀ef", maxUTF8Bytes: 6)
        #expect(chunks == ["ab😀", "cd😀", "ef"])
        #expect(chunks.joined() == "ab😀cd😀ef")
        #expect(T4WindowsTerminalInputChunker.chunks("").isEmpty)
    }

    @Test("Special, application-cursor, and Ctrl keys use VT byte sequences")
    func specialKeyEncoding() {
        let map = T4WindowsTerminalKeyMap.vt
        #expect(map.normal["Enter"] == "\r")
        #expect(map.normal["Backspace"] == "\u{7f}")
        #expect(map.normal["Tab"] == "\t")
        #expect(map.normal["Escape"] == "\u{1b}")
        #expect(map.normal["ArrowUp"] == "\u{1b}[A")
        #expect(map.applicationCursor["ArrowUp"] == "\u{1b}OA")
        #expect(map.normal["Home"] == "\u{1b}[H")
        #expect(map.normal["End"] == "\u{1b}[F")
        #expect(map.normal["PageUp"] == "\u{1b}[5~")
        #expect(map.normal["PageDown"] == "\u{1b}[6~")
        #expect(map.normal["Delete"] == "\u{1b}[3~")
        #expect(map.normal["Insert"] == "\u{1b}[2~")
        #expect(map.control["A"] == "\u{01}")
        #expect(map.control["C"] == "\u{03}")
        #expect(map.control["Z"] == "\u{1a}")
    }

    @Test("Resize clamps to HostWire bounds, deduplicates, and routes")
    func resizeRouting() async {
        #expect(T4WindowsTerminalGridSize.normalized(columns: 1, rows: 900) == .init(columns: 2, rows: 500))

        let router = TerminalRouter()
        let model = T4WindowsTerminalWorkspaceModel(router: router)
        let identity = T4WindowsTerminalIdentity(sessionID: "session-a", terminalID: "term-a")
        _ = await model.refreshHostState(sessionID: "session-a")
        let size = T4WindowsTerminalGridSize(columns: 120, rows: 38)
        await model.routeResize(identity: identity, size: size)
        await model.routeResize(identity: identity, size: size)

        #expect(router.resizeCalls == [.init(identity: identity, size: size)])
    }

    @Test("Shared model keeps four tabs, active selection, and session isolation")
    func tabsAndSessionIsolation() {
        let terminalModel = T4TerminalModel()
        terminalModel.openIdsBySession["session-a"] = ["a-1", "a-2", "a-3", "a-4"]
        terminalModel.activeIdBySession["session-a"] = "a-3"
        terminalModel.openIdsBySession["session-b"] = ["b-1"]
        terminalModel.activeIdBySession["session-b"] = "b-1"
        terminalModel.output["a-3"] = "session a"
        terminalModel.output["b-1"] = "session b"

        #expect(terminalModel.openIdsBySession["session-a"]?.count == T4WindowsTerminalLimits.maxTerminalsPerSession)
        #expect(terminalModel.activeIdBySession["session-a"] == "a-3")
        terminalModel.activeIdBySession["session-a"] = "a-2"
        #expect(terminalModel.activeIdBySession["session-a"] == "a-2")
        #expect(terminalModel.activeIdBySession["session-b"] == "b-1")
        #expect(terminalModel.output["a-3"] == "session a")
        #expect(terminalModel.output["b-1"] == "session b")
    }

    @Test("Close tears down one renderer and one host terminal")
    func closeAndTeardown() async {
        let router = TerminalRouter()
        let model = T4WindowsTerminalWorkspaceModel(router: router)
        let identity = T4WindowsTerminalIdentity(sessionID: "session-a", terminalID: "term-a")
        let owner = BridgeOwner()
        var closed: [T4WindowsTerminalIdentity] = []
        model.surfaceBridge.attach(
            owner: owner,
            onActivate: { _ in },
            onCloseIdentity: { closed.append($0) },
            onCloseSession: { _ in }
        )
        model.activate(identity: identity, output: "hello", exited: nil, appearance: .dark, requestFocus: true)

        await model.close(identity: identity, reason: "test")

        #expect(closed == [identity])
        #expect(router.closeCalls == [.init(identity: identity, reason: "test")])
        #expect(!model.mountedIdentities.contains(identity))
        #expect(model.surfaces[identity] == nil)
    }

    @Test("Disconnect is detached, reconnect pauses input, and ready reattaches known identity")
    func disconnectReconnectAndReattach() async {
        let router = TerminalRouter()
        let model = T4WindowsTerminalWorkspaceModel(router: router)
        let identity = T4WindowsTerminalIdentity(sessionID: "session-a", terminalID: "term-a")
        model.activate(identity: identity, output: "preserved", exited: nil, appearance: .dark, requestFocus: false)

        router.state = .init(connection: .offline, capabilities: .full, detail: "offline")
        _ = await model.refreshHostState(sessionID: "session-a")
        await model.routeInput(identity: identity, data: "blocked")
        #expect(router.inputCalls.isEmpty)
        #expect(model.notices["session-a"]?.contains("Disconnected") == true)

        router.state = .init(connection: .reconnecting, capabilities: .full, detail: "retrying")
        _ = await model.refreshHostState(sessionID: "session-a")
        #expect(model.notices["session-a"]?.contains("Reconnecting") == true)

        router.state = .init(connection: .online, capabilities: .full, detail: nil)
        _ = await model.refreshHostState(sessionID: "session-a")
        await model.routeInput(identity: identity, data: "resumed")
        #expect(router.inputCalls == [.init(identity: identity, data: "resumed")])
        #expect(model.notices["session-a"]?.contains("Reconnected") == true)
        #expect(model.mountedIdentities == [identity])
        #expect(router.openCalls.isEmpty)
    }

    @Test("Repeated SwiftCrossUI attachment does not duplicate a renderer activation")
    func duplicateSurfacePrevention() {
        let bridge = T4WindowsTerminalSurfaceBridge()
        let owner = BridgeOwner()
        let identity = T4WindowsTerminalIdentity(sessionID: "session-a", terminalID: "term-a")
        var activations = 0
        let attach = {
            bridge.attach(
                owner: owner,
                onActivate: { _ in activations += 1 },
                onCloseIdentity: { _ in },
                onCloseSession: { _ in }
            )
        }
        attach()
        bridge.activate(.init(
            identity: identity,
            output: "",
            exited: nil,
            theme: .moon,
            interactive: true,
            focusEpoch: 1
        ))
        attach()

        #expect(activations == 1)
    }

    @Test("Session pruning cleans only terminal surfaces whose owner disappeared")
    func sessionCleanup() {
        let model = T4WindowsTerminalWorkspaceModel()
        let first = T4WindowsTerminalIdentity(sessionID: "session-a", terminalID: "term-a")
        let second = T4WindowsTerminalIdentity(sessionID: "session-b", terminalID: "term-b")
        model.activate(identity: first, output: "a", exited: nil, appearance: .dark, requestFocus: false)
        model.activate(identity: second, output: "b", exited: nil, appearance: .dark, requestFocus: false)

        #expect(model.prune(keeping: ["session-b"]) == ["session-a"])
        #expect(!model.mountedIdentities.contains(first))
        #expect(model.mountedIdentities.contains(second))
    }

    @Test("Bundled bootstrap enforces bounded scrollback and Rosé Pine themes")
    func bootstrapScrollbackAndThemes() throws {
        let darkURL = try #require(T4WindowsTerminalPage.url(
            instanceID: "renderer-dark",
            theme: .resolve(.dark),
            interactive: true
        ))
        let dark = try #require(T4WindowsTerminalPage.bootstrap(from: darkURL))
        #expect(dark.instanceId == "renderer-dark")
        #expect(dark.scrollback == 5_000)
        #expect(dark.theme == .moon)
        #expect(dark.theme.name == "rose-pine-moon")
        #expect(dark.interactive)

        let lightURL = try #require(T4WindowsTerminalPage.url(
            instanceID: "renderer-light",
            theme: .resolve(.light),
            interactive: false
        ))
        let light = try #require(T4WindowsTerminalPage.bootstrap(from: lightURL))
        #expect(light.theme == .dawn)
        #expect(light.theme.name == "rose-pine-dawn")
        #expect(!light.interactive)
        #expect(T4WindowsTerminalPage.allowsNavigation(
            candidate: darkURL.absoluteString,
            expected: darkURL.absoluteString,
            isInitial: true
        ))
        #expect(!T4WindowsTerminalPage.allowsNavigation(
            candidate: "https://example.com/",
            expected: darkURL.absoluteString,
            isInitial: true
        ))
        #expect(!T4WindowsTerminalPage.allowsNavigation(
            candidate: darkURL.absoluteString,
            expected: darkURL.absoluteString,
            isInitial: false
        ))
    }

    @Test("Bridge accepts only versioned, instance-bound, exact messages")
    func bridgeMessageValidation() throws {
        #expect(try T4WindowsTerminalBridgeDecoder.decode(
            #"{"v":1,"instanceId":"renderer","type":"ready"}"#,
            expectedInstanceID: "renderer"
        ) == .ready)
        #expect(try T4WindowsTerminalBridgeDecoder.decode(
            #"{"v":1,"instanceId":"renderer","type":"input","data":"pwd\\r"}"#,
            expectedInstanceID: "renderer"
        ) == .input("pwd\\r"))
        #expect(try T4WindowsTerminalBridgeDecoder.decode(
            #"{"v":1,"instanceId":"renderer","type":"paste","data":"alpha\\nbeta"}"#,
            expectedInstanceID: "renderer"
        ) == .paste("alpha\\nbeta"))
        #expect(try T4WindowsTerminalBridgeDecoder.decode(
            #"{"v":1,"instanceId":"renderer","type":"resize","cols":120,"rows":38}"#,
            expectedInstanceID: "renderer"
        ) == .resize(.init(columns: 120, rows: 38)))
        #expect(try T4WindowsTerminalBridgeDecoder.decode(
            #"{"v":1,"instanceId":"renderer","type":"focus","focused":true}"#,
            expectedInstanceID: "renderer"
        ) == .focus(true))
    }

    @Test("Bridge rejects malformed, unknown, oversized, wrong-instance, and extra-field messages")
    func bridgeMessageRejection() {
        expectBridgeError(.malformed, json: "not json")
        expectBridgeError(
            .unknownType("navigate"),
            json: #"{"v":1,"instanceId":"renderer","type":"navigate"}"#
        )
        expectBridgeError(
            .invalidInstance,
            json: #"{"v":1,"instanceId":"other","type":"ready"}"#
        )
        expectBridgeError(
            .invalidKeys,
            json: #"{"v":1,"instanceId":"renderer","type":"ready","url":"https://example.com"}"#
        )
        expectBridgeError(
            .invalidPayload,
            json: #"{"v":1,"instanceId":"renderer","type":"resize","cols":0,"rows":24}"#
        )
        let oversized = String(repeating: "x", count: T4WindowsTerminalLimits.maxBridgePasteBytes + 600)
        expectBridgeError(.oversized, json: oversized)
    }

    private func expectBridgeError(
        _ expected: T4WindowsTerminalBridgeMessageError,
        json: String
    ) {
        do {
            _ = try T4WindowsTerminalBridgeDecoder.decode(json, expectedInstanceID: "renderer")
            Issue.record("Terminal bridge message should have been rejected")
        } catch let error as T4WindowsTerminalBridgeMessageError {
            #expect(error == expected)
        } catch {
            Issue.record("Unexpected terminal bridge error: \(error)")
        }
    }
}

@MainActor
private final class TerminalRouter: T4WindowsTerminalHostRouting {
    struct OpenCall: Equatable {
        let sessionID: String
        let columns: Int
        let rows: Int
    }

    struct InputCall: Equatable {
        let identity: T4WindowsTerminalIdentity
        let data: String
    }

    struct ResizeCall: Equatable {
        let identity: T4WindowsTerminalIdentity
        let size: T4WindowsTerminalGridSize
    }

    struct CloseCall: Equatable {
        let identity: T4WindowsTerminalIdentity
        let reason: String?
    }

    var state = T4WindowsTerminalHostState(
        connection: .online,
        capabilities: .full,
        detail: nil
    )
    var openResults = ["terminal-fixture"]
    var openCalls: [OpenCall] = []
    var inputCalls: [InputCall] = []
    var resizeCalls: [ResizeCall] = []
    var closeCalls: [CloseCall] = []

    func windowsTerminalHostState() async -> T4WindowsTerminalHostState {
        state
    }

    func windowsOpenTerminal(sessionID: String, columns: Int, rows: Int) async throws -> String {
        openCalls.append(.init(sessionID: sessionID, columns: columns, rows: rows))
        guard !openResults.isEmpty else { throw T4WindowsTerminalRoutingError.failed("No terminal result") }
        return openResults.removeFirst()
    }

    func windowsSendTerminalInput(identity: T4WindowsTerminalIdentity, data: String) async throws {
        inputCalls.append(.init(identity: identity, data: data))
    }

    func windowsResizeTerminal(
        identity: T4WindowsTerminalIdentity,
        size: T4WindowsTerminalGridSize
    ) async throws {
        resizeCalls.append(.init(identity: identity, size: size))
    }

    func windowsCloseTerminal(identity: T4WindowsTerminalIdentity, reason: String?) async throws {
        closeCalls.append(.init(identity: identity, reason: reason))
    }
}

private final class BridgeOwner {}
