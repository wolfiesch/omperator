//  T4TranscriptTextSelection.swift
//  Claude Code-style text selection: SwiftUI's .textSelection only spans a
//  single Text view, so arbitrary cross-message selection happens in a
//  dedicated sheet that renders the whole transcript into ONE native
//  selectable text view (UITextView on iOS, NSTextView on macOS).

import SwiftUI
import HostWire

/// The full transcript flattened into one attributed string: user prompts
/// prefixed like Claude Code (`❯`), assistant bodies markdown-rendered, and
/// tool/turn rows as a bold headline plus monospaced body. No caps — this
/// sheet exists so the user can copy exact text, including long outputs.
enum TranscriptTextSelection {
    static func flatten(entries: [TranscriptEntry], theme t: Theme) -> NSAttributedString {
        let out = NSMutableAttributedString()
        let promptColor = PlatformColor(t.txt)
        let bodyColor = PlatformColor(t.txt)
        let mutedColor = PlatformColor(t.txtMuted)
        let bodyFont = PlatformFont.systemFont(ofSize: 14)
        let headlineFont = PlatformFont.boldSystemFont(ofSize: 12)
        let monoFont = PlatformFont.monospacedSystemFont(ofSize: 12.5, weight: .regular)

        func append(_ string: String, color: PlatformColor, font: PlatformFont) {
            out.append(NSAttributedString(string: string, attributes: [
                .foregroundColor: color,
                .font: font,
            ]))
        }

        for entry in entries {
            switch entry.kind {
            case .message where entry.role == "user":
                append("❯ \(entry.body)", color: promptColor, font: bodyFont)
            case .message:
                if let parsed = try? AttributedString(
                    markdown: entry.body,
                    options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
                ) {
                    let body = NSMutableAttributedString(NSAttributedString(parsed))
                    body.addAttribute(.foregroundColor, value: bodyColor, range: NSRange(location: 0, length: body.length))
                    out.append(body)
                } else {
                    append(entry.body, color: bodyColor, font: bodyFont)
                }
            default:
                if !entry.headline.isEmpty { append("\(entry.headline)\n", color: mutedColor, font: headlineFont) }
                if !entry.body.isEmpty { append(entry.body, color: mutedColor, font: monoFont) }
            }
            out.append(NSAttributedString(string: "\n\n"))
        }
        return out
    }
}

/// One non-editable, fully selectable native text view. Selection across the
/// entire transcript works because the whole transcript is a single view.
private struct SelectableTranscriptPlatformView {
    let attributed: NSAttributedString
}

#if canImport(UIKit)
extension SelectableTranscriptPlatformView: UIViewRepresentable {
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView(usingTextLayoutManager: false)
        view.isEditable = false
        view.isSelectable = true
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: 16, left: 16, bottom: 24, right: 16)
        view.attributedText = attributed
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        view.attributedText = attributed
    }
}
#elseif canImport(AppKit)
extension SelectableTranscriptPlatformView: NSViewRepresentable {
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        if let view = scroll.documentView as? NSTextView {
            view.isEditable = false
            view.isSelectable = true
            view.drawsBackground = false
            view.textContainerInset = NSSize(width: 16, height: 16)
            view.textStorage?.setAttributedString(attributed)
        }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        (scroll.documentView as? NSTextView)?.textStorage?.setAttributedString(attributed)
    }
}
#endif

/// Full-transcript "Select Text" sheet. Chrome matches the other panes:
/// NavigationStack + Done.
struct T4TranscriptTextSheet: View {
    let entries: [TranscriptEntry]
    let theme: Theme
    @Binding var isPresented: Bool

    var body: some View {
        NavigationStack {
            SelectableTranscriptPlatformView(attributed: TranscriptTextSelection.flatten(entries: entries, theme: theme))
                .background(theme.bg.ignoresSafeArea())
                .navigationTitle("Select Text")
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                #endif
                .toolbar {
                    ToolbarItem(placement: platformTrailingPlacement) {
                        Button("Done") { isPresented = false }
                    }
                }
        }
    }
}
