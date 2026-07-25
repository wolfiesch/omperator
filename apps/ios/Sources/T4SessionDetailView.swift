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
    let image: UIImage
    let jpeg: Data

    init?(source: UIImage, maxBytes: Int = 20 * 1024 * 1024) {
        // Downscale until the JPEG fits the wire's per-image limit.
        var scale: CGFloat = 1
        var candidate = source
        while true {
            if let jpeg = candidate.jpegData(compressionQuality: 0.85), jpeg.count <= maxBytes {
                self.image = candidate; self.jpeg = jpeg; return
            }
            scale *= 0.5
            let size = CGSize(width: source.size.width * scale, height: source.size.height * scale)
            guard size.width > 32, let resized = source.preparingThumbnail(of: size) else { return nil }
            candidate = resized
        }
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
    @State private var attachments: [ComposerAttachment] = []
    @State private var pickerItems: [PhotosPickerItem] = []
    @FocusState private var composerFocused: Bool
    private var t: Theme { theme.t }
    private static let maxImages = 8   // PROMPT_IMAGE_MAX_COUNT on the wire

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header
                    if showFacts { facts }
                    Divider().overlay(t.lineFaint)
                    T4TranscriptView(entries: store.transcript(for: session.sessionId), theme: t)
                }
                .padding()
            }
            composer
        }
        .background(t.bg.ignoresSafeArea())
        .navigationTitle(session.title)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            StatusPill(status: session.status, theme: t)
            if let model = session.model {
                Label(model, systemImage: "cpu")
                    .font(.system(size: 11))
                    .foregroundStyle(t.txtMuted)
                    .lineLimit(1)
            }
            Spacer()
            Button { withAnimation(.easeInOut(duration: 0.2)) { showFacts.toggle() } } label: {
                Image(systemName: showFacts ? "info.circle.fill" : "info.circle")
                    .font(.system(size: 16))
                    .foregroundStyle(t.txtMuted)
                    .frame(width: 34, height: 34)
            }
            .press()
            .accessibilityLabel("Session details")
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
                    .font(.bodyF(14)).foregroundStyle(t.txt).tint(t.accent)
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
        .glass(t, 16)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(t.bg)
        .onChange(of: pickerItems) { _, items in loadAttachments(items) }
        .onAppear { dictation.onText = { draft = $0 } }
    }

    private var placeholder: String {
        if !store.connected { return "Connect a host to message" }
        if dictation.recording { return "Listening\u{2026}" }
        return session.status == "active" ? "Steer the turn\u{2026}" : "Message the agent\u{2026}"
    }

    @ViewBuilder private var sendOrStop: some View {
        if store.connected && session.status == "active" {
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
                            Image(uiImage: a.image).resizable().scaledToFill()
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
                   let image = UIImage(data: data),
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
}
