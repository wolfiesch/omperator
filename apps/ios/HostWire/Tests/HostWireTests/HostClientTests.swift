import Testing
import Foundation
@testable import HostWire

/// A scripted transport that emulates a t4-host for unit tests: it replies to
/// `hello` with a `welcome`, to a `command` with a matching `response`, and to
/// `ping` with `pong`. The test can also `enqueue` raw frames (e.g. a `sessions`
/// push) to exercise inbound routing/projections.
final class MockHostTransport: HostWireTransport {
    private let lock = NSLock()
    private var _sent = [Data]()
    private var buffer = [Data]()
    private var waiter: CheckedContinuation<Data, any Error>?
    private(set) var openCount = 0

    var sent: [Data] { sync { _sent } }

    private func sync<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }

    func open() async throws { sync { openCount += 1 } }

    func send(_ data: Data) async throws {
        sync { _sent.append(data) }
        guard let frame = try? ClientFrame.decode(data) else { return }
        switch frame {
        case .hello: enqueue(welcomeData())
        case .command(let c): enqueue(responseData(requestId: c.requestId, command: c.command))
        case .ping(let p): enqueue(pongData(nonce: p.nonce))
        default: break
        }
    }

    func receive() async throws -> Data {
        if let buffered: Data = sync({ buffer.isEmpty ? nil : buffer.removeFirst() }) { return buffered }
        return try await withCheckedThrowingContinuation { (c: CheckedContinuation<Data, any Error>) in
            sync { waiter = c }
        }
    }

    func close() {
        let w: CheckedContinuation<Data, any Error>? = sync {
            let w = waiter
            waiter = nil
            buffer.removeAll()
            return w
        }
        w?.resume(throwing: HostClientError.closed)
    }

    func enqueue(_ data: Data) {
        let w: CheckedContinuation<Data, any Error>? = sync {
            if let w = waiter { waiter = nil; return w }
            buffer.append(data)
            return nil
        }
        w?.resume(returning: data)
    }

    private func welcomeData() -> Data {
        Data("""
        {"v":"omp-app/1","type":"welcome","selectedProtocol":"omp-app/1","hostId":"host-a",\
        "ompVersion":"17","ompBuild":"b","appserverVersion":"1","appserverBuild":"b",\
        "epoch":"epoch-1","grantedCapabilities":["sessions.read"],"grantedFeatures":["resume"],\
        "negotiatedLimits":{},"authentication":"paired","resumed":false}
        """.utf8)
    }

    private func responseData(requestId: String, command: String) -> Data {
        Data("""
        {"v":"omp-app/1","type":"response","requestId":"\(requestId)","commandId":"cmd",\
        "hostId":"host-a","sessionId":"s1","command":"\(command)","ok":true,\
        "result":{"cursor":{"epoch":"e","seq":0},"sessions":[],"totalCount":0,"truncated":false}}
        """.utf8)
    }

    private func pongData(nonce: String) -> Data {
        Data("""
        {"v":"omp-app/1","type":"pong","nonce":"\(nonce)","timestamp":"t"}
        """.utf8)
    }
}

struct HostClientTests {
    private func makeClient(transport: MockHostTransport) -> HostClient {
        var config = HostClient.Config(identity: ClientIdentity(name: "t4-ios", version: "1", build: "dev", platform: "ios"))
        config.handshakeTimeout = 5
        config.commandTimeout = 5
        config.heartbeatInterval = 3600
        return HostClient(transport: transport, config: config)
    }

    @Test("Client completes hello/welcome and reaches ready")
    func handshake() async throws {
        let mock = MockHostTransport()
        let client = makeClient(transport: mock)
        let welcome = try await client.connect()
        #expect(welcome.authentication == .paired)
        #expect(welcome.hostId == "host-a")
        #expect(await client.state == .ready)
        // hello was the first thing sent.
        let first = try ClientFrame.decode(mock.sent[0])
        guard case .hello = first else { Issue.record("expected hello first"); return }
        await client.close()
    }

    @Test("Command dispatch correlates request to response")
    func commandDispatch() async throws {
        let mock = MockHostTransport()
        let client = makeClient(transport: mock)
        _ = try await client.connect()
        let result = try await client.sendCommand(CommandIntent(hostId: "host-a", command: "session.list"))
        #expect(result.ok == true)
        #expect(result.command == "session.list")
        // The mock echoed our requestId back.
        let response = try #require(mock.sent.last { data in
            (try? ClientFrame.decode(data)).map { if case .command = $0 { return true }; return false } ?? false
        })
        let cmd = try ClientFrame.decode(response)
        guard case .command(let c) = cmd else { Issue.record("expected command"); return }
        #expect(result.requestId == c.requestId)
        await client.close()
    }

    @Test("Inbound sessions push surfaces on the projection stream")
    func sessionsStream() async throws {
        let mock = MockHostTransport()
        let client = makeClient(transport: mock)
        _ = try await client.connect()
        mock.enqueue(Data("""
        {"v":"omp-app/1","type":"sessions","hostId":"host-a","cursor":{"epoch":"e","seq":1},\
        "sessions":[{"hostId":"host-a","sessionId":"s1","project":{"projectId":"p"},\
        "revision":"r","title":"T","status":"active","updatedAt":"2026-07-11T10:00:00Z"}],\
        "totalCount":1,"truncated":false}
        """.utf8))
        let stream = await client.frames
        var it = stream.makeAsyncIterator()
        let first = await it.next()
        guard case .sessions(let inv) = first else { Issue.record("expected sessions frame"); return }
        #expect(inv.sessions.count == 1)
        #expect(inv.sessions.first?.title == "T")
        await client.close()
    }
}
