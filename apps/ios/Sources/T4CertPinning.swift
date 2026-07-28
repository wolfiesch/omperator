// T4CertPinning.swift
// TOFU certificate pinning for wss:// host connections. The t4-host serves a
// per-profile self-signed cert on its wss listener (see --remote-tls-port);
// there is no CA chain to validate, so the security anchor is the leaf cert's
// sha256 fingerprint, pinned on first connect and enforced thereafter.
//
// Threat model: this authenticates the host *inside* the tailnet tunnel — a
// rogue tailnet peer can complete a TCP handshake but cannot present the
// pinned cert. First-connect trust (TOFU) matches the existing pairing trust
// model: the device-token pairing flow is already the moment of trust.
//
// The fingerprint the app pins is exactly what the host prints as
// `tlsFingerprint` on GET /healthz, so an operator can verify out-of-band.

import CryptoKit
import Foundation
import OSLog
import Security

private let t4pinLog = Logger(subsystem: "sh.t4code.ios", category: "pinning")

/// Certificate pins follow the connection credential lifetime. Normal app
/// launches persist them in the Keychain; explicit ephemeral dogfood profiles
/// retain them only for this process, while still enforcing continuity across
/// reconnects and newly-created URLSession delegates.
final class T4CertificatePinStore: @unchecked Sendable {
    private static let persistent = T4CertificatePinStore(usesKeychain: true)
    private static let ephemeral = T4CertificatePinStore(usesKeychain: false)

    private let usesKeychain: Bool
    private let memoryLock = NSLock()
    private var memoryPins: [String: String] = [:]

    init(usesKeychain: Bool) {
        self.usesKeychain = usesKeychain
    }

    static var current: T4CertificatePinStore {
        forArguments(ProcessInfo.processInfo.arguments)
    }

    static func forArguments(_ arguments: [String]) -> T4CertificatePinStore {
        Keychain.usesPersistentStore(arguments: arguments) ? persistent : ephemeral
    }

    func get(_ key: String) -> String? {
        if usesKeychain { return Keychain.get(key) }
        memoryLock.lock()
        defer { memoryLock.unlock() }
        return memoryPins[key]
    }

    @discardableResult
    func set(_ value: String, forKey key: String) -> Bool {
        if usesKeychain { return Keychain.set(value, forKey: key) }
        memoryLock.lock()
        defer { memoryLock.unlock() }
        memoryPins[key] = value
        return true
    }

    @discardableResult
    func remove(_ key: String) -> Bool {
        if usesKeychain { return Keychain.remove(forKey: key) }
        memoryLock.lock()
        defer { memoryLock.unlock() }
        memoryPins.removeValue(forKey: key)
        return true
    }
}

/// URLSession delegate that pins the server leaf certificate per host:port.
/// Only `wss://` endpoints should route through this; plain `ws://` carries no
/// server trust challenge at all.
final class T4CertPinner: NSObject, URLSessionDelegate {
    /// Keychain account key for a host:port pair, e.g. "certpin.host.tailnet.ts.net:8788".
    static func pinKey(host: String, port: Int) -> String { "certpin.\(host.lowercased()):\(port)" }

    private let key: String
    private let label: String
    private let store: T4CertificatePinStore

    init(
        host: String,
        port: Int,
        store: T4CertificatePinStore = .current
    ) {
        self.key = Self.pinKey(host: host, port: port)
        self.label = "\(host):\(port)"
        self.store = store
    }

    /// The currently pinned fingerprint for a host:port, if any (exposed for
    /// settings UI / debugging).
    static func pinnedFingerprint(host: String, port: Int) -> String? {
        T4CertificatePinStore.current.get(pinKey(host: host, port: port))
    }

    /// Forget a pin (e.g. after deliberate host cert rotation).
    static func forget(host: String, port: Int) {
        T4CertificatePinStore.current.remove(pinKey(host: host, port: port))
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
        if let stored = store.get(key) {
            if stored == fingerprint {
                completionHandler(.useCredential, URLCredential(trust: trust))
            } else {
                t4pinLog.error("cert pin MISMATCH for \(self.label, privacy: .public): got \(fingerprint, privacy: .public), pinned \(stored, privacy: .public)")
                completionHandler(.cancelAuthenticationChallenge, nil)
            }
        } else {
            // TOFU: accept and pin. Logged loudly so a compromised first
            // connect is at least audible in the logs.
            guard store.set(fingerprint, forKey: key) else {
                t4pinLog.error("failed to persist cert pin for \(self.label, privacy: .public)")
                completionHandler(.cancelAuthenticationChallenge, nil)
                return
            }
            t4pinLog.notice("TOFU pin for \(self.label, privacy: .public): \(fingerprint, privacy: .public)")
            completionHandler(.useCredential, URLCredential(trust: trust))
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
