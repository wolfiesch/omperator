//  T4SessionDetailView.swift
//  One session, desktop-parity: the transcript is the star (scrollable), a
//  compact facts strip sits above it, and a composer docks at the bottom.
//  Transcript renders host-wire durable entries (TranscriptEntry); the
//  composer sends session.prompt over host-wire and is disabled with a clear
//  hint until a host is connected.

import SwiftUI
import HostWire

struct T4SessionDetailView: View {
    let session: SessionRef
    @ObservedObject var store: T4SessionStore
    @EnvironmentObject var theme: ThemeStore
    @State private var draft = ""
    @State private var sending = false
    @State private var showFacts = false
    private var t: Theme { theme.t }

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
            Divider().overlay(t.line)
            HStack(alignment: .bottom, spacing: 10) {
                TextField(store.connected ? "Message…" : "Connect a host to message", text: $draft, axis: .vertical)
                    .font(.system(size: 15))
                    .foregroundStyle(t.txt)
                    .lineLimit(1...6)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(t.glassFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .disabled(!store.connected)
                    .onSubmit { send() }

                Button { send() } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 32))
                        .foregroundStyle(canSend ? t.accent : t.txtGhost)
                }
                .press()
                .disabled(!canSend)
                .accessibilityLabel("Send message")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(t.bg)
        }
    }

    private var canSend: Bool {
        store.connected && !sending && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
}
