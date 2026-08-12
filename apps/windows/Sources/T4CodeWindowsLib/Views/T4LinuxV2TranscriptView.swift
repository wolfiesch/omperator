import SwiftCrossUI
import HostWire

struct T4LinuxV2TranscriptView: View {
    let session: SessionRef
    let store: T4SessionStore
    let theme: ThemeStore
    let composer: Binding<String>

    private var entries: [TranscriptEntry] { store.transcript(for: session.sessionId) }
    private var streaming: StreamingAssistantBuffer? { store.streamingMessages[session.sessionId] }
    private var streamingText: String {
        guard let streaming else { return "" }
        if streaming.reasoning.isEmpty { return streaming.text }
        if streaming.text.isEmpty { return streaming.reasoning }
        return streaming.reasoning + "\n\n" + streaming.text
    }
    private var isStreaming: Bool {
        streaming != nil || store.activeTurns.contains(session.sessionId)
    }
    private var contentVersion: String {
        "\(entries.count):\(entries.last?.id ?? ""):\(streamingText.utf8.count)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(entries, id: \.id) { entry in
                        T4LinuxV2TranscriptEntryView(entry: entry, theme: theme)
                    }
                    if !streamingText.isEmpty {
                        T4LinuxV2AssistantBlocks(
                            text: streamingText,
                            theme: theme,
                            maxCharacters: nil
                        )
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .t4ManageTranscriptScroll(
                sessionID: session.sessionId,
                contentVersion: contentVersion
            )
            Divider()
            composerBar
        }
    }

    private var composerBar: some View {
        let enabled = T4LinuxV2ComposerPolicy.isEnabled(
            connected: store.connected,
            hasSession: true,
            streamingText: isStreaming ? "streaming" : ""
        )
        return HStack(spacing: 8) {
            TextField("", text: composer)
                .inspect([.onCreate, .afterUpdate]) { field in
                    T4WindowsNativeStyle.configureInput(
                        field,
                        automationName: "Message",
                        dark: theme.dark
                    )
                }
                .disabled(!enabled)
            T4WindowsFlatButton(
                "➤",
                automationName: "Send message",
                dark: theme.dark
            ) {
                submit()
            }
            .disabled(!enabled || composer.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(theme.dark
            ? Color(hex: 0x393552).opacity(0.55)
            : Color.white.opacity(0.65))
    }

    private func submit() {
        let text = composer.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isStreaming, store.connected else { return }
        composer.wrappedValue = ""
        Task { await store.sendPrompt(sessionId: session.sessionId, text: text) }
    }
}

private struct T4LinuxV2TranscriptEntryView: View {
    let entry: TranscriptEntry
    let theme: ThemeStore

    var body: some View {
        if entry.kind == .message, entry.role == "user" {
            HStack(spacing: 0) {
                Spacer()
                T4WindowsRichText(
                    segments: T4LinuxV2MarkdownParser.render(body: entryText),
                    dark: theme.dark,
                    bubble: true,
                    maxCharacters: 48
                )
                .padding(.horizontal, 13)
                .padding(.vertical, 10)
                .background(theme.dark
                    ? Color(hex: 0x393552).opacity(0.55)
                    : Color.white.opacity(0.60))
                .overlay {
                    Rectangle()
                        .stroke(theme.dark ? Color(hex: 0x393552) : Color(hex: 0xDFDAD9))
                }
            }
            .frame(maxWidth: .infinity)
        } else if entry.kind == .message {
            T4LinuxV2AssistantBlocks(
                text: entryText,
                theme: theme,
                maxCharacters: 110
            )
        } else {
            T4LinuxV2ToolCard(
                title: entry.headline.isEmpty ? "Tool" : entry.headline,
                body: entry.body,
                kind: entry.kind?.rawValue ?? "unknown",
                theme: theme
            )
        }
    }

    private var entryText: String { entry.body.isEmpty ? entry.headline : entry.body }
}

private struct T4LinuxV2AssistantBlocks: View {
    let text: String
    let theme: ThemeStore
    let maxCharacters: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            ForEach(Array(T4LinuxV2MarkdownParser.blocks(text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .prose(let prose):
                    T4WindowsRichText(
                        segments: T4LinuxV2MarkdownParser.render(body: prose),
                        dark: theme.dark,
                        bubble: false,
                        maxCharacters: maxCharacters
                    )
                case .code(let language, let body):
                    T4LinuxV2CodeCard(language: language, code: body, theme: theme)
                case .advisory(let severity, let guidance, let body):
                    T4LinuxV2AdvisoryCard(
                        severity: severity,
                        guidance: guidance,
                        bodyText: body,
                        theme: theme
                    )
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct T4LinuxV2CodeCard: View {
    let language: String
    let code: String
    let theme: ThemeStore
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                T4WindowsFlatButton(
                    expanded ? "▾" : "▸",
                    automationName: expanded ? "Collapse code" : "Expand code",
                    dark: theme.dark
                ) {
                    expanded.toggle()
                }
                Text((language.isEmpty ? "code" : language).uppercased())
                    .font(.system(size: 8.5, weight: .bold).monospaced())
                    .foregroundColor(theme.t.txtLabel)
                Spacer()
                T4WindowsFlatButton("COPY", automationName: "Copy code", dark: theme.dark) {
                    T4WindowsClipboard.copy(code)
                }
                .font(.system(size: 8.5, weight: .semibold).monospaced())
            }
            if expanded {
                Divider()
                ScrollView(.horizontal) {
                    SyntaxLinesView(
                        runs: SyntaxHighlighter.segments(
                            code,
                            language: language,
                            theme: theme.t
                        )
                    )
                    .font(.term(12.5))
                    .textSelectionEnabled()
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(.top, 10)
        .padding(.horizontal, 12)
        .padding(.bottom, expanded ? 10 : 0)
        .background(theme.dark ? Color(hex: 0x2A273F) : Color(hex: 0xF2E9E1))
        .overlay {
            Rectangle()
                .stroke(theme.t.line, style: StrokeStyle(width: 1))
        }
    }
}

private struct T4LinuxV2AdvisoryCard: View {
    let severity: String?
    let guidance: String?
    let bodyText: String
    let theme: ThemeStore
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                T4WindowsFlatButton(
                    expanded ? "▾" : "▸",
                    automationName: expanded ? "Collapse advisory" : "Expand advisory",
                    dark: theme.dark
                ) {
                    expanded.toggle()
                }
                Text(advisoryTitle)
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(advisoryColor)
                Spacer()
            }
            if expanded {
                Divider()
                VStack(alignment: .leading, spacing: 5) {
                    if let guidance, !guidance.isEmpty {
                        Text(guidance)
                            .font(.system(size: 9))
                            .foregroundColor(theme.t.txtMuted)
                    }
                    if !bodyText.isEmpty {
                        T4WindowsRichText(
                            segments: T4LinuxV2MarkdownParser.render(body: bodyText),
                            dark: theme.dark,
                            bubble: false,
                            maxCharacters: 110
                        )
                    }
                }
                .padding(.top, 5)
            }
        }
        .padding(.top, 10)
        .padding(.horizontal, 12)
        .padding(.bottom, expanded ? 10 : 0)
        .background(theme.t.bg2)
        .overlay {
            Rectangle()
                .stroke(theme.t.line, style: StrokeStyle(width: 1))
        }
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(advisoryColor)
                .frame(width: 3)
        }
    }

    private var advisoryTitle: String {
        let value = severity?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty ? "ADVISORY" : value.uppercased()
    }

    private var advisoryColor: Color {
        switch severity?.lowercased() {
        case "error", "blocker":
            theme.t.diffDel
        case "info":
            theme.t.cBash
        default:
            theme.t.cAdvisor
        }
    }
}

private struct T4LinuxV2ToolCard: View {
    let title: String
    let bodyText: String
    let kind: String
    let theme: ThemeStore
    @State private var expanded = false

    init(title: String, body: String, kind: String, theme: ThemeStore) {
        self.title = title
        bodyText = body
        self.kind = kind
        self.theme = theme
    }

    private var hasBody: Bool {
        !bodyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                T4WindowsFlatButton(
                    expanded ? "▾" : "▸",
                    automationName: expanded ? "Collapse tool result" : "Expand tool result",
                    dark: theme.dark
                ) {
                    if hasBody { expanded.toggle() }
                }
                .disabled(!hasBody)
                Text(title.uppercased())
                    .font(.system(size: 9.5, weight: .bold))
                    .foregroundColor(toolColor)
                Spacer()
            }
            if expanded, hasBody {
                Divider()
                Text(bodyText)
                    .font(.system(size: 9))
                    .foregroundColor(theme.t.txtMuted)
                    .textSelectionEnabled()
                    .padding(.top, 3)
            }
        }
        .padding(.top, 10)
        .padding(.horizontal, 12)
        .padding(.bottom, expanded ? 10 : 0)
        .background(theme.t.bg2)
        .overlay {
            Rectangle()
                .stroke(theme.t.line, style: StrokeStyle(width: 1))
        }
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(toolColor)
                .frame(width: 3)
        }
    }

    private var toolColor: Color {
        let lower = kind.lowercased()
        if lower.contains("result") { return theme.t.cBash }
        if lower.contains("thinking") { return theme.t.cLsp }
        return theme.t.cEdit
    }
}
