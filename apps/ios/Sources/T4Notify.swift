//  T4Notify.swift
//  Local notification bridge. Posts a "Turn complete" notification when a
//  turn ends for a session the user isn't currently viewing, and an
//  "Approval needed" notification when a confirmation challenge arrives for
//  an unviewed (or host-scoped) session. Wired into T4WorkspaceView as a
//  @StateObject that attaches to the store and observes its activeTurns /
//  pendingConfirmation publishers for the transitions that matter.
//
//  Authorization: requestAuthorization(.alert, .sound) on first attach. On
//  iOS this prompts the user; on macOS the app's own notifications are
//  granted without a prompt (this call also registers the app for delivery).
//  No Info.plist permission keys are required for local notifications.

import Foundation
import UserNotifications
import Combine
import os
import HostWire

private let t4logNotify = Logger(subsystem: "sh.t4code.ios", category: "notify")

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
    /// notification authorization on first attach.
    func attach(_ store: T4SessionStore) {
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
        guard !didAuthorize else { return }
        didAuthorize = true
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            if let error { t4logNotify.error("notif auth: \(error, privacy: .public)") }
            t4logNotify.notice("notif authorized=\(granted, privacy: .public)")
        }
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
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(
            identifier: "\(title)-\(body)-\(UUID().uuidString)",
            content: content,
            trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error { t4logNotify.error("notif post: \(error, privacy: .public)") }
        }
    }
}
