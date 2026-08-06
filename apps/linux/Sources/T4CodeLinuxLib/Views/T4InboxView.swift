//  T4InboxView.swift (Linux port of apps/ios/Sources/T4InboxView.swift)
//  Attention inbox — sessions needing the user, surfaced from the workspace
//  header bell. Lists `store.attentionSessions` (pending approval, awaiting
//  input, or a proposed plan ready for review), each with a StatusPill-style
//  plain-text status and a reason label. Tapping a row selects the session
//  and closes the sheet so the detail view takes over.
//
//  Linux port notes:
//  • SwiftUI List/toolbar → ScrollView + header row (StatusPill is shared
//    from T4SessionsView.swift, which this file's macOS original also relies
//    on at module scope).
//  • SF Symbols (bell.slash) → text glyph.

import Foundation
import SwiftCrossUI
import HostWire

struct T4InboxView: View {
    let store: T4SessionStore
    let theme: ThemeStore
    @Binding var isPresented: Bool

    private var t: Theme { theme.t }

    init(store: T4SessionStore, theme: ThemeStore, isPresented: Binding<Bool>) {
        self.store = store
        self.theme = theme
        self._isPresented = isPresented
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header (replaces the navigation toolbar + Done item).
            HStack(spacing: 10) {
                Text("Inbox")
                    .lineLimit(1)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(t.txt)
                Spacer()
                T4TextButton("Done") { isPresented = false }
                    .font(.system(size: 14, weight: .semibold))
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 14)

            Divider(t.line)

            if store.attentionSessions.isEmpty {
                Spacer()
                VStack(spacing: 10) {
                    // LINUX-GAP: bell.slash SF Symbol → "⍾" (bell) glyph
                    Text("⍾")
                        .font(.system(size: 28))
                        .foregroundColor(t.txtMuted)
                    Text("Nothing needs your attention")
                    .lineLimit(1)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(t.txt)
                    Text("Sessions waiting on approval, input, or a plan review will appear here.")
                        .font(.system(size: 12))
                        .foregroundColor(t.txtMuted)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }
                Spacer()
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(store.attentionSessions) { item in
                            row(item)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 4)
                                .onTapGesture {
                                    store.select(item.session)
                                    isPresented = false
                                }
                            Divider(t.lineFaint)
                        }
                    }
                    .padding(.vertical, 6)
                }
            }
        }
        // No intrinsic size here: the workspace slots the inbox as a
        // right-side panel with its own frame(width: 380). A leftover
        // sheet-era fixed size would center 460pt of content in a 380pt
        // slot and clip both edges.
        .background(t.bg)
    }

    /// One inbox row: title + status (plain text, StatusPill-style) on top,
    /// reason label + project + updated time below.
    private func row(_ item: T4SessionStore.AttentionSession) -> some View {
        let session = item.session
        let (statusLabel, statusColor) = StatusPill.style(session.status)
        return VStack(alignment: .leading, spacing: 6) {
            // LINUX-GAP: .firstTextBaseline alignment is unavailable
            HStack(alignment: .top, spacing: 8) {
                Text(session.title)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(t.txt)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(statusLabel.uppercased())
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(statusColor)
            }
            HStack(spacing: 8) {
                Text(item.reasonLabel.uppercased())
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(reasonColor(item.reason))
                Text(session.project.name ?? session.project.projectId)
                    .font(.system(size: 11))
                    .foregroundColor(t.txtMuted)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Text(session.updatedAt)
                    .font(.system(size: 10))
                    .foregroundColor(t.txtLabel)
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
