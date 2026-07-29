//  T4SessionsView.swift
//  The authoritative T4 Code session rail — sessions grouped by project, with
//  status, model, context meter, and pending tags. Tapping a row selects it for
//  the detail destination. Backed by T4SessionStore (host-wire inventory).

import SwiftUI
import HostWire

struct T4SessionsView: View {
    @ObservedObject var store: T4SessionStore
    var onSelect: (SessionRef) -> Void = { _ in }
    @EnvironmentObject var theme: ThemeStore
    private var t: Theme { theme.t }

    /// Session awaiting a rename (rail context menu → alert with text field).
    @State private var renaming: SessionRef?
    @State private var renameText = ""
    @State private var collapsedProjectIds: Set<String> = []
    @State private var visibleLimitByGroupId: [String: Int] = [:]

    private let groupedPageSize = 5
    private let flatPageSize = 25

    var body: some View {
        List {
            railControls
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)

            if store.connecting {
                HStack { ProgressView(); Text("Connecting\u{2026}").foregroundStyle(t.txtMuted) }
                    .frame(maxWidth: .infinity, alignment: .center)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            if let error = store.lastError {
                Text(error).font(.system(size: 12)).foregroundStyle(t.diffDel)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            if !store.pinnedSessions.isEmpty {
                Section {
                    sessionRows(
                        store.pinnedSessions,
                        groupId: "__pinned__",
                        pageSize: groupedPageSize
                    )
                } header: {
                    Label("Pinned", systemImage: "pin.fill")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(t.txtBody)
                        .textCase(nil)
                }
            }
            ForEach(store.groups) { group in
                Section {
                    if !collapsedProjectIds.contains(group.projectId) {
                        sessionRows(
                            group.sessions,
                            groupId: group.projectId,
                            pageSize: store.railOrganization == .flat
                                ? flatPageSize
                                : groupedPageSize
                        )
                    }
                } header: {
                    groupHeader(group)
                }
            }
            if store.groups.isEmpty {
                Text(emptyMessage)
                    .foregroundStyle(t.txtMuted)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(t.bg)
        .alert("Rename Session", isPresented: Binding(
            get: { renaming != nil },
            set: { if !$0 { renaming = nil } }
        )) {
            TextField("Session name", text: $renameText)
            Button("Rename", action: submitRename)
            Button("Cancel", role: .cancel) { renaming = nil }
        } message: {
            Text("Enter a new title for this session.")
        }
    }

    private var railControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("Session list", selection: Binding(
                get: { store.sessionListView },
                set: { store.setSessionListView($0) }
            )) {
                Text("Current \(store.currentSessionCount)")
                    .accessibilityLabel("Current sessions")
                    .accessibilityValue("\(store.currentSessionCount)")
                    .tag(T4SessionListView.current)
                Text("Archived \(store.archivedSessionCount)")
                    .accessibilityLabel("Archived sessions")
                    .accessibilityValue("\(store.archivedSessionCount)")
                    .tag(T4SessionListView.archived)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("session-list-view")

            HStack(spacing: 8) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(T4RailFilter.allCases) { filter in
                            filterButton(filter)
                        }
                    }
                }

                Menu {
                    Picker("Organization", selection: Binding(
                        get: { store.railOrganization },
                        set: { store.setRailOrganization($0) }
                    )) {
                        ForEach(T4RailOrganization.allCases) { organization in
                            Text(organization.label).tag(organization)
                        }
                    }
                    Picker("Sort by", selection: Binding(
                        get: { store.railSort },
                        set: { store.setRailSort($0) }
                    )) {
                        ForEach(T4RailSort.allCases) { sort in
                            Text(sort.label).tag(sort)
                        }
                    }
                } label: {
                    Image(systemName: "slider.horizontal.3")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(t.txtBody)
                        .frame(width: 34, height: 34)
                        .background(t.bg2, in: RoundedRectangle(cornerRadius: 9))
                }
                .accessibilityLabel("Organize sessions")
                .accessibilityHint(
                    "\(store.railOrganization.label), sorted by \(store.railSort.label)"
                )
            }
        }
        .padding(.vertical, 4)
    }

    private func filterButton(_ filter: T4RailFilter) -> some View {
        let selected = store.railFilter == filter
        return Button {
            store.setRailFilter(filter)
        } label: {
            Text(filter.label)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(selected ? t.bg : t.txtMuted)
                .padding(.horizontal, 10)
                .frame(minHeight: 32)
                .background(selected ? t.txt : t.bg2, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("session-filter-\(filter.rawValue)")
    }

    @ViewBuilder
    private func sessionRows(
        _ sessions: [SessionRef],
        groupId: String,
        pageSize: Int
    ) -> some View {
        let limit = visibleLimitByGroupId[groupId] ?? pageSize
        let visible = Array(sessions.prefix(limit))
        ForEach(visible, id: \.sessionId) { session in
            sessionRow(session)
        }
        if sessions.count > visible.count {
            Button {
                visibleLimitByGroupId[groupId] = limit + pageSize
            } label: {
                HStack {
                    Text("Show more")
                    Spacer()
                    Text("\(sessions.count - visible.count) remaining")
                        .foregroundStyle(t.txtLabel)
                }
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(t.accent)
                .padding(.vertical, 4)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Show more sessions")
        }
    }

    private func sessionRow(_ session: SessionRef) -> some View {
        Button { onSelect(session) } label: {
            HStack(spacing: 8) {
                T4SessionRow(
                    session: session,
                    theme: t,
                    unread: store.unreadSessions.contains(session.sessionId)
                )
                if store.pinnedSessionIds.contains(session.sessionId) {
                    Image(systemName: "pin.fill")
                        .font(.system(size: 10))
                        .foregroundStyle(t.accent)
                        .accessibilityHidden(true)
                }
            }
        }
        .buttonStyle(.plain)
        .listRowBackground(Color.clear)
        .listRowSeparatorTint(t.lineFaint)
        .accessibilityIdentifier("session-row-\(session.sessionId)")
        .contextMenu { rowContextMenu(for: session) }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button {
                store.setSessionPinned(
                    session.sessionId,
                    pinned: !store.pinnedSessionIds.contains(session.sessionId)
                )
            } label: {
                Label(
                    store.pinnedSessionIds.contains(session.sessionId) ? "Unpin" : "Pin",
                    systemImage: store.pinnedSessionIds.contains(session.sessionId)
                        ? "pin.slash"
                        : "pin"
                )
            }
            .tint(t.accent)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            if session.t4CanRestore {
                Button {
                    Task { await store.restoreSession(sessionId: session.sessionId) }
                } label: {
                    Label("Restore", systemImage: "arrow.uturn.backward")
                }
                .tint(t.accent)
                .disabled(!store.connected)
            } else if session.t4IsWritable {
                Button {
                    Task { await store.archiveSession(sessionId: session.sessionId) }
                } label: {
                    Label("Archive", systemImage: "archivebox")
                }
                .tint(.orange)
                .disabled(!store.connected)
            }
        }
    }

    private func groupHeader(_ group: T4SessionStore.Group) -> some View {
        Button {
            guard store.railOrganization == .byProject else { return }
            if collapsedProjectIds.contains(group.projectId) {
                collapsedProjectIds.remove(group.projectId)
            } else {
                collapsedProjectIds.insert(group.projectId)
            }
        } label: {
            HStack(spacing: 6) {
                if store.railOrganization == .byProject {
                    Image(
                        systemName: collapsedProjectIds.contains(group.projectId)
                            ? "chevron.right"
                            : "chevron.down"
                    )
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(t.txtLabel)
                }
                Image(systemName: store.railOrganization == .byProject ? "folder" : "tray.full")
                    .font(.system(size: 10))
                    .foregroundStyle(t.txtLabel)
                Text(group.project)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(t.txtBody)
                    .lineLimit(1)
                Spacer()
                Text("\(group.sessions.count)")
                    .font(.system(size: 11))
                    .foregroundStyle(t.txtLabel)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .textCase(nil)
        .padding(.bottom, 4)
        .contextMenu {
            if store.railSort == .manual && store.railOrganization == .byProject {
                Button {
                    store.moveProject(group.projectId, direction: -1)
                } label: {
                    Label("Move project up", systemImage: "arrow.up")
                }
                Button {
                    store.moveProject(group.projectId, direction: 1)
                } label: {
                    Label("Move project down", systemImage: "arrow.down")
                }
            }
        }
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
        Button {
            store.setSessionPinned(
                session.sessionId,
                pinned: !store.pinnedSessionIds.contains(session.sessionId)
            )
        } label: {
            Label(
                store.pinnedSessionIds.contains(session.sessionId) ? "Unpin" : "Pin",
                systemImage: store.pinnedSessionIds.contains(session.sessionId)
                    ? "pin.slash"
                    : "pin"
            )
        }
        if store.railSort == .manual {
            Button {
                store.moveSession(session, direction: -1)
            } label: {
                Label("Move up", systemImage: "arrow.up")
            }
            Button {
                store.moveSession(session, direction: 1)
            } label: {
                Label("Move down", systemImage: "arrow.down")
            }
        }
        Divider()
        if let control = session.sessionControl {
            let presentation = control.t4Presentation
            Label(presentation.railLabel, systemImage: presentation.systemImage)
                .disabled(true)
            if session.t4CanRestore {
                Button {
                    Task { await store.restoreSession(sessionId: session.sessionId) }
                } label: {
                    Label("Restore", systemImage: "arrow.uturn.backward")
                }
                .disabled(!store.connected)
            }
            if presentation.canFork && store.canForkSessions {
                Button {
                    Task { await store.forkSession(sessionId: session.sessionId) }
                } label: {
                    Label("Continue in a Copy", systemImage: "doc.on.doc")
                }
            }
            if case .released = control {
                Button {
                    Task { await store.reclaimSession(sessionId: session.sessionId) }
                } label: {
                    Label("Bring Back to App", systemImage: "arrow.uturn.backward")
                }
            }
        } else if session.archivedAt == nil {
            Button {
                renameText = session.title
                renaming = session
            } label: {
                Label("Rename", systemImage: "pencil")
            }
            Button {
                Task { await store.archiveSession(sessionId: session.sessionId) }
            } label: {
                Label("Archive", systemImage: "archivebox")
            }
            .disabled(!store.connected)
            Divider()
            Button {
                Task { await store.compactSession(sessionId: session.sessionId) }
            } label: {
                Label("Compact", systemImage: "rectangle.compress.vertical")
            }
            Button {
                Task { await store.retrySession(sessionId: session.sessionId) }
            } label: {
                Label("Retry", systemImage: "arrow.clockwise")
            }
            Button {
                Task { await store.closeSession(sessionId: session.sessionId) }
            } label: {
                Label("Close", systemImage: "xmark.circle")
            }
            .disabled(session.status == "closed")
        } else {
            Button {
                Task { await store.restoreSession(sessionId: session.sessionId) }
            } label: {
                Label("Restore", systemImage: "arrow.uturn.backward")
            }
            .disabled(!store.connected)
        }
        Divider()
        Button(role: .destructive) {
            Task { await store.deleteSession(sessionId: session.sessionId) }
        } label: {
            Label("Delete", systemImage: "trash")
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

struct T4SessionRow: View {
    let session: SessionRef
    let theme: Theme
    /// True when durable entries arrived since this session was last selected
    /// — renders a leading accent dot. Driven by `store.unreadSessions`.
    var unread: Bool = false

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if unread {
                Circle()
                    .fill(theme.accent)
                    .frame(width: 8, height: 8)
                    .padding(.top, 7)
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text(session.title)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(theme.txt)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    if let control = session.sessionControl {
                        Text(control.t4Presentation.railLabel)
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(theme.cAdvisor)
                            .lineLimit(1)
                    } else {
                        StatusPill(status: session.status, theme: theme)
                    }
                }
                HStack(spacing: 10) {
                    if let model = session.model {
                        T4ModelLabel(selector: model, theme: theme)
                            .lineLimit(1)
                    }
                    if let usage = session.contextUsage {
                        ContextMeter(used: usage.used, limit: usage.limit, theme: theme)
                    }
                    Spacer(minLength: 0)
                }
                .lineLimit(1)
                .truncationMode(.tail)
                HStack(spacing: 6) {
                    if session.pendingApproval == true { Tag(text: "approval", color: theme.diffAdd, theme: theme) }
                    if session.pendingUserInput == true { Tag(text: "input", color: theme.cTask, theme: theme) }
                    Text(session.updatedAt).font(.system(size: 10)).foregroundStyle(theme.txtLabel)
                        .lineLimit(1)
                }
                .lineLimit(1)
                .truncationMode(.tail)
            }
        }
        .padding(.vertical, 3)
    }
}

struct StatusPill: View {
    let status: String
    let theme: Theme
    var body: some View {
        let (label, color) = Self.style(status)
        Text(label)
            .font(.system(size: 10, weight: .semibold))
            .textCase(.uppercase)
            .foregroundStyle(color)
    }
    static func style(_ status: String) -> (String, Color) {
        switch status {
        case "active": return ("active", Color.green)
        case "idle": return ("idle", Color.yellow)
        case "closed": return ("closed", Color.secondary)
        default: return (status, Color.secondary)
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
            Text("\(used)/\(limit)").font(.system(size: 10)).foregroundStyle(theme.txtLabel)
        }
    }
}

struct Tag: View {
    let text: String
    let color: Color
    let theme: Theme
    var body: some View {
        Text(text)
            .font(.system(size: 9, weight: .semibold))
            .textCase(.uppercase)
            .foregroundStyle(color)
    }
}
