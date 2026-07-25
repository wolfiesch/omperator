//  T4SessionStore.swift
//  Authoritative session inventory for the native T4 Code iOS client. Replaces
//  Enclave's collab-guest "rooms you've joined" model: this holds the real
//  host-wire SessionRef inventory, grouped by project, and drives the rail from
//  a HostClient connection. Seeded with sample data so the rail renders in the
//  simulator without a live host; connect(endpoint:) swaps in a real t4-host.

import SwiftUI
import HostWire

@MainActor
final class T4SessionStore: ObservableObject {
    struct Group: Identifiable {
        let project: String
        let sessions: [SessionRef]
        var id: String { project }
    }

    @Published private(set) var sessions: [SessionRef]
    @Published var query: String = ""
    @Published private(set) var connecting = false
    @Published private(set) var connected = false
    @Published var lastError: String?
    @Published var selectedSession: SessionRef?

    private var client: HostClient?
    private var hostId: String = ""

    /// Select a session (rail tap or auto-select of the most recent).
    func select(_ session: SessionRef?) {
        selectedSession = session
    }

    /// Send a user prompt to a session (session.prompt). No-op with a clear
    /// error when not connected — the composer is disabled in that state.
    func sendPrompt(sessionId: String, text: String) async {
        guard let client, connected, !hostId.isEmpty else {
            lastError = "Not connected to a host."
            return
        }
        do {
            _ = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "session.prompt",
                args: ["text": .string(text)], sessionId: sessionId))
        } catch {
            lastError = "\(error)"
        }
    }

    init() {
        self.sessions = Self.sample
    }

    /// Filtered + project-grouped view of the inventory (the rail model).
    var groups: [Group] {
        let filtered: [SessionRef]
        if query.isEmpty {
            filtered = sessions
        } else {
            let q = query
            filtered = sessions.filter {
                $0.title.localizedCaseInsensitiveContains(q)
                    || ($0.project.name ?? $0.project.projectId).localizedCaseInsensitiveContains(q)
                    || $0.status.localizedCaseInsensitiveContains(q)
                    || ($0.model ?? "").localizedCaseInsensitiveContains(q)
            }
        }
        let keyed = Dictionary(grouping: filtered) { $0.project.name ?? $0.project.projectId }
        return keyed.sorted { $0.key.localizedCaseInsensitiveCompare($1.key) == .orderedAscending }
            .map { Group(project: $0.key, sessions: $0.value.sorted { $0.updatedAt > $1.updatedAt }) }
    }

    /// Transcript entries for a session. Sample until session.attach +
    /// transcript.page are wired to a live host; the entry shape is real.
    func transcript(for sessionId: String) -> [TranscriptEntry] {
        let host = hostId.isEmpty ? "local" : hostId
        let json = """
        [
        {"id":"e1","parentId":null,"hostId":"\(host)","sessionId":"\(sessionId)","kind":"message","timestamp":"2026-07-24T09:00:00Z","data":{"role":"user","text":"audit the reconnect backoff"}},
        {"id":"e2","parentId":"e1","hostId":"\(host)","sessionId":"\(sessionId)","kind":"message","timestamp":"2026-07-24T09:00:05Z","data":{"text":"Looking at HostClient reconnect now."}},
        {"id":"e3","parentId":"e2","hostId":"\(host)","sessionId":"\(sessionId)","kind":"tool-use","timestamp":"2026-07-24T09:00:10Z","data":{"tool":"read","title":"read HostClient.swift"}},
        {"id":"e4","parentId":"e3","hostId":"\(host)","sessionId":"\(sessionId)","kind":"tool-result","timestamp":"2026-07-24T09:00:11Z","data":{"tool":"read","ok":true}},
        {"id":"e5","parentId":"e4","hostId":"\(host)","sessionId":"\(sessionId)","kind":"message","timestamp":"2026-07-24T09:00:20Z","data":{"text":"Backoff is 0.5–30s exponential with cursor resume — correct."}}
        ]
        """
        let entries = (try? JSONDecoder().decode([DurableEntry].self, from: Data(json.utf8))) ?? []
        return entries.map { TranscriptEntry(from: $0) }
    }

    /// Connect to a t4-host over host-wire, handshake, and load the inventory.
    func connect(endpoint: URL, identity: ClientIdentity, authentication: DeviceAuthentication? = nil) async {
        connecting = true
        defer { connecting = false }
        let transport = URLSessionHostWireTransport(endpoint: endpoint)
        let c = HostClient(transport: transport, config: HostClient.Config(identity: identity, authentication: authentication))
        client = c
        do {
            let welcome = try await c.connect()
            hostId = welcome.hostId
            connected = welcome.authentication == .paired || welcome.authentication == .local
            if connected {
                await refresh()
                Task { await observe() }
            }
        } catch {
            lastError = "\(error)"
        }
    }

    /// Re-fetch the authoritative session list (session.list).
    func refresh() async {
        guard let client, connected, !hostId.isEmpty else { return }
        do {
            let result = try await client.sendCommand(CommandIntent(hostId: hostId, command: "session.list"))
            sessions = try result.sessionListResult().sessions
        } catch {
            lastError = "\(error)"
        }
    }

    /// Live sessions pushes keep the inventory current without a re-fetch.
    private func observe() async {
        guard let client else { return }
        for await frame in await client.frames {
            if case .sessions(let inventory) = frame {
                sessions = inventory.sessions
            }
        }
    }

    func disconnect() async {
        await client?.close()
        client = nil
        connected = false
    }

    // MARK: - Sample inventory (simulator preview without a live host)

    private static let sample: [SessionRef] = {
        let json = """
        [
        {"hostId":"studio-mac","sessionId":"s1","project":{"projectId":"t4code","name":"T4 Code"},"revision":"r1","title":"iOS session rail","status":"active","updatedAt":"2026-07-24T11:00:00Z","model":"gpt-5.2","pendingUserInput":true,"contextUsage":{"used":7,"limit":200}},
        {"hostId":"studio-mac","sessionId":"s2","project":{"projectId":"t4code","name":"T4 Code"},"revision":"r2","title":"Host-wire Swift port","status":"closed","updatedAt":"2026-07-20T08:00:00Z","model":"gpt-5.2"},
        {"hostId":"studio-mac","sessionId":"s3","project":{"projectId":"t4code","name":"T4 Code"},"revision":"r3","title":"Agent view","status":"idle","updatedAt":"2026-07-24T08:30:00Z","model":"devin/swe-1-7","contextUsage":{"used":88,"limit":200}},
        {"hostId":"studio-mac","sessionId":"s4","project":{"projectId":"t4code","name":"T4 Code"},"revision":"r4","title":"Hosts & usage","status":"active","updatedAt":"2026-07-24T12:10:00Z","model":"gpt-5.2","pendingApproval":true,"contextUsage":{"used":33,"limit":200}}
        ]
        """
        let decoder = JSONDecoder()
        return (try? decoder.decode([SessionRef].self, from: Data(json.utf8))) ?? []
    }()
}
