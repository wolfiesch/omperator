//  T4CodeUITests.swift
//  UI tests against the offline sample inventory — no host required. These
//  drive the real UI: the rail drawer gesture path, session selection, the
//  model menu, and the composer's disconnected state. Launch args the app
//  understands: -T4RailOpen (boot with rail open).

import XCTest

final class T4CodeUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    private func launch(arguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        // Fresh state every run: no Keychain access, restored connection,
        // persisted rail state, or system permission prompts.
        app.launchArguments = [
            "-T4NoRestore",
            "-T4Demo",
            "-T4ResetRailPreferences",
            "-T4NoNotifications",
        ] + arguments
        app.launch()
        return app
    }

    // MARK: - Rail drawer

    @MainActor
    func testSidebarButtonOpensRailAndSelectsSession() throws {
        let app = launch()
        // Workspace opens on the most recent sample session.
        XCTAssertTrue(app.staticTexts["iOS session rail"].waitForExistence(timeout: 5))

        app.buttons["Show sessions"].tap()
        XCTAssertTrue(app.searchFields["Search sessions"].waitForExistence(timeout: 3))

        // The organization controls intentionally consume the first viewport;
        // scroll to prove rows below them remain reachable in the bounded list.
        let target = app.buttons["session-row-s2"]
        if !target.isHittable { app.swipeUp() }
        XCTAssertTrue(target.waitForExistence(timeout: 3))

        // Tapping a session closes the drawer and shows its detail.
        target.tap()
        XCTAssertTrue(app.staticTexts["Host-wire Swift port"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.searchFields["Search sessions"].exists)
    }

    @MainActor
    func testRailSearchFilters() throws {
        let app = launch(arguments: ["-T4RailOpen"])
        let search = app.searchFields["Search sessions"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("agent")
        XCTAssertTrue(app.buttons["session-row-s3"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["session-row-s4"].exists)
    }

    @MainActor
    func testRailSwitchesBetweenCurrentAndArchivedSessions() throws {
        let app = launch(arguments: ["-T4RailOpen"])
        XCTAssertTrue(app.buttons["session-row-s1"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["session-row-s5"].exists)

        let archived = app.buttons["Archived sessions"]
        XCTAssertTrue(archived.waitForExistence(timeout: 3))
        archived.tap()

        XCTAssertTrue(app.buttons["session-row-s5"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["session-row-s1"].exists)
        XCTAssertTrue(app.staticTexts["Finished release audit"].exists)
    }

    @MainActor
    func testRailAttentionFilterUsesAuthoritativeSessionSignals() throws {
        let app = launch(arguments: ["-T4RailOpen"])
        XCTAssertTrue(app.buttons["session-row-s3"].waitForExistence(timeout: 5))

        app.buttons["session-filter-attention"].tap()

        XCTAssertTrue(app.buttons["session-row-s1"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["session-row-s4"].exists)
        XCTAssertFalse(app.buttons["session-row-s2"].exists)
        XCTAssertFalse(app.buttons["session-row-s3"].exists)
    }

    // MARK: - Model menu

    @MainActor
    func testModelMenuShowsOfflineMessage() throws {
        let app = launch()
        XCTAssertTrue(app.staticTexts["iOS session rail"].waitForExistence(timeout: 5))
        // The toolbar model button is disabled while disconnected; the detail
        // header chip is too — the catalog only comes from a live host.
        let modelButton = app.buttons["Model and session controls"].firstMatch
        XCTAssertTrue(modelButton.exists)
        XCTAssertFalse(modelButton.isEnabled)
    }

    // MARK: - Composer (disconnected)

    @MainActor
    func testComposerIsHonestWhenDisconnected() throws {
        let app = launch()
        XCTAssertTrue(app.staticTexts["iOS session rail"].waitForExistence(timeout: 5))
        // The composer prompt is honest about needing a host (the field's
        // placeholder value, however SwiftUI exposes it this build).
        let composerField = app.descendants(matching: .any)
            .matching(NSPredicate(format: "placeholderValue CONTAINS[c] 'host'"))
            .firstMatch
        XCTAssertTrue(composerField.waitForExistence(timeout: 10))
        // Send is disabled with no host.
        XCTAssertFalse(app.buttons["Send message"].isEnabled)
    }

    // MARK: - Connection status bar

    @MainActor
    func testDisconnectedRailShowsStatusNotConnect() throws {
        let app = launch(arguments: ["-T4RailOpen"])
        XCTAssertTrue(app.staticTexts["Not connected"].waitForExistence(timeout: 5))
        // Pairing lives in onboarding/palette, not the rail.
        XCTAssertFalse(app.buttons["Connect to a T4 Code host"].exists)
    }

    @MainActor
    func testStreamingProofRevealsThinkingAndWriteIntermediateFrames() throws {
        let app = launch(arguments: ["-T4StreamingProof"])
        var thinkingFrames = Set<String>()
        var writeFrames = Set<String>()
        let deadline = Date().addingTimeInterval(18)
        let thinking = app.staticTexts["live-turn-thinking"]
        let write = app.staticTexts["live-turn-tool-write"].firstMatch

        while Date() < deadline {
            if thinking.exists { thinkingFrames.insert(thinking.label) }
            if write.exists { writeFrames.insert(write.label) }
            if thinkingFrames.count >= 3 && writeFrames.count >= 3 { break }
            Thread.sleep(forTimeInterval: 0.05)
        }

        XCTAssertGreaterThanOrEqual(thinkingFrames.count, 3)
        XCTAssertGreaterThanOrEqual(writeFrames.count, 3)
    }
}
