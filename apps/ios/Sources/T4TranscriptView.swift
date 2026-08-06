//  T4TranscriptView.swift
//  Claude Code-style transcript, matching the desktop web renderer:
//  user messages are right-aligned bubbles, assistant messages are full-width
//  markdown, and tool/turn rows stay as cards with a kind-colored accent rail.
//  Rows render host-wire durable entries (TranscriptEntry).

import SwiftUI
import HostWire

struct T4TranscriptView: View {
    let entries: [TranscriptEntry]
    var liveTurn: LiveTurnTimeline?
    var streamingMessage: StreamingAssistantBuffer?
    var liveTools: LiveToolProjection
    let theme: Theme

    /// Render window: only the most recent `visibleLimit` entries are drawn.
    /// Long transcripts re-render every row — markdown bodies included — on
    /// each paced streaming delta, which pegs the main thread on live
    /// sessions. The window keeps live updates cheap; the button pages
    /// older entries forward.
    @State private var visibleLimit = 40

    private var visibleEntries: ArraySlice<TranscriptEntry> {
        entries.suffix(visibleLimit)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if entries.count > visibleEntries.count {
                HStack {
                    Spacer()
                    Button("Show \(min(40, entries.count - visibleEntries.count)) earlier of \(entries.count - visibleEntries.count)") {
                        visibleLimit += 40
                    }
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(theme.txtMuted)
                    .buttonStyle(.plain)
                    Spacer()
                }
            }
            ForEach(visibleEntries, id: \.id) { entry in
                switch entry.kind {
                case .message where entry.role == "user":
                    T4UserBubble(entry: entry, theme: theme)
                case .message:
                    T4AssistantMessage(entry: entry, theme: theme)
                default:
                    T4TranscriptRow(entry: entry, theme: theme)
                }
            }
            if let liveTurn, !liveTurn.isEmpty {
                ForEach(liveTurn.blocks) { block in
                    T4LiveTurnBlockView(block: block, theme: theme)
                }
                T4StreamingIndicator(theme: theme)
            } else {
                if let streamingMessage, !streamingMessage.isEmpty {
                    T4StreamingMessage(
                        text: streamingMessage.text,
                        reasoning: streamingMessage.reasoning,
                        theme: theme
                    )
                }
                ForEach(liveTools.calls) { call in
                    T4LiveToolRow(call: call, theme: theme)
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

/// Live tail row. The unfinished tail intentionally stays lightweight plain
/// text; settled entries receive full Markdown and syntax highlighting.
struct T4StreamingMessage: View {
    let text: String
    let reasoning: String
    let theme: Theme

    @State private var pulse = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !reasoning.isEmpty {
                Text(reasoning)
                    .font(.system(size: 13))
                    .italic()
                    .foregroundStyle(theme.txtMuted)
                    .textSelection(.enabled)
            }
            if !text.isEmpty {
                Text(text)
                    .font(.system(size: 15))
                    .foregroundStyle(theme.txt)
                    .textSelection(.enabled)
            }
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

struct T4StreamingIndicator: View {
    let theme: Theme
    @State private var pulse = false

    var body: some View {
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
        .onAppear { pulse = true }
    }
}

/// An OMP-native live block. Separate rows retain the provider's real block
/// order, so thinking can lead into text and multiple generated tool calls
/// remain visible together instead of being flattened into one tail message.
struct T4LiveTurnBlockView: View {
    let block: LiveTurnBlock
    let theme: Theme
    @State private var pulse = false

    private var isActiveTool: Bool {
        block.phase == .generating || block.phase == .running
    }

    private var toolColor: Color {
        switch block.phase {
        case .generating, .running: return theme.cBash
        case .succeeded: return theme.diffAdd
        case .failed: return theme.diffDel
        }
    }

    private var toolStatus: String {
        switch block.phase {
        case .generating: return "preparing"
        case .running: return "running"
        case .succeeded: return "completed"
        case .failed: return "failed"
        }
    }

    var body: some View {
        switch block.kind {
        case .thinking:
            if !block.content.isEmpty {
                Text(block.content)
                    .font(.system(size: 13))
                    .italic()
                    .foregroundStyle(theme.txtMuted)
                    .textSelection(.enabled)
                    .accessibilityLabel("Assistant thinking: \(block.content)")
                    .accessibilityIdentifier("live-turn-thinking")
            }
        case .text:
            if !block.content.isEmpty {
                Text(block.content)
                    .font(.system(size: 15))
                    .foregroundStyle(theme.txt)
                    .textSelection(.enabled)
                    .accessibilityLabel("Assistant is typing: \(block.content)")
            }
        case .toolInput:
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 7) {
                    Image(systemName: toolIcon)
                        .font(.system(size: 11))
                        .foregroundStyle(toolColor)
                    Text(block.title.isEmpty ? block.tool : block.title)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(theme.txtBody)
                    Spacer()
                    Circle()
                        .fill(toolColor)
                        .frame(width: 6, height: 6)
                        .opacity(isActiveTool && pulse ? 0.9 : 0.35)
                    Text(toolStatus)
                        .font(.system(size: 9))
                        .foregroundStyle(theme.txtLabel)
                }
                if !block.previewText.isEmpty {
                    Text(String(block.previewText.prefix(2_400)))
                        .font(.term(11.5))
                        .foregroundStyle(theme.txt)
                        .textSelection(.enabled)
                }
                if !block.progress.isEmpty {
                    Text(String(block.progress.suffix(1_600)))
                        .font(.term(11.5))
                        .foregroundStyle(theme.txtMuted)
                        .textSelection(.enabled)
                }
                if !block.result.isEmpty && !isActiveTool {
                    Text(String(block.result.prefix(1_600)))
                        .font(.term(11.5))
                        .foregroundStyle(theme.txtMuted)
                        .textSelection(.enabled)
                }
            }
            .padding(10)
            .background(theme.glassFill2, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(toolColor.opacity(0.35), lineWidth: 1)
            )
            .animation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true), value: pulse)
            .onAppear { pulse = true }
            .accessibilityLabel("\(block.tool) \(toolStatus): \(block.previewText)")
            .accessibilityIdentifier("live-turn-tool-\(block.tool.lowercased())")
        }
    }

    private var toolIcon: String {
        switch block.tool.lowercased() {
        case "read": return "doc.text"
        case "write": return "doc.badge.plus"
        case "edit", "patch": return "rectangle.and.pencil.and.ellipsis"
        case "bash", "shell", "terminal": return "terminal"
        case "task", "agent": return "person.3"
        case "search", "find", "grep": return "magnifyingglass"
        case "todo": return "checklist"
        default: return "wrench.and.screwdriver"
        }
    }
}

struct T4LiveToolRow: View {
    let call: LiveToolCall
    let theme: Theme
    @State private var pulse = false

    private var isActive: Bool { call.phase == .generating || call.phase == .running }
    private var color: Color {
        switch call.phase {
        case .generating, .running: return theme.cBash
        case .succeeded: return theme.diffAdd
        case .failed: return theme.diffDel
        }
    }
    private var status: String {
        switch call.phase {
        case .generating: return "preparing"
        case .running: return "running"
        case .succeeded: return "completed"
        case .failed: return "failed"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 7) {
                Image(systemName: "wrench.and.screwdriver")
                    .font(.system(size: 11))
                    .foregroundStyle(color)
                Text(call.title.isEmpty ? call.tool : call.title)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(theme.txtBody)
                Spacer()
                Circle()
                    .fill(color)
                    .frame(width: 6, height: 6)
                    .opacity(isActive && pulse ? 0.9 : 0.35)
                Text(status)
                    .font(.system(size: 9))
                    .foregroundStyle(theme.txtLabel)
            }
            if !call.input.isEmpty {
                Text(String(call.input.prefix(2_400)))
                    .font(.term(11.5))
                    .foregroundStyle(theme.txt)
                    .textSelection(.enabled)
            }
            if !call.progress.isEmpty {
                Text(String(call.progress.suffix(1_600)))
                    .font(.term(11.5))
                    .foregroundStyle(theme.txtMuted)
                    .textSelection(.enabled)
            }
            if !call.result.isEmpty && !isActive {
                Text(String(call.result.prefix(1_600)))
                    .font(.term(11.5))
                    .foregroundStyle(theme.txtMuted)
                    .textSelection(.enabled)
            }
        }
        .padding(10)
        .background(theme.glassFill2, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(color.opacity(0.35), lineWidth: 1)
        )
        .animation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true), value: pulse)
        .onAppear { pulse = true }
        .accessibilityLabel("\(call.tool) \(status)")
    }
}
