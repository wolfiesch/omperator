//  T4TranscriptView.swift
//  Claude Code-style transcript, matching the desktop web renderer:
//  user messages are right-aligned bubbles, assistant messages are full-width
//  markdown, and tool/turn rows stay as cards with a kind-colored accent rail.
//  Rows render host-wire durable entries (TranscriptEntry).

import SwiftUI
import HostWire

struct T4TranscriptView: View {
    let entries: [TranscriptEntry]
    let theme: Theme

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(entries, id: \.id) { entry in
                switch entry.kind {
                case .message where entry.role == "user":
                    T4UserBubble(entry: entry, theme: theme)
                case .message:
                    T4AssistantMessage(entry: entry, theme: theme)
                default:
                    T4TranscriptRow(entry: entry, theme: theme)
                }
            }
        }
    }
}

/// User message: right-aligned bubble, like the desktop renderer
/// (`justify-end`, max ~85% width, secondary fill).
struct T4UserBubble: View {
    let entry: TranscriptEntry
    let theme: Theme

    var body: some View {
        HStack {
            Spacer(minLength: 40)
            Text(entry.body)
                .font(.system(size: 15))
                .foregroundStyle(theme.txt)
                .textSelection(.enabled)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(theme.glassFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(theme.line, lineWidth: 1)
                )
        }
        .padding(.top, 6)
        .accessibilityLabel("You said: \(entry.body)")
    }
}

/// Assistant message: full-width markdown, no chrome — like Claude Code.
struct T4AssistantMessage: View {
    let entry: TranscriptEntry
    let theme: Theme

    var body: some View {
        T4Markdown(text: entry.body, theme: theme)
            .padding(.top, 6)
            .accessibilityLabel("Assistant said: \(entry.body)")
    }
}

/// Tool / review / compaction rows: the card treatment (accent rail +
/// headline + body), unchanged from the original rail renderer.
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
