public struct T4WindowsDemoSession: Identifiable, Equatable, Sendable {
    public let id: String
    public let project: String
    public let title: String
    public let model: String
    public let status: String
    public let updated: String

    public init(
        id: String,
        project: String,
        title: String,
        model: String,
        status: String,
        updated: String
    ) {
        self.id = id
        self.project = project
        self.title = title
        self.model = model
        self.status = status
        self.updated = updated
    }
}

public struct T4WindowsDemoTranscriptItem: Identifiable, Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case user
        case assistant
        case tool
    }

    public let id: String
    public let kind: Kind
    public let title: String
    public let body: String

    public init(id: String, kind: Kind, title: String, body: String) {
        self.id = id
        self.kind = kind
        self.title = title
        self.body = body
    }
}

/// Deterministic, offline data used only by the explicit `-T4Demo` seam.
public enum T4WindowsDemoContent {
    public static let sessions = [
        T4WindowsDemoSession(
            id: "windows-port",
            project: "omperator",
            title: "Native Windows Swift port",
            model: "gpt-5.6-sol",
            status: "Working",
            updated: "now"
        ),
        T4WindowsDemoSession(
            id: "host-wire",
            project: "omperator",
            title: "HostWire compatibility",
            model: "gpt-5.6-sol",
            status: "Done",
            updated: "2m"
        ),
        T4WindowsDemoSession(
            id: "winui-backend",
            project: "swift-cross-ui",
            title: "WinUIBackend launch probe",
            model: "gpt-5.6-sol",
            status: "Ready",
            updated: "5m"
        ),
    ]

    public static let transcript = [
        T4WindowsDemoTranscriptItem(
            id: "request",
            kind: .user,
            title: "You",
            body: "Port the Linux SwiftCrossUI implementation to native Windows with 1:1 functional and visual parity."
        ),
        T4WindowsDemoTranscriptItem(
            id: "analysis",
            kind: .assistant,
            title: "Omperator",
            body: "The Windows client keeps OMP and t4-host as runtime authority. The UI is a native SwiftCrossUI tree hosted by WinUI 3."
        ),
        T4WindowsDemoTranscriptItem(
            id: "hostwire",
            kind: .tool,
            title: "swift test · HostWire",
            body: "21 tests in 3 suites passed on x86_64-unknown-windows-msvc."
        ),
        T4WindowsDemoTranscriptItem(
            id: "window",
            kind: .assistant,
            title: "Omperator",
            body: "Pinned SwiftCrossUI revision 199a856 is active. The next checkpoint is the native demo window."
        ),
    ]
}
