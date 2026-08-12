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
    private var transcriptBuffer: UnsafeMutablePointer<GtkTextBuffer>?
    private var userTag: UnsafeMutablePointer<GtkTextTag>?
    private var assistantTag: UnsafeMutablePointer<GtkTextTag>?
    private var codeTag: UnsafeMutablePointer<GtkTextTag>?
    private var mutedTag: UnsafeMutablePointer<GtkTextTag>?
    private var composerEntry: UnsafeMutablePointer<GtkWidget>?
    private var sendButton: UnsafeMutablePointer<GtkWidget>?
    private var statusLabel: UnsafeMutablePointer<GtkWidget>?
    private var themeButton: UnsafeMutablePointer<GtkWidget>?

    private var renderedSessionId = ""
    private var renderedEntryCount = 0
    private var lastSelectedId = ""
    private var lastSessionCount = -1
    private var lastConnected = false
    private var lastError: String?
    private var dark = true
    private var transcriptScroll: UnsafeMutablePointer<GtkWidget>?
    private var pinnedToBottom = true

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
        statusLabel = makeLabel("connecting…", "subtle")
        shim_widget_halign_start(statusLabel)
        shim_box_append(header, statusLabel)
        shim_box_append(center, header)

        let scroll = shim_scrolled_window()
        transcriptScroll = scroll
        shim_widget_expand(scroll, 0)
        transcriptView = shim_text_view()
        addClass(transcriptView, "transcript")
        shim_text_view_setup(transcriptView)
        shim_scrolled_set_child(scroll, transcriptView)
        shim_box_append(center, scroll)

        // Bottom-pin: stay anchored to the newest content while the user is
        // near the bottom during streaming; scrolling up releases the pin,
        // scrolling back near the bottom re-engages it.
        if let adj = shim_vadj(scroll) {
            onSignal(UnsafeMutableRawPointer(adj), "value-changed") { [weak self] in
                self?.updateScrollPin()
            }
        }

        transcriptBuffer = shim_text_buffer(transcriptView)
        if let buf = transcriptBuffer {
            userTag = shim_tag(buf, "user", "foreground", "#F6C177")
            assistantTag = shim_tag(buf, "assistant", "foreground", "#E0DEF4")
            codeTag = shim_tag2(buf, "code", "family", "monospace", "background", "#2A273F")
            mutedTag = shim_tag(buf, "muted", "foreground", "#6E6A86")
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

        shim_window_present(win)
    }

    // MARK: - Theme

    private func toggleTheme() {
        dark.toggle()
        applyTheme()
    }

    private func applyTheme() {
        let path = dark
            ? "/home/alexis/dev/omperator/spike-gtk-linux/theme-moon.css"
            : "/home/alexis/dev/omperator/spike-gtk-linux/theme-dawn.css"
        shim_css_load(path)
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
        guard let buf = transcriptBuffer else { return }
        var start = GtkTextIter()
        var end = GtkTextIter()
        gtk_text_buffer_get_start_iter(buf, &start)
        gtk_text_buffer_get_end_iter(buf, &end)
        gtk_text_buffer_delete(buf, &start, &end)
    }

    private func appendEntry(_ entry: TranscriptEntry) {
        guard let buf = transcriptBuffer else { return }
        let text = entry.body.isEmpty ? entry.headline : entry.body
        let tag: UnsafeMutablePointer<GtkTextTag>?
        if entry.kind == .message, entry.role == "user" {
            tag = userTag
        } else if entry.kind == .message {
            tag = assistantTag
        } else if text.contains("```") || entry.kind == .toolUse {
            tag = codeTag
        } else {
            tag = mutedTag
        }
        var end = GtkTextIter()
        gtk_text_buffer_get_end_iter(buf, &end)
        let startOffset = gtk_text_iter_get_offset(&end)
        shim_text_append(buf, text + "\n\n")
        gtk_text_buffer_get_end_iter(buf, &end)
        if let tag {
            var start = GtkTextIter()
            gtk_text_buffer_get_iter_at_offset(buf, &start, startOffset)
            gtk_text_buffer_apply_tag(buf, tag, &start, &end)
        }
    }

    private func scrollTranscriptToBottom() {
        // Only auto-scroll while the user is pinned near the bottom; scrolling
        // up during a stream must not fight the reader.
        guard pinnedToBottom else { return }
        guard let view = transcriptView, let buf = transcriptBuffer else { return }
        shim_scroll_bottom(view, buf)
    }

    /// Recompute the pin from the live scroll position (fires on value-changed).
    private func updateScrollPin() {
        guard let scroll = transcriptScroll, let adj = shim_vadj(scroll) else { return }
        pinnedToBottom = shim_adj_near_bottom(adj, 48) == 1
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
