import Foundation

/// Agent frames (host-wire/src/agents.ts + additive.ts agent.* family).
/// `AgentFrame` (type "agent") is a snapshot; the `agent.*` additive frames are
/// the streaming lifecycle/progress/event/transcript updates that feed T4's
/// Agent View.

public enum AgentLifecycle: String, Codable, Equatable, Sendable {
    case created, started, running, completed, failed, cancelled
}

/// Snapshot of one subagent's state (agents.ts, type "agent").
public struct AgentFrame: Decodable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let hostId: HostId
    public let sessionId: SessionId
    public let agentId: AgentId
    public let state: String
    public let progress: Double?
    public let detail: JSONValue?

    private enum CodingKeys: String, CodingKey { case v, type, hostId, sessionId, agentId, state, progress, detail }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(String.self, forKey: .v)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: .type) == "agent" else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected agent frame")
        }
        v = version; type = "agent"
        hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "hostId")
        sessionId = try IDs.opaque(try c.decode(String.self, forKey: .sessionId), path: "sessionId")
        agentId = try IDs.opaque(try c.decode(String.self, forKey: .agentId), path: "agentId")
        state = try Bounded.controlFree(try c.decode(String.self, forKey: .state), path: "state", maxBytes: 64)
        if let p = try c.decodeIfPresent(Double.self, forKey: .progress) {
            guard p.isFinite, (0...1).contains(p) else {
                throw T4WireError.bounds(path: "progress", reason: "progress must be between zero and one")
            }
            progress = p
        } else { progress = nil }
        if let d = try c.decodeIfPresent(JSONValue.self, forKey: .detail) {
            guard case .object = d else { throw T4WireError.invalidFrame(path: "detail", reason: "detail must be an object") }
            detail = d
        } else { detail = nil }
    }
}

/// Shared header for the agent.* additive frames.
private struct AgentHeader: Decodable {
    let hostId: HostId
    let sessionId: SessionId
    let agentId: AgentId
    let cursor: Cursor
    let revision: Revision
}

/// agent.state — current lifecycle state at a cursor.
public struct AgentStateFrame: Decodable, Equatable, Sendable {
    public let v: String, type: String, hostId: HostId, sessionId: SessionId, agentId: AgentId
    public let cursor: Cursor, state: AgentLifecycle, revision: Revision
    private enum CodingKeys: String, CodingKey { case v, type, hostId, sessionId, agentId, cursor, state, revision }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try Agents.check(c, type: "agent.state")
        v = Wire.protocolVersion; type = "agent.state"
        let h = try AgentHeader(from: decoder)
        hostId = h.hostId; sessionId = h.sessionId; agentId = h.agentId; cursor = h.cursor; revision = h.revision
        state = try c.decode(AgentLifecycle.self, forKey: .state)
    }
}

/// agent.lifecycle — a lifecycle transition.
public struct AgentLifecycleFrame: Decodable, Equatable, Sendable {
    public let v: String, type: String, hostId: HostId, sessionId: SessionId, agentId: AgentId
    public let cursor: Cursor, lifecycle: AgentLifecycle, revision: Revision
    private enum CodingKeys: String, CodingKey { case v, type, hostId, sessionId, agentId, cursor, lifecycle, revision }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try Agents.check(c, type: "agent.lifecycle")
        v = Wire.protocolVersion; type = "agent.lifecycle"
        let h = try AgentHeader(from: decoder)
        hostId = h.hostId; sessionId = h.sessionId; agentId = h.agentId; cursor = h.cursor; revision = h.revision
        lifecycle = try c.decode(AgentLifecycle.self, forKey: .lifecycle)
    }
}

/// agent.progress — bounded 0..1 progress with optional detail.
public struct AgentProgressFrame: Decodable, Equatable, Sendable {
    public let v: String, type: String, hostId: HostId, sessionId: SessionId, agentId: AgentId
    public let cursor: Cursor, progress: Double, revision: Revision
    public let detail: JSONValue?
    private enum CodingKeys: String, CodingKey { case v, type, hostId, sessionId, agentId, cursor, progress, revision, detail }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try Agents.check(c, type: "agent.progress")
        v = Wire.protocolVersion; type = "agent.progress"
        let h = try AgentHeader(from: decoder)
        hostId = h.hostId; sessionId = h.sessionId; agentId = h.agentId; cursor = h.cursor; revision = h.revision
        let p = try c.decode(Double.self, forKey: .progress)
        guard p.isFinite, (0...1).contains(p) else {
            throw T4WireError.bounds(path: "progress", reason: "progress must be between zero and one")
        }
        progress = p
        if let d = try c.decodeIfPresent(JSONValue.self, forKey: .detail) {
            guard case .object = d else { throw T4WireError.invalidFrame(path: "detail", reason: "detail must be an object") }
            detail = d
        } else { detail = nil }
    }
}

/// agent.event — a named event with optional data.
public struct AgentEventFrame: Decodable, Equatable, Sendable {
    public let v: String, type: String, hostId: HostId, sessionId: SessionId, agentId: AgentId
    public let cursor: Cursor, event: String, revision: Revision
    public let data: JSONValue?
    private enum CodingKeys: String, CodingKey { case v, type, hostId, sessionId, agentId, cursor, event, revision, data }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try Agents.check(c, type: "agent.event")
        v = Wire.protocolVersion; type = "agent.event"
        let h = try AgentHeader(from: decoder)
        hostId = h.hostId; sessionId = h.sessionId; agentId = h.agentId; cursor = h.cursor; revision = h.revision
        event = try Bounded.controlFree(try c.decode(String.self, forKey: .event), path: "event", maxBytes: 128)
        if let d = try c.decodeIfPresent(JSONValue.self, forKey: .data) {
            guard case .object = d else { throw T4WireError.invalidFrame(path: "data", reason: "data must be an object") }
            data = d
        } else { data = nil }
    }
}

/// agent.transcript — a batch of durable entries for an agent.
public struct AgentTranscriptFrame: Decodable, Equatable, Sendable {
    public let v: String, type: String, hostId: HostId, sessionId: SessionId, agentId: AgentId
    public let cursor: Cursor, entries: [DurableEntry], revision: Revision
    private enum CodingKeys: String, CodingKey { case v, type, hostId, sessionId, agentId, cursor, entries, revision }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try Agents.check(c, type: "agent.transcript")
        v = Wire.protocolVersion; type = "agent.transcript"
        let h = try AgentHeader(from: decoder)
        hostId = h.hostId; sessionId = h.sessionId; agentId = h.agentId; cursor = h.cursor; revision = h.revision
        let entryValues = try c.decode([DurableEntry].self, forKey: .entries)
        for (i, entry) in entryValues.enumerated() {
            guard entry.hostId == hostId, entry.sessionId == sessionId else {
                throw T4WireError.invalidFrame(path: "entries[\(i)]", reason: "transcript entry belongs to another session")
            }
        }
        entries = entryValues
    }
}

enum Agents {
    static func check<K: CodingKey>(_ c: KeyedDecodingContainer<K>, type expected: String) throws {
        let version = try c.decode(String.self, forKey: K(stringValue: "v")!)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: K(stringValue: "type")!) == expected else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected \(expected) frame")
        }
    }
}
