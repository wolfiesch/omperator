//  T4Markdown.swift
//  Minimal markdown renderer for assistant messages, matching the web
//  renderer's shape: prose with inline markdown (bold/italic/code/links via
//  AttributedString) and fenced code blocks as cards with a language label
//  and a copy button. Not a full Markdown engine — a faithful subset for
//  transcript text.

import SwiftUI

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
                    if let attributed = try? AttributedString(
                        markdown: md,
                        options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
                    ) {
                        Text(attributed)
                            .font(.system(size: 15))
                            .foregroundStyle(theme.txt)
                            .textSelection(.enabled)
                    } else {
                        Text(md).font(.system(size: 15)).foregroundStyle(theme.txt)
                    }
                case .code(let language, let code):
                    T4CodeBlock(language: language, code: code, theme: theme)
                }
            }
        }
    }

    /// Split text into prose / fenced-code segments. Handles ```lang … ```;
    /// an unterminated fence renders the remainder as code (streaming-safe).
    static func blocks(in text: String) -> [Block] {
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

struct T4CodeBlock: View {
    let language: String
    let code: String
    let theme: Theme
    @State private var copied = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(language.isEmpty ? "code" : language)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(theme.txtLabel)
                Spacer()
                Button {
                    platformCopy(code)
                    copied = true
                    Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 12))
                        .foregroundStyle(theme.txtMuted)
                        .frame(width: 30, height: 26)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Copy code")
            }
            .padding(.leading, 12)
            .padding(.trailing, 4)
            .frame(height: 34)
            .background(theme.glassFill2)
            .overlay(alignment: .bottom) { Rectangle().fill(theme.lineFaint).frame(height: 1) }

            ScrollView(.horizontal, showsIndicators: false) {
                Text(AttributedString(SyntaxHighlighter.attributed(code, language: language, theme: theme, fontSize: 12.5)))
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(theme.bg2)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(theme.line, lineWidth: 1))
    }
}
