//  EditorView.swift
//  The hero: live streaming transcript + composer. Backed by a GuestClient via
//  SessionVM. A guest can prompt, abort, and answer asks — nothing else the
//  collab wire doesn't expose. View (watch) links are read-only: the composer is
//  replaced by a read-only bar.

import SwiftUI
import PhotosUI
import UIKit

/// A picked, downscaled image ready to send with a prompt.
struct Attachment: Identifiable {
    let id = UUID()
    let image: UIImage      // thumbnail to show
    let data: Data          // JPEG bytes to send
    let mime: String
}

private struct BottomOffsetKey: PreferenceKey {
    static var defaultValue: CGFloat = .infinity
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = min(value, nextValue())
    }
}

private struct ScrollHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

struct EditorView: View {
    @EnvironmentObject var theme: ThemeStore
    @Environment(\.scenePhase) private var scenePhase
    @StateObject var vm: SessionVM
    @StateObject private var dictation = Dictation()
    @State private var draft = ""
    @State private var viewer: String? = nil
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var attachments: [Attachment] = []
    private let maxImages = 5
    @State private var showPalette = false
    @State private var showVisionHelp = false
    @State private var planExpanded = false
    @FocusState private var composerFocused: Bool
    @State private var stickToBottom = true
    @State private var didInitialScroll = false
    @State private var scrollVisibleHeight: CGFloat = 0

    init(client: GuestClient) {
        let seed = Session(id: "live", repo: client.title, branch: client.readOnly ? "watch" : "control",
                           dir: client.cwd, model: client.modelName, status: .waiting,
                           lastSeen: "live", action: "CONNECTING…", tokens: "—", cost: "—")
        _vm = StateObject(wrappedValue: SessionVM(live: client, seed: seed))
    }
    private var t: Theme { theme.t }

    var body: some View {
        ZStack {
            t.bg.ignoresSafeArea()
            transcript
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { composerStack }
        .navigationTitle(vm.session.repo)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(vm.session.repo).font(.disp(15)).foregroundStyle(t.txt).textCase(.uppercase).lineLimit(1)
                    Text(vm.session.dir).font(.term(12)).foregroundStyle(t.txtMuted).lineLimit(1)
                }
            }
            ToolbarItem(placement: .topBarTrailing) { sessionMenu }
        }
        .fullScreenCover(item: Binding(get: { viewer.map { IdStr($0) } }, set: { viewer = $0?.v })) { img in
            ImageViewer(src: img.v, label: "focused image") { viewer = nil }.environmentObject(theme)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { vm.live.reconnectIfNeeded() }
        }
    }

    // MARK: session menu (top-right …)

    @ViewBuilder private var sessionMenu: some View {
        Menu {
            if vm.enhanced && !vm.models.isEmpty {
                Menu {
                    ForEach(vm.models) { m in
                        Button { vm.setModel(m.modelId) } label: {
                            // Eye marks vision-capable models — pick one for fast image handling
                            // (a non-vision model routes images through the slower inspect_image fallback).
                            if m.name == vm.modelName { Label(m.name, systemImage: "checkmark") }
                            else if m.vision { Label("\(m.name)  · sees images", systemImage: "eye") }
                            else { Text(m.name) }
                        }
                    }
                } label: { Label("Change model", systemImage: "arrow.left.arrow.right") }
            }
            if vm.enhanced && !vm.thinkingLevels.isEmpty {
                Menu {
                    ForEach(vm.thinkingLevels, id: \.self) { lvl in
                        Button { vm.setThinking(lvl) } label: {
                            if lvl == vm.thinkingLevel { Label(lvl, systemImage: "checkmark") } else { Text(lvl) }
                        }
                    }
                } label: { Label("Thinking level", systemImage: "brain") }
            }
            if !vm.joinLink.isEmpty {
                ShareLink(item: vm.joinLink) { Label("Share invite link", systemImage: "square.and.arrow.up") }
                Button { UIPasteboard.general.string = vm.joinLink } label: { Label("Copy link", systemImage: "doc.on.doc") }
            }
        } label: {
            Image(systemName: "ellipsis").font(.system(size: 16, weight: .semibold)).foregroundStyle(t.accent)
        }
    }

    // MARK: transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical) {
                transcriptList
            }
            .coordinateSpace(name: "scroll")
            .background(
                GeometryReader { geo in
                    Color.clear
                        .preference(key: ScrollHeightKey.self, value: geo.size.height)
                }
            )
            .onPreferenceChange(ScrollHeightKey.self) { scrollVisibleHeight = $0 }
            .onPreferenceChange(BottomOffsetKey.self) { bottomY in
                // bottomY is the bottom spacer's maxY in the scroll coordinate space.
                // If it's within (or just below) the visible area, we're at the bottom.
                stickToBottom = bottomY <= scrollVisibleHeight + 50
            }
            .onChange(of: vm.turns) { _, _ in
                if didInitialScroll && stickToBottom {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
            .onChange(of: vm.live.phase) { _, phase in
                if phase == "live" && !didInitialScroll {
                    didInitialScroll = true
                    proxy.scrollTo("bottom", anchor: .bottom)
                    Task { @MainActor in
                        try? await Task.sleep(nanoseconds: 100_000_000)
                        proxy.scrollTo("bottom", anchor: .bottom)
                    }
                }
            }
            .onChange(of: composerFocused) { _, focused in
                guard focused else { return }
                withAnimation(.easeInOut(duration: 0.2)) { planExpanded = false }
                if stickToBottom {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .simultaneousGesture(TapGesture().onEnded { hideKeyboard() })
        }
    }

    @ViewBuilder private var transcriptList: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(vm.turns, id: \.id) { turn in
                TurnRow(turn: turn, t: t,
                        onImage: { viewer = $0 },
                        onAnswer: vm.readOnly ? nil : { vm.answer($0, $1) },
                        onAnswerText: vm.readOnly ? nil : { vm.answer($0, $1) },
                        onCancelAsk: vm.readOnly ? nil : { vm.skip($0) },
                        onRewind: (vm.enhanced && !vm.isRunning && turn.type == .user) ? { vm.rewind(to: turn) } : nil,
                        onEdit: (vm.enhanced && !vm.isRunning && turn.type == .user) ? { draft = turn.text; vm.rewindBefore(to: turn) } : nil)
                    .id(turn.id)
            }
            if vm.isRunning { ThinkingLine(t: t).id("think") }
            Color.clear.frame(height: 8)
                .id("bottom")
                .background(
                    GeometryReader { geo in
                        Color.clear
                            .preference(key: BottomOffsetKey.self,
                                        value: geo.frame(in: .named("scroll")).maxY)
                    }
                )
        }
        .padding(16)
    }

    private func hideKeyboard() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }


    // MARK: composer

    private var composerStack: some View {
        GlassEffectContainer(spacing: 8) {
            VStack(spacing: 8) {
                if let g = vm.goal { goalBanner(g) }
                if !vm.plan.isEmpty {
                    PlanStrip(phases: vm.plan, t: t, expanded: $planExpanded)
                }
                if vm.isRunning {
                    HStack(spacing: 8) {
                        if vm.awaitingVision { Image(systemName: "eye").font(.system(size: 13)).foregroundStyle(t.accent) } else { LiveDot(t: t) }
                        Text(vm.session.action).font(.term(14)).foregroundStyle(t.accent).lineLimit(1)
                        Spacer()
                        Text("\(vm.session.tokens) · \(vm.session.model)").font(.term(13)).foregroundStyle(t.txtMuted).lineLimit(1)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .glass(t, 16, flat: true)
                }
                if vm.currentMode == "plan" && !vm.isRunning {
                    planReviewBanner
                }
                if showPalette {
                    SlashPalette(t: t, commands: vm.commands) { name in vm.runCommand(name); showPalette = false }
                }
                if vm.readOnly { readOnlyBar } else { composer }
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 6)
    }

    private func goalBanner(_ g: GoalInfo) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "target").font(.system(size: 12)).foregroundStyle(t.accent)
            Text("GOAL").font(.labl(10)).tracking(1.6).foregroundStyle(t.txt)
            Text(g.objective).font(.term(12)).foregroundStyle(t.txtBody).lineLimit(1)
            Spacer(minLength: 4)
            if let b = g.tokenBudget, b > 0 {
                Text("\(min(100, g.tokensUsed * 100 / b))%").font(.term(11)).foregroundStyle(t.txtMuted)
            }
        }
        .padding(.horizontal, 13).padding(.vertical, 9)
        .glass(t, 16, panel: true)
    }

    private var planReviewBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "checklist").font(.system(size: 13)).foregroundStyle(t.cAdvisor)
            Text("Plan ready — review it in the transcript above.")
                .font(.term(13)).foregroundStyle(t.cAdvisor).lineLimit(2)
            Spacer()
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
        .glass(t, 16, flat: true)
    }

    private var readOnlyBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "eye").font(.system(size: 15)).foregroundStyle(t.txtMuted)
            Text("WATCHING · READ-ONLY").font(.labl(10)).tracking(1.4).foregroundStyle(t.txtMuted)
            Spacer()
            Text("view link").font(.term(13)).foregroundStyle(t.txtGhost)
        }
        .padding(.horizontal, 12).padding(.vertical, 12)
        .glass(t, 16, flat: true)
    }

    private var composer: some View {
        VStack(spacing: 0) {
            if !attachments.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(attachments) { a in
                                ZStack(alignment: .topTrailing) {
                                    Image(uiImage: a.image).resizable().scaledToFill()
                                        .frame(width: 54, height: 54).clipShape(RoundedRectangle(cornerRadius: 12))
                                    Button { attachments.removeAll { $0.id == a.id } } label: {
                                        Image(systemName: "xmark.circle.fill").font(.system(size: 15))
                                            .foregroundStyle(.white, .black.opacity(0.55))
                                    }.offset(x: 6, y: -6)
                                }
                            }
                        }.padding(.horizontal, 10).padding(.top, 9).padding(.trailing, 4)
                    }
                    HStack(spacing: 5) {
                        Text("\(attachments.count) image\(attachments.count == 1 ? "" : "s") · sent with your message")
                            .font(.term(12)).foregroundStyle(t.txtMuted)
                        if vm.viaVisionModel {
                            Image(systemName: "eye").font(.system(size: 9)).foregroundStyle(t.accent.opacity(0.85))
                            Text("read via vision model").font(.labl(8.5)).tracking(0.8).foregroundStyle(t.accent.opacity(0.85))
                        }
                    }.padding(.horizontal, 11).padding(.bottom, 5)
                }
                .overlay(Rectangle().frame(height: 0.5).foregroundStyle(t.lineFaint), alignment: .bottom)
            }
            HStack(spacing: 4) {
                if vm.enhanced && !vm.commands.isEmpty {
                    Button { showPalette.toggle() } label: {
                        Image(systemName: "slash.circle").font(.system(size: 20)).foregroundStyle(showPalette ? t.accent : t.txtMuted).frame(width: 34, height: 34)
                    }
                }
                if vm.canSendImages {
                    PhotosPicker(selection: $pickerItems, maxSelectionCount: maxImages, matching: .images) {
                        Image(systemName: "paperclip").font(.system(size: 20)).foregroundStyle(t.txtMuted).frame(width: 34, height: 34)
                    }
                } else if vm.imagePossible {
                    Button { showVisionHelp = true } label: {
                        Image(systemName: "paperclip").font(.system(size: 20)).foregroundStyle(t.txtGhost).frame(width: 34, height: 34).opacity(0.5)
                    }
                }
                TextField("", text: $draft, prompt: Text(placeholder).foregroundStyle(t.txtMuted), axis: .vertical)
                    .font(.bodyF(14)).foregroundStyle(t.txt).tint(t.accent)
                    .lineLimit(1...5)
                    .focused($composerFocused)
                    .onSubmit(doSend)
                Button { dictation.toggle() } label: {
                    Image(systemName: dictation.recording ? "mic.fill" : "mic").font(.system(size: 20))
                        .foregroundStyle(dictation.recording ? t.accent : t.txtMuted).frame(width: 34, height: 34)
                }
                sendOrStop
            }
            .padding(.horizontal, 8).padding(.vertical, 5)
            if draft.isEmpty && !dictation.recording {
                ComposerTips(t: t, hasCommands: vm.enhanced && !vm.commands.isEmpty) { showPalette = true }
            }
        }
        .glass(t, 16)
        .onChange(of: pickerItems) { _, items in loadAttachments(items) }
        .onAppear { dictation.onText = { draft = $0 } }
        .sheet(isPresented: $showVisionHelp) {
            VisionHelpSheet(t: t) { showVisionHelp = false }.environmentObject(theme)
        }
    }

    private var placeholder: String {
        dictation.recording ? "Listening…" : (vm.isRunning ? "Steer the turn…" : "Message the agent…")
    }

    @ViewBuilder private var sendOrStop: some View {
        if vm.isRunning {
            Button { vm.stop() } label: {
                Image(systemName: "stop.fill").font(.system(size: 15)).foregroundStyle(t.txt)
            }
            .buttonStyle(.glass)
            .frame(width: 38, height: 38)
        } else {
            Button(action: doSend) {
                Image(systemName: "arrow.right").font(.system(size: 17, weight: .semibold)).foregroundStyle(.white)
            }
            .buttonStyle(.glassProminent)
            .tint(t.accent)
            .frame(width: 38, height: 38)
        }
    }

    private func doSend() {
        let x = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let images = attachments.map { (mime: $0.mime, base64: $0.data.base64EncodedString()) }
        guard !x.isEmpty || !images.isEmpty else { return }
        if dictation.recording { dictation.stop() }
        vm.send(x, images: images)
        draft = ""; attachments = []; pickerItems = []
    }

    /// Load, downscale (max 1568px, JPEG 0.75) and stage up to `maxImages` picked photos.
    private func loadAttachments(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        Task {
            var loaded: [Attachment] = []
            for item in items.prefix(maxImages) {
                guard let data = try? await item.loadTransferable(type: Data.self),
                      let ui = UIImage(data: data) else { continue }
                // 1568px long edge is the vision-model sweet spot; only ever shrink.
                let maxDim: CGFloat = 1568
                let scale = min(1, maxDim / max(ui.size.width, ui.size.height))
                let size = CGSize(width: ui.size.width * scale, height: ui.size.height * scale)
                let resized = UIGraphicsImageRenderer(size: size).image { _ in ui.draw(in: CGRect(origin: .zero, size: size)) }
                guard let jpeg = resized.jpegData(compressionQuality: 0.75), let thumb = UIImage(data: jpeg) else { continue }
                loaded.append(Attachment(image: thumb, data: jpeg, mime: "image/jpeg"))
            }
            await MainActor.run { attachments = loaded }
        }
    }
}

struct IdStr: Identifiable { let v: String; var id: String { v }; init(_ v: String) { self.v = v } }

/// The live plan (omp's `todo` tool): phases → tasks with status. A collapsed pill
/// above the composer showing progress + the current task; tap to slide up the full
/// tree. Expansion is bound so the composer can collapse it while you type.
struct PlanStrip: View {
    let phases: [PlanPhase]
    let t: Theme
    @Binding var expanded: Bool

    private var phasesDone: Int { phases.filter { !$0.tasks.isEmpty && $0.doneCount == $0.tasks.count }.count }
    private var currentTask: String? {
        let all = phases.flatMap { $0.tasks }
        return all.first { $0.status == "in_progress" }?.content ?? all.first { $0.status == "pending" }?.content
    }

    var body: some View {
        VStack(spacing: 0) {
            if expanded {
                ScrollView { planBody.padding(.horizontal, 13).padding(.top, 12).padding(.bottom, 8) }
                    .frame(maxHeight: 260)
                Rectangle().frame(height: 0.5).foregroundStyle(t.lineFaint)
            }
            Button { withAnimation(.easeInOut(duration: 0.22)) { expanded.toggle() } } label: {
                HStack(spacing: 7) {
                    Image(systemName: "checklist").font(.system(size: 12)).foregroundStyle(t.accent)
                    Text("PLAN").font(.labl(10)).tracking(1.6).foregroundStyle(t.txt)
                    Text("\(phasesDone)/\(phases.count)").font(.term(12)).foregroundStyle(t.txtMuted)
                    if let cur = currentTask {
                        Image(systemName: "circle.lefthalf.filled").font(.system(size: 9)).foregroundStyle(t.accent)
                        Text(cur).font(.term(12)).foregroundStyle(t.txtBody).lineLimit(1)
                    } else {
                        Image(systemName: "checkmark.circle.fill").font(.system(size: 9)).foregroundStyle(t.cOk)
                        Text("complete").font(.term(12)).foregroundStyle(t.cOk)
                    }
                    Spacer(minLength: 4)
                    Image(systemName: expanded ? "chevron.down" : "chevron.up").font(.system(size: 10, weight: .semibold)).foregroundStyle(t.txtMuted)
                }
                .padding(.horizontal, 13).padding(.vertical, 10)
            }
        }
        .glass(t, 16, panel: true)
    }

    private var planBody: some View {
        VStack(alignment: .leading, spacing: 11) {
            ForEach(phases) { phase in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        Text(phase.name).font(.labl(9.5)).tracking(1).foregroundStyle(t.txtBody).textCase(.uppercase)
                        Text("\(phase.doneCount)/\(phase.tasks.count)").font(.term(11)).foregroundStyle(t.txtMuted)
                    }
                    ForEach(phase.tasks) { task in
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: glyph(task.status)).font(.system(size: 12)).foregroundStyle(color(task.status)).frame(width: 15)
                            Text(task.content).font(.bodyF(13))
                                .foregroundStyle(task.status == "completed" ? t.txtMuted : t.txtBody)
                                .strikethrough(task.status == "abandoned", color: t.txtGhost)
                        }
                    }
                }
            }
        }
    }

    private func glyph(_ s: String) -> String {
        switch s {
        case "completed": "checkmark.circle.fill"
        case "in_progress": "circle.lefthalf.filled"
        case "abandoned": "xmark.circle"
        default: "circle"
        }
    }
    private func color(_ s: String) -> Color {
        switch s {
        case "completed": t.cOk
        case "in_progress": t.accent
        case "abandoned": t.txtGhost
        default: t.txtMuted
        }
    }
}

/// "Vision is off" help — the enable command lives in a one-line monospace box
/// (horizontal-scroll if it overflows) so it never wraps into two lines that read
/// as two commands. Tap to copy.
struct VisionHelpSheet: View {
    let t: Theme
    let onClose: () -> Void
    @State private var copied = false
    private let cmd = "omp config set inspect_image.enabled true"

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("VISION IS OFF").font(.labl(11)).tracking(1.6).foregroundStyle(t.txtMuted)
            Text("This model can’t read images yet.").font(.disp(21)).foregroundStyle(t.txt)
            Text("Run this on the box once, then reconnect — or switch to a vision-capable model.")
                .font(.bodyF(14)).foregroundStyle(t.txtBody).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(cmd).font(.term(15)).foregroundStyle(t.accent).lineLimit(1).fixedSize()
                }
                Button {
                    UIPasteboard.general.string = cmd
                    withAnimation { copied = true }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.system(size: 14)).foregroundStyle(t.txtMuted)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 11)
            .glass(t, 14, flat: true)
            Button { onClose() } label: {
                Text("GOT IT").font(.labl(12)).tracking(1.2).foregroundStyle(t.txt)
                    .frame(maxWidth: .infinity).padding(.vertical, 14)
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(t.lineStrong))
            }
        }
        .padding(22)
        .frame(maxWidth: .infinity, alignment: .leading)
        .presentationDetents([.height(300)])
        .presentationBackground(t.bg)
        .presentationCornerRadius(28)
    }
}
