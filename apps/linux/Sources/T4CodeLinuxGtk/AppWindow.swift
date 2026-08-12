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
    private var transcriptView: UnsafeMutablePointer<GtkWidget>?
    private var transcriptBox: UnsafeMutablePointer<GtkWidget>?
    private var composerEntry: UnsafeMutablePointer<GtkWidget>?
    private var sendButton: UnsafeMutablePointer<GtkWidget>?
    private var statusLabel: UnsafeMutablePointer<GtkWidget>?
    private var themeButton: UnsafeMutablePointer<GtkWidget>?
    private let transcriptWidgets = TranscriptWidgets()

    private var renderedSessionId = ""
    private var renderedEntryCount = 0
    private var lastSelectedId = ""
    private var lastSessionCount = -1
    private var lastConnected = false
    private var lastError: String?
    private var dark = true
    private var transcriptScroll: UnsafeMutablePointer<GtkWidget>?
    private var pinnedToBottom = true
    private var lastScrollValue = 0.0
    private var lastScrollUpper = 0.0
    // Panes (terminal / browser / files)
    private let panes = PanesFactory()
    private var paneSidebar: UnsafeMutablePointer<GtkWidget>?
    private var paneStack: UnsafeMutablePointer<GtkWidget>?
    private var paneVisible = false
    private var activePane = "terminal"
    private var terminalFed = false
    private var railBox: UnsafeMutablePointer<GtkWidget>?
    private var railVisible = true

    init(app: UnsafeMutablePointer<GtkApplication>?) {
        guard let appPtr = app, let win = gtk_application_window_new(appPtr) else { return }
        window = win
        build(win)
        startRefreshTimer()
    }

    // MARK: - Build

    private func build(_ win: UnsafeMutablePointer<GtkWidget>) {
        shim_window(win, "T4 Code", 1180, 760)

        let root = shim_box_new(1, 0)
        shim_window_set_child(win, root)

        // Rail (left)
        let rail = shim_box_new(0, 0)
        railBox = rail
        addClass(rail, "rail")
        shim_widget_size(rail, 232)
        shim_box_append(root, rail)

        let railHeader = shim_box_new(1, 6)
        let railTitle = makeLabel("Sessions", "subtle")
        shim_widget_halign_start(railTitle)
        shim_box_append(railHeader, railTitle)
        themeButton = shim_button("◐")
        addClass(themeButton, "card")
        onSignal(themeButton, "clicked") { [weak self] in self?.toggleTheme() }
        shim_box_append(railHeader, themeButton)
        let panesButton = shim_button("▤")
        addClass(panesButton, "card")
        onSignal(panesButton, "clicked") { [weak self] in self?.togglePanes() }
        shim_box_append(railHeader, panesButton)
        shim_box_append(rail, railHeader)

        let railScroll = shim_scrolled_window()
        shim_widget_expand(railScroll, 0)
        railList = shim_box_new(0, 2)
        shim_scrolled_set_child(railScroll, railList)
        shim_box_append(rail, railScroll)

        // Center: header + transcript + composer
        let center = shim_box_new(0, 0)
        shim_widget_expand(center, 1)
        shim_box_append(root, center)

        let header = shim_box_new(1, 8)
        addClass(header, "card")
        let railToggle = shim_button("☰")
        addClass(railToggle, "card")
        onSignal(railToggle, "clicked") { [weak self] in self?.toggleRail() }
        shim_box_append(header, railToggle)
        statusLabel = makeLabel("connecting…", "subtle")
        shim_widget_halign_start(statusLabel)
        shim_box_append(header, statusLabel)
        shim_box_append(center, header)

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

        let composer = shim_box_new(1, 8)
        addClass(composer, "composer")
        composerEntry = shim_entry()
        addClass(composerEntry, "composer-entry")
        shim_widget_expand(composerEntry, 1)
        onSignal(composerEntry, "activate") { [weak self] in self?.submitComposer() }
        shim_box_append(composer, composerEntry)
        sendButton = shim_button("➤")
        addClass(sendButton, "send-button")
        onSignal(sendButton, "clicked") { [weak self] in self?.submitComposer() }
        shim_box_append(composer, sendButton)
        shim_box_append(center, composer)

        buildPanesSidebar(root)

        shim_window_present(win)
    }

    // MARK: - Panes sidebar

    private func buildPanesSidebar(_ root: UnsafeMutablePointer<GtkWidget>?) {
        let sidebar = shim_box_new(0, 6)
        addClass(sidebar, "rail")
        shim_widget_size(sidebar, 380)
        paneSidebar = sidebar

        // Tab strip: Terminal / Browser / Files
        let tabs = shim_box_new(1, 4)
        for (name, labelText) in [("terminal", "Terminal"), ("browser", "Browser"), ("files", "Files")] {
            let button = shim_button(labelText)
            addClass(button, "card")
            let paneName = name
            onSignal(button, "clicked") { [weak self] in self?.showPane(paneName) }
            shim_widget_expand(button, 1)
            shim_box_append(tabs, button)
        }
        shim_box_append(sidebar, tabs)

        // Stack hosting the three widgets.
        let stack = shim_stack()
        shim_stack_set_transition(stack)
        shim_widget_expand(stack, 0)
        paneStack = stack
        if let terminal = panes.terminalWidget(bridge: store) {
            shim_stack_add(stack, terminal, "terminal")
        }
        if let browser = panes.browserWidget(bridge: store) {
            shim_stack_add(stack, browser, "browser")
        }
        if let files = panes.filesWidget(bridge: store) {
            shim_stack_add(stack, files, "files")
        }
        shim_stack_show(stack, activePane)
        shim_box_append(sidebar, stack)

        shim_widget_hide(sidebar)
        shim_box_append(root, sidebar)

        // Data callbacks.
        panes.onTerminalInput = { [weak self] data in
            guard let self, let session = self.store.selectedSession else { return }
            let store = self.store
            let sid = session.sessionId
            Task { await store.sendTerminalInput(sessionId: sid, data: data) }
        }
        panes.onTerminalResize = { [weak self] cols, rows in
            guard let self, let session = self.store.selectedSession else { return }
            let store = self.store
            let sid = session.sessionId
            Task { await store.resizeTerminal(sessionId: sid, cols: cols, rows: rows) }
        }
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

    private func showPane(_ name: String) {
        activePane = name
        if let stack = paneStack { shim_stack_show(stack, name) }
        if !paneVisible { togglePanes() }
    }

    private func refreshPanes() {
        guard paneVisible, let session = store.selectedSession else { return }
        let sid = session.sessionId
        if activePane == "terminal" {
            if !terminalFed {
                terminalFed = true
                let store = self.store
                Task { await store.openTerminal(sessionId: sid) }
            }
            if let terminalId = store.activeTerminalId(for: sid) {
                panes.feedTerminal(store.terminalOutput(terminalId))
            }
        } else if activePane == "browser" {
            panes.loadURL(store.browserURL(for: sid))
        } else if activePane == "files" {
            let store = self.store
            Task {
                if let diff = await store.filesDiff(sessionId: sid) {
                    let items = diff.changedPaths.map { PanesFactory.FileItem(path: $0, kind: "file", size: nil) }
                    self.panes.setFiles(items)
                }
            }
        }
    }

    private func toggleTheme() {
        dark.toggle()
        applyTheme()
    }

    private func applyTheme() {
        let path = dark
            ? "/home/alexis/dev/omperator/spike-gtk-linux/theme-moon.css"
            : "/home/alexis/dev/omperator/spike-gtk-linux/theme-dawn.css"
        shim_css_load(path)
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
        refreshTranscript()
        refreshPanes()
    }

    private func refreshConnection() {
        let connected = store.connected
        let error = store.lastError
        guard connected != lastConnected || error != lastError else { return }
        lastConnected = connected
        lastError = error
        let text: String
        if let error, !error.isEmpty {
            text = "⚠ \(error)"
        } else {
            text = connected ? "● connected" : "○ connecting…"
        }
        shim_label_set_text(statusLabel, text)
    }

    private func refreshRail() {
        let sessions = store.sessions
        guard sessions.count != lastSessionCount else { return }
        lastSessionCount = sessions.count
        rebuildRail(sessions)
    }

    private func rebuildRail(_ sessions: [SessionRef]) {
        guard let railList else { return }
        // Clear existing rows.
        var child = gtk_widget_get_first_child(railList)
        while let c = child {
            let next = gtk_widget_get_next_sibling(c)
            shim_widget_destroy(c)
            child = next
        }
        railRows.removeAll()
        for session in sessions.prefix(80) {
            let row = shim_box_new(0, 2)
            addClass(row, "rail-item")
            let title = makeLabel(session.title.isEmpty ? session.sessionId : session.title, nil)
            shim_widget_halign_start(title)
            shim_box_append(row, title)
            let sub = makeLabel("\(session.project.name ?? session.project.projectId) · \(session.status)", "muted")
            shim_widget_halign_start(sub)
            shim_box_append(row, sub)
            let sessionId = session.sessionId
            let captured = sessionId
            onPressed(row) { [weak self] in
                guard let self else { return }
                let store = self.store
                if let target = store.sessions.first(where: { $0.sessionId == captured }) {
                    store.select(target)
                }
            }
            shim_box_append(railList, row)
            railRows[sessionId] = row
        }
    }

    private func refreshTranscript() {
        guard let selected = store.selectedSession else { return }
        let sid = selected.sessionId
        if sid != lastSelectedId {
            lastSelectedId = sid
            renderedSessionId = sid
            renderedEntryCount = 0
            clearTranscript()
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

    private func scrollTranscriptToBottom() {
        // Only auto-scroll while the user is pinned near the bottom; scrolling
        // up during a stream must not fight the reader.
        guard pinnedToBottom, let scroll = transcriptScroll else { return }
        shim_scroll_to_max(scroll)
    }

    /// Recompute the pin from the live scroll position (fires on value-changed).
    /// Content growth moves `upper` while `value` holds — that is NOT a user
    /// scroll, so we only change the pin when `value` itself moved.
    private func updateScrollPin() {
        guard let scroll = transcriptScroll, let adj = shim_vadj(scroll) else { return }
        let value = shim_adj_value(adj)
        let upper = shim_adj_upper(adj)
        let page = shim_adj_page(adj)
        let nearBottom = value + page >= upper - 48
        if value != lastScrollValue {
            // The user moved the scrollbar: engage when near the bottom,
            // release when they scroll up away from it.
            pinnedToBottom = nearBottom
        }
        lastScrollValue = value
        lastScrollUpper = upper
    }

    // MARK: - Composer

    private func submitComposer() {
        guard let entry = composerEntry, let selected = store.selectedSession else { return }
        let buffer = shim_entry_buffer(entry)
        let textC = gtk_entry_buffer_get_text(buffer)
        let text = textC.map { String(cString: $0) } ?? ""
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        shim_entry_clear(entry)
        let store = self.store
        let sid = selected.sessionId
        Task { await store.sendPrompt(sessionId: sid, text: trimmed) }
    }
}
