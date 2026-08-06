//  T4SearchPane.swift (Linux port of apps/ios/Sources/T4SearchPane.swift)
//  Workspace search & diff sheet for one session. Two modes behind a
//  segmented control:
//
//  • Search — debounced (300ms) files.search by file-name substring. The host
//    returns up to 50 matches as safe relative POSIX paths (the wire result
//    carries only `path` — no kind/size — so rows show the basename, the
//    parent directory, and a file/folder icon guessed from the extension).
//    Tapping a row loads the file content inline below it via files.read.
//
//  • Diff — files.diff. With no turn id the host returns `{diff}` patch text,
//    rendered with SyntaxHighlighter.diff +/- line tinting. With a turn id the
//    host returns a turn review snapshot `{turnId, baseTree, headTree, changes,
//    patch?}`; the patch artifact is read via artifact.read and the change list
//    is rendered when no patch text is available.
//
//  Backed by T4SessionStore.filesSearch / filesDiff / readFile. files.* is a
//  desktop-bridge operation — standalone hosts don't implement it, and the
//  pane shows the honest failure from store.lastError.
//
//  Linux port notes:
//  • SF Symbols → text glyphs; `.textSelection(.enabled)` →
//    `.textSelectionEnabled()` (inert on Gtk).
//  • SyntaxHighlighter is a cross-agent type (TranscriptAgent's port); the
//    macOS AttributedString wrap is dropped for the String-returning form.
//  • The diff change list is a ScrollView (SwiftCrossUI List rows are
//    selection-bound).

import Foundation
import SwiftCrossUI
import HostWire

// Wire result models (FilesSearchMatch/Result, TurnFileChange,
// FilesDiffResult) live in FilesResultModels.swift — shared with the
// Linux store layer.

// MARK: - Pane

struct T4SearchPane: View {
    let session: SessionRef
    let store: T4SessionStore
    let theme: ThemeStore
    @Binding var isPresented: Bool

    private enum Mode: Hashable, CustomStringConvertible {
        case search, diff
        var description: String { self == .search ? "Search" : "Diff" }
    }

    @State private var mode: Mode = .search
    @State private var query = ""
    @State private var turnId = ""
    @State private var searchResults: FilesSearchResult?
    @State private var searching = false
    @State private var searchError: String?
    @State private var expandedPath: String?
    @State private var fileContent: [String: String] = [:]
    @State private var loadingContent: Set<String> = []
    @State private var failedContent: Set<String> = []
    @State private var patchText: String?
    @State private var diffChanges: [TurnFileChange] = []
    @State private var loadingDiff = false
    @State private var diffError: String?
    @State private var searchTask: Task<Void, Never>?
    @State private var diffTask: Task<Void, Never>?

    private var t: Theme { theme.t }

    init(
        session: SessionRef,
        store: T4SessionStore,
        theme: ThemeStore,
        isPresented: Binding<Bool>
    ) {
        self.session = session
        self.store = store
        self.theme = theme
        self._isPresented = isPresented
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header (replaces the navigation toolbar + Done item).
            HStack(spacing: 10) {
                Text("Search & Diff")
                    // Capture seam: -T4SearchQuery=q pre-fills and runs a search.
                    .onAppear {
                        if let raw = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("-T4SearchQuery=") }),
                           query.isEmpty {
                            query = String(raw.dropFirst("-T4SearchQuery=".count))
                            Task { await runSearch(query) }
                        }
                    }
                    .lineLimit(1)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(t.txt)
                Spacer()
                T4TextButton("Done") { isPresented = false }
                    .font(.system(size: 14, weight: .semibold))
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 14)

            Divider(t.line)

            Picker(
                of: [Mode.search, Mode.diff],
                selection: Binding(
                    get: { mode },
                    set: { newValue in
                        if let newValue { mode = newValue }
                    }
                )
            )
            // LINUX-GAP: macOS uses .segmented; GtkBackend supports only .menu.
            .pickerStyle(.menu)
            .padding(12)

            if mode == .search {
                searchBar
                Divider(t.line)
                searchBody
            } else {
                diffBar
                Divider(t.line)
                diffBody
            }
        }
        .frame(width: 560, height: 520)
        .background(t.bg)
        .onChange(of: mode) {
            if mode == .diff { Task { await runDiff(turnId) } }
            else { Task { await runSearch(query) } }
        }
        // The sheet can open before the host connection lands — retry then.
        .onChange(of: store.connected) {
            if store.connected {
                if mode == .search { Task { await runSearch(query) } }
                else { Task { await runDiff(turnId) } }
            }
        }
    }

    // MARK: Search

    private var searchBar: some View {
        HStack(spacing: 8) {
            // LINUX-GAP: magnifyingglass SF Symbol → "⌕" glyph
            Text("⌕")
                .font(.system(size: 13))
                .foregroundColor(t.txtMuted)
            TextField("Search files by name…", text: $query)
                .font(.system(size: 14))
                .onChange(of: query) { scheduleSearch() }
            if searching {
                ProgressView()
            } else if !query.isEmpty {
                T4TextButton("✕") {
                    query = ""
                    searchResults = nil
                    searchError = nil
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background { RoundedRectangle(cornerRadius: 10).fill(t.lineFaint) }
        .padding(.horizontal, 12)
    }

    @ViewBuilder
    private var searchBody: some View {
        if searching && searchResults == nil {
            Spacer()
            ProgressView()
            Spacer()
        } else if let searchError, searchResults == nil {
            Spacer()
            Text(searchError)
                .font(.system(size: 13))
                .foregroundColor(t.cAdvisor)
                .multilineTextAlignment(.center)
                .padding(20)
            Spacer()
        } else if let results = searchResults, results.matches.isEmpty {
            Spacer()
            Text("No matching files.")
                .font(.system(size: 13))
                .foregroundColor(t.txtMuted)
            Spacer()
        } else if let results = searchResults {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if results.truncated {
                        Text("Results truncated — refine your query.")
                            .font(.system(size: 10))
                            .foregroundColor(t.txtLabel)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 6)
                    }
                    ForEach(results.matches) { match in
                        resultRow(match)
                        Divider(t.lineFaint)
                            .padding(.leading, 36)
                    }
                }
            }
        } else {
            Spacer()
            VStack(spacing: 8) {
                Text("⌕")
                    .font(.system(size: 28))
                    .foregroundColor(t.txtLabel)
                Text("Search the workspace by file name.")
                    .font(.system(size: 13))
                    .foregroundColor(t.txtMuted)
            }
            Spacer()
        }
    }

    /// One search result row. Tapping toggles an inline preview that loads the
    /// file content via files.read (cached per path for the sheet's lifetime).
    private func resultRow(_ match: FilesSearchMatch) -> some View {
        let isDir = match.path.hasSuffix("/")
        let name = basename(match.path)
        let dir = directory(match.path)
        let expanded = expandedPath == match.path
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Text(isDir ? "▣" : fileIcon(for: name))
                    .font(.system(size: 15))
                    .foregroundColor(isDir ? t.accent : t.txtMuted)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text(name)
                        .font(.system(size: 14))
                        .foregroundColor(t.txt)
                        .lineLimit(1)
                    if !dir.isEmpty {
                        Text(dir)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundColor(t.txtLabel)
                            .lineLimit(1)
                    }
                }
                Spacer()
                Text(expanded ? "▾" : "▸")
                    .font(.system(size: 11))
                    .foregroundColor(t.txtLabel)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .onTapGesture { Task { await toggle(match.path) } }
            if expanded {
                contentPreview(match.path)
            }
        }
        .background(t.bg)
    }

    @ViewBuilder
    private func contentPreview(_ path: String) -> some View {
        if loadingContent.contains(path) {
            HStack(spacing: 6) {
                ProgressView()
                Text("Loading…")
                    .font(.system(size: 11))
                    .foregroundColor(t.txtMuted)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(t.lineFaint)
        } else if let content = fileContent[path] {
            ScrollView(.horizontal) {
                Text(String(content.prefix(4000)))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(t.txtBody)
                    .textSelectionEnabled()
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(t.lineFaint)
        } else {
            Text("Couldn’t read this file.")
                .font(.system(size: 11))
                .foregroundColor(t.cAdvisor)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(t.lineFaint)
        }
    }

    private func scheduleSearch() {
        searchTask?.cancel()
        let q = query
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 300_000_000)
            if Task.isCancelled { return }
            await runSearch(q)
        }
    }

    private func runSearch(_ q: String) async {
        let trimmed = q.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            searchResults = nil
            searching = false
            searchError = nil
            return
        }
        searching = true
        searchError = nil
        let result = await store.filesSearch(sessionId: session.sessionId, query: trimmed)
        searching = false
        if let result {
            searchResults = result
        } else {
            searchResults = nil
            searchError = store.lastError ?? "Search failed."
        }
    }

    /// Toggle a row's inline preview, loading content on first expand.
    private func toggle(_ path: String) async {
        if expandedPath == path {
            expandedPath = nil
            return
        }
        expandedPath = path
        if fileContent[path] == nil && !failedContent.contains(path) {
            loadingContent.insert(path)
            let content = await store.readFile(sessionId: session.sessionId, path: path)
            loadingContent.remove(path)
            if let content {
                fileContent[path] = content
            } else {
                failedContent.insert(path)
            }
        }
    }

    // MARK: Diff

    private var diffBar: some View {
        VStack(spacing: 6) {
            HStack(spacing: 8) {
                // LINUX-GAP: arrow.triangle.branch SF Symbol → "⎇" glyph
                Text("⎇")
                    .font(.system(size: 13))
                    .foregroundColor(t.txtMuted)
                TextField("Turn id (optional)", text: $turnId)
                    .font(.system(size: 13, design: .monospaced))
                    .onChange(of: turnId) { scheduleDiff() }
                if loadingDiff {
                    ProgressView()
                } else {
                    T4TextButton("⟳") { Task { await runDiff(turnId) } }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background { RoundedRectangle(cornerRadius: 10).fill(t.lineFaint) }

            Text("Leave blank for the working-tree diff; set a turn id for that turn’s review snapshot.")
                .font(.system(size: 10))
                .foregroundColor(t.txtLabel)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 14)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private var diffBody: some View {
        if loadingDiff {
            Spacer()
            ProgressView()
            Spacer()
        } else if let patchText {
            ScrollView {
                // Cross-agent type (TranscriptAgent): the Linux
                // SyntaxHighlighter port returns a String; the macOS
                // AttributedString wrap is dropped (LINUX-GAP).
                Text(SyntaxHighlighter.diff(patchText, theme: t, fontSize: 12))
                    .textSelectionEnabled()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
        } else if !diffChanges.isEmpty {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(diffChanges) { change in
                        HStack(spacing: 8) {
                            Text(changeIcon(change.status))
                                .font(.system(size: 13))
                                .foregroundColor(changeColor(change.status))
                                .frame(width: 20)
                            Text(change.path)
                                .font(.system(size: 13, design: .monospaced))
                                .foregroundColor(t.txt)
                                .lineLimit(1)
                            Spacer()
                            Text("+\(change.additions) −\(change.deletions)")
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundColor(t.txtLabel)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 6)
                        Divider(t.lineFaint)
                    }
                }
                .padding(.vertical, 6)
            }
        } else if let diffError {
            Spacer()
            Text(diffError)
                .font(.system(size: 13))
                .foregroundColor(t.cAdvisor)
                .multilineTextAlignment(.center)
                .padding(20)
            Spacer()
        } else {
            Spacer()
            VStack(spacing: 8) {
                Text("⎇")
                    .font(.system(size: 28))
                    .foregroundColor(t.txtLabel)
                Text("No diff available for this session.")
                    .font(.system(size: 13))
                    .foregroundColor(t.txtMuted)
            }
            Spacer()
        }
    }

    private func scheduleDiff() {
        diffTask?.cancel()
        let tid = turnId
        diffTask = Task {
            try? await Task.sleep(nanoseconds: 300_000_000)
            if Task.isCancelled { return }
            await runDiff(tid)
        }
    }

    private func runDiff(_ tid: String) async {
        loadingDiff = true
        diffError = nil
        let trimmed = tid.trimmingCharacters(in: .whitespacesAndNewlines)
        let result = await store.filesDiff(sessionId: session.sessionId,
                                           turnId: trimmed.isEmpty ? nil : trimmed)
        loadingDiff = false
        if let result {
            patchText = result.patchText
            diffChanges = result.changes
            if result.patchText == nil && result.changes.isEmpty {
                diffError = "No diff available for this session."
            }
        } else {
            patchText = nil
            diffChanges = []
            diffError = store.lastError ?? "Diff failed."
        }
    }

    // MARK: Helpers

    /// Text glyph for a file by extension (SF Symbols don't exist on Linux;
    /// the macOS names are replaced with a dependency-free guess).
    private func fileIcon(for name: String) -> String {
        let ext = (name as NSString).pathExtension.lowercased()
        switch ext {
        case "swift": return "s"
        case "ts", "tsx", "js", "jsx", "mjs", "cjs", "json": return "{}"
        case "md", "markdown": return "¶"
        case "png", "jpg", "jpeg", "gif", "webp", "svg": return "▧"
        case "lock": return "⚿"
        default: return "·"
        }
    }

    private func changeIcon(_ status: String) -> String {
        switch status {
        case "added":       return "+"
        case "deleted":     return "−"
        case "modified":    return "±"
        case "renamed", "copied": return "⇄"
        case "untracked":   return "?"
        default:            return "·"
        }
    }

    private func changeColor(_ status: String) -> Color {
        switch status {
        case "added", "untracked": return t.diffAdd
        case "deleted":            return t.diffDel
        default:                   return t.txtMuted
        }
    }
}

// MARK: - Path helpers

/// Last path segment of a relative POSIX path ("" → "").
private func basename(_ path: String) -> String {
    if let slash = path.lastIndex(of: "/") {
        return String(path[path.index(after: slash)...])
    }
    return path
}

/// Directory prefix of a relative POSIX path (everything before the final
/// slash); "" for a bare name or the root.
private func directory(_ path: String) -> String {
    if let slash = path.lastIndex(of: "/") {
        return String(path[..<slash])
    }
    return ""
}
