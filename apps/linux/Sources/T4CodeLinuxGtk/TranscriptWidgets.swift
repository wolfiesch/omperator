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
/// Tool, code, and advisory cards are collapsible (`collapsibleCard`): they
/// start collapsed to a single header row (chevron + title) and expand on
/// click; user bubbles and prose blocks stay fully expanded.
///
/// Prose renders as GtkLabels (Pango markup), not text views: a wrapped
/// GtkTextView measured inside a vertical box reports its height wrapped at a
/// ~1-char width (GTK measures with for_size=-1 and uses the last layout's
/// height), so every prose block would balloon to thousands of pixels. Labels
/// compute wrap height correctly; `max-width-chars` caps the natural width so
/// the block never overflows the column. Wrap mode is GTK_WRAP_WORD (see
/// `shim_label_wrap_words`): GTK 4.22 measures WORD_CHAR-wrapped labels'
/// one-line width as both min and natural, which pinned the transcript column
/// to the widest paragraph and stopped re-wrap on rail/sidebar toggles.
/// Code blocks keep the text-view + per-token-tag path (nowrap natural height
/// is content-accurate), and the copy button writes the raw code to the
/// clipboard.
///
/// Entry dispatch: AppWindow calls `buildEntry` once per transcript entry and
/// parents the returned widget; the scroll pin / store wiring live elsewhere.

@MainActor
final class TranscriptWidgets {

    // MARK: - Theme hooks

    /// Syntax token colors by tag name. `applyTheme` swaps these between the
    /// Moon and Dawn palettes and re-tints every live code tag.
    static var syntaxForegrounds: [String: String] = ThemePalette.dark.syntaxForegrounds
    static var syntaxBackgrounds: [String: String] = ThemePalette.dark.syntaxBackgrounds

    /// Extra Pango attributes per syntax tag: weight (Pango weight) / italics.
    static var syntaxWeights: [String: Int] = ["syn-keyword": 600]
    static var syntaxItalics: Set<String> = ["syn-comment", "syn-attribute"]

    /// One theme's prose/markup colors. `applyTheme(dark:)` swaps between Moon
    /// and Dawn (mirroring theme-moon.css / theme-dawn.css and AppWindow's own
    /// applyTagTheme). Only colors change; weights/sizes/styles are
    /// theme-independent.
    private struct ThemePalette {        let syntaxForegrounds: [String: String]
        let syntaxBackgrounds: [String: String]
        let proseForegrounds: [String: String]
        let proseBackgrounds: [String: String]

        /// Accent colors used by the Pango-markup prose labels. Only these
        /// change with the theme; body text inherits its color from the CSS
        /// surface (bubble/card), so plain runs stay theme-correct for free.
        var gold: String { proseForegrounds["user"] ?? "#F6C177" }
        var text: String { proseForegrounds["assistant"] ?? "#E0DEF4" }
        var codeFg: String { proseForegrounds["md-inline-code"] ?? "#9CCFD8" }
        var link: String { proseForegrounds["md-link"] ?? "#C4A7E7" }
        var quote: String { proseForegrounds["md-quote"] ?? "#908CAA" }
        var add: String { proseForegrounds["diff-add"] ?? "#9CCFD8" }
        var remove: String { proseForegrounds["diff-remove"] ?? "#EB6F92" }

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

    /// All code tags this factory created, so `applyTheme` can re-tint them.
    /// Tags are dropped (via a GObject weak ref) the moment their buffer frees
    /// them, so a cleared transcript can never leave a dangling pointer behind.
    private var liveSyntaxTags: [(name: String, tag: UnsafeMutablePointer<GtkTextTag>)] = []

    /// The palette applied to newly built widgets (also used by `proseMarkup`
    /// to color label spans). Updated by `applyTheme`.
    private static var currentPalette: ThemePalette = .dark

    /// Prose/bubble labels, kept so `applyTheme` can re-render their markup
    /// with the current palette's accent colors.
    private var liveLabels: [(label: UnsafeMutablePointer<GtkWidget>, text: String, bubble: Bool)] = []

    /// Opaque self reference for the tag weak-notify userData. Retained once
    /// and never released (bounded, one factory per app) so a notify that
    /// fires after AppWindow releases the factory can never dereference freed
    /// memory — same tradeoff GtkSupport.onSignal documents for its boxes.
    private lazy var tagTrackerHandle: UnsafeMutableRawPointer = Unmanaged.passRetained(self).toOpaque()

    // MARK: - Entry dispatch

    /// Build the widget tree for one transcript entry.
    ///
    /// - `.message` + role "user" → `userBubble` (pending: false — the store
    ///   has no per-entry pending flag; optimistic dimming is the caller's
    ///   choice).
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
        // GtkBox packs children left→right; a hexpand spacer before the bubble
        // is what actually pushes it to the right edge.
        shim_box_append(row, shim_spacer())
        let bubble = shim_box_new(0, 0)
        addClass(bubble, "user-bubble")
        if pending { shim_widget_opacity(bubble, 0.5) }
        if let label = proseLabelWidget(text, cssClass: "", maxChars: 48, bubble: true) {
            shim_box_append(bubble, label)
        }
        shim_box_append(row, bubble)
        return row
    }

    /// Agent prose: markdown-lite, selectable, wrapping label capped at 110
    /// chars (content-sized; the serif font comes from the "assistant-message"
    /// CSS class).
    func proseLabel(text: String) -> UnsafeMutablePointer<GtkWidget>? {
        proseLabelWidget(text, cssClass: "assistant-message", maxChars: 110, bubble: false)
    }

    // MARK: - Collapsible cards

    /// Wrap a card body under a single-row header that starts COLLAPSED and
    /// expands on click. The header is a chevron (▸ collapsed / ▾ expanded)
    /// plus the card title; `extras` (e.g. a code block's COPY button) are
    /// appended to the row right of the clickable title area, so they stay
    /// clickable without toggling the card. The body stays hidden (via
    /// shim_widget_hide) until the title area is pressed (onPressed gesture),
    /// then toggles between shown/hidden. User bubbles and prose never route
    /// through here — only tool/code/advisory cards collapse.
    ///
    /// State is reflected in three CSS hooks for the theme:
    /// - `.card-header` on the header row (the compact one-line strip),
    /// - `.card-chevron` on the chevron glyph,
    /// - `.collapsed` / `.expanded` on the card itself, so the theme can
    ///   tighten the card's padding while collapsed.
    private func collapsibleCard(
        title: String,
        titleClasses: [String],
        body: UnsafeMutablePointer<GtkWidget>?,
        extras: ((UnsafeMutablePointer<GtkWidget>) -> Void)? = nil
    ) -> UnsafeMutablePointer<GtkWidget> {
        let card = shim_box_new(0, 0)
        addClass(card, "collapsed")

        let header = shim_box_new(1, 8)
        addClass(header, "card-header")

        // Clickable title area: chevron + title, hexpanded so the whole row
        // (up to any extras like COPY) is a press target.
        let clickable = shim_box_new(1, 6)
        shim_widget_expand(clickable, 1)
        let chevron = makeLabel("▸", "card-chevron")
        if let chevron { shim_box_append(clickable, chevron) }
        if let titleLabel = makeLabel(title) {
            for cls in titleClasses { addClass(titleLabel, cls) }
            shim_widget_halign_start(titleLabel)
            shim_box_append(clickable, titleLabel)
        }
        shim_box_append(header, clickable)
        extras?(header!)
        shim_box_append(card, header)

        if let body {
            shim_box_append(card, body)
            shim_widget_hide(body)   // cards start collapsed
            var expanded = false
            onPressed(clickable) {
                expanded.toggle()
                if expanded {
                    shim_css_class_remove(card, "collapsed")
                    addClass(card, "expanded")
                } else {
                    shim_css_class_remove(card, "expanded")
                    addClass(card, "collapsed")
                }
                if let chevron { shim_label_set_text(chevron, expanded ? "▾" : "▸") }
                if expanded { shim_widget_show(body) } else { shim_widget_hide(body) }
            }
        }
        return card!
    }

    /// Fenced code block: header row (uppercase language + COPY button that
    /// writes the code to the clipboard), a divider, then a horizontally
    /// scrolled monospace text view whose buffer holds the syntax-highlighted
    /// tokens (tags named by token.tag, colored from `syntaxForegrounds`).
    /// Starts collapsed to the header; clicking the language area expands the
    /// divider + code body.
    func codeBlock(lang: String, code: String) -> UnsafeMutablePointer<GtkWidget>? {
        let langName = lang.trimmingCharacters(in: .whitespaces)

        // Body: divider + horizontal-only scroller (collapsed until clicked).
        // The card is capped at the column width and long lines scroll inside
        // the block; the block grows vertically into the transcript's outer
        // scroll.
        let body = shim_box_new(0, 0)
        if let separator = shim_separator(1) {
            shim_box_append(body, separator)
        }
        let scroll = shim_scrolled_window()
        shim_scrolled_policy(scroll, GTK_POLICY_AUTOMATIC, GTK_POLICY_NEVER)
        let tv = shim_text_view()
        shim_text_view_nowrap(tv)
        if let buf = shim_text_buffer(tv) {
            fillCodeBuffer(buf, code: code, language: lang)
        }
        shim_scrolled_set_child(scroll, tv)
        shim_box_append(body, scroll)

        let card = collapsibleCard(
            title: langName.isEmpty ? "code" : langName.uppercased(),
            titleClasses: ["code-header"],
            body: body
        ) { header in
            let copy = shim_button("COPY")
            addClass(copy, "code-copy")
            let payload = code
            onSignal(copy, "clicked") { shim_clipboard_set_text(payload) }
            shim_box_append(header, copy)
        }
        addClass(card, "code-block")
        return card
    }

    /// Kind-colored card for tool / turn rows: "tool-card" (surface + colored
    /// left rail via CSS) plus a per-kind class (`tool-tool-use`,
    /// `tool-tool-result`, `tool-thinking`, …) so the theme can tint the rail.
    /// Head is uppercased; the meta (tool output) wraps and is selectable.
    /// Starts collapsed to the head row; clicking it expands the meta body.
    func toolCard(head: String, meta: String, kind: String) -> UnsafeMutablePointer<GtkWidget>? {
        let metaText = meta.trimmingCharacters(in: .whitespacesAndNewlines)
        var body: UnsafeMutablePointer<GtkWidget>?
        if !metaText.isEmpty {
            let bodyBox = shim_box_new(0, 3)
            shim_box_append(bodyBox, metaLabelWidget(meta))
            body = bodyBox
        }
        let card = collapsibleCard(
            title: head.uppercased(),
            titleClasses: ["tool-head"],
            body: body
        )
        addClass(card, "tool-card")
        let kindClass = "tool-" + kind.lowercased().replacingOccurrences(of: " ", with: "-")
        addClass(card, kindClass)
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
    /// Starts collapsed to the severity row; clicking it expands the guidance
    /// + body.
    func advisoryCard(severity: String?, guidance: String?, body: String) -> UnsafeMutablePointer<GtkWidget>? {
        let hasGuidance = guidance?.isEmpty == false
        let hasBody = !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        var bodyBox: UnsafeMutablePointer<GtkWidget>?
        if hasGuidance || hasBody {
            let box = shim_box_new(0, 5)
            if hasGuidance, let guidance {
                shim_box_append(box, metaLabelWidget(guidance))
            }
            if hasBody, let bodyLabel = proseLabelWidget(body, cssClass: "assistant-message", maxChars: 110, bubble: false) {
                shim_box_append(box, bodyLabel)
            }
            bodyBox = box
        }
        let headerText = (severity?.isEmpty == false ? severity! : "advisory").uppercased()
        let card = collapsibleCard(
            title: headerText,
            titleClasses: ["advisory-severity", "accent"],
            body: bodyBox
        )
        addClass(card, "advisory-card")
        if let sev = severity?.lowercased(), !sev.isEmpty {
            if sev == "info" {
                addClass(card, "advisory-info")
            } else if sev == "error" || sev == "blocker" {
                addClass(card, "advisory-error")
            }
            // warning / concern / others keep the default gold callout.
        }
        return card
    }

    // MARK: - Theme

    /// Re-tint every tag and re-render every label this factory created for
    /// the given theme. GTK text tags don't follow CSS, so AppWindow calls
    /// this on theme toggle (and once at startup). Colors update in place;
    /// new entries pick up the same palette from the static dictionaries.
    func applyTheme(dark: Bool) {
        let palette = dark ? ThemePalette.dark : ThemePalette.light
        Self.currentPalette = palette
        Self.syntaxForegrounds = palette.syntaxForegrounds
        Self.syntaxBackgrounds = palette.syntaxBackgrounds

        for (name, tag) in liveSyntaxTags {
            if let fg = Self.syntaxForegrounds[name] { shim_tag_set_str(tag, "foreground", fg) }
            if let bg = Self.syntaxBackgrounds[name] { shim_tag_set_str(tag, "background", bg) }
        }
        for entry in liveLabels {
            shim_label_set_markup(entry.label, proseMarkup(entry.text, bubble: entry.bubble))
        }
    }

    // MARK: - Prose labels (Pango markup)

    /// Build a markdown-lite prose label. `maxChars` caps the natural width so
    /// the block never overflows the column; short text keeps the label
    /// content-sized. `bubble` selects the compact inline-only styling.
    private func proseLabelWidget(
        _ text: String,
        cssClass: String,
        maxChars: Int,
        bubble: Bool
    ) -> UnsafeMutablePointer<GtkWidget>? {
        let label = shim_label("")
        if !cssClass.isEmpty { addClass(label, cssClass) }
        // GTK_WRAP_WORD, not WORD_CHAR: GTK 4.22 measures a WORD_CHAR-wrapped
        // label's one-line width as both min and natural, so it never re-wraps
        // when the column resizes (right edge cut off). WORD wraps to any width.
        shim_label_wrap_words(label)
        shim_label_selectable(label)
        shim_label_max_width_chars(label, Int32(maxChars))
        shim_widget_halign_start(label)
        shim_label_set_markup(label, proseMarkup(text, bubble: bubble))
        if let label { liveLabels.append((label, text, bubble)) }
        return label
    }

    /// Muted, wrapping, selectable meta/guidance label (tool output, advisory
    /// guidance) capped at 110 chars.
    private func metaLabelWidget(_ text: String) -> UnsafeMutablePointer<GtkWidget>? {
        let label = makeLabel(text, "tool-meta")
        shim_label_wrap_words(label)
        shim_label_selectable(label)
        shim_label_max_width_chars(label, 110)
        shim_widget_halign_start(label)
        return label
    }

    /// Convert rendered markdown segments to a Pango-markup string. Text is
    /// escaped; styled runs map through the theme palette. Block-level tags
    /// (headings, fences) degrade to inline styling — chat bubbles and prose
    /// blocks are inline-only, per Enclave.
    private func proseMarkup(_ text: String, bubble: Bool) -> String {
        let palette = Self.currentPalette
        let gold = palette.gold
        let code = palette.codeFg
        let link = palette.link
        let quote = palette.quote
        let add = palette.add
        let remove = palette.remove

        var markup = ""
        for segment in renderTranscriptSegments(body: text, role: "assistant") {
            guard !segment.text.isEmpty else { continue }
            let open: String
            switch segment.tag {
            case "md-h1":
                open = bubble ? "span foreground=\"\(gold)\" weight=\"700\"" : "span size=\"15360\" weight=\"700\" foreground=\"\(gold)\""
            case "md-h2":
                open = bubble ? "span foreground=\"\(gold)\" weight=\"700\"" : "span size=\"13312\" weight=\"700\" foreground=\"\(gold)\""
            case "md-h3":
                open = "span weight=\"600\" foreground=\"\(gold)\""
            case "md-bold":
                open = "span foreground=\"\(gold)\" weight=\"700\""
            case "md-italic":
                open = "i"
            case "md-inline-code", "code-block":
                open = "span font_family=\"JetBrains Mono\" foreground=\"\(code)\""
            case "md-link":
                open = "span foreground=\"\(link)\" underline=\"single\""
            case "md-list":
                open = "span"
            case "md-quote":
                open = "span foreground=\"\(quote)\" font_style=\"italic\""
            case "diff-add":
                open = "span foreground=\"\(add)\""
            case "diff-remove":
                open = "span foreground=\"\(remove)\""
            case "user":
                open = "span foreground=\"\(gold)\" weight=\"600\""
            default:
                open = ""   // assistant / plain
            }
            if open.isEmpty {
                markup += escapeMarkup(segment.text)
            } else {
                let close = open.hasPrefix("span") ? "</span>" : "</\(open)>"
                markup += "<\(open)>\(escapeMarkup(segment.text))\(close)"
            }
        }
        return markup
    }

    private func escapeMarkup(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
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
                trackTag(token.tag, created)
                tag = created
            } else {
                tag = nil
            }
            shim_text_append_tagged(buf, token.text, tag)
        }
    }

    // MARK: - Tag tracking

    private func trackTag(_ name: String, _ tag: UnsafeMutablePointer<GtkTextTag>) {
        liveSyntaxTags.append((name, tag))
        shim_tag_track_gone(tag, tagTrackerHandle, Self.tagGoneForwarder)
    }

    /// Weak-ref trampoline: removes a dying tag from the tracking array so
    /// `applyTheme` never touches freed memory after a transcript clear. The
    /// factory instance outlives every tag it creates (retained once in
    /// `tagTrackerHandle`), so an unretained self here is safe.
    private static let tagGoneForwarder: ShimTagGoneHandler = { userData, goneObject in
        guard let userData else { return }
        let factory = Unmanaged<TranscriptWidgets>.fromOpaque(userData).takeUnretainedValue()
        guard let gone = goneObject else { return }
        factory.removeDeadTag(UnsafeMutableRawPointer(gone))
    }

    private func removeDeadTag(_ gone: UnsafeMutableRawPointer) {
        liveSyntaxTags.removeAll { UnsafeMutableRawPointer($0.tag) == gone }
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
