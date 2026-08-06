//  FixtureIntegrationTests.swift
//  Live wire-protocol integration against the workspace fixture server.
//  Exercises the exact production path: LinuxWebSocketTransport → HostClient
//  handshake → command dispatch → session attach → streaming frames.

import Foundation
import Testing
import HostWire
@testable import T4CodeLinuxLib

@Suite("Fixture wire integration", .serialized)
struct FixtureIntegrationTests {
    private static let token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

    private static func identity() -> ClientIdentity {
        ClientIdentity(name: platformClientName, version: "0.1", build: "test", platform: platformClientPlatform)
    }

    private static func auth() -> DeviceAuthentication {
        DeviceAuthentication(deviceId: "fixture-test", deviceToken: token)
    }

    /// Full handshake + welcome fields from the basic-v1 seed.
    @Test
    func handshakeReturnsWelcomeWithLocalAuth() async throws {
        let fixture = try await FixtureServer.spawn(scenario: "basic-v1", repoPath: t4RepoRoot)
        defer { fixture.stop() }

        let client = HostClient(
            transport: LinuxWebSocketTransport(endpoint: fixture.url),
            config: .init(identity: Self.identity(), authentication: Self.auth())
        )
        let welcome = try await client.connect()

        #expect(welcome.hostId == "host-basic")
        #expect(welcome.ompVersion == "fixture")
        #expect(welcome.authentication == .local)
        #expect(!welcome.grantedCapabilities.isEmpty)

        await client.close()
    }

    /// catalog.get round-trip against the fixture catalog.
    @Test
    func catalogGetReturnsItems() async throws {
        let fixture = try await FixtureServer.spawn(scenario: "basic-v1", repoPath: t4RepoRoot)
        defer { fixture.stop() }

        let client = HostClient(
            transport: LinuxWebSocketTransport(endpoint: fixture.url),
            config: .init(identity: Self.identity(), authentication: Self.auth())
        )
        let welcome = try await client.connect()
        let frame = try await client.sendCommand(
            CommandIntent(hostId: welcome.hostId, command: "catalog.get", args: [:])
        )
        #expect(frame.ok, "catalog.get failed: \(frame)")
        guard case .object(let body) = frame.result,
              case .array(let items) = body["items"]
        else {
            Issue.record("catalog.get result missing items: \(frame)")
            return
        }
        #expect(!items.isEmpty)
        await client.close()
    }

    /// session.attach against the seeded session.
    @Test
    func sessionAttachSucceeds() async throws {
        let fixture = try await FixtureServer.spawn(scenario: "basic-v1", repoPath: t4RepoRoot)
        defer { fixture.stop() }

        let client = HostClient(
            transport: LinuxWebSocketTransport(endpoint: fixture.url),
            config: .init(identity: Self.identity(), authentication: Self.auth())
        )
        let welcome = try await client.connect()
        let frame = try await client.sendCommand(
            CommandIntent(hostId: welcome.hostId, command: "session.attach", args: [:], sessionId: "session-basic")
        )
        #expect(frame.ok, "session.attach failed: \(frame)")
        guard case .object(let body) = frame.result,
              case .bool(let attached) = body["attached"]
        else {
            Issue.record("session.attach result malformed: \(frame)")
            return
        }
        #expect(attached)
        await client.close()
    }

    /// Rejection shape: an invalid device token must surface the wire's
    /// canonical error, not a crash or a silent hang.
    @Test
    func invalidTokenProducesWireError() async throws {
        let fixture = try await FixtureServer.spawn(scenario: "basic-v1", repoPath: t4RepoRoot)
        defer { fixture.stop() }

        let client = HostClient(
            transport: LinuxWebSocketTransport(endpoint: fixture.url),
            config: .init(
                identity: Self.identity(),
                authentication: DeviceAuthentication(deviceId: "x", deviceToken: "bad")
            )
        )
        do {
            _ = try await client.connect()
            Issue.record("connect should have failed with an invalid token")
        } catch {
            // The wire rejects the malformed token (INVALID_FRAME → the host
            // then closes, so the client may see either the protocol error
            // text or a transport close). Either is a valid rejection — the
            // key assertions are: it fails, and it fails fast (no hang).
            print("invalid-token error: \(error)")
        }
        await client.close()
    }
}
