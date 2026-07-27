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

    var body: some View {
        List {
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
            ForEach(store.groups) { group in
                Section {
                    ForEach(group.sessions, id: \.sessionId) { session in
                        Button { onSelect(session) } label: {
                            T4SessionRow(session: session, theme: t)
                        }
                        .buttonStyle(.plain)
                        .listRowBackground(Color.clear)
                        .listRowSeparatorTint(t.lineFaint)
                        .contextMenu { rowContextMenu(for: session) }
                    }
                } header: {
                    HStack(spacing: 6) {
                        Image(systemName: "folder").font(.system(size: 10)).foregroundStyle(t.txtLabel)
                        Text(group.project).font(.system(size: 12, weight: .semibold)).foregroundStyle(t.txtBody)
                        Spacer()
                        Text("\(group.sessions.count)").font(.system(size: 11)).foregroundStyle(t.txtLabel)
                    }
                    .textCase(nil)
                    .padding(.bottom, 4)
                }
            }
            if store.groups.isEmpty {
                Text(store.query.isEmpty ? "No sessions on this host" : "No matches")
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

    @ViewBuilder
    private func rowContextMenu(for session: SessionRef) -> some View {
        Button {
            renameText = session.title
            renaming = session
        } label: {
            Label("Rename", systemImage: "pencil")
        }
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
            Task { await store.forkSession(sessionId: session.sessionId) }
        } label: {
            Label("Fork", systemImage: "arrow.triangle.branch")
        }
        Button {
            Task { await store.closeSession(sessionId: session.sessionId) }
        } label: {
            Label("Close", systemImage: "xmark.circle")
        }
        .disabled(session.status == "closed")
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

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(session.title)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(theme.txt)
                    .lineLimit(1)
                Spacer(minLength: 8)
                StatusPill(status: session.status, theme: theme)
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
