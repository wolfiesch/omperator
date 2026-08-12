//  T4Markdown.swift (Linux port of apps/ios/Sources/T4Markdown.swift)
//  Minimal markdown renderer for assistant messages, matching the web
//  renderer's shape: prose plus fenced code blocks as cards with a language
//  label. Not a full Markdown engine — a faithful subset for transcript text.
//
//  Linux deltas (same split logic, simpler rendering primitives):
//  - Prose renders as plain Text. The Apple file builds AttributedString for
//    inline bold/italic/code/links; SwiftCrossUI Text has no attributed
//    flavor, so inline emphasis renders literally (LINUX-GAP).
//  - Code blocks keep the language label + syntax-colored body
//    (SyntaxHighlighter segments). The copy button is omitted (LINUX-GAP:
//    no platformCopy pasteboard seam on Linux yet).

import SwiftCrossUI

struct T4Markdown: View {
    let text: String
    let theme: Theme

    enum Block: Equatable {
        case prose(String)
        case code(language: String, code: String)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(Self.blocks(in: text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .prose(let md):
                    Text(md)
                        .font(.system(size: 15))
                        .foregroundColor(theme.txt)
                        .textSelectionEnabled()
                case .code(let language, let code):
                    T4CodeBlock(language: language, code: code, theme: theme)
                }
            }
        }
    }

    /// Split text into prose / fenced-code segments. Handles ```lang … ```;
    /// an unterminated fence renders the remainder as code (streaming-safe).
    ///
    /// Memoized: SwiftCrossUI re-renders the transcript on every store change,
    /// and without a cache every render re-splits every assistant message.
    static func blocks(in text: String) -> [Block] {
        if let cached = blockCache[text] { return cached }
        let result = splitBlocks(text)
        if blockCache.count > 512 { blockCache.removeAll() }
        blockCache[text] = result
        return result
    }

    private static var blockCache: [String: [Block]] = [:]

    private static func splitBlocks(_ text: String) -> [Block] {
        var out: [Block] = []
        var prose = ""
        let lines = text.components(separatedBy: "\n")
        var index = 0
        while index < lines.count {
            let line = lines[index]
            index += 1
            if line.hasPrefix("```") {
                let language = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var codeLines: [String] = []
                var closed = false
                while index < lines.count {
                    let codeLine = lines[index]
                    index += 1
                    if codeLine.hasPrefix("```") { closed = true; break }
                    codeLines.append(codeLine)
                }
                let pending = prose.trimmingCharacters(in: .newlines)
                if !pending.isEmpty { out.append(.prose(pending)); prose = "" }
                let code = codeLines.joined(separator: "\n")
                if closed || !code.isEmpty { out.append(.code(language: language, code: code)) }
            } else {
                prose += line + "\n"
            }
        }
        let pending = prose.trimmingCharacters(in: .newlines)
        if !pending.isEmpty { out.append(.prose(pending)) }
        return out
    }
}

/// Renders `SyntaxHighlighter` runs as monospaced lines of colored text.
/// Shared by T4CodeBlock (fenced code) and T4TranscriptRow (diff bodies).
struct SyntaxLinesView: View {
    let runs: [SyntaxRun]

    /// Linux perf bound: every line is its own HStack of per-run Text widgets,
    /// so an uncapped code block multiplies into hundreds of widgets per
    /// render. Cap the widget count; the elided line count is shown instead.
    private static let maxLines = 25

    var body: some View {
        let all = Self.lines(from: runs)
        let lines = Array(all.prefix(Self.maxLines))
        let hidden = all.count - lines.count
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                HStack(spacing: 0) {
                    ForEach(Array(line.enumerated()), id: \.offset) { _, run in
                        Text(run.text)
                            .foregroundColor(run.color)
                    }
                }
            }
            if hidden > 0 {
                Text("… \(hidden) more lines")
                    .font(.term(11))
                    .foregroundColor(Color(red: 0.5, green: 0.5, blue: 0.55))
            }
        }
    }

    /// Split colored runs at newlines so each physical line is its own row
    /// (an HStack of runs can't wrap). Drops a single trailing empty line.
    static func lines(from runs: [SyntaxRun]) -> [[SyntaxRun]] {
        var result: [[SyntaxRun]] = [[]]
        for run in runs {
            let parts = run.text.split(separator: "\n", omittingEmptySubsequences: false)
            for (i, part) in parts.enumerated() {
                if i > 0 { result.append([]) }
                if !part.isEmpty { result[result.count - 1].append((String(part), run.color)) }
            }
        }
        if result.count > 1, result.last?.isEmpty == true { result.removeLast() }
        return result
    }
}

struct T4CodeBlock: View {
    let language: String
    let code: String
    let theme: Theme
    @State private var copied = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(language.isEmpty ? "code" : language)
                    .font(.term(11))
                    .foregroundColor(theme.txtLabel)
                Spacer()
                // LINUX-GAP: the Apple file has a copy-code button here
                // (platformCopy — NSPasteboard/UIPasteboard); there is no
                // pasteboard seam on Linux yet, so the label row is it.
            }
            .padding(.leading, 12)
            .padding(.trailing, 4)
            .frame(height: 34)
            .background(theme.glassFill2)
            .overlay(alignment: .bottom) { Rectangle().fill(theme.lineFaint).frame(height: 1) }

            ScrollView(.horizontal) {
                SyntaxLinesView(runs: SyntaxHighlighter.segments(code, language: language, theme: theme))
                    .font(.term(12.5))
                    .textSelectionEnabled()
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(theme.bg2)
        .cornerRadius(10)
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .stroke(theme.line, style: StrokeStyle(width: 1))
        }
    }
}
