//  SyntaxHighlighter.swift (Linux port of apps/ios/Sources/SyntaxHighlighter.swift)
//  Theme-aware, dependency-free syntax coloring for fenced code blocks.
//  Same combined-regex engine, match-priority rules, and language specs as
//  the Apple source. Output type changes for SwiftCrossUI: the Apple file
//  builds NSAttributedString (AppKit/UIKit fonts + colors); Linux has no
//  attributed-text rendering, so the same token walk emits plain
//  (text, Color) runs that views render with a monospaced font. `diff` keeps
//  the +/- gutter logic; per-line background tints are dropped (LINUX-GAP:
//  SwiftCrossUI Text has no background attribute).

import Foundation
import SwiftCrossUI

enum SyntaxToken { case comment, string, number, keyword, type, function, attribute }

fileprivate struct LangSpec {
    /// (kind, regex fragment). Order = match priority (comments & strings first).
    let rules: [(SyntaxToken, String)]
    var signature: String { rules.map { $0.1 }.joined(separator: "|") }
    static func kw(_ s: String) -> String { #"\b(?:\#(s))\b"# }
}

/// One colored run: text plus the resolved foreground color. `fontSize` is
/// not carried (Linux renders code with a uniform monospaced font set by the
/// caller); it stays a parameter so call sites read like the Apple file.
typealias SyntaxRun = (text: String, color: Color)

enum SyntaxHighlighter {

    // MARK: - public

    static func segments(_ code: String, language rawLang: String, theme t: Theme, baseColor: Color? = nil, fontSize: Double? = 12.5) -> [SyntaxRun] {
        let lang = rawLang.lowercased().trimmingCharacters(in: .whitespaces)
        // Memoized: SwiftCrossUI re-renders the transcript on every store
        // change; without this, every render re-runs the regex pass over
        // every code block. Keyed by content + language + theme mode (colors
        // differ dark/light).
        let key = "\(lang)\u{1F}\(t.mode.rawValue)\u{1F}\(code)"
        if let cached = segmentCache[key] { return cached }
        let result: [SyntaxRun]
        if lang == "diff" || lang == "patch" {
            result = diffSegments(code, theme: t, baseColor: baseColor, fontSize: fontSize)
        } else {
            result = colorRuns(code, spec: spec(for: lang), theme: t, baseColor: baseColor, fontSize: fontSize)
        }
        if segmentCache.count > 512 { segmentCache.removeAll() }
        segmentCache[key] = result
        return result
    }

    private static var segmentCache: [String: [SyntaxRun]] = [:]

    /// macOS-parity name: `attributed` there returns an NSAttributedString;
    /// on Linux the same pass yields color runs. Alias of `segments`.
    static func attributed(_ code: String, language rawLang: String, theme t: Theme, baseColor: Color? = nil, fontSize: Double? = 12.5) -> [SyntaxRun] {
        segments(code, language: rawLang, theme: t, baseColor: baseColor, fontSize: fontSize)
    }

    /// Plain-text form of `diffSegments` (same gutter/line processing, colors
    /// discarded) — used by views that render a uniform terminal string.
    static func diff(_ code: String, theme t: Theme, codeLanguage: String? = nil, baseColor: Color? = nil, fontSize: Double? = 12.5) -> String {
        diffSegments(code, theme: t, codeLanguage: codeLanguage, baseColor: baseColor, fontSize: fontSize)
            .map(\.text)
            .joined()
    }

    /// Map a file path to the `language` string accepted by `spec(for:)`.
    static func languageFromPath(_ path: String) -> String? {
        let base = (path as NSString).lastPathComponent
        if base.lowercased() == "dockerfile" { return "dockerfile" }
        let ext = (base as NSString).pathExtension.lowercased()
        let map: [String: String] = [
            "swift": "swift", "ts": "typescript", "tsx": "typescript", "mts": "typescript", "cts": "typescript",
            "js": "javascript", "jsx": "javascript", "mjs": "javascript", "cjs": "javascript",
            "py": "python", "rb": "ruby", "rs": "rust", "go": "go",
            "java": "java", "kt": "kotlin", "c": "c", "h": "c", "cpp": "cpp", "cc": "cpp", "hpp": "cpp",
            "cs": "csharp", "php": "php", "sh": "bash", "bash": "bash", "zsh": "bash", "fish": "bash",
            "sql": "sql", "html": "html", "htm": "html", "xml": "html", "svg": "html", "vue": "html", "svelte": "html",
            "css": "css", "scss": "css", "less": "css", "json": "json", "jsonc": "json", "json5": "json",
            "yaml": "yaml", "yml": "yaml", "toml": "ini", "ini": "ini", "md": "markdown", "mdx": "markdown",
            "dockerfile": "dockerfile", "lua": "lua", "zig": "zig", "diff": "diff", "patch": "diff"
        ]
        return map[ext]
    }

    // MARK: - tokenized coloring

    /// Same pass as the Apple `color(_:spec:theme:)`: one combined regex,
    /// dispatch by the captured group so tokens never recolor inside
    /// comments/strings. Emits base-colored text between matches.
    private static func colorRuns(_ code: String, spec: LangSpec, theme t: Theme, baseColor: Color? = nil, fontSize: Double? = 12.5) -> [SyntaxRun] {
        var out: [SyntaxRun] = []
        let base = baseColor ?? t.txtBody
        let regex = compiled(spec)
        let ns = code as NSString
        let full = NSRange(location: 0, length: ns.length)
        var cursor = 0
        regex.enumerateMatches(in: code, options: [], range: full) { m, _, _ in
            guard let m else { return }
            if m.range.location > cursor {
                append(&out, ns.substring(with: NSRange(location: cursor, length: m.range.location - cursor)), base)
            }
            for i in 0..<spec.rules.count {
                let r = m.range(at: i + 1)
                if r.location != NSNotFound {
                    append(&out, ns.substring(with: r), tokenColor(spec.rules[i].0, t))
                    break
                }
            }
            cursor = NSMaxRange(m.range)
        }
        if cursor < ns.length {
            append(&out, ns.substring(with: NSRange(location: cursor, length: ns.length - cursor)), base)
        }
        return out
    }

    private static func append(_ out: inout [SyntaxRun], _ text: String, _ color: Color) {
        guard !text.isEmpty else { return }
        // Merge adjacent same-color runs so long plain spans stay one run.
        if let last = out.last, last.color == color {
            out[out.count - 1] = (last.text + text, color)
        } else {
            out.append((text, color))
        }
    }

    private static func tokenColor(_ kind: SyntaxToken, _ t: Theme) -> Color {
        switch kind {
        case .comment:   return t.synComment
        case .string:    return t.synString
        case .number:    return t.synNumber
        case .keyword:   return t.synKeyword
        case .type:      return t.synType
        case .function:  return t.synFunction
        case .attribute: return t.synType
        }
    }

    static func diffSegments(_ code: String, theme t: Theme, codeLanguage: String? = nil, baseColor: Color? = nil, fontSize: Double? = 12.5) -> [SyntaxRun] {
        var out: [SyntaxRun] = []
        let defaultFG = baseColor ?? t.txtBody
        let lines = code.components(separatedBy: "\n")
        let codeFrameSep = "│"
        let numberedRegex = try! NSRegularExpression(pattern: "^([+\\- ])(\\d+)\\|(.*)$", options: [])

        for (i, body) in lines.enumerated() {
            var fg: Color = defaultFG
            // LINUX-GAP: macOS paints +/- line backgrounds (diffAddBG/diffDelBG)
            // via NSAttributedString backgroundColor; SwiftCrossUI Text has no
            // per-run background, so only the foreground tint survives.
            var gutter: String
            var content: String
            var isHunk = false

            if body.trimmingCharacters(in: .whitespaces).isEmpty {
                gutter = "…"
                content = ""
            } else if let match = numberedRegex.firstMatch(in: body, options: [], range: NSRange(location: 0, length: (body as NSString).length)) {
                let prefix = (body as NSString).substring(with: match.range(at: 1))
                let lineNum = (body as NSString).substring(with: match.range(at: 2))
                content = (body as NSString).substring(with: match.range(at: 3))
                gutter = "\(prefix)\(lineNum)|"
                if prefix == "+" { fg = t.diffAdd }
                else if prefix == "-" { fg = t.diffDel }
            } else if let sepIdx = body.firstIndex(of: Character(codeFrameSep)) {
                let g = String(body[..<sepIdx])
                gutter = g + codeFrameSep
                content = String(body[body.index(after: sepIdx)...])
                let marker = g.trimmingCharacters(in: .whitespaces).first
                if marker == "+" { fg = t.diffAdd }
                else if marker == "-" { fg = t.diffDel }
                else if marker == "*" { fg = t.synKeyword }
            } else if body.hasPrefix("@@") {
                gutter = body
                content = ""
                isHunk = true
                fg = t.synKeyword
            } else if body.hasPrefix("+") && !body.hasPrefix("+++") {
                gutter = "+"
                content = String(body.dropFirst())
                if content.hasPrefix(" ") { content = String(content.dropFirst()) }
                fg = t.diffAdd
            } else if body.hasPrefix("-") && !body.hasPrefix("---") {
                gutter = "-"
                content = String(body.dropFirst())
                if content.hasPrefix(" ") { content = String(content.dropFirst()) }
                fg = t.diffDel
            } else if body.hasPrefix(" ") {
                gutter = " "
                content = String(body.dropFirst())
                if content.hasPrefix(" ") { content = String(content.dropFirst()) }
            } else {
                gutter = ""
                content = body
            }

            append(&out, gutter, fg)

            if !content.isEmpty {
                if let codeLanguage, !isHunk {
                    let lang = codeLanguage.lowercased().trimmingCharacters(in: .whitespaces)
                    out.append(contentsOf: colorRuns(content, spec: spec(for: lang), theme: t, baseColor: fg, fontSize: fontSize))
                } else {
                    append(&out, content, fg)
                }
            }

            if i != lines.count - 1 { append(&out, "\n", fg) }
        }
        return out
    }

    // MARK: - compiled-regex cache

    private static var cache: [String: NSRegularExpression] = [:]
    private static let cacheLock = NSLock()
    private static func compiled(_ spec: LangSpec) -> NSRegularExpression {
        cacheLock.lock(); defer { cacheLock.unlock() }
        if let r = cache[spec.signature] { return r }
        let pattern = spec.rules.enumerated().map { "(\($0.element.1))" }.joined(separator: "|")
        let r = (try? NSRegularExpression(pattern: pattern, options: []))
            ?? (try! NSRegularExpression(pattern: "", options: []))
        cache[spec.signature] = r
        return r
    }

    // MARK: - language specs

    fileprivate static func spec(for lang: String) -> LangSpec {
        switch lang {
        case "swift":                       return .swift
        case "javascript", "js", "mjs", "cjs",
             "typescript", "ts", "jsx", "tsx": return .js
        case "python", "py", "py3":         return .python
        case "bash", "sh", "shell", "zsh", "fish": return .bash
        case "json", "json5":               return .json
        case "rust", "rs":                  return .rust
        case "go", "golang":                return .go
        case "sql", "mysql", "postgres", "postgresql", "sqlite", "sqlite3": return .sql
        case "css", "scss", "less":         return .css
        case "html", "xml", "svg", "vue", "svelte": return .html
        case "yaml", "yml", "toml":         return .yaml
        default:                            return .generic
        }
    }
}

private extension LangSpec {
    // shared fragments (raw strings → literal regex escaping)
    static var lineSlash: String { #"//[^\n]*"# }
    static var lineDash:  String { #"--[^\n]*"# }
    static var blockC:    String { #"/\*[\s\S]*?\*/"# }
    static var lineHash:  String { #"#[^\n]*"# }
    static var dq:        String { #""(?:\\.|[^"\\])*""# }
    static var sq:        String { #"'(?:\\.|[^'\\])*'"# }
    static var tmpl:      String { #"`(?:\\.|[^`\\])*`"# }
    static var strings:   String { dq + "|" + sq }
    static var num:       String { #"\b0[xX][0-9a-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[fFlLuU]*\b"# }
    static var fn:        String { #"[A-Za-z_$][\w$]*(?=\s*\()"# }
    static var dec:       String { #"@\w+"# }

    static let swift = LangSpec(rules: [
        (.comment, lineSlash + "|" + blockC),
        (.string, strings),
        (.number, num),
        (.attribute, dec),
        (.keyword, kw("func|let|var|if|else|guard|for|while|switch|case|default|break|continue|return|throw|throws|rethrows|try|catch|do|defer|struct|class|enum|protocol|extension|init|deinit|self|Self|super|nil|true|false|as|is|in|where|import|public|private|fileprivate|internal|open|static|final|lazy|weak|unowned|some|any|async|await|actor|associatedtype|typealias|mutating|nonmutating|override|convenience|required|inout|indirect|repeat|fallthrough")),
        (.type, kw("Int|Double|Float|String|Bool|Array|Dictionary|Set|Optional|Result|Void|URL|Data|Date|Error|Any|Codable|Hashable|Equatable|Comparable|Range|UUID")),
        (.function, fn),
    ])

    static let js = LangSpec(rules: [
        (.comment, lineSlash + "|" + blockC),
        (.string, strings + "|" + tmpl),
        (.number, num),
        (.attribute, dec),
        (.keyword, kw("var|let|const|function|return|if|else|for|while|do|switch|case|break|continue|new|delete|typeof|instanceof|void|this|class|extends|super|import|export|from|default|try|catch|finally|throw|async|await|yield|null|undefined|true|false|in|of|static|get|set|public|private|protected|readonly|interface|type|enum|namespace|as|is|implements|abstract")),
        (.type, kw("string|number|boolean|any|unknown|void|never|object|symbol|bigint|Promise|Array|Map|Set|Date|Error|JSON|Math|Object|console")),
        (.function, fn),
    ])

    static let python = LangSpec(rules: [
        (.comment, lineHash),
        (.string, strings + "|" + #"(?:'''|""")[\s\S]*?(?:'''|""")"#),
        (.number, num),
        (.attribute, dec),
        (.keyword, kw("def|class|return|if|elif|else|for|while|break|continue|pass|raise|try|except|finally|with|as|import|from|global|nonlocal|lambda|yield|async|await|del|in|is|not|and|or|None|True|False|assert")),
        (.type, kw("int|float|str|bool|list|dict|tuple|set|frozenset|object|bytes|bytearray|range|type|complex")),
        (.function, fn),
    ])

    static let bash = LangSpec(rules: [
        (.comment, lineHash),
        (.string, strings),
        (.number, num),
        (.keyword, kw("if|then|else|elif|fi|for|do|done|while|until|case|esac|in|function|return|local|export|unset|echo|read|exit|shift|break|continue|cd|set|source|alias|trap|wait|printf")),
        (.function, fn),
    ])

    static let json = LangSpec(rules: [
        (.string, strings),
        (.number, num),
        (.type, kw("true|false|null")),
    ])

    static let rust = LangSpec(rules: [
        (.comment, lineSlash + "|" + blockC),
        (.string, strings),
        (.number, num),
        (.attribute, dec),
        (.keyword, kw("fn|let|mut|const|static|if|else|for|while|loop|match|break|continue|return|struct|enum|trait|impl|pub|use|mod|ref|self|Self|super|as|in|where|unsafe|async|await|move|dyn|crate|extern|type|true|false")),
        (.type, kw("i8|i16|i32|i64|i128|usize|u8|u16|u32|u64|u128|isize|f32|f64|bool|char|str|String|Vec|Option|Result|Box|Rc|Arc|HashMap|HashSet")),
        (.function, fn),
    ])

    static let go = LangSpec(rules: [
        (.comment, lineSlash + "|" + blockC),
        (.string, strings),
        (.number, num),
        (.keyword, kw("func|var|const|type|struct|interface|map|chan|if|else|for|range|switch|case|default|break|continue|return|defer|go|select|package|import|fallthrough|nil|true|false")),
        (.type, kw("int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|uintptr|string|bool|byte|rune|float32|float64|complex64|complex128|error|any")),
        (.function, fn),
    ])

    static let sql = LangSpec(rules: [
        (.comment, lineDash + "|" + blockC),
        (.string, sq),
        (.number, num),
        (.keyword, kw("SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE|TABLE|DROP|ALTER|ADD|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|VALUES|SET|INTO|AND|OR|NOT|NULL|AS|DISTINCT|UNION|INDEX|PRIMARY|KEY|FOREIGN|REFERENCES|DEFAULT|UNIQUE|BEGIN|COMMIT|ROLLBACK|ASC|DESC|CASE|WHEN|THEN|END|EXISTS|IN|LIKE|BETWEEN")),
    ])

    static let css = LangSpec(rules: [
        (.comment, blockC),
        (.string, strings),
        (.number, num + "|" + #"#[0-9a-fA-F]{3,8}\b"#),
        (.attribute, #"@[\w-]+"#),
        (.type, kw("px|em|rem|vh|vw|auto|none|block|flex|grid|absolute|relative|fixed|solid|dashed|inherit|initial|center|left|right|top|bottom")),
    ])

    static let html = LangSpec(rules: [
        (.comment, #"<!--[\s\S]*?-->"#),
        (.string, strings),
        (.keyword, #"<\/?[a-zA-Z][\w-]*"#),
        (.attribute, #"[a-zA-Z-]+(?=\s*=)"#),
        (.number, num),
    ])

    static let yaml = LangSpec(rules: [
        (.comment, lineHash),
        (.string, strings),
        (.number, num),
        (.keyword, #"[A-Za-z_][\w-]*(?=\s*:)"#),
        (.type, kw("true|false|null|yes|no|on|off")),
    ])

    static let generic = LangSpec(rules: [
        (.comment, lineSlash + "|" + blockC + "|" + lineHash),
        (.string, strings),
        (.number, num),
        (.function, fn),
    ])
}
