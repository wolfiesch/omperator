//  T4RelayPipe.swift
//  The public (rendezvous) control-plane guest — "the pipe". Joins a
//  pairLink WebSocket as a guest, speaks the sealed pair-code protocol
//  (mirror of scripts/relay-control.mjs), and yields host-wire bytes to the
//  consumer with the type prefix stripped. `T4RelayTransport` adapts the pipe
//  to the `HostWireTransport` seam so a `HostClient` can run over it.
//
//  Wire protocol:
//    - Sealed binary envelopes `[4B big-endian peerId][12B IV][ciphertext+16B
//      tag]` with the room key from the pairLink. The guest sends peerId 0 and
//      reads every envelope regardless of the addressed peer.
//    - The FIRST sealed frame on a fresh room must be JSON
//      `{ "t": "pair", "code": "NNNNNN" }` — no type prefix. The host
//      validates the code and binds the peer; wrong/expired codes are
//      rejected. Rejoining the same link later (persisted, or after a
//      transient drop) requires NO code — the link is the credential and the
//      host rebinds.
//    - After binding, every sealed payload is host-wire bytes with a 1-byte
//      type prefix: `[0x00]` + UTF-8 (JSON host-wire frames) or `[0x01]` +
//      binary. The pipe always sends text (`[0x00] + bytes`); inbound
//      payloads are stripped of the prefix and yielded raw.
//    - TEXT WebSocket messages are relay control frames (e.g. peer-left) —
//      never decrypted, ignored by the pipe.
//    - Fatal relay close codes (4001 room closed, 4004 no such room, 4009
//      host taken, 4029 room full — T4CollabWire.fatalCloseCodes) are
//      terminal: the stream ends with an error. Transient drops reconnect
//      with exponential backoff (1s…30s, jittered) and the stream survives.

import Foundation
import HostWire
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// The E2E control-room guest for the public connect path.
///
/// The inbound stream (`receive()`) yields one Data per sealed host-wire
/// frame, in wire order, with the 1-byte type prefix already stripped. It
/// ends after `close()`, a fatal relay close code (throws
/// `PipeError.roomUnavailable`), or a decryption failure (throws
/// `PipeError.corruptedFrame`). Transient drops are invisible to the
/// consumer — the pipe rejoins on its own.
public actor T4RelayPipe {
    public enum PipeError: Error, Sendable {
        /// The pipe is terminated (user close or a terminal fault) or was
        /// never connected.
        case closed
        /// No socket is currently open (transient reconnect in progress).
        case notConnected
        /// The current socket went away without a close code (receive threw).
        case socketClosed
        /// A sealed envelope failed to decrypt or was structurally invalid.
        case corruptedFrame
        /// The relay closed the room with a fatal close code.
        case roomUnavailable(Int)
    }

    /// Inbound host-wire bytes, type prefix stripped, one element per frame.
    public private(set) var inbound: AsyncThrowingStream<Data, Error>
    private var continuation: AsyncThrowingStream<Data, Error>.Continuation!

    private let link: URL
    private let key: SymmetricKey
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var attempt = 0
    private var terminated = false
    private var closedByUser = false
    private var state: State = .idle

    private enum State: Sendable {
        case idle, connecting, live, reconnectWait, closed
    }

    public init(link: URL, key: SymmetricKey) {
        self.link = link
        self.key = key
        let (stream, cont) = AsyncThrowingStream<Data, Error>.makeStream()
        self.inbound = stream
        self.continuation = cont
    }

    // MARK: - Lifecycle

    /// Join the control room. `code` sends the pairing frame as the first
    /// sealed message — only for a fresh connection; the code is single-use,
    /// so reconnects and rejoins pass nil (the link alone is the credential).
    /// After a `close()` the pipe can be re-opened (HostClient reconnect
    /// cycles); after a terminal fault it throws `PipeError.closed`.
    public func connect(code: String?) async throws {
        guard !terminated else { throw PipeError.closed }
        if state == .closed {
            // Reopen after a transport close: a fresh socket needs a fresh
            // stream (the previous one was finished by close()).
            closedByUser = false
            makeStream()
            state = .idle
        }
        guard state == .idle || state == .reconnectWait else { return }
        state = .connecting
        openSocket()
        if let code {
            sendPairFrame(code)
        }
    }

    /// Send host-wire bytes upstream as a type-0 (text) frame. Throws when
    /// the socket is not open (transient reconnect in flight) or the pipe is
    /// terminated.
    public func send(_ data: Data) async throws {
        guard !terminated, !closedByUser else { throw PipeError.closed }
        guard let task else { throw PipeError.notConnected }
        var payload = Data(count: 1)
        payload[0] = 0x00
        payload.append(data)
        guard let sealed = T4CollabWire.sealRaw(payload, key: key) else {
            throw PipeError.corruptedFrame
        }
        let envelope = T4CollabWire.packEnvelope(peerId: 0, sealed: sealed)
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, any Error>) in
            task.send(.data(envelope)) { error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }
        }
    }

    /// The inbound host-wire byte stream (type prefix stripped). Returns the
    /// stream of the current connection; a reopened pipe hands back a fresh
    /// stream.
    public func receive() -> AsyncThrowingStream<Data, Error> {
        inbound
    }

    /// Close the current socket and end the stream. Re-openable via
    /// `connect(code:)` (HostClient calls close() then open() across its
    /// reconnect cycles); the user-facing terminality is HostClient's own
    /// `closedByUser`.
    public func close() {
        guard !closedByUser else { return }
        closedByUser = true
        state = .closed
        attempt = 0
        reconnectTask?.cancel(); reconnectTask = nil
        receiveTask?.cancel(); receiveTask = nil
        teardownSocket()
        continuation.finish()
    }

    // MARK: - Socket

    private func openSocket() {
        state = .connecting
        let session = URLSession(configuration: .default)
        let task = session.webSocketTask(with: link)
        // Host-wire snapshot frames can carry large payloads; the 1MB default
        // silently drops oversized frames. 128MB mirrors the collab guest.
        task.maximumMessageSize = 128 * 1024 * 1024
        self.session = session
        self.task = task
        task.resume()
        startReceiveLoop()
    }

    /// The pairing frame is pure JSON — no type prefix (the relay validates
    /// the plaintext directly before binding). Fire-and-forget; ordering on
    /// the socket guarantees it lands before any `send(_:)` frame.
    private func sendPairFrame(_ code: String) {
        guard let frame = try? JSONSerialization.data(withJSONObject: ["t": "pair", "code": code]),
              let sealed = T4CollabWire.sealRaw(frame, key: key)
        else { return }
        let envelope = T4CollabWire.packEnvelope(peerId: 0, sealed: sealed)
        task?.send(.data(envelope)) { _ in }
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
        guard let task else { throw PipeError.socketClosed }
        return try await task.receive()
    }

    /// The raw close code of the current socket (0 when unknown/not open).
    private func closeCodeAfterFailure() -> Int {
        task?.closeCode.rawValue ?? 0
    }

    // MARK: - Inbound

    private func ingest(_ message: URLSessionWebSocketTask.Message) {
        guard !terminated, !closedByUser else { return }
        switch message {
        case .data(let data):
            // Binary = sealed envelope. Decrypt, strip the 1-byte type
            // prefix, yield the raw host-wire bytes. Every envelope is read
            // regardless of the addressed peer.
            guard let envelope = T4CollabWire.unpackEnvelope(data),
                  let plain = T4CollabWire.openRaw(envelope.payload, key: key),
                  plain.count > 1
            else {
                terminate(.corruptedFrame)
                return
            }
            // A live frame proves the room is healthy — reset the backoff.
            attempt = 0
            continuation.yield(plain.subdata(in: 1..<plain.count))
        case .string:
            // TEXT = relay control frame — never encrypted, ignored.
            break
        @unknown default:
            break
        }
    }

    // MARK: - Faults / reconnect / teardown

    private func handleTransportError(code: Int) {
        guard !terminated, !closedByUser else { return }
        teardownSocket()
        if T4CollabWire.fatalCloseCodes.contains(code) {
            terminate(.roomUnavailable(code))
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
            await self?.connect(code: nil)
        }
    }

    /// Exponential backoff 1s…30s with ±25% jitter (collab-web client.ts).
    private static func reconnectDelay(attempt: Int) -> TimeInterval {
        let base = min(1.0 * pow(2.0, Double(attempt)), 30.0)
        return base * (0.75 + Double.random(in: 0..<0.5))
    }

    /// End the stream with a terminal error. Terminal; further frames are
    /// ignored and later `connect` calls throw `PipeError.closed`.
    private func terminate(_ error: PipeError) {
        guard !terminated else { return }
        terminated = true
        state = .closed
        attempt = 0
        reconnectTask?.cancel(); reconnectTask = nil
        receiveTask?.cancel(); receiveTask = nil
        teardownSocket()
        continuation.finish(throwing: error)
    }

    private func makeStream() {
        let (stream, cont) = AsyncThrowingStream<Data, Error>.makeStream()
        self.inbound = stream
        self.continuation = cont
    }

    private func teardownSocket() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
    }
}

/// `HostWireTransport` adapter that runs a `HostClient` over a `T4RelayPipe`.
/// `open()` connects the pipe — the pairing code is presented only on the
/// very first open (the code is single-use); every later open is a rejoin
/// where the saved link is the credential.
final class T4RelayTransport: HostWireTransport {
    private let pipe: T4RelayPipe
    private let code: String?
    private var hasConnected = false
    private var iterator: AsyncThrowingStream<Data, Error>.Iterator?

    init(pipe: T4RelayPipe, code: String?) {
        self.pipe = pipe
        self.code = code
    }

    func open() async throws {
        try await pipe.connect(code: hasConnected ? nil : code)
        hasConnected = true
        // A reopened pipe (HostClient reconnect cycle) carries a fresh stream.
        iterator = await pipe.receive().makeAsyncIterator()
    }

    func send(_ data: Data) async throws {
        try await pipe.send(data)
    }

    func receive() async throws -> Data {
        if iterator == nil { iterator = await pipe.receive().makeAsyncIterator() }
        guard let next = try await iterator?.next() else {
            throw HostClientError.transport("relay pipe closed")
        }
        return next
    }

    func close() {
        Task { await pipe.close() }
    }
}
