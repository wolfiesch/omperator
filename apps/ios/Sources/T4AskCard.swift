//  T4AskCard.swift
//  Ask + plan-review surfaces ported from Enclave's TranscriptViews: a glass
//  panel with a labl header, radio option rows (recommended option wears an
//  etched chip), or a free-form editor with a SEND button. Plan asks render
//  as PLAN REVIEW with the checklist header and the plan body inset.

import SwiftUI
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
            Image(systemName: isPlan ? "checklist" : (isEditor ? "text.cursor" : "questionmark.bubble"))
                .font(.system(size: 14)).foregroundStyle(t.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text(isPlan ? "PLAN REVIEW" : (isEditor ? "INPUT REQUESTED" : "ASK"))
                    .font(.labl(9)).tracking(1.4).foregroundStyle(t.accent)
                if let question = ask.request.question, !question.isEmpty {
                    Text(question)
                        .font(.bodyF(13.5)).foregroundStyle(t.txt).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
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
        return Button {
            guard !sent else { return }
            picked = option.id
            sent = true
            onSubmit(option.id)
        } label: {
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: chosen ? "largecircle.fill" : "circle")
                    .font(.system(size: 13))
                    .foregroundStyle(chosen ? t.accent : t.txtGhost)
                    .frame(width: 15)
                Text(option.label)
                    .font(.bodyF(13))
                    .foregroundStyle(chosen ? t.accent : t.txtBody)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 11).padding(.vertical, 9)
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(chosen ? t.accentLine : t.line))
            .background(chosen ? t.glassFill2 : .clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(sent)
    }

    private var editor: some View {
        TextEditor(text: $text)
            .font(.bodyF(13.5)).foregroundStyle(t.txt)
            .scrollContentBackground(.hidden)
            .frame(minHeight: 84, maxHeight: 160)
            .padding(.horizontal, 11).padding(.vertical, 7)
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(t.line))
            .background(t.glassFill2)
    }

    private var actions: some View {
        Button {
            textSent = true
            onSubmit(text)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: textSent ? "checkmark" : "paperplane.fill")
                Text(textSent ? "SENT" : "SEND").font(.labl(10.5))
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity).padding(.vertical, 10)
        }
        .buttonStyle(.borderedProminent)
        .tint(t.accent)
        .disabled(textSent || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
}
