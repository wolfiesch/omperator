import Foundation

/// Authoritative session inventory (host-wire/src/session-index.ts).
///
/// `SessionRef` types the fields the session rail reads directly. The deeply
/// nested optional sub-states — `liveState` (session control / provider
/// transport / cluster / ci), `attention`, and `runtime` — are carried as
/// opaque `JSONValue` until their typed decoders are ported. Everything needed
/// to render and group the rail (host, session, project, revision, title,
/// status, activity flags, model, context usage) is typed and validated here.

public struct ProjectIdentity: Decodable, Equatable, Sendable {
    public let projectId: ProjectId
    public let name: String?

    private enum CodingKeys: String, CodingKey { case projectId, name }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        projectId = try IDs.opaque(try c.decode(String.self, forKey: .projectId), path: "project.projectId")
        name = try c.decodeIfPresent(String.self, forKey: .name).map { try Bounded.controlFree($0, path: "project.name", maxBytes: 256) }
    }
}

public struct ContextUsage: Decodable, Equatable, Sendable {
    public let used: Int
    public let limit: Int

    private enum CodingKeys: String, CodingKey { case used, limit }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        used = try c.decode(Int.self, forKey: .used)
        limit = try c.decode(Int.self, forKey: .limit)
        guard used >= 0, limit >= 0, used <= limit else {
            throw T4WireError.bounds(path: "contextUsage", reason: "invalid context usage")
        }
    }
}

public struct SessionRef: Decodable, Equatable, Sendable {
    public let hostId: HostId
    public let sessionId: SessionId
    public let project: ProjectIdentity
    public let revision: Revision
    public let title: String
    public let status: String
    public let updatedAt: String
    public let archivedAt: String?
    public let liveState: JSONValue?
    public let model: String?
    public let thinking: String?
    public let pendingApproval: Bool?
    public let pendingUserInput: Bool?
    public let proposedPlan: String?
    public let contextUsage: ContextUsage?
    public let attention: JSONValue?
    public let runtime: JSONValue?
    public let proposedPlan: String?
    public let mode: String?
    private enum CodingKeys: String, CodingKey {
        case hostId, sessionId, project, revision, title, status, updatedAt, archivedAt
        case liveState, model, thinking, pendingApproval, pendingUserInput, proposedPlan
        case contextUsage, attention, runtime, mode
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "hostId")
        sessionId = try IDs.opaque(try c.decode(String.self, forKey: .sessionId), path: "sessionId")
        project = try c.decode(ProjectIdentity.self, forKey: .project)
        revision = try IDs.opaque(try c.decode(String.self, forKey: .revision), path: "revision")
        title = try Bounded.controlFree(try c.decode(String.self, forKey: .title), path: "title", maxBytes: 512)
        status = try Bounded.controlFree(try c.decode(String.self, forKey: .status), path: "status", maxBytes: 64)
        updatedAt = try Bounded.controlFree(try c.decode(String.self, forKey: .updatedAt), path: "updatedAt", maxBytes: 128)
        // archivedAt: canonical ISO-8601 timestamp when present.
        if let archived = try c.decodeIfPresent(String.self, forKey: .archivedAt) {
            archivedAt = try Bounded.controlFree(archived, path: "archivedAt", maxBytes: 128)
            // Best-effort canonical check (strict round-trip deferred — formatter
            // fractional-second handling varies); require it to parse.
            if ISO8601DateFormatter.canonical.date(from: archivedAt!) == nil {
                throw T4WireError.invalidFrame(path: "archivedAt", reason: "archivedAt must be a canonical ISO timestamp")
            }
        } else {
            archivedAt = nil
        }
        liveState = try c.decodeIfPresent(JSONValue.self, forKey: .liveState)
        model = try c.decodeIfPresent(String.self, forKey: .model).map { try Bounded.controlFree($0, path: "model", maxBytes: 256) }
        thinking = try c.decodeIfPresent(String.self, forKey: .thinking).map { try Bounded.controlFree($0, path: "thinking", maxBytes: 256) }
        pendingApproval = try c.decodeIfPresent(Bool.self, forKey: .pendingApproval)
        pendingUserInput = try c.decodeIfPresent(Bool.self, forKey: .pendingUserInput)
        proposedPlan = try c.decodeIfPresent(String.self, forKey: .proposedPlan).map { try Bounded.string($0, path: "proposedPlan", maxBytes: 4096) }
        mode = try c.decodeIfPresent(String.self, forKey: .mode).map { try Bounded.controlFree($0, path: "mode", maxBytes: 32) }
        contextUsage = try c.decodeIfPresent(ContextUsage.self, forKey: .contextUsage)
        attention = try c.decodeIfPresent(JSONValue.self, forKey: .attention)
        runtime = try c.decodeIfPresent(JSONValue.self, forKey: .runtime)
    }
}

/// `{ cursor, sessions, totalCount, truncated }` — the result of `session.list`
/// and `host.list`, and the body of a `sessions` frame.
public struct SessionListResult: Decodable, Equatable, Sendable {
    public let cursor: Cursor
    public let sessions: [SessionRef]
    public let totalCount: Int
    public let truncated: Bool

    private enum CodingKeys: String, CodingKey { case cursor, sessions, totalCount, truncated }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cursor = try c.decode(Cursor.self, forKey: .cursor)
        let sessionValues = try c.decode([SessionRef].self, forKey: .sessions)
        let (tc, tr) = try ListMetadata.resolve(
            totalCount: try c.decodeIfPresent(Int.self, forKey: .totalCount),
            truncated: try c.decodeIfPresent(Bool.self, forKey: .truncated),
            sessionCount: sessionValues.count,
            path: "result"
        )
        sessions = sessionValues
        totalCount = tc
        truncated = tr
    }
}

/// Host → client push: the current session inventory for a host (or cluster).
public struct SessionsFrame: Decodable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let hostId: HostId?
    public let cursor: Cursor
    public let sessions: [SessionRef]
    public let totalCount: Int
    public let truncated: Bool

    private enum CodingKeys: String, CodingKey { case v, type, hostId, cursor, sessions, totalCount, truncated }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(String.self, forKey: .v)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: .type) == "sessions" else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected sessions frame")
        }
        v = version
        type = "sessions"
        hostId = try c.decodeIfPresent(String.self, forKey: .hostId).map { try IDs.opaque($0, path: "hostId") }
        cursor = try c.decode(Cursor.self, forKey: .cursor)
        let sessionValues = try c.decode([SessionRef].self, forKey: .sessions)
        let (tc, tr) = try ListMetadata.resolve(
            totalCount: try c.decodeIfPresent(Int.self, forKey: .totalCount),
            truncated: try c.decodeIfPresent(Bool.self, forKey: .truncated),
            sessionCount: sessionValues.count,
            path: "frame"
        )
        sessions = sessionValues
        totalCount = tc
        truncated = tr
    }
}

/// Computes/validates the list `totalCount`/`truncated` pair
/// (session-index.decodeListMetadata): totalCount defaults to the session count,
/// truncated defaults to totalCount > sessionCount, and an explicit truncated
/// must agree with totalCount > sessionCount.
enum ListMetadata {
    static func resolve(totalCount: Int?, truncated: Bool?, sessionCount: Int, path: String) throws -> (totalCount: Int, truncated: Bool) {
        let tc = totalCount ?? sessionCount
        guard tc >= 0, tc >= sessionCount else {
            throw T4WireError.invalidFrame(path: "\(path).totalCount", reason: "totalCount cannot be less than sessions length")
        }
        let expectedTruncated = tc > sessionCount
        let tr = truncated ?? expectedTruncated
        guard tr == expectedTruncated else {
            throw T4WireError.invalidFrame(path: path, reason: "truncated does not match totalCount")
        }
        return (tc, tr)
    }
}

extension ISO8601DateFormatter {
    /// A shared formatter that accepts internet date/time with optional seconds.
    static let canonical: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
