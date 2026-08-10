import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import HostWire

/// Windows' Foundation WebSocket implementation exposes each 16 KiB libcurl
/// callback as a separate message. HostWire sends one JSON object per WebSocket
/// message, so this seam rejoins those callbacks before handing a frame to
/// `HostClient` while continuing to use the shared URLSession transport.
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
        guard message.count == Self.foundationChunkSize,
              !Self.isCompleteJSONObject(message)
        else {
            return message
        }

        message.reserveCapacity(min(maximumMessageSize, Self.foundationChunkSize * 2))
        while message.count < maximumMessageSize {
            let chunk = try await transport.receive()
            guard chunk.count <= maximumMessageSize - message.count else {
                throw HostClientError.transport(
                    "host frame exceeds \(maximumMessageSize) bytes"
                )
            }
            message.append(chunk)
            if Self.isCompleteJSONObject(message) {
                return message
            }
            if chunk.count < Self.foundationChunkSize {
                // The callback stream ended but the payload is malformed. Return
                // it intact so HostClient reports the canonical JSON error.
                return message
            }
        }
        throw HostClientError.transport(
            "host frame exceeds \(maximumMessageSize) bytes"
        )
    }

    public func close() {
        transport.close()
    }

    private static func isCompleteJSONObject(_ data: Data) -> Bool {
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
                isInsideString = true
            case 0x7B, 0x5B:
                guard !rootClosed else { return false }
                sawRoot = true
                depth += 1
            case 0x7D, 0x5D:
                depth -= 1
                guard depth >= 0 else { return false }
                if sawRoot, depth == 0 {
                    rootClosed = true
                }
            case 0x20, 0x09, 0x0A, 0x0D:
                break
            default:
                if rootClosed {
                    return false
                }
            }
        }

        return sawRoot && rootClosed && depth == 0 && !isInsideString
    }
}
