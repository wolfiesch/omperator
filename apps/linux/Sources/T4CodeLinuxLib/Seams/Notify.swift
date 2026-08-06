//  Notify.swift (Linux port of apps/ios/Sources/T4Notify.swift)
//  Local notification bridge. Posts a "Turn complete" notification when a
//  turn ends for a session the user isn't currently viewing, and an
//  "Approval needed" notification when a confirmation challenge arrives for
//  an unviewed (or host-scoped) session. Wired into T4WorkspaceView as a
//  @StateObject that attaches to the store and observes its activeTurns /
//  pendingConfirmation publishers for the transitions that matter.
//
//  Delivery: `notify-send` (libnotify, installed at /usr/bin/notify-send) as
//  a Foundation.Process subprocess. There is no authorization step on Linux —
//  the desktop's notification daemon enforces policy (Do Not Disturb, per-app
//  permissions) — so requestAuthorizationIfNeeded is a no-op kept for parity.

import Foundation
import HostWire
import OpenCombine

private enum T4NotifyLog {
    static func error(_ message: String) { print("T4Notify [error]: \(message)") }
}

@MainActor
enum T4Notify {
    /// notify-send subprocesses that must stay retained while their child
    /// runs. Finished handles are pruned lazily on the next post.
    private static var inflight: [Process] = []

    /// Post a desktop notification through `notify-send` (libnotify).
    static func notify(title: String, body: String) {
        inflight.removeAll { !$0.isRunning }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/notify-send")
        process.arguments = ["-a", "T4 Code", title, body]
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        do {
            try process.run()
        } catch {
            T4NotifyLog.error("notify-send: \(error)")
            return
        }
        inflight.append(process)
    }
}

@MainActor
final class T4Notifier: ObservableObject {
    private weak var store: T4SessionStore?
    private var bag = Set<AnyCancellable>()
    /// The activeTurns snapshot from the last transition — diffing against the
    /// incoming set yields the sessions whose turns just ended.
    private var lastActiveTurns: Set<String> = []
    /// The confirmationId of the last challenge we surfaced, so a re-published
    /// identical challenge (same id) doesn't re-notify.
    private var lastConfirmationId: String?
    private var didAuthorize = false

    /// Attach to the store and begin observing turn/confirmation transitions.
    /// Idempotent — safe to call from a re-firing .task/.onAppear. Requests
    /// notification authorization on first attach (a no-op on Linux).
    func attach(to store: T4SessionStore) {
        if self.store == nil {
            self.store = store
            lastActiveTurns = store.activeTurns
            lastConfirmationId = store.pendingConfirmation?.confirmationId
            subscribe(to: store)
        } else {
            self.store = store
        }
        requestAuthorizationIfNeeded()
    }

    private func subscribe(to store: T4SessionStore) {
        // Turn-end detection: a sessionId that leaves activeTurns is a
        // turn.end/turn.error (the store removes it on those events). Notify
        // only for sessions the user isn't currently viewing.
        store.transcriptModel.$activeTurns
            .removeDuplicates()
            .sink { [weak self] active in
                guard let self, let store = self.store else { return }
                let ended = self.lastActiveTurns.subtracting(active)
                self.lastActiveTurns = active
                let viewing = store.selectedSession?.sessionId
                for sid in ended where sid != viewing {
                    self.notifyTurnEnd(sessionId: sid, store: store)
                }
            }
            .store(in: &bag)

        // Confirmation challenge: notify on a new challenge (by id) for an
        // unviewed or host-scoped session. The approve/deny banner handles the
        // in-view case; this catches the user's attention when they're elsewhere.
        store.promptModel.$pendingConfirmation
            .removeDuplicates()
            .sink { [weak self] challenge in
                guard let self, let store = self.store else { return }
                guard let challenge, challenge.confirmationId != self.lastConfirmationId else { return }
                self.lastConfirmationId = challenge.confirmationId
                let viewing = store.selectedSession?.sessionId
                if challenge.sessionId == nil || challenge.sessionId != viewing {
                    self.notifyApprovalNeeded(challenge: challenge, store: store)
                }
            }
            .store(in: &bag)
    }

    private func requestAuthorizationIfNeeded() {
        // LINUX-GAP (UNUserNotificationCenter): desktop notifications are not
        // gated by the app on Linux — the notification daemon enforces policy.
        didAuthorize = true
    }

    private func notifyTurnEnd(sessionId: String, store: T4SessionStore) {
        let title = store.sessions.first(where: { $0.sessionId == sessionId })?.title ?? "Session"
        post(title: title, body: "Turn complete")
    }

    private func notifyApprovalNeeded(challenge: ConfirmationChallenge, store: T4SessionStore) {
        let title: String
        if let sid = challenge.sessionId,
           let session = store.sessions.first(where: { $0.sessionId == sid }) {
            title = session.title
        } else {
            title = "T4 Code"
        }
        post(title: title, body: "Approval needed")
    }

    private func post(title: String, body: String) {
        T4Notify.notify(title: title, body: body)
    }
}
