//  T4AgentsPane.swift
//  Subagent list for one session, fed by the .agent snapshot and agent.*
//  additive frames (Agents.swift types) rolled into `store.agents(for:)`.
//  A sheet listing each subagent with its lifecycle state, a progress bar
//  (when the host reports 0..1 progress), and a one-line detail extract.
//  Entered from the session detail ellipsis menu.

import SwiftUI
import HostWire

struct T4AgentsPane: View {
    let session: SessionRef
    @ObservedObject var store: T4SessionStore
    @EnvironmentObject var theme: ThemeStore
    @Binding var isPresented: Bool

    private var t: Theme { theme.t }
    private var agents: [T4SessionStore.AgentState] { store.agents(for: session.sessionId) }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if agents.isEmpty {
                    Spacer()
                    VStack(spacing: 10) {
                        Image(systemName: "person.3.sequence")
                            .font(.system(size: 28))
                            .foregroundStyle(t.txtMuted)
                        Text("No subagents")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(t.txt)
                        Text("Subagents spawned by this session will appear here.")
                            .font(.system(size: 12))
                            .foregroundStyle(t.txtMuted)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                    }
                    Spacer()
                } else {
                    List {
                        ForEach(agents) { agent in
                            row(agent)
                        }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                }
            }
            .background(t.bg.ignoresSafeArea())
            .navigationTitle("Agents")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { isPresented = false }
                        .font(.system(size: 14, weight: .semibold))
                }
            }
        }
    }

    /// One agent row: id + lifecycle state (plain text, colored by state) on
    /// top, a progress bar when progress is known, and a one-line detail.
    private func row(_ agent: T4SessionStore.AgentState) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Image(systemName: stateIcon(agent.state))
                    .font(.system(size: 13))
                    .foregroundStyle(stateColor(agent.state))
                    .frame(width: 18)
                Text(agent.agentId)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(t.txt)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(agent.state)
                    .font(.system(size: 10, weight: .semibold))
                    .textCase(.uppercase)
                    .foregroundStyle(stateColor(agent.state))
            }
            if let progress = agent.progress {
                ProgressBar(value: progress, tint: stateColor(agent.state), track: t.lineFaint)
            }
            if let detail = agent.detail, !detail.isEmpty {
                Text(detail)
                    .font(.system(size: 12))
                    .foregroundStyle(t.txtBody)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 4)
    }

    /// SF Symbol for a lifecycle state.
    private func stateIcon(_ state: String) -> String {
        switch state {
        case "running", "started":          return "bolt.fill"
        case "completed":                   return "checkmark.circle.fill"
        case "failed":                      return "xmark.octagon.fill"
        case "cancelled":                   return "minus.circle.fill"
        case "created", "idle":             return "circle.dashed"
        default:                            return "person.fill"
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
