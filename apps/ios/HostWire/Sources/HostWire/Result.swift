import Foundation

/// Command response frame (host-wire/src/result.ts). `result` stays opaque
/// (`JSONValue`) until the per-command result decoders are ported; the
/// structural rules — ok/error/result mutual exclusion and the requirement that
/// a typed `result` carry a `command` — are enforced here.

public struct ResultError: Decodable, Equatable, Sendable {
    public let code: String
    public let message: String
    public let details: [String: JSONValue]?

    private enum CodingKeys: String, CodingKey { case code, message, details }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        code = try Bounded.controlFree(try c.decode(String.self, forKey: .code), path: "error.code", maxBytes: 128)
        message = try Bounded.string(try c.decode(String.self, forKey: .message), path: "error.message", maxBytes: 1024)
        details = try c.decodeIfPresent([String: JSONValue].self, forKey: .details)
        if let details {
            switch code {
            case "idempotency_conflict":
                try ResultError.requireDetailString(details, "commandId", maxBytes: 256)
                try ResultError.requireDetailString(details, "payloadHash", maxBytes: 256)
            case "stale_revision":
                try ResultError.requireDetailString(details, "expectedRevision", maxBytes: 256)
                try ResultError.requireDetailString(details, "actualRevision", maxBytes: 256)
            case "outcome_unknown":
                try ResultError.requireDetailString(details, "recovery", maxBytes: 1024)
            default:
                break
            }
        }
    }

    private static func requireDetailString(_ details: [String: JSONValue], _ key: String, maxBytes: Int) throws {
        guard case .string(let value) = details[key] else {
            throw T4WireError.invalidFrame(path: "error.details.\(key)", reason: "expected string")
        }
        _ = try Bounded.controlFree(value, path: "error.details.\(key)", maxBytes: maxBytes)
    }
}

public struct ResultFrame: Decodable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let requestId: RequestId
    public let commandId: CommandId?
    public let hostId: HostId
    public let sessionId: SessionId?
    public let ok: Bool
    public let result: JSONValue?
    public let command: String?
    public let error: ResultError?

    private enum CodingKeys: String, CodingKey {
        case v, type, requestId, commandId, hostId, sessionId, ok, result, command, error
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(String.self, forKey: .v)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: .type) == "response" else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected response frame")
        }
        let requestId = try IDs.opaque(try c.decode(String.self, forKey: .requestId), path: "requestId")
        let commandId = try c.decodeIfPresent(String.self, forKey: .commandId).map { try IDs.opaque($0, path: "commandId") }
        let hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "hostId")
        let sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId).map { try IDs.opaque($0, path: "sessionId") }
        let isOk = try c.decode(Bool.self, forKey: .ok)
        let resultValue = try c.decodeIfPresent(JSONValue.self, forKey: .result)
        let errorValue = try c.decodeIfPresent(ResultError.self, forKey: .error)
        var commandValue: String? = nil
        if let raw = try c.decodeIfPresent(String.self, forKey: .command) {
            commandValue = try Bounded.controlFree(raw, path: "command", maxBytes: 128)
        }

        // ok/error/result mutual exclusion (result.decodeResult).
        if isOk {
            if errorValue != nil {
                throw T4WireError.invalidFrame(path: "error", reason: "successful response cannot have error")
            }
        } else {
            if resultValue != nil {
                throw T4WireError.invalidFrame(path: "result", reason: "failed response cannot have result")
            }
            guard errorValue != nil else {
                throw T4WireError.invalidFrame(path: "error", reason: "failed response requires an error")
            }
        }
        // A typed result requires the `command` discriminator.
        if isOk, resultValue != nil, commandValue == nil {
            throw T4WireError.invalidFrame(path: "command", reason: "successful response result requires a typed command")
        }

        v = version
        type = "response"
        self.requestId = requestId
        self.commandId = commandId
        self.hostId = hostId
        self.sessionId = sessionId
        ok = isOk
        result = resultValue
        command = commandValue
        error = errorValue
    }
}
