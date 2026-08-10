import Foundation
import SwiftCrossUI
import HostWire

/// Dense Windows session rail matched to the desktop macOS reference.
/// Store behavior remains shared; only layout and presentation are Windows-owned.
struct T4WindowsSessionsView: View {
    let store: T4SessionStore
    let theme: ThemeStore
    var onSelect: (SessionRef) -> Void
    var onInbox: () -> Void

    @State private var collapsedProjectIds: Set<String> = []
    @State private var visibleLimitByGroupId: [String: Int] = [:]

    private let groupedPageSize = 7
    private let flatPageSize = 30
    private var p: WindowsCorePalette { WindowsCorePalette(theme.effective) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                filterControls
                attentionRow
                listToggle
                    .padding(.top, 7)
                    .padding(.bottom, 5)

                if store.connecting {
                    HStack(spacing: 6) {
                        ProgressView()
                        Text("Connecting\u{2026}")
                            .font(.system(size: 11))
                            .foregroundColor(p.textMuted)
                    }
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 7)
                }

                if let error = store.lastError {
                    Text(error)
                        .font(.system(size: 11))
                        .foregroundColor(p.danger)
                        .padding(.vertical, 5)
                }

                if !store.pinnedSessions.isEmpty {
                    compactHeader(title: "Pinned", count: store.pinnedSessions.count)
                    sessionRows(store.pinnedSessions, groupId: "__pinned__", pageSize: groupedPageSize)
                }

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
                        .font(.system(size: 12))
                        .foregroundColor(p.textMuted)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, 16)
                }
            }
            .padding(.horizontal, 7)
            .padding(.bottom, 10)
        }
        .onChange(of: store.groups.count) {
            if collapsedProjectIds.isEmpty && store.groups.count > 12 {
                collapsedProjectIds = Set(store.groups.dropFirst(5).map(\.projectId))
            }
        }
    }

    private var filterControls: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 3) {
                ForEach(Array(T4RailFilter.allCases.prefix(3)), id: \.rawValue) { filter in
                    filterButton(filter)
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: 3) {
                ForEach(Array(T4RailFilter.allCases.dropFirst(3)), id: \.rawValue) { filter in
                    filterButton(filter)
                }
                Spacer(minLength: 0)
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
                ._buttonWidth(25)
            }
        }
        .padding(.top, 3)
        .padding(.bottom, 4)
    }

    private func filterButton(_ filter: T4RailFilter) -> some View {
        let selected = store.railFilter == filter
        return Text(filter.label)
            .font(.system(size: 10, weight: selected ? .semibold : .regular))
            .foregroundColor(selected ? p.text : p.textMuted)
            .padding(.horizontal, 9)
            .frame(height: 27)
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: 7).fill(p.hover)
                }
            }
            .onTapGesture { store.setRailFilter(filter) }
    }

    private var attentionRow: some View {
        HStack(spacing: 7) {
            Text("▱")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(p.textMuted)
            Text("Attention")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(p.textBody)
            Spacer()
            Text("\(store.attentionSessions.count)")
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(p.textMuted)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background { RoundedRectangle(cornerRadius: 6).fill(p.hover) }
        }
        .padding(.horizontal, 7)
        .frame(height: 31)
        .onTapGesture(perform: onInbox)
    }

    private var listToggle: some View {
        HStack(spacing: 0) {
            listToggleButton(.current, label: "Current · \(store.currentSessionCount)")
            listToggleButton(.archived, label: "Archived · \(store.archivedSessionCount)")
        }
        .padding(2)
        .background {
            RoundedRectangle(cornerRadius: 8).fill(p.line)
            RoundedRectangle(cornerRadius: 8).fill(p.surfaceSubtle).padding(1)
        }
    }

    private func listToggleButton(_ view: T4SessionListView, label: String) -> some View {
        let selected = store.sessionListView == view
        return Text(label)
            .font(.system(size: 10, weight: selected ? .semibold : .regular))
            .foregroundColor(selected ? p.textBody : p.textMuted)
            .frame(maxWidth: .infinity, minHeight: 25)
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: 6).fill(p.hover)
                }
            }
            .onTapGesture { store.setSessionListView(view) }
    }

    @ViewBuilder
    private func sessionRows(_ sessions: [SessionRef], groupId: String, pageSize: Int) -> some View {
        let limit = visibleLimitByGroupId[groupId] ?? pageSize
        let visible = Array(sessions.prefix(limit))
        ForEach(visible, id: \.sessionId) { session in
            sessionRow(session)
        }
        if sessions.count > visible.count {
            HStack {
                Text("Show more")
                Spacer()
                Text("\(sessions.count - visible.count) remaining")
                    .foregroundColor(p.textFaint)
            }
            .font(.system(size: 10, weight: .semibold))
            .foregroundColor(p.accent)
            .padding(.horizontal, 7)
            .frame(height: 27)
            .onTapGesture { visibleLimitByGroupId[groupId] = limit + pageSize }
        }
    }

    private func sessionRow(_ session: SessionRef) -> some View {
        let selected = store.selectedSession?.sessionId == session.sessionId
        return HStack(spacing: 3) {
            VStack(alignment: .leading, spacing: 4) {
                Text(session.title)
                    .font(.system(size: 12, weight: selected ? .semibold : .medium))
                    .foregroundColor(p.text)
                    .lineLimit(1)
                HStack(spacing: 5) {
                    if let model = session.model {
                        Text(T4ModelLabel.labelString(model))
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundColor(p.textFaint)
                            .lineLimit(1)
                    }
                    Text(compactUpdatedAt(session.updatedAt))
                        .font(.system(size: 9))
                        .foregroundColor(p.textFaint)
                        .lineLimit(1)
                    Spacer(minLength: 2)
                    statusLabel(session)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 8)
            .padding(.vertical, 7)
            .onTapGesture { onSelect(session) }

            if store.pinnedSessionIds.contains(session.sessionId) {
                Text("•")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(p.accent)
            }

        }
        .frame(minHeight: 50)
        .background {
            if selected {
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 8).fill(p.rowSelected)
                    RoundedRectangle(cornerRadius: 1).fill(p.accent).frame(width: 2)
                }
            }
        }
    }

    private func statusLabel(_ session: SessionRef) -> some View {
        let presentation = statusPresentation(session)
        return HStack(spacing: 4) {
            Circle().fill(presentation.color).frame(width: 5, height: 5)
            Text(presentation.label)
                .font(.system(size: 9, weight: .semibold))
                .foregroundColor(presentation.color)
                .lineLimit(1)
        }
    }

    private func statusPresentation(_ session: SessionRef) -> (label: String, color: Color) {
        if session.pendingApproval == true { return ("Approval", p.warning) }
        if session.pendingUserInput == true { return ("Input", p.violet) }
        if let control = session.sessionControl {
            return (control.t4Presentation.railLabel, p.warning)
        }
        switch session.status.lowercased() {
        case "active": return ("Working", p.working)
        case "idle": return ("Idle", p.violet)
        case "closed": return ("Closed", p.textFaint)
        case "error", "failed": return ("Error", p.danger)
        default: return (session.status.capitalized, p.textMuted)
        }
    }

    private func compactHeader(title: String, count: Int) -> some View {
        HStack(spacing: 6) {
            Text("⌄")
                .font(.system(size: 9, weight: .bold))
                .foregroundColor(p.textFaint)
            Text(title)
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(p.textBody)
                .lineLimit(1)
            Spacer()
            Text("\(count)")
                .font(.system(size: 10))
                .foregroundColor(p.textFaint)
        }
        .padding(.horizontal, 6)
        .padding(.top, 6)
        .frame(minHeight: 27)
    }

    private func groupHeader(_ group: T4SessionStore.Group) -> some View {
        HStack(spacing: 5) {
            Text(collapsedProjectIds.contains(group.projectId) ? "›" : "⌄")
                .font(.system(size: 10, weight: .bold))
                .foregroundColor(p.textFaint)
                .frame(width: 10)
            Text(group.project)
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(p.textBody)
                .lineLimit(1)
            Spacer()
            Text("\(group.sessions.count)")
                .font(.system(size: 10))
                .foregroundColor(p.textFaint)
            Text("+ New")
                .font(.system(size: 10))
                .foregroundColor(p.textFaint)
                .onTapGesture {
                    Task {
                        if let created = await store.createSession(projectId: group.projectId) {
                            store.select(created)
                        }
                    }
                }
            if store.railSort == .manual && store.railOrganization == .byProject {
                Menu("⋯") {
                    T4TextButton("Move project up") { store.moveProject(group.projectId, direction: -1) }
                    T4TextButton("Move project down") { store.moveProject(group.projectId, direction: 1) }
                }
                ._buttonWidth(22)
            }
        }
        .padding(.horizontal, 6)
        .padding(.top, 7)
        .frame(minHeight: 28)
        .onTapGesture {
            guard store.railOrganization == .byProject else { return }
            if collapsedProjectIds.contains(group.projectId) {
                collapsedProjectIds.remove(group.projectId)
            } else {
                collapsedProjectIds.insert(group.projectId)
            }
        }
    }

    private func compactUpdatedAt(_ raw: String) -> String {
        if raw.contains("ago") || raw == "now" { return raw }
        guard let date = ISO8601DateFormatter().date(from: raw) else { return raw }
        let seconds = max(0, Int(Date().timeIntervalSince(date)))
        if seconds < 60 { return "now" }
        if seconds < 3_600 { return "\(seconds / 60)m ago" }
        if seconds < 86_400 { return "\(seconds / 3_600)h ago" }
        return "\(seconds / 86_400)d ago"
    }

    private var emptyMessage: String {
        if !store.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.railFilter != .all {
            return "No matches"
        }
        return store.sessionListView == .current
            ? "No current sessions on this host"
            : "No archived sessions on this host"
    }

}
