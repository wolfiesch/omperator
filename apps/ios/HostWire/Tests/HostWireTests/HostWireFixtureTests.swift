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
        let frame = try #require(try ClientFrame.decode(original).hello)
        let reencoded = try encodeFrame(frame)
        let again = try ClientFrame.decode(reencoded)
        #expect(again == .hello(frame))
    }

    @Test("Deep links parse and reject")
    func deepLinks() {
        #expect(Pairing.parseDeepLink("t4-code://pair/studio-mac/123456", issuedAtMs: 1)?.code == "123456")
        #expect(Pairing.parseDeepLink("t4-code://pair/studio-mac/123456", issuedAtMs: 1)?.hostHint == "studio-mac")
        // wrong scheme, extra query, bad code length, bad hint char
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
}
