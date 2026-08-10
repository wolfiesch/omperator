import SwiftCrossUI
import HostWire

private struct WindowsDeferredPane: View {
    let title: String
    let detail: String
    let theme: ThemeStore
    let isPresented: Binding<Bool>

    var body: some View {
        let t = theme.t
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Text(title)
                    .font(.disp(16))
                    .foregroundColor(t.txt)
                Spacer()
                T4TextButton("Close") {
                    isPresented.wrappedValue = false
                }
                .font(.bodyF(12))
                .foregroundColor(t.txtBody)
            }
            Divider(t.line)
            Text(detail)
                .font(.bodyF(13))
                .foregroundColor(t.txtMuted)
                .multilineTextAlignment(.leading)
            Spacer()
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(t.bg2)
    }
}

/// WINDOWS-GAP: pairing UI is not part of the requested workspace slice.
struct T4ConnectView: View {
    let store: T4SessionStore
    let theme: ThemeStore
    let isPresented: Binding<Bool>
    let pendingPair: PendingPair?

    var body: some View {
        WindowsDeferredPane(
            title: "Pair a host",
            detail: "Windows host pairing will use this native surface after the workspace parity port.",
            theme: theme,
            isPresented: isPresented
        )
        .frame(width: 420, height: 260)
    }
}


/// WINDOWS-GAP: WebView2 browser and terminal surfaces remain deferred.
/// Every requested non-browser/non-terminal pane uses the shared Linux SwiftCrossUI view.

struct T4BrowserPaneView: View {
    let session: SessionRef; let store: T4SessionStore; let theme: ThemeStore; let isPresented: Binding<Bool>
    var body: some View { WindowsDeferredPane(title: "Browser", detail: "Browser support is deferred during the core workspace port.", theme: theme, isPresented: isPresented) }
}


struct T4TerminalDrawer: View {
    let session: SessionRef
    let store: T4SessionStore
    let theme: ThemeStore
    let isOpen: Bool

    var body: some View {
        Group {
            if isOpen {
                Text("Terminal support is deferred")
                    .font(.term(12))
                    .foregroundColor(theme.t.txtMuted)
                    .padding(12)
                    .frame(maxWidth: .infinity)
                    .background(theme.t.bg2)
            }
        }
    }
}
