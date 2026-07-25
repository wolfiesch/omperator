import Foundation

/// Command frame + the descriptor registry (host-wire/src/command.ts).
///
/// `CommandFrame` is the client → host command envelope. Construction and
/// decode both validate against the descriptor table: scope (host vs session),
/// revision requirement, and confirmation requirement — exactly as
/// `decodeCommand` does. Per-command argument/result payload typing (the bulk of
/// command.ts) is deferred; `args` is carried as an opaque object and results
/// are read via typed accessors on `ResultFrame` (e.g. session-list results).

public enum CommandScope: String, Sendable { case host, session }
public enum RevisionRequirement: Sendable { case none, optional, required }
public enum ConfirmationRequirement: Sendable { case none, challenge }

public struct CommandDescriptor: Sendable, Equatable {
    public let capability: DeviceCapability
    public let scope: CommandScope
    public let revision: RevisionRequirement
    public let confirmation: ConfirmationRequirement

    public init(capability: DeviceCapability, scope: CommandScope, revision: RevisionRequirement, confirmation: ConfirmationRequirement) {
        self.capability = capability
        self.scope = scope
        self.revision = revision
        self.confirmation = confirmation
    }
}

public enum Commands {
    /// Descriptors for the rail + core session commands. Mirrors the
    /// COMMAND_DESCRIPTORS entries in command.ts; the long tail (settings,
    /// files, terminal, review, agents, usage, preview, cluster) lands later.
    public static let descriptors: [String: CommandDescriptor] = [
        "runtime.list":       .init(capability: .sessionsRead,   scope: .host,    revision: .none,     confirmation: .none),
        "workspace.list":     .init(capability: .sessionsRead,   scope: .host,    revision: .none,     confirmation: .none),
        "workspace.create":   .init(capability: .sessionsManage, scope: .host,    revision: .none,     confirmation: .none),
        "workspace.import":   .init(capability: .sessionsManage, scope: .host,    revision: .none,     confirmation: .none),
        "workspace.archive":  .init(capability: .sessionsManage, scope: .host,    revision: .none,     confirmation: .challenge),
        "workspace.recover":  .init(capability: .sessionsManage, scope: .host,    revision: .none,     confirmation: .none),
        "host.list":          .init(capability: .sessionsRead,   scope: .host,    revision: .none,     confirmation: .none),
        "session.list":       .init(capability: .sessionsRead,   scope: .host,    revision: .none,     confirmation: .none),
        "project.reveal":     .init(capability: .sessionsManage, scope: .host,    revision: .none,     confirmation: .none),
        "session.create":     .init(capability: .sessionsManage, scope: .host,    revision: .none,     confirmation: .none),
        "session.fork":       .init(capability: .sessionsManage, scope: .session, revision: .none,     confirmation: .none),
        "session.attach":     .init(capability: .sessionsRead,   scope: .session, revision: .none,     confirmation: .none),
        "session.prompt":     .init(capability: .sessionsPrompt, scope: .session, revision: .optional, confirmation: .none),
        "session.steer":      .init(capability: .sessionsPrompt, scope: .session, revision: .optional, confirmation: .none),
        "session.followUp":   .init(capability: .sessionsPrompt, scope: .session, revision: .optional, confirmation: .none),
        "session.image.begin":   .init(capability: .sessionsPrompt, scope: .session, revision: .none, confirmation: .none),
        "session.image.chunk":    .init(capability: .sessionsPrompt, scope: .session, revision: .none, confirmation: .none),
        "session.image.discard":  .init(capability: .sessionsPrompt, scope: .session, revision: .none, confirmation: .none),
        "session.image.read":     .init(capability: .sessionsRead,   scope: .session, revision: .none, confirmation: .none),
        "artifact.read":          .init(capability: .sessionsRead,   scope: .session, revision: .none, confirmation: .none),
        "session.state.get":      .init(capability: .sessionsRead,   scope: .session, revision: .none, confirmation: .none),
        "session.rename":      .init(capability: .sessionsManage, scope: .session, revision: .required, confirmation: .none),
        "session.retry":       .init(capability: .sessionsControl, scope: .session, revision: .required, confirmation: .none),
        "session.compact":     .init(capability: .sessionsControl, scope: .session, revision: .required, confirmation: .none),
        "session.pause":       .init(capability: .sessionsControl, scope: .session, revision: .required, confirmation: .none),
        "session.resume":      .init(capability: .sessionsControl, scope: .session, revision: .required, confirmation: .none),
        "session.archive":     .init(capability: .sessionsManage, scope: .session, revision: .required, confirmation: .none),
        "session.restore":     .init(capability: .sessionsManage, scope: .session, revision: .required, confirmation: .none),
        "session.delete":      .init(capability: .sessionsManage, scope: .session, revision: .required, confirmation: .none),
    ]

    public static func descriptor(for command: String) -> CommandDescriptor? {
        descriptors[command]
    }
}

/// Client → host command envelope (command.CommandFrame).
public struct CommandFrame: Codable, Equatable, Sendable {
    public let v: String
    public let type: String
    public let requestId: RequestId
    public let commandId: CommandId
    public let hostId: HostId
    public let sessionId: SessionId?
    public let command: String
    public let expectedRevision: Revision?
    public let confirmationId: ConfirmationId?
    public let args: [String: JSONValue]

    private enum CodingKeys: String, CodingKey {
        case v, type, requestId, commandId, hostId, sessionId, command
        case expectedRevision, confirmationId, args
    }

    /// Construct a command to send. Validates against the descriptor table.
    public init(
        requestId: RequestId,
        commandId: CommandId,
        hostId: HostId,
        command: String,
        args: [String: JSONValue] = [:],
        sessionId: SessionId? = nil,
        expectedRevision: Revision? = nil,
        confirmationId: ConfirmationId? = nil,
        v: String = Wire.protocolVersion
    ) throws {
        try CommandFrame.validate(
            command: command, descriptor: Commands.descriptor(for: command),
            sessionId: sessionId, expectedRevision: expectedRevision, confirmationId: confirmationId
        )
        _ = try IDs.opaque(requestId, path: "requestId")
        _ = try IDs.opaque(commandId, path: "commandId")
        _ = try IDs.opaque(hostId, path: "hostId")
        if let sessionId { _ = try IDs.opaque(sessionId, path: "sessionId") }
        self.v = v
        self.type = "command"
        self.requestId = requestId
        self.commandId = commandId
        self.hostId = hostId
        self.sessionId = sessionId
        self.command = command
        self.expectedRevision = expectedRevision
        self.confirmationId = confirmationId
        self.args = args
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let version = try c.decode(String.self, forKey: .v)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: .type) == "command" else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected command frame")
        }
        let command = try Bounded.controlFree(try c.decode(String.self, forKey: .command), path: "command", maxBytes: 128)
        let sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
        let expectedRevision = try c.decodeIfPresent(String.self, forKey: .expectedRevision)
        let confirmationId = try c.decodeIfPresent(String.self, forKey: .confirmationId)
        try CommandFrame.validate(
            command: command, descriptor: Commands.descriptor(for: command),
            sessionId: sessionId, expectedRevision: expectedRevision, confirmationId: confirmationId
        )
        if let expectedRevision { _ = try IDs.opaque(expectedRevision, path: "expectedRevision") }
        if let confirmationId { _ = try IDs.opaque(confirmationId, path: "confirmationId") }
        v = version
        type = "command"
        requestId = try IDs.opaque(try c.decode(String.self, forKey: .requestId), path: "requestId")
        commandId = try IDs.opaque(try c.decode(String.self, forKey: .commandId), path: "commandId")
        hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "hostId")
        self.sessionId = sessionId
        self.command = command
        self.expectedRevision = expectedRevision
        self.confirmationId = confirmationId
        args = try c.decodeIfPresent([String: JSONValue].self, forKey: .args) ?? [:]
    }

    /// Enforce scope / revision / confirmation rules (decodeCommand core).
    private static func validate(
        command: String, descriptor: CommandDescriptor?,
        sessionId: String?, expectedRevision: String?, confirmationId: String?
    ) throws {
        guard let descriptor else {
            throw T4WireError.invalidFrame(path: "command", reason: "unknown command")
        }
        switch descriptor.scope {
        case .session where sessionId == nil:
            throw T4WireError.invalidFrame(path: "sessionId", reason: "sessionId is required for session command")
        case .host where sessionId != nil:
            throw T4WireError.invalidFrame(path: "sessionId", reason: "sessionId is forbidden for host command")
        default:
            break
        }
        switch descriptor.revision {
        case .none where expectedRevision != nil:
            throw T4WireError.invalidFrame(path: "expectedRevision", reason: "expectedRevision is forbidden")
        case .required where expectedRevision == nil:
            throw T4WireError.invalidFrame(path: "expectedRevision", reason: "expectedRevision is required")
        default:
            break
        }
        if descriptor.confirmation == .none, confirmationId != nil {
            throw T4WireError.invalidFrame(path: "confirmationId", reason: "confirmationId is not valid")
        }
    }
}

extension ResultFrame {
    /// Decode a `catalog.get` result body: `{revision, items}`.
    public func catalogItems() throws -> [CatalogItem] {
        guard ok, let result, case .object(let o) = result, let items = o["items"]
        else {
            throw T4WireError.invalidFrame(path: "result", reason: "response has no catalog result")
        }
        return try JSONDecoder().decode([CatalogItem].self, from: JSONEncoder().encode(items))
    }

    /// Decode a `session.image.begin` result body: `{imageId, chunkBytes}`.
    public func imageBeginResult() throws -> (imageId: String, chunkBytes: Int) {
        guard ok, let result, case .object(let o) = result,
              case .string(let imageId) = o["imageId"] ?? .null,
              case .number(let chunkBytes) = o["chunkBytes"] ?? .null, chunkBytes > 0
        else {
            throw T4WireError.invalidFrame(path: "result", reason: "response has no image begin result")
        }
        return (imageId, Int(chunkBytes))
    }

    /// Decode a `session.list` / `host.list` result body, when this response
    /// carries one. Throws if the response is not a session-list result.
    public func sessionListResult() throws -> SessionListResult {
        guard ok, let result else {
            throw T4WireError.invalidFrame(path: "result", reason: "response has no result")
        }
        let data = try JSONEncoder().encode(result)
        return try JSONDecoder().decode(SessionListResult.self, from: data)
    }
}
