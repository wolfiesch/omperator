import Foundation

/// Typed transcript-entry model decoded from a `DurableEntry`, for rendering
/// transcript rows in the iOS UI.
///
/// `DurableEntry.kind` is an open string on the wire (host-wire/src/entry.ts);
/// `SessionEntryProjector` (host-service/src/discovery.ts) emits exactly five
/// kinds — `message`, `tool-use`, `turn-review`, `compaction` — and the
/// canonical `entry.json` fixture carries a standalone `tool-result`. Unknown
/// kinds decode with `kind == nil` and a defensive headline/body so the UI
/// never loses a row. `data` is carried opaquely; `headline`/`body` are the
/// pragmatic render hints derived from the common per-kind fields.

public enum TranscriptEntryKind: String, Equatable, Sendable {
    case message
    case toolUse = "tool-use"
    case toolResult = "tool-result"
    case turnReview = "turn-review"
    case compaction
}

public struct TranscriptEntry: Equatable, Sendable {
    public let id: EntryId
    public let parentId: EntryId?
    public let hostId: HostId
    public let sessionId: SessionId
    public let turnId: TurnId?
    public let kind: TranscriptEntryKind?
    public let timestamp: String
    public let data: JSONValue
    public let headline: String
    public let body: String

    /// Message-role hint for `.message` entries ("user" / "assistant" / …);
    /// nil for non-message kinds or missing data.
    public var role: String? { data.string("role") }

    /// Wrap a decoded `DurableEntry`, deriving `kind`/`headline`/`body` from
    /// its `data` payload. Unknown kinds yield `kind == nil`,
    /// `headline == entry.kind`, `body == ""`.
    public init(from entry: DurableEntry) {
        id = entry.id
        parentId = entry.parentId
        hostId = entry.hostId
        sessionId = entry.sessionId
        turnId = entry.turnId
        timestamp = entry.timestamp
        data = entry.data
        kind = TranscriptEntryKind(rawValue: entry.kind)

        let (h, b) = TranscriptEntry.headlineBody(kind: kind, rawKind: entry.kind, data: entry.data)
        headline = h
        body = b
    }

    /// Decode a `DurableEntry` from JSON then wrap it.
    public static func decode(_ data: Data) throws -> TranscriptEntry {
        let entry = try JSONDecoder().decode(DurableEntry.self, from: data)
        return TranscriptEntry(from: entry)
    }

    // MARK: - Per-kind headline/body

    private static func headlineBody(
        kind: TranscriptEntryKind?,
        rawKind: String,
        data: JSONValue,
    ) -> (headline: String, body: String) {
        switch kind {
        case .message:
            let role = data.string("role") ?? ""
            let customType = data.string("customType") ?? ""
            let headline: String
            if !customType.isEmpty {
                headline = customType
            } else {
                switch role {
                case "user": headline = "You"
                case "assistant": headline = "Assistant"
                default: headline = role.isEmpty ? "Message" : role
                }
            }
            let text = data.string("text") ?? ""
            let reasoning = data.string("reasoning") ?? ""
            let body = !text.isEmpty ? text : reasoning
            return (headline, body)

        case .toolUse:
            let tool = data.string("tool") ?? ""
            let title = data.string("title") ?? tool
            let headline = !title.isEmpty ? title : (!tool.isEmpty ? tool : "Tool")
            let ok = data.bool("ok") ?? true
            let output = data.object("result")?.string("output") ?? ""
            let body: String
            if !output.isEmpty {
                body = output
            } else {
                body = ok ? "ok" : "error"
            }
            return (headline, body)

        case .toolResult:
            let tool = data.string("tool") ?? ""
            let ok = data.bool("ok") ?? true
            let headline = !tool.isEmpty ? tool : "Tool result"
            return (headline, ok ? "ok" : "error")

        case .turnReview:
            let changes = data.array("changes")?.count ?? 0
            let headline = "Turn review"
            let body = changes == 0 ? "" : "\(changes) change\(changes == 1 ? "" : "s")"
            return (headline, body)

        case .compaction:
            let headline = "Compaction"
            let body = data.string("summary") ?? data.string("shortSummary") ?? ""
            return (headline, body)

        case .none:
            return (rawKind, "")
        }
    }
}

// MARK: - JSONValue accessors
extension JSONValue {
    /// Read a string field from an object value. Non-string values are ignored.
    func string(_ key: String) -> String? {
        guard case .object(let o) = self, case .string(let s) = o[key] ?? .null else { return nil }
        return s
    }

    /// Read a bool field from an object value. Non-bool values are ignored.
    func bool(_ key: String) -> Bool? {
        guard case .object(let o) = self, case .bool(let b) = o[key] ?? .null else { return nil }
        return b
    }

    /// Read a nested object field from an object value.
    func object(_ key: String) -> JSONValue? {
        guard case .object(let o) = self, let v = o[key], case .object = v else { return nil }
        return v
    }

    /// Read a nested array field from an object value.
    func array(_ key: String) -> [JSONValue]? {
        guard case .object(let o) = self, let v = o[key], case .array(let a) = v else { return nil }
        return a
    }

    /// Read a number field from an object value as a Double.
    func number(_ key: String) -> Double? {
        guard case .object(let o) = self, case .number(let n) = o[key] ?? .null else { return nil }
        return n
    }
}
