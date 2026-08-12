import Foundation
import HostWire

/// Public bridge to the shared session store for the pure-GTK4 executable
/// target. T4SessionStore stays internal to the library (its SwiftCrossUI
/// conformances don't belong in a public API); this facade exposes only the
/// surface the GTK window needs, in public HostWire/Foundation types.
@MainActor
public final class T4GtkBridge {
    private let store = T4SessionStore()

    public init() {}

    public func restore() async { await store.restore() }

    public var connected: Bool { store.connected }
    public var lastError: String? { store.lastError }
    public var sessions: [SessionRef] { store.sessions }
    public var selectedSession: SessionRef? { store.selectedSession }

    public func select(_ session: SessionRef?) { store.select(session) }

    public func sendPrompt(sessionId: String, text: String) async {
        await store.sendPrompt(sessionId: sessionId, text: text)
    }

    public func cancel(sessionId: String) async { await store.cancel(sessionId: sessionId) }

    public func transcript(for sessionId: String) -> [TranscriptEntry] {
        store.transcript(for: sessionId)
    }

    // MARK: - Panes (terminal / browser / files)

    public func openTerminal(sessionId: String) async { _ = await store.openTerminal(sessionId: sessionId) }
    public func activeTerminalId(for sessionId: String) -> String? { store.activeTerminal(sessionId: sessionId) }
    public func terminalOutput(_ terminalId: String) -> String { store.terminalOutput[terminalId] ?? "" }
    public func sendTerminalInput(sessionId: String, data: String) async { await store.sendTerminalInput(sessionId: sessionId, data: data) }
    public func resizeTerminal(sessionId: String, cols: Int, rows: Int) async { await store.resizeTerminal(sessionId: sessionId, cols: cols, rows: rows) }
    public func closeTerminal(sessionId: String) async { await store.closeTerminal(sessionId: sessionId) }

    public func browserURL(for sessionId: String) -> String { store.browserURL(for: sessionId) }
    public func setBrowserURL(for sessionId: String, url: String) { store.setBrowserURL(for: sessionId, url: url) }

    public func listFiles(sessionId: String, path: String) async -> [FileListEntry]? { await store.listFiles(sessionId: sessionId, path: path) }
    public func readFile(sessionId: String, path: String) async -> String? { await store.readFile(sessionId: sessionId, path: path) }

    public struct GtkFilesDiff: Sendable {
        public let patchText: String?
        public let changedPaths: [String]
    }
    public func filesDiff(sessionId: String) async -> GtkFilesDiff? {
        guard let result = await store.filesDiff(sessionId: sessionId) else { return nil }
        return GtkFilesDiff(patchText: result.patchText, changedPaths: result.changes.map { $0.path })
    }
}
