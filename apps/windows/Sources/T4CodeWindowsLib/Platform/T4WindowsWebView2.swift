import Foundation
@_spi(Backends) import SwiftCrossUI
import WinUIBackend
import WinUI
import UWP
import WebView2Core
import WindowsFoundation

/// A SwiftCrossUI representable backed by WinUI's native WebView2 control.
/// A coordinator-owned WebView2 is retained per session while the pane is
/// mounted, so switching sessions does not collapse their history stacks.
struct T4WindowsWebView2: WinUIElementRepresentable {
    typealias WinUIElementType = WinUI.Grid

    let bridge: T4WindowsBrowserSurfaceBridge

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeWinUIElement(context _: Context) -> WinUI.Grid {
        WinUI.Grid()
    }

    func updateWinUIElement(_ grid: WinUI.Grid, context: Context) {
        context.coordinator.attach(grid: grid, bridge: bridge)
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        winUIElement _: WinUI.Grid,
        context _: Context
    ) -> ViewSize {
        ViewSize(proposal.width ?? 400, proposal.height ?? 480)
    }

    static func dismantleWinUIElement(_ grid: WinUI.Grid, coordinator: Coordinator) {
        grid.children.clear()
        coordinator.closeAll()
    }

    final class Coordinator {
        private enum InitialContent {
            case url(String)
            case html(String)
        }

        private final class Entry {
            let webView = WinUI.WebView2()
            var core: WebView2Core.CoreWebView2?
            var controlEvents: [EventCleanup] = []
            var coreEvents: [EventCleanup] = []
            var started = false
            var initialized = false
            var coreEventsInstalled = false
            var pendingInitialContent: InitialContent?
            var pendingCommand: T4WindowsBrowserNativeCommand?
            var activeNavigationID: UInt64?
            var stoppedNavigationID: UInt64?

            func dispose() {
                for event in coreEvents { event.dispose() }
                for event in controlEvents { event.dispose() }
                coreEvents.removeAll()
                controlEvents.removeAll()
                core = nil
                try? webView.close()
            }
        }

        private var entries: [String: Entry] = [:]
        private var activeSessionID: String?
        private weak var bridge: T4WindowsBrowserSurfaceBridge?

        func attach(
            grid: WinUI.Grid,
            bridge: T4WindowsBrowserSurfaceBridge
        ) {
            self.bridge = bridge
            bridge.attach(
                owner: self,
                onActivate: { [weak self, weak grid] activation in
                    guard let self, let grid else { return }
                    self.activate(activation, in: grid)
                },
                onCommand: { [weak self] sessionID, command in
                    self?.receive(command, sessionID: sessionID)
                },
                onCloseSession: { [weak self, weak grid] sessionID in
                    guard let self, let grid else { return }
                    self.close(sessionID: sessionID, in: grid)
                }
            )
        }

        private func activate(
            _ activation: T4WindowsBrowserSurfaceBridge.Activation,
            in grid: WinUI.Grid
        ) {
            let entry: Entry
            if let existing = entries[activation.sessionID] {
                entry = existing
            } else {
                entry = makeEntry(sessionID: activation.sessionID)
                entry.pendingInitialContent = activation.fixtureHTML.map(InitialContent.html)
                    ?? .url(activation.initialURL)
                entries[activation.sessionID] = entry
            }

            setBackground(activation.backgroundHex, on: entry.webView)
            if activeSessionID != activation.sessionID {
                grid.children.clear()
                grid.children.append(entry.webView)
                activeSessionID = activation.sessionID
            }
            if !entry.started {
                start(entry, sessionID: activation.sessionID)
            } else if entry.initialized, let core = entry.core {
                emitState(core, sessionID: activation.sessionID)
            }
        }

        private func receive(
            _ command: T4WindowsBrowserNativeCommand,
            sessionID: String
        ) {
            guard let entry = entries[sessionID] else {
                emit(.commandFailed("The browser surface is not mounted."), sessionID: sessionID)
                return
            }
            performOrQueue(command, entry: entry, sessionID: sessionID)
        }

        private func close(sessionID: String, in grid: WinUI.Grid) {
            guard let entry = entries.removeValue(forKey: sessionID) else { return }
            if activeSessionID == sessionID {
                grid.children.clear()
                activeSessionID = nil
            }
            entry.dispose()
            bridge?.publishCleanup([sessionID])
        }

        func closeAll() {
            let sessionIDs = Array(entries.keys)
            for entry in entries.values {
                entry.dispose()
            }
            entries.removeAll()
            activeSessionID = nil
            bridge?.publishCleanup(sessionIDs)
            bridge?.detach(owner: self)
            bridge = nil
        }

        private func makeEntry(sessionID: String) -> Entry {
            let entry = Entry()
            entry.webView.horizontalAlignment = .stretch
            entry.webView.verticalAlignment = .stretch

            entry.controlEvents.append(
                entry.webView.coreWebView2Initialized.addHandler { [weak self, weak webView = entry.webView] _, args in
                    guard let self, let webView, let args else { return }
                    guard args.exception >= 0, let core = webView.coreWebView2 else {
                        let code = String(format: "0x%08X", UInt32(bitPattern: args.exception))
                        self.emit(.runtimeUnavailable("WebView2 could not initialize (\(code))."), sessionID: sessionID)
                        return
                    }
                    guard let current = self.entries[sessionID], current.webView === webView else { return }
                    current.initialized = true
                    current.core = core
                    self.installCoreEvents(core, entry: current, sessionID: sessionID)
                    self.emit(.surfaceReady, sessionID: sessionID)
                    self.performPending(entry: current, core: core, sessionID: sessionID)
                }
            )
            entry.controlEvents.append(
                entry.webView.coreProcessFailed.addHandler { [weak self] _, _ in
                    self?.emit(
                        .runtimeUnavailable("The WebView2 process stopped unexpectedly."),
                        sessionID: sessionID
                    )
                }
            )
            return entry
        }

        private func start(_ entry: Entry, sessionID: String) {
            entry.started = true
            do {
                _ = try entry.webView.ensureCoreWebView2Async()
            } catch {
                emit(
                    .runtimeUnavailable("WebView2 is unavailable: \(error)"),
                    sessionID: sessionID
                )
            }
        }

        private func installCoreEvents(
            _ core: WebView2Core.CoreWebView2,
            entry: Entry,
            sessionID: String
        ) {
            guard !entry.coreEventsInstalled else { return }
            entry.coreEventsInstalled = true

            entry.coreEvents.append(
                core.navigationStarting.addHandler { [weak self, weak entry] _, args in
                    guard let self, let entry, let args else { return }
                    entry.activeNavigationID = args.navigationId
                    self.emit(.navigationStarted(url: args.uri), sessionID: sessionID)
                }
            )
            entry.coreEvents.append(
                core.navigationCompleted.addHandler { [weak self, weak core, weak entry] _, args in
                    guard let self, let core, let entry, let args else { return }
                    let wasStoppedByUser = entry.stoppedNavigationID == args.navigationId
                    if wasStoppedByUser {
                        entry.stoppedNavigationID = nil
                    }
                    if entry.activeNavigationID == args.navigationId {
                        entry.activeNavigationID = nil
                    }
                    let failure = args.isSuccess
                        ? nil
                        : Self.navigationFailureMessage(
                            args.webErrorStatus,
                            wasStoppedByUser: wasStoppedByUser
                        )
                    self.emitState(
                        core,
                        sessionID: sessionID,
                        isLoading: false,
                        failure: failure
                    )
                }
            )

            entry.coreEvents.append(
                core.sourceChanged.addHandler { [weak self, weak core] _, _ in
                    guard let self, let core else { return }
                    self.emitState(core, sessionID: sessionID)
                }
            )
            entry.coreEvents.append(
                core.historyChanged.addHandler { [weak self, weak core] _, _ in
                    guard let self, let core else { return }
                    self.emitState(core, sessionID: sessionID)
                }
            )
            entry.coreEvents.append(
                core.documentTitleChanged.addHandler { [weak self, weak core] _, _ in
                    guard let self, let core else { return }
                    self.emitState(core, sessionID: sessionID)
                }
            )
            entry.coreEvents.append(
                core.newWindowRequested.addHandler { [weak self, weak core] _, args in
                    guard let self, let core, let args else { return }
                    args.handled = true
                    do {
                        try core.navigate(args.uri)
                    } catch {
                        self.emit(.commandFailed("Could not open link: \(error)"), sessionID: sessionID)
                    }
                }
            )
            entry.coreEvents.append(
                core.processFailed.addHandler { [weak self] _, _ in
                    self?.emit(
                        .runtimeUnavailable("The WebView2 process stopped unexpectedly."),
                        sessionID: sessionID
                    )
                }
            )
        }

        static func navigationFailureMessage(
            _ status: WebView2Core.CoreWebView2WebErrorStatus,
            wasStoppedByUser: Bool = false
        ) -> String? {
            if wasStoppedByUser && status == .operationCanceled {
                return nil
            }
            if status == .timeout {
                return "Navigation timed out."
            }
            if status == .serverUnreachable || status == .cannotConnect {
                return "Could not connect to the server."
            }
            if status == .hostNameNotResolved {
                return "Could not resolve the host name."
            }
            if status == .connectionAborted || status == .connectionReset || status == .disconnected {
                return "The connection was interrupted."
            }
            if status == .operationCanceled {
                return "Navigation canceled."
            }
            if status == .redirectFailed {
                return "The page redirect failed."
            }
            if status == .validAuthenticationCredentialsRequired
                || status == .validProxyAuthenticationRequired
            {
                return "Navigation requires authentication."
            }
            if status == .certificateCommonNameIsIncorrect
                || status == .certificateExpired
                || status == .clientCertificateContainsErrors
                || status == .certificateRevoked
                || status == .certificateIsInvalid
            {
                return "The site's security certificate is invalid."
            }
            if status == .errorHttpInvalidServerResponse {
                return "The server returned an invalid response."
            }
            return "Navigation failed."
        }

        private func performPending(
            entry: Entry,
            core: WebView2Core.CoreWebView2,
            sessionID: String
        ) {
            if let command = entry.pendingCommand {
                entry.pendingCommand = nil
                entry.pendingInitialContent = nil
                perform(command, entry: entry, core: core, sessionID: sessionID)
                return
            }
            guard let initialContent = entry.pendingInitialContent else { return }
            entry.pendingInitialContent = nil
            do {
                switch initialContent {
                case .url(let url):
                    try core.navigate(url)
                case .html(let html):
                    try core.navigateToString(html)
                }
            } catch {
                emit(.commandFailed("Could not load the page: \(error)"), sessionID: sessionID)
            }
        }

        private func performOrQueue(
            _ command: T4WindowsBrowserNativeCommand,
            entry: Entry,
            sessionID: String
        ) {
            guard entry.initialized, let core = entry.core else {
                entry.pendingCommand = command
                return
            }
            entry.pendingInitialContent = nil
            perform(command, entry: entry, core: core, sessionID: sessionID)
        }

        private func perform(
            _ command: T4WindowsBrowserNativeCommand,
            entry: Entry,
            core: WebView2Core.CoreWebView2,
            sessionID: String
        ) {
            do {
                switch command {
                case .navigate(let url):
                    try core.navigate(url)
                case .back:
                    guard core.canGoBack else { return }
                    try core.goBack()
                case .forward:
                    guard core.canGoForward else { return }
                    try core.goForward()
                case .reload:
                    try core.reload()
                case .stop:
                    entry.stoppedNavigationID = entry.activeNavigationID
                    try core.stop()
                }
            } catch {
                if command == .stop {
                    entry.stoppedNavigationID = nil
                }
                emit(.commandFailed("Browser command failed: \(error)"), sessionID: sessionID)
            }
        }

        private func emitState(
            _ core: WebView2Core.CoreWebView2,
            sessionID: String,
            isLoading: Bool? = nil,
            failure: String? = nil
        ) {
            emit(
                .navigationState(
                    url: core.source,
                    title: core.documentTitle,
                    canGoBack: core.canGoBack,
                    canGoForward: core.canGoForward,
                    isLoading: isLoading,
                    failure: failure
                ),
                sessionID: sessionID
            )
        }

        private func emit(_ event: T4WindowsBrowserEvent, sessionID: String) {
            bridge?.publish(
                T4WindowsBrowserEventEnvelope(sessionID: sessionID, event: event)
            )
        }

        private func setBackground(_ hex: UInt32, on webView: WinUI.WebView2) {
            webView.defaultBackgroundColor = UWP.Color(
                a: 255,
                r: UInt8((hex >> 16) & 0xFF),
                g: UInt8((hex >> 8) & 0xFF),
                b: UInt8(hex & 0xFF)
            )
        }
    }
}
