import Foundation
import SwiftCrossUI
import HostWire
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

struct T4WorkspaceView: View {
    let theme: ThemeStore
    let store: T4SessionStore
    let configuration: T4WindowsLaunchConfiguration

    @State private var browserModel: T4WindowsBrowserWorkspaceModel
    @State private var connectionModel: T4WindowsConnectionCoordinator
    @State private var shell: T4LinuxV2ShellState
    @State private var composer = ""
    @State private var relativeTimeNow = Date()

    init(
        theme: ThemeStore,
        store: T4SessionStore,
        configuration: T4WindowsLaunchConfiguration
    ) {
        self.theme = theme
        self.store = store
        self.configuration = configuration
        _browserModel = State(wrappedValue: T4WindowsBrowserWorkspaceModel())
        _connectionModel = State(wrappedValue: T4WindowsConnectionCoordinator(store: store))
        _shell = State(wrappedValue: configuration.initialShellState)
    }

    var body: some View {
        ZStack {
            HStack(spacing: 0) {
                if shell.railVisible && !shell.compact {
                    T4LinuxV2SessionRail(
                        theme: theme,
                        store: store,
                        now: relativeTimeNow
                    )
                    .frame(width: 232)
                    Divider()
                }
                VStack(alignment: .leading, spacing: 0) {
                    topBar
                    Divider()
                    if shell.settingsPresented {
                        settingsPanel
                        Divider()
                    }
                    if let session = store.selectedSession {
                        T4LinuxV2TranscriptView(
                            session: session,
                            store: store,
                            theme: theme,
                            composer: $composer
                        )
                    } else {
                        Color.clear
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
                if shell.browserVisible && !shell.compact, let session = store.selectedSession {
                    Divider()
                    T4BrowserPaneView(
                        session: session,
                        store: store,
                        theme: theme,
                        browserModel: browserModel,
                        fixtureEnabled: configuration.browserFixtureEnabled,
                        isPresented: Binding(
                            get: { shell.browserVisible },
                            set: { shell.browserVisible = $0 }
                        )
                    )
                    .frame(width: 380)
                }
            }
            if connectionModel.screen == .signIn || connectionModel.screen == .pairComputer {
                onboardingOverlay
            }
        }
        .background(theme.t.bg)
        .foregroundColor(theme.t.txt)
        .onAppear {
            store.selectDefaultVisibleSessionIfNeeded()
            store.startDemoStreamIfNeeded()
            T4WindowsNativeWindow.setCompact(shell.compact)
        }
        .task {
            await connectionModel.start(
                forceOnboarding: configuration.captureState == .onboarding
            )
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                guard !Task.isCancelled else { return }
                relativeTimeNow = Date()
            }
        }
        .onChange(of: shell.compact) {
            T4WindowsNativeWindow.setCompact(shell.compact)
        }
    }

    private var topBar: some View {
        HStack(spacing: 8) {
            T4WindowsFlatButton(
                "☰",
                automationName: shell.railVisible ? "Hide session sidebar" : "Show session sidebar",
                dark: theme.dark
            ) {
                shell.toggleRail()
            }
            Text(T4LinuxV2ConnectionTitle.text(
                sessionTitle: store.selectedSession?.title,
                connected: store.connected,
                error: store.lastError
            ))
            .font(.system(size: 17, weight: .semibold))
            .foregroundColor(theme.t.txt)
            Spacer()
            T4WindowsFlatButton(
                "⤢",
                automationName: shell.compact ? "Restore window" : "Compact window",
                dark: theme.dark
            ) {
                shell.setCompact(!shell.compact)
            }
            T4WindowsFlatButton(
                "▤",
                automationName: shell.browserVisible ? "Hide browser sidebar" : "Show browser sidebar",
                dark: theme.dark
            ) {
                shell.toggleBrowser()
            }
            T4WindowsFlatButton(
                "⚙",
                automationName: shell.settingsPresented ? "Close settings" : "Open settings",
                dark: theme.dark
            ) {
                shell.settingsPresented.toggle()
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
    }

    private var settingsPanel: some View {
        HStack(spacing: 14) {
            Toggle("Dark mode", isOn: Binding(
                get: { theme.dark },
                set: { enabled in
                    if enabled != theme.dark { theme.toggle() }
                }
            ))
            Toggle("Compact window", isOn: Binding(
                get: { shell.compact },
                set: { shell.setCompact($0) }
            ))
            Toggle("Show sidebar", isOn: Binding(
                get: { shell.railVisible },
                set: { shell.railVisible = $0 }
            ))
        }
        .toggleStyle(.checkbox)
        .font(.system(size: 10.5))
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(theme.t.bg2)
    }

    private var onboardingOverlay: some View {
        ZStack {
            Color(hex: theme.dark ? 0x232136 : 0xFAF4ED)
                .opacity(0.93)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Group {
                if connectionModel.screen == .signIn {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Welcome to Omperator")
                            .font(.system(size: 19, weight: .bold))
                            .foregroundColor(theme.dark ? .white : Color(hex: 0x403C58))
                        Text("Sign in to start working on your computer.")
                            .font(.system(size: 10))
                            .foregroundColor(theme.t.txtMuted)
                        TextField("Username", text: Binding(
                            get: { connectionModel.username },
                            set: { connectionModel.username = $0 }
                        ))
                        .inspect([.onCreate, .afterUpdate]) { field in
                            T4WindowsNativeStyle.configureInput(
                                field,
                                automationName: "Username",
                                dark: theme.dark
                            )
                        }
                        .disabled(connectionModel.isSubmitting)
                        SecureField("Password", text: Binding(
                            get: { connectionModel.password },
                            set: { connectionModel.password = $0 }
                        ))
                        .inspect([.onCreate, .afterUpdate]) { field in
                            T4WindowsNativeStyle.configureInput(
                                field,
                                automationName: "Password",
                                dark: theme.dark
                            )
                        }
                        .disabled(connectionModel.isSubmitting)
                        T4WindowsFlatButton(
                            "Sign in",
                            automationName: connectionModel.isSubmitting ? "Signing in" : "Sign in",
                            dark: theme.dark,
                            width: 276
                        ) {
                            Task { await connectionModel.submitLogin() }
                        }
                        .disabled(connectionModel.isSubmitting)
                        onboardingStatus
                    }
                } else {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Pair your computer")
                            .font(.system(size: 19, weight: .bold))
                        Text("Enter the pairing code shown by Omperator on your computer.")
                            .font(.system(size: 10))
                            .foregroundColor(theme.t.txtMuted)
                        ForEach(connectionModel.hosts, id: \.hostId) { host in
                            T4WindowsFlatButton(
                                host.hostId == connectionModel.selectedHostID
                                    ? "● \(host.label.isEmpty ? host.hostname : host.label)"
                                    : "○ \(host.label.isEmpty ? host.hostname : host.label)",
                                automationName: "Computer: \(host.label.isEmpty ? host.hostname : host.label)",
                                dark: theme.dark,
                                width: 276
                            ) {
                                connectionModel.selectedHostID = host.hostId
                            }
                        }
                        TextField("6-digit pairing code", text: Binding(
                            get: { connectionModel.pairingCode },
                            set: { connectionModel.pairingCode = $0 }
                        ))
                        .inspect([.onCreate, .afterUpdate]) { field in
                            T4WindowsNativeStyle.configureInput(
                                field,
                                automationName: "Pairing code",
                                dark: theme.dark
                            )
                        }
                        .disabled(connectionModel.isSubmitting)
                        T4WindowsFlatButton(
                            connectionModel.isSubmitting ? "Connecting…" : "Connect",
                            automationName: connectionModel.isSubmitting ? "Connecting" : "Connect computer",
                            dark: theme.dark,
                            width: 276
                        ) {
                            Task { await connectionModel.submitPairingCode() }
                        }
                        .disabled(connectionModel.isSubmitting || connectionModel.selectedHost == nil)
                        T4WindowsFlatButton(
                            "Refresh computers",
                            automationName: "Refresh computers",
                            dark: theme.dark,
                            width: 276
                        ) {
                            Task { await connectionModel.refreshComputers() }
                        }
                        .disabled(connectionModel.isSubmitting)
                        onboardingStatus
                    }
                }
            }
            .padding(.vertical, 28)
            .padding(.horizontal, 32)
            .frame(width: 340)
            .background(theme.t.bg2)
        }
    }

    private var onboardingStatus: some View {
        Text(connectionModel.status)
            .font(.system(size: 10))
            .foregroundColor(connectionModel.statusIsError ? theme.t.diffDel : theme.t.txtMuted)
    }
}

private struct T4LinuxV2SessionRail: View {
    let theme: ThemeStore
    let store: T4SessionStore
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Text("Sessions")
                    .font(.system(size: 11))
                    .foregroundColor(theme.t.txtMuted)
                T4WindowsFlatButton("◐", automationName: "Switch color theme", dark: theme.dark) {
                    theme.toggle()
                }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(store.sessions.prefix(80)), id: \.sessionId) { session in
                        sessionRow(session)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(10)
    }

    private func sessionRow(_ session: SessionRef) -> some View {
        let visible = T4LinuxV2VisibleSession(session: session, now: now)
        return VStack(alignment: .leading, spacing: 2) {
            Text(visible.title)
                .font(.system(size: 11))
                .foregroundColor(theme.t.txt)
            if !visible.relativeTime.isEmpty {
                Text(visible.relativeTime)
                    .font(.system(size: 11))
                    .foregroundColor(theme.t.txtGhost)
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onTapGesture {
            store.select(session)
        }
    }
}
