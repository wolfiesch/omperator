//  TerminalPane.swift (Linux port of apps/ios/Sources/T4TerminalDrawer.swift)
//  VTE surface for the session terminal drawer. The macOS drawer (tab bar,
//  open/close plumbing) is ported by the view layer; this seam supplies the
//  rendering half: a GtkWidgetRepresentable wrapping a VteTerminal that
//  displays host output (fed via `vte_terminal_feed`, tail-only per update)
//  and captures user keystrokes through VTE's "commit" signal.
//
//  VteTerminal has no Swift binding in swift-cross-ui's Gtk module, so the
//  widget is wrapped from its raw C pointer via GObject.init(_:), which takes
//  a reference on init and releases it on deinit — the same ref-counting
//  discipline every generated Gtk binding uses. Signals are connected with
//  g_signal_connect_data and a @convention(c) marshaller that re-enters Swift
//  through a strongly-retained callback box (the Gtk module's own SignalBox
//  pattern); the wrapper disconnects them before releasing the object.

import CVTE
import Foundation
import Gtk
import GtkBackend
import SwiftCrossUI

/// Gtk.Widget subclass wrapping a VteTerminal GObject. Created once per
/// representable and reused across updates so scrollback survives re-renders.
final class T4VteTerminal: Gtk.Widget {
    /// The underlying VteTerminal (the same GObject as the wrapper).
    var terminalPointer: UnsafeMutablePointer<VteTerminal> {
        UnsafeMutableRawPointer(gobjectPointer).assumingMemoryBound(to: VteTerminal.self)
    }

    /// Raw signal handler IDs plus their strongly-retained callback boxes —
    /// mirrors GObject's own signal bookkeeping (disconnect before release so
    /// no callback can fire on a deallocated Swift wrapper).
    private var handlers: [(id: UInt, box: Any)] = []

    init(terminal: UnsafeMutablePointer<GtkWidget>) {
        super.init(terminal)
    }

    /// Connect a VteTerminal signal with a C marshaller. `box` keeps the
    /// Swift callbacks alive for the widget's lifetime and is the `user_data`
    /// the marshaller re-enters through.
    func connectSignal(name: String, handler: GCallback, box: AnyObject) {
        let id = g_signal_connect_data(
            UnsafeMutableRawPointer(gobjectPointer),
            name,
            handler,
            Unmanaged.passUnretained(box).toOpaque(),
            nil,
            GConnectFlags(rawValue: 0)
        )
        handlers.append((id: id, box: box))
    }

    deinit {
        for (id, _) in handlers {
            g_signal_handler_disconnect(gobjectPointer, id)
        }
    }
}

/// Retains the Swift callbacks while a raw g_signal_connect handler is
/// attached. One box per connection (the owning widget keeps it alive).
private final class T4TerminalSignalBox {
    let onInput: ((String) -> Void)?
    let onResize: ((Int, Int) -> Void)?

    init(onInput: ((String) -> Void)? = nil, onResize: ((Int, Int) -> Void)? = nil) {
        self.onInput = onInput
        self.onResize = onResize
    }
}

extension T4TerminalSignalBox {
    /// VTE "commit" signal: (VteTerminal*, char* text, guint size, gpointer).
    /// `text` is NOT NUL-terminated — the size must be honored.
    static let commitHandler: @convention(c) (
        UnsafeMutablePointer<VteTerminal>?, UnsafePointer<CChar>?, UInt32, UnsafeMutableRawPointer?
    ) -> Void = { _, text, size, data in
        guard let data, let text, size > 0 else { return }
        let box = Unmanaged<T4TerminalSignalBox>.fromOpaque(data).takeUnretainedValue()
        guard let onInput = box.onInput else { return }
        let bytes = UnsafeRawBufferPointer(start: text, count: Int(size)).bindMemory(to: UInt8.self)
        if let string = String(validating: bytes, as: UTF8.self) {
            onInput(string)
        }
    }

    /// VTE "char-size-changed" signal: (VteTerminal*, guint, guint, gpointer).
    /// Fires when the character grid resizes — report the new cell count.
    static let charSizeChangedHandler: @convention(c) (
        UnsafeMutablePointer<VteTerminal>?, UInt32, UInt32, UnsafeMutableRawPointer?
    ) -> Void = { terminal, _, _, data in
        guard let data, let terminal else { return }
        let box = Unmanaged<T4TerminalSignalBox>.fromOpaque(data).takeUnretainedValue()
        guard let onResize = box.onResize else { return }
        onResize(
            Int(vte_terminal_get_column_count(terminal)),
            Int(vte_terminal_get_row_count(terminal))
        )
    }
}

/// Live feed registry: SwiftCrossUI's RepresentingWidget never refreshes the
/// representable value after mount (update(with:) only re-applies the
/// environment), so a T4TerminalPane keeps its initial `output` forever and
/// the update-path feedTail never sees new bytes. The drawer therefore pushes
/// store output changes straight into the live coordinator via this registry.
@MainActor
enum T4TerminalFeeds {
    private static var live: [String: T4TerminalCoordinator] = [:]

    static func register(_ terminalId: String, coordinator: T4TerminalCoordinator) {
        live[terminalId] = coordinator
    }

    static func unregister(coordinator: T4TerminalCoordinator) {
        if live[coordinator.terminalId] === coordinator { live[coordinator.terminalId] = nil }
    }

    /// Feed the bytes appended since the last push (append-only buffer; a
    /// head trim shrinks the count and re-seeds from zero, same as feedTail).
    static func push(_ terminalId: String, full: String) {
        guard let coordinator = live[terminalId] else { return }
        let count = full.utf8.count
        if count < coordinator.lastFedLength { coordinator.lastFedLength = 0 }
        guard count > coordinator.lastFedLength else { return }
        let start = full.utf8.index(full.utf8.startIndex, offsetBy: coordinator.lastFedLength)
        coordinator.feed(String(Substring(full.utf8[start...])))
        coordinator.lastFedLength = count
    }
}

/// Holds the live VteTerminal and the callbacks bridging it to the store.
/// Created once per representable and retained across re-renders (SwiftCrossUI
/// keeps the coordinator for the widget's lifetime), so `feed` keeps working
/// even when the view graph re-renders around it.
final class T4TerminalCoordinator {
    /// Mutable holder for the live VteTerminal pointer (see `terminalBox`).
    private final class TerminalBox {
        var terminal: UnsafeMutablePointer<VteTerminal>?
    }

    /// Wire terminal id — the registry key used by T4TerminalFeeds.
    let terminalId: String
    /// The live feed path: pushes host output bytes into the VTE terminal.
    /// Stored as a closure so out-of-band pushes (non-render store frames)
    /// can target the live widget.
    let feed: (String) -> Void
    /// User keystrokes (VTE "commit") → host. Suppressed once the pty exits.
    let onInput: (String) -> Void
    /// Cell-grid resizes → host pty resize.
    let onResize: (Int, Int) -> Void
    /// Byte length of the store buffer fed so far; the update path feeds only
    /// the newly appended tail (mirrors feedTail in T4TerminalDrawer.swift).
    var lastFedLength: Int = 0
    /// False once the pty has exited: stop forwarding keystrokes (mirrors the
    /// macOS surface's interactivity gating).
    var isInteractive: Bool = true
    /// The live VteTerminal pointer, boxed so the `feed` closure can reference
    /// it without capturing self during init (definite-initialization rule).
    private let terminalBox: TerminalBox

    init(terminalId: String, onInput: @escaping (String) -> Void, onResize: @escaping (Int, Int) -> Void) {
        self.terminalId = terminalId
        self.onInput = onInput
        self.onResize = onResize
        let box = TerminalBox()
        self.terminalBox = box
        self.feed = { text in
            guard let terminal = box.terminal else { return }
            text.withCString { pointer in
                vte_terminal_feed(terminal, pointer, Int(text.utf8.count))
            }
        }
    }

    /// Bind the coordinator to a freshly created VteTerminal and attach the
    /// commit / char-size-changed signal handlers.
    func attach(to widget: T4VteTerminal) {
        terminalBox.terminal = widget.terminalPointer

        let commitBox = T4TerminalSignalBox(onInput: { [weak self] text in
            guard let self, self.isInteractive else { return }
            self.onInput(text)
        })
        widget.connectSignal(
            name: "commit",
            handler: unsafeBitCast(T4TerminalSignalBox.commitHandler, to: GCallback.self),
            box: commitBox
        )

        let resizeBox = T4TerminalSignalBox(onResize: onResize)
        widget.connectSignal(
            name: "char-size-changed",
            handler: unsafeBitCast(T4TerminalSignalBox.charSizeChangedHandler, to: GCallback.self),
            box: resizeBox
        )
    }
}

/// Terminal pane: a VteTerminal displaying `output` (tail-fed per update),
/// forwarding keystrokes via `onInput` and cell-grid resizes via `onResize`.
struct T4TerminalPane: GtkWidgetRepresentable {
    typealias GtkWidgetType = T4VteTerminal
    typealias Coordinator = T4TerminalCoordinator

    /// Wire terminal id — keys the live feed registry (T4TerminalFeeds).
    let terminalId: String
    /// The store's output buffer for this terminal (append-only until the
    /// ~200KB cap trims the oldest half).
    let output: String
    /// The pty's exit code once it has exited (nil while running). Stops
    /// keystroke forwarding after exit.
    let exited: Int?
    let onInput: (String) -> Void
    let onResize: (Int, Int) -> Void

    init(
        terminalId: String,
        output: String,
        exited: Int? = nil,
        onInput: @escaping (String) -> Void = { _ in },
        onResize: @escaping (Int, Int) -> Void = { _, _ in }
    ) {
        self.terminalId = terminalId
        self.output = output
        self.exited = exited
        self.onInput = onInput
        self.onResize = onResize
    }

    func makeCoordinator() -> T4TerminalCoordinator {
        T4TerminalCoordinator(terminalId: terminalId, onInput: onInput, onResize: onResize)
    }

    func makeGtkWidget(context: Context) -> T4VteTerminal {
        guard let terminal = vte_terminal_new() else {
            fatalError("vte_terminal_new() returned nil")
        }
        let widget = T4VteTerminal(terminal: terminal)
        // Terminal voice: VT323. fontconfig's monospace alias (see
        // ~/.config/fontconfig/fonts.conf) also routes SwiftCrossUI's
        // `.monospaced` design to it, so text rows and this widget match.
        if let desc = pango_font_description_from_string("VT323 14") {
            vte_terminal_set_font(widget.terminalPointer, desc)
            pango_font_description_free(desc)
        }
        // Fill whatever space the layout system proposes.
        widget.expandHorizontally = true
        widget.useExpandHorizontally = true
        widget.expandVertically = true
        widget.useExpandVertically = true
        context.coordinator.attach(to: widget)
        context.coordinator.isInteractive = exited == nil
        context.coordinator.lastFedLength = 0
        T4TerminalFeeds.register(terminalId, coordinator: context.coordinator)
        feedTail(context.coordinator)
        return widget
    }

    static func dismantleGtkWidget(_ widget: T4VteTerminal, coordinator: T4TerminalCoordinator) {
        T4TerminalFeeds.unregister(coordinator: coordinator)
    }

    func updateGtkWidget(_ widget: T4VteTerminal, context: Context) {
        context.coordinator.isInteractive = exited == nil
        feedTail(context.coordinator)
    }

    /// Feed only the bytes appended since the last feed (the store buffer is
    /// append-only until the ~200KB cap trims the oldest half, at which point
    /// `output.count` shrinks below `lastFedLength` and we re-seed from zero).
    private func feedTail(_ coordinator: T4TerminalCoordinator) {
        let count = output.utf8.count
        if count < coordinator.lastFedLength {
            // Buffer was trimmed from the head — re-seed by feeding the whole
            // buffer. VTE has no public "clear", so feed the current buffer
            // as-is; the visual jump is acceptable for a bounded-buffer trim.
            coordinator.lastFedLength = 0
        }
        guard count > coordinator.lastFedLength else { return }
        let start = output.utf8.index(output.startIndex, offsetBy: coordinator.lastFedLength)
        let tail = String(Substring(output.utf8[start...]))
        coordinator.feed(tail)
        coordinator.lastFedLength = count
    }
}
