import Foundation
import SwiftCrossUI
import HostWire

/// Compact neutral transcript renderer for the Windows core chat.
struct T4WindowsTranscriptView: View {
    let entries: [TranscriptEntry]
    var liveTurn: LiveTurnTimeline?
    var streamingMessage: StreamingAssistantBuffer?
    var liveTools: LiveToolProjection
    let palette: WindowsCorePalette

    @State private var visibleLimit = 24

    private var visibleEntries: ArraySlice<TranscriptEntry> {
        entries.suffix(visibleLimit)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if entries.count > visibleEntries.count {
                HStack {
                    Spacer()
                    T4TextButton("Show earlier") { visibleLimit += 40 }
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(palette.textMuted)
                    Spacer()
                }
            }

            ForEach(Array(visibleEntries), id: \.id) { entry in
                switch entry.kind {
                case .message where entry.role == "user":
                    T4WindowsUserMessage(entry: entry, palette: palette)
                case .message:
                    T4WindowsAssistantMessage(entry: entry, palette: palette)
                default:
                    T4WindowsTranscriptRow(entry: entry, palette: palette)
                }
            }

            if let liveTurn, !liveTurn.isEmpty {
                ForEach(liveTurn.blocks) { block in
                    T4WindowsLiveBlock(block: block, palette: palette)
                }
                streamingIndicator
            } else {
                if let streamingMessage, !streamingMessage.isEmpty {
                    T4WindowsStreamingMessage(buffer: streamingMessage, palette: palette)
                }
                ForEach(liveTools.calls) { call in
                    T4WindowsLiveTool(call: call, palette: palette)
                }
            }
        }
    }

    private var streamingIndicator: some View {
        HStack(spacing: 6) {
            Circle().fill(palette.accent).frame(width: 5, height: 5)
            Text("streaming")
                .font(.system(size: 9))
                .foregroundColor(palette.textFaint)
        }
    }
}

private struct T4WindowsUserMessage: View {
    let entry: TranscriptEntry
    let palette: WindowsCorePalette

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 70)
            Text(entry.body)
                .font(.system(size: 13))
                .foregroundColor(palette.text)
                .textSelectionEnabled()
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .frame(maxWidth: 570, alignment: .trailing)
                .background {
                    RoundedRectangle(cornerRadius: 10).fill(palette.surface)
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(palette.line, style: StrokeStyle(width: 1))
                }
        }
        .padding(.top, 3)
    }
}

private struct T4WindowsAssistantMessage: View {
    let entry: TranscriptEntry
    let palette: WindowsCorePalette
    @State private var expanded = false

    private static let previewCap = 4_000

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            let body = !expanded && entry.body.count > Self.previewCap
                ? String(entry.body.prefix(Self.previewCap)) + "\n\n…"
                : entry.body
            T4WindowsMarkdown(text: body, palette: palette)
            if !expanded && entry.body.count > Self.previewCap {
                T4TextButton("Show full message") { expanded = true }
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(palette.textMuted)
            }
        }
    }
}

private struct T4WindowsMarkdown: View {
    let text: String
    let palette: WindowsCorePalette

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            ForEach(Array(T4Markdown.blocks(in: text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .prose(let markdown):
                    VStack(alignment: .leading, spacing: 7) {
                        ForEach(Array(Self.paragraphs(markdown).enumerated()), id: \.offset) { _, paragraph in
                            Text(Self.clean(paragraph))
                                .font(.system(size: 13))
                                .foregroundColor(palette.textBody)
                                .textSelectionEnabled()
                        }
                    }
                case .code(let language, let code):
                    T4WindowsCodeBlock(language: language, code: code, palette: palette)
                }
            }
        }
    }

    private static func paragraphs(_ markdown: String) -> [String] {
        markdown
            .components(separatedBy: "\n\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private static func clean(_ markdown: String) -> String {
        markdown
            .replacingOccurrences(of: "**", with: "")
            .replacingOccurrences(of: "__", with: "")
            .replacingOccurrences(of: "`", with: "")
    }
}

private struct T4WindowsCodeBlock: View {
    let language: String
    let code: String
    let palette: WindowsCorePalette

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(language.isEmpty ? "code" : language)
                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                    .foregroundColor(palette.textFaint)
                Spacer()
            }
            .padding(.horizontal, 10)
            .frame(height: 28)
            .background(palette.surface)
            .overlay(alignment: .bottom) { Rectangle().fill(palette.line).frame(height: 1) }

            ScrollView(.horizontal) {
                Text(String(code.prefix(2_400)))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(palette.textBody)
                    .textSelectionEnabled()
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background {
            RoundedRectangle(cornerRadius: 8).fill(palette.surfaceSubtle)
            RoundedRectangle(cornerRadius: 8)
                .stroke(palette.line, style: StrokeStyle(width: 1))
        }
    }
}

private struct T4WindowsTranscriptRow: View {
    let entry: TranscriptEntry
    let palette: WindowsCorePalette
    @State private var expanded = false

    private var presentation: (icon: String, color: Color) {
        let head = entry.headline.lowercased()
        switch entry.kind {
        case .toolUse, .toolResult:
            let name = head.split(separator: " ").first.map(String.init) ?? "tool"
            switch name {
            case "read": return ("▤", palette.violet)
            case "write", "edit", "patch": return ("✎", palette.accent)
            case "bash", "terminal": return ("›", palette.working)
            case "task", "agent": return ("≡", palette.violet)
            case "search", "find", "grep": return ("⌕", palette.accent)
            case "todo": return ("✓", palette.success)
            default: return ("·", palette.warning)
            }
        case .turnReview: return ("◉", palette.violet)
        case .compaction: return ("▧", palette.textMuted)
        default: return ("·", palette.textFaint)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 7) {
                Text(presentation.icon)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(presentation.color)
                    .frame(width: 14)
                Text(entry.headline.isEmpty ? "Activity" : entry.headline)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(palette.textBody)
                    .lineLimit(1)
                Spacer()
                if !entry.body.isEmpty {
                    Text(expanded ? "⌃" : "›")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundColor(palette.textFaint)
                }
            }
            .padding(.horizontal, 10)
            .frame(minHeight: 32)

            if expanded && !entry.body.isEmpty {
                Rectangle().fill(palette.line).frame(height: 1)
                Text(String(entry.body.prefix(2_000)))
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(palette.textMuted)
                    .textSelectionEnabled()
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background {
            RoundedRectangle(cornerRadius: 8).fill(palette.surfaceSubtle)
            RoundedRectangle(cornerRadius: 8)
                .stroke(palette.line, style: StrokeStyle(width: 1))
        }
        .onTapGesture { expanded.toggle() }
    }
}

private struct T4WindowsStreamingMessage: View {
    let buffer: StreamingAssistantBuffer
    let palette: WindowsCorePalette

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !buffer.reasoning.isEmpty {
                Text(buffer.reasoning)
                    .font(.system(size: 11))
                    .italic()
                    .foregroundColor(palette.textMuted)
                    .textSelectionEnabled()
            }
            if !buffer.text.isEmpty {
                Text(buffer.text)
                    .font(.system(size: 13))
                    .foregroundColor(palette.textBody)
                    .textSelectionEnabled()
            }
            HStack(spacing: 6) {
                Circle().fill(palette.accent).frame(width: 5, height: 5)
                Text("streaming")
                    .font(.system(size: 9))
                    .foregroundColor(palette.textFaint)
            }
        }
    }
}

private struct T4WindowsLiveBlock: View {
    let block: LiveTurnBlock
    let palette: WindowsCorePalette

    private var active: Bool { block.phase == .generating || block.phase == .running }
    private var color: Color {
        switch block.phase {
        case .generating, .running: return palette.working
        case .succeeded: return palette.success
        case .failed: return palette.danger
        }
    }

    private var status: String {
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
                Text(String(block.content.suffix(1_800)))
                    .font(.system(size: 11))
                    .italic()
                    .foregroundColor(palette.textMuted)
                    .textSelectionEnabled()
            }
        case .text:
            if !block.content.isEmpty {
                Text(String(block.content.suffix(4_000)))
                    .font(.system(size: 13))
                    .foregroundColor(palette.textBody)
                    .textSelectionEnabled()
            }
        case .toolInput:
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 7) {
                    Circle().fill(color).frame(width: 5, height: 5)
                    Text(block.title.isEmpty ? block.tool : block.title)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(palette.textBody)
                    Spacer()
                    Text(status)
                        .font(.system(size: 9))
                        .foregroundColor(palette.textFaint)
                }
                if !block.previewText.isEmpty {
                    Text(String(block.previewText.prefix(2_400)))
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(palette.textBody)
                        .textSelectionEnabled()
                }
                if !block.progress.isEmpty {
                    Text(String(block.progress.suffix(1_600)))
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(palette.textMuted)
                        .textSelectionEnabled()
                }
                if !block.result.isEmpty && !active {
                    Text(String(block.result.prefix(1_600)))
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(palette.textMuted)
                        .textSelectionEnabled()
                }
            }
            .padding(9)
            .background {
                RoundedRectangle(cornerRadius: 8).fill(palette.surfaceSubtle)
                RoundedRectangle(cornerRadius: 8)
                    .stroke(palette.line, style: StrokeStyle(width: 1))
            }
        }
    }
}

private struct T4WindowsLiveTool: View {
    let call: LiveToolCall
    let palette: WindowsCorePalette

    private var active: Bool { call.phase == .generating || call.phase == .running }
    private var color: Color {
        switch call.phase {
        case .generating, .running: return palette.working
        case .succeeded: return palette.success
        case .failed: return palette.danger
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
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 7) {
                Circle().fill(color).frame(width: 5, height: 5)
                Text(call.title.isEmpty ? call.tool : call.title)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(palette.textBody)
                Spacer()
                Text(status)
                    .font(.system(size: 9))
                    .foregroundColor(palette.textFaint)
            }
            if !call.input.isEmpty {
                Text(String(call.input.prefix(2_400)))
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(palette.textBody)
                    .textSelectionEnabled()
            }
            if !call.progress.isEmpty {
                Text(String(call.progress.suffix(1_600)))
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(palette.textMuted)
                    .textSelectionEnabled()
            }
            if !call.result.isEmpty && !active {
                Text(String(call.result.prefix(1_600)))
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(palette.textMuted)
                    .textSelectionEnabled()
            }
        }
        .padding(9)
        .background {
            RoundedRectangle(cornerRadius: 8).fill(palette.surfaceSubtle)
            RoundedRectangle(cornerRadius: 8)
                .stroke(palette.line, style: StrokeStyle(width: 1))
        }
    }
}
