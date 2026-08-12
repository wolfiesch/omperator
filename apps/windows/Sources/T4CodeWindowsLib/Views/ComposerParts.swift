//  ComposerParts.swift (Linux port of apps/ios/Sources/ComposerParts.swift)
//  Composer extras: the quiet, slowly-cycling hint strip that sits under the
//  draft when it's empty. Every tip names a real action in this app — no
//  fictional slash commands (T4 host-wire has no slash palette).
//
//  Linux deltas:
//  - macOS cycles tips on a `Timer.publish` + `.onReceive`; Linux uses a
//    `.task` loop (no onReceive in SwiftCrossUI).
//  - Tips are trimmed to actions that exist on Linux: dictation and photo
//    attachments are not ported (LINUX-GAP), so those tips are dropped.

import SwiftCrossUI

/// A quiet, slowly-cycling hint under the composer. Fades between tips.
struct ComposerTips: View {
    let t: Theme
    @State private var i = 0
    private let tips: [(icon: String, text: String)] = [
        ("■", "tap stop to interrupt a running turn"),
        ("☰", "use the model menu to pick a provider and thinking level"),
    ]

    var body: some View {
        let tip = tips[i % tips.count]
        HStack(spacing: 8) {
            Text(tip.icon)
                .font(.system(size: 12))
                .foregroundColor(t.txtGhost)
                .frame(width: 16)
            Text(tip.text)
                .font(.bodyF(12))
                .foregroundColor(t.txtMuted)
                .lineLimit(1)
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.top, 7)
        .padding(.bottom, 8)
        .overlay(alignment: .top) { Rectangle().fill(t.lineFaint).frame(height: 1) }
        .task {
            // LINUX-GAP: macOS cycles on a Combine timer; a task loop is the
            // SwiftCrossUI equivalent (cancelled when the view disappears).
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3.2))
                guard !Task.isCancelled else { return }
                i = (i + 1) % tips.count
            }
        }
    }
}
