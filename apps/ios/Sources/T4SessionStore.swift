//  T4SessionStore.swift
//  Authoritative session inventory for the native T4 Code iOS client. Replaces
//  Enclave's collab-guest "rooms you've joined" model: this holds the real
//  host-wire SessionRef inventory, grouped by project, and drives the rail from
//  a HostClient connection. Seeded with sample data so the rail renders in the
//  simulator without a live host; connect(endpoint:) swaps in a real t4-host.

import SwiftUI
import HostWire
import CryptoKit
import os

private let t4log = Logger(subsystem: "sh.t4code.ios", category: "store")

@MainActor
final class T4SessionStore: ObservableObject {
    struct Group: Identifiable {
        let project: String
        let sessions: [SessionRef]
        var id: String { project }
    }

    /// A host-asked question awaiting the user's answer (question mode).
    /// `request` is the typed `ask.request` payload; `sessionId` scopes the
    /// banner to the session that raised it.
    struct PendingAsk: Identifiable {
        let sessionId: String
        let request: AskRequest
        var id: String { request.askId }
    }

    /// Per-session transcript paging state, driven by `transcript.page`.
    /// `nextCursor` is the opaque cursor the host returned for the next older
    /// page (nil before the first page); `hasMore` is nil until the first
    /// older page resolves (unknown); `loading` is true while a page is in
    /// flight (idempotent guard).
    struct TranscriptPaging: Equatable {
        var nextCursor: String?
        var hasMore: Bool?
        var loading: Bool
    }

    /// One session needing the user's attention (inbox). `reason` is the
    /// highest-priority pending flag: approval > input > plan.
    struct AttentionSession: Identifiable {
        enum Reason { case approval, input, plan }
        let session: SessionRef
        let reason: Reason
        var id: String { session.sessionId }
        var reasonLabel: String {
            switch reason {
            case .approval: return "Approval"
            case .input:    return "Input"
            case .plan:     return "Plan"
            }
        }
    }

    /// One subagent's rolled-up state for the agents pane, fed by the .agent
    /// snapshot and agent.* additive frames in observe(). `detail` is a
    /// best-effort text extract from the frame's opaque `detail`/`data` object.
    struct AgentState: Identifiable, Equatable {
        let agentId: String
        var state: String
        var progress: Double?
        var detail: String?
        var id: String { agentId }
    }

    @Published private(set) var sessions: [SessionRef]
    @Published var query: String = ""
    @Published private(set) var connecting = false
    @Published private(set) var connected = false
    @Published var lastError: String?
    /// Human-readable endpoint the store is currently paired/connected to
    /// (e.g. "ws://macbookpro.my-tailnet.ts.net:8787/v1/ws"), for UI display.
    @Published private(set) var pairedEndpoint: String?
    @Published var selectedSession: SessionRef?
    /// Live transcripts by sessionId (snapshot + streamed entries). Present
    /// only for attached sessions while connected; the sample rail falls back
    /// to `sampleTranscript` when disconnected.
    @Published private(set) var liveEntries: [String: [TranscriptEntry]] = [:]
    /// In-progress assistant text by sessionId, mirrored from `message.update`
    /// live events. Cleared on `message.settled`/`message.discarded`/`turn.end`
    /// and when the matching durable assistant entry lands via `.entry` (de-
    /// dupe: the durable entry is the source of truth once it arrives). The
    /// transcript view renders this as a pulsing live tail row after the
    /// durable entries.
    @Published private(set) var streamingText: [String: String] = [:]
    /// Sessions with a turn in flight, from turn.start/turn.end events — the
    /// composer's stop button keys off this (the ref's `status` sticks at
    /// "active" long after the turn actually ends).
    @Published private(set) var activeTurns: Set<String> = []
    /// OMP todo phases by sessionId (the plan strip's data), refreshed on
    /// attach and after streamed entries.
    @Published private(set) var todoPhasesBySession: [String: [PlanPhase]] = [:]

    /// Todo phases for a session (live when connected, empty otherwise).
    func todoPhases(for sessionId: String) -> [PlanPhase] {
        todoPhasesBySession[sessionId] ?? []
    }

    /// Pull session.state.get and mirror todoPhases for the plan strip.
    func refreshTodos(sessionId: String) async {
        guard let client, connected, !hostId.isEmpty else { return }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "session.state.get", sessionId: sessionId))
            todoPhasesBySession[sessionId] = Self.parseTodoPhases(result.result)
        } catch {
            t4log.error("refreshTodos failed: \(error)")
        }
    }

    /// Parse the optional todoPhases field out of a state result body.
    static func parseTodoPhases(_ result: JSONValue?) -> [PlanPhase] {
        guard case .object(let o) = result ?? .null, case .array(let phases) = o["todoPhases"] ?? .null
        else { return [] }
        var out: [PlanPhase] = []
        for phase in phases {
            guard case .object(let p) = phase, case .string(let name) = p["name"] ?? .null,
                  case .array(let tasks) = p["tasks"] ?? .null else { continue }
            let mapped: [PlanTask] = tasks.compactMap { task in
                guard case .object(let t) = task, case .string(let content) = t["content"] ?? .null,
                      case .string(let status) = t["status"] ?? .null else { return nil }
                return PlanTask(content: content, status: status)
            }
            out.append(PlanPhase(name: name, tasks: mapped))
        }
        return out
    }
    /// Host catalog (models etc.) from catalog.get, fetched after connect.
    @Published private(set) var catalog: [CatalogItem] = []
    /// A confirmation challenge awaiting the user's approve/deny decision.
    @Published var pendingConfirmation: ConfirmationChallenge?
    /// A host ask (question mode) awaiting the user's answer, if any.
    @Published var pendingAsk: PendingAsk?
    /// Optimistic fast-mode state per session (the wire has no fast field).
    @Published private(set) var fastBySession: [String: Bool] = [:]
    /// Per-session transcript paging state (transcript.page). `hasMore` is
    /// nil until the first older page resolves (unknown); the "Load earlier"
    /// button shows when hasMore is true OR (unknown and entries ≥ 50).
    @Published private(set) var pagingState: [String: TranscriptPaging] = [:]
    /// Session currently prepending a paged history block. The detail view
    /// suppresses its scroll-to-bottom follow while this matches its session
    /// so prepended older rows don't yank the viewport to the bottom.
    @Published private(set) var prependingSession: String?
    /// Subagents per session, fed by .agent/.agentState/.agentLifecycle/
    /// .agentProgress/.agentEvent frames in observe(). The agents pane
    /// renders this; empty when the host has no subagents for a session.
    @Published private(set) var agentsBySession: [String: [AgentState]] = [:]
    /// Per-terminal buffered output, keyed by terminalId. `terminal.output`
    /// frames append here (capped ~200KB per terminal, dropping the oldest
    /// chunk when exceeded). The terminal drawer feeds this to SwiftTerm.
    @Published private(set) var terminalOutput: [String: String] = [:]
    /// Per-terminal exit code, set when a `terminal.exit` frame arrives.
    /// Presence of a key means the pty has exited; nil value means exited
    /// with code 0 recorded as absent until exit.
    @Published private(set) var terminalExits: [String: Int] = [:]
    /// The terminal id opened for the selected session by `openTerminal`,
    /// or nil when no terminal is open. The drawer watches this to know
    /// which buffered output stream to render.
    @Published private(set) var openTerminalId: [String: String] = [:]
    /// Per-terminal last error (e.g. a denied term.open command). Cleared
    /// on a successful open or explicit close.
    @Published private(set) var terminalErrors: [String: String] = [:]
    /// Code reviews per session, fed by `review` additive frames in observe().
    /// The review pane reads the latest reviewId from here to call
    /// review.read; empty when the host has not pushed a review.
    @Published private(set) var reviewsBySession: [String: [ReviewFrame]] = [:]
    /// Last fetched usage snapshot (usage.read, host scope). nil until the
    /// usage pane first loads it; refreshed on demand. `generatedAt` is the
    /// host's epoch-millis timestamp.
    @Published private(set) var usageSnapshot: UsageReadResult?
    /// Last fetched host settings (settings.read, host scope). Carried as an
    /// opaque object map (boundedSettings) — keys are setting names, values
    /// are strings/bools/numbers. nil until the settings pane first loads it.
    @Published private(set) var settingsSnapshot: [String: JSONValue]?
    /// Last fetched host settings revision (settings.read result.revision),
    /// required as `expectedRevision` for settings.write. nil until the
    /// settings pane first loads it.
    @Published private(set) var settingsRevision: String?
    /// Cached artifact chunks by artifactId, populated by artifact.read.
    /// The artifacts pane taps a descriptor to load+preview content; the
    /// first chunk (offset 0) is enough for inline text/patch previews.
    @Published private(set) var artifactChunks: [String: ArtifactReadChunk] = [:]

    /// Models from the catalog, in display order (supported first).
    var catalogModels: [CatalogItem] {
        catalog.filter { $0.kind == .model && $0.supported != false }
            .sorted { $0.id.localizedCaseInsensitiveCompare($1.id) == .orderedAscending }
    }

    private var client: HostClient?
    private var hostId: String = ""
    /// Capabilities the host granted at welcome — gates optional commands
    /// (e.g. catalog.get needs catalog.read; an unauthorized command gets
    /// the connection closed by the remote policy).
    private var grantedCapabilities: [String] = []

    // Persisted connection (dev-grade: UserDefaults, not Keychain).
    private static let savedEndpointKey = "t4.endpoint"
    private static let savedDeviceIdKey = "t4.deviceId"
    private static let savedDeviceTokenKey = "t4.deviceToken"

    /// Auto-reconnect on launch with the last successful connection, if any.
    func restore() async {
        // UI-test seam: -T4NoRestore forces the offline sample inventory.
        if ProcessInfo.processInfo.arguments.contains("-T4NoRestore") { return }
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
        if connected, let session { Task { await attach(sessionId: session.sessionId) } }
    }

    /// Attach to a session's transcript stream. The host replies with a
    /// snapshot frame (full log at a cursor) and then live entry frames;
    /// `observe()` routes both into `liveEntries`. Safe to repeat.
    func attach(sessionId: String) async {
        guard let client, connected, !hostId.isEmpty else { return }
        do {
            _ = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "session.attach", sessionId: sessionId))
            t4log.notice("attach sent for \(sessionId, privacy: .public)")
        } catch {
            t4log.error("attach failed: \(error)")
            lastError = "\(error)"
        }
    }

    /// Attach to the selected session if we haven't yet (connection-driven,
    /// not view-driven: a view race once left sessions permanently empty).
    private func attachSelectedIfNeeded() {
        guard connected, let selected = selectedSession,
              liveEntries[selected.sessionId] == nil else { return }
        Task {
            await attach(sessionId: selected.sessionId)
            await refreshTodos(sessionId: selected.sessionId)
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

    /// Set the session's mode (session.mode.set): "build", "plan", or
    /// "readOnly". Prompt shaping is host-side; iOS only sets/displays it.
    func setMode(sessionId: String, mode: String) async {
        _ = await control(sessionId: sessionId, command: "session.mode.set",
                          args: ["mode": .string(mode)])
    }

    /// Answer the pending host ask (session.ui.respond {requestId, value}),
    /// then clear it. The host clears the ask with an `ask.resolved` event,
    /// but we clear optimistically so the banner dismisses immediately.
    func respondAsk(value: String) async {
        guard let ask = pendingAsk else { return }
        let askId = ask.request.askId
        let sessionId = ask.sessionId
        pendingAsk = nil
        _ = await control(sessionId: sessionId, command: "session.ui.respond",
                          args: ["requestId": .string(askId), "value": .string(value)])
    }

    // MARK: - Prompt leases
    // Remote hosts require a lease for every mutation, and the lease KIND
    // matters: prompt leases cover prompt-ish commands (prompt/steer/
    // followUp/ui.respond), controller leases cover everything else
    // (cancel, model/thinking/fast/mode.set). Acquire with the session's
    // current revision, pass leaseId on the mutation, release after (except
    // prompts — turns start asynchronously, the 30s TTL covers turn start).

    private enum LeaseKind: String {
        case prompt = "prompt.lease"
        case controller = "controller.lease"
    }

    private func revision(of sessionId: String) -> String? {
        sessions.first(where: { $0.sessionId == sessionId })?.revision
    }

    private func acquireLease(sessionId: String, kind: LeaseKind = .prompt) async -> String? {
        guard let client, connected, !hostId.isEmpty, var revision = revision(of: sessionId) else { return nil }
        for attempt in 0...1 {
            do {
                let result = try await client.sendCommand(CommandIntent(
                    hostId: hostId, command: "\(kind.rawValue).acquire",
                    args: ["ownerId": .string("t4-ios")],
                    sessionId: sessionId, expectedRevision: revision))
                return try result.leaseResult()
            } catch {
                // Revision churn is normal (attach/list bumps it): refresh once
                // and retry with the current revision before giving up.
                if attempt == 0, let fresh = try? await refreshRevision(of: sessionId) {
                    revision = fresh
                    continue
                }
                t4log.error("acquireLease(\(kind.rawValue)) failed: \(error)")
                lastError = "\(error)"
                return nil
            }
        }
        return nil
    }

    /// Re-fetch the inventory and return one session's current revision.
    private func refreshRevision(of sessionId: String) async throws -> String? {
        await refresh()
        return revision(of: sessionId)
    }

    private func releaseLease(sessionId: String, leaseId: String, kind: LeaseKind = .prompt) async {
        guard let client, connected, !hostId.isEmpty, let revision = revision(of: sessionId) else { return }
        _ = try? await client.sendCommand(CommandIntent(
            hostId: hostId, command: "\(kind.rawValue).release",
            args: ["leaseId": .string(leaseId)],
            sessionId: sessionId, expectedRevision: revision))
    }

    /// Run a mutation under a freshly acquired lease of the right kind.
    private func withLease(sessionId: String, kind: LeaseKind = .prompt, release: Bool = true, mutation: (String) async -> Void) async {
        guard let leaseId = await acquireLease(sessionId: sessionId, kind: kind) else { return }
        // Lease acquire bumps the session revision; refresh so the mutation
        // carries the current one (the host rejects stale revisions).
        await refresh()
        await mutation(leaseId)
        if release { await releaseLease(sessionId: sessionId, leaseId: leaseId, kind: kind) }
    }

    /// Revision-tracked session control command. Returns true on success.
    @discardableResult
    private func control(sessionId: String, command: String, args: [String: JSONValue]) async -> Bool {
        guard let client, connected, !hostId.isEmpty else { return false }
        var succeeded = false
        await withLease(sessionId: sessionId, kind: .controller) { leaseId in
            guard let revision = revision(of: sessionId) else {
                lastError = "session revision unknown"
                return
            }
            var fullArgs = args
            fullArgs["leaseId"] = .string(leaseId)
            do {
                _ = try await client.sendCommand(CommandIntent(
                    hostId: hostId, command: command, args: fullArgs,
                    sessionId: sessionId, expectedRevision: revision))
                succeeded = true
            } catch {
                lastError = "\(error)"
            }
        }
        return succeeded
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
            await withLease(sessionId: sessionId, release: false) { leaseId in
                var args: [String: JSONValue] = ["message": .string(text), "leaseId": .string(leaseId)]
                if !refs.isEmpty { args["images"] = .array(refs) }
                do {
                    // session.prompt: revision is optional on the wire —
                    // omitting it sidesteps stale_revision churn entirely.
                    _ = try await client.sendCommand(CommandIntent(
                        hostId: hostId, command: "session.prompt", args: args,
                        sessionId: sessionId))
                    t4log.notice("prompt accepted for \(sessionId, privacy: .public)")
                } catch {
                    t4log.error("prompt failed: \(error)")
                    lastError = "\(error)"
                }
            }
        } catch {
            lastError = "\(error)"
        }
    }

    /// Interrupt a running turn (session.cancel).
    func cancel(sessionId: String) async {
        guard let client, connected, !hostId.isEmpty else { return }
        await withLease(sessionId: sessionId, kind: .controller) { leaseId in
            do {
                _ = try await client.sendCommand(CommandIntent(
                    hostId: hostId, command: "session.cancel",
                    args: ["leaseId": .string(leaseId)],
                    sessionId: sessionId))
            } catch {
                lastError = "\(error)"
            }
        }
    }

    // MARK: - Session lifecycle
    // session.create is host-scope (sessions.manage, no revision, no
    // confirmation, no lease) — sent directly like session.list. The
    // remaining lifecycle commands are session-scoped and run under a
    // controller lease via control(): rename (sessions.manage, revision
    // required), retry/compact (sessions.control, revision required), and
    // close/delete (sessions.manage, revision required, confirmation
    // challenge — the host returns a challenge that surfaces through
    // pendingConfirmation as the approve/deny banner in the session view).

    /// Create a session in a project (session.create {projectId, title?}).
    /// Returns the new session and refreshes the inventory; nil when not
    /// connected or the host rejects the create. `title` is optional on the
    /// wire (bounded text, 512 bytes).
    @discardableResult
    func createSession(projectId: String, title: String? = nil) async -> SessionRef? {
        guard let client, connected, !hostId.isEmpty else { return nil }
        var args: [String: JSONValue] = ["projectId": .string(projectId)]
        if let title, !title.isEmpty { args["title"] = .string(title) }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "session.create", args: args))
            let created = try result.sessionCreateResult()
            await refresh()
            return created
        } catch {
            t4log.error("createSession failed: \(error)")
            lastError = "\(error)"
            return nil
        }
    }

    /// Rename a session (session.rename {name}). Confirmation none — the
    /// rename takes effect immediately under the controller lease.
    func renameSession(sessionId: String, name: String) async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        _ = await control(sessionId: sessionId, command: "session.rename",
                          args: ["name": .string(trimmed)])
    }

    /// Compact the session's context (session.compact). No args beyond the
    /// lease; the host rewrites the transcript in place.
    func compactSession(sessionId: String) async {
        _ = await control(sessionId: sessionId, command: "session.compact", args: [:])
    }

    /// Retry the last turn (session.retry).
    func retrySession(sessionId: String) async {
        _ = await control(sessionId: sessionId, command: "session.retry", args: [:])
    }

    /// Close a session (session.close). The host returns a confirmation
    /// challenge; `observe()` routes it to `pendingConfirmation`, rendered
    /// as the approve/deny banner in the session view.
    func closeSession(sessionId: String) async {
        _ = await control(sessionId: sessionId, command: "session.close", args: [:])
    }

    /// Delete a session (session.delete). Same confirmation flow as close.
    func deleteSession(sessionId: String) async {
        _ = await control(sessionId: sessionId, command: "session.delete", args: [:])
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

    // MARK: - Attention inbox
    // Sessions needing the user: pending approval, awaiting input, or a
    // proposed plan ready for review. Highest-priority reason wins (approval
    // > input > plan), sorted by updatedAt desc. The workspace bell button
    // badges with `attentionSessions.count` and opens T4InboxView.

    /// Sessions needing attention, sorted newest-first. A session appears
    /// when pendingApproval, pendingUserInput, or a non-empty proposedPlan is
    /// set on the SessionRef (the host sets these as turns progress).
    var attentionSessions: [AttentionSession] {
        sessions.compactMap { session -> AttentionSession? in
            if session.pendingApproval == true {
                return AttentionSession(session: session, reason: .approval)
            }
            if session.pendingUserInput == true {
                return AttentionSession(session: session, reason: .input)
            }
            if let plan = session.proposedPlan, !plan.isEmpty {
                return AttentionSession(session: session, reason: .plan)
            }
            return nil
        }
        .sorted { $0.session.updatedAt > $1.session.updatedAt }
    }

    /// Subagents for a session: live host state when connected, sample rows
    /// otherwise (agents-pane preview without a host).
    func agents(for sessionId: String) -> [AgentState] {
        if connected { return agentsBySession[sessionId] ?? [] }
        return Self.sampleAgents
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
            grantedCapabilities = welcome.grantedCapabilities
            connected = welcome.authentication == .paired || welcome.authentication == .local
            if connected {
                pairedEndpoint = endpoint.absoluteString
                persist(endpoint: endpoint, authentication: authentication)
                await refresh()
                await loadCatalog()
                Task { await observe() }
            } else {
                t4log.error("connect: auth not accepted (\(welcome.authentication.rawValue, privacy: .public))")
            }
        } catch {
            t4log.error("connect failed: \(error)")
            lastError = "\(error)"
        }
    }

    /// Pair a new device against a t4-host that requires pairing, then connect.
    /// If the host is already open (welcome.authentication is .paired/.local —
    /// e.g. a local UDS host or one that already trusts this device), this
    /// behaves like `connect(...)` with no credentials. Otherwise it sends a
    /// pair.start with the 6-digit code and persists the granted device token
    /// on success, mirroring connect()'s post-connect refresh/catalog/observe.
    func pairAndConnect(endpoint: URL, code: String, deviceName: String) async {
        connecting = true
        defer { connecting = false }
        let transport = URLSessionHostWireTransport(endpoint: endpoint)
        let identity = ClientIdentity(name: "t4-ios", version: "0.1", build: "dev", platform: "ios")
        let c = HostClient(transport: transport, config: HostClient.Config(identity: identity, authentication: nil))
        client = c
        do {
            let welcome = try await c.connect()
            hostId = welcome.hostId
            if welcome.authentication == .paired || welcome.authentication == .local {
                // Open host — no pairing round-trip needed.
                connected = true
                pairedEndpoint = endpoint.absoluteString
                persist(endpoint: endpoint, authentication: nil)
                await refresh()
                await loadCatalog()
                Task { await observe() }
                return
            }
            let slug = Self.slugify(deviceName)
            let intent = PairStartIntent(
                code: code,
                deviceId: "ios-\(slug)",
                deviceName: deviceName,
                platform: "ios",
                requestedCapabilities: ["sessions.read", "sessions.prompt", "sessions.control", "sessions.manage", "catalog.read", "term.open", "term.input", "term.resize"]
            )
            let ok = try await c.pair(intent)
            // The paired connection is inert by design (the host rejects
            // commands from a just-paired socket): reconnect with the granted
            // credentials — connect() handles persist/refresh/catalog/observe.
            await c.close()
            let auth = DeviceAuthentication(deviceId: ok.deviceId, deviceToken: ok.deviceToken)
            await connect(endpoint: endpoint, identity: identity, authentication: auth)
            if connected { pairedEndpoint = endpoint.absoluteString }
        } catch {
            lastError = "Pairing failed — check the code and that the host is running (\(error))"
        }
    }

    /// Lowercase the device name into a host-safe id slug: alphanumerics
    /// kept, every other run collapsed to a single hyphen, trimmed. Falls
    /// back to "device" when the name has no usable characters.
    private static func slugify(_ name: String) -> String {
        let lowered = name.lowercased()
        var slug = ""
        var lastWasDash = true
        for ch in lowered {
            if ch.isLetter || ch.isNumber {
                slug.append(ch)
                lastWasDash = false
            } else if !lastWasDash {
                slug.append("-")
                lastWasDash = true
            }
        }
        if slug.hasSuffix("-") { slug.removeLast() }
        return slug.isEmpty ? "device" : slug
    }

    /// Re-fetch the authoritative session list (session.list).
    func refresh() async {
        guard let client, connected, !hostId.isEmpty else { return }
        do {
            let result = try await client.sendCommand(CommandIntent(hostId: hostId, command: "session.list"))
            sessions = try result.sessionListResult().sessions
            reconcileSelection()
            attachSelectedIfNeeded()
        } catch {
            t4log.error("refresh failed: \(error)")
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
    /// Skipped when the device lacks catalog.read — an unauthorized command
    /// gets the connection closed by the remote policy.
    private func loadCatalog() async {
        guard let client, connected, !hostId.isEmpty, grantedCapabilities.contains("catalog.read") else { return }
        do {
            let result = try await client.sendCommand(CommandIntent(hostId: hostId, command: "catalog.get"))
            catalog = try result.catalogItems()
        } catch {
            lastError = "\(error)"
        }
    }

    // MARK: - Files (read-only workspace browser)

    /// List a directory in the session workspace (files.list). `path` is a
    /// safe relative POSIX path; pass "" for the project root — the host
    /// treats an absent/empty path as the workspace root. Returns the
    /// entries (folders and files) or nil on failure (lastError is set).
    func listFiles(sessionId: String, path: String) async -> [FileListEntry]? {
        guard let client, connected, !hostId.isEmpty else {
            lastError = "Not connected to a host."
            return nil
        }
        var args: [String: JSONValue] = [:]
        if !path.isEmpty { args["path"] = .string(path) }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "files.list", args: args, sessionId: sessionId))
            return try result.filesListResult()
        } catch {
            t4log.error("files.list failed: \(error)")
            lastError = "\(error)"
            return nil
        }
    }

    /// Read a file from the session workspace (files.read). `path` is a safe
    /// relative POSIX path. Returns the content string (already decoded from
    /// base64 when the host used that encoding) or nil on failure (lastError
    /// is set). The host bounds content to MAX_FILE_BYTES.
    func readFile(sessionId: String, path: String) async -> String? {
        guard let client, connected, !hostId.isEmpty else {
            lastError = "Not connected to a host."
            return nil
        }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "files.read",
                args: ["path": .string(path)], sessionId: sessionId))
            let (content, _) = try result.filesReadResult()
            return content
        } catch {
            t4log.error("files.read failed: \(error)")
            lastError = "\(error)"
            return nil
        }
    }

    // MARK: - Terminal drawer
    // term.open is a session-scoped command (capability term.open, revision
    // optional) that opens a pty and returns {terminalId}. Output arrives as
    // terminal.output additive frames (routed in observe()); the client sends
    // terminal.input/terminal.resize/terminal.close as raw additive frames
    // via HostClient.sendFrame (no requestId, no response). If the host denies
    // term.open (the paired device lacks the capability), the command throws
    // and lastError surfaces — the drawer shows an error row.

    /// Open a terminal for a session (term.open {cols, rows}). Returns the
    /// new terminalId, or nil on failure (lastError / terminalErrors set).
    /// Reuses an already-open terminal for the session if present.
    @discardableResult
    func openTerminal(sessionId: String, cols: Int = 80, rows: Int = 24) async -> String? {
        if let existing = openTerminalId[sessionId] { return existing }
        guard let client, connected, !hostId.isEmpty else {
            lastError = "Not connected to a host."
            return nil
        }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "term.open",
                args: ["cols": .number(Double(cols)), "rows": .number(Double(rows))],
                sessionId: sessionId))
            let terminalId = try result.termOpenResult()
            openTerminalId[sessionId] = terminalId
            terminalOutput[terminalId] = ""
            terminalErrors.removeValue(forKey: sessionId)
            t4log.notice("term.open \(terminalId, privacy: .public) for \(sessionId, privacy: .public)")
            return terminalId
        } catch {
            t4log.error("term.open failed: \(error)")
            lastError = "\(error)"
            terminalErrors[sessionId] = "\(error)"
            return nil
        }
    }

    /// Send user keystrokes to a pty (terminal.input). No-op when the
    /// terminal is not open or not connected. `data` is UTF-8 text.
    func sendTerminalInput(sessionId: String, data: String) async {
        guard let client, let terminalId = openTerminalId[sessionId] else { return }
        let frame = TerminalInputFrame(hostId: hostId, sessionId: sessionId, terminalId: terminalId, data: data)
        try? await client.sendFrame(frame)
    }

    /// Resize a pty (terminal.resize {cols, rows}). No-op when no terminal
    /// is open for the session.
    func resizeTerminal(sessionId: String, cols: Int, rows: Int) async {
        guard let client, let terminalId = openTerminalId[sessionId] else { return }
        let frame = TerminalResizeFrame(hostId: hostId, sessionId: sessionId, terminalId: terminalId, cols: cols, rows: rows)
        try? await client.sendFrame(frame)
    }

    /// Close a pty (terminal.close). Clears the session's open terminal id
    /// and buffered output; the host may still emit a terminal.exit frame.
    func closeTerminal(sessionId: String, reason: String? = nil) async {
        guard let client, let terminalId = openTerminalId[sessionId] else { return }
        let frame = TerminalCloseFrame(hostId: hostId, sessionId: sessionId, terminalId: terminalId, reason: reason)
        try? await client.sendFrame(frame)
        openTerminalId.removeValue(forKey: sessionId)
        terminalOutput.removeValue(forKey: terminalId)
        terminalExits.removeValue(forKey: terminalId)
    }

    /// Drop all terminal state for a session (e.g. on disconnect). Does not
    /// send terminal.close — the transport is gone.
    func clearTerminal(sessionId: String) {
        if let terminalId = openTerminalId[sessionId] {
            terminalOutput.removeValue(forKey: terminalId)
            terminalExits.removeValue(forKey: terminalId)
        }
        openTerminalId.removeValue(forKey: sessionId)
        terminalErrors.removeValue(forKey: sessionId)
    }

    // MARK: - Panes data
    // Four detail-ellipsis panes — Usage, Review, Artifacts, Settings — each
    // backed by a host-wire command. usage.read and settings.read/write are
    // host-scope (no sessionId); review.read and artifact.read are session-
    // scoped. review.read takes the latest reviewId from `reviewsBySession`
    // (fed by `review` additive frames in observe()); artifact.read takes an
    // artifactId from a transcript entry's `data.artifacts` descriptor list.
    // All five degrade to a clear error banner when the host denies the
    // command (e.g. the paired device lacks the capability).

    /// Fetch the host usage snapshot (usage.read, host scope). Stores the
    /// result in `usageSnapshot` and returns it; nil on failure (lastError
    /// is set). Safe to repeat — the pane refreshes on demand.
    @discardableResult
    func usageRead() async -> UsageReadResult? {
        guard let client, connected, !hostId.isEmpty else {
            lastError = "Not connected to a host."
            return nil
        }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "usage.read"))
            let snapshot = try result.usageReadResult()
            usageSnapshot = snapshot
            return snapshot
        } catch {
            t4log.error("usage.read failed: \(error)")
            lastError = "\(error)"
            return nil
        }
    }

    /// Fetch one code review (review.read, session scope). `reviewId` defaults
    /// to the latest review frame's id for the session when nil. Returns the
    /// typed result or nil on failure (lastError is set).
    @discardableResult
    func reviewRead(sessionId: String, reviewId: String? = nil) async -> ReviewReadResult? {
        guard let client, connected, !hostId.isEmpty else {
            lastError = "Not connected to a host."
            return nil
        }
        let id = reviewId ?? reviewsBySession[sessionId]?.last?.reviewId
        guard let id else {
            lastError = "No review available for this session."
            return nil
        }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "review.read",
                args: ["reviewId": .string(id)], sessionId: sessionId))
            return try result.reviewReadResult()
        } catch {
            t4log.error("review.read failed: \(error)")
            lastError = "\(error)"
            return nil
        }
    }

    /// Read one chunk of a session-retained artifact (artifact.read, session
    /// scope). `offset` defaults to 0 (the first chunk, enough for inline
    // text/patch previews). Caches the chunk in `artifactChunks` and returns
    // it; nil on failure (lastError is set).
    @discardableResult
    func artifactRead(sessionId: String, artifactId: String, offset: Int = 0) async -> ArtifactReadChunk? {
        guard let client, connected, !hostId.isEmpty else {
            lastError = "Not connected to a host."
            return nil
        }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "artifact.read",
                args: ["artifactId": .string(artifactId), "offset": .number(Double(offset))],
                sessionId: sessionId))
            let chunk = try result.artifactReadResult()
            artifactChunks[artifactId] = chunk
            return chunk
        } catch {
            t4log.error("artifact.read failed: \(error)")
            lastError = "\(error)"
            return nil
        }
    }

    /// Fetch the host settings map (settings.read, host scope). Stores the
    /// map in `settingsSnapshot` and returns it; nil on failure (lastError
    /// is set).
    @discardableResult
    func settingsRead() async -> [String: JSONValue]? {
        guard let client, connected, !hostId.isEmpty else {
            lastError = "Not connected to a host."
            return nil
        }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "settings.read"))
            let read = try result.settingsReadResult()
            settingsSnapshot = read.settings
            settingsRevision = read.revision
            return read.settings
        } catch {
            t4log.error("settings.read failed: \(error)")
            lastError = "\(error)"
            return nil
        }
    }

    /// Write one host setting (settings.write, host scope, revision required).
    /// The host echoes the written metadata object; on success the store
    /// refreshes `settingsSnapshot` with the echo and returns true. Returns
    /// false on failure (lastError is set). `value` is sent as a JSONValue
    /// (string/bool/number); the pane shapes string values as `.string`.
    @discardableResult
    func settingsWrite(key: String, value: JSONValue) async -> Bool {
        guard let client, connected, !hostId.isEmpty else {
            lastError = "Not connected to a host."
            return false
        }
        // settings.write is host-scope, revision required, confirmation
        // challenge. The revision is the settings revision captured by the
        // last settings.read (`settingsRevision`); the host may answer with a
        // confirmation challenge instead of a result — that surfaces as
        // `pendingConfirmation` via observe() and the banner handles approve/
        // deny. Send without a confirmationId so the host issues the
        // challenge; the store's pendingConfirmation banner then drives the
        // confirm() flow.
        guard let revision = settingsRevision else {
            lastError = "Settings revision unknown — load settings first."
            return false
        }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "settings.write",
                args: [key: value], expectedRevision: revision))
            if let echo = try result.settingsWriteResult() {
                settingsSnapshot = echo
            }
            return true
        } catch {
            t4log.error("settings.write failed: \(error)")
            lastError = "\(error)"
            return false
        }
    }

    /// Code reviews for a session: live review frames when connected, sample
    /// rows otherwise (review-pane preview without a host).
    func reviews(for sessionId: String) -> [ReviewFrame] {
        if connected { return reviewsBySession[sessionId] ?? [] }
        return Self.sampleReviews
    }

    /// Artifact descriptors referenced by a session's transcript entries.
    /// Scans `data.artifacts` (an array of {artifactId, kind, mediaType, ...}
    // descriptors) on every durable entry and de-dupes by artifactId. The
    // artifacts pane lists these; tapping one calls `artifactRead` to load
    // its first chunk for inline preview.
    func artifacts(for sessionId: String) -> [ArtifactDescriptor] {
        let entries = transcript(for: sessionId)
        var seen = Set<String>()
        var out: [ArtifactDescriptor] = []
        for entry in entries {
            guard let arr = entry.data.array("artifacts") else { continue }
            for value in arr {
                guard case .object(let obj) = value,
                      case .string(let aid) = obj["artifactId"] ?? .null,
                      !seen.contains(aid) else { continue }
                seen.insert(aid)
                if let descriptor = ArtifactDescriptor(from: value) {
                    out.append(descriptor)
                }
            }
        }
        return out
    }

    // MARK: - Transcript paging (transcript.page)

    /// Load one older transcript page for a session and prepend it to the
    /// live transcript. The `before` cursor is the opaque `nextCursor` the
    /// host returned from the previous `transcript.page` call; it is omitted
    /// on the first page (the host then returns the newest page plus a cursor
    /// for older history). Idempotent while a page is already in flight.
    /// The host's `transcript-page-reader` decrypts `before` as an opaque
    /// cursor payload — NOT an entry id — so the cursor from the prior result
    /// is the only valid `before` value.
    func loadEarlier(sessionId: String) async {
        guard let client, connected, !hostId.isEmpty else { return }
        // Idempotent: never overlap two page requests for one session.
        if pagingState[sessionId]?.loading == true { return }
        // Stop once the host has told us there is no more history.
        if pagingState[sessionId]?.hasMore == false { return }

        var state = pagingState[sessionId] ?? TranscriptPaging(nextCursor: nil, hasMore: nil, loading: false)
        state.loading = true
        pagingState[sessionId] = state

        var args: [String: JSONValue] = ["limit": .number(50)]
        if let before = state.nextCursor { args["before"] = .string(before) }

        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "transcript.page", args: args, sessionId: sessionId))
            let page = try result.transcriptPageResult()

            // Prepend the decoded older rows, dropping any that overlap the
            // already-known live tail (the first page commonly overlaps the
            // attach snapshot). The host returns entries oldest→newest.
            let existing = liveEntries[sessionId] ?? []
            let existingIds = Set(existing.map { $0.id })
            let older = page.entries.map { TranscriptEntry(from: $0) }
                .filter { !existingIds.contains($0.id) }

            // Flag the prepend so the detail view suppresses its scroll-to-
            // bottom follow; clear it on the next runloop tick so the
            // count-change render still sees the flag set.
            prependingSession = sessionId
            if !older.isEmpty {
                liveEntries[sessionId] = older + existing
            }
            pagingState[sessionId] = TranscriptPaging(
                nextCursor: page.nextCursor,
                hasMore: page.hasMore,
                loading: false)
            Task { @MainActor in prependingSession = nil }
        } catch {
            t4log.error("transcript.page failed: \(error)")
            lastError = "\(error)"
            var failed = pagingState[sessionId] ?? TranscriptPaging(nextCursor: nil, hasMore: nil, loading: false)
            failed.loading = false
            pagingState[sessionId] = failed
            Task { @MainActor in prependingSession = nil }
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
                // The snapshot is the live tail at the current cursor; older
                // history paging restarts from unknown (hasMore = nil).
                pagingState[snapshot.sessionId] = TranscriptPaging(nextCursor: nil, hasMore: nil, loading: false)
            case .entry(let entryFrame):
                var entries = liveEntries[entryFrame.sessionId] ?? []
                let entry = TranscriptEntry(from: entryFrame.entry)
                if !entries.contains(where: { $0.id == entry.id }) {
                    entries.append(entry)
                    liveEntries[entryFrame.sessionId] = entries
                }
                // De-dupe with the live tail: when the durable assistant
                // message entry lands, the in-progress streaming text is now
                // redundant — drop it so the transcript doesn't double-render.
                if entry.kind == .message, entry.role != "user",
                   streamingText[entryFrame.sessionId] != nil {
                    streamingText.removeValue(forKey: entryFrame.sessionId)
                }
            case .confirmation(let challenge):
                pendingConfirmation = challenge
            case .event(let frame):
                if frame.event.isAskResolved {
                    pendingAsk = nil
                } else if let ask = frame.event.askRequest {
                    pendingAsk = PendingAsk(sessionId: frame.sessionId, request: ask)
                }
                // Assistant streaming: the host emits `message.update` with
                // the FULL current text snapshot (not an append) per token
                // batch, then `message.settled` once the durable entry is
                // committed. Mirror the snapshot into streamingText while in
                // flight; clear on settled/discarded/turn.end (the durable
                // entry then arrives via .entry above).
                let sid = frame.sessionId
                switch frame.event.type {
                case "turn.start":
                    activeTurns.insert(sid)
                case "turn.end", "turn.error":
                    activeTurns.remove(sid)
                    Task { await refreshTodos(sessionId: sid) }
                case "message.update":
                    // Only stream the assistant voice; user echoes are sent
                    // by the client itself and settle immediately.
                    if case .string(let role) = frame.event.fields["role"], role == "assistant",
                       case .string(let text) = frame.event.fields["text"] {
                        streamingText[sid] = text
                    }
                case "message.settled", "message.discarded", "turn.end":
                    streamingText.removeValue(forKey: sid)
                default:
                    break
                }
            // Terminal frames: append output to the per-terminal buffer
            // (capped ~200KB, drop oldest chunk when exceeded) and record
            // exit codes. The drawer renders terminalOutput[terminalId].
            case .terminalOutput(let f):
                var buf = terminalOutput[f.terminalId] ?? ""
                buf += f.data
                // Cap ~200KB: if exceeded, drop the oldest half so the
                // buffer stays bounded without thrashing on every chunk.
                let cap = 200_000
                if buf.utf8.count > cap {
                    let cut = buf.utf8.count / 2
                    if let idx = buf.utf8.index(buf.startIndex, offsetBy: cut, limitedBy: buf.endIndex) {
                        buf = String(buf[idx...])
                    }
                }
                terminalOutput[f.terminalId] = buf
            case .terminalExit(let f):
                terminalExits[f.terminalId] = f.exitCode
            // Agent frames: roll subagent state into agentsBySession for the
            // agents pane. The .agent snapshot seeds/replaces a slot; the
            // agent.* additive frames update state/progress/detail in place.
            case .agent(let f):
                upsertAgent(sessionId: f.sessionId, agentId: f.agentId) { slot in
                    slot.state = f.state
                    slot.progress = f.progress
                    slot.detail = Self.detailText(f.detail)
                }
            case .agentState(let f):
                upsertAgent(sessionId: f.sessionId, agentId: f.agentId) { slot in
                    slot.state = f.state.rawValue
                }
            case .agentLifecycle(let f):
                upsertAgent(sessionId: f.sessionId, agentId: f.agentId) { slot in
                    slot.state = f.lifecycle.rawValue
                }
            case .agentProgress(let f):
                upsertAgent(sessionId: f.sessionId, agentId: f.agentId) { slot in
                    slot.progress = f.progress
                    if let d = f.detail { slot.detail = Self.detailText(d) }
                }
            case .agentEvent(let f):
                upsertAgent(sessionId: f.sessionId, agentId: f.agentId) { slot in
                    slot.detail = f.event + (Self.detailText(f.data).map { " — \($0)" } ?? "")
                }
            case .agentTranscript(let f):
                // Transcript batches carry no state/progress; ensure the slot
                // exists so the pane lists the agent even before a snapshot.
                upsertAgent(sessionId: f.sessionId, agentId: f.agentId) { _ in }
            // Review frames: track the latest review per session so the
            // Review pane can call review.read with the current reviewId.
            // (reviewsBySession is declared in the Panes data MARK section.)
            case .review(let r):
                reviewsBySession[r.sessionId, default: []].append(r)
            default:
                break
            }
        }
    }

    /// Insert or update one subagent slot for a session, applying `mutate` to
    /// the rolled-up state. New slots default to an unknown state/progress.
    private func upsertAgent(sessionId: String, agentId: String, mutate: (inout AgentState) -> Void) {
        var agents = agentsBySession[sessionId] ?? []
        if let index = agents.firstIndex(where: { $0.agentId == agentId }) {
            mutate(&agents[index])
        } else {
            var slot = AgentState(agentId: agentId, state: "running", progress: nil, detail: nil)
            mutate(&slot)
            agents.append(slot)
        }
        agentsBySession[sessionId] = agents
    }

    /// Best-effort one-line text from an agent frame's opaque `detail`/`data`
    /// object: prefers a `text`/`message`/`title`/`label` string field, else a
    /// `status`/`state` string. Returns nil when nothing readable is present.
    private static func detailText(_ value: JSONValue?) -> String? {
        guard let value else { return nil }
        for key in ["text", "message", "title", "label", "status", "state"] {
            if let s = value.string(key), !s.isEmpty { return s }
        }
        return nil
    }

    func disconnect() async {
        await client?.close()
        client = nil
        connected = false
        pairedEndpoint = nil
        // Drop any open terminals — the transport is gone, no close frame.
        terminalOutput.removeAll()
        terminalExits.removeAll()
        openTerminalId.removeAll()
        terminalErrors.removeAll()
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

    /// Sample subagents — offline preview for the agents pane (one running,
    one completed) so the sheet renders without a live host.
    private static let sampleAgents: [AgentState] = [
        AgentState(agentId: "agent-scout", state: "running", progress: 0.62, detail: "Mapping the reconnect backoff"),
        AgentState(agentId: "agent-worker", state: "completed", progress: 1.0, detail: "Ported the lease acquire loop"),
    ]

    /// Sample code reviews — offline preview for the review pane (one
    /// pending review with a warning finding) so the sheet renders without
    /// a live host. Built by decoding a minimal `review` frame.
    private static let sampleReviews: [ReviewFrame] = {
        let json = """
        {"v":"omp-app/1","type":"review","hostId":"studio-mac","sessionId":"s1","reviewId":"review-sample","status":"pending","path":"src/fixture.ts","findings":[{"severity":"warning","message":"Fixture review finding for the mobile application flow.","line":12}]}
        """
        return (try? JSONDecoder().decode(ReviewFrame.self, from: Data(json.utf8)))
            .map { [$0] } ?? []
    }()
}
