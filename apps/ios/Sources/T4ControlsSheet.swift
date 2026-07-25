//  T4ControlsSheet.swift
//  Per-session controls: model picker (provider-labeled, catalog-fed),
//  thinking level, and fast mode — the three session controls the host-wire
//  actually exposes (session.model.set / session.thinking.set /
//  session.fast.set). No working-mode picker: the wire has no such command.

import SwiftUI
import HostWire

struct T4ControlsSheet: View {
    let session: SessionRef
    @ObservedObject var store: T4SessionStore
    @EnvironmentObject var theme: ThemeStore
    @Environment(\.dismiss) private var dismiss
    private var t: Theme { theme.t }

    private static let thinkingLevels = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]

    struct ProviderGroup: Identifiable {
        let provider: String
        let models: [CatalogItem]
        var id: String { provider }
    }

    /// Catalog models grouped by provider prefix, providers sorted A–Z.
    private var providers: [ProviderGroup] {
        var byProvider: [String: [CatalogItem]] = [:]
        for item in store.catalogModels {
            let provider = splitModelSelector(item.id).provider ?? "other"
            byProvider[provider, default: []].append(item)
        }
        return byProvider.keys.sorted().map { key in
            ProviderGroup(provider: key, models: byProvider[key] ?? [])
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(providers) { group in
                        Section {
                            ForEach(group.models, id: \.id) { item in
                                Button {
                                    Task { await store.setModel(sessionId: session.sessionId, selector: item.id) }
                                    dismiss()
                                } label: {
                                    HStack(spacing: 10) {
                                        T4ModelLabel(selector: item.id, theme: t, size: 13)
                                        Spacer()
                                        if item.id == session.model {
                                            Image(systemName: "checkmark")
                                                .font(.system(size: 13, weight: .bold))
                                                .foregroundStyle(t.accent)
                                        }
                                    }
                                }
                                .foregroundStyle(t.txt)
                            }
                        } header: {
                            Text(group.provider.uppercased())
                                .font(.system(size: 11, weight: .bold))
                                .tracking(1)
                                .foregroundStyle(t.accent)
                                .textCase(nil)
                        }
                    }
                    if store.catalogModels.isEmpty {
                        Text("No models in the host catalog")
                            .foregroundStyle(t.txtMuted)
                    }
                } header: {
                    Text("Model").textCase(nil)
                } footer: {
                    Text("The PROVIDER chip is the authority — it decides where your prompts go.")
                        .font(.system(size: 11))
                }

                Section("Thinking") {
                    ForEach(Self.thinkingLevels, id: \.self) { level in
                        Button {
                            Task { await store.setThinking(sessionId: session.sessionId, level: level) }
                            dismiss()
                        } label: {
                            HStack {
                                Text(level).foregroundStyle(t.txt)
                                Spacer()
                                if level == session.thinking {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 13, weight: .bold))
                                        .foregroundStyle(t.accent)
                                }
                            }
                        }
                    }
                }

                Section {
                    Toggle(isOn: Binding(
                        get: { store.fastBySession[session.sessionId] ?? false },
                        set: { Task { await store.setFast(sessionId: session.sessionId, enabled: $0) } }
                    )) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Fast mode").foregroundStyle(t.txt)
                            Text("Provider-priority processing for this model")
                                .font(.system(size: 11))
                                .foregroundStyle(t.txtMuted)
                        }
                    }
                    .tint(t.accent)
                }
            }
            .navigationTitle("Session controls")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
