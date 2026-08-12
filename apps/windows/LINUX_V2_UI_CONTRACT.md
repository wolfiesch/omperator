# Linux v2 code-derived UI contract

## Authority and scope

This contract is derived from Linux commit `d4fb75ff3cf24dbd4981948dc4c2d1a685c9b887`. It records the native GTK code as written; values marked **intrinsic** are deliberately not estimated. GTK files are design evidence only and must not compile into the Windows target.

Primary sources:

- `apps/linux/Sources/T4CodeLinuxGtk/AppWindow.swift`
- `apps/linux/Sources/T4CodeLinuxGtk/TranscriptWidgets.swift`
- `apps/linux/Sources/T4CodeLinuxGtk/MarkdownRenderer.swift`
- `apps/linux/Sources/T4CodeLinuxGtk/PanesFactory.swift`
- `apps/linux/Sources/T4CodeLinuxGtk/SyntaxHighlighter.swift`
- `apps/linux/Sources/T4CodeLinuxGtk/CompositorPin.swift`
- `apps/linux/Sources/T4CodeLinuxGtk/GtkSupport.swift`
- `apps/linux/Sources/T4CodeLinuxGtk/main.swift`
- `apps/linux/Sources/CT4Gtk/shim.h`
- `apps/linux/Sources/T4CodeLinuxLib/Store/T4GtkBridge.swift`
- `spike-gtk-linux/theme-moon.css`
- `spike-gtk-linux/theme-dawn.css`

## Coordinate and layout rules

- `shim_box_new(1, spacing)` is horizontal; `shim_box_new(0, spacing)` is vertical.
- GTK CSS `px` values and `gtk_widget_set_size_request` values map to WinUI effective pixels.
- GTK `pt` values remain points; Pango markup sizes are in 1/1024 point units.
- All current GTK radii are exactly `0`.
- There are no automatic CSS or window-width breakpoints in the pinned code. Compact mode is an explicit state transition, not a responsive breakpoint.
- The GTK source does not specify minimum or maximum normal-window dimensions. Unspecified control widths/heights are intrinsic.
- The only automatic transcript width bounds are Pango `max-width-chars`: 48 characters for user bubbles and 110 for assistant/tool text.

## Theme primitives

| Primitive | Moon (dark) | Dawn (light) | Use |
| --- | --- | --- | --- |
| Window background | `#232136` | `#FAF4ED` | Root, transparent rail/center/sidebar base |
| Primary foreground | `#E0DEF4` | `#575279` | Inherited body text |
| Strong title | `#FFFFFF` | `#403C58` | Top-bar and login titles |
| Hairline | `#393552` | `#DFDAD9` | Rail, top-bar, sidebar, bubble/code borders |
| Muted | `#6E6A86` | `#797593` | Relative time, code headers, glyphs |
| Subtle | `#908CAA` | `#6E6A8A` | Rail title, login subtitle |
| Gold accent | `#F6C177` | `#EA9D34` | Send/login action and emphasis |
| Cyan/code | `#9CCFD8` | `#286983` | Code and tool accents |
| Purple/link | `#C4A7E7` | `#907AA9` | Links and keywords |
| Error | `#EB6F92` | `#B4637A` | Login/advisory/diff error |
| Code surface | `#2A273F` | `#F2E9E1` | Code card |
| Tool surface | `#2A273F` | `#FFFAF3` | Tool cards and settings/login card |
| Overlay | `rgba(35,33,54,0.93)` | `rgba(250,244,237,0.93)` | Onboarding backdrop |
| UI font | `Fira Sans`, `Helvetica Neue`, sans-serif | Same | Window, rail, user, composer, login |
| Prose font | `New York`, `Charter`, Georgia, serif | Same | Assistant message |
| Mono font | `JetBrains Mono`, `Cascadia Code`, monospace | Same | Code and inline code |

### Syntax palette

| Token | Moon | Dawn | Weight/style |
| --- | --- | --- | --- |
| `syn-keyword` | `#C4A7E7` | `#907AA9` | 600 |
| `syn-string` | `#9CCFD8` | `#56949F` | 400 |
| `syn-comment` | `#6E6A86` | `#9893A5` | italic |
| `syn-number` | `#F6C177` | `#EA9D34` | 400 |
| `syn-type` | `#3E8FB0` | `#286983` | 400 |
| `syn-function` | `#EBBCBA` | `#D7827E` | 400 |
| `syn-attribute` | `#C4A7E7` | `#907AA9` | italic |
| `syn-plain` | `#E0DEF4` | `#575279` | 400 |
| `diff-add` | `#9CCFD8` on `rgba(49,116,143,0.35)` | `#56949F` on `rgba(86,148,159,0.22)` | Whole line |
| `diff-remove` | `#EB6F92` on `rgba(235,111,146,0.18)` | `#B4637A` on `rgba(180,99,122,0.16)` | Whole line |

Supported aliases are exact: Swift; JavaScript/TypeScript/JSX/TSX; Python; Bash/sh/shell/zsh/fish; JSON/JSON5; Rust; Go; CSS/SCSS/Less; HTML/XML/SVG/Vue/Svelte; C/C++/Objective-C aliases; YAML/YML/TOML; Markdown/MD/MDX; diff/patch; and a generic comment/string/number fallback. Unified-diff detection overrides a declared language.

## Visible surface contract

### Root window

- **GTK source/function:** `AppWindow.build(_:)`; `main.swift` activation; `shim_window`.
- **Widget hierarchy:** `GtkApplicationWindow` → `GtkOverlay` → horizontal workspace; workspace children are session rail, flexible center column, and browser sidebar. Onboarding backdrop/card are overlay children.
- **Orientation/nesting:** Workspace horizontal, spacing `0`; center vertical, spacing `0`.
- **Fixed dimensions:** Normal default `1180 × 760`; compact default `440 × 560`.
- **Flexible dimensions:** Center is horizontally expanding; transcript scroll is vertically expanding.
- **Margins:** `0` at root.
- **Padding:** `0` at root.
- **Spacing:** Workspace and center `0`.
- **Font:** Fira Sans stack, `11pt`, inherited weight 400.
- **Foreground/background:** Moon `#E0DEF4` on `#232136`; Dawn `#575279` on `#FAF4ED`.
- **Border/radius:** Root none; radius `0` throughout GTK theme.
- **Alignment:** Native window placement; no custom initial floating/TV placement.
- **Visibility:** Presented after building all hidden/visible children.
- **Enabled state:** Window enabled.
- **State transition:** Explicit theme and compact transitions only; no automatic width breakpoint.
- **Windows counterpart:** Native WinUI window hosting Windows-owned shell.
- **Windows status:** Implemented by `T4WindowsRootView`, `T4WorkspaceView`, and the native WinUI executable.

### Onboarding overlay

- **GTK source/function:** `AppWindow.buildOnboarding`, `refreshOnboarding`.
- **Widget hierarchy:** Full-fill vertical `onboarding` backdrop and separate centered vertical `login-card`, both direct `GtkOverlay` children.
- **Orientation/nesting:** Backdrop vertical spacing `0`; card vertical spacing `12`.
- **Fixed dimensions:** Card width request `340`; height intrinsic.
- **Flexible dimensions:** Backdrop expands and fills both axes.
- **Margins/padding/spacing:** Backdrop has no margin/padding; card padding `28px 32px`, spacing `12`.
- **Font:** Inherits Fira Sans `11pt` except child rules below.
- **Foreground/background:** Moon backdrop `rgba(35,33,54,0.93)`; Dawn `rgba(250,244,237,0.93)`.
- **Border/radius:** Backdrop none; card values below; radius `0`.
- **Alignment:** Card horizontal and vertical center.
- **Visibility condition:** Armed only when `!store.hasSavedConnection`; initially hidden; appears only after restore is no longer `connecting` and is not connected; permanently disarms and hides once connected.
- **Enabled condition:** Overlay itself does not disable child workspace explicitly; it covers it.
- **State transition:** Hidden → waiting for restore → shown if disconnected → hidden permanently on connection. This prevents a flash over a working local automatic connection.
- **Windows counterpart:** Full-window WinUI overlay with modal input semantics and focus containment.
- **Windows status:** Implemented by `T4WorkspaceView.onboardingOverlay` with `T4WindowsConnectionCoordinator` state gating.

### Login card and controls

- **GTK source/function:** `AppWindow.buildOnboarding`, `submitLogin`, `setLoginStatus`; `T4GtkBridge.login`.
- **Widget hierarchy:** Title → explanatory label → username entry → password entry → Sign in button → status label.
- **Orientation/nesting:** Vertical card spacing `12`.
- **Fixed/flexible dimensions:** Card width `340`; button horizontal expansion; all heights intrinsic.
- **Margins/padding/spacing:** Card padding `28px 32px`; entries padding `8px 12px`; button padding `7px 14px`.
- **Font:** Title `19pt` weight 700; subtitle/status `10pt`; entries `11pt` Fira Sans; button inherited, weight 600.
- **Foreground/background:** Moon card `#2A273F`, title `#FFFFFF`, subtitle `#908CAA`; Dawn card `#FFFAF3`, title `#403C58`, subtitle `#6E6A8A`. Entry fills Moon `rgba(57,53,82,0.55)`, Dawn `rgba(255,255,255,0.65)`.
- **Border/radius:** Moon card `1px #1B1930`, top `#393552`; Dawn `1px #DFDAD9`, top `#FFFFFF`; radius `0`. Entries use Moon `rgba(86,82,110,0.7)` with lighter top, Dawn `#CECACD` with white top; radius `0`.
- **Alignment:** Labels start-aligned; card centered.
- **Labels:** `Welcome to Omperator`; `Sign in to start working on your computer.`; placeholders `Username`, `Password`; button `Sign in`.
- **Visibility condition:** Follows onboarding overlay.
- **Enabled condition:** Submission guard prevents duplicate work; GTK disables only the Sign in button during submission. Windows must also disable both fields to satisfy the migration acceptance criteria.
- **State transition:** Empty validation → `Enter your username and password to sign in.`; submission → `Signing in…`; login first, then registration fallback for 401/404/409; successful account then `restore()`; connected hides overlay; signed-in/unreachable → `Signed in — but your computer isn't reachable yet. Try again in a moment.`
- **Authentication failures:** Invalid credentials → `That username or password isn't right — try again.`; offline → `Can't reach the sign-in server. Check your connection and try again.`; invalid registration defaults to the source-defined 3–32-character username/eight-character password message.
- **Password behavior:** Masked by `gtk_entry_set_visibility(false)`.
- **Windows counterpart:** WinUI onboarding view backed by Windows Credential Manager and redacted account client.
- **Windows status:** Implemented with masked input, submission disabling, register fallback, friendly redacted errors, and Credential Manager persistence.

### Session rail

- **GTK source/function:** `AppWindow.build`, `rebuildRail`, `refreshRail`, `refreshRailTimes`.
- **Widget hierarchy:** Vertical `rail` → horizontal header → vertical-expanding scroller → vertical row list.
- **Orientation/nesting:** Rail vertical spacing `0`; header horizontal spacing `6`; row list vertical spacing `2`.
- **Fixed dimensions:** Width request `232`; height flexible.
- **Flexible dimensions:** Scroller vertically expands.
- **Margins/padding/spacing:** Rail margin `0`, padding `10`; row list spacing `2`.
- **Font:** Inherited Fira Sans `11pt`.
- **Foreground/background:** Transparent over root; Moon/Dawn root colors.
- **Border/radius:** Right hairline `1px #393552` Moon / `#DFDAD9` Dawn; no other border; radius `0`.
- **Alignment:** Left edge of workspace.
- **Visibility condition:** Visible initially; `☰` and `Show sidebar` toggle it; compact mode hides it and compact exit shows it.
- **Enabled condition:** Rows enabled; theme button enabled.
- **State transition:** `railVisible` Boolean. There is no automatic narrow-window collapse.
- **Windows counterpart:** WinUI session rail, exact effective width 232.
- **Windows status:** Implemented at effective width `232`.

### Rail header and title

- **GTK source/function:** `AppWindow.build`.
- **Widget hierarchy:** `Sessions` label then `◐` theme button.
- **Orientation/nesting:** Horizontal spacing `6`.
- **Fixed/flexible dimensions:** Intrinsic; no spacer, so glyph follows title.
- **Margins/padding/spacing:** Inherits rail padding; no additional header padding.
- **Font:** Title inherited `11pt`, regular; `subtle` color only.
- **Foreground/background:** Moon title `#908CAA`; Dawn `#6E6A8A`; transparent background.
- **Border/radius:** Theme glyph uses flat button: none, radius `0`, padding `2px 7px`.
- **Alignment:** Title start-aligned.
- **Visibility/enabled:** Visible/enabled whenever rail is visible.
- **State transition:** `◐` toggles Moon/Dawn.
- **Windows counterpart:** Rail header and accessible theme glyph button.
- **Windows status:** Implemented with accessible `◑` theme action.

### Session rows

- **GTK source/function:** `AppWindow.rebuildRail`.
- **Widget hierarchy:** Vertical `rail-item` containing friendly title then relative timestamp.
- **Orientation/nesting:** Vertical spacing `2`.
- **Fixed/flexible dimensions:** Width fills list by GTK allocation; height intrinsic; list capped to first 80 sessions.
- **Margins/padding/spacing:** Padding `8px 10px`; no margin; inter-row spacing `2`.
- **Font:** Title and time inherit Fira Sans `11pt`; no visible monospace identifiers.
- **Foreground/background:** Moon `#E0DEF4`; Dawn `#575279`; hover Moon `rgba(57,53,82,0.55)` with inset `rgba(86,82,110,0.4)` top edge; Dawn `rgba(223,218,217,0.55)` with white 0.7 inset top edge.
- **Border/radius:** No border; radius `0`.
- **Alignment:** Both labels start-aligned.
- **Visibility condition:** One row per first 80 sessions. Empty inventory yields no row and no separate empty-state label.
- **Enabled condition:** Press selects the matching current `SessionRef` by internal ID; ID is never rendered.
- **State transition:** Rail rebuilds only when session count changes; timestamps refresh every 60 seconds.
- **Windows counterpart:** WinUI selectable row with friendly projection only.
- **Windows status:** Implemented with a capped friendly projection and no internal metadata.

### Friendly title, relative timestamp, and selected state

- **GTK source/function:** `AppWindow.rebuildRail`, `relativeTime`.
- **Title rule:** `session.title`, falling back exactly to `Untitled session` when empty.
- **Timestamp rules:** Invalid ISO-8601-with-fractional-seconds input → empty; `<1 minute` → `just now`; `<60 minutes` → `Nm ago`; `<24 hours` → `Nh ago`; `<48 hours` → `yesterday`; `<7 days` → `Nd ago`; otherwise `MMM d` using the process locale/time zone.
- **Visible exclusions:** No session ID, revision, internal status code, host, endpoint, certificate fingerprint, or project metadata.
- **Timestamp color:** Moon `#6E6A86`; Dawn `#797593`.
- **Selected treatment:** The pinned GTK code stores row pointers and changes selected content/title, but applies no selected CSS class or distinct selected-row visual. This absence is authoritative and must not be replaced by an estimated treatment in the code-first pass.
- **Visibility/enabled:** Title always shown for each row; timestamp may be empty; row remains enabled.
- **State transition:** Row press calls `store.select`; title/transcript/browser projection changes on refresh.
- **Windows counterpart:** Pure visible-session projection plus selection state; no visible internal fields.
- **Windows status:** Implemented; relative-time boundaries and reflection-based identifier exclusions are covered.

### Main top bar

- **GTK source/function:** `AppWindow.build`, `refreshConnection`.
- **Widget hierarchy:** `☰` → session/status title → expanding spacer → `⤢` → `▤` → `⚙`.
- **Orientation/nesting:** Horizontal spacing `8`.
- **Fixed dimensions:** No fixed height; `min-height: 0`; intrinsic glyph/title height.
- **Flexible dimensions:** Spacer expands; title remains start-aligned.
- **Margins/padding/spacing:** Padding `2px 6px`; spacing `8`; no margin.
- **Font:** Title `17px`, weight 600; glyphs inherited, weight 500.
- **Foreground/background:** Transparent. Title Moon `#FFFFFF`, Dawn `#403C58`; glyph Moon `#6E6A86`, Dawn `#797593`.
- **Border/radius:** Bottom `1px #393552` Moon / `#DFDAD9` Dawn; flat buttons have no border/radius and `2px 7px` padding.
- **Alignment:** Left rail toggle, title, right-aligned action group.
- **Visibility/enabled:** Always visible; controls enabled.
- **State transition:** Rail, compact, browser sidebar, and settings toggles.
- **Windows counterpart:** Slim WinUI top bar with accessible glyph buttons in exact order.
- **Windows status:** Implemented as the slim v2 top bar.

### Session title and connection states

- **GTK source/function:** `AppWindow.refreshConnection`.
- **Priority:** Non-empty selected session title wins; otherwise non-empty error becomes `⚠ {error}`; otherwise connected becomes `● connected`; every other state becomes `○ connecting…`.
- **Disconnected state:** With an error and no title, error text is visible. With no error and no title, even a settled disconnected store reads `○ connecting…`.
- **Reconnecting state:** No dedicated visual beyond `○ connecting…`; `store.connecting` is used only to defer onboarding.
- **Font/color/alignment:** Top-bar title treatment above; start-aligned.
- **Enabled condition:** Read-only label.
- **State transition:** Refreshes when connected, last error, or title changes.
- **Security constraint:** Windows must redact transport/server text before projection; tokens, passwords, pairing codes, endpoints containing credentials, and fingerprints cannot reach title, errors, logs, diagnostics, screenshots, accessibility labels, or fixtures.
- **Windows counterpart:** Redacted connection-title projection.
- **Windows status:** Implemented through `T4WindowsConnectionTitle` and centralized secret redaction.

### Right-side toolbar glyphs

- **GTK source/function:** `AppWindow.build`.
- **Controls/order:** Right group is compact `⤢`, browser sidebar `▤`, settings `⚙`; rail `☰` is left of the title; theme `◐` is in the rail header.
- **Geometry/style:** Intrinsic flat buttons; padding `2px 7px`; no border/radius/shadow; hover wash Moon `rgba(57,53,82,0.55)`, Dawn `rgba(86,148,159,0.16)`.
- **Visibility/enabled:** Always visible/enabled, including when their target surface is hidden.
- **State transition:** Boolean toggles; no selected glyph styling.
- **Windows counterpart:** WinUI glyph buttons with semantic automation names; visible glyph/order unchanged.
- **Windows status:** Implemented with semantic native buttons in the current order.

### Transcript viewport and column

- **GTK source/function:** `AppWindow.build`, `refreshTranscript`, scroll helpers in `shim.h`.
- **Widget hierarchy:** Vertically expanding `GtkScrolledWindow` → vertical `transcript` box → one widget tree per durable entry plus optional live tail.
- **Orientation/nesting:** Column vertical spacing `10`; assistant block sub-column vertical spacing `9`.
- **Fixed/flexible dimensions:** Viewport fills remaining center height/width; no fixed measure in pixels.
- **Margins/padding/spacing:** Transcript padding `16px`; entry spacing `10`; no outer margin.
- **Font:** Base transcript Fira Sans `10.5pt`; entry classes override.
- **Foreground/background:** Transparent over root.
- **Border/radius:** None.
- **Alignment:** Entries control their own alignment; viewport starts at current/restored offset.
- **Visibility condition:** Center always visible; when no selected session or no entries it is blank.
- **Enabled condition:** Labels selectable; outer scroll interactive.
- **State transition:** Incremental append; clear on selected-session change or transcript shrink.
- **Windows counterpart:** WinUI scroll host with durable entry items and separate streaming tail.
- **Windows status:** Implemented with durable blocks, a separate live tail, and patched native scroll anchoring.

### Assistant messages

- **GTK source/function:** `TranscriptWidgets.buildEntry`, `assistantBlocks`, `proseLabel`.
- **Widget hierarchy:** Assistant message → vertical block column; prose labels, fenced code cards, and advisory cards are sibling blocks.
- **Orientation/nesting:** Block column vertical spacing `9`.
- **Fixed/flexible dimensions:** Prose max natural width 110 characters; height wraps intrinsically.
- **Margins/padding/spacing:** No prose card padding/margin; spacing comes from parent columns.
- **Font:** `New York`, `Charter`, Georgia, serif; exactly `18px`; regular except Markdown runs.
- **Foreground/background:** Moon `#E0DEF4`; Dawn `#575279`; transparent.
- **Border/radius:** None.
- **Alignment:** Start-aligned; selectable; word wrapping uses `GTK_WRAP_WORD`, not `WORD_CHAR`.
- **Visibility/enabled:** Visible for durable non-user message blocks; selectable, noneditable.
- **State transition:** Durable entries append; disposed labels are weak-tracked and removed before theme repaint.
- **Windows counterpart:** WinUI selectable prose block with equivalent wrapping and disposal-safe theme binding.
- **Windows status:** Implemented with WinUI rich-text runs and value-driven theme application.

### User messages

- **GTK source/function:** `TranscriptWidgets.userBubble`.
- **Widget hierarchy:** Full-width horizontal row → expanding spacer → content-sized vertical bubble → selectable prose label.
- **Orientation/nesting:** Row horizontal spacing `0`; bubble vertical spacing `0`.
- **Fixed/flexible dimensions:** Bubble max natural width 48 characters; row expands horizontally.
- **Margins/padding/spacing:** Bubble padding `10px 13px`; no margin.
- **Font:** Fira Sans stack, `15px`.
- **Foreground/background:** Moon text `#E0DEF4`, fill `rgba(57,53,82,0.55)`; Dawn text `#575279`, fill `rgba(255,255,255,0.6)`.
- **Border/radius:** `1px` hairline (`#393552` / `#DFDAD9`); radius `0`; no shadow.
- **Alignment:** Right edge via a leading horizontal-expanding spacer. Content label itself start-aligns.
- **Visibility/enabled:** Durable user entries; selectable, noneditable.
- **State transition:** Optional pending state would set opacity `0.5`, but the current store path always calls it with `pending: false`.
- **Windows counterpart:** Right-aligned WinUI bubble state, with optional pending opacity retained in the model.
- **Windows status:** Implemented as a trailing-aligned bounded bubble.

### Streaming tail

- **GTK source/function:** `AppWindow.refreshStreaming`; `T4GtkBridge.streamingText(for:)`.
- **Widget hierarchy:** One `assistant-message` label appended after durable entry widgets.
- **Orientation/nesting:** Transcript-column child.
- **Fixed/flexible dimensions:** Intrinsic, word-wrapped, no explicit 110-character cap in this path.
- **Margins/padding/spacing:** Inherits transcript entry spacing; no own padding/margin.
- **Font/color/background:** Same `18px` assistant serif style, transparent, theme foreground.
- **Border/radius/alignment:** None; start-aligned; selectable.
- **Visibility condition:** Exists only while store streaming text for the selected session is non-empty.
- **Enabled condition:** Read-only/selectable.
- **State transition:** Create on first non-empty delta; replace text for each changed aggregate; destroy and clear cache when streaming becomes empty; durable entry then owns the settled content.
- **Scroll interaction:** Calls bottom scroll after each changed aggregate, but scrolling occurs only while follow mode is pinned.
- **Windows counterpart:** Session-keyed transient tail item separate from durable transcript collection.
- **Windows status:** Implemented and reconciled on durable turn completion.

### Scroll memory and follow mode

- **GTK source/function:** `refreshTranscript`, `restoreScroll`, `updateScrollPin`, `followContentGrowth`; `shim_scroll_get/set/to_max`.
- **Fixed constants:** Near-bottom threshold `48`; per-session saved offset is a `Double` adjustment value.
- **First-open state:** Missing saved offset sets `pinnedToBottom = true`; deferred idle callback sets the adjustment to `upper - pageSize`.
- **Session switch:** Save outgoing value before clearing; restore incoming saved value after layout; saved sessions are not automatically pinned.
- **Follow release/reacquisition:** Only an actual `value` change updates pin state; `value + page >= upper - 48` reacquires, movement farther away releases.
- **Content growth:** Adjustment `changed` signal chases the true bottom only while pinned. Upper-bound growth alone does not release follow.
- **Visibility/enabled:** Scrollbar uses a 6px square-corner thumb; interactive.
- **Windows counterpart:** Session-keyed scroll-state controller measured in WinUI scroll coordinates.
- **Windows status:** Implemented with `T4LinuxV2ScrollMemory`, the `48`-point threshold, and native growth callbacks.

### Markdown prose

- **GTK source/function:** `MarkdownRenderer.renderTranscriptSegments`, `TranscriptWidgets.proseMarkup`.
- **Block rules:** Headings `#`/`##`/`###` only with whitespace or end; quote only `> `; list supports leading spaces/tabs then `-`, `*`, `•`, or any-digit ordered marker ending `.` or `)` followed by whitespace; indentation and marker remain visible; `+` is not a list marker. Fences are lines beginning exactly with three backticks in the line renderer and whitespace-trimmed backticks in block splitting.
- **Inline rules:** Single-backtick inline code; asterisk or underscore runs of exactly 1/2/3 for italic/bold/bold-italic; no intraword emphasis; opener cannot precede whitespace; closer cannot follow an alphanumeric; code spans are excluded from emphasis scanning. Links parse `[nonempty label](nonempty URL)` and render the label only.
- **Visible link behavior:** Purple/underlined visual only; the GTK label does not attach navigation/click behavior.
- **Marker behavior:** Heading, quote, fence, emphasis, inline-code, and link delimiters are removed; list markers and indentation remain; newlines are preserved.
- **Effective prose styles:** H1 label run `size=15360` (15pt), 700, gold; H2 `13312` (13pt), 700, gold; H3 600 gold; bold 700 gold; bold-italic 700 italic gold; italic inherited color italic; inline code JetBrains Mono/cyan; link purple underline; quote muted italic; diff lines add/remove colors.
- **CSS definitions not directly applied by the label path:** `.md-h1` `17pt` margin `12 0 6`; `.md-h2` `15pt` margin `10 0 5`; `.md-h3` `13pt` margin `8 0 4`; `.md-inline-code` `12pt`, padding `1px 4px`; `.md-list` padding-left `18px`; `.md-quote` padding `4px 10px`, margin `6px 0`. Windows must follow effective renderer behavior and document any deliberate use of the otherwise dormant CSS box values.
- **Background/border/radius:** Inline prose has none in the effective Pango-label path; radius `0` globally.
- **Windows counterpart:** Foundation-only parser port producing Windows styled runs/blocks, not a generic Markdown package.
- **Windows status:** Implemented by `T4LinuxV2MarkdownParser`; list/emphasis/link/fence boundaries are covered.

### Code blocks

- **GTK source/function:** `TranscriptWidgets.codeBlock`, `fillCodeBuffer`; `SyntaxHighlighter.highlightCode`.
- **Widget hierarchy:** Collapsible vertical card → horizontal header (expandable title area + independent Copy button) → hidden body (horizontal separator + scroller + nonwrapping text view).
- **Orientation/nesting:** Card/body vertical spacing `0`; header horizontal spacing `8`; clickable title row horizontal spacing `6`.
- **Fixed/flexible dimensions:** Width capped by transcript allocation; no fixed height; horizontal scroll automatic, vertical scroll disabled.
- **Margins/padding/spacing:** Card padding `10px 12px`; header title CSS padding `2px 2px 6px`; collapsed cards set bottom padding `0`; Copy padding `3px 10px`.
- **Font:** JetBrains Mono/Cascadia Code, `12.5pt`; header and Copy `8.5pt`, weights 700/600.
- **Foreground/background:** Moon `#9CCFD8` on `#2A273F`; Dawn `#56949F` on `#F2E9E1`; token palette overrides runs.
- **Border/radius:** `1px` hairline; radius `0`; no card shadow. Separator intrinsic GTK hairline.
- **Alignment:** Start; long lines do not wrap.
- **Visibility condition:** Card always shows one-line header; body starts hidden.
- **Enabled condition:** Header title toggles; Copy remains independent and copies raw code.
- **State transition:** `collapsed` with `▸` → `expanded` with `▾`; reverse on next press.
- **Windows counterpart:** WinUI collapsible code card plus syntax runs and clipboard command.
- **Windows status:** Implemented with collapsible WinUI cards, syntax runs, horizontal overflow, and independent Copy.

### Tool output and advisory cards

- **GTK source/function:** `TranscriptWidgets.toolCard`, `advisoryCard`, `collapsibleCard`.
- **Widget hierarchy:** Same collapsible header/body system. Tool body is a selectable `tool-meta` label; advisory body can contain muted guidance then assistant Markdown prose.
- **Orientation/nesting:** Card vertical `0`; tool body vertical `3`; advisory body vertical `5`; header `8`; title cluster `6`.
- **Fixed/flexible dimensions:** Text max natural width 110 characters; intrinsic height.
- **Margins/padding/spacing:** Card padding `10px 12px`; collapsed bottom padding `0`.
- **Font:** Tool head `9.5pt`, 700, uppercase in code; meta `9pt`; header `9pt`, 600.
- **Foreground/background:** Moon tool `#2A273F`, Dawn `#FFFAF3`; default 3px left rail blue/cyan, tool result cyan, thinking purple. Advisory uses gold tint/rail; info blue; error/blocker red.
- **Border/radius:** Tool Moon base border `#1B1930` with top `#393552`, Dawn `#DFDAD9` with white top; 3px colored left border; radius `0`. Tool/advisory retain small source-defined shadows, unlike flat bubble/code cards.
- **Alignment:** Start; meta selectable and word-wrapped.
- **Visibility condition:** All non-message/unknown transcript entries dispatch to a tool card. Empty body yields header-only card.
- **Enabled condition:** Header toggles only when a body exists.
- **State transition:** Starts collapsed; toggles header chevron/body visibility.
- **Windows counterpart:** WinUI tool/advisory rows preserving entry kind and severity treatments.
- **Windows status:** Implemented with kind/severity-specific collapsible cards.

### Composer

- **GTK source/function:** `AppWindow.build`, `submitComposer`.
- **Widget hierarchy:** Horizontal `composer` → expanding single-line entry → `➤` button.
- **Orientation/nesting:** Horizontal spacing `8`.
- **Fixed/flexible dimensions:** Entry horizontally expands; all heights intrinsic.
- **Margins/padding/spacing:** Composer margin `10px 12px`; padding `8px 12px`; button padding `4px 12px`.
- **Font:** Entry Fira Sans `10.5pt`; button inherited, weight 600.
- **Foreground/background:** Moon composer `rgba(57,53,82,0.55)`, text `#E0DEF4`, caret/accent button `#F6C177`; Dawn composer `rgba(255,255,255,0.65)`, text `#575279`, button `#EA9D34`.
- **Border/radius:** Beveled 1px source colors; radius `0`; source-defined small shadow/glow.
- **Alignment:** Fixed at bottom of center column below transcript.
- **Visibility condition:** Always visible, including disconnected/no-selection states.
- **Enabled condition:** GTK does not disable composer during connection or streaming. Submit requires a selected session and non-whitespace text; no placeholder is assigned.
- **State transition/send behavior:** Enter or button; trim; ignore empty; clear immediately; asynchronously call `sendPrompt`. Current store owns lease/error behavior.
- **Compact behavior:** Same geometry inside the 440px window after both side areas hide.
- **Windows counterpart:** WinUI composer. Migration acceptance requires disabled/streaming state, which is a documented deliberate correction to the pinned GTK omission.
- **Windows status:** Implemented. The field and send action disable while disconnected, unselected, or streaming, as required by the migration acceptance criteria.

### Browser sidebar

- **GTK source/function:** `AppWindow.buildPanesSidebar`, `refreshPanes`, `togglePanes`; `PanesFactory.browserWidget`.
- **Widget hierarchy:** Vertical `pane-sidebar` → scrolled WebKitGTK web view. There is no tab strip or visible navigation chrome in the pinned GTK hierarchy.
- **Orientation/nesting:** Sidebar vertical spacing `6`.
- **Fixed dimensions:** Width request `380`; height fills workspace.
- **Flexible dimensions:** Web view scroller expands both axes.
- **Margins/padding/spacing:** Margin `0`; padding `10px`; spacing `6`.
- **Font/foreground/background:** Sidebar transparent over root; embedded page owns content styling.
- **Border/radius:** Left hairline `1px #393552` Moon / `#DFDAD9` Dawn; radius `0`.
- **Alignment:** Rightmost workspace child.
- **Visibility condition:** Hidden initially; `▤` toggles; compact mode closes it. No Terminal/Files tab or ordinary control exists.
- **Enabled condition:** Web view interactive when visible.
- **State transition/lifecycle:** Default `http://localhost:3000`; selected-session URL loads only when different from the last request so in-flight load/scroll state is not reset; URI updates write back to selected session; loading notifications exposed; browser object disconnects signals on destroy.
- **Engine methods:** Load URL, Reload, Back, Forward, current URL, can-go-back/forward, and loading state exist. GTK factory has no Stop/title/error presentation.
- **Windows counterpart:** Preserved WebView2 mounted inside simplified 380px chrome. User-required Windows chrome exposes Back, Forward, Reload, Stop, URL, loading, title, and error while Browser remains the only ordinary sidebar pane.
- **Windows status:** Implemented with app-lifetime per-session WebView2 state and full required navigation chrome.

### Settings panel

- **GTK source/function:** `AppWindow.buildSettingsPanel`, `toggleSettingsPanel`.
- **Widget hierarchy:** Start-aligned horizontal `settings-popover` inserted directly below top bar, containing three check buttons.
- **Orientation/nesting:** Horizontal spacing `14`.
- **Fixed/flexible dimensions:** Intrinsic; each check indicator minimum `14 × 14`.
- **Margins/padding/spacing:** Panel padding `10px 14px`; check-button padding `4px 2px`; no margin.
- **Font:** Check labels `10.5pt`.
- **Foreground/background:** Moon `#E0DEF4` on `#2A273F`; Dawn `#575279` on `#FFFAF3`; checked fill gold.
- **Border/radius:** Panel `1px` hairline; checks `1px` muted border; all radius `0`.
- **Alignment:** Start, below top bar; despite its class name, this implementation is not a floating GTK popover.
- **Labels/order:** `Dark mode`, `Compact window`, `Show sidebar`.
- **Visibility condition:** Hidden initially; `⚙` toggles.
- **Enabled condition:** All toggles enabled; state is synchronized immediately before showing while event callbacks are suppressed.
- **State transition:** Dark toggles theme; Compact toggles compact window; Show sidebar toggles the session rail, not the browser pane.
- **Windows counterpart:** Plain WinUI settings strip/panel with the same labels/order and one source of truth.
- **Windows status:** Implemented with exactly the three current labels and order.

### Compact-window mode

- **GTK source/function:** `AppWindow.toggleMiniMode`; `CompositorPin.setPinned`.
- **Entry transition:** Save current default width/height; hide rail if visible; hide browser if visible and set its state false; resize to `440 × 560`; request compositor pin.
- **Exit transition:** Unpin; restore saved default size; always show rail; browser remains closed because its prior open state is not retained by the pinned code.
- **Visibility:** Center/top bar/transcript/composer remain; both side areas hide.
- **Alignment/layout:** Same center hierarchy reflows at 440 width; assistant labels use word wrap.
- **Platform-specific behavior:** X11/niri/Hyprland/Sway/KDE implement best-effort topmost; GNOME/unknown no-op. Windows uses its native topmost/window APIs and must not import compositor code.
- **Enabled condition:** Explicit `⤢` or settings check.
- **Breakpoint behavior:** No automatic compact breakpoint.
- **Windows counterpart:** Native WinUI compact state at exact 440 × 560, with Windows topmost equivalent where supported.
- **Windows status:** Implemented with native client resize and WinUI always-on-top.

### Sidebar shown/hidden modes

- **GTK source/function:** `toggleRail`, `togglePanes`, `toggleMiniMode`.
- **Session rail:** Initially shown; `☰` or `Show sidebar` toggles; width 232.
- **Browser sidebar:** Initially hidden; `▤` toggles; width 380.
- **Compact:** Forces both hidden; exiting restores rail, not browser.
- **Center behavior:** Horizontally expanding center consumes all released width; `GTK_WRAP_WORD` rewraps prose in both directions.
- **Animation:** None for these visibility changes. The unused pane-stack helper defines a 180ms slide, but current Browser-only hierarchy does not instantiate the stack.
- **Windows counterpart:** Separate Boolean rail/browser visibility states, with exact compact transition behavior unless a documented correctness fix preserves prior browser state.
- **Windows status:** Implemented with independent rail/browser Booleans and the pinned compact close/restore behavior.

### Moon theme

- **GTK source/function:** `main.swift`, `AppWindow.applyTheme`, `TranscriptWidgets.applyTheme`; `theme-moon.css`.
- **Initial state:** `dark = true`; Moon CSS is loaded on application activation.
- **Typography:** Fira Sans UI/user, 18px serif assistant, JetBrains Mono code.
- **Geometry:** Exact shared values above; all radii `0`.
- **State transition:** Each toggle loads another application-priority provider, then re-tints live syntax tags and re-renders live prose labels.
- **Crash correction:** Syntax tags and labels are weak-tracked; transcript clear removes dead objects before theme repaint.
- **Windows counterpart:** Moon token set with element-lifetime-safe theme binding.
- **Windows status:** Implemented; Moon is the initial effective palette.

### Dawn theme

- **GTK source/function:** `AppWindow.applyTheme`, `TranscriptWidgets.applyTheme`; `theme-dawn.css`.
- **Initial state:** Not initial; reached by theme toggle.
- **Typography/geometry:** Same as Moon.
- **Colors:** Exact Dawn primitives and syntax table above. Terminal CSS deliberately remains Moon-dark in the Dawn stylesheet, although Terminal is hidden from the ordinary current UI.
- **State transition:** Same as Moon; existing live elements repaint in place.
- **Windows counterpart:** Dawn token set; hidden terminal may retain its engine-owned palette.
- **Windows status:** Implemented; repeated Moon/Dawn native capture sweeps complete without disposed-widget mutation.

## GTK CSS/provider inventory

Application providers are loaded from absolute source-tree paths by `shim_css_load` at GTK application priority:

- Moon: `/home/alexis/dev/omperator/spike-gtk-linux/theme-moon.css`
- Dawn: `/home/alexis/dev/omperator/spike-gtk-linux/theme-dawn.css`

Windows must package its own theme resources; the absolute Linux path is not portable.

Classes/selectors present in the current theme pair:

`rail`, `pane-sidebar`, `rail-item`, `transcript`, `user-bubble`, `assistant-message`, `code-block`, `code-header`, `code-copy`, `syn-keyword`, `syn-string`, `syn-comment`, `syn-number`, `syn-type`, `syn-function`, `syn-attribute`, `syn-plain`, `tool-card`, `tool-head`, `tool-meta`, `advisory-card`, `advisory-info`, `advisory-error`, `tool-tool-use`, `tool-tool-result`, `tool-thinking`, `md-h1`, `md-h2`, `md-h3`, `md-bold`, `md-italic`, `md-inline-code`, `md-quote`, `md-list`, `md-link`, `diff-add`, `diff-remove`, `terminal`, `composer`, `composer-entry`, `send-button`, `card`, `muted`, `subtle`, `accent`, `flat-btn`, `topbar`, `topbar-title`, `card-header`, `card-chevron`, `collapsed`, `expanded`, `onboarding`, `login-card`, `login-title`, `login-subtle`, `login-entry`, `login-button`, `login-error`, and `settings-popover`.

Other styled selectors are the window root; descendant text views; scrolled windows; scrollbar sliders; entry placeholders; check buttons/check indicators; and hover, active, disabled, checked, collapsed, and severity/kind state selectors.

## Known code-defined gaps and deliberate Windows differences

These are facts from the pinned code, not visual estimates:

1. GTK has no distinct selected-row style despite retaining row pointers.
2. GTK has no rail empty-state message.
3. GTK shows no browser navigation/title/error chrome; only the WebKit view is visible.
4. GTK does not disable composer controls while streaming or disconnected.
5. GTK disables only the login button during submission, not both fields.
6. GTK link treatment is visual but not clickable.
7. GTK settings `Show sidebar` controls the session rail; browser visibility remains the `▤` action.
8. GTK has no automatic narrow/standard/wide breakpoint; only explicit compact mode.
9. GTK uses the historical native window title `T4 Code`; Windows public title must remain `Omperator` under repository naming rules while stable technical identifiers stay unchanged.
10. GTK compact exit does not restore an open browser sidebar.
11. GTK connection status has no dedicated settled-disconnected or reconnecting visual beyond error text/`○ connecting…`.
12. GTK loads theme files from an absolute developer path. Windows packages resources instead.

The Windows implementation may correct only the gaps explicitly required by the migration prompt (browser chrome, disabled submission/composer behavior, secure redaction, accessibility names, public product title). Every correction must be recorded as a genuine GTK/WinUI difference rather than described as pixel parity.
