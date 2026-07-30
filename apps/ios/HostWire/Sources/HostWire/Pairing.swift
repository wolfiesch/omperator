import Foundation

/// Pairing frames + the `t4-code://pair/...` deep link
/// (host-wire/src/pairing-confirm.ts, protocol/src/pair-link.ts).

public enum ConfirmDecision: String, Codable, Equatable, Sendable {
    case approve
    case deny
}

/// Client → host: approve/deny a confirmation challenge.
public struct ConfirmFrame: Codable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let requestId: RequestId
    public let confirmationId: ConfirmationId
    public let commandId: CommandId
    public let hostId: HostId
    public let sessionId: SessionId?
    public let decision: ConfirmDecision

    public init(
        requestId: RequestId, confirmationId: ConfirmationId, commandId: CommandId,
        hostId: HostId, sessionId: SessionId? = nil, decision: ConfirmDecision,
        v: String = Wire.protocolVersion
    ) {
        self.v = v; self.type = "confirm"
        self.requestId = requestId; self.confirmationId = confirmationId; self.commandId = commandId
        self.hostId = hostId; self.sessionId = sessionId; self.decision = decision
    }

    private enum CodingKeys: String, CodingKey {
        case v, type, requestId, confirmationId, commandId, hostId, sessionId, decision
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(String.self, forKey: .v)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: .type) == "confirm" else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected confirmation decision")
        }
        v = version; type = "confirm"
        requestId = try IDs.opaque(try c.decode(String.self, forKey: .requestId), path: "requestId")
        confirmationId = try IDs.opaque(try c.decode(String.self, forKey: .confirmationId), path: "confirmationId")
        commandId = try IDs.opaque(try c.decode(String.self, forKey: .commandId), path: "commandId")
        hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "hostId")
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId).map { try IDs.opaque($0, path: "sessionId") }
        decision = try c.decode(ConfirmDecision.self, forKey: .decision)
    }
}

/// Client → host: begin pairing with a 6-digit code.
public struct PairStartFrame: Codable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let requestId: RequestId
    public let code: String
    public let deviceId: DeviceId
    public let deviceName: String
    public let platform: String
    public let requestedCapabilities: [String]

    public init(
        requestId: RequestId, code: String, deviceId: DeviceId, deviceName: String,
        platform: String, requestedCapabilities: [String], v: String = Wire.protocolVersion
    ) {
        self.v = v; self.type = "pair.start"
        self.requestId = requestId; self.code = code; self.deviceId = deviceId
        self.deviceName = deviceName; self.platform = platform
        self.requestedCapabilities = requestedCapabilities
    }

    private enum CodingKeys: String, CodingKey {
        case v, type, requestId, code, deviceId, deviceName, platform, requestedCapabilities
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(String.self, forKey: .v)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: .type) == "pair.start" else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected pair.start frame")
        }
        v = version; type = "pair.start"
        requestId = try IDs.opaque(try c.decode(String.self, forKey: .requestId), path: "requestId")
        code = try Pairing.pairingCode(try c.decode(String.self, forKey: .code), path: "code")
        deviceId = try IDs.opaque(try c.decode(String.self, forKey: .deviceId), path: "deviceId", maxBytes: 256)
        deviceName = try Bounded.controlFree(try c.decode(String.self, forKey: .deviceName), path: "deviceName", maxBytes: 256)
        platform = try Bounded.controlFree(try c.decode(String.self, forKey: .platform), path: "platform", maxBytes: 128)
        let requested = try Capabilities.requestedFeatures(try c.decode([String].self, forKey: .requestedCapabilities), path: "requestedCapabilities")
        try Capabilities.validate(requested, path: "requestedCapabilities")
        requestedCapabilities = requested
    }
}

/// Host → client: pairing succeeded, here is the device token.
public struct PairOkFrame: Decodable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let requestId: RequestId
    public let pairingId: PairingId
    public let deviceId: DeviceId
    public let deviceName: String
    public let platform: String
    public let requestedCapabilities: [String]
    public let grantedCapabilities: [String]
    public let deviceToken: String
    public let expiresAt: String

    private enum CodingKeys: String, CodingKey {
        case v, type, requestId, pairingId, deviceId, deviceName, platform
        case requestedCapabilities, grantedCapabilities, deviceToken, expiresAt
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(String.self, forKey: .v)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: .type) == "pair.ok" else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected pair.ok frame")
        }
        v = version; type = "pair.ok"
        requestId = try IDs.opaque(try c.decode(String.self, forKey: .requestId), path: "requestId")
        pairingId = try IDs.opaque(try c.decode(String.self, forKey: .pairingId), path: "pairingId")
        deviceId = try IDs.opaque(try c.decode(String.self, forKey: .deviceId), path: "deviceId", maxBytes: 256)
        deviceName = try Bounded.controlFree(try c.decode(String.self, forKey: .deviceName), path: "deviceName", maxBytes: 256)
        platform = try Bounded.controlFree(try c.decode(String.self, forKey: .platform), path: "platform", maxBytes: 128)
        let requested = try Capabilities.requestedFeatures(try c.decode([String].self, forKey: .requestedCapabilities), path: "requestedCapabilities")
        let granted = try c.decode([String].self, forKey: .grantedCapabilities)
        try Capabilities.validate(granted, path: "grantedCapabilities")
        requestedCapabilities = requested
        grantedCapabilities = granted
        deviceToken = try Bounded.deviceToken(try c.decode(String.self, forKey: .deviceToken), path: "deviceToken")
        expiresAt = try Bounded.controlFree(try c.decode(String.self, forKey: .expiresAt), path: "expiresAt", maxBytes: 128)
    }
}

/// Host → client: pairing failed.
public struct PairErrorFrame: Decodable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let code: String
    public let message: String
    public let requestId: RequestId?

    private enum CodingKeys: String, CodingKey { case v, type, code, message, requestId }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(String.self, forKey: .v)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: .type) == "pair.error" else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected pair.error frame")
        }
        v = version; type = "pair.error"
        code = try Bounded.controlFree(try c.decode(String.self, forKey: .code), path: "code", maxBytes: 128)
        message = try Bounded.string(try c.decode(String.self, forKey: .message), path: "message", maxBytes: 1024)
        requestId = try c.decodeIfPresent(String.self, forKey: .requestId).map { try IDs.opaque($0, path: "requestId") }
    }
}

/// Host → client: a command needs explicit confirmation.
public struct ConfirmationChallenge: Decodable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let confirmationId: ConfirmationId
    public let commandId: CommandId
    public let hostId: HostId
    public let sessionId: SessionId?
    public let commandHash: String
    public let revision: Revision
    public let expiresAt: String
    public let summary: String
    public let preview: String?

    private enum CodingKeys: String, CodingKey {
        case v, type, confirmationId, commandId, hostId, sessionId, commandHash
        case revision, expiresAt, summary, preview
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(String.self, forKey: .v)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: .type) == "confirmation" else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected confirmation challenge")
        }
        v = version; type = "confirmation"
        confirmationId = try IDs.opaque(try c.decode(String.self, forKey: .confirmationId), path: "confirmationId")
        commandId = try IDs.opaque(try c.decode(String.self, forKey: .commandId), path: "commandId")
        hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "hostId")
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId).map { try IDs.opaque($0, path: "sessionId") }
        commandHash = try Bounded.controlFree(try c.decode(String.self, forKey: .commandHash), path: "commandHash", maxBytes: 256)
        revision = try IDs.opaque(try c.decode(String.self, forKey: .revision), path: "revision")
        expiresAt = try Bounded.controlFree(try c.decode(String.self, forKey: .expiresAt), path: "expiresAt", maxBytes: 128)
        summary = try Bounded.string(try c.decode(String.self, forKey: .summary), path: "summary", maxBytes: 2048)
        preview = try c.decodeIfPresent(String.self, forKey: .preview).map { try Bounded.string($0, path: "preview", maxBytes: 8192) }
    }
}

/// A parsed `t4-code://pair/<hostHint>/<6-digit code>` deep link.
public struct PendingPair: Equatable, Sendable {
    public let hostHint: String
    public let code: String
    /// Epoch milliseconds, matching the TS `issuedAt` (Date.now()).
    public let issuedAt: Double
}

public enum Pairing {
    /// Six-digit pairing code (pairing-confirm.pairingCode).
    public static func pairingCode(_ value: String, path: String) throws -> String {
        let code = try Bounded.controlFree(value, path: path, maxBytes: 6)
        guard code.wholeMatch(of: #/\d{6}/#) != nil else {
            throw T4WireError.pairingInvalid(path: path, reason: "pairing code must be six digits")
        }
        return code
    }

    /// Parse `t4-code://pair/<hostHint>/<code>` (pair-link.parsePairDeepLink).
    /// Returns nil for any deviation: wrong scheme/host, extra components, or a
    /// malformed hint/code.
    public static func parseDeepLink(_ string: String, issuedAtMs: Double) -> PendingPair? {
        guard let comps = URLComponents(string: string),
              comps.scheme == "t4-code",
              comps.host == "pair",
              comps.user == nil, comps.password == nil,
              comps.queryItems == nil, comps.fragment == nil
        else { return nil }
        let segments = comps.path.split(separator: "/").map(String.init).filter { !$0.isEmpty }
        guard segments.count == 2 else { return nil }
        let hint = segments[0]
        let code = segments[1]
        guard hint.wholeMatch(of: #/[A-Za-z0-9][A-Za-z0-9._-]{0,127}/#) != nil,
              code.wholeMatch(of: #/\d{6}/#) != nil
        else { return nil }
        return PendingPair(hostHint: hint, code: code, issuedAt: issuedAtMs)
    }
}
