//  T4SessionsView.swift (Linux port of apps/ios/Sources/T4SessionsView.swift)
//  The authoritative T4 Code session rail — sessions grouped by project, with
//  status, model, context meter, and pending tags. Tapping a row selects it for
//  the detail destination. Backed by T4SessionStore (host-wire inventory).
//
//  Linux port notes:
//  • SwiftUI List sections / contextMenu / swipeActions do not exist in
//    SwiftCrossUI: the rail is a ScrollView and row actions live in a
//    trailing "⋯" Menu (LINUX-GAP: contextMenu/swipeActions).
//  • The rename alert is a sheet — SwiftCrossUI alerts cannot host a text
//    field (LINUX-GAP: alert text fields).
//  • SF Symbols are replaced by text glyphs; accessibility modifiers are
//    dropped (no a11y system in SwiftCrossUI).
//  • T4ModelLabel is a cross-agent type (TranscriptAgent's port).

import Foundation
import SwiftCrossUI
import HostWire

struct T4SessionsView: View {
    let store: T4SessionStore
    let theme: ThemeStore
    var onSelect: (SessionRef) -> Void = { _ in }

    private var t: Theme { theme.t }

    /// Session awaiting a rename (rail row menu → rename sheet).
    @State private var renaming: SessionRef?
    @State private var renameText = ""
    @State private var collapsedProjectIds: Set<String> = []
    @State private var visibleLimitByGroupId: [String: Int] = [:]

    private let groupedPageSize = 5
    private let flatPageSize = 25

    init(
        store: T4SessionStore,
        theme: ThemeStore,
        onSelect: @escaping (SessionRef) -> Void = { _ in }
    ) {
        self.store = store
        self.theme = theme
        self.onSelect = onSelect
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                railControls

                if store.connecting {
                    HStack(spacing: 6) {
                        ProgressView()
                        Text("Connecting\u{2026}")
                            .font(.bodyF(12))
                            .foregroundColor(t.txtMuted)
                    }
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 6)
                }
                if let error = store.lastError {
                    Text(error)
                        .font(.bodyF(12))
                        .foregroundColor(t.diffDel)
                        .padding(.vertical, 4)
                }
                if !store.pinnedSessions.isEmpty {
                    HStack(spacing: 5) {
                        Text("Pinned")
                        .lineLimit(1)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(t.txtBody)
                        // LINUX-GAP: pin.fill SF Symbol → text glyph
                        Text("⚑")
                            .font(.system(size: 10))
                            .foregroundColor(t.accent)
                    }
                    .padding(.top, 8)
                    .padding(.bottom, 4)
                    sessionRows(store.pinnedSessions, groupId: "__pinned__", pageSize: groupedPageSize)
                }
                // Linux perf bound: the rail is an eager ScrollView layout and
                // a fully expanded multi-hundred-session inventory makes every
                // re-render pass so expensive the main thread never paints.
                // While a big inventory's collapse decision is pending (and on
                // every later pass), only headers render; the onChange below
                // collapses all but the first 5 projects, then rows appear.
                let collapsePending = store.groups.count > 12 && collapsedProjectIds.isEmpty
                ForEach(store.groups) { group in
                    groupHeader(group)
                    if !collapsePending, !collapsedProjectIds.contains(group.projectId) {
                        sessionRows(
                            group.sessions,
                            groupId: group.projectId,
                            pageSize: store.railOrganization == .flat ? flatPageSize : groupedPageSize
                        )
                    }
                }
                if store.groups.isEmpty {
                    Text(emptyMessage)
                        .font(.bodyF(13))
                        .foregroundColor(t.txtMuted)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, 12)
                }
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 12)
        }
        .onChange(of: store.groups.count) {
            // Linux perf bound: the rail is an eager ScrollView layout, so a
            // fully expanded multi-hundred-session inventory stalls the main
            // thread for one giant layout pass (the window never paints).
            // Default to the first 5 projects expanded, the rest collapsed;
            // every group header remains tappable to expand.
            if collapsedProjectIds.isEmpty && store.groups.count > 12 {
                collapsedProjectIds = Set(store.groups.dropFirst(5).map(\.projectId))
            }
        }
        .sheet(isPresented: Binding(
            get: { renaming != nil },
            set: { if !$0 { renaming = nil } }
        )) {
            renameSheet
        }
    }

    private var railControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker(
                of: [
                    SessionListViewOption(view: .current, label: "Current \(store.currentSessionCount)"),
                    SessionListViewOption(view: .archived, label: "Archived \(store.archivedSessionCount)"),
                ],
                selection: Binding(
                    get: { SessionListViewOption(view: store.sessionListView, label: "") },
                    set: { newValue in
                        if let newValue { store.setSessionListView(newValue.view) }
                    }
                )
            )
            // LINUX-GAP: GtkBackend only implements the .menu picker style;
            // .segmented falls back to a menu picker.
            .pickerStyle(.menu)

            HStack(spacing: 8) {
                ScrollView(.horizontal) {
                    HStack(spacing: 6) {
                        ForEach(T4RailFilter.allCases, id: \.rawValue) { filter in
                            filterButton(filter)
                        }
                    }
                }

                // LINUX-GAP: slider.horizontal.3 SF Symbol → "≡" glyph; the
                // two nested Pickers become submenus with checkable Toggles
                // (SwiftCrossUI Menu items support Button/Text/Toggle/Divider).
                Menu("≡") {
                    Menu("Organization") {
                        Toggle("By project", isOn: Binding(
                            get: { store.railOrganization == .byProject },
                            set: { if $0 { store.setRailOrganization(.byProject) } }
                        ))
                        Toggle("In one list", isOn: Binding(
                            get: { store.railOrganization == .flat },
                            set: { if $0 { store.setRailOrganization(.flat) } }
                        ))
                    }
                    Menu("Sort by") {
                        Toggle("Priority", isOn: Binding(
                            get: { store.railSort == .priority },
                            set: { if $0 { store.setRailSort(.priority) } }
                        ))
                        Toggle("Last updated", isOn: Binding(
                            get: { store.railSort == .updated },
                            set: { if $0 { store.setRailSort(.updated) } }
                        ))
                        Toggle("Manual order", isOn: Binding(
                            get: { store.railSort == .manual },
                            set: { if $0 { store.setRailSort(.manual) } }
                        ))
                    }
                }
                ._buttonWidth(34)
            }
        }
        .padding(.vertical, 4)
    }

    private func filterButton(_ filter: T4RailFilter) -> some View {
        let selected = store.railFilter == filter
        // Select state is highlighted text, not a pill: sharp accent-dim
        // highlight behind the label when active, plain muted text otherwise.
        return Text(filter.label)
            .font(.system(size: 11, weight: .semibold))
            .lineLimit(1)
            .foregroundColor(selected ? t.accent : t.txtMuted)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .frame(minHeight: 32)
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: 2).fill(t.accentDim)
                }
            }
            .onTapGesture { store.setRailFilter(filter) }
    }

    @ViewBuilder
    private func sessionRows(_ sessions: [SessionRef], groupId: String, pageSize: Int) -> some View {
        let limit = visibleLimitByGroupId[groupId] ?? pageSize
        let visible = Array(sessions.prefix(limit))
        ForEach(visible, id: \.sessionId) { session in
            sessionRow(session)
        }
        if sessions.count > visible.count {
            HStack(spacing: 6) {
                Text("Show more")
                Spacer()
                Text("\(sessions.count - visible.count) remaining")
                    .font(.bodyF(12))
                    .foregroundColor(t.txtLabel)
            }
            .font(.system(size: 12, weight: .semibold))
            .foregroundColor(t.accent)
            .padding(.vertical, 4)
            .onTapGesture { visibleLimitByGroupId[groupId] = limit + pageSize }
        }
    }

    /// Row actions (pin/move/archive/…) live in a trailing menu — the
    /// macOS contextMenu/swipeActions equivalent. The menu sits OUTSIDE the
    /// row's tap target: SwiftCrossUI tap gestures swallow child buttons.
    private func sessionRow(_ session: SessionRef) -> some View {
        HStack(spacing: 6) {
            HStack(spacing: 8) {
                T4SessionRow(session: session, theme: t)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if store.pinnedSessionIds.contains(session.sessionId) {
                    // LINUX-GAP: pin.fill SF Symbol → text glyph
                    Text("⚑")
                        .font(.system(size: 10))
                        .foregroundColor(t.accent)
                }
            }
            .onTapGesture { onSelect(session) }

            Menu("⋯") {
                rowContextMenu(for: session)
            }
        }
        .padding(.vertical, 2)
    }

    private func groupHeader(_ group: T4SessionStore.Group) -> some View {
        HStack(spacing: 6) {
            HStack(spacing: 6) {
                if store.railOrganization == .byProject {
                    Text(collapsedProjectIds.contains(group.projectId) ? "▸" : "▾")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundColor(t.txtLabel)
                        .frame(width: 10)
                } else {
                    // LINUX-GAP: fixed-width spacer keeps the tray icon aligned
                    Text("")
                        .frame(width: 10)
                }
                // LINUX-GAP: folder/tray.full SF Symbols → text glyphs
                Text(store.railOrganization == .byProject ? "▣" : "▤")
                    .font(.system(size: 10))
                    .foregroundColor(t.txtLabel)
                Text(group.project)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(t.txtBody)
                    .lineLimit(1)
            }
            .onTapGesture {
                guard store.railOrganization == .byProject else { return }
                if collapsedProjectIds.contains(group.projectId) {
                    collapsedProjectIds.remove(group.projectId)
                } else {
                    collapsedProjectIds.insert(group.projectId)
                }
            }
            Spacer()
            Text("\(group.sessions.count)")
                .font(.system(size: 11))
                .foregroundColor(t.txtLabel)
            if store.railSort == .manual && store.railOrganization == .byProject {
                Menu("⋯") {
                    T4TextButton("Move project up") { store.moveProject(group.projectId, direction: -1) }
                    T4TextButton("Move project down") { store.moveProject(group.projectId, direction: 1) }
                }
            }
        }
        .padding(.top, 8)
        .padding(.bottom, 4)
    }

    private var emptyMessage: String {
        if !store.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || store.railFilter != .all {
            return "No matches"
        }
        return store.sessionListView == .current
            ? "No current sessions on this host"
            : "No archived sessions on this host"
    }

    @ViewBuilder
    private func rowContextMenu(for session: SessionRef) -> some View {
        T4TextButton(store.pinnedSessionIds.contains(session.sessionId) ? "Unpin" : "Pin") {
            store.setSessionPinned(
                session.sessionId,
                pinned: !store.pinnedSessionIds.contains(session.sessionId)
            )
        }
        if store.railSort == .manual {
            T4TextButton("Move up") {
                store.moveSession(session, direction: -1)
            }
            T4TextButton("Move down") {
                store.moveSession(session, direction: 1)
            }
        }
        Divider()
        if let control = session.sessionControl {
            let presentation = control.t4Presentation
            // Inert menu label mirroring the macOS disabled Label item.
            Text(presentation.railLabel)
            if session.t4CanRestore {
                T4TextButton("Restore") {
                    Task { await store.restoreSession(sessionId: session.sessionId) }
                }
                .disabled(!store.connected)
            }
            if presentation.canFork && store.canForkSessions {
                T4TextButton("Continue in a Copy") {
                    Task { await store.forkSession(sessionId: session.sessionId) }
                }
            }
            if case .released = control {
                T4TextButton("Bring Back to App") {
                    Task { await store.reclaimSession(sessionId: session.sessionId) }
                }
            }
        } else {
            if session.archivedAt == nil {
                T4TextButton("Rename") {
                    renameText = session.title
                    renaming = session
                }
                T4TextButton("Archive") {
                    Task { await store.archiveSession(sessionId: session.sessionId) }
                }
                .disabled(!store.connected)
                Divider()
                T4TextButton("Compact") {
                    Task { await store.compactSession(sessionId: session.sessionId) }
                }
                T4TextButton("Retry") {
                    Task { await store.retrySession(sessionId: session.sessionId) }
                }
                T4TextButton("Close") {
                    Task { await store.closeSession(sessionId: session.sessionId) }
                }
                .disabled(session.status == "closed")
            } else {
                T4TextButton("Restore") {
                    Task { await store.restoreSession(sessionId: session.sessionId) }
                }
                .disabled(!store.connected)
            }
            Divider()
            T4TextButton("Delete") {
                Task { await store.deleteSession(sessionId: session.sessionId) }
            }
        }
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
                T4TextButton("Cancel") { renaming = nil }
                T4TextButton("Rename") { submitRename() }
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

    private func submitRename() {
        guard let session = renaming else { return }
        let name = renameText
        renaming = nil
        renameText = ""
        Task { await store.renameSession(sessionId: session.sessionId, name: name) }
    }
}

/// Picker option type — SwiftCrossUI renders options via string
/// interpolation, so the live session counts ride on the description.
private struct SessionListViewOption: Equatable, CustomStringConvertible {
    let view: T4SessionListView
    let label: String

    var description: String { label }

    static func == (lhs: SessionListViewOption, rhs: SessionListViewOption) -> Bool {
        lhs.view == rhs.view
    }
}

struct T4SessionRow: View {
    let session: SessionRef
    let theme: Theme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // LINUX-GAP: .firstTextBaseline alignment is unavailable
            HStack(alignment: .top, spacing: 8) {
                Text(session.title)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(theme.txt)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if let control = session.sessionControl {
                    Text(control.t4Presentation.railLabel)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(theme.cAdvisor)
                        .lineLimit(1)
                } else {
                    StatusPill(status: session.status, theme: theme)
                }
            }
            HStack(spacing: 10) {
                if let model = session.model {
                    // Cross-agent type (TranscriptAgent): T4ModelLabel(selector:theme:size:)
                    T4ModelLabel(selector: model, theme: theme)
                        .lineLimit(1)
                }
                if let usage = session.contextUsage {
                    ContextMeter(used: usage.used, limit: usage.limit, theme: theme)
                }
                Spacer(minLength: 0)
            }
            .lineLimit(1)
            HStack(spacing: 6) {
                if session.pendingApproval == true { Tag(text: "approval", color: theme.diffAdd, theme: theme) }
                if session.pendingUserInput == true { Tag(text: "input", color: theme.cTask, theme: theme) }
                Text(session.updatedAt).font(.system(size: 10)).foregroundColor(theme.txtLabel)
                    .lineLimit(1)
            }
            .lineLimit(1)
        }
        .padding(.vertical, 3)
    }
}

struct StatusPill: View {
    let status: String
    let theme: Theme
    var body: some View {
        let (label, color) = Self.style(status)
        Text(label.uppercased())
            .font(.system(size: 10, weight: .semibold))
            .foregroundColor(color)
    }
    static func style(_ status: String) -> (String, Color) {
        switch status {
        case "active": return ("active", Color.green)
        case "idle": return ("idle", Color.yellow)
        // LINUX-GAP: SwiftUI Color.secondary → Color.gray
        default: return (status, Color.gray)
        }
    }
}

struct ContextMeter: View {
    let used: Int
    let limit: Int
    let theme: Theme
    var body: some View {
        let fraction = limit > 0 ? min(1.0, Double(used) / Double(limit)) : 0
        HStack(spacing: 4) {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(theme.lineFaint)
                    Capsule().fill(theme.accent.opacity(0.8)).frame(width: geo.size.width * fraction)
                }
            }
            .frame(width: 44, height: 4)
            Text("\(used)/\(limit)").font(.system(size: 10)).foregroundColor(theme.txtLabel)
        }
    }
}

struct Tag: View {
    let text: String
    let color: Color
    let theme: Theme
    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 9, weight: .semibold))
            .foregroundColor(color)
    }
}
