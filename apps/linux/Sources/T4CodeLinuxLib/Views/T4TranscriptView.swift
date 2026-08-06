//  T4TranscriptView.swift (Linux port of apps/ios/Sources/T4TranscriptView.swift)
//  Claude Code-style transcript, matching the desktop web renderer:
//  user messages are right-aligned bubbles, assistant messages are full-width
//  markdown, and tool/turn rows stay as cards with a kind-colored accent rail.
//  Rows render host-wire durable entries (TranscriptEntry).
//
//  Linux deltas:
//  - SF Symbol icons become text glyphs (SwiftCrossUI has no symbol images).
//  - Buttons with custom labels become `.onTapGesture` rows (Button takes a
//    String label only).
//  - Pulse animations, `.animation`, `.transition`, `.textSelection(.enabled)`
//    → static accent dot + `.textSelectionEnabled()` (LINUX-GAP: no animation
//    system; withAnimation is a no-op shim).

import SwiftCrossUI
import HostWire

struct T4TranscriptView: View {
    let entries: [TranscriptEntry]
    var liveTurn: LiveTurnTimeline?
    var streamingMessage: StreamingAssistantBuffer?
    var liveTools: LiveToolProjection
    let theme: Theme

    /// Render window: only the most recent `visibleLimit` entries are drawn.
    /// Older history is paged in via the "Load earlier" control. This caps
    /// the per-render widget count so large transcripts stay snappy.
    @State private var visibleLimit = 20

    /// The slice of entries actually rendered (the tail of the history).
    private var visibleEntries: ArraySlice<TranscriptEntry> {
        entries.suffix(visibleLimit)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if entries.count > visibleEntries.count {
                HStack {
                    Spacer()
                    T4TextButton("Show \(min(40, entries.count - visibleEntries.count)) earlier of \(entries.count - visibleEntries.count)") {
                        visibleLimit += 40
                    }
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(theme.txtMuted)
                    Spacer()
                }
            }
            ForEach(Array(visibleEntries), id: \.id) { entry in
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
        // Cap the bubble at ~85% of the transcript width (the desktop
        // renderer's rule); without the cap a long prompt measures at its
        // natural one-line width and overflows the detail's right edge.
        GeometryReader { proxy in
            HStack {
                Spacer()
                Text(entry.body)
                    .font(.system(size: 15))
                    .foregroundColor(theme.txt)
                    .textSelectionEnabled()
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background {
                        RoundedRectangle(cornerRadius: 14)
                            .fill(theme.glassFill)
                    }
                    .overlay {
                        RoundedRectangle(cornerRadius: 14)
                            .stroke(theme.line, style: StrokeStyle(width: 1))
                    }
                    .frame(maxWidth: proxy.size.width * 0.85, alignment: .trailing)
            }
        }
        .padding(.top, 6)
    }
}

/// Assistant message: full-width markdown, no chrome — like Claude Code.
struct T4AssistantMessage: View {
    let entry: TranscriptEntry
    let theme: Theme
    @State private var expanded = false

    /// Linux perf bound: SwiftCrossUI lays out every markdown/code line as
    /// its own widget, so uncapped multi-KB assistant bodies make every
    /// re-render (each stream event) a layout storm. Render the head by
    /// default; "Show full" reveals the complete body on demand.
    private static let previewCap = 3_000

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !expanded && entry.body.count > Self.previewCap {
                T4Markdown(text: String(entry.body.prefix(Self.previewCap)) + "\n\n…", theme: theme)
                    .padding(.top, 6)
                T4TextButton("Show full message (\(entry.body.count) chars)") { expanded = true }
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(theme.txtMuted)
            } else {
                T4Markdown(text: entry.body, theme: theme)
                    .padding(.top, 6)
            }
        }
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
            case "read":              return (name, "▤", theme.cLsp)
            case "write":             return (name, "✎", theme.diffAdd)
            case "edit", "patch":     return (name, "✎", theme.cEdit)
            case "bash", "terminal":  return (name, "❯", theme.cBash)
            case "task", "agent":     return (name, "☰", theme.cTask)
            case "search", "find", "grep": return (name, "⌕", theme.accent)
            case "lsp":               return (name, "✚", theme.cLsp)
            case "todo":              return (name, "☑", theme.accent)
            default:                  return (name, "⚙", theme.cAdvisor)
            }
        case .turnReview: return ("review", "◉", theme.cTask)
        case .compaction: return ("compact", "▣", theme.txtMuted)
        default:          return (entry.kind?.rawValue ?? "entry", "●", theme.txtLabel)
        }
    }

    private var isDiffBody: Bool {
        entry.body.contains("\n@@") || entry.body.hasPrefix("diff ") || entry.body.contains("\n--- ") && entry.body.contains("\n+++ ")
    }

    private static let bodyCap = 1_600

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 7) {
                Text(tool.icon)
                    .font(.system(size: 11))
                    .foregroundColor(tool.color)
                    .frame(width: 15)
                Text(entry.headline.isEmpty ? tool.name : entry.headline)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(theme.txtBody)
                    .lineLimit(expanded ? nil : 1)
                Spacer()
                if !entry.body.isEmpty {
                    Text(expanded ? "▼" : "▶")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(theme.txtLabel)
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 8)

            if expanded && !entry.body.isEmpty {
                Group {
                    if isDiffBody {
                        // LINUX-GAP: macOS nests this in Text(AttributedString);
                        // runs render as colored line rows instead.
                        SyntaxLinesView(runs: SyntaxHighlighter.diffSegments(
                            String(entry.body.prefix(Self.bodyCap)), theme: theme))
                            .font(.term(11))
                            .textSelectionEnabled()
                    } else {
                        Text(String(entry.body.prefix(Self.bodyCap)))
                            .font(.term(12))
                            .foregroundColor(theme.txt)
                            .textSelectionEnabled()
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10).padding(.bottom, 8)
            }
        }
        .background {
            // Fill and ring both live in the background: an overlay stroke
            // sits on top of the tap gesture and eats clicks (the same
            // class of bug as the entry-focus issue — keep overlays
            // non-interactive).
            RoundedRectangle(cornerRadius: 10)
                .fill(theme.glassFill2)
            RoundedRectangle(cornerRadius: 10)
                .stroke(tool.color.opacity(0.35), style: StrokeStyle(width: 1))
        }
        // Toggle on the whole card: GTK recognizes a click on release and a
        // drag on motion, so tapping anywhere toggles while drag-selecting
        // the body text still works.
        .onTapGesture { expanded.toggle() }
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
                    .foregroundColor(theme.txtMuted)
                    .textSelectionEnabled()
            }
            if !text.isEmpty {
                Text(text)
                    .font(.system(size: 15))
                    .foregroundColor(theme.txt)
                    .textSelectionEnabled()
            }
            HStack(spacing: 6) {
                // LINUX-GAP: macOS pulses the dot with a repeatForever
                // animation; Linux renders it static at the lit opacity.
                Circle()
                    .fill(theme.accent.opacity(pulse ? 0.9 : 0.25))
                    .frame(width: 6, height: 6)
                Text("streaming")
                    .font(.system(size: 9))
                    .foregroundColor(theme.txtLabel)
            }
        }
        .padding(.top, 6)
        // .onAppear { pulse = true } — disabled: remount-per-render makes this
        // a state-mutation → re-render loop on live sessions (100% CPU).
    }
}

struct T4StreamingIndicator: View {
    let theme: Theme
    @State private var pulse = false

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(theme.accent.opacity(pulse ? 0.9 : 0.25))
                .frame(width: 6, height: 6)
            Text("streaming")
                .font(.system(size: 9))
                .foregroundColor(theme.txtLabel)
        }
        // .onAppear { pulse = true } — disabled: when the widget is remounted
        // per render pass, onAppear → @State mutation → re-render loop
        // (main thread pegs at 100% CPU on a live session).
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
                // Linux perf bound: an uncapped thinking block re-shapes
                // thousands of chars on every stream event; the freshest
                // thinking is at the tail.
                Text(String(block.content.suffix(1_600)))
                    .font(.system(size: 13))
                    .italic()
                    .foregroundColor(theme.txtMuted)
                    .textSelectionEnabled()
            }
        case .text:
            if !block.content.isEmpty {
                Text(String(block.content.suffix(3_000)))
                    .font(.system(size: 15))
                    .foregroundColor(theme.txt)
                    .textSelectionEnabled()
            }
        case .toolInput:
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 7) {
                    Text(toolIcon)
                        .font(.system(size: 11))
                        .foregroundColor(toolColor)
                    Text(block.title.isEmpty ? block.tool : block.title)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(theme.txtBody)
                    Spacer()
                    Circle()
                        .fill(toolColor.opacity(isActiveTool && pulse ? 0.9 : 0.35))
                        .frame(width: 6, height: 6)
                    Text(toolStatus)
                        .font(.system(size: 9))
                        .foregroundColor(theme.txtLabel)
                }
                if !block.previewText.isEmpty {
                    Text(String(block.previewText.prefix(2_400)))
                        .font(.term(11.5))
                        .foregroundColor(theme.txt)
                        .textSelectionEnabled()
                }
                if !block.progress.isEmpty {
                    Text(String(block.progress.suffix(1_600)))
                        .font(.term(11.5))
                        .foregroundColor(theme.txtMuted)
                        .textSelectionEnabled()
                }
                if !block.result.isEmpty && !isActiveTool {
                    Text(String(block.result.prefix(1_600)))
                        .font(.term(11.5))
                        .foregroundColor(theme.txtMuted)
                        .textSelectionEnabled()
                }
            }
            .padding(10)
            .background {
                RoundedRectangle(cornerRadius: 10)
                    .fill(theme.glassFill2)
            }
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .stroke(toolColor.opacity(0.35), style: StrokeStyle(width: 1))
            }
            // .onAppear { pulse = true } — disabled: remount-per-render makes
            // this a state-mutation → re-render loop (100% CPU on live data).
        }
    }

    private var toolIcon: String {
        switch block.tool.lowercased() {
        case "read": return "▤"
        case "write": return "✎"
        case "edit", "patch": return "✎"
        case "bash", "shell", "terminal": return "❯"
        case "task", "agent": return "☰"
        case "search", "find", "grep": return "⌕"
        case "todo": return "☑"
        default: return "⚙"
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
                Text("⚙")
                    .font(.system(size: 11))
                    .foregroundColor(color)
                Text(call.title.isEmpty ? call.tool : call.title)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(theme.txtBody)
                Spacer()
                Circle()
                    .fill(color.opacity(isActive && pulse ? 0.9 : 0.35))
                    .frame(width: 6, height: 6)
                Text(status)
                    .font(.system(size: 9))
                    .foregroundColor(theme.txtLabel)
            }
            if !call.input.isEmpty {
                Text(String(call.input.prefix(2_400)))
                    .font(.term(11.5))
                    .foregroundColor(theme.txt)
                    .textSelectionEnabled()
            }
            if !call.progress.isEmpty {
                Text(String(call.progress.suffix(1_600)))
                    .font(.term(11.5))
                    .foregroundColor(theme.txtMuted)
                    .textSelectionEnabled()
            }
            if !call.result.isEmpty && !isActive {
                Text(String(call.result.prefix(1_600)))
                    .font(.term(11.5))
                    .foregroundColor(theme.txtMuted)
                    .textSelectionEnabled()
            }
        }
        .padding(10)
        .background {
            RoundedRectangle(cornerRadius: 10)
                .fill(theme.glassFill2)
        }
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .stroke(color.opacity(0.35), style: StrokeStyle(width: 1))
        }
        // .onAppear { pulse = true } — disabled: remount-per-render makes this
        // a state-mutation → re-render loop (100% CPU on live data).
    }
}
