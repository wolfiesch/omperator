//  T4PlanStrip.swift (Linux port of apps/ios/Sources/T4PlanStrip.swift)
//  The live plan (OMP's todo tool): phases → tasks with status. A collapsed
//  pill above the composer showing progress + the current task; tap to slide
//  up the full tree. Ported from Enclave's PlanStrip, fed by
//  session.state.get todoPhases.
//
//  PlanTask/PlanPhase live in PlanModels.swift — shared with the Linux
//  store layer.
//
//  Linux deltas:
//  - The macOS header is a Button with a custom label; SwiftCrossUI Button
//    takes a String only, so the pill toggles via `.onTapGesture`.
//  - No animation system: `expanded` swaps content conditionally (the
//    `.animation`/`.clipped()`/`.scrollDisabled`/`.allowsHitTesting`/
//    `.opacity` chain is a LINUX-GAP; withAnimation is a no-op shim).
//  - SF Symbols → text glyphs; `.tracking` and `.strikethrough` don't exist
//    in SwiftCrossUI (LINUX-GAP).

import SwiftCrossUI

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
        VStack(spacing: 0) {
            HStack(spacing: 7) {
                Text("☑").font(.system(size: 12)).foregroundColor(t.accent)
                Text("PLAN").font(.labl(10)).foregroundColor(t.txt)
                Text("\(phasesDone)/\(phases.count)").font(.term(12)).foregroundColor(t.txtMuted)
                if let cur = currentTask {
                    Text("◐").font(.system(size: 9)).foregroundColor(t.accent)
                    Text(cur).font(.term(12)).foregroundColor(t.txtBody).lineLimit(1)
                } else {
                    Text("✔").font(.system(size: 9)).foregroundColor(t.cOk)
                    Text("complete").font(.term(12)).foregroundColor(t.cOk)
                }
                Spacer()
                Text(expanded ? "▼" : "▲")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(t.txtLabel)
            }
            .padding(.horizontal, 13).padding(.vertical, 10)
            .onTapGesture { withAnimation { expanded.toggle() } }
            if expanded {
                Rectangle().fill(t.lineFaint).frame(height: 1)
                ScrollView {
                    planBody
                        .padding(.horizontal, 13)
                        .padding(.top, 8)
                        .padding(.bottom, 12)
                }
                .frame(maxHeight: 260)
            }
        }
        .glass(t, 16, panel: true)
    }

    private var planBody: some View {
        VStack(alignment: .leading, spacing: 11) {
            ForEach(phases) { phase in
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 6) {
                        Text(phase.name.uppercased())
                            .font(.labl(9))
                            .foregroundColor(phase.doneCount == phase.tasks.count && !phase.tasks.isEmpty ? t.cOk : t.txtMuted)
                        Text("\(phase.doneCount)/\(phase.tasks.count)")
                            .font(.term(11)).foregroundColor(t.txtLabel)
                    }
                    ForEach(phase.tasks) { task in
                        HStack(alignment: .top, spacing: 7) {
                            Text(icon(for: task.status))
                                .font(.system(size: 9))
                                .foregroundColor(color(for: task.status))
                            // LINUX-GAP: macOS adds .strikethrough for
                            // completed tasks; SwiftCrossUI Text has none.
                            Text(task.content)
                                .font(.bodyF(12))
                                .foregroundColor(task.status == "completed" ? t.txtLabel : t.txtBody)
                        }
                    }
                }
            }
        }
    }

    private func icon(for status: String) -> String {
        switch status {
        case "completed": return "✔"
        case "in_progress": return "◐"
        default: return "○"
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
