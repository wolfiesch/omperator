//  EngineBridge.swift
//  The live oh-my-pi collab guest client. This is the ONLY file that talks the
//  wire protocol: it parses a `/collab` link, opens the relay WebSocket, seals
//  and opens AES-256-GCM frames, applies host frames in arrival order, and
//  projects the omp transcript onto the app's `[UITurn]` shape so every existing
//  view renders live data unchanged.
//
//  Protocol mirror of @oh-my-pi/collab-web (src/lib/{client,socket,codec,link}.ts)
//  and the shared wire types in @oh-my-pi/pi-wire. COLLAB_PROTO = 3.
//
//    let client = GuestClient(link: "ws://localhost:7466/r/<id>.<key>", name: "iPhone")
//    client.connect()          // → client.turns streams; feed EditorView via SessionVM
//    client.sendPrompt("…")    // steer / prompt the host agent
//    client.sendAbort()        // stop the current turn

import Foundation
import CryptoKit
import Combine

// ═══════════════════════════════════════════════════════════════════════════
// Wire constants (pi-wire/src/index.ts)
// ═══════════════════════════════════════════════════════════════════════════

private enum Wire {
    static let proto = 3
    static let envelopeHeader = 4         // [4B uint32 BE peerId]
    static let roomKeyBytes = 32
    static let writeTokenBytes = 16
    static let defaultRelay = "wss://my.omp.sh"
}

// ═══════════════════════════════════════════════════════════════════════════
// base64url
// ═══════════════════════════════════════════════════════════════════════════

enum Base64URL {
    static func decode(_ text: String) -> Data? {
        var s = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
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

// ═══════════════════════════════════════════════════════════════════════════
// Collab link → { wsURL, key, writeToken }
// ═══════════════════════════════════════════════════════════════════════════

enum LinkParse {
    case ok(CollabLink)
    case err(String)
}

struct CollabLink {
    let wsURL: URL          // wss://host[:port]/r/<roomId>
    let key: SymmetricKey
    let writeToken: Data?

    /// Accepts the compact bare form (`<roomId>.<key>` → default relay), a
    /// scheme-less `host/r/<roomId>.<key>` (→ wss), or a full ws/wss URL.
    static func parse(_ raw: String) -> LinkParse {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "%23", with: "#", options: .caseInsensitive)
        if text.isEmpty { return .err("Paste a collab link.") }

        // Bare `<roomId>.<key>` or legacy `<roomId>#<key>` → default relay.
        if let m = text.range(of: #"^([A-Za-z0-9_-]{10,64})[#.]([A-Za-z0-9_-]+)$"#, options: .regularExpression) {
            _ = m
            let parts = text.split(whereSeparator: { $0 == "#" || $0 == "." })
            if parts.count == 2 { text = "\(Wire.defaultRelay)/r/\(parts[0]).\(parts[1])" }
        } else if !text.contains("://") {
            text = "wss://\(text)"       // scheme-less host/r/… → wss
        }

        guard let url = URLComponents(string: text), let scheme = url.scheme, let host = url.host else {
            return .err("That doesn't look like a collab link.")
        }
        // A browser web link — what omp's QR encodes — carries the collab link in
        // the URL fragment: `https://my.omp.sh/#<roomId>.<key>`. Unwrap and parse it.
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

        // Path `/r/<roomId>.<key>` or legacy `/r/<roomId>` with key in the fragment.
        guard let match = url.path.range(of: #"^/r/([A-Za-z0-9_-]{10,64})(\.[A-Za-z0-9_-]+)?$"#, options: .regularExpression) else {
            return .err("Link must contain a /r/<roomId> path.")
        }
        _ = match
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
        guard let frag = fragment, !frag.isEmpty, let secret = Base64URL.decode(frag) else {
            return .err("Link is missing the key part.")
        }
        guard secret.count == Wire.roomKeyBytes || secret.count == Wire.roomKeyBytes + Wire.writeTokenBytes else {
            return .err("Key must be 32 (view) or 48 (full) bytes.")
        }
        let keyData = secret.prefix(Wire.roomKeyBytes)
        let writeToken = secret.count > Wire.roomKeyBytes ? Data(secret.suffix(Wire.writeTokenBytes)) : nil
        let portPart = url.port.map { ":\($0)" } ?? ""
        guard let ws = URL(string: "\(wsScheme)://\(host)\(portPart)/r/\(roomId)") else {
            return .err("Could not build the relay URL.")
        }
        return .ok(CollabLink(wsURL: ws, key: SymmetricKey(data: keyData), writeToken: writeToken))
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// AES-256-GCM sealing. WebCrypto's `[12B IV][ciphertext+tag]` layout is exactly
// CryptoKit's `SealedBox.combined` (nonce ∥ ciphertext ∥ tag).
// ═══════════════════════════════════════════════════════════════════════════

private enum Seal {
    static func open(_ key: SymmetricKey, _ data: Data) -> [String: Any]? {
        guard data.count > 12,
              let box = try? AES.GCM.SealedBox(combined: data),
              let plain = try? AES.GCM.open(box, using: key),
              let obj = try? JSONSerialization.jsonObject(with: plain) as? [String: Any]
        else { return nil }
        return obj
    }
    static func seal(_ key: SymmetricKey, _ frame: [String: Any]) -> Data? {
        guard let plain = try? JSONSerialization.data(withJSONObject: frame),
              let box = try? AES.GCM.seal(plain, using: key)
        else { return nil }
        return box.combined     // 12B nonce + ciphertext + 16B tag
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// WebSocket transport: `?role=guest`, binary sealed envelopes, text control.
// ═══════════════════════════════════════════════════════════════════════════

private final class CollabSocket: NSObject, URLSessionWebSocketDelegate {
    var onOpen: (() -> Void)?
    var onFrame: (([String: Any]) -> Void)?
    var onControl: (([String: Any]) -> Void)?
    var onUnexpectedClose: ((String) -> Void)?

    private let wsURL: URL
    private let key: SymmetricKey
    private var task: URLSessionWebSocketTask?
    private var closed = false
    private var intentionalClose = false
    private var generation = 0

    init(wsURL: URL, key: SymmetricKey) { self.wsURL = wsURL; self.key = key }

    func connect() {
        intentionalClose = false
        closed = false
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        generation += 1
        let gen = generation
        var comps = URLComponents(url: wsURL, resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "role", value: "guest")]
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        let task = session.webSocketTask(with: comps.url!)
        // A snapshot chunk carrying browser screenshots easily exceeds the 1MB default,
        // and an oversized frame is silently dropped → an empty transcript. Give it room.
        task.maximumMessageSize = 128 * 1024 * 1024
        self.task = task
        task.resume()
        receive(gen)
    }

    func close() {
        intentionalClose = true
        closed = true
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    /// Seal a guest frame and send it as `[4B peerId=0][sealed]`.
    func send(_ frame: [String: Any]) {
        guard let sealed = Seal.seal(key, frame) else { return }
        var env = Data(count: Wire.envelopeHeader)   // peerId 0, big-endian
        env.append(sealed)
        task?.send(.data(env)) { _ in }
    }

    func urlSession(_ s: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol proto: String?) {
        guard webSocketTask === task else { return }
        onOpen?()
    }
    func urlSession(_ s: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith code: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard webSocketTask === task else { return }
        fail("connection closed (\(code.rawValue))")
    }

    private func receive(_ gen: Int) {
        task?.receive { [weak self] result in
            guard let self, self.generation == gen else { return }
            guard !self.closed else { return }
            switch result {
            case .failure(let err):
                self.fail(err.localizedDescription)
                return
            case .success(let message):
                switch message {
                case .data(let data):
                    if data.count > Wire.envelopeHeader {
                        let payload = data.subdata(in: Wire.envelopeHeader..<data.count)
                        if let frame = Seal.open(self.key, payload) { self.onFrame?(frame) }
                        else { self.fail("bad key or corrupted frame") }
                    }
                case .string(let text):
                    if let obj = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] {
                        self.onControl?(obj)
                    }
                @unknown default: break
                }
                self.receive(gen)
            }
        }
    }

    private func fail(_ reason: String) {
        guard !intentionalClose, !closed else { return }
        closed = true
        onUnexpectedClose?(reason)
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// GuestClient — session replica + transcript projection + commands.
// ═══════════════════════════════════════════════════════════════════════════

@MainActor
final class GuestClient: ObservableObject {
    // Published surface the UI observes.
    @Published private(set) var turns: [UITurn] = []
    @Published private(set) var phase: String = "connecting"   // connecting/waiting/live/ended
    @Published private(set) var working = false
    @Published private(set) var title = "session"
    @Published private(set) var cwd = "~"
    @Published private(set) var modelName = "—"
    @Published private(set) var tokensLabel = "—"
    @Published private(set) var costLabel = "—"
    @Published private(set) var endedReason: String?
    @Published private(set) var readOnly = false

    // Trust / Activity surfaces.
    @Published private(set) var sessionId = ""
    @Published private(set) var relay = "—"
    @Published private(set) var thinkingLevel = "—"
    @Published private(set) var contextPercent: Double?
    @Published private(set) var queued = 0
    @Published private(set) var participants: [ParticipantInfo] = []
    @Published private(set) var agents: [AgentInfo] = []
    @Published private(set) var progress: [SubagentProgress] = []

    // /enclave enhanced capabilities — all false/empty over plain /collab.
    @Published private(set) var enhanced = false        // an /enclave host is present
    @Published private(set) var canSendImages = false   // image is actually understandable now
    @Published private(set) var nativeVision = false    // current model sees images directly
    @Published private(set) var visionModelAvailable = false // a vision model exists (fallback could be enabled)
    @Published private(set) var commands: [EnclaveCommand] = []
    @Published private(set) var models: [ModelOption] = []
    @Published private(set) var thinkingLevels: [String] = []
    private(set) var joinLink = ""                        // the link this guest joined with (to invite others)

    /// Fired after every applied frame (SessionVM bridges this to its own publish).
    var onChange: (() -> Void)?

    private let socket: CollabSocket
    private let name: String
    private let writeToken: Data?
    private var reqSeq = 0
    private var pendingTranscripts: [Int: CheckedContinuation<(text: String, newSize: Int)?, Never>] = [:]
    private var pendingControl: [Int: CheckedContinuation<String?, Never>] = [:]
    private var pendingImageFetches: [Int: CheckedContinuation<(data: String, mimeType: String)?, Never>] = [:]
    private var fetchedImages: [String: String] = [:]     // imagePath → "data:<mime>;base64,<data>"
    private var imageFetchAttempted: Set<String> = []     // imagePath; suppress retry storms
    private var progressMap: [String: SubagentProgress] = [:]

    // Replica state.
    private var entries: [[String: Any]] = []
    private var stream: [String: Any]?          // streaming assistant ghost
    private var streamDone = false
    private var activeTools: [(id: String, tool: [String: Any])] = []
    private var uiRequest: [String: Any]?
    // Thinking-duration timing: from the first thinking content to the first answer
    // text, stamped onto the finalizing entry so its block shows "thought for Xs".
    private var thinkStart: Date?
    private var thoughtSeconds: Int?
    private var thoughtForEntry: [String: Int] = [:]
    @Published private(set) var welcomed = false   // a host actually answered (got a welcome)
    @Published private(set) var plan: [PlanPhase] = []   // latest `todo` tool plan (phases → tasks)
    @Published private(set) var goal: GoalInfo?          // goal mode's active objective
    @Published private(set) var activity: String?        // transient host activity (retrying / compacting / fallback)
    @Published private(set) var currentMode: String?    // active mode from the last mode_change entry (e.g. "plan"); nil = none
    @Published private(set) var notices: [NoticeItem] = [] // host toasts (rate limits, tool failures)
    private var planKey = ""                              // UserDefaults key for this room's cached plan
    private var terminated = false                          // host deliberately ended (bye / room-closed / pre-welcome error) — never reconnect
    private var reconnectAttempt = 0
    private var reconnectTask: Task<Void, Never>?
    var justPaired = false                          // joined via a fresh QR pair → show a paired notice

    // Incremental rebuild caches: avoid reprocessing the entire `entries` array on every
    // streaming frame. `cachedStaticTurns` is derived from `entries`; `cachedTail` is the
    // dynamic suffix (pending send, active tools, stream, ui-request, notices). When only the
    // tail changes, we rebuild just that suffix instead of walking all history.
    private var cachedStaticTurns: [UITurn] = []
    private var cachedTail: [UITurn] = []
    private var cachedEntryCount: Int = 0
    // Streaming rebuild coalescing: message_update frames arrive faster than the
    // display can render. Instead of rebuilding + publishing on every token, flush
    // at most once per ~33ms (30fps). The last stream state wins; intermediate
    // tokens are never rendered — smooth streaming instead of a slideshow.
    private var streamRebuildPending = false
    private var lastStreamRebuild: Date = .distantPast
    private let streamCoalesceInterval: TimeInterval = 1.0 / 30.0
    private var skipRebuild = false   // set by applyEvent to suppress applyFrame's immediate rebuild

    init?(link: String, name: String) {
        switch CollabLink.parse(link) {
        case .err: return nil
        case .ok(let parsed):
            self.name = name
            self.writeToken = parsed.writeToken
            self.readOnly = parsed.writeToken == nil
            self.relay = (parsed.wsURL.host ?? "—") + (parsed.wsURL.port.map { ":\($0)" } ?? "")
            self.socket = CollabSocket(wsURL: parsed.wsURL, key: parsed.key)
            self.planKey = "enclave.plan." + parsed.wsURL.absoluteString
            self.joinLink = link
        }
        // Show the last known plan immediately, before the snapshot reconnects/loads.
        plan = Self.loadPlan(planKey)
        socket.onOpen = { [weak self] in Task { @MainActor in self?.handleOpen() } }
        socket.onFrame = { [weak self] f in Task { @MainActor in self?.applyFrame(f) } }
        socket.onControl = { [weak self] c in Task { @MainActor in
            if c["t"] as? String == "room-closed" { self?.end("room closed") }
        } }
        socket.onUnexpectedClose = { [weak self] r in Task { @MainActor in self?.scheduleReconnect(reason: r) } }
    }

    /// `nil` when the pasted link doesn't parse — surface the reason to the user.
    static func validate(_ link: String) -> String? {
        if case .err(let reason) = CollabLink.parse(link) { return reason }
        return nil
    }

    func connect() { socket.connect() }

    func close() {
        terminated = true
        reconnectTask?.cancel()
        reconnectAttempt = 0
        socket.close()
    }

    private func backoff(for attempt: Int) -> TimeInterval {
        TimeInterval([1, 2, 4, 8, 16][min(attempt, 4)])
    }

    private func scheduleReconnect(reason: String) {
        guard !terminated, phase != "ended" else { return }
        reconnectTask?.cancel()
        guard reconnectAttempt < 5 else {
            phase = "ended"; endedReason = "reconnect failed · \(reason)"; working = false
            rebuild()
            return
        }
        let delay = backoff(for: reconnectAttempt)
        reconnectAttempt += 1
        phase = "reconnecting"
        rebuild()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            if Task.isCancelled { return }
            self?.socket.connect()
        }
    }

    func reconnectIfNeeded() {
        // Only act when the connection is actually dead/retrying — NOT on the initial
        // launch (phase == "connecting") or while live. Host-ended (terminated) is final.
        guard !terminated, phase == "reconnecting" || phase == "ended" else { return }
        reconnectTask?.cancel()
        reconnectAttempt = 0
        phase = "reconnecting"
        rebuild()
        socket.connect()
    }

    // ── commands ─────────────────────────────────────────────────────────────

    // Optimistic echo: show your own message the instant you send it, until the host
    // echoes it back (its collab-prompt entry). A big image round-trips slowly, so
    // without this the transcript looks empty until the reply lands.
    private var pendingSendText: String?
    private var pendingSendImage: String?
    private var pendingSendBaseline = 0

    private func collabPromptCount() -> Int {
        entries.reduce(0) { $0 + (($1["customType"] as? String) == "collab-prompt" ? 1 : 0) }
    }

    func sendPrompt(_ text: String, images: [(mime: String, base64: String)] = []) {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty || !images.isEmpty else { return }
        var frame: [String: Any] = ["t": "prompt", "text": clean]
        if !images.isEmpty {
            frame["images"] = images.map { ["type": "image", "mimeType": $0.mime, "data": $0.base64] }
        }
        socket.send(frame)
        pendingSendBaseline = collabPromptCount()
        pendingSendText = clean
        pendingSendImage = images.first.map { "data:\($0.mime);base64,\($0.base64)" }
        rebuild()
    }
    func sendAbort() { socket.send(["t": "abort"]) }
    func answer(reqId: Int, value: String?) {
        var frame: [String: Any] = ["t": "ui-response", "reqId": reqId]
        if let value { frame["value"] = value }
        socket.send(frame)
    }

    // ── /enclave control channel (no-ops unless the plugin is present) ────────

    /// Send a control command and await its result. Returns nil on success, or an
    /// error message. (Frames are simply ignored by a plain /collab host.)
    @discardableResult
    func sendControl(_ method: String, _ params: [String: Any] = [:]) async -> String? {
        guard enhanced else { return "this session isn't running /enclave" }
        reqSeq += 1
        let reqId = reqSeq
        return await withCheckedContinuation { cont in
            pendingControl[reqId] = cont
            socket.send(["t": "enclave-cmd", "reqId": reqId, "method": method, "params": params])
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 8_000_000_000)
                if let c = self?.pendingControl.removeValue(forKey: reqId) { c.resume(returning: "timed out") }
            }
        }
    }

    @discardableResult func setModel(_ id: String) async -> String? { await sendControl("set-model", ["model": id]) }
    @discardableResult func setThinking(_ level: String) async -> String? { await sendControl("set-thinking", ["level": level]) }
    @discardableResult func runSlash(_ name: String, args: String = "") async -> String? { await sendControl("slash", ["name": name, "args": args]) }
    @discardableResult func rewind(to entryId: String) async -> String? { await sendControl("rewind", ["toEntryId": entryId]) }

    /// The entry id just before `entryId` — the point to rewind to for an edit-replace.
    func entryBefore(_ entryId: String) -> String? {
        guard let i = entries.firstIndex(where: { $0["id"] as? String == entryId }), i > 0 else { return nil }
        return entries[i - 1]["id"] as? String
    }

    /// Chat with / kill / revive a subagent (agent-cmd guest frame).
    func sendAgentCmd(_ cmd: String, agentId: String, text: String? = nil) {
        var frame: [String: Any] = ["t": "agent-cmd", "cmd": cmd, "agentId": agentId]
        if let text { frame["text"] = text }
        socket.send(frame)
    }

    /// Incremental subagent-transcript read (fetch-transcript). Returns decoded
    /// JSONL from `fromByte` + the next offset base, or nil on timeout/failure.
    func fetchTranscript(agentId: String, fromByte: Int) async -> (text: String, newSize: Int)? {
        reqSeq += 1
        let reqId = reqSeq
        return await withCheckedContinuation { cont in
            pendingTranscripts[reqId] = cont
            socket.send(["t": "fetch-transcript", "reqId": reqId, "agentId": agentId, "fromByte": fromByte])
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                if let c = self?.pendingTranscripts.removeValue(forKey: reqId) { c.resume(returning: nil) }
            }
        }
    }

    func fetchImage(path: String, mimeType: String?) async -> (data: String, mimeType: String)? {
        guard enhanced else { return nil }
        reqSeq += 1
        let reqId = reqSeq
        return await withCheckedContinuation { cont in
            pendingImageFetches[reqId] = cont
            var params: [String: Any] = ["path": path]
            if let mimeType { params["mimeType"] = mimeType }
            socket.send(["t": "enclave-cmd", "reqId": reqId, "method": "fetch-image", "params": params])
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 8_000_000_000)
                if let c = self?.pendingImageFetches.removeValue(forKey: reqId) { c.resume(returning: nil) }
            }
        }
    }

    // ── frame handling (mirrors client.ts #applyFrame) ────────────────────────

    private func handleOpen() {
        var hello: [String: Any] = ["t": "hello", "proto": Wire.proto, "name": name]
        if let token = writeToken { hello["writeToken"] = Base64URL.encode(token) }
        socket.send(hello)
        phase = welcomed ? "reconnecting" : "waiting"
    }

    private func applyFrame(_ f: [String: Any]) {
        guard let t = f["t"] as? String else { return }
        if ProcessInfo.processInfo.environment["ENCLAVE_DEBUG"] != nil {
            let note: String
            switch t {
            case "event":
                note = "type=\((f["event"] as? [String: Any])?["type"] as? String ?? "?")"
            case "state":
                let streaming = (f["state"] as? [String: Any])?["isStreaming"]
                note = "isStreaming=\((streaming as? Bool).map { $0 ? "true" : "false" } ?? "?")"
            case "entry":
                let entry = f["entry"] as? [String: Any]
                note = "type=\(entry?["type"] as? String ?? "?") role=\(entry?["role"] as? String ?? "?")"
            default:
                note = ""
            }
            NSLog("eb:frame t=%@ %@", t, note)
        }
        skipRebuild = false
        switch t {
        case "welcome":
            welcomed = true
            reconnectAttempt = 0
            reconnectTask?.cancel()
            entries = []; cachedStaticTurns = []; cachedEntryCount = 0; cachedTail = []
            stream = nil; streamDone = false; activeTools = []; uiRequest = nil
            progressMap = [:]; progress = []
            enhanced = false; canSendImages = false; nativeVision = false; visionModelAvailable = false; commands = []
            endedReason = nil
            currentMode = nil
            if let header = f["header"] as? [String: Any] {
                title = header["title"] as? String ?? header["id"] as? String ?? title
                sessionId = header["id"] as? String ?? sessionId
            }
            applyState(f["state"] as? [String: Any])
            applyAgents(f["agents"] as? [[String: Any]])
            readOnly = f["readOnly"] as? Bool ?? readOnly
            phase = (f["entryCount"] as? Int ?? 0) == 0 ? "live" : "waiting"
            // Dev seam: inject a canned ui-request so the questionnaire surface can be
            // exercised in the simulator without a live omp host.
            if let mode = ProcessInfo.processInfo.environment["ENCLAVE_ASK_MOCK"], !mode.isEmpty {
                uiRequest = mockAsk(mode); rebuild()
            }
            // Dev seam: force plan-review state for QA.
            if let m = ProcessInfo.processInfo.environment["ENCLAVE_PLAN_MOCK"], !m.isEmpty {
                currentMode = "plan"; working = false; rebuild()
            }
        case "snapshot-chunk":
            if let list = f["entries"] as? [[String: Any]] { entries.append(contentsOf: list) }
            if f["final"] as? Bool == true { phase = "live" }
        case "entry":
            if let e = f["entry"] as? [String: Any] {
                entries.append(e)
                if isAssistantMessage(e) {
                    if streamDone { stream = nil; streamDone = false }
                    // Stamp the thinking duration onto this finalizing message. Fall back to
                    // "now − thinkStart" so a thinking→tool message (no text) still shows it.
                    if let eid = e["id"] as? String, let start = thinkStart, entryHasThinking(e) {
                        thoughtForEntry[eid] = thoughtSeconds ?? max(1, Int(Date().timeIntervalSince(start).rounded()))
                    }
                    thinkStart = nil; thoughtSeconds = nil   // next message in the turn measures fresh
                }
            }
        case "event":
            applyEvent(f["event"] as? [String: Any])
        case "state":
            applyState(f["state"] as? [String: Any])
        case "agents":
            applyAgents(f["agents"] as? [[String: Any]])
        case "bus":
            applyBus(channel: f["channel"] as? String, data: f["data"] as? [String: Any])
        case "transcript":
            if let reqId = f["reqId"] as? Int, let cont = pendingTranscripts.removeValue(forKey: reqId) {
                if f["error"] != nil { cont.resume(returning: nil) }
                else { cont.resume(returning: (f["text"] as? String ?? "", f["newSize"] as? Int ?? fromByteFallback)) }
            }
        case "enclave-caps":            // the /enclave host announcing its powers
            enhanced = true
            canSendImages = f["vision"] as? Bool ?? false
            nativeVision = f["nativeVision"] as? Bool ?? true   // absent → assume native (no hint)
            visionModelAvailable = f["visionModelAvailable"] as? Bool ?? false
            commands = (f["commands"] as? [[String: Any]] ?? []).map {
                EnclaveCommand(name: $0["name"] as? String ?? "", summary: $0["summary"] as? String ?? $0["description"] as? String ?? "")
            }
            models = (f["models"] as? [[String: Any]] ?? []).map {
                ModelOption(modelId: $0["id"] as? String ?? "", name: $0["name"] as? String ?? ($0["id"] as? String ?? ""), vision: $0["vision"] as? Bool ?? false)
            }
            if let levels = f["thinking"] as? [String] { thinkingLevels = levels }
            if let cur = f["current"] as? [String: Any], let th = cur["thinking"] as? String { thinkingLevel = th }
            imageFetchAttempted.removeAll()
            cachedStaticTurns = []; cachedEntryCount = 0
        case "enclave-result":          // reply to a control command
            if let reqId = f["reqId"] as? Int,
               let cont = pendingImageFetches.removeValue(forKey: reqId) {
                if (f["ok"] as? Bool ?? true), let data = f["data"] as? String {
                    cont.resume(returning: (data, f["mimeType"] as? String ?? "image/png"))
                } else {
                    cont.resume(returning: nil)
                }
                break
            }
            if let reqId = f["reqId"] as? Int, let cont = pendingControl.removeValue(forKey: reqId) {
                cont.resume(returning: (f["ok"] as? Bool ?? true) ? nil : (f["message"] as? String ?? "failed"))
            }
        case "ui-request":
            uiRequest = f["request"] as? [String: Any]
        case "ui-request-end":
            if (uiRequest?["reqId"] as? Int) == (f["reqId"] as? Int) { uiRequest = nil }
        case "bye":
            end(f["reason"] as? String ?? "session ended"); return
        case "error":
            if !welcomed { end(f["message"] as? String ?? "host error"); return }
        default:
            break
        }
        if skipRebuild {
            skipRebuild = false
        } else {
            rebuild()
        }
    }

    private var fromByteFallback: Int { 0 }

    private func applyAgents(_ list: [[String: Any]]?) {
        guard let list else { return }
        agents = list.map { a in
            AgentInfo(id: a["id"] as? String ?? UUID().uuidString,
                      displayName: a["displayName"] as? String ?? "agent",
                      kind: a["kind"] as? String ?? "sub",
                      status: a["status"] as? String ?? "idle",
                      hasSessionFile: a["hasSessionFile"] as? Bool ?? false,
                      parentId: a["parentId"] as? String,
                      createdAt: (a["createdAt"] as? NSNumber)?.doubleValue ?? 0,
                      lastActivity: (a["lastActivity"] as? NSNumber)?.doubleValue ?? 0)
        }
    }

    private func applyBus(channel: String?, data: [String: Any]?) {
        guard let channel, let data else { return }
        if channel == "task:subagent:progress", let p = data["progress"] as? [String: Any] {
            let id = p["id"] as? String ?? "\(data["index"] as? Int ?? 0)"
            progressMap[id] = SubagentProgress(
                id: id,
                index: data["index"] as? Int ?? p["index"] as? Int ?? 0,
                task: data["task"] as? String ?? p["task"] as? String ?? "task",
                description: p["description"] as? String ?? data["assignment"] as? String,
                status: p["status"] as? String ?? "running",
                currentTool: p["currentTool"] as? String,
                lastIntent: p["lastIntent"] as? String,
                toolCount: p["toolCount"] as? Int ?? 0,
                tokens: p["tokens"] as? Int ?? 0,
                cost: (p["cost"] as? NSNumber)?.doubleValue ?? 0,
                recentOutput: (p["recentOutput"] as? [String] ?? []).suffix(6).map { $0 },
                contextTokens: p["contextTokens"] as? Int,
                contextWindow: p["contextWindow"] as? Int)
        } else if channel == "task:subagent:lifecycle", let id = data["id"] as? String {
            if let existing = progressMap[id] {
                progressMap[id] = SubagentProgress(id: existing.id, index: existing.index, task: existing.task,
                    description: existing.description, status: data["status"] as? String ?? existing.status,
                    currentTool: existing.currentTool, lastIntent: existing.lastIntent,
                    toolCount: existing.toolCount, tokens: existing.tokens, cost: existing.cost,
                    recentOutput: existing.recentOutput, contextTokens: existing.contextTokens, contextWindow: existing.contextWindow)
            } else {
                progressMap[id] = SubagentProgress(id: id, index: data["index"] as? Int ?? 0,
                    task: data["description"] as? String ?? "subagent", description: data["description"] as? String,
                    status: data["status"] as? String ?? "started", currentTool: nil, lastIntent: nil,
                    toolCount: 0, tokens: 0, cost: 0)
            }
        }
        progress = progressMap.values.sorted { $0.index < $1.index }
    }

    private func applyEvent(_ e: [String: Any]?) {
        guard let e, let type = e["type"] as? String else { return }
        if ProcessInfo.processInfo.environment["ENCLAVE_DEBUG"] != nil {
            NSLog("eb:event type=%@ working=%d", type, working ? 1 : 0)
        }
        switch type {
        case "message_start", "message_update":
            let m = (e["message"] as? [String: Any]) ?? e
            if m["role"] as? String == "assistant" { stream = m; streamDone = false; measureThinking(m) }
            scheduleStreamRebuild()
            skipRebuild = true   // applyFrame's rebuild() is replaced by the coalesced one
        case "message_end":
            let m = (e["message"] as? [String: Any]) ?? e
            if m["role"] as? String == "assistant" { stream = m; streamDone = true; measureThinking(m) }
        case "tool_execution_start", "tool_execution_update":
            if let id = e["toolCallId"] as? String {
                activeTools.removeAll { $0.id == id }
                activeTools.append((id, e))
            }
        case "tool_execution_end":
            if let id = e["toolCallId"] as? String { activeTools.removeAll { $0.id == id } }
        case "agent_start": working = true; stream = nil; streamDone = false; thinkStart = nil; thoughtSeconds = nil; activity = nil
        // Turn done: drop the streaming ghost — the finalized entry now carries it
        // (otherwise the ghost and the entry both render, duplicating the reply).
        case "agent_end": working = false; stream = nil; streamDone = false; activity = nil

        // ── previously-dropped events now surfaced ──────────────────────────────
        // Retries / model fallback: show *why* the turn is hanging.
        case "auto_retry_start":
            let a = e["attempt"] as? Int ?? 1, m = e["maxAttempts"] as? Int ?? 1
            activity = "RETRYING \(a)/\(m)…"
        case "auto_retry_end":
            activity = (e["success"] as? Bool ?? true) ? nil : "RETRY FAILED"
        case "retry_fallback_applied":
            activity = "FALLING BACK → \(e["to"] as? String ?? "backup model")"
        case "retry_fallback_succeeded":
            activity = nil
        case "auto_compaction_start":
            activity = "COMPACTING CONTEXT…"
        case "auto_compaction_end":
            activity = nil
        case "thinking_level_changed":
            if let l = e["thinkingLevel"] as? String { thinkingLevel = l }
        // Host toasts: rate limits, tool failures, info.
        case "notice":
            let level = e["level"] as? String ?? "info"
            let msg = e["message"] as? String ?? ""
            if !msg.isEmpty {
                notices.append(NoticeItem(id: "\(notices.count)-\(msg.hashValue)", level: level, message: msg))
                if notices.count > 20 { notices.removeFirst(notices.count - 20) }
                rebuild()
            }
        // Goal mode: the persistent objective the host is pursuing.
        case "goal_updated":
            if let g = e["goal"] as? [String: Any], let obj = g["objective"] as? String {
                goal = GoalInfo(objective: obj, status: g["status"] as? String ?? "active",
                                tokensUsed: g["tokensUsed"] as? Int ?? 0, tokenBudget: g["tokenBudget"] as? Int)
            } else { goal = nil }
        default: break
        }
    }

    /// Time thinking: start the clock when thinking content first appears, stop it
    /// when the answer text starts — that span is what "thought for Xs" reports.
    private func measureThinking(_ m: [String: Any]) {
        let blocks = m["content"] as? [[String: Any]] ?? []
        let hasThinking = blocks.contains { thinkingContent(from: $0) != nil }
        // Thinking ends when the model starts acting — a text answer OR a tool call.
        let hasAction = blocks.contains {
            let ty = $0["type"] as? String
            return (ty == "text" && !(($0["text"] as? String ?? "").isEmpty)) || ty == "toolCall"
        }
        if hasThinking, thinkStart == nil { thinkStart = Date() }
        if hasAction, thoughtSeconds == nil, let s = thinkStart { thoughtSeconds = max(1, Int(Date().timeIntervalSince(s).rounded())) }
    }

    private func entryHasThinking(_ e: [String: Any]) -> Bool {
        guard let msg = e["message"] as? [String: Any], let blocks = msg["content"] as? [[String: Any]] else { return false }
        return blocks.contains { thinkingContent(from: $0) != nil }
    }

    // MARK: - thinking block helpers

    private func isThinkingBlock(_ b: [String: Any]) -> Bool {
        switch b["type"] as? String {
        case "thinking", "redactedThinking", "reasoning": return true
        default: return false
        }
    }

    private func thinkingContent(from b: [String: Any]) -> String? {
        guard isThinkingBlock(b) else { return nil }
        let text = b["thinking"] as? String ?? b["text"] as? String ?? b["data"] as? String ?? b["content"] as? String ?? b["reasoning"] as? String
        return text?.isEmpty == false ? text : nil
    }

    private func applyState(_ s: [String: Any]?) {
        guard let s else { return }
        working = s["isStreaming"] as? Bool ?? working
        if s["isAborting"] as? Bool == true { activity = "ABORTING…" }
        queued = s["queuedMessageCount"] as? Int ?? queued
        if let n = s["sessionName"] as? String, !n.isEmpty { title = n }
        if let c = s["cwd"] as? String { cwd = c }
        if let level = s["thinkingLevel"] as? String { thinkingLevel = level }
        if let m = s["model"] as? [String: Any], let name = m["name"] as? String { modelName = name }
        if let usage = s["contextUsage"] as? [String: Any] {
            if let tokens = usage["tokens"] as? Int { tokensLabel = tokens >= 1000 ? "\(tokens / 1000)K" : "\(tokens)" }
            contextPercent = (usage["percent"] as? NSNumber)?.doubleValue
        }
        if let list = s["participants"] as? [[String: Any]] {
            participants = list.map { p in
                ParticipantInfo(name: p["name"] as? String ?? "peer",
                                role: p["role"] as? String ?? "guest",
                                readOnly: p["readOnly"] as? Bool ?? false)
            }
        }
    }

    private func end(_ reason: String) {
        if phase == "ended" { return }
        terminated = true
        reconnectTask?.cancel()
        phase = "ended"
        endedReason = reason
        working = false
        currentMode = nil
        socket.close()
        rebuild()
    }

    // ── projection: omp transcript → [UITurn] ─────────────────────────────────

    private struct StaticRebuild {
        let turns: [UITurn]
        let plan: [PlanPhase]
        let mode: String?
        let sawModeChange: Bool
        let inspectImages: [(id: String, path: String, mime: String?)]
    }

    /// Throttle streaming rebuilds to ~30fps. If enough time has elapsed since the
    /// last flush, rebuild immediately. Otherwise schedule a deferred rebuild that
    /// picks up the latest `stream` state — intermediate frames are silently dropped.
    private func scheduleStreamRebuild() {
        let elapsed = Date().timeIntervalSince(lastStreamRebuild)
        if elapsed >= streamCoalesceInterval {
            lastStreamRebuild = Date()
            rebuild()
        } else if !streamRebuildPending {
            streamRebuildPending = true
            let delay = streamCoalesceInterval - elapsed
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                guard let self, self.streamRebuildPending else { return }
                self.streamRebuildPending = false
                self.lastStreamRebuild = Date()
                self.rebuild()
            }
        }
        // If a rebuild is already pending, do nothing — it will pick up the latest stream.
    }
    private func rebuild() {
        streamRebuildPending = false  // any explicit rebuild supersedes a pending coalesced one
        // If no new entries arrived and we already have a cached static projection,
        // only the dynamic tail (stream, pending send, active tools, ui-request, notices)
        // may have changed. Rebuild just that tail instead of reprocessing all history.
        let entriesUnchanged = entries.count == cachedEntryCount && !cachedStaticTurns.isEmpty

        let staticTurns: [UITurn]
        let latestPlan: [PlanPhase]?
        let latestMode: String?
        let sawModeChange: Bool
        let inspectImages: [(id: String, path: String, mime: String?)]
        if entriesUnchanged {
            staticTurns = cachedStaticTurns
            latestPlan = nil
            latestMode = nil
            sawModeChange = false
            inspectImages = []
        } else {
            let result = buildStaticTurns()
            staticTurns = result.turns
            latestPlan = result.plan
            latestMode = result.mode
            sawModeChange = result.sawModeChange
            inspectImages = result.inspectImages
            cachedStaticTurns = staticTurns
            cachedEntryCount = entries.count
        }

        let newTail = buildTail(staticTurns: staticTurns)

        // Model chips only earn their space when the session actually used >1 model.
        var combined = staticTurns + newTail
        if Set(combined.compactMap { $0.model.isEmpty ? nil : $0.model }).count <= 1 {
            for i in combined.indices { combined[i].model = "" }
        }

        let tailCount = newTail.count
        cachedStaticTurns = Array(combined.prefix(combined.count - tailCount))
        cachedTail = Array(combined.suffix(tailCount))
        if turns != combined {
            turns = combined
        }

        // Only adopt a live plan once one actually arrives, so the cached plan shown on
        // reconnect isn't wiped to empty while the snapshot is still streaming in.
        if let plan = latestPlan, !plan.isEmpty, self.plan != plan {
            self.plan = plan
            Self.savePlan(plan, planKey)
        }

        // Adopt mode only when a real mode_change entry is observed this rebuild;
        // a snapshot mid-stream leaves sawModeChange false, so we don't wipe the
        // active mode while reconnecting. A mode_change to "none" clears it.
        if sawModeChange, currentMode != latestMode { currentMode = latestMode }

        onChange?()

        for img in inspectImages where fetchedImages[img.path] == nil && !imageFetchAttempted.contains(img.path) {
            imageFetchAttempted.insert(img.path)
            Task { [weak self] in
                guard let self else { return }
                if let r = await self.fetchImage(path: img.path, mimeType: img.mime) {
                    self.fetchedImages[img.path] = "data:\(r.mimeType);base64,\(r.data)"
                    self.cachedStaticTurns = []; self.cachedEntryCount = 0
                    self.rebuild()
                }
            }
        }
    }

    private func buildStaticTurns() -> StaticRebuild {
        var out: [UITurn] = []
        var toolIndex: [String: Int] = [:]
        var latestPlan: [PlanPhase] = []
        var latestMode: String? = nil
        var sawModeChange = false
        var inspectImages: [(id: String, path: String, mime: String?)] = []

        // Confirm a fresh QR pair at the top of the scroll, once the host welcomes us.
        if welcomed && justPaired { out.append(UITurn.sys("paired", "SUCCESSFULLY PAIRED THIS SESSION")) }

        for entry in entries {
            guard let type = entry["type"] as? String else { continue }
            let eid = entry["id"] as? String ?? UUID().uuidString
            switch type {
            case "custom_message" where (entry["customType"] as? String) == "collab-prompt":
                out.append(userTurn(id: eid, content: entry["content"]))
            case "message":
                guard let msg = entry["message"] as? [String: Any], let role = msg["role"] as? String else { break }
                switch role {
                case "user":
                    out.append(userTurn(id: eid, content: msg["content"]))
                case "assistant":
                    let msgModel = msg["model"] as? String ?? ""
                    for (i, block) in (msg["content"] as? [[String: Any]] ?? []).enumerated() {
                        switch block["type"] as? String {
                        case "text":
                            let text = block["text"] as? String ?? ""
                            if !text.isEmpty { out.append(agentTurn(id: "\(eid)#\(i)", text: text, model: msgModel)) }
                        case "toolCall":
                            let name = block["name"] as? String ?? "tool"
                            if name == "todo" { break }
                            let id = block["id"] as? String ?? "\(eid)#\(i)"
                            out.append(toolTurn(id: id, name: name, args: block["arguments"], intent: block["intent"] as? String))
                            toolIndex[id] = out.count - 1
                        case "thinking", "redactedThinking", "reasoning":
                            if let think = thinkingContent(from: block) {
                                out.append(thinkingTurn(id: "\(eid)#\(i)", text: think, seconds: thoughtForEntry[eid], model: msgModel))
                            }
                        default: break
                        }
                    }
                    if let err = msg["errorMessage"] as? String, !err.isEmpty {
                        out.append(UITurn.sys("error", "ERROR · " + err))
                    } else if (msg["stopReason"] as? String) == "error" {
                        out.append(UITurn.sys("error", "TURN FAILED — SEE THE HOST"))
                    }
                case "toolResult":
                    let id = msg["toolCallId"] as? String ?? eid
                    if (msg["toolName"] as? String) == "todo" {
                        if let phases = parsePlan(msg["details"]) { latestPlan = phases }
                        break
                    }
                    let isError = msg["isError"] as? Bool ?? false
                    let isInspect = (msg["toolName"] as? String) == "inspect_image"
                    let details = msg["details"] as? [String: Any]
                    let imagePath = isInspect ? (details?["imagePath"] as? String) : nil
                    if let idx = toolIndex[id] {
                        fillResult(&out[idx], content: msg["content"], isError: isError, details: details, kind: out[idx].kind)
                        if isInspect, !isError, out[idx].image == nil, let p = imagePath, !p.isEmpty {
                            if let cached = fetchedImages[p] {
                                out[idx].image = cached
                            } else if p.hasPrefix("attachment://") || p.hasPrefix("Image #") {
                                for prev in out.reversed() {
                                    if prev.type == .user, let img = prev.image {
                                        out[idx].image = img
                                        break
                                    }
                                }
                            } else {
                                let mime = details?["mimeType"] as? String
                                inspectImages.append((id: id, path: p, mime: mime))
                            }
                        }
                    } else {
                        var turn = toolTurn(id: id, name: msg["toolName"] as? String ?? "tool", args: nil, intent: nil)
                        fillResult(&turn, content: msg["content"], isError: isError, details: details, kind: turn.kind)
                        if isInspect, !isError, turn.image == nil, let p = imagePath, !p.isEmpty {
                            if let cached = fetchedImages[p] {
                                turn.image = cached
                            } else if p.hasPrefix("attachment://") || p.hasPrefix("Image #") {
                                for prev in out.reversed() {
                                    if prev.type == .user, let img = prev.image {
                                        turn.image = img
                                        break
                                    }
                                }
                            } else {
                                let mime = details?["mimeType"] as? String
                                inspectImages.append((id: id, path: p, mime: mime))
                            }
                        }
                        out.append(turn)
                    }
                default: break
                }
            case "compaction":
                out.append(UITurn.sys("compaction", (entry["shortSummary"] as? String ?? "COMPACTING CONTEXT").uppercased()))
            case "mode_change":
                let mode = entry["mode"] as? String ?? "none"
                sawModeChange = true
                latestMode = (mode == "none") ? nil : mode
                out.append(UITurn.sys("mode", mode == "none" ? "EXITED MODE" : "ENTERED \(mode.uppercased()) MODE"))
            case "branch_summary":
                out.append(UITurn.sys("rewind", "REWOUND · " + (entry["summary"] as? String ?? "earlier work")))
            case "model_change":
                out.append(UITurn.sys("model", "MODEL → " + (entry["model"] as? String ?? "?")))
            case "thinking_level_change":
                if let l = entry["thinkingLevel"] as? String { out.append(UITurn.sys("model", "THINKING → " + l.uppercased())) }
            case "service_tier_change":
                out.append(UITurn.sys("model", "SERVICE TIER CHANGED"))
            case "custom_message" where (entry["customType"] as? String) == "system-notice":
                let raw = contentString(entry["content"])
                if !raw.isEmpty {
                    let (pre, id, agent, status, dur, summary, footer) = parseSystemNotice(raw)
                    var turn = UITurn(id: eid, type: .sys)
                    turn.kind = "system-notice"
                    turn.head = id.isEmpty ? agent : id
                    turn.meta = "\(status) · \(dur)"
                    turn.caption = pre
                    turn.text = summary
                    turn.lines = footer.isEmpty ? [] : [footer]
                    out.append(turn)
                }
            case "custom_message":
                let ct = entry["customType"] as? String ?? ""
                if ct == "advisor", entry["display"] as? Bool == true {
                    let text = contentString(entry["content"])
                    if !text.isEmpty { var t = UITurn(id: eid, type: .advisor); t.text = text; out.append(t) }
                } else if entry["display"] as? Bool == true, ct != "collab-prompt", !ct.hasPrefix("enclave-") {
                    let text = contentString(entry["content"])
                    if !text.isEmpty { out.append(UITurn.sys("note", text)) }
                }
            default: break
            }
        }

        return StaticRebuild(turns: out, plan: latestPlan, mode: latestMode, sawModeChange: sawModeChange, inspectImages: inspectImages)
    }

    private func buildTail(staticTurns: [UITurn]) -> [UITurn] {
        var out: [UITurn] = []
        var toolIndex: [String: Int] = [:]
        for (i, turn) in staticTurns.enumerated() where turn.type == .tool {
            toolIndex[turn.id] = i
        }

        // Optimistic sent message — shown until the host echoes its prompt back.
        // Some hosts/Enclave plugins echo as `custom_message` with customType "collab-prompt";
        // others echo as a regular `message` entry with role "user". Clear the ghost when
        // either kind arrives.
        if pendingSendText != nil,
           (collabPromptCount() > pendingSendBaseline || hostHasEchoedUserText(pendingSendText)) {
            pendingSendText = nil; pendingSendImage = nil
        }
        if let pt = pendingSendText {
            var t = UITurn(id: "pending-send", type: .user)
            t.text = pt; t.image = pendingSendImage; t.pending = true
            out.append(t)
        }

        // Executing tools with no result entry yet.
        for (id, tool) in activeTools where toolIndex[id] == nil {
            var turn = toolTurn(id: id, name: tool["toolName"] as? String ?? "tool", args: tool["args"], intent: tool["intent"] as? String)
            turn.pending = true
            out.append(turn)
        }

        // Streaming assistant ghost, until its entry lands.
        if let s = stream {
            let blocks = s["content"] as? [[String: Any]] ?? []
            let thinking = blocks.compactMap { thinkingContent(from: $0) }.joined(separator: "\n")
            if !thinking.isEmpty { out.append(thinkingTurn(id: "stream-think", text: thinking, seconds: nil)) }
            let text = blocks.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined(separator: "\n")
            if !text.isEmpty {
                var turn = agentTurn(id: "stream", text: text)
                turn.streaming = !streamDone
                out.append(turn)
            }
        }

        // Pending host ask (omp `ask`): select (radio/checkbox) or free-form editor.
        if let req = uiRequest, let reqId = req["reqId"] as? Int {
            var turn = UITurn(id: "ui-\(reqId)", type: .ask)
            turn.reqId = reqId
            turn.askKind = req["kind"] as? String ?? "select"
            turn.question = req["title"] as? String ?? "The host is asking…"
            turn.helpText = req["helpText"] as? String ?? ""
            turn.prefill = req["prefill"] as? String ?? ""
            turn.initialIndex = req["initialIndex"] as? Int
            turn.selectionMarker = req["selectionMarker"] as? String ?? "radio"
            turn.checkedIndices = (req["checkedIndices"] as? [Any] ?? [])
                .compactMap { ($0 as? Int) ?? ($0 as? NSNumber)?.intValue }
            turn.disabledIndices = (req["disabledIndices"] as? [Any] ?? [])
                .compactMap { ($0 as? Int) ?? ($0 as? NSNumber)?.intValue }
            var labels: [String] = []; var descs: [String] = []
            for opt in (req["options"] as? [Any] ?? []) {
                if let s = opt as? String { labels.append(s); descs.append("") }
                else if let d = opt as? [String: Any] {
                    labels.append(d["label"] as? String ?? "option")
                    descs.append(d["description"] as? String ?? "")
                } else { labels.append("option"); descs.append("") }
            }
            turn.options = labels
            turn.optionDescriptions = descs
            out.append(turn)
        }

        // Host notices (rate limits, tool failures) — surfaced at the bottom of the scroll.
        for n in notices { out.append(UITurn.sys(n.level == "error" ? "error" : "notice", n.message)) }

        return out
    }

    // ── turn builders ─────────────────────────────────────────────────────────

    private static func loadPlan(_ key: String) -> [PlanPhase] {
        guard !key.isEmpty, let data = UserDefaults.standard.data(forKey: key),
              let plan = try? JSONDecoder().decode([PlanPhase].self, from: data) else { return [] }
        return plan
    }
    private static func savePlan(_ plan: [PlanPhase], _ key: String) {
        guard !key.isEmpty, let data = try? JSONEncoder().encode(plan) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }

    /// Parse a `todo` toolResult's details → phases/tasks for the plan panel.
    private func parsePlan(_ details: Any?) -> [PlanPhase]? {
        guard let d = details as? [String: Any], let phases = d["phases"] as? [[String: Any]] else { return nil }
        return phases.map { ph in
            let tasks = (ph["tasks"] as? [[String: Any]] ?? []).map {
                PlanTask(content: $0["content"] as? String ?? "", status: $0["status"] as? String ?? "pending")
            }
            return PlanPhase(name: ph["name"] as? String ?? "", tasks: tasks)
        }
    }


    private func userTurn(id: String, content: Any?) -> UITurn {
        var t = UITurn(id: id, type: .user)
        t.text = contentString(content)
        t.image = firstImage(content)
        return t
    }
    private func thinkingTurn(id: String, text: String, seconds: Int? = nil, model: String = "") -> UITurn {
        var t = UITurn(id: id, type: .thinking); t.text = text; t.thoughtSeconds = seconds; t.model = model; return t
    }
    private func agentTurn(id: String, text: String, model: String = "") -> UITurn {
        var t = UITurn(id: id, type: .agent); t.text = text; t.model = model; return t
    }
    private func toolTurn(id: String, name: String, args: Any?, intent: String?) -> UITurn {
        var t = UITurn(id: id, type: .tool)
        t.kind = toolKind(name)
        t.head = name
        t.meta = argSummary(args) ?? intent ?? ""
        return t
    }
    private func fillResult(_ turn: inout UITurn, content: Any?, isError: Bool, details: [String: Any]? = nil, kind: String = "") {
        turn.pending = false
        if let img = firstImage(content) { turn.image = img }
        let text = contentString(content)
        if !text.isEmpty {
            let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            if lines.count == 1 && lines[0].count <= 80 && turn.meta.isEmpty { turn.meta = lines[0] }
            else { turn.lines = Array(lines.prefix(14)) }
        }
        if isError && turn.meta.isEmpty { turn.meta = "error" }

        if let details = details, (kind == "edit" || kind == "ast_edit") {
            if let diff = details["diff"] as? String, !diff.isEmpty {
                turn.diff = diff
                turn.diffLang = SyntaxHighlighter.languageFromPath(details["path"] as? String ?? "") ?? ""
            } else if let displayContent = details["displayContent"] as? String, !displayContent.isEmpty {
                turn.diff = displayContent
                let displayPath = details["path"] as? String
                    ?? (details["fileReplacements"] as? [[String: Any]])?.first?["path"] as? String
                    ?? details["scopePath"] as? String
                turn.diffLang = SyntaxHighlighter.languageFromPath(displayPath ?? "") ?? ""
            }
            if let perFileResults = details["perFileResults"] as? [[String: Any]] {
                turn.perFileDiffs = perFileResults.compactMap { entry in
                    let path = entry["path"] as? String ?? ""
                    let diff = entry["diff"] as? String ?? ""
                    guard !path.isEmpty || !diff.isEmpty else { return nil }
                    let isErr = entry["isError"] as? Bool ?? false
                    let errorText = entry["errorText"] as? String
                    let lang = SyntaxHighlighter.languageFromPath(path) ?? ""
                    return UIToolFileDiff(path: path, diff: diff, lang: lang, isError: isErr, errorText: errorText)
                }
            }
        }
    }

    private func hostHasEchoedUserText(_ text: String?) -> Bool {
        guard let text, !text.isEmpty else { return false }
        // collab-prompt echo (host's custom_message entry)
        if entries.last(where: { ($0["customType"] as? String) == "collab-prompt" }) != nil {
            return true
        }
        // regular user message echo (message entry with role == "user")
        if let last = entries.last, last["type"] as? String == "message",
           let msg = last["message"] as? [String: Any],
           msg["role"] as? String == "user" {
            return contentString(msg["content"]).trimmingCharacters(in: .whitespacesAndNewlines) == text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return false
    }

    // ── content helpers ───────────────────────────────────────────────────────

    private func contentString(_ content: Any?) -> String {
        if let s = content as? String { return s }
        if let arr = content as? [[String: Any]] {
            return arr.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined(separator: "\n")
        }
        return ""
    }

    // ── system-notice parsing (harness background-job completion) ───────────
    private func extractXMLAttr(_ s: String, _ name: String) -> String? {
        let pattern = "\\b\(name)\\s*=\\s*\"([^\"]*)\""
        guard let range = s.range(of: pattern, options: .regularExpression) else { return nil }
        let match = String(s[range])
        let parts = match.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2 else { return nil }
        return parts[1].trimmingCharacters(in: CharacterSet(charactersIn: "\""))
    }

    private func extractJSONSummary(_ s: String) -> String? {
        guard let data = s.data(using: .utf8) else { return nil }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return json["summary"] as? String
    }

    private func parseSystemNotice(_ raw: String) -> (
        preamble: String, id: String, agent: String, status: String, duration: String, summary: String, footer: String
    ) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        var preamble = ""
        var id = ""
        var agent = ""
        var status = ""
        var duration = ""
        var summary = ""
        var footer = ""

        guard let tagStart = trimmed.range(of: "<task-result") else {
            summary = trimmed
            return (preamble, id, agent, status, duration, summary, footer)
        }

        preamble = String(trimmed[..<tagStart.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
        let afterTagStart = trimmed[tagStart.lowerBound...]
        guard let tagEnd = afterTagStart.range(of: ">") else {
            summary = trimmed
            return (preamble, id, agent, status, duration, summary, footer)
        }

        let tag = String(afterTagStart[..<tagEnd.upperBound])
        id = extractXMLAttr(tag, "id") ?? ""
        agent = extractXMLAttr(tag, "agent") ?? ""
        status = extractXMLAttr(tag, "status") ?? ""
        duration = extractXMLAttr(tag, "duration") ?? ""

        let afterTag = afterTagStart[tagEnd.upperBound...]
        if let outputStart = afterTag.range(of: "<output>"),
           let outputEnd = afterTag.range(of: "</output>") {
            let output = String(afterTag[outputStart.upperBound..<outputEnd.lowerBound])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            summary = extractJSONSummary(output) ?? output
        }

        if let resultEnd = afterTag.range(of: "</task-result>") {
            footer = String(afterTag[resultEnd.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        }

        return (preamble, id, agent, status, duration, summary, footer)
    }

    private func firstImage(_ content: Any?) -> String? {
        guard let arr = content as? [[String: Any]] else { return nil }
        for block in arr where block["type"] as? String == "image" {
            if let data = block["data"] as? String, let mime = block["mimeType"] as? String {
                return "data:\(mime);base64,\(data)"
            }
        }
        return nil
    }

    /// omp tool name → the app's tool-kind vocabulary (drives glyph + color).
    private func toolKind(_ name: String) -> String {
        let n = name.lowercased()
        if n.contains("read") || n.contains("cat") { return "read" }
        if n.contains("grep") || n.contains("search") || n.contains("glob") || n.contains("find") { return "search" }
        if n.contains("ast_edit") { return "ast_edit" }
        if n.contains("edit") || n.contains("write") || n.contains("apply") { return "edit" }
        if n.contains("bash") || n.contains("shell") || n.contains("exec") || n.contains("eval") { return "bash" }
        if n.contains("lsp") || n.contains("diagnos") { return "lsp" }
        if n.contains("task") || n.contains("agent") || n.contains("spawn") { return "task" }
        if n.contains("debug") || n.contains("dap") || n.contains("lldb") { return "debug" }
        if n.contains("inspect") { return "inspect" }
        if n.contains("image") || n.contains("photo") { return "image" }
        return n
    }

    private func argSummary(_ args: Any?) -> String? {
        guard let dict = args as? [String: Any] else { return nil }
        for key in ["path", "file", "filePath", "file_path", "command", "cmd", "pattern", "query", "url", "name"] {
            if let v = dict[key] as? String, !v.isEmpty { return v }
        }
        if let data = try? JSONSerialization.data(withJSONObject: dict),
           let s = String(data: data, encoding: .utf8), s.count <= 60 { return s }
        return nil
    }

    /// Canned ui-request for simulator QA. No-op when the env var is unset.
    private func mockAsk(_ mode: String) -> [String: Any] {
        switch mode {
        case "checkbox":
            return [
                "reqId": 1,
                "kind": "select",
                "title": "Which files should the refactor touch?",
                "helpText": "Tap an option to toggle it; the host will re-prompt with the updated selection.",
                "selectionMarker": "checkbox",
                "checkedIndices": [1],
                "options": [
                    ["label": "src/engine.ts", "description": "Core wire protocol types"],
                    ["label": "src/client.ts", "description": "Guest client socket handling"],
                    ["label": "src/views.tsx", "description": "React transcript rendering"]
                ]
            ]
        case "editor":
            return [
                "reqId": 1,
                "kind": "editor",
                "title": "What should the next task cover?",
                "helpText": "Type your answer and tap SEND, or SKIP to leave it blank.",
                "prefill": "Investigate the failing build on CI."
            ]
        case "plan":
            return [
                "reqId": 1,
                "kind": "plan",
                "title": "Plan mode - next step",
                "helpText": "## Plan\n\n1. Refactor the wire protocol.\n2. Update the guest client.\n3. Verify the UI renders correctly.",
                "selectionMarker": "radio",
                "options": [
                    "Approve and execute",
                    "Approve and compact context",
                    "Keep context and execute",
                    "Refine plan"
                ],
                "disabledIndices": [2]
            ]
        default:
            return [
                "reqId": 1,
                "kind": "select",
                "title": "Pick a deployment strategy",
                "helpText": "Choose the option that best fits the current release.",
                "selectionMarker": "radio",
                "initialIndex": 1,
                "options": [
                    "Canary",
                    ["label": "Rolling", "description": "Gradual rollout with automatic rollback on error."],
                    "Blue/green"
                ]
            ]
        }
    }

    private func isAssistantMessage(_ entry: [String: Any]) -> Bool {
        entry["type"] as? String == "message" && (entry["message"] as? [String: Any])?["role"] as? String == "assistant"
    }
}
