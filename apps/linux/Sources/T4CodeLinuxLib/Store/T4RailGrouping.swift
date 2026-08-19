import Foundation
import HostWire

/// Pure grouping/caption rules for the GTK session rail. Host `runtimeAlive`
/// is process liveness; local drafts count as running while they wait to boot.
/// Turn activity is a row caption, never a group.
public enum T4RailGrouping {
    public static func isDraftSession(_ sessionId: String) -> Bool {
        sessionId.hasPrefix("draft-")
    }

    public static func isRunning(_ session: SessionRef) -> Bool {
        if isDraftSession(session.sessionId) { return true }
        if session.archivedAt != nil { return false }
        if session.status.lowercased() == "closed" { return false }
        return session.runtimeAlive == true
    }

    public static func caption(_ session: SessionRef, hasLiveTurn: Bool) -> String? {
        switch session.status.lowercased() {
        case "error", "failed":
            return "Error"
        default:
            break
        }
        if isDraftSession(session.sessionId) { return "Starting" }
        if case .observer(let lock, _) = session.sessionControl, lock == .live {
            return "Open elsewhere"
        }
        if session.status.lowercased() == "active" || session.status.lowercased() == "working"
            || hasLiveTurn
        {
            return "Working"
        }
        return nil
    }
}
