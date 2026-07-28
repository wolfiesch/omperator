//  T4SessionStore.swift
//  Authoritative session inventory for the native T4 Code iOS client. Replaces
//  Enclave's collab-guest "rooms you've joined" model: this holds the real
//  host-wire SessionRef inventory, grouped by project, and drives the rail from
//  a HostClient connection. Seeded with sample data so the rail renders in the
//  simulator without a live host; connect(endpoint:) swaps in a real t4-host.

import SwiftUI
import HostWire
import CryptoKit
import Combine
import os

let t4log = Logger(subsystem: "sh.t4code.ios", category: "store")

struct PendingTranscriptQueue {
    private(set) var entries: [TranscriptEntry] = []

    var isEmpty: Bool { entries.isEmpty }

    mutating func enqueue(_ entry: TranscriptEntry) {
        if let index = entries.firstIndex(where: { $0.id == entry.id }) {
            entries[index] = entry
        } else {
            entries.append(entry)
        }
    }

    mutating func drainReadyPrefix(
        while isReady: (TranscriptEntry) -> Bool
    ) -> [TranscriptEntry] {
        var drained: [TranscriptEntry] = []
        while let first = entries.first, isReady(first) {
            drained.append(entries.removeFirst())
        }
        return drained
    }

    mutating func removeAll(where shouldRemove: (TranscriptEntry) -> Bool) {
        entries.removeAll(where: shouldRemove)
    }
}

@MainActor
final class T4SessionStore: ObservableObject {
    let connectionModel = T4ConnectionInventoryModel()
    let transcriptModel = T4TranscriptProjectionModel()
    let promptModel = T4PromptLeaseModel()
    let agentModel = T4AgentInventoryModel()
    let terminalModel = T4TerminalModel()
    let previewModel = T4PreviewBrowserModel()
    let filesReviewModel = T4FilesReviewModel()
    let catalogSettingsModel = T4CatalogSettingsModel()
    private var domainModelSubscriptions = Set<AnyCancellable>()

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
    /// One host preview capture, surfaced as a transcript image row. `image`
    /// is nil until the chunked `preview.capture.read` fetch resolves; the
    /// browser pane and transcript render the row once it is set. Keyed by
    /// `captureId` so re-arriving frames for the same capture update in place.
    struct PreviewCaptureRow: Identifiable, Equatable {
        let captureId: String
        let previewId: String
        let mimeType: String
        let width: Int
        let height: Int
        let capturedAt: Int
        var image: PlatformImage?
        var id: String { captureId }

        init(metadata: PreviewCaptureMetadata, previewId: String, image: PlatformImage? = nil) {
            self.captureId = metadata.captureId
            self.previewId = previewId
            self.mimeType = metadata.mimeType.rawValue
            self.width = metadata.width
            self.height = metadata.height
            self.capturedAt = metadata.capturedAt
            self.image = image
        }
    }
    /// Host version/identity snapshot captured from the WelcomeFrame on
    /// connect (hostId, ompVersion, appserverVersion). Shown in the Settings
    /// pane's Host section; nil while disconnected.
    struct HostInfo: Equatable, Sendable {
        let hostId: String
        let ompVersion: String
        let appserverVersion: String
    }

    private(set) var sessions: [SessionRef] {
        get { connectionModel.sessions }
        set { connectionModel.sessions = newValue }
    }
    @Published var query: String = ""
    private(set) var connecting: Bool {
        get { connectionModel.connecting }
        set { connectionModel.connecting = newValue }
    }
    private(set) var connected: Bool {
        get { connectionModel.connected }
        set { connectionModel.connected = newValue }
    }
    var lastError: String? {
        get { connectionModel.lastError }
        set { connectionModel.lastError = newValue }
    }
    /// Human-readable endpoint the store is currently paired/connected to
    /// (e.g. "ws://macbookpro.my-tailnet.ts.net:8787/v1/ws"), for UI display.
    private(set) var pairedEndpoint: String? {
        get { connectionModel.pairedEndpoint }
        set { connectionModel.pairedEndpoint = newValue }
    }
    /// Host version/identity from the WelcomeFrame (hostId, OMP version,
    /// appserver version). Captured on connect, cleared on disconnect.
    private(set) var hostInfo: HostInfo? {
        get { connectionModel.hostInfo }
        set { connectionModel.hostInfo = newValue }
    }
    @Published var selectedSession: SessionRef?
    /// Live transcripts by sessionId (snapshot + streamed entries). Present
    /// only for attached sessions while connected; the sample rail falls back
    /// to `sampleTranscript` when disconnected.
    var liveEntries: [String: [TranscriptEntry]] {
        get { transcriptModel.entries }
        set { transcriptModel.entries = newValue }
    }
    /// Frame-paced assistant text/reasoning by session. Host snapshots remain
    /// authoritative; the display buffer reveals them by whole graphemes.
    private(set) var streamingMessages: [String: StreamingAssistantBuffer] {
        get { transcriptModel.streamingMessages }
        set { transcriptModel.streamingMessages = newValue }
    }
    /// Ordered OMP-native assistant blocks. Unlike the compatibility buffers,
    /// this keeps thinking, response text, and generated tool input interleaved
    /// exactly as the model emitted them.
    private(set) var liveTurns: [String: LiveTurnTimeline] {
        get { transcriptModel.liveTurns }
        set { transcriptModel.liveTurns = newValue }
    }
    /// Transient tool arguments, execution progress, and results by session.
    private(set) var liveTools: [String: LiveToolProjection] {
        get { transcriptModel.liveTools }
        set { transcriptModel.liveTools = newValue }
    }
    /// Durable rows that arrived before their frame-paced live projection
    /// finished. A per-session queue preserves wire order across assistant and
    /// tool rows, and only drains a ready prefix.
    private var pendingTranscriptEntries: [String: PendingTranscriptQueue] = [:]
    /// Sessions with a turn in flight, from turn.start/turn.end events — the
    /// composer's stop button keys off this (the ref's `status` sticks at
    /// "active" long after the turn actually ends).
    private(set) var activeTurns: Set<String> {
        get { transcriptModel.activeTurns }
        set { transcriptModel.activeTurns = newValue }
    }
    /// OMP todo phases by sessionId (the plan strip's data), refreshed on
    /// attach and after streamed entries.
    private(set) var todoPhasesBySession: [String: [PlanPhase]] {
        get { transcriptModel.todoPhasesBySession }
        set { transcriptModel.todoPhasesBySession = newValue }
    }

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
    private(set) var catalog: [CatalogItem] {
        get { catalogSettingsModel.catalog }
        set { catalogSettingsModel.catalog = newValue }
    }
    /// A confirmation challenge awaiting the user's approve/deny decision.
    var pendingConfirmation: ConfirmationChallenge? {
        get { promptModel.pendingConfirmation }
        set { promptModel.pendingConfirmation = newValue }
    }
    /// A host ask (question mode) awaiting the user's answer, if any.
    var pendingAsk: PendingAsk? {
        get { promptModel.pendingAsk }
        set { promptModel.pendingAsk = newValue }
    }
    /// Optimistic fast-mode state per session (the wire has no fast field).
    private(set) var fastBySession: [String: Bool] {
        get { promptModel.fastBySession }
        set { promptModel.fastBySession = newValue }
    }
    /// Per-session transcript paging state (transcript.page). `hasMore` is
    /// nil until the first older page resolves (unknown); the "Load earlier"
    /// button shows when hasMore is true OR (unknown and entries ≥ 50).
    var pagingState: [String: TranscriptPaging] {
        get { transcriptModel.pagingState }
        set { transcriptModel.pagingState = newValue }
    }
    /// Session currently prepending a paged history block. The detail view
    /// suppresses its scroll-to-bottom follow while this matches its session
    /// so prepended older rows don't yank the viewport to the bottom.
    var prependingSession: String? {
        get { transcriptModel.prependingSession }
        set { transcriptModel.prependingSession = newValue }
    }
    /// Subagents per session, fed by .agent/.agentState/.agentLifecycle/
    /// .agentProgress/.agentEvent frames in observe(). The agents pane
    /// renders this; empty when the host has no subagents for a session.
    private(set) var agentsBySession: [String: [AgentState]] {
        get { agentModel.agentsBySession }
        set { agentModel.agentsBySession = newValue }
    }
    /// Per-terminal buffered output, keyed by terminalId. `terminal.output`
    /// frames append here (capped ~200KB per terminal, dropping the oldest
    /// chunk when exceeded). The terminal drawer feeds this to SwiftTerm.
    var terminalOutput: [String: String] {
        get { terminalModel.output }
        set { terminalModel.output = newValue }
    }
    /// Per-terminal exit code, set when a `terminal.exit` frame arrives.
    /// Presence of a key means the pty has exited; nil value means exited
    /// with code 0 recorded as absent until exit.
    var terminalExits: [String: Int] {
        get { terminalModel.exits }
        set { terminalModel.exits = newValue }
    }
    /// Per-session ordered terminal ids (max 4), in the order `openTerminal`
    /// opened them. The drawer renders one tab per id; the active id is the
    /// tab whose buffered output is rendered and whose keystrokes are sent.
    var openTerminalIds: [String: [String]] {
        get { terminalModel.openIdsBySession }
        set { terminalModel.openIdsBySession = newValue }
    }
    /// The active terminal id for a session — the tab the drawer renders and
    /// the target of `sendTerminalInput`/`resizeTerminal`. Set by `openTerminal`
    /// (new terminal becomes active) and `selectTerminal` (tab switch), and
    /// reselected to a neighbor when the active terminal is closed.
    var activeTerminalId: [String: String] {
        get { terminalModel.activeIdBySession }
        set { terminalModel.activeIdBySession = newValue }
    }
    /// Per-terminal last error (e.g. a denied term.open command). Cleared
    /// on a successful open or explicit close.
    var terminalErrors: [String: String] {
        get { terminalModel.errors }
        set { terminalModel.errors = newValue }
    }
    /// Per-session browser URL for the browser pane (T4BrowserPane). The
    /// pane persists the URL field here so reopening a session's browser
    /// returns to the last visited page. Defaults to localhost:3000 via
    /// `browserURL(for:)` when unset.
    var browserURLBySession: [String: String] {
        get { previewModel.urlBySession }
        set { previewModel.urlBySession = newValue }
    }
    /// Code reviews per session, fed by `review` additive frames in observe().
    /// The review pane reads the latest reviewId from here to call
    /// review.read; empty when the host has not pushed a review.
    private(set) var reviewsBySession: [String: [ReviewFrame]] {
        get { filesReviewModel.reviewsBySession }
        set { filesReviewModel.reviewsBySession = newValue }
    }
    /// Last fetched usage snapshot (usage.read, host scope). nil until the
    /// usage pane first loads it; refreshed on demand. `generatedAt` is the
    /// host's epoch-millis timestamp.
    var usageSnapshot: UsageReadResult? {
        get { catalogSettingsModel.usageSnapshot }
        set { catalogSettingsModel.usageSnapshot = newValue }
    }
    /// Last fetched host settings (settings.read, host scope). Carried as an
    /// opaque object map (boundedSettings) — keys are setting names, values
    /// are strings/bools/numbers. nil until the settings pane first loads it.
    var settingsSnapshot: [String: JSONValue]? {
        get { catalogSettingsModel.settingsSnapshot }
        set { catalogSettingsModel.settingsSnapshot = newValue }
    }
    /// Last fetched host settings revision (settings.read result.revision),
    /// required as `expectedRevision` for settings.write. nil until the
    /// settings pane first loads it.
    var settingsRevision: String? {
        get { catalogSettingsModel.settingsRevision }
        set { catalogSettingsModel.settingsRevision = newValue }
    }
    /// Cached artifact chunks by artifactId, populated by artifact.read.
    /// The artifacts pane taps a descriptor to load+preview content; the
    /// first chunk (offset 0) is enough for inline text/patch previews.
    var artifactChunks: [String: ArtifactReadChunk] {
        get { filesReviewModel.artifactChunks }
        set { filesReviewModel.artifactChunks = newValue }
    }
    /// Latest preview id per session, tracked from `preview.launch`/`state`/
    /// `navigation`/`capture` push frames and the `preview.launch` command
    /// result. `previewCapture(sessionId:previewId:)` uses this when no
    /// explicit previewId is given; the browser pane's Capture button is
    /// enabled while a preview is tracked.
    var previewIdBySession: [String: String] {
        get { previewModel.previewIdBySession }
        set { previewModel.previewIdBySession = newValue }
    }
    /// Decoded capture images by captureId, populated by `previewCapture`
    /// (the Capture button) and by the async fetch kicked off when a
    /// `preview.capture` push frame arrives. The browser pane renders the
    /// latest one full-fit; transcript capture rows look their image up here
    /// by `data.captureId`.
    var previewCaptureImages: [String: PlatformImage] {
        get { previewModel.captureImages }
        set { previewModel.captureImages = newValue }
    }
    /// Ordered capture rows per session — one per `preview.capture` push
    /// frame or explicit `preview.capture` command. Each carries the capture
    /// metadata plus the decoded image once the chunked fetch resolves. The
    /// browser pane and transcript render these as image rows.
    var previewCaptureRowsBySession: [String: [PreviewCaptureRow]] {
        get { previewModel.captureRowsBySession }
        set { previewModel.captureRowsBySession = newValue }
    }

    /// True once a live host has spoken (refresh or push). Drives the boot
    /// splash: saved-connection devices see "Connecting…", not fake chat.
    private(set) var hasLiveInventory: Bool {
        get { connectionModel.hasLiveInventory }
        set { connectionModel.hasLiveInventory = newValue }
    }
    /// True when a previous session's endpoint is persisted (restore will run).
    var hasSavedConnection: Bool {
        EphemeralConnectionCredentials() != nil
            || Keychain.get(Self.savedEndpointKey) != nil
    }

    /// True once a live host has spoken; false while showing the offline sample.
    private func markLive() { hasLiveInventory = true }

    /// Models from the catalog, in display order (supported first).
    var catalogModels: [CatalogItem] {
        catalog.filter { $0.kind == .model && $0.supported != false }
            .sorted { $0.id.localizedCaseInsensitiveCompare($1.id) == .orderedAscending }
    }

    var client: HostClient?
    var hostId: String = ""
    private var streamingTasks: [String: Task<Void, Never>] = [:]
    private var liveTurnTasks: [String: Task<Void, Never>] = [:]
    private var toolStreamingTasks: [String: Task<Void, Never>] = [:]
    /// Capabilities the host granted at welcome — gates optional commands
    /// (e.g. catalog.get needs catalog.read; an unauthorized command gets
    /// the connection closed by the remote policy).
    var grantedCapabilities: [String] = []
    /// Negotiated additive protocol features. Ownership UI uses these to
    /// expose safe copy/adoption actions only when the host supports them.
    private var grantedFeatures: Set<ProtocolFeature> = []

    var canForkSessions: Bool {
        connected
            && grantedCapabilities.contains("sessions.manage")
            && grantedFeatures.contains(.sessionFork)
    }

    // Persisted connection credentials, stored in the device Keychain (see
    // Keychain.swift). The account names are reused as the legacy
    // UserDefaults keys so the one-time migration maps 1:1.
    private static let savedEndpointKey = "t4.endpoint"
    private static let savedDeviceIdKey = "t4.deviceId"
    private static let savedDeviceTokenKey = "t4.deviceToken"
    /// UserDefaults flag set once the legacy plist credentials have been
    /// copied into the Keychain and the plist entries deleted.
    private static let keychainMigratedKey = "t4.keychainMigrated"

    private func receiveStreamingMessage(sessionId: String, text: String, reasoning: String) {
        var buffer = streamingMessages[sessionId] ?? StreamingAssistantBuffer()
        buffer.receive(text: text, reasoning: reasoning)
        streamingMessages[sessionId] = buffer
        guard streamingTasks[sessionId] == nil else { return }
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            while !Task.isCancelled, var next = self.streamingMessages[sessionId] {
                let hasMore = next.advance()
                self.streamingMessages[sessionId] = next
                if !hasMore {
                    self.finishPendingAssistantEntry(sessionId: sessionId)
                    break
                }
                try? await Task.sleep(nanoseconds: 16_666_667)
            }
            if !Task.isCancelled { self.streamingTasks[sessionId] = nil }
        }
        streamingTasks[sessionId] = task
    }

    private func clearStreamingMessage(sessionId: String) {
        streamingTasks.removeValue(forKey: sessionId)?.cancel()
        streamingMessages.removeValue(forKey: sessionId)
        guard var pending = pendingTranscriptEntries[sessionId] else { return }
        pending.removeAll { $0.kind == .message && $0.role != "user" }
        if pending.isEmpty { pendingTranscriptEntries.removeValue(forKey: sessionId) }
        else { pendingTranscriptEntries[sessionId] = pending }
    }

    private func receiveLiveTurnBlock(sessionId: String, event: SessionEvent) {
        // The ordered event supersedes the flattened compatibility projection.
        // Keep any already-arrived durable row pending while the new timeline
        // finishes revealing its final snapshot.
        streamingTasks.removeValue(forKey: sessionId)?.cancel()
        streamingMessages.removeValue(forKey: sessionId)

        var timeline = liveTurns[sessionId] ?? LiveTurnTimeline()
        guard timeline.apply(event) else { return }
        liveTurns[sessionId] = timeline
        scheduleLiveTurnFrames(sessionId: sessionId)
    }

    #if DEBUG
    /// Deterministic visual-proof seam shared by the macOS and iOS targets.
    /// It enters through the same SessionEvent projection as live host frames,
    /// then lets the production 60 fps pacing tasks reveal each snapshot.
    func runStreamingProofFixture() async {
        guard let sessionId = selectedSession?.sessionId ?? sessions.first?.sessionId else { return }
        let entryId = "assistant:native-stream-proof"
        let blocks: [(Int, String, String, String?, String?)] = [
            (0, "thinking", "I’ll preserve block order while every character appears smoothly.", nil, nil),
            (1, "text", "I’m updating the implementation first.", nil, nil),
            (
                2,
                "tool-input",
                #"{"path":"Sources/Streaming.swift","content":"struct StreamState {\n    let isSmooth = true\n}"}"#,
                "proof-write",
                "write"
            ),
        ]
        activeTurns.insert(sessionId)
        defer { activeTurns.remove(sessionId) }
        for (index, kind, content, callId, tool) in blocks {
            var length = 3
            while length < content.count {
                receiveLiveTurnBlock(
                    sessionId: sessionId,
                    event: Self.streamingProofEvent(
                        entryId: entryId,
                        blockIndex: index,
                        blockKind: kind,
                        content: String(content.prefix(length)),
                        callId: callId,
                        tool: tool
                    )
                )
                try? await Task.sleep(for: .milliseconds(180))
                length += 3
            }
            receiveLiveTurnBlock(
                sessionId: sessionId,
                event: Self.streamingProofEvent(
                    entryId: entryId,
                    blockIndex: index,
                    blockKind: kind,
                    content: content,
                    callId: callId,
                    tool: tool
                )
            )
        }
    }

    private static func streamingProofEvent(
        entryId: String,
        blockIndex: Int,
        blockKind: String,
        content: String,
        callId: String?,
        tool: String?
    ) -> SessionEvent {
        var fields: [String: JSONValue] = [
            "type": .string("assistant.block.update"),
            "entryId": .string(entryId),
            "blockIndex": .number(Double(blockIndex)),
            "blockKind": .string(blockKind),
            "content": .string(content),
        ]
        if let callId { fields["callId"] = .string(callId) }
        if let tool { fields["tool"] = .string(tool) }
        let frame: JSONValue = .object([
            "v": .string("omp-app/1"),
            "type": .string("event"),
            "cursor": .object(["epoch": .string("native-stream-proof"), "seq": .number(1)]),
            "hostId": .string("native-stream-proof-host"),
            "sessionId": .string("native-stream-proof-session"),
            "event": .object(fields),
        ])
        let data = try! JSONEncoder().encode(frame)
        guard case .event(let decoded) = try! ServerFrame.decode(data) else {
            preconditionFailure("streaming proof event did not decode")
        }
        return decoded.event
    }
    #endif

    private func receiveLiveTurnToolLifecycle(sessionId: String, event: SessionEvent) -> Bool {
        guard var timeline = liveTurns[sessionId],
              timeline.applyToolLifecycle(event) else { return false }
        liveTurns[sessionId] = timeline
        scheduleLiveTurnFrames(sessionId: sessionId)
        return true
    }

    private func scheduleLiveTurnFrames(sessionId: String) {
        guard liveTurnTasks[sessionId] == nil else { return }
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            while !Task.isCancelled, var next = self.liveTurns[sessionId] {
                let hasMore = next.advance()
                self.liveTurns[sessionId] = next
                self.finishPendingLiveTurnEntries(sessionId: sessionId)
                if !hasMore { break }
                try? await Task.sleep(nanoseconds: 16_666_667)
            }
            if !Task.isCancelled { self.liveTurnTasks[sessionId] = nil }
        }
        liveTurnTasks[sessionId] = task
    }

    private func finishPendingLiveTurnEntries(sessionId: String) {
        finishPendingTranscriptEntries(sessionId: sessionId)
    }

    private func settleLiveTurnTool(sessionId: String, callId: String) {
        guard var timeline = liveTurns[sessionId], timeline.contains(callId: callId) else { return }
        timeline.removeTool(callId: callId)
        if timeline.isEmpty {
            liveTurnTasks.removeValue(forKey: sessionId)?.cancel()
            liveTurns.removeValue(forKey: sessionId)
        } else {
            liveTurns[sessionId] = timeline
        }
    }

    private func settleLiveTurnAssistant(sessionId: String, entryId: String? = nil) {
        guard var timeline = liveTurns[sessionId],
              timeline.hasAssistantBlocks() else { return }
        if let entryId, timeline.hasAssistantBlocks(entryId: entryId) {
            timeline.removeAssistantBlocks(entryId: entryId)
        } else {
            timeline.removeAssistantBlocks()
        }
        if timeline.isEmpty {
            liveTurnTasks.removeValue(forKey: sessionId)?.cancel()
            liveTurns.removeValue(forKey: sessionId)
        } else {
            liveTurns[sessionId] = timeline
        }
    }

    private func clearLiveTurn(sessionId: String) {
        liveTurnTasks.removeValue(forKey: sessionId)?.cancel()
        liveTurns.removeValue(forKey: sessionId)
    }

    private func appendDurableEntry(_ entry: TranscriptEntry, sessionId: String) {
        var entries = liveEntries[sessionId] ?? []
        guard !entries.contains(where: { $0.id == entry.id }) else { return }
        entries.append(entry)
        liveEntries[sessionId] = entries
    }

    private func finishPendingAssistantEntry(sessionId: String) {
        finishPendingTranscriptEntries(sessionId: sessionId)
    }

    private func receiveToolEvent(sessionId: String, event: SessionEvent) {
        var projection = liveTools[sessionId] ?? LiveToolProjection()
        projection.apply(event)
        if projection.calls.isEmpty { liveTools.removeValue(forKey: sessionId) }
        else { liveTools[sessionId] = projection }
        guard !projection.isCaughtUp, toolStreamingTasks[sessionId] == nil else { return }
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            while !Task.isCancelled, var next = self.liveTools[sessionId] {
                let hasMore = next.advance()
                self.liveTools[sessionId] = next
                if !hasMore {
                    self.finishPendingToolEntries(sessionId: sessionId)
                    break
                }
                try? await Task.sleep(nanoseconds: 16_666_667)
            }
            if !Task.isCancelled { self.toolStreamingTasks[sessionId] = nil }
        }
        toolStreamingTasks[sessionId] = task
    }

    private func finishPendingToolEntries(sessionId: String) {
        finishPendingTranscriptEntries(sessionId: sessionId)
    }

    private func enqueuePendingTranscriptEntry(_ entry: TranscriptEntry, sessionId: String) {
        var pending = pendingTranscriptEntries[sessionId] ?? PendingTranscriptQueue()
        pending.enqueue(entry)
        pendingTranscriptEntries[sessionId] = pending
    }

    private func shouldDeferTranscriptEntry(_ entry: TranscriptEntry, sessionId: String) -> Bool {
        if pendingTranscriptEntries[sessionId]?.isEmpty == false { return true }
        return !pendingTranscriptEntryIsReady(entry, sessionId: sessionId)
    }

    private func pendingTranscriptEntryIsReady(
        _ entry: TranscriptEntry,
        sessionId: String
    ) -> Bool {
        if entry.kind == .message, entry.role != "user" {
            if let timeline = liveTurns[sessionId] {
                if timeline.hasAssistantBlocks(entryId: entry.id) {
                    return timeline.assistantIsCaughtUp(entryId: entry.id)
                }
                if timeline.hasAssistantBlocks() {
                    return timeline.assistantIsCaughtUp()
                }
            }
            if let buffer = streamingMessages[sessionId] {
                return buffer.isCaughtUp
            }
        }
        if entry.kind == .toolUse, let callId = entry.toolCallId {
            if let timeline = liveTurns[sessionId], timeline.contains(callId: callId) {
                return timeline.toolIsCaughtUp(callId: callId)
            }
            if let projection = liveTools[sessionId],
               projection.calls.contains(where: { $0.id == callId }) {
                return projection.isCaughtUp
            }
        }
        return true
    }

    private func finishPendingTranscriptEntries(sessionId: String) {
        guard var pending = pendingTranscriptEntries[sessionId] else { return }
        let finished = pending.drainReadyPrefix {
            pendingTranscriptEntryIsReady($0, sessionId: sessionId)
        }
        if pending.isEmpty { pendingTranscriptEntries.removeValue(forKey: sessionId) }
        else { pendingTranscriptEntries[sessionId] = pending }
        for entry in finished {
            appendDurableEntry(entry, sessionId: sessionId)
            settleLiveProjection(for: entry, sessionId: sessionId)
        }
    }

    private func settleLiveProjection(for entry: TranscriptEntry, sessionId: String) {
        if entry.kind == .message, entry.role != "user" {
            streamingMessages.removeValue(forKey: sessionId)
            settleLiveTurnAssistant(sessionId: sessionId, entryId: entry.id)
        }
        if let callId = entry.toolCallId {
            settleLiveTurnTool(sessionId: sessionId, callId: callId)
            settleTool(sessionId: sessionId, callId: callId)
        }
    }

    private func settleTool(sessionId: String, callId: String) {
        guard var projection = liveTools[sessionId] else { return }
        projection.remove(callId: callId)
        if projection.calls.isEmpty {
            toolStreamingTasks.removeValue(forKey: sessionId)?.cancel()
            liveTools.removeValue(forKey: sessionId)
        }
        else { liveTools[sessionId] = projection }
    }

    /// One-time migration of the prior dev-grade UserDefaults credentials
    /// into the Keychain. Copies any legacy endpoint/deviceId/deviceToken
    /// values across (only when the Keychain doesn't already hold them),
    /// then deletes the UserDefaults entries and sets the migrated flag so
    /// it never runs again. Called from `init()` so `hasSavedConnection`
    /// reflects migrated state before the first view reads it.
    static func migrateCredentialsToKeychainIfNeeded(
        arguments: [String] = ProcessInfo.processInfo.arguments,
        defaults: UserDefaults = .standard
    ) {
        // A fresh-state test launch must leave legacy credentials intact for a
        // later normal launch to migrate. Keychain writes are deliberately
        // disabled in this mode, so deleting the source values would lose them.
        guard Keychain.usesPersistentStore(arguments: arguments) else { return }
        if defaults.bool(forKey: keychainMigratedKey) { return }
        for key in [savedEndpointKey, savedDeviceIdKey, savedDeviceTokenKey] {
            if Keychain.get(key) == nil,
               let value = defaults.string(forKey: key), !value.isEmpty {
                Keychain.set(value, forKey: key)
            }
            defaults.removeObject(forKey: key)
        }
        defaults.set(true, forKey: keychainMigratedKey)
    }

    /// Auto-reconnect on launch with the last successful connection, if any.
    func restore() async {
        let arguments = ProcessInfo.processInfo.arguments
        // Harness seam: a complete endpoint/device/token triple is an
        // in-memory connection profile. It never reads, writes, migrates, or
        // deletes the developer's Keychain credentials.
        if let ephemeral = EphemeralConnectionCredentials(arguments: arguments),
           let endpoint = URL(string: ephemeral.endpoint),
           !connected, !connecting {
            await connect(
                endpoint: endpoint,
                identity: ClientIdentity(
                    name: platformClientName,
                    version: "0.1",
                    build: "dev",
                    platform: platformClientPlatform
                ),
                authentication: DeviceAuthentication(
                    deviceId: ephemeral.deviceId,
                    deviceToken: ephemeral.deviceToken
                )
            )
            return
        }
        // UI-test seam: -T4NoRestore forces the offline sample inventory only
        // when no complete in-memory connection profile was supplied.
        if Self.shouldSkipRestore(arguments: arguments) { return }
        // UI-test seam: -T4ForgetCreds wipes saved connection credentials so
        // the boot lands on real onboarding (fresh-install path).
        if ProcessInfo.processInfo.arguments.contains("-T4ForgetCreds") {
            Keychain.remove(forKey: Self.savedEndpointKey)
            Keychain.remove(forKey: Self.savedDeviceIdKey)
            Keychain.remove(forKey: Self.savedDeviceTokenKey)
            return
        }
        // Dev seam: -T4Endpoint=wss://host:port/v1/ws overrides the saved
        // endpoint (the one-time UserDefaults migration otherwise shadows
        // `defaults write` tweaks between runs).
        if let seam = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("-T4Endpoint=") }) {
            Keychain.set(String(seam.dropFirst("-T4Endpoint=".count)), forKey: Self.savedEndpointKey)
        }
        guard !connected, !connecting,
              let endpointString = Keychain.get(Self.savedEndpointKey),
              let endpoint = URL(string: endpointString) else { return }
        let deviceId = Keychain.get(Self.savedDeviceIdKey) ?? ""
        let token = Keychain.get(Self.savedDeviceTokenKey) ?? ""
        let auth: DeviceAuthentication? = (!deviceId.isEmpty && !token.isEmpty)
            ? DeviceAuthentication(deviceId: deviceId, deviceToken: token) : nil
        await connect(
            endpoint: endpoint,
            identity: ClientIdentity(
                name: platformClientName,
                version: "0.1",
                build: "dev",
                platform: platformClientPlatform
            ),
            authentication: auth
        )
    }

    static func shouldSkipRestore(arguments: [String]) -> Bool {
        arguments.contains("-T4NoRestore")
            && EphemeralConnectionCredentials(arguments: arguments) == nil
    }

    private func persist(endpoint: URL, authentication: DeviceAuthentication?) {
        // nil/empty values clear the item, matching the prior UserDefaults
        // semantics (an open host persists only the endpoint, no creds).
        Keychain.set(endpoint.absoluteString, forKey: Self.savedEndpointKey)
        Keychain.set(authentication?.deviceId, forKey: Self.savedDeviceIdKey)
        Keychain.set(authentication?.deviceToken, forKey: Self.savedDeviceTokenKey)
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
                    args: ["ownerId": .string(platformClientName)],
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

    /// Copy an observer/unverified session into a fresh session this app owns.
    /// The source is read-only and never mutated by `session.fork`.
    @discardableResult
    func forkSession(sessionId: String, cwd: String? = nil) async -> SessionRef? {
        guard let client, connected, !hostId.isEmpty, canForkSessions,
              let source = sessions.first(where: { $0.sessionId == sessionId })
        else { return nil }
        switch source.sessionControl {
        case .observer, .unverified:
            break
        default:
            lastError = "This session does not need a read-only copy."
            return nil
        }
        var args: [String: JSONValue] = [:]
        if let cwd, !cwd.isEmpty { args["cwd"] = .string(cwd) }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "session.fork", args: args,
                sessionId: sessionId))
            let created = try result.sessionCreateResult()
            await refresh()
            let fresh = sessions.first(where: { $0.sessionId == created.sessionId }) ?? created
            select(fresh)
            return fresh
        } catch {
            t4log.error("forkSession failed: \(error)")
            lastError = "\(error)"
            return nil
        }
    }

    /// Stop the app-owned writer and publish the terminal resume command.
    /// The host issues a confirmation challenge before completing this call.
    @discardableResult
    func releaseSession(sessionId: String) async -> String? {
        guard let client, connected, !hostId.isEmpty,
              sessions.first(where: { $0.sessionId == sessionId })?.sessionControl == nil,
              !activeTurns.contains(sessionId)
        else { return nil }
        var resumeCommand: String?
        await withLease(sessionId: sessionId, kind: .controller) { leaseId in
            guard let revision = revision(of: sessionId) else {
                lastError = "session revision unknown"
                return
            }
            do {
                let result = try await client.sendCommand(CommandIntent(
                    hostId: hostId, command: "session.release",
                    args: ["leaseId": .string(leaseId)],
                    sessionId: sessionId, expectedRevision: revision))
                resumeCommand = try result.sessionReleaseResult()
            } catch {
                t4log.error("releaseSession failed: \(error)")
                lastError = "\(error)"
            }
        }
        if resumeCommand != nil { await refresh() }
        return resumeCommand
    }

    /// Bring a released session back under appserver ownership.
    func reclaimSession(sessionId: String) async {
        guard let client, connected, !hostId.isEmpty,
              case .released = sessions.first(where: { $0.sessionId == sessionId })?.sessionControl,
              var revision = revision(of: sessionId)
        else { return }
        for attempt in 0...1 {
            do {
                let result = try await client.sendCommand(CommandIntent(
                    hostId: hostId, command: "session.reclaim",
                    sessionId: sessionId, expectedRevision: revision))
                try result.sessionReclaimResult()
                await refresh()
                return
            } catch {
                if attempt == 0, let fresh = try? await refreshRevision(of: sessionId) {
                    revision = fresh
                    continue
                }
                t4log.error("reclaimSession failed: \(error)")
                lastError = "\(error)"
            }
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

    /// Demo mode: fake inventory/transcripts render ONLY with -T4Demo in the
    /// launch arguments (UI tests + screenshots). Never a user-facing default.
    static let demoMode = ProcessInfo.processInfo.arguments.contains("-T4Demo")

    init() {
        Self.migrateCredentialsToKeychainIfNeeded()
        connectionModel.sessions = Self.demoMode ? Self.sample : []
        connectionModel.objectWillChange
            .merge(with: promptModel.objectWillChange)
            .merge(with: agentModel.objectWillChange)
            .merge(with: previewModel.objectWillChange)
            .merge(with: filesReviewModel.objectWillChange)
            .merge(with: catalogSettingsModel.objectWillChange)
            .sink { [weak self] in self?.objectWillChange.send() }
            .store(in: &domainModelSubscriptions)
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
        return Self.demoMode ? Self.sampleAgents : []
    }

    /// Transcript entries for a session: the live host log when attached,
    /// sample rows otherwise (rail preview without a host).
    func transcript(for sessionId: String) -> [TranscriptEntry] {
        if connected { return liveEntries[sessionId] ?? [] }
        return Self.demoMode ? sampleTranscript(for: sessionId) : []
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

    /// Features negotiated in every hello: the HostWire defaults plus the
    /// command-gating feature names for the panes (preview, search, watch).
    private static let clientFeatures = [
        "resume", "prompt.lease", "controller.lease", "prompt.images", "transcript.page",
        "session.delta", "files.list", "terminal.io",
        "preview.control", "files.search", "files.diff", "transcript.search",
        "session.watch", "host.watch", "project.reveal",
        "session.observer", "session.unverified", "session.fork",
    ]

    /// Transport for an endpoint. `wss://` gets a pinning session (TOFU leaf
    /// fingerprint in the Keychain); everything else uses the shared session.
    private func makeTransport(endpoint: URL) -> URLSessionHostWireTransport {
        guard endpoint.scheme == "wss",
              let host = endpoint.host
        else { return URLSessionHostWireTransport(endpoint: endpoint) }
        let port = endpoint.port ?? 443
        let session = URLSession(
            configuration: .ephemeral,
            delegate: T4CertPinner(host: host, port: port),
            delegateQueue: nil
        )
        return URLSessionHostWireTransport(endpoint: endpoint, session: session)
    }

    /// A later healthy connection supersedes any earlier endpoint failure.
    /// Keep this transition explicit so a transient restore/pair attempt cannot
    /// leave a stale transport error pinned above a live session inventory.
    func clearErrorAfterSuccessfulConnection() {
        lastError = nil
    }

    /// Connect to a t4-host over host-wire, handshake, and load the inventory.
    func connect(endpoint: URL, identity: ClientIdentity, authentication: DeviceAuthentication? = nil) async {
        connecting = true
        defer { connecting = false }
        let transport = makeTransport(endpoint: endpoint)
        let c = HostClient(transport: transport, config: HostClient.Config(identity: identity, authentication: authentication, requestedFeatures: Self.clientFeatures))
        client = c
        do {
            let welcome = try await c.connect()
            hostId = welcome.hostId
            hostInfo = HostInfo(hostId: welcome.hostId, ompVersion: welcome.ompVersion, appserverVersion: welcome.appserverVersion)
            grantedCapabilities = welcome.grantedCapabilities
            grantedFeatures = Set(welcome.grantedFeatures)
            connected = welcome.authentication == .paired || welcome.authentication == .local
            if connected {
                pairedEndpoint = endpoint.absoluteString
                persist(endpoint: endpoint, authentication: authentication)
                clearErrorAfterSuccessfulConnection()
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
        // A restored macOS WindowGroup can render more than one RootView.
        // Each view runs the launch-argument pairing task, but a pairing
        // ticket is single-use. Serialize those tasks through the shared
        // store so only the first view can claim the ticket.
        guard !connecting, !connected else { return }
        connecting = true
        defer { connecting = false }
        let transport = makeTransport(endpoint: endpoint)
        let identity = ClientIdentity(
            name: platformClientName,
            version: "0.1",
            build: "dev",
            platform: platformClientPlatform
        )
        let c = HostClient(transport: transport, config: HostClient.Config(identity: identity, authentication: nil, requestedFeatures: Self.clientFeatures))
        client = c
        do {
            let welcome = try await c.connect()
            hostId = welcome.hostId
            hostInfo = HostInfo(hostId: welcome.hostId, ompVersion: welcome.ompVersion, appserverVersion: welcome.appserverVersion)
            if welcome.authentication == .paired || welcome.authentication == .local {
                // Open host — no pairing round-trip needed.
                grantedCapabilities = welcome.grantedCapabilities
                grantedFeatures = Set(welcome.grantedFeatures)
                connected = true
                pairedEndpoint = endpoint.absoluteString
                persist(endpoint: endpoint, authentication: nil)
                clearErrorAfterSuccessfulConnection()
                await refresh()
                await loadCatalog()
                Task { await observe() }
                return
            }
            let slug = Self.slugify(deviceName)
            let intent = PairStartIntent(
                code: code,
                // Device IDs are registry primary keys. Include an install
                // nonce so a fresh install can pair even when the host still
                // retains an older token for a device with the same name.
                deviceId: "\(platformDeviceIdPrefix)-\(slug)-\(UUID().uuidString.lowercased())",
                deviceName: deviceName,
                platform: platformClientPlatform,
                requestedCapabilities: ["sessions.read", "sessions.prompt", "sessions.control", "sessions.manage", "catalog.read", "files.list", "files.read", "files.diff", "term.open", "term.input", "term.resize", "preview.control", "preview.read", "usage.read", "agents.control", "audit.read", "config.read", "config.write"]
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
            markLive()
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






    /// Live frames keep the inventory, transcripts, and confirmations current.
    private func observe() async {
        guard let client else { return }
        for await frame in await client.frames {
            switch frame {
            case .sessions(let inventory):
                sessions = inventory.sessions
                markLive()
                reconcileSelection()
            case .snapshot(let snapshot):
                clearStreamingMessage(sessionId: snapshot.sessionId)
                clearLiveTurn(sessionId: snapshot.sessionId)
                pendingTranscriptEntries.removeValue(forKey: snapshot.sessionId)
                toolStreamingTasks.removeValue(forKey: snapshot.sessionId)?.cancel()
                liveTools.removeValue(forKey: snapshot.sessionId)
                liveEntries[snapshot.sessionId] = snapshot.entries.map { TranscriptEntry(from: $0) }
                // The snapshot is the live tail at the current cursor; older
                // history paging restarts from unknown (hasMore = nil).
                pagingState[snapshot.sessionId] = TranscriptPaging(nextCursor: nil, hasMore: nil, loading: false)
            case .entry(let entryFrame):
                let entry = TranscriptEntry(from: entryFrame.entry)
                let sid = entryFrame.sessionId
                // A settled row can arrive in the same provider burst as its
                // final delta. Keep it pending until the live projection has
                // revealed that final snapshot. Once any row is pending, all
                // later rows join the same queue so a fast tool cannot settle
                // ahead of earlier paced assistant content.
                if shouldDeferTranscriptEntry(entry, sessionId: sid) {
                    enqueuePendingTranscriptEntry(entry, sessionId: sid)
                    finishPendingTranscriptEntries(sessionId: sid)
                } else {
                    appendDurableEntry(entry, sessionId: sid)
                    settleLiveProjection(for: entry, sessionId: sid)
                }
            case .confirmation(let challenge):
                pendingConfirmation = challenge
                // UI-test seam: -T4AutoApprove auto-approves challenges (e.g.
                // term.open) so headless runs can reach the surfaces behind them.
                if ProcessInfo.processInfo.arguments.contains("-T4AutoApprove") {
                    Task { await confirm(.approve) }
                }
            case .event(let frame):
                if frame.event.isAskResolved {
                    pendingAsk = nil
                } else if let ask = frame.event.askRequest {
                    pendingAsk = PendingAsk(sessionId: frame.sessionId, request: ask)
                }
                let sid = frame.sessionId
                switch frame.event.type {
                case "turn.start":
                    activeTurns.insert(sid)
                case "turn.end", "turn.error":
                    activeTurns.remove(sid)
                    if liveTurns[sid] == nil {
                        finishPendingToolEntries(sessionId: sid)
                        toolStreamingTasks.removeValue(forKey: sid)?.cancel()
                        liveTools.removeValue(forKey: sid)
                    } else {
                        // Settlement can race the final provider burst. Keep
                        // the ordered projection alive until its paced frames
                        // finish, then swap in the durable rows.
                        scheduleLiveTurnFrames(sessionId: sid)
                    }
                    Task { await refreshTodos(sessionId: sid) }
                case "assistant.block.update":
                    receiveLiveTurnBlock(sessionId: sid, event: frame.event)
                case "message.update":
                    if case .string(let role) = frame.event.fields["role"], role == "assistant",
                       case .string(let text) = frame.event.fields["text"] {
                        let reasoning: String
                        if case .string(let value) = frame.event.fields["reasoning"] { reasoning = value }
                        else { reasoning = "" }
                        receiveStreamingMessage(sessionId: sid, text: text, reasoning: reasoning)
                    }
                case "message.settled":
                    // The durable entry is the replacement signal. Clearing
                    // here would skip the remaining paced frames.
                    break
                case "message.discarded":
                    clearStreamingMessage(sessionId: sid)
                    clearLiveTurn(sessionId: sid)
                case "tool.input.update", "tool.start", "tool.progress", "tool.result":
                    if !receiveLiveTurnToolLifecycle(sessionId: sid, event: frame.event) {
                        receiveToolEvent(sessionId: sid, event: frame.event)
                    }
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
            // Preview frames: track the latest previewId per session from
            // launch/state/navigation/capture, and on a capture frame record
            // the capture (transcript image row + capture row) and kick off
            // the chunked byte fetch so the image resolves asynchronously.
            case .previewLaunch(let f):
                previewIdBySession[f.sessionId] = f.previewId
            case .previewState(let f):
                previewIdBySession[f.sessionId] = f.previewId
            case .previewNavigation(let f):
                previewIdBySession[f.sessionId] = f.previewId
            case .previewCapture(let f):
                previewIdBySession[f.sessionId] = f.previewId
                recordCapture(sessionId: f.sessionId, metadata: f.capture, previewId: f.previewId)
                Task { await fetchCaptureBytes(sessionId: f.sessionId, previewId: f.previewId, metadata: f.capture) }
            case .previewError(let f):
                t4log.notice("preview error \(f.code, privacy: .public): \(f.message)")
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
        grantedCapabilities = []
        grantedFeatures = []
        pairedEndpoint = nil
        hostInfo = nil
        for task in streamingTasks.values { task.cancel() }
        streamingTasks.removeAll()
        for task in liveTurnTasks.values { task.cancel() }
        liveTurnTasks.removeAll()
        for task in toolStreamingTasks.values { task.cancel() }
        toolStreamingTasks.removeAll()
        streamingMessages.removeAll()
        liveTurns.removeAll()
        liveTools.removeAll()
        pendingTranscriptEntries.removeAll()
        // Drop any open terminals — the transport is gone, no close frame.
        terminalOutput.removeAll()
        terminalExits.removeAll()
        openTerminalIds.removeAll()
        activeTerminalId.removeAll()
        terminalErrors.removeAll()
        Keychain.remove(forKey: Self.savedEndpointKey)
        Keychain.remove(forKey: Self.savedDeviceIdKey)
        Keychain.remove(forKey: Self.savedDeviceTokenKey)
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
    /// one completed) so the sheet renders without a live host.
    private static let sampleAgents: [AgentState] = [
        AgentState(agentId: "agent-scout", state: "running", progress: 0.62, detail: "Mapping the reconnect backoff"),
        AgentState(agentId: "agent-worker", state: "completed", progress: 1.0, detail: "Ported the lease acquire loop"),
    ]

    /// Sample code reviews — offline preview for the review pane (one
    /// pending review with a warning finding) so the sheet renders without
    /// a live host. Built by decoding a minimal `review` frame.
    static let sampleReviews: [ReviewFrame] = {
        let json = """
        {"v":"omp-app/1","type":"review","hostId":"studio-mac","sessionId":"s1","reviewId":"review-sample","status":"pending","path":"src/fixture.ts","findings":[{"severity":"warning","message":"Fixture review finding for the mobile application flow.","line":12}]}
        """
        return (try? JSONDecoder().decode(ReviewFrame.self, from: Data(json.utf8)))
            .map { [$0] } ?? []
    }()
}
