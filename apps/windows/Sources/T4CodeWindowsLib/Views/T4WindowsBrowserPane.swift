import Foundation
import SwiftCrossUI
import HostWire

struct T4BrowserPaneView: View {
    let session: SessionRef
    let store: T4SessionStore
    let theme: ThemeStore
    @State private var browserModel: T4WindowsBrowserWorkspaceModel
    let fixtureEnabled: Bool
    let isPresented: Binding<Bool>

    @State private var activeSessionID = ""

    private var t: Theme { theme.t }
    private var fixtureHTML: String? {
        fixtureEnabled ? T4WindowsBrowserFixture.html : nil
    }
    private var captureFailure: Bool {
        T4SessionStore.demoMode
            && ProcessInfo.processInfo.arguments.contains("-T4BrowserFailure")
    }

    private var initialURL: String {
        store.browserURL(for: session.sessionId)
    }
    private var snapshot: T4WindowsBrowserSnapshot {
        browserModel.currentSnapshot(
            sessionID: session.sessionId,
            initialURL: initialURL
        )
    }
    private var address: Binding<String> {
        Binding(
            get: { snapshot.address },
            set: {
                browserModel.setAddress(
                    $0,
                    sessionID: session.sessionId,
                    initialURL: initialURL
                )
            }
        )
    }
    init(
        session: SessionRef,
        store: T4SessionStore,
        theme: ThemeStore,
        browserModel: T4WindowsBrowserWorkspaceModel,
        fixtureEnabled: Bool,
        isPresented: Binding<Bool>
    ) {
        self.session = session
        self.store = store
        self.theme = theme
        self._browserModel = State(wrappedValue: browserModel)
        self.fixtureEnabled = fixtureEnabled
        self.isPresented = isPresented
    }

    /// Source-aligned Linux detail views remain compiled in the Windows
    /// library. If one is instantiated, it receives the real native browser
    /// with pane-local state rather than the removed placeholder.
    init(
        session: SessionRef,
        store: T4SessionStore,
        theme: ThemeStore,
        isPresented: Binding<Bool>
    ) {
        self.init(
            session: session,
            store: store,
            theme: theme,
            browserModel: T4WindowsBrowserWorkspaceModel(),
            fixtureEnabled: false,
            isPresented: isPresented
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider(t.line)
            browserSurface
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(t.bg)
        .onAppear {
            activateSessionIfNeeded()
        }
        .onChange(of: session.sessionId) {
            activateSessionIfNeeded()
        }
        .onChange(of: theme.effective) {
            activateSurface()
        }
    }

    private var toolbar: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                navButton("‹", name: "Back", enabled: snapshot.canGoBack && snapshot.surfaceState == .ready) {
                    issue(.back)
                }
                navButton("›", name: "Forward", enabled: snapshot.canGoForward && snapshot.surfaceState == .ready) {
                    issue(.forward)
                }
                navButton(
                    snapshot.isLoading ? "■" : "↻",
                    name: snapshot.isLoading ? "Stop loading" : "Reload",
                    enabled: snapshot.surfaceState == .ready
                ) {
                    issue(snapshot.isLoading ? .stop : .reload)
                }

                TextField("Enter URL", text: address)
                    .font(.term(12))
                    .textContentType(.url)
                    .foregroundColor(t.txt)
                    .inspect([.onCreate, .afterUpdate]) { field in
                        T4WindowsNativeStyle.configureInput(
                            field,
                            automationName: "Browser address",
                            dark: theme.dark
                        )
                    }
                    .onSubmit { issue(.navigate(snapshot.address)) }

                if snapshot.isLoading {
                    ProgressView()
                }

                T4WindowsFlatButton("×", automationName: "Hide browser sidebar", dark: theme.dark) {
                    isPresented.wrappedValue = false
                }
            }
            Text(snapshot.title.isEmpty ? "Browser" : snapshot.title)
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(t.txtMuted)
                .lineLimit(1)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 5)
        .background(t.bg)
    }

    private func navButton(
        _ glyph: String,
        name: String,
        enabled: Bool,
        action: @escaping @MainActor @Sendable () -> Void
    ) -> some View {
        T4WindowsFlatButton(glyph, automationName: name, dark: theme.dark, width: 28, action: action)
            .font(.system(size: 14))
            .foregroundColor(enabled ? t.txt : t.txtGhost)
            .disabled(!enabled)
            .frame(height: 28)
    }


    private var browserSurface: some View {
        ZStack {
            if !captureFailure {
                GeometryReader { geometry in
                    T4WindowsWebView2(bridge: browserModel.surfaceBridge)
                        .frame(width: geometry.size.width, height: geometry.size.height)
                }
            }

            if captureFailure {
                browserMessage(
                    title: "Browser unavailable",
                    detail: "WebView2 could not initialize for this session."
                )
            } else if snapshot.errorMessage != nil {
                browserMessage(title: "Browser error", detail: "The page could not be loaded.")
            } else {
                switch snapshot.surfaceState {
                case .initializing:
                    browserMessage(
                        title: "Starting WebView2",
                        detail: "Preparing the native browser surface."
                    )
                case .unavailable:
                    browserMessage(
                        title: "Browser unavailable",
                        detail: "WebView2 is not available on this computer."
                    )
                case .idle, .ready:
                    EmptyView()
                }
            }
        }
        .frame(minHeight: 220, maxHeight: .infinity)
        .background(t.bg2)
    }

    private func browserMessage(title: String, detail: String) -> some View {
        VStack(spacing: 7) {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(t.txt)
            Text(detail)
                .font(.system(size: 10))
                .foregroundColor(t.txtMuted)
                .multilineTextAlignment(.center)
        }
        .padding(16)
        .frame(maxWidth: 300)
        .background {
            RoundedRectangle(cornerRadius: 10).fill(t.panel)
        }
    }



    private func activateSessionIfNeeded() {
        guard !captureFailure else { return }
        if activeSessionID != session.sessionId {
            activeSessionID = session.sessionId
            _ = browserModel.mount(
                sessionID: session.sessionId,
                initialURL: initialURL
            )
        }
        activateSurface()
    }

    private func activateSurface() {
        browserModel.surfaceBridge.activate(.init(
            sessionID: session.sessionId,
            initialURL: snapshot.currentURL,
            fixtureHTML: fixtureHTML,
            backgroundHex: theme.effective == .dark ? 0x232136 : 0xFAF4ED
        ))
    }

    private func issue(_ action: T4WindowsBrowserAction) {
        guard let command = browserModel.dispatch(
            sessionID: session.sessionId,
            action: action
        ) else {
            return
        }
        if case .navigate(let url) = command {
            store.setBrowserURL(for: session.sessionId, url: url)
        }
    }
}

enum T4WindowsBrowserFixture {
    static let html: String? = {
        guard let url = Bundle.module.url(
            forResource: "BrowserFixture",
            withExtension: "html"
        ) else {
            return nil
        }
        return try? String(contentsOf: url, encoding: .utf8)
    }()
}
