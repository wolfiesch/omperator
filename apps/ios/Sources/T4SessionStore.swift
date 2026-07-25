//  T4SessionStore.swift
//  Authoritative session inventory for the native T4 Code iOS client. Replaces
//  Enclave's collab-guest "rooms you've joined" model: this holds the real
//  host-wire SessionRef inventory, grouped by project, and drives the rail from
//  a HostClient connection. Seeded with sample data so the rail renders in the
//  simulator without a live host; connect(endpoint:) swaps in a real t4-host.

import SwiftUI
import HostWire
import CryptoKit

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
    /// Live transcripts by sessionId (snapshot + streamed entries). Present
    /// only for attached sessions while connected; the sample rail falls back
    /// to `sampleTranscript` when disconnected.
    @Published private(set) var liveEntries: [String: [TranscriptEntry]] = [:]
    /// Host catalog (models etc.) from catalog.get, fetched after connect.
    @Published private(set) var catalog: [CatalogItem] = []
    /// A confirmation challenge awaiting the user's approve/deny decision.
    @Published var pendingConfirmation: ConfirmationChallenge?
    /// Optimistic fast-mode state per session (the wire has no fast field).
    @Published private(set) var fastBySession: [String: Bool] = [:]

    /// Models from the catalog, in display order (supported first).
    var catalogModels: [CatalogItem] {
        catalog.filter { $0.kind == .model && $0.supported != false }
            .sorted { $0.id.localizedCaseInsensitiveCompare($1.id) == .orderedAscending }
    }

    private var client: HostClient?
    private var hostId: String = ""

    // Persisted connection (dev-grade: UserDefaults, not Keychain).
    private static let savedEndpointKey = "t4.endpoint"
    private static let savedDeviceIdKey = "t4.deviceId"
    private static let savedDeviceTokenKey = "t4.deviceToken"

    /// Auto-reconnect on launch with the last successful connection, if any.
    func restore() async {
        let defaults = UserDefaults.standard
        guard !connected, !connecting,
              let endpointString = defaults.string(forKey: Self.savedEndpointKey),
              let endpoint = URL(string: endpointString) else { return }
        let deviceId = defaults.string(forKey: Self.savedDeviceIdKey) ?? ""
        let token = defaults.string(forKey: Self.savedDeviceTokenKey) ?? ""
        let auth: DeviceAuthentication? = (!deviceId.isEmpty && !token.isEmpty)
            ? DeviceAuthentication(deviceId: deviceId, deviceToken: token) : nil
        await connect(endpoint: endpoint, identity: ClientIdentity(name: "t4-ios", version: "0.1", build: "dev", platform: "ios"), authentication: auth)
    }

    private func persist(endpoint: URL, authentication: DeviceAuthentication?) {
        let defaults = UserDefaults.standard
        defaults.set(endpoint.absoluteString, forKey: Self.savedEndpointKey)
        defaults.set(authentication?.deviceId, forKey: Self.savedDeviceIdKey)
        defaults.set(authentication?.deviceToken, forKey: Self.savedDeviceTokenKey)
    }

    /// Select a session (rail tap or auto-select of the most recent).
    func select(_ session: SessionRef?) {
        selectedSession = session
    }

    /// Attach to a session's transcript stream. The host replies with a
    /// snapshot frame (full log at a cursor) and then live entry frames;
    /// `observe()` routes both into `liveEntries`.
    func attach(sessionId: String) async {
        guard let client, connected, !hostId.isEmpty else { return }
        do {
            _ = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "session.attach", sessionId: sessionId))
        } catch {
            lastError = "\(error)"
        }
    }

    /// Switch the session's model (session.model.set, session persistence).
    /// `selector` is the catalog id, e.g. "deepseek/deepseek-v4-flash".
    func setModel(sessionId: String, selector: String) async {
        await control(sessionId: sessionId, command: "session.model.set",
                      args: ["selector": .string(selector), "persistence": .string("session")])
    }

    /// Set the reasoning level (session.thinking.set).
    func setThinking(sessionId: String, level: String) async {
        await control(sessionId: sessionId, command: "session.thinking.set",
                      args: ["level": .string(level)])
    }

    /// Toggle provider-priority fast mode (session.fast.set).
    func setFast(sessionId: String, enabled: Bool) async {
        let ok = await control(sessionId: sessionId, command: "session.fast.set",
                      args: ["enabled": .bool(enabled)])
        if ok { fastBySession[sessionId] = enabled }
    }

    /// Revision-tracked session control command. Returns true on success.
    @discardableResult
    private func control(sessionId: String, command: String, args: [String: JSONValue]) async -> Bool {
        guard let client, connected, !hostId.isEmpty else { return false }
        guard let revision = sessions.first(where: { $0.sessionId == sessionId })?.revision else {
            lastError = "session revision unknown"
            return false
        }
        do {
            _ = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: command, args: args,
                sessionId: sessionId, expectedRevision: revision))
            return true
        } catch {
            lastError = "\(error)"
            return false
        }
    }

    /// Answer the pending confirmation challenge (approve/deny).
    func confirm(_ decision: ConfirmDecision) async {
        guard let client, let challenge = pendingConfirmation else { return }
        pendingConfirmation = nil
        do {
            try await client.sendConfirm(ConfirmIntent(
                confirmationId: challenge.confirmationId, commandId: challenge.commandId,
                hostId: challenge.hostId, decision: decision, sessionId: challenge.sessionId))
        } catch {
            lastError = "\(error)"
        }
    }

    /// Send a user prompt to a session (session.prompt), uploading any images
    /// first (session.image.begin/chunk → imageId refs). No-op with a clear
    /// error when not connected — the composer is disabled in that state.
    func sendPrompt(sessionId: String, text: String, images: [Data] = []) async {
        guard let client, connected, !hostId.isEmpty else {
            lastError = "Not connected to a host."
            return
        }
        do {
            var refs: [JSONValue] = []
            for image in images {
                refs.append(.object(["imageId": .string(try await uploadImage(image, sessionId: sessionId))]))
            }
            var args: [String: JSONValue] = ["message": .string(text)]
            if !refs.isEmpty { args["images"] = .array(refs) }
            _ = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "session.prompt", args: args, sessionId: sessionId))
        } catch {
            lastError = "\(error)"
        }
    }

    /// Interrupt a running turn (session.cancel).
    func cancel(sessionId: String) async {
        guard let client, connected, !hostId.isEmpty else { return }
        do {
            _ = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "session.cancel", sessionId: sessionId))
        } catch {
            lastError = "\(error)"
        }
    }

    /// Upload one JPEG: begin {mimeType,size,sha256} → chunk loop (base64,
    /// host-chunk-sized slices) → the imageId a prompt can reference.
    private func uploadImage(_ data: Data, sessionId: String) async throws -> String {
        guard let client else { throw T4WireError.invalidFrame(path: "client", reason: "not connected") }
        let sha = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let begin = try await client.sendCommand(CommandIntent(
            hostId: hostId, command: "session.image.begin",
            args: ["mimeType": .string("image/jpeg"), "size": .number(Double(data.count)), "sha256": .string(sha)],
            sessionId: sessionId))
        let (imageId, chunkBytes) = try begin.imageBeginResult()
        var offset = 0
        while offset < data.count {
            let slice = data.subdata(in: offset..<min(offset + chunkBytes, data.count))
            _ = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "session.image.chunk",
                args: ["imageId": .string(imageId), "offset": .number(Double(offset)),
                       "content": .string(slice.base64EncodedString())],
                sessionId: sessionId))
            offset += slice.count
        }
        return imageId
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

    /// Transcript entries for a session: the live host log when attached,
    /// sample rows otherwise (rail preview without a host).
    func transcript(for sessionId: String) -> [TranscriptEntry] {
        if connected { return liveEntries[sessionId] ?? [] }
        return sampleTranscript(for: sessionId)
    }

    /// Sample transcript — offline preview only.
    private func sampleTranscript(for sessionId: String) -> [TranscriptEntry] {
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
                persist(endpoint: endpoint, authentication: authentication)
                await refresh()
                await loadCatalog()
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
            reconcileSelection()
        } catch {
            lastError = "\(error)"
        }
    }

    /// Keep the selection honest across inventory updates: a stale selection
    /// (e.g. auto-picked from the sample rail before connect) is replaced by
    /// the most recent live session; a surviving one gets the fresh ref.
    private func reconcileSelection() {
        guard let selected = selectedSession else {
            selectedSession = sessions.first
            return
        }
        if let fresh = sessions.first(where: { $0.sessionId == selected.sessionId }) {
            selectedSession = fresh
        } else {
            selectedSession = sessions.first
        }
    }

    /// Fetch the host catalog (models, tools, …) once after connecting.
    private func loadCatalog() async {
        guard let client, connected, !hostId.isEmpty else { return }
        do {
            let result = try await client.sendCommand(CommandIntent(hostId: hostId, command: "catalog.get"))
            catalog = try result.catalogItems()
        } catch {
            lastError = "\(error)"
        }
    }

    /// Live frames keep the inventory, transcripts, and confirmations current.
    private func observe() async {
        guard let client else { return }
        for await frame in await client.frames {
            switch frame {
            case .sessions(let inventory):
                sessions = inventory.sessions
                reconcileSelection()
            case .snapshot(let snapshot):
                liveEntries[snapshot.sessionId] = snapshot.entries.map { TranscriptEntry(from: $0) }
            case .entry(let entryFrame):
                var entries = liveEntries[entryFrame.sessionId] ?? []
                let entry = TranscriptEntry(from: entryFrame.entry)
                if !entries.contains(where: { $0.id == entry.id }) {
                    entries.append(entry)
                    liveEntries[entryFrame.sessionId] = entries
                }
            case .confirmation(let challenge):
                pendingConfirmation = challenge
            default:
                break
            }
        }
    }

    func disconnect() async {
        await client?.close()
        client = nil
        connected = false
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: Self.savedEndpointKey)
        defaults.removeObject(forKey: Self.savedDeviceIdKey)
        defaults.removeObject(forKey: Self.savedDeviceTokenKey)
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
