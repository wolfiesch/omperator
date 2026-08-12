import Foundation
import CGtk

// Pure-GTK4 spike (Phase A): Rosé Pine look + streaming-transcript perf,
// no store — a synthetic stream proves the toolkit can paint a live turn at
// 60fps before we wire the real T4SessionStore (Phase B). The C shim owns all
// GObject type casts; every widget here is an opaque GtkWidget*.

private typealias VoidCb = @convention(c) (UnsafeMutableRawPointer?, UnsafeMutableRawPointer?) -> Void

private final class Box {
    let value: () -> Void
    init(_ value: @escaping () -> Void) { self.value = value }
}

private func connect(_ instance: UnsafeMutableRawPointer?, _ signal: String, _ action: @escaping () -> Void) {
    let box = Box(action)
    let cb: VoidCb = { _, userData in
        guard let userData else { return }
        Unmanaged<Box>.fromOpaque(userData).takeUnretainedValue().value()
    }
    let fp = unsafeBitCast(cb as VoidCb, to: GCallback.self)
    g_signal_connect_data(
        instance, signal, fp,
        Unmanaged.passRetained(box).toOpaque(),
        { userData, _ in if let userData { Unmanaged<Box>.fromOpaque(userData).release() } },
        GConnectFlags(rawValue: 0)
    )
}

// MARK: - Streaming state

private final class StreamState {
    var textView: UnsafeMutablePointer<GtkWidget>?
    var buffer: UnsafeMutablePointer<GtkTextBuffer>?
    var codeTag: UnsafeMutablePointer<GtkTextTag>?
    var tickFrames = 0
    var tickStart: Double = 0
    var streamTicks = 0
    var streaming = false
}

private let state = StreamState()

private let streamChunks = [
    "The layout now anchors to the newest content exactly when it should. ",
    "Streaming while at bottom follows every delta; scrolled up it stays put. ",
    "Rows render host-wire durable entries, one widget per line of markdown. ",
    "let answer = try await store.sendPrompt(text)\n",
    "Each delta appends into the same buffer — no relayout storm. ",
    "Tool cards settle in place, code keeps its syntax tint, diffs stay readable. ",
    "This is the frame the compositor sees, every sixteenth of a second. ",
    "The pin lives in the scrolled window, gated by a bottom-anchor flag. ",
    "Verified: sixty frames a second, every character on screen. ",
    "One toolkit, no abstraction tax, the design survives. ",
]

private let streamTimeoutCb: @convention(c) (UnsafeMutableRawPointer?) -> gboolean = { _ in
    let chunk = streamChunks[state.streamTicks % streamChunks.count]
    if let buffer = state.buffer {
        if chunk.contains("store.sendPrompt") {
            shim_text_append_code(buffer, chunk, state.codeTag)
        } else {
            shim_text_append(buffer, chunk)
        }
    }
    state.streamTicks += 1
    return gboolean(state.streaming && state.streamTicks < 600 ? 1 : 0)
}

private let tickCb: GtkTickCallback = { _, _, _ in
    if state.tickStart == 0 { state.tickStart = Double(g_get_monotonic_time()) / 1_000_000 }
    state.tickFrames += 1
    if state.tickFrames % 120 == 0 {
        let now = Double(g_get_monotonic_time()) / 1_000_000
        let fps = 120.0 / (now - state.tickStart)
        state.tickStart = now
        FileHandle.standardError.write(Data("spike: ~\(String(format: "%.1f", fps)) fps while streaming\n".utf8))
    }
    return gboolean(1)
}

private func startStream() {
    guard !state.streaming, state.buffer != nil else { return }
    state.streaming = true
    state.streamTicks = 0
    state.tickFrames = 0
    state.tickStart = 0
    g_timeout_add(16, streamTimeoutCb, nil)
    shim_add_tick(state.textView, tickCb)
}

// MARK: - App

typealias ActFn = @convention(c) (UnsafeMutablePointer<GtkApplication>?, UnsafeMutableRawPointer?) -> Void

let activate: ActFn = { appPtr, _ in
    guard let appPtr, let win = gtk_application_window_new(appPtr) else { return }
    shim_window(win, "T4 Code — pure GTK4 spike", 1100, 700)

    let root = shim_box_new(1, 12)
    shim_window_set_child(win, root)

    // Rail (left, session list)
    let rail = shim_box_new(0, 6)
    shim_css_class(rail, "rail")
    shim_widget_size(rail, 220)
    shim_box_append(root, rail)
    let railTitle = shim_label("Sessions")
    shim_css_class(railTitle, "subtle")
    shim_widget_halign_start(railTitle)
    shim_box_append(rail, railTitle)

    // Center: transcript + composer
    let center = shim_box_new(0, 8)
    shim_widget_expand(center, 1)
    shim_box_append(root, center)

    let scroll = shim_scrolled_window()
    shim_widget_expand(scroll, 0)
    let textView = shim_text_view()
    shim_css_class(textView, "transcript")
    shim_text_view_setup(textView)
    shim_scrolled_set_child(scroll, textView)
    shim_box_append(center, scroll)

    let buffer = shim_text_buffer(textView)
    state.textView = textView
    state.buffer = buffer
    state.codeTag = shim_code_tag(buffer)
    shim_text_append(buffer, "  you — how do i make this transcript stream without a layout storm?\n\n")
    shim_text_append(buffer, "Pure GTK4: the text view appends incrementally, so a live turn is just buffer inserts. No widget-per-line relayout. Watch:")

    // Composer
    let composer = shim_box_new(1, 8)
    shim_css_class(composer, "composer")
    let entry = shim_entry()
    shim_css_class(entry, "composer-entry")
    shim_widget_expand(entry, 1)
    shim_box_append(composer, entry)
    let sendButton = shim_button("Send")
    shim_css_class(sendButton, "send-button")
    shim_box_append(composer, sendButton)
    shim_box_append(center, composer)

    connect(entry, "activate") { startStream() }
    connect(sendButton, "clicked") { startStream() }

    shim_window_present(win)

    // Auto-start the stream after 1s so the perf measurement runs unattended.
    g_timeout_add(1000, { _ in
        startStream()
        return gboolean(0)
    }, nil)
}

let app = gtk_application_new("sh.t4code.gtkspike", GApplicationFlags(rawValue: 0))
let fp = unsafeBitCast(activate as ActFn, to: GCallback.self)
g_signal_connect_data(app, "activate", fp, nil, nil, GConnectFlags(rawValue: 0))
connect(app, "startup") { shim_css_load("/home/alexis/dev/omperator/spike-gtk-linux/theme.css") }
let status = app!.withMemoryRebound(to: GApplication.self, capacity: 1) { g_application_run($0, CommandLine.argc, CommandLine.unsafeArgv) }
g_object_unref(app)
exit(status)
