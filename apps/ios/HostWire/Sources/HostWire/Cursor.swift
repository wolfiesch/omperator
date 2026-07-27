import Foundation

/// A per-session append cursor: an epoch string + a monotonic sequence number
/// (host-wire/src/cursor.ts). Epochs are bounded control-free (<= 128 bytes);
/// sequences are safe non-negative integers.
public struct Cursor: Codable, Equatable, Hashable, Sendable {
    public let epoch: String
    public let seq: Int

    public init(epoch: String, seq: Int) {
        self.epoch = epoch
        self.seq = seq
    }

    private enum CodingKeys: String, CodingKey { case epoch, seq }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        epoch = try Bounded.controlFree(try c.decode(String.self, forKey: .epoch), path: "cursor.epoch", maxBytes: Limits.maxEpochBytes)
        seq = try Bounded.seq(try c.decode(Int.self, forKey: .seq), path: "cursor.seq")
    }
}
