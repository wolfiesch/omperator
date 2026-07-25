//  T4SessionDetailView.swift
//  One session: identity + status + context, and (once attached over host-wire)
//  the live transcript. For now the transcript surface is a placeholder; it is
//  wired to host-wire durable entries in the next step.

import SwiftUI
import HostWire

struct T4SessionDetailView: View {
    let session: SessionRef
    @ObservedObject var store: T4SessionStore
    @EnvironmentObject var theme: ThemeStore
    private var t: Theme { theme.t }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                facts
                Divider().overlay(t.lineFaint)
                transcriptPlaceholder
            }
            .padding()
        }
        .background(t.bg.ignoresSafeArea())
        .navigationTitle(session.title)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(session.title).font(.system(size: 22, weight: .bold)).foregroundStyle(t.txt)
            Spacer()
            StatusPill(status: session.status, theme: t)
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
    }

    private var transcriptPlaceholder: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Transcript").font(.system(size: 13, weight: .semibold)).foregroundStyle(t.txtBody)
            Text("The live transcript renders here once the session is attached over host-wire.")
                .font(.system(size: 12)).foregroundStyle(t.txtMuted)
        }
    }
}
