//  SessionVM.swift
//  View model for one open session's transcript + composer. Backed entirely by
//  the live GuestClient: `turns` mirrors the projected transcript, and send/stop/
//  answer map to the guest frames (prompt / abort / ui-response). Guests cannot
//  rewind (host-only), so there is no edit path.

import SwiftUI
import Combine

@MainActor
final class SessionVM: ObservableObject {
    @Published var turns: [UITurn] = []
    @Published private(set) var session: Session

    let live: GuestClient
    private let seed: Session

    var isRunning: Bool { live.working }
    var readOnly: Bool { live.readOnly }

    // /enclave capabilities (all off over plain /collab).
    var enhanced: Bool { live.enhanced }
    var canSendImages: Bool { live.canSendImages }
    var viaVisionModel: Bool { live.canSendImages && !live.nativeVision }  // routed through the vision fallback
    // Show the paperclip when an image path exists (real or enable-able); it's greyed
    // when a vision model is present but the session can't yet use it (inspect_image off).
    var imagePossible: Bool { live.canSendImages || live.visionModelAvailable }
    var commands: [EnclaveCommand] { live.commands }
    var plan: [PlanPhase] { live.plan }
    var currentMode: String? { live.currentMode }
    var goal: GoalInfo? { live.goal }
    var models: [ModelOption] { live.models }
    var thinkingLevels: [String] { live.thinkingLevels }
    var thinkingLevel: String { live.thinkingLevel }
    var modelName: String { live.modelName }
    var joinLink: String { live.joinLink }

    @Published var awaitingVision = false   // this turn is reading an image via the vision fallback
    private var sawWorking = false

    init(live client: GuestClient, seed s: Session) {
        session = s
        seed = s
        live = client
        client.onChange = { [weak self] in self?.syncLive() }
        syncLive()
        // Dev seam: auto-send a prompt shortly after connect (streaming test / demo).
        if let p = ProcessInfo.processInfo.environment["ENCLAVE_COLLAB_PROMPT"], !p.isEmpty {
            Task { try? await Task.sleep(nanoseconds: 1_500_000_000); client.sendPrompt(p) }
        }
    }

    private func syncLive() {
        if turns != live.turns { turns = live.turns }
        if live.working { sawWorking = true } else if sawWorking { awaitingVision = false; sawWorking = false }
        let waiting = turns.contains { $0.type == .ask }
        let status = EnclaveStatus.from(phase: live.phase, working: live.working, waiting: waiting)
        let action: String
        if let a = live.activity {                       // retrying / compacting / falling back
            action = a
        } else if awaitingVision && live.working {
            action = "READING YOUR IMAGE VIA VISION…"
        } else if status == .ended {
            action = "Ended · \(live.endedReason ?? "session closed")"
        } else if status == .connecting || status == .working {
            action = status.label + "…"                  // in-progress ellipsis kept (animated feel)
        } else {
            action = status.label                        // Live / Needs you
        }
        session = Session(id: seed.id, repo: live.title, branch: live.readOnly ? "watch" : "control",
                          dir: live.cwd, model: live.modelName,
                          status: live.working ? .running : (live.phase == "ended" ? .idle : .waiting),
                          lastSeen: "live", action: action, tokens: live.tokensLabel, cost: live.costLabel)
    }

    func send(_ text: String, images: [(mime: String, base64: String)] = []) {
        guard !readOnly else { return }
        if !images.isEmpty && viaVisionModel { awaitingVision = true; sawWorking = false }
        live.sendPrompt(text, images: images)   // host echoes it back as an entry
    }

    func stop() { guard !readOnly else { return }; live.sendAbort() }

    /// Answer a live host ask (select). `idx` is the chosen option — send its label.
    func answer(_ turn: UITurn, _ idx: Int) {
        guard !readOnly, let reqId = turn.reqId, idx < turn.options.count else { return }
        live.answer(reqId: reqId, value: turn.options[idx])
    }
    /// Answer a live host ask (editor) — send the typed text.
    func answer(_ turn: UITurn, _ text: String) {
        guard !readOnly, let reqId = turn.reqId else { return }
        live.answer(reqId: reqId, value: text)
    }
    /// Cancel/skip a live host ask — sends no value (the host aborts the ask).
    func skip(_ turn: UITurn) {
        guard !readOnly, let reqId = turn.reqId else { return }
        live.answer(reqId: reqId, value: nil)
    }

    // /enclave control actions (no-ops without the plugin).
    func runCommand(_ name: String) { Task { _ = await live.runSlash(name) } }
    func setModel(_ id: String) { Task { _ = await live.setModel(id) } }
    func setThinking(_ level: String) { Task { _ = await live.setThinking(level) } }
    func rewind(to turn: UITurn) { Task { _ = await live.rewind(to: turn.id) } }
    /// Edit-replace: rewind to just before the message so the edited text supersedes it.
    func rewindBefore(to turn: UITurn) {
        if let prev = live.entryBefore(turn.id) { Task { _ = await live.rewind(to: prev) } }
    }
}
