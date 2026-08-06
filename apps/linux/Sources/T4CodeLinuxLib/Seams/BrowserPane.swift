//  BrowserPane.swift (Linux port of apps/ios/Sources/T4BrowserPane.swift)
//  WebKitGTK surface for the session browser pane. This seam supplies the
//  rendering half: a GtkWidgetRepresentable wrapping a WebKitWebView with
//  URL loading plus back/forward/reload navigation and live URI/loading
//  state, mirroring the macOS WKWebView bridge (T4BrowserWebView).
//
//  Signals ("notify::uri", "notify::is-loading") are connected with raw
//  g_signal_connect_data and @convention(c) marshallers that re-enter Swift
//  through a strongly-retained callback box — the same discipline as the VTE
//  terminal seam (Seams/TerminalPane.swift) and the Gtk module's SignalBox.
//
//  The widget is wrapped from its raw C pointer via GObject.init(_:), which
//  takes a reference on init and releases it on deinit — the ref-counting
//  rule every generated Gtk binding uses for constructor results.

import CWebKit
import Foundation
import Gtk
import GtkBackend
import SwiftCrossUI

/// One navigation action per token increment (mirrors macOS T4BrowserAction).
enum T4BrowserAction: String {
    case back, forward, reload, home
}

/// Snapshot pushed to the view on every URI/loading-state change.
struct T4BrowserNavState: Equatable {
    let uri: String
    let canGoBack: Bool
    let canGoForward: Bool
    let loading: Bool
}

/// Gtk.Widget subclass wrapping a WebKitWebView GObject. One webview is
/// created per representable and reused across updates, so page state
/// survives re-renders (mirrors the macOS coordinator-held WKWebView).
/// The Gtk.Widget is a GtkScrolledWindow containing the webview: WebKit's
/// natural size is the page height, which would otherwise inflate the host
/// window; the scrolled window bounds it and gives the page internal
/// scrolling.
final class T4WebKitWebView: Gtk.Widget {
    let webViewPointer: UnsafeMutablePointer<WebKitWebView>

    /// `wrapping` is the Gtk widget this Gtk.Widget wraps (the webview itself
    /// when used as the scrolled window's child, or the scrolled window when
    /// returned to the representable); `webView` is always the WebKitWebView.
    init(webView: UnsafeMutablePointer<GtkWidget>, wrapping widgetPointer: UnsafeMutablePointer<GtkWidget>) {
        self.webViewPointer = UnsafeMutableRawPointer(webView).assumingMemoryBound(to: WebKitWebView.self)
        super.init(widgetPointer)
    }

    private var handlers: [(id: gulong, box: AnyObject)] = []

    /// Connect a WebKit signal with a C marshaller; `box` keeps the Swift
    /// callbacks alive for the widget's lifetime and is the `user_data` the
    /// marshaller re-enters through. Attaches to the webview (the child),
    /// not the scrolled-window wrapper.
    func connectSignal(name: String, handler: GCallback, box: AnyObject) {
        let id = g_signal_connect_data(
            UnsafeMutableRawPointer(webViewPointer),
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
            g_signal_handler_disconnect(UnsafeMutableRawPointer(webViewPointer), id)
        }
    }
}

/// Retains the Swift callbacks while a raw g_signal_connect handler is
/// attached. One box per connection (the owning widget keeps it alive).
private final class T4BrowserSignalBox {
    let onNavigated: (T4BrowserNavState) -> Void

    init(onNavigated: @escaping (T4BrowserNavState) -> Void) {
        self.onNavigated = onNavigated
    }
}

extension T4BrowserSignalBox {
    /// "notify::uri" / "notify::is-loading" share the (GObject*, GParamSpec*,
    /// gpointer) shape — both marshal to the same state push. The first
    /// parameter is typed as `UnsafeMutableRawPointer` to avoid the
    /// Gtk/CWebKit `GObject` typealias ambiguity.
    static let notifyHandler: @convention(c) (
        UnsafeMutableRawPointer?, UnsafeMutableRawPointer?, UnsafeMutableRawPointer?
    ) -> Void = { object, _, data in
        guard let object, let data else { return }
        let box = Unmanaged<T4BrowserSignalBox>.fromOpaque(data).takeUnretainedValue()
        let view = object.assumingMemoryBound(to: WebKitWebView.self)
        box.onNavigated(currentNavState(view))
    }

    private static func currentNavState(_ view: UnsafeMutablePointer<WebKitWebView>) -> T4BrowserNavState {
        let uri = webkit_web_view_get_uri(view).map { String(cString: $0) } ?? ""
        return T4BrowserNavState(
            uri: uri,
            canGoBack: webkit_web_view_can_go_back(view) != 0,
            canGoForward: webkit_web_view_can_go_forward(view) != 0,
            loading: webkit_web_view_is_loading(view) != 0
        )
    }
}

/// Coordinator: survives representable re-creations, owns the webview
/// signals and the last-applied navigation token.
@MainActor
final class T4BrowserCoordinator {
    let onNavigated: (T4BrowserNavState) -> Void
    private var signalBox: T4BrowserSignalBox?
    var lastActionToken = -1
    /// The URL we last asked the webview to load. Compared against the view's
    /// `url` on updates — reading the webview's own transient URI instead
    /// would restart an in-flight load on every re-render (the URI is nil
    /// until the load commits), leaving the page loading forever.
    var lastRequestedURL: String?

    init(onNavigated: @escaping (T4BrowserNavState) -> Void) {
        self.onNavigated = onNavigated
    }

    /// Apply a navigation action once per token increment.
    func apply(action: T4BrowserAction, token: Int, homeURL: String, on widget: T4WebKitWebView) {
        guard token != lastActionToken else { return }
        lastActionToken = token
        let view = widget.webViewPointer
        switch action {
        case .back: webkit_web_view_go_back(view)
        case .forward: webkit_web_view_go_forward(view)
        case .reload: webkit_web_view_reload(view)
        case .home: webkit_web_view_load_uri(view, homeURL)
        }
    }
}

/// Browser pane: a WebKitWebView loading `url`, sized to fill. `updateGtkWidget`
/// reloads only when the URL actually changed, so re-renders don't reset
/// scroll position or page state.
struct T4BrowserPane: GtkWidgetRepresentable {
    typealias GtkWidgetType = T4WebKitWebView
    typealias Coordinator = T4BrowserCoordinator

    let url: String
    let action: T4BrowserAction
    let actionToken: Int
    let onNavigated: (T4BrowserNavState) -> Void

    init(
        url: String,
        action: T4BrowserAction = .home,
        actionToken: Int = 0,
        onNavigated: @escaping (T4BrowserNavState) -> Void = { _ in }
    ) {
        self.url = url
        self.action = action
        self.actionToken = actionToken
        self.onNavigated = onNavigated
    }

    func makeCoordinator() -> T4BrowserCoordinator {
        T4BrowserCoordinator(onNavigated: onNavigated)
    }

    func makeGtkWidget(context: Context) -> T4WebKitWebView {
        // Bounded box: WebKitWebView's natural size is the page's laid-out
        // size, which inflates the host layout through GtkFixed's
        // natural-size allocation. T4BoundedBox reports a zero natural size
        // and allocates the webview the box's full area, so the pane keeps
        // its frame(width:) and the page lays out responsively.
        guard let boundedBox = t4_bounded_web_view_box_new(),
              let webView = gtk_widget_get_first_child(boundedBox)
        else {
            fatalError("t4_bounded_web_view_box_new() returned nil")
        }
        let widget = T4WebKitWebView(webView: webView, wrapping: boundedBox)
        // Fill whatever space the layout system proposes.
        widget.expandHorizontally = true
        widget.useExpandHorizontally = true
        widget.expandVertically = true
        widget.useExpandVertically = true

        // Live URI/loading state → the view.
        let box = T4BrowserSignalBox(onNavigated: context.coordinator.onNavigated)
        widget.connectSignal(name: "notify::uri", handler: unsafeBitCast(T4BrowserSignalBox.notifyHandler, to: GCallback.self), box: box)
        widget.connectSignal(name: "notify::is-loading", handler: unsafeBitCast(T4BrowserSignalBox.notifyHandler, to: GCallback.self), box: box)

        context.coordinator.lastRequestedURL = url
        webkit_web_view_load_uri(widget.webViewPointer, url)
        return widget
    }

    func updateGtkWidget(_ widget: T4WebKitWebView, context: Context) {
        let view = widget.webViewPointer
        // Apply the queued navigation action (back/forward/reload/home) once.
        context.coordinator.apply(action: action, token: actionToken, homeURL: url, on: widget)
        // Only reload when the URL genuinely changed (never reset scroll state
        // on an unrelated re-render).
        if action == .home || actionToken == context.coordinator.lastActionToken {
            if context.coordinator.lastRequestedURL != url {
                context.coordinator.lastRequestedURL = url
                webkit_web_view_load_uri(view, url)
            }
        }
    }
}
