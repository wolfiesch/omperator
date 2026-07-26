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
        // One glass object: the plan unfolds INSIDE the card above the pill,
        // height-animated, clipped by the card. No GlassEffectContainer (its
        // shape morph was the jump), nothing floating.
        VStack(spacing: 0) {
            ScrollView { planBody.padding(.horizontal, 13).padding(.top, 12).padding(.bottom, 8) }
                .scrollDisabled(!expanded)
                .frame(maxHeight: expanded ? 260 : 0)
                .opacity(expanded ? 1 : 0)
                .allowsHitTesting(expanded)
                .accessibilityHidden(!expanded)
            if expanded {
                Rectangle().frame(height: 0.5).foregroundStyle(t.lineFaint)
            }
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
        .glass(t, 16, panel: true)
        .clipped()
        .animation(.easeInOut(duration: 0.22), value: expanded)
    }
}
