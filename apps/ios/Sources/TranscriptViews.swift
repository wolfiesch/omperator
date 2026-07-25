//  TranscriptViews.swift
//  The pieces that render a transcript turn, matching the prototype 1:1.

import SwiftUI
import UIKit

// MARK: - Turn row (dispatch by type)

struct TurnRow: View {
    let turn: UITurn
    let t: Theme
    var onImage: (String) -> Void = { _ in }
    var onAnswer: ((UITurn, Int) -> Void)? = nil       // select option index
    var onAnswerText: ((UITurn, String) -> Void)? = nil // editor text
    var onCancelAsk: ((UITurn) -> Void)? = nil
    var onRewind: (() -> Void)? = nil
    var onEdit: (() -> Void)? = nil

    var body: some View {
        content
            .padding(.bottom, 14)
            .transition(.opacity)
    }

    /// Long-press actions. Copy is always offered; Edit/Rewind only when the
    /// /enclave plugin makes them available (callbacks non-nil).
    @ViewBuilder private var messageMenu: some View {
        Button { UIPasteboard.general.string = turn.text } label: { Label("Copy", systemImage: "doc.on.doc") }
        if let onEdit { Button { onEdit() } label: { Label("Edit", systemImage: "pencil") } }
        if let onRewind { Button(role: .destructive) { onRewind() } label: { Label("Rewind to here", systemImage: "arrow.uturn.backward") } }
    }

    @ViewBuilder private var content: some View {
        switch turn.type {
        case .user: userBubble
        case .agent: agentLine
        case .tool: ToolCard(turn: turn, t: t, onImage: onImage)
        case .advisor: advisorNote
        case .sys where turn.kind == "system-notice": SystemNoticeCard(turn: turn, t: t)
        case .sys: SysChip(turn: turn, t: t)
        case .ask where turn.askKind == "plan":
            PlanReviewCard(turn: turn, t: t,
                onSubmit: onAnswer.map { cb in { idx in cb(turn, idx) } },
                onSubmitText: onAnswerText.map { cb in { text in cb(turn, text) } })
        case .ask:
            AskCard(turn: turn, t: t,
                onSubmit: onAnswer.map { cb in { idx in cb(turn, idx) } },
                onSubmitText: onAnswerText.map { cb in { text in cb(turn, text) } },
                onCancel: onCancelAsk.map { cb in { cb(turn) } })
        case .thinking: ThinkingBlock(turn: turn, t: t)
        }
    }

    private var userBubble: some View {
        VStack(alignment: .trailing, spacing: 5) {
            if let img = turn.image {
                Button { onImage(img) } label: {
                    SrcImage(src: img) { $0.resizable().scaledToFill() } placeholder: { t.line }
                        .frame(width: 180, height: 120).clipped()
                        .clipShape(RoundedRectangle(cornerRadius: 16)).glass(t, 16)
                }
                .contextMenu {
                    if let ui = SrcImage<AnyView, AnyView>.decode(img) {
                        Button { UIPasteboard.general.image = ui } label: { Label("Copy", systemImage: "doc.on.doc") }
                        Button { UIImageWriteToSavedPhotosAlbum(ui, nil, nil, nil) } label: { Label("Save", systemImage: "square.and.arrow.down") }
                    }
                    Button { UIPasteboard.general.string = img } label: { Label("Copy Link", systemImage: "link") }
                }
            }
            if !turn.text.isEmpty {
                VStack(alignment: .leading, spacing: 9) {
                    ForEach(Array(markdownBlocks(turn.text).enumerated()), id: \.offset) { _, seg in
                        switch seg {
                        case .prose(let p):
                            if !p.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                Text(inlineMarkdown(p, t: t)).font(.bodyF(14))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        case .advisory(let severity, let guidance, let body):
                            AdvisoryCard(severity: severity, guidance: guidance, advisoryBody: body, t: t)
                        case .code(let lang, let body):
                            CodeBlock(lang: lang, code: body, t: t)
                        }
                    }
                }
                .padding(.horizontal, 13).padding(.vertical, 10)
                .glass(t, 16)
                .contextMenu { messageMenu }
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .opacity(turn.pending ? 0.5 : 1)   // optimistic 'sending…' until the host echoes it
    }

    private var agentLine: some View {
        // Serif prose with fenced code rendered as scrollable monospace boxes.
        let segs = markdownBlocksWithLanguage(turn.text)
        return VStack(alignment: .leading, spacing: 9) {
            ForEach(0..<segs.count, id: \.self) { i in
                switch segs[i].block {
                case .prose(let p):
                    if !p.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text(inlineMarkdown(p, t: t, defaultLanguage: segs[i].language))
                            .font(.serif(16))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                case .advisory(let severity, let guidance, let body):
                    AdvisoryCard(severity: severity, guidance: guidance, advisoryBody: body, t: t, defaultLanguage: segs[i].language)
                case .code(let lang, let body):
                    CodeBlock(lang: lang, code: body, t: t)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu {
            Button { UIPasteboard.general.string = turn.text } label: { Label("Copy", systemImage: "doc.on.doc") }
        }
    }

    private var advisorNote: some View {
        let segs = markdownBlocksWithLanguage(turn.text)
        return VStack(alignment: .leading, spacing: 9) {
            ForEach(0..<segs.count, id: \.self) { i in
                switch segs[i].block {
                case .prose(let p):
                    if !p.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text(inlineMarkdown(p, t: t, defaultLanguage: segs[i].language))
                            .font(.bodyF(13.5))
                            .textSelection(.enabled)
                    }
                case .advisory(let severity, let guidance, let body):
                    AdvisoryCard(severity: severity, guidance: guidance, advisoryBody: body, t: t, defaultLanguage: segs[i].language)
                case .code(let lang, let body):
                    CodeBlock(lang: lang, code: body, t: t)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Markdown blocks (prose + fenced code)

enum MDBlock { case prose(String); case code(lang: String, body: String); case advisory(severity: String?, guidance: String?, body: String) }

func decodeEntities(_ s: String) -> String {
    s.replacingOccurrences(of: "&lt;", with: "<")
     .replacingOccurrences(of: "&gt;", with: ">")
     .replacingOccurrences(of: "&quot;", with: "\"")
     .replacingOccurrences(of: "&apos;", with: "'")
     .replacingOccurrences(of: "&amp;", with: "&")
}

func advisoryAttrs(from opener: String) -> (severity: String?, guidance: String?) {
    var severity: String?
    var guidance: String?
    if let regex = try? NSRegularExpression(pattern: "severity=\"([^\"]*)\"") {
        let range = NSRange(opener.startIndex..., in: opener)
        if let match = regex.firstMatch(in: opener, options: [], range: range),
           let r = Range(match.range(at: 1), in: opener) {
            severity = String(opener[r])
        }
    }
    if let regex = try? NSRegularExpression(pattern: "guidance=\"([^\"]*)\"") {
        let range = NSRange(opener.startIndex..., in: opener)
        if let match = regex.firstMatch(in: opener, options: [], range: range),
           let r = Range(match.range(at: 1), in: opener) {
            guidance = String(opener[r])
        }
    }
    return (severity, guidance)
}

func advisoryStart(in line: String) -> String.Index? {
    if let r = line.range(of: "<advisory") { return r.lowerBound }
    if let r = line.range(of: "&lt;advisory") { return r.lowerBound }
    return nil
}

func advisoryTagEnd(in line: String, after start: String.Index) -> String.Index? {
    let suffix = line[start...]
    var literalPos: String.Index?
    var entityPos: String.Index?
    if let r = suffix.range(of: ">") { literalPos = r.upperBound }
    if let r = suffix.range(of: "&gt;") { entityPos = r.upperBound }
    if let l = literalPos, let e = entityPos {
        return l < e ? l : e
    }
    return literalPos ?? entityPos
}

func advisoryCloserRange(in line: String) -> Range<String.Index>? {
    line.range(of: "</advisory>") ?? line.range(of: "&lt;/advisory&gt;")
}

/// Split agent text into prose runs, fenced ``` code blocks, and <advisory> callouts.
/// Tolerant of entity-escaped tags and inline placement; tolerant of an unclosed
/// fence or advisory (still streaming): everything after the opener renders as that
/// block type.
func markdownBlocks(_ s: String) -> [MDBlock] {
    var out: [MDBlock] = []
    var prose: [String] = []
    let lines = s.components(separatedBy: "\n")
    var i = 0
    func flush() { if !prose.isEmpty { out.append(.prose(prose.joined(separator: "\n"))); prose = [] } }
    while i < lines.count {
        let trimmed = lines[i].trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("```") {
            flush()
            let lang = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            var body: [String] = []; i += 1
            while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") { body.append(lines[i]); i += 1 }
            if i < lines.count { i += 1 }   // consume closing fence
            out.append(.code(lang: lang, body: body.joined(separator: "\n")))
        } else if let start = advisoryStart(in: trimmed), let tagEnd = advisoryTagEnd(in: trimmed, after: start) {
            flush()
            let prefix = String(trimmed[..<start])
            if !prefix.trimmingCharacters(in: .whitespaces).isEmpty {
                out.append(.prose(prefix))
            }
            let opener = String(trimmed[start..<tagEnd])
            let rest = String(trimmed[tagEnd...])
            let (severity, guidance) = advisoryAttrs(from: opener)
            var body: [String] = []
            if let closerRange = advisoryCloserRange(in: rest) {
                let piece = String(rest[..<closerRange.lowerBound])
                if !piece.isEmpty { body.append(piece) }
                let suffix = String(rest[closerRange.upperBound...])
                if !suffix.trimmingCharacters(in: .whitespaces).isEmpty { prose.append(suffix) }
                out.append(.advisory(severity: severity, guidance: guidance, body: decodeEntities(body.joined(separator: "\n"))))
                i += 1
            } else {
                if !rest.isEmpty { body.append(rest) }
                i += 1
                while i < lines.count, advisoryCloserRange(in: lines[i]) == nil { body.append(lines[i]); i += 1 }
                if i < lines.count {
                    if let closerRange = advisoryCloserRange(in: lines[i]) {
                        let piece = String(lines[i][..<closerRange.lowerBound])
                        if !piece.isEmpty { body.append(piece) }
                        let suffix = String(lines[i][closerRange.upperBound...])
                        if !suffix.trimmingCharacters(in: .whitespaces).isEmpty { prose.append(suffix) }
                    }
                    i += 1
                }
                out.append(.advisory(severity: severity, guidance: guidance, body: decodeEntities(body.joined(separator: "\n"))))
            }
        } else { prose.append(lines[i]); i += 1 }
    }
    flush()
    return out
}

/// Same markdown split, but with an inferred inline-code language for each prose/advisory block.
/// The language is the `lang` of the nearest preceding fenced code block; `generic` for none.
func markdownBlocksWithLanguage(_ s: String) -> [(block: MDBlock, language: String)] {
    var lastLang = ""
    return markdownBlocks(s).map { block in
        switch block {
        case .code(let lang, _):
            lastLang = lang
            return (block, lang)
        case .prose, .advisory:
            return (block, lastLang)
        }
    }
}


/// A fenced code block: language label + copy button over a scrollable monospace body.
struct CodeBlock: View {
    let lang: String; let code: String; let t: Theme
    @State private var copied = false
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(lang.isEmpty ? "CODE" : lang.uppercased()).font(.labl(8.5)).tracking(1.5).foregroundStyle(t.txtMuted)
                Spacer()
                Button {
                    UIPasteboard.general.string = code
                    copied = true
                    Task { try? await Task.sleep(nanoseconds: 1_400_000_000); copied = false }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.system(size: 10))
                        Text(copied ? "COPIED" : "COPY").font(.labl(8.5)).tracking(1)
                    }.foregroundStyle(copied ? t.cOk : t.txtMuted)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .overlay(Rectangle().frame(height: 0.5).foregroundStyle(t.lineFaint), alignment: .bottom)
            ScrollView(.horizontal, showsIndicators: false) {
                CodeTextView(attributedText: SyntaxHighlighter.attributed(code, language: lang, theme: t))
                    .padding(12)
            }
            .frame(maxWidth: .infinity)
        }
        .background(t.bg2)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(t.lineFaint))
    }
}

/// Renders a parsed \u003cadvisory\u003e callout with severity, guidance, and body.
struct AdvisoryCard: View {
    let severity: String?
    let guidance: String?
    let advisoryBody: String
    let t: Theme
    var defaultLanguage: String = ""

    private var color: Color {
        switch severity {
        case "info": return t.txtMuted
        default: return t.cAdvisor
        }
    }

    private var glyph: String {
        switch severity {
        case "blocker": return "exclamationmark.octagon.fill"
        case "concern", "warning": return "exclamationmark.triangle.fill"
        case "info": return "info.circle.fill"
        default: return "bell.fill"
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: glyph).font(.system(size: 12)).foregroundStyle(color)
                    Text((severity ?? "advisory").uppercased()).font(.labl(9)).tracking(1.2).foregroundStyle(color)
                    Spacer(minLength: 0)
                }
                if let guidance = guidance, !guidance.isEmpty {
                    Text(guidance).font(.bodyF(12)).foregroundStyle(t.txtMuted).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }
                if !advisoryBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text(inlineMarkdown(advisoryBody, t: t, defaultLanguage: defaultLanguage)).font(.serif(16))
                        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                }
            }
            .padding(.leading, 11).padding(.trailing, 12).padding(.vertical, 8)
            Spacer(minLength: 0)
        }
        .background(t.glassFill2)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(t.lineFaint))
    }
}

/// Inline markdown (bold/code/italics, line breaks preserved, streaming-safe)
/// plus three enrichments:
///   1. bare URLs → clickable .link (accent + underline) via NSDataDetector.
///   2. ==highlight== spans → themed background tint; markers stripped.
///   3. inline `code` spans → themed background + optional syntax highlighting.
func inlineMarkdown(_ s: String, t: Theme, baseColor: Color? = nil, defaultLanguage: String? = nil) -> AttributedString {
    guard let parsed = try? AttributedString(
        markdown: s,
        options: AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible)
    ) else { return AttributedString(s) }
    let mut = NSMutableAttributedString(parsed)
    if mut.string.isEmpty && !s.isEmpty { return AttributedString(s) }

    let body = NSRange(location: 0, length: mut.length)

    // Base text color — baked in so per-token syntax colors can survive.
    mut.addAttribute(.foregroundColor, value: UIColor(baseColor ?? t.txt), range: body)

    // 1 — bare URLs not already turned into a markdown link.
    inlineLinkDetector.enumerateMatches(in: mut.string, options: [], range: body) { result, _, _ in
        guard let result, let url = result.url, result.range.location != NSNotFound else { return }
        if mut.attribute(NSAttributedString.Key.link, at: result.range.location, effectiveRange: nil) != nil { return }
        mut.addAttribute(NSAttributedString.Key.link, value: url, range: result.range)
        mut.addAttribute(NSAttributedString.Key.foregroundColor, value: UIColor(t.accent), range: result.range)
        mut.addAttribute(NSAttributedString.Key.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: result.range)
    }

    // 2 — ==highlight== spans (strip markers back-to-front so earlier ranges hold).
    var spans: [NSRange] = []
    inlineHighlightRegex.enumerateMatches(in: mut.string, options: [], range: body) { result, _, _ in
        guard let result, result.numberOfRanges >= 2, result.range(at: 1).location != NSNotFound else { return }
        spans.append(result.range)
    }
    for full in spans.sorted(by: { $0.location > $1.location }) {
        mut.addAttribute(NSAttributedString.Key.backgroundColor, value: UIColor(t.highlightBG), range: full)
        mut.deleteCharacters(in: NSRange(location: full.location + full.length - 2, length: 2))
        mut.deleteCharacters(in: NSRange(location: full.location, length: 2))
    }

    // 3 — inline `code` spans: background, optional syntax highlight, and monospace intent.
    var codeRanges: [NSRange] = []
    mut.enumerateAttribute(.inlinePresentationIntent, in: body, options: []) { value, range, _ in
        guard let intent = value as? InlinePresentationIntent, intent.contains(.code) else { return }
        codeRanges.append(range)
    }
    for range in codeRanges.sorted(by: { $0.location > $1.location }) {
        if let defaultLanguage {
            let code = mut.attributedSubstring(from: range).string
            let highlighted = SyntaxHighlighter.attributed(code, language: defaultLanguage, theme: t, baseColor: baseColor, fontSize: nil)
            let wrapped = NSMutableAttributedString(attributedString: highlighted)
            let full = NSRange(location: 0, length: wrapped.length)
            wrapped.addAttribute(.backgroundColor, value: UIColor(t.accent.opacity(0.14)), range: full)
            wrapped.addAttribute(.inlinePresentationIntent, value: InlinePresentationIntent.code, range: full)
            mut.replaceCharacters(in: range, with: wrapped)
        } else {
            mut.addAttribute(.backgroundColor, value: UIColor(t.accent.opacity(0.14)), range: range)
        }
    }

    return AttributedString(mut)
}

private let inlineLinkDetector: NSDataDetector = { try! NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) }()
private let inlineHighlightRegex: NSRegularExpression = { try! NSRegularExpression(pattern: #"==([^=\n]+)=="#) }()

// MARK: - Tool card

struct ToolCard: View {
    let turn: UITurn
    let t: Theme
    var onImage: (String) -> Void = { _ in }

    private var c: Color { toolColor(turn.kind, t) }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Rectangle().fill(c).frame(width: 2).cornerRadius(2)
            VStack(alignment: .leading, spacing: turn.diff.isEmpty && turn.perFileDiffs.isEmpty && turn.lines.isEmpty && turn.image == nil && turn.caption == nil ? 0 : 7) {
                HStack(spacing: 8) {
                    Image(systemName: toolGlyph(turn.kind)).font(.system(size: 13)).foregroundStyle(c)
                    Text(turn.head.uppercased()).font(.labl(10.5)).tracking(0.4).foregroundStyle(c)
                    Text(turn.meta).font(.term(13)).foregroundStyle(t.txtMuted).lineLimit(1)
                    Spacer(minLength: 0)
                    if let a = turn.add {
                        Text("+\(a)").font(.term(13)).foregroundStyle(t.cOk)
                        if let d = turn.del { Text("−\(d)").font(.term(13)).foregroundStyle(t.cAdvisor) }
                    }
                }
                // Compact chip, not an inline image: a browser-heavy session dumps many
                // screenshots, and decoding them all up front is what stalls the view.
                // The full image decodes only when you tap to focus it.
                if let img = turn.image {
                    if turn.kind == "inspect" {
                        Button { onImage(img) } label: {
                            SrcImage(src: img) { $0.resizable().scaledToFill() } placeholder: { t.line }
                                .frame(width: 180, height: 120).clipped()
                                .clipShape(RoundedRectangle(cornerRadius: 16)).glass(t, 16)
                        }
                    } else {
                        Button { onImage(img) } label: {
                            HStack(spacing: 6) {
                                Image(systemName: "photo").font(.system(size: 12)).foregroundStyle(c)
                                Text("image result").font(.term(13)).foregroundStyle(t.txtBody)
                                Text("tap to view").font(.labl(8.5)).tracking(0.6).foregroundStyle(t.txtMuted)
                                Spacer(minLength: 0)
                                Image(systemName: "eye").font(.system(size: 11)).foregroundStyle(t.txtMuted)
                            }
                            .padding(.horizontal, 10).padding(.vertical, 8)
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(t.lineFaint))
                        }
                    }
                }
                if let cap = turn.caption { Text(cap).font(.bodyF(13)).foregroundStyle(t.txtBody).textSelection(.enabled) }
                if !turn.diff.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        CodeTextView(attributedText: SyntaxHighlighter.diff(turn.diff, theme: t, codeLanguage: turn.diffLang.isEmpty ? nil : turn.diffLang, fontSize: 13))
                            .padding(.horizontal, 10).padding(.vertical, 8)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(t.bg2).clipShape(RoundedRectangle(cornerRadius: 16))
                } else if !turn.perFileDiffs.isEmpty {
                    VStack(alignment: .leading, spacing: 1) {
                        ForEach(Array(turn.perFileDiffs.enumerated()), id: \.offset) { _, file in
                            if !file.path.isEmpty {
                                Text(file.path).font(.term(12)).foregroundStyle(t.txtMuted).padding(.bottom, 2)
                            }
                            ScrollView(.horizontal, showsIndicators: false) {
                                CodeTextView(attributedText: SyntaxHighlighter.diff(file.diff, theme: t, codeLanguage: file.lang.isEmpty ? nil : file.lang, fontSize: 13))
                                    .padding(.horizontal, 10).padding(.vertical, 8)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .background(t.bg2).clipShape(RoundedRectangle(cornerRadius: 16))
                } else if !turn.lines.isEmpty {
                    VStack(alignment: .leading, spacing: 1) {
                        ForEach(Array(turn.lines.enumerated()), id: \.offset) { _, l in
                            Text(l).font(.term(13)).foregroundStyle(l.hasPrefix("+") ? t.cOk : (l.hasPrefix("\u{2212}") || l.hasPrefix("-")) ? t.cAdvisor : t.txtMuted).textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .background(t.bg2).clipShape(RoundedRectangle(cornerRadius: 16))
                }
            }
        }
    }
}

// MARK: - Sys chip / ask / approval

struct SysChip: View {
    let turn: UITurn; let t: Theme
    private var c: Color {
        switch turn.kind {
        case "paired": t.cOk
        case "rewind", "mode", "notice": t.accent
        case "stop", "ttsr", "error": t.cAdvisor
        default: t.txtMuted
        }
    }
    private var glyph: String {
        switch turn.kind {
        case "compaction": "square.3.layers.3d"; case "retry": "arrow.triangle.2.circlepath"
        case "ttsr": "text.badge.checkmark"; case "stop": "stop.fill"; case "rewind": "arrow.uturn.backward"
        case "paired": "checkmark.seal.fill"; case "error": "exclamationmark.triangle.fill"
        case "mode": "flag.fill"; case "model": "arrow.triangle.swap"; case "note": "text.bubble"; case "notice": "info.circle.fill"
        default: "circle.grid.cross"
        }
    }
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: glyph).font(.system(size: 11)).foregroundStyle(c)
            Text(turn.text).font(.labl(9)).tracking(1.4).foregroundStyle(c).textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .center)
    }
}

/// Harness background-job completion notice — a glass card showing the task name,
/// status, optional output summary, and follow-up footer.
struct SystemNoticeCard: View {
    let turn: UITurn
    let t: Theme

    private var statusColor: Color {
        let s = turn.meta.lowercased()
        if s.contains("completed") || s.contains("success") { return t.cOk }
        if s.contains("failed") || s.contains("error") { return t.cAdvisor }
        return t.accent
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "gearshape.2").font(.system(size: 13)).foregroundStyle(t.accent)
                Text(turn.head).font(.bodyF(13)).fontWeight(.semibold).foregroundStyle(t.txtBody)
                Spacer(minLength: 0)
                HStack(spacing: 4) {
                    Circle().fill(statusColor).frame(width: 6, height: 6)
                    Text(turn.meta).font(.labl(9)).tracking(0.5).foregroundStyle(t.txtMuted)
                }
            }
            if let caption = turn.caption, !caption.isEmpty {
                    Text(caption).font(.bodyF(12)).foregroundStyle(t.txtMuted).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !turn.text.isEmpty {
                    Text(turn.text).font(.term(12)).foregroundStyle(t.txtBody).textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(t.bg2).clipShape(RoundedRectangle(cornerRadius: 12))
            }
            if !turn.lines.isEmpty {
                ForEach(turn.lines, id: \.self) { line in
                    Text(line).font(.bodyF(11)).foregroundStyle(t.txtMuted).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(12)
        .glass(t, 16, active: true)
    }
}

/// Host ask (omp `ask` tool) — the questionnaire surface. Mirrors the PlanStrip
/// glass aesthetic: an accent panel with a labl header, the prompt, optional help
/// text, and option rows (radio ◉/○ or checkbox ☑/☐) or a free-form editor.
/// Selects submit on tap — the host re-prompts multi-select with refreshed
/// checkedIndices; the editor sends typed text. Read-only guests get a static
/// preview (no controls). The recommended option (initialIndex) wears an etched
/// "RECOMMENDED" chip, matching omp's TUI ` (Recommended)` cue.
struct AskCard: View {
    let turn: UITurn; let t: Theme
    var onSubmit: ((Int) -> Void)? = nil        // select: tapped option index
    var onSubmitText: ((String) -> Void)? = nil // editor: typed text
    var onCancel: (() -> Void)? = nil
    @State private var sent = false              // select: locked after a tap
    @State private var picked: Int? = nil        // select: which option was tapped
    @State private var text: String = ""         // editor
    @State private var textSent = false

    private var isEditor: Bool { turn.askKind == "editor" }
    private var isCheckbox: Bool { turn.selectionMarker == "checkbox" }
    private var interactive: Bool { onSubmit != nil || onSubmitText != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            if !turn.helpText.isEmpty {
                    Text(turn.helpText).font(.bodyF(12)).foregroundStyle(t.txtMuted).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if isEditor { editor } else { options }
            if interactive { actions }
        }
        .padding(12)
        .glass(t, 16, active: true)
        .onChange(of: turn) { _ in
            // Checkbox asks re-prompt with a fresh turn; reset the submit lock so the
            // user can keep toggling options until the host finishes the ask.
            sent = false; picked = nil; textSent = false
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 7) {
            Image(systemName: isEditor ? "text.cursor" : "questionmark.bubble")
                .font(.system(size: 14)).foregroundStyle(t.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text(isEditor ? "INPUT REQUESTED" : "ASK")
                    .font(.labl(9)).tracking(1.4).foregroundStyle(t.accent)
                    Text(turn.question).font(.bodyF(13.5)).foregroundStyle(t.txt).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var options: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(Array(turn.options.enumerated()), id: \.offset) { i, label in
                optionRow(i, label)
            }
        }
    }

    @ViewBuilder
    private func optionRow(_ i: Int, _ label: String) -> some View {
        let checked = turn.checkedIndices.contains(i)
        let chosen = picked == i
        let marked = checked || chosen
        let recommended = turn.initialIndex == i
        Button { tap(i) } label: {
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: marker(marked))
                    .font(.system(size: 13))
                    .foregroundStyle(marked ? t.accent : t.txtGhost)
                    .frame(width: 15)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(label).font(.bodyF(13)).foregroundStyle(marked ? t.accent : t.txtBody)
                        if recommended {
                            Text("RECOMMENDED").font(.labl(8)).tracking(1).foregroundStyle(t.accent)
                                .padding(.horizontal, 5).padding(.vertical, 1)
                                .etched(t, tint: t.accent.opacity(0.10))
                        }
                    }
                    if i < turn.optionDescriptions.count, !turn.optionDescriptions[i].isEmpty {
                        Text(turn.optionDescriptions[i]).font(.bodyF(12)).foregroundStyle(t.txtMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 11).padding(.vertical, 9)
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(marked ? t.accentLine : t.line))
            .background(marked ? t.glassFill2 : .clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!interactive || sent)
    }

    private func marker(_ on: Bool) -> String {
        isCheckbox ? (on ? "checkmark.square.fill" : "square") : (on ? "largecircle.fill" : "circle")
    }

    private var editor: some View {
        TextEditor(text: $text)
            .font(.bodyF(13.5)).foregroundStyle(t.txt)
            .scrollContentBackground(.hidden)
            .frame(minHeight: 84, maxHeight: 160)
            .padding(.horizontal, 11).padding(.vertical, 7)
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(t.line))
            .background(t.glassFill2)
            .onAppear { if text.isEmpty && !turn.prefill.isEmpty { text = turn.prefill } }
    }

    @ViewBuilder
    private var actions: some View {
        HStack(spacing: 10) {
            if isEditor {
                Button { textSent = true; onSubmitText?(text) } label: {
                    HStack(spacing: 6) {
                        Image(systemName: textSent ? "checkmark" : "paperplane.fill")
                        Text(textSent ? "SENT" : "SEND").font(.labl(10.5))
                    }
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity).padding(.vertical, 10)
                }
                .buttonStyle(.glassProminent)
                .tint(t.accent)
                .disabled(textSent || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if onCancel != nil {
                Button { onCancel?() } label: {
                    Text("SKIP").font(.labl(10.5)).foregroundStyle(t.txtMuted)
                        .frame(maxWidth: .infinity).padding(.vertical, 10)
                }
                .buttonStyle(.glass)
                .disabled(sent || textSent)
            }
        }
    }

    private func tap(_ i: Int) {
        guard !sent else { return }
        sent = true; picked = i
        onSubmit?(i)
    }
}
// MARK: - Plan review

/// Plan approval / refinement card for /enclave plan mode. The full plan markdown is
/// shown as the body; approve options are radio rows; "Refine plan" expands a text
/// editor and sends JSON `{"choice":"Refine plan","feedback":"..."}`.
struct PlanReviewCard: View {
    let turn: UITurn; let t: Theme
    var onSubmit: ((Int) -> Void)? = nil
    var onSubmitText: ((String) -> Void)? = nil

    @State private var sent = false
    @State private var picked: Int? = nil
    @State private var feedback = ""
    @State private var feedbackSent = false

    private var refineIndex: Int { turn.options.firstIndex(of: "Refine plan") ?? -1 }
    private var isRefine: Bool { refineIndex >= 0 && picked == refineIndex }
    private var interactive: Bool { onSubmit != nil || onSubmitText != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            if !turn.helpText.isEmpty { planBody }
            options
            if isRefine { refineEditor }
            if isRefine && interactive { refineActions }
        }
        .padding(12)
        .glass(t, 16, active: true)
        .onChange(of: turn) { _ in
            sent = false; picked = nil; feedback = ""; feedbackSent = false
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 7) {
            Image(systemName: "checklist").font(.system(size: 14)).foregroundStyle(t.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text("PLAN REVIEW").font(.labl(9)).tracking(1.4).foregroundStyle(t.accent)
                Text(turn.question).font(.bodyF(13.5)).foregroundStyle(t.txt).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var planBody: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(markdownBlocks(turn.helpText).enumerated()), id: \.offset) { _, block in
                switch block {
                case .prose(let p):
                    if !p.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text(inlineMarkdown(p, t: t))
                            .font(.bodyF(13)).foregroundStyle(t.txtBody).textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                case .advisory(let severity, let guidance, let body):
                    AdvisoryCard(severity: severity, guidance: guidance, advisoryBody: body, t: t)
                case .code(let lang, let body):
                    CodeBlock(lang: lang, code: body, t: t)
                }
            }
        }
        .padding(10)
        .glass(t, 14, flat: true)
    }

    private var options: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(Array(turn.options.enumerated()), id: \.offset) { i, label in
                optionRow(i, label)
            }
        }
    }

    private func optionRow(_ i: Int, _ label: String) -> some View {
        let disabled = turn.disabledIndices.contains(i) || !interactive
        let chosen = picked == i
        let on = chosen
        return Button { tap(i) } label: {
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: on ? "largecircle.fill" : "circle")
                    .font(.system(size: 13))
                    .foregroundStyle(disabled ? t.txtGhost : (on ? t.accent : t.txtGhost))
                    .frame(width: 15)
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).font(.bodyF(13))
                        .foregroundStyle(disabled ? t.txtMuted : (on ? t.accent : t.txtBody))
                    if i < turn.optionDescriptions.count, !turn.optionDescriptions[i].isEmpty {
                        Text(turn.optionDescriptions[i]).font(.bodyF(12))
                            .foregroundStyle(t.txtMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 11).padding(.vertical, 9)
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(on ? t.accentLine : t.line))
            .background(on ? t.glassFill2 : .clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }

    private var refineEditor: some View {
        TextEditor(text: $feedback)
            .font(.bodyF(13.5)).foregroundStyle(t.txt)
            .scrollContentBackground(.hidden)
            .frame(minHeight: 84, maxHeight: 160)
            .padding(.horizontal, 11).padding(.vertical, 7)
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(t.line))
            .background(t.glassFill2)
    }

    private var refineActions: some View {
        HStack(spacing: 10) {
            Button { sendFeedback() } label: {
                HStack(spacing: 6) {
                    Image(systemName: feedbackSent ? "checkmark" : "paperplane.fill")
                    Text(feedbackSent ? "SENT" : "SEND").font(.labl(10.5))
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity).padding(.vertical, 10)
            }
            .buttonStyle(.glassProminent)
            .tint(t.accent)
            .disabled(feedbackSent || feedback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private func tap(_ i: Int) {
        guard !sent else { return }
        picked = i
        if i == refineIndex {
            // Refine needs feedback; user types then taps SEND.
            return
        }
        sent = true
        onSubmit?(i)
    }

    private func sendFeedback() {
        guard !feedbackSent else { return }
        feedbackSent = true
        let payload: [String: String] = ["choice": "Refine plan", "feedback": feedback]
        let json = (try? JSONSerialization.data(withJSONObject: payload, options: []))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "{\"choice\":\"Refine plan\",\"feedback\":\"\"}"
        onSubmitText?(json)
    }
}

// MARK: - misc

/// The thinking state: just the enclave eye, its pupil dilating and closing on a
/// slow breath — no text. Clean, single-glyph, unmistakably Enclave.
struct ThinkingLine: View {
    let t: Theme
    @State private var open: CGFloat = 0.25
    var body: some View {
        LogoMark(t: t, size: 22, color: t.accent, open: open)
            .onAppear {
                withAnimation(.easeInOut(duration: 1.15).repeatForever(autoreverses: true)) { open = 1.3 }
            }
    }
}

/// The model's reasoning — collapsed by default, tap to expand or collapse.
struct ThinkingBlock: View {
    let turn: UITurn; let t: Theme
    @State private var expanded = false
    private var header: String {
        guard let s = turn.thoughtSeconds else { return "THINKING" }
        return s < 60 ? "THOUGHT FOR \(s)s" : "THOUGHT FOR \(s / 60)m \(s % 60)s"
    }
    // Short model name for the attribution chip (only set when >1 model was used).
    private var modelChip: String? {
        turn.model.isEmpty ? nil : (turn.model.split(separator: "/").last.map(String.init) ?? turn.model)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() } } label: {
                HStack(spacing: 6) {
                    Text(header).font(.labl(9)).tracking(1.6).foregroundStyle(t.txtMuted)
                    if let m = modelChip {
                        Text(m).font(.labl(8)).tracking(0.5).foregroundStyle(t.accent)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .etched(t, tint: t.accent.opacity(0.10))
                    }
                    Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(t.txtGhost)
                    Spacer(minLength: 0)
                }.contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded {
                Text(inlineMarkdown(turn.text, t: t, baseColor: t.txtMuted, defaultLanguage: ""))
                    .font(.serif(13.5)).italic().textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 8).padding(.leading, 2)
            }
        }
        .padding(.vertical, 1)
    }
}

struct ImageViewer: View {
    @EnvironmentObject var theme: ThemeStore
    let src: String; let label: String; let onClose: () -> Void
    @State private var shareURL: URL? = nil
    private var t: Theme { theme.t }

    private func prepareShareURL() {
        guard shareURL == nil,
              let ui = SrcImage<AnyView, AnyView>.decode(src),
              let data = ui.pngData() else { return }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString + ".png")
        do {
            try data.write(to: url)
            shareURL = url
        } catch {
            shareURL = nil
        }
    }

    var body: some View {
        ZStack {
            Rectangle().fill(.ultraThinMaterial).ignoresSafeArea().onTapGesture(perform: onClose)

            SrcImage(src: src) { $0.resizable().scaledToFit() } placeholder: { t.line }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(22)
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(t.lineStrong))

            VStack(spacing: 6) {
                Text(label).font(.term(14)).foregroundStyle(t.lockFg).textSelection(.enabled)
                Text("TAP ANYWHERE TO CLOSE").font(.labl(9)).foregroundStyle(t.lockFg.opacity(0.5))
            }
            .padding(.horizontal, 16).padding(.vertical, 10)
            .glass(t, 16, flat: true)
            .frame(maxHeight: .infinity, alignment: .bottom)
            .padding(.bottom, 34)

            if let url = shareURL {
                ShareLink(item: url) {
                    Image(systemName: "square.and.arrow.up")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(t.txt)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.glass)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                .padding(22)
            }
        }
        .onAppear(perform: prepareShareURL)
    }
}

/// Renders an image src that may be a `data:` URI (base64, what the guest sends and
/// the host echoes back) OR an http(s) URL. AsyncImage alone can't load data: URIs.
struct SrcImage<Content: View, Placeholder: View>: View {
    let src: String
    @ViewBuilder let content: (Image) -> Content
    @ViewBuilder let placeholder: () -> Placeholder

    var body: some View {
        if src.hasPrefix("data:"), let ui = Self.decode(src) {
            content(Image(uiImage: ui))
        } else if let url = URL(string: src), url.scheme?.hasPrefix("http") == true {
            AsyncImage(url: url) { content($0) } placeholder: { placeholder() }
        } else {
            placeholder()
        }
    }

    static func naturalSize(_ src: String) -> CGSize? {
        if src.hasPrefix("data:"), let ui = decode(src) {
            return CGSize(width: ui.size.width * ui.scale, height: ui.size.height * ui.scale)
        }
        return nil
    }

    static func decode(_ dataURI: String) -> UIImage? {
        let key = dataURI as NSString
        if let cached = srcImageCache.object(forKey: key) { return cached }
        guard let comma = dataURI.firstIndex(of: ","),
              let data = Data(base64Encoded: String(dataURI[dataURI.index(after: comma)...])),
              let ui = UIImage(data: data) else { return nil }
        srcImageCache.setObject(ui, forKey: key)
        return ui
    }
}

private let srcImageCache = NSCache<NSString, UIImage>()

// bespoke ring + sealed-slit logomark
struct LogoMark: View {
    let t: Theme; var size: CGFloat = 24; var color: Color; var open: CGFloat = 1
    var body: some View {
        ZStack {
            Circle().stroke(color, lineWidth: size * 0.075)
            EnclaveSlit(open: open).stroke(color, style: StrokeStyle(lineWidth: size * 0.06, lineCap: .round, lineJoin: .round))
        }
        // Inset the mark within its footprint so a circular Liquid Glass toolbar
        // chip doesn't clip the ring at the top and bottom.
        .frame(width: size * 0.82, height: size * 0.82)
        .frame(width: size, height: size)
    }
}
