import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

//  T4CollabGuest.swift
//  Collab guest runtime: connects to a collab room on the relay as a guest,
//  speaks the sealed frame protocol (hello → welcome/snapshot-chunk
//  accumulation → live frames), and reconnects with exponential backoff on
//  transient faults. The /enclave room token is presented as the hello
//  `enclaveToken`, upgrading the guest on locked /enclave rooms.
//
//  Transport mirrors HostClient (URLSessionWebSocketTask, one binary message
//  per envelope, no per-message compression); the wire behavior mirrors the
//  Enclave EngineBridge guest and @oh-my-pi/collab-web's CollabGuestClient.
//
//      let guest = T4CollabGuest(link: "ws://localhost:7466/r/<id>.<key>",
//                                token: roomToken, name: "iPhone")
//      guest.start()
//      for await frame in guest.frames { … }

/// Guest side of a collab room hosted by the /enclave plugin.
///
/// Frames arrive on `frames` in wire order: `welcome` (resets the snapshot),
/// then `snapshotChunk` batches to accumulate until `final`, then live
/// `entry`/`event`/`state` frames plus the /enclave extension frames. The
/// stream ends after `close()` or a terminal frame (host `bye`, relay
/// `room-closed`, a pre-welcome `error`, a fatal close code, or a decryption
/// failure). Reconnects are silent: the consumer only sees the next `welcome`.
public actor T4CollabGuest {
    /// Frames the guest emits. Terminal frames are followed by the end of the
    /// stream.
    public let frames: AsyncStream<T4CollabFrame>
    private let frameContinuation: AsyncStream<T4CollabFrame>.Continuation

    private let rawLink: String
    private let token: String?
    private let name: String

    /// Parsed once at `start()`; nil until then (or after a bad link).
    private var link: T4CollabLink?
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var attempt = 0
    private var welcomed = false
    private var terminated = false
    private var closedByUser = false
    private var state: State = .idle

    private enum State: Sendable {
        case idle, connecting, live, reconnectWait, closed
    }

    private enum T4CollabGuestError: Error {
        case socketClosed
    }

    /// - Parameters:
    ///   - link: A collab link — bare `<roomId>.<key>` (default relay), legacy
    ///     `<roomId>#<key>`, scheme-less `host/r/<roomId>.<key>`, or a full
    ///     ws/wss URL. A 48-byte key (32B key + 16B write token) grants full
    ///     access; 32 bytes is view-only.
    ///   - token: The /enclave room token, sent as the hello `enclaveToken`
    ///     when present. Nil for open rooms.
    ///   - name: The guest display name shown to the host.
    public init(link: String, token: String?, name: String) {
        self.rawLink = link
        self.token = token
        self.name = name
        let (stream, continuation) = AsyncStream<T4CollabFrame>.makeStream()
        self.frames = stream
        self.frameContinuation = continuation
    }

    // MARK: - Lifecycle

    /// Open the relay connection and join the room. Idempotent; after a
    /// terminal state (`close()` or a fatal fault) it is a no-op.
    public func start() {
        guard state == .idle else { return }
        connect()
    }

    /// Leave the room and end the `frames` stream. Terminal.
    public func close() {
        guard !closedByUser else { return }
        closedByUser = true
        terminated = true
        state = .closed
        reconnectTask?.cancel(); reconnectTask = nil
        receiveTask?.cancel(); receiveTask = nil
        teardownSocket()
        frameContinuation.finish()
    }

    // MARK: - Commands

    /// Send a prompt to the host agent. Blank text is ignored.
    public func sendPrompt(_ text: String) {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        send(["t": "prompt", "text": clean])
    }

    /// Interrupt the host's current turn.
    public func sendAbort() {
        send(["t": "abort"])
    }

    /// Answer a `uiRequest`. Pass nil to decline or leave the answer blank.
    public func sendUiResponse(reqId: Int, value: String?) {
        var frame: [String: Any] = ["t": "ui-response", "reqId": reqId]
        if let value { frame["value"] = value }
        send(frame)
    }

    // MARK: - Connect / reconnect

    private func connect() {
        guard !terminated, !closedByUser else { return }
        guard state == .idle || state == .reconnectWait else { return }
        let parsed: T4CollabLink
        if let existing = link {
            parsed = existing
        } else {
            switch T4CollabLink.parse(rawLink) {
            case .err(let reason):
                terminate(.error(message: reason))
                return
            case .ok(let value):
                parsed = value
                link = value
            }
        }
        openSocket(parsed)
    }

    private func openSocket(_ parsed: T4CollabLink) {
        state = .connecting
        var comps = URLComponents(url: parsed.wsURL, resolvingAgainstBaseURL: false)
        comps?.queryItems = [URLQueryItem(name: "role", value: "guest")]
        guard let url = comps?.url else {
            terminate(.error(message: "malformed relay URL"))
            return
        }
        let session = URLSession(configuration: .default)
        let task = session.webSocketTask(with: url)
        // Snapshot chunks can carry screenshots; the 1MB default silently
        // drops oversized frames. 128MB mirrors the Enclave guest.
        task.maximumMessageSize = 128 * 1024 * 1024
        self.session = session
        self.task = task
        task.resume()
        sendHello(parsed)
        startReceiveLoop()
    }

    private func sendHello(_ parsed: T4CollabLink) {
        var hello: [String: Any] = ["t": "hello", "proto": T4CollabWire.proto, "name": name]
        if let writeToken = parsed.writeToken {
            hello["writeToken"] = T4Base64URL.encode(writeToken)
        }
        if let token {
            hello["enclaveToken"] = token
        }
        send(hello)
    }

    /// Seal a guest frame and send it as `[4B peerId=0][sealed]`. Fire-and-
    /// forget: no-ops when the socket is not open or the frame is not
    /// JSON-serializable.
    private func send(_ frame: [String: Any]) {
        guard let task, let key = link?.key else { return }
        guard let sealed = T4CollabWire.seal(frame, key: key) else { return }
        var envelope = Data(count: T4CollabWire.envelopeHeader)   // peerId 0
        envelope.append(sealed)
        task.send(.data(envelope)) { _ in }
    }

    private func startReceiveLoop() {
        receiveTask?.cancel()
        receiveTask = Task { [weak self] in
            while let self {
                let message: URLSessionWebSocketTask.Message
                do {
                    message = try await self.receiveNext()
                } catch {
                    let code = await self.closeCodeAfterFailure()
                    await self.handleTransportError(code: code)
                    break
                }
                await self.ingest(message)
            }
        }
    }

    private func receiveNext() async throws -> URLSessionWebSocketTask.Message {
        guard let task else { throw T4CollabGuestError.socketClosed }
        return try await task.receive()
    }

    /// The raw close code of the current socket (0 when unknown/not open).
    private func closeCodeAfterFailure() -> Int {
        task?.closeCode.rawValue ?? 0
    }

    // MARK: - Inbound

    private func ingest(_ message: URLSessionWebSocketTask.Message) {
        switch message {
        case .data(let data):
            guard data.count > T4CollabWire.envelopeHeader, let key = link?.key else { return }
            let payload = data.subdata(in: T4CollabWire.envelopeHeader..<data.count)
            guard let frame = T4CollabWire.open(payload, key: key) else {
                terminate(.error(message: "bad key or corrupted frame"))
                return
            }
            ingestFrame(frame)
        case .string(let text):
            // TEXT = relay control (room-closed). Parse leniently.
            if let control = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] {
                ingestControl(control)
            }
        @unknown default:
            break
        }
    }

    private func ingestFrame(_ f: [String: Any]) {
        guard !terminated else { return }
        guard let t = f["t"] as? String else { return }
        switch t {
        case "welcome":
            welcomed = true
            attempt = 0
            state = .live
            let header = (f["header"] as? [String: Any]).map(T4CollabWireEntry.init(json:)) ?? T4CollabWireEntry(json: [:])
            let entryCount = f["entryCount"] as? Int ?? 0
            frameContinuation.yield(.welcome(header: header, entryCount: entryCount))
        case "snapshot-chunk":
            let entries = (f["entries"] as? [[String: Any]] ?? []).map(T4CollabWireEntry.init(json:))
            let final = f["final"] as? Bool ?? false
            frameContinuation.yield(.snapshotChunk(entries: entries, final: final))
        case "entry":
            if let raw = f["entry"] as? [String: Any] {
                frameContinuation.yield(.entry(T4CollabWireEntry(json: raw)))
            }
        case "event":
            if let raw = f["event"] as? [String: Any] {
                frameContinuation.yield(.event(T4CollabEvent(json: raw)))
            }
        case "state":
            frameContinuation.yield(decodeState(f["state"] as? [String: Any]))
        case "enclave-caps":
            let models = (f["models"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
            let commands = (f["commands"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String }
            let current = (f["current"] as? [String: Any])?["model"] as? String
            frameContinuation.yield(.enclaveCaps(models: models, commands: commands, current: current))
        case "enclave-result":
            frameContinuation.yield(.enclaveResult(ok: f["ok"] as? Bool ?? false,
                                                   message: f["message"] as? String,
                                                   reqId: f["reqId"] as? Int))
        case "ui-request":
            if let request = f["request"] as? [String: Any] {
                frameContinuation.yield(decodeUiRequest(request))
            }
        case "bye":
            terminate(.bye(reason: f["reason"] as? String ?? "session ended"))
        case "error":
            let message = f["message"] as? String ?? "host error"
            if welcomed {
                // Post-welcome errors are transient (rate limits, tool
                // failures) — surface and keep going.
                frameContinuation.yield(.error(message: message))
            } else {
                // Pre-welcome errors are terminal — the session never started.
                terminate(.error(message: message))
            }
        default:
            break    // tolerate unknown frame types
        }
    }

    private func ingestControl(_ c: [String: Any]) {
        guard !terminated else { return }
        if (c["t"] as? String) == "room-closed" {
            terminate(.bye(reason: "room closed"))
        }
    }

    private func decodeState(_ s: [String: Any]?) -> T4CollabFrame {
        let isStreaming = s?["isStreaming"] as? Bool ?? false
        var modelId: String?
        if let model = s?["model"] as? [String: Any] {
            modelId = model["id"] as? String ?? model["name"] as? String
        }
        return .state(isStreaming: isStreaming, modelId: modelId, thinkingLevel: s?["thinkingLevel"] as? String)
    }

    private func decodeUiRequest(_ r: [String: Any]) -> T4CollabFrame {
        let reqId = r["reqId"] as? Int ?? 0
        let kind = r["kind"] as? String ?? ""
        let title = r["title"] as? String ?? ""
        var options: [String]?
        if let raw = r["options"] as? [Any], !raw.isEmpty {
            options = raw.map { option -> String in
                if let s = option as? String { return s }
                if let o = option as? [String: Any] { return o["label"] as? String ?? "" }
                return ""
            }
        }
        return .uiRequest(reqId: reqId, kind: kind, title: title, options: options,
                          helpText: r["helpText"] as? String, prefill: r["prefill"] as? String)
    }

    // MARK: - Faults / reconnect / teardown

    private func handleTransportError(code: Int) {
        guard !terminated, !closedByUser else { return }
        teardownSocket()
        if T4CollabWire.fatalCloseCodes.contains(code) {
            terminate(.error(message: "room unavailable (\(code))"))
        } else {
            scheduleReconnect()
        }
    }

    private func scheduleReconnect() {
        guard !terminated, !closedByUser, state != .closed else { return }
        state = .reconnectWait
        let delay = Self.reconnectDelay(attempt: attempt)
        attempt += 1
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.connect()
        }
    }

    /// Exponential backoff 1s…30s with ±25% jitter (collab-web client.ts).
    private static func reconnectDelay(attempt: Int) -> TimeInterval {
        let base = min(1.0 * pow(2.0, Double(attempt)), 30.0)
        return base * (0.75 + Double.random(in: 0..<0.5))
    }

    /// Yield one final frame (if any) and end the stream. Terminal; further
    /// frames are ignored.
    private func terminate(_ frame: T4CollabFrame) {
        guard !terminated else { return }
        terminated = true
        state = .closed
        attempt = 0
        reconnectTask?.cancel(); reconnectTask = nil
        receiveTask?.cancel(); receiveTask = nil
        teardownSocket()
        frameContinuation.yield(frame)
        frameContinuation.finish()
    }

    private func teardownSocket() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
    }
}
