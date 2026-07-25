import Foundation

/// Host → client: an unrecoverable gap in a session's append log
/// (host-wire/src/gap.ts). `from`/`to` share an epoch and `to.seq >= from.seq`.
public struct GapFrame: Decodable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let hostId: HostId
    public let sessionId: SessionId
    public let from: Cursor
    public let to: Cursor
    public let reason: String

    private enum CodingKeys: String, CodingKey { case v, type, hostId, sessionId, from, to, reason }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(String.self, forKey: .v)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: .type) == "gap" else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected gap frame")
        }
        v = version; type = "gap"
        hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "hostId")
        sessionId = try IDs.opaque(try c.decode(String.self, forKey: .sessionId), path: "sessionId")
        // Cursors carry their own path prefix via Cursor.init(from:); validate the
        // gap-specific range invariant here.
        let fromCursor = try c.decode(Cursor.self, forKey: .from)
        let toCursor = try c.decode(Cursor.self, forKey: .to)
        guard fromCursor.epoch == toCursor.epoch, toCursor.seq >= fromCursor.seq else {
            throw T4WireError.invalidFrame(path: "to", reason: "gap cursor range is invalid")
        }
        from = fromCursor
        to = toCursor
        reason = try Bounded.controlFree(try c.decode(String.self, forKey: .reason), path: "reason", maxBytes: 256)
    }
}
