import Foundation

/// Transport seam for the host-wire client. Decouples the protocol logic (and
/// its unit tests) from the concrete socket. `URLSessionHostWireTransport` is
/// the production implementation; tests inject a mock.
public protocol HostWireTransport: AnyObject {
    /// Open the underlying socket (create + resume the WebSocket task).
    func open() async throws
    /// Send one framed JSON message.
    func send(_ data: Data) async throws
    /// Await the next inbound message; throws on close/error.
    func receive() async throws -> Data
    /// Close the socket; subsequent `receive` calls must throw.
    func close()
}

/// Production transport over `URLSessionWebSocketTask` (iOS 13+ / macOS 10.15+).
public final class URLSessionHostWireTransport: HostWireTransport {
    private let endpoint: URL
    private let session: URLSession
    private var task: URLSessionWebSocketTask?

    public init(endpoint: URL, session: URLSession = .shared) {
        self.endpoint = endpoint
        self.session = session
    }

    public func open() async throws {
        let task = session.webSocketTask(with: endpoint)
        self.task = task
        task.resume()
    }

    public func send(_ data: Data) async throws {
        guard let task else { throw HostClientError.transport("socket not open") }
        guard let text = String(data: data, encoding: .utf8) else {
            throw HostClientError.transport("frame is not UTF-8")
        }
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            task.send(.string(text)) { error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }
        }
    }

    public func receive() async throws -> Data {
        guard let task else { throw HostClientError.transport("socket not open") }
        do {
            let message = try await task.receive()
            switch message {
            case .data(let data): return data
            case .string(let text): return Data(text.utf8)
            @unknown default: throw HostClientError.transport("unknown websocket message")
            }
        } catch {
            // Surface the server's close code — policy denials (1008) vs
            // transport faults look identical otherwise.
            let code = task.closeCode
            let reason = task.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            throw HostClientError.transport("closed by host: \(code.rawValue) \(reason)")
        }
    }

    public func close() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }
}
