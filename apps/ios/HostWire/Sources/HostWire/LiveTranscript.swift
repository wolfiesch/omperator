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

public enum LiveTurnBlockKind: String, Equatable, Sendable {
    case text
    case thinking
    case toolInput = "tool-input"
}

/// One ordered block in the assistant turn currently being generated.
///
/// OMP sends accumulated block snapshots. The native client retains their
/// original content order and reveals append-only growth by Swift graphemes,
/// matching the TUI's text, thinking, and tool-argument timeline.
public struct LiveTurnBlock: Equatable, Identifiable, Sendable {
    public let id: String
    public let entryId: String
    public let blockIndex: Int
    public let kind: LiveTurnBlockKind
    public private(set) var tool: String
    public private(set) var title: String
    public private(set) var content: String
    public private(set) var progress: String
    public private(set) var result: String
    public private(set) var phase: LiveToolPhase
    private var targetContent: String
    private var callId: String?

    fileprivate init(
        entryId: String,
        blockIndex: Int,
        kind: LiveTurnBlockKind,
        content: String,
        callId: String?,
        tool: String
    ) {
        id = "\(entryId):\(blockIndex)"
        self.entryId = entryId
        self.blockIndex = blockIndex
        self.kind = kind
        self.callId = callId
        self.tool = tool
        title = tool
        self.content = ""
        progress = ""
        result = ""
        phase = .generating
        targetContent = Self.retained(content, limit: 65_536)
    }

    public var toolCallId: String? { callId }
    public var isCaughtUp: Bool { content == targetContent }

    /// A useful partial value while the raw JSON arguments are still invalid.
    /// Write/edit/eval calls therefore look like the TUI: the payload itself
    /// grows, rather than a wall of JSON appearing when parsing finally works.
    public var previewText: String {
        guard kind == .toolInput else { return content }
        let normalized = tool.lowercased()
        let keys: [String]
        switch normalized {
        case "write":
            keys = ["content"]
        case "edit", "patch":
            keys = ["input", "_input", "content"]
        case "eval":
            keys = ["code"]
        case "bash", "shell", "terminal":
            keys = ["cmd", "command"]
        default:
            keys = []
        }
        return StreamingJSONPreview.firstString(in: content, keys: keys) ?? content
    }

    fileprivate mutating func receive(content: String, callId: String?, tool: String?) {
        targetContent = Self.retained(content, limit: 65_536)
        if !targetContent.hasPrefix(self.content) { self.content = targetContent }
        if let callId, !callId.isEmpty { self.callId = callId }
        if let tool, !tool.isEmpty {
            self.tool = tool
            if title.isEmpty { title = tool }
        }
    }

    fileprivate mutating func applyToolLifecycle(_ event: SessionEvent) {
        switch event.type {
        case "tool.start":
            if let value = event.string("tool"), !value.isEmpty { tool = value }
            title = event.string("title").flatMap { $0.isEmpty ? nil : $0 } ?? tool
            // Keep revealing the model-generated snapshot when it is already
            // present. A start frame must not snap past pending characters.
            if targetContent.isEmpty, let args = event.fields["args"] {
                targetContent = Self.compactDisplay(args)
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

    fileprivate mutating func advance(maxCatchUpFrames: Int) {
        guard content != targetContent else { return }
        guard targetContent.hasPrefix(content) else {
            content = targetContent
            return
        }
        let remaining = targetContent.dropFirst(content.count)
        let frames = max(1, maxCatchUpFrames)
        let step = max(1, Int(ceil(Double(remaining.count) / Double(frames))))
        content += remaining.prefix(step)
    }

    fileprivate static func display(_ value: JSONValue) -> String {
        if case .string(let value) = value { return retained(value, limit: 65_536) }
        guard let data = try? JSONEncoder.sortedPretty.encode(value),
              let output = String(data: data, encoding: .utf8) else { return "" }
        return retained(output, limit: 65_536)
    }

    fileprivate static func compactDisplay(_ value: JSONValue) -> String {
        if case .string(let value) = value { return retained(value, limit: 65_536) }
        guard let data = try? JSONEncoder.sortedCompact.encode(value),
              let output = String(data: data, encoding: .utf8) else { return "" }
        return retained(output, limit: 65_536)
    }

    fileprivate static func retained(_ value: String, limit: Int) -> String {
        value.count <= limit ? value : "…\(value.suffix(max(0, limit - 1)))"
    }
}

/// The live assistant turn in wire order, including interleaved thinking,
/// visible response text, and every tool call whose arguments are still being
/// generated or executed.
public struct LiveTurnTimeline: Equatable, Sendable {
    public private(set) var blocks: [LiveTurnBlock] = []

    public init() {}

    public var isEmpty: Bool { blocks.isEmpty }
    public var isCaughtUp: Bool { blocks.allSatisfy(\.isCaughtUp) }

    @discardableResult
    public mutating func apply(_ event: SessionEvent) -> Bool {
        guard event.type == "assistant.block.update",
              let entryId = event.string("entryId"), !entryId.isEmpty,
              let blockIndex = event.int("blockIndex"),
              let rawKind = event.string("blockKind"),
              let kind = LiveTurnBlockKind(rawValue: rawKind),
              let content = event.string("content") else { return false }
        let blockId = "\(entryId):\(blockIndex)"
        if let index = blocks.firstIndex(where: { $0.id == blockId }) {
            blocks[index].receive(
                content: content,
                callId: event.string("callId"),
                tool: event.string("tool")
            )
            return true
        }

        let block = LiveTurnBlock(
            entryId: entryId,
            blockIndex: blockIndex,
            kind: kind,
            content: content,
            callId: event.string("callId"),
            tool: event.string("tool") ?? ""
        )
        if let insertion = blocks.firstIndex(where: {
            $0.entryId == entryId && $0.blockIndex > blockIndex
        }) {
            blocks.insert(block, at: insertion)
        } else {
            blocks.append(block)
        }
        if blocks.count > 64 { blocks.removeFirst(blocks.count - 64) }
        return true
    }

    @discardableResult
    public mutating func applyToolLifecycle(_ event: SessionEvent) -> Bool {
        guard let callId = event.string("callId"),
              let index = blocks.firstIndex(where: { $0.toolCallId == callId }) else {
            return false
        }
        blocks[index].applyToolLifecycle(event)
        return true
    }

    public func contains(callId: String) -> Bool {
        blocks.contains { $0.toolCallId == callId }
    }

    public func hasAssistantBlocks(entryId: String? = nil) -> Bool {
        blocks.contains {
            $0.kind != .toolInput && (entryId == nil || $0.entryId == entryId)
        }
    }

    public func assistantIsCaughtUp(entryId: String? = nil) -> Bool {
        let matching = blocks.filter {
            $0.kind != .toolInput && (entryId == nil || $0.entryId == entryId)
        }
        return !matching.isEmpty && matching.allSatisfy(\.isCaughtUp)
    }

    public func toolIsCaughtUp(callId: String) -> Bool {
        guard let block = blocks.first(where: { $0.toolCallId == callId }) else { return false }
        return block.isCaughtUp
    }

    public mutating func removeAssistantBlocks(entryId: String? = nil) {
        blocks.removeAll {
            $0.kind != .toolInput && (entryId == nil || $0.entryId == entryId)
        }
    }

    public mutating func removeTool(callId: String) {
        blocks.removeAll { $0.toolCallId == callId }
    }

    public mutating func removeAll() {
        blocks.removeAll(keepingCapacity: false)
    }

    @discardableResult
    public mutating func advance(maxCatchUpFrames: Int = 15) -> Bool {
        for index in blocks.indices {
            blocks[index].advance(maxCatchUpFrames: maxCatchUpFrames)
        }
        return !isCaughtUp
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

    func int(_ key: String) -> Int? {
        guard case .number(let value) = fields[key],
              value.rounded() == value,
              value >= Double(Int.min),
              value <= Double(Int.max) else { return nil }
        return Int(value)
    }
}

private enum StreamingJSONPreview {
    static func firstString(in json: String, keys: [String]) -> String? {
        for key in keys {
            if let value = string(in: json, key: key) { return value }
        }
        return nil
    }

    private static func string(in json: String, key: String) -> String? {
        guard let keyRange = json.range(of: "\"\(key)\"") else { return nil }
        var cursor = keyRange.upperBound
        while cursor < json.endIndex, json[cursor].isWhitespace {
            cursor = json.index(after: cursor)
        }
        guard cursor < json.endIndex, json[cursor] == ":" else { return nil }
        cursor = json.index(after: cursor)
        while cursor < json.endIndex, json[cursor].isWhitespace {
            cursor = json.index(after: cursor)
        }
        guard cursor < json.endIndex, json[cursor] == "\"" else { return nil }
        cursor = json.index(after: cursor)

        var output = ""
        while cursor < json.endIndex {
            let character = json[cursor]
            cursor = json.index(after: cursor)
            if character == "\"" { return output }
            guard character == "\\" else {
                output.append(character)
                continue
            }
            guard cursor < json.endIndex else { return output }
            let escaped = json[cursor]
            cursor = json.index(after: cursor)
            switch escaped {
            case "\"": output.append("\"")
            case "\\": output.append("\\")
            case "/": output.append("/")
            case "b": output.append("\u{8}")
            case "f": output.append("\u{c}")
            case "n": output.append("\n")
            case "r": output.append("\r")
            case "t": output.append("\t")
            default:
                // A partial unicode escape is still useful as visible progress.
                output.append("\\")
                output.append(escaped)
            }
        }
        return output
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
