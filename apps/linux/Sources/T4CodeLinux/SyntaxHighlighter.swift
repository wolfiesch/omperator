//  SyntaxHighlighter.swift
//  Pure-GTK syntax coloring for fenced code blocks in the Omperator transcript.
//  Fresh port of the Enclave/SwiftCrossUI engine (~/dev/Enclave/Sources/
//  SyntaxHighlighter.swift, apps/linux/Sources/T4CodeLinuxLib/Views/) to the
//  GTK4 app surface: same ordered (tag, regex) rules with one combined regex
//  per language, but emitting flat `CodeToken` runs instead of attributed
//  text or colors. Comments and strings are always the first rules so later
//  rules never recolor inside them.
//
//  Foundation only — no GTK import. Concatenating `tokens.map(\.text)` is
//  byte-identical to the input `code`.

import Foundation

/// One colored run of source text.
public struct CodeToken {
    public let text: String
    public let tag: String
    public init(text: String, tag: String) {
        self.text = text
        self.tag = tag
    }
}

/// Ordered (tag, regex fragment) rules. Order = match priority.
private struct LangSpec {
    let rules: [(tag: String, fragment: String)]
    var signature: String { rules.map { $0.fragment }.joined(separator: "|") }
}

/// Tokenize a fenced code block. `language` is matched case-insensitively;
/// unknown languages get a light comment/string/number pass. `diff`/`patch`
/// (or any unified-diff text) get per-line +/− tinting instead.
public func highlightCode(_ code: String, language: String) -> [CodeToken] {
    let lang = language.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
    if lang == "diff" || lang == "patch" || looksLikeUnifiedDiff(code) {
        return diffTokens(code)
    }
    return tokenize(code, spec: spec(for: lang))
}

// MARK: - tokenizer

/// Walk one combined regex (rule order = alternation order) and emit tagged
/// runs, filling gaps with `syn-plain`.
private func tokenize(_ code: String, spec: LangSpec) -> [CodeToken] {
    if code.isEmpty { return [] }
    guard let regex = compiled(spec) else {
        return [CodeToken(text: code, tag: "syn-plain")]
    }
    let ns = code as NSString
    let full = NSRange(location: 0, length: ns.length)
    var tokens: [CodeToken] = []
    var cursor = 0
    regex.enumerateMatches(in: code, options: [], range: full) { match, _, _ in
        guard let match else { return }
        let start = match.range.location
        let end = NSMaxRange(match.range)
        if start > cursor {
            append(&tokens, ns.substring(with: NSRange(location: cursor, length: start - cursor)), "syn-plain")
        }
        for (i, rule) in spec.rules.enumerated() {
            let r = match.range(at: i + 1)
            if r.location != NSNotFound {
                append(&tokens, ns.substring(with: r), rule.tag)
                break
            }
        }
        cursor = end
    }
    if cursor < ns.length {
        append(&tokens, ns.substring(with: NSRange(location: cursor, length: ns.length - cursor)), "syn-plain")
    }
    return tokens
}

/// Append a run, merging into the previous token when the tags match so
/// adjacent same-colored spans stay one token.
private func append(_ tokens: inout [CodeToken], _ text: String, _ tag: String) {
    guard !text.isEmpty else { return }
    if let last = tokens.last, last.tag == tag {
        tokens[tokens.count - 1] = CodeToken(text: last.text + text, tag: tag)
    } else {
        tokens.append(CodeToken(text: text, tag: tag))
    }
}

// MARK: - diff

/// Per-line diff tokens. `+` lines become `diff-add`, `-` lines become
/// `diff-remove` (markers kept, one token per line, newlines preserved).
/// File headers (`--- a/…`, `+++ b/…`) and bare `+` / `-` lines stay plain.
private func diffTokens(_ code: String) -> [CodeToken] {
    if code.isEmpty { return [] }
    let lines = code.split(separator: "\n", omittingEmptySubsequences: false)
    var tokens: [CodeToken] = []
    tokens.reserveCapacity(lines.count)
    for (i, line) in lines.enumerated() {
        var text = String(line)
        if i != lines.count - 1 { text.append("\n") }
        tokens.append(CodeToken(text: text, tag: diffTag(line)))
    }
    return tokens
}

private func diffTag(_ line: Substring) -> String {
    if line.hasPrefix("+++") || line.hasPrefix("---") { return "syn-plain" }
    if line == "+" || line == "-" { return "syn-plain" }
    if line.hasPrefix("+") { return "diff-add" }
    if line.hasPrefix("-") { return "diff-remove" }
    return "syn-plain"
}

/// True when `code` looks like a unified diff even if the fence said something
/// else: a `@@` hunk header accompanied by +/− lines, or a git/svn header.
private func looksLikeUnifiedDiff(_ code: String) -> Bool {
    var sawHunk = false
    var sawMarker = false
    for line in code.split(separator: "\n", omittingEmptySubsequences: false) {
        if line.hasPrefix("@@") {
            sawHunk = true
        } else if line.hasPrefix("diff --git ") || line.hasPrefix("Index: ") || line.hasPrefix("=== ") {
            return true
        }
        if !sawMarker && (line.hasPrefix("+") || line.hasPrefix("-")) { sawMarker = true }
        if sawHunk && sawMarker { return true }
    }
    return false
}

// MARK: - compiled-regex cache

private let specCacheLock = NSLock()
private var specCache: [String: NSRegularExpression] = [:]

private func compiled(_ spec: LangSpec) -> NSRegularExpression? {
    specCacheLock.lock(); defer { specCacheLock.unlock() }
    if let cached = specCache[spec.signature] { return cached }
    let pattern = spec.rules.enumerated().map { "(\($0.element.fragment))" }.joined(separator: "|")
    guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else { return nil }
    specCache[spec.signature] = regex
    return regex
}

// MARK: - shared regex fragments

private enum Frag {
    static let lineSlash = #"//[^\n]*"#
    static let blockC = #"/\*[\s\S]*?\*/"#
    static let lineHash = #"#[^\n]*"#
    static let htmlComment = #"<!--[\s\S]*?-->"#
    static let dq = #""(?:\\.|[^"\\])*""#
    static let sq = #"'(?:\\.|[^'\\])*'"#
    static let tmpl = #"`(?:\\.|[^`\\])*`"#
    static let strings = dq + "|" + sq
    static let num = #"\b0[xX][0-9a-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[fFlLuU]*\b"#
    static let fn = #"[A-Za-z_$][\w$]*(?=\s*\()"#
    static let dec = #"@\w+"#
    /// Preprocessor directives (`#include`, `#define`, …) for C-family code.
    static let preproc = #"(?m)^[ \t]*#[ \t]*[a-zA-Z]+\b"#
    static func kw(_ s: String) -> String { #"\b(?:\#(s))\b"# }
}

// MARK: - language specs

private enum Langs {
    static let swift = LangSpec(rules: [
        ("syn-comment", Frag.lineSlash + "|" + Frag.blockC),
        ("syn-string", Frag.strings),
        ("syn-number", Frag.num),
        ("syn-attribute", Frag.dec),
        ("syn-keyword", Frag.kw("func|let|var|if|else|guard|for|while|switch|case|default|break|continue|return|throw|throws|rethrows|try|catch|do|defer|struct|class|enum|protocol|extension|init|deinit|self|Self|super|nil|true|false|as|is|in|where|import|public|private|fileprivate|internal|open|static|final|lazy|weak|unowned|some|any|async|await|actor|associatedtype|typealias|mutating|nonmutating|override|convenience|required|inout|indirect|repeat|fallthrough")),
        ("syn-type", Frag.kw("Int|Double|Float|String|Bool|Array|Dictionary|Set|Optional|Result|Void|URL|Data|Date|Error|Any|Codable|Hashable|Equatable|Comparable|Range|UUID")),
        ("syn-function", Frag.fn),
    ])

    static let js = LangSpec(rules: [
        ("syn-comment", Frag.lineSlash + "|" + Frag.blockC),
        ("syn-string", Frag.strings + "|" + Frag.tmpl),
        ("syn-number", Frag.num),
        ("syn-attribute", Frag.dec),
        ("syn-keyword", Frag.kw("var|let|const|function|return|if|else|for|while|do|switch|case|break|continue|new|delete|typeof|instanceof|void|this|class|extends|super|import|export|from|default|try|catch|finally|throw|async|await|yield|null|undefined|true|false|in|of|static|get|set|public|private|protected|readonly|interface|type|enum|namespace|as|is|implements|abstract")),
        ("syn-type", Frag.kw("string|number|boolean|any|unknown|void|never|object|symbol|bigint|Promise|Array|Map|Set|Date|Error|JSON|Math|Object|console")),
        ("syn-function", Frag.fn),
    ])

    static let python = LangSpec(rules: [
        ("syn-comment", Frag.lineHash),
        ("syn-string", #"(?:'''|""")[\s\S]*?(?:'''|""")"# + "|" + Frag.strings),
        ("syn-number", Frag.num),
        ("syn-attribute", Frag.dec),
        ("syn-keyword", Frag.kw("def|class|return|if|elif|else|for|while|break|continue|pass|raise|try|except|finally|with|as|import|from|global|nonlocal|lambda|yield|async|await|del|in|is|not|and|or|None|True|False|assert")),
        ("syn-type", Frag.kw("int|float|str|bool|list|dict|tuple|set|frozenset|object|bytes|bytearray|range|type|complex")),
        ("syn-function", Frag.fn),
    ])

    static let bash = LangSpec(rules: [
        ("syn-comment", Frag.lineHash),
        ("syn-string", Frag.strings),
        ("syn-number", Frag.num),
        ("syn-keyword", Frag.kw("if|then|else|elif|fi|for|do|done|while|until|case|esac|in|function|return|local|export|unset|echo|read|exit|shift|break|continue|cd|set|source|alias|trap|wait|printf")),
        ("syn-function", Frag.fn),
    ])

    static let json = LangSpec(rules: [
        ("syn-string", Frag.strings),
        ("syn-number", Frag.num),
        ("syn-type", Frag.kw("true|false|null")),
    ])

    static let rust = LangSpec(rules: [
        ("syn-comment", Frag.lineSlash + "|" + Frag.blockC),
        ("syn-string", Frag.strings),
        ("syn-number", Frag.num),
        ("syn-attribute", #"#\[[a-zA-Z_][\w]*\]"#),
        ("syn-keyword", Frag.kw("fn|let|mut|const|static|if|else|for|while|loop|match|break|continue|return|struct|enum|trait|impl|pub|use|mod|ref|self|Self|super|as|in|where|unsafe|async|await|move|dyn|crate|extern|type|true|false")),
        ("syn-type", Frag.kw("i8|i16|i32|i64|i128|usize|u8|u16|u32|u64|u128|isize|f32|f64|bool|char|str|String|Vec|Option|Result|Box|Rc|Arc|HashMap|HashSet")),
        ("syn-function", Frag.fn),
    ])

    static let go = LangSpec(rules: [
        ("syn-comment", Frag.lineSlash + "|" + Frag.blockC),
        ("syn-string", Frag.strings + "|" + Frag.tmpl),
        ("syn-number", Frag.num),
        ("syn-keyword", Frag.kw("func|var|const|type|struct|interface|map|chan|if|else|for|range|switch|case|default|break|continue|return|defer|go|select|package|import|fallthrough|nil|true|false")),
        ("syn-type", Frag.kw("int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|uintptr|string|bool|byte|rune|float32|float64|complex64|complex128|error|any")),
        ("syn-function", Frag.fn),
    ])

    static let css = LangSpec(rules: [
        ("syn-comment", Frag.blockC),
        ("syn-string", Frag.strings),
        ("syn-number", Frag.num + "|" + #"#[0-9a-fA-F]{3,8}\b"#),
        ("syn-attribute", #"@[\w-]+"#),
        ("syn-type", Frag.kw("px|em|rem|vh|vw|auto|none|block|flex|grid|absolute|relative|fixed|solid|dashed|inherit|initial|center|left|right|top|bottom")),
    ])

    static let html = LangSpec(rules: [
        ("syn-comment", Frag.htmlComment),
        ("syn-string", Frag.strings),
        ("syn-keyword", #"<\/?[a-zA-Z][\w-]*"#),
        ("syn-attribute", #"[a-zA-Z-]+(?=\s*=)"#),
        ("syn-number", Frag.num),
    ])

    static let c = LangSpec(rules: [
        ("syn-comment", Frag.lineSlash + "|" + Frag.blockC),
        ("syn-string", Frag.strings),
        ("syn-number", Frag.num),
        ("syn-attribute", Frag.dec + "|" + Frag.preproc),
        ("syn-keyword", Frag.kw("auto|break|case|const|continue|default|do|else|enum|extern|for|goto|if|inline|register|restrict|return|sizeof|static|struct|switch|typedef|union|volatile|while|alignas|alignof|and|and_eq|asm|bitand|bitor|bool|catch|class|compl|const_cast|constexpr|decltype|delete|dynamic_cast|explicit|export|false|friend|mutable|namespace|new|noexcept|not|not_eq|nullptr|operator|or|or_eq|private|protected|public|reinterpret_cast|static_assert|static_cast|template|this|thread_local|throw|true|try|typeid|typename|using|virtual|xor|xor_eq|NULL|override|final")),
        ("syn-type", Frag.kw("void|char|short|int|long|float|double|signed|unsigned|wchar_t|char16_t|char32_t|size_t|ssize_t|ptrdiff_t|intptr_t|uintptr_t|int8_t|int16_t|int32_t|int64_t|uint8_t|uint16_t|uint32_t|uint64_t|intmax_t|uintmax_t|string|wstring|u16string|u32string|string_view|vector|map|unordered_map|set|unordered_set|list|deque|stack|queue|priority_queue|pair|tuple|optional|variant|unique_ptr|shared_ptr|weak_ptr|function|initializer_list|iterator|FILE|va_list|id|SEL|Class|IMP|instancetype|BOOL|NSInteger|NSUInteger|CGFloat|NSObject|NSString|NSArray|NSDictionary|NSSet|NSData|NSNumber|NSDate|NSURL|NSError|NSRange|NSPoint|NSSize|NSRect|CGPoint|CGSize|CGRect")),
        ("syn-function", Frag.fn),
    ])

    static let yaml = LangSpec(rules: [
        ("syn-comment", Frag.lineHash),
        ("syn-string", Frag.strings),
        ("syn-number", Frag.num),
        ("syn-keyword", #"[A-Za-z_][\w-]*(?=\s*:)"#),
        ("syn-type", Frag.kw("true|false|null|yes|no|on|off")),
    ])

    static let markdown = LangSpec(rules: [
        ("syn-comment", Frag.htmlComment),
        ("syn-string", #"``[\s\S]*?``|`[^`\n]*`"#),
        ("syn-attribute", #"!?\[[^\]]*\]\([^)]*\)|https?://[^\s<)\]]+"#),
        ("syn-keyword", #"(?m)^#{1,6}[^\n]*"#),
        ("syn-attribute", #"\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|~~[^~\n]+~~"#),
        ("syn-number", Frag.num),
    ])

    static let generic = LangSpec(rules: [
        ("syn-comment", Frag.lineSlash + "|" + Frag.blockC + "|" + Frag.lineHash),
        ("syn-string", Frag.strings),
        ("syn-number", Frag.num),
    ])
}

// MARK: - dispatch

private func spec(for lang: String) -> LangSpec {
    switch lang {
    case "swift": return Langs.swift
    case "javascript", "js", "mjs", "cjs", "typescript", "ts", "jsx", "tsx": return Langs.js
    case "python", "py", "py3": return Langs.python
    case "bash", "sh", "shell", "zsh", "fish": return Langs.bash
    case "json", "json5": return Langs.json
    case "rust", "rs": return Langs.rust
    case "go", "golang": return Langs.go
    case "css", "scss", "less": return Langs.css
    case "html", "xml", "svg", "vue", "svelte": return Langs.html
    case "c", "h", "cpp", "cc", "cxx", "hpp", "hxx", "c++", "objc", "obj-c", "objective-c", "objectivec", "mm": return Langs.c
    case "yaml", "yml", "toml": return Langs.yaml
    case "markdown", "md", "mdx": return Langs.markdown
    default: return Langs.generic
    }
}
