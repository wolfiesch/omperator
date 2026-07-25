import Foundation

/// Catalog + settings server frames (host-wire/src/additive.ts, the
/// `decodeCatalog` dispatch). `catalog` advertises the available tools/models/
/// commands/skills/agents/providers/modes plus optional operation capabilities;
/// `settings` carries the host's bounded settings map. Both share a
/// `(hostId, revision)` header.

/// How an operation may be executed (OPERATION_EXECUTIONS). Decoded strictly:
/// an unknown raw value fails decode, mirroring `known(...)` in additive.ts.
public enum OperationExecution: String, Codable, Equatable, Sendable {
    case typed
    case headless
    case terminalOnly = "terminal-only"
    case unavailable
}

/// The kind of entry a `CatalogItem` describes (CatalogKind).
public enum CatalogKind: String, Codable, Equatable, Sendable {
    case tool, model, command, setting, skill, agent, provider, mode
}

/// Why an `OperationCapability` is unavailable (OperationDisabledReason).
/// `code` is a control-free tag (<= 128 bytes); `message` is bounded text
/// (<= 2048 bytes). The TS spreads the source object for extra keys; this port
/// keeps the typed, validated fields.
public struct OperationDisabledReason: Decodable, Equatable, Sendable {
    public let code: String
    public let message: String

    private enum CodingKeys: String, CodingKey { case code, message }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        code = try Bounded.controlFree(try c.decode(String.self, forKey: .code), path: "code", maxBytes: 128)
        message = try CatalogFrames.boundedText(try c.decode(String.self, forKey: .message), path: "message", maxBytes: 2048)
    }
}

/// One operation's capability (decodeOperationCapability). `operationId` is an
/// opaque id; `label` is control-free (<= 256); `description` is bounded text
/// (<= 4096); `capabilities` is a bounded array (<= 128) of control-free tags
/// (<= 128 each). Cross-field rules mirror the TS exactly: an unsupported
/// operation must carry a `disabledReason`, a supported one must not, and
/// `terminal-only`/`unavailable` operations cannot be supported.
public struct OperationCapability: Decodable, Equatable, Sendable {
    public let operationId: OperationId
    public let label: String
    public let description: String?
    public let execution: OperationExecution
    public let supported: Bool
    public let disabledReason: OperationDisabledReason?
    public let capabilities: [String]?

    private enum CodingKeys: String, CodingKey {
        case operationId, label, description, execution, supported, disabledReason, capabilities
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        operationId = try IDs.opaque(try c.decode(String.self, forKey: .operationId), path: "operationId")
        label = try Bounded.controlFree(try c.decode(String.self, forKey: .label), path: "label", maxBytes: 256)
        if let d = try c.decodeIfPresent(String.self, forKey: .description) {
            description = try CatalogFrames.boundedText(d, path: "description", maxBytes: 4096)
        } else { description = nil }
        execution = try c.decode(OperationExecution.self, forKey: .execution)
        supported = try c.decode(Bool.self, forKey: .supported)
        disabledReason = try c.decodeIfPresent(OperationDisabledReason.self, forKey: .disabledReason)
        if !supported, disabledReason == nil {
            throw T4WireError.invalidFrame(path: "disabledReason", reason: "unsupported operation requires disabledReason")
        }
        if supported, disabledReason != nil {
            throw T4WireError.invalidFrame(path: "disabledReason", reason: "supported operation cannot have disabledReason")
        }
        if (execution == .terminalOnly || execution == .unavailable), supported {
            throw T4WireError.invalidFrame(path: "supported", reason: "\(execution.rawValue) operation cannot be supported")
        }
        if let caps = try c.decodeIfPresent([String].self, forKey: .capabilities) {
            try CatalogFrames.checkArray(caps, path: "capabilities", max: Limits.maxCapabilities)
            var validated: [String] = []
            validated.reserveCapacity(caps.count)
            for (i, v) in caps.enumerated() {
                validated.append(try Bounded.controlFree(v, path: "capabilities[\(i)]", maxBytes: 128))
            }
            capabilities = validated
        } else { capabilities = nil }
    }
}

/// One catalog entry (decodeCatalogItem). `id` is an opaque catalog id; `kind`
/// is a `CatalogKind`; `name` is control-free (<= 256); `description` is bounded
/// text (<= 4096); `capabilities` is a bounded array (<= 128) of control-free
/// tags (<= 128 each); `reason` is bounded text (<= 2048); `metadata` is a
/// bounded object (boundedMetadata) carried as `JSONValue`.
public struct CatalogItem: Decodable, Equatable, Sendable {
    public let id: CatalogId
    public let kind: CatalogKind
    public let name: String
    public let description: String?
    public let capabilities: [String]?
    public let supported: Bool?
    public let reason: String?
    public let metadata: JSONValue?

    private enum CodingKeys: String, CodingKey {
        case id, kind, name, description, capabilities, supported, reason, metadata
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try IDs.opaque(try c.decode(String.self, forKey: .id), path: "id")
        kind = try c.decode(CatalogKind.self, forKey: .kind)
        name = try Bounded.controlFree(try c.decode(String.self, forKey: .name), path: "name", maxBytes: 256)
        supported = try c.decodeIfPresent(Bool.self, forKey: .supported)
        if let d = try c.decodeIfPresent(String.self, forKey: .description) {
            description = try CatalogFrames.boundedText(d, path: "description", maxBytes: 4096)
        } else { description = nil }
        if let caps = try c.decodeIfPresent([String].self, forKey: .capabilities) {
            try CatalogFrames.checkArray(caps, path: "capabilities", max: Limits.maxCapabilities)
            var validated: [String] = []
            validated.reserveCapacity(caps.count)
            for (i, v) in caps.enumerated() {
                validated.append(try Bounded.controlFree(v, path: "capabilities[\(i)]", maxBytes: 128))
            }
            capabilities = validated
        } else { capabilities = nil }
        if let r = try c.decodeIfPresent(String.self, forKey: .reason) {
            reason = try CatalogFrames.boundedText(r, path: "reason", maxBytes: 2048)
        } else { reason = nil }
        if let md = try c.decodeIfPresent(JSONValue.self, forKey: .metadata) {
            guard case .object = md else {
                throw T4WireError.invalidFrame(path: "metadata", reason: "metadata must be an object")
            }
            metadata = md
        } else {
            metadata = nil
        }
    }
}

/// Host → client: the catalog snapshot (type "catalog"). `items` is a bounded
/// array of `CatalogItem`; `operations` is an optional bounded array of
/// `OperationCapability`.
public struct CatalogFrame: Decodable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let hostId: HostId
    public let revision: Revision
    public let items: [CatalogItem]
    public let operations: [OperationCapability]?

    private enum CodingKeys: String, CodingKey { case v, type, hostId, revision, items, operations }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(String.self, forKey: .v)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: .type) == "catalog" else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected catalog frame")
        }
        v = version; type = "catalog"
        hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "hostId")
        revision = try IDs.opaque(try c.decode(String.self, forKey: .revision), path: "revision")
        let itemValues = try c.decode([CatalogItem].self, forKey: .items)
        try CatalogFrames.checkArray(itemValues, path: "items", max: Limits.maxArrayItems)
        items = itemValues
        if let ops = try c.decodeIfPresent([OperationCapability].self, forKey: .operations) {
            try CatalogFrames.checkArray(ops, path: "operations", max: Limits.maxArrayItems)
            operations = ops
        } else {
            operations = nil
        }
    }
}

/// Host → client: the settings snapshot (type "settings"). `settings` is a
/// bounded settings map (boundedSettings) carried as a `JSONValue` object.
public struct SettingsFrame: Decodable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let hostId: HostId
    public let revision: Revision
    public let settings: JSONValue

    private enum CodingKeys: String, CodingKey { case v, type, hostId, revision, settings }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(String.self, forKey: .v)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: .type) == "settings" else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected settings frame")
        }
        v = version; type = "settings"
        hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "hostId")
        revision = try IDs.opaque(try c.decode(String.self, forKey: .revision), path: "revision")
        let s = try c.decode(JSONValue.self, forKey: .settings)
        guard case .object = s else {
            throw T4WireError.invalidFrame(path: "settings", reason: "settings must be an object")
        }
        settings = s
    }
}

/// Private helpers mirroring guards.ts utilities not yet in `Bounded`.
private enum CatalogFrames {
    /// boundedText (guards.ts): bounded UTF-8 text — allows empty and control
    /// characters, only enforces a byte-length ceiling.
    static func boundedText(_ s: String, path: String, maxBytes: Int) throws -> String {
        if s.utf8.count > maxBytes {
            throw T4WireError.bounds(path: path, reason: "text exceeds \(maxBytes) bytes")
        }
        return s
    }

    /// boundedArray (guards.ts): rejects arrays exceeding `max` items.
    static func checkArray<T>(_ array: [T], path: String, max: Int) throws {
        if array.count > max {
            throw T4WireError.bounds(path: path, reason: "expected bounded array")
        }
    }
}
