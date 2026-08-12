//  T4AskCard.swift (Linux port of apps/ios/Sources/T4AskCard.swift)
//  Ask + plan-review surfaces ported from Enclave's TranscriptViews: a glass
//  panel with a label header, radio option rows (recommended option wears an
//  etched chip), or a free-form editor with a SEND button. Plan asks render
//  as PLAN REVIEW with the checklist header and the plan body inset.
//
//  Linux deltas:
//  - macOS `.glass(t, 16, active: true)` is approximated inline
//    (RoundedRectangle fill + border from the theme's glass tokens).
//  - Option rows are Buttons with custom labels on macOS; SwiftCrossUI
//    Button takes a String only, so rows toggle via `.onTapGesture` with the
//    same picked/sent state machine.
//  - SF Symbols → text glyphs; `.tracking` on the label is dropped
//    (LINUX-GAP).

import SwiftCrossUI
import HostWire

struct T4AskCard: View {
    let ask: T4SessionStore.PendingAsk
    let theme: Theme
    let onSubmit: (String) -> Void

    @State private var sent = false
    @State private var picked: String?
    @State private var text = ""
    @State private var textSent = false

    private var t: Theme { theme }
    private var isEditor: Bool { ask.request.options.isEmpty }
    private var isPlan: Bool {
        ask.request.question?.localizedCaseInsensitiveContains("plan") == true
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            if isEditor { editor } else { options }
            if isEditor { actions }
        }
        .padding(12)
        .glass(t, 16, active: true)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 7) {
            Text(isPlan ? "☑" : (isEditor ? "✎" : "?"))
                .font(.system(size: 14)).foregroundColor(t.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text(isPlan ? "PLAN REVIEW" : (isEditor ? "INPUT REQUESTED" : "ASK"))
                    .font(.labl(9)).foregroundColor(t.accent)
                if let question = ask.request.question, !question.isEmpty {
                    Text(question)
                        .font(.bodyF(13.5)).foregroundColor(t.txt).textSelectionEnabled()
                }
            }
        }
    }

    private var options: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(ask.request.options) { option in
                optionRow(option)
            }
        }
    }

    private func optionRow(_ option: AskOption) -> some View {
        let chosen = picked == option.id
        return HStack(alignment: .top, spacing: 9) {
            Text(chosen ? "◉" : "○")
                .font(.system(size: 13))
                .foregroundColor(chosen ? t.accent : t.txtGhost)
                .frame(width: 15)
            Text(option.label)
                .font(.bodyF(13))
                .foregroundColor(chosen ? t.accent : t.txtBody)
            Spacer()
        }
        .padding(.horizontal, 11).padding(.vertical, 9)
        .background {
            // Ring lives in the background — an overlay stroke would sit on
            // top of the tap gesture and eat the click.
            RoundedRectangle(cornerRadius: 14)
                .fill(chosen ? t.glassFill2 : Color.clear)
            RoundedRectangle(cornerRadius: 14)
                .stroke(chosen ? t.accentLine : t.line, style: StrokeStyle(width: 1))
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
            .font(.bodyF(13.5)).foregroundColor(t.txt)
            .frame(minHeight: 84, maxHeight: 160)
            .padding(.horizontal, 11).padding(.vertical, 7)
            .background {
                // Background ring, not an overlay: overlay strokes eat
                // entry focus/clicks.
                RoundedRectangle(cornerRadius: 14)
                    .fill(t.glassFill2)
                RoundedRectangle(cornerRadius: 14)
                    .stroke(t.line, style: StrokeStyle(width: 1))
            }
    }

    private var actions: some View {
        T4TextButton(textSent ? "✓ SENT" : "SEND") {
            textSent = true
            onSubmit(text)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background {
            RoundedRectangle(cornerRadius: 12)
                .fill(t.interactiveAccent)
        }
        .foregroundColor(t.bg)
        .disabled(textSent || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
}
