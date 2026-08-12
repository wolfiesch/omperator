import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import HostWire

/// Windows Foundation can expose one WebSocket text message as multiple,
/// variably sized libcurl callbacks. HostWire sends one JSON object per message,
/// so this seam rejoins those callbacks before handing a frame to `HostClient`
/// while continuing to use the shared URLSession transport.
public final class WindowsURLSessionHostWireTransport: HostWireTransport {
    public static let defaultMaximumMessageSize = 32 * 1024 * 1024

    private static let foundationChunkSize = 16 * 1024

    private let transport: URLSessionHostWireTransport
    private let maximumMessageSize: Int

    public init(
        endpoint: URL,
        session: URLSession = .shared,
        maximumMessageSize: Int = defaultMaximumMessageSize
    ) {
        transport = URLSessionHostWireTransport(
            endpoint: endpoint,
            session: session
        )
        self.maximumMessageSize = maximumMessageSize
    }

    public func open() async throws {
        try await transport.open()
    }

    public func send(_ data: Data) async throws {
        try await transport.send(data)
    }

    public func receive() async throws -> Data {
        var message = try await transport.receive()
        guard message.count <= maximumMessageSize else {
            throw HostClientError.transport(
                "host frame exceeds \(maximumMessageSize) bytes"
            )
        }

        switch Self.jsonFrameState(message) {
        case .complete, .invalid:
            return message
        case .incomplete:
            break
        }

        message.reserveCapacity(
            min(maximumMessageSize, max(message.count * 2, Self.foundationChunkSize))
        )
        while message.count < maximumMessageSize {
            let chunk = try await transport.receive()
            guard chunk.count <= maximumMessageSize - message.count else {
                throw HostClientError.transport(
                    "host frame exceeds \(maximumMessageSize) bytes"
                )
            }
            message.append(chunk)
            switch Self.jsonFrameState(message) {
            case .complete:
                return message
            case .invalid:
                // Preserve malformed frames so HostClient reports its canonical
                // protocol decoding error instead of hiding it as a timeout.
                return message
            case .incomplete:
                continue
            }
        }
        throw HostClientError.transport(
            "host frame exceeds \(maximumMessageSize) bytes"
        )
    }

    public func close() {
        transport.close()
    }

    private enum JSONFrameState {
        case complete
        case incomplete
        case invalid
    }

    /// Classify an object/array frame without decoding or copying it. Windows
    /// Foundation does not reliably preserve the nominal 16 KiB callback size,
    /// so structural prefix validity—not fragment length—decides whether the
    /// next callback belongs to the current WebSocket message.
    private static func jsonFrameState(_ data: Data) -> JSONFrameState {
        var depth = 0
        var sawRoot = false
        var rootClosed = false
        var isInsideString = false
        var isEscaped = false

        for byte in data {
            if isInsideString {
                if isEscaped {
                    isEscaped = false
                } else if byte == 0x5C {
                    isEscaped = true
                } else if byte == 0x22 {
                    isInsideString = false
                }
                continue
            }

            switch byte {
            case 0x22:
                guard sawRoot, !rootClosed else { return .invalid }
                isInsideString = true
            case 0x7B, 0x5B:
                guard !rootClosed else { return .invalid }
                sawRoot = true
                depth += 1
            case 0x7D, 0x5D:
                guard sawRoot else { return .invalid }
                depth -= 1
                guard depth >= 0 else { return .invalid }
                if depth == 0 {
                    rootClosed = true
                }
            case 0x20, 0x09, 0x0A, 0x0D:
                break
            default:
                guard sawRoot, !rootClosed else { return .invalid }
            }
        }

        if sawRoot, rootClosed, depth == 0, !isInsideString {
            return .complete
        }
        return .incomplete
    }
}
