import Foundation

/// Host → client: a session transcript snapshot — the full durable entry log at
/// a cursor/revision (host-wire/src/snapshot.ts). Every entry must belong to the
/// frame's session.
public struct SnapshotFrame: Decodable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let cursor: Cursor
    public let revision: Revision
    public let hostId: HostId
    public let sessionId: SessionId
    public let entries: [DurableEntry]

    private enum CodingKeys: String, CodingKey { case v, type, cursor, revision, hostId, sessionId, entries }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(String.self, forKey: .v)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: .type) == "snapshot" else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected snapshot frame")
        }
        v = version; type = "snapshot"
        cursor = try c.decode(Cursor.self, forKey: .cursor)
        revision = try IDs.opaque(try c.decode(String.self, forKey: .revision), path: "revision")
        hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "hostId")
        sessionId = try IDs.opaque(try c.decode(String.self, forKey: .sessionId), path: "sessionId")
        let entryValues = try c.decode([DurableEntry].self, forKey: .entries)
        for (i, entry) in entryValues.enumerated() {
            guard entry.hostId == hostId, entry.sessionId == sessionId else {
                throw T4WireError.invalidFrame(path: "entries[\(i)]", reason: "entry belongs to another session")
            }
        }
        entries = entryValues
    }
}
