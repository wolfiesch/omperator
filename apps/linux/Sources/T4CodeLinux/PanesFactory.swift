//  PanesFactory.swift
//  GTK widget builders for the app's right-side panes: Terminal (VTE via
//  CVTE), Browser (WebKitGTK via CWebKit), and Files (a scrolled list of the
//  session's changed files). The main agent wires the returned widgets into
//  AppWindow's sidebar and feeds them store data.
//
//  Data contract: T4GtkBridge (Store/T4GtkBridge.swift) currently exposes
//  only session/transcript state — no terminal, browser, or files surface —
//  so these are scaffolds with feed/refresh methods the main agent calls with
//  store data (T4SessionStore+Terminal / +Preview / +Files, internal to
//  T4CodeLinuxLib):
//
//   • Terminal — feed the active terminal's `terminalOutput[terminalId]`
//     buffer with feedTerminal(_:) (tail-only; a head trim re-seeds, mirroring
//     T4TerminalFeeds). Forward onTerminalInput keystrokes to
//     `store.sendTerminalInput(sessionId:data:)` and onTerminalResize to
//     `store.resizeTerminal(sessionId:cols:rows:)`. setTerminalInteractive(_:)
//     mirrors the pty-exit gate; clearTerminal() maps to store.clearTerminal.
//   • Browser — seed with `store.browserURL(for:)` via loadURL(_:); reflect
//     setBrowserURL/openPreview on the main agent's side. onURLChanged /
//     onLoadingChanged mirror the seam's notify::uri / notify::is-loading.
//   • Files — setFiles(_:) with paths from `store.listFiles` (directory
//     browser) or `store.filesDiff().changes` (the turn's changed files);
//     onFileActivated(path) lets the main agent drill in with readFile.
//
//  The widget/state lifecycle is the same discipline as the seams: GTK owns
//  the widget objects (parenting takes the initial reference); the factory
//  keeps plain pointers plus signal boxes and disconnects handlers when the
//  widget is destroyed (a "destroy" marshaller nils the pointer so no feed
//  touches freed memory).

import Foundation
import CT4Gtk
import CVTE
import CWebKit
import T4CodeLinuxLib

/// Builds and feeds the right-side panes of the pure-GTK4 window.
@MainActor
public final class PanesFactory {
    /// The bridge passed to the last widget builder. Retained for the wiring
    /// contract; today T4GtkBridge has no terminal/browser/files surface, so
    /// all data flows through the feed methods below.
    public private(set) var bridge: T4GtkBridge?

    public init() {
        ensureRowHandler()
    }

    // MARK: - Shared plumbing

    /// Connect a GObject signal through a C marshaller; `box` is the retained
    /// Swift object the marshaller re-enters through (kept alive by the
    /// factory's state objects).
    @discardableResult
    private func connectSignal(
        _ instance: UnsafeMutableRawPointer,
        _ name: String,
        _ handler: GCallback,
        _ box: AnyObject
    ) -> UInt {
        g_signal_connect_data(
            instance,
            name,
            handler,
            Unmanaged.passUnretained(box).toOpaque(),
            nil,
            GConnectFlags(rawValue: 0)
        )
    }

    private static func asGtkWidget<T>(_ pointer: UnsafeMutablePointer<T>) -> UnsafeMutablePointer<GtkWidget> {
        UnsafeMutableRawPointer(pointer).assumingMemoryBound(to: GtkWidget.self)
    }

    // MARK: - Terminal (VTE)

    /// Live terminal widget state. The pointer is raw: GTK owns the widget;
    /// the "destroy" marshaller nils it so feedTerminal never touches freed
    /// memory, and disconnects the signal handlers.
    private final class TerminalState {
        var terminal: UnsafeMutablePointer<VteTerminal>?
        var signalBox: TerminalSignalBox?
        var handlerIDs: [UInt] = []
        var lastFedLength = 0
        var isInteractive = true

        func teardown() {
            if let terminal {
                for id in handlerIDs {
                    g_signal_handler_disconnect(UnsafeMutableRawPointer(terminal), id)
                }
            }
            handlerIDs.removeAll()
            signalBox = nil
            terminal = nil
        }
    }

    /// Retains the Swift callbacks for the raw "commit" / "char-size-changed"
    /// connections (same pattern as Seams/TerminalPane.swift).
    private final class TerminalSignalBox {
        let onInput: ((String) -> Void)?
        let onResize: ((Int, Int) -> Void)?

        init(onInput: ((String) -> Void)?, onResize: ((Int, Int) -> Void)?) {
            self.onInput = onInput
            self.onResize = onResize
        }
    }

    /// VTE "commit" signal: (VteTerminal*, char* text, guint size, gpointer).
    /// `text` is NOT NUL-terminated — the size must be honored.
    private static let commitHandler: @convention(c) (
        UnsafeMutablePointer<VteTerminal>?, UnsafePointer<CChar>?, UInt32, UnsafeMutableRawPointer?
    ) -> Void = { _, text, size, data in
        guard let data, let text, size > 0 else { return }
        let box = Unmanaged<TerminalSignalBox>.fromOpaque(data).takeUnretainedValue()
        guard let onInput = box.onInput else { return }
        let bytes = UnsafeRawBufferPointer(start: text, count: Int(size)).bindMemory(to: UInt8.self)
        if let string = String(validating: bytes, as: UTF8.self) {
            onInput(string)
        }
    }

    /// VTE "char-size-changed" signal: (VteTerminal*, guint, guint, gpointer).
    private static let charSizeChangedHandler: @convention(c) (
        UnsafeMutablePointer<VteTerminal>?, UInt32, UInt32, UnsafeMutableRawPointer?
    ) -> Void = { terminal, _, _, data in
        guard let data, let terminal else { return }
        let box = Unmanaged<TerminalSignalBox>.fromOpaque(data).takeUnretainedValue()
        guard let onResize = box.onResize else { return }
        onResize(
            Int(vte_terminal_get_column_count(terminal)),
            Int(vte_terminal_get_row_count(terminal))
        )
    }

    /// Widget "destroy" signal: nil the live pointer and disconnect.
    private static let terminalDestroyHandler: @convention(c) (
        UnsafeMutablePointer<GtkWidget>?, UnsafeMutableRawPointer?
    ) -> Void = { _, data in
        guard let data else { return }
        Unmanaged<TerminalState>.fromOpaque(data).takeUnretainedValue().teardown()
    }

    private var terminalState: TerminalState?

    /// Keystrokes committed by the terminal (user input) → forward to
    /// `store.sendTerminalInput(sessionId:data:)`. Suppressed while
    /// `setTerminalInteractive(false)` (pty exited).
    public var onTerminalInput: ((String) -> Void)?
    /// Cell-grid size changes → forward to `store.resizeTerminal(sessionId:cols:rows:)`.
    public var onTerminalResize: ((Int, Int) -> Void)?

    /// Create the VTE terminal widget for the sidebar. Returns the bare
    /// VteTerminal widget (it manages its own scrollback); the main agent
    /// parents it wherever the pane lives. Feed it with `feedTerminal(_:)`.
    public func terminalWidget(bridge: T4GtkBridge) -> UnsafeMutablePointer<GtkWidget>? {
        self.bridge = bridge
        // vte_terminal_new() is declared GtkWidget* in vte-2.91 — recover the
        // concrete VteTerminal type (same cast the seam's wrapper does).
        guard let raw = vte_terminal_new() else { return nil }
        let terminal = UnsafeMutableRawPointer(raw).assumingMemoryBound(to: VteTerminal.self)

        // Terminal voice: VT323 14 (matches the SwiftCrossUI seam's font, so
        // transcript rows and the terminal render alike).
        if let desc = pango_font_description_from_string("VT323 14") {
            vte_terminal_set_font(terminal, desc)
            pango_font_description_free(desc)
        }
        vte_terminal_set_scrollback_lines(terminal, 10_000)
        shim_widget_expand(Self.asGtkWidget(terminal), 1)
        shim_widget_expand(Self.asGtkWidget(terminal), 0)

        // Replace any previous terminal (disconnect its handlers first so no
        // C callback can fire on a state the factory no longer retains).
        terminalState?.teardown()
        let state = TerminalState()
        state.terminal = terminal
        terminalState = state

        let box = TerminalSignalBox(
            onInput: { [weak self] text in self?.onTerminalInput?(text) },
            onResize: { [weak self] cols, rows in self?.onTerminalResize?(cols, rows) }
        )
        state.signalBox = box
        state.handlerIDs.append(connectSignal(
            UnsafeMutableRawPointer(terminal), "commit",
            unsafeBitCast(Self.commitHandler, to: GCallback.self), box))
        state.handlerIDs.append(connectSignal(
            UnsafeMutableRawPointer(terminal), "char-size-changed",
            unsafeBitCast(Self.charSizeChangedHandler, to: GCallback.self), box))
        state.handlerIDs.append(connectSignal(
            UnsafeMutableRawPointer(terminal), "destroy",
            unsafeBitCast(Self.terminalDestroyHandler, to: GCallback.self), state))

        return Self.asGtkWidget(terminal)
    }

    /// Feed the terminal's output buffer (`terminalOutput[terminalId]`).
    /// Append-only until the store's ~200KB cap trims the oldest half; a head
    /// trim re-seeds from the whole buffer (mirrors T4TerminalFeeds.push).
    public func feedTerminal(_ output: String) {
        guard let state = terminalState, let terminal = state.terminal else { return }
        let count = output.utf8.count
        if count < state.lastFedLength {
            state.lastFedLength = 0
        }
        guard count > state.lastFedLength else { return }
        let start = output.utf8.index(output.utf8.startIndex, offsetBy: state.lastFedLength)
        let tail = String(Substring(output.utf8[start...]))
        tail.withCString { pointer in
            vte_terminal_feed(terminal, pointer, Int(tail.utf8.count))
        }
        state.lastFedLength = count
    }

    /// Gate keystroke forwarding — false once the pty has exited
    /// (`terminalExits[terminalId]` present), so dead terminals stop
    /// accepting input.
    public func setTerminalInteractive(_ interactive: Bool) {
        terminalState?.isInteractive = interactive
    }

    /// Clear the screen and scrollback (maps to store.clearTerminal; VTE has
    /// no fine-grained public clear).
    public func clearTerminal() {
        guard let state = terminalState, let terminal = state.terminal else { return }
        vte_terminal_reset(terminal, 0 /* clear_tabstops */, 1 /* clear_history */)
        state.lastFedLength = 0
    }

    // MARK: - Browser (WebKitGTK)

    /// Live webview state (same discipline as TerminalState).
    private final class BrowserState {
        var webView: UnsafeMutablePointer<WebKitWebView>?
        var signalBox: BrowserSignalBox?
        var handlerIDs: [UInt] = []
        var lastRequestedURL: String?

        func teardown() {
            if let webView {
                for id in handlerIDs {
                    g_signal_handler_disconnect(UnsafeMutableRawPointer(webView), id)
                }
            }
            handlerIDs.removeAll()
            signalBox = nil
            webView = nil
        }
    }

    /// Retains the Swift callbacks for the "notify::uri"/"notify::is-loading"
    /// connections (mirrors Seams/BrowserPane.swift).
    private final class BrowserSignalBox {
        let onURIChanged: ((String) -> Void)?
        let onLoadingChanged: ((Bool) -> Void)?

        init(onURIChanged: ((String) -> Void)?, onLoadingChanged: ((Bool) -> Void)?) {
            self.onURIChanged = onURIChanged
            self.onLoadingChanged = onLoadingChanged
        }
    }

    /// "notify::uri" / "notify::is-loading" share the (GObject*, GParamSpec*,
    /// gpointer) shape. The first parameter is UnsafeMutableRawPointer to
    /// avoid the Gtk/CWebKit `GObject` typealias ambiguity (seam pattern).
    private static let notifyHandler: @convention(c) (
        UnsafeMutableRawPointer?, UnsafeMutableRawPointer?, UnsafeMutableRawPointer?
    ) -> Void = { object, _, data in
        guard let object, let data else { return }
        let box = Unmanaged<BrowserSignalBox>.fromOpaque(data).takeUnretainedValue()
        let view = object.assumingMemoryBound(to: WebKitWebView.self)
        box.onURIChanged?(webkit_web_view_get_uri(view).map { String(cString: $0) } ?? "")
        box.onLoadingChanged?(webkit_web_view_is_loading(view) != 0)
    }

    /// Widget "destroy" signal: nil the live pointer and disconnect.
    private static let webViewDestroyHandler: @convention(c) (
        UnsafeMutablePointer<GtkWidget>?, UnsafeMutableRawPointer?
    ) -> Void = { _, data in
        guard let data else { return }
        Unmanaged<BrowserState>.fromOpaque(data).takeUnretainedValue().teardown()
    }

    private var browserState: BrowserState?

    /// Live URI change → reflect into the store (`store.setBrowserURL`).
    public var onURLChanged: ((String) -> Void)?
    /// Live loading-state change (start/stop).
    public var onLoadingChanged: ((Bool) -> Void)?

    /// Mirrors T4SessionStore.defaultBrowserURL (internal to the lib).
    public static let defaultBrowserURL = "http://localhost:3000"

    /// Create the browser pane: a GtkScrolledWindow containing a fresh
    /// WebKitWebView. The scrolled window bounds WebKit's natural size (the
    /// page height), giving the page internal scrolling and keeping the host
    /// layout from inflating — the seam's approach.
    public func browserWidget(bridge: T4GtkBridge) -> UnsafeMutablePointer<GtkWidget>? {
        self.bridge = bridge
        // WebKitGTK 6.0 declares webkit_web_view_new() as GtkWidget* —
        // recover the concrete WebKitWebView type.
        guard let raw = webkit_web_view_new() else { return nil }
        let webView = UnsafeMutableRawPointer(raw).assumingMemoryBound(to: WebKitWebView.self)
        let scroll = shim_scrolled_window()
        shim_widget_expand(scroll, 1)
        shim_widget_expand(scroll, 0)
        shim_scrolled_set_child(scroll, Self.asGtkWidget(webView))

        // Replace any previous webview (disconnect first).
        browserState?.teardown()
        let state = BrowserState()
        state.webView = webView
        browserState = state

        let box = BrowserSignalBox(
            onURIChanged: { [weak self] uri in self?.onURLChanged?(uri) },
            onLoadingChanged: { [weak self] loading in self?.onLoadingChanged?(loading) }
        )
        state.signalBox = box
        state.handlerIDs.append(connectSignal(
            UnsafeMutableRawPointer(webView), "notify::uri",
            unsafeBitCast(Self.notifyHandler, to: GCallback.self), box))
        state.handlerIDs.append(connectSignal(
            UnsafeMutableRawPointer(webView), "notify::is-loading",
            unsafeBitCast(Self.notifyHandler, to: GCallback.self), box))
        state.handlerIDs.append(connectSignal(
            UnsafeMutableRawPointer(webView), "destroy",
            unsafeBitCast(Self.webViewDestroyHandler, to: GCallback.self), state))

        // Seed with the store's default; the main agent re-targets with
        // `loadURL(store.browserURL(for: sessionId))` when a session is shown.
        state.lastRequestedURL = Self.defaultBrowserURL
        webkit_web_view_load_uri(webView, Self.defaultBrowserURL)
        return scroll
    }

    /// Load a URL. No-ops when it matches the last requested URL (never
    /// reset in-flight loads or scroll state — seam behavior).
    public func loadURL(_ url: String) {
        guard let state = browserState, let webView = state.webView, state.lastRequestedURL != url else { return }
        state.lastRequestedURL = url
        webkit_web_view_load_uri(webView, url)
    }

    public func reload() {
        guard let webView = browserState?.webView else { return }
        webkit_web_view_reload(webView)
    }

    public func goBack() {
        guard let webView = browserState?.webView else { return }
        webkit_web_view_go_back(webView)
    }

    public func goForward() {
        guard let webView = browserState?.webView else { return }
        webkit_web_view_go_forward(webView)
    }

    /// The webview's current URI (nil until a load commits).
    public var currentURL: String? {
        guard let webView = browserState?.webView else { return nil }
        return webkit_web_view_get_uri(webView).map { String(cString: $0) }
    }

    public var canGoBack: Bool {
        guard let webView = browserState?.webView else { return false }
        return webkit_web_view_can_go_back(webView) != 0
    }

    public var canGoForward: Bool {
        guard let webView = browserState?.webView else { return false }
        return webkit_web_view_can_go_forward(webView) != 0
    }

    public var isLoading: Bool {
        guard let webView = browserState?.webView else { return false }
        return webkit_web_view_is_loading(webView) != 0
    }

    // MARK: - Files

    /// One row for the files list. Mirrors HostWire `FileListEntry` (path /
    /// kind / size); feed rows from `store.listFiles` entries or
    /// `store.filesDiff().changes` (status-modified paths of the turn).
    public struct FileItem: Equatable, Sendable {
        /// Safe relative POSIX path, exactly as the host returned it.
        public let path: String
        /// "directory" renders as a folder row ("/" suffix); anything else
        /// renders as a file row ("file", "text", "binary", "huge", "missing"…).
        public let kind: String
        /// Byte size when the host provided one (nil for directories).
        public let size: Int?

        public init(path: String, kind: String, size: Int? = nil) {
            self.path = path
            self.kind = kind
            self.size = size
        }
    }

    /// Retained per-row box: the row's path plus the activation action. Held
    /// by the C gesture's user_data; released by the destroy notify when the
    /// row is unparented (setFiles rebuild clears rows).
    private final class FileRowBox {
        let path: String
        let action: (String) -> Void

        init(path: String, action: @escaping (String) -> Void) {
            self.path = path
            self.action = action
        }
    }

    /// C trampoline: the shim forwards `userData` (a FileRowBox) — capture-free,
    /// so it converts to a C function pointer.
    private static let rowForwarder: @convention(c) (UnsafeMutableRawPointer?) -> Void = { userData in
        guard let userData else { return }
        let box = Unmanaged<FileRowBox>.fromOpaque(userData).takeUnretainedValue()
        box.action(box.path)
    }

    /// Releases the passRetained FileRowBox when the row's gesture connection
    /// is dropped (widget destroy or explicit unparent on refresh).
    private static let rowDestroy: @convention(c) (UnsafeMutableRawPointer?) -> Void = { userData in
        guard let userData else { return }
        Unmanaged<FileRowBox>.fromOpaque(userData).release()
    }

    private var rowHandlerInstalled = false

    private func ensureRowHandler() {
        guard !rowHandlerInstalled else { return }
        rowHandlerInstalled = true
        shim_set_row_handler(Self.rowForwarder)
    }

    private var filesScroll: UnsafeMutablePointer<GtkWidget>?
    private var filesList: UnsafeMutablePointer<GtkWidget>?
    /// Thumbnail textures by file path (image files only); loaded async via
    /// the bridge's binary-safe files.read. Reffed for the pane's lifetime.
    private var thumbnailCache: [String: UnsafeMutableRawPointer] = [:]

    /// Don't thumbnail files above this size — decode cost isn't worth it.
    private static let thumbnailMaxBytes = 4 * 1024 * 1024

    /// True for image files worth a thumbnail (extension-driven; the bytes
    /// still have to decode through the GDK loaders).
    static func isImageFile(_ path: String) -> Bool {
        ["png", "jpg", "jpeg", "webp", "gif"].contains(
            URL(fileURLWithPath: path).pathExtension.lowercased())
    }

    /// Row activation (tap a changed file) → drill in with
    /// `store.readFile(sessionId:path:)` or navigate `store.listFiles` for a
    /// directory. Read at tap time, so setting it after setFiles still works.
    public var onFileActivated: ((String) -> Void)?

    /// Create the files pane: a scrolled vertical list. Initially empty; feed
    /// it with `setFiles(_:)` — the session's changed files (filesDiff
    /// changes) or a directory listing (listFiles entries).
    public func filesWidget(bridge: T4GtkBridge) -> UnsafeMutablePointer<GtkWidget>? {
        self.bridge = bridge
        ensureRowHandler()
        let scroll = shim_scrolled_window()
        shim_widget_expand(scroll, 1)
        shim_widget_expand(scroll, 0)
        let list = shim_box_new(0, 2)
        shim_scrolled_set_child(scroll, list)
        filesScroll = scroll
        filesList = list
        return scroll
    }

    /// Rebuild the list with the given rows (directories first, then files —
    /// mirrors T4FilesPane's ordering; the main agent may pre-sort).
    public func setFiles(_ items: [FileItem]) {
        guard let list = filesList else { return }
        ensureRowHandler()
        shim_box_clear(list)
        let sorted = items.sorted { lhs, rhs in
            let ldir = lhs.kind == "directory"
            let rdir = rhs.kind == "directory"
            if ldir != rdir { return ldir }
            return lhs.path.localizedStandardCompare(rhs.path) == .orderedAscending
        }
        for item in sorted {
            let isDir = item.kind == "directory"
            let row = shim_box_new(1, 6)
            shim_css_class(row, isDir ? "dir-row" : "file-row")
            if !isDir, Self.isImageFile(item.path), (item.size ?? 0) <= Self.thumbnailMaxBytes {
                let pic = shim_picture()
                shim_picture_fit(pic)
                shim_widget_size_wh(pic, 28, 28)
                shim_css_class(pic, "file-thumb")
                shim_widget_hide(pic)
                if let cached = thumbnailCache[item.path] {
                    shim_picture_set_texture(pic, cached)
                    shim_widget_show(pic)
                } else if let bridge {
                    let picRef = shim_ref(pic)
                    let path = item.path
                    Task { @MainActor [weak self] in
                        defer { shim_unref(picRef) }
                        guard let self,
                              let data = await bridge.fileImageBytes(sessionId: bridge.selectedSession?.sessionId ?? "", path: path),
                              !data.isEmpty, data.count <= Self.thumbnailMaxBytes,
                              let texture = AppWindow.texture(from: data) else { return }
                        self.thumbnailCache[path] = texture
                        shim_picture_set_texture(pic, texture)
                        shim_widget_show(pic)
                    }
                }
                shim_box_append(row, pic)
            }
            let label = shim_label(isDir ? item.path + "/" : item.path)
            shim_widget_halign_start(label)
            shim_box_append(row, label)
            shim_box_append(list, row)
            let box = FileRowBox(path: item.path, action: { [weak self] path in self?.onFileActivated?(path) })
            shim_on_row_activated(row, Unmanaged.passRetained(box).toOpaque(), Self.rowDestroy)
        }
    }
}
