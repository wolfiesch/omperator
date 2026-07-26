//  T4PlanStrip.swift
//  The live plan (OMP's todo tool): phases → tasks with status. A collapsed
//  pill above the composer showing progress + the current task; tap to slide
//  up the full tree. Ported from Enclave's PlanStrip, fed by session.state.get
//  todoPhases.

import SwiftUI

struct PlanTask: Identifiable, Equatable {
    let content: String
    let status: String   // pending / in_progress / completed
    var id: String { content }
}

struct PlanPhase: Identifiable, Equatable {
    let name: String
    let tasks: [PlanTask]
    var id: String { name }
    var doneCount: Int { tasks.filter { $0.status == "completed" }.count }
}

struct T4PlanStrip: View {
    let phases: [PlanPhase]
    let t: Theme
    @Binding var expanded: Bool

    private var phasesDone: Int { phases.filter { !$0.tasks.isEmpty && $0.doneCount == $0.tasks.count }.count }
    private var currentTask: String? {
        let all = phases.flatMap { $0.tasks }
        return all.first { $0.status == "in_progress" }?.content ?? all.first { $0.status == "pending" }?.content
    }

    var body: some View {
        // The pill is the anchor: it never moves. The plan panel lives in an
        // overlay pinned above it (no layout impact) and grows upward — so
        // expand/collapse is one clean unfold from the strip, no overshoot.
        pill
            .glass(t, 16, panel: true)
            .overlay(alignment: .bottom) {
                ScrollView { planBody.padding(.horizontal, 13).padding(.top, 12).padding(.bottom, 8) }
                    .scrollDisabled(!expanded)
                    .frame(maxHeight: expanded ? 260 : 0, alignment: .bottom)
                    .opacity(expanded ? 1 : 0)
                    .allowsHitTesting(expanded)
                    .accessibilityHidden(!expanded)
                    .background(t.panel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .stroke(t.glassBorder, lineWidth: 1)
                    )
                    .clipped()
                    .padding(.horizontal, 2)
                    .alignmentGuide(.bottom) { $0[.top] - 8 }
            }
            .animation(.easeInOut(duration: 0.22), value: expanded)
    }

    private var pill: some View {
        Button { expanded.toggle() } label: {
            HStack(spacing: 7) {
                Image(systemName: "checklist").font(.system(size: 12)).foregroundStyle(t.accent)
                Text("PLAN").font(.labl(10)).tracking(1.6).foregroundStyle(t.txt)
                Text("\(phasesDone)/\(phases.count)").font(.term(12)).foregroundStyle(t.txtMuted)
                if let cur = currentTask {
                    Image(systemName: "circle.lefthalf.filled").font(.system(size: 9)).foregroundStyle(t.accent)
                    Text(cur).font(.term(12)).foregroundStyle(t.txtBody).lineLimit(1)
                } else {
                    Image(systemName: "checkmark.circle.fill").font(.system(size: 9)).foregroundStyle(t.cOk)
                    Text("complete").font(.term(12)).foregroundStyle(t.cOk)
                }
                Spacer(minLength: 4)
                Image(systemName: expanded ? "chevron.down" : "chevron.up")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(t.txtLabel)
            }
            .padding(.horizontal, 13).padding(.vertical, 10)
        }
        .buttonStyle(.plain)
    }

    private var planBody: some View {
        VStack(alignment: .leading, spacing: 11) {
            ForEach(phases) { phase in
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 6) {
                        Text(phase.name.uppercased())
                            .font(.labl(9)).tracking(1.2)
                            .foregroundStyle(phase.doneCount == phase.tasks.count && !phase.tasks.isEmpty ? t.cOk : t.txtMuted)
                        Text("\(phase.doneCount)/\(phase.tasks.count)")
                            .font(.term(11)).foregroundStyle(t.txtLabel)
                    }
                    ForEach(phase.tasks) { task in
                        HStack(alignment: .firstTextBaseline, spacing: 7) {
                            Image(systemName: icon(for: task.status))
                                .font(.system(size: 9))
                                .foregroundStyle(color(for: task.status))
                            Text(task.content)
                                .font(.bodyF(12))
                                .foregroundStyle(task.status == "completed" ? t.txtLabel : t.txtBody)
                                .strikethrough(task.status == "completed")
                        }
                    }
                }
            }
        }
    }

    private func icon(for status: String) -> String {
        switch status {
        case "completed": return "checkmark.circle.fill"
        case "in_progress": return "circle.lefthalf.filled"
        default: return "circle"
        }
    }

    private func color(for status: String) -> Color {
        switch status {
        case "completed": return t.cOk
        case "in_progress": return t.accent
        default: return t.txtLabel
        }
    }
}
