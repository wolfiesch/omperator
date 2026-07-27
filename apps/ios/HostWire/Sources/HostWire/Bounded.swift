import Foundation

/// Wire errors mirror the failure codes raised by host-wire/src/guards.ts +
/// the per-frame decoders, so a port consumer sees the same vocabulary.
public enum T4WireError: Error, Equatable, CustomStringConvertible, Sendable {
    case missingVersion(path: String, expected: String)
    case unsupportedProtocol(path: String, reason: String)
    case invalidFrame(path: String, reason: String)
    case bounds(path: String, reason: String)
    case unsafeSequence(path: String)
    case unknownFrame(family: String)
    case pairingInvalid(path: String, reason: String)
    case confirmationInvalid(path: String, reason: String)

    public var description: String {
        switch self {
        case let .missingVersion(p, e): "MISSING_VERSION at \(p): expected \(e)"
        case let .unsupportedProtocol(p, r): "UNSUPPORTED_PROTOCOL at \(p): \(r)"
        case let .invalidFrame(p, r): "INVALID_FRAME at \(p): \(r)"
        case let .bounds(p, r): "BOUNDS at \(p): \(r)"
        case let .unsafeSequence(p): "UNSAFE_SEQUENCE at \(p)"
        case let .unknownFrame(f): "UNKNOWN_FRAME: \(f)"
        case let .pairingInvalid(p, r): "PAIRING_INVALID at \(p): \(r)"
        case let .confirmationInvalid(p, r): "CONFIRMATION_INVALID at \(p): \(r)"
        }
    }
}

/// Content validators mirroring host-wire/src/guards.ts.
/// Codable already enforces JSON *types*; these enforce the protocol's
/// *content* bounds (non-empty, byte-length, control-char-free, formats).
enum Bounded {
    /// Non-empty UTF-8 string whose byte length is <= maxBytes (guards.string).
    static func string(_ s: String, path: String, maxBytes: Int) throws -> String {
        guard !s.isEmpty else {
            throw T4WireError.bounds(path: path, reason: "expected non-empty string")
        }
        if s.utf8.count > maxBytes {
            throw T4WireError.bounds(path: path, reason: "string exceeds \(maxBytes) bytes")
        }
        return s
    }

    /// Like `string`, plus rejects C0/C1 control characters and DEL
    /// (guards.controlFree): 0x00-0x1f, 0x7f, 0x80-0x9f.
    static func controlFree(_ s: String, path: String, maxBytes: Int) throws -> String {
        let value = try string(s, path: path, maxBytes: maxBytes)
        for scalar in value.unicodeScalars {
            let c = scalar.value
            if c <= 0x1f || c == 0x7f || (c >= 0x80 && c <= 0x9f) {
                throw T4WireError.bounds(path: path, reason: "control character not allowed")
            }
        }
        return value
    }

    /// A safe, non-negative integer (guards.safeSeq).
    static func seq(_ n: Int, path: String) throws -> Int {
        guard n >= 0 else { throw T4WireError.unsafeSequence(path: path) }
        return n
    }

    /// Canonical base64url for 32 bytes: 42 base64url chars + a final char from
    /// the base64url residue set (guards.deviceToken).
    static func deviceToken(_ s: String, path: String) throws -> String {
        let url = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        let residue = "AEIMQUYcgkosw048"
        guard s.count == 43,
              let last = s.last, residue.contains(last),
              s.dropLast().allSatisfy({ url.contains($0) })
        else {
            throw T4WireError.invalidFrame(path: path, reason: "device token must be canonical base64url for 32 bytes")
        }
        return s
    }
}
