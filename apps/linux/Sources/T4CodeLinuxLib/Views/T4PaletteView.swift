//  T4PaletteView.swift (Linux port of apps/ios/Sources/T4PaletteView.swift)
//  Command palette overlay — search field on top, results below. Two result
//  kinds: Sessions (title/project/status, subtitle shows provider/model) and
//  Actions (New Session, Connect, Disconnect, Rename, Compact, Retry, Close,
//  Delete, toggle theme, plan mode on/off for the selected session).
//
//  Fuzzy-ish filter: case-insensitive substring on title/project/status/model
//  for sessions, on the action name for actions. Keyboard: up/down moves the
//  selection, return activates, Esc closes.
//
//  Linux port notes:
//  • SwiftCrossUI has no onKeyPress/@FocusState: keyboard navigation is
//    dropped, rows activate on click (LINUX-GAP: onKeyPress). The dimmed
//    backdrop taps to close, as on iOS.
//  • .glass(...) → panel background + border overlay with the theme's
//    panel/glassBorder tokens.
//  • The macOS "Connect to Host" action posts .t4PaletteRequestConnect for
//    the workspace to observe; on Linux the workspace hands an
//    `onRequestConnect` closure down instead.
//  • The rename alert is a sheet (alerts cannot host text fields).
//  • SF Symbols → text glyphs.

import Foundation
import SwiftCrossUI
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

    /// Text glyph shown beside the action (SF Symbols don't exist on Linux).
    var glyph: String {
        switch self {
        case .newSession:   return "+"
        case .connect:      return "⛁"
        case .disconnect:   return "⛌"
        case .rename:       return "✎"
        case .compact:      return "⤡"
        case .retry:        return "⟳"
        case .close:        return "✕"
        case .delete:       return "⌫"
        case .toggleTheme:  return "◐"
        case .planModeOn:   return "☰"
        case .planModeOff:  return "⚒"
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
    let store: T4SessionStore
    let theme: ThemeStore
    @Binding var isPresented: Bool
    /// Linux port seam: the macOS palette posts .t4PaletteRequestConnect on
    /// the notification center for the workspace to observe; here the
    /// workspace passes the action directly (LINUX-GAP: onReceive).
    var onRequestConnect: () -> Void = {}

    @State private var query = ""
    @State private var selection = 0
    // LINUX-GAP: @FocusState has no SwiftCrossUI equivalent — the search
    // field cannot be programmatically focused.

    /// Rename is the one action that needs a text prompt; handled inline so the
    /// palette stays self-contained and routes to store.renameSession.
    @State private var renameTarget: SessionRef?
    @State private var renameText = ""

    private var t: Theme { theme.t }

    init(
        store: T4SessionStore,
        theme: ThemeStore,
        isPresented: Binding<Bool>,
        onRequestConnect: @escaping () -> Void = {}
    ) {
        self.store = store
        self.theme = theme
        self._isPresented = isPresented
        self.onRequestConnect = onRequestConnect
    }

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
                .onTapGesture { close() }

            panel
                .frame(maxWidth: 520, maxHeight: 420)
                .padding(.horizontal, 40)
        }
        .onAppear {
            query = ""
            selection = 0
        }
        .sheet(isPresented: Binding(
            get: { renameTarget != nil },
            set: { if !$0 { renameTarget = nil } }
        )) {
            renameSheet
        }
    }

    private var panel: some View {
        VStack(spacing: 0) {
            searchField
            Rectangle().fill(t.line).frame(height: 1)
            results
        }
        // LINUX-GAP: .glass(t, 18, panel: true, border: true) →
        // panel fill + glassBorder hairline.
        // LINUX-FIX: background ring, not overlay stroke (overlay DrawingArea
        // eats clicks; the search field inside could never take focus).
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: 18).fill(t.glassBorder)
                RoundedRectangle(cornerRadius: 18).fill(t.panel).padding(1)
            }
        }
    }

    private var searchField: some View {
        HStack(spacing: 10) {
            // LINUX-GAP: magnifyingglass SF Symbol → "⌕" glyph
            Text("⌕")
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(t.txtMuted)
            TextField("Search sessions and actions", text: $query)
                .font(.system(size: 16))
                .onChange(of: query) { selection = 0 }
            if !query.isEmpty {
                T4TextButton("✕") { query = "" }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var results: some View {
        ScrollView {
            VStack(spacing: 0) {
                if !filteredSessions.isEmpty {
                    sectionHeader("Sessions")
                    ForEach(filteredSessions, id: \.sessionId) { s in
                        row(for: .session(s))
                    }
                }
                if !filteredActions.isEmpty {
                    sectionHeader("Actions")
                    ForEach(filteredActions) { a in
                        row(for: .action(a))
                    }
                }
                if items.isEmpty {
                    emptyState
                }
            }
            .padding(.vertical, 6)
        }
    }

    private func sectionHeader(_ label: String) -> some View {
        Text(label.uppercased())
            .font(.system(size: 11, weight: .bold))
            .foregroundColor(t.txtGhost)
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
        .background(selected ? t.glassFill : Color.clear)
        .onTapGesture {
            selection = index
            activate()
        }
    }

    private func sessionRow(_ s: SessionRef, selected: Bool) -> some View {
        HStack(spacing: 12) {
            Circle()
                .fill(statusColor(s.status))
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(s.title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(t.txt)
                    .lineLimit(1)
                Text(subtitle(for: s))
                    .font(.system(size: 12))
                    .foregroundColor(t.txtMuted)
                    .lineLimit(1)
            }
            Spacer()
            Text(s.status.uppercased())
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(t.txtLabel)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    private func actionRow(_ a: PaletteAction, selected: Bool) -> some View {
        HStack(spacing: 12) {
            Text(a.glyph)
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(t.txtMuted)
                .frame(width: 18)
            Text(a.title)
                .font(.system(size: 14))
                .foregroundColor(t.txt)
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    private var emptyState: some View {
        Text("No matches")
            .font(.system(size: 13))
            .foregroundColor(t.txtGhost)
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

    // LINUX-GAP: move(_:) keyboard navigation is retained for parity but is
    // not wired to any keys (SwiftCrossUI has no onKeyPress).
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
            // The workspace owns the connect sheet; flip it via the seam.
            onRequestConnect()
        case .disconnect:
            Task { await store.disconnect() }
        case .rename:
            // Keep the palette mounted so the rename sheet can present over it;
            // the sheet's buttons close the palette after the user decides.
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
        withAnimation { isPresented = false }
    }

    /// Rename prompt as a sheet (SwiftCrossUI alerts cannot host a text field).
    private var renameSheet: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Rename Session")
                    .lineLimit(1)
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(t.txt)
            Text("Enter a new title for this session.")
                .font(.bodyF(12))
                .foregroundColor(t.txtMuted)
            TextField("Session name", text: $renameText)
                .padding(6)
                .background { RoundedRectangle(cornerRadius: 8).fill(t.glassFill) }
            HStack(spacing: 10) {
                Spacer()
                T4TextButton("Cancel") { renameTarget = nil; close() }
                T4TextButton("Rename") {
                    if let s = renameTarget {
                        Task { await store.renameSession(sessionId: s.sessionId, name: renameText) }
                    }
                    renameTarget = nil
                    close()
                }
            }
        }
        .padding(20)
        .frame(width: 360)
        // LINUX-FIX: background ring, not overlay stroke (focus-eating).
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: 14).fill(t.glassBorder)
                RoundedRectangle(cornerRadius: 14).fill(t.panel).padding(1)
            }
        }
    }
}

private extension Int {
    func clamped(to range: Range<Int>) -> Int {
        Swift.min(Swift.max(self, range.lowerBound), range.upperBound - 1)
    }
}
