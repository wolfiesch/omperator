//  KeychainTests.swift
//  Linux libsecret-backed credential store seam.
//
//  The in-memory fallback (-T4NoRestore) is deterministic and always runs.
//  The persistent path (real Secret Service via `secret-tool`) is attempted
//  only when the daemon is reachable — probed once, skipped cleanly when not
//  (the developer machine has no org.freedesktop.secrets provider running).

import Foundation
import Testing
@testable import T4CodeLinuxLib

@Suite("Keychain seam")
struct KeychainTests {
    /// In-memory fallback honors -T4NoRestore: full set/get/remove round-trip
    /// without touching any daemon.
    @Test
    func ephemeralRoundTrip() {
        let args = ["test", "-T4NoRestore"]
        let key = "ephemeral-\(UUID().uuidString)"

        #expect(!Keychain.usesPersistentStore(arguments: args))
        #expect(Keychain.set("value-1", forKey: key))
        #expect(Keychain.get(key) == "value-1")
        #expect(Keychain.remove(forKey: key))
        #expect(Keychain.get(key) == nil)
    }

    /// Persistent path against the real Secret Service. Skipped when the
    /// daemon isn't activatable (no org.freedesktop.secrets on the bus).
    @Test
    func persistentRoundTripIfDaemonAvailable() throws {
        // Probe the daemon once: a failed store means no Secret Service.
        let probeKey = "probe-\(UUID().uuidString)"
        let daemonUp = Keychain.set("x", forKey: probeKey)
        if daemonUp { _ = Keychain.remove(forKey: probeKey) }

        try #require(daemonUp, "no Secret Service daemon — skipping persistent path")

        let key = "persistent-\(UUID().uuidString)"
        #expect(Keychain.set("secret-value", forKey: key))
        #expect(Keychain.get(key) == "secret-value")
        #expect(Keychain.remove(forKey: key))
        #expect(Keychain.get(key) == nil)
    }

    /// EphemeralConnectionCredentials parses the launch-argument triple.
    @Test
    func ephemeralCredentialsParse() {
        let args = [
            "test",
            "-T4Endpoint=ws://127.0.0.1:9999/fixture",
            "-T4DeviceId=dev-1",
            "-T4DeviceToken=tok-1",
        ]
        let creds = EphemeralConnectionCredentials(arguments: args)
        #expect(creds != nil)
        #expect(creds?.endpoint == "ws://127.0.0.1:9999/fixture")
        #expect(creds?.deviceId == "dev-1")
        #expect(creds?.deviceToken == "tok-1")

        #expect(EphemeralConnectionCredentials(arguments: ["test"]) == nil)
        // Incomplete triples are rejected.
        #expect(EphemeralConnectionCredentials(arguments: ["test", "-T4Endpoint=x"]) == nil)
    }
}
