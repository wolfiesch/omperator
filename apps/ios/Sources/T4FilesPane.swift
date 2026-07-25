//  T4FilesPane.swift
//  Read-only workspace browser for one session. A sheet with a path
//  breadcrumb, a directory list (folders first, then files, with icons),
//  drill-in by tapping a folder, and a read-only file viewer (monospaced,
//  selectable) by tapping a file. Back navigation via the breadcrumb. Empty
//  directories and load errors render inline, store.lastError style.
//
//  Backed by T4SessionStore.listFiles / readFile, which send files.list and
//  files.read over host-wire. The host bounds content to MAX_FILE_BYTES and
//  validates every path as a safe relative POSIX path; this view only renders
//  what the host returns.

import SwiftUI
import HostWire

/// One row in the directory listing, sorted for display (folders first).
private struct FileRow: Identifiable {
    let entry: FileListEntry

    var id: String { entry.path }
    var isDirectory: Bool { entry.kind == "directory" }
    var name: String {
        // FileListEntry.path is the full relative path; show the last segment.
        if let slash = entry.path.lastIndex(of: "/") {
            return String(entry.path[entry.path.index(after: slash)...])
        }
        return entry.path
    }
}

/// Identifiable wrapper for a file-view navigation destination (a bare
/// `String` isn't Identifiable, so `navigationDestination(item:)` needs this).
private struct FileViewTarget: Identifiable, Equatable {
    let path: String
    var id: String { path }
}

/// Read-only file viewer for a single file's contents.
private struct FileViewer: View {
    let session: SessionRef
    let store: T4SessionStore
    let path: String
    @EnvironmentObject var theme: ThemeStore
    @State private var content: String?
    @State private var size: Int?
    @State private var loading = true
    @State private var error: String?
    private var t: Theme { theme.t }
    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "doc.text")
                    .font(.system(size: 13))
                    .foregroundStyle(t.txtMuted)
                Text(basename(path))
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(t.txt)
                    .lineLimit(1)
                Spacer()
                if let size {
                    Text(byteLabel(size))
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(t.txtLabel)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            Divider().background(t.line)
            if loading {
                Spacer()
                ProgressView()
                    .tint(t.txtMuted)
                Spacer()
            } else if let error {
                Spacer()
                Text(error)
                    .font(.system(size: 13))
                    .foregroundStyle(t.cAdvisor)
                    .multilineTextAlignment(.center)
                    .padding(20)
                Spacer()
            } else if let content {
                ScrollView {
                    Text(content)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(t.txt)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                }
            }
        }
        .background(t.bg.ignoresSafeArea())
        .task { await load() }
    }

    private func load() async {
        loading = true
        error = nil
        let result = await store.readFile(sessionId: session.sessionId, path: path)
        loading = false
        if let result {
            content = result
            size = result.utf8.count
        } else {
            error = store.lastError ?? "Couldn’t read this file."
        }
    }
}

/// The files browser sheet. Presented at the project root (path "") and
/// drills into subdirectories by pushing onto `pathStack`.
struct T4FilesPane: View {
    let session: SessionRef
    @ObservedObject var store: T4SessionStore
    @EnvironmentObject var theme: ThemeStore
    @Binding var isPresented: Bool

    /// Navigation stack of directory paths, root-first. The last element is
    /// the currently displayed directory; "" is the workspace root.
    @State private var pathStack: [String] = [""]
    @State private var viewedFile: FileViewTarget?
    @State private var loading = true
    @State private var error: String?
    @State private var entries: [FileRow]?

    private var t: Theme { theme.t }
    private var currentPath: String { pathStack.last ?? "" }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                breadcrumb
                Divider().background(t.line)
                if loading {
                    Spacer()
                    ProgressView().tint(t.txtMuted)
                    Spacer()
                } else if let error {
                    Spacer()
                    Text(error)
                        .font(.system(size: 13))
                        .foregroundStyle(t.cAdvisor)
                        .multilineTextAlignment(.center)
                        .padding(20)
                    Spacer()
                } else if let entries, entries.isEmpty {
                    Spacer()
                    Text("This folder is empty.")
                        .font(.system(size: 13))
                        .foregroundStyle(t.txtMuted)
                    Spacer()
                } else if let entries {
                    list(entries)
                }
            }
            .background(t.bg.ignoresSafeArea())
            .navigationTitle("Files")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { isPresented = false }
                        .font(.system(size: 14, weight: .semibold))
                }
            }
            .fullScreenCover(item: $viewedFile) { target in
                FileViewer(session: session, store: store, path: target.path)
                    .environmentObject(theme)
            }
        }
        .task(id: currentPath) { await load() }
    }

    /// Breadcrumb of path segments; tap any crumb to pop back to that depth.
    private var breadcrumb: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(Array(pathStack.enumerated()), id: \.offset) { index, path in
                    if index > 0 {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9))
                            .foregroundStyle(t.txtLabel)
                    }
                    Button {
                        // Pop to this depth (drop everything after `index`).
                        pathStack = Array(pathStack[0...index])
                    } label: {
                        Text(index == 0 ? "root" : basename(path))
                            .font(.system(size: 12, weight: index == pathStack.count - 1 ? .semibold : .regular))
                            .foregroundStyle(index == pathStack.count - 1 ? t.txt : t.txtMuted)
                    }
                    .accessibilityLabel("Navigate to \(index == 0 ? "root" : basename(path))")
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        }
    }

    /// Sorted directory list: folders first, then files, each alphabetical.
    private func list(_ rows: [FileRow]) -> some View {
        let sorted = rows.sorted { a, b in
            if a.isDirectory != b.isDirectory { return a.isDirectory }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
        return List {
            ForEach(sorted) { row in
                Button {
                    if row.isDirectory {
                        pathStack.append(row.entry.path)
                    } else {
                        viewedFile = FileViewTarget(path: row.entry.path)
                    }
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: row.isDirectory ? "folder.fill" : icon(for: row.name))
                            .font(.system(size: 15))
                            .foregroundStyle(row.isDirectory ? t.accent : t.txtMuted)
                            .frame(width: 22)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(row.name)
                                .font(.system(size: 14))
                                .foregroundStyle(t.txt)
                                .lineLimit(1)
                            if let size = row.entry.size, !row.isDirectory {
                                Text(byteLabel(size))
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundStyle(t.txtLabel)
                            }
                        }
                        Spacer()
                        if row.isDirectory {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 11))
                                .foregroundStyle(t.txtLabel)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .listRowBackground(Color.clear)
                .listRowSeparatorTint(t.lineFaint)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
    }

    /// Fetch the current directory listing.
    private func load() async {
        loading = true
        error = nil
        let result = await store.listFiles(sessionId: session.sessionId, path: currentPath)
        loading = false
        if let result {
            entries = result.map { FileRow(entry: $0) }
        } else {
            entries = nil
            error = store.lastError ?? "Couldn’t list this folder."
        }
    }

    /// SF Symbol for a file by extension (a small, dependency-free guess).
    private func icon(for name: String) -> String {
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
}

/// Last path segment of a relative POSIX path ("" → "").
private func basename(_ path: String) -> String {
    if let slash = path.lastIndex(of: "/") {
        return String(path[path.index(after: slash)...])
    }
    return path
}

/// Human-readable byte count (1024-based, two significant figures).
private func byteLabel(_ bytes: Int) -> String {
    if bytes < 1024 { return "\(bytes) B" }
    let kb = Double(bytes) / 1024
    if kb < 1024 { return String(format: "%.1f KB", kb) }
    let mb = kb / 1024
    if mb < 1024 { return String(format: "%.1f MB", mb) }
    return String(format: "%.1f GB", mb / 1024)
}
