//  LiveActivityController.swift
//  Drives the ActivityKit Live Activity (lock screen + Dynamic Island) from the
//  live GuestClient. Local updates only — no push token is requested here, so it
//  works without the APNs entitlement. A relay→APNs bridge can later push updates
//  using the same ContentState (see AppDelegate for the token scaffold).

import ActivityKit
import Foundation

@MainActor
final class LiveActivityController {
    private var activity: Activity<EnclaveActivityAttributes>?

    static func state(from c: GuestClient) -> EnclaveActivityAttributes.ContentState {
        let waiting = c.turns.contains { $0.type == .ask }
        let status = EnclaveStatus.from(phase: c.phase, working: c.working, waiting: waiting)
        let prompt = c.turns.last(where: { $0.type == .ask })?.question ?? ""
        return .init(title: c.title, action: status.label, phase: c.phase, working: c.working,
                     waiting: waiting, tokens: c.tokensLabel, model: c.modelName, prompt: prompt)
    }

    /// Start (once) or update the activity to the given state.
    func sync(sessionId: String, state: EnclaveActivityAttributes.ContentState) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        if let activity {
            Task { await activity.update(ActivityContent(state: state, staleDate: nil)) }
            return
        }
        let attributes = EnclaveActivityAttributes(sessionId: sessionId)
        activity = try? Activity.request(attributes: attributes,
                                         content: ActivityContent(state: state, staleDate: nil),
                                         pushType: nil)
    }

    func end() {
        let a = activity
        activity = nil
        Task { await a?.end(nil, dismissalPolicy: .immediate) }
    }
}
