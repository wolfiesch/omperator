import Foundation
import os

private let t4wireLog = Logger(subsystem: "sh.t4code.ios", category: "wire")

/// Host-wire client runtime: WebSocket connect, hello/welcome handshake,
/// heartbeat, command dispatch with request/response correlation, inbound
/// routing, and reconnect with cursor resume. Ports the connection lifecycle of
/// `packages/client/src/omp-client-*` to Swift, speaking the frame types in
/// this package directly.
public actor HostClient {
    public enum State: Sendable { case idle, connecting, handshaking, pairing, ready, reconnectWait, closing, closed, fatal }

    public struct Config: Sendable {
        public var identity: ClientIdentity
        public var authentication: DeviceAuthentication?
        public var requestedFeatures: [String]
        public var capabilities: Capabilities?
        public var handshakeTimeout: TimeInterval = 15
        public var heartbeatInterval: TimeInterval = 15
        public var heartbeatTimeout: TimeInterval = 5
        public var commandTimeout: TimeInterval = 30
        public var reconnectBase: TimeInterval = 0.5
        public var reconnectMax: TimeInterval = 30
        public init(
            identity: ClientIdentity,
            authentication: DeviceAuthentication? = nil,
            requestedFeatures: [String] = ["resume", "prompt.lease", "controller.lease", "prompt.images", "transcript.page", "session.delta", "files.list", "terminal.io"],
            capabilities: Capabilities? = Capabilities(client: [
                "sessions.read", "sessions.prompt", "sessions.control", "sessions.manage",
                "catalog.read", "files.list", "files.read",
                "term.open", "term.input", "term.resize",
            ])
        ) {
            self.identity = identity
            self.authentication = authentication
            self.requestedFeatures = requestedFeatures
            self.capabilities = capabilities
        }
    }

    public let transport: HostWireTransport
    public private(set) var config: Config
    public private(set) var state: State = .idle
    public private(set) var welcome: WelcomeFrame?
    public private(set) var lastFatal: HostClientError?

    /// Projections subscribe here for host→client frames the app renders
    /// (sessions inventory, snapshots, events, agents, confirmation challenges).
    public let frames: AsyncStream<ServerFrame>
    private let frameContinuation: AsyncStream<ServerFrame>.Continuation

    /// Pending command requests awaiting their response, keyed by requestId.
    private var pending: [RequestId: CheckedContinuation<ResultFrame, any Error>] = [:]
    private var welcomeCont: CheckedContinuation<WelcomeFrame, any Error>?
    private var pairCont: CheckedContinuation<PairOkFrame, any Error>?

    private var cursorJournal: [SessionKey: Cursor] = [:]
    private var heartbeatNonce: String?
    private var heartbeatTimeoutTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var receiveTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var attempt = 0
    private var closedByUser = false

    public init(transport: HostWireTransport, config: Config) {
        self.transport = transport
        self.config = config
        var cont: AsyncStream<ServerFrame>.Continuation!
        self.frames = AsyncStream { cont = $0 }
        self.frameContinuation = cont
    }

    // MARK: - Connect / handshake

    /// Open the socket and complete the hello → welcome handshake. Returns the
    /// welcome frame; throws on transport/protocol/timeout. On
    /// `pairing-required` the state becomes `.pairing` (call `pair(...)`).
    @discardableResult
    public func connect() async throws -> WelcomeFrame {
        closedByUser = false
        try await openSocketAndHandshake()
        if state == .ready { attempt = 0 }
        return welcome!
    }

    private func openSocketAndHandshake() async throws {
        state = .connecting
        try await transport.open()
        state = .handshaking
        try await sendPayload(try encodeFrame(makeHello()))
        startReceiveLoop()
        startHeartbeat()
        let awaited = try await awaitWelcome(timeout: config.handshakeTimeout)
        welcome = awaited
        state = awaited.authentication == .pairingRequired ? .pairing : .ready
    }

    private func awaitWelcome(timeout: TimeInterval) async throws -> WelcomeFrame {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<WelcomeFrame, any Error>) in
            welcomeCont = cont
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(timeout))
                await self?.resumeWelcome(with: .failure(HostClientError.timeout("handshake")))
            }
        }
    }

    // MARK: - Pairing

    /// Send a pair.start and await pair.ok / pair.error. Only valid in pairing state.
    @discardableResult
    public func pair(_ intent: PairStartIntent) async throws -> PairOkFrame {
        guard state == .pairing else { throw HostClientError.invalidState("not in pairing state") }
        let frame = PairStartFrame(
            requestId: Self.id(), code: intent.code, deviceId: intent.deviceId,
            deviceName: intent.deviceName, platform: intent.platform,
            requestedCapabilities: intent.requestedCapabilities
        )
        try await sendPayload(try encodeFrame(frame))
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<PairOkFrame, any Error>) in
            pairCont = cont
            let pairTimeout = max(config.handshakeTimeout, 30)
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(pairTimeout))
                await self?.resumePair(with: .failure(HostClientError.timeout("pairing")))
            }
        }
    }

    // MARK: - Commands

    /// Send a host command and await its response (correlated by requestId).
    @discardableResult
    public func sendCommand(_ intent: CommandIntent) async throws -> ResultFrame {
        guard state == .ready || state == .pairing else { throw HostClientError.invalidState("client not ready") }
        let requestId = Self.id()
        let frame = try CommandFrame(
            requestId: requestId, commandId: Self.id(), hostId: intent.hostId,
            command: intent.command, args: intent.args, sessionId: intent.sessionId,
            expectedRevision: intent.expectedRevision, confirmationId: intent.confirmationId
        )
        let payload = try encodeFrame(frame)
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<ResultFrame, any Error>) in
            pending[requestId] = cont
            let timeout = config.commandTimeout
            Task { [weak self] in
                do { try await self?.sendPayload(payload) }
                catch { await self?.failPending(requestId, error) }
            }
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(timeout))
                await self?.failPending(requestId, HostClientError.timeout("command"))
            }
        }
    }

    /// Send a confirmation decision for a challenge.
    public func sendConfirm(_ intent: ConfirmIntent) async throws {
        let frame = ConfirmFrame(
            requestId: Self.id(), confirmationId: intent.confirmationId,
            commandId: intent.commandId, hostId: intent.hostId,
            sessionId: intent.sessionId, decision: intent.decision
        )
        try await sendPayload(try encodeFrame(frame))
    }

    /// Send a raw additive client → host frame (e.g. `terminal.input`,
    /// `terminal.resize`, `terminal.close`). These are not commands — they
    /// carry no requestId and get no response — so they bypass the command
    /// correlation machinery and are written directly to the transport.
    /// Throws if the client is not ready.
    public func sendFrame<T: Encodable>(_ frame: T) async throws {
        guard state == .ready || state == .pairing else {
            throw HostClientError.invalidState("client not ready")
        }
        try await sendPayload(try encodeFrame(frame))
    }

    // MARK: - Close / reconnect

    public func close() {
        closedByUser = true
        state = .closing
        heartbeatTask?.cancel(); heartbeatTask = nil
        heartbeatTimeoutTask?.cancel(); heartbeatTimeoutTask = nil
        reconnectTask?.cancel(); reconnectTask = nil
        receiveTask?.cancel(); receiveTask = nil
        transport.close()
        failAllPending(HostClientError.closed)
        resumeWelcome(with: .failure(HostClientError.closed))
        resumePair(with: .failure(HostClientError.closed))
        frameContinuation.finish()
        state = .closed
    }

    private func handleDisconnect(_ reason: String) {
        guard !closedByUser, state != .closed, state != .fatal, state != .closing, state != .reconnectWait else { return }
        state = .reconnectWait
        heartbeatTask?.cancel(); heartbeatTask = nil
        heartbeatTimeoutTask?.cancel(); heartbeatTimeoutTask = nil
        transport.close()
        failAllPending(HostClientError.transport(reason))
        attempt += 1
        let delay = min(config.reconnectBase * pow(2.0, Double(attempt - 1)), config.reconnectMax)
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            await self?.reconnect()
        }
    }

    private func reconnect() async {
        guard !closedByUser, state == .reconnectWait else { return }
        do {
            try await openSocketAndHandshake()
            if state == .ready { attempt = 0 }
        } catch {
            handleDisconnect("reconnect failed")
        }
    }

    // MARK: - Inbound

    private func startReceiveLoop() {
        receiveTask?.cancel()
        receiveTask = Task { [weak self] in
            while let self {
                do {
                    let data = try await self.receiveNext()
                    try await self.ingest(data)
                } catch {
                    t4wireLog.error("ingest failed: \(error)")
                    await self.handleDisconnect("\(error)")
                    break
                }
            }
        }
    }

    private func receiveNext() async throws -> Data { try await transport.receive() }
    private func sendPayload(_ data: Data) async throws {
        t4wireLog.debug("out: \(String(decoding: data, as: UTF8.self), privacy: .public)")
        try await transport.send(data)
    }

    private func ingest(_ data: Data) throws {
        t4wireLog.debug("in: \(String(decoding: data, as: UTF8.self).prefix(600), privacy: .public)")
        let frame = try ServerFrame.decode(data)
        switch frame {
        case .welcome(let w):
            resumeWelcome(with: .success(w))
        case .response(let r):
            if let cont = pending.removeValue(forKey: r.requestId) {
                // A host rejection is an error, not a result: ok:false carries
                // error.code/message and MUST surface to the caller (the TS
                // client throws; swallowing it hid session_busy/stale_revision
                // for weeks of UI behavior).
                if r.ok {
                    cont.resume(returning: r)
                } else {
                    cont.resume(throwing: HostClientError.commandFailed(
                        code: r.error?.code ?? "unknown", message: r.error?.message ?? "command failed"))
                }
            }
        case .pong(let p):
            if p.nonce == heartbeatNonce {
                heartbeatNonce = nil
                heartbeatTimeoutTask?.cancel()
                heartbeatTimeoutTask = nil
            }
        case .bye(let b):
            frameContinuation.yield(frame)
            handleDisconnect("bye: \(b.code)")
        case .error(let e):
            frameContinuation.yield(frame)
            if e.code.lowercased() == "fatal" {
                state = .fatal
                lastFatal = .protocol(e.message)
                failAllPending(HostClientError.protocol(e.message))
            }
        case .pairOk(let ok):
            resumePair(with: .success(ok))
            config.authentication = DeviceAuthentication(deviceId: ok.deviceId, deviceToken: ok.deviceToken)
        case .pairError(let err):
            resumePair(with: .failure(HostClientError.protocol(err.message)))
        case .event(let ev):
            cursorJournal[SessionKey(hostId: ev.hostId, sessionId: ev.sessionId)] = ev.cursor
            frameContinuation.yield(frame)
        case .entry(let f):
            cursorJournal[SessionKey(hostId: f.hostId, sessionId: f.sessionId)] = f.cursor
            frameContinuation.yield(frame)
        case .snapshot(let f):
            cursorJournal[SessionKey(hostId: f.hostId, sessionId: f.sessionId)] = f.cursor
            frameContinuation.yield(frame)
        case .gap(let f):
            cursorJournal[SessionKey(hostId: f.hostId, sessionId: f.sessionId)] = f.to
            frameContinuation.yield(frame)
        case .agentState(let f):
            cursorJournal[SessionKey(hostId: f.hostId, sessionId: f.sessionId)] = f.cursor
            frameContinuation.yield(frame)
        case .agentLifecycle(let f):
            cursorJournal[SessionKey(hostId: f.hostId, sessionId: f.sessionId)] = f.cursor
            frameContinuation.yield(frame)
        case .agentProgress(let f):
            cursorJournal[SessionKey(hostId: f.hostId, sessionId: f.sessionId)] = f.cursor
            frameContinuation.yield(frame)
        case .agentEvent(let f):
            cursorJournal[SessionKey(hostId: f.hostId, sessionId: f.sessionId)] = f.cursor
            frameContinuation.yield(frame)
        case .agentTranscript(let f):
            cursorJournal[SessionKey(hostId: f.hostId, sessionId: f.sessionId)] = f.cursor
            frameContinuation.yield(frame)
        case .agent:
            frameContinuation.yield(frame)
        case .sessions, .confirmation, .terminalOutput, .terminalExit, .filesList, .filesRead, .filesWrite, .filesPatch, .filesDiff, .auditTail, .auditEvent, .catalog, .settings, .hostWatch, .sessionWatch, .sessionState, .sessionDelta, .lease, .promptLease, .previewLaunch, .previewState, .previewNavigation, .previewCapture, .previewError, .legacyTerminal, .audit, .files, .review:
            frameContinuation.yield(frame)
        }
    }

    // MARK: - Heartbeat

    private func startHeartbeat() {
        heartbeatTask?.cancel()
        let interval = config.heartbeatInterval
        heartbeatTask = Task { [weak self] in
            while let self {
                try? await Task.sleep(for: .seconds(interval))
                if Task.isCancelled { break }
                await self.tickHeartbeat()
            }
        }
    }

    private func tickHeartbeat() {
        guard state == .ready || state == .pairing else { return }
        let nonce = Self.id()
        heartbeatNonce = nonce
        let ping = PingFrame(nonce: nonce, timestamp: ISO8601DateFormatter().string(from: Date()))
        let timeout = config.heartbeatTimeout
        Task { [weak self] in
            do { try await self?.sendPayload(try encodeFrame(ping)) }
            catch { await self?.handleDisconnect("ping send failed") }
        }
        heartbeatTimeoutTask?.cancel()
        heartbeatTimeoutTask = Task { [weak self, nonce] in
            try? await Task.sleep(for: .seconds(timeout))
            guard let self else { return }
            let missed = await self.clearHeartbeatIfPending(nonce: nonce)
            if missed { await self.handleDisconnect("heartbeat timeout") }
        }
    }

    private func clearHeartbeatIfPending(nonce: String) -> Bool {
        if heartbeatNonce == nonce { heartbeatNonce = nil; return true }
        return false
    }

    // MARK: - Hello + helpers

    private func makeHello() -> HelloFrame {
        let saved = cursorJournal.map { SavedCursor(hostId: $0.key.hostId, sessionId: $0.key.sessionId, cursor: $0.value) }
        return HelloFrame(
            protocolRange: ProtocolRange(min: Wire.protocolVersion, max: Wire.protocolVersion),
            client: config.identity,
            requestedFeatures: config.requestedFeatures,
            savedCursors: saved,
            capabilities: config.capabilities,
            authentication: config.authentication
        )
    }

    private static func id() -> String { UUID().uuidString }

    private func resumeWelcome(with result: Result<WelcomeFrame, any Error>) {
        guard let cont = welcomeCont else { return }
        welcomeCont = nil
        switch result {
        case .success(let w): cont.resume(returning: w)
        case .failure(let e): cont.resume(throwing: e)
        }
    }

    private func resumePair(with result: Result<PairOkFrame, any Error>) {
        guard let cont = pairCont else { return }
        pairCont = nil
        switch result {
        case .success(let ok): cont.resume(returning: ok)
        case .failure(let e): cont.resume(throwing: e)
        }
    }

    private func failPending(_ requestId: RequestId, _ error: any Error) {
        if let cont = pending.removeValue(forKey: requestId) { cont.resume(throwing: error) }
    }

    private func failAllPending(_ error: HostClientError) {
        for (_, cont) in pending { cont.resume(throwing: error) }
        pending.removeAll()
    }
}

// MARK: - Intents + errors

public struct CommandIntent: Sendable {
    public let hostId: HostId
    public let sessionId: SessionId?
    public let command: String
    public let args: [String: JSONValue]
    public let expectedRevision: Revision?
    public let confirmationId: ConfirmationId?
    public init(hostId: HostId, command: String, args: [String: JSONValue] = [:], sessionId: SessionId? = nil, expectedRevision: Revision? = nil, confirmationId: ConfirmationId? = nil) {
        self.hostId = hostId; self.command = command; self.args = args
        self.sessionId = sessionId; self.expectedRevision = expectedRevision; self.confirmationId = confirmationId
    }
}

public struct ConfirmIntent: Sendable {
    public let confirmationId: ConfirmationId
    public let commandId: CommandId
    public let hostId: HostId
    public let sessionId: SessionId?
    public let decision: ConfirmDecision
    public init(confirmationId: ConfirmationId, commandId: CommandId, hostId: HostId, decision: ConfirmDecision, sessionId: SessionId? = nil) {
        self.confirmationId = confirmationId; self.commandId = commandId; self.hostId = hostId
        self.decision = decision; self.sessionId = sessionId
    }
}

public struct PairStartIntent: Sendable {
    public let code: String
    public let deviceId: DeviceId
    public let deviceName: String
    public let platform: String
    public let requestedCapabilities: [String]
    public init(code: String, deviceId: DeviceId, deviceName: String, platform: String, requestedCapabilities: [String]) {
        self.code = code; self.deviceId = deviceId; self.deviceName = deviceName
        self.platform = platform; self.requestedCapabilities = requestedCapabilities
    }
}

public enum HostClientError: Error, Sendable {
    case transport(String)
    case protocol_(String)
    case timeout(String)
    case closed
    case invalidState(String)
    /// Host answered ok:false — error.code/message from the response frame.
    case commandFailed(code: String, message: String)

    /// `protocol` is reserved in Swift; this maps the readable name to the `protocol_` case.
    public static func `protocol`(_ s: String) -> HostClientError { .protocol_(s) }
}
