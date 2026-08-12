import Foundation

/// One styled run of rendered transcript text. `text` is the marker-stripped
/// rendering the buffer should show; `tag` names the GtkTextTag / CSS class
/// the caller applies to that run.
struct StyledSegment {
    let text: String
    let tag: String
}

// MARK: - Entry point

/// Render a transcript entry body into styled segments for the GTK text
/// buffer. Pure Foundation — no GTK types; the caller maps each `tag` onto a
/// GtkTextTag and appends `text`.
///
/// - User messages (`role == "user"`) are returned as a single `user`-tagged
///   segment with the body verbatim (no markdown parsing).
/// - Assistant/other/nil roles are parsed as markdown-lite; plain text uses
///   the `assistant` tag.
///
/// Tags emitted: md-h1, md-h2, md-h3, md-bold, md-italic, md-bold-italic,
/// md-inline-code, md-list, md-quote, md-link, code-block, diff-add,
/// diff-remove, user, assistant.
///
/// Text is rendered (markers stripped): heading `# `, quote `> `, and fenced
/// code-block markers are dropped; bold/italic/code/link delimiters are
/// dropped; list lines keep their bullet or number — nested items keep their
/// leading indentation as text, so each level renders visibly; newlines are
/// preserved (each original line maps to at most one output line, and dropped
/// fence lines leave their line slot as a blank line, so block boundaries
/// never merge).
///
/// Emphasis follows simplified CommonMark rules: `***`/`___` → bold-italic,
/// `**`/`__` → bold, `*`/`_` → italic, markers stripped. Emphasis never
/// opens inside a word (`a**b**c`, `foo_bar_baz` stay literal) and never
/// parses inside inline code spans.
func renderTranscriptSegments(body: String, role: String?) -> [StyledSegment] {
    guard !body.isEmpty else { return [] }
    if role == "user" {
        return [StyledSegment(text: body, tag: "user")]
    }

    let defaultTag = "assistant"
    let lines = body.split(separator: "\n", omittingEmptySubsequences: false)
    var segments: [StyledSegment] = []
    var inCodeBlock = false

    for (index, line) in lines.enumerated() {
        let lineText = String(line)
        let isLast = index == lines.count - 1
        var lineSegments: [StyledSegment]

        if inCodeBlock {
            if isFenceLine(lineText) {
                inCodeBlock = false
                lineSegments = []
            } else {
                lineSegments = codeLineSegments(lineText)
            }
        } else if isFenceLine(lineText) {
            inCodeBlock = true
            lineSegments = []
        } else {
            lineSegments = proseLineSegments(lineText, defaultTag: defaultTag)
        }

        // Every non-final line keeps its newline, attached to the last run of
        // that line (or emitted alone for fully-dropped lines like fences).
        if !isLast {
            appendNewline(to: &lineSegments, defaultTag: defaultTag)
        }
        segments.append(contentsOf: lineSegments)
    }
    return segments
}

// MARK: - Line-level (block) parsing

/// A fenced code block opens/closes on any line starting with three backticks.
private func isFenceLine(_ line: String) -> Bool {
    line.hasPrefix("```")
}

/// One content line inside a fenced code block. Lines that read like diff
/// hunks (`+` / `-` at column 0 followed by content) get the diff tags;
/// everything else — including blank lines — belongs to the code block so the
/// whole block shares its background.
private func codeLineSegments(_ line: String) -> [StyledSegment] {
    if let tag = diffTag(for: line) {
        return [StyledSegment(text: line, tag: tag)]
    }
    return [StyledSegment(text: line, tag: "code-block")]
}

/// Parse one line of prose: heading, list, quote, diff, then inline spans.
private func proseLineSegments(_ line: String, defaultTag: String) -> [StyledSegment] {
    if let (content, tag) = headingContent(line) {
        return content.isEmpty ? [] : [StyledSegment(text: content, tag: tag)]
    }
    // List rule wins over diff for "- …" so `- item` renders as a list item.
    // Nested and ordered items match through `isListLine`; the indentation
    // and the bullet/number stay in the emitted text.
    if isListLine(line) {
        return [StyledSegment(text: line, tag: "md-list")]
    }
    if line.hasPrefix("> ") {
        let content = String(line.dropFirst(2))
        return content.isEmpty ? [] : [StyledSegment(text: content, tag: "md-quote")]
    }
    if let tag = diffTag(for: line) {
        return [StyledSegment(text: line, tag: tag)]
    }
    return inlineSegments(line, defaultTag: defaultTag)
}

/// A list line: optional leading indentation, then a bullet (`-`, `*`,
/// `•`) or an ordered marker (`1.`, `1)`), then whitespace. Nested items
/// (`  - sub`, `    2. …`) match through their indentation, which stays in
/// the emitted text so each level renders visibly. A bare `-` with nothing
/// after it is not a list, and `+` is deliberately not a bullet so prose
/// diff lines (`+ change`) keep their diff tag.
private func isListLine(_ line: String) -> Bool {
    var i = line.startIndex
    while i < line.endIndex, line[i] == " " || line[i] == "\t" {
        i = line.index(after: i)
    }
    guard i < line.endIndex else { return false }
    if line[i] == "-" || line[i] == "*" || line[i] == "•" {
        i = line.index(after: i)
    } else if line[i].isNumber {
        var digits = i
        while digits < line.endIndex, line[digits].isNumber {
            digits = line.index(after: digits)
        }
        guard digits < line.endIndex, line[digits] == "." || line[digits] == ")" else { return false }
        i = line.index(after: digits)
    } else {
        return false
    }
    guard i < line.endIndex, line[i] == " " || line[i] == "\t" else { return false }
    return true
}

/// `#` / `##` / `###` at line start, followed by a space/tab or end of line.
/// Returns the stripped content and the heading tag. `#foo`, `#### …`, and
/// bare `#` (no content) fall through to plain text.
private func headingContent(_ line: String) -> (content: String, tag: String)? {
    guard line.hasPrefix("#") else { return nil }
    var index = line.startIndex
    var hashes = 0
    while index < line.endIndex, line[index] == "#", hashes < 3 {
        hashes += 1
        index = line.index(after: index)
    }
    guard hashes >= 1 else { return nil }
    if index < line.endIndex {
        let c = line[index]
        guard c == " " || c == "\t" else { return nil }
        index = line.index(after: index)
    }
    let tag = hashes == 1 ? "md-h1" : (hashes == 2 ? "md-h2" : "md-h3")
    return (String(line[index...]), tag)
}

/// A diff line: `+`/`-` as the first character, with content after it. A lone
/// `+`/`-` or a bare `- ` marker is not a diff line.
private func diffTag(for line: String) -> String? {
    guard let first = line.first, first == "+" || first == "-" else { return nil }
    let rest = line.dropFirst()
    guard !rest.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
    return first == "+" ? "diff-add" : "diff-remove"
}

/// Attach the line's newline to its last segment, or emit it alone when the
/// whole line was dropped (fences, empty headings).
private func appendNewline(to segments: inout [StyledSegment], defaultTag: String) {
    if segments.isEmpty {
        segments.append(StyledSegment(text: "\n", tag: defaultTag))
    } else {
        let last = segments.removeLast()
        segments.append(StyledSegment(text: last.text + "\n", tag: last.tag))
    }
}

// MARK: - Inline span parsing

/// Scan a line for inline spans: `` `code` ``, `***bold-italic***`,
/// `**bold**`/`__bold__`, `*italic*`/`_italic_`, `[label](url)`. Content is
/// emitted marker-stripped; text that never pairs up (or pairs with empty
/// content) stays plain and literal.
private func inlineSegments(_ line: String, defaultTag: String) -> [StyledSegment] {
    var segments: [StyledSegment] = []
    var plainStart = line.startIndex
    var i = line.startIndex

    func flushPlain() {
        if plainStart < i {
            segments.append(StyledSegment(text: String(line[plainStart..<i]), tag: defaultTag))
        }
    }

    while i < line.endIndex {
        let c = line[i]

        if c == "`" {
            let contentStart = line.index(after: i)
            if let close = findIndex(of: "`", in: line, after: contentStart), contentStart < close {
                flushPlain()
                segments.append(StyledSegment(text: String(line[contentStart..<close]), tag: "md-inline-code"))
                plainStart = line.index(after: close)
                i = plainStart
                continue
            }
            i = line.index(after: i)
            continue
        }

        if c == "*" || c == "_" {
            // Measure the run of identical markers at `i` (capped at 3 —
            // longer runs never form emphasis here).
            var runEnd = i
            var runLen = 0
            while runEnd < line.endIndex, line[runEnd] == c, runLen < 3 {
                runLen += 1
                runEnd = line.index(after: runEnd)
            }
            // Try longest first: `***`/`___` → bold-italic, `**`/`__` →
            // bold, `*`/`_` → italic.
            var emitted = false
            var len = runLen
            while len >= 1 {
                if let span = emphasisSpan(c, len: len, at: i, runEnd: runEnd, in: line),
                   !span.content.isEmpty {
                    flushPlain()
                    segments.append(StyledSegment(text: span.content, tag: emphasisTag(for: len)))
                    plainStart = span.pastClose
                    i = span.pastClose
                    emitted = true
                    break
                }
                len -= 1
            }
            if !emitted {
                i = line.index(after: i)
            }
            continue
        }

        if c == "[" {
            let labelStart = line.index(after: i)
            if let openParen = findSubstring("](", in: line, after: labelStart), labelStart < openParen,
               let closeParen = findIndex(of: ")", in: line, after: line.index(after: openParen)) {
                let label = String(line[labelStart..<openParen])
                let url = String(line[line.index(after: openParen)..<closeParen])
                if !label.isEmpty && !url.isEmpty {
                    flushPlain()
                    segments.append(StyledSegment(text: label, tag: "md-link"))
                    plainStart = line.index(after: closeParen)
                    i = plainStart
                    continue
                }
            }
            i = line.index(after: i)
            continue
        }

        i = line.index(after: i)
    }

    if plainStart < line.endIndex {
        segments.append(StyledSegment(text: String(line[plainStart...]), tag: defaultTag))
    }
    return segments
}

/// The tag for an emphasis span of the given marker length.
private func emphasisTag(for len: Int) -> String {
    switch len {
    case 3: return "md-bold-italic"
    case 2: return "md-bold"
    default: return "md-italic"
    }
}

/// Try to parse an emphasis span at `start`: a run of `len` `char`s that is
/// a valid opener, followed by non-empty content, closed by a valid run of
/// the same length. Returns the marker-stripped content and the index just
/// past the closer.
private func emphasisSpan(
    _ char: Character, len: Int, at start: String.Index, runEnd: String.Index, in line: String
) -> (content: String, pastClose: String.Index)? {
    // Opener: not preceded by an alphanumeric (no intraword emphasis, so
    // `a**b**c` / `foo_bar_baz` stay literal), and not followed by
    // whitespace.
    let before = start > line.startIndex ? line[line.index(before: start)] : nil
    if let b = before, !isEmphasisBoundary(b) { return nil }
    let after = runEnd < line.endIndex ? line[runEnd] : nil
    if let a = after, a.isWhitespace { return nil }

    let contentStart = line.index(start, offsetBy: len)
    guard let close = findEmphasisCloser(char: char, len: len, in: line, after: contentStart) else {
        return nil
    }
    let content = String(line[contentStart..<close])
    guard !content.isEmpty else { return nil }
    return (content, line.index(close, offsetBy: len))
}

/// A character that may border an emphasis delimiter: whitespace or
/// punctuation. Emphasis opens only after one of these (or line start) and
/// must close before one (or line end).
private func isEmphasisBoundary(_ c: Character) -> Bool {
    c.isWhitespace || c.isPunctuation
}

/// Find a valid closer for an emphasis run of exactly `len` `char`s at or
/// after `start`. The closer must be a run of exactly `len` (not part of a
/// longer run), preceded by non-whitespace, and followed by whitespace,
/// punctuation, or end of line. Inline code spans are skipped, so code
/// content never supplies a closer.
private func findEmphasisCloser(
    char: Character, len: Int, in line: String, after start: String.Index
) -> String.Index? {
    var j = start
    while j < line.endIndex {
        if line[j] == "`" {
            let contentStart = line.index(after: j)
            if let close = findIndex(of: "`", in: line, after: contentStart), contentStart < close {
                j = line.index(after: close)
                continue
            }
            j = line.index(after: j)
            continue
        }
        if line[j] != char {
            j = line.index(after: j)
            continue
        }
        var end = j
        var runLen = 0
        while end < line.endIndex, line[end] == char {
            runLen += 1
            end = line.index(after: end)
        }
        if runLen == len {
            let before = j > line.startIndex ? line[line.index(before: j)] : nil
            if let b = before, b.isWhitespace {
                j = end
                continue
            }
            let after = end < line.endIndex ? line[end] : nil
            if let a = after, !isEmphasisBoundary(a) {
                j = end
                continue
            }
            return j
        }
        j = end
    }
    return nil
}

// MARK: - String scanning helpers

private func findIndex(of char: Character, in s: String, after start: String.Index) -> String.Index? {
    var j = start
    while j < s.endIndex {
        if s[j] == char { return j }
        j = s.index(after: j)
    }
    return nil
}

private func findSubstring(_ needle: String, in s: String, after start: String.Index) -> String.Index? {
    guard !needle.isEmpty else { return nil }
    var j = start
    while j < s.endIndex {
        if s[j...].hasPrefix(needle) { return j }
        j = s.index(after: j)
    }
    return nil
}
