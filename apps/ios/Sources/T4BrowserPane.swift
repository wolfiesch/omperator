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

/// One captured element tap from "design mode" annotation: a concise CSS
/// selector, a short visible-text snippet, and the page URL the element
/// lives on. Reported by the webview's injected one-shot click handler and
/// shown in the note sheet before composing a prompt.
struct DesignTapCapture: Identifiable {
    let selector: String
    let snippet: String
    let url: String
    var id: String { selector + snippet + url }
}

/// Browser sheet for one session. Presented from the session detail header's
/// safari button. Owns the WKWebView via `T4BrowserWebView`; the URL field is
/// seeded from `store.browserURL(for:)` and persisted on submit/navigation.
struct T4BrowserPane: View {
    let session: SessionRef
    @ObservedObject var store: T4SessionStore
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
    /// "Design mode lite": when true, the next tap in the webview is
    /// intercepted to capture an element selector + snippet. One-shot —
    /// cleared after a single capture (or when toggled off).
    @State private var annotating = false
    /// The most recent captured tap, presented as the note sheet's `item`.
    @State private var tapCapture: DesignTapCapture?
    /// The user's note typed in the annotation sheet.
    @State private var note = ""
    /// Whether the capture view is presented over the webview.
    @State private var showingCapture = false
    @FocusState private var urlFieldFocused: Bool
    private var t: Theme { theme.t }

    init(session: SessionRef, store: T4SessionStore, isPresented: Binding<Bool>) {
        self.session = session
        self.store = store
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
                    annotating: annotating,
                    onNavigated: { resolved in handleNavigated(resolved) },
                    onTapCapture: { capture in handleTapCapture(capture) }
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
        // Design-mode note sheet: selector + snippet + a note field. Send
        // builds a structured prompt and prefills the session composer (via
        // the store's pendingComposerText channel) without auto-sending.
        .sheet(item: $tapCapture) { _ in annotationSheet }
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
            annotateButton
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
        store.previewIdBySession[session.sessionId] != nil
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

    /// "Design mode lite" toggle. When active, the next webview tap is
    /// intercepted to capture an element; the button stays highlighted until
    /// that one-shot capture resolves (or the user toggles it off).
    private var annotateButton: some View {
        Button { annotating.toggle() } label: {
            Image(systemName: "cursorarrow.rays")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(annotating ? t.accent : t.txt)
                .frame(width: 28, height: 28)
        }
        .press()
        .accessibilityLabel(annotating ? "Cancel annotation" : "Annotate an element")
    }

    /// A webview tap was captured — present the note sheet and end the
    /// one-shot annotate mode so subsequent taps navigate normally.
    private func handleTapCapture(_ capture: DesignTapCapture) {
        annotating = false
        note = ""
        tapCapture = capture
    }

    /// Note sheet: shows the captured selector + snippet and asks what should
    /// change. Send builds a structured prompt and prefills the composer.
    private var annotationSheet: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Annotate element")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(t.txt)
            if let capture = tapCapture {
                VStack(alignment: .leading, spacing: 6) {
                    Text(capture.url)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(t.txtLabel)
                        .lineLimit(1).truncationMode(.middle)
                    Text(capture.selector)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(t.txtBody)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if !capture.snippet.isEmpty {
                        Text("\u{201C}\(capture.snippet)\u{201D}")
                            .font(.bodyF(12))
                            .foregroundStyle(t.txtMuted)
                            .lineLimit(2)
                    }
                }
                .padding(10)
                .background(t.bg2, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            TextField("What should change?", text: $note, axis: .vertical)
                .font(.bodyF(14))
                .foregroundStyle(t.txt)
                .tint(t.interactiveAccent)
                .lineLimit(1...4)
                #if os(iOS)
                .textInputAutocapitalization(.sentences)
                #endif
                .padding(.horizontal, 10).padding(.vertical, 8)
                .background(t.bg2)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(t.line, lineWidth: 0.5))
            HStack(spacing: 12) {
                Spacer()
                Button("Cancel") { tapCapture = nil; note = "" }
                    .foregroundStyle(t.txtMuted)
                Button {
                    sendAnnotation()
                } label: {
                    Text("Send")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16).padding(.vertical, 7)
                        .background(t.accent, in: Capsule())
                }
                .disabled(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(maxWidth: 420)
        .background(t.bg)
        #if os(iOS)
        .presentationDetents([.medium])
        #endif
    }

    /// Build the structured design prompt and prefill the session composer.
    /// Does NOT auto-send — the user reviews and sends from the composer.
    private func sendAnnotation() {
        guard let capture = tapCapture else { return }
        let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedNote.isEmpty else { return }
        // Flatten so the prompt is a single readable line for the composer.
        let selector = capture.selector.replacingOccurrences(of: "\n", with: " ")
        let snippet = capture.snippet.replacingOccurrences(of: "\n", with: " ")
        let prompt = "[design] \(capture.url) element `\(selector)` (\"\(snippet)\"): \(trimmedNote)"
        store.pendingComposerText = prompt
        tapCapture = nil
        note = ""
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
    /// When true, the coordinator installs a one-shot click handler in the
    /// webview that captures the tapped element and reports it via
    /// `onTapCapture`. Cleared (set false) by the pane after one capture.
    let annotating: Bool
    let onNavigated: (String) -> Void
    let onTapCapture: (DesignTapCapture) -> Void

    var body: some View {
        #if os(iOS)
        UIKitBrowserWebView(
            loadURL: loadURL,
            action: action,
            actionToken: actionToken,
            canGoBack: $canGoBack,
            canGoForward: $canGoForward,
            loading: $loading,
            annotating: annotating,
            onNavigated: onNavigated,
            onTapCapture: onTapCapture
        )
        #else
        AppKitBrowserWebView(
            loadURL: loadURL,
            action: action,
            actionToken: actionToken,
            canGoBack: $canGoBack,
            canGoForward: $canGoForward,
            loading: $loading,
            annotating: annotating,
            onNavigated: onNavigated,
final class T4BrowserCoordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    let webView: WKWebView

    var canGoBack: Binding<Bool>
    var canGoForward: Binding<Bool>
    var loading: Binding<Bool>
    var onNavigated: (String) -> Void
    /// Reports a captured element tap from the injected JS handler. Set by
    /// the representable on each update.
    var onTapCapture: ((DesignTapCapture) -> Void)?
    private var lastLoadedURL: String?
    private var lastActionToken: Int = -1
    /// Mirrors the last `annotating` value applied so install/remove runs
    /// only on transitions, not every updateUIView pass.
    private var lastAnnotating = false
    /// The message-handler name bridging the injected JS → coordinator.
    static let tapMessageName = "designModeTap"

    init(canGoBack: Binding<Bool>,
         canGoForward: Binding<Bool>,
         loading: Binding<Bool>,
         onNavigated: @escaping (String) -> Void) {
        let config = WKWebViewConfiguration()
        #if os(iOS)
        config.allowsInlineMediaPlayback = true
        config.allowsAirPlayForMediaPlayback = true
        #endif
        // Register the design-mode tap bridge before the webview copies the
        // config; the coordinator receives postMessage calls here.
        config.userContentController.add(self, name: Self.tapMessageName)
        self.webView = WKWebView(frame: .zero, configuration: config)
        self.canGoBack = canGoBack
        self.canGoForward = canGoForward
        self.loading = loading
        self.onNavigated = onNavigated
        super.init()
        webView.navigationDelegate = self
    }

    deinit {
        // Drop the handler ref so a reused userContentController doesn't leak
        // the coordinator (retain-cycle) once the pane is dismissed.
        webView.configuration.userContentController.removeScriptMessageHandler(forName: Self.tapMessageName)
    }
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
    /// unchanged inputs are no-ops. `annotating` installs/removes the one-shot
    /// element-capture click handler on transitions only.
    func apply(loadURL: String, action: T4BrowserAction, actionToken: Int, annotating: Bool) {
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
        if annotating != lastAnnotating {
            lastAnnotating = annotating
            if annotating { installTapHandler() } else { removeTapHandler() }
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

    // MARK: Design-mode tap capture

    /// Inject a one-shot capture-phase click listener. On the next click it
    /// prevents default, builds a concise CSS selector for the target (id →
    /// tag.class chain with nth-of-type disambiguation), grabs a short text
    /// snippet + the page URL, removes itself, and posts the payload back to
    /// the coordinator via the registered message handler.
    private func installTapHandler() {
        let js = """
        (function(){
          if (window.__t4DesignTap) { document.removeEventListener('click', window.__t4DesignTap, true); }
          function esc(s){ return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&'); }
          function buildSelector(el){
            var parts = [];
            var cur = el;
            while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
              if (cur.id) { parts.unshift('#' + esc(cur.id)); break; }
              var tag = cur.tagName.toLowerCase();
              var part = tag;
              var cls = (cur.className && typeof cur.className === 'string') ? cur.className.trim().split(/\\s+/).filter(Boolean) : [];
              if (cls.length) { part += '.' + cls.map(esc).join('.'); }
              var sibs = Array.from(cur.parentNode.children).filter(function(n){ return n.tagName === cur.tagName; });
              if (sibs.length > 1) { part += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')'; }
              parts.unshift(part);
              cur = cur.parentNode;
            }
            return parts.join(' > ');
          }
          function handler(e){
            e.preventDefault(); e.stopPropagation();
            document.removeEventListener('click', handler, true);
            window.__t4DesignTap = null;
            var el = e.target;
            while (el && el.nodeType !== 1 && el.parentNode) { el = el.parentNode; }
            if (!el || el.nodeType !== 1) { return; }
            var selector = buildSelector(el);
            if (selector.length > 120) { selector = selector.slice(0, 117) + '...'; }
            var snippet = (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
            try { webkit.messageHandlers.designModeTap.postMessage({ selector: selector, snippet: snippet, url: location.href }); } catch(_) {}
          }
          window.__t4DesignTap = handler;
          document.addEventListener('click', handler, true);
        })();
        """
        webView.evaluateJavaScript(js)
    }

    /// Tear down the injected listener without firing it (user toggled off,
    /// or the pane is resetting annotate mode after a capture).
    private func removeTapHandler() {
        webView.evaluateJavaScript(
            "(function(){ if (window.__t4DesignTap) { document.removeEventListener('click', window.__t4DesignTap, true); window.__t4DesignTap = null; } })();"
        )
    }

    // MARK: WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.tapMessageName,
              let body = message.body as? [String: Any],
              let selector = body["selector"] as? String,
              let url = body["url"] as? String else { return }
        let snippet = (body["snippet"] as? String) ?? ""
        // Delivered on the main thread by WebKit — safe to invoke SwiftUI cb.
        onTapCapture?(DesignTapCapture(selector: selector, snippet: snippet, url: url))
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        loading.wrappedValue = true
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        syncState()
        // A new document drops the injected handler — re-arm if annotate
        // mode is still on so the user doesn't have to toggle again.
        if lastAnnotating { installTapHandler() }
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
    let annotating: Bool
    let onNavigated: (String) -> Void
    let onTapCapture: (DesignTapCapture) -> Void

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
        context.coordinator.onTapCapture = onTapCapture
        context.coordinator.apply(loadURL: loadURL, action: action, actionToken: actionToken, annotating: annotating)
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
    let annotating: Bool
    let onNavigated: (String) -> Void
    let onTapCapture: (DesignTapCapture) -> Void

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
        context.coordinator.onTapCapture = onTapCapture
        context.coordinator.apply(loadURL: loadURL, action: action, actionToken: actionToken, annotating: annotating)
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
