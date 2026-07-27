//  T4PanesView.swift
//  Four detail-ellipsis panes — Usage, Review, Artifacts, Settings — each a
//  sheet backed by a host-wire command in T4SessionStore's Panes data section.
//  Usage and Settings are host-scope (no session); Review and Artifacts are
//  session-scoped. All four degrade to a clear error banner when the host
//  denies the command (e.g. the paired device lacks the capability), and all
//  render sample rows when offline so the sheets preview in the simulator.
//
//  Shapes consumed (HostWire):
//   • usage.read  → UsageReadResult { generatedAt, reports, accountsWithoutUsage, capacity }
//     — per report: provider, fetchedAt, limits[]; per limit: id, label, scope,
//       window?, amount { used, limit, remaining, usedFraction, unit }, status?
//   • review.read → ReviewReadResult { reviewId, status, path?, findings[] }
//     — findings are opaque objects; the UI reads severity/message/line.
//   • artifact.read → ArtifactReadChunk { artifactId, kind, mediaType, size,
//       offset, nextOffset, complete, content (base64) }
//   • settings.read → SettingsReadResult { revision, settings {[String: JSONValue]} }
//   • settings.write → { written: true, revision: <new> } (confirmation-challenged,
//     expectedRevision required); partial settings object args, per-key merge for
//     providerKeys (host masks values on read).

import SwiftUI
import HostWire

// MARK: - Usage pane

/// Host usage snapshot (usage.read): generatedAt header, one section per
/// provider report with its limits (label, used/limit, unit, status), then
/// capacity windows and accounts without usage. Refreshed on appear and via
/// the toolbar refresh button. Sample rows when offline.
struct T4UsagePane: View {
    @ObservedObject var store: T4SessionStore
    @EnvironmentObject var theme: ThemeStore
    @Binding var isPresented: Bool

    @State private var loading = true
    @State private var error: String?
    private var t: Theme { theme.t }

    private var snapshot: UsageReadResult? { store.usageSnapshot }

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    Spacer()
                    ProgressView().tint(t.txtMuted)
                    Spacer()
                } else if let error {
                    Spacer()
                    paneError(error, t)
                    Spacer()
                } else if let snapshot {
                    usageList(snapshot)
                } else {
                    Spacer()
                    Text("No usage data.")
                        .font(.system(size: 13))
                        .foregroundStyle(t.txtMuted)
                    Spacer()
                }
            }
            .background(t.bg.ignoresSafeArea())
            .navigationTitle("Usage")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: platformTrailingPlacement) {
                    Button("Done") { isPresented = false }
                        .font(.system(size: 14, weight: .semibold))
                }
                ToolbarItem(placement: platformLeadingPlacement) {
                    Button {
                        Task { await load() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(loading || !store.connected)
                }
            }
        }
        .task { await load() }
    }

    private func usageList(_ snapshot: UsageReadResult) -> some View {
        List {
            Section {
                row("Generated", generatedLabel(snapshot.generatedAt), t)
                    .listRowSeparator(.hidden)
            }
            ForEach(snapshot.reports, id: \.provider) { report in
                Section(header: Text(report.provider).font(.system(size: 12, weight: .bold)).foregroundStyle(t.txtLabel)) {
                    ForEach(report.limits, id: \.id) { limit in
                        limitRow(limit)
                    }
                    if let notes = report.notes, !notes.isEmpty {
                        ForEach(Array(notes.enumerated()), id: \.offset) { _, note in
                            Text(note)
                                .font(.system(size: 11))
                                .foregroundStyle(t.txtMuted)
                                .listRowSeparator(.hidden)
                        }
                    }
                }
            }
            if !snapshot.capacity.isEmpty {
                Section(header: Text("Capacity").font(.system(size: 12, weight: .bold)).foregroundStyle(t.txtLabel)) {
                    ForEach(Array(snapshot.capacity.keys.sorted()), id: \.self) { provider in
                        ForEach(snapshot.capacity[provider] ?? [], id: \.window) { window in
                            capacityRow(provider, window)
                        }
                    }
                }
            }
            if !snapshot.accountsWithoutUsage.isEmpty {
                Section(header: Text("Accounts without usage").font(.system(size: 12, weight: .bold)).foregroundStyle(t.txtLabel)) {
                    ForEach(Array(snapshot.accountsWithoutUsage.enumerated()), id: \.offset) { _, account in
                        row(account.provider, account.email ?? account.orgName ?? account.accountId ?? "—", t)
                    }
                }
            }
        }
        #if os(iOS)
        .listStyle(.insetGrouped)
        #else
        .listStyle(.inset)
        #endif
        .scrollContentBackground(.hidden)
    }

    private func limitRow(_ limit: UsageLimit) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(limit.label)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(t.txt)
                Spacer()
                if let status = limit.status {
                    Text(status.rawValue)
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(statusColor(status))
                }
            }
            HStack(spacing: 6) {
                Text(amountLabel(limit.amount))
                    .font(.system(size: 12))
                    .foregroundStyle(t.txtBody)
                Text(limit.amount.unit.rawValue)
                    .font(.system(size: 11))
                    .foregroundStyle(t.txtMuted)
                Spacer()
                if let frac = limit.amount.usedFraction {
                    ProgressBar(value: frac, tint: t.accent, track: t.lineFaint)
                        .frame(width: 64, height: 4)
                }
            }
            if let window = limit.window {
                Text(window.label)
                    .font(.system(size: 10))
                    .foregroundStyle(t.txtLabel)
            }
        }
        .padding(.vertical, 2)
    }

    private func capacityRow(_ provider: String, _ window: UsageCapacityWindow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(provider) · \(window.window)")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(t.txt)
            HStack(spacing: 6) {
                Text("\(Int(window.usedAccounts))/\(window.accounts)")
                    .font(.system(size: 12))
                    .foregroundStyle(t.txtBody)
                Text("accounts")
                    .font(.system(size: 11))
                    .foregroundStyle(t.txtMuted)
                Spacer()
                ProgressBar(value: window.accounts > 0 ? window.usedAccounts / Double(window.accounts) : 0,
                            tint: t.cTask, track: t.lineFaint)
                    .frame(width: 64, height: 4)
            }
        }
        .padding(.vertical, 2)
    }

    private func load() async {
        loading = true
        error = nil
        if !store.connected {
            // Offline preview: leave snapshot as-is (sample or nil).
            loading = false
            return
        }
        if await store.usageRead() == nil, let err = store.lastError {
            error = err
        }
        loading = false
    }

    private func amountLabel(_ a: UsageAmount) -> String {
        let used = a.used.map { Self.fmt($0) } ?? "—"
        let limit = a.limit.map { Self.fmt($0) } ?? "—"
        return "\(used) / \(limit)"
    }

    private func generatedLabel(_ ms: Int) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000.0)
        return Self.dateFormatter.string(from: date)
    }

    private func statusColor(_ s: UsageStatus) -> Color {
        switch s {
        case .ok: return t.cOk
        case .warning: return t.accent
        case .exhausted: return t.diffDel
        case .unknown: return t.txtMuted
        }
    }

    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        return f
    }()

    private static func fmt(_ n: Double) -> String {
        n == n.rounded() ? String(Int(n)) : String(format: "%.2f", n)
    }
}

// MARK: - Review pane

/// Code review findings (review.read): reviewId + status header, optional
/// path, then one row per finding (severity, message, line). Reads the latest
/// reviewId from `store.reviews(for:)` (fed by `review` additive frames) and
/// calls review.read on appear. Sample review when offline.
struct T4ReviewPane: View {
    let session: SessionRef
    @ObservedObject var store: T4SessionStore
    @EnvironmentObject var theme: ThemeStore
    @Binding var isPresented: Bool

    @State private var loading = true
    @State private var error: String?
    @State private var result: ReviewReadResult?
    private var t: Theme { theme.t }

    private var reviews: [ReviewFrame] { store.reviews(for: session.sessionId) }

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    Spacer()
                    ProgressView().tint(t.txtMuted)
                    Spacer()
                } else if let error {
                    Spacer()
                    paneError(error, t)
                    Spacer()
                } else if let result {
                    reviewList(result)
                } else {
                    Spacer()
                    Text("No review available.")
                        .font(.system(size: 13))
                        .foregroundStyle(t.txtMuted)
                    Spacer()
                }
            }
            .background(t.bg.ignoresSafeArea())
            .navigationTitle("Review")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: platformTrailingPlacement) {
                    Button("Done") { isPresented = false }
                        .font(.system(size: 14, weight: .semibold))
                }
                ToolbarItem(placement: platformLeadingPlacement) {
                    Button {
                        Task { await load() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(loading || !store.connected || reviews.isEmpty)
                }
            }
        }
        .task { await load() }
    }

    private func reviewList(_ r: ReviewReadResult) -> some View {
        List {
            Section {
                row("Review", r.reviewId, t).listRowSeparator(.hidden)
                row("Status", r.status, t).listRowSeparator(.hidden)
                if let path = r.path {
                    row("Path", path, t).listRowSeparator(.hidden)
                }
            }
            if r.findings.isEmpty {
                Section {
                    Text("No findings — review is clean.")
                        .font(.system(size: 13))
                        .foregroundStyle(t.txtMuted)
                }
            } else {
                Section(header: Text("Findings (\(r.findings.count))").font(.system(size: 12, weight: .bold)).foregroundStyle(t.txtLabel)) {
                    ForEach(Array(r.findings.enumerated()), id: \.offset) { _, finding in
                        findingRow(finding)
                    }
                }
            }
        }
        #if os(iOS)
        .listStyle(.insetGrouped)
        #else
        .listStyle(.inset)
        #endif
        .scrollContentBackground(.hidden)
    }

    private func findingRow(_ finding: JSONValue) -> some View {
        let severity = finding.string("severity") ?? "info"
        let message = finding.string("message") ?? ""
        let line = finding.number("line").map { Int($0) }
        let path = finding.string("path")
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(severity)
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(severityColor(severity))
                if let path {
                    Text(path)
                        .font(.system(size: 11))
                        .foregroundStyle(t.txtMuted)
                        .lineLimit(1)
                }
                Spacer()
                if let line {
                    Text("L\(line)")
                        .font(.system(size: 11))
                        .foregroundStyle(t.txtLabel)
                }
            }
            Text(message)
                .font(.system(size: 13))
                .foregroundStyle(t.txt)
        }
        .padding(.vertical, 2)
    }

    private func load() async {
        loading = true
        error = nil
        if !store.connected {
            // Offline preview: synthesize a result from the sample review.
            if let sample = reviews.first {
                result = ReviewReadResult(reviewId: sample.reviewId, status: sample.status,
                                          path: sample.path, findings: sample.findings)
            }
            loading = false
            return
        }
        if let r = await store.reviewRead(sessionId: session.sessionId) {
            result = r
        } else if let err = store.lastError {
            error = err
        }
        loading = false
    }

    private func severityColor(_ s: String) -> Color {
        switch s {
        case "error", "critical": return t.diffDel
        case "warning": return t.accent
        case "info": return t.cTask
        default: return t.txtMuted
        }
    }
}

// MARK: - Artifacts pane

/// Session-retained artifacts: lists descriptors parsed from transcript
/// entries' `data.artifacts` arrays. Tapping a row calls artifact.read for
/// the first chunk (offset 0) and shows an inline preview — text/patch as
/// monospaced content, image as a rendered UIImage, binary as a size label.
struct T4ArtifactsPane: View {
    let session: SessionRef
    @ObservedObject var store: T4SessionStore
    @EnvironmentObject var theme: ThemeStore
    @Binding var isPresented: Bool

    @State private var expanded: String?   // artifactId currently previewing
    @State private var loading: String?    // artifactId currently fetching
    @State private var error: String?
    private var t: Theme { theme.t }

    private var artifacts: [ArtifactDescriptor] { store.artifacts(for: session.sessionId) }

    var body: some View {
        NavigationStack {
            Group {
                if artifacts.isEmpty {
                    Spacer()
                    VStack(spacing: 10) {
                        Image(systemName: "paperclip")
                            .font(.system(size: 28))
                            .foregroundStyle(t.txtMuted)
                        Text("No artifacts")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(t.txt)
                        Text("Artifacts produced by this session will appear here.")
                            .font(.system(size: 12))
                            .foregroundStyle(t.txtMuted)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                    }
                    Spacer()
                } else {
                    List {
                        ForEach(artifacts, id: \.artifactId) { descriptor in
                            artifactRow(descriptor)
                        }
                    }
                    #if os(iOS)
                    .listStyle(.insetGrouped)
                    #else
                    .listStyle(.inset)
                    #endif
                    .scrollContentBackground(.hidden)
                }
                if let error {
                    paneError(error, t)
                        .padding(.bottom, 12)
                }
            }
            .background(t.bg.ignoresSafeArea())
            .navigationTitle("Artifacts")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: platformTrailingPlacement) {
                    Button("Done") { isPresented = false }
                        .font(.system(size: 14, weight: .semibold))
                }
            }
        }
    }

    private func artifactRow(_ d: ArtifactDescriptor) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                Task { await toggle(d) }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: kindIcon(d.kind))
                        .font(.system(size: 14))
                        .foregroundStyle(kindColor(d.kind))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(d.name ?? "#\(d.artifactId)")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(t.txt)
                            .lineLimit(1)
                        Text("\(d.kind) · \(d.mediaType)")
                            .font(.system(size: 11))
                            .foregroundStyle(t.txtMuted)
                    }
                    Spacer()
                    if loading == d.artifactId {
                        ProgressView().scaleEffect(0.7).tint(t.txtMuted)
                    } else {
                        Image(systemName: expanded == d.artifactId ? "chevron.down" : "chevron.right")
                            .font(.system(size: 11))
                            .foregroundStyle(t.txtLabel)
                    }
                }
            }
            .buttonStyle(.plain)
            if expanded == d.artifactId {
                preview(for: d)
            }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private func preview(for d: ArtifactDescriptor) -> some View {
        if let chunk = store.artifactChunks[d.artifactId] {
            chunkPreview(chunk)
        } else if loading == d.artifactId {
            Text("Loading…")
                .font(.system(size: 12))
                .foregroundStyle(t.txtMuted)
        } else {
            Text("Tap to load preview")
                .font(.system(size: 12))
                .foregroundStyle(t.txtLabel)
        }
    }

    @ViewBuilder
    private func chunkPreview(_ chunk: ArtifactReadChunk) -> some View {
        switch chunk.kind {
        case "text", "patch":
            if let bytes = chunk.decodedBytes, let text = String(data: bytes, encoding: .utf8) {
                Text(text.prefix(2048))
                    .font(.term(12))
                    .foregroundStyle(t.txtBody)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(t.glassFill, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            } else {
                Text("Could not decode text content.")
                    .font(.system(size: 12))
                    .foregroundStyle(t.txtMuted)
            }
        case "image":
            if let bytes = chunk.decodedBytes, let img = platformImage(data: bytes) {
                Image(platformImage: img)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 240)
                    .cornerRadius(8)
            } else {
                Text("Could not decode image.")
                    .font(.system(size: 12))
                    .foregroundStyle(t.txtMuted)
            }
        default:
            Text("Binary · \(chunk.size) bytes")
                .font(.system(size: 12))
                .foregroundStyle(t.txtMuted)
        }
    }

    private func toggle(_ d: ArtifactDescriptor) async {
        if expanded == d.artifactId {
            expanded = nil
            return
        }
        expanded = d.artifactId
        if store.artifactChunks[d.artifactId] != nil { return }
        guard store.connected else {
            error = "Not connected to a host."
            return
        }
        loading = d.artifactId
        error = nil
        if await store.artifactRead(sessionId: session.sessionId, artifactId: d.artifactId) == nil,
           let err = store.lastError {
            error = err
        }
        loading = nil
    }

    private func kindIcon(_ k: String) -> String {
        switch k {
        case "image": return "photo"
        case "text": return "doc.text"
        case "patch": return "square.and.pencil"
        default: return "doc"
        }
    }

    private func kindColor(_ k: String) -> Color {
        switch k {
        case "image": return t.cAdvisor
        case "text": return t.cTask
        case "patch": return t.cBash
        default: return t.txtMuted
        }
    }
}

// MARK: - Settings pane

/// Host settings (settings.read / settings.write), sectioned:
/// MODELS (per-role model selector), BEHAVIOR (thinking level, tool approval),
/// PROVIDERS & KEYS (masked provider keys + add-key flow), CONNECTION
/// (endpoint, wss fingerprint + forget, disconnect), APPEARANCE (theme).
/// Reads on appear; every mutation goes through store.settingsWrite(patch:)
/// with the captured revision. The pane keeps a local optimistic mirror of
/// the snapshot — mutated immediately on write and reverted from the store on
/// failure. settings.write may trigger a confirmation challenge, surfaced as
/// store.pendingConfirmation by observe() and handled by the session banner.
struct T4SettingsPane: View {
    @ObservedObject var store: T4SessionStore
    @EnvironmentObject var theme: ThemeStore
    @Binding var isPresented: Bool

    @State private var loading = true
    @State private var error: String?
    /// Local optimistic mirror of store.settingsSnapshot — applied immediately
    /// on write, reverted to the store's value on failure.
    @State private var snapshot: [String: JSONValue] = [:]
    @State private var saving = false
    /// Add-provider-key sheet state.
    @State private var addingKey = false
    @State private var newKeyProvider = ""
    @State private var newKeyValue = ""
    private var t: Theme { theme.t }

    // Known model roles (host modelRoles keys). "default" is the fallback when
    // a role is unset, so it doubles as the clear sentinel in the picker.
    private let roles: [(id: String, label: String)] = [
        ("default", "Default"), ("smol", "Smol"), ("slow", "Slow"),
        ("vision", "Vision"), ("plan", "Plan"), ("designer", "Designer"),
        ("commit", "Commit"), ("tiny", "Tiny"), ("task", "Task"),
        ("advisor", "Advisor")
    ]
    private let thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]
    private let approvalModes: [(id: String, label: String)] = [
        ("always-ask", "Always ask"), ("write", "Write"), ("yolo", "Yolo")
    ]

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    Spacer()
                    ProgressView().tint(t.txtMuted)
                    Spacer()
                } else if let error {
                    Spacer()
                    paneError(error, t)
                    Spacer()
                } else {
                    settingsList
                }
            }
            .background(t.bg.ignoresSafeArea())
            .navigationTitle("Settings")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: platformTrailingPlacement) {
                    Button("Done") { isPresented = false }
                        .font(.system(size: 14, weight: .semibold))
                }
                ToolbarItem(placement: platformLeadingPlacement) {
                    Button { Task { await load() } } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(loading || !store.connected)
                }
            }
            .sheet(isPresented: $addingKey) {
                addKeySheet
            }
        }
        .task { await load() }
    }

    private var settingsList: some View {
        List {
            modelsSection
            behaviorSection
            providersSection
            connectionSection
            appearanceSection
        }
        #if os(iOS)
        .listStyle(.insetGrouped)
        #else
        .listStyle(.inset)
        #endif
        .scrollContentBackground(.hidden)
    }

    // MARK: MODELS

    @ViewBuilder
    private var modelsSection: some View {
        Section(header: sectionHeader("Models")) {
            if store.catalogModels.isEmpty {
                Text("No models in catalog")
                    .font(.system(size: 12))
                    .foregroundStyle(t.txtMuted)
            } else {
                ForEach(roles, id: \.id) { role in
                    Picker(selection: Binding(
                        get: { roleValue(role.id) },
                        set: { new in Task { await setRole(role.id, new) } }
                    )) {
                        Text("default").tag("default")
                        ForEach(store.catalogModels, id: \.id) { m in
                            Text(m.id).tag(m.id)
                        }
                    } label: {
                        Text(role.label)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(t.txt)
                    }
                    .pickerStyle(.menu)
                    .tint(t.accent)
                }
            }
        }
    }

    // MARK: BEHAVIOR

    @ViewBuilder
    private var behaviorSection: some View {
        Section(header: sectionHeader("Behavior")) {
            Picker(selection: Binding(
                get: { thinkingLevel() },
                set: { new in Task { await setThinkingLevel(new) } }
            )) {
                ForEach(thinkingLevels, id: \.self) { Text($0).tag($0) }
            } label: {
                Text("Thinking")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(t.txt)
            }
            .pickerStyle(.menu)
            .tint(t.accent)

            Picker(selection: Binding(
                get: { approvalMode() },
                set: { new in Task { await setApprovalMode(new) } }
            )) {
                ForEach(approvalModes, id: \.id) { Text($0.label).tag($0.id) }
            } label: {
                Text("Tool approval")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(t.txt)
            }
            .pickerStyle(.menu)
            .tint(t.accent)
        }
    }

    // MARK: PROVIDERS & KEYS

    @ViewBuilder
    private var providersSection: some View {
        Section(header: sectionHeader("Providers & Keys")) {
            let keys = providerKeys()
            if keys.isEmpty {
                Text("No provider keys set")
                    .font(.system(size: 12))
                    .foregroundStyle(t.txtMuted)
            } else {
                ForEach(keys, id: \.provider) { entry in
                    HStack {
                        Text(entry.provider)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(t.txt)
                        Spacer()
                        Text(entry.masked)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(t.txtMuted)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
            }
            Button {
                addingKey = true
            } label: {
                Label("Add provider key", systemImage: "plus")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(t.accent)
            }
            .disabled(saving)
        }
    }

    /// Add-provider-key sheet: provider name + write-only SecureField. The key
    /// is sent as a single-key providerKeys patch; the host masks on read, so
    /// the saved row never shows the raw key.
    private var addKeySheet: some View {
        NavigationStack {
            Form {
                Section("Provider") {
                    TextField("e.g. openai", text: $newKeyProvider)
                        .autocorrectionDisabled(true)
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                }
                Section("API key") {
                    SecureField("sk-…", text: $newKeyValue)
                        .autocorrectionDisabled(true)
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                }
                if let error {
                    Section {
                        Text(error)
                            .font(.system(size: 12))
                            .foregroundStyle(t.cAdvisor)
                    }
                }
            }
            .navigationTitle("Add provider key")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: platformLeadingPlacement) {
                    Button("Cancel") { addingKey = false }
                }
                ToolbarItem(placement: platformTrailingPlacement) {
                    Button("Save") { Task { await addKey() } }
                        .font(.system(size: 14, weight: .semibold))
                        .disabled(saving || newKeyProvider.isEmpty || newKeyValue.isEmpty)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 360, minHeight: 240)
        #endif
    }

    // MARK: CONNECTION

    @ViewBuilder
    private var connectionSection: some View {
        Section(header: sectionHeader("Connection")) {
            if let info = store.hostInfo {
                hostRow("Host ID", info.hostId)
                hostRow("OMP version", info.ompVersion)
                hostRow("Appserver", info.appserverVersion)
            } else {
                hostRow("Host ID", "—")
                hostRow("OMP version", "—")
                hostRow("Appserver", "—")
            }
            hostRow("Endpoint", store.pairedEndpoint?
                .replacingOccurrences(of: "wss://", with: "")
                .replacingOccurrences(of: "ws://", with: "")
                .replacingOccurrences(of: "/v1/ws", with: "") ?? "Not connected")
            if let fp = pinnedFingerprint {
                HStack(alignment: .firstTextBaseline) {
                    Text("wss fingerprint")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(t.txt)
                    Spacer()
                    Text(String(fp.prefix(16)) + "…")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(t.txtMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Button(role: .destructive) {
                    forgetPin()
                } label: {
                    Label("Forget pinned cert", systemImage: "lock.slash")
                        .font(.system(size: 13))
                }
            }
            Button(role: .destructive) {
                Task { await store.disconnect() }
            } label: {
                Label("Disconnect", systemImage: "antenna.radiowaves.left.and.right.slash")
            }
            .disabled(!store.connected)
        }
    }

    // MARK: APPEARANCE

    @ViewBuilder
    private var appearanceSection: some View {
        Section(header: sectionHeader("Appearance")) {
            Picker(selection: $theme.mode) {
                Text("System").tag(Appearance.system)
                Text("Dark").tag(Appearance.dark)
                Text("Light").tag(Appearance.light)
            } label: {
                Text("Theme")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(t.txt)
            }
            .pickerStyle(.menu)
            .tint(t.accent)
        }
    }

    // MARK: Helpers

    @ViewBuilder
    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(t.txtLabel)
    }

    @ViewBuilder
    private func hostRow(_ key: String, _ value: String) -> some View {
        HStack {
            Text(key)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(t.txt)
            Spacer()
            Text(value)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(t.txtMuted)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }

    /// modelRoles as a plain String→String map from the local snapshot.
    private var modelRolesDict: [String: String] {
        guard case .object(let o) = snapshot["modelRoles"] ?? .null else { return [:] }
        return o.compactMapValues { v in
            if case .string(let s) = v { return s } else { return nil }
        }
    }

    /// Current selector for a role, "default" when unset.
    private func roleValue(_ role: String) -> String {
        modelRolesDict[role] ?? "default"
    }

    /// Write one role. Sends the full merged modelRoles object (values are not
    /// masked, so round-tripping them is safe regardless of merge semantics).
    private func setRole(_ role: String, _ selector: String) async {
        var roles = modelRolesDict
        if selector == "default" { roles.removeValue(forKey: role) }
        else { roles[role] = selector }
        let obj = roles.mapValues { JSONValue.string($0) }
        let patch: [String: JSONValue] = roles.isEmpty
            ? ["modelRoles": .object([:])]
            : ["modelRoles": .object(obj)]
        await write(patch) { s in
            if roles.isEmpty { s.removeValue(forKey: "modelRoles") }
            else { s["modelRoles"] = .object(obj) }
        }
    }

    private func thinkingLevel() -> String {
        if case .string(let s) = snapshot["defaultThinkingLevel"] ?? .null { return s }
        return "auto"
    }

    private func setThinkingLevel(_ level: String) async {
        await write(["defaultThinkingLevel": .string(level)]) { s in
            s["defaultThinkingLevel"] = .string(level)
        }
    }

    private func approvalMode() -> String {
        if case .string(let s) = snapshot["tools.approvalMode"] ?? .null { return s }
        return "always-ask"
    }

    private func setApprovalMode(_ mode: String) async {
        await write(["tools.approvalMode": .string(mode)]) { s in
            s["tools.approvalMode"] = .string(mode)
        }
    }

    /// Sorted (provider, masked) pairs from the local snapshot.
    private func providerKeys() -> [(provider: String, masked: String)] {
        guard case .object(let o) = snapshot["providerKeys"] ?? .null else { return [] }
        return o.compactMap { k, v -> (provider: String, masked: String)? in
            if case .string(let s) = v { return (provider: k, masked: s) } else { return nil }
        }.sorted { $0.provider < $1.provider }
    }

    /// Add a provider key. Sends a single-key providerKeys patch so the host
    /// merges per-key — never echo masked values back, which would clobber the
    /// real key. The re-read after write surfaces the host's masked form.
    private func addKey() async {
        let provider = newKeyProvider.trimmingCharacters(in: .whitespacesAndNewlines)
        let value = newKeyValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !provider.isEmpty, !value.isEmpty else { return }
        let patch: [String: JSONValue] = ["providerKeys": .object([provider: .string(value)])]
        await write(patch) { s in
            // Read existing masked keys from the in-progress snapshot so the
            // optimistic row list includes the new key alongside the others.
            var keys: [String: String] = [:]
            if case .object(let o) = s["providerKeys"] ?? .null {
                for (k, v) in o where case .string(let m) = v { keys[k] = m }
            }
            keys[provider] = "sk-…\(value.suffix(4))"
            s["providerKeys"] = .object(keys.mapValues { .string($0) })
        }
        if error == nil {
            addingKey = false
            newKeyProvider = ""
            newKeyValue = ""
        }
    }

    /// Optimistic write: mutate the local snapshot immediately, send the patch,
    /// then sync from the store on success or revert on failure.
    private func write(
        _ patch: [String: JSONValue],
        optimistic: (inout [String: JSONValue]) -> Void
    ) async {
        saving = true
        error = nil
        let backup = snapshot
        var next = snapshot
        optimistic(&next)
        snapshot = next
        let ok = await store.settingsWrite(patch: patch)
        if ok {
            snapshot = store.settingsSnapshot ?? [:]
        } else {
            snapshot = backup
            if let err = store.lastError { error = err }
        }
        saving = false
    }

    /// Pinned wss leaf-cert fingerprint for the current endpoint, if any.
    private var pinnedFingerprint: String? {
        guard let endpoint = store.pairedEndpoint,
              let comps = URLComponents(string: endpoint),
              let host = comps.host else { return nil }
        let port = comps.port ?? (comps.scheme == "wss" ? 443 : 80)
        return T4CertPinner.pinnedFingerprint(host: host, port: port)
    }

    private func forgetPin() {
        guard let endpoint = store.pairedEndpoint,
              let comps = URLComponents(string: endpoint),
              let host = comps.host else { return }
        let port = comps.port ?? (comps.scheme == "wss" ? 443 : 80)
        T4CertPinner.forget(host: host, port: port)
    }

    private func load() async {
        loading = true
        error = nil
        if !store.connected {
            snapshot = [:]
            loading = false
            return
        }
        if let read = await store.settingsRead() {
            snapshot = read
        } else if let err = store.lastError {
            error = err
        }
        loading = false
    }
}

// MARK: - Shared helpers

/// One key/value row, label + value, used by the usage and review panes.
private func row(_ key: String, _ value: String, _ t: Theme) -> some View {
    HStack(alignment: .firstTextBaseline) {
        Text(key.uppercased())
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(t.txtLabel)
            .frame(width: 96, alignment: .leading)
        Text(value)
            .font(.system(size: 13))
            .foregroundStyle(t.txtBody)
    }
}

/// Inline error banner for a pane (store.lastError style).
private func paneError(_ message: String, _ t: Theme) -> some View {
    VStack(spacing: 6) {
        Image(systemName: "exclamationmark.triangle.fill")
            .font(.system(size: 20))
            .foregroundStyle(t.cAdvisor)
        Text(message)
            .font(.system(size: 12))
            .foregroundStyle(t.txtBody)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 24)
    }
}

/// Slim 0..1 progress bar (capsule track + filled capsule), reused by the
/// usage pane. Mirrors the agents pane's ProgressBar.
private struct ProgressBar: View {
    let value: Double
    let tint: Color
    let track: Color

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(track)
                Capsule().fill(tint).frame(width: geo.size.width * min(max(value, 0), 1))
            }
        }
    }
}
