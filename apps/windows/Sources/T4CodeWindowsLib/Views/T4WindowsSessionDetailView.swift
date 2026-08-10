import Foundation
import SwiftCrossUI
import HostWire

/// Windows-owned core session surface. It keeps the shared store, models, pane
/// implementations, and wire actions while matching the desktop macOS geometry.
struct T4WindowsSessionDetailView: View {
    let session: SessionRef
    let store: T4SessionStore
    let theme: ThemeStore
    let inboxPresented: Binding<Bool>
    let onOpenInbox: () -> Void
    let onOpenPalette: () -> Void

    private let connectionModel: T4ConnectionInventoryModel
    private let transcriptModel: T4TranscriptProjectionModel
    private let promptModel: T4PromptLeaseModel

    @Environment(\.t4WindowWidth) private var windowWidth
    @State private var draft = ""
    @State private var sending = false
    @State private var showFacts = false
    @State private var planExpanded = false
    @State private var activeSheet: ActiveSheet?
    @State private var renaming = false
    @State private var renameText = ""
    @State private var ownershipBusy = false

    enum ActiveSheet: String, Identifiable {
        case files, agents, usage, review, artifacts, settings, browser, searchDiff
        var id: String { rawValue }
    }

    private let thinkingLevels = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]
    private var p: WindowsCorePalette { WindowsCorePalette(theme.effective) }
    private var t: Theme { theme.t }

    init(
        session: SessionRef,
        store: T4SessionStore,
        theme: ThemeStore,
        inboxPresented: Binding<Bool>,
        onOpenInbox: @escaping () -> Void,
        onOpenPalette: @escaping () -> Void
    ) {
        self.session = session
        self.store = store
        self.theme = theme
        self.inboxPresented = inboxPresented
        self.onOpenInbox = onOpenInbox
        self.onOpenPalette = onOpenPalette
        connectionModel = store.connectionModel
        transcriptModel = store.transcriptModel
        promptModel = store.promptModel
    }

    var body: some View {
        VStack(spacing: 0) {
            sessionHeader
            turnStatusStrip
            transportStrip
            if let sheet = activeSheet {
                HStack(spacing: 0) {
                    chatColumn
                    Divider(p.line)
                    paneSidebar(sheet)
                }
            } else {
                chatColumn
            }
        }
        .background(p.canvas)
        .task(id: session.sessionId) {
            await store.attach(sessionId: session.sessionId)
            applyAskSeam()
        }
        .onAppear { applyBootSeams() }
        .onChange(of: inboxPresented.wrappedValue) {
            if inboxPresented.wrappedValue { activeSheet = nil }
        }
        .sheet(isPresented: $renaming) { renameSheet }
    }
    private var titleParts: (leading: String, trailing: String) {
        let words = session.title.split(separator: " ").map(String.init)
        guard words.count > 1 else { return (session.title, "") }
        let split = max(1, words.count / 2)
        return (
            words.prefix(split).joined(separator: " "),
            words.dropFirst(split).joined(separator: " ")
        )
    }

    @ViewBuilder
    private var sessionTitle: some View {
        if windowWidth < 1200 {
            Text(session.title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(p.text)
                .lineLimit(1)
                .frame(width: windowWidth < 1000 ? 150 : 220, alignment: .leading)
        } else {
            HStack(spacing: 4) {
                Text(titleParts.leading).fixedSize()
                Text(titleParts.trailing).fixedSize()
            }
            .font(.system(size: 12, weight: .semibold))
            .foregroundColor(p.text)
            .frame(width: 320, alignment: .leading)
        }
    }


    private var sessionHeader: some View {
        HStack(spacing: 9) {
            sessionTitle
            Rectangle().fill(p.line).frame(width: 1, height: 17)
            Text("▧")
                .font(.system(size: 11))
                .foregroundColor(p.textMuted)
            Text(session.project.name ?? session.project.projectId)
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(p.textMuted)
                .lineLimit(1)
            Text("⌄")
                .font(.system(size: 9, weight: .bold))
                .foregroundColor(p.textFaint)
            Spacer(minLength: 10)
            statusLabel(compact: true)
            T4TextButton("Preview") { openSheet(.browser) }
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(p.textBody)
                .padding(.horizontal, 9)
                .frame(height: 26)
                .background { RoundedRectangle(cornerRadius: 7).fill(p.surfaceSubtle) }
            workspaceMenu
        }
        .padding(.horizontal, 12)
        .frame(height: 40)
        .background(p.appBar)
        .overlay(alignment: .bottom) { Rectangle().fill(p.line).frame(height: 1) }
    }

    private var workspaceMenu: some View {
        Menu("Workspace") {
            T4TextButton("Files") { openSheet(.files) }
            T4TextButton("Agents") { openSheet(.agents) }
            T4TextButton("Review") { openSheet(.review) }
            T4TextButton("Artifacts") { openSheet(.artifacts) }
            T4TextButton("Search & Diff") { openSheet(.searchDiff) }
            Divider()
            T4TextButton("Usage") { openSheet(.usage) }
            T4TextButton("Settings") { openSheet(.settings) }
            Divider()
            T4TextButton("Attention inbox") { onOpenInbox() }
            T4TextButton("Command palette") { onOpenPalette() }
            Divider()
            Menu("Session") {
                T4TextButton(store.pinnedSessionIds.contains(session.sessionId) ? "Unpin" : "Pin") {
                    store.setSessionPinned(
                        session.sessionId,
                        pinned: !store.pinnedSessionIds.contains(session.sessionId)
                    )
                }
                if store.railSort == .manual {
                    T4TextButton("Move up") { store.moveSession(session, direction: -1) }
                    T4TextButton("Move down") { store.moveSession(session, direction: 1) }
                }
                if let control = session.sessionControl {
                    if control.t4Presentation.canFork && store.canForkSessions {
                        T4TextButton("Continue in a Copy") {
                            runOwnershipAction { await store.forkSession(sessionId: session.sessionId) }
                        }
                    }
                    if case .released = control {
                        T4TextButton("Bring Back to App") {
                            runOwnershipAction {
                                await store.reclaimSession(sessionId: session.sessionId)
                                return ()
                            }
                        }
                    }
                } else if session.archivedAt == nil {
                    T4TextButton("Archive") {
                        Task { await store.archiveSession(sessionId: session.sessionId) }
                    }
                    .disabled(!store.connected)
                } else {
                    T4TextButton("Restore") {
                        Task { await store.restoreSession(sessionId: session.sessionId) }
                    }
                    .disabled(!store.connected)
                }
                Divider()
                T4TextButton("Rename") {
                    renameText = session.title
                    renaming = true
                }
                T4TextButton("Compact") {
                    Task { await store.compactSession(sessionId: session.sessionId) }
                }
                T4TextButton("Retry") {
                    Task { await store.retrySession(sessionId: session.sessionId) }
                }
                T4TextButton("Close") {
                    Task { await store.closeSession(sessionId: session.sessionId) }
                }
                .disabled(session.status == "closed")
                T4TextButton("Delete") {
                    Task { await store.deleteSession(sessionId: session.sessionId) }
                }
            }
        }
        ._buttonWidth(94)
        .font(.system(size: 10, weight: .semibold))
    }

    private var turnStatusStrip: some View {
        HStack(spacing: 10) {
            Spacer()
            statusLabel(compact: false)
            if transcriptModel.activeTurns.contains(session.sessionId) {
                Text("Live turn")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(p.textFaint)
            }
            if let badge = modeBadgeText {
                Text(badge)
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(p.violet)
            }
            Spacer()
        }
        .frame(height: 34)
        .background(p.canvas)
        .overlay(alignment: .bottom) { Rectangle().fill(p.line).frame(height: 1) }
    }

    private var transportStrip: some View {
        HStack(spacing: 7) {
            Circle()
                .fill(connectionModel.connected ? p.success : p.textFaint)
                .frame(width: 6, height: 6)
            HStack(spacing: 4) {
                Text("Codex").fixedSize()
                Text("transport").fixedSize()
            }
            .font(.system(size: 11, weight: .semibold))
            .foregroundColor(p.textBody)
            .frame(width: 108, alignment: .leading)
            Text("WEBSOCKET")
                .font(.system(size: 8, weight: .semibold, design: .monospaced))
                .foregroundColor(p.textMuted)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background { RoundedRectangle(cornerRadius: 5).fill(p.surface) }
            Text(connectionModel.connected ? "Connected" : "Offline")
                .font(.system(size: 10))
                .foregroundColor(p.textMuted)
            Spacer()
            T4ModelMenuButton(
                session: session,
                store: store,
                theme: t,
                label: T4ModelLabel.labelString(session.model ?? "Model")
            )
            .font(.system(size: 10))
            T4TextButton(showFacts ? "Hide details" : "Details") {
                showFacts.toggle()
            }
            .font(.system(size: 10, weight: .medium))
            .foregroundColor(showFacts ? p.accent : p.textMuted)
        }
        .padding(.horizontal, 12)
        .frame(height: 35)
        .background(p.surfaceSubtle)
        .overlay(alignment: .bottom) { Rectangle().fill(p.line).frame(height: 1) }
    }

    private var chatColumn: some View {
        VStack(spacing: 0) {
            ScrollView {
                HStack(spacing: 0) {
                    Spacer(minLength: 16)
                    VStack(alignment: .leading, spacing: 13) {
                        loadEarlierSection
                        if let challenge = promptModel.pendingConfirmation {
                            confirmationBanner(challenge)
                        }
                        if showFacts { facts }
                        T4WindowsTranscriptView(
                            entries: store.transcript(for: session.sessionId),
                            liveTurn: transcriptModel.liveTurns[session.sessionId],
                            streamingMessage: transcriptModel.streamingMessages[session.sessionId],
                            liveTools: transcriptModel.liveTools[session.sessionId] ?? LiveToolProjection(),
                            palette: p
                        )
                    }
                    .frame(maxWidth: 700, alignment: .leading)
                    .padding(.vertical, 18)
                    Spacer(minLength: 16)
                }
            }
            .environment(\.scrollAnchorsToBottom, true)

            HStack(spacing: 0) {
                Spacer(minLength: 14)
                VStack(spacing: 7) {
                    pendingAskCard
                    planStripSection
                    composer
                }
                .frame(maxWidth: 690)
                Spacer(minLength: 14)
            }
            .padding(.bottom, 14)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(p.canvas)
    }

    @ViewBuilder
    private var pendingAskCard: some View {
        if let ask = promptModel.pendingAsk, ask.sessionId == session.sessionId {
            T4WindowsAskCard(ask: ask, palette: p) { value in
                Task { await store.respondAsk(value: value) }
            }
        }
    }

    private var planStripSection: some View {
        Group {
            if !store.todoPhases(for: session.sessionId).isEmpty {
                T4WindowsPlanStrip(
                    phases: store.todoPhases(for: session.sessionId),
                    palette: p,
                    expanded: $planExpanded
                )
            }
        }
    }

    private var composer: some View {
        VStack(spacing: 0) {
            if let control = session.sessionControl {
                ownershipComposer(control)
            } else {
                TextField(placeholder, text: $draft)
                    .font(.system(size: 13))
                    .foregroundColor(p.text)
                    .disabled(!inputEnabled)
                    .onSubmit(perform: send)
                    .padding(.horizontal, 12)
                    .frame(minHeight: 43)

                Rectangle().fill(p.line).frame(height: 1)

                HStack(spacing: 7) {
                    T4ModelMenuButton(
                        session: session,
                        store: store,
                        theme: t,
                        label: "Default"
                    )
                    .font(.system(size: 9))
                    thinkingMenu
                    fastButton
                    modeMenu
                    Spacer(minLength: 4)
                    contextLabel
                    Text("+")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundColor(p.textFaint)
                    sendButton
                }
                .padding(.horizontal, 10)
                .frame(height: 36)
            }
        }
        .background {
            RoundedRectangle(cornerRadius: 14).fill(p.lineStrong)
            RoundedRectangle(cornerRadius: 14).fill(p.surface).padding(1)
        }
    }

    private var thinkingMenu: some View {
        Menu((session.thinking ?? "medium").capitalized) {
            ForEach(thinkingLevels, id: \.self) { level in
                T4TextButton(level == session.thinking ? "✓ \(level)" : level) {
                    Task { await store.setThinking(sessionId: session.sessionId, level: level) }
                }
            }
        }
        .font(.system(size: 9))
    }

    private var fastButton: some View {
        let enabled = promptModel.fastBySession[session.sessionId] ?? false
        return T4TextButton("Fast") {
            Task { await store.setFast(sessionId: session.sessionId, enabled: !enabled) }
        }
        .font(.system(size: 9, weight: enabled ? .semibold : .regular))
        .foregroundColor(enabled ? p.accent : p.textMuted)
    }

    private var modeMenu: some View {
        let current = session.mode ?? "build"
        return Menu(current == "readOnly" ? "Read-only" : current.capitalized) {
            T4TextButton(current == "build" ? "✓ Build" : "Build") {
                Task { await store.setMode(sessionId: session.sessionId, mode: "build") }
            }
            T4TextButton(current == "plan" ? "✓ Plan" : "Plan") {
                Task { await store.setMode(sessionId: session.sessionId, mode: "plan") }
            }
            T4TextButton(current == "readOnly" ? "✓ Read-only" : "Read-only") {
                Task { await store.setMode(sessionId: session.sessionId, mode: "readOnly") }
            }
        }
        .font(.system(size: 9))
    }

    private var contextLabel: some View {
        let percent: Int
        if let usage = session.contextUsage, usage.limit > 0 {
            percent = Int((Double(usage.used) / Double(usage.limit) * 100).rounded())
        } else {
            percent = 0
        }
        return HStack(spacing: 4) {
            Circle().fill(p.lineStrong).frame(width: 10, height: 10)
            Text("\(percent)%")
                .font(.system(size: 9, design: .monospaced))
                .foregroundColor(p.textMuted)
        }
    }

    private var sendButton: some View {
        let active = transcriptModel.activeTurns.contains(session.sessionId)
        let title = active ? "Steer" : "Queue"
        return T4TextButton(title) { send() }
            .font(.system(size: 10, weight: .semibold))
            .foregroundColor(canSend ? p.text : p.textFaint)
            .padding(.horizontal, 9)
            .frame(height: 25)
            .background {
                RoundedRectangle(cornerRadius: 8)
                    .fill(canSend && active ? p.accent : p.surfaceSubtle)
            }
            .disabled(!canSend)
    }

    @ViewBuilder
    private func ownershipComposer(_ control: SessionControlState) -> some View {
        let presentation = control.t4Presentation
        HStack(spacing: 10) {
            Circle().fill(p.warning).frame(width: 6, height: 6)
            VStack(alignment: .leading, spacing: 2) {
                Text(presentation.title)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(p.text)
                Text(presentation.detail)
                    .font(.system(size: 10))
                    .foregroundColor(p.textMuted)
            }
            Spacer()
            if presentation.canFork && store.canForkSessions {
                T4TextButton("Continue in a Copy") {
                    runOwnershipAction { await store.forkSession(sessionId: session.sessionId) }
                }
                .font(.system(size: 10, weight: .semibold))
                .disabled(ownershipBusy)
            }
            if case .released = control {
                T4TextButton("Bring Back") {
                    runOwnershipAction {
                        await store.reclaimSession(sessionId: session.sessionId)
                        return ()
                    }
                }
                .font(.system(size: 10, weight: .semibold))
                .disabled(ownershipBusy)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private var placeholder: String {
        if !connectionModel.connected { return "Connect a host to message" }
        if let control = session.sessionControl { return control.t4Presentation.railLabel }
        if session.archivedAt != nil { return "Restore this session to message" }
        return transcriptModel.activeTurns.contains(session.sessionId)
            ? "Steer the running turn or queue a follow-up"
            : "Message the agent"
    }

    private var canSend: Bool {
        inputEnabled && !sending && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var inputEnabled: Bool {
        connectionModel.connected && session.t4IsWritable
    }

    private func send() {
        guard canSend else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        draft = ""
        sending = true
        Task {
            await store.sendPrompt(sessionId: session.sessionId, text: text)
            sending = false
        }
    }

    private var modeBadgeText: String? {
        switch session.mode ?? "build" {
        case "plan": return "PLAN"
        case "readOnly": return "READ-ONLY"
        default: return nil
        }
    }

    private func statusLabel(compact: Bool) -> some View {
        let active = transcriptModel.activeTurns.contains(session.sessionId) || session.status == "active"
        let label = active ? "Working" : session.status.capitalized
        let color = active ? p.working : (session.status == "closed" ? p.textFaint : p.violet)
        return HStack(spacing: 5) {
            Circle().fill(color).frame(width: compact ? 5 : 6, height: compact ? 5 : 6)
            Text(label)
                .font(.system(size: compact ? 9 : 10, weight: .semibold))
                .foregroundColor(color)
        }
    }

    private var facts: some View {
        let rows: [(String, String)] = [
            ("Project", session.project.name ?? session.project.projectId),
            ("Host", session.hostId),
            ("Model", session.model ?? "—"),
            ("Revision", session.revision),
            ("Updated", session.updatedAt),
            ("Context", session.contextUsage.map { "\($0.used)/\($0.limit)" } ?? "—"),
        ]
        return VStack(alignment: .leading, spacing: 6) {
            ForEach(rows, id: \.0) { row in
                HStack(alignment: .top, spacing: 10) {
                    Text(row.0.uppercased())
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(p.textFaint)
                        .frame(width: 72, alignment: .leading)
                    Text(row.1)
                        .font(.system(size: 11))
                        .foregroundColor(p.textBody)
                        .lineLimit(1)
                }
            }
        }
        .padding(10)
        .background { RoundedRectangle(cornerRadius: 9).fill(p.surfaceSubtle) }
    }

    private func confirmationBanner(_ challenge: ConfirmationChallenge) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Circle().fill(p.warning).frame(width: 6, height: 6)
                Text("Approval needed")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(p.text)
            }
            Text(challenge.summary)
                .font(.system(size: 11))
                .foregroundColor(p.textBody)
            HStack(spacing: 8) {
                T4TextButton("Approve") { Task { await store.confirm(.approve) } }
                    .font(.system(size: 10, weight: .semibold))
                T4TextButton("Deny") { Task { await store.confirm(.deny) } }
                    .font(.system(size: 10, weight: .semibold))
            }
        }
        .padding(11)
        .background { RoundedRectangle(cornerRadius: 10).fill(p.surface) }
    }

    private var loadEarlierSection: some View {
        let paging = transcriptModel.pagingState[session.sessionId]
        let entries = store.transcript(for: session.sessionId)
        let show = paging?.hasMore == true || (paging?.hasMore == nil && entries.count >= 50)
        let loading = paging?.loading == true
        return Group {
            if show {
                HStack {
                    Spacer()
                    if loading { ProgressView() }
                    T4TextButton(loading ? "Loading…" : "Load earlier messages") {
                        Task { await store.loadEarlier(sessionId: session.sessionId) }
                    }
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(p.textMuted)
                    .disabled(loading)
                    Spacer()
                }
            }
        }
    }

    private func sheetBinding(_ sheet: ActiveSheet) -> Binding<Bool> {
        Binding(get: { activeSheet == sheet }, set: { if !$0 { activeSheet = nil } })
    }

    private func openSheet(_ sheet: ActiveSheet) {
        inboxPresented.wrappedValue = false
        activeSheet = sheet
    }

    private func paneWidth(_ preferred: Double) -> Double {
        if windowWidth < 1000 { return min(preferred, 300) }
        if windowWidth < 1200 { return min(preferred, 350) }
        return preferred
    }

    @ViewBuilder
    private func paneSidebar(_ sheet: ActiveSheet) -> some View {
        switch sheet {
        case .files:
            T4FilesPane(session: session, store: store, theme: theme, isPresented: sheetBinding(.files))
                .frame(width: paneWidth(400))
        case .agents:
            T4AgentsPane(session: session, store: store, theme: theme, isPresented: sheetBinding(.agents))
                .frame(width: paneWidth(400))
        case .usage:
            T4UsagePane(store: store, theme: theme, isPresented: sheetBinding(.usage))
                .frame(width: paneWidth(400))
        case .review:
            T4ReviewPane(session: session, store: store, theme: theme, isPresented: sheetBinding(.review))
                .frame(width: paneWidth(440))
        case .artifacts:
            T4ArtifactsPane(session: session, store: store, theme: theme, isPresented: sheetBinding(.artifacts))
                .frame(width: paneWidth(400))
        case .settings:
            T4SettingsPane(store: store, theme: theme, isPresented: sheetBinding(.settings))
                .frame(width: paneWidth(400))
        case .browser:
            T4BrowserPaneView(
                session: session,
                store: store,
                theme: theme,
                isPresented: sheetBinding(.browser)
            )
            .frame(width: paneWidth(620))
        case .searchDiff:
            T4SearchPane(session: session, store: store, theme: theme, isPresented: sheetBinding(.searchDiff))
                .frame(width: paneWidth(440))
        }
    }

    private func applyBootSeams() {
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-T4ShowFiles") { openSheet(.files) }
        if args.contains("-T4ShowBrowser") { openSheet(.browser) }
        if args.contains("-T4ShowAgents") { openSheet(.agents) }
        if args.contains("-T4ShowPlan") { planExpanded = true }
        if let raw = args.first(where: { $0.hasPrefix("-T4ShowSheet=") }),
           let sheet = ActiveSheet(rawValue: String(raw.dropFirst("-T4ShowSheet=".count))) {
            openSheet(sheet)
        }
    }

    private func applyAskSeam() {
        if T4SessionStore.demoMode, ProcessInfo.processInfo.arguments.contains("-T4ShowAsk") {
            promptModel.pendingAsk = T4SessionStore.PendingAsk(
                sessionId: session.sessionId,
                request: AskRequest(
                    askId: "demo-ask",
                    question: "Apply the plan and make these changes?",
                    options: [
                        AskOption(id: "yes", label: "Yes, apply the plan"),
                        AskOption(id: "edit", label: "Edit the plan first"),
                        AskOption(id: "no", label: "Cancel"),
                    ]
                )
            )
        }
    }

    private var renameSheet: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Rename Session")
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(p.text)
            Text("Enter a new title for this session.")
                .font(.system(size: 12))
                .foregroundColor(p.textMuted)
            TextField(session.title, text: $renameText)
                .padding(8)
                .background { RoundedRectangle(cornerRadius: 8).fill(p.surface) }
            HStack(spacing: 10) {
                Spacer()
                T4TextButton("Cancel") { renaming = false }
                T4TextButton("Rename") { submitRename() }
            }
        }
        .padding(20)
        .frame(width: 360)
        .background {
            RoundedRectangle(cornerRadius: 14).fill(p.lineStrong)
            RoundedRectangle(cornerRadius: 14).fill(p.surface).padding(1)
        }
    }

    private func submitRename() {
        let name = renameText
        renaming = false
        renameText = ""
        Task { await store.renameSession(sessionId: session.sessionId, name: name) }
    }

    private func runOwnershipAction<T>(_ operation: @escaping () async -> T) {
        guard !ownershipBusy else { return }
        ownershipBusy = true
        Task {
            _ = await operation()
            ownershipBusy = false
        }
    }
}
