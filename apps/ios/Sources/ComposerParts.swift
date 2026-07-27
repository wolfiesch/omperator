//  ComposerParts.swift
//  Composer extras ported from Enclave: the quiet, slowly-cycling hint strip
//  that sits under the draft when it's empty. Every tip names a real action in
//  this app — no fictional slash commands (T4 host-wire has no slash palette).

import SwiftUI

/// A quiet, slowly-cycling hint under the composer. Fades between tips.
struct ComposerTips: View {
    let t: Theme
    @State private var i = 0
    private let tips: [(icon: String, text: String)] = [
        ("mic", "dictate instead of typing"),
        ("paperclip", "attach an image to your message"),
        ("stop.fill", "tap stop to interrupt a running turn"),
    ]
    private let timer = Timer.publish(every: 3.2, on: .main, in: .common).autoconnect()

    var body: some View {
        let tip = tips[i % tips.count]
        HStack(spacing: 8) {
            Image(systemName: tip.icon)
                .font(.system(size: 12))
                .foregroundStyle(t.txtGhost)
                .frame(width: 16)
            Text(tip.text)
                .font(.bodyF(12))
                .foregroundStyle(t.txtMuted)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .id(i)
        .transition(.opacity)
        .animation(.easeInOut(duration: 0.35), value: i)
        .padding(.horizontal, 10)
        .padding(.top, 7)
        .padding(.bottom, 8)
        .overlay(Rectangle().frame(height: 0.5).foregroundStyle(t.lineFaint), alignment: .top)
        .onReceive(timer) { _ in i = (i + 1) % tips.count }
    }
}
