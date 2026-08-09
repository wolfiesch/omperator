import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

//  T4CollabWire.swift
//  Collab wire protocol for T4CollabGuest: link parsing, AES-256-GCM
//  sealing, envelope packing, and the public frame/data types shared by the
//  guest and its consumers.
//
//  Protocol mirror of @oh-my-pi/collab-web (src/lib/{link,crypto,frames}.ts,
//  COLLAB_PROTO = 3) and the Enclave EngineBridge guest (~/dev/Enclave/
//  Sources/EngineBridge.swift). All host frames arrive as sealed binary
//  envelopes `[4B peerId][12B IV][ciphertext+16B tag]`; TEXT messages are
//  relay control frames and are never encrypted.

// MARK: - Wire constants

/// Collab wire constants (pi-wire/src/index.ts).
enum T4CollabWire {
    static let proto = 3
    /// Envelope header: [4B uint32 big-endian peerId]; guests always send 0.
    static let envelopeHeader = 4
    static let roomKeyBytes = 32
    static let writeTokenBytes = 16
    static let defaultRelay = "wss://my.omp.sh"
    /// Relay close codes that are terminal — never reconnect: 4001 room
    /// closed, 4004 no such room, 4009 host taken, 4029 room full.
    static let fatalCloseCodes: Set<Int> = [4001, 4004, 4009, 4029]
}

// MARK: - base64url

/// RFC 4648 base64url without padding, used for link keys and the write token.
enum T4Base64URL {
    static func decode(_ text: String) -> Data? {
        var s = text.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s.append("=") }
        return Data(base64Encoded: s)
    }

    static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

// MARK: - Collab link

/// Link parse outcome: a parsed link or a user-presentable rejection reason.
enum T4CollabLinkParse {
    case ok(T4CollabLink)
    case err(String)
}

/// A parsed collab link: relay WebSocket URL plus the room key (and the
/// optional 16-byte write token that upgrades a view-only link to full access).
struct T4CollabLink {
    let wsURL: URL
    let key: SymmetricKey
    let writeToken: Data?

    /// Accepts the compact bare form (`<roomId>.<key>` → default relay), a
    /// legacy `roomId#key` form, a scheme-less `host/r/<roomId>.<key>` (→ wss),
    /// or a full ws/wss URL. The key is base64url: 32 bytes = view-only,
    /// 48 bytes = full access (32B key + 16B write token).
    static func parse(_ raw: String) -> T4CollabLinkParse {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "%23", with: "#", options: .caseInsensitive)
        guard !text.isEmpty else { return .err("Paste a collab link.") }

        // Bare `<roomId>.<key>` or legacy `<roomId>#<key>` → default relay.
        if text.range(of: #"^([A-Za-z0-9_-]{10,64})[#.]([A-Za-z0-9_-]+)$"#, options: .regularExpression) != nil {
            let parts = text.split(whereSeparator: { $0 == "#" || $0 == "." })
            if parts.count == 2 { text = "\(T4CollabWire.defaultRelay)/r/\(parts[0]).\(parts[1])" }
        } else if !text.contains("://") {
            text = "wss://\(text)"       // scheme-less host/r/… → wss
        }

        guard let url = URLComponents(string: text), let scheme = url.scheme, let host = url.host else {
            return .err("That doesn't look like a collab link.")
        }
        // A browser web link — what omp's QR encodes — carries the collab link
        // in the URL fragment: `https://my.omp.sh/#<roomId>.<key>`. Unwrap and
        // re-parse the fragment as the link.
        if scheme == "http" || scheme == "https", let frag = url.fragment, !frag.isEmpty {
            return parse(frag)
        }
        let wsScheme: String
        switch scheme {
        case "wss", "https": wsScheme = "wss"
        case "ws", "http":
            let local = host == "localhost" || host == "127.0.0.1" || host == "::1"
            if !local { return .err("Plain ws:// is only allowed for localhost — use wss://.") }
            wsScheme = "ws"
        default: return .err("Unsupported scheme: \(scheme)")
        }

        // Path `/r/<roomId>.<key>` or legacy `/r/<roomId>` with the key in the fragment.
        guard url.path.range(of: #"^/r/([A-Za-z0-9_-]{10,64})(\.[A-Za-z0-9_-]+)?$"#, options: .regularExpression) != nil else {
            return .err("Link must contain a /r/<roomId> path.")
        }
        let pathBody = String(url.path.dropFirst(3))  // after "/r/"
        let roomId: String
        var fragment: String?
        if let dot = pathBody.firstIndex(of: ".") {
            roomId = String(pathBody[..<dot])
            fragment = String(pathBody[pathBody.index(after: dot)...])
        } else {
            roomId = pathBody
            fragment = url.fragment
        }
        guard let frag = fragment, !frag.isEmpty, let secret = T4Base64URL.decode(frag) else {
            return .err("Link is missing the key part.")
        }
        guard secret.count == T4CollabWire.roomKeyBytes || secret.count == T4CollabWire.roomKeyBytes + T4CollabWire.writeTokenBytes else {
            return .err("Key must be 32 (view) or 48 (full) bytes.")
        }
        let keyData = secret.prefix(T4CollabWire.roomKeyBytes)
        let writeToken = secret.count > T4CollabWire.roomKeyBytes ? Data(secret.suffix(T4CollabWire.writeTokenBytes)) : nil
        let portPart = url.port.map { ":\($0)" } ?? ""
        guard let ws = URL(string: "\(wsScheme)://\(host)\(portPart)/r/\(roomId)") else {
            return .err("Could not build the relay URL.")
        }
        return .ok(T4CollabLink(wsURL: ws, key: SymmetricKey(data: keyData), writeToken: writeToken))
    }
}

// MARK: - AES-256-GCM

extension T4CollabWire {
    /// Seal a frame as `[12B IV][ciphertext+16B tag]` — WebCrypto's layout,
    /// which is exactly CryptoKit's `SealedBox.combined`. Returns nil if the
    /// frame is not JSON-serializable.
    static func seal(_ frame: [String: Any], key: SymmetricKey) -> Data? {
        guard let plain = try? JSONSerialization.data(withJSONObject: frame),
              let box = try? AES.GCM.seal(plain, using: key)
        else { return nil }
        return box.combined
    }

    /// Open a sealed payload (already stripped of the envelope header) back
    /// into a JSON object. Nil = bad key or corrupted frame — the caller must
    /// treat that as a terminal fault, never a retry.
    static func open(_ payload: Data, key: SymmetricKey) -> [String: Any]? {
        guard payload.count > 12,
              let box = try? AES.GCM.SealedBox(combined: payload),
              let plain: Data = try? AES.GCM.open(box, using: key),
              let obj = try? JSONSerialization.jsonObject(with: plain) as? [String: Any]
        else { return nil }
        return obj
    }
}

// MARK: - JSONValue bridging

extension JSONValue {
    /// Lossy-but-safe conversion of a `JSONSerialization`-style `Any` value
    /// (NSNull / Bool / NSNumber / String / NSArray / NSDictionary) into
    /// `JSONValue`. Returns nil for values JSON cannot represent.
    static func fromAny(_ value: Any) -> JSONValue? {
        switch value {
        case is NSNull: return .null
        case let b as Bool: return .bool(b)
        case let n as NSNumber: return .number(n.doubleValue)
        case let s as String: return .string(s)
        case let a as [Any]:
            var out: [JSONValue] = []
            out.reserveCapacity(a.count)
            for item in a {
                guard let j = fromAny(item) else { return nil }
                out.append(j)
            }
            return .array(out)
        case let o as [String: Any]:
            var out: [String: JSONValue] = [:]
            out.reserveCapacity(o.count)
            for (k, v) in o {
                guard let j = fromAny(v) else { return nil }
                out[k] = j
            }
            return .object(out)
        default:
            return nil
        }
    }
}

// MARK: - Public data types

/// One collab message (the `message` field of an entry). JSON-lenient: the
/// `content` payload is carried raw as either a JSON string (user text) or a
/// content-block array.
public struct T4CollabWireMessage: Sendable, Equatable {
    public let role: String?
    public let content: JSONValue?
    /// toolResult identity lives at the message level on the wire; the
    /// decoder used to drop it, which made every tool card render as "tool".
    public let toolName: String?
    public let toolCallId: String?
    public let isError: Bool?

    init(json: [String: Any]) {
        self.role = json["role"] as? String
        self.content = json["content"].flatMap(JSONValue.fromAny)
        self.toolName = json["toolName"] as? String
        self.toolCallId = json["toolCallId"] as? String
        self.isError = json["isError"] as? Bool
    }
}

/// One collab transcript entry. JSON-lenient: the identity fields are typed
/// with empty-string defaults, everything else is best-effort, and unknown
/// fields are dropped.
public struct T4CollabWireEntry: Sendable, Equatable {
    public let id: String
    public let parentId: String?
    public let type: String
    public let timestamp: String
    public let message: T4CollabWireMessage?
    public let customType: String?
    public let summary: String?

    init(json: [String: Any]) {
        self.id = json["id"] as? String ?? ""
        self.parentId = json["parentId"] as? String
        self.type = json["type"] as? String ?? ""
        self.timestamp = json["timestamp"] as? String ?? ""
        self.message = (json["message"] as? [String: Any]).map(T4CollabWireMessage.init(json:))
        self.customType = json["customType"] as? String
        self.summary = json["summary"] as? String ?? json["shortSummary"] as? String
    }
}

/// One collab event (`message_start`/`message_update`/`message_end`,
/// `tool_execution_*`, `notice`, …). JSON-lenient: only `type` is required;
/// everything else is best-effort, with raw JSON for object-shaped payloads.
public struct T4CollabEvent: Sendable, Equatable {
    public let type: String
    /// The event's `message` — a string for `notice` events, or the raw
    /// message object for `message_*` events.
    public let message: JSONValue?
    public let toolCallId: String?
    public let toolName: String?
    public let result: JSONValue?
    public let args: JSONValue?
    /// Notice severity ("info"/"warning"/"error") when the event is a notice.
    public let level: String?

    init(json: [String: Any]) {
        self.type = json["type"] as? String ?? ""
        self.message = json["message"].flatMap(JSONValue.fromAny)
        self.toolCallId = json["toolCallId"] as? String
        self.toolName = json["toolName"] as? String
        self.result = json["result"].flatMap(JSONValue.fromAny)
        self.args = json["args"].flatMap(JSONValue.fromAny)
        self.level = json["level"] as? String
    }
}

/// A frame the guest yields to consumers, mirroring the collab host frames.
///
/// Terminal conditions — user `close()`, a host `bye`, a relay `room-closed`,
/// a fatal close code, a decryption failure, or an `error` frame that arrives
/// before the welcome — end the `frames` stream; the terminal frame (when
/// there is one) is yielded immediately before the stream ends.
public enum T4CollabFrame: Sendable, Equatable {
    /// The host's session header plus the snapshot size. Resets the snapshot
    /// accumulation: previous `snapshotChunk` entries must be discarded.
    case welcome(header: T4CollabWireEntry, entryCount: Int)
    /// One snapshot batch; accumulate entries until `final` is true.
    case snapshotChunk(entries: [T4CollabWireEntry], final: Bool)
    case entry(T4CollabWireEntry)
    case event(T4CollabEvent)
    case state(isStreaming: Bool, modelId: String?, thinkingLevel: String?)
    /// The /enclave plugin's capability announcement: model ids, command
    /// names, and the currently selected model id.
    case enclaveCaps(models: [String], commands: [String], current: String?)
    /// Reply to an /enclave control command (ok + optional message + the
    /// request id it answers).
    case enclaveResult(ok: Bool, message: String?, reqId: Int?)
    /// A host question awaiting a `sendUiResponse` answer.
    case uiRequest(reqId: Int, kind: String, title: String, options: [String]?, helpText: String?, prefill: String?)
    /// A host/transport fault. Terminal when it precedes the welcome.
    case error(message: String)
    /// The session ended (host `bye` or relay `room-closed`); the stream
    /// terminates after this frame.
    case bye(reason: String)
}
