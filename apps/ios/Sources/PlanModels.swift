//  PlanModels.swift
//  OMP todo-tool wire models, shared by the store (T4SessionStore feeds
//  PlanPhase arrays from session.state.get todoPhases) and the plan strip
//  view. Extracted from T4PlanStrip.swift so the Linux client can compile
//  the store layer without the SwiftUI view.

import Foundation

struct PlanTask: Identifiable, Equatable {
    let content: String
    let status: String   // pending / in_progress / completed
    var id: String { content }
}

struct PlanPhase: Identifiable, Equatable {
    let name: String
    let tasks: [PlanTask]
    var id: String { name }
    var doneCount: Int { tasks.filter { $0.status == "completed" }.count }
}
