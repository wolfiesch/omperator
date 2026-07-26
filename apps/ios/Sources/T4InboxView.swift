//  T4InboxView.swift
//  Attention inbox — sessions needing the user, surfaced from the workspace
//  toolbar bell. Lists `store.attentionSessions` (pending approval, awaiting
//  input, or a proposed plan ready for review), each with a StatusPill-style
//  plain-text status and a reason label. Tapping a row selects the session
//  and closes the sheet so the detail view takes over.

import SwiftUI
import HostWire

struct T4InboxView: View {
    @ObservedObject var store: T4SessionStore
    @EnvironmentObject var theme: ThemeStore
    @Binding var isPresented: Bool

    private var t: Theme { theme.t }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if store.attentionSessions.isEmpty {
                    Spacer()
                    VStack(spacing: 10) {
                        Image(systemName: "bell.slash")
                            .font(.system(size: 28))
                            .foregroundStyle(t.txtMuted)
                        Text("Nothing needs your attention")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(t.txt)
                        Text("Sessions waiting on approval, input, or a plan review will appear here.")
                            .font(.system(size: 12))
                            .foregroundStyle(t.txtMuted)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                    }
                    Spacer()
                } else {
                    List {
                        ForEach(store.attentionSessions) { item in
                            Button {
                                store.select(item.session)
                                isPresented = false
                            } label: {
                                row(item)
                            }
                            .buttonStyle(.plain)
                            .listRowBackground(Color.clear)
                            .listRowSeparatorTint(t.lineFaint)
                        }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                }
            }
            .background(t.bg.ignoresSafeArea())
            .navigationTitle("Inbox")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { isPresented = false }
                        .font(.system(size: 14, weight: .semibold))
                }
            }
        }
    }

    /// One inbox row: title + status (plain text, StatusPill-style) on top,
    /// reason label + project + updated time below.
    private func row(_ item: T4SessionStore.AttentionSession) -> some View {
        let session = item.session
        let (statusLabel, statusColor) = StatusPill.style(session.status)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(session.title)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(t.txt)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(statusLabel)
                    .font(.system(size: 10, weight: .semibold))
                    .textCase(.uppercase)
                    .foregroundStyle(statusColor)
            }
            HStack(spacing: 8) {
                Text(item.reasonLabel)
                    .font(.system(size: 10, weight: .semibold))
                    .textCase(.uppercase)
                    .foregroundStyle(reasonColor(item.reason))
                Text(session.project.name ?? session.project.projectId)
                    .font(.system(size: 11))
                    .foregroundStyle(t.txtMuted)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Text(session.updatedAt)
                    .font(.system(size: 10))
                    .foregroundStyle(t.txtLabel)
            }
        }
        .padding(.vertical, 3)
    }

    private func reasonColor(_ reason: T4SessionStore.AttentionSession.Reason) -> Color {
        switch reason {
        case .approval: return t.diffAdd
        case .input:    return t.cTask
        case .plan:     return t.accent
        }
    }
}
