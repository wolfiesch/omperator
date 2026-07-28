//  T4SessionDetailView.swift
//  One session, desktop-parity: the transcript is the star (scrollable), a
//  compact facts strip sits above it, and a composer docks at the bottom.
//  Transcript renders host-wire durable entries (TranscriptEntry); the
//  composer sends session.prompt over host-wire and is disabled with a clear
//  hint until a host is connected.

import SwiftUI
import PhotosUI
import HostWire

/// One picked photo, kept as a downscaled JPEG ready for session.image upload.
struct ComposerAttachment: Identifiable {
    let id = UUID()
    let image: PlatformImage
    let jpeg: Data

    init?(source: PlatformImage, maxBytes: Int = 20 * 1024 * 1024) {
        // Downscale until the JPEG fits the wire's per-image limit.
        guard let result = platformJPEGFitting(source, maxBytes: maxBytes) else { return nil }
        self.image = result.image
        self.jpeg = result.jpeg
    }
}

struct T4SessionDetailView: View {
    let session: SessionRef
    @ObservedObject var store: T4SessionStore
    @EnvironmentObject var theme: ThemeStore
    #if os(macOS)
    @EnvironmentObject private var macCommands: MacCommandsModel
    #endif
    @StateObject private var dictation = Dictation()
    @State private var draft = ""
    @State private var sending = false
    @State private var showFacts = false
    @State private var planExpanded = false
    /// Bottom terminal open flag is persisted per-session in the layout
    /// (store.layout.terminalOpen); toggling writes through the store so a
    /// relaunch restores the terminal alongside the dock.
    private var showTerminal: Bool { store.layout(for: session.sessionId).terminalOpen }
    /// Modal sheets only — the region migration moved browser/files/agents/
    /// review/searchDiff/artifacts into dock tiles. Settings + usage stay
    /// modal (inbox is owned by the workspace, not the session detail).
    /// details is the iOS session-facts card (macOS uses a chrome popover).
    enum ActiveSheet: String, Identifiable { case settings, usage, details; var id: String { rawValue } }
    @State private var activeSheet: ActiveSheet?
    #if os(macOS)
    /// Owns the floating NSPanels for popped-out dock tiles. Synced to the
    /// layout's `floatingPanes` on every change; closed on disappear.
    @StateObject private var floatingPanels: T4FloatingPaneManager
    #endif
    @State private var attachments: [ComposerAttachment] = []
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var askDraft = ""
    @State private var renaming = false
    @State private var renameText = ""
    @FocusState private var composerFocused: Bool
    private var t: Theme { theme.t }
    private static let maxImages = 8   // PROMPT_IMAGE_MAX_COUNT on the wire

    /// Custom init: the macOS floating-pane manager is a @StateObject with a
    /// session/store/theme dependency, so it must be seeded here.
    init(session: SessionRef, store: T4SessionStore) {
        self.session = session
        self.store = store
        #if os(macOS)
        // theme is an @EnvironmentObject (unavailable in init); the floating
        // pane manager receives it via sync(theme:) from the body.
        _floatingPanels = StateObject(wrappedValue: T4FloatingPaneManager(session: session, store: store))
        #endif
    }
    private func toggleTerminal() {
        let next = !showTerminal
        withAnimation(.easeInOut(duration: 0.2)) { store.setTerminalOpen(next, for: session.sessionId) }
    }

    /// Open a pane into the right dock (replaces the old sheet assignment).
    private func openPane(_ pane: DockPane) {
        store.openDockPane(pane, for: session.sessionId)
    }

    private func sheetBinding(_ sheet: ActiveSheet) -> Binding<Bool> {
        Binding(get: { activeSheet == sheet }, set: { if !$0 { activeSheet = nil } })
    }

    /// Region layout: center transcript + right dock + bottom terminal. macOS
    /// gets true concurrent regions (HStack transcript+dock, terminal below);
    /// iOS gets the transcript + terminal with the dock as a right-edge
    /// slide-over overlay (mirrors the left session rail).
    @ViewBuilder
    private var regionContainer: some View {
        #if os(macOS)
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                transcriptCenter
                let layout = store.layout(for: session.sessionId)
                if layout.dockVisible {
                    T4RightDockRegion(
                        session: session, store: store, dockWidth: layout.dockWidth,
                        onPopOut: { store.floatDockPane($0, for: session.sessionId) },
                        onResize: { store.setDockWidth($0, for: session.sessionId) }
                    )
                    .environmentObject(theme)
                }
            }
            T4TerminalDrawer(session: session, store: store, isOpen: showTerminal)
                .environmentObject(theme)
        }
        #else
        VStack(spacing: 0) {
            transcriptCenter
            T4TerminalDrawer(session: session, store: store, isOpen: showTerminal)
                .environmentObject(theme)
        }
        .overlay {
            T4RightDockSlideOver(session: session, store: store)
                .environmentObject(theme)
        }
        #endif
    }

    /// The center transcript region (scrollable, with the live ask tail). This
    /// is the star — the right dock and bottom terminal run alongside it.
    private var transcriptCenter: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    loadEarlierSection
                    #if os(iOS)
                    // macOS carries the status pill in the window toolbar;
                    // iOS keeps it as a slim transcript-top row. Approval
                    // challenges dock above the composer on both platforms;
                    // session facts live in the details sheet (iOS) / chrome
                    // popover (macOS), never in the scrollback.
                    statusRow
                    #endif
                    T4TranscriptView(entries: store.transcript(for: session.sessionId),
                                     streamingText: store.streamingText[session.sessionId] ?? "",
                                     theme: t)
                    // Live asks belong at the transcript's tail — the newest
                    // thing demanding attention, always in view.
                    if let ask = store.pendingAsk, ask.sessionId == session.sessionId {
                        T4AskCard(ask: ask, theme: t) { value in
                            Task { await store.respondAsk(value: value) }
                        }
                    }
                    Color.clear
                        .frame(height: 1)
                        .id("transcript-bottom")
                }
                .padding()
            }
            .onAppear { proxy.scrollTo("transcript-bottom", anchor: .bottom) }
            // Native iOS 26 scroll-edge fade at the bottom, like the nav bar's
            // top-of-screen effect — lines dissolve under the floating composer
            // instead of hard-clipping.
            #if os(iOS)
            .scrollEdgeEffectStyle(.soft, for: .bottom)
            #endif
            .onChange(of: store.transcript(for: session.sessionId).count) { _, _ in
                // A page prepend increases the count too; suppress the
                // scroll-to-bottom follow while the store is prepending older
                // history so the viewport stays put.
                guard store.prependingSession != session.sessionId else { return }
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo("transcript-bottom", anchor: .bottom)
                }
            }
            .onChange(of: store.streamingText[session.sessionId] ?? "") { _, _ in
                // Keep the live streaming tail in view as tokens arrive.
                guard store.prependingSession != session.sessionId else { return }
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo("transcript-bottom", anchor: .bottom)
                }
            }
            #if os(macOS)
            // Docked to the transcript column: plan strip + composer stick to
            // the transcript's bottom edge, never spanning the right dock or
            // the terminal drawer. Approval challenges dock here too — a
            // decision surface, not transcript scrollback.
            .safeAreaInset(edge: .bottom, spacing: 20) {
                VStack(spacing: 8) {
                    if let challenge = store.pendingConfirmation {
                        confirmationBanner(challenge)
                    }
                    planStripSection
                    composer
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 6)
            }
            #endif
        }
    }

    var body: some View {
        regionContainer
        .background(t.bg.ignoresSafeArea())
        #if os(iOS)
        // Floating glass: plan strip + composer hover over the transcript,
        // which scrolls underneath. No floor, no divider. Approval challenges
        // dock here too — a decision surface, not transcript scrollback.
        .safeAreaInset(edge: .bottom, spacing: 20) {
            VStack(spacing: 8) {
                if let challenge = store.pendingConfirmation {
                    confirmationBanner(challenge)
                }
                planStripSection
                composer
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 6)
        }
        #endif
        // Collapse the plan strip while typing so the keyboard never buries it.
        .onChange(of: composerFocused) { _, focused in
            if focused, planExpanded {
                withAnimation(.easeInOut(duration: 0.22)) { planExpanded = false }
            }
        }
        #if os(macOS)
        .onChange(of: macCommands.composerTick) { _, _ in composerFocused = true }
        #endif
        // Cross-pane prefill (browser design-mode annotation): adopt the
        // pending text into the composer draft, then clear the channel. Append
        // to existing draft so a half-typed message isn't clobbered.
        .onChange(of: store.pendingComposerText) { _, pending in
            guard let pending else { return }
            let flat = pending.replacingOccurrences(of: "\n", with: " ")
            draft = draft.isEmpty ? flat : "\(draft)\n\(flat)"
            store.pendingComposerText = nil
            composerFocused = true
        }
        .navigationTitle(session.title)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        // Session chrome: on macOS the status pill rides next to the title
        // and the actions are native toolbar items; on iOS everything folds
        // into one top-right overflow menu.
        .toolbar {
            #if os(macOS)
            ToolbarItem(placement: .navigation) {
                HStack(spacing: 8) {
                    StatusPill(status: session.status, theme: t)
                    if let badge = modeBadgeText {
                        Text(badge.text)
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(badge.color)
                    }
                }
            }
            ToolbarItemGroup(placement: .primaryAction) {
                Button { showFacts.toggle() } label: {
                    Image(systemName: showFacts ? "info.circle.fill" : "info.circle")
                }
                .accessibilityLabel("Session details")
                .popover(isPresented: $showFacts, arrowEdge: .bottom) {
                    facts
                        .padding(14)
                        .frame(width: 320)
                }
                Button { openPane(.files) } label: {
                    Image(systemName: "folder")
                }
                .accessibilityLabel("Browse files")
                Button { toggleTerminal() } label: {
                    Image(systemName: showTerminal ? "terminal.fill" : "terminal")
                }
                .accessibilityLabel("Toggle terminal")
                Button { openPane(.browser) } label: {
                    Image(systemName: "safari")
                }
                .accessibilityLabel("Open browser")
                Menu { sessionMenuContent } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("Session actions")
            }
            #else
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { activeSheet = .details } label: {
                        Label("Session details", systemImage: "info.circle")
                    }
                    Button { openPane(.files) } label: { Label("Files", systemImage: "folder") }
                    Button { openPane(.browser) } label: { Label("Browser", systemImage: "safari") }
                    Button { toggleTerminal() } label: {
                        Label(showTerminal ? "Close terminal" : "Open terminal", systemImage: "terminal")
                    }
                    Divider()
                    sessionMenuContent
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("Session actions")
            }
            #endif
        }
        .task(id: session.sessionId) { await store.attach(sessionId: session.sessionId) }
        .onAppear {
            // UI-test seams: boot with a pane/drawer/card visible for screenshots.
            // The old -T4ShowFiles/Browser/Agents seams now open region tiles
            // (kept working for the parent's screenshot harness).
            let args = ProcessInfo.processInfo.arguments
            if args.contains("-T4ShowFiles") { openPane(.files) }
            if args.contains("-T4ShowBrowser") { openPane(.browser) }
            if args.contains("-T4ShowAgents") { openPane(.agents) }
            if args.contains("-T4ShowTerminal") { store.setTerminalOpen(true, for: session.sessionId) }
            if args.contains("-T4ShowPlan") { planExpanded = true }
            // Generic: -T4ShowSheet=usage|settings|<dockpane>. Dock panes
            // (files/browser/agents/review/searchDiff/artifacts) open as
            // region tiles; settings/usage stay modal sheets.
            if let raw = args.first(where: { $0.hasPrefix("-T4ShowSheet=") }) {
                let value = String(raw.dropFirst("-T4ShowSheet=".count))
                if let pane = DockPane(rawValue: value) { openPane(pane) }
                else if let sheet = ActiveSheet(rawValue: value) { activeSheet = sheet }
            }
            // UI-test seam: -T4Fork forks the current session at boot and selects the copy.
            if args.contains("-T4Fork") {
                Task {
                    for _ in 0..<40 where !store.connected { try? await Task.sleep(for: .milliseconds(500)) }
                    _ = await store.forkSession(sessionId: session.sessionId)
                }
            }
            // UI-test seam: -T4FloatBrowser docks the browser and floats it (macOS pop-out path).
            if args.contains("-T4FloatBrowser") {
                store.openDockPane(.browser, for: session.sessionId)
                store.floatDockPane(.browser, for: session.sessionId)
            }
        }
        .task(id: session.sessionId) {
            // -T4ShowAsk: demo ask pinned to whatever session is current (the
            // selection swaps from sample to live after connect).
            if ProcessInfo.processInfo.arguments.contains("-T4ShowAsk") {
                store.pendingAsk = T4SessionStore.PendingAsk(
                    sessionId: session.sessionId,
                    request: AskRequest(askId: "demo-ask", question: "Apply the plan and make these changes?",
                                        options: [AskOption(id: "yes", label: "Yes, apply the plan"),
                                                  AskOption(id: "edit", label: "Edit the plan first"),
                                                  AskOption(id: "no", label: "Cancel")]))
            }
        }
        .alert("Rename Session", isPresented: $renaming) {
            TextField("Session name", text: $renameText)
            Button("Rename", action: submitRename)
            Button("Cancel", role: .cancel) { renaming = false }
        } message: {
            Text("Enter a new title for this session.")
        }
        .sheet(item: $activeSheet) { sheet in
            // Only settings + usage remain as modal sheets — the region
            // migration moved every dockable pane into the right dock tile.
            Group {
            switch sheet {
            case .usage:
                T4UsagePane(store: store, isPresented: sheetBinding(.usage))
                    .environmentObject(theme)
            case .settings:
                T4SettingsPane(store: store, isPresented: sheetBinding(.settings))
                    .environmentObject(theme)
            case .details:
                // iOS session facts: a swipe-down card, not transcript
                // scrollback. macOS never sets this — it uses the popover.
                NavigationStack {
                    facts
                        .padding(18)
                        .navigationTitle("Session details")
                        #if os(iOS)
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) {
                                Button("Done") { activeSheet = nil }
                                    .font(.system(size: 14, weight: .semibold))
                            }
                        }
                        #endif
                }
                #if os(iOS)
                .presentationDetents([.medium, .large])
                #endif
            }
            }
            #if os(macOS)
            .frame(minWidth: 560, idealWidth: 680, minHeight: 720, idealHeight: 840)
            #endif
        }
        #if os(macOS)
        // Keep the floating NSPanels in sync with the layout's floatingPanes:
        // pop-out opens a panel, dock-back / panel × closes it. Re-runs on
        // every layout change (including active-pane switches, which are
        // no-ops here since the panel set is unchanged).
        .task(id: store.layout(for: session.sessionId).floatingPanes) {
            floatingPanels.sync(with: store.layout(for: session.sessionId), theme: theme)
        }
        .onDisappear { floatingPanels.closeAll() }
        #endif
    }

    /// Confirmation challenge: summary + approve/deny, matching the desktop
    /// app's approval surface.
    private func confirmationBanner(_ challenge: ConfirmationChallenge) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.shield.fill")
                    .font(.system(size: 14))
                    .foregroundStyle(t.cAdvisor)
                Text("Approval needed")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(t.txt)
            }
            Text(challenge.summary)
                .font(.system(size: 13))
                .foregroundStyle(t.txtBody)
            HStack(spacing: 10) {
                Button { Task { await store.confirm(.approve) } } label: {
                    Text("Approve")
                        .font(.system(size: 13, weight: .semibold))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(t.diffAdd)
                Button { Task { await store.confirm(.deny) } } label: {
                    Text("Deny")
                        .font(.system(size: 13, weight: .semibold))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(t.diffDel)
            }
        }
        .padding(12)
        .background(t.diffDelBG, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
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

    /// Question-mode ask banner: option buttons when the host offered a fixed
    /// choice, otherwise a text field + Answer button for free-text replies.
    private func askBanner(_ ask: T4SessionStore.PendingAsk) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "questionmark.bubble.fill")
                    .font(.system(size: 14))
                    .foregroundStyle(t.cTask)
                Text("Question")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(t.txt)
            }
            if let question = ask.request.question {
                Text(question)
                    .font(.system(size: 13))
                    .foregroundStyle(t.txtBody)
            }
            if ask.request.options.isEmpty {
                HStack(spacing: 10) {
                    TextField("Answer", text: $askDraft, axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                        .lineLimit(1...4)
                    Button {
                        let value = askDraft
                        askDraft = ""
                        Task { await store.respondAsk(value: value) }
                    } label: {
                        Text("Answer")
                            .font(.system(size: 13, weight: .semibold))
                            .padding(.horizontal, 12)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(t.cTask)
                    .disabled(askDraft.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(ask.request.options) { option in
                        Button {
                            Task { await store.respondAsk(value: option.id) }
                        } label: {
                            Text(option.label)
                                .font(.system(size: 13, weight: .semibold))
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(.bordered)
                        .tint(t.cTask)
                    }
                }
            }
        }
        .padding(12)
        .background(t.highlightBG, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
    /// "Load earlier messages" control at the top of the transcript scroll
    /// content. Shown when the host reports more history (`hasMore == true`)
    /// or when paging state is unknown and the live transcript is at least
    /// 50 rows (a full first page may still be fetchable). A spinner replaces
    /// the label while a page is in flight.
    private var loadEarlierSection: some View {
        let paging = store.pagingState[session.sessionId]
        let entries = store.transcript(for: session.sessionId)
        let show = (paging?.hasMore == true)
            || (paging?.hasMore == nil && entries.count >= 50)
        let loading = paging?.loading == true
        return Group {
            if show {
                HStack {
                    Spacer()
                    Button {
                        Task { await store.loadEarlier(sessionId: session.sessionId) }
                    } label: {
                        HStack(spacing: 6) {
                            if loading {
                                ProgressView()
                                    .controlSize(.small)
                            } else {
                                Image(systemName: "arrow.up")
                                    .font(.system(size: 11, weight: .semibold))
                            }
                            Text(loading ? "Loading…" : "Load earlier messages")
                                .font(.system(size: 13, weight: .semibold))
                        }
                        .foregroundStyle(t.txtMuted)
                        .padding(.vertical, 6)
                        .padding(.horizontal, 12)
                    }
                    .disabled(loading)
                    .buttonStyle(.plain)
                    Spacer()
                }
            }
        }
    }

    /// Slim transcript-top row (iOS only): status pill, model control, mode
    /// badge. The action buttons that used to sit here moved to the toolbar —
    /// macOS shows them as native chrome items, iOS folds them into the
    /// top-right overflow menu.
    private var statusRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            StatusPill(status: session.status, theme: t)
            if let model = session.model {
                T4ModelMenuButton(session: session, store: store, theme: t) {
                    T4ModelLabel(selector: model, theme: t)
                }
                .accessibilityLabel("Model and session controls")
            }
            if let badge = modeBadgeText {
                Text(badge.text)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(badge.color)
            }
            Spacer()
        }
    }

    /// Session actions shared by the macOS toolbar menu and the iOS
    /// top-right overflow menu.
    @ViewBuilder
    private var sessionMenuContent: some View {
                Button {
                    renameText = session.title
                    renaming = true
                } label: {
                    Label("Rename", systemImage: "pencil")
                }
                Button {
                    Task { await store.compactSession(sessionId: session.sessionId) }
                } label: {
                    Label("Compact", systemImage: "rectangle.compress.vertical")
                }
                Button {
                    Task { await store.retrySession(sessionId: session.sessionId) }
                } label: {
                    Label("Retry", systemImage: "arrow.clockwise")
                }
                Button {
                    Task { await store.forkSession(sessionId: session.sessionId) }
                } label: {
                    Label("Fork", systemImage: "arrow.triangle.branch")
                }
                Button {
                    Task { await store.closeSession(sessionId: session.sessionId) }
                } label: {
                    Label("Close", systemImage: "xmark.circle")
                }
                .disabled(session.status == "closed")
                Button(role: .destructive) {
                    Task { await store.deleteSession(sessionId: session.sessionId) }
                } label: {
                    Label("Delete", systemImage: "trash")
                }
                Divider()
                Button {
                    Task { await newSessionInProject() }
                } label: {
                    Label("New Session in Project", systemImage: "plus.square")
                }
                Button {
                    openPane(.agents)
                } label: {
                    Label("Agents", systemImage: "person.3.sequence")
                }
                Divider()
                Button {
                    activeSheet = .usage
                } label: {
                    Label("Usage", systemImage: "chart.bar.xaxis")
                }
                Button {
                    openPane(.review)
                } label: {
                    Label("Review", systemImage: "checkmark.shield")
                }
                Button {
                    openPane(.artifacts)
                } label: {
                    Label("Artifacts", systemImage: "paperclip")
                }
                Button {
                    openPane(.searchDiff)
                } label: {
                    Label("Search & Diff", systemImage: "magnifyingglass.and.list.bullet.indent")
                }
                Button {
                    activeSheet = .settings
                } label: {
                    Label("Settings", systemImage: "gearshape")
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
                HStack(alignment: .firstTextBaseline) {
                    Text(row.0.uppercased())
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(t.txtLabel)
                        .frame(width: 84, alignment: .leading)
                    Text(row.1).font(.system(size: 13)).foregroundStyle(t.txtBody)
                        .lineLimit(1).truncationMode(.middle)
                }
            }
        }
        .transition(.opacity)
    }

    private var composer: some View {
        VStack(spacing: 0) {
            if !attachments.isEmpty { attachmentStrip }
            HStack(spacing: 4) {
                if store.connected {
                    PhotosPicker(selection: $pickerItems, maxSelectionCount: Self.maxImages, matching: .images) {
                        Image(systemName: "paperclip").font(.system(size: 20))
                            .foregroundStyle(t.txtMuted).frame(width: 34, height: 34)
                    }
                    .accessibilityLabel("Attach an image")
                }
                TextField("", text: $draft, prompt: Text(placeholder).foregroundStyle(t.txtMuted), axis: .vertical)
                    .font(.bodyF(14)).foregroundStyle(t.txt).tint(t.interactiveAccent)
                    .lineLimit(1...5)
                    .focused($composerFocused)
                    .disabled(!store.connected)
                    .onSubmit(send)
                Button { dictation.toggle() } label: {
                    Image(systemName: dictation.recording ? "mic.fill" : "mic").font(.system(size: 20))
                        .foregroundStyle(dictation.recording ? t.accent : t.txtMuted).frame(width: 34, height: 34)
                }
                .disabled(!store.connected)
                .accessibilityLabel(dictation.recording ? "Stop dictation" : "Dictate")
                sendOrStop
            }
            .padding(.horizontal, 8).padding(.vertical, 5)
            if draft.isEmpty && !dictation.recording {
                ComposerTips(t: t)
            }
        }
        .glass(t, 16, panel: true)
        .onChange(of: pickerItems) { _, items in loadAttachments(items) }
        .onAppear { dictation.onText = { draft = $0 } }
    }

    private var placeholder: String {
        if !store.connected { return "Connect a host to message" }
        if dictation.recording { return "Listening\u{2026}" }
        return store.activeTurns.contains(session.sessionId) ? "Steer the turn\u{2026}" : "Message the agent\u{2026}"
    }

    @ViewBuilder private var sendOrStop: some View {
        if store.connected && store.activeTurns.contains(session.sessionId) {
            Button { Task { await store.cancel(sessionId: session.sessionId) } } label: {
                Image(systemName: "stop.fill").font(.system(size: 15)).foregroundStyle(t.txt)
                    .frame(width: 34, height: 34)
            }
            .press()
            .accessibilityLabel("Stop the running turn")
        } else {
            Button { send() } label: {
                Image(systemName: "arrow.up.circle.fill").font(.system(size: 30))
                    .foregroundStyle(canSend ? t.accent : t.txtGhost)
            }
            .press()
            .disabled(!canSend)
            .accessibilityLabel("Send message")
        }
    }

    private var attachmentStrip: some View {
        VStack(alignment: .leading, spacing: 6) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(attachments) { a in
                        ZStack(alignment: .topTrailing) {
                            Image(platformImage: a.image).resizable().scaledToFill()
                                .frame(width: 54, height: 54)
                                .clipShape(RoundedRectangle(cornerRadius: 12))
                            Button { attachments.removeAll { $0.id == a.id } } label: {
                                Image(systemName: "xmark.circle.fill").font(.system(size: 15))
                                    .foregroundStyle(.white, .black.opacity(0.55))
                            }
                            .offset(x: 6, y: -6)
                            .accessibilityLabel("Remove image")
                        }
                    }
                }
                .padding(.horizontal, 10).padding(.top, 9).padding(.trailing, 4)
            }
            Text("\(attachments.count) image\(attachments.count == 1 ? "" : "s") · sent with your message")
                .font(.term(12)).foregroundStyle(t.txtMuted)
                .padding(.horizontal, 11).padding(.bottom, 5)
        }
        .overlay(Rectangle().frame(height: 0.5).foregroundStyle(t.lineFaint), alignment: .bottom)
    }

    private func loadAttachments(_ items: [PhotosPickerItem]) {
        Task {
            for item in items {
                if let data = try? await item.loadTransferable(type: Data.self),
                   let image = platformImage(data: data),
                   let attachment = ComposerAttachment(source: image) {
                    attachments.append(attachment)
                }
            }
            pickerItems = []
        }
    }

    private var canSend: Bool {
        store.connected && !sending
            && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)
    }

    private func send() {
        guard canSend else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let images = attachments.map(\.jpeg)
        let sentAttachments = attachments
        draft = ""
        attachments = []
        sending = true
        Task {
            let accepted = await store.sendPrompt(sessionId: session.sessionId, text: text, images: images)
            // Never eat the user's words: a failed send (lease conflict,
            // dropped connection) puts the draft and attachments back.
            if !accepted {
                draft = text
                attachments = sentAttachments
            }
            sending = false
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
