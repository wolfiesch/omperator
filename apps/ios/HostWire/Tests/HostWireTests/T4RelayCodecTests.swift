import Testing
import Foundation
@testable import HostWire
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// Raw AES-256-GCM + envelope codec for the public (relay) control plane —
/// mirror of scripts/relay-control.mjs's `seal`/`open`/`packEnvelope`/
/// `unpackEnvelope`.
struct T4RelayCodecTests {
    @Test("sealRaw/openRaw round-trip is [12B IV][ciphertext+16B tag]")
    func rawRoundTrip() {
        let key = SymmetricKey(size: .bits256)
        let plain = Data("host-wire bytes".utf8)
        let sealed = T4CollabWire.sealRaw(plain, key: key)
        #expect(sealed != nil)
        #expect(sealed!.count == 12 + plain.count + 16)
        #expect(T4CollabWire.openRaw(sealed!, key: key) == plain)
    }

    @Test("sealRaw uses a fresh random IV per frame")
    func rawFreshIV() {
        let key = SymmetricKey(size: .bits256)
        let plain = Data("same plaintext".utf8)
        let first = T4CollabWire.sealRaw(plain, key: key)!
        let second = T4CollabWire.sealRaw(plain, key: key)!
        #expect(first != second)
        #expect(T4CollabWire.openRaw(first, key: key) == T4CollabWire.openRaw(second, key: key))
    }

    @Test("openRaw rejects a wrong key and structurally short payloads")
    func rawBadInputs() {
        let key = SymmetricKey(size: .bits256)
        let other = SymmetricKey(size: .bits256)
        let sealed = T4CollabWire.sealRaw(Data("secret".utf8), key: key)!
        #expect(T4CollabWire.openRaw(sealed, key: other) == nil)
        #expect(T4CollabWire.openRaw(Data([0, 1, 2]), key: key) == nil)
    }

    @Test("packEnvelope/unpackEnvelope are [4B big-endian][payload]")
    func envelope() {
        let payload = Data("sealed-bytes".utf8)
        let packed = T4CollabWire.packEnvelope(peerId: 0x0102_0304, sealed: payload)
        #expect(packed.count == 4 + payload.count)
        #expect(Array(packed.prefix(4)) == [0x01, 0x02, 0x03, 0x04])
        let unpacked = T4CollabWire.unpackEnvelope(packed)
        #expect(unpacked?.peerId == 0x0102_0304)
        #expect(unpacked?.payload == payload)
        // Too short to carry the header.
        #expect(T4CollabWire.unpackEnvelope(Data([1, 2, 3])) == nil)
    }

    @Test("guest envelope round-trip mirrors the relay codec layout")
    func guestEnvelopeRoundTrip() {
        let key = SymmetricKey(size: .bits256)
        // Phone → relay: peerId 0, raw JSON pair frame (no type prefix).
        let pairFrame = Data(#"{"t":"pair","code":"123456"}"#.utf8)
        let sealed = T4CollabWire.sealRaw(pairFrame, key: key)!
        let envelope = T4CollabWire.packEnvelope(peerId: 0, sealed: sealed)
        #expect(envelope.count == 4 + sealed.count)
        let unpacked = T4CollabWire.unpackEnvelope(envelope)!
        #expect(unpacked.peerId == 0)
        #expect(T4CollabWire.openRaw(unpacked.payload, key: key) == pairFrame)
        // Host → phone: type-prefixed host-wire bytes, stripped on receipt.
        let typed = Data([0x00]) + Data(#"{"v":"omp-app/1","type":"welcome"}"#.utf8)
        let hostEnvelope = T4CollabWire.packEnvelope(peerId: 7, sealed: T4CollabWire.sealRaw(typed, key: key)!)
        let hostUnpacked = T4CollabWire.unpackEnvelope(hostEnvelope)!
        #expect(hostUnpacked.peerId == 7)
        let plain = T4CollabWire.openRaw(hostUnpacked.payload, key: key)!
        #expect(plain[0] == 0x00)
        #expect(plain.subdata(in: 1..<plain.count) == typed.subdata(in: 1..<typed.count))
    }

    @Test("deep links accept a sha256: rendezvous hostId hint")
    func deepLinkSha256Hint() {
        let hostId = "sha256:" + String(repeating: "a", count: 64)
        let pair = Pairing.parseDeepLink("t4-code://pair/\(hostId)/654321", issuedAtMs: 1)
        #expect(pair?.hostHint == hostId)
        #expect(pair?.code == "654321")
        // Hint-only sha256 links stay valid (empty code = rejoin).
        let hintOnly = Pairing.parseDeepLink("t4-code://pair/\(hostId)", issuedAtMs: 1)
        #expect(hintOnly?.hostHint == hostId)
        #expect(hintOnly?.code == "")
    }
}
