import Foundation

/// A frame-paced view of one in-flight assistant message.
///
/// The host remains authoritative and sends complete accumulated snapshots.
/// `advance()` deliberately reveals those snapshots by whole user-perceived
/// characters so provider-sized chunks do not make the native transcript jump.
public struct StreamingAssistantBuffer: Equatable, Sendable {
    public private(set) var text: String
    public private(set) var reasoning: String
    private var targetText: String
    private var targetReasoning: String

    public init(text: String = "", reasoning: String = "") {
        self.text = text
        self.reasoning = reasoning
        targetText = text
        targetReasoning = reasoning
    }

    public var isEmpty: Bool {
        text.isEmpty && reasoning.isEmpty && targetText.isEmpty && targetReasoning.isEmpty
    }

    public var isCaughtUp: Bool {
        text == targetText && reasoning == targetReasoning
    }

    /// Accept the latest complete host snapshot. Non-prefix corrections replace
    /// immediately; ordinary append-only inference remains frame-paced.
    public mutating func receive(text: String, reasoning: String) {
        targetText = text
        targetReasoning = reasoning
        if !text.hasPrefix(self.text) { self.text = text }
        if !reasoning.hasPrefix(self.reasoning) { self.reasoning = reasoning }
    }

    /// Reveal the next grapheme(s), adapting only when the display falls more
    /// than a few frames behind the host.
    @discardableResult
    public mutating func advance(maxCatchUpFrames: Int = 6) -> Bool {
        let frames = max(1, maxCatchUpFrames)
        text = Self.advance(text, toward: targetText, maxCatchUpFrames: frames)
        reasoning = Self.advance(reasoning, toward: targetReasoning, maxCatchUpFrames: frames)
        return !isCaughtUp
    }

    private static func advance(
        _ current: String,
        toward target: String,
        maxCatchUpFrames: Int
    ) -> String {
        guard current != target else { return current }
        guard target.hasPrefix(current) else { return target }
        let remaining = target.dropFirst(current.count)
        let step = max(1, Int(ceil(Double(remaining.count) / Double(maxCatchUpFrames))))
        return current + remaining.prefix(step)
    }
}

public enum LiveToolPhase: String, Equatable, Sendable {
    case generating
    case running
    case succeeded
    case failed
}

/// One transient tool call, from model-generated arguments through execution.
public struct LiveToolCall: Equatable, Identifiable, Sendable {
    public let id: String
    public private(set) var tool: String
    public private(set) var title: String
    public private(set) var input: String
    public private(set) var progress: String
    public private(set) var result: String
    public private(set) var phase: LiveToolPhase
    private var targetInput: String

    fileprivate init(id: String, tool: String) {
        self.id = id
        self.tool = tool
        title = tool
        input = ""
        progress = ""
        result = ""
        phase = .generating
        targetInput = ""
    }

    fileprivate mutating func apply(_ event: SessionEvent) {
        switch event.type {
        case "tool.input.update":
            if let value = event.string("tool"), !value.isEmpty {
                tool = value
                title = value
            }
            if let value = event.string("input") {
                targetInput = Self.retained(value, limit: 65_536)
                if !targetInput.hasPrefix(input) { input = targetInput }
            }
            phase = .generating
        case "tool.start":
            if let value = event.string("tool"), !value.isEmpty { tool = value }
            title = event.string("title").flatMap { $0.isEmpty ? nil : $0 } ?? tool
            if let args = event.fields["args"] {
                targetInput = Self.compactDisplay(args)
                if !targetInput.hasPrefix(input) { input = targetInput }
            }
            phase = .running
        case "tool.progress":
            let update = event.string("chunk") ?? event.string("note") ?? ""
            if !update.isEmpty {
                let separator = progress.isEmpty || event.string("chunk") != nil ? "" : "\n"
                progress = Self.retained(progress + separator + update, limit: 32_768)
            }
            phase = .running
        case "tool.result":
            if let value = event.fields["result"] { result = Self.display(value) }
            phase = event.bool("ok") == false ? .failed : .succeeded
        default:
            break
        }
    }

    fileprivate var isCaughtUp: Bool { input == targetInput }

    fileprivate mutating func advance() {
        guard input != targetInput else { return }
        guard targetInput.hasPrefix(input) else {
            input = targetInput
            return
        }
        let remaining = targetInput.dropFirst(input.count)
        let step = max(1, Int(ceil(Double(remaining.count) / 6.0)))
        input += remaining.prefix(step)
    }

    private static func display(_ value: JSONValue) -> String {
        if case .string(let value) = value { return retained(value, limit: 65_536) }
        guard let data = try? JSONEncoder.sortedPretty.encode(value),
              let output = String(data: data, encoding: .utf8) else { return "" }
        return retained(output, limit: 65_536)
    }

    private static func compactDisplay(_ value: JSONValue) -> String {
        if case .string(let value) = value { return retained(value, limit: 65_536) }
        guard let data = try? JSONEncoder.sortedCompact.encode(value),
              let output = String(data: data, encoding: .utf8) else { return "" }
        return retained(output, limit: 65_536)
    }

    private static func retained(_ value: String, limit: Int) -> String {
        value.count <= limit ? value : "…\(value.suffix(max(0, limit - 1)))"
    }
}

/// Ordered, bounded transient tool state for one attached session.
public struct LiveToolProjection: Equatable, Sendable {
    public private(set) var calls: [LiveToolCall] = []

    public init() {}

    public var isCaughtUp: Bool { calls.allSatisfy(\.isCaughtUp) }

    public mutating func apply(_ event: SessionEvent) {
        guard event.type == "tool.input.update"
                || event.type == "tool.start"
                || event.type == "tool.progress"
                || event.type == "tool.result",
              let callId = event.string("callId"),
              !callId.isEmpty else { return }
        let index: Int
        if let existing = calls.firstIndex(where: { $0.id == callId }) {
            index = existing
        } else {
            calls.append(LiveToolCall(id: callId, tool: event.string("tool") ?? "tool"))
            if calls.count > 32 { calls.removeFirst(calls.count - 32) }
            guard let inserted = calls.firstIndex(where: { $0.id == callId }) else { return }
            index = inserted
        }
        calls[index].apply(event)
    }

    public mutating func remove(callId: String) {
        calls.removeAll { $0.id == callId }
    }

    public mutating func removeAll() {
        calls.removeAll(keepingCapacity: false)
    }

    @discardableResult
    public mutating func advance() -> Bool {
        for index in calls.indices { calls[index].advance() }
        return !isCaughtUp
    }
}

private extension SessionEvent {
    func string(_ key: String) -> String? {
        guard case .string(let value) = fields[key] else { return nil }
        return value
    }

    func bool(_ key: String) -> Bool? {
        guard case .bool(let value) = fields[key] else { return nil }
        return value
    }
}

private extension JSONEncoder {
    static var sortedPretty: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return encoder
    }

    static var sortedCompact: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }
}
