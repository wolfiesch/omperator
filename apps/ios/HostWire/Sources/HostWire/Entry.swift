import Foundation

/// A durable transcript entry (host-wire/src/entry.ts).
///
/// Core identity fields are typed and validated; `data` is carried as an opaque
/// object until the per-kind transcript decoders (additive.ts) are ported —
/// that is what turns `data` into typed message/tool/review rows for the UI.
public struct DurableEntry: Decodable, Equatable, Sendable {
    public let id: EntryId
    public let parentId: String?
    public let hostId: HostId
    public let sessionId: SessionId
    public let turnId: TurnId?
    public let kind: String
    public let timestamp: String
    public let data: JSONValue

    private enum CodingKeys: String, CodingKey {
        case id, parentId, hostId, sessionId, turnId, kind, timestamp, data
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try IDs.opaque(try c.decode(String.self, forKey: .id), path: "entry.id")
        parentId = try c.decodeIfPresent(String.self, forKey: .parentId).map { try IDs.opaque($0, path: "entry.parentId") }
        hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "entry.hostId")
        sessionId = try IDs.opaque(try c.decode(String.self, forKey: .sessionId), path: "entry.sessionId")
        turnId = try c.decodeIfPresent(String.self, forKey: .turnId).map { try IDs.opaque($0, path: "entry.turnId") }
        kind = try Bounded.controlFree(try c.decode(String.self, forKey: .kind), path: "entry.kind", maxBytes: 128)
        timestamp = try Bounded.controlFree(try c.decode(String.self, forKey: .timestamp), path: "entry.timestamp", maxBytes: 128)
        let dataValue = try c.decode(JSONValue.self, forKey: .data)
        guard case .object = dataValue else {
            throw T4WireError.invalidFrame(path: "entry.data", reason: "entry data must be an object")
        }
        data = dataValue
    }
}

/// Host → client: one durable entry appended to a session log (envelope "entry").
public struct DurableEntryFrame: Decodable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let cursor: Cursor
    public let revision: Revision
    public let hostId: HostId
    public let sessionId: SessionId
    public let entry: DurableEntry

    private enum CodingKeys: String, CodingKey { case v, type, cursor, revision, hostId, sessionId, entry }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(String.self, forKey: .v)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: .type) == "entry" else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected durable entry frame")
        }
        v = version; type = "entry"
        cursor = try c.decode(Cursor.self, forKey: .cursor)
        revision = try IDs.opaque(try c.decode(String.self, forKey: .revision), path: "revision")
        hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "hostId")
        sessionId = try IDs.opaque(try c.decode(String.self, forKey: .sessionId), path: "sessionId")
        entry = try c.decode(DurableEntry.self, forKey: .entry)
        guard entry.hostId == hostId, entry.sessionId == sessionId else {
            throw T4WireError.invalidFrame(path: "entry", reason: "entry belongs to another session")
        }
    }
}

// MARK: - Artifact descriptor

/// One session-retained artifact descriptor (host-wire/src/entry.ts
/// `ArtifactDescriptor`), carried on a durable entry's `data.artifacts` list.
/// `artifactId` is a numeric opaque id; `kind` is image/text/patch/binary;
/// `disposition` is inline/attachment; `retention` is always "session".
/// `size`/`sha256`/`name` are optional. Built from an opaque `JSONValue`
/// object (already validated by the host on ingest); unknown keys are
/// tolerated on the client to stay forward-compatible.
public struct ArtifactDescriptor: Equatable, Sendable {
    public let artifactId: ArtifactId
    public let kind: String
    public let mediaType: String
    public let size: Int?
    public let sha256: String?
    public let name: String?
    public let disposition: String

    /// Best-effort build from an opaque object. Returns nil if the required
    /// fields (artifactId, kind, mediaType, disposition) are missing or not
    /// strings. The host validates these on ingest, so a nil here means the
    /// client received a shape it doesn't recognize — skip it rather than
    /// crash.
    public init?(from value: JSONValue) {
        guard case .object(let obj) = value,
              case .string(let aid) = obj["artifactId"] ?? .null,
              case .string(let k) = obj["kind"] ?? .null,
              case .string(let mt) = obj["mediaType"] ?? .null,
              case .string(let disp) = obj["disposition"] ?? .null
        else { return nil }
        artifactId = aid
        kind = k
        mediaType = mt
        disposition = disp
        if case .number(let n) = obj["size"] ?? .null { size = Int(n) } else { size = nil }
        if case .string(let s) = obj["sha256"] ?? .null { sha256 = s } else { sha256 = nil }
        if case .string(let nm) = obj["name"] ?? .null { name = nm } else { name = nil }
    }
}
