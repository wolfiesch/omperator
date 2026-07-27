import Foundation

/// Watch + lease frame families (host-wire/src/additive.ts lines ~123-257).
/// `host.watch` / `session.watch` / `session.state` / `session.delta` advance a
/// session/host cursor and carry a `revision`; `lease` / `prompt.lease` report
/// the lifecycle of a controller/prompt lease against a session.

/// `host.watch` / `session.watch` state (additive.ts `known(state, ...)`).
public enum WatchState: String, Codable, Equatable, Sendable {
    case started, stopped, ready
}

/// `LeaseState` (additive.ts): the lifecycle phase of a lease.
public enum LeaseState: String, Codable, Equatable, Sendable {
    case acquired, renewed, released, expired
}

/// host.watch — a host-level watch has started/stopped/become ready at a cursor.
public struct HostWatchFrame: Decodable, Equatable, Sendable {
    public let v: String, type: String, watchId: WatchId, hostId: HostId
    public let cursor: Cursor, state: WatchState, revision: Revision

    private enum CodingKeys: String, CodingKey { case v, type, watchId, hostId, cursor, state, revision }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try WatchLeases.check(c, type: "host.watch")
        v = Wire.protocolVersion; type = "host.watch"
        watchId = try IDs.opaque(try c.decode(String.self, forKey: .watchId), path: "watchId")
        hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "hostId")
        cursor = try c.decode(Cursor.self, forKey: .cursor)
        state = try c.decode(WatchState.self, forKey: .state)
        revision = try IDs.opaque(try c.decode(String.self, forKey: .revision), path: "revision")
    }
}

/// session.watch — a session-level watch has started/stopped/become ready.
public struct SessionWatchFrame: Decodable, Equatable, Sendable {
    public let v: String, type: String, watchId: WatchId, hostId: HostId, sessionId: SessionId
    public let cursor: Cursor, state: WatchState, revision: Revision

    private enum CodingKeys: String, CodingKey { case v, type, watchId, hostId, sessionId, cursor, state, revision }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try WatchLeases.check(c, type: "session.watch")
        v = Wire.protocolVersion; type = "session.watch"
        watchId = try IDs.opaque(try c.decode(String.self, forKey: .watchId), path: "watchId")
        let ids = try WatchLeases.Ids(from: decoder)
        hostId = ids.hostId; sessionId = ids.sessionId
        cursor = try c.decode(Cursor.self, forKey: .cursor)
        state = try c.decode(WatchState.self, forKey: .state)
        revision = try IDs.opaque(try c.decode(String.self, forKey: .revision), path: "revision")
    }
}

/// session.state — a session's state string at a cursor/revision.
public struct SessionStateFrame: Decodable, Equatable, Sendable {
    public let v: String, type: String, hostId: HostId, sessionId: SessionId
    public let cursor: Cursor, revision: Revision, state: String

    private enum CodingKeys: String, CodingKey { case v, type, hostId, sessionId, cursor, revision, state }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try WatchLeases.check(c, type: "session.state")
        v = Wire.protocolVersion; type = "session.state"
        let ids = try WatchLeases.Ids(from: decoder)
        hostId = ids.hostId; sessionId = ids.sessionId
        cursor = try c.decode(Cursor.self, forKey: .cursor)
        revision = try IDs.opaque(try c.decode(String.self, forKey: .revision), path: "revision")
        state = try Bounded.controlFree(try c.decode(String.self, forKey: .state), path: "state", maxBytes: 128)
    }
}

/// session.delta — an upsert or remove of a session at a cursor/revision.
/// Exactly one of `upsert` / `remove` must be present; an upsert must belong to
/// the framing (hostId, sessionId) and a remove must equal the framing sessionId.
public struct SessionDeltaFrame: Decodable, Equatable, Sendable {
    public let v: String, type: String, hostId: HostId, sessionId: SessionId
    public let cursor: Cursor, revision: Revision
    public let upsert: SessionRef?
    public let remove: SessionId?

    private enum CodingKeys: String, CodingKey { case v, type, hostId, sessionId, cursor, revision, upsert, remove }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try WatchLeases.check(c, type: "session.delta")
        v = Wire.protocolVersion; type = "session.delta"
        let ids = try WatchLeases.Ids(from: decoder)
        hostId = ids.hostId; sessionId = ids.sessionId
        cursor = try c.decode(Cursor.self, forKey: .cursor)
        revision = try IDs.opaque(try c.decode(String.self, forKey: .revision), path: "revision")
        upsert = try c.decodeIfPresent(SessionRef.self, forKey: .upsert)
        remove = try c.decodeIfPresent(String.self, forKey: .remove).map { try IDs.opaque($0, path: "remove") }
        if upsert == nil && remove == nil {
            throw T4WireError.invalidFrame(path: "delta", reason: "session delta requires upsert or remove")
        }
        if upsert != nil && remove != nil {
            throw T4WireError.invalidFrame(path: "delta", reason: "session delta cannot upsert and remove")
        }
        if let u = upsert {
            if u.hostId != ids.hostId || u.sessionId != ids.sessionId {
                throw T4WireError.invalidFrame(path: "upsert", reason: "upsert belongs to another session")
            }
        }
        if let r = remove, r != ids.sessionId {
            throw T4WireError.invalidFrame(path: "remove", reason: "remove belongs to another session")
        }
    }
}

/// lease — a controller lease lifecycle event against a session.
public struct LeaseFrame: Decodable, Equatable, Sendable {
    public let v: String, type: String, hostId: HostId, sessionId: SessionId, leaseId: LeaseId
    public let cursor: Cursor, kind: String, state: LeaseState, owner: DeviceId, expiresAt: String
    public let revision: Revision?

    private enum CodingKeys: String, CodingKey {
        case v, type, hostId, sessionId, leaseId, cursor, kind, state, owner, expiresAt, revision
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try WatchLeases.check(c, type: "lease")
        v = Wire.protocolVersion; type = "lease"
        let ids = try WatchLeases.Ids(from: decoder)
        hostId = ids.hostId; sessionId = ids.sessionId
        leaseId = try IDs.opaque(try c.decode(String.self, forKey: .leaseId), path: "leaseId")
        cursor = try c.decode(Cursor.self, forKey: .cursor)
        let k = try c.decode(String.self, forKey: .kind)
        guard k == "controller" else {
            throw T4WireError.invalidFrame(path: "kind", reason: "lease kind does not match type")
        }
        kind = k
        state = try c.decode(LeaseState.self, forKey: .state)
        owner = try IDs.opaque(try c.decode(String.self, forKey: .owner), path: "owner")
        expiresAt = try Bounded.controlFree(try c.decode(String.self, forKey: .expiresAt), path: "expiresAt", maxBytes: 128)
        revision = try c.decodeIfPresent(String.self, forKey: .revision).map { try IDs.opaque($0, path: "revision") }
    }
}

/// prompt.lease — a prompt lease lifecycle event; `kind` is always "prompt".
public struct PromptLeaseFrame: Decodable, Equatable, Sendable {
    public let v: String, type: String, hostId: HostId, sessionId: SessionId, leaseId: LeaseId
    public let cursor: Cursor, kind: String, state: LeaseState, owner: DeviceId, expiresAt: String
    public let revision: Revision?

    private enum CodingKeys: String, CodingKey {
        case v, type, hostId, sessionId, leaseId, cursor, kind, state, owner, expiresAt, revision
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try WatchLeases.check(c, type: "prompt.lease")
        v = Wire.protocolVersion; type = "prompt.lease"
        let ids = try WatchLeases.Ids(from: decoder)
        hostId = ids.hostId; sessionId = ids.sessionId
        leaseId = try IDs.opaque(try c.decode(String.self, forKey: .leaseId), path: "leaseId")
        cursor = try c.decode(Cursor.self, forKey: .cursor)
        let k = try c.decode(String.self, forKey: .kind)
        guard k == "prompt" else {
            throw T4WireError.invalidFrame(path: "kind", reason: "lease kind does not match type")
        }
        kind = k
        state = try c.decode(LeaseState.self, forKey: .state)
        owner = try IDs.opaque(try c.decode(String.self, forKey: .owner), path: "owner")
        expiresAt = try Bounded.controlFree(try c.decode(String.self, forKey: .expiresAt), path: "expiresAt", maxBytes: 128)
        revision = try c.decodeIfPresent(String.self, forKey: .revision).map { try IDs.opaque($0, path: "revision") }
    }
}

/// Helpers mirroring host-wire/src/additive.ts `frame` / `own` for the watch +
/// lease families.
enum WatchLeases {
    /// Shared `v` + `type` guard (additive.ts `frame(input, expected)`).
    static func check<K: CodingKey>(_ c: KeyedDecodingContainer<K>, type expected: String) throws {
        let version = try c.decode(String.self, forKey: K(stringValue: "v")!)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: K(stringValue: "type")!) == expected else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected \(expected) frame")
        }
    }

    /// Shared (hostId, sessionId) locator (additive.ts `own(x)`).
    struct Ids: Decodable {
        let hostId: HostId
        let sessionId: SessionId
        private enum CodingKeys: String, CodingKey { case hostId, sessionId }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "hostId")
            sessionId = try IDs.opaque(try c.decode(String.self, forKey: .sessionId), path: "sessionId")
        }
    }
}
