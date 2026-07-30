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

struct T4ModelMenuButton<Content: View>: View {
    let session: SessionRef
    @ObservedObject var store: T4SessionStore
    @ObservedObject private var connectionModel: T4ConnectionInventoryModel
    @ObservedObject private var catalogModel: T4CatalogSettingsModel
    @ObservedObject private var promptModel: T4PromptLeaseModel
    let theme: Theme
    @ViewBuilder let label: () -> Content

    init(
        session: SessionRef,
        store: T4SessionStore,
        theme: Theme,
        @ViewBuilder label: @escaping () -> Content
    ) {
        self.session = session
        self.store = store
        self._connectionModel = ObservedObject(wrappedValue: store.connectionModel)
        self._catalogModel = ObservedObject(wrappedValue: store.catalogSettingsModel)
        self._promptModel = ObservedObject(wrappedValue: store.promptModel)
        self.theme = theme
        self.label = label
    }

    private var catalogModels: [CatalogItem] {
        catalogModel.catalog
            .filter { $0.kind == .model && $0.supported != false }
            .sorted { $0.id.localizedCaseInsensitiveCompare($1.id) == .orderedAscending }
    }

    private var providers: [T4ProviderGroup] { groupByProvider(catalogModels) }

    var body: some View {
        Menu {
            modelContent
            controlContent
            modeContent
        } label: {
            label()
        }
        .disabled(!connectionModel.connected || !session.t4IsWritable)
    }

    @ViewBuilder private var modelContent: some View {
        ForEach(providers) { group in
            Menu {
                ForEach(group.models, id: \.id) { item in
                    Button {
                        Task { await store.setModel(sessionId: session.sessionId, selector: item.id) }
                    } label: {
                        Label(splitModelSelector(item.id).model,
                              systemImage: item.id == session.model ? "checkmark" : "circle")
                    }
                }
            } label: {
                Label(group.name, systemImage: "chevron.right")
            }
        }
        if catalogModels.isEmpty {
            Text("No models in the host catalog")
        }
    }

    @ViewBuilder private var controlContent: some View {
        Section {
            Menu {
                ForEach(t4ThinkingLevels, id: \.self) { level in
                    Button {
                        Task { await store.setThinking(sessionId: session.sessionId, level: level) }
                    } label: {
                        Label(level, systemImage: level == session.thinking ? "checkmark" : "circle")
                    }
                }
            } label: {
                Label("Thinking: \(session.thinking ?? "auto")", systemImage: "brain")
            }

            Toggle(isOn: Binding(
                get: { promptModel.fastBySession[session.sessionId] ?? false },
                set: { enabled in Task { await store.setFast(sessionId: session.sessionId, enabled: enabled) } }
            )) {
                Label("Fast mode", systemImage: "bolt")
            }
        }
    }

    @ViewBuilder private var modeContent: some View {
        Section("Mode") {
            modeButton("build", label: "Build", hint: "Make changes directly")
            modeButton("plan", label: "Plan", hint: "Propose a plan before touching anything")
            modeButton("readOnly", label: "Read-only", hint: "Inspect only; no writes, no commands")
        }
    }

    @ViewBuilder
    private func modeButton(_ mode: String, label: String, hint: String) -> some View {
        let current = session.mode ?? "build"
        Button {
            Task { await store.setMode(sessionId: session.sessionId, mode: mode) }
        } label: {
            if current == mode {
                Label("\(label) — \(hint)", systemImage: "checkmark")
            } else {
                Text("\(label) — \(hint)")
            }
        }
    }
}
