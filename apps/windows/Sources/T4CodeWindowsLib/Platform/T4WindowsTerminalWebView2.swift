import Foundation
@_spi(Backends) import SwiftCrossUI
import UWP
import WebView2Core
import WindowsFoundation
import WinUI
import WinUIBackend

/// One native WinUI WebView2 host for the terminal drawer. The coordinator owns
/// one xterm renderer per HostWire terminal identity and mounts exactly one as
/// the active child. All content comes from Bundle.module through a private
/// virtual host; top-level navigation away from TerminalHost.html is blocked.
struct T4WindowsTerminalWebView2: WinUIElementRepresentable {
    typealias WinUIElementType = WinUI.Grid

    let bridge: T4WindowsTerminalSurfaceBridge

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
        ViewSize(proposal.width ?? 640, proposal.height ?? 240)
    }

    static func dismantleWinUIElement(_ grid: WinUI.Grid, coordinator: Coordinator) {
        coordinator.closeAll(in: grid, restoreFocus: true)
    }

    @MainActor
    final class Coordinator {
        private final class Entry {
            let identity: T4WindowsTerminalIdentity
            let instanceID: String
            let expectedURL: URL
            let webView = WinUI.WebView2()
            var core: WebView2Core.CoreWebView2?
            var controlEvents: [EventCleanup] = []
            var coreEvents: [EventCleanup] = []
            var activation: T4WindowsTerminalSurfaceBridge.Activation
            var started = false
            var initialized = false
            var pageReady = false
            var initialNavigationPending = true
            var lastOutput = ""
            var lastTheme: T4WindowsTerminalTheme?
            var lastInteractive: Bool?
            var lastFocusEpoch: UInt64 = 0

            init(
                identity: T4WindowsTerminalIdentity,
                instanceID: String,
                expectedURL: URL,
                activation: T4WindowsTerminalSurfaceBridge.Activation
            ) {
                self.identity = identity
                self.instanceID = instanceID
                self.expectedURL = expectedURL
                self.activation = activation
            }

            func dispose() {
                if pageReady, let core,
                   let json = try? T4WindowsTerminalNativeMessage.dispose(instanceID: instanceID).json() {
                    try? core.postWebMessageAsJson(json)
                }
                for event in coreEvents { event.dispose() }
                for event in controlEvents { event.dispose() }
                coreEvents.removeAll()
                controlEvents.removeAll()
                core = nil
                pageReady = false
                try? webView.close()
            }
        }

        private var entries: [T4WindowsTerminalIdentity: Entry] = [:]
        private var activeIdentity: T4WindowsTerminalIdentity?
        private weak var bridge: T4WindowsTerminalSurfaceBridge?
        private var previouslyFocusedElement: WinUI.UIElement?

        func attach(grid: WinUI.Grid, bridge: T4WindowsTerminalSurfaceBridge) {
            self.bridge = bridge
            bridge.attach(
                owner: self,
                onActivate: { [weak self, weak grid] activation in
                    guard let self, let grid else { return }
                    self.activate(activation, in: grid)
                },
                onCloseIdentity: { [weak self, weak grid] identity in
                    guard let self, let grid else { return }
                    self.close(identity: identity, in: grid)
                },
                onCloseSession: { [weak self, weak grid] sessionID in
                    guard let self, let grid else { return }
                    self.close(sessionID: sessionID, in: grid)
                }
            )
        }

        private func activate(
            _ activation: T4WindowsTerminalSurfaceBridge.Activation,
            in grid: WinUI.Grid
        ) {
            let entry: Entry
            if let existing = entries[activation.identity] {
                existing.activation = activation
                entry = existing
            } else {
                let instanceID = UUID().uuidString.lowercased()
                guard let expectedURL = T4WindowsTerminalPage.url(
                    instanceID: instanceID,
                    theme: activation.theme,
                    interactive: activation.interactive
                ) else {
                    emit(.runtimeUnavailable("Could not create the bundled terminal page URL."), identity: activation.identity)
                    return
                }
                let created = Entry(
                    identity: activation.identity,
                    instanceID: instanceID,
                    expectedURL: expectedURL,
                    activation: activation
                )
                configureLayout(created.webView)
                installControlEvents(created)
                entries[activation.identity] = created
                entry = created
            }

            setBackground(activation.theme.background, on: entry.webView)
            if activeIdentity != activation.identity {
                capturePreviousFocus(from: grid)
                grid.children.clear()
                grid.children.append(entry.webView)
                activeIdentity = activation.identity
            }
            if !entry.started {
                start(entry)
            } else if entry.pageReady {
                synchronize(entry)
            }
        }

        private func configureLayout(_ webView: WinUI.WebView2) {
            webView.horizontalAlignment = .stretch
            webView.verticalAlignment = .stretch
            webView.allowFocusOnInteraction = true
            webView.isTabStop = true
        }

        private func installControlEvents(_ entry: Entry) {
            entry.controlEvents.append(
                entry.webView.coreWebView2Initialized.addHandler { [weak self, weak webView = entry.webView] _, args in
                    guard let self, let webView, let args else { return }
                    guard args.exception >= 0, let core = webView.coreWebView2 else {
                        let code = String(format: "0x%08X", UInt32(bitPattern: args.exception))
                        self.emit(
                            .runtimeUnavailable("WebView2 could not initialize the terminal renderer (\(code))."),
                            identity: entry.identity
                        )
                        return
                    }
                    guard let current = self.entries[entry.identity], current.webView === webView else { return }
                    current.initialized = true
                    current.core = core
                    self.configureCore(core, entry: current)
                }
            )
            entry.controlEvents.append(
                entry.webView.coreProcessFailed.addHandler { [weak self] _, _ in
                    self?.emit(
                        .runtimeUnavailable("The terminal WebView2 process stopped unexpectedly."),
                        identity: entry.identity
                    )
                }
            )
        }

        private func start(_ entry: Entry) {
            entry.started = true
            emit(.initializing, identity: entry.identity)
            do {
                _ = try entry.webView.ensureCoreWebView2Async()
            } catch {
                emit(
                    .runtimeUnavailable("WebView2 is unavailable for the terminal renderer: \(error)"),
                    identity: entry.identity
                )
            }
        }

        private func configureCore(_ core: WebView2Core.CoreWebView2, entry: Entry) {
            let settings = core.settings
            settings?.areBrowserAcceleratorKeysEnabled = false
            settings?.areDefaultContextMenusEnabled = false
            settings?.areDefaultScriptDialogsEnabled = false
            settings?.areDevToolsEnabled = false
            settings?.areHostObjectsAllowed = false
            settings?.isBuiltInErrorPageEnabled = false
            settings?.isScriptEnabled = true
            settings?.isStatusBarEnabled = false
            settings?.isWebMessageEnabled = true
            settings?.isZoomControlEnabled = false
            settings?.isGeneralAutofillEnabled = false
            settings?.isPasswordAutosaveEnabled = false
            settings?.isPinchZoomEnabled = false
            settings?.isSwipeNavigationEnabled = false

            installCoreEvents(core, entry: entry)
            guard let resourceRoot = Bundle.module.resourceURL else {
                emit(.runtimeUnavailable("Bundled terminal assets are missing."), identity: entry.identity)
                return
            }
            do {
                try core.setVirtualHostNameToFolderMapping(
                    T4WindowsTerminalPage.host,
                    resourceRoot.path,
                    .denyCors
                )
                try core.navigate(entry.expectedURL.absoluteString)
            } catch {
                emit(
                    .runtimeUnavailable("Could not load the bundled terminal renderer: \(error)"),
                    identity: entry.identity
                )
            }
        }

        private func installCoreEvents(_ core: WebView2Core.CoreWebView2, entry: Entry) {
            entry.coreEvents.append(
                core.navigationStarting.addHandler { [weak self, weak entry] _, args in
                    guard let self, let entry, let args else { return }
                    let allowed = T4WindowsTerminalPage.allowsNavigation(
                        candidate: args.uri,
                        expected: entry.expectedURL.absoluteString,
                        isInitial: entry.initialNavigationPending
                    )
                    if allowed {
                        entry.initialNavigationPending = false
                    } else {
                        args.cancel = true
                        self.emit(
                            .messageRejected("Blocked navigation outside the bundled terminal surface."),
                            identity: entry.identity
                        )
                    }
                }
            )
            entry.coreEvents.append(
                core.navigationCompleted.addHandler { [weak self, weak entry] _, args in
                    guard let self, let entry, let args else { return }
                    guard args.isSuccess else {
                        self.emit(
                            .runtimeUnavailable("The bundled terminal page failed to load."),
                            identity: entry.identity
                        )
                        return
                    }
                }
            )
            entry.coreEvents.append(
                core.webMessageReceived.addHandler { [weak self, weak entry] _, args in
                    guard let self, let entry, let args else { return }
                    guard args.source == entry.expectedURL.absoluteString else {
                        self.emit(
                            .messageRejected("Rejected a terminal message from an unexpected page."),
                            identity: entry.identity
                        )
                        return
                    }
                    do {
                        let message = try T4WindowsTerminalBridgeDecoder.decode(
                            args.webMessageAsJson,
                            expectedInstanceID: entry.instanceID
                        )
                        if message == .ready {
                            entry.pageReady = true
                            self.emit(.ready, identity: entry.identity)
                            self.synchronize(entry)
                        } else {
                            self.emit(.message(message), identity: entry.identity)
                        }
                    } catch {
                        self.emit(.messageRejected(String(describing: error)), identity: entry.identity)
                    }
                }
            )
            entry.coreEvents.append(
                core.newWindowRequested.addHandler { [weak self, weak entry] _, args in
                    guard let self, let entry, let args else { return }
                    args.handled = true
                    self.emit(
                        .messageRejected("Blocked a new-window request from the terminal surface."),
                        identity: entry.identity
                    )
                }
            )
            entry.coreEvents.append(
                core.processFailed.addHandler { [weak self, weak entry] _, _ in
                    guard let self, let entry else { return }
                    self.emit(
                        .runtimeUnavailable("The terminal renderer process stopped unexpectedly."),
                        identity: entry.identity
                    )
                }
            )
        }

        private func synchronize(_ entry: Entry) {
            guard entry.pageReady, let core = entry.core else { return }
            let activation = entry.activation

            if entry.lastTheme != activation.theme {
                post(.setTheme(instanceID: entry.instanceID, theme: activation.theme), to: core, identity: entry.identity)
                entry.lastTheme = activation.theme
            }
            let interactive = activation.interactive && activation.exited == nil
            if entry.lastInteractive != interactive {
                post(.setInteractive(instanceID: entry.instanceID, interactive: interactive), to: core, identity: entry.identity)
                entry.lastInteractive = interactive
            }

            if activation.output.hasPrefix(entry.lastOutput) {
                let delta = String(activation.output.dropFirst(entry.lastOutput.count))
                if !delta.isEmpty {
                    post(.write(instanceID: entry.instanceID, data: delta), to: core, identity: entry.identity)
                }
            } else {
                post(
                    .reset(instanceID: entry.instanceID, data: activation.output, trimmed: !entry.lastOutput.isEmpty),
                    to: core,
                    identity: entry.identity
                )
            }
            entry.lastOutput = activation.output

            if activation.focusEpoch != entry.lastFocusEpoch,
               activeIdentity == entry.identity {
                entry.lastFocusEpoch = activation.focusEpoch
                _ = try? entry.webView.focus(.programmatic)
                post(.focus(instanceID: entry.instanceID), to: core, identity: entry.identity)
            }
        }

        private func post(
            _ message: T4WindowsTerminalNativeMessage,
            to core: WebView2Core.CoreWebView2,
            identity: T4WindowsTerminalIdentity
        ) {
            do {
                try core.postWebMessageAsJson(try message.json())
            } catch {
                emit(.runtimeUnavailable("Terminal bridge delivery failed: \(error)"), identity: identity)
            }
        }

        private func close(identity: T4WindowsTerminalIdentity, in grid: WinUI.Grid) {
            guard let entry = entries.removeValue(forKey: identity) else { return }
            if activeIdentity == identity {
                grid.children.clear()
                activeIdentity = nil
            }
            entry.dispose()
            bridge?.publishCleanup([identity])
        }

        private func close(sessionID: String, in grid: WinUI.Grid) {
            let identities = entries.keys.filter { $0.sessionID == sessionID }
            for identity in identities {
                guard let entry = entries.removeValue(forKey: identity) else { continue }
                entry.dispose()
            }
            if activeIdentity?.sessionID == sessionID {
                grid.children.clear()
                activeIdentity = nil
                restorePreviousFocus()
            }
            if !identities.isEmpty { bridge?.publishCleanup(identities) }
        }

        func closeAll(in grid: WinUI.Grid, restoreFocus: Bool) {
            let identities = Array(entries.keys)
            grid.children.clear()
            for entry in entries.values { entry.dispose() }
            entries.removeAll()
            activeIdentity = nil
            if restoreFocus { restorePreviousFocus() }
            if !identities.isEmpty { bridge?.publishCleanup(identities) }
            bridge?.detach(owner: self)
            bridge = nil
        }

        private func capturePreviousFocus(from grid: WinUI.Grid) {
            guard previouslyFocusedElement == nil, let root = grid.xamlRoot else { return }
            previouslyFocusedElement = FocusManager.getFocusedElement(root) as? WinUI.UIElement
        }

        private func restorePreviousFocus() {
            if let element = previouslyFocusedElement {
                _ = try? element.focus(.programmatic)
            }
            previouslyFocusedElement = nil
        }

        private func emit(_ event: T4WindowsTerminalSurfaceEvent, identity: T4WindowsTerminalIdentity) {
            bridge?.publish(.init(identity: identity, event: event))
        }

        private func setBackground(_ cssHex: String, on webView: WinUI.WebView2) {
            let cleaned = cssHex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
            guard cleaned.count == 6, let hex = UInt32(cleaned, radix: 16) else { return }
            webView.defaultBackgroundColor = UWP.Color(
                a: 255,
                r: UInt8((hex >> 16) & 0xFF),
                g: UInt8((hex >> 8) & 0xFF),
                b: UInt8(hex & 0xFF)
            )
        }
    }
}
