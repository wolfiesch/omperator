// T4CertPinning.swift
// Explicit certificate pinning for wss:// host connections. The t4-host serves a
// per-profile self-signed cert on its wss listener (see --remote-tls-port);
// there is no CA chain to validate, so the security anchor is the leaf cert's
// sha256 fingerprint, pinned on first connect and enforced thereafter.
//
// Threat model: this authenticates the host *inside* the tailnet tunnel — a
// rogue tailnet peer can complete a TCP handshake but cannot present the
// pinned cert. The operator-presented pairing payload supplies the expected fingerprint;
// an absent pin falls back only to the platform CA policy, never implicit TOFU.
//
// The fingerprint the app pins is exactly what the host prints as
// `tlsFingerprint` on GET /healthz, so an operator can verify out-of-band.

import CryptoKit
import Foundation
import OSLog
import Security

private let t4pinLog = Logger(subsystem: "sh.t4code.ios", category: "pinning")

/// URLSession delegate that pins the server leaf certificate per host:port.
/// Only `wss://` endpoints should route through this; plain `ws://` carries no
/// server trust challenge at all.
final class T4CertPinner: NSObject, URLSessionDelegate {
    /// Keychain account key for a host:port pair, e.g. "certpin.100.98.34.4:8788".
    static func pinKey(host: String, port: Int) -> String { "certpin.\(host.lowercased()):\(port)" }

    private let key: String
    private let label: String

    init(host: String, port: Int) {
        self.key = Self.pinKey(host: host, port: port)
        self.label = "\(host):\(port)"
    }

    /// The currently pinned fingerprint for a host:port, if any (exposed for
    /// settings UI / debugging).
    static func pinnedFingerprint(host: String, port: Int) -> String? {
        Keychain.get(pinKey(host: host, port: port))
    }

    /// Install the fingerprint carried by a pairing payload before opening the
    /// socket. Existing pins must match; a persistence failure rejects pairing.
    static func establishExpectedPin(host: String, port: Int, fingerprint: String) -> Bool {
        guard fingerprint.wholeMatch(of: #/[0-9a-f]{64}/#) != nil else { return false }
        let key = pinKey(host: host, port: port)
        do {
            if let stored = try Keychain.read(key) { return stored == fingerprint }
            return Keychain.set(fingerprint, forKey: key)
        } catch {
            return false
        }
    }

    /// Forget a pin (e.g. after deliberate host cert rotation).
    static func forget(host: String, port: Int) {
        Keychain.remove(forKey: pinKey(host: host, port: port))
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let fingerprint = Self.leafFingerprint(trust)
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        let stored: String?
        do {
            stored = try Keychain.read(key)
        } catch {
            t4pinLog.error("certificate pin unavailable for \(self.label, privacy: .public)")
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        if let stored {
            if stored == fingerprint {
                completionHandler(.useCredential, URLCredential(trust: trust))
            } else {
                t4pinLog.error("certificate pin mismatch for \(self.label, privacy: .public)")
                completionHandler(.cancelAuthenticationChallenge, nil)
            }
        } else {
            // No explicit pin: use the platform CA policy. Self-signed direct
            // hosts therefore fail until a pairing payload installs their
            // advertised fingerprint; publicly trusted wss remains usable.
            completionHandler(.performDefaultHandling, nil)
        }
    }

    /// sha256 of the leaf certificate's DER, lowercase hex — identical to the
    /// host's `certFingerprint()` (sha256 over the PEM body bytes).
    private static func leafFingerprint(_ trust: SecTrust) -> String? {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first
        else { return nil }
        let der = SecCertificateCopyData(leaf) as Data
        return SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
    }
}
