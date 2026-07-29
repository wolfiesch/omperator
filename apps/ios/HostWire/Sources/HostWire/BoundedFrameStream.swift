import Foundation

/// A byte-bounded, backpressured frame stream. The transport receive loop
/// pauses when the UI consumer falls behind instead of accumulating an
/// unbounded AsyncStream buffer on the MainActor.
public struct BoundedFrameStream: AsyncSequence, Sendable {
    public typealias Element = ServerFrame

    public struct AsyncIterator: AsyncIteratorProtocol {
        fileprivate let buffer: BoundedFrameBuffer

        public mutating func next() async -> ServerFrame? {
            await buffer.next()
        }
    }

    fileprivate let buffer: BoundedFrameBuffer

    fileprivate init(buffer: BoundedFrameBuffer) {
        self.buffer = buffer
    }

    public func makeAsyncIterator() -> AsyncIterator {
        AsyncIterator(buffer: buffer)
    }
}

actor BoundedFrameBuffer {
    private struct Item {
        let frame: ServerFrame
        let bytes: Int
    }

    private let maxBytes: Int
    private var queuedBytes = 0
    private var queue: [Item] = []
    private var receivers: [CheckedContinuation<Item?, Never>] = []
    private var producers: [CheckedContinuation<Void, Never>] = []
    private var finished = false

    init(maxBytes: Int) {
        self.maxBytes = maxBytes
    }

    func enqueue(_ frame: ServerFrame, byteCount: Int) async throws {
        guard byteCount > 0, byteCount <= maxBytes else {
            throw HostClientError.protocol("inbound frame exceeds the native buffer limit")
        }
        while !finished && receivers.isEmpty && queuedBytes + byteCount > maxBytes {
            await withCheckedContinuation { continuation in
                producers.append(continuation)
            }
        }
        guard !finished else { throw HostClientError.closed }
        let item = Item(frame: frame, bytes: byteCount)
        if !receivers.isEmpty {
            receivers.removeFirst().resume(returning: item)
            return
        }
        queue.append(item)
        queuedBytes += byteCount
    }

    func next() async -> ServerFrame? {
        if !queue.isEmpty {
            let item = queue.removeFirst()
            queuedBytes -= item.bytes
            let waiting = producers
            producers.removeAll()
            waiting.forEach { $0.resume() }
            return item.frame
        }
        if finished { return nil }
        let item = await withCheckedContinuation { continuation in
            receivers.append(continuation)
        }
        return item?.frame
    }

    func finish() {
        guard !finished else { return }
        finished = true
        queue.removeAll()
        queuedBytes = 0
        let waitingReceivers = receivers
        receivers.removeAll()
        waitingReceivers.forEach { $0.resume(returning: nil) }
        let waitingProducers = producers
        producers.removeAll()
        waitingProducers.forEach { $0.resume() }
    }
}
