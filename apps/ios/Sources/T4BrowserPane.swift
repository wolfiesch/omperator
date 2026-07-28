//  T4BrowserPane.swift
//  A native browser sheet for a session, desktop-parity: WKWebView (fast,
//  hardware-accelerated, native-first) wrapped in a SwiftUI representable,
//  with a toolbar — back, forward, reload, an editable monospaced URL field,
//  and an "Open in Safari"/share button. The pane renders any http(s) URL
//  directly in WKWebView with NO host support required. When the host does
//  offer previews (capability preview.control/preview.read), opening the
//  pane opportunistically fires `preview.launch {url}` via the store's
//  controller-lease path so the host's preview pipeline tracks the same URL;
//  an unsupported host errors and we no-op — the pane keeps rendering.
//  The URL field is persisted per session in `store.browserURLBySession`.

import SwiftUI
import HostWire
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

#if canImport(WebKit)
import WebKit

/// A toolbar-driven navigation action. Paired with an incrementing token so a
/// repeated tap (same case, new token) re-fires — sentinels stored in a
/// @State URL string would either loop on re-render or swallow repeats.
enum T4BrowserAction: Equatable { case back, forward, reload }

/// Browser sheet for one session. Presented from the session detail header's
/// safari button. Owns the WKWebView via `T4BrowserWebView`; the URL field is
/// seeded from `store.browserURL(for:)` and persisted on submit/navigation.
struct T4BrowserPane: View {
    let session: SessionRef
    @ObservedObject var store: T4SessionStore
    @ObservedObject private var previewModel: T4PreviewBrowserModel
    @EnvironmentObject var theme: ThemeStore
    @Binding var isPresented: Bool

    /// The URL to load. Changes only on submit — the representable loads it
    /// when it differs from the last loaded URL, so re-renders never reload.
    @State private var loadURL: String
    /// The URL field's editable text (may be mid-edit, not yet submitted).
    @State private var urlField: String
    @State private var canGoBack = false
    @State private var canGoForward = false
    @State private var loading = false
    /// Incremented on each back/forward/reload tap; `action` names which.
    @State private var action: T4BrowserAction = .reload
    @State private var actionToken = 0
    /// The latest decoded capture image (from `store.previewCapture`), shown
    /// full-fit in place of the webview while `showingCapture` is true.
    @State private var captureImage: PlatformImage?
    /// Whether the capture view is presented over the webview.
    @State private var showingCapture = false
    @FocusState private var urlFieldFocused: Bool
    private var t: Theme { theme.t }

    init(session: SessionRef, store: T4SessionStore, isPresented: Binding<Bool>) {
        self.session = session
        self.store = store
        self._previewModel = ObservedObject(wrappedValue: store.previewModel)
        self._isPresented = isPresented
        let initial = store.browserURL(for: session.sessionId)
        self._loadURL = State(initialValue: initial)
        self._urlField = State(initialValue: initial)
    }
    var body: some View {
        VStack(spacing: 0) {
            if showingCapture, let image = captureImage {
                captureBar
                Rectangle().fill(t.line).frame(height: 0.5)
                ZoomableCaptureImage(image: image)
                    .background(t.bg2)
            } else {
                toolbar
                Rectangle().fill(t.line).frame(height: 0.5)
                T4BrowserWebView(
                    loadURL: loadURL,
                    action: action,
                    actionToken: actionToken,
                    canGoBack: $canGoBack,
                    canGoForward: $canGoForward,
                    loading: $loading,
                    onNavigated: { resolved in handleNavigated(resolved) }
                )
                .background(t.bg2)
            }
        }
        .background(t.bg)
        .toolbar {
            ToolbarItem(placement: platformTrailingPlacement) {
                Button("Done") { isPresented = false }
                    .font(.system(size: 14, weight: .semibold))
            }
        }
        .navigationTitle("Browser")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .task {
            // Opportunistic host preview launch — no-op when unsupported.
            await store.openPreview(sessionId: session.sessionId, url: loadURL)
        }
    }

    /// Toolbar: back, forward, reload, editable monospaced URL field, share.
    private var toolbar: some View {
        HStack(spacing: 6) {
            Button { fire(.back) } label: {
                Image(systemName: "chevron.backward")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(canGoBack ? t.txt : t.txtGhost)
                    .frame(width: 28, height: 28)
            }
            .press()
            .disabled(!canGoBack)
            .accessibilityLabel("Back")
            Button { fire(.forward) } label: {
                Image(systemName: "chevron.forward")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(canGoForward ? t.txt : t.txtGhost)
                    .frame(width: 28, height: 28)
            }
            .press()
            .disabled(!canGoForward)
            .accessibilityLabel("Forward")
            Button { fire(.reload) } label: {
                Image(systemName: loading ? "stop.fill" : "arrow.clockwise")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(t.txt)
                    .frame(width: 28, height: 28)
            }
            .press()
            .accessibilityLabel(loading ? "Stop" : "Reload")
            TextField("Enter URL", text: $urlField)
                .font(.system(size: 12, design: .monospaced))
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
                .autocorrectionDisabled(true)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(t.bg2)
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(t.line, lineWidth: 0.5))
                .focused($urlFieldFocused)
                .onSubmit { submitURL() }
            captureButton
            shareButton
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(t.bg)
    }

    /// "Open in Safari" on iOS / "Open in default browser" on macOS.
    private var shareButton: some View {
        Button { openExternal() } label: {
            Image(systemName: "safari")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(t.txt)
                .frame(width: 28, height: 28)
        }
        .press()
        #if os(iOS)
        .accessibilityLabel("Open in Safari")
        #else
        .accessibilityLabel("Open in default browser")
        #endif
    }

    /// Fire a back/forward/reload by bumping the token — each tap re-triggers
    /// the representable even when the action case is unchanged.
    private func fire(_ a: T4BrowserAction) {
        action = a
        actionToken += 1
    }

    /// Normalize the URL field into an http(s) URL and load it. Prepends
    /// `http://` when the user typed a bare host (e.g. `localhost:3000`).
    private func submitURL() {
        let trimmed = urlField.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let normalized: String
        if trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://") {
            normalized = trimmed
        } else {
            normalized = "http://" + trimmed
        }
        urlField = normalized
        urlFieldFocused = false
        loadURL = normalized
        store.setBrowserURL(for: session.sessionId, url: normalized)
        Task { await store.openPreview(sessionId: session.sessionId, url: normalized) }
    }

    /// The WKWebView reports the resolved URL after navigation/redirects —
    /// sync the field and persist it. `loadURL` is intentionally NOT updated
    /// here (it stays at the user's submitted URL) so re-renders never reload.
    private func handleNavigated(_ resolved: String) {
        urlField = resolved
        store.setBrowserURL(for: session.sessionId, url: resolved)
    }

    /// Open the current URL in the system browser (Safari / default browser).
    private func openExternal() {
        let target = urlField.hasPrefix("http") ? urlField : loadURL
        guard let url = URL(string: target) else { return }
        #if os(iOS)
        UIApplication.shared.open(url)
        #else
        NSWorkspace.shared.open(url)
        #endif
    }

    /// Capture button — fires `preview.capture` via the store and presents the
    /// reassembled image full-fit. Disabled when no preview is tracked for the
    /// session (the host lacks preview support or hasn't launched one yet).
    private var captureButton: some View {
        Button { Task { await captureNow() } } label: {
            Image(systemName: "camera.viewfinder")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(canCapture ? t.txt : t.txtGhost)
                .frame(width: 28, height: 28)
        }
        .press()
        .disabled(!canCapture)
        .accessibilityLabel("Capture")
    }

    /// Whether a host preview is tracked for this session (gates the Capture
    /// button). The pane still renders the URL directly when false.
    private var canCapture: Bool {
        previewModel.previewIdBySession[session.sessionId] != nil
    }

    /// Capture bar shown in place of the toolbar while the capture view is
    /// presented: a Back button returns to the webview.
    private var captureBar: some View {
        HStack(spacing: 6) {
            Button { showingCapture = false } label: {
                Image(systemName: "chevron.backward")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(t.txt)
                    .frame(width: 28, height: 28)
            }
            .press()
            .accessibilityLabel("Back")
            Text("Capture")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(t.txt)
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(t.bg)
    }

    /// Trigger a preview capture and present the reassembled image. Falls
    /// back to the latest already-fetched capture when the command fails.
    private func captureNow() async {
        var image = await store.previewCapture(sessionId: session.sessionId)
        if image == nil { image = store.latestCaptureImage(for: session.sessionId) }
        guard let image else { return }
        captureImage = image
        showingCapture = true
    }
}

// MARK: - Capture view

/// Pinch-zoomable, full-fit render of a decoded preview capture. The image is
/// fit to the available space (aspectRatio .fit), then magnified [1, 8] and
/// panned via simultaneous gestures. Works on iOS (touch pinch) and macOS
/// (trackpad pinch + drag).
struct ZoomableCaptureImage: View {
    let image: PlatformImage
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero

    var body: some View {
        Image(platformImage: image)
            .resizable()
            .aspectRatio(contentMode: .fit)
            .scaleEffect(scale)
            .offset(offset)
            .gesture(
                MagnificationGesture()
                    .onChanged { scale = max(1, min(8, lastScale * $0)) }
                    .onEnded { _ in
                        lastScale = scale
                        if scale <= 1 { offset = .zero; lastOffset = .zero }
                    }
            )
            .simultaneousGesture(
                DragGesture()
                    .onChanged {
                        offset = CGSize(width: lastOffset.width + $0.translation.width,
                                        height: lastOffset.height + $0.translation.height)
                    }
                    .onEnded { _ in lastOffset = offset }
            )
    }
}

// MARK: - WKWebView representable

/// SwiftUI bridge to WKWebView. One webview is created and reused across
/// updates (held in the coordinator). `loadURL` loads a page when it changes;
/// `action`/`actionToken` fire back/forward/reload on each new token.
/// `onNavigated` reports the resolved URL; back/forward/loading update via
/// bindings.
struct T4BrowserWebView: View {
    let loadURL: String
    let action: T4BrowserAction
    let actionToken: Int
    @Binding var canGoBack: Bool
    @Binding var canGoForward: Bool
    @Binding var loading: Bool
    let onNavigated: (String) -> Void

    var body: some View {
        #if os(iOS)
        UIKitBrowserWebView(
            loadURL: loadURL,
            action: action,
            actionToken: actionToken,
            canGoBack: $canGoBack,
            canGoForward: $canGoForward,
            loading: $loading,
            onNavigated: onNavigated
        )
        #else
        AppKitBrowserWebView(
            loadURL: loadURL,
            action: action,
            actionToken: actionToken,
            canGoBack: $canGoBack,
            canGoForward: $canGoForward,
            loading: $loading,
            onNavigated: onNavigated
        )
        #endif
    }
}

/// Shared WKWebView holder + navigation delegate. Created once per
/// representable, retained by SwiftUI across updates so page state survives
/// re-renders.
final class T4BrowserCoordinator: NSObject, WKNavigationDelegate {
    let webView: WKWebView

    var canGoBack: Binding<Bool>
    var canGoForward: Binding<Bool>
    var loading: Binding<Bool>
    var onNavigated: (String) -> Void
    private var lastLoadedURL: String?
    private var lastActionToken: Int = -1

    init(canGoBack: Binding<Bool>,
         canGoForward: Binding<Bool>,
         loading: Binding<Bool>,
         onNavigated: @escaping (String) -> Void) {
        let config = WKWebViewConfiguration()
        #if os(iOS)
        config.allowsInlineMediaPlayback = true
        config.allowsAirPlayForMediaPlayback = true
        #endif
        self.webView = WKWebView(frame: .zero, configuration: config)
        self.canGoBack = canGoBack
        self.canGoForward = canGoForward
        self.loading = loading
        self.onNavigated = onNavigated
        super.init()
        webView.navigationDelegate = self
    }

    /// Sync SwiftUI state from the webview. MUST be deferred: apply() runs
    /// inside updateUIView, and publishing binding changes mid-update can
    /// tear down the hosting sheet.
    private func syncStateDeferred() {
        DispatchQueue.main.async { [weak self] in self?.syncState() }
    }

    /// Apply the latest load URL + action token. A new token runs the named
    /// action once; a changed loadURL loads the page once. Re-renders with
    /// unchanged inputs are no-ops.
    func apply(loadURL: String, action: T4BrowserAction, actionToken: Int) {
        if actionToken != lastActionToken {
            lastActionToken = actionToken
            switch action {
            case .back:    if webView.canGoBack    { webView.goBack() }
            case .forward: if webView.canGoForward { webView.goForward() }
            case .reload:  webView.reload()
            }
        }
        if loadURL != lastLoadedURL, let target = URL(string: loadURL) {
            lastLoadedURL = loadURL
            webView.load(URLRequest(url: target))
        }
        syncStateDeferred()
    }

    func syncState() {
        canGoBack.wrappedValue = webView.canGoBack
        canGoForward.wrappedValue = webView.canGoForward
        loading.wrappedValue = webView.isLoading
        if let current = webView.url?.absoluteString {
            onNavigated(current)
        }
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        loading.wrappedValue = true
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        syncState()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        syncState()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        syncState()
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        syncState()
    }
}

#if os(iOS)
import UIKit

/// iOS WKWebView bridge. The webview is pinned to the safe area; the
/// coordinator is created once and reused.
struct UIKitBrowserWebView: UIViewRepresentable {
    let loadURL: String
    let action: T4BrowserAction
    let actionToken: Int
    @Binding var canGoBack: Bool
    @Binding var canGoForward: Bool
    @Binding var loading: Bool
    let onNavigated: (String) -> Void

    func makeCoordinator() -> T4BrowserCoordinator {
        T4BrowserCoordinator(canGoBack: $canGoBack,
                             canGoForward: $canGoForward,
                             loading: $loading,
                             onNavigated: onNavigated)
    }

    func makeUIView(context: Context) -> WKWebView {
        let web = context.coordinator.webView
        web.allowsBackForwardNavigationGestures = true
        web.scrollView.contentInsetAdjustmentBehavior = .never
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        // Rebind in case SwiftUI recreated the bindings.
        context.coordinator.canGoBack = $canGoBack
        context.coordinator.canGoForward = $canGoForward
        context.coordinator.loading = $loading
        context.coordinator.onNavigated = onNavigated
        context.coordinator.apply(loadURL: loadURL, action: action, actionToken: actionToken)
    }
}
#else
import AppKit

/// macOS WKWebView bridge. The webview fills the pane; the coordinator is
/// created once and reused.
struct AppKitBrowserWebView: NSViewRepresentable {
    let loadURL: String
    let action: T4BrowserAction
    let actionToken: Int
    @Binding var canGoBack: Bool
    @Binding var canGoForward: Bool
    @Binding var loading: Bool
    let onNavigated: (String) -> Void

    func makeCoordinator() -> T4BrowserCoordinator {
        T4BrowserCoordinator(canGoBack: $canGoBack,
                             canGoForward: $canGoForward,
                             loading: $loading,
                             onNavigated: onNavigated)
    }

    func makeNSView(context: Context) -> WKWebView {
        let web = context.coordinator.webView
        web.allowsBackForwardNavigationGestures = true
        return web
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {
        context.coordinator.canGoBack = $canGoBack
        context.coordinator.canGoForward = $canGoForward
        context.coordinator.loading = $loading
        context.coordinator.onNavigated = onNavigated
        context.coordinator.apply(loadURL: loadURL, action: action, actionToken: actionToken)
    }
}
#endif

#else
// WebKit unavailable (non-Apple toolchain) — render a graceful stub so the
// file still compiles everywhere `T4BrowserPane` is referenced.
struct T4BrowserPane: View {
    let session: SessionRef
    @ObservedObject var store: T4SessionStore
    @Binding var isPresented: Bool
    var body: some View {
        Text("Browser unavailable on this platform.")
            .padding()
    }
}
#endif
