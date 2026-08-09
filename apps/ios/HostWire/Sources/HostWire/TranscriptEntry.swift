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

    /// Stable OMP tool-call id carried by durable tool rows.
    public var toolCallId: String? { data.string("toolCallId") }

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

    /// Render a tool output safely: when the payload parses as JSON, walk it
    /// for text/content/thinking strings and join them; a structured value
    /// with no readable text falls back to a pretty JSON dump. Plain text
    /// passes through untouched.
    public static func readableOutput(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let data = trimmed.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) else {
            return raw
        }
        var parts: [String] = []
        func walk(_ value: Any) {
            if let text = value as? String {
                // A string that is itself JSON (double-encoded payload) must
                // be walked, not shown verbatim.
                if let nested = text.data(using: .utf8),
                   let inner = try? JSONSerialization.jsonObject(with: nested),
                   !(inner is String) {
                    walk(inner)
                } else {
                    parts.append(text)
                }
            } else if let array = value as? [Any] {
                for item in array { walk(item) }
            } else if let dict = value as? [String: Any] {
                // Prose keys first; skip metadata keys.
                for key in ["text", "content", "thinking", "output", "message"] {
                    if let value = dict[key] { walk(value) }
                }
            }
        }
        walk(object)
        let joined = parts.joined(separator: "\n")
        if !joined.isEmpty { return joined }
        // No prose: never dump raw JSON — the row shows the ok/error state.
        return ""
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
                // Never let a raw JSON dump reach the row: walk it for the
                // readable text blocks and pretty-print only as a fallback.
                body = Self.readableOutput(output)
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
    public func string(_ key: String) -> String? {
        guard case .object(let o) = self, case .string(let s) = o[key] ?? .null else { return nil }
        return s
    }

    /// Read a bool field from an object value. Non-bool values are ignored.
    public func bool(_ key: String) -> Bool? {
        guard case .object(let o) = self, case .bool(let b) = o[key] ?? .null else { return nil }
        return b
    }

    /// Read a nested object field from an object value.
    public func object(_ key: String) -> JSONValue? {
        guard case .object(let o) = self, let v = o[key], case .object = v else { return nil }
        return v
    }

    /// Read a nested array field from an object value.
    public func array(_ key: String) -> [JSONValue]? {
        guard case .object(let o) = self, let v = o[key], case .array(let a) = v else { return nil }
        return a
    }

    /// Read a number field from an object value as a Double.
    public func number(_ key: String) -> Double? {
        guard case .object(let o) = self, case .number(let n) = o[key] ?? .null else { return nil }
        return n
    }
}
