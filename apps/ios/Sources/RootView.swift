//  RootView.swift
//  Native TabView — Sessions / Activity / Trust. AppModel holds the guest's saved
//  rooms and the one live connection, so Activity/Trust read live frames too.
//  A guest joins one omp session per link; there is no session enumeration in the
//  collab protocol, so "Sessions" is the rooms you've joined, stored on-device.

import SwiftUI
import UIKit
import Combine

@MainActor
final class AppModel: ObservableObject {
    @Published var sessions: [JoinedSession]
    @Published var active: GuestClient?
    @Published var showEditor = false
    @Published var tab = 0          // selected main tab; the logo button jumps here to 0
    @Published var live: [String: Bool] = [:]   // session.id → host currently connected
    @Published var state: [String: SessionState] = [:] // session.id → richer background state

    private let key = "enclave.sessions"
    private let liveActivity = LiveActivityController()
    private let notify = NotificationPolicy()
    private var cancellable: AnyCancellable?
    private var clients: [String: GuestClient] = [:]    // background watchers
    private var watchers: [String: AnyCancellable] = [:]  // objectWillChange subscriptions
    private var welcomeTimeouts: [String: Task<Void, Never>] = [:]
    private var activeWelcomeTimeout: Task<Void, Never>?
    private let welcomeGrace: TimeInterval = 8

    init() {
        if let data = UserDefaults.standard.data(forKey: key),
           let list = try? JSONDecoder().decode([JoinedSession].self, from: data) {
            sessions = list
        } else { sessions = [] }
        tab = Int(ProcessInfo.processInfo.environment["ENCLAVE_TAB"] ?? "") ?? 0
    }

    @discardableResult
    func connect(link: String, name: String, paired: Bool = false) -> Bool {
        stopWatcher(for: link)   // hand off from background watcher to active editor client
        guard let client = GuestClient(link: link, name: name) else { return false }
        client.justPaired = paired   // fresh QR pair → transcript shows a paired notice
        active = client
        client.connect()
        // Showcase/screenshot mode connects in the background so the tabs stay visible.
        showEditor = ProcessInfo.processInfo.environment["ENCLAVE_SHOWCASE"] != "1"
        upsert(JoinedSession(id: link, link: link, title: "live session",
                             relay: client.relay, readOnly: client.readOnly, savedAt: Date()))
        // Drive the Live Activity + ask notifications from live frames.
        if ProcessInfo.processInfo.environment["ENCLAVE_SCREENSHOT"] != "1" { Notifier.requestAuth() }
        notify.reset()
        cancellable = client.objectWillChange.receive(on: RunLoop.main).sink { [weak self] in self?.onClientChanged() }
        scheduleActiveWelcomeTimeout(client)
        return true
    }

    private func onClientChanged() {
        guard let c = active else { return }
        if let link = connectedLink, let i = sessions.firstIndex(where: { $0.link == link }) {
            updateState(sessions[i].id, from: c)
        }
        if c.phase == "ended" { liveActivity.end() }
        else { liveActivity.sync(sessionId: c.sessionId, state: LiveActivityController.state(from: c)) }
        // Only trust a WELCOMED connection (a host actually answered). Tapping a
        // dead room connects but never welcomes — don't overwrite the saved room's
        // title/badge with the client's pre-welcome defaults, and don't call it live.
        if let link = connectedLink, let i = sessions.firstIndex(where: { $0.link == link }) {
            if c.welcomed { live[sessions[i].id] = true }
            if c.welcomed {
                activeWelcomeTimeout?.cancel(); activeWelcomeTimeout = nil
                if !c.title.isEmpty, c.title != "live session", sessions[i].title != c.title { sessions[i].title = c.title; save() }
                if c.enhanced, sessions[i].enhanced != true { sessions[i].enhanced = true; save() }
            }
        }
        // Only notify while you're AWAY (locked / another app). Foreground banners
        // fired while you're watching the transcript — that's the "random" one.
        let away = UIApplication.shared.applicationState != .active
        notify.update(c, away: away)
    }

    func leave() {
        guard active != nil else { return }   // idempotent: Leave button + onDisappear both call this
        let leftLink = connectedLink
        if let c = active, c.welcomed, let link = leftLink, let i = sessions.firstIndex(where: { $0.link == link }) {
            sessions[i].title = c.title
            sessions[i].readOnly = c.readOnly
            sessions[i].enhanced = c.enhanced   // authoritative once actually welcomed
            save()
        }
        cancellable?.cancel(); cancellable = nil
        activeWelcomeTimeout?.cancel(); activeWelcomeTimeout = nil
        notify.reset()
        liveActivity.end()
        active?.close()
        active = nil
        showEditor = false
        // Hand off the just-left session to a background watcher so the list stays live.
        if let link = leftLink, let s = sessions.first(where: { $0.link == link }) {
            connectedLink = nil
            startWatcher(for: s)
        } else {
            connectedLink = nil
        }
        refreshLiveness()
    }

    func remove(_ s: JoinedSession) { sessions.removeAll { $0.id == s.id }; live[s.id] = nil; state[s.id] = nil; stopWatcher(for: s.id); save() }

    func setTagColor(_ color: SessionColor, for id: String) {
        guard let i = sessions.firstIndex(where: { $0.id == id }) else { return }
        sessions[i].tagColor = color
        save()
    }

    /// Drop every offline session in one go (keeps the one you're connected to).
    func clearOffline() {
        let keep = connectedLink
        for s in sessions where live[s.id] != true && s.link != keep {
            live[s.id] = nil
            state[s.id] = nil
            stopWatcher(for: s.id)
        }
        sessions.removeAll { live[$0.id] != true && $0.link != keep }
        save()
    }

    /// Ping each saved room's relay status endpoint to see if a host is connected.
    /// Live sessions also get a background GuestClient watcher so the list reflects
    /// realtime state (working, phase, title) without loading the full chat.
    func refreshLiveness() {
        let connected = connectedLink
        for s in sessions {
            if s.link == connected {
                live[s.id] = active?.welcomed ?? false
                syncWatchers()
                continue
            }
            guard let url = statusURL(for: s.link) else {
                if clients[s.id]?.welcomed != true {
                    live[s.id] = false
                    state[s.id] = SessionState()
                }
                syncWatchers()
                continue
            }
            Task { [weak self] in
                var req = URLRequest(url: url)
                req.timeoutInterval = 6
                req.cachePolicy = .reloadIgnoringLocalCacheData
                var isLive = false
                if let (data, resp) = try? await URLSession.shared.data(for: req),
                   (resp as? HTTPURLResponse)?.statusCode == 200,
                   let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    isLive = obj["live"] as? Bool ?? false
                }
                await MainActor.run {
                    if isLive {
                        self?.live[s.id] = true
                    } else if self?.clients[s.id]?.welcomed != true {
                        self?.live[s.id] = false
                        self?.state[s.id] = SessionState()
                    }
                    self?.syncWatchers()
                }
            }
        }
    }

    // MARK: - Background session watchers

    private var deviceName: String { UIDevice.current.name }

    private func startWatcher(for s: JoinedSession) {
        guard clients[s.id] == nil else { return }
        guard let client = GuestClient(link: s.link, name: deviceName) else { return }
        clients[s.id] = client
        client.connect()
        watchers[s.id] = client.objectWillChange.receive(on: RunLoop.main).sink { [weak self, weak client] in
            guard let self, let client else { return }
            self.updateState(s.id, from: client)
        }
    }

    private func stopWatcher(for id: String) {
        cancelWelcomeTimeout(for: id)
        clients[id]?.close()
        clients[id] = nil
        watchers[id]?.cancel()
        watchers[id] = nil
    }

    private func scheduleWelcomeTimeout(for id: String, client: GuestClient) {
        // Only background watchers can strand in "connected, never welcomed". The
        // active editor client shows its own connecting state and is excluded.
        guard clients[id] === client else { return }
        cancelWelcomeTimeout(for: id)
        welcomeTimeouts[id] = Task { [weak self, weak client] in
            try? await Task.sleep(nanoseconds: UInt64((self?.welcomeGrace ?? 8) * 1_000_000_000))
            guard !Task.isCancelled, let self = self else { return }
            await MainActor.run {
                guard let c = client, !c.welcomed, c.phase != "ended" else { return }
                // Still no welcome after the grace window — treat host as unreachable.
                self.live[id] = false
                self.state[id] = SessionState()
                self.stopWatcher(for: id)
            }
        }
    }
    private func scheduleActiveWelcomeTimeout(_ client: GuestClient) {
        activeWelcomeTimeout?.cancel()
        activeWelcomeTimeout = Task { [weak self, weak client] in
            try? await Task.sleep(nanoseconds: UInt64((self?.welcomeGrace ?? 8) * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard let self, let client,
                      self.active === client,
                      !client.welcomed,
                      client.phase != "ended" else { return }
                self.leave()
            }
        }
    }
    private func cancelWelcomeTimeout(for id: String) {
        welcomeTimeouts[id]?.cancel(); welcomeTimeouts[id] = nil
    }

    private func syncWatchers() {
        for s in sessions {
            // Never run a background watcher for the currently active editor session.
            if s.link == connectedLink || clients[s.id] === active { stopWatcher(for: s.id); continue }
            if live[s.id] == true { startWatcher(for: s) } else { stopWatcher(for: s.id) }
        }
    }

    private func updateState(_ id: String, from client: GuestClient) {
        let welcomed = client.welcomed
        let phase = client.phase

        // Definitive offline: host ended / reconnect exhausted.
        if phase == "ended" {
            cancelWelcomeTimeout(for: id)
            live[id] = false
            state[id] = SessionState()
            stopWatcher(for: id)
            return
        }

        // Confirmed live: full snapshot, upgrade liveness.
        if welcomed {
            cancelWelcomeTimeout(for: id)
            state[id] = SessionState(
                live: true, working: client.working, phase: phase,
                title: client.title, mode: client.currentMode, lastSeen: Date())
            live[id] = true
            if !client.title.isEmpty, client.title != "live session",
               let i = sessions.firstIndex(where: { $0.id == id }),
               sessions[i].title != client.title {
                sessions[i].title = client.title; save()
            }
            return
        }

        // Pre-welcome handshake (connecting/reconnecting/waiting). A fresh client
        // swapping in must NOT flip a live host offline. Preserve prior liveness;
        // refresh only the volatile fields. The grace timeout (Step 5) bounds how
        // long we'll stay optimistic if a welcome never arrives.
        if var s = state[id] {
            s.working = client.working
            s.phase = phase
            if let m = client.currentMode { s.mode = m }
            s.lastSeen = Date()
            state[id] = s
            // live[id] intentionally untouched — sticky.
        } else {
            // No prior state for this session (never confirmed live): show neutral
            // pre-welcome state. live[id] stays nil/false — a genuinely unknown host
            // is not "live" until it welcomes.
            state[id] = SessionState(
                live: false, working: client.working, phase: phase,
                title: client.title, mode: client.currentMode, lastSeen: Date())
        }
        scheduleWelcomeTimeout(for: id, client: client)
    }

    private func statusURL(for link: String) -> URL? {
        guard case let .ok(parsed) = CollabLink.parse(link) else { return nil }
        var s = parsed.wsURL.absoluteString
        if s.hasPrefix("wss://") { s = "https://" + s.dropFirst(6) }
        else if s.hasPrefix("ws://") { s = "http://" + s.dropFirst(5) }
        return URL(string: s)
    }

    private var connectedLink: String?

    private func upsert(_ s: JoinedSession) {
        connectedLink = s.link
        if let i = sessions.firstIndex(where: { $0.id == s.id }) {
            sessions[i].savedAt = s.savedAt; sessions[i].relay = s.relay; sessions[i].readOnly = s.readOnly
        } else {
            sessions.insert(s, at: 0)
        }
        save()
        syncWatchers()
    }
    private func save() {
        if let data = try? JSONEncoder().encode(sessions) { UserDefaults.standard.set(data, forKey: key) }
    }
}

struct RootView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var app: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var showPair = ProcessInfo.processInfo.environment["ENCLAVE_SHOW_PAIR"] == "1"
    @State private var searchText = ""
    private var t: Theme { theme.t }

    var body: some View {
        NavigationStack {
            SessionsView(query: $searchText)
                .background(t.bg.ignoresSafeArea())
                .searchable(text: $searchText, prompt: "Search sessions")
                .searchToolbarBehavior(.minimize)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { theme.toggle() } label: {
                            Image(systemName: theme.effective == .dark ? "sun.max" : "moon")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(t.txt)
                                .frame(width: 38, height: 38)
                        }
                        .press()
                    }
                    DefaultToolbarItem(kind: .search, placement: .bottomBar)
                    ToolbarSpacer(.flexible, placement: .bottomBar)
                    ToolbarItem(placement: .bottomBar) {
                        Button { showPair = true } label: {
                            Image(systemName: "plus")
                                .font(.system(size: 17, weight: .semibold))
                        }
                        .buttonStyle(.glassProminent)
                        .tint(t.accent)
                        .accessibilityLabel("Pair a session")
                    }
                }
                // Native push: tapping a session (→ showEditor) slides the editor in from
                // the right; Leave / back-swipe pops it left.
                .navigationDestination(isPresented: $app.showEditor) {
                    if let client = app.active {
                        EditorView(client: client)
                            .environmentObject(theme)
                            .navigationBarBackButtonHidden(true)
                            .toolbar {
                                ToolbarItem(placement: .topBarLeading) {
                                    Button { app.leave() } label: {
                                        HStack(spacing: 5) { Image(systemName: "chevron.left"); Text("Leave") }.foregroundStyle(t.accent)
                                    }
                                }
                            }
                            .onDisappear { app.leave() }   // covers the native back-swipe
                    }
                }
                .navigationDestination(isPresented: $showPair) {
                    PairView(onClose: { showPair = false },
                             onConnect: { link in showPair = false; app.connect(link: link, name: UIDevice.current.name, paired: true) })
                        .environmentObject(theme)
                        .toolbar(.hidden, for: .navigationBar)
                }
        }
        .tint(t.accent)
        .onChange(of: colorScheme, initial: true) { _, new in theme.systemDark = (new == .dark) }
        .task {
            // Launch seam / deep-link: auto-join a collab session from an env var,
            // or fall back to the most recently saved session so the user lands in
            // the live room without an extra tap after a cold launch.
            guard app.active == nil else { return }
            if let link = ProcessInfo.processInfo.environment["ENCLAVE_COLLAB_LINK"] {
                app.connect(link: link, name: UIDevice.current.name)
            } else if let latest = app.sessions.max(by: { $0.savedAt < $1.savedAt }) {
                app.connect(link: latest.link, name: UIDevice.current.name)
            }
        }
    }

}
