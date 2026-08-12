import Foundation
import CT4Gtk

/// Pure-GTK4 helpers: GObject signal plumbing, CSS classes, and the
/// main-loop tickle that keeps Swift concurrency's main actor fed while the
/// GLib main loop owns the thread.

// MARK: - Signal callbacks

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

/// Run a block on the main actor from within a GLib callback (main thread).
func onMainActor(_ action: @escaping @MainActor () -> Void) {
    MainActor.assumeIsolated { action() }
}
