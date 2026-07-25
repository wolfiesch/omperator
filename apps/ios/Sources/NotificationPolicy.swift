import UIKit

@MainActor
final class NotificationPolicy {
    private var wasWorking = false
    private var lastDoneTurnCount = -1
    private var notifiedAsks: Set<String> = []   // NOT cleared by reset() — see below
    private var pendingDoneCount = 0
    private var pendingDoneLast = ""             // most recent agent text in the window
    private var doneTask: Task<Void, Never>?
    private var notifiedEnded = false
    private let quiet: TimeInterval = 30

    /// Reset transient turn/ended state on connect/leave. notifiedAsks is intentionally
    /// preserved (keyed by sessionId-reqId) so reconnecting an unanswered ask can't re-fire —
    /// matching today's behavior.
    func reset() {
        wasWorking = false
        lastDoneTurnCount = -1
        pendingDoneCount = 0
        pendingDoneLast = ""
        doneTask?.cancel(); doneTask = nil
        notifiedEnded = false
    }

    func update(_ c: GuestClient, away: Bool) {
        // ENDED — flush any coalesced done as the Ended summary, once.
        if c.phase == "ended" {
            if !notifiedEnded {
                notifiedEnded = true
                doneTask?.cancel(); doneTask = nil
                if away { postSummary(c, ended: true) }
            }
            wasWorking = c.working
            return
        }
        // working→false edge: dedup by turn count, then (re)start the quiet window,
        // coalescing consecutive completions into one pending summary.
        if wasWorking && !c.working, c.turns.count != lastDoneTurnCount {
            lastDoneTurnCount = c.turns.count
            pendingDoneCount += 1
            if let last = c.turns.last(where: { $0.type == .agent })?.text, !last.isEmpty { pendingDoneLast = last }
            scheduleDone(c)
        }
        wasWorking = c.working
        // Host ask — once per (session, reqId), immediately when away (no debounce).
        if let ask = c.turns.last(where: { $0.type == .ask }), let rq = ask.reqId {
            let key = "\(c.sessionId)-\(rq)"
            if !notifiedAsks.contains(key) {
                notifiedAsks.insert(key)
                if away {
                    Notifier.post(title: c.title.isEmpty ? "session" : c.title,
                                  body: ask.question.isEmpty ? "The host is asking for your input." : ask.question,
                                  id: "ask-\(rq)")
                }
            }
        }
    }

    private func scheduleDone(_ c: GuestClient) {
        doneTask?.cancel()
        let id = c.sessionId
        let title = c.title.isEmpty ? "session" : c.title
        let count = pendingDoneCount
        let last = pendingDoneLast
        doneTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64((self?.quiet ?? 30) * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.flushDone(id: id, title: title, count: count, last: last) }
        }
    }

    private func flushDone(id: String, title: String, count: Int, last: String) {
        pendingDoneCount = 0; pendingDoneLast = ""
        guard count > 0 else { return }
        // Only interrupt if still away at fire time — if the user came back, they saw it live.
        guard UIApplication.shared.applicationState != .active else { return }
        Notifier.post(title: title, body: doneBody(count: count, last: last), id: "done-\(id)")
    }

    private func postSummary(_ c: GuestClient, ended: Bool) {
        let body = pendingDoneCount > 0
            ? doneBody(count: pendingDoneCount, last: pendingDoneLast)
            : (ended ? "The session ended." : "The agent finished.")
        pendingDoneCount = 0; pendingDoneLast = ""
        Notifier.post(title: c.title.isEmpty ? "session" : c.title, body: body, id: "done-\(c.sessionId)")
    }

    private func doneBody(count: Int, last: String) -> String {
        if count == 1 { return last.isEmpty ? "The agent finished." : String(last.prefix(140)) }
        return "Done · \(count) turns" + (last.isEmpty ? "" : " — \(String(last.prefix(100)))")
    }
}
