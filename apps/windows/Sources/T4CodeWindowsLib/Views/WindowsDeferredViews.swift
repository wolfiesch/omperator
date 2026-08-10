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

/// WINDOWS-GAP: command-palette behavior is deferred; its overlay position and
/// invocation remain wired through the shared workspace.
struct T4PaletteView: View {
    let store: T4SessionStore
    let theme: ThemeStore
    let isPresented: Binding<Bool>
    let onRequestConnect: () -> Void

    var body: some View {
        WindowsDeferredPane(
            title: "Command palette",
            detail: "Palette actions are deferred during the core workspace port.",
            theme: theme,
            isPresented: isPresented
        )
        .frame(width: 520, height: 260)
        .glass(theme.t, 18, panel: true)
    }
}

/// WINDOWS-GAP: inbox behavior is deferred, while the native right-sidebar
/// geometry remains identical to the Linux workspace.
struct T4InboxView: View {
    let store: T4SessionStore
    let theme: ThemeStore
    let isPresented: Binding<Bool>

    var body: some View {
        WindowsDeferredPane(
            title: "Inbox",
            detail: "Inbox actions are deferred during the core workspace port.",
            theme: theme,
            isPresented: isPresented
        )
    }
}

/// WINDOWS-GAP: browser, terminal, file, review, settings, usage, artifact,
/// agent, and search panes are explicitly deferred by this milestone. Their
/// toolbar entry points and sidebar widths remain in T4SessionDetailView.
struct T4FilesPane: View {
    let session: SessionRef; let store: T4SessionStore; let theme: ThemeStore; let isPresented: Binding<Bool>
    var body: some View { deferred("Files") }
    private func deferred(_ title: String) -> some View { WindowsDeferredPane(title: title, detail: "This pane is deferred during the core workspace port.", theme: theme, isPresented: isPresented) }
}

struct T4AgentsPane: View {
    let session: SessionRef; let store: T4SessionStore; let theme: ThemeStore; let isPresented: Binding<Bool>
    var body: some View { WindowsDeferredPane(title: "Agents", detail: "This pane is deferred during the core workspace port.", theme: theme, isPresented: isPresented) }
}

struct T4UsagePane: View {
    let store: T4SessionStore; let theme: ThemeStore; let isPresented: Binding<Bool>
    var body: some View { WindowsDeferredPane(title: "Usage", detail: "This pane is deferred during the core workspace port.", theme: theme, isPresented: isPresented) }
}

struct T4ReviewPane: View {
    let session: SessionRef; let store: T4SessionStore; let theme: ThemeStore; let isPresented: Binding<Bool>
    var body: some View { WindowsDeferredPane(title: "Review", detail: "This pane is deferred during the core workspace port.", theme: theme, isPresented: isPresented) }
}

struct T4ArtifactsPane: View {
    let session: SessionRef; let store: T4SessionStore; let theme: ThemeStore; let isPresented: Binding<Bool>
    var body: some View { WindowsDeferredPane(title: "Artifacts", detail: "This pane is deferred during the core workspace port.", theme: theme, isPresented: isPresented) }
}

struct T4SettingsPane: View {
    let store: T4SessionStore; let theme: ThemeStore; let isPresented: Binding<Bool>
    var body: some View { WindowsDeferredPane(title: "Settings", detail: "This pane is deferred during the core workspace port.", theme: theme, isPresented: isPresented) }
}

struct T4BrowserPaneView: View {
    let session: SessionRef; let store: T4SessionStore; let theme: ThemeStore; let isPresented: Binding<Bool>
    var body: some View { WindowsDeferredPane(title: "Browser", detail: "Browser support is deferred during the core workspace port.", theme: theme, isPresented: isPresented) }
}

struct T4SearchPane: View {
    let session: SessionRef; let store: T4SessionStore; let theme: ThemeStore; let isPresented: Binding<Bool>
    var body: some View { WindowsDeferredPane(title: "Search & Diff", detail: "This pane is deferred during the core workspace port.", theme: theme, isPresented: isPresented) }
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
