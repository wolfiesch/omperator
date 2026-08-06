//  T4SearchPane.swift
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

import SwiftUI
import HostWire

// Wire result models (FilesSearchMatch/Result, TurnFileChange,
// FilesDiffResult) now live in FilesResultModels.swift — shared with the
// Linux store layer.

// MARK: - Pane

struct T4SearchPane: View {
    let session: SessionRef
    @ObservedObject var store: T4SessionStore
    @EnvironmentObject var theme: ThemeStore
    @Binding var isPresented: Bool

    private enum Mode: Hashable { case search, diff }

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

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Mode", selection: $mode) {
                    Text("Search").tag(Mode.search)
                    Text("Diff").tag(Mode.diff)
                }
                .pickerStyle(.segmented)
                .padding(12)

                if mode == .search {
                    searchBar
                    Divider().background(t.line)
                    searchBody
                } else {
                    diffBar
                    Divider().background(t.line)
                    diffBody
                }
            }
            .background(t.bg.ignoresSafeArea())
            .navigationTitle("Search & Diff")
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
        .onChange(of: mode) { _, newMode in
            if newMode == .diff { Task { await runDiff(turnId) } }
            else { Task { await runSearch(query) } }
        }
        // The sheet can open before the host connection lands — retry then.
        .onChange(of: store.connected) { _, now in
            if now {
                if mode == .search { Task { await runSearch(query) } }
                else { Task { await runDiff(turnId) } }
            }
        }
    }

    // MARK: Search

    private var searchBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 13))
                .foregroundStyle(t.txtMuted)
            TextField("Search files by name…", text: $query)
                .font(.system(size: 14))
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
                .onChange(of: query) { _, _ in scheduleSearch() }
            if searching {
                ProgressView().scaleEffect(0.8).tint(t.txtMuted)
            } else if !query.isEmpty {
                Button {
                    query = ""
                    searchResults = nil
                    searchError = nil
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(t.txtLabel)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(t.lineFaint, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.horizontal, 12)
    }

    @ViewBuilder
    private var searchBody: some View {
        if searching && searchResults == nil {
            Spacer()
            ProgressView().tint(t.txtMuted)
            Spacer()
        } else if let searchError, searchResults == nil {
            Spacer()
            Text(searchError)
                .font(.system(size: 13))
                .foregroundStyle(t.cAdvisor)
                .multilineTextAlignment(.center)
                .padding(20)
            Spacer()
        } else if let results = searchResults, results.matches.isEmpty {
            Spacer()
            Text("No matching files.")
                .font(.system(size: 13))
                .foregroundStyle(t.txtMuted)
            Spacer()
        } else if let results = searchResults {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if results.truncated {
                        Text("Results truncated — refine your query.")
                            .font(.system(size: 10))
                            .foregroundStyle(t.txtLabel)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 6)
                    }
                    ForEach(results.matches) { match in
                        resultRow(match)
                        Divider()
                            .background(t.lineFaint)
                            .padding(.leading, 36)
                    }
                }
            }
        } else {
            Spacer()
            VStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 28))
                    .foregroundStyle(t.txtLabel)
                Text("Search the workspace by file name.")
                    .font(.system(size: 13))
                    .foregroundStyle(t.txtMuted)
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
            Button {
                Task { await toggle(match.path) }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: isDir ? "folder.fill" : fileIcon(for: name))
                        .font(.system(size: 15))
                        .foregroundStyle(isDir ? t.accent : t.txtMuted)
                        .frame(width: 22)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(name)
                            .font(.system(size: 14))
                            .foregroundStyle(t.txt)
                            .lineLimit(1)
                        if !dir.isEmpty {
                            Text(dir)
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(t.txtLabel)
                                .lineLimit(1)
                        }
                    }
                    Spacer()
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 11))
                        .foregroundStyle(t.txtLabel)
                }
                .contentShape(Rectangle())
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
            }
            .buttonStyle(.plain)
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
                ProgressView().scaleEffect(0.7).tint(t.txtMuted)
                Text("Loading…")
                    .font(.system(size: 11))
                    .foregroundStyle(t.txtMuted)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(t.lineFaint)
        } else if let content = fileContent[path] {
            ScrollView(.horizontal, showsIndicators: false) {
                Text(String(content.prefix(4000)))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(t.txtBody)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(t.lineFaint)
        } else {
            Text("Couldn’t read this file.")
                .font(.system(size: 11))
                .foregroundStyle(t.cAdvisor)
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
                Image(systemName: "arrow.triangle.branch")
                    .font(.system(size: 13))
                    .foregroundStyle(t.txtMuted)
                TextField("Turn id (optional)", text: $turnId)
                    .font(.system(size: 13, design: .monospaced))
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                    .onChange(of: turnId) { _, _ in scheduleDiff() }
                if loadingDiff {
                    ProgressView().scaleEffect(0.8).tint(t.txtMuted)
                } else {
                    Button {
                        Task { await runDiff(turnId) }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 13))
                            .foregroundStyle(t.txtMuted)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(t.lineFaint, in: RoundedRectangle(cornerRadius: 10, style: .continuous))

            Text("Leave blank for the working-tree diff; set a turn id for that turn’s review snapshot.")
                .font(.system(size: 10))
                .foregroundStyle(t.txtLabel)
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
            ProgressView().tint(t.txtMuted)
            Spacer()
        } else if let patchText {
            ScrollView {
                Text(AttributedString(SyntaxHighlighter.diff(patchText, theme: t, fontSize: 12)))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
        } else if !diffChanges.isEmpty {
            List {
                ForEach(diffChanges) { change in
                    HStack(spacing: 8) {
                        Image(systemName: changeIcon(change.status))
                            .font(.system(size: 13))
                            .foregroundStyle(changeColor(change.status))
                            .frame(width: 20)
                        Text(change.path)
                            .font(.system(size: 13, design: .monospaced))
                            .foregroundStyle(t.txt)
                            .lineLimit(1)
                        Spacer()
                        Text("+\(change.additions) −\(change.deletions)")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(t.txtLabel)
                    }
                    .listRowBackground(Color.clear)
                    .listRowSeparatorTint(t.lineFaint)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
        } else if let diffError {
            Spacer()
            Text(diffError)
                .font(.system(size: 13))
                .foregroundStyle(t.cAdvisor)
                .multilineTextAlignment(.center)
                .padding(20)
            Spacer()
        } else {
            Spacer()
            VStack(spacing: 8) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.system(size: 28))
                    .foregroundStyle(t.txtLabel)
                Text("No diff available for this session.")
                    .font(.system(size: 13))
                    .foregroundStyle(t.txtMuted)
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

    /// SF Symbol for a file by extension (dependency-free guess).
    private func fileIcon(for name: String) -> String {
        let ext = (name as NSString).pathExtension.lowercased()
        switch ext {
        case "swift": return "swift"
        case "ts", "tsx", "js", "jsx", "mjs", "cjs": return "doc.text"
        case "json": return "doc.text"
        case "md", "markdown": return "doc.richtext"
        case "png", "jpg", "jpeg", "gif", "webp", "svg": return "photo"
        case "lock": return "lock.doc"
        default: return "doc"
        }
    }

    private func changeIcon(_ status: String) -> String {
        switch status {
        case "added":       return "plus.circle"
        case "deleted":     return "minus.circle"
        case "modified":    return "pencil.circle"
        case "renamed", "copied": return "arrow.triangle.swap"
        case "untracked":   return "questionmark.circle"
        default:            return "circle"
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
