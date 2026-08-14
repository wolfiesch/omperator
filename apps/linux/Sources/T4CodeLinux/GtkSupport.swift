import Foundation
import CT4Gtk

/// Pure-GTK4 helpers: GObject signal plumbing, CSS classes, and the
/// main-loop tickle that keeps Swift concurrency's main actor fed while the
/// GLib main loop owns the thread.

// MARK: - Signal callbacks

enum RailGrouping: Int {
    case recency = 0
    case project = 1
    case status = 2
}

final class GtkBox {
    let value: () -> Void
    init(_ value: @escaping () -> Void) { self.value = value }
}

private typealias VoidCb = @convention(c) (UnsafeMutableRawPointer?, UnsafeMutableRawPointer?) -> Void

func onSignal(_ instance: UnsafeMutableRawPointer?, _ signal: String, _ action: @escaping () -> Void) {
    let box = GtkBox(action)
    let cb: VoidCb = { _, userData in
        guard let userData else { return }
        Unmanaged<GtkBox>.fromOpaque(userData).takeUnretainedValue().value()
    }
    let fp = unsafeBitCast(cb as VoidCb, to: GCallback.self)
    // The box is retained for the signal's lifetime and never released: GTK
    // can fire a gesture during widget teardown after its closure data is
    // finalized, and releasing there double-frees. A small bounded leak is the
    // safe spike tradeoff (production would disconnect before unparenting).
    g_signal_connect_data(
        instance, signal, fp,
        Unmanaged.passRetained(box).toOpaque(),
        nil,
        GConnectFlags(rawValue: 0)
    )
}

// MARK: - Widget helpers

func addClass(_ widget: UnsafeMutablePointer<GtkWidget>?, _ name: String) {
    shim_css_class(widget, name)
}

func removeClass(_ widget: UnsafeMutablePointer<GtkWidget>?, _ name: String) {
    shim_css_class_remove(widget, name)
}

func makeLabel(_ text: String, _ cls: String? = nil) -> UnsafeMutablePointer<GtkWidget>? {
    let w = shim_label(text)
    if let cls { addClass(w, cls) }
    return w
}

// MARK: - Press gestures (5-arg ABI, routed through the C trampoline)

private let pressedForwarder: @convention(c) (UnsafeMutableRawPointer?) -> Void = { userData in
    guard let userData else { return }
    Unmanaged<GtkBox>.fromOpaque(userData).takeUnretainedValue().value()
}

private var pressedHandlerInstalled = false

func onPressed(_ widget: UnsafeMutablePointer<GtkWidget>?, _ action: @escaping () -> Void) {
    if !pressedHandlerInstalled {
        pressedHandlerInstalled = true
        shim_set_pressed_handler(pressedForwarder)
    }
    let box = GtkBox(action)
    shim_on_pressed(widget, Unmanaged.passRetained(box).toOpaque())
}

// MARK: - Main-actor pump (GLib owns the main loop)

/// The GLib main loop owns the main thread; Swift concurrency's main actor
/// lives on the Foundation main runloop. Pump it from a GLib timeout so
/// @MainActor store work and async UI tasks actually execute.
func installMainActorPump() {
    g_timeout_add(16, { _ in
        RunLoop.main.limitDate(forMode: .default)
        return gboolean(1)
    }, nil)
}

/// Forwarder for one-shot GLib idle callbacks (box pattern, freed after run).
let idleForwarder: @convention(c) (UnsafeMutableRawPointer?) -> gboolean = { userData in
    guard let userData else { return gboolean(0) }
    Unmanaged<GtkBox>.fromOpaque(userData).takeRetainedValue().value()
    return gboolean(0)
}

/// Forwarder for GTK frame-tick callbacks (box pattern; the box stays retained
/// for the callback's lifetime, like onSignal). Returns true to keep ticking.
let tickForwarder: @convention(c) (UnsafeMutablePointer<GtkWidget>?, OpaquePointer?, UnsafeMutableRawPointer?) -> gboolean = { _, _, userData in
    guard let userData else { return gboolean(1) }
    Unmanaged<GtkBox>.fromOpaque(userData).takeUnretainedValue().value()
    return gboolean(1)
}

/// Run a block on the main actor from within a GLib callback (main thread).
func onMainActor(_ action: @escaping @MainActor () -> Void) {
    MainActor.assumeIsolated { action() }
}

// MARK: - Key events (composer send keys, lightbox Esc)

final class GtkKeyBox {
    let handler: (UInt32, UInt32) -> Bool
    init(_ handler: @escaping (UInt32, UInt32) -> Bool) { self.handler = handler }
}

private let keyForwarder: @convention(c) (UInt32, UInt32, UnsafeMutableRawPointer?) -> Int32 = { keyval, state, userData in
    guard let userData else { return 0 }
    return Unmanaged<GtkKeyBox>.fromOpaque(userData).takeUnretainedValue().handler(keyval, state) ? 1 : 0
}

private var keyHandlerInstalled = false

/// GDK modifier bits (gdktypes.h) and keyvals (gdkkeysyms.h) — the C enum
/// constants aren't imported into Swift; documented stable values.
let gdkShiftMask: UInt32 = 1
let gdkControlMask: UInt32 = 4
let gdkKeyReturn: UInt32 = 0xFF0D
let gdkKeyKPEnter: UInt32 = 0xFF8D
let gdkKeyEscape: UInt32 = 0xFF1B
let gdkKeyV: UInt32 = 0x76

/// Key-pressed handler via GtkEventControllerKey. Return true to swallow.
func onKey(_ widget: UnsafeMutablePointer<GtkWidget>?, _ handler: @escaping (UInt32, UInt32) -> Bool) {
    guard let widget else { return }
    if !keyHandlerInstalled {
        keyHandlerInstalled = true
        shim_set_key_handler(keyForwarder)
    }
    shim_on_key(widget, Unmanaged.passRetained(GtkKeyBox(handler)).toOpaque())
}

// MARK: - File paths (open dialog + drag & drop share one trampoline)

final class GtkPathsBox {
    let handler: ([String]) -> Void
    /// One-shot sources (open dialog) balance their passRetained after firing;
    /// repeated sources (drop target) stay retained for the widget lifetime.
    let releaseAfterUse: Bool
    init(releaseAfterUse: Bool, _ handler: @escaping ([String]) -> Void) {
        self.releaseAfterUse = releaseAfterUse
        self.handler = handler
    }
}

private let pathsForwarder: @convention(c) (UnsafeMutableRawPointer?, UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?, Int32) -> Void = { userData, paths, count in
    guard let userData else { return }
    let unmanaged = Unmanaged<GtkPathsBox>.fromOpaque(userData)
    let box = unmanaged.takeUnretainedValue()
    var out: [String] = []
    if let paths {
        for i in 0..<Int(count) {
            if let p = paths[i] { out.append(String(cString: p)) }
        }
    }
    box.handler(out)
    if box.releaseAfterUse { unmanaged.release() }
}

private var pathsHandlerInstalled = false

func installPathsHandlerIfNeeded() {
    guard !pathsHandlerInstalled else { return }
    pathsHandlerInstalled = true
    shim_set_paths_handler(pathsForwarder)
}

// MARK: - Clipboard image bytes (paste, one-shot per read)

final class GtkClipboardBox {
    let handler: (Data?, String?) -> Void
    init(_ handler: @escaping (Data?, String?) -> Void) { self.handler = handler }
}

private let clipboardBytesForwarder: @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<UInt8>?, UInt, UnsafePointer<CChar>?) -> Void = { userData, data, len, mime in
    guard let userData else { return }
    let box = Unmanaged<GtkClipboardBox>.fromOpaque(userData).takeRetainedValue()
    let bytes = data.map { Data(bytes: $0, count: Int(len)) }
    box.handler(bytes, mime.map { String(cString: $0) })
}

private var clipboardBytesHandlerInstalled = false

func installClipboardBytesHandlerIfNeeded() {
    guard !clipboardBytesHandlerInstalled else { return }
    clipboardBytesHandlerInstalled = true
    shim_set_clipboard_bytes_handler(clipboardBytesForwarder)
}

// MARK: - Right-click (context menu trigger)

/// Shares the pressed-handler slot: the shim's right-click trampoline
/// forwards through shim_pressed_handler with the same userData box.
/// Click position (root-window coords) is read via shim_menu_click_pos.
func onRightClick(_ widget: UnsafeMutablePointer<GtkWidget>?, _ action: @escaping () -> Void) {
    guard let widget else { return }
    if !pressedHandlerInstalled {
        pressedHandlerInstalled = true
        shim_set_pressed_handler(pressedForwarder)
    }
    shim_on_right_click(widget, Unmanaged.passRetained(GtkBox(action)).toOpaque())
}

/// The last right-click position in root-window coordinates. MUST live in
/// this file: the C shim is header-only, so its `static` globals are
/// per-translation-unit — only this file's TU shares storage with the
/// trampoline that records the position.
func menuClickPos() -> (Double, Double) {
    var x = 0.0, y = 0.0
    shim_menu_click_pos(&x, &y)
    return (x, y)
}
