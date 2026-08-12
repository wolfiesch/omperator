import WinSDK
import WindowsFoundation
import WinUI
import WinUIBackend

import SwiftCrossUI

/// Current native GTK values are already expressed in effective pixels.
/// Retained hidden SwiftCrossUI panes still call the prior density seam, so
/// Windows keeps it as an identity conversion.
func t4PlatformMetric(_ value: Int) -> Int { value }
func t4PlatformMetric(_ value: Double) -> Double { value }


extension EnvironmentValues {
    /// Shared view contract consumed by the native WinUI scroll anchor below.
    @Entry var scrollAnchorsToBottom: Bool = false

    /// WINDOWS-GAP: live root width keeps fixed Linux sidebar proportions from
    /// crowding important controls at Windows' supported 900-point minimum.
    @Entry var t4WindowWidth: Double = 1280

    /// Realized window height used only where WinUI needs an explicit viewport
    /// instead of SwiftCrossUI's flexible-height negotiation.
    @Entry var t4WindowHeight: Double = 800
}

extension SwiftCrossUI.ScrollView {
    func t4AnchorToBottom(contentID: String) -> some View {
        inspect([.onCreate, .afterUpdate]) { scrollViewer in
            T4WindowsScrollAnchor.install(on: scrollViewer, contentID: contentID)
        }
    }

    func t4ManageTranscriptScroll(sessionID: String, contentVersion: String) -> some View {
        inspect([.onCreate, .afterUpdate]) { scrollViewer in
            T4WindowsScrollAnchor.install(
                on: scrollViewer,
                sessionID: sessionID,
                contentVersion: contentVersion
            )
        }
    }
}

@MainActor
private enum T4WindowsScrollAnchor {
    private static var anchors: [ObjectIdentifier: Anchor] = [:]
    private static var positions: [String: Double] = [:]

    static func install(on scrollViewer: WinUI.ScrollViewer, contentID: String) {
        install(on: scrollViewer, sessionID: contentID, contentVersion: contentID)
    }

    static func install(
        on scrollViewer: WinUI.ScrollViewer,
        sessionID: String,
        contentVersion: String
    ) {
        let key = ObjectIdentifier(scrollViewer)
        if let anchor = anchors[key] {
            anchor.update(sessionID: sessionID, contentVersion: contentVersion)
            return
        }

        let anchor = Anchor(
            scrollViewer: scrollViewer,
            sessionID: sessionID,
            contentVersion: contentVersion
        )
        anchors[key] = anchor
        anchor.installEvents()
        anchor.restoreOrPin()
    }

    private static func remove(_ scrollViewer: WinUI.ScrollViewer) {
        anchors.removeValue(forKey: ObjectIdentifier(scrollViewer))?.dispose()
    }

    @MainActor
    private final class Anchor {
        private weak var scrollViewer: WinUI.ScrollViewer?
        private var sessionID: String
        private var contentVersion: String
        private var followsBottom = true
        private var didInitialPosition = false
        private var pendingRestore: Double?
        private var viewChanged: EventCleanup?
        private var layoutUpdated: EventCleanup?
        private var unloaded: EventCleanup?

        init(
            scrollViewer: WinUI.ScrollViewer,
            sessionID: String,
            contentVersion: String
        ) {
            self.scrollViewer = scrollViewer
            self.sessionID = sessionID
            self.contentVersion = contentVersion
            pendingRestore = T4WindowsScrollAnchor.positions[sessionID]
            followsBottom = pendingRestore == nil
        }

        func installEvents() {
            guard let scrollViewer else { return }
            viewChanged = scrollViewer.viewChanged.addHandler { [weak self] _, _ in
                guard let self, let scrollViewer = self.scrollViewer, self.didInitialPosition else {
                    return
                }
                self.followsBottom =
                    scrollViewer.scrollableHeight - scrollViewer.verticalOffset
                        <= T4TranscriptScrollMemory.nearBottomThreshold
                T4WindowsScrollAnchor.positions[self.sessionID] = scrollViewer.verticalOffset
            }
            layoutUpdated = scrollViewer.layoutUpdated.addHandler { [weak self] _, _ in
                self?.restoreOrPin()
            }
            unloaded = scrollViewer.unloaded.addHandler { [weak scrollViewer] _, _ in
                guard let scrollViewer else { return }
                Task { @MainActor in
                    T4WindowsScrollAnchor.remove(scrollViewer)
                }
            }
        }

        func update(sessionID: String, contentVersion: String) {
            if self.sessionID != sessionID {
                if let scrollViewer {
                    T4WindowsScrollAnchor.positions[self.sessionID] = scrollViewer.verticalOffset
                }
                self.sessionID = sessionID
                self.contentVersion = contentVersion
                pendingRestore = T4WindowsScrollAnchor.positions[sessionID]
                followsBottom = pendingRestore == nil
                didInitialPosition = false
            } else if self.contentVersion != contentVersion {
                self.contentVersion = contentVersion
            }
            restoreOrPin()
        }

        func restoreOrPin() {
            guard let scrollViewer else { return }
            if let pendingRestore {
                guard scrollViewer.scrollableHeight > 0 else { return }
                self.pendingRestore = nil
                didInitialPosition = true
                _ = try? scrollViewer.changeView(nil, pendingRestore, nil, true)
                return
            }
            guard followsBottom else { return }
            let bottom = scrollViewer.scrollableHeight
            guard bottom > 0 else { return }
            if !didInitialPosition || bottom - scrollViewer.verticalOffset > 0.5 {
                didInitialPosition = true
                _ = try? scrollViewer.changeView(nil, bottom, nil, true)
            }
        }

        func dispose() {
            if let scrollViewer {
                T4WindowsScrollAnchor.positions[sessionID] = scrollViewer.verticalOffset
            }
            viewChanged?.dispose()
            layoutUpdated?.dispose()
            unloaded?.dispose()
            viewChanged = nil
            layoutUpdated = nil
            unloaded = nil
        }
    }
}
