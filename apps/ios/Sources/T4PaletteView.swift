//  T4PaletteView.swift
//  Command palette overlay — search field on top, results below. Two result
//  kinds: Sessions (title/project/status, subtitle shows provider/model) and
//  Actions (New Session, Connect, Disconnect, Rename, Compact, Retry, Close,
//  Delete, toggle theme, plan mode on/off for the selected session).
//
//  Fuzzy-ish filter: case-insensitive substring on title/project/status/model
//  for sessions, on the action name for actions. Keyboard: up/down moves the
//  selection, return activates, Esc closes. On macOS Esc is also routed through
//  MacCommands.dismissTick (the workspace observes it and flips isPresented);
//  on iOS a swipe-down gesture dismisses, and the dimmed backdrop taps to close.

import SwiftUI
import HostWire

/// A palette action the user can invoke. Availability is gated on connection /
/// selection state so the filtered list only shows actionable rows.
enum PaletteAction: String, CaseIterable, Identifiable {
    case newSession, connect, disconnect, rename, compact, retry, close, delete
    case toggleTheme, planModeOn, planModeOff

    var id: String { rawValue }

    var title: String {
        switch self {
        case .newSession:   return "New Session"
        case .connect:      return "Connect to Host"
        case .disconnect:   return "Disconnect"
        case .rename:       return "Rename Session"
        case .compact:      return "Compact"
        case .retry:        return "Retry"
        case .close:        return "Close"
        case .delete:       return "Delete"
        case .toggleTheme:  return "Toggle Theme"
        case .planModeOn:   return "Plan Mode On"
        case .planModeOff:  return "Plan Mode Off"
        }
    }

    var systemImage: String {
        switch self {
        case .newSession:   return "plus.square"
        case .connect:      return "link.badge.plus"
        case .disconnect:   return "link.badge.minus"
        case .rename:       return "pencil"
        case .compact:      return "rectangle.compress.vertical"
        case .retry:        return "arrow.clockwise"
        case .close:        return "xmark.circle"
        case .delete:       return "trash"
        case .toggleTheme:  return "circle.lefthalf.filled"
        case .planModeOn:   return "list.bullet.rectangle"
        case .planModeOff:  return "hammer"
        }
    }

    /// Rows that don't apply to the current state are hidden, not disabled — a
    /// palette of greyed-out entries is noise.
    func isAvailable(connected: Bool, hasSelected: Bool) -> Bool {
        switch self {
        case .newSession:   return connected
        case .connect:      return !connected
        case .disconnect:   return connected
        case .rename:       return hasSelected
        case .compact:      return hasSelected
        case .retry:        return hasSelected
        case .close:        return hasSelected
        case .delete:       return hasSelected
        case .toggleTheme:  return true
        case .planModeOn:   return hasSelected
        case .planModeOff:  return hasSelected
        }
    }
}

/// One row in the palette list. Sessions sort above actions so typing a name
/// surfaces matching sessions first; typing an action verb surfaces the action.
enum PaletteItem: Identifiable, Equatable {
    case session(SessionRef)
    case action(PaletteAction)

    var id: String {
        switch self {
        case .session(let s): return "session:\(s.sessionId)"
        case .action(let a):  return "action:\(a.id)"
        }
    }
}

struct T4PaletteView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var store: T4SessionStore
    @Binding var isPresented: Bool

    @State private var query = ""
    @State private var selection = 0
    @FocusState private var searchFocused: Bool

    /// Rename is the one action that needs a text prompt; handled inline so the
    /// palette stays self-contained and routes to store.renameSession.
    @State private var renameTarget: SessionRef?
    @State private var renameText = ""

    private var t: Theme { theme.t }

    // MARK: - Filtering

    private var filteredSessions: [SessionRef] {
        let q = query.lowercased()
        guard !q.isEmpty else { return store.sessions }
        return store.sessions.filter { s in
            s.title.lowercased().contains(q)
                || (s.project.name ?? s.project.projectId).lowercased().contains(q)
                || s.status.lowercased().contains(q)
                || (s.model ?? "").lowercased().contains(q)
        }
    }

    private var filteredActions: [PaletteAction] {
        let q = query.lowercased()
        let connected = store.connected
        let hasSelected = store.selectedSession != nil
        return PaletteAction.allCases.filter { action in
            action.isAvailable(connected: connected, hasSelected: hasSelected)
                && (q.isEmpty || action.title.lowercased().contains(q))
        }
    }

    private var items: [PaletteItem] {
        filteredSessions.map(PaletteItem.session) + filteredActions.map(PaletteItem.action)
    }

    // MARK: - Body

    var body: some View {
        ZStack {
            // Dimmed backdrop: tap to dismiss.
            Color.black.opacity(0.45)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { close() }

            panel
                .frame(maxWidth: 520, maxHeight: 420)
                .glass(t, 18, panel: true, border: true)
                .padding(.horizontal, 40)
                #if os(iOS)
                .gesture(dismissSwipe)
                #endif
        }
        .transition(.opacity)
        .onAppear {
            query = ""
            selection = 0
            // Focus the field next runloop tick so the keystrokes land.
            DispatchQueue.main.async { searchFocused = true }
        }
        .alert("Rename Session", isPresented: Binding(
            get: { renameTarget != nil },
            set: { if !$0 { renameTarget = nil } }
        )) {
            TextField("Session name", text: $renameText)
            Button("Rename") {
                if let s = renameTarget {
                    Task { await store.renameSession(sessionId: s.sessionId, name: renameText) }
                }
                renameTarget = nil
                close()
            }
            Button("Cancel", role: .cancel) { renameTarget = nil; close() }
        } message: {
            Text("Enter a new title for this session.")
        }
    }

    private var panel: some View {
        VStack(spacing: 0) {
            searchField
            Rectangle().fill(t.line).frame(height: 1)
            results
        }
        .background(t.panel)
    }

    private var searchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(t.txtMuted)
            TextField("Search sessions and actions", text: $query)
                .textFieldStyle(.plain)
                .font(.system(size: 16))
                .focused($searchFocused)
                .onChange(of: query) { _, _ in selection = 0 }
                .onKeyPress(.upArrow) { move(-1); return .handled }
                .onKeyPress(.downArrow) { move(1); return .handled }
                .onKeyPress(.return) { activate(); return .handled }
                .onKeyPress(.escape) { close(); return .handled }
            if !query.isEmpty {
                Button { query = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(t.txtGhost)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var results: some View {
        ScrollView {
            LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                if !filteredSessions.isEmpty {
                    section(header: "Sessions") {
                        ForEach(filteredSessions, id: \.sessionId) { s in
                            row(for: .session(s))
                        }
                    }
                }
                if !filteredActions.isEmpty {
                    section(header: "Actions") {
                        ForEach(filteredActions) { a in
                            row(for: .action(a))
                        }
                    }
                }
                if items.isEmpty {
                    emptyState
                }
            }
            .padding(.vertical, 6)
        }
    }

    @ViewBuilder
    private func section<Content: View>(header: String, @ViewBuilder content: () -> Content) -> some View {
        Section(header: sectionHeader(header)) {
            content()
        }
    }

    private func sectionHeader(_ label: String) -> some View {
        Text(label.uppercased())
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(t.txtGhost)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 4)
            .background(t.panel)
    }

    @ViewBuilder
    private func row(for item: PaletteItem) -> some View {
        let index = items.firstIndex(of: item) ?? 0
        let selected = index == selection
        Group {
            switch item {
            case .session(let s):
                sessionRow(s, selected: selected)
            case .action(let a):
                actionRow(a, selected: selected)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            selection = index
            activate()
        }
        .background(selected ? t.glassFill : Color.clear)
    }

    private func sessionRow(_ s: SessionRef, selected: Bool) -> some View {
        HStack(spacing: 12) {
            Circle()
                .fill(statusColor(s.status))
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(s.title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(t.txt)
                    .lineLimit(1)
                Text(subtitle(for: s))
                    .font(.system(size: 12))
                    .foregroundStyle(t.txtMuted)
                    .lineLimit(1)
            }
            Spacer()
            Text(s.status)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(t.txtLabel)
                .textCase(.uppercase)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    private func actionRow(_ a: PaletteAction, selected: Bool) -> some View {
        HStack(spacing: 12) {
            Image(systemName: a.systemImage)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(t.txtMuted)
                .frame(width: 18)
            Text(a.title)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(t.txt)
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    private var emptyState: some View {
        Text("No matches")
            .font(.system(size: 13))
            .foregroundStyle(t.txtGhost)
            .padding(.vertical, 24)
    }

    // MARK: - Helpers

    private func subtitle(for s: SessionRef) -> String {
        let project = s.project.name ?? s.project.projectId
        let model = s.model.map { splitModelSelector($0).model } ?? "no model"
        return "\(project) · \(model)"
    }

    private func statusColor(_ status: String) -> Color {
        switch status.lowercased() {
        case "active", "working":   return t.cOk
        case "approval", "input":   return t.cAdvisor
        case "plan":                return t.cTask
        case "error":               return t.diffDel
        case "closed", "done":      return t.txtGhost
        default:                    return t.txtMuted
        }
    }

    private func move(_ delta: Int) {
        guard !items.isEmpty else { return }
        selection = (selection + delta).clamped(to: 0..<items.count)
    }

    private func activate() {
        guard items.indices.contains(selection) else { return }
        switch items[selection] {
        case .session(let s):
            store.select(s)
            close()
        case .action(let a):
            perform(a)
        }
    }

    private func perform(_ action: PaletteAction) {
        let selected = store.selectedSession
        switch action {
        case .newSession:
            let projectId = selected?.project.projectId
                ?? store.groups.first?.sessions.first?.project.projectId
                ?? ""
            Task {
                if let created = await store.createSession(projectId: projectId) {
                    store.select(created)
                }
            }
        case .connect:
            // The workspace owns the connect sheet; flip a flag it observes.
            NotificationCenter.default.post(name: .t4PaletteRequestConnect, object: nil)
        case .disconnect:
            Task { await store.disconnect() }
        case .rename:
            // Keep the palette mounted so the rename alert can present over it;
            // the alert's buttons close the palette after the user decides.
            if let s = selected {
                renameTarget = s
                renameText = s.title
            }
            return
        case .compact:
            if let s = selected { Task { await store.compactSession(sessionId: s.sessionId) } }
        case .retry:
            if let s = selected { Task { await store.retrySession(sessionId: s.sessionId) } }
        case .close:
            if let s = selected { Task { await store.closeSession(sessionId: s.sessionId) } }
        case .delete:
            if let s = selected { Task { await store.deleteSession(sessionId: s.sessionId) } }
        case .toggleTheme:
            theme.toggle()
        case .planModeOn:
            if let s = selected { Task { await store.setMode(sessionId: s.sessionId, mode: "plan") } }
        case .planModeOff:
            if let s = selected { Task { await store.setMode(sessionId: s.sessionId, mode: "build") } }
        }
        close()
    }

    private func close() {
        withAnimation(.easeOut(duration: 0.18)) { isPresented = false }
    }

    #if os(iOS)
    /// Swipe down to dismiss, mirroring the system sheet gesture.
    private var dismissSwipe: some Gesture {
        DragGesture(minimumDistance: 20)
            .onEnded { value in
                if value.translation.height > 60 { close() }
            }
    }
    #endif
}

extension Notification.Name {
    /// Posted by the palette when the user picks "Connect to Host" — the
    /// workspace observes it and presents the connect sheet (the sheet's
    /// presentation state lives on the workspace, not the palette).
    static let t4PaletteRequestConnect = Notification.Name("t4PaletteRequestConnect")
}

private extension Int {
    func clamped(to range: Range<Int>) -> Int {
        Swift.min(Swift.max(self, range.lowerBound), range.upperBound - 1)
    }
}
