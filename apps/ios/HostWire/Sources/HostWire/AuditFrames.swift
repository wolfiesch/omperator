import Foundation

/// Audit frames (host-wire/src/additive.ts audit.* family). The host emits an
/// `audit.tail` batch (the full event log at a cursor) or a streaming
/// `audit.event` frame. Every event must belong to the frame's host.

/// One audit event (additive.ts `AuditEvent`, decoded by `decodeAuditEvent`).
/// `eventId` is an `OperationId`; `action`/`actor`/`timestamp` are bounded
/// control-free strings; `detail` is an opaque object map.
public struct AuditEvent: Decodable, Equatable, Sendable {
    public let eventId: OperationId
    public let hostId: HostId
    public let sessionId: SessionId?
    public let action: String
    public let actor: String
    public let timestamp: String
    public let detail: JSONValue?

    private enum CodingKeys: String, CodingKey { case eventId, hostId, sessionId, action, actor, timestamp, detail }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        eventId = try IDs.opaque(try c.decode(String.self, forKey: .eventId), path: "eventId")
        hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "hostId")
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId).map {
            try IDs.opaque($0, path: "sessionId")
        }
        action = try Bounded.controlFree(try c.decode(String.self, forKey: .action), path: "action", maxBytes: 128)
        actor = try Bounded.controlFree(try c.decode(String.self, forKey: .actor), path: "actor", maxBytes: 256)
        timestamp = try Bounded.controlFree(try c.decode(String.self, forKey: .timestamp), path: "timestamp", maxBytes: 128)
        if let d = try c.decodeIfPresent(JSONValue.self, forKey: .detail) {
            guard case .object = d else { throw T4WireError.invalidFrame(path: "detail", reason: "detail must be an object") }
            detail = d
        } else { detail = nil }
    }
}

/// audit.tail — the full audit event log at a cursor (additive.ts
/// `AuditTailFrame`). Every event must belong to the frame's host.
public struct AuditTailFrame: Decodable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let hostId: HostId
    public let cursor: Cursor
    public let events: [AuditEvent]

    private enum CodingKeys: String, CodingKey { case v, type, hostId, cursor, events }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(String.self, forKey: .v)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: .type) == "audit.tail" else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected audit.tail frame")
        }
        v = version; type = "audit.tail"
        hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "hostId")
        cursor = try c.decode(Cursor.self, forKey: .cursor)
        let eventValues = try c.decode([AuditEvent].self, forKey: .events)
        for (i, event) in eventValues.enumerated() {
            guard event.hostId == hostId else {
                throw T4WireError.invalidFrame(path: "events[\(i)]", reason: "audit event belongs to another host")
            }
        }
        events = eventValues
    }
}

/// audit.event — a single streaming audit event at a cursor (additive.ts
/// `AuditEventFrame`). The event must belong to the frame's host.
public struct AuditEventFrame: Decodable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let hostId: HostId
    public let event: AuditEvent
    public let cursor: Cursor

    private enum CodingKeys: String, CodingKey { case v, type, hostId, event, cursor }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(String.self, forKey: .v)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: .type) == "audit.event" else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected audit.event frame")
        }
        v = version; type = "audit.event"
        hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "hostId")
        let eventValue = try c.decode(AuditEvent.self, forKey: .event)
        guard eventValue.hostId == hostId else {
            throw T4WireError.invalidFrame(path: "event.hostId", reason: "audit event belongs to another host")
        }
        event = eventValue
        cursor = try c.decode(Cursor.self, forKey: .cursor)
    }
}
