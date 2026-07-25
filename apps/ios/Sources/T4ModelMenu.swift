//  T4ModelMenu.swift
//  Native inline model menu (UIMenu-style popup): models grouped under
//  PROVIDER section headers, thinking-level submenu, fast-mode toggle. Used
//  by the workspace toolbar and the session detail header — one menu, one
//  truth. The provider is always the section title, so where a prompt goes
//  is never ambiguous.

import SwiftUI
import HostWire

private let t4ThinkingLevels = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]

struct T4ProviderGroup: Identifiable {
    let name: String
    let models: [CatalogItem]
    var id: String { name }
}

private func groupByProvider(_ items: [CatalogItem]) -> [T4ProviderGroup] {
    var byProvider: [String: [CatalogItem]] = [:]
    for item in items {
        let provider = splitModelSelector(item.id).provider ?? "other"
        byProvider[provider, default: []].append(item)
    }
    return byProvider.keys.sorted().map { T4ProviderGroup(name: $0, models: byProvider[$0] ?? []) }
}

struct T4ModelMenuButton<Label: View>: View {
    let session: SessionRef
    @ObservedObject var store: T4SessionStore
    let theme: Theme
    @ViewBuilder let label: () -> Label

    private var providers: [T4ProviderGroup] { groupByProvider(store.catalogModels) }

    var body: some View {
        Menu {
            ForEach(providers) { group in
                Section(group.name.uppercased()) {
                    ForEach(group.models, id: \.id) { item in
                        Button {
                            Task { await store.setModel(sessionId: session.sessionId, selector: item.id) }
                        } label: {
                            if item.id == session.model {
                                Label(splitModelSelector(item.id).model, systemImage: "checkmark")
                            } else {
                                Text(splitModelSelector(item.id).model)
                            }
                        }
                    }
                }
            }
            if store.catalogModels.isEmpty {
                Text("No models in the host catalog")
            }

            Section {
                Menu {
                    ForEach(t4ThinkingLevels, id: \.self) { level in
                        Button {
                            Task { await store.setThinking(sessionId: session.sessionId, level: level) }
                        } label: {
                            if level == session.thinking {
                                Label(level, systemImage: "checkmark")
                            } else {
                                Text(level)
                            }
                        }
                    }
                } label: {
                    Label("Thinking: \(session.thinking ?? "auto")", systemImage: "brain")
                }

                Toggle(isOn: Binding(
                    get: { store.fastBySession[session.sessionId] ?? false },
                    set: { enabled in Task { await store.setFast(sessionId: session.sessionId, enabled: enabled) } }
                )) {
                    Label("Fast mode", systemImage: "bolt")
                }
            }
        } label: {
            label()
        }
        .disabled(!store.connected)
    }
}
