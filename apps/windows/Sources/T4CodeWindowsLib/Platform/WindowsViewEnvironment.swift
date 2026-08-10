import SwiftCrossUI

extension EnvironmentValues {
    /// WINDOWS-GAP: Linux's patched GTK ScrollView consumes this flag to pin a
    /// streaming transcript. WinUIBackend does not expose the equivalent hook
    /// yet; retain the environment contract so the view hierarchy stays 1:1.
    @Entry var scrollAnchorsToBottom: Bool = false
}
