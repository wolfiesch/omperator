// Public rendezvous relay transport, source-aligned with apps/ios/Sources/T4RelayPipe.swift.

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import HostWire
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

public actor T4RelayPipe {
    public enum PipeError: Error, Sendable {
        case closed
        case notConnected
        case socketClosed
        case corruptedFrame
        case roomUnavailable(Int)
    }

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
        inbound = stream
        continuation = cont
    }

    public func connect(code: String?) async throws {
        guard !terminated else { throw PipeError.closed }
        if state == .closed {
            closedByUser = false
            makeStream()
            state = .idle
        }
        guard state == .idle || state == .reconnectWait else { return }
        state = .connecting
        openSocket()
        if let code { sendPairFrame(code) }
    }

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
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            task.send(.data(envelope)) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            }
        }
    }

    public func receive() -> AsyncThrowingStream<Data, Error> { inbound }

    public func close() {
        guard !closedByUser else { return }
        closedByUser = true
        state = .closed
        attempt = 0
        reconnectTask?.cancel()
        reconnectTask = nil
        receiveTask?.cancel()
        receiveTask = nil
        teardownSocket()
        continuation.finish()
    }

    private func openSocket() {
        state = .connecting
        let session = URLSession(configuration: .default)
        let task = session.webSocketTask(with: link)
        task.maximumMessageSize = 128 * 1024 * 1024
        self.session = session
        self.task = task
        task.resume()
        startReceiveLoop()
    }

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

    private func closeCodeAfterFailure() -> Int { task?.closeCode.rawValue ?? 0 }

    private func ingest(_ message: URLSessionWebSocketTask.Message) {
        guard !terminated, !closedByUser else { return }
        switch message {
        case .data(let data):
            guard let envelope = T4CollabWire.unpackEnvelope(data),
                  let plain = T4CollabWire.openRaw(envelope.payload, key: key),
                  plain.count > 1
            else {
                terminate(.corruptedFrame)
                return
            }
            attempt = 0
            continuation.yield(plain.subdata(in: 1..<plain.count))
        case .string:
            break
        @unknown default:
            break
        }
    }

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
            try? await self?.connect(code: nil)
        }
    }

    private static func reconnectDelay(attempt: Int) -> TimeInterval {
        let base = min(pow(2.0, Double(attempt)), 30.0)
        return base * (0.75 + Double.random(in: 0..<0.5))
    }

    private func terminate(_ error: PipeError) {
        guard !terminated else { return }
        terminated = true
        state = .closed
        attempt = 0
        reconnectTask?.cancel()
        reconnectTask = nil
        receiveTask?.cancel()
        receiveTask = nil
        teardownSocket()
        continuation.finish(throwing: error)
    }

    private func makeStream() {
        let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        inbound = stream
        self.continuation = continuation
    }

    private func teardownSocket() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
    }
}

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
        iterator = await pipe.receive().makeAsyncIterator()
    }

    func send(_ data: Data) async throws { try await pipe.send(data) }

    func receive() async throws -> Data {
        if iterator == nil { iterator = await pipe.receive().makeAsyncIterator() }
        guard let next = try await iterator?.next() else {
            throw HostClientError.transport("relay pipe closed")
        }
        return next
    }

    func close() { Task { await pipe.close() } }
}
