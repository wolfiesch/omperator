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

    /// Typed view of an `ask.request` event's fields, or nil when this event
    /// is not an ask. Asks carry either `options` (a fixed choice the user
    /// taps) or a free-text `question`; the host clears them with
    /// `ask.resolved`.
    public var askRequest: AskRequest? {
        guard type == "ask.request" else { return nil }
        guard case .string(let askId) = fields["askId"] else { return nil }
        var question: String?
        if case .string(let q) = fields["question"] { question = q }
        var options: [AskOption] = []
        if case .array(let arr) = fields["options"] {
            for item in arr {
                guard case .object(let obj) = item,
                      case .string(let id) = obj["id"],
                      case .string(let label) = obj["label"] else { continue }
                options.append(AskOption(id: id, label: label))
            }
        }
        return AskRequest(askId: askId, question: question, options: options)
    }

    /// True for `ask.resolved` events — clears any pending ask on the client.
    public var isAskResolved: Bool { type == "ask.resolved" }
}

/// One selectable answer in an `ask.request` (host-wire ask surface).
public struct AskOption: Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public init(id: String, label: String) { self.id = id; self.label = label }
}

/// A host-asked question awaiting the user's answer (question mode). Either
/// `options` is non-empty (tap a choice) or `question` is set (free text).
public struct AskRequest: Equatable, Sendable {
    public let askId: String
    public let question: String?
    public let options: [AskOption]
    public var isFreeText: Bool { options.isEmpty }
    public init(askId: String, question: String? = nil, options: [AskOption] = []) {
        self.askId = askId; self.question = question; self.options = options
    }
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
    case snapshot(SnapshotFrame)
    case entry(DurableEntryFrame)
    case gap(GapFrame)
    case agent(AgentFrame)
    case agentState(AgentStateFrame)
    case agentLifecycle(AgentLifecycleFrame)
    case agentProgress(AgentProgressFrame)
    case agentEvent(AgentEventFrame)
    case agentTranscript(AgentTranscriptFrame)
    case terminalOutput(TerminalOutputFrame)
    case terminalExit(TerminalExitFrame)
    case filesList(FilesListFrame)
    case filesRead(FilesReadFrame)
    case filesWrite(FilesWriteFrame)
    case filesPatch(FilesPatchFrame)
    case filesDiff(FilesDiffFrame)
    case auditTail(AuditTailFrame)
    case auditEvent(AuditEventFrame)
    case catalog(CatalogFrame)
    case settings(SettingsFrame)
    case hostWatch(HostWatchFrame)
    case sessionWatch(SessionWatchFrame)
    case sessionState(SessionStateFrame)
    case sessionDelta(SessionDeltaFrame)
    case lease(LeaseFrame)
    case promptLease(PromptLeaseFrame)
    case previewLaunch(PreviewLaunchFrame)
    case previewState(PreviewStateFrame)
    case previewNavigation(PreviewNavigationFrame)
    case previewCapture(PreviewCaptureFrame)
    case previewError(PreviewErrorFrame)
    case legacyTerminal(LegacyTerminalFrame)
    case audit(AuditFrame)
    case files(FileFrame)
    case review(ReviewFrame)

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
        case "snapshot": return .snapshot(try wireDecode(SnapshotFrame.self, from: data))
        case "entry": return .entry(try wireDecode(DurableEntryFrame.self, from: data))
        case "gap": return .gap(try wireDecode(GapFrame.self, from: data))
        case "agent": return .agent(try wireDecode(AgentFrame.self, from: data))
        case "agent.state": return .agentState(try wireDecode(AgentStateFrame.self, from: data))
        case "agent.lifecycle": return .agentLifecycle(try wireDecode(AgentLifecycleFrame.self, from: data))
        case "agent.progress": return .agentProgress(try wireDecode(AgentProgressFrame.self, from: data))
        case "agent.event": return .agentEvent(try wireDecode(AgentEventFrame.self, from: data))
        case "agent.transcript": return .agentTranscript(try wireDecode(AgentTranscriptFrame.self, from: data))
        case "terminal.output": return .terminalOutput(try wireDecode(TerminalOutputFrame.self, from: data))
        case "terminal.exit": return .terminalExit(try wireDecode(TerminalExitFrame.self, from: data))
        case "files.list": return .filesList(try wireDecode(FilesListFrame.self, from: data))
        case "files.read": return .filesRead(try wireDecode(FilesReadFrame.self, from: data))
        case "files.write": return .filesWrite(try wireDecode(FilesWriteFrame.self, from: data))
        case "files.patch": return .filesPatch(try wireDecode(FilesPatchFrame.self, from: data))
        case "files.diff": return .filesDiff(try wireDecode(FilesDiffFrame.self, from: data))
        case "audit.tail": return .auditTail(try wireDecode(AuditTailFrame.self, from: data))
        case "audit.event": return .auditEvent(try wireDecode(AuditEventFrame.self, from: data))
        case "catalog": return .catalog(try wireDecode(CatalogFrame.self, from: data))
        case "settings": return .settings(try wireDecode(SettingsFrame.self, from: data))
        case "host.watch": return .hostWatch(try wireDecode(HostWatchFrame.self, from: data))
        case "session.watch": return .sessionWatch(try wireDecode(SessionWatchFrame.self, from: data))
        case "session.state": return .sessionState(try wireDecode(SessionStateFrame.self, from: data))
        case "session.delta": return .sessionDelta(try wireDecode(SessionDeltaFrame.self, from: data))
        case "lease": return .lease(try wireDecode(LeaseFrame.self, from: data))
        case "prompt.lease": return .promptLease(try wireDecode(PromptLeaseFrame.self, from: data))
        case "preview.launch": return .previewLaunch(try wireDecode(PreviewLaunchFrame.self, from: data))
        case "preview.state": return .previewState(try wireDecode(PreviewStateFrame.self, from: data))
        case "preview.navigation": return .previewNavigation(try wireDecode(PreviewNavigationFrame.self, from: data))
        case "preview.capture": return .previewCapture(try wireDecode(PreviewCaptureFrame.self, from: data))
        case "preview.error": return .previewError(try wireDecode(PreviewErrorFrame.self, from: data))
        case "terminal": return .legacyTerminal(try wireDecode(LegacyTerminalFrame.self, from: data))
        case "audit": return .audit(try wireDecode(AuditFrame.self, from: data))
        case "files": return .files(try wireDecode(FileFrame.self, from: data))
        case "review": return .review(try wireDecode(ReviewFrame.self, from: data))
        default: throw T4WireError.unknownFrame(family: "not yet ported (server): \(type)")
        }
    }
}

/// Encode any encodable frame to the wire (one JSON object per message).
public func encodeFrame<T: Encodable>(_ frame: T) throws -> Data {
    try JSONEncoder().encode(frame)
}
