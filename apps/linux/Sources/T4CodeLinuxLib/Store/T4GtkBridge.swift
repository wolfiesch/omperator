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
}
