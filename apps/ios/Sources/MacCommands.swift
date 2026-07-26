//  MacCommands.swift
//  macOS-only menu bar + keyboard shortcuts for T4 Code. The Commands scene
//  reads the focused window's store and shared UI command model via
//  @FocusedValue, so shortcuts route to whichever workspace is frontmost.
//  iOS never compiles this file (#if os(macOS) wraps the whole thing).

#if os(macOS)
import SwiftUI
import HostWire

/// Shared macOS UI command state: sidebar visibility plus tick signals routed
/// from the menu bar / keyboard shortcuts back into the workspace (search
/// focus, sheet dismiss, connect sheet, rename target). Owned by the App and
/// injected as an EnvironmentObject; the workspace publishes it (and the
/// store) to the Commands scene via .focusedSceneValue.
@MainActor
final class MacCommandsModel: ObservableObject {
    /// Drives NavigationSplitView column visibility (⌘B toggles).
    @Published var columnVisibility: NavigationSplitViewVisibility = .all
    /// Monotonic ticks — the workspace observes these to perform one-shot UI
    /// actions without the Commands scene needing direct view-state access.
    @Published var focusSearchTick = 0
    @Published var dismissTick = 0
    @Published var connectTick = 0
    @Published var paletteTick = 0
    /// Set by the Session → Rename menu command; the workspace presents the
    /// rename alert bound to this.
    @Published var renameTarget: SessionRef?

    func toggleSidebar() {
        withAnimation { columnVisibility = columnVisibility == .all ? .detailOnly : .all }
    }
    func requestConnect() { connectTick &+= 1 }
    func openPalette() { paletteTick &+= 1 }
}

extension FocusedValues {
    @Entry var t4SessionStore: T4SessionStore?
    @Entry var macCommands: MacCommandsModel?
}

/// macOS menu bar + keyboard shortcuts. Menus: Session, View, Host, Go to
/// Session. Shortcuts: ⌘N new, ⌘B toggle sidebar, ⌘F focus search, ⌘1…⌘9
/// select visible session by index, ⌘⌫ delete, Esc close sheet.
struct MacCommands: SwiftUI.Commands {
    @FocusedValue(\.t4SessionStore) private var store: T4SessionStore?
    @FocusedValue(\.macCommands) private var commands: MacCommandsModel?

    private var selected: SessionRef? { store?.selectedSession }
    /// Visible sessions in rail order (project-grouped, newest-first), the
    /// same ordering the sidebar shows — the index ⌘1…⌘9 addresses.
    private var flatSessions: [SessionRef] { store?.groups.flatMap(\.sessions) ?? [] }

    var body: some SwiftUI.Commands {
        CommandMenu("Session") {
            Button("New Session") { Task { await newSession() } }
                .keyboardShortcut("n", modifiers: .command)
                .disabled(store == nil || (store?.groups.isEmpty ?? true))

            Button("Rename\u{2026}") { if let s = selected { commands?.renameTarget = s } }
                .disabled(selected == nil)

            Divider()

            Button("Compact") {
                if let s = selected { Task { await store?.compactSession(sessionId: s.sessionId) } }
            }
            .disabled(selected == nil)

            Button("Retry") {
                if let s = selected { Task { await store?.retrySession(sessionId: s.sessionId) } }
            }
            .disabled(selected == nil)

            Divider()

            Button("Close") {
                if let s = selected { Task { await store?.closeSession(sessionId: s.sessionId) } }
            }
            .disabled(selected == nil || selected?.status == "closed")

            Button("Delete") {
                if let s = selected { Task { await store?.deleteSession(sessionId: s.sessionId) } }
            }
            .keyboardShortcut(.delete, modifiers: .command)
            .disabled(selected == nil)
        }

        CommandMenu("View") {
            Button("Command Palette") { commands?.openPalette() }
                .keyboardShortcut("k", modifiers: .command)

            Button("Toggle Sidebar") { commands?.toggleSidebar() }
                .keyboardShortcut("b", modifiers: .command)

            Button("Focus Search") { commands?.focusSearch() }
                .keyboardShortcut("f", modifiers: .command)

            Button("Close Sheet") { commands?.dismissPresented() }
                .keyboardShortcut(.escape, modifiers: [])

        }

        CommandMenu("Host") {
            Button("Connect\u{2026}") { commands?.requestConnect() }
                .disabled(store?.connected == true)

            Button("Disconnect") { Task { await store?.disconnect() } }
                .disabled(store?.connected != true)

            Divider()

            Button("Pair with Host\u{2026}") { commands?.requestConnect() }
        }

        CommandMenu("Go to Session") {
            ForEach(0..<9) { i in
                Button("Session \(i + 1)") { selectByIndex(i) }
                    .keyboardShortcut(KeyEquivalent(Character("\(i + 1)")), modifiers: .command)
                    .disabled(i >= flatSessions.count)
            }
        }
    }

    // MARK: - Actions

    private func newSession() async {
        guard let store else { return }
        let projectId = selected?.project.projectId
            ?? store.groups.first?.sessions.first?.project.projectId
            ?? ""
        guard !projectId.isEmpty else { return }
        let created = await store.createSession(projectId: projectId)
        if let created { store.select(created) }
    }

    private func selectByIndex(_ i: Int) {
        guard let store, flatSessions.indices.contains(i) else { return }
        store.select(flatSessions[i])
    }


}
#endif
