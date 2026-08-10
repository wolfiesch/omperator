import Testing
@testable import T4CodeWindowsLib

private final class BrowserBridgeOwner {}

@Suite("Windows native browser")
struct T4WindowsBrowserTests {
    @Test("URL input normalizes HTTP addresses and rejects malformed values")
    func urlNormalization() {
        #expect(T4WindowsBrowserURL.normalize("example.com/path") == "https://example.com/path")
        #expect(T4WindowsBrowserURL.normalize("  http://localhost:8080/demo  ") == "http://localhost:8080/demo")
        #expect(T4WindowsBrowserURL.normalize("") == nil)
        #expect(T4WindowsBrowserURL.normalize("http://") == nil)
        #expect(T4WindowsBrowserURL.normalize("https://exa mple.test") == nil)
        #expect(T4WindowsBrowserURL.normalize("javascript:alert(1)") == nil)
    }

    @Test("Browser URL and navigation state stay isolated per session")
    func sessionIsolation() {
        let model = T4WindowsBrowserWorkspaceModel()
        _ = model.mount(sessionID: "session-a", initialURL: "https://a.example")
        _ = model.apply(.init(sessionID: "session-a", event: .surfaceReady))
        _ = model.apply(.init(
            sessionID: "session-a",
            event: .navigationState(
                url: "https://a.example/two",
                title: "A two",
                canGoBack: true,
                canGoForward: false,
                isLoading: false,
                failure: nil
            )
        ))

        _ = model.mount(sessionID: "session-b", initialURL: "https://b.example")
        _ = model.apply(.init(sessionID: "session-b", event: .surfaceReady))
        _ = model.apply(.init(
            sessionID: "session-b",
            event: .navigationState(
                url: "https://b.example/only",
                title: "B only",
                canGoBack: false,
                canGoForward: true,
                isLoading: false,
                failure: nil
            )
        ))

        let sessionA = model.snapshot(sessionID: "session-a", initialURL: "https://ignored.example")
        let sessionB = model.snapshot(sessionID: "session-b", initialURL: "https://ignored.example")
        #expect(sessionA.currentURL == "https://a.example/two")
        #expect(sessionA.title == "A two")
        #expect(sessionA.canGoBack)
        #expect(!sessionA.canGoForward)
        #expect(sessionB.currentURL == "https://b.example/only")
        #expect(sessionB.title == "B only")
        #expect(!sessionB.canGoBack)
        #expect(sessionB.canGoForward)
    }

    @Test("Unavailable navigation capabilities never emit native commands")
    func capabilityGating() {
        let model = T4WindowsBrowserWorkspaceModel()
        _ = model.mount(sessionID: "session", initialURL: "https://example.com")
        let owner = BrowserBridgeOwner()
        var commands: [T4WindowsBrowserNativeCommand] = []
        model.surfaceBridge.attach(
            owner: owner,
            onActivate: { _ in },
            onCommand: { sessionID, command in
                if sessionID == "session" { commands.append(command) }
            },
            onCloseSession: { _ in }
        )

        #expect(model.dispatch(sessionID: "session", action: .back) == nil)
        #expect(model.dispatch(sessionID: "session", action: .forward) == nil)
        #expect(model.dispatch(sessionID: "session", action: .reload) == nil)
        #expect(model.dispatch(sessionID: "session", action: .stop) == nil)
        #expect(commands.isEmpty)

        _ = model.apply(.init(sessionID: "session", event: .surfaceReady))
        #expect(model.dispatch(sessionID: "session", action: .reload) == .reload)
        #expect(model.dispatch(sessionID: "session", action: .back) == nil)
        #expect(commands == [.reload])

        _ = model.apply(.init(sessionID: "session", event: .navigationStarted(url: "https://example.com/two")))
        let historyUpdate = model.apply(.init(
            sessionID: "session",
            event: .navigationState(
                url: "https://example.com/two",
                title: "Two",
                canGoBack: true,
                canGoForward: false,
                isLoading: nil,
                failure: nil
            )
        ))
        #expect(historyUpdate.isLoading)
        #expect(model.dispatch(sessionID: "session", action: .stop) == .stop)
        #expect(commands == [.reload, .stop])

        _ = model.apply(.init(
            sessionID: "session",
            event: .navigationState(
                url: "https://example.com/two",
                title: "Two",
                canGoBack: true,
                canGoForward: false,
                isLoading: false,
                failure: nil
            )
        ))
        #expect(model.dispatch(sessionID: "session", action: .back) == .back)
        #expect(model.dispatch(sessionID: "session", action: .forward) == nil)
        #expect(model.dispatch(sessionID: "session", action: .stop) == nil)
        #expect(commands == [.reload, .stop, .back])
    }

    @Test("Intentional stops do not surface cancellation errors")
    func intentionalStopFailureMapping() {
        #expect(
            T4WindowsWebView2.Coordinator.navigationFailureMessage(
                .operationCanceled,
                wasStoppedByUser: true
            ) == nil
        )
        #expect(
            T4WindowsWebView2.Coordinator.navigationFailureMessage(
                .operationCanceled
            ) == "Navigation canceled."
        )
    }

    @Test("Malformed navigation never creates a native request")
    func malformedNavigation() {

        let model = T4WindowsBrowserWorkspaceModel()
        _ = model.mount(sessionID: "session", initialURL: "https://example.com")
        _ = model.apply(.init(sessionID: "session", event: .surfaceReady))

        #expect(model.command(sessionID: "session", action: .navigate("https://bad host")) == nil)
        #expect(model.snapshot(sessionID: "session", initialURL: "https://ignored.example").errorMessage != nil)
    }

    @Test("Runtime and command failures stay visible and disable navigation")
    func failureStates() {
        let model = T4WindowsBrowserWorkspaceModel()
        _ = model.mount(sessionID: "session", initialURL: "https://example.com")

        let unavailable = model.apply(.init(
            sessionID: "session",
            event: .runtimeUnavailable("WebView2 runtime is missing.")
        ))
        #expect(unavailable.surfaceState == .unavailable("WebView2 runtime is missing."))
        #expect(unavailable.errorMessage == "WebView2 runtime is missing.")
        #expect(!unavailable.isLoading)
        #expect(model.dispatch(sessionID: "session", action: .reload) == nil)

        _ = model.apply(.init(sessionID: "session", event: .surfaceReady))
        let failed = model.apply(.init(
            sessionID: "session",
            event: .commandFailed("Navigation was rejected.")
        ))
        #expect(failed.surfaceState == .ready)
        #expect(failed.errorMessage == "Navigation was rejected.")
    }

    @Test("Repeated representable updates do not replay browser activation")
    func idempotentSurfaceAttachment() {
        let bridge = T4WindowsBrowserSurfaceBridge()
        let owner = BrowserBridgeOwner()
        var activatedSessionIDs: [String] = []
        bridge.activate(.init(
            sessionID: "session",
            initialURL: "https://example.com",
            fixtureHTML: nil,
            backgroundHex: 0xFFFFFF
        ))

        for _ in 0..<3 {
            bridge.attach(
                owner: owner,
                onActivate: { activatedSessionIDs.append($0.sessionID) },
                onCommand: { _, _ in },
                onCloseSession: { _ in }
            )
        }

        #expect(activatedSessionIDs == ["session"])
        bridge.detach(owner: owner)
        bridge.attach(
            owner: owner,
            onActivate: { activatedSessionIDs.append($0.sessionID) },
            onCommand: { _, _ in },
            onCloseSession: { _ in }
        )
        #expect(activatedSessionIDs == ["session", "session"])
    }

    @Test("Pane cleanup releases mounted state but preserves the last URL")
    func paneCleanup() {
        let model = T4WindowsBrowserWorkspaceModel()
        _ = model.mount(sessionID: "kept", initialURL: "https://example.com")
        _ = model.apply(.init(sessionID: "kept", event: .surfaceReady))
        _ = model.apply(.init(
            sessionID: "kept",
            event: .navigationState(
                url: "https://example.com/final",
                title: "Final",
                canGoBack: true,
                canGoForward: true,
                isLoading: false,
                failure: nil
            )
        ))

        let closed = model.unmount(sessionID: "kept")
        #expect(!model.mountedSessionIDs.contains("kept"))
        #expect(closed?.surfaceState == .idle)
        #expect(closed?.currentURL == "https://example.com/final")
        #expect(closed?.canGoBack == false)
        #expect(closed?.canGoForward == false)

        _ = model.mount(sessionID: "discarded", initialURL: "https://discarded.example")
        model.prune(keeping: ["kept"])
        #expect(model.snapshots["kept"] != nil)
        #expect(model.snapshots["discarded"] == nil)
        #expect(!model.mountedSessionIDs.contains("discarded"))
    }

    @Test("Local fixture includes history, popup, and scroll probes")
    func localFixture() throws {
        let html = try #require(T4WindowsBrowserFixture.html)
        #expect(html.contains("id=\"details-link\""))
        #expect(html.contains("target=\"_blank\""))
        #expect(html.contains("id=\"failure-link\""))
        #expect(html.contains("height: 760px"))
        #expect(html.contains("hashchange"))
    }
}
