//  T4FilesPane.swift (Linux port of apps/ios/Sources/T4FilesPane.swift)
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
//
//  Linux port notes (per the shared porting contract):
//   • @EnvironmentObject theme → `let theme: ThemeStore` via init.
//   • NavigationStack → plain header (LINUX-GAP); back navigation stays in
//     the breadcrumb, exactly like macOS.
//   • macOS `.sheet(item: $viewedFile)` → sheet(isPresented:) with a
//     computed binding (SwiftCrossUI has no item-based sheet).
//   • Rows are tappable via onTapGesture — SwiftCrossUI Button takes a
//     String label only (macOS used a Button with a custom label view).

import Foundation
import SwiftCrossUI
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
/// `String` isn't Identifiable, so `navigationDestination(item:)` needs this;
/// on Linux it drives the sheet's computed binding instead).
private struct FileViewTarget: Identifiable, Equatable {
    let path: String
    var id: String { path }
}

/// Read-only file viewer for a single file's contents.
private struct FileViewer: View {
    let session: SessionRef
    let store: T4SessionStore
    let theme: ThemeStore
    let path: String
    @State private var content: String?
    @State private var size: Int?
    @State private var loading = true
    @State private var error: String?
    private var t: Theme { theme.t }

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 8) {
                // LINUX-GAP: Image(systemName: "doc.text") — text glyph.
                Text("¶")
                    .font(.system(size: 13))
                    .foregroundColor(t.txtMuted)
                Text(basename(path))
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(t.txt)
                    .lineLimit(1)
                Spacer()
                if let size {
                    Text(byteLabel(size))
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(t.txtLabel)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            Divider(t.line)
            if loading {
                Spacer()
                // LINUX-GAP: .tint(t.txtMuted) on ProgressView.
                ProgressView()
                Spacer()
            } else if let error {
                Spacer()
                Text(error)
                    .font(.system(size: 13))
                    .foregroundColor(t.cAdvisor)
                    .multilineTextAlignment(.center)
                    .padding(20)
                Spacer()
            } else if let content {
                ScrollView {
                    Text(content)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundColor(t.txt)
                        .textSelectionEnabled()
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(t.bg)
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
    let store: T4SessionStore
    let theme: ThemeStore
    @Binding var isPresented: Bool

    /// Navigation stack of directory paths, root-first. The last element is
    /// the currently displayed directory; "" is the workspace root.
    @State private var pathStack: [String] = [""]
    @State private var viewedFile: FileViewTarget?
    @State private var loading = true
    @State private var error: String?
    @State private var entries: [FileRow]?
    @State private var selection: String?

    private var t: Theme { theme.t }
    private var currentPath: String { pathStack.last ?? "" }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider(t.line)
            breadcrumb
            Divider(t.line)
            if loading {
                Spacer()
                // LINUX-GAP: .tint(t.txtMuted) on ProgressView.
                ProgressView()
                Spacer()
            } else if let error {
                Spacer()
                Text(error)
                    .font(.system(size: 13))
                    .foregroundColor(t.cAdvisor)
                    .multilineTextAlignment(.center)
                    .padding(20)
                Spacer()
            } else if let entries, entries.isEmpty {
                Spacer()
                Text("This folder is empty.")
                    .font(.system(size: 13))
                    .foregroundColor(t.txtMuted)
                Spacer()
            } else if let entries {
                list(entries)
            }
        }
        .background(t.bg)
        .sheet(isPresented: Binding(
            get: { viewedFile != nil },
            set: { showing in if !showing { viewedFile = nil } }
        )) {
            if let target = viewedFile {
                // LINUX-GAP: macOS presents FileViewer as a full-screen cover
                // on iOS / sheet on macOS; Linux always sheets it.
                FileViewer(session: session, store: store, theme: theme, path: target.path)
            }
        }
        .task(id: currentPath) { await load() }
        // The sheet can open before the host connection lands — retry then.
        .onChange(of: store.connected) {
            if store.connected { Task { await load() } }
        }
    }

    /// Title + trailing Done (macOS navigationTitle + toolbar).
    private var header: some View {
        HStack(spacing: 8) {
            Spacer()
            Text("Files")
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

    /// Breadcrumb of path segments; tap any crumb to pop back to that depth.
    private var breadcrumb: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 4) {
                // LINUX-GAP: tuple keypaths (\.offset / \.element) don't
                // typecheck in SwiftCrossUI's ForEach, and `pathStack.indices`
                // resolves to Swift 6.3's new `indices(where:)` (RangeSet) —
                // use an explicit index range; each crumb renders through a
                // plain helper function (no let/if statements in the builder).
                ForEach(0..<pathStack.count, id: \.self) { index in
                    crumbButton(index: index)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        }
    }

    /// One breadcrumb segment: a chevron prefix for non-root crumbs, then the
    /// path-segment button; tapping pops back to that depth.
    private func crumbButton(index: Int) -> some View {
        let path = pathStack[index]
        let isLast = index == pathStack.count - 1
        return HStack(spacing: 4) {
            if index > 0 {
                // LINUX-GAP: Image(systemName: "chevron.right") — text glyph.
                Text("›")
                    .font(.system(size: 9))
                    .foregroundColor(t.txtLabel)
            }
            // LINUX-GAP: SwiftCrossUI Button takes a String label only (no
            // label: builder), so the crumb's styled text is the Button's.
            T4TextButton(index == 0 ? "root" : basename(path)) {
                // Pop to this depth (drop everything after `index`).
                // LINUX-GAP: macOS slices `pathStack[0...index]`; the
                // slice/prefix-to-Array conversions trip Swift 6.3's
                // RangeSet overloads, so drop the tail in place.
                if index < pathStack.count - 1 {
                    pathStack.removeLast(pathStack.count - 1 - index)
                }
            }
            .font(.system(size: 12, weight: isLast ? .semibold : .regular))
            .foregroundColor(isLast ? t.txt : t.txtMuted)
        }
    }

    /// Sorted directory list: folders first, then files, each alphabetical.
    private func list(_ rows: [FileRow]) -> some View {
        let sorted = rows.sorted { a, b in
            if a.isDirectory != b.isDirectory { return a.isDirectory }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
        return List(sorted, selection: $selection) { row in
            HStack(spacing: 10) {
                // LINUX-GAP: Image(systemName: "folder.fill" / icon) — text
                // glyphs.
                Text(row.isDirectory ? "▣" : icon(for: row.name))
                    .font(.system(size: 15))
                    .foregroundColor(row.isDirectory ? t.accent : t.txtMuted)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text(row.name)
                        .font(.system(size: 14))
                        .foregroundColor(t.txt)
                        .lineLimit(1)
                    if let size = row.entry.size, !row.isDirectory {
                        Text(byteLabel(size))
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundColor(t.txtLabel)
                    }
                }
                Spacer()
                if row.isDirectory {
                    Text("›")
                        .font(.system(size: 11))
                        .foregroundColor(t.txtLabel)
                }
            }
            // macOS wraps the row in a Button with a custom label view;
            // SwiftCrossUI Button takes a String label only, so the row is
            // tappable via onTapGesture instead.
            .onTapGesture {
                if row.isDirectory {
                    pathStack.append(row.entry.path)
                } else {
                    viewedFile = FileViewTarget(path: row.entry.path)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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

    /// Text glyph stand-in for the macOS SF Symbol file icons, keyed by
    /// extension (a small, dependency-free guess).
    private func icon(for name: String) -> String {
        let ext = (name as NSString).pathExtension.lowercased()
        switch ext {
        case "swift": return "◈"
        case "ts", "tsx", "js", "jsx", "mjs", "cjs": return "¶"
        case "json": return "¶"
        case "md", "markdown": return "✎"
        case "png", "jpg", "jpeg", "gif", "webp", "svg": return "▣"
        case "lock": return "▦"
        default: return "▤"
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
