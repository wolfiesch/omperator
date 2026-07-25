//  SessionsView.swift
//  The rooms you've joined. The collab protocol has no way to enumerate a host's
//  sessions, so this is the guest's own on-device list (AppModel.sessions): each
//  entry is a /collab link you've connected to. Tap to reconnect; Pair to add.

import SwiftUI
import UIKit

struct SessionsView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var app: AppModel
    @Binding var query: String
    private var t: Theme { theme.t }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                if app.sessions.isEmpty {
                    emptyState
                        .padding(.horizontal, 0)
                } else {
                    ForEach(liveSessions) { s in sessionRow(s) }
                    if !offlineSessions.isEmpty {
                        VStack(alignment: .leading, spacing: 0) {
                            HStack(spacing: 8) {
                                Text("OFFLINE").font(.labl(9)).tracking(2).foregroundStyle(t.txtMuted)
                                Rectangle().frame(height: 0.5).foregroundStyle(t.lineFaint)
                                Button { withAnimation { app.clearOffline() } } label: {
                                    Text("CLEAR ALL").font(.labl(9)).tracking(1).foregroundStyle(t.cAdvisor)
                                }
                            }
                            .padding(.horizontal, 16)
                            .padding(.top, 16).padding(.bottom, 8)
                            ForEach(offlineSessions) { s in sessionRow(s) }
                        }
                    }
                }
            }
        }
        .background(t.bg.ignoresSafeArea())
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - derived lists

    private var liveSessions: [JoinedSession] {
        app.sessions.filter {
            app.live[$0.id] == true && matchesQuery($0)
        }.sorted { $0.savedAt > $1.savedAt }
    }
    private var offlineSessions: [JoinedSession] {
        app.sessions.filter {
            app.live[$0.id] != true && matchesQuery($0)
        }.sorted { $0.savedAt > $1.savedAt }
    }
    private func matchesQuery(_ s: JoinedSession) -> Bool {
        query.isEmpty || s.title.localizedCaseInsensitiveContains(query) || s.relay.localizedCaseInsensitiveContains(query)
    }

    // MARK: - rows

    private func sessionRow(_ s: JoinedSession) -> some View {
        let cardOpacity: CGFloat = app.live[s.id] == true ? 1 : 0.6
        return JoinedCard(session: s, t: t, state: app.state[s.id] ?? SessionState())
            .opacity(cardOpacity)
            .frame(maxWidth: sessionCardMaxWidth)
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .onTapGesture { app.connect(link: s.link, name: UIDevice.current.name) }
            .contextMenu {
                ColorMenu(session: s, t: t)
                Button(role: .destructive) { app.remove(s) } label: { Label("Remove", systemImage: "trash") }
            } preview: {
                JoinedCard(session: s, t: t, state: app.state[s.id] ?? SessionState())
                    .frame(maxWidth: sessionCardMaxWidth)
                    .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
    }

    // MARK: - empty state

    private var emptyState: some View {
        VStack(spacing: 12) {
            LogoMark(t: t, size: 44, color: t.txtGhost)
            Text("NO SESSIONS YET").font(.labl(10)).tracking(2).foregroundStyle(t.txtMuted)
            (Text("Share a session from your coding agent — run ").foregroundStyle(t.txtMuted) + Text("omp /enclave").font(.term(15)).foregroundStyle(t.accent) + Text(" or ").foregroundStyle(t.txtMuted) + Text("omp /collab").font(.term(15)).foregroundStyle(t.accent) + Text(" on the box — then pair with the link.").foregroundStyle(t.txtMuted))
                .font(.bodyF(13.5)).multilineTextAlignment(.center)
            Spacer().frame(height: 16)
        }
        .padding(.horizontal, 24).padding(.vertical, 48)
    }
}

/// Color tag picker for a session card.
private struct ColorMenu: View {
    let session: JoinedSession
    let t: Theme
    @EnvironmentObject var app: AppModel

    var body: some View {
        Menu {
            ForEach(SessionColor.allCases) { color in
                Button { app.setTagColor(color, for: session.id) } label: {
                    HStack(spacing: 8) {
                        Circle().fill(color.color(in: t)).frame(width: 12, height: 12)
                        Text(label(for: color)).font(.bodyF(14))
                        Spacer()
                        if session.tagColor == color {
                            Image(systemName: "checkmark").font(.system(size: 12, weight: .semibold))
                        }
                    }
                }
            }
        } label: {
            Label("Color", systemImage: "paintpalette")
        }
    }

    private func label(for color: SessionColor) -> String {
        switch color {
        case .default: return "Default"
        case .accent: return "Accent"
        case .foam: return "Foam"
        case .iris: return "Iris"
        case .pine: return "Pine"
        case .rose: return "Rose"
        case .green: return "Green"
        }
    }
}

// MARK: - Joined card

struct JoinedCard: View {
    let session: JoinedSession
    let t: Theme
    let state: SessionState

    private var isLive: Bool { state.live }
    private var isPlanReview: Bool { state.mode == "plan" && !state.working && state.live }
    private var isReplying: Bool { state.live && state.working }
    private var statusText: String {
        if isPlanReview { return "PLAN REVIEW" }
        return isReplying ? "REPLYING" : (isLive ? "LIVE" : "OFFLINE")
    }
    private var statusColor: Color {
        if isPlanReview { return t.cAdvisor }
        return isReplying ? t.accent : (isLive ? t.cOk : t.txtGhost)
    }
    private var statusIcon: String {
        if isPlanReview { return "checklist" }
        return isReplying ? "circle.dashed" : (isLive ? "circle.fill" : "network.slash")
    }
    private var iconColor: Color { session.tagColor.color(in: t) }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            // 46pt Liquid Glass icon tile with etched Enclave logo + mode badge
            ZStack(alignment: .bottomTrailing) {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(.clear)
                    .frame(width: 46, height: 46)
                    .glassEffect(
                        .regular.tint(iconColor.opacity(0.30)).interactive(),
                        in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                    )
                    .overlay {
                        LogoMark(t: t, size: 24, color: iconColor)
                            .shadow(color: .black.opacity(t.mode == .dark ? 0.30 : 0.15), radius: 0.6, x: 0, y: 0.6)
                            .shadow(color: .white.opacity(t.mode == .dark ? 0.10 : 0.50), radius: 0.4, x: 0, y: -0.4)
                    }

                // read-only / control mode badge — ENLARGED
                Circle().fill(t.bg).frame(width: 18, height: 18)
                    .overlay(Circle().stroke(iconColor.opacity(0.60), lineWidth: 1))
                    .overlay(
                        Image(systemName: session.readOnly ? "eye" : "pen")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(iconColor)
                    )
                    .offset(x: 5, y: 5)
            }

            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text(session.title)
                        .font(.disp(17))
                        .foregroundStyle(t.txt)
                        .lineLimit(1)
                    Spacer()
                    Text(formatDate(session.savedAt))
                        .font(.term(12))
                        .foregroundStyle(t.txtGhost)
                }
                HStack(spacing: 6) {
                    Image(systemName: statusIcon).font(.system(size: 8)).foregroundStyle(statusColor)
                    Text(statusText).font(.term(12)).foregroundStyle(statusColor)
                    Text("·").font(.term(12)).foregroundStyle(t.txtGhost)
                    if let enh = session.enhanced {
                        Text(enh ? "ENCLAVE" : "COLLAB").font(.term(12)).foregroundStyle(t.txtMuted)
                        Text("·").font(.term(12)).foregroundStyle(t.txtGhost)
                    }
                    Text(session.relay).font(.term(12)).foregroundStyle(t.txtMuted)
                }
            }
        }
        .padding(13)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func formatDate(_ date: Date) -> String {
        let now = Date()
        let diff = now.timeIntervalSince(date)
        if diff < 60 { return "now" }
        if diff < 3600 { return "\(Int(diff / 60))m" }
        if diff < 86400 { return "\(Int(diff / 3600))h" }
        if diff < 604800 { return "\(Int(diff / 86400))d" }
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f.string(from: date)
    }
}

// MARK: - List row helper

extension View {
    func plainRow(
        top: CGFloat = 0,
        bottom: CGFloat = 0,
        leading: CGFloat = 16,
        trailing: CGFloat = 16
    ) -> some View {
        listRowSpacing(0)
            .listRowInsets(EdgeInsets(top: top, leading: leading, bottom: bottom, trailing: trailing))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }
}

// MARK: - Preview

#Preview {
    let t = Theme(.dark)
    return List {
        JoinedCard(
            session: JoinedSession(id: "wss://example.com/r/abc", link: "wss://example.com/r/abc", title: "Example", relay: "example.com", readOnly: false, savedAt: Date(), enhanced: true),
            t: t,
            state: SessionState()
        )
        .plainRow()
    }
    .listStyle(.plain)
    .background(t.bg)
}
