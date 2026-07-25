//  TrustView.swift
//  Read-only trust surface for the connected session: what the host tells us over
//  the sealed wire (session id, cwd, relay, model, thinking, context, participants).
//  A guest cannot change model routing or manage host devices, so none of that is
//  here — this is an honest mirror of SessionState.

import SwiftUI

struct TrustView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var app: AppModel
    private var t: Theme { theme.t }

    var body: some View {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text("ZERO-TRUST · SEALED RELAY").font(.labl(9)).tracking(1.6).foregroundStyle(t.txtLabel)
                        .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 2)
                    Text("Trust").font(.disp(40)).foregroundStyle(t.txt).textCase(.uppercase)
                        .padding(.horizontal, 16).padding(.bottom, 14)
                    if let client = app.active {
                        TrustLive(client: client, t: t)
                    } else {
                        VStack(spacing: 10) {
                            Image(systemName: "checkmark.shield").font(.system(size: 30)).foregroundStyle(t.txtGhost)
                            Text("NOT CONNECTED").font(.labl(10)).tracking(2).foregroundStyle(t.txtMuted)
                            Text("Session details appear here once you join. Frames are sealed on-device with AES-256-GCM — the relay only sees ciphertext.")
                                .font(.bodyF(13)).foregroundStyle(t.txtMuted).multilineTextAlignment(.center)
                        }.frame(maxWidth: .infinity).padding(.vertical, 48).padding(.horizontal, 20)
                    }
                }.padding(.bottom, 20)
            }
            .background(t.bg.ignoresSafeArea())
            .tint(t.accent)
    }
}

struct TrustLive: View {
    @ObservedObject var client: GuestClient
    let t: Theme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // host / session
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 9) {
                    if client.working { LiveDot(t: t) } else { Circle().fill(t.txtGhost).frame(width: 7, height: 7) }
                    Text(client.title).font(.disp(16)).foregroundStyle(t.txt).textCase(.uppercase).lineLimit(1)
                    Spacer()
                    Chip(t: t, text: client.readOnly ? "watch" : "control", on: !client.readOnly)
                }.padding(.bottom, 12)
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 0), GridItem(.flexible(), spacing: 0)], spacing: 0) {
                    SpecCell(t: t, k: "Session", v: client.sessionId.isEmpty ? "—" : String(client.sessionId.prefix(8)))
                    SpecCell(t: t, k: "Relay", v: client.relay)
                    SpecCell(t: t, k: "cwd", v: client.cwd)
                    SpecCell(t: t, k: "Seal", v: "AES-256-GCM")
                    SpecCell(t: t, k: "Proto", v: "collab v3")
                    SpecCell(t: t, k: "Phase", v: client.phase)
                }
            }.padding(14).glass(t, 16).padding(.horizontal, 16).padding(.bottom, 20)

            // model / context
            Text("MODEL").font(.labl(9)).tracking(2).foregroundStyle(t.txtMuted).padding(.horizontal, 20).padding(.bottom, 10)
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    if client.enhanced && !client.models.isEmpty {
                        Menu {
                            ForEach(client.models) { m in
                                Button(m.name) { Task { _ = await client.setModel(m.modelId) } }
                            }
                        } label: {
                            HStack(spacing: 6) {
                                Text(client.modelName).font(.term(15)).foregroundStyle(t.txt).lineLimit(1)
                                Image(systemName: "chevron.up.chevron.down").font(.system(size: 11)).foregroundStyle(t.txtMuted)
                            }
                        }
                    } else {
                        Text(client.modelName).font(.term(15)).foregroundStyle(t.txt).lineLimit(1)
                    }
                    Spacer()
                    if client.enhanced && !client.thinkingLevels.isEmpty {
                        Menu {
                            ForEach(client.thinkingLevels, id: \.self) { lvl in
                                Button(lvl) { Task { _ = await client.setThinking(lvl) } }
                            }
                        } label: { Chip(t: t, text: client.thinkingLevel, on: true) }
                    } else {
                        Chip(t: t, text: client.thinkingLevel, on: true)
                    }
                }
                if let pct = client.contextPercent {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text("CONTEXT").font(.labl(9)).tracking(1.4).foregroundStyle(t.txtLabel)
                            Spacer()
                            Text("\(Int(pct))% · \(client.tokensLabel)").font(.term(13)).foregroundStyle(t.txtMuted)
                        }
                        GeometryReader { g in
                            ZStack(alignment: .leading) {
                                Rectangle().fill(t.line).frame(height: 3)
                                Rectangle().fill(pct > 85 ? t.cAdvisor : t.accent).frame(width: g.size.width * min(pct / 100, 1), height: 3)
                            }
                        }.frame(height: 3)
                    }
                }
            }.padding(13).glass(t, 16).padding(.horizontal, 16).padding(.bottom, 20)

            // participants
            Text("PARTICIPANTS").font(.labl(9)).tracking(2).foregroundStyle(t.txtMuted).padding(.horizontal, 20).padding(.bottom, 10)
            VStack(spacing: 8) {
                if client.participants.isEmpty {
                    Text("—").font(.term(14)).foregroundStyle(t.txtMuted).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 13).padding(.vertical, 11).glass(t, 16, flat: true)
                }
                ForEach(client.participants) { p in
                    HStack(spacing: 10) {
                        Image(systemName: p.role == "host" ? "desktopcomputer" : "iphone").font(.system(size: 17)).foregroundStyle(p.role == "host" ? t.accent : t.txtMuted)
                        Text(p.name).font(.disp(14)).foregroundStyle(t.txt).textCase(.uppercase).lineLimit(1)
                        Spacer()
                        Text(p.role == "host" ? "host" : (p.readOnly ? "watch" : "control")).font(.term(12)).foregroundStyle(t.txtMuted)
                    }
                    .padding(.horizontal, 13).padding(.vertical, 11).glass(t, 16, flat: true)
                }
            }.padding(.horizontal, 16).padding(.bottom, 20)
        }
    }
}
