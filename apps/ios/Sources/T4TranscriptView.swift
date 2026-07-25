//  T4TranscriptView.swift
//  Renders a session transcript from HostWire TranscriptEntry rows. Each row is
//  a headline + body with a kind-colored accent rail. Backed by host-wire
//  durable entries (sample until session.attach + transcript.page are wired to a
//  live host).

import SwiftUI
import HostWire

struct T4TranscriptView: View {
    let entries: [TranscriptEntry]
    let theme: Theme

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(entries, id: \.id) { entry in
                T4TranscriptRow(entry: entry, theme: theme)
            }
        }
    }
}

struct T4TranscriptRow: View {
    let entry: TranscriptEntry
    let theme: Theme

    private var accent: Color {
        guard let kind = entry.kind else { return theme.txtLabel }
        switch kind {
        case .message: return theme.accent
        case .toolUse: return theme.cBash
        case .toolResult: return entry.body.contains("error") ? theme.diffDel : theme.diffAdd
        case .turnReview: return theme.cTask
        case .compaction: return theme.txtMuted
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Rectangle().fill(accent).frame(width: 3).clipShape(RoundedRectangle(cornerRadius: 1.5))
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.headline.isEmpty ? (entry.kind?.rawValue ?? "entry") : entry.headline)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(theme.txtBody)
                if !entry.body.isEmpty {
                    Text(entry.body).font(.system(size: 13)).foregroundStyle(theme.txt)
                }
                Text(entry.timestamp).font(.system(size: 9)).foregroundStyle(theme.txtLabel)
            }
        }
    }
}
