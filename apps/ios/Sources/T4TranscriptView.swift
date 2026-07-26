//  T4TranscriptView.swift
//  Claude Code-style transcript, matching the desktop web renderer:
//  user messages are right-aligned bubbles, assistant messages are full-width
//  markdown, and tool/turn rows stay as cards with a kind-colored accent rail.
//  Rows render host-wire durable entries (TranscriptEntry).

import SwiftUI
import HostWire

struct T4TranscriptView: View {
    let entries: [TranscriptEntry]
    /// In-progress assistant text (store.streamingText[sessionId]); when
    /// non-empty, rendered as a live tail row after the durable entries.
    var streamingText: String = ""
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
            if !streamingText.isEmpty {
                T4StreamingMessage(text: streamingText, theme: theme)
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

/// Tool / review / compaction rows: per-kind icon + tinted header, terminal
/// voice for outputs, syntax-colored code, and diff line tinting when the
/// body is a diff.
struct T4TranscriptRow: View {
    let entry: TranscriptEntry
    let theme: Theme
    @State private var expanded = false

    /// Tool-kind identity from the entry kind/headline.
    private var tool: (name: String, icon: String, color: Color) {
        let head = entry.headline.lowercased()
        switch entry.kind {
        case .toolUse, .toolResult:
            let name = head.split(separator: " ").first.map(String.init) ?? "tool"
            switch name {
            case "read":              return (name, "doc.text", theme.cLsp)
            case "write":             return (name, "doc.badge.plus", theme.diffAdd)
            case "edit", "patch":    return (name, "rectangle.and.pencil.and.ellipsis", theme.cEdit)
            case "bash", "terminal": return (name, "terminal", theme.cBash)
            case "task", "agent":    return (name, "person.3", theme.cTask)
            case "search", "find", "grep": return (name, "magnifyingglass", theme.accent)
            case "lsp":               return (name, "cross", theme.cLsp)
            case "todo":               return (name, "checklist", theme.accent)
            default:                  return (name, "wrench", theme.cAdvisor)
            }
        case .turnReview: return ("review", "eye", theme.cTask)
        case .compaction: return ("compact", "archivebox", theme.txtMuted)
        default:          return (entry.kind?.rawValue ?? "entry", "circle", theme.txtLabel)
        }
    }

    private var isDiffBody: Bool {
        entry.body.contains("\n@@") || entry.body.hasPrefix("diff ") || entry.body.contains("\n--- ") && entry.body.contains("\n+++ ")
    }

    private static let bodyCap = 1_600

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.easeInOut(duration: 0.18)) { expanded.toggle() } } label: {
                HStack(spacing: 7) {
                    Image(systemName: tool.icon)
                        .font(.system(size: 11))
                        .foregroundStyle(tool.color)
                        .frame(width: 15)
                    Text(entry.headline.isEmpty ? tool.name : entry.headline)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(theme.txtBody)
                        .lineLimit(expanded ? nil : 1)
                    Spacer(minLength: 4)
                    if !entry.body.isEmpty {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(theme.txtLabel)
                    }
                }
                .padding(.horizontal, 10).padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded && !entry.body.isEmpty {
                Group {
                    if isDiffBody {
                        Text(AttributedString(SyntaxHighlighter.diff(
                            String(entry.body.prefix(Self.bodyCap)), theme: theme, fontSize: 11)))
                    } else {
                        Text(String(entry.body.prefix(Self.bodyCap)))
                            .font(.term(12))
                            .foregroundStyle(theme.txt)
                    }
                }
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10).padding(.bottom, 8)
            }
        }
        .background(theme.glassFill2, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(tool.color.opacity(0.35), lineWidth: 1)
        )
    }
}

/// Live tail row: in-progress assistant text mirrored from `message.update`
/// events, rendered with the same T4Markdown treatment as a settled assistant
/// message plus a subtle pulsing cursor dot to signal the turn is streaming.
struct T4StreamingMessage: View {
    let text: String
    let theme: Theme

    @State private var pulse = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            T4Markdown(text: text, theme: theme)
            HStack(spacing: 6) {
                Circle()
                    .fill(theme.accent)
                    .frame(width: 6, height: 6)
                    .opacity(pulse ? 0.9 : 0.25)
                    .animation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: pulse)
                Text("streaming")
                    .font(.system(size: 9))
                    .foregroundStyle(theme.txtLabel)
            }
        }
        .padding(.top, 6)
        .accessibilityLabel("Assistant is typing: \(text)")
        .onAppear { pulse = true }
    }
}
