//  Models.swift
//  UI-side value types for the live omp collab guest. Everything here is fed from
//  EngineBridge (the guest client) — there is no mock data. Shapes map 1:1 to the
//  omp wire types so the projection in EngineBridge is a straight translation.

import SwiftUI

// MARK: - Turn (one rendered transcript row)

struct UIToolFileDiff: Equatable {
    let path: String
    let diff: String
    let lang: String
    let isError: Bool
    let errorText: String?
}

struct UITurn: Identifiable, Equatable {
    let id: String
    var type: TurnType
    var text: String = ""
    var streaming = false
    var image: String? = nil

    // tool / sys
    var kind: String = ""          // tool kind or sys kind
    var head: String = ""
    var meta: String = ""
    var add: Int? = nil
    var del: Int? = nil
    var lines: [String] = []
    var caption: String? = nil

    // diff
    var diff: String = ""
    var diffLang: String = ""
    var perFileDiffs: [UIToolFileDiff] = []

    // ask
    var question: String = ""
    var options: [String] = []
    var pending = false
    var reqId: Int? = nil          // live host ui-request id (answered via GuestClient)
    var askKind: String = "select"            // "select" | "editor" | "plan"
    var selectionMarker: String = "radio"     // "radio" | "checkbox"
    var checkedIndices: [Int] = []
    var initialIndex: Int? = nil              // recommended option (0-based)
    var disabledIndices: [Int] = []           // unselectable options
    var optionDescriptions: [String] = []     // parallel to options; "" when absent
    var helpText: String = ""
    var prefill: String = ""

    // thinking
    var thoughtSeconds: Int? = nil // set once thinking finishes → "thought for Xs"
    var model: String = ""         // producing model (only kept when the session used >1)

    static func == (a: UITurn, b: UITurn) -> Bool {
        a.id == b.id && a.text == b.text && a.streaming == b.streaming && a.pending == b.pending
            && a.meta == b.meta && a.lines == b.lines && a.diff == b.diff && a.diffLang == b.diffLang
            && a.perFileDiffs == b.perFileDiffs && a.thoughtSeconds == b.thoughtSeconds && a.model == b.model
            && a.askKind == b.askKind && a.question == b.question && a.options == b.options
            && a.optionDescriptions == b.optionDescriptions && a.selectionMarker == b.selectionMarker
            && a.checkedIndices == b.checkedIndices && a.helpText == b.helpText && a.prefill == b.prefill
            && a.initialIndex == b.initialIndex && a.disabledIndices == b.disabledIndices
    }

    static func sys(_ kind: String, _ text: String) -> UITurn {
        var t = UITurn(id: UUID().uuidString, type: .sys); t.kind = kind; t.text = text; return t
    }
}

enum TurnType: String { case user, agent, tool, advisor, sys, ask, thinking }

// tool-kind → sf symbol + color
func toolGlyph(_ kind: String) -> String {
    switch kind {
    case "read": return "doc.text"
    case "search", "ast_grep", "find": return "magnifyingglass"
    case "edit", "write", "ast_edit": return "square.and.pencil"
    case "bash", "eval": return "terminal"
    case "lsp": return "chevron.left.forwardslash.chevron.right"
    case "task": return "circle.grid.cross"
    case "debug": return "ladybug"
    case "inspect": return "eye"
    case "image": return "photo"
    default: return "doc.text"
    }
}
func toolColor(_ kind: String, _ t: Theme) -> Color {
    switch kind {
    case "edit", "write", "ast_edit": return t.cEdit
    case "bash", "eval": return t.cBash
    case "lsp": return t.cLsp
    case "task": return t.cTask
    case "inspect", "debug": return t.cLsp
    case "image": return t.cTask
    default: return t.txtMuted
    }
}

// MARK: - Session summary (derived live from the host's SessionHeader + SessionState)

struct Session: Identifiable {
    let id: String
    var repo: String
    var branch: String
    var dir: String
    var model: String
    var status: Status          // running / waiting / idle
    var lastSeen: String
    var action: String
    var tokens: String
    var cost: String

    enum Status: String { case running, waiting, idle }
}

// MARK: - Background session list state

/// Lightweight live state for a session in the list, kept up to date by a
/// background GuestClient watcher. Separate from the full `Session` value used
/// inside the editor transcript.
struct SessionState: Equatable {
    var live: Bool = false
    var working: Bool = false
    var phase: String = "offline"
    var title: String = ""
    var mode: String? = nil        // host mode from the last mode_change (e.g. "plan")
    var lastSeen: Date?
}

struct AgentInfo: Identifiable {
    let id: String
    let displayName: String
    let kind: String            // "main" | "sub"
    let status: String          // running / idle / parked / aborted
    let hasSessionFile: Bool
    var parentId: String? = nil
    var createdAt: Double = 0
    var lastActivity: Double = 0
}

struct SubagentProgress: Identifiable {
    let id: String
    let index: Int
    let task: String
    let description: String?
    let status: String          // pending / running / completed / failed / aborted
    let currentTool: String?
    let lastIntent: String?
    let toolCount: Int
    let tokens: Int
    let cost: Double
    var recentOutput: [String] = []   // live tail of the subagent's output
    var contextTokens: Int? = nil
    var contextWindow: Int? = nil
}

struct ParticipantInfo: Identifiable {
    var id: String { name + role }
    let name: String
    let role: String            // "host" | "guest"
    let readOnly: Bool
}

// MARK: - Plan / todos (omp's `todo` tool — the latest todo toolResult's phases)

struct PlanTask: Identifiable, Equatable, Codable {
    var id: String { content }
    let content: String
    let status: String            // pending / in_progress / completed / abandoned
}
struct PlanPhase: Identifiable, Equatable, Codable {
    var id: String { name }
    let name: String
    let tasks: [PlanTask]
    var doneCount: Int { tasks.filter { $0.status == "completed" }.count }
}

// MARK: - Host notices (rate limits, tool failures) + goal mode

struct NoticeItem: Identifiable, Equatable {
    let id: String
    let level: String     // info / warning / error
    let message: String
}

struct GoalInfo: Equatable {
    let objective: String
    let status: String
    let tokensUsed: Int
    let tokenBudget: Int?
}

// MARK: - /enclave plugin capabilities (absent over plain /collab)

struct EnclaveCommand: Identifiable { var id: String { name }; let name: String; let summary: String }
struct ModelOption: Identifiable { var id: String { modelId }; let modelId: String; let name: String; var vision = false }

// MARK: - Joined sessions (persisted locally — the guest's own room list)

enum SessionColor: String, Codable, CaseIterable, Identifiable {
    case `default`, accent, foam, iris, pine, rose, green
    var id: String { rawValue }
    func color(in t: Theme) -> Color {
        switch self {
        case .default: return t.txt
        case .accent: return t.accent
        case .foam: return t.cBash
        case .iris: return t.cLsp
        case .pine: return t.cTask
        case .rose: return t.cAdvisor
        case .green: return t.cOk
        }
    }
}

struct JoinedSession: Identifiable, Codable, Equatable {
    var id: String              // stable per room link
    var link: String
    var title: String
    var relay: String
    var readOnly: Bool
    var savedAt: Date
    var enhanced: Bool? = nil   // true = /enclave, false = /collab, nil = never connected
    var tagColor: SessionColor = .default
}
