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
    private let inboxPresented: Binding<Bool>?
#if os(Windows)
    private let browserModel: T4WindowsBrowserWorkspaceModel
    private let browserFixtureEnabled: Bool
    private let terminalWorkspace: T4WindowsTerminalWorkspaceModel
#endif
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
#if os(Windows)
    @Environment(\.t4WindowWidth) private var windowWidth
    @Environment(\.t4WindowHeight) private var windowHeight
#endif
    private var t: Theme { theme.t }
#if os(Windows)
    private var terminalDrawerHeight: Double {
        if windowWidth < 800 { return 180 }
        if windowWidth < 1_100 { return 240 }
        return 330
    }
    private var lowerSurfaceStagger: Int { t4PlatformMetric(6) }



    private var transcriptViewportHeight: Double {
        var reserved = 74.0
        if showTerminal {
            // WinUI's drawer chrome realizes seven points taller than its
            // nominal frame; reserve the realized extent so lower surfaces
            // keep the Linux vertical origin.
            reserved += terminalDrawerHeight + 7
        }
        if !store.todoPhases(for: session.sessionId).isEmpty {
            // The compact WinUI plan viewport realizes at 222 DIPs.
            reserved += planExpanded ? 222 : 34
        }
        if let ask = promptModel.pendingAsk, ask.sessionId == session.sessionId {
            reserved += 140
        }
        return max(windowHeight - reserved, 160)
    }
#endif
    private var lowerSurfaceHorizontalPadding: Int {
#if os(Windows)
        return 6
#else
        return 12
#endif
    }
    private var composerVerticalPadding: Int {
#if os(Windows)
        return 3
#else
        return 5
#endif
    }


#if os(Windows)
    init(
        session: SessionRef,
        store: T4SessionStore,
        theme: ThemeStore,
        inboxPresented: Binding<Bool>? = nil,
        browserModel: T4WindowsBrowserWorkspaceModel,
        browserFixtureEnabled: Bool,
        terminalWorkspace: T4WindowsTerminalWorkspaceModel
    ) {
        self.session = session
        self.store = store
        self.theme = theme
        self.inboxPresented = inboxPresented
        self.browserModel = browserModel
        self.browserFixtureEnabled = browserFixtureEnabled
        self.terminalWorkspace = terminalWorkspace
        self.connectionModel = store.connectionModel
        self.transcriptModel = store.transcriptModel
        self.promptModel = store.promptModel
    }
#else
    init(session: SessionRef, store: T4SessionStore, theme: ThemeStore) {
        self.session = session
        self.store = store
        self.theme = theme
        self.inboxPresented = nil
        self.connectionModel = store.connectionModel
        self.transcriptModel = store.transcriptModel
        self.promptModel = store.promptModel
    }
#endif

    private func sheetBinding(_ sheet: ActiveSheet) -> Binding<Bool> {
        Binding(get: { activeSheet == sheet }, set: { if !$0 { activeSheet = nil } })
    }

    private var isExternalInboxPresented: Bool {
        inboxPresented?.wrappedValue ?? false
    }

    private func openSheet(_ sheet: ActiveSheet) {
        inboxPresented?.wrappedValue = false
        activeSheet = sheet
    }

    private func paneWidth(_ preferred: Double) -> Double {
#if os(Windows)
        // Windows renders fixed SwiftCrossUI frames at the monitor's 125%
        // raster scale. Two-thirds lands on Linux's 5:6 normalized width.
        let scaled = preferred * (2.0 / 3.0)
        if windowWidth < 1_000 { return min(scaled, 240) }
        if windowWidth < 1_200 { return min(scaled, 300) }
        return scaled
#else
        return preferred
#endif
    }

    private var showsHeaderModel: Bool {
#if os(Windows)
        // WINDOWS-GAP: the root toolbar already exposes the model picker.
        // Omitting this duplicate leaves every pane action visible on resize.
        return false
#else
        return true
#endif
    }

    var body: some View {
        // In-window pane sidebar: panes render beside the transcript column
        // (macOS split style) instead of floating sheet windows — one window,
        // no modal grabs, predictable layout. Fixed widths per pane
        // (SwiftCrossUI's SplitView is internal to the framework, so a
        // draggable divider is a later improvement; defaults are sensible).
        if let sheet = activeSheet {
            HStack(alignment: .top, spacing: 0) {
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
            .onChange(of: isExternalInboxPresented) {
                if isExternalInboxPresented { activeSheet = nil }
            }
            .sheet(isPresented: $renaming) { renameSheet }
        } else {
            detailColumn
                .background(t.bg)
                .task(id: session.sessionId) {
                    await store.attach(sessionId: session.sessionId)
                    applyAskSeam()
                }
                .onAppear { applyBootSeams() }
                .onChange(of: isExternalInboxPresented) {
                    if isExternalInboxPresented { activeSheet = nil }
                }
                .sheet(isPresented: $renaming) { renameSheet }
        }
    }

    /// The transcript + terminal drawer + composer column (split detail side).
    private var detailColumn: some View {
        VStack(spacing: 0) {
            // The ownership state lives in the composer (below), not a pinned
            // banner — the card scrolled away and duplicated the message.
#if os(Windows)
            // WINDOWS-FIX: WinUI otherwise measures the vertical ScrollView at
            // its full transcript height, which pushes the composer below the
            // window and lets unwrapped rows widen the whole detail column.
            GeometryReader { geometry in
                ScrollView {
                    VStack(alignment: .leading, spacing: 9) {
                        transcriptContent
                    }
                    .padding()
                    .frame(width: geometry.size.width)
                }
                .t4AnchorToBottom(contentID: session.sessionId)
                .environment(\.scrollAnchorsToBottom, true)
                .frame(width: geometry.size.width, height: geometry.size.height)
            }
            .frame(height: transcriptViewportHeight)
            T4WindowsTerminalDrawer(
                session: session,
                store: store,
                theme: theme,
                workspace: terminalWorkspace,
                isOpen: showTerminal
            )
#else
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    transcriptContent
                    pendingAskCard
                }
                .padding()
            }
            .environment(\.scrollAnchorsToBottom, true)
            T4TerminalDrawer(session: session, store: store, theme: theme, isOpen: showTerminal)
#endif
            // Floating glass: plan strip + composer hover over the
            // transcript. macOS uses `.safeAreaInset(edge: .bottom)`;
            // Linux docks them in the outer column below the drawer.
            VStack(spacing: t4PlatformMetric(8)) {
#if os(Windows)
                // WINDOWS-GAP: WinUIBackend has no transcript bottom anchor;
                // pin live asks above the composer so they cannot open off-screen.
                pendingAskCard
                planStripSection.padding(.top, lowerSurfaceStagger)
                composer.padding(.top, lowerSurfaceStagger)
#else
                planStripSection
                composer
#endif
            }
            .padding(.horizontal, lowerSurfaceHorizontalPadding)
            .padding(.bottom, t4PlatformMetric(6))
        }
    }

    @ViewBuilder
    private var transcriptContent: some View {
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
    }

    @ViewBuilder
    private var pendingAskCard: some View {
        if let ask = promptModel.pendingAsk, ask.sessionId == session.sessionId {
            T4AskCard(ask: ask, theme: t) { value in
                Task { await store.respondAsk(value: value) }
            }
        }
    }

    /// The in-window pane sidebar (right of the transcript). Widths are fixed
    /// per pane: browsers and diffs want more room, simple lists less.
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
#if os(Windows)
            T4BrowserPaneView(
                session: session,
                store: store,
                theme: theme,
                browserModel: browserModel,
                fixtureEnabled: browserFixtureEnabled,
                isPresented: sheetBinding(.browser)
            )
            .frame(width: paneWidth(620))
#else
            T4BrowserPaneView(
                session: session,
                store: store,
                theme: theme,
                isPresented: sheetBinding(.browser)
            )
            .frame(width: paneWidth(620))
#endif
        case .searchDiff:
#if os(Windows)
            VStack(spacing: 0) {
                Spacer()
                T4SearchPane(session: session, store: store, theme: theme, isPresented: sheetBinding(.searchDiff))
                    .frame(width: paneWidth(440))
                Spacer()
            }
            .frame(maxHeight: .infinity)
#else
            T4SearchPane(session: session, store: store, theme: theme, isPresented: sheetBinding(.searchDiff))
                .frame(width: paneWidth(440))
#endif
        }
    }

    /// Boot seams: launch args that pre-open panes/drawer/cards for
    /// screenshots and UI tests.
    private func applyBootSeams() {
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-T4ShowFiles") { openSheet(.files) }
        if args.contains("-T4ShowBrowser") { openSheet(.browser) }
        if args.contains("-T4ShowAgents") { openSheet(.agents) }
        if args.contains("-T4ShowTerminal") { showTerminal = true }
        if args.contains("-T4ShowPlan") { planExpanded = true }
        // Generic: -T4ShowSheet=usage|review|artifacts|settings|searchDiff|files|browser|agents
        if let raw = args.first(where: { $0.hasPrefix("-T4ShowSheet=") }),
           let sheet = ActiveSheet(rawValue: String(raw.dropFirst("-T4ShowSheet=".count))) {
            openSheet(sheet)
        }
    }

    /// -T4ShowAsk: demo ask pinned to the current demo session.
    /// Live launches never synthesize host input.
    private func applyAskSeam() {
#if os(Windows)
        guard T4SessionStore.demoMode else { return }
#endif
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
            if showsHeaderModel, let model = session.model {
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
                    openSheet(.agents)
                }
                Divider()
                T4TextButton("Usage") {
                    openSheet(.usage)
                }
                T4TextButton("Review") {
                    openSheet(.review)
                }
                T4TextButton("Artifacts") {
                    openSheet(.artifacts)
                }
                T4TextButton("Search & Diff") {
                    openSheet(.searchDiff)
                }
                T4TextButton("Settings") {
                    openSheet(.settings)
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
            .frame(width: 34, height: toolbarButtonHeight)
            T4TextButton("Files") {
                openSheet(.files)
            }
            .font(.system(size: 11))
            .foregroundColor(t.txtMuted)
            .frame(width: 34, height: toolbarButtonHeight)
            T4TextButton(showTerminal ? "❯_" : "❯") {
                withAnimation { showTerminal.toggle() }
            }
            .font(.system(size: 15))
            .foregroundColor(showTerminal ? t.cBash : t.txtMuted)
            .frame(width: 34, height: toolbarButtonHeight)
            T4TextButton("Web") {
                openSheet(.browser)
            }
            .font(.system(size: 11))
            .foregroundColor(t.txtMuted)
            .frame(width: 34, height: toolbarButtonHeight)
        }
    }
    private var toolbarButtonHeight: Double {
#if os(Windows)
        26
#else
        34
#endif
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
                HStack(spacing: t4PlatformMetric(4)) {
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
                .padding(.horizontal, t4PlatformMetric(8))
                .padding(.vertical, t4PlatformMetric(composerVerticalPadding))
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
        HStack(spacing: t4PlatformMetric(10)) {
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
        .padding(.horizontal, t4PlatformMetric(12))
        .padding(.vertical, t4PlatformMetric(10))
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
            .frame(width: t4PlatformMetric(34), height: t4PlatformMetric(34))
        } else {
            T4TextButton("➤") {
                send()
            }
            .font(.system(size: 20))
            .foregroundColor(canSend ? t.accent : t.txtGhost)
            .disabled(!canSend)
            .frame(width: t4PlatformMetric(34), height: t4PlatformMetric(34))
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
