import Foundation

enum T4LinuxV2MarkdownStyle: String, Equatable, Sendable {
    case assistant
    case user
    case heading1
    case heading2
    case heading3
    case bold
    case italic
    case boldItalic
    case inlineCode
    case list
    case quote
    case link
    case codeBlock
    case diffAdd
    case diffRemove
}

struct T4LinuxV2MarkdownSegment: Equatable, Sendable {
    let text: String
    let style: T4LinuxV2MarkdownStyle
}

enum T4LinuxV2TranscriptBlock: Equatable, Sendable {
    case prose(String)
    case code(language: String, body: String)
    case advisory(severity: String?, guidance: String?, body: String)
}

/// Foundation-only port of the pinned native GTK renderer. It intentionally
/// implements the source's markdown-lite grammar instead of delegating to a
/// generic Markdown package.
enum T4LinuxV2MarkdownParser {
    static func render(body: String, role: String? = nil) -> [T4LinuxV2MarkdownSegment] {
        guard !body.isEmpty else { return [] }
        if role == "user" { return [.init(text: body, style: .user)] }

        let lines = body.split(separator: "\n", omittingEmptySubsequences: false)
        var output: [T4LinuxV2MarkdownSegment] = []
        var inCodeBlock = false
        for (index, lineSlice) in lines.enumerated() {
            let line = String(lineSlice)
            let isLast = index == lines.count - 1
            var segments: [T4LinuxV2MarkdownSegment]
            if inCodeBlock {
                if isFenceLine(line) {
                    inCodeBlock = false
                    segments = []
                } else {
                    segments = [segment(line, diffStyle(for: line) ?? .codeBlock)]
                }
            } else if isFenceLine(line) {
                inCodeBlock = true
                segments = []
            } else {
                segments = proseLine(line)
            }
            if !isLast { appendNewline(to: &segments) }
            output.append(contentsOf: segments)
        }
        return output
    }

    /// Split prose, fenced code, and advisory blocks. Unclosed blocks remain
    /// renderable while the assistant is still streaming.
    static func blocks(_ text: String) -> [T4LinuxV2TranscriptBlock] {
        var output: [T4LinuxV2TranscriptBlock] = []
        var prose: [String] = []
        let lines = text.components(separatedBy: "\n")
        var index = 0
        func flush() {
            if !prose.isEmpty {
                output.append(.prose(prose.joined(separator: "\n")))
                prose = []
            }
        }

        while index < lines.count {
            let trimmed = lines[index].trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                flush()
                let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var body: [String] = []
                index += 1
                while index < lines.count,
                      !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    body.append(lines[index])
                    index += 1
                }
                if index < lines.count { index += 1 }
                output.append(.code(language: language, body: body.joined(separator: "\n")))
            } else if let start = advisoryStart(in: trimmed),
                      let tagEnd = advisoryTagEnd(in: trimmed, after: start) {
                flush()
                let prefix = String(trimmed[..<start])
                if !prefix.trimmingCharacters(in: .whitespaces).isEmpty {
                    output.append(.prose(prefix))
                }
                let opener = String(trimmed[start..<tagEnd])
                let rest = String(trimmed[tagEnd...])
                let attributes = advisoryAttributes(from: opener)
                var body: [String] = []
                if let close = advisoryCloser(in: rest) {
                    let piece = String(rest[..<close.lowerBound])
                    if !piece.isEmpty { body.append(piece) }
                    let suffix = String(rest[close.upperBound...])
                    if !suffix.trimmingCharacters(in: .whitespaces).isEmpty { prose.append(suffix) }
                    output.append(.advisory(
                        severity: attributes.severity,
                        guidance: attributes.guidance,
                        body: decodeEntities(body.joined(separator: "\n"))
                    ))
                    index += 1
                } else {
                    if !rest.isEmpty { body.append(rest) }
                    index += 1
                    while index < lines.count, advisoryCloser(in: lines[index]) == nil {
                        body.append(lines[index])
                        index += 1
                    }
                    if index < lines.count, let close = advisoryCloser(in: lines[index]) {
                        let piece = String(lines[index][..<close.lowerBound])
                        if !piece.isEmpty { body.append(piece) }
                        let suffix = String(lines[index][close.upperBound...])
                        if !suffix.trimmingCharacters(in: .whitespaces).isEmpty { prose.append(suffix) }
                        index += 1
                    }
                    output.append(.advisory(
                        severity: attributes.severity,
                        guidance: attributes.guidance,
                        body: decodeEntities(body.joined(separator: "\n"))
                    ))
                }
            } else {
                prose.append(lines[index])
                index += 1
            }
        }
        flush()
        return output
    }

    private static func proseLine(_ line: String) -> [T4LinuxV2MarkdownSegment] {
        if let heading = headingContent(line) {
            return heading.content.isEmpty ? [] : [segment(heading.content, heading.style)]
        }
        if isListLine(line) { return [segment(line, .list)] }
        if line.hasPrefix("> ") {
            let content = String(line.dropFirst(2))
            return content.isEmpty ? [] : [segment(content, .quote)]
        }
        if let style = diffStyle(for: line) { return [segment(line, style)] }
        return inlineSegments(line)
    }

    private static func isFenceLine(_ line: String) -> Bool { line.hasPrefix("```") }

    private static func isListLine(_ line: String) -> Bool {
        var index = line.startIndex
        while index < line.endIndex, line[index] == " " || line[index] == "\t" {
            index = line.index(after: index)
        }
        guard index < line.endIndex else { return false }
        if line[index] == "-" || line[index] == "*" || line[index] == "•" {
            index = line.index(after: index)
        } else if line[index].isNumber {
            var digits = index
            while digits < line.endIndex, line[digits].isNumber { digits = line.index(after: digits) }
            guard digits < line.endIndex, line[digits] == "." || line[digits] == ")" else { return false }
            index = line.index(after: digits)
        } else {
            return false
        }
        return index < line.endIndex && (line[index] == " " || line[index] == "\t")
    }

    private static func headingContent(_ line: String) -> (content: String, style: T4LinuxV2MarkdownStyle)? {
        guard line.hasPrefix("#") else { return nil }
        var index = line.startIndex
        var count = 0
        while index < line.endIndex, line[index] == "#", count < 3 {
            count += 1
            index = line.index(after: index)
        }
        guard count > 0 else { return nil }
        if index < line.endIndex {
            guard line[index] == " " || line[index] == "\t" else { return nil }
            index = line.index(after: index)
        }
        let style: T4LinuxV2MarkdownStyle = count == 1 ? .heading1 : (count == 2 ? .heading2 : .heading3)
        return (String(line[index...]), style)
    }

    private static func diffStyle(for line: String) -> T4LinuxV2MarkdownStyle? {
        guard let first = line.first, first == "+" || first == "-" else { return nil }
        guard !line.dropFirst().trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return first == "+" ? .diffAdd : .diffRemove
    }

    private static func appendNewline(to segments: inout [T4LinuxV2MarkdownSegment]) {
        if segments.isEmpty {
            segments.append(segment("\n", .assistant))
        } else {
            let last = segments.removeLast()
            segments.append(segment(last.text + "\n", last.style))
        }
    }

    private static func inlineSegments(_ line: String) -> [T4LinuxV2MarkdownSegment] {
        var output: [T4LinuxV2MarkdownSegment] = []
        var plainStart = line.startIndex
        var index = line.startIndex
        func flushPlain() {
            if plainStart < index { output.append(segment(String(line[plainStart..<index]), .assistant)) }
        }

        while index < line.endIndex {
            let character = line[index]
            if character == "`" {
                let contentStart = line.index(after: index)
                if let close = find(character: "`", in: line, after: contentStart), contentStart < close {
                    flushPlain()
                    output.append(segment(String(line[contentStart..<close]), .inlineCode))
                    plainStart = line.index(after: close)
                    index = plainStart
                    continue
                }
                index = line.index(after: index)
                continue
            }

            if character == "*" || character == "_" {
                var runEnd = index
                var runLength = 0
                while runEnd < line.endIndex, line[runEnd] == character, runLength < 3 {
                    runLength += 1
                    runEnd = line.index(after: runEnd)
                }
                var emitted = false
                var length = runLength
                while length >= 1 {
                    if let span = emphasisSpan(character, length: length, start: index, runEnd: runEnd, line: line),
                       !span.content.isEmpty {
                        flushPlain()
                        let style: T4LinuxV2MarkdownStyle = length == 3 ? .boldItalic : (length == 2 ? .bold : .italic)
                        output.append(segment(span.content, style))
                        plainStart = span.pastClose
                        index = span.pastClose
                        emitted = true
                        break
                    }
                    length -= 1
                }
                if !emitted { index = line.index(after: index) }
                continue
            }

            if character == "[" {
                let labelStart = line.index(after: index)
                if let openParen = find(substring: "](", in: line, after: labelStart), labelStart < openParen,
                   let closeParen = find(character: ")", in: line, after: line.index(after: openParen)) {
                    let label = String(line[labelStart..<openParen])
                    let url = String(line[line.index(after: openParen)..<closeParen])
                    if !label.isEmpty, !url.isEmpty {
                        flushPlain()
                        output.append(segment(label, .link))
                        plainStart = line.index(after: closeParen)
                        index = plainStart
                        continue
                    }
                }
                index = line.index(after: index)
                continue
            }
            index = line.index(after: index)
        }
        if plainStart < line.endIndex { output.append(segment(String(line[plainStart...]), .assistant)) }
        return output
    }

    private static func emphasisSpan(
        _ character: Character,
        length: Int,
        start: String.Index,
        runEnd: String.Index,
        line: String
    ) -> (content: String, pastClose: String.Index)? {
        let before = start > line.startIndex ? line[line.index(before: start)] : nil
        if let before, !isBoundary(before) { return nil }
        let after = runEnd < line.endIndex ? line[runEnd] : nil
        if let after, after.isWhitespace { return nil }
        let contentStart = line.index(start, offsetBy: length)
        guard let close = emphasisCloser(character, length: length, line: line, after: contentStart) else { return nil }
        let content = String(line[contentStart..<close])
        guard !content.isEmpty else { return nil }
        return (content, line.index(close, offsetBy: length))
    }

    private static func emphasisCloser(
        _ character: Character,
        length: Int,
        line: String,
        after start: String.Index
    ) -> String.Index? {
        var index = start
        while index < line.endIndex {
            if line[index] == "`" {
                let contentStart = line.index(after: index)
                if let close = find(character: "`", in: line, after: contentStart), contentStart < close {
                    index = line.index(after: close)
                    continue
                }
            }
            guard line[index] == character else {
                index = line.index(after: index)
                continue
            }
            var end = index
            var runLength = 0
            while end < line.endIndex, line[end] == character {
                runLength += 1
                end = line.index(after: end)
            }
            if runLength == length {
                let before = index > line.startIndex ? line[line.index(before: index)] : nil
                if let before, before.isWhitespace { index = end; continue }
                let after = end < line.endIndex ? line[end] : nil
                if let after, !isBoundary(after) { index = end; continue }
                return index
            }
            index = end
        }
        return nil
    }

    private static func isBoundary(_ character: Character) -> Bool {
        character.isWhitespace || character.isPunctuation
    }

    private static func find(character: Character, in text: String, after start: String.Index) -> String.Index? {
        var index = start
        while index < text.endIndex {
            if text[index] == character { return index }
            index = text.index(after: index)
        }
        return nil
    }

    private static func find(substring: String, in text: String, after start: String.Index) -> String.Index? {
        var index = start
        while index < text.endIndex {
            if text[index...].hasPrefix(substring) { return index }
            index = text.index(after: index)
        }
        return nil
    }

    private static func segment(_ text: String, _ style: T4LinuxV2MarkdownStyle) -> T4LinuxV2MarkdownSegment {
        .init(text: text, style: style)
    }

    private static func advisoryStart(in line: String) -> String.Index? {
        line.range(of: "<advisory")?.lowerBound ?? line.range(of: "&lt;advisory")?.lowerBound
    }

    private static func advisoryTagEnd(in line: String, after start: String.Index) -> String.Index? {
        let suffix = line[start...]
        let literal = suffix.range(of: ">")?.upperBound
        let escaped = suffix.range(of: "&gt;")?.upperBound
        if let literal, let escaped { return literal < escaped ? literal : escaped }
        return literal ?? escaped
    }

    private static func advisoryCloser(in line: String) -> Range<String.Index>? {
        line.range(of: "</advisory>") ?? line.range(of: "&lt;/advisory&gt;")
    }

    private static func advisoryAttributes(from opener: String) -> (severity: String?, guidance: String?) {
        (attribute("severity", in: opener), attribute("guidance", in: opener))
    }

    private static func attribute(_ name: String, in opener: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: "\(name)=\"([^\"]*)\"") else { return nil }
        let range = NSRange(opener.startIndex..., in: opener)
        guard let match = regex.firstMatch(in: opener, range: range),
              let valueRange = Range(match.range(at: 1), in: opener) else { return nil }
        return String(opener[valueRange])
    }

    private static func decodeEntities(_ text: String) -> String {
        text.replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&apos;", with: "'")
            .replacingOccurrences(of: "&amp;", with: "&")
    }
}
