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

    private var palette: WindowsCorePalette { WindowsCorePalette(theme.effective) }
    private var fixtureHTML: String? {
        fixtureEnabled ? T4WindowsBrowserFixture.html : nil
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
            header
            Divider(palette.line)
            navigationBar
            Divider(palette.line)
            statusBar
            Divider(palette.line)
            browserSurface
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(palette.canvas)
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

    private var header: some View {
        HStack(spacing: 8) {
            Text("Browser")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(palette.text)
            Text(session.title)
                .font(.system(size: 10))
                .foregroundColor(palette.textMuted)
                .lineLimit(1)
            Spacer()
            Button("Close") {
                isPresented.wrappedValue = false
            }
            ._buttonWidth(54)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(palette.surfaceSubtle)
    }

    private var navigationBar: some View {
        HStack(spacing: 5) {
            Button("‹") { issue(.back) }
                ._buttonWidth(30)
                .disabled(!snapshot.canGoBack || snapshot.surfaceState != .ready)
            Button("›") { issue(.forward) }
                ._buttonWidth(30)
                .disabled(!snapshot.canGoForward || snapshot.surfaceState != .ready)
            Button("↻") { issue(.reload) }
                ._buttonWidth(30)
                .disabled(snapshot.surfaceState != .ready)
            Button("×") { issue(.stop) }
                ._buttonWidth(30)
                .disabled(!snapshot.isLoading || snapshot.surfaceState != .ready)
            TextField("URL", text: address)
                .onSubmit { issue(.navigate(snapshot.address)) }
                .padding(.horizontal, 7)
                .frame(minHeight: 30)
                .background {
                    RoundedRectangle(cornerRadius: 6).fill(palette.surface)
                }
            Button("Go") { issue(.navigate(snapshot.address)) }
                ._buttonWidth(38)
        }
        .font(.system(size: 11, weight: .semibold))
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
        .background(palette.surfaceSubtle)
    }

    private var statusBar: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 7) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 6, height: 6)
                Text(statusLabel)
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(palette.textMuted)
                Text(snapshot.title)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(palette.textBody)
                    .lineLimit(1)
                Spacer()
            }
            if let error = snapshot.errorMessage {
                Text(error)
                    .font(.system(size: 9))
                    .foregroundColor(palette.danger)
                    .lineLimit(2)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(minHeight: 31)
        .background(palette.canvas)
    }

    private var browserSurface: some View {
        ZStack {
            GeometryReader { geometry in
                T4WindowsWebView2(bridge: browserModel.surfaceBridge)
                .frame(width: geometry.size.width, height: geometry.size.height)
            }

            switch snapshot.surfaceState {
            case .initializing:
                browserMessage(
                    title: "Starting WebView2",
                    detail: "Preparing the native browser surface."
                )
            case .unavailable(let message):
                browserMessage(title: "Browser unavailable", detail: message)
            case .idle, .ready:
                EmptyView()
            }
        }
        .frame(minHeight: 220, maxHeight: .infinity)
        .background(palette.canvas)
    }

    private func browserMessage(title: String, detail: String) -> some View {
        VStack(spacing: 7) {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(palette.text)
            Text(detail)
                .font(.system(size: 10))
                .foregroundColor(palette.textMuted)
                .multilineTextAlignment(.center)
        }
        .padding(16)
        .frame(maxWidth: 300)
        .background {
            RoundedRectangle(cornerRadius: 10).fill(palette.surface)
        }
    }

    private var statusLabel: String {
        if snapshot.errorMessage != nil { return "ERROR" }
        if snapshot.isLoading { return "LOADING" }
        switch snapshot.surfaceState {
        case .idle: return "IDLE"
        case .initializing: return "STARTING"
        case .ready: return "READY"
        case .unavailable: return "UNAVAILABLE"
        }
    }

    private var statusColor: Color {
        if snapshot.errorMessage != nil { return palette.danger }
        if snapshot.isLoading { return palette.working }
        switch snapshot.surfaceState {
        case .idle, .initializing: return palette.textFaint
        case .ready: return palette.success
        case .unavailable: return palette.danger
        }
    }

    private func activateSessionIfNeeded() {
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
            backgroundHex: palette.isDark ? 0x0F0F11 : 0xFFFFFF
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
