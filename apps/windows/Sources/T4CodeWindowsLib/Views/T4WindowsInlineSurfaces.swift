import Foundation
import SwiftCrossUI
import HostWire

struct T4WindowsPlanStrip: View {
    let phases: [PlanPhase]
    let palette: WindowsCorePalette
    @Binding var expanded: Bool

    private var phasesDone: Int {
        phases.filter { !$0.tasks.isEmpty && $0.doneCount == $0.tasks.count }.count
    }

    private var currentTask: String? {
        let tasks = phases.flatMap(\.tasks)
        return tasks.first { $0.status == "in_progress" }?.content
            ?? tasks.first { $0.status == "pending" }?.content
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 7) {
                Text("✓")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(palette.accent)
                Text("PLAN")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(palette.textBody)
                Text("\(phasesDone)/\(phases.count)")
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundColor(palette.textFaint)
                if let currentTask {
                    Circle().fill(palette.warning).frame(width: 5, height: 5)
                    Text(currentTask)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(palette.textMuted)
                        .lineLimit(1)
                } else {
                    Text("Complete")
                        .font(.system(size: 10))
                        .foregroundColor(palette.success)
                }
                Spacer()
                Text(expanded ? "⌄" : "⌃")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(palette.textFaint)
            }
            .padding(.horizontal, 11)
            .frame(height: 34)
            .onTapGesture { expanded.toggle() }

            if expanded {
                Rectangle().fill(palette.line).frame(height: 1)
                ScrollView {
                    VStack(alignment: .leading, spacing: 9) {
                        ForEach(phases) { phase in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(spacing: 6) {
                                    Text(phase.name.uppercased())
                                        .font(.system(size: 9, weight: .bold))
                                        .foregroundColor(
                                            phase.doneCount == phase.tasks.count && !phase.tasks.isEmpty
                                                ? palette.success
                                                : palette.textMuted
                                        )
                                    Text("\(phase.doneCount)/\(phase.tasks.count)")
                                        .font(.system(size: 9, design: .monospaced))
                                        .foregroundColor(palette.textFaint)
                                }
                                ForEach(phase.tasks) { task in
                                    HStack(alignment: .top, spacing: 7) {
                                        Text(icon(for: task.status))
                                            .font(.system(size: 9, weight: .semibold))
                                            .foregroundColor(color(for: task.status))
                                        Text(task.content)
                                            .font(.system(size: 10))
                                            .foregroundColor(
                                                task.status == "completed" ? palette.textFaint : palette.textBody
                                            )
                                    }
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 11)
                    .padding(.vertical, 9)
                }
                .frame(height: 150)
            }
        }
        .background {
            RoundedRectangle(cornerRadius: 10).fill(palette.surface)
            RoundedRectangle(cornerRadius: 10)
                .stroke(palette.line, style: StrokeStyle(width: 1))
        }
    }

    private func icon(for status: String) -> String {
        switch status {
        case "completed": return "✓"
        case "in_progress": return "•"
        default: return "○"
        }
    }

    private func color(for status: String) -> Color {
        switch status {
        case "completed": return palette.success
        case "in_progress": return palette.accent
        default: return palette.textFaint
        }
    }
}

struct T4WindowsAskCard: View {
    let ask: T4SessionStore.PendingAsk
    let palette: WindowsCorePalette
    let onSubmit: (String) -> Void

    @State private var sent = false
    @State private var picked: String?
    @State private var text = ""
    @State private var textSent = false

    private var isEditor: Bool { ask.request.options.isEmpty }
    private var isPlan: Bool {
        ask.request.question?.localizedCaseInsensitiveContains("plan") == true
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 7) {
                Text(isPlan ? "✓" : (isEditor ? ">" : "?"))
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(palette.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text(isPlan ? "PLAN REVIEW" : (isEditor ? "INPUT REQUESTED" : "ASK"))
                        .font(.system(size: 9, weight: .bold))
                        .foregroundColor(palette.accent)
                    if let question = ask.request.question, !question.isEmpty {
                        Text(question)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(palette.text)
                            .textSelectionEnabled()
                    }
                }
            }

            if isEditor {
                editor
                editorAction
            } else {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(ask.request.options) { option in
                        optionRow(option)
                    }
                }
            }
        }
        .padding(11)
        .background {
            RoundedRectangle(cornerRadius: 11).fill(palette.surface)
            RoundedRectangle(cornerRadius: 11)
                .stroke(palette.accentMuted, style: StrokeStyle(width: 1))
        }
    }

    private func optionRow(_ option: AskOption) -> some View {
        let chosen = picked == option.id
        return HStack(spacing: 8) {
            Text(chosen ? "●" : "○")
                .font(.system(size: 9))
                .foregroundColor(chosen ? palette.accent : palette.textFaint)
            Text(option.label)
                .font(.system(size: 11))
                .foregroundColor(chosen ? palette.text : palette.textBody)
            Spacer()
        }
        .padding(.horizontal, 9)
        .frame(minHeight: 29)
        .background {
            RoundedRectangle(cornerRadius: 7)
                .fill(chosen ? palette.hover : palette.surfaceSubtle)
            RoundedRectangle(cornerRadius: 7)
                .stroke(chosen ? palette.accentMuted : palette.line, style: StrokeStyle(width: 1))
        }
        .onTapGesture {
            guard !sent else { return }
            picked = option.id
            sent = true
            onSubmit(option.id)
        }
    }

    private var editor: some View {
        TextEditor(text: $text)
            .font(.system(size: 11))
            .foregroundColor(palette.text)
            .frame(minHeight: 60, maxHeight: 110)
            .padding(.horizontal, 9)
            .padding(.vertical, 6)
            .background {
                RoundedRectangle(cornerRadius: 8).fill(palette.surfaceSubtle)
                RoundedRectangle(cornerRadius: 8)
                    .stroke(palette.line, style: StrokeStyle(width: 1))
            }
    }

    private var editorAction: some View {
        T4TextButton(textSent ? "SENT" : "SEND") {
            textSent = true
            onSubmit(text)
        }
        .font(.system(size: 10, weight: .bold))
        .frame(maxWidth: .infinity)
        .padding(.vertical, 7)
        .background { RoundedRectangle(cornerRadius: 8).fill(palette.accent) }
        .foregroundColor(palette.text)
        .disabled(textSent || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
}
