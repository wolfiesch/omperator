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
    private var stopButton: UnsafeMutablePointer<GtkWidget>?
    private var queueButton: UnsafeMutablePointer<GtkWidget>?
    private var queueStrip: UnsafeMutablePointer<GtkWidget>?
    private var composerTurnActive = false
    private var composerBusy = false
    private var composerChromeSessionId = ""
    private var lastQueueSignature = ""
    private var confirmingCancel = false

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
    private var railWrapperBox: UnsafeMutablePointer<GtkWidget>?
    private var railRevealer: UnsafeMutablePointer<GtkWidget>?
    private var railVisible = true
    /// Rail width, persisted across launches (clamped to the resize bounds).
    private var railWidth: Int = {
        let v = UserDefaults.standard.object(forKey: "t4.railWidth") as? Int ?? 232
        return min(400, max(180, v))
    }()
    private var railDragStartWidth = 0
    /// Right panes sidebar width, persisted.
    private var paneWidth: Int = {
        let v = UserDefaults.standard.object(forKey: "t4.paneWidth") as? Int ?? 380
        return min(600, max(280, v))
    }()
    private var paneDragStartWidth = 0
    private var paneDividerBox: UnsafeMutablePointer<GtkWidget>?
    private var railDividerBox: UnsafeMutablePointer<GtkWidget>?
    private var miniButton: UnsafeMutablePointer<GtkWidget>?
    private var miniMode = false
    private var fullSize: (width: Int, height: Int)?
    /// Settled transcript rows (and captures). Live streaming widgets live in
    /// `liveTailBox` so a growing turn never lands above later durable rows.
    private var durableBox: UnsafeMutablePointer<GtkWidget>?
    private var liveTailBox: UnsafeMutablePointer<GtkWidget>?
    private var liveWidgets: [String: LiveStreamWidget] = [:]
    private var liveOrder: [String] = []
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
        transcriptWidgets.onCopyMenu = { [weak self] x, y, items in self?.showCopyMenu(x: x, y: y, items: items) }
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

    /// Bring the existing window forward. A second app launch while one is
    /// already running delivers a remote "activate" (GApplication forwards it
    /// and the new process exits) — present the window, never rebuild it.
    func present() {
        if let window { shim_window_present(window) }
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
        onKey(win) { [weak self] keyval, state in
            guard let self else { return false }
            if keyval == gdkKeyEscape, self.lightbox != nil {
                self.hideLightbox()
                return true
            }
            if (keyval == gdkKeyN || keyval == gdkKeyNUpper), (state & gdkControlMask) != 0 {
                self.newSession()
                return true
            }
            if (keyval == gdkKeyB || keyval == gdkKeyBUpper), (state & gdkControlMask) != 0 {
                self.toggleRail()
                return true
            }
            return false
        }

        // Rail (left), wrapped in a revealer for the slide popout/popin.
        // Revealer reports the animated width as its measure, so the
        // transcript column reflows with the clip instead of snapping.
        let rail = shim_box_new(0, 0)
        railBox = rail
        addClass(rail, "rail")
        shim_widget_size(rail, Int32(railWidth))
        // Wrapper so open/close animates as ONE layout child (rail+divider move together, no double-relayout stutter)
        let railWrapper = shim_box_new(1, 0)
        shim_set_overflow_hidden(railWrapper)
        shim_set_halign_start(railWrapper)
        railWrapperBox = railWrapper
        shim_box_append(railWrapper, rail)
        let railDivider = makeRailDivider()
        railDividerBox = railDivider
        shim_box_append(railWrapper, railDivider)
        let railRevealer = shim_revealer()
        shim_revealer_set_child(railRevealer, railWrapper)
        shim_revealer_set_reveal(railRevealer, 1)
        self.railRevealer = railRevealer
        shim_box_append(workspace, railRevealer)

        let railHeader = shim_box_new(1, 6)
        let railTitle = makeLabel("Sessions", "subtle")
        shim_widget_halign_start(railTitle)
        shim_box_append(railHeader, railTitle)
        // New session: creates untitled in the selected session's project
        // (fallback: first known project), then selects it — the iOS flow.
        let newButton = shim_button("+")
        addClass(newButton, "flat-btn")
        onSignal(newButton, "clicked") { [weak self] in self?.newSession() }
        shim_box_append(railHeader, newButton)
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

        // Grouping picker: Recent (Active / Inactive, recency within each) or
        // Project. Segmented buttons, not a GtkDropDown — the dropdown's popup
        // crashed (its notify::selected signal has a 3-arg signature the
        // onSignal trampoline doesn't handle) and its translucent closed state
        // clashed with the rail. Buttons use the plain 2-arg "clicked" signal.
        let segmented = shim_box_new(1, 0)
        addClass(segmented, "rail-segmented")
        railSegmentButtons.removeAll()
        for mode in [RailGrouping.recency, .project] {
            let label = mode == .recency ? "Recent" : "Project"
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
        // Chat convention: a transcript shorter than the viewport sinks to
        // the bottom so the conversation grows upward from the composer; once
        // content exceeds the viewport, valign END is a no-op and the
        // scrolled window + bottom-pin take over.
        shim_widget_valign_end(box)
        transcriptBox = box
        let durable = shim_box_new(0, 10)
        durableBox = durable
        shim_box_append(box, durable)
        let live = shim_box_new(0, 8)
        liveTailBox = live
        shim_box_append(box, live)
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

        let composer = shim_box_new(0, 8)
        addClass(composer, "composer")

        let queues = shim_box_new(0, 4)
        addClass(queues, "queue-strip")
        shim_widget_hide(queues)
        queueStrip = queues
        shim_box_append(composer, queues)

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

        let stop = shim_button("Stop")
        addClass(stop, "stop-button")
        shim_widget_hide(stop)
        onSignal(stop, "clicked") { [weak self] in self?.stopComposer() }
        stopButton = stop
        shim_box_append(inputRow, stop)

        let queue = shim_button("Queue")
        addClass(queue, "queue-button")
        shim_widget_hide(queue)
        onSignal(queue, "clicked") { [weak self] in self?.queueComposer() }
        queueButton = queue
        shim_box_append(inputRow, queue)

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
        shim_widget_size(sidebar, Int32(paneWidth))
        paneSidebar = sidebar

        // The sidebar IS the browser pane — no tab strip. Terminal and Files
        // stay available in PanesFactory for future callers, just not offered.
        if let browser = panes.browserWidget(bridge: store) {
            shim_widget_expand(browser, 1)
            shim_widget_expand(browser, 0)
            shim_box_append(sidebar, browser)
        }

        shim_widget_hide(sidebar)
        let paneDivider = makePaneDivider()
        paneDividerBox = paneDivider
        shim_widget_hide(paneDivider)
        shim_box_append(workspace, paneDivider)
        shim_box_append(workspace, sidebar)

        panes.onURLChanged = { [weak self] url in
            guard let self, let session = self.store.selectedSession else { return }
            self.store.setBrowserURL(for: session.sessionId, url: url)
        }
    }

    /// Slide the session rail open or closed. `animated: false` is for
    /// mini-mode, where the window itself is resizing in the same beat.
    private func setRailVisible(_ visible: Bool, animated: Bool = true) {
        guard let revealer = railRevealer else { return }
        railVisible = visible
        // Drop leftover size requests from the old tick animation so the
        // revealer can measure the child's natural width (rail + divider).
        if let wrapper = railWrapperBox { shim_widget_size(wrapper, -1) }
        railWrapperBox.map { shim_widget_show($0) }
        railBox.map { shim_widget_show($0) }
        railDividerBox.map { shim_widget_show($0) }
        if !animated { shim_revealer_set_duration(revealer, 0) }
        shim_revealer_set_reveal(revealer, visible ? 1 : 0)
        if !animated { shim_revealer_set_duration(revealer, 220) }
        if let check = settingsRailCheck {
            settingsSyncing = true
            shim_check_set_active(check, visible ? 1 : 0)
            settingsSyncing = false
        }
    }

    private func toggleRail() {
        setRailVisible(!railVisible)
    }

    /// Drag handle between the rail and the transcript. Dragging left of the
    /// min width snaps the rail closed; dragging right of the collapsed edge
    /// reopens it. Width clamps to 180-400 and persists across launches.
    private func makeRailDivider() -> UnsafeMutablePointer<GtkWidget> {
        let divider = shim_box_new(0, 0)!
        addClass(divider, "pane-divider")
        shim_set_col_resize_cursor(divider)
        onDrag(divider) { [weak self] ox, _, phase in
            guard let self else { return }
            switch phase {
            case 2: self.railDragStartWidth = self.railWidth
            case 0: self.applyRailDrag(offsetX: ox)
            case 1: self.finishRailDrag(offsetX: ox)
            default: break
            }
        }
        return divider
    }

    private func applyRailDrag(offsetX: Double) {
        guard let rail = railBox else { return }
        let proposed = railDragStartWidth + Int(offsetX)
        if proposed < 160 {
            if railVisible { setRailVisible(false) }
            return
        }
        if !railVisible { setRailVisible(true) }
        let clamped = min(400, max(180, proposed))
        railWidth = clamped
        shim_widget_size(rail, Int32(clamped))
    }

    private func finishRailDrag(offsetX: Double) {
        applyRailDrag(offsetX: offsetX)
        UserDefaults.standard.set(railWidth, forKey: "t4.railWidth")
    }

    private func togglePanes() {
        paneVisible.toggle()
        guard let sidebar = paneSidebar else { return }
        if paneVisible {
            paneDividerBox.map { shim_widget_show($0) }
            shim_widget_show(sidebar)
        } else {
            shim_widget_hide(sidebar)
            paneDividerBox.map { shim_widget_hide($0) }
        }
    }

    private func makePaneDivider() -> UnsafeMutablePointer<GtkWidget> {
        let divider = shim_box_new(0, 0)!
        addClass(divider, "pane-divider")
        shim_set_col_resize_cursor(divider)
        onDrag(divider) { [weak self] ox, _, phase in
            guard let self else { return }
            switch phase {
            case 2: self.paneDragStartWidth = self.paneWidth
            case 0: self.applyPaneDrag(offsetX: ox)
            case 1: self.finishPaneDrag(offsetX: ox)
            default: break
            }
        }
        return divider
    }

    private func applyPaneDrag(offsetX: Double) {
        guard let sidebar = paneSidebar else { return }
        // Dragging the pane divider LEFT widens the sidebar.
        let clamped = min(600, max(280, paneDragStartWidth - Int(offsetX)))
        paneWidth = clamped
        shim_widget_size(sidebar, Int32(clamped))
    }

    private func finishPaneDrag(offsetX: Double) {
        applyPaneDrag(offsetX: offsetX)
        UserDefaults.standard.set(paneWidth, forKey: "t4.paneWidth")
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
            if railVisible { setRailVisible(false, animated: false) }
            if paneVisible { paneVisible = false; paneDividerBox.map { shim_widget_hide($0) }; paneSidebar.map { shim_widget_hide($0) } }
            shim_window_resize(win, 440, 560)
            CompositorPin.setPinned(true, window: win)
        } else {
            // Restore: full size, sidebars back, unpin.
            CompositorPin.setPinned(false, window: win)
            if let size = fullSize { shim_window_resize(win, Int32(size.width), Int32(size.height)) }
            if let rail = railBox { shim_widget_size(rail, Int32(railWidth)) }
            setRailVisible(true, animated: false)
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

    /// Holds the window controller strongly for the lifetime of the refresh
    /// timeout source. The source's GLib destroy notify releases the box, so
    /// the tick can never retain a freed AppWindow no matter how the owning
    /// reference is dropped while the main loop is still running.
    private final class RefreshTimerBox {
        let controller: AppWindow
        init(_ controller: AppWindow) { self.controller = controller }
    }

    private let refreshTimerRelease: @convention(c) (UnsafeMutableRawPointer?) -> Void = { userData in
        guard let userData else { return }
        Unmanaged<RefreshTimerBox>.fromOpaque(userData).release()
    }

    private func startRefreshTimer() {
        // Kick off the async connect.
        Task { [store] in
            await store.restore()
        }
        // Poll the store's state and repaint what changed. GLib owns the loop;
        // the main actor is pumped by installMainActorPump(). The box keeps
        // `self` alive for the source's whole lifetime (passRetained here,
        // released by refreshTimerRelease when the source is destroyed), so a
        // repeated GApplication activation can never leave this tick retaining
        // a freed controller.
        let box = RefreshTimerBox(self)
        let userData = Unmanaged.passRetained(box).toOpaque()
        g_timeout_add_full(0, 33, { userData in
            guard let userData else { return gboolean(0) }
            let box = Unmanaged<RefreshTimerBox>.fromOpaque(userData).takeUnretainedValue()
            MainActor.assumeIsolated { box.controller.refresh() }
            return gboolean(1)
        }, userData, refreshTimerRelease)
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
        refreshComposer()
        refreshCancelConfirmation()
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
            shim_box_append(durableBox ?? box, pic)
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
        if (railIsActive(session) ? "active" : "inactive").contains(query) { return true }
        if let label = railStatusLabel(session.status), label.lowercased().contains(query) { return true }
        if let model = session.model, model.lowercased().contains(query) { return true }
        return false
    }

    private func refreshRail() {
        let sessions = store.sessions
        let needsYouIds = sessions.filter(needsYou).map(\.sessionId).sorted().joined()
        let statusFingerprint = sessions.map { "\($0.sessionId):\($0.status)" }.joined()
        let selectedId = store.selectedSession?.sessionId ?? ""
        let liveIds = sessions.filter(railIsActive).map(\.sessionId).sorted().joined()
        let signature = "\(railGrouping.rawValue)|\(railSearchText)|\(sessions.count)|\(needsYouIds)|\(statusFingerprint)|\(selectedId)|\(liveIds)"
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
            // Two stacks only: live work vs everything else. Idle is the
            // default living state, not a third bucket or a row marker.
            appendRailSection("Active", rest.filter(railIsActive))
            appendRailSection("Inactive", rest.filter { !railIsActive($0) })
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
            let meta = shim_box_new(1, 6)
            if let status = railStatusLabel(session.status) {
                let statusLabel = makeLabel(status, "muted")
                shim_widget_halign_start(statusLabel)
                shim_box_append(meta, statusLabel)
            }
            let time = makeLabel(relativeTime(session.updatedAt), "muted")
            shim_widget_halign_start(time)
            shim_box_append(meta, time)
            shim_widget_halign_start(meta)
            shim_box_append(row, meta)
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

    /// Live work vs parked/stopped. Host `status` is usually `idle` even for
    /// the chat in hand, so Active is: the open session, a local live turn,
    /// or liveState/working flags — not the inventory string.
    private func railIsActive(_ session: SessionRef) -> Bool {
        if store.selectedSession?.sessionId == session.sessionId { return true }
        if store.hasLiveTurn(sessionId: session.sessionId) { return true }
        switch session.status.lowercased() {
        case "active", "working": return true
        default: return railLiveStateWorking(session)
        }
    }

    /// Web's `sessionIsWorking` liveState signals. Extra activity lives here
    /// when the catalog ref stays idle.
    private func railLiveStateWorking(_ session: SessionRef) -> Bool {
        guard case .object(let live) = session.liveState else { return false }
        if case .string(let phase) = live["phase"] {
            switch phase.lowercased() {
            case "working", "running", "active", "streaming", "compacting", "queued",
                 "waiting", "awaiting-input", "awaiting_input":
                return true
            default: break
            }
        }
        func flag(_ key: String) -> Bool {
            if case .bool(true) = live[key] { return true }
            return false
        }
        if flag("working") || flag("isWorking") || flag("isRunning") || flag("turnActive")
            || flag("inFlight") || flag("isStreaming") || flag("isCompacting")
        {
            return true
        }
        if case .number(let n) = live["queuedMessageCount"], n > 0 { return true }
        if case .number(let n) = live["queue"], n > 0 { return true }
        if case .array(let a) = live["queuedMessages"], !a.isEmpty { return true }
        if case .array(let a) = live["queue"], !a.isEmpty { return true }
        return false
    }

    /// Exceptional row labels only. Idle/active/closed are the Recents groups
    /// (or silence), not per-row stamps.
    private func railStatusLabel(_ status: String) -> String? {
        switch status.lowercased() {
        case "error", "failed": return "Error"
        default: return nil
        }
    }

    /// "+" in the rail header: open a local draft session instantly (the
    /// host session is created in the background on the first prompt).
    private func newSession() {
        store.startDraftSession()
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
        if let durable = durableBox { shim_box_clear(durable) }
        if let live = liveTailBox { shim_box_clear(live) }
        liveWidgets.removeAll()
        liveOrder.removeAll()
    }

    private func appendEntry(_ entry: TranscriptEntry) {
        guard let box = durableBox else { return }
        if let widget = transcriptWidgets.buildEntry(entry) {
            shim_box_append(box, widget)
        }
    }

    private struct LiveStreamWidget {
        var root: UnsafeMutablePointer<GtkWidget>
        var body: UnsafeMutablePointer<GtkWidget>?
        var committed: UnsafeMutablePointer<GtkWidget>?
        var tail: UnsafeMutablePointer<GtkWidget>?
        var buffer: UnsafeMutablePointer<GtkTextBuffer>?
        var chevron: UnsafeMutablePointer<GtkWidget>?
        var lastText = ""
        var lastCommitted = ""
        var lastTail = ""
        var expanded = true
    }

    /// Live turn at the transcript tail: thinking, tools, and assistant text
    /// in wire order. Tool output appends into a text buffer; prose labels
    /// only relayout the current line (committed paragraphs stay put).
    private func refreshStreaming() {
        guard store.selectedSession != nil, liveTailBox != nil else { return }
        let sid = store.selectedSession!.sessionId
        let blocks = store.liveTurnBlocks(for: sid)
        if blocks.isEmpty {
            if !liveOrder.isEmpty {
                if let live = liveTailBox { shim_box_clear(live) }
                liveWidgets.removeAll()
                liveOrder.removeAll()
            }
            return
        }
        let ids = blocks.map(\.id)
        if liveOrder != Array(ids.prefix(liveOrder.count)) || liveOrder.count > ids.count {
            rebuildLiveTail(blocks)
            scrollTranscriptToBottom()
            return
        }
        var changed = false
        for block in blocks {
            if liveWidgets[block.id] == nil {
                guard let widget = makeLiveWidget(block), let live = liveTailBox else { continue }
                shim_box_append(live, widget.root)
                liveWidgets[block.id] = widget
                liveOrder.append(block.id)
                changed = true
            }
            if updateLiveWidget(block) { changed = true }
        }
        let desired = Set(ids)
        if liveOrder.contains(where: { !desired.contains($0) }) {
            for id in liveOrder where !desired.contains(id) {
                if let widget = liveWidgets.removeValue(forKey: id) {
                    shim_widget_destroy(widget.root)
                }
            }
            liveOrder = ids
            changed = true
        }
        if changed { scrollTranscriptToBottom() }
    }

    private func rebuildLiveTail(_ blocks: [T4GtkBridge.GtkLiveBlock]) {
        guard let live = liveTailBox else { return }
        shim_box_clear(live)
        liveWidgets.removeAll()
        liveOrder.removeAll()
        for block in blocks {
            guard let widget = makeLiveWidget(block) else { continue }
            shim_box_append(live, widget.root)
            liveWidgets[block.id] = widget
            liveOrder.append(block.id)
            _ = updateLiveWidget(block)
        }
    }

    private func makeLiveWidget(_ block: T4GtkBridge.GtkLiveBlock) -> LiveStreamWidget? {
        switch block.kind {
        case .thinking:
            return makeLiveThinking(block)
        case .text:
            return makeLiveText()
        case .tool:
            return makeLiveTool(block)
        }
    }

    private func makeLiveThinking(_ block: T4GtkBridge.GtkLiveBlock) -> LiveStreamWidget? {
        guard let card = shim_box_new(0, 4) else { return nil }
        addClass(card, "tool-card")
        addClass(card, "tool-thinking")
        addClass(card, "expanded")
        let header = shim_box_new(1, 8)
        addClass(header, "card-header")
        let chevron = makeLabel("▾", "card-chevron")
        shim_box_append(header, chevron)
        let title = makeLabel("Thinking", "tool-head")
        shim_widget_halign_start(title)
        shim_box_append(header, title)
        let headerButton = shim_button_child(header)
        addClass(headerButton, "card-header-btn")
        let id = block.id
        onSignal(UnsafeMutableRawPointer(headerButton), "clicked") { [weak self] in
            self?.toggleLiveBlock(id: id)
        }
        shim_box_append(card, headerButton)
        let body = shim_box_new(0, 0)
        let committed = makeLabel("", "tool-meta")
        shim_label_wrap_words(committed)
        shim_label_selectable(committed)
        shim_widget_halign_start(committed)
        shim_widget_hide(committed)
        let tail = makeLabel("", "tool-meta")
        shim_label_wrap_words(tail)
        shim_label_selectable(tail)
        shim_widget_halign_start(tail)
        shim_box_append(body, committed)
        shim_box_append(body, tail)
        shim_box_append(card, body)
        return LiveStreamWidget(
            root: card, body: body, committed: committed, tail: tail,
            buffer: nil, chevron: chevron, expanded: true
        )
    }

    private func makeLiveText() -> LiveStreamWidget? {
        guard let column = shim_box_new(0, 0) else { return nil }
        let committed = makeLabel("", "assistant-message")
        shim_label_wrap_words(committed)
        shim_label_selectable(committed)
        shim_widget_halign_start(committed)
        shim_widget_hide(committed)
        let tail = makeLabel("", "assistant-message")
        shim_label_wrap_words(tail)
        shim_label_selectable(tail)
        shim_widget_halign_start(tail)
        shim_box_append(column, committed)
        shim_box_append(column, tail)
        return LiveStreamWidget(
            root: column, body: column, committed: committed, tail: tail,
            buffer: nil, chevron: nil, expanded: true
        )
    }

    private func makeLiveTool(_ block: T4GtkBridge.GtkLiveBlock) -> LiveStreamWidget? {
        guard let card = shim_box_new(0, 4) else { return nil }
        addClass(card, "tool-card")
        addClass(card, "tool-tool-use")
        addClass(card, "expanded")
        let header = shim_box_new(1, 8)
        addClass(header, "card-header")
        let titleText = liveToolTitle(block)
        let title = makeLabel(titleText, "tool-head")
        shim_widget_halign_start(title)
        shim_box_append(header, title)
        shim_box_append(card, header)
        let tv = shim_text_view()
        shim_text_view_setup(tv)
        let buf = shim_text_buffer(tv)
        let scroll = shim_scrolled_window()
        shim_scrolled_set_child(scroll, tv)
        shim_scrolled_content_height(scroll, 24, 220)
        shim_box_append(card, scroll)
        return LiveStreamWidget(
            root: card, body: scroll, committed: title, tail: nil,
            buffer: buf, chevron: nil, expanded: true
        )
    }

    private func liveToolTitle(_ block: T4GtkBridge.GtkLiveBlock) -> String {
        let name = block.title.isEmpty ? "tool" : block.title
        switch block.phase {
        case "running", "generating":
            return name.uppercased() + " · " + block.phase
        case "failed":
            return name.uppercased() + " · error"
        default:
            return name.uppercased()
        }
    }

    @discardableResult
    private func updateLiveWidget(_ block: T4GtkBridge.GtkLiveBlock) -> Bool {
        guard var widget = liveWidgets[block.id] else { return false }
        var changed = false
        switch block.kind {
        case .thinking, .text:
            let full = block.text
            if widget.expanded {
                if applySplitLabels(full, widget: &widget) { changed = true }
            } else if full != widget.lastText {
                widget.lastText = full
                changed = true
            }
        case .tool:
            let title = liveToolTitle(block)
            if let titleLabel = widget.committed, title != widget.lastCommitted {
                shim_label_set_text(titleLabel, title)
                widget.lastCommitted = title
                changed = true
            }
            if let buf = widget.buffer {
                let body = block.progress
                if applyDeltaBuffer(buf, full: body, last: &widget.lastText) {
                    changed = true
                }
            }
        }
        if changed { liveWidgets[block.id] = widget }
        return changed
    }

    private func applySplitLabels(_ full: String, widget: inout LiveStreamWidget, force: Bool = false) -> Bool {
        guard force || full != widget.lastText else { return false }
        let committed: String
        let tail: String
        if let idx = full.lastIndex(of: "\n") {
            committed = String(full[...idx])
            tail = String(full[full.index(after: idx)...])
        } else {
            committed = ""
            tail = full
        }
        var changed = false
        if committed != widget.lastCommitted {
            widget.lastCommitted = committed
            if let label = widget.committed {
                if committed.isEmpty {
                    shim_widget_hide(label)
                } else {
                    shim_label_set_text(label, committed)
                    shim_widget_show(label)
                }
            }
            changed = true
        }
        if tail != widget.lastTail {
            widget.lastTail = tail
            if let label = widget.tail { shim_label_set_text(label, tail) }
            changed = true
        }
        widget.lastText = full
        return changed
    }

    private func applyDeltaBuffer(
        _ buf: UnsafeMutablePointer<GtkTextBuffer>,
        full: String,
        last: inout String
    ) -> Bool {
        guard full != last else { return false }
        if !last.isEmpty, full.hasPrefix(last) {
            let suffix = String(full.dropFirst(last.count))
            if !suffix.isEmpty { shim_text_append(buf, suffix) }
        } else {
            shim_buffer_set_text(buf, full)
        }
        last = full
        return true
    }

    private func toggleLiveBlock(id: String) {
        guard var widget = liveWidgets[id] else { return }
        widget.expanded.toggle()
        let expanded = widget.expanded
        if let chevron = widget.chevron { shim_label_set_text(chevron, expanded ? "▾" : "▸") }
        if let body = widget.body {
            if expanded { shim_widget_show(body) } else { shim_widget_hide(body) }
        }
        if expanded {
            shim_css_class_remove(widget.root, "collapsed")
            addClass(widget.root, "expanded")
            _ = applySplitLabels(widget.lastText, widget: &widget, force: true)
        } else {
            shim_css_class_remove(widget.root, "expanded")
            addClass(widget.root, "collapsed")
        }
        liveWidgets[id] = widget
        if expanded { scrollTranscriptToBottom() }
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

    private func composerText() -> String {
        guard let buffer = composerBuffer else { return "" }
        let textC = shim_buffer_text(buffer)
        let text = textC.map { String(cString: $0) } ?? ""
        shim_free(textC)
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func clearComposerDraft() {
        guard let buffer = composerBuffer else { return }
        shim_buffer_set_text(buffer, "")
        if let view = composerView { shim_text_scroll_cursor(view) }
        attachments = []
        rebuildAttachmentStrip()
    }

    /// Idle: session.prompt. Live turn: session.steer. Draft stays until the
    /// host accepts, so a busy rejection does not eat the message.
    private func submitComposer() {
        guard !composerBusy, let selected = store.selectedSession else { return }
        let trimmed = composerText()
        let images = attachments.map { T4GtkBridge.GtkPromptImage(data: $0.data, mimeType: $0.mimeType) }
        let live = store.hasLiveTurn(sessionId: selected.sessionId)
        if live {
            guard !trimmed.isEmpty else { return }
            guard images.isEmpty else { return }
            pinnedToBottom = true
            composerBusy = true
            let sid = selected.sessionId
            Task { [store] in
                let ok = await store.steer(sessionId: sid, text: trimmed)
                self.composerBusy = false
                if ok { self.clearComposerDraft() }
                self.refreshComposer()
            }
            return
        }
        guard !trimmed.isEmpty || !images.isEmpty else { return }
        pinnedToBottom = true
        composerBusy = true
        let sid = selected.sessionId
        Task { [store] in
            let ok = await store.sendPrompt(sessionId: sid, text: trimmed, images: images)
            self.composerBusy = false
            if ok { self.clearComposerDraft() }
            self.refreshComposer()
        }
    }

    private func queueComposer() {
        guard !composerBusy, let selected = store.selectedSession else { return }
        guard store.hasLiveTurn(sessionId: selected.sessionId) else { return }
        let trimmed = composerText()
        guard !trimmed.isEmpty, attachments.isEmpty else { return }
        pinnedToBottom = true
        composerBusy = true
        let sid = selected.sessionId
        Task { [store] in
            let ok = await store.followUp(sessionId: sid, text: trimmed)
            self.composerBusy = false
            if ok { self.clearComposerDraft() }
            self.refreshComposer()
        }
    }

    private func stopComposer() {
        guard let selected = store.selectedSession else { return }
        let sid = selected.sessionId
        Task { [store] in await store.cancel(sessionId: sid) }
    }

    /// Stop / Queue / Steer appear only while this session has a live turn.
    private func refreshComposer() {
        let sid = store.selectedSession?.sessionId ?? ""
        let live = !sid.isEmpty && store.hasLiveTurn(sessionId: sid)
        if live != composerTurnActive || sid != composerChromeSessionId {
            composerTurnActive = live
            composerChromeSessionId = sid
            if live {
                if let stop = stopButton { shim_widget_show(stop) }
                if let queue = queueButton { shim_widget_show(queue) }
                if let send = sendButton { shim_button_set_label(send, "Steer") }
            } else {
                if let stop = stopButton { shim_widget_hide(stop) }
                if let queue = queueButton { shim_widget_hide(queue) }
                if let send = sendButton { shim_button_set_label(send, "➤") }
            }
        }
        refreshQueueChips()
    }

    private func refreshQueueChips() {
        let sid = store.selectedSession?.sessionId ?? ""
        let items = sid.isEmpty ? [] : store.queuedMessages(for: sid)
        let signature = items.map { "\($0.kind):\($0.text)" }.joined(separator: "|")
        guard signature != lastQueueSignature else { return }
        lastQueueSignature = signature
        guard let strip = queueStrip else { return }
        shim_box_clear(strip)
        if items.isEmpty {
            shim_widget_hide(strip)
            return
        }
        for item in items {
            let prefix = item.kind == .steering ? "Steer" : "Queued"
            let label = makeLabel("\(prefix) · \(item.text)", "queue-chip")
            if let label {
                shim_label_wrap_words(label)
                shim_widget_halign_start(label)
                shim_box_append(strip, label)
            }
        }
        shim_widget_show(strip)
    }

    /// session.cancel is confirmation-gated. Stop already expressed the
    /// intent, so approve that challenge instead of leaving cancel hung.
    private func refreshCancelConfirmation() {
        guard let challenge = store.pendingConfirmation else { return }
        let summary = challenge.summary.lowercased()
        guard summary.contains("session.cancel") else { return }
        guard !confirmingCancel else { return }
        confirmingCancel = true
        Task { [store] in
            await store.confirm(.approve)
            self.confirmingCancel = false
        }
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
                // Click the staged thumbnail to preview it full-size;
                // right-click copies the image.
                onPressed(pic) { [weak self] in self?.showLightbox(texture) }
                onRightClick(pic) { [weak self] in
                    let (x, y) = menuClickPos()
                    self?.showCopyMenu(x: x, y: y, items: [("Copy Image", { shim_clipboard_set_texture(texture) })])
                }
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
        onRightClick(pic) { [weak self] in
            let (x, y) = menuClickPos()
            self?.showCopyMenu(x: x, y: y, items: [("Copy Image", {
                shim_clipboard_set_texture(texture)
            })])
        }
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

    // MARK: - Copy context menu

    typealias CopyMenuItem = (label: String, action: () -> Void)

    private var copyMenu: UnsafeMutablePointer<GtkWidget>?
    private var copyMenuBox: UnsafeMutablePointer<GtkWidget>?

    /// One shared popover for every transcript element's right-click menu.
    /// Window-anchored so transcript rebuilds never orphan it; content is
    /// rebuilt per open. `x`/`y` are root-window coordinates (from the
    /// shim's right-click trampoline).
    func showCopyMenu(x: Double, y: Double, items: [CopyMenuItem]) {
        guard let win = window, !items.isEmpty else { return }
        if copyMenu == nil {
            let pop = shim_popover_new()
            addClass(pop, "copy-menu")
            let box = shim_box_new(0, 2)
            shim_popover_set_child(pop, box)
            shim_popover_attach(pop, win)
            copyMenu = pop
            copyMenuBox = box
        }
        guard let pop = copyMenu, let box = copyMenuBox else { return }
        shim_box_clear(box)
        for item in items {
            let btn = shim_button(item.label)
            addClass(btn, "copy-menu-item")
            onSignal(btn, "clicked") { [weak self] in
                item.action()
                self?.hideCopyMenu()
            }
            shim_box_append(box, btn)
        }
        shim_popover_point_to(pop, x, y)
        shim_popover_popup(pop)
    }

    private func hideCopyMenu() {
        if let pop = copyMenu { shim_popover_popdown(pop) }
    }
}
