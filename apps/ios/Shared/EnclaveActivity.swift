//  EnclaveActivity.swift  (shared: app + EnclaveWidgets extension)
//  The Live Activity contract. ContentState is the live session snapshot the app
//  pushes to the lock screen / Dynamic Island as omp frames arrive.

import ActivityKit
import Foundation

enum EnclaveStatus: String, CaseIterable {
    case connecting, live, working, needsYou, ended
    var label: String {
        switch self {
        case .connecting: "Connecting"
        case .live: "Live"
        case .working: "Working"
        case .needsYou: "Needs you"
        case .ended: "Ended"
        }
    }
    static func from(phase: String, working: Bool, waiting: Bool) -> EnclaveStatus {
        if phase == "ended" { return .ended }
        if ["connecting", "waiting", "reconnecting"].contains(phase) { return .connecting }
        if waiting { return .needsYou }
        if working { return .working }
        return .live
    }
}

struct EnclaveActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var title: String        // session / repo name
        var action: String       // Connecting · Live · Working · Needs you · Ended
        var phase: String        // connecting / waiting / live / ended
        var working: Bool        // agent is streaming
        var waiting: Bool        // a host ask is pending your answer
        var tokens: String       // context tokens label
        var model: String
        var prompt: String = ""  // host ask question for the expanded-island serif line; "" when none
    }

    var sessionId: String
}
