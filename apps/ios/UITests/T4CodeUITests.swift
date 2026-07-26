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
        // Fresh state every run: no persisted endpoint/creds, no restores.
        app.launchArguments = ["-T4NoRestore", "-T4Demo"] + arguments
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

        // Project group header with all four sample sessions.
        XCTAssertTrue(app.staticTexts["Host-wire Swift port"].exists)

        // Tapping a session closes the drawer and shows its detail.
        app.staticTexts["Host-wire Swift port"].tap()
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
        XCTAssertTrue(app.staticTexts["Agent view"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.staticTexts["Hosts & usage"].exists)
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
        // The composer prompt is honest about needing a host (placeholder
        // text is the field's own value, not a static label).
        let field = app.textFields["Connect a host to message"].firstMatch
        let fieldView = app.textViews["Connect a host to message"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10) || fieldView.waitForExistence(timeout: 3))
        // Send is disabled with no host.
        XCTAssertFalse(app.buttons["Send message"].isEnabled)
    }

    // MARK: - Connection status bar

    @MainActor
    func testDisconnectedRailShowsConnectButton() throws {
        let app = launch(arguments: ["-T4RailOpen"])
        XCTAssertTrue(app.buttons["Connect to a T4 Code host"].waitForExistence(timeout: 5))
    }
}
