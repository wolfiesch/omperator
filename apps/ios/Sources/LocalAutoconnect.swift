//  LocalAutoconnect.swift
//  Zero-config connection to a t4-host running on this machine. On every
//  start the host mints a device record bound to its own tailnet node and
//  publishes it next to the appserver socket with 0600 permissions — file
//  possession is the same-machine proof, so the app connects with no pairing
//  UI and nothing written to the Keychain. Connection management stays in
//  Settings; onboarding only appears when neither this file nor a saved
//  remote exists.

import Foundation

/// The credential a local t4-host publishes for same-machine apps.
struct LocalHostCredential {
    let endpoint: URL
    let deviceId: String
    let deviceToken: String

    /// Socket directories a local t4-host may publish into, in probe order:
    /// the `t4-host serve` profile dir, then the OMP desktop app's dir.
    private static var candidateFiles: [URL] {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return [
            home.appending(path: ".omp/run/appserver.sock.localdevice"),
            home.appending(path: "Library/Application Support/com.ohmypi.omp/.omp/run/appserver.sock.localdevice"),
        ]
    }

    /// The current local credential, or nil when no local host is publishing
    /// one (or the file is malformed). Cheap enough to call from computed
    /// properties: two small file reads at most.
    static func load() -> LocalHostCredential? {
        for file in candidateFiles {
            guard let data = try? Data(contentsOf: file),
                  let parsed = try? JSONDecoder().decode(PublishedFile.self, from: data),
                  parsed.version == 1,
                  let endpoint = URL(string: parsed.endpoint),
                  !parsed.deviceId.isEmpty, !parsed.deviceToken.isEmpty
            else { continue }
            return LocalHostCredential(endpoint: endpoint, deviceId: parsed.deviceId, deviceToken: parsed.deviceToken)
        }
        return nil
    }

    private struct PublishedFile: Decodable {
        let version: Int
        let endpoint: String
        let deviceId: String
        let deviceToken: String
    }
}
