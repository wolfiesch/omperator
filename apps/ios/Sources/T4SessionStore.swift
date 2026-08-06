//  T4SessionStore.swift
//  Authoritative session inventory for the native T4 Code iOS client. Replaces
//  Enclave's collab-guest "rooms you've joined" model: this holds the real
//  host-wire SessionRef inventory, grouped by project, and drives the rail from
//  a HostClient connection. Seeded with sample data so the rail renders in the
//  simulator without a live host; connect(endpoint:) swaps in a real t4-host.

import Foundation
import HostWire
#if canImport(SwiftUI)
import SwiftUI
#endif
#if canImport(Combine)
import Combine
#else
import OpenCombine
#endif
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif
#if canImport(os)
import os
#endif

#if canImport(os)
let t4log = Logger(subsystem: "sh.t4code.ios", category: "store")
#else
/// OSLog-compatible message on Linux: the store's callsites use
/// `\(value, privacy: .public)` interpolation, which only typechecks
/// against an interpolation type that accepts a privacy label.
enum T4Privacy { case `public`, `private`, auto }

/// Frame pacing for the streaming reveal loops. On Linux each reveal tick can
/// change text height, which ripples a full SwiftCrossUI layout recompute up
/// the tree (bottomUpUpdate → root), so 60fps pacing costs ~60 full-tree
/// layout passes per second on a live session and pegs the main thread. Linux
/// paces at 4fps (250ms) — still fluid to the eye — which keeps those passes
/// at ~4Hz. macOS keeps the original 60fps pacing.
enum T4StorePacing {
    #if os(Linux)
    static let sleepNs: UInt64 = 250_000_000
    #else
    static let sleepNs: UInt64 = 16_666_667
    #endif
}

struct T4LogMessage: ExpressibleByStringInterpolation {
    struct StringInterpolation: StringInterpolationProtocol {
        var text = ""
        init(literalCapacity: Int, interpolationCount: Int) {}
        mutating func appendLiteral(_ literal: String) { text += literal }
        mutating func appendInterpolation<T>(_ value: T) { text += String(describing: value) }
        mutating func appendInterpolation<T>(_ value: T, privacy: T4Privacy) { text += String(describing: value) }
    }
    let text: String
    init(stringInterpolation: StringInterpolation) { text = stringInterpolation.text }
    init(stringLiteral value: String) { text = value }
}

enum T4LogShim {
    static func error(_ message: T4LogMessage) {
        FileHandle.standardError.write(Data("[t4store] \(message.text)\n".utf8))
    }
    static func notice(_ message: T4LogMessage) {
        FileHandle.standardError.write(Data("[t4store] \(message.text)\n".utf8))
    }
}
let t4log = T4LogShim.self
#endif

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

enum T4SessionListView: String, CaseIterable, Identifiable {
    case current
    case archived

    var id: String { rawValue }
    var label: String { self == .current ? "Current" : "Archived" }
}

enum T4RailOrganization: String, CaseIterable, Identifiable {
    case byProject
    case flat

    var id: String { rawValue }
    var label: String { self == .byProject ? "By project" : "In one list" }
}

enum T4RailSort: String, CaseIterable, Identifiable {
    case priority
    case updated
    case manual

    var id: String { rawValue }
    var label: String {
        switch self {
        case .priority: "Priority"
        case .updated: "Last updated"
        case .manual: "Manual order"
        }
    }
}

enum T4RailFilter: String, CaseIterable, Identifiable {
    case all
    case attention
    case running
    case errors

    var id: String { rawValue }
    var label: String {
        switch self {
        case .all: "All"
        case .attention: "Attention"
        case .running: "Running"
        case .errors: "Errors"
        }
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
        let projectId: String
        let project: String
        let sessions: [SessionRef]
        var id: String { projectId }
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
    /// Search and quick-filter state is deliberately ephemeral so relaunching
    /// can never make sessions appear to be missing.
    @Published var railFilter: T4RailFilter = .all
    @Published private(set) var sessionListView: T4SessionListView
    @Published private(set) var railOrganization: T4RailOrganization
    @Published private(set) var railSort: T4RailSort
    @Published private(set) var pinnedSessionIds: Set<String>
    @Published private(set) var projectManualOrder: [String]
    @Published private(set) var sessionManualOrderByScope: [String: [String]]
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
        if let phases = todoPhasesBySession[sessionId] { return phases }
        if Self.demoMode, sessionId == "s1" { return Self.samplePlanPhases }
        return []
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
        catalogSettingsModel.sortedSupportedModels
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
    private static let railListViewKey = "t4.rail.listView"
    private static let railOrganizationKey = "t4.rail.organization"
    private static let railSortKey = "t4.rail.sort"
    private static let railPinnedSessionIdsKey = "t4.rail.pinnedSessionIds"
    private static let railProjectManualOrderKey = "t4.rail.projectManualOrder"
    private static let railSessionManualOrderKey = "t4.rail.sessionManualOrder"
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
                let hasMore = next.advance(maxCatchUpFrames: 2)
                self.streamingMessages[sessionId] = next
                if !hasMore {
                    self.finishPendingAssistantEntry(sessionId: sessionId)
                    break
                }
                try? await Task.sleep(nanoseconds: T4StorePacing.sleepNs)
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

        // Seed every row before pacing updates. The UI test attaches after app
        // launch, so streaming blocks sequentially can finish the thinking row
        // before the tool row exists and make simultaneous observation depend
        // on simulator startup timing.
        var lengths = Array(repeating: 3, count: blocks.count)
        for (offset, block) in blocks.enumerated() {
            receiveLiveTurnBlock(
                sessionId: sessionId,
                event: Self.streamingProofEvent(
                    entryId: entryId,
                    blockIndex: block.0,
                    blockKind: block.1,
                    content: String(block.2.prefix(lengths[offset])),
                    callId: block.3,
                    tool: block.4
                )
            )
        }
        try? await Task.sleep(for: .milliseconds(500))

        while lengths.indices.contains(where: { lengths[$0] < blocks[$0].2.count }) {
            for offset in blocks.indices where lengths[offset] < blocks[offset].2.count {
                let block = blocks[offset]
                lengths[offset] = min(block.2.count, lengths[offset] + 3)
                receiveLiveTurnBlock(
                    sessionId: sessionId,
                    event: Self.streamingProofEvent(
                        entryId: entryId,
                        blockIndex: block.0,
                        blockKind: block.1,
                        content: String(block.2.prefix(lengths[offset])),
                        callId: block.3,
                        tool: block.4
                    )
                )
            }
            try? await Task.sleep(for: .milliseconds(250))
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
                let hasMore = next.advance(maxCatchUpFrames: 2)
                self.liveTurns[sessionId] = next
                self.finishPendingLiveTurnEntries(sessionId: sessionId)
                if !hasMore { break }
                try? await Task.sleep(nanoseconds: T4StorePacing.sleepNs)
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
                try? await Task.sleep(nanoseconds: T4StorePacing.sleepNs)
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
        // Linux QA seam: -T4OpenEndpoint=<ws://…> connects to an open host
        // without device credentials (welcome.authentication == .local) — the
        // raw-endpoint connect-sheet path for open hosts. The Tailnet
        // gateway's local transport rejects device authentication, so this is
        // how the Linux client reaches a gateway-backed host from the CLI.
        #if os(Linux)
        if let openSeam = arguments.first(where: { $0.hasPrefix("-T4OpenEndpoint=") }),
           let endpoint = URL(string: String(openSeam.dropFirst("-T4OpenEndpoint=".count))),
           !connected, !connecting {
            await connect(
                endpoint: endpoint,
                identity: ClientIdentity(
                    name: platformClientName,
                    version: "0.1",
                    build: "dev",
                    platform: platformClientPlatform
                ),
                authentication: nil
            )
            return
        }
        #endif

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
        #if os(Linux)
        T4Perf.mark("restore-keychain-read")
        #endif
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

    /// Demo stream driver (-T4DemoStream): replays a live turn into the hero
    /// session — user bubble, typewriter assistant reply, a tool call, and
    /// the settled summary — so captures and videos can show streaming with
    /// the bottom anchor engaged. Offline demo mode only.
    func startDemoStreamIfNeeded() {
        guard Self.demoMode,
              ProcessInfo.processInfo.arguments.contains("-T4DemoStream") else { return }
        let sessionId = "s1"
        Task { @MainActor [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            let userEntry = try! TranscriptEntry.decode(Data(#"{"id":"ds-user","parentId":null,"hostId":"studio-mac","sessionId":"s1","kind":"message","timestamp":"2026-08-05T11:50:00Z","data":{"role":"user","text":"nice. can you also make long prose paragraphs stop clipping off the left edge?"}}"#.utf8))
            liveEntries[sessionId, default: []].append(userEntry)
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            let reply = "Good catch — that's the ellipsized-label bug. Every `Text` was created with `ellipsize = .end`, and Pango lays ellipsized text out wider than the allocation, which GTK then draws centered — so long paragraphs lost a slice off the left.\n\nThe fix is three small pieces: default to no ellipsize, ellipsize only line-limited labels, and left-align the text block (`xalign = 0`) so an oversized layout can never clip the leading edge. The layout-height override in `CustomLabel` also only runs for ellipsized labels now — applied to plain wrapping text it left Pango holding a stale, wider line layout.\n\nVerified on the long opencode session: every paragraph starts flush at the detail edge in both themes."
            receiveStreamingMessage(sessionId: sessionId, text: reply, reasoning: "")
            // Wait for the pacing task to finish the typewriter effect.
            while streamingMessages[sessionId] != nil {
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
            let settledText = reply.replacingOccurrences(of: "\n", with: "\\n")
            let toolEntry = try! TranscriptEntry.decode(Data(#"{"id":"ds-tool","parentId":"ds-user","hostId":"studio-mac","sessionId":"s1","kind":"tool-use","timestamp":"2026-08-05T11:50:30Z","data":{"tool":"bash","title":"swift test","result":{"output":"✔ Suite \"Anchor behavior\" passed after 0.802 seconds.\n✔ Test run with 13 tests in 5 suites passed after 16.121 seconds."},"ok":true}}"#.utf8))
            let settled = try! TranscriptEntry.decode(Data(("{\"id\":\"ds-done\",\"parentId\":\"ds-tool\",\"hostId\":\"studio-mac\",\"sessionId\":\"s1\",\"kind\":\"message\",\"timestamp\":\"2026-08-05T11:50:36Z\",\"data\":{\"text\":\"" + settledText + "\"}}").utf8))
            liveEntries[sessionId, default: []].append(toolEntry)
            liveEntries[sessionId, default: []].append(settled)
        }
    }

    func selectDefaultVisibleSessionIfNeeded() {
        guard selectedSession == nil else { return }
        // Capture seam: -T4Select=<sessionId> pins the demo selection.
        if let raw = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("-T4Select=") }),
           let target = sessions.first(where: { $0.sessionId == String(raw.dropFirst("-T4Select=".count)) }) {
            select(target)
            return
        }
        reconcileSelectionForVisibleList()
    }

    /// Session attach is idempotent per connection: the host replays the full
    /// transcript snapshot on every session.attach, so repeated attaches
    /// (select + detail task + attachSelectedIfNeeded all racing) each pay a
    /// full snapshot — on large transcripts that's seconds of main-thread
    /// parse/render per click. Track attached sessions and skip repeats.
    private var attachedSessions = Set<String>()

    /// Attach to a session's transcript stream. The host replies with a
    /// snapshot frame (full log at a cursor) and then live entry frames;
    /// `observe()` routes both into `liveEntries`. Safe to repeat.
    func attach(sessionId: String) async {
        guard let client, connected, !hostId.isEmpty else { return }
        guard !attachedSessions.contains(sessionId) else { return }
        attachedSessions.insert(sessionId)
        do {
            _ = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "session.attach", sessionId: sessionId))
        } catch {
            attachedSessions.remove(sessionId)
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

    /// Archive is reversible: the host retains the transcript and artifacts,
    /// while Current stops rendering the session. Refresh after success so the
    /// rail changes views immediately even before the next pushed inventory.
    func archiveSession(sessionId: String) async {
        guard sessions.first(where: { $0.sessionId == sessionId })?.t4IsWritable == true else {
            return
        }
        if await runLeaseFreeLifecycleCommand(sessionId: sessionId, command: "session.archive") {
            await refresh()
        }
    }

    /// Restore an archived session to Current.
    func restoreSession(sessionId: String) async {
        guard sessions.first(where: { $0.sessionId == sessionId })?.t4CanRestore == true else {
            return
        }
        if await runLeaseFreeLifecycleCommand(sessionId: sessionId, command: "session.restore") {
            await refresh()
        }
    }

    /// Archive, restore, and archived-session delete are lifecycle mutations
    /// rather than in-session writes. They intentionally bypass controller
    /// leases, matching the canonical web client and allowing actions while an
    /// archived session cannot acquire a lease.
    private func runLeaseFreeLifecycleCommand(sessionId: String, command: String) async -> Bool {
        guard let client, connected, !hostId.isEmpty,
              let revision = revision(of: sessionId) else { return false }
        do {
            _ = try await client.sendCommand(CommandIntent(
                hostId: hostId,
                command: command,
                sessionId: sessionId,
                expectedRevision: revision
            ))
            return true
        } catch {
            lastError = "\(error)"
            return false
        }
    }

    /// Delete a session (session.delete). Current sessions keep the existing
    /// controller-lease path. Archived sessions cannot acquire a lease, so
    /// they dispatch the challenged lifecycle command directly.
    func deleteSession(sessionId: String) async {
        guard let session = sessions.first(where: { $0.sessionId == sessionId }) else { return }
        if session.archivedAt != nil {
            if await runLeaseFreeLifecycleCommand(sessionId: sessionId, command: "session.delete") {
                await refresh()
            }
        } else {
            _ = await control(sessionId: sessionId, command: "session.delete", args: [:])
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

    /// Demo mode: fake inventory/transcripts render ONLY with -T4Demo in the
    /// launch arguments (UI tests + screenshots). Never a user-facing default.
    static let demoMode = ProcessInfo.processInfo.arguments.contains("-T4Demo")

    init() {
        let defaults = UserDefaults.standard
        if ProcessInfo.processInfo.arguments.contains("-T4ResetRailPreferences") {
            for key in [
                Self.railListViewKey,
                Self.railOrganizationKey,
                Self.railSortKey,
                Self.railPinnedSessionIdsKey,
                Self.railProjectManualOrderKey,
                Self.railSessionManualOrderKey,
            ] {
                defaults.removeObject(forKey: key)
            }
        }
        self.sessionListView = T4SessionListView(
            rawValue: defaults.string(forKey: Self.railListViewKey) ?? ""
        ) ?? .current
        self.railOrganization = T4RailOrganization(
            rawValue: defaults.string(forKey: Self.railOrganizationKey) ?? ""
        ) ?? .byProject
        self.railSort = T4RailSort(
            rawValue: defaults.string(forKey: Self.railSortKey) ?? ""
        ) ?? .priority
        self.pinnedSessionIds = Set(
            defaults.stringArray(forKey: Self.railPinnedSessionIdsKey) ?? []
        )
        self.projectManualOrder =
            defaults.stringArray(forKey: Self.railProjectManualOrderKey) ?? []
        if let data = defaults.data(forKey: Self.railSessionManualOrderKey),
           let decoded = try? JSONDecoder().decode([String: [String]].self, from: data) {
            self.sessionManualOrderByScope = decoded
        } else {
            self.sessionManualOrderByScope = [:]
        }
        Self.migrateCredentialsToKeychainIfNeeded()
        connectionModel.sessions = Self.demoMode ? Self.sample : []
        if Self.demoMode {
            // Offline captures: the usage and settings panes only have live
            // data paths otherwise and render their empty states in shots.
            catalogSettingsModel.usageSnapshot = Self.sampleUsageSnapshot
            catalogSettingsModel.settingsSnapshot = Self.sampleSettings
            catalogSettingsModel.catalog = Self.sampleCatalog
        }
        connectionModel.objectWillChange
            .merge(with: transcriptModel.objectWillChange)
            .merge(with: promptModel.objectWillChange)
            .merge(with: agentModel.objectWillChange)
            .merge(with: terminalModel.objectWillChange)
            .merge(with: previewModel.objectWillChange)
            .merge(with: filesReviewModel.objectWillChange)
            .merge(with: catalogSettingsModel.objectWillChange)
            .sink { [weak self] in self?.objectWillChange.send() }
            .store(in: &domainModelSubscriptions)
    }

    var currentSessionCount: Int {
        sessions.lazy.filter { $0.archivedAt == nil }.count
    }

    var archivedSessionCount: Int {
        sessions.lazy.filter { $0.archivedAt != nil }.count
    }

    var pinnedSessions: [SessionRef] {
        sortSessions(filteredSessions.filter { pinnedSessionIds.contains($0.sessionId) }, scope: "__pinned__")
    }

    func setSessionListView(_ view: T4SessionListView) {
        guard sessionListView != view else { return }
        sessionListView = view
        UserDefaults.standard.set(view.rawValue, forKey: Self.railListViewKey)
        reconcileSelectionForVisibleList()
    }

    func setRailOrganization(_ organization: T4RailOrganization) {
        guard railOrganization != organization else { return }
        railOrganization = organization
        UserDefaults.standard.set(organization.rawValue, forKey: Self.railOrganizationKey)
    }

    func setRailSort(_ sort: T4RailSort) {
        guard railSort != sort else { return }
        railSort = sort
        UserDefaults.standard.set(sort.rawValue, forKey: Self.railSortKey)
    }

    func setRailFilter(_ filter: T4RailFilter) {
        railFilter = filter
    }

    func setSessionPinned(_ sessionId: String, pinned: Bool) {
        if pinned {
            pinnedSessionIds.insert(sessionId)
        } else {
            pinnedSessionIds.remove(sessionId)
        }
        UserDefaults.standard.set(
            pinnedSessionIds.sorted(),
            forKey: Self.railPinnedSessionIdsKey
        )
    }

    func moveSession(_ session: SessionRef, direction: Int) {
        guard railSort == .manual, direction == -1 || direction == 1 else { return }
        let scope = manualScope(for: session)
        let visibleIds: [String]
        if railOrganization == .flat {
            visibleIds = filteredSessions.map(\.sessionId)
        } else {
            visibleIds = filteredSessions
                .filter { $0.project.projectId == session.project.projectId }
                .map(\.sessionId)
        }
        var order = normalizedManualOrder(
            stored: sessionManualOrderByScope[scope] ?? [],
            visibleIds: visibleIds
        )
        guard let index = order.firstIndex(of: session.sessionId) else { return }
        let target = index + direction
        guard target >= 0, target < visibleIds.count else { return }
        order.swapAt(index, target)
        sessionManualOrderByScope[scope] = order
        persistSessionManualOrder()
    }

    func moveProject(_ projectId: String, direction: Int) {
        guard railSort == .manual, railOrganization == .byProject,
              direction == -1 || direction == 1 else { return }
        let visibleIds = groups.map(\.projectId)
        var order = normalizedManualOrder(stored: projectManualOrder, visibleIds: visibleIds)
        guard let index = order.firstIndex(of: projectId) else { return }
        let target = index + direction
        guard target >= 0, target < visibleIds.count else { return }
        order.swapAt(index, target)
        projectManualOrder = order
        UserDefaults.standard.set(order, forKey: Self.railProjectManualOrderKey)
    }

    private var filteredSessions: [SessionRef] {
        let queryText = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return sessions.filter { session in
            let archived = session.archivedAt != nil
            guard archived == (sessionListView == .archived) else { return false }
            guard matchesFilter(session) else { return false }
            guard !queryText.isEmpty else { return true }
            return [
                session.title,
                session.project.name ?? session.project.projectId,
                session.status,
                session.model ?? "",
                session.hostId,
            ].contains { $0.localizedCaseInsensitiveContains(queryText) }
        }
    }

    /// Fingerprint of everything `groups` derives from, memoized so the
    /// rail's per-render recomputation (filter + O(n log n) sort, with
    /// per-comparison @Published reads) runs only when an input actually
    /// changes. Without this, every layout pass re-derives the rail and
    /// re-emits, which on a live session pins the main thread (the app
    /// freezes on connected session views).
    @MainActor private struct RailFingerprint: Hashable {
        var sessions: [String]
        var query: String
        var railFilter: T4RailFilter
        var sessionListView: T4SessionListView
        var railOrganization: T4RailOrganization
        var railSort: T4RailSort
        var projectManualOrder: [String]
        var sessionManualOrderByScope: [String: [String]]

        init(store: T4SessionStore) {
            sessions = store.sessions.map {
                "\($0.sessionId)|\($0.status)|\($0.updatedAt)|\($0.model ?? "")|\($0.archivedAt ?? "")|\($0.pendingApproval == true ? 1 : 0)\($0.pendingUserInput == true ? 1 : 0)\($0.proposedPlan == nil ? 0 : 1)|\($0.mode ?? "")"
            }
            query = store.query
            railFilter = store.railFilter
            sessionListView = store.sessionListView
            railOrganization = store.railOrganization
            railSort = store.railSort
            projectManualOrder = store.projectManualOrder
            sessionManualOrderByScope = store.sessionManualOrderByScope
        }
    }

    private var groupsCache: (fingerprint: RailFingerprint, groups: [Group])?

    /// Filtered + organized view of the inventory (the rail model).
    var groups: [Group] {
        let fingerprint = RailFingerprint(store: self)
        if let cached = groupsCache, cached.fingerprint == fingerprint {
            return cached.groups
        }
        let computed = computeGroups()
        groupsCache = (fingerprint, computed)
        return computed
    }

    private func computeGroups() -> [Group] {
        let filtered = filteredSessions
        if railOrganization == .flat {
            return [
                Group(
                    projectId: "__flat__",
                    project: sessionListView == .current ? "All current sessions" : "All archived sessions",
                    sessions: sortSessions(filtered, scope: "__flat__")
                ),
            ].filter { !$0.sessions.isEmpty }
        }
        let keyed = Dictionary(grouping: filtered) { $0.project.projectId }
        return keyed.compactMap { projectId, sessions -> Group? in
            guard let first = sessions.first else { return nil }
            return Group(
                projectId: projectId,
                project: first.project.name ?? first.project.projectId,
                sessions: sortSessions(sessions, scope: projectId)
            )
        }.sorted(by: compareGroups)
    }

    private func matchesFilter(_ session: SessionRef) -> Bool {
        switch railFilter {
        case .all:
            return true
        case .attention:
            return session.pendingApproval == true
                || session.pendingUserInput == true
                || ["pendingApproval", "awaitingInput", "planReady"].contains(session.status)
        case .running:
            return ["active", "working"].contains(session.status)
        case .errors:
            return ["error", "failed"].contains(session.status)
        }
    }

    private func sessionPriority(_ session: SessionRef) -> Int {
        if session.pendingApproval == true || session.status == "pendingApproval" { return 6 }
        if session.pendingUserInput == true || session.status == "awaitingInput" { return 5 }
        if ["active", "working"].contains(session.status) { return 4 }
        if ["error", "failed"].contains(session.status) { return 2 }
        if session.proposedPlan != nil || session.status == "planReady" { return 1 }
        return 0
    }

    private func sortSessions(_ input: [SessionRef], scope: String) -> [SessionRef] {
        let manualOrder = sessionManualOrderByScope[scope] ?? []
        return input.sorted { left, right in
            if railSort == .manual {
                let leftRank = manualOrder.firstIndex(of: left.sessionId) ?? Int.max
                let rightRank = manualOrder.firstIndex(of: right.sessionId) ?? Int.max
                if leftRank != rightRank { return leftRank < rightRank }
            }
            if railSort == .priority {
                let leftPriority = sessionPriority(left)
                let rightPriority = sessionPriority(right)
                if leftPriority != rightPriority { return leftPriority > rightPriority }
            }
            if left.updatedAt != right.updatedAt { return left.updatedAt > right.updatedAt }
            return left.sessionId < right.sessionId
        }
    }

    private func compareGroups(_ left: Group, _ right: Group) -> Bool {
        if railSort == .manual {
            let leftRank = projectManualOrder.firstIndex(of: left.projectId) ?? Int.max
            let rightRank = projectManualOrder.firstIndex(of: right.projectId) ?? Int.max
            if leftRank != rightRank { return leftRank < rightRank }
        }
        if railSort == .priority {
            let leftPriority = left.sessions.map(sessionPriority).max() ?? 0
            let rightPriority = right.sessions.map(sessionPriority).max() ?? 0
            if leftPriority != rightPriority { return leftPriority > rightPriority }
        }
        let leftUpdated = left.sessions.map(\.updatedAt).max() ?? ""
        let rightUpdated = right.sessions.map(\.updatedAt).max() ?? ""
        if leftUpdated != rightUpdated { return leftUpdated > rightUpdated }
        let nameOrder = left.project.localizedCaseInsensitiveCompare(right.project)
        if nameOrder != .orderedSame { return nameOrder == .orderedAscending }
        return left.projectId < right.projectId
    }

    private func manualScope(for session: SessionRef) -> String {
        railOrganization == .flat ? "__flat__" : session.project.projectId
    }

    private func normalizedManualOrder(stored: [String], visibleIds: [String]) -> [String] {
        var seen = Set<String>()
        let visible = Set(visibleIds)
        var result = stored.filter { visible.contains($0) && seen.insert($0).inserted }
        result.append(contentsOf: visibleIds.filter { seen.insert($0).inserted })
        result.append(contentsOf: stored.filter { !visible.contains($0) && seen.insert($0).inserted })
        return result
    }

    private func persistSessionManualOrder() {
        guard let data = try? JSONEncoder().encode(sessionManualOrderByScope) else { return }
        UserDefaults.standard.set(data, forKey: Self.railSessionManualOrderKey)
    }

    private func reconcileSelectionForVisibleList() {
        if let selectedSession,
           (selectedSession.archivedAt != nil) == (sessionListView == .archived) {
            return
        }
        // T4_NO_SELECT=1 (perf-bisect seam): skip auto-select/attach so the
        // app renders the rail only — isolates inventory render cost from
        // live-transcript render cost on Linux.
        if ProcessInfo.processInfo.environment["T4_NO_SELECT"] == "1" { return }
        select(sessions.first {
            ($0.archivedAt != nil) == (sessionListView == .archived)
        })
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
        if Self.demoMode {
            // The demo-stream driver (-T4DemoStream) appends to liveEntries;
            // those entries ride on top of the static sample.
            return sampleTranscript(for: sessionId) + (liveEntries[sessionId] ?? [])
        }
        return []
    }

    /// Sample transcript — offline preview only.
    private func sampleTranscript(for sessionId: String) -> [TranscriptEntry] {
        let host = hostId.isEmpty ? "local" : hostId
        let body: String
        switch sessionId {
        case "s1": body = Self.sampleTranscriptAnchor
        case "s2": body = Self.sampleTranscriptSite
        case "s5": body = Self.sampleTranscriptEval
        default: body = Self.sampleTranscriptDefault
        }
        let json = body.replacingOccurrences(of: "__HOST__", with: host)
            .replacingOccurrences(of: "__SESSION__", with: sessionId)
        let entries = (try? JSONDecoder().decode([DurableEntry].self, from: Data(json.utf8))) ?? []
        return entries.map { TranscriptEntry(from: $0) }
    }

    /// Hero transcript (s1): a full coding arc — prompt, plan, reads, a diff
    /// edit, a failing test, the fix, green run, and a markdown summary with
    /// a table. Doubles as the wrap/markdown rendering showcase.
    private static let sampleTranscriptAnchor = #"""
    [
    {"id":"e1","parentId":null,"hostId":"__HOST__","sessionId":"__SESSION__","kind":"message","timestamp":"2026-08-05T09:14:00Z","data":{"role":"user","text":"the linux transcript jumps around while streaming. keep it pinned to the bottom when i'm already there, but don't fight me when i scroll up"}},
    {"id":"e2","parentId":"e1","hostId":"__HOST__","sessionId":"__SESSION__","kind":"message","timestamp":"2026-08-05T09:14:06Z","data":{"reasoning":"The jump is the scrolled window keeping its `value` while `upper` grows — the viewport stays at an absolute offset instead of following the newest entry. SwiftCrossUI has no scroll API, so this belongs in the Gtk backend: watch the vertical adjustment's `changed` signal, and when content grows, snap `value = upper - pageSize` — but only if the pre-growth geometry was already at the bottom. **Scrolling up must release the pin**, and scrolling back near the bottom should re-engage it on the next growth. A 120px slack band reads well at 15pt body text."}},
    {"id":"e3","parentId":"e2","hostId":"__HOST__","sessionId":"__SESSION__","kind":"tool-use","timestamp":"2026-08-05T09:14:10Z","data":{"tool":"todo","title":"plan","result":{"output":"Investigate\n  Locate the scroll container wiring ✓\n  Confirm adjustment signal order ✓\nImplement\n  Add stick-to-bottom anchor to ScrolledWindow ◐\n  Gate it behind an environment flag ◐\nVerify\n  Streaming pin + scroll-up release on Xvfb ○"},"ok":true}},
    {"id":"e4","parentId":"e3","hostId":"__HOST__","sessionId":"__SESSION__","kind":"tool-use","timestamp":"2026-08-05T09:14:16Z","data":{"tool":"read","title":"read ScrolledWindow.swift","result":{"output":"public class ScrolledWindow: Widget {\n    var child: Widget?\n\n    public convenience init() {\n        self.init(gtk_scrolled_window_new())\n    }\n\n    public func setScrollBarPresence(hasVerticalScrollBar: Bool, hasHorizontalScrollBar: Bool) {\n        gtk_scrolled_window_set_policy(\n            opaquePointer,\n            hasHorizontalScrollBar ? GTK_POLICY_AUTOMATIC : GTK_POLICY_NEVER,\n            hasVerticalScrollBar ? GTK_POLICY_AUTOMATIC : GTK_POLICY_NEVER\n        )\n    }\n}"},"ok":true}},
    {"id":"e5","parentId":"e4","hostId":"__HOST__","sessionId":"__SESSION__","kind":"message","timestamp":"2026-08-05T09:14:24Z","data":{"text":"The plan: track `lastUpper`, and on every adjustment `changed` recompute whether the user *was* at the bottom before the growth. That single comparison handles all three cases — initial open, streaming growth, and user scroll-away — without a sticky state machine:\n\n```swift\nlet wasAtBottom = value + pageSize >= lastUpper - Self.bottomSlack\nlastUpper = upper\nguard anchorsToBottom, wasAtBottom, upper > pageSize else { return }\ngtk_adjustment_set_value(adjustment, upper - pageSize)\n```\n\nWiring it behind `scrollAnchorsToBottom` so only the transcript opts in — the rail and pane lists keep their normal behavior."}},
    {"id":"e6","parentId":"e5","hostId":"__HOST__","sessionId":"__SESSION__","kind":"tool-use","timestamp":"2026-08-05T09:15:02Z","data":{"tool":"edit","title":"edit ScrolledWindow.swift","result":{"output":"diff --git a/Sources/Gtk/Widgets/ScrolledWindow.swift b/Sources/Gtk/Widgets/ScrolledWindow.swift\n--- a/Sources/Gtk/Widgets/ScrolledWindow.swift\n+++ b/Sources/Gtk/Widgets/ScrolledWindow.swift\n@@ -3,6 +3,28 @@\n public class ScrolledWindow: Widget {\n     var child: Widget?\n \n+    /// Stick-to-bottom anchoring for streaming transcripts.\n+    public var anchorsToBottom = false {\n+        didSet { installBottomAnchor() }\n+    }\n+    private var lastUpper = 0.0\n+\n+    private func snapToBottomIfAnchored() {\n+        guard let adjustment = gtk_scrolled_window_get_vadjustment(opaquePointer) else { return }\n+        let value = gtk_adjustment_get_value(adjustment)\n+        let pageSize = gtk_adjustment_get_page_size(adjustment)\n+        let upper = gtk_adjustment_get_upper(adjustment)\n+        let wasAtBottom = value + pageSize >= lastUpper - Self.bottomSlack\n+        lastUpper = upper\n+        guard anchorsToBottom, wasAtBottom, upper > pageSize else { return }\n+        gtk_adjustment_set_value(adjustment, upper - pageSize)\n+    }\n+\n     public func setScrollBarPresence("},"ok":true}},
    {"id":"e7","parentId":"e6","hostId":"__HOST__","sessionId":"__SESSION__","kind":"tool-use","timestamp":"2026-08-05T09:15:21Z","data":{"tool":"bash","title":"swift build","result":{"output":"Fetching dependencies… done\nCompiling Gtk Widgets/ScrolledWindow.swift\nCompiling GtkBackend GtkBackend.swift\nCompiling T4CodeLinuxLib Views/T4SessionDetailView.swift\nBuild complete! (21.37s)"},"ok":true}},
    {"id":"e8","parentId":"e7","hostId":"__HOST__","sessionId":"__SESSION__","kind":"tool-use","timestamp":"2026-08-05T09:15:47Z","data":{"tool":"bash","title":"swift test --filter AnchorTests","result":{"output":"✔ opensPinnedToBottom (0.412s)\n✘ anchorReleasesOnScrollUp — expected value to stay 480.0, got 960.0 (snapped)\n✔ anchorReengagesNearBottom (0.388s)\n✘ run with 3 tests: 1 failure"},"ok":false}},
    {"id":"e9","parentId":"e8","hostId":"__HOST__","sessionId":"__SESSION__","kind":"message","timestamp":"2026-08-05T09:15:55Z","data":{"reasoning":"The release test fails because I update `lastUpper` **before** reading the pre-change geometry when GTK coalesces two growths into one signal — the second `changed` sees a `lastUpper` that already includes the first growth, so a scrolled-up user looks \"at bottom\" and gets yanked down. Read the geometry first, then update."}},
    {"id":"e10","parentId":"e9","hostId":"__HOST__","sessionId":"__SESSION__","kind":"tool-use","timestamp":"2026-08-05T09:16:03Z","data":{"tool":"edit","title":"edit ScrolledWindow.swift (read-before-write)","result":{"output":"@@ -14,8 +14,8 @@\n-        lastUpper = upper\n-        let wasAtBottom = value + pageSize >= lastUpper - Self.bottomSlack\n+        let wasAtBottom = value + pageSize >= lastUpper - Self.bottomSlack\n+        lastUpper = upper"},"ok":true}},
    {"id":"e11","parentId":"e10","hostId":"__HOST__","sessionId":"__SESSION__","kind":"tool-use","timestamp":"2026-08-05T09:16:19Z","data":{"tool":"bash","title":"swift test","result":{"output":"✔ Suite \"Anchor behavior\" passed after 0.802 seconds.\n✔ Suite \"Store prompt flow\" passed after 0.531 seconds.\n✔ Suite \"Fixture wire integration\" passed after 15.104 seconds.\n✔ Test run with 13 tests in 5 suites passed after 16.121 seconds."},"ok":true}},
    {"id":"e12","parentId":"e11","hostId":"__HOST__","sessionId":"__SESSION__","kind":"message","timestamp":"2026-08-05T09:16:40Z","data":{"text":"Done — the transcript now anchors to the newest content exactly when it should. The behavior matrix:\n\n| Situation | Result |\n|---|---|\n| Open a long session | lands on the latest entries |\n| Streaming while at bottom | follows every delta |\n| Scrolled up while streaming | stays put — no fighting |\n| Back within 120px of bottom | re-engages on the next delta |\n| Load earlier messages | shows the entries you just loaded |\n\nThe pin lives in `ScrolledWindow` itself, gated by a `scrollAnchorsToBottom` environment flag, so every surface keeps its old behavior unless it opts in. Verified on Xvfb against a live host: pinned open, follow-stream, and release-without-drift all pass. The full flow is covered by the new `AnchorTests` suite."}},
    {"id":"e13","parentId":"e12","hostId":"__HOST__","sessionId":"__SESSION__","kind":"message","timestamp":"2026-08-05T09:16:44Z","data":{"text":"Captured the verification run for the release notes.","artifacts":[{"artifactId":"art-anchor-moon","kind":"image","mediaType":"image/png","size":204113,"sha256":"9f2c1ab7","name":"linux-anchor-pinned-moon.png","disposition":"inline"},{"artifactId":"art-anchor-dawn","kind":"image","mediaType":"image/png","size":198764,"sha256":"41bd77e0","name":"linux-anchor-pinned-dawn.png","disposition":"inline"}]}}
    ]
    """#

    /// Site-refresh transcript (s2): pairs with the browser pane — the
    /// assistant checks the freshly built site while screenshots retake.
    private static let sampleTranscriptSite = #"""
    [
    {"id":"e1","parentId":null,"hostId":"__HOST__","sessionId":"__SESSION__","kind":"message","timestamp":"2026-08-05T10:02:00Z","data":{"role":"user","text":"retake the linux site screenshots in both themes — and the usage pane is empty in the current set, fix that too"}},
    {"id":"e2","parentId":"e1","hostId":"__HOST__","sessionId":"__SESSION__","kind":"message","timestamp":"2026-08-05T10:02:09Z","data":{"text":"On it. The empty usage pane was a demo-data gap, not a render bug — the pane only had a live path. Seeding a sample `UsageReadResult` for captures, then retaking all 28 stills at 1920×1080 in **dawn** and **moon**."}},
    {"id":"e3","parentId":"e2","hostId":"__HOST__","sessionId":"__SESSION__","kind":"tool-use","timestamp":"2026-08-05T10:02:31Z","data":{"tool":"bash","title":"pnpm --filter @t4-code/site build","result":{"output":"vite v7.1.2 building for production...\n✓ 214 modules transformed.\ndist/index.html            12.4 kB\ndist/linux.html            18.9 kB\ndist/assets/site-B7x2kQ.css  41.2 kB\n✓ built in 3.41s"},"ok":true}},
    {"id":"e4","parentId":"e3","hostId":"__HOST__","sessionId":"__SESSION__","kind":"message","timestamp":"2026-08-05T10:02:44Z","data":{"text":"Site build is clean. Loading it in the browser pane now to check the new screenshot grid before the capture sweep — the hero shot should lead with the anchored transcript, and every feature still gets both themes."}},
    {"id":"e5","parentId":"e4","hostId":"__HOST__","sessionId":"__SESSION__","kind":"tool-use","timestamp":"2026-08-05T10:03:12Z","data":{"tool":"read","title":"read linux.html","result":{"output":"<section id=\"screenshots\">\n  <figure data-theme-pair>\n    <img data-theme=\"dawn\" src=\"screenshots/linux-dawn.png\">\n    <img data-theme=\"moon\" src=\"screenshots/linux-moon.png\">\n  </figure>\n  …\n</section>"},"ok":true}}
    ]
    """#

    /// Eval transcript (s5): a closed-out benchmark run with a results table.
    private static let sampleTranscriptEval = #"""
    [
    {"id":"e1","parentId":null,"hostId":"__HOST__","sessionId":"__SESSION__","kind":"message","timestamp":"2026-08-04T16:02:00Z","data":{"role":"user","text":"run the hidden eval for muse-spark-1.2-contributor and give me the congregate breakdown"}},
    {"id":"e2","parentId":"e1","hostId":"__HOST__","sessionId":"__SESSION__","kind":"tool-use","timestamp":"2026-08-04T16:02:20Z","data":{"tool":"bash","title":"muse eval --hidden --candidate 1.2-contributor","result":{"output":"running 51 hidden fixtures…\nT1–T5 51/51 · T6 5/7 · RVC 1/1\npolicy: 0 crashes · 0 hangs · 0 determinism violations\ncongregate components written to bench_out/muse-1.2.json"},"ok":true}},
    {"id":"e3","parentId":"e2","hostId":"__HOST__","sessionId":"__SESSION__","kind":"message","timestamp":"2026-08-04T16:02:44Z","data":{"text":"Clean run. Congregate breakdown for `muse-spark-1.2-contributor`:\n\n| Component | Score | Weight |\n|---|---|---|\n| mechanical | 91.4 | 0.4 |\n| designer | 71.4 | 0.3 |\n| speed | 83.0 | 0.2 |\n| elegance | 96.2 | 0.1 |\n\n**Congregate: 84.1** — lands right after gpt-luna, above grok/gpt-sol/glm-5.2. The two T6 misses are the same adversarial fixtures v4-flash fails (`deep_nesting`, `memo_cycle`); both are clean refusals, so no policy deduction."}}
    ]
    """#

    /// Default short transcript for the remaining sample sessions.
    private static let sampleTranscriptDefault = #"""
    [
    {"id":"e1","parentId":null,"hostId":"__HOST__","sessionId":"__SESSION__","kind":"message","timestamp":"2026-08-04T09:00:00Z","data":{"role":"user","text":"audit the reconnect backoff"}},
    {"id":"e2","parentId":"e1","hostId":"__HOST__","sessionId":"__SESSION__","kind":"message","timestamp":"2026-08-04T09:00:05Z","data":{"text":"Looking at HostClient reconnect now."}},
    {"id":"e3","parentId":"e2","hostId":"__HOST__","sessionId":"__SESSION__","kind":"tool-use","timestamp":"2026-08-04T09:00:10Z","data":{"tool":"read","title":"read HostClient.swift","result":{"output":"public actor HostClient {\n    private var backoff: ExponentialBackoff\n    …"},"ok":true}},
    {"id":"e4","parentId":"e3","hostId":"__HOST__","sessionId":"__SESSION__","kind":"message","timestamp":"2026-08-04T09:00:20Z","data":{"text":"Backoff is 0.5–30s exponential with cursor resume — correct."}}
    ]
    """#

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
    /// On platforms without Security (Linux), plain transport only — cert
    /// pinning is a wave-2 concern there.
    private func makeTransport(endpoint: URL) -> any HostWireTransport {
        #if canImport(Security)
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
        #else
        // Linux: URLSession's WebSocket path requires libcurl built with
        // WebSockets (distro curl lacks it); use the native RFC 6455
        // transport from Seams/LinuxWebSocketTransport.swift.
        return LinuxWebSocketTransport(endpoint: endpoint)
        #endif
    }

    /// A later healthy connection supersedes any earlier endpoint failure.
    /// Keep this transition explicit so a transient restore/pair attempt cannot
    /// leave a stale transport error pinned above a live session inventory.
    func clearErrorAfterSuccessfulConnection() {
        lastError = nil
    }

    /// Connect to a t4-host over host-wire, handshake, and load the inventory.
    func connect(endpoint: URL, identity: ClientIdentity, authentication: DeviceAuthentication? = nil) async {
        #if os(Linux)
        T4Perf.mark("connect-start")
        #endif
        connecting = true
        // New connection, new attach state — the previous connection's
        // session.attach registrations don't carry over.
        attachedSessions.removeAll()
        defer { connecting = false }
        let transport = makeTransport(endpoint: endpoint)
        let c = HostClient(transport: transport, config: HostClient.Config(identity: identity, authentication: authentication, requestedFeatures: Self.clientFeatures))
        client = c
        do {
            let welcome = try await c.connect()
            #if os(Linux)
            T4Perf.mark("connect-welcome")
            #endif
            hostId = welcome.hostId
            hostInfo = HostInfo(hostId: welcome.hostId, ompVersion: welcome.ompVersion, appserverVersion: welcome.appserverVersion)
            grantedCapabilities = welcome.grantedCapabilities
            grantedFeatures = Set(welcome.grantedFeatures)
            connected = welcome.authentication == .paired || welcome.authentication == .local
            if connected {
                pairedEndpoint = endpoint.absoluteString
                persist(endpoint: endpoint, authentication: authentication)
                clearErrorAfterSuccessfulConnection()
                // Don't hold the first frame hostage to a busy host:
                // session.list and catalog.get can take many seconds (the
                // appserver serializes external usage fetches into catalog
                // builds). Flip to the live workspace immediately and
                // populate the rail + model menu asynchronously.
                Task {
                    await refresh()
                    #if os(Linux)
                    T4Perf.mark("connect-refresh")
                    #endif
                    await loadCatalog()
                    #if os(Linux)
                    T4Perf.mark("connect-catalog")
                    #endif
                }
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
            reconcileSelectionForVisibleList()
            return
        }
        if let fresh = sessions.first(where: { $0.sessionId == selected.sessionId }),
           (fresh.archivedAt != nil) == (sessionListView == .archived) {
            selectedSession = fresh
        } else {
            reconcileSelectionForVisibleList()
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
        attachedSessions.removeAll()
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
        {"hostId":"studio-mac","sessionId":"s1","project":{"projectId":"omperator","name":"Omperator"},"revision":"r1","title":"Pin streaming transcript to bottom","status":"active","updatedAt":"2026-08-05T11:42:00Z","model":"kimi-code/k3","pendingUserInput":true,"contextUsage":{"used":64,"limit":200}},
        {"hostId":"studio-mac","sessionId":"s2","project":{"projectId":"omperator","name":"Omperator"},"revision":"r2","title":"Site screenshot refresh","status":"active","updatedAt":"2026-08-05T10:18:00Z","model":"gpt-5.2","contextUsage":{"used":41,"limit":200}},
        {"hostId":"studio-mac","sessionId":"s3","project":{"projectId":"omperator","name":"Omperator"},"revision":"r3","title":"Palette command audit","status":"idle","updatedAt":"2026-08-04T19:55:00Z","model":"devin/swe-1-7","contextUsage":{"used":88,"limit":200}},
        {"hostId":"studio-mac","sessionId":"s4","project":{"projectId":"omperator","name":"Omperator"},"revision":"r4","title":"Fixture streaming proofs","status":"active","updatedAt":"2026-08-05T09:02:00Z","model":"gpt-5.2","pendingApproval":true,"contextUsage":{"used":33,"limit":200}},
        {"hostId":"studio-mac","sessionId":"s5","project":{"projectId":"muse-spark","name":"muse-spark"},"revision":"r5","title":"Hidden eval 1.2-contributor","status":"idle","updatedAt":"2026-08-04T16:40:00Z","model":"deepseek-v4-flash","contextUsage":{"used":142,"limit":200}},
        {"hostId":"studio-mac","sessionId":"s6","project":{"projectId":"muse-spark","name":"muse-spark"},"revision":"r6","title":"Congregate score ranking","status":"closed","updatedAt":"2026-08-03T14:12:00Z","model":"glm-5.2"},
        {"hostId":"studio-mac","sessionId":"s7","project":{"projectId":"archive","name":"Archived work"},"revision":"r7","title":"Release audit 0.2.0","status":"closed","updatedAt":"2026-07-18T17:00:00Z","archivedAt":"2026-07-19T09:00:00.000Z","model":"gpt-5.2"}
        ]
        """
        let decoder = JSONDecoder()
        return (try? decoder.decode([SessionRef].self, from: Data(json.utf8))) ?? []
    }()

    /// Sample subagents — offline preview for the agents pane so the sheet
    /// renders without a live host: one running, one completed, one queued,
    /// one failed.
    private static let sampleAgents: [AgentState] = [
        AgentState(agentId: "scout/backoff-map", state: "running", progress: 0.62, detail: "Mapping reconnect backoff across transport resets"),
        AgentState(agentId: "worker/anchor-patch", state: "running", progress: 0.31, detail: "Porting the scroll anchor to Gtk3 backend"),
        AgentState(agentId: "reviewer/clip-audit", state: "completed", progress: 1.0, detail: "Audited 214 transcript rows for edge clipping"),
        AgentState(agentId: "sonic/shot-list", state: "failed", progress: 0.18, detail: "Screenshot manifest lint — stale hero dimensions"),
    ]

    /// Sample code reviews — offline preview for the review pane. Built by
    /// decoding a minimal `review` frame.
    /// Sample model catalog — populates the settings pane's Models section
    /// and the composer model menu in demo mode.
    private static let sampleCatalog: [CatalogItem] = {
        let json = """
        [
        {"id":"kimi-code/k3","kind":"model","name":"k3","description":"Kimi Code — fast daily driver","supported":true},
        {"id":"gpt-5.2","kind":"model","name":"GPT-5.2","description":"OpenAI flagship","supported":true},
        {"id":"deepseek-v4-flash","kind":"model","name":"v4 flash","description":"DeepSeek fast tier","supported":true},
        {"id":"devin/swe-1-7","kind":"model","name":"swe-1-7","description":"Devin SWE agent","supported":true},
        {"id":"glm-5.2","kind":"model","name":"GLM-5.2","description":"Zhipu flagship","supported":true}
        ]
        """
        return (try? JSONDecoder().decode([CatalogItem].self, from: Data(json.utf8))) ?? []
    }()

    /// Sample plan phases — offline plan strip for the hero session (s1).
    private static let samplePlanPhases: [PlanPhase] = [
        PlanPhase(name: "Investigate", tasks: [
            PlanTask(content: "Locate the scroll container wiring", status: "completed"),
            PlanTask(content: "Confirm adjustment signal order", status: "completed"),
        ]),
        PlanPhase(name: "Implement", tasks: [
            PlanTask(content: "Add stick-to-bottom anchor to ScrolledWindow", status: "completed"),
            PlanTask(content: "Gate it behind an environment flag", status: "completed"),
        ]),
        PlanPhase(name: "Verify", tasks: [
            PlanTask(content: "Streaming pin + scroll-up release on Xvfb", status: "in_progress"),
            PlanTask(content: "Retake dawn/moon captures", status: "pending"),
        ]),
    ]

    /// Sample usage snapshot — offline usage pane for captures. Mirrors a
    /// `usage.read` result: per-provider limits, capacity, one idle account.
    private static let sampleUsageSnapshot: UsageReadResult? = {
        let json = """
        {"generatedAt":1785963900,"reports":[
          {"provider":"kimi-code","fetchedAt":1785963840,"limits":[
            {"id":"session","label":"Session","scope":{"provider":"kimi-code"},"window":{"id":"5h","label":"5-hour","durationMs":18000000,"resetsAt":1785971100},"amount":{"used":34,"limit":100,"usedFraction":0.34,"unit":"percent"},"status":"ok"},
            {"id":"weekly","label":"Weekly","scope":{"provider":"kimi-code"},"window":{"id":"7d","label":"Weekly","durationMs":604800000,"resetsAt":1786366000},"amount":{"used":61,"limit":100,"usedFraction":0.61,"unit":"percent"},"status":"warning"}
          ]},
          {"provider":"gpt-5.2","fetchedAt":1785963820,"limits":[
            {"id":"session","label":"Session","scope":{"provider":"gpt-5.2"},"window":{"id":"5h","label":"5-hour","durationMs":18000000,"resetsAt":1785969000},"amount":{"used":72,"limit":100,"usedFraction":0.72,"unit":"percent"},"status":"warning"},
            {"id":"weekly","label":"Weekly","scope":{"provider":"gpt-5.2"},"window":{"id":"7d","label":"Weekly","durationMs":604800000,"resetsAt":1786366000},"amount":{"used":38,"limit":100,"usedFraction":0.38,"unit":"percent"},"status":"ok"}
          ],"notes":["Capacity pool shared across 3 seats"]},
          {"provider":"deepseek","fetchedAt":1785963810,"limits":[
            {"id":"daily","label":"Daily tokens","scope":{"provider":"deepseek"},"window":{"id":"1d","label":"Daily","durationMs":86400000,"resetsAt":1786000000},"amount":{"used":1840000,"limit":15000000,"usedFraction":0.12,"unit":"tokens"},"status":"ok"}
          ]}
        ],"accountsWithoutUsage":[
          {"provider":"openrouter","type":"api_key","email":"dogfood@omperator.dev"}
        ],"capacity":{
          "kimi-code":[{"window":"5h","durationMs":18000000,"accounts":3,"usedAccounts":1.0,"remainingAccounts":2.0}],
          "gpt-5.2":[{"window":"5h","durationMs":18000000,"accounts":2,"usedAccounts":2.0,"remainingAccounts":0.0}]
        }}
        """
        return try? JSONDecoder().decode(UsageReadResult.self, from: Data(json.utf8))
    }()

    static let sampleReviews: [ReviewFrame] = {
        let json = """
        {"v":"omp-app/1","type":"review","hostId":"studio-mac","sessionId":"s1","reviewId":"review-anchor","status":"pending","path":"Sources/Gtk/Widgets/ScrolledWindow.swift","findings":[
          {"severity":"warning","message":"snapToBottomIfAnchored runs on the GTK main thread; keep the handler allocation-free.","line":41},
          {"severity":"info","message":"bottomSlack of 120px reads well at 15pt body text; revisit if the composer grows.","line":64},
          {"severity":"warning","message":"The retained signal box is never released — one per scroll container, bounded, but note it upstream.","line":33}
        ]}
        """
        return (try? JSONDecoder().decode(ReviewFrame.self, from: Data(json.utf8)))
            .map { [$0] } ?? []
    }()
}
