import Foundation

/// Terminal frames (host-wire/src/additive.ts terminal.* family).
/// `terminal.input` / `terminal.resize` / `terminal.close` are client → host;
/// `terminal.output` / `terminal.exit` are host → client (server additive).
/// All carry the (hostId, sessionId, terminalId) locator; the server frames
/// additionally advance a per-session `Cursor`.

/// Output stream for `terminal.output` (additive.ts `known(stream, ...)`).
public enum TerminalStream: String, Codable, Equatable, Sendable {
    case stdout, stderr
}

/// terminal.input — raw bytes/utf8 to feed a pty.
public struct TerminalInputFrame: Codable, Equatable, Sendable {
    public let v: String, type: String, hostId: HostId, sessionId: SessionId, terminalId: TerminalId
    public let data: String
    public let encoding: String?

    private enum CodingKeys: String, CodingKey { case v, type, hostId, sessionId, terminalId, data, encoding }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try Terminals.check(c, type: "terminal.input")
        v = Wire.protocolVersion; type = "terminal.input"
        let ids = try Terminals.Ids(from: decoder)
        hostId = ids.hostId; sessionId = ids.sessionId; terminalId = ids.terminalId
        let enc = try c.decodeIfPresent(String.self, forKey: .encoding)
        encoding = try enc.map { try Terminals.validateEncoding($0, path: "encoding") }
        data = try Terminals.data(try c.decode(String.self, forKey: .data), path: "data", encoding: encoding)
    }
    /// Construct a client → host `terminal.input` frame for sending.
    public init(hostId: HostId, sessionId: SessionId, terminalId: TerminalId, data: String, encoding: String? = nil) {
        self.v = Wire.protocolVersion; self.type = "terminal.input"
        self.hostId = hostId; self.sessionId = sessionId; self.terminalId = terminalId
        self.data = data; self.encoding = encoding
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(v, forKey: .v)
        try c.encode(type, forKey: .type)
        try c.encode(hostId, forKey: .hostId)
        try c.encode(sessionId, forKey: .sessionId)
        try c.encode(terminalId, forKey: .terminalId)
        try c.encode(data, forKey: .data)
        try c.encodeIfPresent(encoding, forKey: .encoding)
    }
}

/// terminal.output — a chunk of pty output at a cursor.
public struct TerminalOutputFrame: Decodable, Equatable, Sendable {
    public let v: String, type: String, hostId: HostId, sessionId: SessionId, terminalId: TerminalId
    public let cursor: Cursor, stream: TerminalStream, data: String
    public let encoding: String?

    private enum CodingKeys: String, CodingKey { case v, type, hostId, sessionId, terminalId, cursor, stream, data, encoding }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try Terminals.check(c, type: "terminal.output")
        v = Wire.protocolVersion; type = "terminal.output"
        let ids = try Terminals.Ids(from: decoder)
        hostId = ids.hostId; sessionId = ids.sessionId; terminalId = ids.terminalId
        cursor = try c.decode(Cursor.self, forKey: .cursor)
        stream = try c.decode(TerminalStream.self, forKey: .stream)
        let enc = try c.decodeIfPresent(String.self, forKey: .encoding)
        encoding = try enc.map { try Terminals.validateEncoding($0, path: "encoding") }
        data = try Terminals.data(try c.decode(String.self, forKey: .data), path: "data", encoding: encoding)
    }
}

/// terminal.resize — a pty dimension change (cols 1..1000, rows 1..500).
public struct TerminalResizeFrame: Codable, Equatable, Sendable {
    public let v: String, type: String, hostId: HostId, sessionId: SessionId, terminalId: TerminalId
    public let cols: Int, rows: Int

    private enum CodingKeys: String, CodingKey { case v, type, hostId, sessionId, terminalId, cols, rows }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try Terminals.check(c, type: "terminal.resize")
        v = Wire.protocolVersion; type = "terminal.resize"
        let ids = try Terminals.Ids(from: decoder)
        hostId = ids.hostId; sessionId = ids.sessionId; terminalId = ids.terminalId
        cols = try Terminals.dimension(try c.decode(Int.self, forKey: .cols), path: "cols")
        rows = try Terminals.dimension(try c.decode(Int.self, forKey: .rows), path: "rows")
    }
    /// Construct a client → host `terminal.resize` frame for sending.
    public init(hostId: HostId, sessionId: SessionId, terminalId: TerminalId, cols: Int, rows: Int) {
        self.v = Wire.protocolVersion; self.type = "terminal.resize"
        self.hostId = hostId; self.sessionId = sessionId; self.terminalId = terminalId
        self.cols = cols; self.rows = rows
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(v, forKey: .v)
        try c.encode(type, forKey: .type)
        try c.encode(hostId, forKey: .hostId)
        try c.encode(sessionId, forKey: .sessionId)
        try c.encode(terminalId, forKey: .terminalId)
        try c.encode(cols, forKey: .cols)
        try c.encode(rows, forKey: .rows)
    }
}

/// terminal.close — request a pty be closed with an optional reason.
public struct TerminalCloseFrame: Codable, Equatable, Sendable {
    public let v: String, type: String, hostId: HostId, sessionId: SessionId, terminalId: TerminalId
    public let reason: String?

    private enum CodingKeys: String, CodingKey { case v, type, hostId, sessionId, terminalId, reason }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try Terminals.check(c, type: "terminal.close")
        v = Wire.protocolVersion; type = "terminal.close"
        let ids = try Terminals.Ids(from: decoder)
        hostId = ids.hostId; sessionId = ids.sessionId; terminalId = ids.terminalId
        if let r = try c.decodeIfPresent(String.self, forKey: .reason) {
            reason = try Bounded.controlFree(r, path: "reason", maxBytes: 256)
        } else { reason = nil }
    }
    /// Construct a client → host `terminal.close` frame for sending.
    public init(hostId: HostId, sessionId: SessionId, terminalId: TerminalId, reason: String? = nil) {
        self.v = Wire.protocolVersion; self.type = "terminal.close"
        self.hostId = hostId; self.sessionId = sessionId; self.terminalId = terminalId
        self.reason = reason
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(v, forKey: .v)
        try c.encode(type, forKey: .type)
        try c.encode(hostId, forKey: .hostId)
        try c.encode(sessionId, forKey: .sessionId)
        try c.encode(terminalId, forKey: .terminalId)
        try c.encodeIfPresent(reason, forKey: .reason)
    }
}

/// terminal.exit — a pty has exited with an exit code at a cursor.
public struct TerminalExitFrame: Decodable, Equatable, Sendable {
    public let v: String, type: String, hostId: HostId, sessionId: SessionId, terminalId: TerminalId
    public let cursor: Cursor, exitCode: Int
    public let signal: String?

    private enum CodingKeys: String, CodingKey { case v, type, hostId, sessionId, terminalId, cursor, exitCode, signal }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try Terminals.check(c, type: "terminal.exit")
        v = Wire.protocolVersion; type = "terminal.exit"
        let ids = try Terminals.Ids(from: decoder)
        hostId = ids.hostId; sessionId = ids.sessionId; terminalId = ids.terminalId
        cursor = try c.decode(Cursor.self, forKey: .cursor)
        let code = try c.decode(Int.self, forKey: .exitCode)
        guard abs(code) <= 9_007_199_254_740_991 else {
            throw T4WireError.invalidFrame(path: "exitCode", reason: "exitCode must be safe integer")
        }
        exitCode = code
        if let s = try c.decodeIfPresent(String.self, forKey: .signal) {
            signal = try Bounded.controlFree(s, path: "signal", maxBytes: 128)
        } else { signal = nil }
    }
}

enum Terminals {
    /// Max bytes carried by one terminal `data` payload (limits.ts
    /// MAX_TERMINAL_OUTPUT_BYTES). Defined locally pending a Limits entry.
    static let maxOutputBytes = 256_000

    static func check<K: CodingKey>(_ c: KeyedDecodingContainer<K>, type expected: String) throws {
        let version = try c.decode(String.self, forKey: K(stringValue: "v")!)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: K(stringValue: "type")!) == expected else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected \(expected) frame")
        }
    }

    /// `known(encoding, "encoding", ["utf8", "base64"])` — the encoding is
    /// optional but, when present, must be one of the two literal strings.
    static func validateEncoding(_ s: String, path: String) throws -> String {
        guard s == "utf8" || s == "base64" else {
            throw T4WireError.invalidFrame(path: path, reason: "expected one of \"utf8\", \"base64\"")
        }
        return s
    }

    /// `dimension(value, path)` (additive.ts): a safe non-negative integer that
    /// is non-zero and within the per-field ceiling — cols ≤ 1000, rows ≤ 500.
    static func dimension(_ n: Int, path: String) throws -> Int {
        let safe = try Bounded.seq(n, path: path)
        let max = path.hasSuffix("cols") ? 1000 : 500
        guard safe != 0, safe <= max else {
            throw T4WireError.bounds(path: path, reason: "terminal dimension out of range")
        }
        return safe
    }

    /// `boundedText` / `boundedBase64` for terminal `data` (guards.ts).
    /// UTF-8 (or absent encoding): bounded UTF-8 text ≤ maxOutputBytes.
    /// base64: bounded text ≤ ceil(maxOutputBytes·4/3)+4 AND canonical base64.
    static func data(_ s: String, path: String, encoding: String?) throws -> String {
        if encoding == "base64" {
            let maxChars = (maxOutputBytes * 4 + 2) / 3 + 4
            guard s.utf8.count <= maxChars else {
                throw T4WireError.bounds(path: path, reason: "expected bounded UTF-8 text")
            }
            guard s.wholeMatch(of: #/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/#) != nil else {
                throw T4WireError.bounds(path: path, reason: "invalid base64 payload")
            }
            return s
        }
        guard s.utf8.count <= maxOutputBytes else {
            throw T4WireError.bounds(path: path, reason: "expected bounded UTF-8 text")
        }
        return s
    }

    /// Shared (hostId, sessionId, terminalId) locator for every terminal.* frame.
    struct Ids: Decodable {
        let hostId: HostId
        let sessionId: SessionId
        let terminalId: TerminalId
        private enum CodingKeys: String, CodingKey { case hostId, sessionId, terminalId }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "hostId")
            sessionId = try IDs.opaque(try c.decode(String.self, forKey: .sessionId), path: "sessionId")
            terminalId = try IDs.opaque(try c.decode(String.self, forKey: .terminalId), path: "terminalId")
        }
    }
}
