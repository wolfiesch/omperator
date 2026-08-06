import Foundation
import HostWire

@MainActor
extension T4SessionStore {
    // MARK: - Files (read-only workspace browser)

    func listFiles(sessionId: String, path: String) async -> [FileListEntry]? {
        guard let client, connected, !hostId.isEmpty else {
            if Self.demoMode { return Self.sampleFileList(path: path) }
            lastError = "Not connected to a host."
            return nil
        }
        var args: [String: JSONValue] = [:]
        if !path.isEmpty { args["path"] = .string(path) }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "files.list", args: args, sessionId: sessionId))
            return try result.filesListResult()
        } catch {
            t4log.error("files.list failed: \(error)")
            lastError = "This host has no files bridge (desktop hosts only)."
            return nil
        }
    }

    func readFile(sessionId: String, path: String) async -> String? {
        guard let client, connected, !hostId.isEmpty else {
            if Self.demoMode { return Self.sampleFileContent(path: path) }
            lastError = "Not connected to a host."
            return nil
        }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "files.read",
                args: ["path": .string(path)], sessionId: sessionId))
            let (content, _) = try result.filesReadResult()
            return content
        } catch {
            t4log.error("files.read failed: \(error)")
            lastError = "\(error)"
            return nil
        }
    }

    func filesSearch(sessionId: String, query: String) async -> FilesSearchResult? {
        guard let client, connected, !hostId.isEmpty else {
            if Self.demoMode { return Self.sampleSearchResults(query: query) }
            lastError = "Not connected to a host."
            return nil
        }
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return FilesSearchResult(matches: [], truncated: false) }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "files.search",
                args: ["query": .string(trimmed)], sessionId: sessionId))
            return Self.decodeFilesSearchResult(result)
        } catch {
            t4log.error("files.search failed: \(error)")
            lastError = "This host has no files bridge (desktop hosts only)."
            return nil
        }
    }

    func filesDiff(sessionId: String, turnId: String? = nil) async -> FilesDiffResult? {
        guard let client, connected, !hostId.isEmpty else {
            if Self.demoMode { return Self.sampleDiffResult }
            lastError = "Not connected to a host."
            return nil
        }
        var args: [String: JSONValue] = [:]
        if let turnId, !turnId.isEmpty { args["turnId"] = .string(turnId) }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "files.diff", args: args, sessionId: sessionId))
            guard result.ok, let body = result.result, case .object(let o) = body else {
                lastError = "files.diff returned no result."
                return nil
            }
            if case .string(let diff) = o["diff"] ?? .null {
                return FilesDiffResult(patchText: diff, changes: [])
            }
            let changes = Self.parseTurnChanges(o["changes"] ?? .null)
            var patchText: String?
            if case .object(let pd) = o["patch"] ?? .null,
               case .string(let artifactId) = pd["artifactId"] ?? .null {
                if let chunk = await artifactRead(sessionId: sessionId, artifactId: artifactId),
                   let data = chunk.decodedBytes {
                    patchText = String(data: data, encoding: .utf8)
                }
            }
            return FilesDiffResult(patchText: patchText, changes: changes)
        } catch {
            t4log.error("files.diff failed: \(error)")
            lastError = "This host has no files bridge (desktop hosts only)."
            return nil
        }
    }

    private static func decodeFilesSearchResult(_ result: ResultFrame) -> FilesSearchResult? {
        guard result.ok, let body = result.result, case .object(let o) = body else { return nil }
        let truncated = (o["truncated"] ?? .null) == .bool(true)
        let matches: [FilesSearchMatch] = {
            guard case .array(let arr) = o["matches"] ?? .null else { return [] }
            return arr.compactMap { value in
                guard case .object(let match) = value,
                      case .string(let path) = match["path"] ?? .null else { return nil }
                return FilesSearchMatch(path: path)
            }
        }()
        return FilesSearchResult(matches: matches, truncated: truncated)
    }

    private static func parseTurnChanges(_ value: JSONValue) -> [TurnFileChange] {
        guard case .array(let changes) = value else { return [] }
        return changes.compactMap { value in
            guard case .object(let change) = value,
                  case .string(let path) = change["path"] ?? .null,
                  case .string(let status) = change["status"] ?? .null,
                  case .string(let kind) = change["kind"] ?? .null else { return nil }
            return TurnFileChange(
                path: path,
                status: status,
                kind: kind,
                additions: intField(change["additions"]),
                deletions: intField(change["deletions"])
            )
        }
    }

    private static func intField(_ value: JSONValue?) -> Int {
        if case .number(let number) = value, number.isFinite, number >= 0 {
            return Int(number)
        }
        return 0
    }
}

// MARK: - Demo file samples (offline captures)

extension T4SessionStore {
    /// Workspace tree for the files pane in demo mode.
    static func sampleFileList(path: String) -> [FileListEntry] {
        let rows: [(String, String, Int?)]
        switch path {
        case "Sources", "Sources/":
            rows = [
                ("Sources/Gtk", "directory", nil),
                ("Sources/GtkBackend", "directory", nil),
                ("Sources/SwiftCrossUI", "directory", nil),
                ("Sources/T4CodeLinuxLib", "directory", nil),
            ]
        case "Sources/Gtk/Widgets", "Sources/Gtk/Widgets/":
            rows = [
                ("Sources/Gtk/Widgets/ScrolledWindow.swift", "file", 2412),
                ("Sources/Gtk/Widgets/Fixed.swift", "file", 1830),
                ("Sources/Gtk/Widgets/CustomRootWidget.swift", "file", 1596),
            ]
        default:
            rows = [
                ("Sources", "directory", nil),
                ("Tests", "directory", nil),
                ("patches", "directory", nil),
                ("Package.swift", "file", 1188),
                ("README.md", "file", 4410),
            ]
        }
        return rows.compactMap { row in
            var dict: [String: Any] = ["path": row.0, "kind": row.1]
            if let size = row.2 { dict["size"] = size }
            guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return nil }
            return try? JSONDecoder().decode(FileListEntry.self, from: data)
        }
    }

    /// File body for the demo files pane reader.
    static func sampleFileContent(path: String) -> String {
        """
        import CGtk

        /// `GtkFixed` places its child widgets at fixed positions and with
        /// fixed sizes. SwiftCrossUI drives layout itself, so the fixed is
        /// only a positioning surface.
        open class Fixed: Widget {
            public var children: [Widget] = []

            /// Last layout position per child, so the backend can skip
            /// no-op gtk_fixed_move calls (each one queues a resize).
            public var lastPositions: [ObjectIdentifier: SIMD2<Int>] = [:]

            public func put(_ child: Widget, x: Double, y: Double) {
                gtk_fixed_put(castedPointer(), child.widgetPointer, x, y)
                children.append(child)
                child.parentWidget = self
            }

            public func move(_ child: Widget, x: Double, y: Double) {
                gtk_fixed_move(castedPointer(), child.widgetPointer, x, y)
            }
        }
        """
    }

    /// Search matches for the demo search pane.
    static func sampleSearchResults(query: String) -> FilesSearchResult {
        FilesSearchResult(matches: [
            FilesSearchMatch(path: "Sources/Gtk/Widgets/ScrolledWindow.swift"),
            FilesSearchMatch(path: "Sources/GtkBackend/GtkBackend.swift"),
            FilesSearchMatch(path: "Sources/T4CodeLinuxLib/Views/T4SessionDetailView.swift"),
            FilesSearchMatch(path: "Sources/T4CodeLinuxLib/Views/T4TranscriptView.swift"),
            FilesSearchMatch(path: "Tests/T4CodeLinuxTests/AnchorTests.swift"),
        ], truncated: false)
    }

    /// Turn diff for the demo search-diff sheet: the anchor patch, with the
    /// change list the review row renders.
    static var sampleDiffResult: FilesDiffResult {
        FilesDiffResult(
            patchText: """
            diff --git a/Sources/Gtk/Widgets/ScrolledWindow.swift b/Sources/Gtk/Widgets/ScrolledWindow.swift
            --- a/Sources/Gtk/Widgets/ScrolledWindow.swift
            +++ b/Sources/Gtk/Widgets/ScrolledWindow.swift
            @@ -3,6 +3,28 @@
             public class ScrolledWindow: Widget {
                 var child: Widget?
            
            +    /// Stick-to-bottom anchoring for streaming transcripts.
            +    public var anchorsToBottom = false {
            +        didSet { installBottomAnchor() }
            +    }
            +    private var lastUpper = 0.0
            +
            +    private func snapToBottomIfAnchored() {
            +        guard let adjustment = gtk_scrolled_window_get_vadjustment(opaquePointer) else { return }
            +        let value = gtk_adjustment_get_value(adjustment)
            +        let pageSize = gtk_adjustment_get_page_size(adjustment)
            +        let upper = gtk_adjustment_get_upper(adjustment)
            +        let wasAtBottom = value + pageSize >= lastUpper - Self.bottomSlack
            +        lastUpper = upper
            +        guard anchorsToBottom, wasAtBottom, upper > pageSize else { return }
            +        gtk_adjustment_set_value(adjustment, upper - pageSize)
            +    }
            +
                 public func setScrollBarPresence(
            """,
            changes: [
                TurnFileChange(path: "Sources/Gtk/Widgets/ScrolledWindow.swift", status: "modified", kind: "text", additions: 22, deletions: 0),
                TurnFileChange(path: "Sources/GtkBackend/GtkBackend.swift", status: "modified", kind: "text", additions: 3, deletions: 1),
                TurnFileChange(path: "Sources/T4CodeLinuxLib/Views/T4SessionDetailView.swift", status: "modified", kind: "text", additions: 4, deletions: 3),
                TurnFileChange(path: "Tests/T4CodeLinuxTests/AnchorTests.swift", status: "added", kind: "text", additions: 86, deletions: 0),
            ]
        )
    }
}
