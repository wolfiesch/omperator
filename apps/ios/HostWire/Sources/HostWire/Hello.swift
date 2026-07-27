import Foundation

/// hello/welcome handshake (host-wire/src/hello.ts).

/// `{ min: "omp-app/1", max: "omp-app/1" }` — protocol range offered by client.
public struct ProtocolRange: Codable, Equatable, Sendable {
    public let min: String
    public let max: String
    public init(min: String, max: String) { self.min = min; self.max = max }

    private enum CodingKeys: String, CodingKey { case min, max }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let mn = try c.decode(String.self, forKey: .min)
        let mx = try c.decode(String.self, forKey: .max)
        let minMaj = try Hello.protocolMajor(mn, path: "protocol.min")
        let maxMaj = try Hello.protocolMajor(mx, path: "protocol.max")
        guard minMaj <= maxMaj else {
            throw T4WireError.unsupportedProtocol(path: "protocol", reason: "protocol range is inverted")
        }
        min = mn
        max = mx
    }
}

/// `{ name, version, build, platform }` — who the client is.
public struct ClientIdentity: Codable, Equatable, Sendable {
    public let name: String
    public let version: String
    public let build: String
    public let platform: String

    public init(name: String, version: String, build: String, platform: String) {
        self.name = name; self.version = version; self.build = build; self.platform = platform
    }

    private enum CodingKeys: String, CodingKey { case name, version, build, platform }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try Bounded.controlFree(try c.decode(String.self, forKey: .name), path: "client.name", maxBytes: 128)
        version = try Bounded.controlFree(try c.decode(String.self, forKey: .version), path: "client.version", maxBytes: 64)
        build = try Bounded.controlFree(try c.decode(String.self, forKey: .build), path: "client.build", maxBytes: 128)
        platform = try Bounded.controlFree(try c.decode(String.self, forKey: .platform), path: "client.platform", maxBytes: 128)
    }
}

/// A saved resume point the client offers in hello.
public struct SavedCursor: Codable, Equatable, Sendable {
    public let hostId: HostId
    public let sessionId: SessionId
    public let cursor: Cursor

    public init(hostId: HostId, sessionId: SessionId, cursor: Cursor) {
        self.hostId = hostId; self.sessionId = sessionId; self.cursor = cursor
    }

    private enum CodingKeys: String, CodingKey { case hostId, sessionId, cursor }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "savedCursors.hostId")
        sessionId = try IDs.opaque(try c.decode(String.self, forKey: .sessionId), path: "savedCursors.sessionId")
        cursor = try c.decode(Cursor.self, forKey: .cursor)
    }
}

/// The first client frame (hello.decodeHello).
public struct HelloFrame: Codable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let protocolRange: ProtocolRange
    public let client: ClientIdentity
    public let requestedFeatures: [String]
    public let savedCursors: [SavedCursor]
    public let capabilities: Capabilities?
    public let authentication: DeviceAuthentication?

    public init(
        v: String = Wire.protocolVersion,
        protocolRange: ProtocolRange,
        client: ClientIdentity,
        requestedFeatures: [String],
        savedCursors: [SavedCursor],
        capabilities: Capabilities? = nil,
        authentication: DeviceAuthentication? = nil
    ) {
        self.v = v; self.type = "hello"
        self.protocolRange = protocolRange; self.client = client
        self.requestedFeatures = requestedFeatures; self.savedCursors = savedCursors
        self.capabilities = capabilities; self.authentication = authentication
    }

    private enum CodingKeys: String, CodingKey {
        case v, type, protocolRange = "protocol", client, requestedFeatures, savedCursors, capabilities, authentication
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(String.self, forKey: .v)
        guard version == Wire.protocolVersion else {
            throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion)
        }
        let type = try c.decode(String.self, forKey: .type)
        guard type == "hello" else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected hello frame")
        }
        let range = try c.decode(ProtocolRange.self, forKey: .protocolRange)
        // The host speaks omp-app/1; the offered range must include major 1.
        let minMaj = try Hello.protocolMajor(range.min, path: "protocol.min")
        let maxMaj = try Hello.protocolMajor(range.max, path: "protocol.max")
        guard minMaj <= 1, maxMaj >= 1 else {
            throw T4WireError.unsupportedProtocol(path: "protocol", reason: "no supported protocol in range")
        }
        let features = try Capabilities.requestedFeatures(
            try c.decode([String].self, forKey: .requestedFeatures), path: "requestedFeatures"
        )
        let cursors = try c.decode([SavedCursor].self, forKey: .savedCursors)
        guard cursors.count <= Limits.maxSavedCursors else {
            throw T4WireError.bounds(path: "savedCursors", reason: "too many saved cursors")
        }
        v = version
        self.type = type
        protocolRange = range
        client = try c.decode(ClientIdentity.self, forKey: .client)
        requestedFeatures = features
        savedCursors = cursors
        capabilities = try c.decodeIfPresent(Capabilities.self, forKey: .capabilities)
        authentication = try c.decodeIfPresent(DeviceAuthentication.self, forKey: .authentication)
    }
}

public enum WelcomeAuth: String, Codable, Equatable, Sendable {
    case local
    case pairingRequired = "pairing-required"
    case paired
}

/// The host's hello reply (hello.decodeWelcome).
public struct WelcomeFrame: Decodable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let selectedProtocol: String
    public let hostId: HostId
    public let ompVersion: String
    public let ompBuild: String
    public let appserverVersion: String
    public let appserverBuild: String
    public let epoch: String
    public let grantedCapabilities: [String]
    public let grantedFeatures: [ProtocolFeature]
    public let negotiatedLimits: [String: JSONValue]
    public let authentication: WelcomeAuth
    public let resumed: Bool

    private enum CodingKeys: String, CodingKey {
        case v, type, selectedProtocol, hostId, ompVersion, ompBuild
        case appserverVersion, appserverBuild, epoch, grantedCapabilities, grantedFeatures
        case negotiatedLimits, authentication, resumed
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(String.self, forKey: .v)
        guard version == Wire.protocolVersion else {
            throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion)
        }
        let type = try c.decode(String.self, forKey: .type)
        guard type == "welcome" else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected welcome frame")
        }
        let selected = try Bounded.controlFree(try c.decode(String.self, forKey: .selectedProtocol), path: "selectedProtocol", maxBytes: 64)
        guard selected == Wire.protocolVersion else {
            throw T4WireError.unsupportedProtocol(path: "selectedProtocol", reason: "unsupported selected protocol")
        }
        let auth = try c.decode(WelcomeAuth.self, forKey: .authentication)
        let granted = try c.decode([String].self, forKey: .grantedCapabilities)
        try Capabilities.validate(granted, path: "grantedCapabilities")
        if auth == .pairingRequired, !granted.isEmpty {
            throw T4WireError.invalidFrame(path: "grantedCapabilities", reason: "pairing-required welcome must grant no capabilities")
        }
        v = version
        self.type = type
        selectedProtocol = selected
        hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "hostId")
        ompVersion = try Bounded.controlFree(try c.decode(String.self, forKey: .ompVersion), path: "ompVersion", maxBytes: 64)
        ompBuild = try Bounded.controlFree(try c.decode(String.self, forKey: .ompBuild), path: "ompBuild", maxBytes: 128)
        appserverVersion = try Bounded.controlFree(try c.decode(String.self, forKey: .appserverVersion), path: "appserverVersion", maxBytes: 64)
        appserverBuild = try Bounded.controlFree(try c.decode(String.self, forKey: .appserverBuild), path: "appserverBuild", maxBytes: 128)
        epoch = try Bounded.controlFree(try c.decode(String.self, forKey: .epoch), path: "epoch", maxBytes: Limits.maxEpochBytes)
        grantedCapabilities = granted
        grantedFeatures = try Capabilities.strictFeatures(try c.decode([String].self, forKey: .grantedFeatures), path: "grantedFeatures")
        negotiatedLimits = try c.decode([String: JSONValue].self, forKey: .negotiatedLimits)
        authentication = auth
        resumed = try c.decode(Bool.self, forKey: .resumed)
    }
}

public enum Hello {
    /// Parse `omp-app/<positive integer>` and return its major version.
    static func protocolMajor(_ text: String, path: String) throws -> Int {
        guard let match = text.wholeMatch(of: #/omp-app\/([1-9]\d*)/#),
              let major = Int(match.1)
        else {
            throw T4WireError.unsupportedProtocol(path: path, reason: "protocol must be omp-app/<positive integer>")
        }
        return major
    }
}
