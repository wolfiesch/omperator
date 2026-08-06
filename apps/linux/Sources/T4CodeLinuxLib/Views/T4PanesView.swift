//  T4PanesView.swift (Linux port of apps/ios/Sources/T4PanesView.swift)
//  Four detail-ellipsis panes — Usage, Review, Artifacts, Settings — each a
//  sheet backed by a host-wire command in T4SessionStore's Panes data section.
//  Usage and Settings are host-scope (no session); Review and Artifacts are
//  session-scoped. All four degrade to a clear error banner when the host
//  denies the command (e.g. the paired device lacks the capability), and all
//  render sample rows when offline so the sheets preview in the simulator.
//
//  Linux port notes (per the shared porting contract):
//   • @EnvironmentObject store/theme → plain `let` properties passed via
//     init (the root re-renders the whole subtree on store changes).
//   • NavigationStack/toolbar/navigationTitle → plain VStack headers with
//     the same buttons (LINUX-GAP: SwiftCrossUI has no navigation stack).
//   • SF Symbol images → text glyphs.
//   • List sections → flattened Identifiable row lists (SwiftCrossUI List
//     renders one flat row list; no Section support).
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

import Foundation
import SwiftCrossUI
import HostWire

// MARK: - Usage pane

/// Host usage snapshot (usage.read): generatedAt header, one section per
/// provider report with its limits (label, used/limit, unit, status), then
/// capacity windows and accounts without usage. Refreshed on appear and via
/// the header refresh button. Sample rows when offline.
struct T4UsagePane: View {
    let store: T4SessionStore
    let theme: ThemeStore
    @Binding var isPresented: Bool

    @State private var loading = true
    @State private var error: String?
    @State private var selection: Int?
    private var t: Theme { theme.t }

    private var snapshot: UsageReadResult? { store.usageSnapshot }

    var body: some View {
        VStack(spacing: 0) {
            paneHeader(title: "Usage")
            Divider(t.line)
            if loading {
                Spacer()
                // LINUX-GAP: .tint(t.txtMuted) on ProgressView (SwiftCrossUI
                // has no view tint modifier).
                ProgressView()
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
                    .foregroundColor(t.txtMuted)
                Spacer()
            }
        }
        .background(t.bg)
        .task { await load() }
    }

    /// Title + leading refresh (macOS toolbar's leading ToolbarItem) and
    /// trailing Done (macOS toolbar's trailing ToolbarItem).
    private func paneHeader(title: String) -> some View {
        HStack(spacing: 8) {
            T4TextButton("⟳") { Task { await load() } }
                .disabled(loading || !store.connected)
                .font(.system(size: 13, weight: .semibold))
            Spacer()
            Text(title)
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(t.txt)
            Spacer()
            T4TextButton("Done") { isPresented = false }
                .font(.system(size: 14, weight: .semibold))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    /// Flattened row list mirroring the macOS section structure: generated
    /// meta row, per-provider header + limits (+ notes), capacity windows,
    /// accounts without usage.
    private func usageList(_ snapshot: UsageReadResult) -> some View {
        var rows: [UsageListRow] = []
        rows.append(UsageListRow(id: rows.count, row: .generated(generatedLabel(snapshot.generatedAt))))
        for report in snapshot.reports {
            rows.append(UsageListRow(id: rows.count, row: .provider(report.provider)))
            for limit in report.limits {
                rows.append(UsageListRow(id: rows.count, row: .limit(limit)))
            }
            if let notes = report.notes, !notes.isEmpty {
                for note in notes {
                    rows.append(UsageListRow(id: rows.count, row: .note(note)))
                }
            }
        }
        if !snapshot.capacity.isEmpty {
            rows.append(UsageListRow(id: rows.count, row: .capacityHeader))
            for provider in snapshot.capacity.keys.sorted() {
                for window in snapshot.capacity[provider] ?? [] {
                    rows.append(UsageListRow(id: rows.count, row: .capacity(provider, window)))
                }
            }
        }
        if !snapshot.accountsWithoutUsage.isEmpty {
            rows.append(UsageListRow(id: rows.count, row: .accountsHeader))
            for account in snapshot.accountsWithoutUsage {
                rows.append(UsageListRow(id: rows.count, row: .account(account)))
            }
        }
        return List(rows, selection: $selection) { item in
            switch item.row {
            case .generated(let label):
                row("Generated", label, t)
            case .provider(let provider):
                Text(provider)
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(t.txtLabel)
            case .limit(let limit):
                limitRow(limit)
            case .note(let note):
                Text(note)
                    .font(.system(size: 11))
                    .foregroundColor(t.txtMuted)
            case .capacityHeader:
                Text("Capacity")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(t.txtLabel)
            case .capacity(let provider, let window):
                capacityRow(provider, window)
            case .accountsHeader:
                Text("Accounts without usage")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(t.txtLabel)
            case .account(let account):
                row(account.provider, account.email ?? account.orgName ?? account.accountId ?? "—", t)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func limitRow(_ limit: UsageLimit) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(limit.label)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(t.txt)
                Spacer()
                if let status = limit.status {
                    Text(status.rawValue)
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(statusColor(status))
                }
            }
            HStack(spacing: 6) {
                Text(amountLabel(limit.amount))
                    .font(.system(size: 12))
                    .foregroundColor(t.txtBody)
                Text(limit.amount.unit.rawValue)
                    .font(.system(size: 11))
                    .foregroundColor(t.txtMuted)
                Spacer()
                if let frac = limit.amount.usedFraction {
                    ProgressBar(value: frac, tint: t.accent, track: t.lineFaint)
                        .frame(width: 64, height: 4)
                }
            }
            if let window = limit.window {
                Text(window.label)
                    .font(.system(size: 10))
                    .foregroundColor(t.txtLabel)
            }
        }
        .padding(.vertical, 2)
    }

    private func capacityRow(_ provider: String, _ window: UsageCapacityWindow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(provider) · \(window.window)")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(t.txt)
            HStack(spacing: 6) {
                Text("\(Int(window.usedAccounts))/\(window.accounts)")
                    .font(.system(size: 12))
                    .foregroundColor(t.txtBody)
                Text("accounts")
                    .font(.system(size: 11))
                    .foregroundColor(t.txtMuted)
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

/// Flattened usage list rows (macOS `List` sections don't exist on Linux).
private struct UsageListRow: Identifiable {
    enum Row {
        case generated(String)
        case provider(String)
        case limit(UsageLimit)
        case note(String)
        case capacityHeader
        case capacity(String, UsageCapacityWindow)
        case accountsHeader
        case account(UsageAccountWithoutReport)
    }

    let id: Int
    let row: Row
}

// MARK: - Review pane

/// Code review findings (review.read): reviewId + status header, optional
/// path, then one row per finding (severity, message, line). Reads the latest
/// reviewId from `store.reviews(for:)` (fed by `review` additive frames) and
/// calls review.read on appear. Sample review when offline.
struct T4ReviewPane: View {
    let session: SessionRef
    let store: T4SessionStore
    let theme: ThemeStore
    @Binding var isPresented: Bool

    @State private var loading = true
    @State private var error: String?
    @State private var result: ReviewReadResult?
    @State private var selection: Int?
    private var t: Theme { theme.t }

    private var reviews: [ReviewFrame] { store.reviews(for: session.sessionId) }

    var body: some View {
        VStack(spacing: 0) {
            paneHeader
            Divider(t.line)
            if loading {
                Spacer()
                // LINUX-GAP: .tint(t.txtMuted) on ProgressView.
                ProgressView()
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
                    .foregroundColor(t.txtMuted)
                Spacer()
            }
        }
        .background(t.bg)
        .task { await load() }
    }

    /// Title + leading refresh (macOS toolbar's leading ToolbarItem, disabled
    /// while loading, disconnected, or with no review frame) and trailing Done.
    private var paneHeader: some View {
        HStack(spacing: 8) {
            T4TextButton("⟳") { Task { await load() } }
                .disabled(loading || !store.connected || reviews.isEmpty)
                .font(.system(size: 13, weight: .semibold))
            Spacer()
            Text("Review")
                    .lineLimit(1)
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(t.txt)
            Spacer()
            T4TextButton("Done") { isPresented = false }
                .font(.system(size: 14, weight: .semibold))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    /// Flattened row list: meta rows (Review/Status/Path), then the findings
    /// header + one row per finding, or a "clean" note when empty.
    private func reviewList(_ r: ReviewReadResult) -> some View {
        var rows: [ReviewListRow] = []
        rows.append(ReviewListRow(id: rows.count, row: .meta(key: "Review", value: r.reviewId)))
        rows.append(ReviewListRow(id: rows.count, row: .meta(key: "Status", value: r.status)))
        if let path = r.path {
            rows.append(ReviewListRow(id: rows.count, row: .meta(key: "Path", value: path)))
        }
        if r.findings.isEmpty {
            rows.append(ReviewListRow(id: rows.count, row: .clean))
        } else {
            rows.append(ReviewListRow(id: rows.count, row: .findingsHeader(r.findings.count)))
            for finding in r.findings {
                rows.append(ReviewListRow(id: rows.count, row: .finding(finding)))
            }
        }
        return List(rows, selection: $selection) { item in
            switch item.row {
            case .meta(let key, let value):
                row(key, value, t)
            case .clean:
                Text("No findings — review is clean.")
                    .font(.system(size: 13))
                    .foregroundColor(t.txtMuted)
            case .findingsHeader(let count):
                Text("Findings (\(count))")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(t.txtLabel)
            case .finding(let finding):
                findingRow(finding)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
                    .foregroundColor(severityColor(severity))
                if let path {
                    Text(path)
                        .font(.system(size: 11))
                        .foregroundColor(t.txtMuted)
                        .lineLimit(1)
                }
                Spacer()
                if let line {
                    Text("L\(line)")
                        .font(.system(size: 11))
                        .foregroundColor(t.txtLabel)
                }
            }
            Text(message)
                .font(.system(size: 13))
                .foregroundColor(t.txt)
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

/// Flattened review list rows (macOS `List` sections don't exist on Linux).
private struct ReviewListRow: Identifiable {
    enum Row {
        case meta(key: String, value: String)
        case clean
        case findingsHeader(Int)
        case finding(JSONValue)
    }

    let id: Int
    let row: Row
}

// MARK: - Artifacts pane

/// Session-retained artifacts: lists descriptors parsed from transcript
/// entries' `data.artifacts` arrays. Tapping a row calls artifact.read for
/// the first chunk (offset 0) and shows an inline preview — text/patch as
/// monospaced content, image/binary as a placeholder label (image decoding
/// lands with the wave-3 media representable).
struct T4ArtifactsPane: View {
    let session: SessionRef
    let store: T4SessionStore
    let theme: ThemeStore
    @Binding var isPresented: Bool

    @State private var expanded: String?   // artifactId currently previewing
    @State private var loading: String?    // artifactId currently fetching
    @State private var error: String?
    @State private var selection: String?
    private var t: Theme { theme.t }

    private var artifacts: [ArtifactDescriptor] { store.artifacts(for: session.sessionId) }

    var body: some View {
        VStack(spacing: 0) {
            paneHeader
            Divider(t.line)
            if artifacts.isEmpty {
                emptyState
            } else {
                List(artifacts.map { ArtifactRow(descriptor: $0) }, selection: $selection) { item in
                    artifactRow(item.descriptor)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if let error {
                paneError(error, t)
                    .padding(.bottom, 12)
            }
        }
        .background(t.bg)
    }

    /// Title + trailing Done (macOS toolbar; the artifacts pane has no
    /// refresh button).
    private var paneHeader: some View {
        HStack(spacing: 8) {
            Spacer()
            Text("Artifacts")
                    .lineLimit(1)
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(t.txt)
            Spacer()
            T4TextButton("Done") { isPresented = false }
                .font(.system(size: 14, weight: .semibold))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            // LINUX-GAP: Image(systemName: "paperclip") — text glyph stand-in.
            Text("❖")
                .font(.system(size: 28))
                .foregroundColor(t.txtMuted)
            Text("No artifacts")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(t.txt)
            Text("Artifacts produced by this session will appear here.")
                .font(.system(size: 12))
                .foregroundColor(t.txtMuted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func artifactRow(_ d: ArtifactDescriptor) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            // macOS wraps the row in a Button with a custom label; SwiftCrossUI
            // Button takes a String label only, so the whole row is tappable.
            HStack(spacing: 8) {
                // LINUX-GAP: Image(systemName: kindIcon(d.kind)) — text glyph.
                Text(kindIcon(d.kind))
                    .font(.system(size: 14))
                    .foregroundColor(kindColor(d.kind))
                VStack(alignment: .leading, spacing: 2) {
                    Text(d.name ?? "#\(d.artifactId)")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(t.txt)
                        .lineLimit(1)
                    Text("\(d.kind) · \(d.mediaType)")
                        .font(.system(size: 11))
                        .foregroundColor(t.txtMuted)
                }
                Spacer()
                if loading == d.artifactId {
                    // LINUX-GAP: .scaleEffect(0.7) on ProgressView.
                    ProgressView()
                } else {
                    Text(expanded == d.artifactId ? "▾" : "▸")
                        .font(.system(size: 11))
                        .foregroundColor(t.txtLabel)
                }
            }
            .onTapGesture {
                Task { await toggle(d) }
            }
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
                .foregroundColor(t.txtMuted)
        } else {
            Text("Tap to load preview")
                .font(.system(size: 12))
                .foregroundColor(t.txtLabel)
        }
    }

    @ViewBuilder
    private func chunkPreview(_ chunk: ArtifactReadChunk) -> some View {
        switch chunk.kind {
        case "text", "patch":
            if let bytes = chunk.decodedBytes, let text = String(data: bytes, encoding: .utf8) {
                Text(String(text.prefix(2048)))
                    .font(.term(12))
                    .foregroundColor(t.txtBody)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    // LINUX-GAP: `.background(in: RoundedRectangle(...))` shape
                    // fill — SwiftCrossUI backgrounds take a view instead.
                    .background(RoundedRectangle(cornerRadius: 8).fill(t.glassFill))
            } else {
                Text("Could not decode text content.")
                    .font(.system(size: 12))
                    .foregroundColor(t.txtMuted)
            }
        case "image":
            if let bytes = chunk.decodedBytes, platformImage(data: bytes) != nil {
                // LINUX-GAP: Image(platformImage:).resizable().scaledToFit()
                // needs a GdkPixbuf/ImageFormats decode representable — wave 3.
                Text("Image artifact (\(chunk.size) bytes) — image preview lands with the wave-3 media representable.")
                    .font(.system(size: 12))
                    .foregroundColor(t.txtMuted)
            } else {
                Text("Could not decode image.")
                    .font(.system(size: 12))
                    .foregroundColor(t.txtMuted)
            }
        default:
            Text("Binary · \(chunk.size) bytes")
                .font(.system(size: 12))
                .foregroundColor(t.txtMuted)
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

    /// Text glyph stand-ins for the macOS SF Symbols.
    private func kindIcon(_ k: String) -> String {
        switch k {
        case "image": return "▣"
        case "text": return "¶"
        case "patch": return "✎"
        default: return "▤"
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

/// Identifiable wrapper for the artifacts list (ArtifactDescriptor is not
/// Identifiable; macOS uses `ForEach(artifacts, id: \.artifactId)`).
private struct ArtifactRow: Identifiable {
    let descriptor: ArtifactDescriptor
    var id: String { descriptor.artifactId }
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
    let store: T4SessionStore
    let theme: ThemeStore
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
        VStack(spacing: 0) {
            paneHeader
            Divider(t.line)
            if loading {
                Spacer()
                // LINUX-GAP: .tint(t.txtMuted) on ProgressView.
                ProgressView()
                Spacer()
            } else if let error {
                Spacer()
                paneError(error, t)
                Spacer()
            } else {
                settingsList
            }
        }
        .background(t.bg)
        .sheet(isPresented: $addingKey) {
            addKeySheet
        }
        .task { await load() }
    }

    /// Title + leading refresh (macOS toolbar's leading ToolbarItem) and
    /// trailing Done.
    private var paneHeader: some View {
        HStack(spacing: 8) {
            T4TextButton("⟳") { Task { await load() } }
                .disabled(loading || !store.connected)
                .font(.system(size: 13, weight: .semibold))
            Spacer()
            Text("Settings")
                    .lineLimit(1)
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(t.txt)
            Spacer()
            T4TextButton("Done") { isPresented = false }
                .font(.system(size: 14, weight: .semibold))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var settingsList: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                modelsSection
                behaviorSection
                providersSection
                connectionSection
                appearanceSection
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 16)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(t.bg)
    }

    /// One settings group: a labeled card of rows, no hairline dividers — the
    /// card's padding does the grouping work the separators used to fake.
    @ViewBuilder
    private func settingsCard<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title.uppercased())
                .font(.system(size: 11, weight: .semibold))
                // LINUX-GAP: .tracking(0.8) (no letter-spacing modifier).
                .foregroundColor(t.txtLabel)
                .padding(.leading, 4)
            VStack(alignment: .leading, spacing: 2) { content() }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(t.bg2)
                // LINUX-GAP: .clipShape(RoundedRectangle(cornerRadius: 12,
                // style: .continuous)) → cornerRadius + stroke overlay.
                .cornerRadius(12)
                .overlay {
                    RoundedRectangle(cornerRadius: 12)
                        .stroke(t.lineFaint, style: StrokeStyle(width: 0.5))
                }
        }
    }

    /// One row inside a card: breathing room instead of a separator.
    @ViewBuilder
    private func cardRow<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        HStack { content() }
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: MODELS

    @ViewBuilder
    private var modelsSection: some View {
        settingsCard("Models") {
            if store.catalogModels.isEmpty {
                Text("No models in catalog")
                    .font(.system(size: 12))
                    .foregroundColor(t.txtMuted)
            } else {
                ForEach(roles, id: \.id) { role in
                    cardRow {
                        Text(role.label)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundColor(t.txt)
                        Spacer()
                        // LINUX-GAP: macOS Picker(label:selection:) with
                        // .pickerStyle(.menu) + .tint — SwiftCrossUI Picker
                        // takes options + Binding<Value?>; label is a sibling.
                        Picker(
                            of: ["default"] + store.catalogModels.map(\.id),
                            selection: Binding(
                                get: { roleValue(role.id) as String? },
                                set: { new in
                                    if let new { Task { await setRole(role.id, new) } }
                                }
                            )
                        )
                        .pickerStyle(.menu)
                    }
                }
            }
        }
    }

    // MARK: BEHAVIOR

    @ViewBuilder
    private var behaviorSection: some View {
        settingsCard("Behavior") {
            cardRow {
                Text("Thinking")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(t.txt)
                Spacer()
                Picker(
                    of: thinkingLevels,
                    selection: Binding(
                        get: { thinkingLevel() as String? },
                        set: { new in
                            if let new { Task { await setThinkingLevel(new) } }
                        }
                    )
                )
                .pickerStyle(.menu)
            }

            cardRow {
                Text("Tool approval")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(t.txt)
                Spacer()
                Picker(
                    of: approvalModes.map(\.label),
                    selection: Binding(
                        get: { approvalModes.first { $0.id == approvalMode() }?.label },
                        set: { new in
                            guard let new,
                                  let mode = approvalModes.first(where: { $0.label == new })
                            else { return }
                            Task { await setApprovalMode(mode.id) }
                        }
                    )
                )
                .pickerStyle(.menu)
            }
        }
    }

    // MARK: PROVIDERS & KEYS

    @ViewBuilder
    private var providersSection: some View {
        settingsCard("Providers & Keys") {
            let keys = providerKeys()
            if keys.isEmpty {
                Text("No provider keys set")
                    .font(.system(size: 12))
                    .foregroundColor(t.txtMuted)
            } else {
                ForEach(keys, id: \.provider) { entry in
                    cardRow {
                        Text(entry.provider)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundColor(t.txt)
                        Spacer()
                        Text(entry.masked)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundColor(t.txtMuted)
                            .lineLimit(1)
                    }
                }
            }
            cardRow {
                // LINUX-GAP: Label("Add provider key", systemImage: "plus").
                T4TextButton("+ Add provider key") {
                    addingKey = true
                }
                .font(.system(size: 13, weight: .semibold))
                .disabled(saving)
            }
        }
    }

    /// Add-provider-key sheet: provider name + write-only SecureField. The key
    /// is sent as a single-key providerKeys patch; the host masks on read, so
    /// the saved row never shows the raw key.
    private var addKeySheet: some View {
        VStack(spacing: 0) {
            HStack {
                T4TextButton("Cancel") { addingKey = false }
                Spacer()
                Text("Add provider key")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(t.txt)
                Spacer()
                T4TextButton("Save") {
                    Task { await addKey() }
                }
                .font(.system(size: 14, weight: .semibold))
                .disabled(saving || newKeyProvider.isEmpty || newKeyValue.isEmpty)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            Divider(t.line)
            VStack(alignment: .leading, spacing: 12) {
                // LINUX-GAP: Form + Section grouping → plain labeled fields.
                VStack(alignment: .leading, spacing: 4) {
                    Text("Provider")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(t.txtLabel)
                    TextField("e.g. openai", text: $newKeyProvider)
                        .padding(8)
                        .background {
                            RoundedRectangle(cornerRadius: t.r).fill(t.glassFill)
                        }
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("API key")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(t.txtLabel)
                    SecureField("sk-…", text: $newKeyValue)
                        .padding(8)
                        .background {
                            RoundedRectangle(cornerRadius: t.r).fill(t.glassFill)
                        }
                }
                if let error {
                    Text(error)
                        .font(.system(size: 12))
                        .foregroundColor(t.cAdvisor)
                }
            }
            .padding(14)
            Spacer()
        }
        .frame(minWidth: 360, minHeight: 240)
        .background(t.bg)
    }

    // MARK: CONNECTION

    @ViewBuilder
    private var connectionSection: some View {
        settingsCard("Connection") {
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
                cardRow {
                    Text("wss fingerprint")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(t.txt)
                    Spacer()
                    Text(String(fp.prefix(16)) + "…")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(t.txtMuted)
                        .lineLimit(1)
                }
            }
            // LINUX-GAP: the macOS pane adds a "Forget pinned cert" button
            // here (T4CertPinner.forget) — no cert-pinner seam on Linux, and
            // pinnedFingerprint is always nil, so the row + button are inert.
            cardRow {
                T4TextButton("Disconnect") {
                    Task { await store.disconnect() }
                }
                .disabled(!store.connected)
            }
        }
    }

    // MARK: APPEARANCE

    @ViewBuilder
    private var appearanceSection: some View {
        settingsCard("Appearance") {
            cardRow {
                Text("Theme")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(t.txt)
                Spacer()
                // LINUX-GAP: macOS binds the picker directly to $theme.mode;
                // SwiftCrossUI pickers display `"\(option)"`, so options are
                // human labels bridged to Appearance.
                Picker(
                    of: ["System", "Dark", "Light"],
                    selection: Binding(
                        get: { Self.appearanceLabel(theme.mode) as String? },
                        set: { new in
                            if let new { theme.mode = Self.appearance(from: new) }
                        }
                    )
                )
                .pickerStyle(.menu)
            }
        }
    }

    // MARK: Helpers

    @ViewBuilder
    private func hostRow(_ key: String, _ value: String) -> some View {
        cardRow {
            Text(key)
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(t.txt)
            Spacer()
            Text(value)
                .font(.system(size: 12, design: .monospaced))
                .foregroundColor(t.txtMuted)
                .lineLimit(1)
        }
    }

    private static func appearanceLabel(_ a: Appearance) -> String {
        switch a {
        case .system: return "System"
        case .dark: return "Dark"
        case .light: return "Light"
        }
    }

    private static func appearance(from label: String) -> Appearance {
        switch label {
        case "Dark": return .dark
        case "Light": return .light
        default: return .system
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
                for (k, v) in o {
                    if case .string(let m) = v { keys[k] = m }
                }
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
    ///
    /// LINUX-GAP: the macOS pane reads T4CertPinner.pinnedFingerprint(host:
    /// port:) — T4CertPinner is an iOS/macOS URLSessionDelegate seam with no
    /// Linux counterpart (the Linux transport pins in Seams/). The
    /// fingerprint row and forget button are therefore inert on Linux.
    private var pinnedFingerprint: String? {
        nil
    }

    private func load() async {
        loading = true
        error = nil
        if !store.connected {
            // Demo mode seeds a store-level snapshot for offline captures.
            snapshot = store.settingsSnapshot ?? [:]
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
@MainActor
private func row(_ key: String, _ value: String, _ t: Theme) -> some View {
    // LINUX-GAP: .firstTextBaseline alignment doesn't exist — .top is close.
    HStack(alignment: .top) {
        Text(key.uppercased())
            .font(.system(size: 10, weight: .semibold))
            .foregroundColor(t.txtLabel)
            .frame(width: 96, alignment: .leading)
        Text(value)
            .font(.system(size: 13))
            .foregroundColor(t.txtBody)
    }
}

/// Inline error banner for a pane (store.lastError style).
@MainActor
private func paneError(_ message: String, _ t: Theme) -> some View {
    VStack(spacing: 6) {
        // LINUX-GAP: Image(systemName: "exclamationmark.triangle.fill") —
        // text glyph stand-in.
        Text("⚠")
            .font(.system(size: 20))
            .foregroundColor(t.cAdvisor)
        Text(message)
            .font(.system(size: 12))
            .foregroundColor(t.txtBody)
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
