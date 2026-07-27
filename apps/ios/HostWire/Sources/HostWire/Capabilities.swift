import Foundation

/// Device capabilities a client may hold (capabilities.DEVICE_CAPABILITIES).
public enum DeviceCapability: String, Codable, CaseIterable, Sendable {
    case sessionsRead = "sessions.read"
    case sessionsPrompt = "sessions.prompt"
    case sessionsControl = "sessions.control"
    case sessionsManage = "sessions.manage"
    case bashRun = "bash.run"
    case terminalOpen = "term.open"
    case terminalInput = "term.input"
    case terminalResize = "term.resize"
    case filesRead = "files.read"
    case filesWrite = "files.write"
    case filesList = "files.list"
    case filesDiff = "files.diff"
    case agentsControl = "agents.control"
    case auditRead = "audit.read"
    case configRead = "config.read"
    case catalogRead = "catalog.read"
    case configWrite = "config.write"
    case brokerRead = "broker.read"
    case usageRead = "usage.read"
    case previewRead = "preview.read"
    case previewControl = "preview.control"
    case previewInput = "preview.input"
    case ciTrigger = "ci.trigger"
}

/// Negotiable protocol features (capabilities.PROTOCOL_FEATURES). The wire
/// carries these as strings; a newer client may name an unknown feature, so
/// requested-feature lists tolerate unknown values while granted lists are
/// strict (see `Capabilities.strictFeatures`).
public enum ProtocolFeature: String, Codable, CaseIterable, Sendable {
    case resume
    case hostWatch = "host.watch"
    case sessionWatch = "session.watch"
    case sessionState = "session.state"
    case sessionDelta = "session.delta"
    case sessionObserver = "session.observer"
    case sessionUnverified = "session.unverified"
    case sessionFork = "session.fork"
    case controllerLease = "controller.lease"
    case promptLease = "prompt.lease"
    case promptImages = "prompt.images"
    case transcriptImages = "transcript.images"
    case transcriptSearch = "transcript.search"
    case transcriptPage = "transcript.page"
    case projectReveal = "project.reveal"
    case agentLifecycle = "agent.lifecycle"
    case agentProgress = "agent.progress"
    case agentEvent = "agent.event"
    case agentTranscript = "agent.transcript"
    case terminalIO = "terminal.io"
    case filesList = "files.list"
    case filesSearch = "files.search"
    case filesDiff = "files.diff"
    case auditTail = "audit.tail"
    case catalogMetadata = "catalog.metadata"
    case settingsMetadata = "settings.metadata"
    case previewControl = "preview.control"
    case runtimeAdapters = "runtime.adapters"
    case workspaceLifecycle = "workspace.lifecycle"
    case clusterOperator = "cluster.operator"
}

/// `{ client: string[], server?: string[] }` — every entry must be a known
/// device capability (capabilities.decodeCapabilities).
public struct Capabilities: Codable, Equatable, Sendable {
    public let client: [String]
    public let server: [String]?

    public init(client: [String], server: [String]? = nil) {
        self.client = client
        self.server = server
    }

    private enum CodingKeys: String, CodingKey { case client, server }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let cl = try c.decode([String].self, forKey: .client)
        let sv = try c.decodeIfPresent([String].self, forKey: .server)
        try Capabilities.validate(cl, path: "client")
        if let sv { try Capabilities.validate(sv, path: "server") }
        client = cl
        server = sv
    }

    private static let known = Set(DeviceCapability.allCases.map(\.rawValue))

    /// Reject unknown capabilities (strict — used for capabilities + granted).
    public static func validate(_ values: [String], path: String) throws {
        for value in values where !known.contains(value) {
            throw T4WireError.invalidFrame(path: "capabilities.\(path)", reason: "unknown device capability \(value)")
        }
    }

    /// Additive feature list (capabilities.decodeFeatureList): bounded strings,
    /// unknown names tolerated so a newer client can negotiate forward.
    public static func requestedFeatures(_ values: [String], path: String) throws -> [String] {
        try values.enumerated().map { index, value in
            try Bounded.controlFree(value, path: "\(path)[\(index)]", maxBytes: 128)
        }
    }

    /// Strict feature list (capabilities.decodeNegotiatedFeatureList): every
    /// entry must be a known protocol feature.
    public static func strictFeatures(_ values: [String], path: String) throws -> [ProtocolFeature] {
        let knownFeatures = Set(ProtocolFeature.allCases.map(\.rawValue))
        return try values.enumerated().map { index, value in
            _ = try Bounded.controlFree(value, path: "\(path)[\(index)]", maxBytes: 128)
            guard knownFeatures.contains(value) else {
                throw T4WireError.invalidFrame(path: "\(path)[\(index)]", reason: "unknown protocol feature \(value)")
            }
            return ProtocolFeature(rawValue: value)!
        }
    }
}
