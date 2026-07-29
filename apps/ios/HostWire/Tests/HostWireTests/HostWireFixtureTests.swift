import Testing
import Foundation
@testable import HostWire

/// Decodes the real wire fixtures from packages/host-wire/fixtures/v1 (copied
/// into this test target). Valid fixtures must decode; the `.invalid` ones must
/// throw. Only the frame types ported so far are exercised; the rest will be
/// covered as the port progresses.
struct HostWireFixtureTests {
    /// fixture basename → is it a client (true) or server (false) frame.
    private static let ported: [String: Bool] = [
        "hello": true,
        "hello-auth": true,
        "ping": true,
        "response": false,
        "event": false,
        "pong": false,
        "bye": false,
        "sessions": false,
        "sessions-cluster": false,
        "snapshot": false,
        "entry-frame": false,
        "gap": false,
        "agent": false,
        "agent-progress": false,
        "terminal-output": false,
        "files-diff": false,
        "audit-event": false,
        "catalog": false,
        "review": false,
        "preview-capture": false,
        "prompt-lease": false,
        "session-delta": false,
        "host-watch": false,
        "terminal": false,
        "audit": false,
        "files": false,
    ]

    private static let invalid: Set<String> = [
        "hello-auth-bad.invalid",
        "hello-auth-partial.invalid",
    ]

    private func data(for basename: String) throws -> Data {
        let url = try #require(Bundle.module.url(forResource: basename, withExtension: "json", subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }

    @Test("Valid fixtures decode through the frame dispatcher")
    func validFixturesDecode() throws {
        for (name, isClient) in Self.ported {
            let bytes = try data(for: name)
            #expect(throws: Never.self) {
                if isClient { _ = try ClientFrame.decode(bytes) } else { _ = try ServerFrame.decode(bytes) }
            }
        }
    }

    @Test("Invalid fixtures are rejected")
    func invalidFixturesThrow() throws {
        for name in Self.invalid {
            let bytes = try data(for: name)
            #expect(throws: (any Error).self) {
                _ = try ClientFrame.decode(bytes)
            }
        }
    }

    @Test("Hello round-trips through encode")
    func helloRoundTrip() throws {
        let original = try data(for: "hello")
        let first = try ClientFrame.decode(original)
        guard case .hello(let frame) = first else {
            Issue.record("expected hello frame")
            return
        }
        let reencoded = try encodeFrame(frame)
        let again = try ClientFrame.decode(reencoded)
        #expect(again == .hello(frame))
    }

    @Test("Deep links parse and reject")
    func deepLinks() {
        let payload: [String: Any] = [
            "version": 1,
            "hostHint": "studio-mac",
            "endpoint": "wss://studio-mac:9443/v1/ws",
            "tlsFingerprint": String(repeating: "a", count: 64),
            "code": "123456",
        ]
        let data = try! JSONSerialization.data(withJSONObject: payload)
        let encoded = data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let link = "t4-code://pair/\(encoded)"
        let parsed = Pairing.parseDeepLink(link, issuedAtMs: 1)
        #expect(parsed?.code == "123456")
        #expect(parsed?.hostHint == "studio-mac")
        #expect(parsed?.endpoint == "wss://studio-mac:9443/v1/ws")
        // wrong scheme, legacy incomplete payload, and extra query
        #expect(Pairing.parseDeepLink("https://pair/studio-mac/123456", issuedAtMs: 1) == nil)
        #expect(Pairing.parseDeepLink("t4-code://pair/studio-mac/123456?x=1", issuedAtMs: 1) == nil)
        #expect(Pairing.parseDeepLink("t4-code://pair/studio-mac/12345", issuedAtMs: 1) == nil)
        #expect(Pairing.parseDeepLink("t4-code://pair/stud!o-mac/123456", issuedAtMs: 1) == nil)
    }

    @Test("Device token format is enforced")
    func deviceTokenFormat() throws {
        // 42 base64url chars + one residue char = valid.
        let good = String(repeating: "A", count: 42) + "Q"
        #expect(throws: Never.self) { try Bounded.deviceToken(good, path: "deviceToken") }
        // wrong length
        #expect(throws: T4WireError.self) { try Bounded.deviceToken("short", path: "deviceToken") }
        // bad residue char
        let badResidue = String(repeating: "A", count: 42) + "B"
        #expect(throws: T4WireError.self) { try Bounded.deviceToken(badResidue, path: "deviceToken") }
    }
    @Test("Session inventory decodes; command envelope round-trips and validates")
    func sessionsAndCommand() throws {
        let frame = try ServerFrame.decode(try data(for: "sessions"))
        guard case .sessions(let inv) = frame else { Issue.record("expected sessions frame"); return }
        #expect(inv.sessions.count >= 1)
        #expect(inv.sessions.first?.project.name == "One")
        #expect(inv.totalCount == inv.sessions.count)
        #expect(inv.truncated == false)
        #expect(inv.sessions.first?.sessionControl == .observer(lockStatus: .live, transcript: .live))
        #expect(inv.sessions.dropFirst().first?.sessionControl == .reconciling(transcript: .snapshot))

        let cluster = try ServerFrame.decode(try data(for: "sessions-cluster"))
        guard case .sessions(let c) = cluster else { Issue.record("expected sessions frame"); return }
        #expect(c.sessions.first?.hostId.hasPrefix("cluster:") ?? false)

        // A host-scoped command encodes and round-trips.
        let cmd = try CommandFrame(requestId: "req-1", commandId: "cmd-1", hostId: "host-a", command: "session.list")
        guard case .command(let back) = try ClientFrame.decode(try encodeFrame(cmd)) else { Issue.record("expected command"); return }
        #expect(back.command == "session.list")
        #expect(back.sessionId == nil)

        // A session-scoped command requires sessionId at construction.
        #expect(throws: T4WireError.self) {
            _ = try CommandFrame(requestId: "r", commandId: "c", hostId: "h", command: "session.prompt")
        }
        // A revision-required command needs expectedRevision.
        #expect(throws: T4WireError.self) {
            _ = try CommandFrame(requestId: "r", commandId: "c", hostId: "h", command: "session.rename", sessionId: "s")
        }
        #expect(Commands.descriptor(for: "session.delete")?.confirmation == .challenge)
        #expect(Commands.descriptor(for: "term.open")?.confirmation == .challenge)
        #expect(Commands.descriptor(for: "preview.launch")?.confirmation == .challenge)
    }

    @Test("Unknown session ownership shapes stay read-only")
    func unknownSessionControl() throws {
        let data = Data("""
        {"hostId":"h","sessionId":"s","project":{"projectId":"p"},"revision":"r",\
        "title":"Legacy","status":"idle","updatedAt":"2026-07-27T00:00:00.000Z",\
        "liveState":{"sessionControl":{"mode":"future","owner":"other"}}}
        """.utf8)
        let session = try JSONDecoder().decode(SessionRef.self, from: data)
        #expect(session.sessionControl == .unknown)
        #expect(session.sessionControl != nil)
    }

    @Test("Snapshot, entry, and gap frames decode; durable entry decodes standalone")
    func transcriptFrames() throws {
        // Snapshot, durable-entry, and gap server frames.
        for name in ["snapshot", "entry-frame", "gap"] {
            #expect(throws: Never.self) { _ = try ServerFrame.decode(try data(for: name)) }
        }
        // A bare durable entry (the body of an entry frame, no envelope wrapper).
        let entry = try JSONDecoder().decode(DurableEntry.self, from: try data(for: "entry"))
        #expect(entry.kind == "tool-result")
    }
}
