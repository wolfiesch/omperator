import Foundation

/// Frame envelope + top-level decode dispatch (host-wire/src/envelope.ts).
///
/// Every frame is a JSON object carrying `v: "omp-app/1"` and a string `type`
/// discriminant. `ClientFrame`/`ServerFrame` decode by peeking `type` then
/// decoding the whole message into the matching struct. Types not yet ported
/// (commands, terminal I/O, sessions inventory, entries, agents, files, review,
/// audit, gap, additive) throw `.unknownFrame`; they land in later steps.

public struct ErrorFrame: Decodable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let code: String
    public let message: String
    public let requestId: String?

    private enum CodingKeys: String, CodingKey { case v, type, code, message, requestId }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(String.self, forKey: .v)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: .type) == "error" else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected error frame")
        }
        v = version; type = "error"
        code = try Bounded.controlFree(try c.decode(String.self, forKey: .code), path: "code", maxBytes: 128)
        message = try Bounded.string(try c.decode(String.self, forKey: .message), path: "message", maxBytes: 2048)
        requestId = try c.decodeIfPresent(String.self, forKey: .requestId).map { try IDs.opaque($0, path: "requestId") }
    }
}

/// An open session event: `{ type: <string>, ... }`. Only `type` is fixed
/// (bounded control-free); the rest is carried verbatim until the typed event
/// vocabulary is ported.
public struct SessionEvent: Equatable, Sendable {
    public let type: String
    public let fields: [String: JSONValue]
}

/// Host → client: one live session event with its cursor.
public struct LiveEventFrame: Decodable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let cursor: Cursor
    public let hostId: HostId
    public let sessionId: SessionId
    public let event: SessionEvent

    private enum CodingKeys: String, CodingKey { case v, type, cursor, hostId, sessionId, event }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(String.self, forKey: .v)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: .type) == "event" else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected event frame")
        }
        v = version; type = "event"
        cursor = try c.decode(Cursor.self, forKey: .cursor)
        hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "hostId")
        sessionId = try IDs.opaque(try c.decode(String.self, forKey: .sessionId), path: "sessionId")
        let fields = try c.decode([String: JSONValue].self, forKey: .event)
        guard case .string(let eventType) = fields["type"] else {
            throw T4WireError.invalidFrame(path: "event.type", reason: "event must have a string type")
        }
        _ = try Bounded.controlFree(eventType, path: "event.type", maxBytes: 128)
        event = SessionEvent(type: eventType, fields: fields)
    }
}

private struct TypePeek: Decodable {
    let type: String
}

private func wireDecode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
    try JSONDecoder().decode(type, from: data)
}

/// A decoded client → host frame.
public enum ClientFrame: Equatable, Sendable {
    case hello(HelloFrame)
    case confirm(ConfirmFrame)
    case pairStart(PairStartFrame)
    case ping(PingFrame)
    case command(CommandFrame)

    public static func decode(_ data: Data) throws -> ClientFrame {
        let type = try wireDecode(TypePeek.self, from: data).type
        switch type {
        case "hello": return .hello(try wireDecode(HelloFrame.self, from: data))
        case "confirm": return .confirm(try wireDecode(ConfirmFrame.self, from: data))
        case "pair.start": return .pairStart(try wireDecode(PairStartFrame.self, from: data))
        case "ping": return .ping(try wireDecode(PingFrame.self, from: data))
        case "command": return .command(try wireDecode(CommandFrame.self, from: data))
        default: throw T4WireError.unknownFrame(family: "not yet ported (client): \(type)")
        }
    }
}

/// A decoded host → client frame.
public enum ServerFrame: Equatable, Sendable {
    case welcome(WelcomeFrame)
    case sessions(SessionsFrame)
    case event(LiveEventFrame)
    case confirmation(ConfirmationChallenge)
    case response(ResultFrame)
    case error(ErrorFrame)
    case pong(PongFrame)
    case bye(ByeFrame)
    case pairOk(PairOkFrame)
    case pairError(PairErrorFrame)

    public static func decode(_ data: Data) throws -> ServerFrame {
        let type = try wireDecode(TypePeek.self, from: data).type
        switch type {
        case "welcome": return .welcome(try wireDecode(WelcomeFrame.self, from: data))
        case "sessions": return .sessions(try wireDecode(SessionsFrame.self, from: data))
        case "event": return .event(try wireDecode(LiveEventFrame.self, from: data))
        case "confirmation": return .confirmation(try wireDecode(ConfirmationChallenge.self, from: data))
        case "response": return .response(try wireDecode(ResultFrame.self, from: data))
        case "error": return .error(try wireDecode(ErrorFrame.self, from: data))
        case "pong": return .pong(try wireDecode(PongFrame.self, from: data))
        case "bye": return .bye(try wireDecode(ByeFrame.self, from: data))
        case "pair.ok": return .pairOk(try wireDecode(PairOkFrame.self, from: data))
        case "pair.error": return .pairError(try wireDecode(PairErrorFrame.self, from: data))
        default: throw T4WireError.unknownFrame(family: "not yet ported (server): \(type)")
        }
    }
}

/// Encode any encodable frame to the wire (one JSON object per message).
public func encodeFrame<T: Encodable>(_ frame: T) throws -> Data {
    try JSONEncoder().encode(frame)
}
