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
    @StateObject private var dictation = Dictation()
    @State private var draft = ""
    @State private var sending = false
    @State private var showFacts = false
    @State private var planExpanded = false
    @State private var showTerminal = false
    /// One enum-driven sheet: multiple .sheet modifiers on one view stack
    /// and merge toolbars (the triple-Done bug).
    enum ActiveSheet: String, Identifiable { case files, agents, usage, review, artifacts, settings, browser, searchDiff; var id: String { rawValue } }
    @State private var activeSheet: ActiveSheet?
    @State private var attachments: [ComposerAttachment] = []
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var askDraft = ""
    @State private var renaming = false
    @State private var renameText = ""
    @FocusState private var composerFocused: Bool
    private var t: Theme { theme.t }
    private static let maxImages = 8   // PROMPT_IMAGE_MAX_COUNT on the wire

    private func sheetBinding(_ sheet: ActiveSheet) -> Binding<Bool> {
        Binding(get: { activeSheet == sheet }, set: { if !$0 { activeSheet = nil } })
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        loadEarlierSection
                        header
                        if let challenge = store.pendingConfirmation {
                            confirmationBanner(challenge)
                        }
                        if showFacts { facts }
                        Divider().overlay(t.lineFaint)
                        T4TranscriptView(entries: store.transcript(for: session.sessionId),
                                         streamingText: store.streamingText[session.sessionId] ?? "",
                                         theme: t)
                        // Live asks belong at the transcript's tail — the
                        // newest thing demanding attention, always in view.
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
                // Native iOS 26 scroll-edge fade at the bottom, like the nav
                // bar's top-of-screen effect — lines dissolve under the
                // floating composer instead of hard-clipping.
                #if os(iOS)
                .scrollEdgeEffectStyle(.soft, for: .bottom)
                #endif
                .onChange(of: store.transcript(for: session.sessionId).count) { _, _ in
                    // A page prepend increases the count too; suppress the
                    // scroll-to-bottom follow while the store is prepending
                    // older history so the viewport stays put.
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
            }
            T4TerminalDrawer(session: session, store: store, isOpen: showTerminal)
                .environmentObject(theme)
        }
        .background(t.bg.ignoresSafeArea())
        // Floating glass: plan strip + composer hover over the transcript,
        // which scrolls underneath. No floor, no divider.
        .safeAreaInset(edge: .bottom, spacing: 20) {
            VStack(spacing: 8) {
                planStripSection
                composer
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 6)
        }
        // Collapse the plan strip while typing so the keyboard never buries it.
        .onChange(of: composerFocused) { _, focused in
            if focused, planExpanded {
                withAnimation(.easeInOut(duration: 0.22)) { planExpanded = false }
            }
        }
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
        .task(id: session.sessionId) { await store.attach(sessionId: session.sessionId) }
        .onAppear {
            // UI-test seams: boot with a pane/drawer/card visible for screenshots.
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
            // UI-test seam: -T4Fork forks the current session at boot and selects the copy.
            if args.contains("-T4Fork") {
                Task {
                    for _ in 0..<40 where !store.connected { try? await Task.sleep(for: .milliseconds(500)) }
                    _ = await store.forkSession(sessionId: session.sessionId)
                }
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
            switch sheet {
            case .files:
                T4FilesPane(session: session, store: store, isPresented: sheetBinding(.files))
                    .environmentObject(theme)
            case .agents:
                T4AgentsPane(session: session, store: store, isPresented: sheetBinding(.agents))
                    .environmentObject(theme)
            case .usage:
                T4UsagePane(store: store, isPresented: sheetBinding(.usage))
                    .environmentObject(theme)
            case .review:
                T4ReviewPane(session: session, store: store, isPresented: sheetBinding(.review))
                    .environmentObject(theme)
            case .artifacts:
                T4ArtifactsPane(session: session, store: store, isPresented: sheetBinding(.artifacts))
                    .environmentObject(theme)
            case .settings:
                T4SettingsPane(store: store, isPresented: sheetBinding(.settings))
                    .environmentObject(theme)
            case .browser:
                T4BrowserPane(session: session, store: store, isPresented: sheetBinding(.browser))
                    .environmentObject(theme)
            case .searchDiff:
                T4SearchPane(session: session, store: store, isPresented: sheetBinding(.searchDiff))
                    .environmentObject(theme)
            }
        }
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

    private var header: some View {

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
            Menu {
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
                    activeSheet = .agents
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
                    activeSheet = .review
                } label: {
                    Label("Review", systemImage: "checkmark.shield")
                }
                Button {
                    activeSheet = .artifacts
                } label: {
                    Label("Artifacts", systemImage: "paperclip")
                }
                Button {
                    activeSheet = .searchDiff
                } label: {
                    Label("Search & Diff", systemImage: "magnifyingglass.and.list.bullet.indent")
                }
                Button {
                    activeSheet = .settings
                } label: {
                    Label("Settings", systemImage: "gearshape")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.system(size: 16))
                    .foregroundStyle(t.txtMuted)
                    .frame(width: 34, height: 34)
            }
            .press()
            .accessibilityLabel("Session actions")
            Spacer()
            Button { withAnimation(.easeInOut(duration: 0.2)) { showFacts.toggle() } } label: {
                Image(systemName: showFacts ? "info.circle.fill" : "info.circle")
                    .font(.system(size: 16))
                    .foregroundStyle(t.txtMuted)
                    .frame(width: 34, height: 34)
            }
            .press()
            .accessibilityLabel("Session details")
            Button { activeSheet = .files } label: {
                Image(systemName: "folder")
                    .font(.system(size: 16))
                    .foregroundStyle(t.txtMuted)
                    .frame(width: 34, height: 34)
            }
            .press()
            .accessibilityLabel("Browse files")
            Button { withAnimation(.easeInOut(duration: 0.2)) { showTerminal.toggle() } } label: {
                Image(systemName: showTerminal ? "terminal.fill" : "terminal")
                    .font(.system(size: 16))
                    .foregroundStyle(showTerminal ? t.cBash : t.txtMuted)
                    .frame(width: 34, height: 34)
            }
            .press()
            .accessibilityLabel("Toggle terminal")
            Button { activeSheet = .browser } label: {
                Image(systemName: "safari")
                    .font(.system(size: 16))
                    .foregroundStyle(t.txtMuted)
                    .frame(width: 34, height: 34)
            }
            .press()
            .accessibilityLabel("Open browser")
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
        draft = ""
        attachments = []
        sending = true
        Task {
            await store.sendPrompt(sessionId: session.sessionId, text: text, images: images)
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
