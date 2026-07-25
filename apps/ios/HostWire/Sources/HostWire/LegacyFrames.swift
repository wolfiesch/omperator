import Foundation

/// Remaining non-additive server frames: the legacy `terminal` union, the
/// `audit` event frame, and the `files` / `review` frames (host-wire/src/
/// terminal.ts, audit.ts, files-review.ts). `TurnReviewSnapshot` / turn-file
/// changes (the typed body of a turn-review entry) are deferred until the
/// transcript entry data is typed.

/// Legacy terminal frame (type "terminal"): an output chunk (stdout/stderr) or
/// an exit. Output carries `data` and no exitCode; exit carries `exitCode` and
/// no data.
public struct LegacyTerminalFrame: Decodable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let hostId: HostId
    public let sessionId: SessionId
    public let terminalId: TerminalId
    public let stream: String
    public let data: String?
    public let exitCode: Int?

    private enum CodingKeys: String, CodingKey { case v, type, hostId, sessionId, terminalId, stream, data, exitCode }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(String.self, forKey: .v)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: .type) == "terminal" else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected terminal frame")
        }
        v = version; type = "terminal"
        hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "hostId")
        sessionId = try IDs.opaque(try c.decode(String.self, forKey: .sessionId), path: "sessionId")
        terminalId = try IDs.opaque(try c.decode(String.self, forKey: .terminalId), path: "terminalId")
        let streamValue = try Bounded.controlFree(try c.decode(String.self, forKey: .stream), path: "stream", maxBytes: 32)
        stream = streamValue
        let dataValue = try c.decodeIfPresent(String.self, forKey: .data)
        let exitValue = try c.decodeIfPresent(Int.self, forKey: .exitCode)
        switch streamValue {
        case "stdout", "stderr":
            guard let dataValue else { throw T4WireError.invalidFrame(path: "data", reason: "terminal output requires data") }
            if dataValue.utf8.count > 256_000 {
                throw T4WireError.bounds(path: "data", reason: "terminal output exceeds limit")
            }
            if exitValue != nil { throw T4WireError.invalidFrame(path: "exitCode", reason: "terminal output cannot have exitCode") }
            data = dataValue
            exitCode = nil
        case "exit":
            if dataValue != nil { throw T4WireError.invalidFrame(path: "data", reason: "terminal exit cannot have data") }
            guard let exitValue, abs(exitValue) <= 9_007_199_254_740_991 else {
                throw T4WireError.invalidFrame(path: "exitCode", reason: "exitCode must be safe integer")
            }
            data = nil
            exitCode = exitValue
        default:
            throw T4WireError.invalidFrame(path: "stream", reason: "unknown terminal stream")
        }
    }
}

/// Audit event frame (type "audit").
public struct AuditFrame: Decodable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let hostId: HostId
    public let sessionId: SessionId?
    public let action: String
    public let actor: String
    public let timestamp: String
    public let detail: JSONValue?

    private enum CodingKeys: String, CodingKey { case v, type, hostId, sessionId, action, actor, timestamp, detail }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(String.self, forKey: .v)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: .type) == "audit" else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected audit frame")
        }
        v = version; type = "audit"
        hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "hostId")
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId).map { try IDs.opaque($0, path: "sessionId") }
        action = try Bounded.controlFree(try c.decode(String.self, forKey: .action), path: "action", maxBytes: 128)
        actor = try Bounded.controlFree(try c.decode(String.self, forKey: .actor), path: "actor", maxBytes: 256)
        timestamp = try Bounded.controlFree(try c.decode(String.self, forKey: .timestamp), path: "timestamp", maxBytes: 128)
        if let d = try c.decodeIfPresent(JSONValue.self, forKey: .detail) {
            guard case .object = d else { throw T4WireError.invalidFrame(path: "detail", reason: "detail must be an object") }
            detail = d
        } else { detail = nil }
    }
}

/// File read frame (type "files") — a file's content at a path, optionally
/// truncated. (Path-shape validation is simplified to a bounded control-free
/// string; the host enforces real relative paths.)
public struct FileFrame: Decodable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let hostId: HostId
    public let sessionId: SessionId
    public let path: String
    public let content: String?
    public let truncated: Bool?

    private enum CodingKeys: String, CodingKey { case v, type, hostId, sessionId, path, content, truncated }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(String.self, forKey: .v)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: .type) == "files" else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected files frame")
        }
        v = version; type = "files"
        hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "hostId")
        sessionId = try IDs.opaque(try c.decode(String.self, forKey: .sessionId), path: "sessionId")
        path = try Bounded.controlFree(try c.decode(String.self, forKey: .path), path: "path", maxBytes: 4096)
        if let content = try c.decodeIfPresent(String.self, forKey: .content) {
            if content.utf8.count > 768 * 1024 { throw T4WireError.bounds(path: "content", reason: "file content exceeds limit") }
            self.content = content
        } else { content = nil }
        truncated = try c.decodeIfPresent(Bool.self, forKey: .truncated)
    }
}

/// Review frame (type "review") — a code review with findings.
public struct ReviewFrame: Decodable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let hostId: HostId
    public let sessionId: SessionId
    public let reviewId: String
    public let status: String
    public let path: String?
    public let findings: [JSONValue]

    private enum CodingKeys: String, CodingKey { case v, type, hostId, sessionId, reviewId, status, path, findings }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(String.self, forKey: .v)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: .type) == "review" else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected review frame")
        }
        v = version; type = "review"
        hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "hostId")
        sessionId = try IDs.opaque(try c.decode(String.self, forKey: .sessionId), path: "sessionId")
        reviewId = try Bounded.controlFree(try c.decode(String.self, forKey: .reviewId), path: "reviewId", maxBytes: 256)
        status = try Bounded.controlFree(try c.decode(String.self, forKey: .status), path: "status", maxBytes: 64)
        path = try c.decodeIfPresent(String.self, forKey: .path).map { try Bounded.controlFree($0, path: "path", maxBytes: 4096) }
        let findingValues = try c.decode([JSONValue].self, forKey: .findings)
        for (i, finding) in findingValues.enumerated() {
            guard case .object = finding else {
                throw T4WireError.invalidFrame(path: "findings[\(i)]", reason: "finding must be an object")
            }
        }
        findings = findingValues
    }
}
