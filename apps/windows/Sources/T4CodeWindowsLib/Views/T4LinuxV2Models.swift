import Foundation
import HostWire

/// Visible session data deliberately excludes every host-wire identifier and
/// internal status field. The source SessionRef stays behind the selection
/// closure; only this projection reaches labels and accessibility surfaces.
struct T4LinuxV2VisibleSession: Equatable, Sendable {
    let title: String
    let relativeTime: String

    @MainActor
    init(session: SessionRef, now: Date = Date()) {
        title = session.title.isEmpty ? "Untitled session" : session.title
        relativeTime = T4LinuxV2RelativeTime.format(session.updatedAt, now: now)
    }
}

@MainActor
enum T4LinuxV2RelativeTime {
    private static let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d"
        return formatter
    }()

    static func format(_ timestamp: String, now: Date = Date()) -> String {
        guard let date = isoFormatter.date(from: timestamp) else { return "" }
        let minutes = Int(now.timeIntervalSince(date) / 60)
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes)m ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h ago" }
        if hours < 48 { return "yesterday" }
        let days = hours / 24
        if days < 7 { return "\(days)d ago" }
        return dayFormatter.string(from: date)
    }
}

enum T4LinuxV2VisiblePane: String, Equatable, Sendable {
    case browser

    static let ordinarySidebarPanes: [Self] = [.browser]
}

struct T4LinuxV2ShellState: Equatable, Sendable {
    var compact = false
    var railVisible = true
    var browserVisible = false
    var settingsPresented = false

    mutating func setCompact(_ enabled: Bool) {
        guard compact != enabled else { return }
        compact = enabled
        if enabled {
            railVisible = false
            browserVisible = false
        } else {
            // The pinned GTK implementation always restores the rail and
            // leaves the browser closed when compact mode ends.
            railVisible = true
        }
    }

    mutating func toggleRail() {
        railVisible.toggle()
    }

    mutating func toggleBrowser() {
        guard !compact else { return }
        browserVisible.toggle()
    }
}

enum T4LinuxV2ConnectionTitle {
    static func text(sessionTitle: String?, connected: Bool, error: String?) -> String {
        if let sessionTitle, !sessionTitle.isEmpty { return sessionTitle }
        if let error, !error.isEmpty {
            return "⚠ \(T4WindowsRedaction.friendlyConnectionError(error))"
        }
        return connected ? "● connected" : "○ connecting…"
    }
}

enum T4WindowsRedaction {
    /// Raw transport errors can contain room URLs, account tokens, pairing
    /// codes, or certificate material. UI and accessibility receive only a
    /// fixed classification, never the original payload.
    static func friendlyConnectionError(_ raw: String) -> String {
        let lower = raw.lowercased()
        if lower.contains("pair") || lower.contains("code") || lower.contains("room") {
            return "Pairing failed. Check the code and try again."
        }
        if lower.contains("offline") || lower.contains("network") || lower.contains("timed out")
            || lower.contains("unreachable") || lower.contains("connect") {
            return "Connection interrupted. Try again in a moment."
        }
        return "Something went wrong. Try again in a moment."
    }

    static func containsSecretMaterial(_ text: String) -> Bool {
        let lower = text.lowercased()
        let markers = [
            "bearer ", "password=", "password:", "devicetoken", "accounttoken",
            "certificatepin", "sha256/", "/r/",
        ]
        if markers.contains(where: lower.contains) { return true }
        if text.range(of: #"\b\d{6}\b"#, options: .regularExpression) != nil { return true }
        return false
    }
}

/// Platform-neutral state machine matching AppWindow's adjustment rules. The
/// WinUI ScrollViewer adapter below owns one instance and translates offsets.
struct T4TranscriptScrollMemory: Equatable, Sendable {
    static let nearBottomThreshold = 48.0

    private(set) var positions: [String: Double] = [:]
    private(set) var sessionID: String?
    private(set) var followsBottom = true

    mutating func switchSession(to next: String, outgoingOffset: Double?) -> Double? {
        if let current = sessionID, current != next, let outgoingOffset {
            positions[current] = outgoingOffset
        }
        guard sessionID != next else { return nil }
        sessionID = next
        let saved = positions[next]
        followsBottom = saved == nil
        return saved
    }

    mutating func userScrolled(value: Double, page: Double, upper: Double) {
        followsBottom = value + page >= upper - Self.nearBottomThreshold
        if let sessionID { positions[sessionID] = value }
    }

    mutating func rememberCurrentOffset(_ value: Double) {
        if let sessionID { positions[sessionID] = value }
    }

    func targetAfterContentGrowth(upper: Double, page: Double) -> Double? {
        followsBottom ? max(0, upper - page) : nil
    }
}

enum T4LinuxV2ComposerPolicy {
    static func isEnabled(connected: Bool, hasSession: Bool, streamingText: String) -> Bool {
        connected && hasSession && streamingText.isEmpty
    }
}
