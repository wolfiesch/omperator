//  T4SessionDetailView.swift (Linux port of apps/ios/Sources/T4SessionDetailView.swift)
//  One session, desktop-parity: the transcript is the star (scrollable), a
//  compact facts strip sits above it, and a composer docks at the bottom.
//  Transcript renders host-wire durable entries (TranscriptEntry); the
//  composer sends session.prompt over host-wire and is disabled with a clear
//  hint until a host is connected.
//
//  Linux deltas:
//  - @EnvironmentObject/@ObservedObject → plain `let` models passed via init
//    (the root's @State store re-renders the subtree on change — proven).
//  - `.environmentObject(theme)` → `theme: ThemeStore` init parameter.
//  - ScrollViewReader/auto-scroll, @FocusState, PhotosPicker, dictation,
//    `.safeAreaInset`, `.navigationTitle`, `.alert` with TextField: no
//    SwiftCrossUI equivalents → dropped with LINUX-GAP comments. The rename
//    alert becomes a small sheet.
//  - Sheets use `sheet(isPresented:)` (one modifier per case); macOS used a
//    single `sheet(item:)`. `.browser` renders a placeholder until the full
//    T4BrowserPane view is ported (the Linux seam is only T4BrowserPane(url:)).
//  - Photo attachments: PlatformImage exists, but the macOS picker
//    (PhotosPicker) + downscale (platformJPEGFitting) do not → the
//    attachment flow is a LINUX-GAP; ComposerAttachment keeps its shape and
//    the strip renders only when populated (never on Linux).
//  - `.press()` is dropped (ViewExtras no-op); `.glass()` comes from the
//    shared ViewExtras (single declaration point).

import Foundation
import SwiftCrossUI
import HostWire

/// One picked photo, kept as a downscaled JPEG ready for session.image upload.
/// LINUX-GAP: the macOS init downscales via `platformJPEGFitting`, which has
/// no Linux equivalent yet (no image decoder in the store layer), so
/// attachments can't be created on Linux — the fields stay for API parity.
struct ComposerAttachment: Identifiable {
    let id = UUID()
    let image: PlatformImage
    let jpeg: Data
}

struct T4SessionDetailView: View {
    let session: SessionRef
    let store: T4SessionStore
    let theme: ThemeStore
    private let connectionModel: T4ConnectionInventoryModel
    private let transcriptModel: T4TranscriptProjectionModel
    private let promptModel: T4PromptLeaseModel
    @State private var draft = ""
    @State private var sending = false
    @State private var showFacts = false
    @State private var planExpanded = false
    @State private var showTerminal = false
    /// One enum-driven sheet set. macOS presents via `sheet(item:)`; Linux
    /// chains one `.sheet(isPresented:)` per case through `sheetBinding`.
    enum ActiveSheet: String, Identifiable { case files, agents, usage, review, artifacts, settings, browser, searchDiff; var id: String { rawValue } }
    @State private var activeSheet: ActiveSheet?
    @State private var attachments: [ComposerAttachment] = []
    @State private var renaming = false
    @State private var renameText = ""
    @State private var ownershipBusy = false
    private var t: Theme { theme.t }

    init(session: SessionRef, store: T4SessionStore, theme: ThemeStore) {
        self.session = session
        self.store = store
        self.theme = theme
        self.connectionModel = store.connectionModel
        self.transcriptModel = store.transcriptModel
        self.promptModel = store.promptModel
    }

    private func sheetBinding(_ sheet: ActiveSheet) -> Binding<Bool> {
        Binding(get: { activeSheet == sheet }, set: { if !$0 { activeSheet = nil } })
    }

    var body: some View {
        // In-window pane sidebar: panes render beside the transcript column
        // (macOS split style) instead of floating sheet windows — one window,
        // no modal grabs, predictable layout. Fixed widths per pane
        // (SwiftCrossUI's SplitView is internal to the framework, so a
        // draggable divider is a later improvement; defaults are sensible).
        if let sheet = activeSheet {
            HStack(spacing: 0) {
                detailColumn
                Divider(t.line)
                paneSidebar(sheet)
            }
            .background(t.bg)
            .task(id: session.sessionId) {
                await store.attach(sessionId: session.sessionId)
                applyAskSeam()
            }
            .onAppear { applyBootSeams() }
            .sheet(isPresented: $renaming) { renameSheet }
        } else {
            detailColumn
                .background(t.bg)
                .task(id: session.sessionId) {
                    await store.attach(sessionId: session.sessionId)
                    applyAskSeam()
                }
                .onAppear { applyBootSeams() }
                .sheet(isPresented: $renaming) { renameSheet }
        }
    }

    /// The transcript + terminal drawer + composer column (split detail side).
    private var detailColumn: some View {
        VStack(spacing: 0) {
            // The ownership state lives in the composer (below), not a pinned
            // banner — the card scrolled away and duplicated the message.
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    loadEarlierSection
                    header
                    if let challenge = promptModel.pendingConfirmation {
                        confirmationBanner(challenge)
                    }
                    if showFacts { facts }
                    Divider()
                    T4TranscriptView(entries: store.transcript(for: session.sessionId),
                                     liveTurn: transcriptModel.liveTurns[session.sessionId],
                                     streamingMessage: transcriptModel.streamingMessages[session.sessionId],
                                     liveTools: transcriptModel.liveTools[session.sessionId] ?? LiveToolProjection(),
                                     theme: t)
                    // Live asks belong at the transcript's tail — the
                    // newest thing demanding attention, always in view.
                    if let ask = promptModel.pendingAsk, ask.sessionId == session.sessionId {
                        T4AskCard(ask: ask, theme: t) { value in
                            Task { await store.respondAsk(value: value) }
                        }
                    }
                }
                .padding()
            }
            // Stay pinned to the newest transcript content while the
            // scrollbar is near the bottom; scrolling up releases the pin,
            // scrolling back near the bottom re-engages it.
            .environment(\.scrollAnchorsToBottom, true)
            T4TerminalDrawer(session: session, store: store, theme: theme, isOpen: showTerminal)
            // Floating glass: plan strip + composer hover over the
            // transcript. macOS uses `.safeAreaInset(edge: .bottom)`;
            // Linux docks them in the outer column below the drawer.
            VStack(spacing: 8) {
                planStripSection
                composer
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 6)
        }
    }

    /// The in-window pane sidebar (right of the transcript). Widths are fixed
    /// per pane: browsers and diffs want more room, simple lists less.
    @ViewBuilder
    private func paneSidebar(_ sheet: ActiveSheet) -> some View {
        switch sheet {
        case .files:
            T4FilesPane(session: session, store: store, theme: theme, isPresented: sheetBinding(.files))
                .frame(width: 400)
        case .agents:
            T4AgentsPane(session: session, store: store, theme: theme, isPresented: sheetBinding(.agents))
                .frame(width: 400)
        case .usage:
            T4UsagePane(store: store, theme: theme, isPresented: sheetBinding(.usage))
                .frame(width: 400)
        case .review:
            T4ReviewPane(session: session, store: store, theme: theme, isPresented: sheetBinding(.review))
                .frame(width: 440)
        case .artifacts:
            T4ArtifactsPane(session: session, store: store, theme: theme, isPresented: sheetBinding(.artifacts))
                .frame(width: 400)
        case .settings:
            T4SettingsPane(store: store, theme: theme, isPresented: sheetBinding(.settings))
                .frame(width: 400)
        case .browser:
            T4BrowserPaneView(
                session: session,
                store: store,
                theme: theme,
                isPresented: sheetBinding(.browser)
            )
            .frame(width: 620)
        case .searchDiff:
            T4SearchPane(session: session, store: store, theme: theme, isPresented: sheetBinding(.searchDiff))
                .frame(width: 440)
        }
    }

    /// Boot seams: launch args that pre-open panes/drawer/cards for
    /// screenshots and UI tests.
    private func applyBootSeams() {
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-T4ShowFiles") { activeSheet = .files }
        if args.contains("-T4ShowBrowser") { activeSheet = .browser }
        if args.contains("-T4ShowAgents") { activeSheet = .agents }
        if args.contains("-T4ShowTerminal") { showTerminal = true }
        if args.contains("-T4ShowPlan") { planExpanded = true }
        // Generic: -T4ShowSheet=usage|review|artifacts|settings|searchDiff|files|browser|agents
        if let raw = args.first(where: { $0.hasPrefix("-T4ShowSheet=") }),
           let sheet = ActiveSheet(rawValue: String(raw.dropFirst("-T4ShowSheet=".count))) {
            activeSheet = sheet
        }
    }

    /// -T4ShowAsk: demo ask pinned to whatever session is current (the
    /// selection swaps from sample to live after connect).
    private func applyAskSeam() {
        if ProcessInfo.processInfo.arguments.contains("-T4ShowAsk") {
            promptModel.pendingAsk = T4SessionStore.PendingAsk(
                sessionId: session.sessionId,
                request: AskRequest(askId: "demo-ask", question: "Apply the plan and make these changes?",
                                    options: [AskOption(id: "yes", label: "Yes, apply the plan"),
                                              AskOption(id: "edit", label: "Edit the plan first"),
                                              AskOption(id: "no", label: "Cancel")]))
        }
    }

    /// LINUX-GAP: macOS uses `.alert("Rename Session", isPresented:)`
    /// with a TextField inside; SwiftCrossUI alerts take actions only, so
    /// rename is a small sheet with the same buttons.
    private var renameSheet: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Rename Session")
                .lineLimit(1)
                .font(.disp(16))
                .foregroundColor(t.txt)
            Text("Enter a new title for this session.")
                .font(.bodyF(13))
                .foregroundColor(t.txtMuted)
            TextField(session.title, text: $renameText)
                .padding(8)
                .background {
                    RoundedRectangle(cornerRadius: t.r).fill(t.glassFill)
                }
            HStack(spacing: 10) {
                T4TextButton("Cancel") { renaming = false }
                T4TextButton("Rename") { submitRename() }
            }
        }
        .padding(20)
        .frame(width: 360)
    }

    /// Confirmation challenge: summary + approve/deny, matching the desktop
    /// app's approval surface.
    private func confirmationBanner(_ challenge: ConfirmationChallenge) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text("⚠")
                    .font(.system(size: 14))
                    .foregroundColor(t.cAdvisor)
                Text("Approval needed")
                    .lineLimit(1)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundColor(t.txt)
            }
            Text(challenge.summary)
                .font(.system(size: 13))
                .foregroundColor(t.txtBody)
            HStack(spacing: 10) {
                T4TextButton("Approve") {
                    Task { await store.confirm(.approve) }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                .background {
                    RoundedRectangle(cornerRadius: 10).fill(t.diffAdd)
                }
                .foregroundColor(t.bg)
                T4TextButton("Deny") {
                    Task { await store.confirm(.deny) }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                .background {
                    RoundedRectangle(cornerRadius: 10).fill(t.diffDel)
                }
                .foregroundColor(t.bg)
            }
        }
        .padding(12)
        .background {
            RoundedRectangle(cornerRadius: 12)
                .fill(t.diffDelBG)
        }
    }

    /// Mode badge: plain text in the header when mode ≠ build. Plan uses the
    /// task accent, read-only the advisor accent — text only, no capsule.
    private var modeBadgeText: (text: String, color: Color)? {
        switch session.mode ?? "build" {
        case "plan":     return ("PLAN", t.cTask)
        case "readOnly": return ("READ-ONLY", t.cAdvisor)
        default:         return nil
        }
    }

    /// Plan strip placement: above the composer when the session has todos.
    private var planStripSection: some View {
        Group {
            if !store.todoPhases(for: session.sessionId).isEmpty {
                T4PlanStrip(phases: store.todoPhases(for: session.sessionId), t: t, expanded: $planExpanded)
            }
        }
    }

    /// "Load earlier messages" control at the top of the transcript scroll
    /// content. Shown when the host reports more history (`hasMore == true`)
    /// or when paging state is unknown and the live transcript is at least
    /// 50 rows (a full first page may still be fetchable). A spinner replaces
    /// the label while a page is in flight.
    private var loadEarlierSection: some View {
        let paging = transcriptModel.pagingState[session.sessionId]
        let entries = store.transcript(for: session.sessionId)
        let show = (paging?.hasMore == true)
            || (paging?.hasMore == nil && entries.count >= 50)
        let loading = paging?.loading == true
        return Group {
            if show {
                HStack {
                    Spacer()
                    if loading {
                        // LINUX-GAP: macOS uses a small controlSize spinner;
                        // Linux ProgressView() has no control size variants.
                        ProgressView()
                    }
                    T4TextButton(loading ? "Loading…" : "Load earlier messages") {
                        Task { await store.loadEarlier(sessionId: session.sessionId) }
                    }
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(t.txtMuted)
                    .padding(.vertical, 6)
                    .padding(.horizontal, 12)
                    .disabled(loading)
                    Spacer()
                }
            }
        }
    }

    private var header: some View {
        // LINUX-GAP: macOS aligns on .firstTextBaseline; SwiftCrossUI only
        // has .top/.center/.bottom vertical alignments.
        HStack(alignment: .top, spacing: 10) {
            StatusPill(status: session.status, theme: t)
            if let model = session.model {
                T4ModelMenuButton(session: session, store: store, theme: t, label: T4ModelLabel.labelString(model))
            }
            if let badge = modeBadgeText {
                Text(badge.text)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(badge.color)
            }
            Menu("⋯") {
                if let control = session.sessionControl {
                    let presentation = control.t4Presentation
                    Text(presentation.railLabel)
                    if presentation.canFork && store.canForkSessions {
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
                } else {
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
                    T4TextButton("Continue in Terminal") {
                        Task { await store.releaseSession(sessionId: session.sessionId) }
                    }
                    .disabled(transcriptModel.activeTurns.contains(session.sessionId) || session.status == "closed")
                    T4TextButton("Close") {
                        Task { await store.closeSession(sessionId: session.sessionId) }
                    }
                    .disabled(session.status == "closed")
                    T4TextButton("Delete") {
                        Task { await store.deleteSession(sessionId: session.sessionId) }
                    }
                }
                Divider()
                T4TextButton("New Session in Project") {
                    Task { await newSessionInProject() }
                }
                T4TextButton("Agents") {
                    activeSheet = .agents
                }
                Divider()
                T4TextButton("Usage") {
                    activeSheet = .usage
                }
                T4TextButton("Review") {
                    activeSheet = .review
                }
                T4TextButton("Artifacts") {
                    activeSheet = .artifacts
                }
                T4TextButton("Search & Diff") {
                    activeSheet = .searchDiff
                }
                T4TextButton("Settings") {
                    activeSheet = .settings
                }
            }
            .font(.system(size: 16))
            .foregroundColor(t.txtMuted)
            Spacer()
            T4TextButton("ⓘ") {
                withAnimation { showFacts.toggle() }
            }
            .font(.system(size: 16))
            .foregroundColor(showFacts ? t.accent : t.txtMuted)
            .frame(width: 34, height: 34)
            T4TextButton("Files") {
                activeSheet = .files
            }
            .font(.system(size: 11))
            .foregroundColor(t.txtMuted)
            .frame(width: 34, height: 34)
            T4TextButton(showTerminal ? "❯_" : "❯") {
                withAnimation { showTerminal.toggle() }
            }
            .font(.system(size: 15))
            .foregroundColor(showTerminal ? t.cBash : t.txtMuted)
            .frame(width: 34, height: 34)
            T4TextButton("Web") {
                activeSheet = .browser
            }
            .font(.system(size: 11))
            .foregroundColor(t.txtMuted)
            .frame(width: 34, height: 34)
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
        return VStack(alignment: .leading, spacing: 8) {
            ForEach(rows, id: \.0) { row in
                HStack(alignment: .top) {
                    Text(row.0.uppercased())
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(t.txtLabel)
                        .frame(width: 84, alignment: .leading)
                    // LINUX-GAP: macOS adds .truncationMode(.middle); the
                    // field truncates at the tail on Linux.
                    Text(row.1).font(.system(size: 13)).foregroundColor(t.txtBody)
                        .lineLimit(1)
                }
            }
        }
    }

    private var composer: some View {
        VStack(spacing: 0) {
            if !attachments.isEmpty { attachmentStrip }
            if let control = session.sessionControl {
                ownershipComposer(control)
            } else {
                HStack(spacing: 4) {
                    // LINUX-GAP: macOS shows a PhotosPicker (paperclip) here and
                    // a dictation mic after the field — no PhotosPicker or
                    // Dictation on Linux.
                    TextField(placeholder, text: $draft)
                        .font(.bodyF(14))
                        .foregroundColor(t.txt)
                        .disabled(!inputEnabled)
                        .onSubmit(perform: send)
                    sendOrStop
                }
                .padding(.horizontal, 8).padding(.vertical, 5)
            }
            if draft.isEmpty && session.sessionControl == nil {
                ComposerTips(t: t)
            }
        }
        .glass(t, 16, panel: true)
    }

    /// The ownership state, in the composer: the message replaces the text
    /// field when the session isn't writable (read-only / active elsewhere /
    /// released), with the fork/reclaim actions inline.
    @ViewBuilder
    private func ownershipComposer(_ control: SessionControlState) -> some View {
        let presentation = control.t4Presentation
        HStack(spacing: 10) {
            Text("●")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(t.cAdvisor)
            VStack(alignment: .leading, spacing: 2) {
                Text(presentation.title)
                    .font(.bodyF(13))
                    .foregroundColor(t.txt)
                Text(presentation.detail)
                    .font(.bodyF(12))
                    .foregroundColor(t.txtMuted)
                if let resumeCommand = control.t4ResumeCommand {
                    Text(resumeCommand)
                        .font(.term(12))
                        .foregroundColor(t.txt)
                        .textSelectionEnabled()
                }
            }
            Spacer()
            if presentation.canFork && store.canForkSessions {
                T4TextButton("Continue in a Copy") {
                    runOwnershipAction { await store.forkSession(sessionId: session.sessionId) }
                }
                .font(.system(size: 12, weight: .semibold))
                .disabled(ownershipBusy)
            }
            if case .released = control {
                T4TextButton("Bring Back") {
                    runOwnershipAction {
                        await store.reclaimSession(sessionId: session.sessionId)
                        return ()
                    }
                }
                .font(.system(size: 12, weight: .semibold))
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
        return transcriptModel.activeTurns.contains(session.sessionId) ? "Steer the turn…" : "Message the agent…"
    }

    @ViewBuilder private var sendOrStop: some View {
        if inputEnabled && transcriptModel.activeTurns.contains(session.sessionId) {
            T4TextButton("✕") {
                Task { await store.cancel(sessionId: session.sessionId) }
            }
            .font(.system(size: 15))
            .foregroundColor(t.txt)
            .frame(width: 34, height: 34)
        } else {
            T4TextButton("➤") {
                send()
            }
            .font(.system(size: 20))
            .foregroundColor(canSend ? t.accent : t.txtGhost)
            .disabled(!canSend)
            .frame(width: 34, height: 34)
        }
    }

    private var attachmentStrip: some View {
        // LINUX-GAP: photo attachments can't be created on Linux (no
        // PhotosPicker / platformJPEGFitting), so this never renders.
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                ForEach(attachments) { a in
                    Text("\(a.image.data.count) bytes")
                        .font(.term(12))
                        .foregroundColor(t.txtMuted)
                        .padding(8)
                        .background {
                            RoundedRectangle(cornerRadius: 12)
                                .fill(t.glassFill2)
                        }
                }
                .padding(.horizontal, 10).padding(.top, 9).padding(.trailing, 4)
            }
            Text("\(attachments.count) image\(attachments.count == 1 ? "" : "s") · sent with your message")
                .font(.term(12)).foregroundColor(t.txtMuted)
                .padding(.horizontal, 11).padding(.bottom, 5)
        }
        .overlay(alignment: .bottom) { Rectangle().fill(t.lineFaint).frame(height: 1) }
    }

    private var canSend: Bool {
        inputEnabled && !sending
            && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)
    }

    private var inputEnabled: Bool {
        connectionModel.connected && session.t4IsWritable
    }

    private func send() {
        guard canSend else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let images = attachments.map(\.jpeg)
        draft = ""
        attachments = []
        sending = true
        Task {
            await store.sendPrompt(sessionId: session.sessionId, text: text, images: images)
            sending = false
        }
    }

    private func runOwnershipAction<T>(_ operation: @escaping () async -> T) {
        guard !ownershipBusy else { return }
        ownershipBusy = true
        Task {
            _ = await operation()
            ownershipBusy = false
        }
    }

    /// Create a fresh session in this session's project and select it. The
    /// new session appears in the rail via the store's refresh; selecting it
    /// navigates the detail view (the parent's onSelect binding).
    private func newSessionInProject() async {
        guard let created = await store.createSession(projectId: session.project.projectId) else { return }
        store.select(created)
    }

    private func submitRename() {
        let name = renameText
        renaming = false
        renameText = ""
        Task { await store.renameSession(sessionId: session.sessionId, name: name) }
    }
}
