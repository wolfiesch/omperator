//  T4DiscoveryClient.swift
//  Public rendezvous host discovery shared by the native clients.

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

struct T4DiscoveryHost: Decodable, Identifiable, Equatable, Sendable {
    let hostId: String
    let hostname: String
    let label: String
    let origin: URL

    var id: String { hostId }

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

    init?(raw: Raw) {
        guard let origin = URL(string: raw.origin) else { return nil }
        hostId = raw.hostId
        hostname = raw.hostname
        label = raw.label
        self.origin = origin
    }
}

private struct T4DiscoveryResponse: Decodable {
    let hosts: [T4DiscoveryHost.Raw]
}

enum T4DiscoveryClient {
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

    static func discoverHosts(accountToken: String? = nil) async -> [T4DiscoveryHost] {
        do {
            var request = URLRequest(url: rendezvousBaseURL().appendingPathComponent("v1/hosts"))
            request.timeoutInterval = 15
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            if let accountToken, !accountToken.isEmpty {
                request.setValue("Bearer \(accountToken)", forHTTPHeaderField: "Authorization")
            }
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return [] }
            let envelope = try JSONDecoder().decode(T4DiscoveryResponse.self, from: data)
            return envelope.hosts
                .compactMap { T4DiscoveryHost(raw: $0) }
                .sorted {
                    $0.hostname.localizedCaseInsensitiveCompare($1.hostname) == .orderedAscending
                }
        } catch {
            return []
        }
    }
}
