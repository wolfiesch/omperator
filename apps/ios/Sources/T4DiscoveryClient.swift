//  T4DiscoveryClient.swift
//  Rendezvous host discovery for the native T4 Code clients (iOS + macOS):
//  the registry's /v1/hosts lists the tailnet's computers, and a healthz
//  probe keeps only the ones this device can actually reach (same tailnet /
//  LAN). Discovery is strictly best-effort — any failure reads as an empty
//  list, and the Advanced (endpoint/pair) connect path remains the fallback.

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// One computer advertised by the rendezvous registry. `origin` is the host
/// gateway's HTTPS origin (e.g. https://workstation.example-tailnet.ts.net:8445).
struct T4DiscoveryHost: Decodable, Identifiable, Equatable, Sendable {
    let hostId: String
    let hostname: String
    let label: String
    let origin: URL

    var id: String { hostId }

    /// Wire shape of one advertised host. `origin` arrives as a String and is
    /// converted via URL(string:) by the client; entries with unparseable
    /// origins are dropped rather than failing the whole list decode.
    struct Raw: Decodable {
        let hostId: String
        let hostname: String
        let label: String
        let origin: String
    }

    init(hostId: String, hostname: String, label: String, origin: URL) {
        self.hostId = hostId
        self.hostname = hostname
        self.label = label
        self.origin = origin
    }

    /// Advertised origin → URL; nil when the registry sent an unparseable
    /// origin (the caller drops the entry).
    init?(raw: Raw) {
        guard let origin = URL(string: raw.origin) else { return nil }
        hostId = raw.hostId
        hostname = raw.hostname
        label = raw.label
        self.origin = origin
    }
}

/// The rendezvous GET /v1/hosts response envelope.
private struct T4DiscoveryResponse: Decodable {
    let hosts: [T4DiscoveryHost.Raw]
}

/// Fetches the reachable-computer list from the rendezvous registry. Pure
/// static helpers — no instances, no state.
enum T4DiscoveryClient {
    /// The rendezvous base URL: Info.plist key `T4RendezvousURL` wins, then
    /// the `-T4RendezvousURL=` launch argument, then the baked default.
    static func rendezvousBaseURL() -> URL {
        if let fromPlist = Bundle.main.object(forInfoDictionaryKey: "T4RendezvousURL") as? String,
           !fromPlist.trimmingCharacters(in: .whitespaces).isEmpty,
           let url = URL(string: fromPlist) {
            return url
        }
        if let argument = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("-T4RendezvousURL=") }) {
            let value = String(argument.dropFirst("-T4RendezvousURL=".count))
            if !value.trimmingCharacters(in: .whitespaces).isEmpty, let url = URL(string: value) {
                return url
            }
        }
        return URL(string: "https://wickrunner.com:8445")!
    }

    /// List the reachable computers: GET {rendezvous}/v1/hosts, then probe
    /// each advertised origin's /healthz (3s timeout) and keep only the HTTP
    /// 200s, sorted by hostname (case-insensitive). Any error returns [] —
    /// discovery never throws to the UI.
    static func discoverHosts() async -> [T4DiscoveryHost] {
        let hosts: [T4DiscoveryHost]
        do {
            var request = URLRequest(url: rendezvousBaseURL().appendingPathComponent("v1/hosts"))
            request.timeoutInterval = 15
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return [] }
            let envelope = try JSONDecoder().decode(T4DiscoveryResponse.self, from: data)
            hosts = envelope.hosts.compactMap { T4DiscoveryHost(raw: $0) }
        } catch {
            return []
        }
        // Probe the origins concurrently — a phone only sees the hosts it can
        // reach, so unreachable entries are dropped here, not at the registry.
        let reachable = await withTaskGroup(of: (host: T4DiscoveryHost, reachable: Bool).self) { group in
            for host in hosts {
                group.addTask { (host, await Self.isReachable(host)) }
            }
            var reachable: [T4DiscoveryHost] = []
            for await (host, ok) in group where ok {
                reachable.append(host)
            }
            return reachable
        }
        return reachable.sorted {
            $0.hostname.localizedCaseInsensitiveCompare($1.hostname) == .orderedAscending
        }
    }

    /// A host is reachable when its gateway answers /healthz with HTTP 200
    /// inside the 3s probe timeout.
    private static func isReachable(_ host: T4DiscoveryHost) async -> Bool {
        var request = URLRequest(url: host.origin.appendingPathComponent("healthz"))
        request.timeoutInterval = 3
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }
}
