import Foundation
import HostWire
import Testing
@testable import T4CodeWindowsLib

@Suite("Windows pane behavior", .serialized)
@MainActor
struct T4PaneBehaviorTests {
    @Test("Normal mode never substitutes deterministic pane samples")
    func normalModeHasNoFakePaneData() {
        #expect(!T4SessionStore.demoMode)

        let store = T4SessionStore()
        #expect(store.sessions.isEmpty)
        #expect(store.agents(for: "missing-session").isEmpty)
        #expect(store.reviews(for: "missing-session").isEmpty)
        #expect(store.artifacts(for: "missing-session").isEmpty)
        #expect(store.todoPhases(for: "missing-session").isEmpty)
        #expect(store.attentionSessions.isEmpty)
        #expect(store.pendingAsk == nil)
        #expect(store.usageSnapshot == nil)
        #expect(store.settingsSnapshot == nil)
    }

    @Test("Live fixture drives Files Search Usage and Settings commands")
    func livePaneCommands() async throws {
        let fixture = try await WindowsFixtureServer.spawn(scenario: "basic-v1")
        defer { fixture.stop() }

        let store = T4SessionStore()
        do {
            await store.connect(
                endpoint: fixture.url,
                identity: ClientIdentity(
                    name: T4WindowsPlatform.clientName,
                    version: "0.1",
                    build: "pane-fixture-test",
                    platform: T4WindowsPlatform.clientPlatform
                ),
                authentication: nil
            )
            try await waitForPaneStore("live pane fixture inventory") {
                store.connected && store.sessions.count == 1
            }
            guard let session = store.sessions.first else {
                throw PaneAssertionError.expectedSession
            }

            let files = await store.listFiles(sessionId: session.sessionId, path: "")
            #expect(files?.isEmpty == true)
            #expect(await store.readFile(sessionId: session.sessionId, path: "src/app.ts") == "")

            let search = await store.filesSearch(sessionId: session.sessionId, query: "app")
            #expect(search?.matches.map(\.path) == [
                "src/app.ts",
                "apps/web/src/components/CommandPalette.tsx",
            ])
            #expect(search?.truncated == false)

            let diff = await store.filesDiff(sessionId: session.sessionId)
            #expect(diff?.patchText == "")
            #expect(diff?.changes.isEmpty == true)

            let usage = await store.usageRead()
            #expect(usage?.reports.first?.provider == "fixture-provider")
            #expect(usage?.reports.first?.limits.first?.label == "Fixture requests")
            #expect(store.usageSnapshot == usage)

            let settings = await store.settingsRead()
            #expect(settings?["defaultThinkingLevel"] == .string("medium"))
            let initialRevision = store.settingsRevision
            #expect(initialRevision != nil)

            let write = Task {
                await store.settingsWrite(patch: ["defaultThinkingLevel": .string("high")])
            }
            try await waitForPaneStore("settings confirmation challenge") {
                store.pendingConfirmation != nil
            }
            await store.confirm(.approve)
            #expect(await write.value)
            #expect(store.pendingConfirmation == nil)
            #expect(store.settingsSnapshot?["defaultThinkingLevel"] == .string("high"))
            #expect(store.settingsRevision != initialRevision)

            let agents = store.agents(for: session.sessionId)
            #expect(agents.map(\.agentId) == ["agent-parent", "agent-fixture"])
            #expect(agents.allSatisfy { $0.state == "running" })

            let reviews = store.reviews(for: session.sessionId)
            #expect(reviews.count == 1)
            #expect(reviews.first?.reviewId == "review-fixture")
            #expect(reviews.first?.findings.count == 1)

            #expect(store.artifacts(for: session.sessionId).isEmpty)
            #expect(store.todoPhases(for: session.sessionId).isEmpty)
            #expect(store.attentionSessions.isEmpty)
            #expect(store.pendingAsk == nil)

            let review = await store.reviewRead(sessionId: session.sessionId)
            #expect(review?.reviewId == "review-fixture")
            #expect(review?.status == "pending")
            #expect(review?.path == "src/fixture.ts")
            #expect(review?.findings.count == 1)
            #expect(store.lastError == nil)

            await store.disconnect()
        } catch {
            await store.disconnect()
            throw error
        }
    }

    @Test("Derived pane models expose live agents plans artifacts and asks")
    func derivedPaneModels() async throws {
        let store = T4SessionStore()
        store.connectionModel.connected = true

        store.agentModel.agentsBySession["session-pane"] = [
            T4SessionStore.AgentState(
                agentId: "agent-one",
                state: "running",
                progress: 0.5,
                detail: "Reviewing pane parity"
            ),
        ]
        #expect(store.agents(for: "session-pane") == [
            T4SessionStore.AgentState(
                agentId: "agent-one",
                state: "running",
                progress: 0.5,
                detail: "Reviewing pane parity"
            ),
        ])

        let phase = PlanPhase(name: "Pane parity", tasks: [
            PlanTask(content: "Port the pane", status: "completed"),
            PlanTask(content: "Inspect the pane", status: "in_progress"),
        ])
        store.transcriptModel.todoPhasesBySession["session-pane"] = [phase]
        #expect(store.todoPhases(for: "session-pane") == [phase])
        #expect(phase.doneCount == 1)

        let entryJSON = #"{"id":"entry-artifact","hostId":"host-pane","sessionId":"session-pane","kind":"message","timestamp":"2026-08-09T21:00:00Z","data":{"role":"assistant","text":"Artifact ready","artifacts":[{"artifactId":"artifact-one","kind":"text","mediaType":"text/plain","size":12,"name":"notes.txt","disposition":"inline"},{"artifactId":"artifact-one","kind":"text","mediaType":"text/plain","disposition":"inline"}]}}"#
        let entry = try TranscriptEntry.decode(Data(entryJSON.utf8))
        store.transcriptModel.entries["session-pane"] = [entry]
        let artifacts = store.artifacts(for: "session-pane")
        #expect(artifacts.count == 1)
        #expect(artifacts.first?.artifactId == "artifact-one")
        #expect(artifacts.first?.name == "notes.txt")

        store.pendingAsk = T4SessionStore.PendingAsk(
            sessionId: "session-pane",
            request: AskRequest(
                askId: "ask-one",
                question: "Apply the pane plan?",
                options: [AskOption(id: "approve", label: "Approve")]
            )
        )
        await store.respondAsk(value: "approve")
        #expect(store.pendingAsk == nil)
    }

    @Test("Inbox derives priority and recency from live sessions")
    func inboxPriorityAndSort() throws {
        let store = T4SessionStore()
        store.connectionModel.sessions = [
            try session(
                id: "approval",
                updatedAt: "2026-08-09T21:00:00Z",
                pendingApproval: true,
                pendingUserInput: true,
                proposedPlan: "Also has a plan"
            ),
            try session(
                id: "input",
                updatedAt: "2026-08-09T21:01:00Z",
                pendingUserInput: true
            ),
            try session(
                id: "plan",
                updatedAt: "2026-08-09T21:02:00Z",
                proposedPlan: "Review this plan"
            ),
            try session(id: "idle", updatedAt: "2026-08-09T21:03:00Z"),
        ]

        #expect(store.attentionSessions.map(\.id) == ["plan", "input", "approval"])
        #expect(store.attentionSessions.map(\.reasonLabel) == ["Plan", "Input", "Approval"])
    }

    @Test("Command palette hides actions that cannot run")
    func paletteAvailability() {
        #expect(PaletteAction.connect.isAvailable(connected: false, hasSelected: false))
        #expect(!PaletteAction.disconnect.isAvailable(connected: false, hasSelected: false))
        #expect(!PaletteAction.newSession.isAvailable(connected: false, hasSelected: false))
        #expect(PaletteAction.toggleTheme.isAvailable(connected: false, hasSelected: false))
        #expect(!PaletteAction.newSession.isAvailable(connected: true, hasSelected: false))
        #expect(PaletteAction.newSession.isAvailable(connected: true, hasSelected: true))
        #expect(PaletteAction.disconnect.isAvailable(connected: true, hasSelected: false))
        #expect(PaletteAction.rename.isAvailable(connected: true, hasSelected: true))
        #expect(PaletteAction.planModeOn.isAvailable(connected: true, hasSelected: true))
        #expect(PaletteAction.planModeOff.isAvailable(connected: true, hasSelected: true))
    }
}

@MainActor
private func waitForPaneStore(
    _ operation: String,
    timeout: TimeInterval = 10,
    condition: @MainActor () async -> Bool
) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() {
            return
        }
        try await Task.sleep(for: .milliseconds(50))
    }
    throw WindowsFixtureProbeError.timeout(operation)
}

private func session(
    id: String,
    updatedAt: String,
    pendingApproval: Bool? = nil,
    pendingUserInput: Bool? = nil,
    proposedPlan: String? = nil
) throws -> SessionRef {
    var object: [String: Any] = [
        "hostId": "host-pane",
        "sessionId": id,
        "project": ["projectId": "project-pane", "name": "Pane project"],
        "revision": "revision-\(id)",
        "title": "Session \(id)",
        "status": "idle",
        "updatedAt": updatedAt,
    ]
    if let pendingApproval { object["pendingApproval"] = pendingApproval }
    if let pendingUserInput { object["pendingUserInput"] = pendingUserInput }
    if let proposedPlan { object["proposedPlan"] = proposedPlan }
    let data = try JSONSerialization.data(withJSONObject: object)
    return try JSONDecoder().decode(SessionRef.self, from: data)
}

private enum PaneAssertionError: Error {
    case expectedSession
}
