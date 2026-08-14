import Foundation
import CT4Gtk
import HostWire
import T4CodeLinuxLib

/// The pure-GTK4 workspace window: session rail + streaming transcript +
/// composer, driven by the shared T4SessionStore (unchanged backend).

@MainActor
final class AppWindow {
    let store = T4GtkBridge()

    // GTK state
    private var window: UnsafeMutablePointer<GtkWidget>?
    private var railList: UnsafeMutablePointer<GtkWidget>?
    private var railRows: [String: UnsafeMutablePointer<GtkWidget>] = [:]
    private var railSearchEntry: UnsafeMutablePointer<GtkWidget>?
    private var railSegmentButtons: [RailGrouping: UnsafeMutablePointer<GtkWidget>] = [:]
    private var railSearchText = ""
    private var railGrouping: RailGrouping = .recency
    private var lastRailSignature = ""
    private var transcriptView: UnsafeMutablePointer<GtkWidget>?
    private var transcriptBox: UnsafeMutablePointer<GtkWidget>?
    private var composerView: UnsafeMutablePointer<GtkWidget>?
    private var composerBuffer: UnsafeMutablePointer<GtkTextBuffer>?
    private var attachStrip: UnsafeMutablePointer<GtkWidget>?
    private var rootOverlay: UnsafeMutablePointer<GtkWidget>?
    private var lightbox: UnsafeMutablePointer<GtkWidget>?
    private var sendButton: UnsafeMutablePointer<GtkWidget>?

    /// One staged composer attachment (file pick, paste, or drop).
    private struct Attachment {
        let id: UUID
        let data: Data
        let mimeType: String
        let name: String
    }
    private var attachments: [Attachment] = []
    private var dropBox: GtkPathsBox?

    /// Preview captures already rendered as transcript image rows, per
    /// session (captureId → picture widget still awaiting its texture).
    private var renderedCaptureIds: [String] = []
    private var pendingCapturePictures: [String: UnsafeMutablePointer<GtkWidget>] = [:]
    private var statusLabel: UnsafeMutablePointer<GtkWidget>?
    private var themeButton: UnsafeMutablePointer<GtkWidget>?
    private let transcriptWidgets = TranscriptWidgets()

    private var renderedSessionId = ""
    private var renderedEntryCount = 0
    private var lastSelectedId = ""
    private var lastSessionCount = -1
    private var lastConnected = false
    private var lastError: String?
    private var lastTitle = ""
    private var dark = AppWindow.launchDark
    private var transcriptScroll: UnsafeMutablePointer<GtkWidget>?
    private var pinnedToBottom = true
    private var lastScrollValue = 0.0
    private var lastScrollUpper = 0.0
    /// Set while the app itself scrolls to the bottom; updateScrollPin ignores
    /// those value-changes so our own auto-scroll never releases the pin.
    private var programmaticScroll = false
    /// Content height seen by the last frame-tick, so the follow only scrolls
    /// when the transcript actually grew.
    private var lastTickUpper = 0.0
    /// Per-session scroll position, saved on swap and restored on return.
    private var scrollPositions: [String: Double] = [:]
    // Panes (browser sidebar; terminal/files stay available in PanesFactory)
    private let panes = PanesFactory()
    private var paneSidebar: UnsafeMutablePointer<GtkWidget>?
    private var paneVisible = false
    private var railBox: UnsafeMutablePointer<GtkWidget>?
    private var railVisible = true
    private var miniButton: UnsafeMutablePointer<GtkWidget>?
    private var miniMode = false
    private var fullSize: (width: Int, height: Int)?
    private var streamingLabel: UnsafeMutablePointer<GtkWidget>?
    private var lastStreamedText = ""
    // First-run onboarding (username + password login).
    private var onboardingArmed = false
    private var onboardingVisible = false
    private var onboardingBackdrop: UnsafeMutablePointer<GtkWidget>?
    private var onboardingCard: UnsafeMutablePointer<GtkWidget>?
    private var loginEntry: UnsafeMutablePointer<GtkWidget>?
    private var passwordEntry: UnsafeMutablePointer<GtkWidget>?
    private var loginButton: UnsafeMutablePointer<GtkWidget>?
    private var loginStatusLabel: UnsafeMutablePointer<GtkWidget>?
    private var loginInProgress = false
    // Settings panel (plain-language toggles).
    private var settingsPanel: UnsafeMutablePointer<GtkWidget>?
    private var settingsDarkCheck: UnsafeMutablePointer<GtkWidget>?
    private var settingsCompactCheck: UnsafeMutablePointer<GtkWidget>?
    private var settingsRailCheck: UnsafeMutablePointer<GtkWidget>?
    private var settingsSyncing = false
    // Rail relative-time refresh cadence (seconds).
    private var lastRailTimeRefresh = -60.0
    private var railTimeLabels: [String: UnsafeMutablePointer<GtkWidget>] = [:]

    /// Launch seam: -T4Theme=dark|light forces the appearance for headless
    /// screenshot sweeps; anything else (including system) keeps the dark
    /// Rosé Pine Moon default.
    private static var launchDark: Bool {
        guard let raw = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("-T4Theme=") }) else {
            return true
        }
        return String(raw.dropFirst("-T4Theme=".count)) != "light"
    }

    /// Capture seam: -T4WindowSize=1920x1080 launches at exact capture
    /// geometry — resizing a realized WebKitGTK view on Xvfb races its
    /// compositor and can leave the browser pane unpainted.
    private static var launchSize: (width: Int, height: Int) {
        guard let raw = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("-T4WindowSize=") }) else {
            return (1180, 760)
        }
        let parts = raw.dropFirst("-T4WindowSize=".count).split(separator: "x")
        guard parts.count == 2, let w = Int(parts[0]), let h = Int(parts[1]) else {
            return (1180, 760)
        }
        return (w, h)
    }

    init(app: UnsafeMutablePointer<GtkApplication>?) {
        guard let appPtr = app, let win = gtk_application_window_new(appPtr) else { return }
        window = win
        transcriptWidgets.bridge = store
        transcriptWidgets.onZoom = { [weak self] texture in self?.showLightbox(texture) }
        build(win)
        // Dev seam: -T4Attach=/path/to.png stages a composer attachment at
        // startup (QA for the attachment strip without a file dialog).
        if let seam = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("-T4Attach=") }) {
            attachFiles([String(seam.dropFirst("-T4Attach=".count))])
        }
        // First run: no saved endpoint — offer the friendly login until the
        // workspace actually connects (a live local gateway connects on its
        // own, so the screen shows only when a sign-in is genuinely needed).
        onboardingArmed = !store.hasSavedConnection
        startRefreshTimer()
    }

    // MARK: - Build

    private func build(_ win: UnsafeMutablePointer<GtkWidget>) {
        shim_window(win, "T4 Code", Int32(Self.launchSize.width), Int32(Self.launchSize.height))

        // Window root is an overlay: the workspace beneath, the first-run
        // login screen above (hidden until the store connects), and the
        // image lightbox above everything.
        let root = shim_overlay_new()
        rootOverlay = root
        let workspace = shim_box_new(1, 0)
        shim_overlay_set_child(root, workspace)
        shim_window_set_child(win, root)

        // Esc closes the image lightbox when one is open.
        onKey(win) { [weak self] keyval, _ in
            guard let self, keyval == gdkKeyEscape, self.lightbox != nil else { return false }
            self.hideLightbox()
            return true
        }

        // Rail (left)
        let rail = shim_box_new(0, 0)
        railBox = rail
        addClass(rail, "rail")
        shim_widget_size(rail, 232)
        shim_box_append(workspace, rail)

        let railHeader = shim_box_new(1, 6)
        let railTitle = makeLabel("Sessions", "subtle")
        shim_widget_halign_start(railTitle)
        shim_box_append(railHeader, railTitle)
        themeButton = shim_button("◐")
        addClass(themeButton, "flat-btn")
        onSignal(themeButton, "clicked") { [weak self] in self?.toggleTheme() }
        shim_box_append(railHeader, themeButton)
        shim_box_append(rail, railHeader)

        // Session search: live-filters the rail by title / project / status /
        // model as you type.
        let search = shim_entry()
        railSearchEntry = search
        addClass(search, "rail-search")
        shim_entry_set_placeholder(search, "Filter sessions…")
        onSignal(UnsafeMutableRawPointer(search), "changed") { [weak self] in
            self?.railSearchChanged()
        }
        shim_box_append(rail, search)

        // Grouping picker: a segmented control (Recent / Project / Status).
        // Segmented buttons, not a GtkDropDown — the dropdown's popup crashed
        // (its notify::selected signal has a 3-arg signature the onSignal
        // trampoline doesn't handle) and its translucent closed state clashed
        // with the rail. Buttons use the plain 2-arg "clicked" signal and show
        // all three modes with the active one highlighted.
        let segmented = shim_box_new(1, 0)
        addClass(segmented, "rail-segmented")
        railSegmentButtons.removeAll()
        for mode in [RailGrouping.recency, .project, .status] {
            let label = mode == .recency ? "Recent" : (mode == .project ? "Project" : "Status")
            let button = shim_button(label)
            addClass(button, "rail-segment")
            shim_widget_expand(button, 1)
            let captured = mode
            onPressed(button) { [weak self] in
                self?.setRailGrouping(captured)
            }
            railSegmentButtons[mode] = button
            shim_box_append(segmented, button)
        }
        shim_box_append(rail, segmented)
        updateRailSegmentStates()

        let railScroll = shim_scrolled_window()
        shim_widget_expand(railScroll, 0)
        railList = shim_box_new(0, 2)
        shim_scrolled_set_child(railScroll, railList)
        shim_box_append(rail, railScroll)

        // Center: header + transcript + composer
        let center = shim_box_new(0, 0)
        shim_widget_expand(center, 1)
        shim_box_append(workspace, center)

        let header = shim_box_new(1, 8)
        addClass(header, "topbar")
        let railToggle = shim_button("☰")
        addClass(railToggle, "flat-btn")
        onSignal(railToggle, "clicked") { [weak self] in self?.toggleRail() }
        shim_box_append(header, railToggle)
        statusLabel = makeLabel("connecting…", "topbar-title")
        shim_widget_halign_start(statusLabel)
        shim_box_append(header, statusLabel)
        // Right end: mini-mode toggle (compact always-on-top-capable window).
        shim_box_append(header, shim_spacer())
        miniButton = shim_button("⤢")
        addClass(miniButton, "flat-btn")
        onSignal(miniButton, "clicked") { [weak self] in self?.toggleMiniMode() }
        shim_box_append(header, miniButton)
        let panesButton = shim_button("▤")
        addClass(panesButton, "flat-btn")
        onSignal(panesButton, "clicked") { [weak self] in self?.togglePanes() }
        shim_box_append(header, panesButton)
        // Settings (plain-language toggles).
        let settingsButton = shim_button("⚙")
        addClass(settingsButton, "flat-btn")
        onSignal(settingsButton, "clicked") { [weak self] in self?.toggleSettingsPanel() }
        shim_box_append(header, settingsButton)
        shim_box_append(center, header)

        buildSettingsPanel(center)

        let scroll = shim_scrolled_window()
        transcriptScroll = scroll
        shim_widget_expand(scroll, 0)
        // Per-entry widget container: each transcript entry is a real widget
        // (user bubble card, serif prose, code block, tool card) — a flat text
        // view can't do right-aligned bubbles or structured code blocks.
        let box = shim_box_new(0, 10)
        addClass(box, "transcript")
        transcriptBox = box
        shim_scrolled_set_child(scroll, box)
        shim_box_append(center, scroll)

        // Bottom-pin: stay anchored to the newest content while the user is
        // near the bottom during streaming; scrolling up releases the pin,
        // scrolling back near the bottom re-engages it.
        if let adj = shim_vadj(scroll) {
            onSignal(UnsafeMutableRawPointer(adj), "value-changed") { [weak self] in
                self?.updateScrollPin()
            }
        }
        // Follow the bottom from a frame-tick, not the adjustment "changed"
        // signal: the tick runs right before draw, AFTER layout, so the content
        // height is final — the "changed" signal fired before the new text was
        // measured and left the view one chunk short (newest line cut off until
        // a scrollbar wiggle forced a re-measure).
        let tickBox = GtkBox { [weak self] in self?.scrollFollowTick() }
        shim_add_tick(scroll, tickForwarder, Unmanaged.passRetained(tickBox).toOpaque())

        let composer = shim_box_new(1, 8)
        addClass(composer, "composer")

        // Attachment strip: chips with thumbnails, hidden until the first
        // attachment lands (file pick, paste, or drop).
        let strip = shim_box_new(0, 6)
        addClass(strip, "attachment-strip")
        shim_widget_hide(strip)
        attachStrip = strip
        shim_box_append(composer, strip)

        // Input row: attach button + wrapping multiline text view (auto-grow
        // to ~6 lines, then internal scroll) + send button.
        let inputRow = shim_box_new(1, 8)
        let attachButton = shim_button("📎")
        addClass(attachButton, "flat-btn")
        onSignal(attachButton, "clicked") { [weak self] in self?.openImagePicker() }
        shim_box_append(inputRow, attachButton)

        let composerScroll = shim_scrolled_window()
        shim_scrolled_content_height(composerScroll, 30, 150)
        shim_scrolled_no_width_propagate(composerScroll)
        let view = shim_composer_view()
        addClass(view, "composer-view")
        composerView = view
        composerBuffer = shim_text_buffer(view)
        shim_scrolled_set_child(composerScroll, view)
        shim_widget_expand(composerScroll, 1)
        shim_box_append(inputRow, composerScroll)

        // Enter sends; Shift+Enter inserts a newline. Ctrl+V with an image
        // on the clipboard attaches it instead of pasting text.
        onKey(view) { [weak self] keyval, state in
            guard let self else { return false }
            if (keyval == gdkKeyReturn || keyval == gdkKeyKPEnter) && (state & gdkShiftMask) == 0 {
                self.submitComposer()
                return true
            }
            if keyval == gdkKeyV && (state & gdkControlMask) != 0 && shim_clipboard_has_image(view) != 0 {
                self.pasteClipboardImage(view: view)
                return true
            }
            return false
        }

        // Drag & drop of image files onto the composer.
        installPathsHandlerIfNeeded()
        let drop = GtkPathsBox(releaseAfterUse: false) { [weak self] paths in self?.attachFiles(paths) }
        dropBox = drop
        shim_drop_files(composer, Unmanaged.passRetained(drop).toOpaque())

        sendButton = shim_button("➤")
        addClass(sendButton, "send-button")
        onSignal(sendButton, "clicked") { [weak self] in self?.submitComposer() }
        shim_box_append(inputRow, sendButton)
        shim_box_append(composer, inputRow)
        shim_box_append(center, composer)

        buildPanesSidebar(workspace)

        buildOnboarding(root)

        // Apply the launch theme (main.swift preloads Moon; -T4Theme=light
        // must land here or the CSS stays dark until the first toggle).
        applyTheme()

        shim_window_present(win)
    }

    // MARK: - Settings panel

    /// Small plain-language settings surface: a compact panel under the topbar
    /// with three toggles backed by the existing AppWindow methods.
    private func buildSettingsPanel(_ parent: UnsafeMutablePointer<GtkWidget>?) {
        guard let parent else { return }
        let panel = shim_box_new(1, 14)
        addClass(panel, "settings-popover")
        settingsPanel = panel

        let darkCheck = shim_check_button("Dark mode")
        onSignal(darkCheck, "toggled") { [weak self] in
            guard let self, !self.settingsSyncing else { return }
            self.toggleTheme()
        }
        shim_box_append(panel, darkCheck)
        settingsDarkCheck = darkCheck

        let compactCheck = shim_check_button("Compact window")
        onSignal(compactCheck, "toggled") { [weak self] in
            guard let self, !self.settingsSyncing else { return }
            self.toggleMiniMode()
        }
        shim_box_append(panel, compactCheck)
        settingsCompactCheck = compactCheck

        let railCheck = shim_check_button("Show sidebar")
        onSignal(railCheck, "toggled") { [weak self] in
            guard let self, !self.settingsSyncing else { return }
            self.toggleRail()
        }
        shim_box_append(panel, railCheck)
        settingsRailCheck = railCheck

        shim_widget_halign_start(panel)
        shim_box_append(parent, panel)
        shim_widget_hide(panel)
    }

    private func toggleSettingsPanel() {
        guard let panel = settingsPanel else { return }
        if shim_widget_visible(panel) != 0 {
            shim_widget_hide(panel)
            return
        }
        // Sync the checks with the live state before showing (suppressing the
        // programmatic "toggled" emissions so they don't re-fire the toggles).
        settingsSyncing = true
        shim_check_set_active(settingsDarkCheck, dark ? 1 : 0)
        shim_check_set_active(settingsCompactCheck, miniMode ? 1 : 0)
        shim_check_set_active(settingsRailCheck, railVisible ? 1 : 0)
        settingsSyncing = false
        shim_widget_show(panel)
    }

    // MARK: - First-run onboarding (username + password)

    /// Friendly login shown over the workspace until the store connects.
    private func buildOnboarding(_ overlay: UnsafeMutablePointer<GtkWidget>?) {
        guard let overlay else { return }
        let backdrop = shim_box_new(0, 0)
        addClass(backdrop, "onboarding")
        shim_widget_fill(backdrop)
        shim_overlay_add_overlay(overlay, backdrop)
        onboardingBackdrop = backdrop

        let card = shim_box_new(0, 12)
        addClass(card, "login-card")
        // Overlay children position themselves by their own alignment within
        // the full overlay area — center the card over the dimmed workspace.
        shim_widget_halign_center(card)
        shim_widget_valign_center(card)
        shim_widget_size(card, 340)

        let title = makeLabel("Welcome to Omperator", "login-title")
        shim_widget_halign_start(title)
        shim_box_append(card, title)

        let subtitle = makeLabel("Sign in to start working on your computer.", "login-subtle")
        shim_widget_halign_start(subtitle)
        shim_box_append(card, subtitle)

        loginEntry = shim_entry()
        addClass(loginEntry, "login-entry")
        shim_entry_set_placeholder(loginEntry, "Username")
        onSignal(loginEntry, "activate") { [weak self] in self?.submitLogin() }
        shim_box_append(card, loginEntry)

        passwordEntry = shim_entry()
        addClass(passwordEntry, "login-entry")
        shim_entry_set_placeholder(passwordEntry, "Password")
        shim_entry_set_visibility(passwordEntry, 0)
        onSignal(passwordEntry, "activate") { [weak self] in self?.submitLogin() }
        shim_box_append(card, passwordEntry)

        loginButton = shim_button("Sign in")
        addClass(loginButton, "login-button")
        shim_widget_expand(loginButton, 1)
        onSignal(loginButton, "clicked") { [weak self] in self?.submitLogin() }
        shim_box_append(card, loginButton)

        loginStatusLabel = makeLabel("", "login-subtle")
        shim_widget_halign_start(loginStatusLabel)
        shim_box_append(card, loginStatusLabel)

        shim_overlay_add_overlay(overlay, card)
        onboardingCard = card
        // Hidden until the store settles without a connection.
        shim_widget_hide(backdrop)
        shim_widget_hide(card)
    }

    /// Drive the onboarding visibility from the refresh loop. Shows the login
    /// only when there is no saved endpoint AND the initial auto-connect to
    /// the local gateway did not come up — a friendly first-run, never a gate
    /// that blocks a working local setup.
    private func refreshOnboarding() {
        guard onboardingArmed, let backdrop = onboardingBackdrop, let card = onboardingCard else { return }
        if store.connected {
            onboardingArmed = false
            if onboardingVisible {
                onboardingVisible = false
                shim_widget_hide(backdrop)
                shim_widget_hide(card)
            }
            return
        }
        // Wait for the restore() attempt to settle before showing: a live
        // local gateway connects on its own and must not flash the login over
        // a working workspace.
        if !onboardingVisible && !store.connecting {
            onboardingVisible = true
            shim_widget_show(backdrop)
            shim_widget_show(card)
        }
    }

    private func submitLogin() {
        guard !loginInProgress else { return }
        guard let loginEntry, let passwordEntry else { return }
        let username = entryText(loginEntry)
        let password = entryText(passwordEntry)
        guard !username.isEmpty, !password.isEmpty else {
            setLoginStatus("Enter your username and password to sign in.", isError: true)
            return
        }
        loginInProgress = true
        setLoginStatus("Signing in…", isError: false)
        shim_widget_sensitive(loginButton, 0)
        let store = self.store
        Task {
            var message: String?
            do {
                try await store.login(username: username, password: password)
                // Account ready — connect to the workspace (local gateway).
                await store.restore()
            } catch {
                message = error.localizedDescription
            }
            self.loginInProgress = false
            shim_widget_sensitive(self.loginButton, 1)
            if let message {
                self.setLoginStatus(message, isError: true)
            } else if !self.store.connected {
                // Signed in, but the workspace hasn't connected yet (local
                // gateway unreachable) — keep the screen up and say so.
                self.setLoginStatus("Signed in — but your computer isn't reachable yet. Try again in a moment.", isError: true)
            }
        }
    }

    private func entryText(_ entry: UnsafeMutablePointer<GtkWidget>) -> String {
        let textC = shim_entry_text(entry)
        return (textC.map { String(cString: $0) } ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func setLoginStatus(_ text: String, isError: Bool) {
        guard let label = loginStatusLabel else { return }
        shim_label_set_text(label, text)
        if isError {
            addClass(label, "login-error")
        } else {
            shim_css_class_remove(label, "login-error")
        }
    }

    // MARK: - Panes sidebar (browser only)

    private func buildPanesSidebar(_ workspace: UnsafeMutablePointer<GtkWidget>?) {
        let sidebar = shim_box_new(0, 6)
        addClass(sidebar, "pane-sidebar")
        shim_widget_size(sidebar, 380)
        paneSidebar = sidebar

        // The sidebar IS the browser pane — no tab strip. Terminal and Files
        // stay available in PanesFactory for future callers, just not offered.
        if let browser = panes.browserWidget(bridge: store) {
            shim_widget_expand(browser, 1)
            shim_widget_expand(browser, 0)
            shim_box_append(sidebar, browser)
        }

        shim_widget_hide(sidebar)
        shim_box_append(workspace, sidebar)

        panes.onURLChanged = { [weak self] url in
            guard let self, let session = self.store.selectedSession else { return }
            self.store.setBrowserURL(for: session.sessionId, url: url)
        }
    }

    private func togglePanes() {
        paneVisible.toggle()
        guard let sidebar = paneSidebar else { return }
        if paneVisible { shim_widget_show(sidebar) } else { shim_widget_hide(sidebar) }
    }

    private func toggleRail() {
        railVisible.toggle()
        guard let rail = railBox else { return }
        if railVisible { shim_widget_show(rail) } else { shim_widget_hide(rail) }
    }

    // MARK: - Mini mode

    private func toggleMiniMode() {
        miniMode.toggle()
        guard let win = window else { return }
        if miniMode {
            // Save the full geometry, then go compact: hide sidebars, shrink.
            var w: Int32 = 0, h: Int32 = 0
            shim_window_get_size(win, &w, &h)
            fullSize = (Int(w), Int(h))
            if railVisible { railVisible = false; railBox.map { shim_widget_hide($0) } }
            if paneVisible { paneVisible = false; paneSidebar.map { shim_widget_hide($0) } }
            shim_window_resize(win, 440, 560)
            CompositorPin.setPinned(true, window: win)
        } else {
            // Restore: full size, sidebars back, unpin.
            CompositorPin.setPinned(false, window: win)
            if let size = fullSize { shim_window_resize(win, Int32(size.width), Int32(size.height)) }
            railVisible = true
            railBox.map { shim_widget_show($0) }
            // The pane sidebar restores to its pre-mini visibility only if it was open.
        }
    }

    private func refreshPanes() {
        guard paneVisible, let session = store.selectedSession else { return }
        panes.loadURL(store.browserURL(for: session.sessionId))
    }

    private func toggleTheme() {
        dark.toggle()
        applyTheme()
    }

    private func applyTheme() {
        let name = dark ? "theme-moon" : "theme-dawn"
        if let css = Bundle.module.url(forResource: name, withExtension: "css", subdirectory: "themes") {
            shim_css_load(css.path)
        }
        applyTagTheme()
    }

    // MARK: - Theme tags

    /// Re-tint every transcript tag the widget factory owns for the active
    /// theme (dark = Rosé Pine Moon, light = Dawn).
    private func applyTagTheme() {
        transcriptWidgets.applyTheme(dark: dark)
    }

    // MARK: - Store bridge

    private func startRefreshTimer() {
        // Kick off the async connect.
        Task { [store] in
            await store.restore()
        }
        // Poll the store's state and repaint what changed. GLib owns the loop;
        // the main actor is pumped by installMainActorPump().
        g_timeout_add(33, { userData in
            guard let userData else { return gboolean(0) }
            let win = Unmanaged<AppWindow>.fromOpaque(userData).takeUnretainedValue()
            MainActor.assumeIsolated { win.refresh() }
            return gboolean(1)
        }, Unmanaged.passUnretained(self).toOpaque())
    }

    private func refresh() {
        refreshConnection()
        refreshRail()
        refreshRailTimes()
        refreshOnboarding()
        refreshTranscript()
        refreshCaptures()
        refreshStreaming()
        refreshPanes()
    }

    /// Preview captures render as image rows at the transcript tail. New
    /// captures append once (tracked by captureId); a row whose texture is
    /// still in flight (chunked capture.read) gets it on a later refresh.
    private func refreshCaptures() {
        guard let selected = store.selectedSession, let box = transcriptBox else { return }
        let sid = selected.sessionId
        var changed = false
        for row in store.previewCaptureRows(for: sid) {
            if let pic = pendingCapturePictures[row.captureId] {
                if let data = store.captureImageData(row.captureId),
                   let texture = AppWindow.texture(from: data) {
                    shim_picture_set_texture(pic, texture)
                    shim_unref(texture)
                    shim_widget_show(pic)
                    pendingCapturePictures.removeValue(forKey: row.captureId)
                    changed = true
                }
                continue
            }
            guard !renderedCaptureIds.contains(row.captureId) else { continue }
            renderedCaptureIds.append(row.captureId)
            let pic = shim_picture()
            shim_picture_fit(pic)
            shim_widget_size_wh(pic, -1, 220)
            addClass(pic, "transcript-image")
            // Hidden until the capture texture resolves (in-flight fetch).
            shim_widget_hide(pic)
            if let data = store.captureImageData(row.captureId),
               let texture = AppWindow.texture(from: data) {
                shim_picture_set_texture(pic, texture)
                shim_unref(texture)
                shim_widget_show(pic)
            } else {
                pendingCapturePictures[row.captureId] = pic
            }
            shim_box_append(box, pic)
            let captureId = row.captureId
            onPressed(pic) { [weak self] in
                guard let self,
                      let data = self.store.captureImageData(captureId),
                      let texture = AppWindow.texture(from: data) else { return }
                self.showLightbox(texture)
                shim_unref(texture)
            }
            changed = true
        }
        if changed { scrollTranscriptToBottom() }
    }

    private func refreshConnection() {
        let connected = store.connected
        let error = store.lastError
        let title = store.selectedSession?.title ?? ""
        guard connected != lastConnected || error != lastError || title != lastTitle else { return }
        lastConnected = connected
        lastError = error
        lastTitle = title
        let text: String
        if !title.isEmpty {
            text = title
        } else if let error, !error.isEmpty {
            text = "⚠ \(error)"
        } else {
            text = connected ? "● connected" : "○ connecting…"
        }
        shim_label_set_text(statusLabel, text)
    }

    private func railSearchChanged() {
        railSearchText = railSearchEntry.map { String(cString: shim_entry_text($0)) } ?? ""
        lastRailSignature = ""  // force a rebuild
    }

    private func setRailGrouping(_ mode: RailGrouping) {
        guard railGrouping != mode else { return }
        railGrouping = mode
        updateRailSegmentStates()
        lastRailSignature = ""  // force a rebuild
    }

    /// Highlight the active segment (gold) and dim the rest.
    private func updateRailSegmentStates() {
        for (mode, button) in railSegmentButtons {
            if mode == railGrouping {
                addClass(button, "rail-segment-active")
            } else {
                removeClass(button, "rail-segment-active")
            }
        }
    }

    private func needsYou(_ session: SessionRef) -> Bool {
        (session.pendingApproval ?? false) || (session.pendingUserInput ?? false)
    }

    private func railMatches(_ session: SessionRef, query: String) -> Bool {
        if query.isEmpty { return true }
        if session.title.lowercased().contains(query) { return true }
        if let name = session.project.name, name.lowercased().contains(query) { return true }
        if session.status.lowercased().contains(query) { return true }
        if let model = session.model, model.lowercased().contains(query) { return true }
        return false
    }

    private func refreshRail() {
        let sessions = store.sessions
        let needsYouIds = sessions.filter(needsYou).map(\.sessionId).sorted().joined()
        let signature = "\(railGrouping.rawValue)|\(railSearchText)|\(sessions.count)|\(needsYouIds)"
        guard signature != lastRailSignature else { return }
        lastRailSignature = signature
        rebuildRail(sessions)
    }

    private func rebuildRail(_ sessions: [SessionRef]) {
        guard let railList else { return }
        var child = gtk_widget_get_first_child(railList)
        while let c = child {
            let next = gtk_widget_get_next_sibling(c)
            shim_widget_destroy(c)
            child = next
        }
        railRows.removeAll()
        railTimeLabels.removeAll()

        let query = railSearchText.lowercased().trimmingCharacters(in: .whitespaces)
        let filtered = sessions.filter { railMatches($0, query: query) }
        let byRecency = { (a: SessionRef, b: SessionRef) in a.updatedAt > b.updatedAt }
        let needsYouList = filtered.filter(needsYou).sorted(by: byRecency)
        let rest = filtered.filter { !needsYou($0) }.sorted(by: byRecency)

        // Pinned "Needs you" section at the top of every grouping mode.
        if !needsYouList.isEmpty {
            appendRailSection("Needs you", needsYouList)
        }

        switch railGrouping {
        case .recency:
            appendRailRows(rest)
        case .project:
            var seen: [String] = []
            var groups: [String: [SessionRef]] = [:]
            for session in rest {
                let key = session.project.name?.isEmpty == false ? session.project.name! : "No project"
                if groups[key] == nil { seen.append(key) }
                groups[key, default: []].append(session)
            }
            for key in seen.sorted(by: { $0.lowercased() < $1.lowercased() }) {
                appendRailSection(key, groups[key] ?? [])
            }
        case .status:
            var seen: [String] = []
            var groups: [String: [SessionRef]] = [:]
            for session in rest {
                let key = session.status.isEmpty ? "Unknown" : session.status
                if groups[key] == nil { seen.append(key) }
                groups[key, default: []].append(session)
            }
            for key in seen.sorted(by: { $0.lowercased() < $1.lowercased() }) {
                appendRailSection(key, groups[key] ?? [])
            }
        }
    }

    private func appendRailSection(_ title: String, _ sessions: [SessionRef]) {
        guard let railList, !sessions.isEmpty else { return }
        let header = makeLabel(title, "rail-section")
        shim_widget_halign_start(header)
        shim_box_append(railList, header)
        appendRailRows(sessions)
    }

    private func appendRailRows(_ sessions: [SessionRef]) {
        guard let railList else { return }
        for session in sessions.prefix(80) {
            let row = shim_box_new(0, 2)
            addClass(row, "rail-item")
            let title = makeLabel(session.title.isEmpty ? "Untitled session" : session.title, nil)
            shim_widget_halign_start(title)
            shim_box_append(row, title)
            let time = makeLabel(relativeTime(session.updatedAt), "muted")
            shim_widget_halign_start(time)
            shim_box_append(row, time)
            let captured = session.sessionId
            onPressed(row) { [weak self] in
                guard let self else { return }
                let store = self.store
                if let target = store.sessions.first(where: { $0.sessionId == captured }) {
                    store.select(target)
                }
            }
            shim_box_append(railList, row)
            railRows[session.sessionId] = row
            railTimeLabels[session.sessionId] = time
        }
    }

    /// Re-render the rail's relative-time labels on a slow cadence so "2m ago"
    /// stays truthful without rebuilding the rows every frame.
    private func refreshRailTimes() {
        let now = Date().timeIntervalSince1970
        guard now - lastRailTimeRefresh >= 60 else { return }
        lastRailTimeRefresh = now
        for session in store.sessions.prefix(80) {
            guard let label = railTimeLabels[session.sessionId] else { continue }
            shim_label_set_text(label, relativeTime(session.updatedAt))
        }
    }

    /// Friendly relative recency for the rail: "just now", "5m ago", "2h ago",
    /// "yesterday", "3d ago", then the month-day ("Aug 3").
    private func relativeTime(_ iso: String) -> String {
        guard let date = Self.isoFormatter.date(from: iso) else { return "" }
        let minutes = Int(Date().timeIntervalSince(date) / 60)
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes)m ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h ago" }
        if hours < 48 { return "yesterday" }
        let days = hours / 24
        if days < 7 { return "\(days)d ago" }
        return Self.dayFormatter.string(from: date)
    }

    private static let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        // .withFractionalSeconds is required to parse host timestamps that
        // carry millisecond precision (e.g. "2026-01-01T00:00:00.000Z");
        // plain second-precision timestamps parse with the same options.
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d"
        return formatter
    }()

    private func refreshTranscript() {
        guard let selected = store.selectedSession else { return }
        let sid = selected.sessionId
        if sid != lastSelectedId {
            // Leaving the previous session: remember its scroll position.
            if !lastSelectedId.isEmpty, let scroll = transcriptScroll {
                scrollPositions[lastSelectedId] = shim_scroll_get(scroll)
            }
            lastSelectedId = sid
            renderedSessionId = sid
            renderedEntryCount = 0
            renderedCaptureIds = []
            pendingCapturePictures = [:]
            clearTranscript()
            // Restore the incoming session's saved position, or open at the
            // bottom on first visit. Deferred so the content has laid out.
            let saved = scrollPositions[sid]
            pinnedToBottom = saved == nil
            let box = GtkBox { [weak self] in self?.restoreScroll(saved) }
            shim_idle(idleForwarder, Unmanaged.passRetained(box).toOpaque())
        }
        let entries = store.transcript(for: sid)
        if entries.count < renderedEntryCount {
            clearTranscript()
            renderedEntryCount = 0
        }
        guard entries.count > renderedEntryCount else { return }
        let newEntries = entries[renderedEntryCount...]
        for entry in newEntries { appendEntry(entry) }
        renderedEntryCount = entries.count
        scrollTranscriptToBottom()
    }

    private func restoreScroll(_ saved: Double?) {
        guard let scroll = transcriptScroll else { return }
        programmaticScroll = true
        if let saved {
            shim_scroll_set(scroll, saved)
        } else {
            shim_scroll_to_max(scroll)
        }
        programmaticScroll = false
    }

    private func clearTranscript() {
        guard let box = transcriptBox else { return }
        shim_box_clear(box)
    }

    private func appendEntry(_ entry: TranscriptEntry) {
        guard let box = transcriptBox else { return }
        if let widget = transcriptWidgets.buildEntry(entry) {
            shim_box_append(box, widget)
        }
    }

    /// Live assistant text while a turn is streaming — appended at the
    /// transcript's tail and replaced as it grows; removed when the turn
    /// settles (the durable entry takes over).
    private func refreshStreaming() {
        guard let selected = store.selectedSession, let box = transcriptBox else { return }
        let sid = selected.sessionId
        let text = store.streamingText(for: sid)
        if text.isEmpty {
            if let label = streamingLabel {
                shim_widget_destroy(label)
                streamingLabel = nil
                lastStreamedText = ""
            }
            return
        }
        guard text != lastStreamedText else { return }
        lastStreamedText = text
        if streamingLabel == nil {
            let label = makeLabel("", "assistant-message")
            shim_label_wrap_words(label)
            shim_label_selectable(label)
            shim_widget_halign_start(label)
            shim_box_append(box, label)
            streamingLabel = label
        }
        shim_label_set_text(streamingLabel, text)
        scrollTranscriptToBottom()
    }

    private func scrollTranscriptToBottom() {
        // Only auto-scroll while the user is pinned near the bottom; scrolling
        // up during a stream must not fight the reader.
        guard pinnedToBottom, let scroll = transcriptScroll else { return }
        scrollToBottomProgrammatically(scroll)
    }

    /// Auto-scroll helper: marks the value-change as app-initiated so the pin
    /// handler doesn't mistake it for a user scroll and release the pin.
    private func scrollToBottomProgrammatically(_ scroll: UnsafeMutablePointer<GtkWidget>) {
        programmaticScroll = true
        shim_scroll_to_max(scroll)
        programmaticScroll = false
    }

    /// Frame-tick follow: after layout each frame, if pinned and the content
    /// grew since the last tick, scroll to the (now-final) bottom. Runs the
    /// scroll only on change, so it costs a float compare per frame when idle.
    private func scrollFollowTick() {
        guard pinnedToBottom, let scroll = transcriptScroll, let adj = shim_vadj(scroll) else { return }
        let upper = shim_adj_upper(adj)
        guard upper != lastTickUpper else { return }
        lastTickUpper = upper
        scrollToBottomProgrammatically(scroll)
    }

    /// Recompute the pin from the live scroll position (fires on value-changed).
    /// Content growth moves `upper` while `value` holds — that is NOT a user
    /// scroll, so we only change the pin when `value` itself moved.
    private func updateScrollPin() {
        guard let scroll = transcriptScroll, let adj = shim_vadj(scroll) else { return }
        let value = shim_adj_value(adj)
        let upper = shim_adj_upper(adj)
        let page = shim_adj_page(adj)
        lastScrollValue = value
        lastScrollUpper = upper
        // Only the user's own scrolls move the pin. Our auto-scroll-to-bottom
        // (programmaticScroll) must not release it — otherwise the pin switches
        // itself off mid-stream whenever the page grows during the scroll.
        guard !programmaticScroll else { return }
        if value + page >= upper - 48 {
            pinnedToBottom = true
        } else {
            pinnedToBottom = false
        }
    }

    // MARK: - Composer

    private func submitComposer() {
        guard let buffer = composerBuffer, let selected = store.selectedSession else { return }
        let textC = shim_buffer_text(buffer)
        let text = textC.map { String(cString: $0) } ?? ""
        shim_free(textC)
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let images = attachments.map { T4GtkBridge.GtkPromptImage(data: $0.data, mimeType: $0.mimeType) }
        guard !trimmed.isEmpty || !images.isEmpty else { return }
        shim_buffer_set_text(buffer, "")
        if let view = composerView { shim_text_scroll_cursor(view) }
        attachments = []
        rebuildAttachmentStrip()
        // Sending a message means "watch this turn": re-pin to the bottom so
        // the reply streams into view (the user may have released the pin by
        // scrolling up to read earlier).
        pinnedToBottom = true
        let store = self.store
        let sid = selected.sessionId
        Task { await store.sendPrompt(sessionId: sid, text: trimmed, images: images) }
    }

    // MARK: - Composer attachments

    /// Wire limit (promptImageMaxCount): no more than 8 images per prompt.
    private static let maxAttachments = 8

    private func addAttachment(data: Data, mimeType: String, name: String) {
        guard attachments.count < Self.maxAttachments else { return }
        attachments.append(Attachment(id: UUID(), data: data, mimeType: mimeType, name: name))
        rebuildAttachmentStrip()
    }

    private func removeAttachment(id: UUID) {
        attachments.removeAll { $0.id == id }
        rebuildAttachmentStrip()
    }

    private func rebuildAttachmentStrip() {
        guard let strip = attachStrip else { return }
        shim_box_clear(strip)
        for attachment in attachments {
            let chip = shim_box_new(0, 4)
            addClass(chip, "attachment-chip")
            if let texture = Self.texture(from: attachment.data) {
                let pic = shim_picture()
                shim_picture_fit(pic)
                shim_widget_size_wh(pic, 40, 40)
                shim_picture_set_texture(pic, texture)
                // Click the staged thumbnail to preview it full-size.
                onPressed(pic) { [weak self] in self?.showLightbox(texture) }
                shim_box_append(chip, pic)
            }
            if let nameLabel = makeLabel(attachment.name, "chip-name") {
                shim_box_append(chip, nameLabel)
            }
            let remove = shim_button("✕")
            addClass(remove, "chip-remove")
            onSignal(remove, "clicked") { [weak self] in self?.removeAttachment(id: attachment.id) }
            shim_box_append(chip, remove)
            shim_box_append(strip, chip)
        }
        if attachments.isEmpty { shim_widget_hide(strip) } else { shim_widget_show(strip) }
    }

    /// Decode image bytes into a GDK texture (nil when undecodable).
    static func texture(from data: Data) -> UnsafeMutableRawPointer? {
        data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return nil }
            return shim_texture_from_bytes(base.assumingMemoryBound(to: UInt8.self), UInt(raw.count))
        }
    }

    private func attachFiles(_ paths: [String]) {
        for path in paths {
            guard let mime = Self.imageMimeType(for: path),
                  let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { continue }
            addAttachment(data: data, mimeType: mime, name: URL(fileURLWithPath: path).lastPathComponent)
        }
    }

    static func imageMimeType(for path: String) -> String? {
        switch URL(fileURLWithPath: path).pathExtension.lowercased() {
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "gif": return "image/gif"
        default: return nil
        }
    }

    private func openImagePicker() {
        installPathsHandlerIfNeeded()
        let box = GtkPathsBox(releaseAfterUse: true) { [weak self] paths in self?.attachFiles(paths) }
        shim_open_images_dialog(window, Unmanaged.passRetained(box).toOpaque())
    }

    /// One clipboard read at a time (GDK X11 races concurrent selection
    /// reads; the shim guard is the backstop, this avoids even starting).
    private var pasteInFlight = false

    private func pasteClipboardImage(view: UnsafeMutablePointer<GtkWidget>?) {
        guard !pasteInFlight else { return }
        pasteInFlight = true
        installClipboardBytesHandlerIfNeeded()
        let box = GtkClipboardBox { [weak self] data, mime in
            guard let self, let data, !data.isEmpty else { self?.pasteInFlight = false; return }
            self.pasteInFlight = false
            let mimeType = mime ?? "image/png"
            self.addAttachment(data: data, mimeType: mimeType, name: "pasted-image.\(Self.imageExtension(for: mimeType))")
        }
        let boxPtr = Unmanaged.passRetained(box).toOpaque()
        // Initiate the async read from an idle, not mid key-signal dispatch —
        // the X11 selection request doesn't reliably go out from inside a
        // key-pressed emission on this stack.
        let start = GtkBox { shim_clipboard_read_image(view, boxPtr) }
        shim_idle(idleForwarder, Unmanaged.passRetained(start).toOpaque())
    }

    static func imageExtension(for mimeType: String) -> String {
        switch mimeType {
        case "image/jpeg": return "jpg"
        case "image/webp": return "webp"
        case "image/gif": return "gif"
        default: return "png"
        }
    }

    // MARK: - Image lightbox

    func showLightbox(_ texture: UnsafeMutableRawPointer) {
        guard let root = rootOverlay, lightbox == nil else { return }
        let backdrop = shim_box_new(0, 0)
        addClass(backdrop, "lightbox-backdrop")
        shim_widget_fill(backdrop)
        let pic = shim_picture()
        shim_picture_fit(pic)
        shim_picture_set_texture(pic, texture)
        shim_widget_margins(pic, 40)
        shim_box_append(backdrop, pic)
        onPressed(backdrop) { [weak self] in self?.hideLightbox() }
        shim_overlay_add_overlay(root, backdrop)
        lightbox = backdrop
    }

    private func hideLightbox() {
        guard let root = rootOverlay, let lb = lightbox else { return }
        lightbox = nil
        shim_overlay_remove(root, lb)
    }
}
