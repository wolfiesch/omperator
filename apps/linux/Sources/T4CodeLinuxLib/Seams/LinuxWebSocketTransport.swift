//  LinuxWebSocketTransport.swift (Linux)
//  Production `HostWireTransport` for Linux. FoundationNetworking's
//  URLSession WebSocket support is not usable here — swift-corelibs
//  requires libcurl built with WebSockets, which the distro curl lacks
//  ("WebSockets not supported by libcurl").
//
//  This is a compact RFC 6455 client over BSD sockets:
//    - ws://   plain TCP
//    - wss://  rejected with a clear error (TLS not yet wired; the fixture
//              smoke test and Tailnet routes use ws://)
//  Frames: masked client text frames, unmasked server text/binary frames,
//  ping/pong keepalive passthrough, close handshake. One reader task owns
//  receive(); send() is a continuation on the same socket.

import Foundation
import Glibc
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import HostWire

final class LinuxWebSocketTransport: HostWireTransport {
    private let endpoint: URL
    private var fd: Int32 = -1
    private var readerTask: Task<Void, Never>?
    private var inbox: AsyncStream<Data>.Continuation?
    private var stream: AsyncStream<Data>?
    private var closed = false
    private let lock = NSLock()

    private static let clientKey = { () -> String in
        var bytes = [UInt8](repeating: 0, count: 16)
        for i in 0..<16 { bytes[i] = UInt8.random(in: 0...255) }
        return Data(bytes).base64EncodedString()
    }()

    /// -T4Origin= seam: the Tailnet gateway rejects every WebSocket upgrade
    /// whose Origin is not its exact allowed set. A native client sends no
    /// Origin by default, so this injects the tailnet HTTPS origin for local
    /// ws:// connections routed through the gateway.
    static var upgradeOrigin: String? {
        ProcessInfo.processInfo.arguments
            .first(where: { $0.hasPrefix("-T4Origin=") })
            .map { String($0.dropFirst("-T4Origin=".count)) }
            .flatMap { $0.isEmpty ? nil : $0 }
    }

    init(endpoint: URL) {
        self.endpoint = endpoint
    }

    // MARK: - HostWireTransport

    func open() async throws {
        guard endpoint.scheme == "ws" || endpoint.scheme == "wss" else {
            throw HostClientError.transport("unsupported scheme \(endpoint.scheme ?? "nil")")
        }
        guard endpoint.scheme == "ws" else {
            throw HostClientError.transport(
                "wss:// requires TLS which the Linux transport does not implement yet; use ws:// (Tailnet-encrypted)"
            )
        }
        guard let host = endpoint.host, let port = endpoint.port else {
            throw HostClientError.transport("endpoint missing host/port")
        }

        // Resolve + connect (blocking, quick).
        let sockfd: Int32 = try Self.connectTCP(host: host, port: UInt16(port))
        fd = sockfd

        // HTTP/1.1 upgrade request.
        let path = endpoint.path.isEmpty ? "/" : endpoint.path
        let query = endpoint.query.map { "?\($0)" } ?? ""
        var originHeader = ""
        if let origin = Self.upgradeOrigin {
            originHeader = "Origin: \(origin)\r\n"
        }
        let request =
            "GET \(path)\(query) HTTP/1.1\r\n" +
            "Host: \(host):\(port)\r\n" +
            originHeader +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Key: \(Self.clientKey)\r\n" +
            "Sec-WebSocket-Version: 13\r\n" +
            "\r\n"
        try writeAll(Data(request.utf8))

        // Read the response head (until \r\n\r\n).
        var head = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while head.range(of: Data("\r\n\r\n".utf8), options: []) == nil {
            let n = read(sockfd, &buffer, buffer.count)
            if n <= 0 { throw HostClientError.transport("connection closed during handshake") }
            head.append(contentsOf: buffer[0..<n])
            if head.count > 64_000 { throw HostClientError.transport("oversized handshake") }
        }
        let headText = String(decoding: head, as: UTF8.self)
        guard headText.hasPrefix("HTTP/1.1 101") || headText.hasPrefix("HTTP/1.0 101") else {
            let statusLine = headText.split(separator: "\r\n").first ?? ""
            throw HostClientError.transport("upgrade failed: \(statusLine)")
        }

        // Start the reader loop.
        let (stream, continuation) = AsyncStream.makeStream(of: Data.self)
        self.stream = stream
        inbox = continuation
        readerTask = Task { [weak self] in
            self?.readLoop(stream: stream)
        }
    }

    func send(_ data: Data) async throws {
        try Self.writeFrame(fd: fd, opcode: 0x1, payload: data)
    }

    func receive() async throws -> Data {
        guard let stream else { throw HostClientError.transport("socket not open") }
        for await data in stream {
            return data
        }
        throw HostClientError.transport("closed by host")
    }

    func close() {
        lock.lock()
        let fd = self.fd
        self.fd = -1
        closed = true
        lock.unlock()
        if fd >= 0 {
            var closePayload = Data([0x03, 0xE8]) // 1000 normal
            _ = try? Self.writeFrame(fd: fd, opcode: 0x8, payload: closePayload)
            shutdown(fd, Int32(SHUT_RDWR))
            Glibc.close(fd)
        }
        inbox?.finish()
        readerTask?.cancel()
    }

    // MARK: - Reader

    private func readLoop(stream: AsyncStream<Data>) {
        var buffer = [UInt8](repeating: 0, count: 65_536)
        var pending = Data()
        while !Task.isCancelled {
            let n = read(fd, &buffer, buffer.count)
            if n <= 0 {
                inbox?.finish()
                return
            }
            pending.append(contentsOf: buffer[0..<n])

            // Parse all complete frames in `pending`.
            while true {
                guard let (frame, consumed) = try? Self.parseFrame(pending) else {
                    break
                }
                pending.removeFirst(consumed)
                switch frame.opcode {
                case 0x0, 0x1, 0x2:
                    inbox?.yield(frame.payload)
                case 0x8: // close
                    _ = try? Self.writeFrame(fd: fd, opcode: 0x8, payload: Data([0x03, 0xE8]))
                    inbox?.finish()
                    return
                case 0x9: // ping → pong
                    _ = try? Self.writeFrame(fd: fd, opcode: 0xA, payload: frame.payload)
                case 0xA: // pong
                    break
                default:
                    break
                }
            }
        }
        inbox?.finish()
    }

    private struct Frame {
        let opcode: UInt8
        let payload: Data
    }

    private static func parseFrame(_ data: Data) throws -> (Frame, Int) {
        guard data.count >= 2 else { throw TransportError.incomplete }
        let opcode = data[data.startIndex] & 0x0F
        let masked = (data[data.startIndex + 1] & 0x80) != 0
        var payloadLen = UInt64(data[data.startIndex + 1] & 0x7F)
        var offset = 2
        if payloadLen == 126 {
            guard data.count >= offset + 2 else { throw TransportError.incomplete }
            payloadLen = UInt64(data[data.startIndex + offset]) << 8 | UInt64(data[data.startIndex + offset + 1])
            offset += 2
        } else if payloadLen == 127 {
            guard data.count >= offset + 8 else { throw TransportError.incomplete }
            payloadLen = 0
            for i in 0..<8 {
                payloadLen = payloadLen << 8 | UInt64(data[data.startIndex + offset + i])
            }
            offset += 8
        }
        var maskKey: [UInt8] = []
        if masked {
            guard data.count >= offset + 4 else { throw TransportError.incomplete }
            maskKey = Array(data[data.startIndex + offset..<data.startIndex + offset + 4])
            offset += 4
        }
        guard data.count >= offset + Int(payloadLen) else { throw TransportError.incomplete }
        var payload = Array(data[data.startIndex + offset..<data.startIndex + offset + Int(payloadLen)])
        if masked {
            for i in 0..<payload.count {
                payload[i] ^= maskKey[i % 4]
            }
        }
        return (Frame(opcode: opcode, payload: Data(payload)), offset + Int(payloadLen))
    }

    private enum TransportError: Error { case incomplete }

    // MARK: - Socket helpers

    private static func connectTCP(host: String, port: UInt16) throws -> Int32 {
        var hints = addrinfo()
        hints.ai_family = AF_UNSPEC
        hints.ai_socktype = Int32(SOCK_STREAM.rawValue)
        var result: UnsafeMutablePointer<addrinfo>?
        let status = getaddrinfo(host, String(port), &hints, &result)
        guard status == 0, result != nil else {
            throw HostClientError.transport("resolve failed: \(gai_strerror(status).map(String.init) ?? "?")")
        }
        let address = result!
        defer { freeaddrinfo(address) }

        var lastError: Int32 = 0
        var addr: UnsafeMutablePointer<addrinfo>? = address
        while let current = addr {
            let sockfd = Int32(socket(current.pointee.ai_family, current.pointee.ai_socktype, current.pointee.ai_protocol))
            if sockfd >= 0 {
                var noDelay: Int32 = 1
                setsockopt(sockfd, Int32(IPPROTO_TCP), TCP_NODELAY, &noDelay, socklen_t(MemoryLayout<Int32>.size))
                if connect(sockfd, current.pointee.ai_addr, current.pointee.ai_addrlen) == 0 {
                    return sockfd
                }
                lastError = errno
                Glibc.close(sockfd)
            }
            addr = current.pointee.ai_next
        }
        throw HostClientError.transport("connect failed: \(String(cString: strerror(lastError)))")
    }

    private func writeAll(_ data: Data) throws {
        try data.withUnsafeBytes { raw in
            var written = 0
            while written < data.count {
                let n = write(fd, raw.baseAddress!.advanced(by: written), data.count - written)
                if n < 0 {
                    if errno == EINTR { continue }
                    throw HostClientError.transport("write failed: \(String(cString: strerror(errno)))")
                }
                written += n
            }
        }
    }

    private static func writeFrame(fd: Int32, opcode: UInt8, payload: Data) throws {
        var header = Data()
        header.append(0x80 | opcode)
        let len = payload.count
        if len < 126 {
            header.append(0x80 | UInt8(len))
        } else if len < 65_536 {
            header.append(0x80 | 126)
            header.append(UInt8((len >> 8) & 0xFF))
            header.append(UInt8(len & 0xFF))
        } else {
            header.append(0x80 | 127)
            var big = UInt64(len).bigEndian
            withUnsafeBytes(of: &big) { header.append(contentsOf: $0) }
        }
        var mask = [UInt8](repeating: 0, count: 4)
        for i in 0..<4 { mask[i] = UInt8.random(in: 0...255) }
        header.append(contentsOf: mask)

        var masked = [UInt8](payload)
        for i in 0..<masked.count { masked[i] ^= mask[i % 4] }

        var out = Data(header)
        out.append(contentsOf: masked)
        var written = 0
        let count = out.count
        let base = out.withUnsafeBytes { $0.baseAddress! }
        while written < count {
            let n = write(fd, base.advanced(by: written), count - written)
            if n < 0 {
                if errno == EINTR { continue }
                throw HostClientError.transport("frame write failed: \(String(cString: strerror(errno)))")
            }
            written += n
        }
    }
}
