//  ComposerParts.swift
//  Shared chips + the cycling composer hint strip. (The slash palette lives with
//  the /enclave plugin, where commands can actually run; these tips only ever
//  point at things a guest can really do.)

import SwiftUI

/// A quiet, slowly-cycling hint under the composer. Every tip is a real action
/// the guest can take — no fictional slash commands.
struct ComposerTips: View {
    let t: Theme
    var hasCommands: Bool = false          // an /enclave plugin with slash commands
    var onSlash: () -> Void = {}           // open the slash palette
    @State private var i = 0
    private var tips: [(icon: String, text: String, slash: Bool)] {
        var out: [(String, String, Bool)] = []
        if hasCommands { out.append(("slash.circle", "tap the slash button to run a command", true)) }
        out += [
            ("mic", "dictate instead of typing", false),
            ("paperclip", "attach an image to your message", false),
            ("text.bubble", "type while it's running to steer the turn", false),
            ("questionmark.bubble", "answer the agent's asks right here", false),
            ("stop.fill", "tap stop to interrupt a running turn", false),
        ]
        return out
    }
    private let timer = Timer.publish(every: 3.2, on: .main, in: .common).autoconnect()

    var body: some View {
        let tip = tips[i % tips.count]
        HStack(spacing: 8) {
            Image(systemName: tip.icon).font(.system(size: 12)).foregroundStyle(tip.slash ? t.accent : t.txtGhost).frame(width: 15)
            Text(tip.text).font(.bodyF(12)).foregroundStyle(tip.slash ? t.accent : t.txtMuted).lineLimit(1)
            Spacer(minLength: 0)
        }
        .id(i)
        .transition(.opacity)
        .animation(.easeInOut(duration: 0.35), value: i)
        .padding(.horizontal, 10).padding(.top, 7).padding(.bottom, 8)
        .overlay(Rectangle().frame(height: 0.5).foregroundStyle(t.lineFaint), alignment: .top)
        .onReceive(timer) { _ in i = (i + 1) % tips.count }
    }
}

struct Chip: View {
    let t: Theme; let text: String; var on = false
    var body: some View {
        Text(text).font(.labl(10)).tracking(1)
            .foregroundStyle(on ? t.accent : t.txtMuted)
            .padding(.horizontal, 10).padding(.vertical, 4)
            .etched(t, tint: on ? t.accentDim : nil)
    }
}

/// Slash-command palette — populated from the /enclave plugin's real command
/// list. Tapping runs the command host-side; interactive ones come back as asks.
struct SlashPalette: View {
    let t: Theme
    let commands: [EnclaveCommand]
    var onPick: (String) -> Void
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("SLASH COMMANDS").font(.labl(9)).tracking(2).foregroundStyle(t.txtMuted)
                Spacer()
            }
            .padding(.horizontal, 13).padding(.vertical, 11)
            .overlay(Rectangle().frame(height: 0.5).foregroundStyle(t.lineFaint), alignment: .bottom)
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(commands) { cmd in
                        Button { onPick(cmd.name) } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                Text("/" + cmd.name).font(.term(15)).foregroundStyle(t.accent).frame(width: 96, alignment: .leading)
                                Text(cmd.summary).font(.bodyF(13)).foregroundStyle(t.txtBody).lineLimit(1)
                                Spacer()
                            }.padding(.horizontal, 12).padding(.vertical, 9)
                        }
                    }
                }.padding(6)
            }
            .frame(maxHeight: 300)
        }
        .glass(t, 16, panel: true)
    }
}
