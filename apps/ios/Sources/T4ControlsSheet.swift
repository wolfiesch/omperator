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

    var body: some View {
        NavigationStack {
            List {
                T4ModelSections(session: session, store: store, theme: t) { dismiss() }
                T4ThinkingSection(session: session, store: store, theme: t) { dismiss() }
                T4FastSection(session: session, store: store, theme: t)
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

// MARK: - Model picker

private struct T4ModelSections: View {
    let session: SessionRef
    @ObservedObject var store: T4SessionStore
    let theme: Theme
    let done: () -> Void

    struct ProviderGroup: Identifiable {
        let provider: String
        let models: [CatalogItem]
        var id: String { provider }
    }

    private var providers: [ProviderGroup] {
        var byProvider: [String: [CatalogItem]] = [:]
        for item in store.catalogModels {
            let provider = splitModelSelector(item.id).provider ?? "other"
            byProvider[provider, default: []].append(item)
        }
        return byProvider.keys.sorted().map { ProviderGroup(provider: $0, models: byProvider[$0] ?? []) }
    }

    var body: some View {
        Section {
            if store.catalogModels.isEmpty {
                Text("No models in the host catalog").foregroundStyle(theme.txtMuted)
            }
            ForEach(providers) { group in
                Section {
                    ForEach(group.models, id: \.id) { item in
                        Button {
                            Task { await store.setModel(sessionId: session.sessionId, selector: item.id) }
                            done()
                        } label: {
                            HStack(spacing: 10) {
                                T4ModelLabel(selector: item.id, theme: theme, size: 13)
                                Spacer()
                                if item.id == session.model {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 13, weight: .bold))
                                        .foregroundStyle(theme.accent)
                                }
                            }
                        }
                        .foregroundStyle(theme.txt)
                    }
                } header: {
                    Text(group.provider.uppercased())
                        .font(.system(size: 11, weight: .bold))
                        .tracking(1)
                        .foregroundStyle(theme.accent)
                        .textCase(nil)
                }
            }
        } header: {
            Text("Model").textCase(nil)
        } footer: {
            Text("The PROVIDER chip is the authority — it decides where your prompts go.")
                .font(.system(size: 11))
        }
    }
}

// MARK: - Thinking level

private struct T4ThinkingSection: View {
    let session: SessionRef
    @ObservedObject var store: T4SessionStore
    let theme: Theme
    let done: () -> Void

    private static let levels = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]

    var body: some View {
        Section("Thinking") {
            ForEach(Self.levels, id: \.self) { level in
                Button {
                    Task { await store.setThinking(sessionId: session.sessionId, level: level) }
                    done()
                } label: {
                    HStack {
                        Text(level).foregroundStyle(theme.txt)
                        Spacer()
                        if level == session.thinking {
                            Image(systemName: "checkmark")
                                .font(.system(size: 13, weight: .bold))
                                .foregroundStyle(theme.accent)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Fast mode

private struct T4FastSection: View {
    let session: SessionRef
    @ObservedObject var store: T4SessionStore
    let theme: Theme

    var body: some View {
        Section {
            Toggle(isOn: Binding(
                get: { store.fastBySession[session.sessionId] ?? false },
                set: { Task { await store.setFast(sessionId: session.sessionId, enabled: $0) } }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Fast mode").foregroundStyle(theme.txt)
                    Text("Provider-priority processing for this model")
                        .font(.system(size: 11))
                        .foregroundStyle(theme.txtMuted)
                }
            }
            .tint(theme.accent)
        }
    }
}
