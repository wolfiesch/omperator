//  T4AgentsPane.swift (Linux port of apps/ios/Sources/T4AgentsPane.swift)
//  Subagent list for one session, fed by the .agent snapshot and agent.*
//  additive frames (Agents.swift types) rolled into `store.agents(for:)`.
//  A sheet listing each subagent with its lifecycle state, a progress bar
//  (when the host reports 0..1 progress), and a one-line detail extract.
//  Entered from the session detail ellipsis menu.
//
//  Linux port notes (per the shared porting contract):
//   • @ObservedObject store/agentModel + @EnvironmentObject theme → plain
//     `let` properties passed via init (store observation is bridged by
//     T4UIObservation; the root re-renders the whole subtree on changes).
//   • NavigationStack/toolbar → plain header (LINUX-GAP).
//   • SF Symbol icons → text glyphs; .textCase(.uppercase) → uppercased().

import SwiftCrossUI
import HostWire

struct T4AgentsPane: View {
    let session: SessionRef
    let store: T4SessionStore
    let theme: ThemeStore
    @Binding var isPresented: Bool
    let agentModel: T4AgentInventoryModel
    @State private var selection: String?

    init(session: SessionRef, store: T4SessionStore, theme: ThemeStore, isPresented: Binding<Bool>) {
        self.session = session
        self.store = store
        self.theme = theme
        self.agentModel = store.agentModel
        self._isPresented = isPresented
    }

    private var t: Theme { theme.t }
    private var agents: [T4SessionStore.AgentState] {
        if store.connected {
            return agentModel.agentsBySession[session.sessionId] ?? []
        }
        return store.agents(for: session.sessionId)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider(t.line)
            if agents.isEmpty {
                emptyState
            } else {
                List(agents, selection: $selection) { agent in
                    row(agent)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(t.bg)
    }

    /// Title + trailing Done (macOS navigationTitle + toolbar; the agents
    /// pane has no refresh button).
    private var header: some View {
        HStack(spacing: 8) {
            Spacer()
            Text("Agents")
                    .lineLimit(1)
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(t.txt)
            Spacer()
            T4TextButton("Done") { isPresented = false }
                .font(.system(size: 14, weight: .semibold))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            // LINUX-GAP: Image(systemName: "person.3.sequence") — text glyph.
            Text("☰")
                .font(.system(size: 28))
                .foregroundColor(t.txtMuted)
            Text("No subagents")
                    .lineLimit(1)
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(t.txt)
            Text("Subagents spawned by this session will appear here.")
                .font(.system(size: 12))
                .foregroundColor(t.txtMuted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// One agent row: id + lifecycle state (plain text, colored by state) on
    /// top, a progress bar when progress is known, and a one-line detail.
    private func row(_ agent: T4SessionStore.AgentState) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            // LINUX-GAP: .firstTextBaseline alignment doesn't exist — .top.
            HStack(alignment: .top) {
                // LINUX-GAP: Image(systemName: stateIcon(agent.state)) —
                // text glyph.
                Text(stateIcon(agent.state))
                    .font(.system(size: 13))
                    .foregroundColor(stateColor(agent.state))
                    .frame(width: 18)
                Text(agent.agentId)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(t.txt)
                    .lineLimit(1)
                Spacer(minLength: 8)
                // LINUX-GAP: .textCase(.uppercase) — manual uppercasing.
                Text(agent.state.uppercased())
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(stateColor(agent.state))
            }
            if let progress = agent.progress {
                ProgressBar(value: progress, tint: stateColor(agent.state), track: t.lineFaint)
            }
            if let detail = agent.detail, !detail.isEmpty {
                Text(detail)
                    .font(.system(size: 12))
                    .foregroundColor(t.txtBody)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 4)
    }

    /// Text glyph stand-ins for the macOS SF Symbol lifecycle icons.
    private func stateIcon(_ state: String) -> String {
        switch state {
        case "running", "started":          return "⚡"
        case "completed":                   return "✓"
        case "failed":                      return "✕"
        case "cancelled":                   return "–"
        case "created", "idle":             return "○"
        default:                            return "◉"
        }
    }

    /// Color for a lifecycle state — running uses the task accent, completed
    /// the ok/diff-add green, failed the advisor rose, others muted.
    private func stateColor(_ state: String) -> Color {
        switch state {
        case "running", "started":          return t.cTask
        case "completed":                   return t.diffAdd
        case "failed":                      return t.cAdvisor
        case "cancelled":                   return t.txtMuted
        case "created", "idle":             return t.txtMuted
        default:                            return t.txtMuted
        }
    }
}

/// Slim 0..1 progress bar (capsule track + filled capsule).
private struct ProgressBar: View {
    let value: Double
    let tint: Color
    let track: Color

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(track)
                Capsule().fill(tint.opacity(0.85))
                    .frame(width: geo.size.width * min(1, max(0, value)))
            }
        }
        .frame(height: 4)
    }
}
