//  BrowserPane.swift (Linux port of apps/ios/Sources/T4BrowserPane.swift)
//  Session browser pane: toolbar (back/forward/reload + URL field) over a
//  WebKitGTK webview (Seams/BrowserPane.swift), plus the opportunistic host
//  preview launch on appear. Preview-capture overlay is LINUX-GAP (no
//  PlatformImage decode pipeline yet).
//
//  Navigation state (URI / canGoBack / canGoForward / loading) arrives from
//  the seam's "notify::uri"/"notify::is-loading" signals via `onNavigated`;
//  nav actions go the other way through `action`/`actionToken` (same shape
//  as the macOS coordinator pattern).

import SwiftCrossUI
import HostWire

struct T4BrowserPaneView: View {
    let session: SessionRef
    let store: T4SessionStore
    let theme: ThemeStore
    @Binding var isPresented: Bool

    /// The URL to load. Changes only on submit — the seam reloads only when
    /// it differs from the last loaded URL, so re-renders never reload.
    @State private var loadURL: String
    /// The URL field's editable text (may be mid-edit, not yet submitted).
    @State private var urlField: String
    @State private var canGoBack = false
    @State private var canGoForward = false
    @State private var loading = false
    /// The current nav action, applied once per `actionToken` increment.
    @State private var action: T4BrowserAction = .home
    @State private var actionToken = 0

    private var t: Theme { theme.t }

    init(session: SessionRef, store: T4SessionStore, theme: ThemeStore, isPresented: Binding<Bool>) {
        self.session = session
        self.store = store
        self.theme = theme
        self._isPresented = isPresented
        let initial = store.browserURL(for: session.sessionId)
        self._loadURL = State(wrappedValue: initial)
        self._urlField = State(wrappedValue: initial)
    }

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider(t.line)
            T4BrowserPane(
                url: loadURL,
                action: action,
                actionToken: actionToken
            ) { navState in
                canGoBack = navState.canGoBack
                canGoForward = navState.canGoForward
                loading = navState.loading
                if !navState.uri.isEmpty, navState.uri != loadURL {
                    urlField = navState.uri
                }
            }
            .background(t.bg2)
        }
        .background(t.bg)
        .task {
            // Opportunistic host preview launch — no-op when unsupported.
            await store.openPreview(sessionId: session.sessionId, url: loadURL)
        }
    }

    // MARK: - Toolbar

    private var toolbar: some View {
        HStack(spacing: 6) {
            navButton("◀", enabled: canGoBack) { perform(.back) }
            navButton("▶", enabled: canGoForward) { perform(.forward) }
            navButton("⟳", enabled: true) { perform(.reload) }
            navButton("⌂", enabled: true) { perform(.home) }

            TextField("Enter URL", text: $urlField)
                .font(.term(13))
                .textContentType(.url)
                .foregroundColor(t.txt)
                .padding(6)
                .background {
                    RoundedRectangle(cornerRadius: t.r).fill(t.glassFill)
                }
                .onSubmit(perform: submitURL)

            if loading {
                ProgressView()
            }

            T4TextButton("Done") { isPresented = false }
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(t.interactiveAccent)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(t.bg)
    }

    private func navButton(_ glyph: String, enabled: Bool, action run: @escaping () -> Void) -> some View {
        T4TextButton(glyph, action: run)
            .font(.system(size: 14))
            .foregroundColor(enabled ? t.txt : t.txtGhost)
            .disabled(!enabled)
            .frame(width: 30, height: 30)
    }

    // MARK: - Actions

    private func perform(_ a: T4BrowserAction) {
        action = a
        actionToken += 1
    }

    private func submitURL() {
        let trimmed = urlField.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        var normalized = trimmed
        if !normalized.contains("://") {
            normalized = "https://\(normalized)"
        }
        loadURL = normalized
        urlField = normalized
        action = .home
        actionToken += 1
    }
}
