//  RailGroupingTests.swift
//  Running vs Saved is host runtime liveness, not selection or a local turn.

import Foundation
import Testing
import HostWire
@testable import T4CodeLinuxLib

@Suite("Rail grouping")
struct RailGroupingTests {
    private func session(_ json: String) throws -> SessionRef {
        try JSONDecoder().decode(SessionRef.self, from: Data(json.utf8))
    }

    private func ref(
        id: String = "s",
        status: String = "idle",
        runtimeAlive: Bool? = nil,
        archived: Bool = false,
        observerLive: Bool = false
    ) throws -> SessionRef {
        var fields = """
        "hostId":"h","sessionId":"\(id)","project":{"projectId":"p"},\
        "revision":"r","title":"T","status":"\(status)",\
        "updatedAt":"2026-08-05T11:42:00.000Z"
        """
        if let runtimeAlive {
            fields += ",\"runtimeAlive\":\(runtimeAlive ? "true" : "false")"
        }
        if archived {
            fields += ",\"archivedAt\":\"2026-08-06T00:00:00.000Z\""
        }
        if observerLive {
            fields += ",\"liveState\":{\"sessionControl\":{\"mode\":\"observer\",\"lockStatus\":\"live\",\"transcript\":\"live\"}}"
        }
        return try session("{\(fields)}")
    }

    @Test
    func savedHistoryIsNotRunning() throws {
        let parked = try ref()
        #expect(!T4RailGrouping.isRunning(parked))
        #expect(T4RailGrouping.caption(parked, hasLiveTurn: false) == nil)
        #expect(T4RailGrouping.caption(parked, hasLiveTurn: true) == "Working")
    }

    @Test
    func selectionAndLocalTurnsDoNotMoveTheRow() throws {
        let selected = try ref(status: "idle")
        #expect(!T4RailGrouping.isRunning(selected))
        let streamingHere = try ref(status: "idle")
        #expect(!T4RailGrouping.isRunning(streamingHere))
        #expect(T4RailGrouping.caption(streamingHere, hasLiveTurn: true) == "Working")
    }

    @Test
    func liveRuntimeStaysRunningWhileIdle() throws {
        let quiet = try ref(status: "idle", runtimeAlive: true)
        #expect(T4RailGrouping.isRunning(quiet))
        #expect(T4RailGrouping.caption(quiet, hasLiveTurn: false) == nil)
        let turning = try ref(status: "active", runtimeAlive: true)
        #expect(T4RailGrouping.isRunning(turning))
        #expect(T4RailGrouping.caption(turning, hasLiveTurn: false) == "Working")
    }

    @Test
    func draftsCountAsRunning() throws {
        let draft = try ref(id: "draft-abc")
        #expect(T4RailGrouping.isDraftSession(draft.sessionId))
        #expect(T4RailGrouping.isRunning(draft))
        #expect(T4RailGrouping.caption(draft, hasLiveTurn: false) == "Starting")
    }

    @Test
    func closedAndArchivedNeverRun() throws {
        #expect(!T4RailGrouping.isRunning(try ref(status: "closed", runtimeAlive: true)))
        #expect(!T4RailGrouping.isRunning(try ref(runtimeAlive: true, archived: true)))
    }

    @Test
    func liveLockIsRunningOpenElsewhere() throws {
        let elsewhere = try ref(runtimeAlive: true, observerLive: true)
        #expect(T4RailGrouping.isRunning(elsewhere))
        #expect(T4RailGrouping.caption(elsewhere, hasLiveTurn: true) == "Open elsewhere")
    }

    @Test
    func errorsWinTheCaption() throws {
        let failed = try ref(status: "failed", runtimeAlive: true)
        #expect(T4RailGrouping.caption(failed, hasLiveTurn: true) == "Error")
    }
}
