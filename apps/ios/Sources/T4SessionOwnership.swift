import HostWire

struct T4SessionControlPresentation {
    let railLabel: String
    let title: String
    let detail: String
    let systemImage: String
    let canFork: Bool
}

extension SessionControlState {
    var t4Presentation: T4SessionControlPresentation {
        switch self {
        case .observer(let lockStatus, _):
            switch lockStatus {
            case .live:
                return T4SessionControlPresentation(
                    railLabel: "Active elsewhere",
                    title: "Active in another app",
                    detail: "This transcript stays readable. Input returns after the other app releases or exits.",
                    systemImage: "eye",
                    canFork: true
                )
            case .suspect:
                return T4SessionControlPresentation(
                    railLabel: "Waiting to take over",
                    title: "Waiting to take over",
                    detail: "The other app has gone quiet. Input returns after the session settles.",
                    systemImage: "clock.arrow.circlepath",
                    canFork: true
                )
            case .malformed:
                return T4SessionControlPresentation(
                    railLabel: "Read-only",
                    title: "Read-only right now",
                    detail: "Ownership is unclear, so the app will not risk another writer.",
                    systemImage: "lock",
                    canFork: true
                )
            }
        case .reconciling(let transcript):
            return T4SessionControlPresentation(
                railLabel: "Taking over",
                title: "Taking over",
                detail: transcript == .live
                    ? "Confirming the transcript is complete. Input returns in a moment."
                    : "Catching up from the last saved copy before enabling input.",
                systemImage: "arrow.trianglehead.2.clockwise.rotate.90",
                canFork: false
            )
        case .unverified:
            return T4SessionControlPresentation(
                railLabel: "Read-only · use t4-omp",
                title: "Read-only terminal session",
                detail: "This older session has no compatible handoff signal. Continue in a safe copy or keep using the terminal.",
                systemImage: "terminal",
                canFork: true
            )
        case .released:
            return T4SessionControlPresentation(
                railLabel: "Ready for terminal",
                title: "Released to terminal",
                detail: "Run the resume command in a terminal, or bring the session back to this app.",
                systemImage: "rectangle.and.hand.point.up.left",
                canFork: false
            )
        case .unknown:
            return T4SessionControlPresentation(
                railLabel: "Read-only",
                title: "Read-only right now",
                detail: "This app does not recognize the current ownership state, so writes remain disabled.",
                systemImage: "lock",
                canFork: false
            )
        }
    }

    var t4ResumeCommand: String? {
        guard case .released(_, let resumeCommand) = self else { return nil }
        return resumeCommand
    }
}

extension SessionRef {
    var t4IsWritable: Bool {
        sessionControl == nil && archivedAt == nil
    }
}
