import Foundation

/// Opaque identifier typealiases. host-wire brands these at the TS level
/// (string & { __hostId }); Swift keeps them as validated `String` aliases for
/// Codable ergonomics. Every value is validated as a bounded control-free
/// non-empty string (<= 256 bytes) at the point of decode.
public typealias HostId = String
public typealias SessionId = String
public typealias ProjectId = String
public typealias EntryId = String
public typealias AgentId = String
public typealias TerminalId = String
public typealias RequestId = String
public typealias CommandId = String
public typealias PairingId = String
public typealias ConfirmationId = String
public typealias Revision = String
public typealias WatchId = String
public typealias LeaseId = String
public typealias OperationId = String
public typealias PreviewId = String
public typealias PreviewCaptureId = String
public typealias CatalogId = String
public typealias DeviceId = String
public typealias ImageId = String
public typealias ArtifactId = String
public typealias TurnId = String

/// A (host, session) pair — the standard session locator.
public struct SessionKey: Equatable, Hashable, Sendable {
    public let hostId: HostId
    public let sessionId: SessionId
    public init(hostId: HostId, sessionId: SessionId) {
        self.hostId = hostId
        self.sessionId = sessionId
    }
}

/// Identifier validators (host-wire/src/ids.ts).
public enum IDs {
    /// Generic opaque id: bounded control-free non-empty string (<= 256 bytes).
    public static func opaque(_ s: String, path: String, maxBytes: Int = Limits.maxIdBytes) throws -> String {
        try Bounded.controlFree(s, path: path, maxBytes: maxBytes)
    }

    /// UUIDv4 lowercase hex (ids.imageId).
    public static func image(_ s: String, path: String = "imageId") throws -> String {
        let value = try Bounded.controlFree(s, path: path, maxBytes: 36)
        guard value.wholeMatch(of: #/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/#) != nil else {
            throw T4WireError.invalidFrame(path: path, reason: "expected an opaque image identifier")
        }
        return value
    }

    /// Numeric opaque id (ids.artifactId).
    public static func artifact(_ s: String, path: String = "artifactId") throws -> String {
        let value = try Bounded.controlFree(s, path: path, maxBytes: 64)
        guard value.wholeMatch(of: #/[0-9]+/#) != nil else {
            throw T4WireError.invalidFrame(path: path, reason: "expected a numeric opaque artifact identifier")
        }
        return value
    }
}
