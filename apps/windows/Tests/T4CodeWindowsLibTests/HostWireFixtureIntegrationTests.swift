import Foundation
import HostWire
import Testing
@testable import T4CodeWindowsLib

@Suite("Windows URLSession HostWire fixture probe", .serialized)
struct HostWireFixtureIntegrationTests {
    private static let validToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

    private static func identity() -> ClientIdentity {
        ClientIdentity(
            name: "t4-windows",
            version: "0.1",
            build: "fixture-test",
            platform: "windows"
        )
    }

    private static func authentication(token: String = validToken) -> DeviceAuthentication {
        DeviceAuthentication(deviceId: "windows-fixture-test", deviceToken: token)
    }

    private static func config(
        authentication: DeviceAuthentication
    ) -> HostClient.Config {
        var config = HostClient.Config(
            identity: identity(),
            authentication: authentication
        )
        config.handshakeTimeout = 5
        config.heartbeatInterval = 60
        config.commandTimeout = 5
        return config
    }

    @Test("URLSession transport sends hello and receives welcome directly")
    func rawURLSessionHelloWelcomeAndClose() async throws {
        let fixture = try await WindowsFixtureServer.spawn(scenario: "basic-v1")
        defer { fixture.stop() }

        let transport = URLSessionHostWireTransport(endpoint: fixture.url)
        try await transport.open()
        let hello = HelloFrame(
            protocolRange: ProtocolRange(
                min: Wire.protocolVersion,
                max: Wire.protocolVersion
            ),
            client: Self.identity(),
            requestedFeatures: ["resume"],
            savedCursors: [],
            authentication: Self.authentication()
        )
        try await transport.send(JSONEncoder().encode(hello))

        let data = try await transport.receive()
        guard case .welcome(let welcome) = try ServerFrame.decode(data) else {
            transport.close()
            throw FixtureAssertionError.expectedWelcome
        }
        #expect(welcome.hostId == "host-basic")
        #expect(welcome.authentication == .local)
        #expect(welcome.ompVersion == "fixture")
        var receivedInventory = false
        var receivedSnapshot = false
        for _ in 0..<5 {
            switch try ServerFrame.decode(await transport.receive()) {
            case .sessions:
                receivedInventory = true
            case .snapshot:
                receivedSnapshot = true
            default:
                break
            }
        }
        #expect(receivedInventory)
        #expect(receivedSnapshot)

        transport.close()
        do {
            _ = try await transport.receive()
            Issue.record("receive should fail after URLSession transport close")
        } catch HostClientError.transport(let message) {
            #expect(message == "socket not open")
        }
    }

    @Test("HostClient completes inventory, catalog, attach, and snapshot flow")
    func hostClientCompletesFixtureFlow() async throws {
        let fixture = try await WindowsFixtureServer.spawn(scenario: "basic-v1")
        defer { fixture.stop() }

        let transport = WindowsURLSessionHostWireTransport(endpoint: fixture.url)
        let client = HostClient(
            transport: transport,
            config: Self.config(authentication: Self.authentication())
        )
        let recorder = WindowsFixtureFrameRecorder()
        let frames = await client.frames
        let collector = Task {
            for await frame in frames {
                await recorder.record(frame)
            }
        }

        do {
            let welcome = try await client.connect()
            #expect(welcome.hostId == "host-basic")
            #expect(welcome.authentication == .local)
            #expect(!welcome.grantedCapabilities.isEmpty)

            try await waitForWindowsFixture("session inventory") {
                await recorder.latestInventory() != nil
            }
            guard let inventory = await recorder.latestInventory() else {
                throw FixtureAssertionError.expectedInventory
            }
            #expect(inventory.sessions.count == 1)
            #expect(inventory.sessions.first?.sessionId == "session-basic")
            #expect(inventory.sessions.first?.project.projectId == "project-basic")

            let catalog = try await client.sendCommand(
                CommandIntent(
                    hostId: welcome.hostId,
                    command: "catalog.get",
                    args: [:]
                )
            )
            guard case .object(let catalogBody) = catalog.result,
                  case .array(let catalogItems) = catalogBody["items"]
            else {
                throw FixtureAssertionError.expectedCatalogItems
            }
            #expect(catalogItems.count > 0)

            let sessionList = try await client.sendCommand(
                CommandIntent(
                    hostId: welcome.hostId,
                    command: "session.list",
                    args: [:]
                )
            )
            guard case .object(let listBody) = sessionList.result,
                  case .array(let listedSessions) = listBody["sessions"]
            else {
                throw FixtureAssertionError.expectedSessionList
            }
            #expect(listedSessions.count == 1)

            try await waitForWindowsFixture("initial transcript snapshot") {
                await recorder.snapshotCount() > 0
            }
            let snapshotsBeforeAttach = await recorder.snapshotCount()

            let attach = try await client.sendCommand(
                CommandIntent(
                    hostId: welcome.hostId,
                    command: "session.attach",
                    args: [:],
                    sessionId: "session-basic"
                )
            )
            guard case .object(let attachBody) = attach.result,
                  case .bool(let attached) = attachBody["attached"]
            else {
                throw FixtureAssertionError.expectedAttachResult
            }
            #expect(attached)

            try await waitForWindowsFixture("attached transcript snapshot") {
                await recorder.snapshotCount() > snapshotsBeforeAttach
            }
            guard let snapshot = await recorder.latestSnapshot() else {
                throw FixtureAssertionError.expectedSnapshot
            }
            #expect(snapshot.hostId == "host-basic")
            #expect(snapshot.sessionId == "session-basic")
            #expect(snapshot.entries.count == 1)

            await client.close()
            _ = await collector.result
            let state = await client.state
            guard case .closed = state else {
                throw FixtureAssertionError.expectedClosedClient
            }
        } catch {
            await client.close()
            collector.cancel()
            throw error
        }
    }

    @Test("Invalid token is rejected with an error frame")
    func invalidTokenIsRejected() async throws {
        let fixture = try await WindowsFixtureServer.spawn(scenario: "basic-v1")
        defer { fixture.stop() }

        let transport = URLSessionHostWireTransport(endpoint: fixture.url)
        try await transport.open()
        let hello = HelloFrame(
            protocolRange: ProtocolRange(
                min: Wire.protocolVersion,
                max: Wire.protocolVersion
            ),
            client: Self.identity(),
            requestedFeatures: ["resume"],
            savedCursors: [],
            authentication: Self.authentication(token: "bad")
        )
        try await transport.send(JSONEncoder().encode(hello))

        let response = try ServerFrame.decode(await transport.receive())
        guard case .error(let error) = response else {
            transport.close()
            throw FixtureAssertionError.expectedTokenRejection
        }
        #expect(error.code == "INVALID_FRAME")
        #expect(error.message.contains("device token"))
        transport.close()
    }
}

private actor WindowsFixtureFrameRecorder {
    private var inventories: [SessionsFrame] = []
    private var snapshots: [SnapshotFrame] = []

    func record(_ frame: ServerFrame) {
        switch frame {
        case .sessions(let inventory):
            inventories.append(inventory)
        case .snapshot(let snapshot):
            snapshots.append(snapshot)
        default:
            break
        }
    }

    func latestInventory() -> SessionsFrame? {
        inventories.last
    }

    func latestSnapshot() -> SnapshotFrame? {
        snapshots.last
    }

    func snapshotCount() -> Int {
        snapshots.count
    }
}

private enum FixtureAssertionError: Error {
    case expectedWelcome
    case expectedTokenRejection
    case expectedInventory
    case expectedCatalogItems
    case expectedSessionList
    case expectedAttachResult
    case expectedSnapshot
    case expectedClosedClient
}
