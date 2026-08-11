import WinSDK
import WindowsFoundation
import WinUI
import WinUIBackend

import SwiftCrossUI
/// Converts WinUI's resize proposal into the DIP extent used by its XAML tree.
/// SwiftCrossUI currently forwards the unscaled Win32 value after a resize.
func t4WindowsViewportScale() -> Double {
    let dpi = GetDpiForSystem()
    guard dpi > 0 else { return 1 }
    return Double(USER_DEFAULT_SCREEN_DPI) / Double(dpi)
}


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
}

@MainActor
private enum T4WindowsScrollAnchor {
    private static var anchors: [ObjectIdentifier: Anchor] = [:]

    static func install(on scrollViewer: WinUI.ScrollViewer, contentID: String) {
        let key = ObjectIdentifier(scrollViewer)
        if let anchor = anchors[key] {
            anchor.update(contentID: contentID)
            return
        }

        let anchor = Anchor(scrollViewer: scrollViewer, contentID: contentID)
        anchors[key] = anchor
        anchor.installEvents()
        anchor.pinIfNeeded()
    }

    private static func remove(_ scrollViewer: WinUI.ScrollViewer) {
        anchors.removeValue(forKey: ObjectIdentifier(scrollViewer))?.dispose()
    }

    private final class Anchor {
        private weak var scrollViewer: WinUI.ScrollViewer?
        private var contentID: String
        private var followsBottom = true
        private var didInitialPin = false
        private var viewChanged: EventCleanup?
        private var layoutUpdated: EventCleanup?
        private var unloaded: EventCleanup?

        init(scrollViewer: WinUI.ScrollViewer, contentID: String) {
            self.scrollViewer = scrollViewer
            self.contentID = contentID
        }

        func installEvents() {
            guard let scrollViewer else { return }
            viewChanged = scrollViewer.viewChanged.addHandler { [weak self] _, _ in
                guard let self, let scrollViewer = self.scrollViewer, self.didInitialPin else { return }
                self.followsBottom =
                    scrollViewer.scrollableHeight - scrollViewer.verticalOffset <= 120
            }
            layoutUpdated = scrollViewer.layoutUpdated.addHandler { [weak self] _, _ in
                self?.pinIfNeeded()
            }
            unloaded = scrollViewer.unloaded.addHandler { [weak scrollViewer] _, _ in
                guard let scrollViewer else { return }
                Task { @MainActor in
                    T4WindowsScrollAnchor.remove(scrollViewer)
                }
            }
        }

        func update(contentID: String) {
            if self.contentID != contentID {
                self.contentID = contentID
                followsBottom = true
                didInitialPin = false
            }
            pinIfNeeded()
        }

        func pinIfNeeded() {
            guard let scrollViewer, followsBottom else { return }
            let bottom = scrollViewer.scrollableHeight
            guard bottom > 0 else { return }
            if !didInitialPin || bottom - scrollViewer.verticalOffset > 0.5 {
                didInitialPin = true
                _ = try? scrollViewer.changeView(nil, bottom, nil, true)
            }
        }

        func dispose() {
            viewChanged?.dispose()
            layoutUpdated?.dispose()
            unloaded?.dispose()
            viewChanged = nil
            layoutUpdated = nil
            unloaded = nil
        }
    }
}
