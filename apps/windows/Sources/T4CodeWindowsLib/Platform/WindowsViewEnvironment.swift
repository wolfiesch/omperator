import SwiftCrossUI

extension EnvironmentValues {
    /// WINDOWS-GAP: Linux's patched GTK ScrollView consumes this flag to pin a
    /// streaming transcript. WinUIBackend does not expose the equivalent hook
    /// yet; retain the environment contract so the view hierarchy stays 1:1.
    @Entry var scrollAnchorsToBottom: Bool = false

    /// WINDOWS-GAP: live root width keeps fixed Linux sidebar proportions from
    /// crowding important controls at Windows' supported 900-point minimum.
    @Entry var t4WindowWidth: Double = 1280
}
