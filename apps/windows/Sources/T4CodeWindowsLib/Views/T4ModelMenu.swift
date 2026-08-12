//  T4ModelMenu.swift (Linux port of apps/ios/Sources/T4ModelMenu.swift)
//  Native inline model menu: models grouped under PROVIDER section headers,
//  thinking-level submenu, fast-mode toggle. Used by the workspace toolbar
//  and the session detail header — one menu, one truth. The provider is
//  always the section title, so where a prompt goes is never ambiguous.
//
//  Linux deltas:
//  - SwiftCrossUI `Menu` takes a String label (no custom label views), so
//    `T4ModelMenuButton` takes `label: String` instead of macOS's
//    `@ViewBuilder label: () -> Content` closure; callers pass
//    `T4ModelLabel.labelString(selector)`.
//  - SF Symbol "checkmark"/"circle" rows become "✓ "/"○ " text prefixes.
//  - macOS `Section("Mode")` becomes a plain `Text` header row (SwiftCrossUI
//    menus have no sections; separators come from `Divider`).

import SwiftCrossUI
import HostWire

private let t4ThinkingLevels = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]

struct T4ModelMenuButton: View {
    let session: SessionRef
    let store: T4SessionStore
    let connectionModel: T4ConnectionInventoryModel
    let catalogModel: T4CatalogSettingsModel
    let promptModel: T4PromptLeaseModel
    let theme: Theme
    let label: String

    init(session: SessionRef, store: T4SessionStore, theme: Theme, label: String) {
        self.session = session
        self.store = store
        self.connectionModel = store.connectionModel
        self.catalogModel = store.catalogSettingsModel
        self.promptModel = store.promptModel
        self.theme = theme
        self.label = label
    }

    private var catalogModels: [CatalogItem] {
        catalogModel.sortedSupportedModels
    }

    private var providers: [T4ProviderGroup] { catalogModel.providerGroups }

    var body: some View {
        Menu(label) {
            modelContent
            controlContent
            modeContent
        }
        .disabled(!connectionModel.connected || !session.t4IsWritable)
    }

    @ViewBuilder private var modelContent: some View {
        ForEach(providers) { group in
            Menu(group.name) {
                ForEach(group.models, id: \.id) { item in
                    T4TextButton(item.id == session.model ? "✓ \(splitModelSelector(item.id).model)" : "○ \(splitModelSelector(item.id).model)") {
                        Task { await store.setModel(sessionId: session.sessionId, selector: item.id) }
                    }
                }
            }
        }
        if catalogModels.isEmpty {
            Text("No models in the host catalog")
        }
    }

    @ViewBuilder private var controlContent: some View {
        Menu("Thinking: \(session.thinking ?? "auto")") {
            ForEach(t4ThinkingLevels, id: \.self) { level in
                T4TextButton(level == session.thinking ? "✓ \(level)" : "○ \(level)") {
                    Task { await store.setThinking(sessionId: session.sessionId, level: level) }
                }
            }
        }

        Toggle("Fast mode", isOn: Binding(
            get: { promptModel.fastBySession[session.sessionId] ?? false },
            set: { enabled in Task { await store.setFast(sessionId: session.sessionId, enabled: enabled) } }
        ))
    }

    @ViewBuilder private var modeContent: some View {
        Divider()
        Text("Mode")
                    .lineLimit(1)
        modeButton("build", label: "Build", hint: "Make changes directly")
        modeButton("plan", label: "Plan", hint: "Propose a plan before touching anything")
        modeButton("readOnly", label: "Read-only", hint: "Inspect only; no writes, no commands")
    }

    @ViewBuilder
    private func modeButton(_ mode: String, label: String, hint: String) -> some View {
        let current = session.mode ?? "build"
        T4TextButton(current == mode ? "✓ \(label) — \(hint)" : "\(label) — \(hint)") {
            Task { await store.setMode(sessionId: session.sessionId, mode: mode) }
        }
    }
}
