import Foundation
import HostWire
import Testing
@testable import T4CodeWindowsLib

@Suite("Linux v2 Windows behavior", .serialized)
@MainActor
struct T4LinuxV2BehaviorTests {
    @Test("Rail projection exposes friendly titles and exact relative recency")
    func friendlyRailProjection() throws {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let now = try #require(formatter.date(from: "2026-08-12T12:00:00.000Z"))
        func timestamp(minutesAgo: Double) -> String {
            formatter.string(from: now.addingTimeInterval(-minutesAgo * 60))
        }

        #expect(T4LinuxV2RelativeTime.format(timestamp(minutesAgo: 0.5), now: now) == "just now")
        #expect(T4LinuxV2RelativeTime.format(timestamp(minutesAgo: 5), now: now) == "5m ago")
        #expect(T4LinuxV2RelativeTime.format(timestamp(minutesAgo: 120), now: now) == "2h ago")
        #expect(T4LinuxV2RelativeTime.format(timestamp(minutesAgo: 25 * 60), now: now) == "yesterday")
        #expect(T4LinuxV2RelativeTime.format(timestamp(minutesAgo: 3 * 24 * 60), now: now) == "3d ago")

        let oldDate = now.addingTimeInterval(-8 * 24 * 60 * 60)
        let dayFormatter = DateFormatter()
        dayFormatter.dateFormat = "MMM d"
        #expect(
            T4LinuxV2RelativeTime.format(formatter.string(from: oldDate), now: now)
                == dayFormatter.string(from: oldDate)
        )

        let source = try makeLinuxV2Session(
            hostID: "host-must-not-render",
            sessionID: "session-must-not-render",
            revision: "revision-must-not-render",
            title: "Friendly session",
            updatedAt: timestamp(minutesAgo: 5)
        )
        let visible = T4LinuxV2VisibleSession(session: source, now: now)
        #expect(visible.title == "Friendly session")
        #expect(visible.relativeTime == "5m ago")
        let reflected = String(reflecting: visible)
        #expect(!reflected.contains(source.hostId))
        #expect(!reflected.contains(source.sessionId))
        #expect(!reflected.contains(source.revision))
    }

    @Test("Only the browser is exposed by the ordinary sidebar")
    func browserOnlySidebarAndPlainShellSettings() {
        #expect(T4LinuxV2VisiblePane.ordinarySidebarPanes == [.browser])

        var shell = T4LinuxV2ShellState()
        shell.browserVisible = true
        shell.settingsPresented = true
        shell.setCompact(true)
        #expect(shell.compact)
        #expect(!shell.railVisible)
        #expect(!shell.browserVisible)
        #expect(shell.settingsPresented)

        shell.toggleBrowser()
        #expect(!shell.browserVisible)
        shell.setCompact(false)
        #expect(shell.railVisible)
        #expect(!shell.browserVisible)
        shell.toggleRail()
        #expect(!shell.railVisible)
    }

    @Test("Onboarding stays hidden while booting and forced capture shows sign in")
    func onboardingVisibilityAndValidation() async {
        let store = T4SessionStore()
        let secrets = WindowsInMemorySecretStore()
        let coordinator = T4WindowsConnectionCoordinator(
            store: store,
            credentials: T4WindowsAccountCredentialAccess(store: secrets)
        )

        #expect(coordinator.screen == .booting)
        await coordinator.start(forceOnboarding: true)
        #expect(coordinator.screen == .signIn)

        coordinator.username = "  "
        coordinator.password = ""
        await coordinator.submitLogin()
        #expect(coordinator.screen == .signIn)
        #expect(coordinator.status == "Enter your username and password to sign in.")
        #expect(coordinator.statusIsError)
        #expect(!coordinator.isSubmitting)
    }

    @Test("Rendezvous login falls back to registration then logs in again")
    func loginRegistrationFallback() async throws {
        let recorder = RendezvousFallbackRecorder()
        let client = T4RendezvousAccountClient(
            baseURL: try #require(URL(string: "https://rendezvous.invalid/")),
            postRequest: { url, body in
                await recorder.post(url: url, body: body)
            }
        )

        let token = try await client.loginOrRegister(
            username: "fixture-user",
            password: "correct-horse-123"
        )
        #expect(token == "fixture-account-token")

        let calls = await recorder.calls
        #expect(calls.map(\.path) == [
            "/v1/accounts/login",
            "/v1/accounts/register",
            "/v1/accounts/login",
        ])
        #expect(calls.allSatisfy {
            $0.username == "fixture-user" && $0.password == "correct-horse-123"
        })
    }

    @Test("Rendezvous validation never echoes arbitrary server payloads")
    func registrationValidationRedaction() async throws {
        let client = T4RendezvousAccountClient(
            baseURL: try #require(URL(string: "https://rendezvous.invalid/")),
            postRequest: { url, _ in
                if url.path.hasSuffix("/login") {
                    return (401, Data(#"{"error":"invalid credentials"}"#.utf8))
                }
                return (400, Data(#"{"error":"password=server-echoed-value"}"#.utf8))
            }
        )

        do {
            _ = try await client.loginOrRegister(
                username: "fixture-user",
                password: "correct-horse-123"
            )
            Issue.record("Expected invalid registration input")
        } catch let error as T4WindowsAccountError {
            guard case .invalidInput(let message) = error else {
                Issue.record("Expected invalidInput, received \(error)")
                return
            }
            #expect(!message.contains("server-echoed-value"))
            #expect(!T4WindowsRedaction.containsSecretMaterial(message))
        } catch {
            Issue.record("Expected T4WindowsAccountError, received \(error)")
        }
    }

    @Test("Authentication and transport failures never project secret material")
    func friendlyErrorRedaction() {
        let raw = "pairing code 123456 failed for wss://relay.invalid/r/room?accountToken=do-not-project"
        #expect(T4WindowsRedaction.containsSecretMaterial(raw))

        let friendly = T4WindowsRedaction.friendlyConnectionError(raw)
        #expect(friendly == "Pairing failed. Check the code and try again.")
        #expect(!T4WindowsRedaction.containsSecretMaterial(friendly))
        #expect(!friendly.contains("123456"))
        #expect(!friendly.contains("do-not-project"))

        let title = T4LinuxV2ConnectionTitle.text(
            sessionTitle: nil,
            connected: false,
            error: raw
        )
        #expect(title == "⚠ Pairing failed. Check the code and try again.")
        #expect(!T4WindowsRedaction.containsSecretMaterial(title))
        #expect(T4WindowsAccountError.invalidCredentials.errorDescription
            == "That username or password isn't right — try again.")
    }

    @Test("User messages stay verbatim and composer disables during streaming")
    func userMessageAndStreamingComposerPolicy() {
        let body = "**literal** user text"
        #expect(T4LinuxV2MarkdownParser.render(body: body, role: "user") == [
            .init(text: body, style: .user),
        ])
        #expect(T4LinuxV2ComposerPolicy.isEnabled(
            connected: true,
            hasSession: true,
            streamingText: ""
        ))
        #expect(!T4LinuxV2ComposerPolicy.isEnabled(
            connected: true,
            hasSession: true,
            streamingText: "live tail"
        ))
        #expect(!T4LinuxV2ComposerPolicy.isEnabled(
            connected: false,
            hasSession: true,
            streamingText: ""
        ))
    }

    @Test("First open follows bottom and each session restores its own offset")
    func transcriptScrollMemory() {
        var memory = T4TranscriptScrollMemory()

        #expect(memory.switchSession(to: "session-a", outgoingOffset: nil) == nil)
        #expect(memory.followsBottom)
        #expect(memory.targetAfterContentGrowth(upper: 1_000, page: 300) == 700)

        memory.userScrolled(value: 120, page: 300, upper: 1_000)
        #expect(!memory.followsBottom)
        #expect(memory.targetAfterContentGrowth(upper: 1_200, page: 300) == nil)

        #expect(memory.switchSession(to: "session-b", outgoingOffset: 120) == nil)
        #expect(memory.followsBottom)
        memory.userScrolled(value: 660, page: 300, upper: 1_000)
        #expect(memory.followsBottom)
        #expect(memory.targetAfterContentGrowth(upper: 1_200, page: 300) == 900)

        #expect(memory.switchSession(to: "session-a", outgoingOffset: 660) == 120)
        #expect(!memory.followsBottom)
    }

    @Test("Markdown grammar preserves nested lists and all emphasis variants")
    func markdownListsAndEmphasis() {
        let lists = T4LinuxV2MarkdownParser.render(body: "- parent\n  - child\n    2. ordered")
        #expect(lists == [
            .init(text: "- parent\n", style: .list),
            .init(text: "  - child\n", style: .list),
            .init(text: "    2. ordered", style: .list),
        ])

        let emphasis = T4LinuxV2MarkdownParser.render(
            body: "**bold** _italic_ ***both*** ___underscored___ `inline` [docs](https://example.invalid)"
        )
        let styled = emphasis.filter {
            !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        #expect(styled == [
            .init(text: "bold", style: .bold),
            .init(text: "italic", style: .italic),
            .init(text: "both", style: .boldItalic),
            .init(text: "underscored", style: .boldItalic),
            .init(text: "inline", style: .inlineCode),
            .init(text: "docs", style: .link),
        ])
    }

    @Test("Fenced code and advisory blocks remain distinct while streaming")
    func markdownBlockExpansion() {
        let blocks = T4LinuxV2MarkdownParser.blocks(
            "Intro\n```swift\nlet answer = 42\n```\n<advisory severity=\"warning\" guidance=\"Use care\">Body &amp; detail</advisory>\nOutro"
        )
        #expect(blocks == [
            .prose("Intro"),
            .code(language: "swift", body: "let answer = 42"),
            .advisory(severity: "warning", guidance: "Use care", body: "Body & detail"),
            .prose("Outro"),
        ])

        #expect(T4LinuxV2MarkdownParser.blocks("```swift\npartial") == [
            .code(language: "swift", body: "partial"),
        ])
        #expect(T4LinuxV2MarkdownParser.blocks(
            "<advisory severity=\"info\">still streaming"
        ) == [
            .advisory(severity: "info", guidance: nil, body: "still streaming"),
        ])
    }

    @Test("Runtime theme toggle alternates resolved Moon and Dawn state")
    func runtimeThemeSwitch() {
        let defaults = UserDefaults.standard
        let key = "enclave.theme"
        let previous = defaults.object(forKey: key)
        defer {
            if let previous {
                defaults.set(previous, forKey: key)
            } else {
                defaults.removeObject(forKey: key)
            }
        }

        let theme = ThemeStore()
        theme.mode = .dark
        #expect(theme.effective == .dark)
        #expect(theme.dark)
        theme.toggle()
        #expect(theme.effective == .light)
        #expect(!theme.dark)

        theme.mode = .system
        theme.systemDark = true
        #expect(theme.effective == .dark)
        theme.toggle()
        #expect(theme.mode == .light)
        #expect(theme.effective == .light)
    }
}

private actor RendezvousFallbackRecorder {
    struct Call: Sendable {
        let path: String
        let username: String?
        let password: String?
    }

    private(set) var calls: [Call] = []

    func post(url: URL, body: [String: String]) -> (Int, Data) {
        calls.append(Call(
            path: url.path,
            username: body["username"],
            password: body["password"]
        ))
        switch calls.count {
        case 1:
            return (401, Data(#"{"error":"invalid credentials"}"#.utf8))
        case 2:
            return (200, Data(#"{"ok":true}"#.utf8))
        default:
            return (200, Data(#"{"token":"fixture-account-token"}"#.utf8))
        }
    }
}

private func makeLinuxV2Session(
    hostID: String,
    sessionID: String,
    revision: String,
    title: String,
    updatedAt: String
) throws -> SessionRef {
    let object: [String: Any] = [
        "hostId": hostID,
        "sessionId": sessionID,
        "project": ["projectId": "project-hidden", "name": "Hidden project"],
        "revision": revision,
        "title": title,
        "status": "internal-status-must-not-render",
        "updatedAt": updatedAt,
    ]
    let data = try JSONSerialization.data(withJSONObject: object)
    return try JSONDecoder().decode(SessionRef.self, from: data)
}
