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
import Security

private let t4log = Logger(subsystem: "sh.t4code.ios", category: "store")

private struct PendingTranscriptQueue {
    private(set) var entries: [TranscriptEntry] = []

    var isEmpty: Bool { entries.isEmpty }

    mutating func enqueue(_ entry: TranscriptEntry) {
        if let index = entries.firstIndex(where: { $0.id == entry.id }) {
            entries[index] = entry
        } else {
            entries.append(entry)
        }
    }

    mutating func removeAll(where predicate: (TranscriptEntry) -> Bool) {
        entries.removeAll(where: predicate)
    }

    mutating func drainReadyPrefix(
        while isReady: (TranscriptEntry) -> Bool
    ) -> [TranscriptEntry] {
        var count = 0
        while count < entries.count, isReady(entries[count]) { count += 1 }
        guard count > 0 else { return [] }
        let ready = Array(entries.prefix(count))
        entries.removeFirst(count)
        return ready
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

    @Published private(set) var sessions: [SessionRef]
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
    @Published private(set) var connecting = false
    @Published private(set) var connected = false
    @Published var lastError: String?
    /// Composer prefill channel for cross-pane flows (e.g. browser "design
    /// mode" annotation). The session detail composer observes this and
    /// adopts the text into its draft, then clears it. Nil = nothing pending.
    @Published var pendingComposerText: String?
    /// Human-readable endpoint the store is currently paired/connected to
    /// (e.g. "ws://macbookpro.my-tailnet.ts.net:8787/v1/ws"), for UI display.
    @Published private(set) var pairedEndpoint: String?
    /// Host version/identity from the WelcomeFrame (hostId, OMP version,
    /// appserver version). Captured on connect, cleared on disconnect.
    @Published private(set) var hostInfo: HostInfo?
    @Published var selectedSession: SessionRef?
    /// Session ids with durable entries that arrived while the session was
    /// not selected — drives the rail's unread dot. Cleared on select, pruned
    /// to the live inventory on each sessions push. In-memory only.
    @Published private(set) var unreadSessions: Set<String> = []
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
    /// Paced compatibility projection for hosts that emit flattened
    /// `message.update` snapshots rather than ordered assistant blocks.
    @Published private(set) var streamingMessages: [String: StreamingAssistantBuffer] = [:]
    /// Ordered in-flight thinking, text, and tool-input blocks.
    @Published private(set) var liveTurns: [String: LiveTurnTimeline] = [:]
    /// Compatibility projection for hosts that emit tool lifecycle events
    /// without ordered assistant blocks.
    @Published private(set) var liveTools: [String: LiveToolProjection] = [:]
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
    /// Per-session ordered terminal ids (max 4), in the order `openTerminal`
    /// opened them. The drawer renders one tab per id; the active id is the
    /// tab whose buffered output is rendered and whose keystrokes are sent.
    @Published private(set) var openTerminalIds: [String: [String]] = [:]
    /// The active terminal id for a session — the tab the drawer renders and
    /// the target of `sendTerminalInput`/`resizeTerminal`. Set by `openTerminal`
    /// (new terminal becomes active) and `selectTerminal` (tab switch), and
    /// reselected to a neighbor when the active terminal is closed.
    @Published private(set) var activeTerminalId: [String: String] = [:]
    /// Per-terminal last error (e.g. a denied term.open command). Cleared
    /// on a successful open or explicit close.
    @Published private(set) var terminalErrors: [String: String] = [:]
    /// Per-session browser URL for the browser pane (T4BrowserPane). The
    /// pane persists the URL field here so reopening a session's browser
    /// returns to the last visited page. Defaults to localhost:3000 via
    /// `browserURL(for:)` when unset.
    @Published var browserURLBySession: [String: String] = [:]
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
    /// Latest preview id per session, tracked from `preview.launch`/`state`/
    /// `navigation`/`capture` push frames and the `preview.launch` command
    /// result. `previewCapture(sessionId:previewId:)` uses this when no
    /// explicit previewId is given; the browser pane's Capture button is
    /// enabled while a preview is tracked.
    @Published private(set) var previewIdBySession: [String: String] = [:]
    /// Decoded capture images by captureId, populated by `previewCapture`
    /// (the Capture button) and by the async fetch kicked off when a
    /// `preview.capture` push frame arrives. The browser pane renders the
    /// latest one full-fit; transcript capture rows look their image up here
    /// by `data.captureId`.
    @Published private(set) var previewCaptureImages: [String: PlatformImage] = [:]
    /// Ordered capture rows per session — one per `preview.capture` push
    /// frame or explicit `preview.capture` command. Each carries the capture
    /// metadata plus the decoded image once the chunked fetch resolves. The
    /// browser pane and transcript render these as image rows.
    @Published private(set) var previewCaptureRowsBySession: [String: [PreviewCaptureRow]] = [:]

    /// Per-session region/tile layouts (right-dock panes, active tab, terminal
    /// open, dock width, floating panes). Persisted to UserDefaults as JSON
    /// (see T4SessionLayout.swift). Mutated through the extension methods so
    /// persistence is centralized.
    @Published var layoutBySession: [String: T4SessionLayout] = [:]

    /// True once a live host has spoken (refresh or push). Drives the boot
    /// splash: saved-connection devices see "Connecting…", not fake chat.
    @Published private(set) var hasLiveInventory = false
    /// True when a previous session's endpoint is persisted (restore will run).
    var hasSavedConnection: Bool {
        // Ephemeral-credential runs never consult the Keychain (the macOS
        // consent dialog ignores kSecUseAuthenticationUIFail for ACL-denied
        // items and can block the main thread before first paint).
        if ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("-T4DeviceToken=") }) { return true }
        if Keychain.get(Self.savedEndpointKey) != nil { return true }
        #if os(macOS)
        // A local t4-host publishing an autoconnect credential counts as a
        // saved connection: restore() will pick it up without any UI.
        if LocalHostCredential.load() != nil { return true }
        #endif
        return false
    }

    /// True once a live host has spoken; false while showing the offline sample.
    private func markLive() { hasLiveInventory = true }

    /// Models from the catalog, in display order (supported first).
    var catalogModels: [CatalogItem] {
        catalog.filter { $0.kind == .model && $0.supported != false }
            .sorted { $0.id.localizedCaseInsensitiveCompare($1.id) == .orderedAscending }
    }

    private var client: HostClient?
    private var observationTask: Task<Void, Never>?
    private var connectionGeneration: UInt64 = 0
    private var hostId: String = ""
    private var streamingTasks: [String: Task<Void, Never>] = [:]
    private var liveTurnTasks: [String: Task<Void, Never>] = [:]
    private var toolStreamingTasks: [String: Task<Void, Never>] = [:]
    private var pendingTranscriptEntries: [String: PendingTranscriptQueue] = [:]
    /// Capabilities the host granted at welcome — gates optional commands
    /// (e.g. catalog.get needs catalog.read; an unauthorized command gets
    /// the connection closed by the remote policy).
    private var grantedCapabilities: [String] = []
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
    private static let installationDeviceIdKey = "t4.installationDeviceId"
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
            streamingText.removeValue(forKey: sessionId)
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
    private static func migrateCredentialsToKeychainIfNeeded() {
        let defaults = UserDefaults.standard
        if defaults.bool(forKey: keychainMigratedKey) { return }
        // Ephemeral-credential runs (-T4Endpoint + -T4DeviceId + -T4DeviceToken)
        // never touch the Keychain, so skip the migration read/write too.
        if ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("-T4DeviceToken=") }) { return }
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
        // UI-test seam: -T4NoRestore forces the offline sample inventory.
        if ProcessInfo.processInfo.arguments.contains("-T4NoRestore") { return }
        // UI-test seam: -T4ForgetCreds wipes saved connection credentials so
        // the boot lands on real onboarding (fresh-install path).
        if ProcessInfo.processInfo.arguments.contains("-T4ForgetCreds") {
            Keychain.remove(forKey: Self.savedEndpointKey)
            Keychain.remove(forKey: Self.savedDeviceIdKey)
            Keychain.remove(forKey: Self.savedDeviceTokenKey)
            return
        }
        // Dev seam: -T4Endpoint/-T4DeviceId/-T4DeviceToken supply ephemeral
        // credentials that bypass the Keychain entirely. Unsigned macOS dev
        // builds shift signatures, and the keychain consent dialog can block
        // the main thread before first paint — harnesses use these instead.
        let seamArg = { (name: String) -> String? in
            ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("-\(name)=") })
                .map { String($0.dropFirst(name.count + 2)) }
        }
        if let endpointSeam = seamArg("T4Endpoint"),
           let seamDeviceId = seamArg("T4DeviceId"), let seamToken = seamArg("T4DeviceToken"),
           let seamEndpoint = URL(string: endpointSeam), !connected, !connecting {
            ephemeralCredentials = true
            await connect(endpoint: seamEndpoint, identity: ClientIdentity(name: "t4-ios", version: "0.1", build: "dev", platform: "ios"),
                          authentication: DeviceAuthentication(deviceId: seamDeviceId, deviceToken: seamToken))
            return
        }
        if let seam = seamArg("T4Endpoint") {
            Keychain.set(seam, forKey: Self.savedEndpointKey)
        }
        guard !connected, !connecting else { return }
        if let endpointString = Keychain.get(Self.savedEndpointKey),
           let endpoint = URL(string: endpointString) {
            let deviceId = Keychain.get(Self.savedDeviceIdKey) ?? ""
            let token = Keychain.get(Self.savedDeviceTokenKey) ?? ""
            let auth: DeviceAuthentication? = (!deviceId.isEmpty && !token.isEmpty)
                ? DeviceAuthentication(deviceId: deviceId, deviceToken: token) : nil
            await connect(endpoint: endpoint, identity: ClientIdentity(name: "t4-ios", version: "0.1", build: "dev", platform: "ios"), authentication: auth)
            if connected { return }
        }
        #if os(macOS)
        // Local autoconnect: no saved remote (or it's unreachable) and a
        // t4-host on this machine is publishing a credential. Same-machine
        // trust — nothing is written to the Keychain; the host's 0600 file
        // is the source of truth and rotates on every host start.
        guard !connected, !connecting, let local = LocalHostCredential.load() else { return }
        connectingLocalAutoconnect = true
        await connect(endpoint: local.endpoint, identity: ClientIdentity(name: "t4-ios", version: "0.1", build: "dev", platform: "ios"),
                      authentication: DeviceAuthentication(deviceId: local.deviceId, deviceToken: local.deviceToken))
        connectingLocalAutoconnect = false
        localAutoconnect = connected
        #endif
    }

    /// True while the current connection came from the local host's
    /// autoconnect file rather than an explicitly paired/saved host. Drives
    /// the "This Mac · automatic" row in Settings.
    @Published private(set) var localAutoconnect = false
    /// Set only around the autoconnect connect() call so persist() skips the
    /// Keychain for credentials the local host owns.
    private var connectingLocalAutoconnect = false

    /// True when the session's credentials came from -T4Endpoint/-T4DeviceId/
    /// -T4DeviceToken launch seams: nothing may touch the Keychain this run
    /// (delete-then-add against another signer's items triggers the macOS
    /// consent dialog, which can block the main thread indefinitely).
    private var ephemeralCredentials = false

    private func persist(endpoint: URL, authentication: DeviceAuthentication?) {
        if ephemeralCredentials || connectingLocalAutoconnect { return }
        // nil/empty values clear the item, matching the prior UserDefaults
        // semantics (an open host persists only the endpoint, no creds).
        Keychain.set(endpoint.absoluteString, forKey: Self.savedEndpointKey)
        Keychain.set(authentication?.deviceId, forKey: Self.savedDeviceIdKey)
        Keychain.set(authentication?.deviceToken, forKey: Self.savedDeviceTokenKey)
    }

    /// Select a session (rail tap or auto-select of the most recent).
    func select(_ session: SessionRef?) {
        selectedSession = session
        // Viewing clears the unread dot for the now-selected session.
        if let session { unreadSessions.remove(session.sessionId) }
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
        guard let client, connected, !hostId.isEmpty,
              sessions.first(where: { $0.sessionId == sessionId })?.t4IsWritable == true,
              var revision = revision(of: sessionId)
        else {
            lastError = "This session is read-only."
            return nil
        }
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
    /// Send a prompt. Returns true only when the host accepted it — callers
    /// restore the composer draft on false so a failed send never eats the
    /// user's message (lease conflict, dropped connection, upload failure).
    @discardableResult
    func sendPrompt(sessionId: String, text: String, images: [Data] = []) async -> Bool {
        guard let client, connected, !hostId.isEmpty else {
            lastError = "Not connected to a host."
            return false
        }
        do {
            var refs: [JSONValue] = []
            for image in images {
                refs.append(.object(["imageId": .string(try await uploadImage(image, sessionId: sessionId))]))
            }
            var accepted = false
            await withLease(sessionId: sessionId, release: false) { leaseId in
                var args: [String: JSONValue] = ["message": .string(text), "leaseId": .string(leaseId)]
                if !refs.isEmpty { args["images"] = .array(refs) }
                do {
                    // session.prompt: revision is optional on the wire —
                    // omitting it sidesteps stale_revision churn entirely.
                    _ = try await client.sendCommand(CommandIntent(
                        hostId: hostId, command: "session.prompt", args: args,
                        sessionId: sessionId))
                    accepted = true
                    t4log.notice("prompt accepted for \(sessionId, privacy: .public)")
                } catch {
                    t4log.error("prompt failed: \(error)")
                    lastError = "\(error)"
                }
            }
            return accepted
        } catch {
            lastError = "\(error)"
            return false
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
                    hostId: hostId,
                    command: "session.release",
                    args: ["leaseId": .string(leaseId)],
                    sessionId: sessionId,
                    expectedRevision: revision
                ))
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
                    hostId: hostId,
                    command: "session.reclaim",
                    sessionId: sessionId,
                    expectedRevision: revision
                ))
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
    /// while Current stops rendering the session.
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
    /// leases because an archived session cannot acquire one.
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

    /// Current sessions keep the controller-lease delete path. Archived
    /// sessions dispatch the lifecycle command directly.
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
        self.sessions = Self.demoMode ? Self.sample : []
        // Per-session region/tile layouts (UserDefaults JSON) — restored once
        // at init so the first detail view reads persisted dock state.
        loadLayouts()
    }

    var currentSessionCount: Int {
        sessions.lazy.filter { $0.archivedAt == nil }.count
    }

    var archivedSessionCount: Int {
        sessions.lazy.filter { $0.archivedAt != nil }.count
    }

    var pinnedSessions: [SessionRef] {
        sortSessions(
            filteredSessions.filter { pinnedSessionIds.contains($0.sessionId) },
            scope: "__pinned__"
        )
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

    /// Filtered + organized view of the inventory (the rail model).
    var groups: [Group] {
        let filtered = filteredSessions
        if railOrganization == .flat {
            return [
                Group(
                    projectId: "__flat__",
                    project: sessionListView == .current
                        ? "All current sessions"
                        : "All archived sessions",
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
        select(sessions.first {
            ($0.archivedAt != nil) == (sessionListView == .archived)
        })
    }

    func selectDefaultVisibleSessionIfNeeded() {
        guard selectedSession == nil else { return }
        reconcileSelectionForVisibleList()
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
        if connected {
            if let live = agentsBySession[sessionId], !live.isEmpty { return live }
            return projectedTaskAgents(for: sessionId)
        }
        return Self.demoMode ? Self.sampleAgents : []
    }

    /// Fallback agent source: some runtimes stream no agent.* frames at all,
    /// leaving the pane empty even while `task` subagents are visibly working
    /// in the transcript. Project one row per named task-subagent from
    /// tool-use entries (args.tasks[].name); a finished call (result present)
    /// reads "completed", an open one "running".
    private func projectedTaskAgents(for sessionId: String) -> [AgentState] {
        var slots: [String: AgentState] = [:]
        var order: [String] = []
        for entry in liveEntries[sessionId] ?? [] {
            guard entry.kind == .toolUse,
                  case .object(let data) = entry.data,
                  case .string("task") = data["tool"],
                  case .object(let args)? = data["args"],
                  case .array(let tasks)? = args["tasks"] else { continue }
            let done: String
            if case .bool(let ok)? = data["ok"] { done = ok ? "completed" : "failed" }
            else if data["result"] != nil { done = "completed" }
            else { done = "running" }
            let intent: String?
            if case .string(let i)? = args["i"] { intent = i } else { intent = nil }
            for task in tasks {
                guard case .object(let t) = task, case .string(let name)? = t["name"] else { continue }
                if slots[name] == nil { order.append(name) }
                var slot = slots[name] ?? AgentState(agentId: name, state: "running")
                slot.state = done
                slot.detail = intent
                slots[name] = slot
            }
        }
        return order.suffix(12).compactMap { slots[$0] }
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
        "session.delta", "files.list", "files.diff", "terminal.io",
        "preview.control", "files.search", "transcript.search",
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

    /// Connect to a t4-host over host-wire, handshake, and load the inventory.
    func connect(endpoint: URL, identity: ClientIdentity, authentication: DeviceAuthentication? = nil) async {
        connecting = true
        defer { connecting = false }
        let transport = makeTransport(endpoint: endpoint)
        let c = HostClient(transport: transport, config: HostClient.Config(identity: identity, authentication: authentication, requestedFeatures: Self.clientFeatures))
        let generation = await replaceConnection(with: c)
        do {
            let welcome = try await c.connect()
            guard generation == connectionGeneration, client === c else {
                await c.close()
                return
            }
            hostId = welcome.hostId
            hostInfo = HostInfo(hostId: welcome.hostId, ompVersion: welcome.ompVersion, appserverVersion: welcome.appserverVersion)
            grantedCapabilities = welcome.grantedCapabilities
            grantedFeatures = Set(welcome.grantedFeatures)
            connected = welcome.authentication == .paired || welcome.authentication == .local
            if connected {
                pairedEndpoint = endpoint.absoluteString
                persist(endpoint: endpoint, authentication: authentication)
                await refresh()
                await loadCatalog()
                observationTask = Task { [weak self] in
                    await self?.observe(client: c, generation: generation, expectedHostId: welcome.hostId)
                }
            } else {
                t4log.error("connect: auth not accepted (\(welcome.authentication.rawValue, privacy: .public))")
            }
        } catch {
            if generation == connectionGeneration, client === c {
                await c.close()
                client = nil
                clearHostScopedState()
            }
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
        let transport = makeTransport(endpoint: endpoint)
        let identity = ClientIdentity(name: "t4-ios", version: "0.1", build: "dev", platform: "ios")
        let c = HostClient(transport: transport, config: HostClient.Config(identity: identity, authentication: nil, requestedFeatures: Self.clientFeatures))
        let generation = await replaceConnection(with: c)
        do {
            let welcome = try await c.connect()
            guard generation == connectionGeneration, client === c else {
                await c.close()
                return
            }
            hostId = welcome.hostId
            hostInfo = HostInfo(hostId: welcome.hostId, ompVersion: welcome.ompVersion, appserverVersion: welcome.appserverVersion)
            if welcome.authentication == .paired || welcome.authentication == .local {
                // Open host — no pairing round-trip needed.
                grantedCapabilities = welcome.grantedCapabilities
                grantedFeatures = Set(welcome.grantedFeatures)
                connected = true
                pairedEndpoint = endpoint.absoluteString
                persist(endpoint: endpoint, authentication: nil)
                await refresh()
                await loadCatalog()
                observationTask = Task { [weak self] in
                    await self?.observe(client: c, generation: generation, expectedHostId: welcome.hostId)
                }
                return
            }
            let deviceId = try Self.installationDeviceId()
            let intent = PairStartIntent(
                code: code,
                deviceId: deviceId,
                deviceName: deviceName,
                platform: "ios",
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
            if generation == connectionGeneration, client === c {
                await c.close()
                client = nil
                clearHostScopedState()
            }
            lastError = "Pairing failed — check the code and that the host is running (\(error))"
        }
    }

    private static func installationDeviceId() throws -> String {
        if let existing = try Keychain.read(installationDeviceIdKey), !existing.isEmpty {
            return existing
        }
        let created = "ios-\(UUID().uuidString.lowercased())"
        guard Keychain.set(created, forKey: installationDeviceIdKey) else {
            throw Keychain.AccessError(operation: "write", status: errSecIO)
        }
        return created
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

    // MARK: - Files (read-only workspace browser)

    /// List a directory in the session workspace (files.list). `path` is a
    /// safe relative POSIX path; pass "" for the project root — the host
    /// treats an absent/empty path as the workspace root. Returns the
    /// entries (folders and files) or nil on failure (lastError is set).
    /// NOTE: files.* is a desktop-bridge operation — standalone official
    /// hosts don't implement it; the pane shows the honest failure.
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
            lastError = "This host has no files bridge (desktop hosts only)."
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

    /// Read a binary file (e.g. an image) as `Data`. Reuses `readFile` (the
    /// same files.read wire call) and base64-decodes the payload the host
    /// returns for non-text files. Returns nil on failure or if the content
    /// isn't valid base64 (text files, truncated reads). Used for file-pane
    /// image thumbnails.
    func readFileData(sessionId: String, path: String) async -> Data? {
        guard let content = await readFile(sessionId: sessionId, path: path) else { return nil }
        return Data(base64Encoded: content)
    }

    // MARK: - Files search & diff
    // files.search (capability files.list, session scope, revision optional)
    // searches the workspace by file-name substring; the host returns up to
    // PROJECT_FILE_SEARCH_MAX_RESULTS (50) matches as safe relative paths plus
    // a `truncated` flag. files.diff (capability files.diff) returns either
    // `{diff}` patch text (no turnId) or a turn review snapshot `{turnId,
    // baseTree, headTree, changes, patch?}` (turnId set); the snapshot's patch
    // artifact is read via artifact.read. Both are desktop-bridge operations —
    // standalone hosts don't implement them; the pane shows the honest failure.

    /// Search the session workspace by file name (files.search). `query` is a
    /// substring; the host returns up to 50 matches as safe relative paths.
    /// Returns the matches or nil on failure (lastError is set).
    func filesSearch(sessionId: String, query: String) async -> FilesSearchResult? {
        guard let client, connected, !hostId.isEmpty else {
            lastError = "Not connected to a host."
            return nil
        }
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return FilesSearchResult(matches: [], truncated: false) }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "files.search",
                args: ["query": .string(trimmed)], sessionId: sessionId))
            return Self.decodeFilesSearchResult(result)
        } catch {
            t4log.error("files.search failed: \(error)")
            lastError = "This host has no files bridge (desktop hosts only)."
            return nil
        }
    }

    /// Fetch a unified diff for the session workspace (files.diff). With no
    /// `turnId` the host returns `{diff}` patch text; with a `turnId` it
    /// returns a turn review snapshot whose `patch` artifact is read via
    /// artifact.read. Returns the patch text (and change list when available)
    /// or nil on failure (lastError is set).
    func filesDiff(sessionId: String, turnId: String? = nil) async -> FilesDiffResult? {
        guard let client, connected, !hostId.isEmpty else {
            lastError = "Not connected to a host."
            return nil
        }
        var args: [String: JSONValue] = [:]
        if let turnId, !turnId.isEmpty { args["turnId"] = .string(turnId) }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "files.diff", args: args, sessionId: sessionId))
            guard result.ok, let body = result.result, case .object(let o) = body else {
                lastError = "files.diff returned no result."
                return nil
            }
            // {diff} patch-text shape (no turnId).
            if case .string(let diff) = o["diff"] ?? .null {
                return FilesDiffResult(patchText: diff, changes: [])
            }
            // Turn review snapshot shape (turnId present).
            let changes = Self.parseTurnChanges(o["changes"] ?? .null)
            var patchText: String?
            if case .object(let pd) = o["patch"] ?? .null,
               case .string(let artifactId) = pd["artifactId"] ?? .null {
                if let chunk = await artifactRead(sessionId: sessionId, artifactId: artifactId),
                   let data = chunk.decodedBytes {
                    patchText = String(data: data, encoding: .utf8)
                }
            }
            return FilesDiffResult(patchText: patchText, changes: changes)
        } catch {
            t4log.error("files.diff failed: \(error)")
            lastError = "This host has no files bridge (desktop hosts only)."
            return nil
        }
    }

    /// Decode a files.search result body `{matches: [{path}], truncated}`.
    private static func decodeFilesSearchResult(_ result: ResultFrame) -> FilesSearchResult? {
        guard result.ok, let body = result.result, case .object(let o) = body else { return nil }
        let truncated = (o["truncated"] ?? .null) == .bool(true)
        let matches: [FilesSearchMatch] = {
            guard case .array(let arr) = o["matches"] ?? .null else { return [] }
            return arr.compactMap { v in
                guard case .object(let m) = v, case .string(let p) = m["path"] ?? .null else { return nil }
                return FilesSearchMatch(path: p)
            }
        }()
        return FilesSearchResult(matches: matches, truncated: truncated)
    }

    /// Parse a turn review snapshot's `changes` array into typed rows.
    private static func parseTurnChanges(_ value: JSONValue) -> [TurnFileChange] {
        guard case .array(let arr) = value else { return [] }
        return arr.compactMap { v in
            guard case .object(let c) = v,
                  case .string(let path) = c["path"] ?? .null,
                  case .string(let status) = c["status"] ?? .null,
                  case .string(let kind) = c["kind"] ?? .null else { return nil }
            return TurnFileChange(path: path, status: status, kind: kind,
                                  additions: intField(c["additions"]),
                                  deletions: intField(c["deletions"]))
        }
    }

    /// Extract a non-negative integer from a JSON number field (0 otherwise).
    private static func intField(_ value: JSONValue?) -> Int {
        if case .number(let n) = value, n.isFinite, n >= 0 { return Int(n) }
        return 0
    }

    // MARK: - Terminal drawer
    // term.open is a session-scoped command (capability term.open, revision
    // optional) that opens a pty and returns {terminalId}. Output arrives as
    // terminal.output additive frames (routed in observe()); the client sends
    // terminal.input/terminal.resize/terminal.close as raw additive frames
    // via HostClient.sendFrame (no requestId, no response). If the host denies
    // term.open (the paired device lacks the capability), the command throws
    // and lastError surfaces — the drawer shows an error row.

    /// Open another terminal for a session (term.open {cols, rows}). Appends
    /// the new terminalId to the session's ordered list (max 4) and makes it
    /// the active tab. Returns the new terminalId, or nil on failure
    /// (lastError / terminalErrors set). Callers that only need *a* terminal
    /// should check `activeTerminal(sessionId:)` first and call this solely to
    /// add a new tab — this method always opens a fresh pty.
    @discardableResult
    func openTerminal(sessionId: String, cols: Int = 80, rows: Int = 24) async -> String? {
        guard let client, connected, !hostId.isEmpty else {
            lastError = "Not connected to a host."
            return nil
        }
        let ids = openTerminalIds[sessionId] ?? []
        guard ids.count < 4 else {
            lastError = "Terminal limit reached (4)."
            terminalErrors[sessionId] = "Terminal limit reached (4)."
            return nil
        }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "term.open",
                args: ["cols": .number(Double(cols)), "rows": .number(Double(rows))],
                sessionId: sessionId))
            let terminalId = try result.termOpenResult()
            openTerminalIds[sessionId, default: []].append(terminalId)
            activeTerminalId[sessionId] = terminalId
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

    /// The active terminal id for a session (the tab the drawer renders and
    /// the target of input/resize), or nil when no terminal is open.
    func activeTerminal(sessionId: String) -> String? { activeTerminalId[sessionId] }

    /// Switch the active tab for a session. No-op if `terminalId` is not in
    /// the session's open list. Instant for the drawer — it re-renders the
    /// active terminal's buffered output without re-opening the pty.
    func selectTerminal(sessionId: String, terminalId: String) {
        guard (openTerminalIds[sessionId] ?? []).contains(terminalId) else { return }
        activeTerminalId[sessionId] = terminalId
    }

    /// Send user keystrokes to the session's active pty (terminal.input). No-op
    /// when no terminal is active or not connected. `data` is UTF-8 text.
    func sendTerminalInput(sessionId: String, data: String) async {
        guard let client, let terminalId = activeTerminalId[sessionId] else { return }
        let frame = TerminalInputFrame(hostId: hostId, sessionId: sessionId, terminalId: terminalId, data: data)
        try? await client.sendFrame(frame)
    }

    /// Resize the session's active pty (terminal.resize {cols, rows}). No-op
    /// when no terminal is active for the session.
    func resizeTerminal(sessionId: String, cols: Int, rows: Int) async {
        guard let client, let terminalId = activeTerminalId[sessionId] else { return }
        let frame = TerminalResizeFrame(hostId: hostId, sessionId: sessionId, terminalId: terminalId, cols: cols, rows: rows)
        try? await client.sendFrame(frame)
    }

    /// Close the session's active pty (terminal.close). Convenience for the
    /// drawer's close control on the active tab; delegates to the per-terminal
    /// close, which removes the id and selects a neighbor as active.
    func closeTerminal(sessionId: String, reason: String? = nil) async {
        guard let terminalId = activeTerminalId[sessionId] else { return }
        await closeTerminal(terminalId: terminalId, reason: reason)
    }

    /// Close a specific pty by terminalId (terminal.close). Removes the id
    /// from its session's ordered list and, if it was active, selects a
    /// neighbor (the next tab, or the previous when closing the last) as the
    /// new active tab. When the last terminal closes, the session has no
    /// active terminal and the drawer shows its empty state.
    func closeTerminal(terminalId: String, reason: String? = nil) async {
        guard let sessionId = openTerminalIds.first(where: { $0.value.contains(terminalId) })?.key else { return }
        if let client {
            let frame = TerminalCloseFrame(hostId: hostId, sessionId: sessionId, terminalId: terminalId, reason: reason)
            try? await client.sendFrame(frame)
        }
        removeTerminal(terminalId, sessionId: sessionId)
    }

    /// Remove a terminal from a session's list and reselect the active tab.
    /// Shared by `closeTerminal(terminalId:)` and `clearTerminal`. Does not
    /// send terminal.close — callers handle the wire frame (or transport is
    /// gone, in the clear case).
    private func removeTerminal(_ terminalId: String, sessionId: String) {
        var ids = openTerminalIds[sessionId] ?? []
        guard let removed = ids.firstIndex(where: { $0 == terminalId }) else { return }
        ids.remove(at: removed)
        terminalOutput.removeValue(forKey: terminalId)
        terminalExits.removeValue(forKey: terminalId)
        if ids.isEmpty {
            openTerminalIds.removeValue(forKey: sessionId)
            activeTerminalId.removeValue(forKey: sessionId)
        } else {
            openTerminalIds[sessionId] = ids
            // Reselect only when the closed tab was active (or active is
            // missing); otherwise leave the user's selection alone.
            if activeTerminalId[sessionId] == nil || activeTerminalId[sessionId] == terminalId {
                let neighborIdx = min(removed, ids.count - 1)
                activeTerminalId[sessionId] = ids[neighborIdx]
            }
        }
    }

    /// Drop all terminal state for a session (e.g. on disconnect). Does not
    /// send terminal.close — the transport is gone.
    func clearTerminal(sessionId: String) {
        for terminalId in openTerminalIds[sessionId] ?? [] {
            terminalOutput.removeValue(forKey: terminalId)
            terminalExits.removeValue(forKey: terminalId)
        }
        openTerminalIds.removeValue(forKey: sessionId)
        activeTerminalId.removeValue(forKey: sessionId)
        terminalErrors.removeValue(forKey: sessionId)
    }

    // MARK: - Browser pane
    // The browser pane (T4BrowserPane) renders any http(s) URL directly in a
    // WKWebView — it needs no host support. When the host DOES offer previews
    // (capability preview.control/preview.read), `openPreview` opportunistically
    // fires `preview.launch {url}` so the host's own preview pipeline (captures,
    // navigation state) tracks the same URL, and records the returned previewId
    // so the pane's Capture button can fire `preview.capture`. If the host lacks
    // preview support, `preview.launch` errors and we no-op gracefully — the
    // pane keeps rendering the URL directly regardless. `previewCapture`
    // triggers a capture and reassembles its chunked bytes into a PlatformImage;
    // `preview.capture` push frames (observe()) flow into the transcript as
    // image rows and auto-fetch their bytes.

    /// The default URL a session's browser opens to when none is persisted.
    /// A dev server on localhost:3000 is the common case for T4 sessions.
    static let defaultBrowserURL = "http://localhost:3000"

    /// The persisted browser URL for a session, or the default when unset.
    func browserURL(for sessionId: String) -> String {
        browserURLBySession[sessionId] ?? Self.defaultBrowserURL
    }

    /// Persist the browser URL for a session (the pane's URL field calls this
    /// on submit and on navigation). Idempotent; no host round-trip.
    func setBrowserURL(for sessionId: String, url: String) {
        browserURLBySession[sessionId] = url
    }

    /// Opportunistically ask the host to launch a preview for `url`
    /// (preview.launch). No-op when not connected or when the host lacks
    /// preview support — the pane renders the URL directly in WKWebView
    /// regardless of the outcome here. A failure is expected for unsupported
    /// hosts and is swallowed (lastError is preserved) so an unsupported
    /// preview never surfaces a spurious error to the user. On success the
    /// returned previewId is recorded in `previewIdBySession` so the Capture
    /// button can target it.
    func openPreview(sessionId: String, url: String) async {
        guard let client, connected, !hostId.isEmpty else { return }
        // Devices paired before preview caps existed get connection-killed on
        // unauthorized commands — skip instead (the pane renders the URL fine).
        guard grantedCapabilities.contains("preview.control") else { return }
        let priorError = lastError
        // preview.launch is a mutation: the host requires a live controller
        // lease and denies (closing the connection) without one.
        await withLease(sessionId: sessionId, kind: .controller) { leaseId in
            guard let revision = revision(of: sessionId) else { return }
            do {
                let result = try await client.sendCommand(CommandIntent(
                    hostId: hostId, command: "preview.launch",
                    args: ["url": .string(url), "leaseId": .string(leaseId)],
                    sessionId: sessionId, expectedRevision: revision))
                let snapshot = try result.previewMutationResult()
                previewIdBySession[sessionId] = snapshot.previewId
            } catch {
                // Unsupported hosts (no preview.control capability) error here —
                // swallow so the pane keeps rendering the URL directly. Preserve
                // the prior error so a preview failure never surfaces a spurious
                // error to the user.
                lastError = priorError
            }
        }
    }

    /// Capture a preview screenshot and reassemble its bytes into a platform
    /// image. Sends `preview.capture` (which triggers a capture and returns
    /// the snapshot + capture metadata), then streams the bytes via repeated
    /// `preview.capture.read` calls (≤256KiB base64 chunks, ordered by
    /// offset) until `complete`. The reassembled bytes are sha256-verified
    /// against the metadata, decoded to a `PlatformImage`, cached by
    /// captureId, and appended as a transcript capture row. `previewId`
    /// defaults to the session's latest tracked preview. Returns nil when not
    /// connected, the host lacks preview support, or the bytes fail to decode
    /// (lastError is set).
    @discardableResult
    func previewCapture(sessionId: String, previewId: String? = nil) async -> PlatformImage? {
        guard let client, connected, !hostId.isEmpty else {
            lastError = "Not connected to a host."
            return nil
        }
        guard grantedCapabilities.contains("preview.control") else { return nil }
        let pid = previewId ?? previewIdBySession[sessionId]
        guard let pid else {
            lastError = "No preview available for this session."
            return nil
        }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "preview.capture",
                args: ["previewId": .string(pid)], sessionId: sessionId))
            let snapshot = try result.previewMutationResult()
            previewIdBySession[sessionId] = snapshot.previewId
            guard let meta = snapshot.capture else {
                lastError = "Preview returned no capture."
                return nil
            }
            recordCapture(sessionId: sessionId, metadata: meta, previewId: snapshot.previewId)
            return await fetchCaptureBytes(sessionId: sessionId, previewId: snapshot.previewId, metadata: meta)
        } catch {
            t4log.error("preview.capture failed: \(error)")
            lastError = "\(error)"
            return nil
        }
    }

    /// The latest decoded capture image for a session (the browser pane's
    /// Capture view renders this), or nil when no capture has resolved yet.
    func latestCaptureImage(for sessionId: String) -> PlatformImage? {
        guard let row = previewCaptureRowsBySession[sessionId]?.last else { return nil }
        return row.image ?? previewCaptureImages[row.captureId]
    }

    /// Record a capture as it arrives: append a transcript image row (so
    /// captures flow into the transcript) and a capture row (image pending).
    /// Idempotent per captureId — re-arriving frames update in place.
    private func recordCapture(sessionId: String, metadata: PreviewCaptureMetadata, previewId: String) {
        upsertCaptureRow(sessionId: sessionId, metadata: metadata, previewId: previewId, image: nil)
        appendCaptureTranscriptRow(sessionId: sessionId, metadata: metadata, previewId: previewId)
    }

    /// Insert or update the capture row for a session (keyed by captureId).
    /// When the image resolves, the matching row's `image` is set so the
    /// transcript / pane render pixels.
    private func upsertCaptureRow(sessionId: String, metadata: PreviewCaptureMetadata, previewId: String, image: PlatformImage?) {
        var rows = previewCaptureRowsBySession[sessionId] ?? []
        if let index = rows.firstIndex(where: { $0.captureId == metadata.captureId }) {
            rows[index].image = image
        } else {
            rows.append(PreviewCaptureRow(metadata: metadata, previewId: previewId, image: image))
        }
        previewCaptureRowsBySession[sessionId] = rows
    }

    /// Append a synthetic `preview-capture` transcript entry for a capture so
    /// it flows into the transcript as an image row. The entry's `data`
    /// carries `captureId`/`previewId`/`mimeType`/`width`/`height`; the
    /// transcript view renders the image by looking up `data.captureId` in
    /// `previewCaptureImages`. Idempotent per captureId (de-duped by id).
    private func appendCaptureTranscriptRow(sessionId: String, metadata: PreviewCaptureMetadata, previewId: String) {
        let entryId = metadata.captureId
        let payload: JSONValue = .object([
            "id": .string(entryId),
            "hostId": .string(hostId),
            "sessionId": .string(sessionId),
            "kind": .string("preview-capture"),
            "timestamp": .string("\(metadata.capturedAt)"),
            "data": .object([
                "captureId": .string(metadata.captureId),
                "previewId": .string(previewId),
                "mimeType": .string(metadata.mimeType.rawValue),
                "width": .number(Double(metadata.width)),
                "height": .number(Double(metadata.height)),
            ]),
        ])
        guard let data = try? JSONEncoder().encode(payload),
              let entry = try? TranscriptEntry.decode(data) else { return }
        var entries = liveEntries[sessionId] ?? []
        if !entries.contains(where: { $0.id == entryId }) {
            entries.append(entry)
            liveEntries[sessionId] = entries
        }
    }

    /// Stream a capture's bytes via `preview.capture.read` (ordered chunks) and
    /// reassemble into a `PlatformImage`. Verifies the sha256 digest, decodes
    /// the bytes, caches the image by captureId, and updates the session's
    /// capture row. Returns nil on a bounds/hash/decode mismatch (lastError
    /// is set).
    private func fetchCaptureBytes(sessionId: String, previewId: String, metadata: PreviewCaptureMetadata) async -> PlatformImage? {
        guard let client else { return nil }
        do {
            var bytes = Data()
            bytes.reserveCapacity(metadata.size)
            var offset = 0
            while offset < metadata.size {
                let result = try await client.sendCommand(CommandIntent(
                    hostId: hostId, command: "preview.capture.read",
                    args: ["previewId": .string(previewId),
                           "captureId": .string(metadata.captureId),
                           "offset": .number(Double(offset))],
                    sessionId: sessionId))
                let chunk = try result.previewCaptureReadResult()
                guard chunk.previewId == previewId, chunk.captureId == metadata.captureId,
                      chunk.offset == offset, chunk.size == metadata.size else {
                    throw T4WireError.invalidFrame(path: "result", reason: "preview capture chunk identity or offset mismatch")
                }
                guard let part = chunk.decodedBytes, part.count == chunk.nextOffset - offset else {
                    throw T4WireError.invalidFrame(path: "result.content", reason: "preview capture chunk size mismatch")
                }
                bytes.append(part)
                offset = chunk.nextOffset
            }
            guard bytes.count == metadata.size else {
                throw T4WireError.bounds(path: "result", reason: "preview capture size mismatch")
            }
            let digest = SHA256.hash(data: bytes)
            let hex = digest.map { String(format: "%02x", $0) }.joined()
            guard hex == metadata.sha256 else {
                throw T4WireError.invalidFrame(path: "capture.sha256", reason: "preview capture hash mismatch")
            }
            guard let image = platformImage(data: bytes) else {
                lastError = "Preview capture bytes did not decode to an image."
                return nil
            }
            previewCaptureImages[metadata.captureId] = image
            upsertCaptureRow(sessionId: sessionId, metadata: metadata, previewId: previewId, image: image)
            return image
        } catch {
            t4log.error("preview.capture.read failed: \(error)")
            lastError = "\(error)"
            return nil
        }
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
        // Official-mode hosts don't implement usage.read; firing it anyway
        // makes the host close the connection (remote-policy denial).
        guard grantedCapabilities.contains("usage.read") else { return nil }
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

    /// The wire's settings.read carries metadata entries ({type, effective}),
    /// not bare values. Unwrap to the raw map the panes consume — entries that
    /// are already bare (bridge hosts) pass through untouched.
    private static func unwrapSettingsMetadata(_ settings: [String: JSONValue]) -> [String: JSONValue] {
        settings.mapValues { value in
            guard case .object(let entry) = value,
                  entry["type"] != nil,
                  let effective = entry["effective"]
            else { return value }
            return effective
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
        // Same guard as usageRead: hosts without a settings backend close
        // the connection on unauthorized commands.
        guard grantedCapabilities.contains("config.read") else { return nil }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "settings.read"))
            let read = try result.settingsReadResult()
            let settings = Self.unwrapSettingsMetadata(read.settings)
            settingsSnapshot = settings
            settingsRevision = read.revision
            return settings
        } catch {
            t4log.error("settings.read failed: \(error)")
            lastError = "\(error)"
            return nil
        }
    }

    /// Write a partial settings object (settings.write, host scope, revision
    /// required). `patch` is merged into the host settings; the host may answer
    /// with a confirmation challenge instead of a result — that surfaces as
    /// `pendingConfirmation` via observe() and the banner handles approve/deny.
    /// Send without a confirmationId so the host issues the challenge; the
    /// store's pendingConfirmation banner then drives the confirm() flow.
    /// On success the new revision is captured from the result and the
    /// snapshot re-read so masked values (providerKeys) stay authoritative.
    /// Returns false on failure (lastError is set).
    @discardableResult
    func settingsWrite(patch: [String: JSONValue]) async -> Bool {
        guard let client, connected, !hostId.isEmpty else {
            lastError = "Not connected to a host."
            return false
        }
        guard grantedCapabilities.contains("config.write") else {
            lastError = "Settings writes require the config.write capability."
            return false
        }
        guard let revision = settingsRevision else {
            lastError = "Settings revision unknown — load settings first."
            return false
        }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "settings.write",
                args: patch, expectedRevision: revision))
            // Result body: {written: true, revision: <new>}. Capture the new
            // revision so the next write is conflict-free, then re-read to
            // refresh the snapshot (the host is the source of truth, esp. for
            // masked providerKeys).
            if let echo = try result.settingsWriteResult(),
               case .string(let newRev) = echo["revision"] ?? .null, !newRev.isEmpty {
                settingsRevision = newRev
            }
            await settingsRead()
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
    private func observe(client: HostClient, generation: UInt64, expectedHostId: String) async {
        for await frame in await client.frames {
            guard !Task.isCancelled,
                  generation == connectionGeneration,
                  self.client === client,
                  hostId == expectedHostId else { return }
            switch frame {
            case .sessions(let inventory):
                sessions = inventory.sessions
                // Drop unread markers for sessions no longer in the inventory.
                unreadSessions.formIntersection(Set(inventory.sessions.map(\.sessionId)))
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
                let wasKnown = liveEntries[sid]?.contains(where: { $0.id == entry.id }) == true
                if shouldDeferTranscriptEntry(entry, sessionId: sid) {
                    enqueuePendingTranscriptEntry(entry, sessionId: sid)
                    finishPendingTranscriptEntries(sessionId: sid)
                } else {
                    appendDurableEntry(entry, sessionId: sid)
                    settleLiveProjection(for: entry, sessionId: sid)
                }
                if !wasKnown {
                    // A durable entry on a session the user isn't viewing → unread dot.
                    if sid != selectedSession?.sessionId {
                        unreadSessions.insert(sid)
                    }
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
                    streamingText.removeValue(forKey: sid)
                    if liveTurns[sid] == nil {
                        finishPendingToolEntries(sessionId: sid)
                        toolStreamingTasks.removeValue(forKey: sid)?.cancel()
                        liveTools.removeValue(forKey: sid)
                    } else {
                        scheduleLiveTurnFrames(sessionId: sid)
                    }
                    Task { await refreshTodos(sessionId: sid) }
                case "assistant.block.update":
                    receiveLiveTurnBlock(sessionId: sid, event: frame.event)
                case "message.update":
                    // Only stream the assistant voice; user echoes are sent
                    // by the client itself and settle immediately.
                    if case .string(let role) = frame.event.fields["role"], role == "assistant",
                       case .string(let text) = frame.event.fields["text"] {
                        streamingText[sid] = text
                        let reasoning: String
                        if case .string(let value) = frame.event.fields["reasoning"] { reasoning = value }
                        else { reasoning = "" }
                        receiveStreamingMessage(sessionId: sid, text: text, reasoning: reasoning)
                    }
                case "message.settled":
                    break
                case "message.discarded":
                    streamingText.removeValue(forKey: sid)
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
                t4log.notice("preview error \(f.code, privacy: .public): \(f.message, privacy: .public)")
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
        connectionGeneration &+= 1
        observationTask?.cancel()
        observationTask = nil
        await client?.close()
        client = nil
        clearHostScopedState()
        pairedEndpoint = nil
        localAutoconnect = false
        Keychain.remove(forKey: Self.savedEndpointKey)
        Keychain.remove(forKey: Self.savedDeviceIdKey)
        Keychain.remove(forKey: Self.savedDeviceTokenKey)
    }

    private func replaceConnection(with next: HostClient) async -> UInt64 {
        connectionGeneration &+= 1
        let generation = connectionGeneration
        observationTask?.cancel()
        observationTask = nil
        if let previous = client { await previous.close() }
        clearHostScopedState()
        client = next
        return generation
    }

    private func clearHostScopedState() {
        connected = false
        hostId = ""
        hostInfo = nil
        grantedCapabilities.removeAll()
        grantedFeatures.removeAll()
        sessions.removeAll()
        selectedSession = nil
        unreadSessions.removeAll()
        liveEntries.removeAll()
        streamingText.removeAll()
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
        activeTurns.removeAll()
        todoPhasesBySession.removeAll()
        catalog.removeAll()
        pendingConfirmation = nil
        pendingAsk = nil
        pagingState.removeAll()
        agentsBySession.removeAll()
        terminalOutput.removeAll()
        terminalExits.removeAll()
        openTerminalIds.removeAll()
        activeTerminalId.removeAll()
        terminalErrors.removeAll()
        browserURLBySession.removeAll()
        reviewsBySession.removeAll()
        usageSnapshot = nil
        settingsSnapshot = nil
        settingsRevision = nil
        artifactChunks.removeAll()
        previewIdBySession.removeAll()
        previewCaptureImages.removeAll()
        previewCaptureRowsBySession.removeAll()
        hasLiveInventory = false
    }

    // MARK: - Sample inventory (simulator preview without a live host)

    private static let sample: [SessionRef] = {
        let json = """
        [
        {"hostId":"studio-mac","sessionId":"s1","project":{"projectId":"t4code","name":"T4 Code"},"revision":"r1","title":"iOS session rail","status":"active","updatedAt":"2026-07-24T11:00:00Z","model":"gpt-5.2","pendingUserInput":true,"contextUsage":{"used":7,"limit":200}},
        {"hostId":"studio-mac","sessionId":"s2","project":{"projectId":"t4code","name":"T4 Code"},"revision":"r2","title":"Host-wire Swift port","status":"closed","updatedAt":"2026-07-20T08:00:00Z","model":"gpt-5.2"},
        {"hostId":"studio-mac","sessionId":"s3","project":{"projectId":"t4code","name":"T4 Code"},"revision":"r3","title":"Agent view","status":"idle","updatedAt":"2026-07-24T08:30:00Z","model":"devin/swe-1-7","contextUsage":{"used":88,"limit":200}},
        {"hostId":"studio-mac","sessionId":"s4","project":{"projectId":"t4code","name":"T4 Code"},"revision":"r4","title":"Hosts & usage","status":"active","updatedAt":"2026-07-24T12:10:00Z","model":"gpt-5.2","pendingApproval":true,"contextUsage":{"used":33,"limit":200}},
        {"hostId":"studio-mac","sessionId":"s5","project":{"projectId":"archive","name":"Archived work"},"revision":"r5","title":"Finished release audit","status":"closed","updatedAt":"2026-07-18T17:00:00Z","archivedAt":"2026-07-19T09:00:00.000Z","model":"gpt-5.2"}
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
    private static let sampleReviews: [ReviewFrame] = {
        let json = """
        {"v":"omp-app/1","type":"review","hostId":"studio-mac","sessionId":"s1","reviewId":"review-sample","status":"pending","path":"src/fixture.ts","findings":[{"severity":"warning","message":"Fixture review finding for the mobile application flow.","line":12}]}
        """
        return (try? JSONDecoder().decode(ReviewFrame.self, from: Data(json.utf8)))
            .map { [$0] } ?? []
    }()
}
