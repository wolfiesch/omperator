import Foundation
import CT4Gtk
import HostWire

/// Per-entry transcript widgets for the pure-GTK4 app. Each builder returns a
/// standalone widget tree that AppWindow parents into the transcript column;
/// the theme CSS (theme-moon.css / theme-dawn.css) styles the surfaces via
/// CSS classes, and the designer covers the inner-text-view backgrounds with
/// descendant rules (.user-bubble/.assistant-message/.tool-card/.advisory-card
/// textview → transparent), so the glass/panel fills show through.
///
/// Formatting follows the Enclave system (~/dev/Enclave/Sources):
/// - user messages: right-aligned glass bubble (`userBubble`), markdown-lite
///   prose rendered into a wrapping, capped Pango-markup label;
/// - assistant messages: split into markdown blocks — prose (`proseLabel`),
///   fenced code (`codeBlock`), and `<advisory>` callouts (`advisoryCard`);
/// - tool / turn rows: kind-colored cards (`toolCard`).
///
/// Entry dispatch: AppWindow calls `buildEntry` once per transcript entry and
/// parents the returned widget; the scroll pin / store wiring live elsewhere.

@MainActor
final class TranscriptWidgets {

    // MARK: - Theme hooks

    /// Syntax token colors by tag name. The main agent may retint these before
    /// building entries; defaults match theme-moon.css (Rosé Pine Moon) and the
    /// app's dark-mode tag theme. Applied when a code block's tags are created.
    static var syntaxForegrounds: [String: String] = [
        "syn-keyword": "#C4A7E7",
        "syn-string": "#9CCFD8",
        "syn-comment": "#6E6A86",
        "syn-number": "#F6C177",
        "syn-type": "#3E8FB0",
        "syn-function": "#EBBCBA",
        "syn-attribute": "#C4A7E7",
        "syn-plain": "#E0DEF4",
        "diff-add": "#9CCFD8",
        "diff-remove": "#EB6F92",
    ]

    /// Optional per-tag backgrounds (diff lines get a tint; everything else
    /// stays transparent over the code card's surface).
    static var syntaxBackgrounds: [String: String] = [
        "diff-add": "rgba(49,116,143,0.35)",
        "diff-remove": "rgba(235,111,146,0.18)",
    ]

    /// Extra Pango attributes per syntax tag: weight (Pango weight) / italics.
    static var syntaxWeights: [String: Int] = ["syn-keyword": 600]
    static var syntaxItalics: Set<String> = ["syn-comment", "syn-attribute"]

    /// Markdown prose-tag colors (text-view path: proseLabel, advisory bodies).
    /// Mirrors AppWindow.applyTagTheme so per-entry widgets match the old
    /// single-buffer transcript until the main agent migrates fully.
    static var proseForegrounds: [String: String] = [
        "user": "#F6C177",
        "assistant": "#E0DEF4",
        "md-h1": "#F6C177",
        "md-h2": "#F6C177",
        "md-h3": "#E0DEF4",
        "md-bold": "#F6C177",
        "md-italic": "#E0DEF4",
        "md-inline-code": "#9CCFD8",
        "md-list": "#E0DEF4",
        "md-quote": "#908CAA",
        "md-link": "#C4A7E7",
        "code-block": "#9CCFD8",
        "diff-add": "#9CCFD8",
        "diff-remove": "#EB6F92",
    ]

    static var proseBackgrounds: [String: String] = [
        "md-inline-code": "rgba(156,207,216,0.12)",
        "code-block": "#2A273F",
        "diff-add": "rgba(49,116,143,0.35)",
        "diff-remove": "rgba(235,111,146,0.18)",
    ]

    /// Pango-markup opens for the user bubble's label (inline markdown only —
    /// no block layout in a chat bubble). "" renders plain.
    private static let bubbleTagMarkup: [String: String] = [
        "user": "span foreground=\"#F6C177\"",
        "md-h1": "span foreground=\"#F6C177\" weight=\"700\"",
        "md-h2": "span foreground=\"#F6C177\" weight=\"700\"",
        "md-h3": "span foreground=\"#F6C177\" weight=\"600\"",
        "md-bold": "span foreground=\"#F6C177\" weight=\"700\"",
        "md-italic": "i",
        "md-inline-code": "span foreground=\"#9CCFD8\" font_family=\"JetBrains Mono\"",
        "md-link": "span foreground=\"#C4A7E7\" underline=\"single\"",
        "md-list": "span",
        "md-quote": "span foreground=\"#908CAA\" font_style=\"italic\"",
        "code-block": "span foreground=\"#9CCFD8\" font_family=\"JetBrains Mono\"",
        "diff-add": "span foreground=\"#9CCFD8\"",
        "diff-remove": "span foreground=\"#EB6F92\"",
        "assistant": "",
    ]

    /// One theme's tag colors. `applyTheme(dark:)` swaps between Moon and Dawn
    /// (mirroring theme-moon.css / theme-dawn.css and AppWindow's own
    /// applyTagTheme, so per-entry widgets and the old single-buffer transcript
    /// agree). Only colors change; weights/sizes/styles are theme-independent.
    private struct ThemePalette {
        let syntaxForegrounds: [String: String]
        let syntaxBackgrounds: [String: String]
        let proseForegrounds: [String: String]
        let proseBackgrounds: [String: String]

        static let dark = ThemePalette(
            syntaxForegrounds: [
                "syn-keyword": "#C4A7E7", "syn-string": "#9CCFD8", "syn-comment": "#6E6A86",
                "syn-number": "#F6C177", "syn-type": "#3E8FB0", "syn-function": "#EBBCBA",
                "syn-attribute": "#C4A7E7", "syn-plain": "#E0DEF4",
                "diff-add": "#9CCFD8", "diff-remove": "#EB6F92",
            ],
            syntaxBackgrounds: [
                "diff-add": "rgba(49,116,143,0.35)", "diff-remove": "rgba(235,111,146,0.18)",
            ],
            proseForegrounds: [
                "user": "#F6C177", "assistant": "#E0DEF4", "md-h1": "#F6C177", "md-h2": "#F6C177",
                "md-h3": "#E0DEF4", "md-bold": "#F6C177", "md-italic": "#E0DEF4",
                "md-inline-code": "#9CCFD8", "md-list": "#E0DEF4", "md-quote": "#908CAA",
                "md-link": "#C4A7E7", "code-block": "#9CCFD8", "diff-add": "#9CCFD8",
                "diff-remove": "#EB6F92",
            ],
            proseBackgrounds: [
                "md-inline-code": "rgba(156,207,216,0.12)", "code-block": "#2A273F",
                "diff-add": "rgba(49,116,143,0.35)", "diff-remove": "rgba(235,111,146,0.18)",
            ]
        )

        static let light = ThemePalette(
            syntaxForegrounds: [
                "syn-keyword": "#907AA9", "syn-string": "#56949F", "syn-comment": "#9893A5",
                "syn-number": "#EA9D34", "syn-type": "#286983", "syn-function": "#D7827E",
                "syn-attribute": "#907AA9", "syn-plain": "#575279",
                "diff-add": "#56949F", "diff-remove": "#B4637A",
            ],
            syntaxBackgrounds: [
                "diff-add": "rgba(86,148,159,0.22)", "diff-remove": "rgba(180,99,122,0.16)",
            ],
            proseForegrounds: [
                "user": "#EA9D34", "assistant": "#575279", "md-h1": "#EA9D34", "md-h2": "#EA9D34",
                "md-h3": "#575279", "md-bold": "#EA9D34", "md-italic": "#575279",
                "md-inline-code": "#286983", "md-list": "#575279", "md-quote": "#6E6A8A",
                "md-link": "#907AA9", "code-block": "#286983", "diff-add": "#286983",
                "diff-remove": "#B4637A",
            ],
            proseBackgrounds: [
                "md-inline-code": "rgba(86,148,159,0.16)", "code-block": "#F2E9E1",
                "diff-add": "rgba(86,148,159,0.22)", "diff-remove": "rgba(180,99,122,0.16)",
            ]
        )
    }

    /// Tags registered on each prose text-view buffer (created per buffer —
    /// GtkTextTags belong to their buffer).
    private static let proseTagNames = [
        "user", "assistant", "md-h1", "md-h2", "md-h3", "md-bold", "md-italic",
        "md-inline-code", "md-list", "md-quote", "md-link", "code-block",
        "diff-add", "diff-remove",
    ]

    /// All tags this factory created, so `applyTheme` can re-tint them. Tags
    /// are dropped (via a GObject weak ref) the moment their buffer frees
    /// them, so a cleared transcript can never leave a dangling pointer behind.
    private var liveSyntaxTags: [(name: String, tag: UnsafeMutablePointer<GtkTextTag>)] = []
    private var liveProseTags: [(name: String, tag: UnsafeMutablePointer<GtkTextTag>)] = []
    private var proseTags: [String: UnsafeMutablePointer<GtkTextTag>] = [:]

    /// Opaque self reference for the tag weak-notify userData. Retained once
    /// and never released (bounded, one factory per app) so a notify that
    /// fires after AppWindow releases the factory can never dereference freed
    /// memory — same tradeoff GtkSupport.onSignal documents for its boxes.
    private lazy var tagTrackerHandle: UnsafeMutableRawPointer = Unmanaged.passRetained(self).toOpaque()

    // MARK: - Entry dispatch

    /// Build the widget tree for one transcript entry.
    ///
    /// - `.message` + role "user" → `userBubble` (pending: false — the store
    ///   has no per-entry pending flag; optimistic dimming is caller's choice).
    /// - `.message` (assistant/other) → vertical box of `proseLabel` /
    ///   `codeBlock` / `advisoryCard` per markdown block.
    /// - tool / turn-review / compaction / unknown → `toolCard`.
    func buildEntry(_ entry: TranscriptEntry) -> UnsafeMutablePointer<GtkWidget>? {
        switch entry.kind {
        case .message:
            let text = entry.body.isEmpty ? entry.headline : entry.body
            if entry.role == "user" {
                return userBubble(text: text, pending: false)
            }
            return assistantBlocks(text)
        default:
            return toolCard(head: entry.headline, meta: entry.body, kind: entry.kind?.rawValue ?? "unknown")
        }
    }

    private func assistantBlocks(_ text: String) -> UnsafeMutablePointer<GtkWidget>? {
        let column = shim_box_new(0, 9)
        for block in markdownBlocks(text) {
            let widget: UnsafeMutablePointer<GtkWidget>?
            switch block {
            case .prose(let p):
                if p.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
                widget = proseLabel(text: p)
            case .code(let lang, let body):
                widget = codeBlock(lang: lang, code: body)
            case .advisory(let severity, let guidance, let body):
                widget = advisoryCard(severity: severity, guidance: guidance, body: body)
            }
            if let widget { shim_box_append(column, widget) }
        }
        return column
    }

    // MARK: - Widget builders

    /// Right-aligned glass bubble for user messages. The bubble card hugs the
    /// right edge (halign END inside a full-width row) and the prose renders
    /// markdown-lite into a wrapping, selectable label capped at 48 chars, so
    /// the bubble stays content-sized. `pending` dims the whole card to 50%.
    func userBubble(text: String, pending: Bool) -> UnsafeMutablePointer<GtkWidget>? {
        let row = shim_box_new(1, 0)          // full-width rail for right alignment
        shim_widget_expand(row, 1)
        let bubble = shim_box_new(0, 0)
        addClass(bubble, "user-bubble")
        shim_widget_halign_end(bubble)
        if pending { shim_widget_opacity(bubble, 0.5) }
        if let label = bubbleLabel(text) {
            shim_box_append(bubble, label)
        }
        shim_box_append(row, bubble)
        return row
    }

    /// Agent prose: markdown-lite text view — selectable (non-editable text
    /// views still select), wrapping at the column width, serif via the
    /// "assistant-message" CSS class.
    func proseLabel(text: String) -> UnsafeMutablePointer<GtkWidget>? {
        markdownTextView(text, cssClass: "assistant-message")
    }

    /// Fenced code block: header row (uppercase language + COPY button that
    /// writes the code to the clipboard), a divider, then a horizontally
    /// scrolled monospace text view whose buffer holds the syntax-highlighted
    /// tokens (tags named by token.tag, colored from `syntaxForegrounds`).
    func codeBlock(lang: String, code: String) -> UnsafeMutablePointer<GtkWidget>? {
        let card = shim_box_new(0, 0)
        addClass(card, "code-block")

        // Header: language label + spacer + copy button.
        let header = shim_box_new(1, 8)
        let langName = lang.trimmingCharacters(in: .whitespaces)
        let langLabel = makeLabel(langName.isEmpty ? "code" : langName.uppercased(), "code-header")
        shim_widget_halign_start(langLabel)
        shim_box_append(header, langLabel)
        let spacer = shim_box_new(1, 0)
        shim_widget_expand(spacer, 1)
        shim_box_append(header, spacer)
        let copy = shim_button("COPY")
        addClass(copy, "code-copy")
        let payload = code
        onSignal(copy, "clicked") { shim_clipboard_set_text(payload) }
        shim_box_append(header, copy)
        shim_box_append(card, header)

        // Divider between header and body.
        if let separator = shim_separator(1) {
            shim_box_append(card, separator)
        }

        // Horizontal-only scroller: the card is capped at the column width and
        // long lines scroll inside the block; the block grows vertically into
        // the transcript's outer scroll.
        let scroll = shim_scrolled_window()
        shim_scrolled_policy(scroll, GTK_POLICY_AUTOMATIC, GTK_POLICY_NEVER)
        let tv = shim_text_view()
        shim_text_view_nowrap(tv)
        if let buf = shim_text_buffer(tv) {
            fillCodeBuffer(buf, code: code, language: lang)
        }
        shim_scrolled_set_child(scroll, tv)
        shim_box_append(card, scroll)
        return card
    }

    /// Kind-colored card for tool / turn rows: "tool-card" (surface + colored
    /// left rail via CSS) plus a per-kind class (`tool-tool-use`,
    /// `tool-tool-result`, `tool-thinking`, …) so the theme can tint the rail.
    /// Head is uppercased; the meta (tool output) wraps and is selectable.
    func toolCard(head: String, meta: String, kind: String) -> UnsafeMutablePointer<GtkWidget>? {
        let card = shim_box_new(1, 10)
        addClass(card, "tool-card")
        let kindClass = "tool-" + kind.lowercased().replacingOccurrences(of: " ", with: "-")
        addClass(card, kindClass)

        let content = shim_box_new(0, 3)
        let headLabel = makeLabel(head.uppercased(), "tool-head")
        shim_widget_halign_start(headLabel)
        shim_box_append(content, headLabel)
        if !meta.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let metaLabel = makeLabel(meta, "tool-meta")
            shim_label_wrap(metaLabel)
            shim_label_selectable(metaLabel)
            shim_widget_halign_start(metaLabel)
            shim_box_append(content, metaLabel)
        }
        shim_box_append(card, content)
        return card
    }

    /// Callout card for `<advisory>` blocks: "advisory-card" surface with the
    /// gold accent left border (CSS), an uppercased severity header (gold via
    /// "accent"; severity variants "advisory-info" / "advisory-error" re-tint
    /// the card), and the markdown-lite body.
    func advisoryCard(severity: String?, body: String) -> UnsafeMutablePointer<GtkWidget>? {
        advisoryCard(severity: severity, guidance: nil, body: body)
    }

    /// Full advisory card, with the optional guidance line (muted) above the
    /// body. The two-argument `advisoryCard(severity:body:)` delegates here.
    func advisoryCard(severity: String?, guidance: String?, body: String) -> UnsafeMutablePointer<GtkWidget>? {
        let card = shim_box_new(0, 5)
        addClass(card, "advisory-card")
        if let sev = severity?.lowercased(), !sev.isEmpty {
            if sev == "info" {
                addClass(card, "advisory-info")
            } else if sev == "error" || sev == "blocker" {
                addClass(card, "advisory-error")
            }
            // warning / concern / others keep the default gold callout.
        }
        let headerText = (severity?.isEmpty == false ? severity! : "advisory").uppercased()
        let header = makeLabel(headerText, "advisory-severity")
        addClass(header, "accent")
        shim_widget_halign_start(header)
        shim_box_append(card, header)
        if let guidance, !guidance.isEmpty {
            let guidanceLabel = makeLabel(guidance, "tool-meta")
            shim_label_wrap(guidanceLabel)
            shim_label_selectable(guidanceLabel)
            shim_widget_halign_start(guidanceLabel)
            shim_box_append(card, guidanceLabel)
        }
        if !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            if let bodyView = markdownTextView(body, cssClass: "assistant-message") {
                shim_box_append(card, bodyView)
            }
        }
        return card
    }

    // MARK: - Theme

    /// Re-tint every tag this factory created for the given theme. GTK text
    /// tags don't follow CSS, so AppWindow calls this on theme toggle (and
    /// once at startup). Colors update in place; new entries pick up the same
    /// palette from the static dictionaries.
    func applyTheme(dark: Bool) {
        let palette = dark ? Self.ThemePalette.dark : Self.ThemePalette.light
        Self.syntaxForegrounds = palette.syntaxForegrounds
        Self.syntaxBackgrounds = palette.syntaxBackgrounds
        Self.proseForegrounds = palette.proseForegrounds
        Self.proseBackgrounds = palette.proseBackgrounds

        for (name, tag) in liveSyntaxTags {
            if let fg = Self.syntaxForegrounds[name] { shim_tag_set_str(tag, "foreground", fg) }
            if let bg = Self.syntaxBackgrounds[name] { shim_tag_set_str(tag, "background", bg) }
        }
        for (name, tag) in liveProseTags {
            if let fg = Self.proseForegrounds[name] { shim_tag_set_str(tag, "foreground", fg) }
            if let bg = Self.proseBackgrounds[name] { shim_tag_set_str(tag, "background", bg) }
        }
    }

    /// Weak-ref trampoline: removes a dying tag from the tracking arrays so
    /// `applyTheme` never touches freed memory after a transcript clear. The
    /// factory instance outlives every tag it creates, so an unretained self
    /// is safe here.
    private static let tagGoneForwarder: ShimTagGoneHandler = { userData, goneObject in
        guard let userData else { return }
        let factory = Unmanaged<TranscriptWidgets>.fromOpaque(userData).takeUnretainedValue()
        guard let gone = goneObject else { return }
        factory.removeDeadTag(UnsafeMutableRawPointer(gone))
    }

    private func removeDeadTag(_ gone: UnsafeMutableRawPointer) {
        liveSyntaxTags.removeAll { UnsafeMutableRawPointer($0.tag) == gone }
        liveProseTags.removeAll { UnsafeMutableRawPointer($0.tag) == gone }
    }

    private func trackTag(_ name: String, _ tag: UnsafeMutablePointer<GtkTextTag>, syntax: Bool) {
        if syntax {
            liveSyntaxTags.append((name, tag))
        } else {
            liveProseTags.append((name, tag))
        }
        shim_tag_track_gone(tag, tagTrackerHandle, Self.tagGoneForwarder)
    }

    // MARK: - Shared prose rendering

    /// A wrapping, selectable text view filled with markdown-lite segments
    /// (shared by proseLabel and advisory bodies). Tags are registered on the
    /// buffer with the current `proseForegrounds`/`proseBackgrounds`.
    private func markdownTextView(_ text: String, cssClass: String) -> UnsafeMutablePointer<GtkWidget>? {
        let tv = shim_text_view()
        shim_text_view_setup(tv)               // non-editable, WORD_CHAR wrap
        addClass(tv, cssClass)
        if let buf = shim_text_buffer(tv) {
            registerProseTags(buf)
            for segment in renderTranscriptSegments(body: text, role: "assistant") {
                shim_text_append_tagged(buf, segment.text, proseTags[segment.tag])
            }
        }
        return tv
    }

    private func registerProseTags(_ buf: UnsafeMutablePointer<GtkTextBuffer>) {
        proseTags.removeAll(keepingCapacity: true)
        for name in Self.proseTagNames {
            if let tag = shim_tag_new(buf, name) {
                proseTags[name] = tag
                trackTag(name, tag, syntax: false)
            }
        }
        applyProseTheme()
    }

    private func applyProseTheme() {
        for (name, tag) in proseTags {
            if let fg = Self.proseForegrounds[name] { shim_tag_set_str(tag, "foreground", fg) }
            if let bg = Self.proseBackgrounds[name] { shim_tag_set_str(tag, "background", bg) }
        }
        setProseAttr("md-h1", weight: 700, size: 15)
        setProseAttr("md-h2", weight: 700, size: 13)
        setProseAttr("md-h3", weight: 600, size: 11.5)
        setProseAttr("md-bold", weight: 700)
        setProseAttr("md-italic", style: 2)      // PANGO_STYLE_ITALIC
        setProseAttr("md-quote", style: 2)
        setProseAttr("md-link", underline: 1)    // PANGO_UNDERLINE_SINGLE
        setProseAttr("user", weight: 600)
    }

    private func setProseAttr(
        _ name: String,
        weight: Int = 0,
        size: Double = 0,
        style: Int = 0,
        underline: Int = 0
    ) {
        guard let tag = proseTags[name] else { return }
        if weight > 0 { shim_tag_set_int(tag, "weight", Int32(weight)) }
        if size > 0 { shim_tag_set_double(tag, "size-points", size) }
        if style > 0 { shim_tag_set_int(tag, "style", Int32(style)) }
        if underline > 0 { shim_tag_set_int(tag, "underline", Int32(underline)) }
    }

    // MARK: - Code buffer

    /// Fill a code buffer from the highlighter's tokens. Tags are created on
    /// demand (one per token tag name) and colored from the static theme
    /// hooks; syn-plain is "uncolored" but still tagged so a uniform surface
    /// is available if the theme later gives it a background.
    private func fillCodeBuffer(
        _ buf: UnsafeMutablePointer<GtkTextBuffer>,
        code: String,
        language: String
    ) {
        var tagCache: [String: UnsafeMutablePointer<GtkTextTag>] = [:]
        for token in highlightCode(code, language: language) {
            if token.text.isEmpty { continue }
            let tag: UnsafeMutablePointer<GtkTextTag>?
            if let cached = tagCache[token.tag] {
                tag = cached
            } else if let created = shim_tag_new(buf, token.tag) {
                if let fg = Self.syntaxForegrounds[token.tag] { shim_tag_set_str(created, "foreground", fg) }
                if let bg = Self.syntaxBackgrounds[token.tag] { shim_tag_set_str(created, "background", bg) }
                if let weight = Self.syntaxWeights[token.tag] { shim_tag_set_int(created, "weight", Int32(weight)) }
                if Self.syntaxItalics.contains(token.tag) { shim_tag_set_int(created, "style", 2) }
                tagCache[token.tag] = created
                trackTag(token.tag, created, syntax: true)
                tag = created
            } else {
                tag = nil
            }
            shim_text_append_tagged(buf, token.text, tag)
        }
    }

    // MARK: - User bubble label (markdown-lite → Pango markup)

    /// Convert rendered markdown segments to a Pango-markup string for the
    /// bubble's label. Text is escaped; styled runs map through
    /// `bubbleTagMarkup`. Block-level tags (headings, fences) degrade to
    /// inline styling — chat bubbles are inline-only, per Enclave.
    private func bubbleLabel(_ text: String) -> UnsafeMutablePointer<GtkWidget>? {
        let label = shim_label("")
        shim_label_wrap(label)
        shim_label_max_width_chars(label, 48)
        shim_label_selectable(label)

        var markup = ""
        for segment in renderTranscriptSegments(body: text, role: "assistant") {
            guard !segment.text.isEmpty else { continue }
            let open = Self.bubbleTagMarkup[segment.tag] ?? ""
            if open.isEmpty {
                markup += escapeMarkup(segment.text)
            } else {
                let close = open.hasPrefix("span") ? "</span>" : "</\(open)>"
                markup += "<\(open)>\(escapeMarkup(segment.text))\(close)"
            }
        }
        shim_label_set_markup(label, markup)
        return label
    }

    private func escapeMarkup(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }
}

// MARK: - Markdown block model (port of Enclave's markdownBlocks)

/// One markdown block in an assistant message: prose, a fenced code block, or
/// an `<advisory>` callout (with severity / guidance attributes).
enum TranscriptBlock {
    case prose(String)
    case code(lang: String, body: String)
    case advisory(severity: String?, guidance: String?, body: String)
}

private func decodeEntities(_ s: String) -> String {
    s.replacingOccurrences(of: "&lt;", with: "<")
        .replacingOccurrences(of: "&gt;", with: ">")
        .replacingOccurrences(of: "&quot;", with: "\"")
        .replacingOccurrences(of: "&apos;", with: "'")
        .replacingOccurrences(of: "&amp;", with: "&")
}

private func advisoryAttrs(from opener: String) -> (severity: String?, guidance: String?) {
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

private func advisoryStart(in line: String) -> String.Index? {
    if let r = line.range(of: "<advisory") { return r.lowerBound }
    if let r = line.range(of: "&lt;advisory") { return r.lowerBound }
    return nil
}

private func advisoryTagEnd(in line: String, after start: String.Index) -> String.Index? {
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

private func advisoryCloserRange(in line: String) -> Range<String.Index>? {
    line.range(of: "</advisory>") ?? line.range(of: "&lt;/advisory&gt;")
}

/// Split agent text into prose runs, fenced ``` code blocks, and <advisory>
/// callouts. Tolerant of entity-escaped tags and inline placement; tolerant of
/// an unclosed fence or advisory (still streaming): everything after the
/// opener renders as that block type. (Port of Enclave's markdownBlocks.)
private func markdownBlocks(_ s: String) -> [TranscriptBlock] {
    var out: [TranscriptBlock] = []
    var prose: [String] = []
    let lines = s.components(separatedBy: "\n")
    var i = 0
    func flush() {
        if !prose.isEmpty {
            out.append(.prose(prose.joined(separator: "\n")))
            prose = []
        }
    }
    while i < lines.count {
        let trimmed = lines[i].trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("```") {
            flush()
            let lang = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            var body: [String] = []
            i += 1
            while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                body.append(lines[i])
                i += 1
            }
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
                while i < lines.count, advisoryCloserRange(in: lines[i]) == nil {
                    body.append(lines[i])
                    i += 1
                }
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
        } else {
            prose.append(lines[i])
            i += 1
        }
    }
    flush()
    return out
}
