import Foundation

/// ping/pong/bye liveness frames (host-wire/src/heartbeat.ts).
/// All three carry `v: "omp-app/1"` and are discriminated by `type`.

public struct PingFrame: Codable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let nonce: String
    public let timestamp: String

    public init(nonce: String, timestamp: String, v: String = Wire.protocolVersion) {
        self.v = v; self.type = "ping"; self.nonce = nonce; self.timestamp = timestamp
    }

    private enum CodingKeys: String, CodingKey { case v, type, nonce, timestamp }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try Heartbeat.checkVersionAndType(c, expectedType: "ping")
        v = Wire.protocolVersion
        type = "ping"
        nonce = try Bounded.controlFree(try c.decode(String.self, forKey: .nonce), path: "nonce", maxBytes: 128)
        timestamp = try Bounded.controlFree(try c.decode(String.self, forKey: .timestamp), path: "timestamp", maxBytes: 128)
    }
}

public struct PongFrame: Decodable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let nonce: String
    public let timestamp: String

    private enum CodingKeys: String, CodingKey { case v, type, nonce, timestamp }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try Heartbeat.checkVersionAndType(c, expectedType: "pong")
        v = Wire.protocolVersion
        type = "pong"
        nonce = try Bounded.controlFree(try c.decode(String.self, forKey: .nonce), path: "nonce", maxBytes: 128)
        timestamp = try Bounded.controlFree(try c.decode(String.self, forKey: .timestamp), path: "timestamp", maxBytes: 128)
    }
}

public struct ByeFrame: Decodable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let code: String
    public let reason: String
    public let retryable: Bool

    private enum CodingKeys: String, CodingKey { case v, type, code, reason, retryable }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try Heartbeat.checkVersionAndType(c, expectedType: "bye")
        v = Wire.protocolVersion
        type = "bye"
        code = try Bounded.controlFree(try c.decode(String.self, forKey: .code), path: "code", maxBytes: 128)
        reason = try Bounded.string(try c.decode(String.self, forKey: .reason), path: "reason", maxBytes: 1024)
        retryable = try c.decode(Bool.self, forKey: .retryable)
    }
}

enum Heartbeat {
    /// Shared `v` == protocol version and `type` == expected check.
    static func checkVersionAndType<K: CodingKey>(_ c: KeyedDecodingContainer<K>, expectedType: String) throws {
        guard let vKey = K(stringValue: "v"), let typeKey = K(stringValue: "type") else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected \(expectedType) frame")
        }
        let version = try c.decode(String.self, forKey: vKey)
        guard version == Wire.protocolVersion else {
            throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion)
        }
        let type = try c.decode(String.self, forKey: typeKey)
        guard type == expectedType else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected \(expectedType) frame")
        }
    }
}
