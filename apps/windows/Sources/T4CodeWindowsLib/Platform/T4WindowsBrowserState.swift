import Foundation
import SwiftCrossUI

enum T4WindowsBrowserSurfaceState: Equatable {
    case idle
    case initializing
    case ready
    case unavailable(String)
}

struct T4WindowsBrowserSnapshot: Equatable {
    var address: String
    var currentURL: String
    var title: String
    var surfaceState: T4WindowsBrowserSurfaceState
    var isLoading: Bool
    var canGoBack: Bool
    var canGoForward: Bool
    var errorMessage: String?

    static func initial(url: String) -> Self {
        Self(
            address: url,
            currentURL: url,
            title: "New tab",
            surfaceState: .idle,
            isLoading: false,
            canGoBack: false,
            canGoForward: false,
            errorMessage: nil
        )
    }
}

enum T4WindowsBrowserEvent: Equatable {
    case surfaceInitializing
    case surfaceReady
    case navigationStarted(url: String)
    case navigationState(
        url: String,
        title: String,
        canGoBack: Bool,
        canGoForward: Bool,
        isLoading: Bool?,
        failure: String?
    )
    case commandFailed(String)
    case runtimeUnavailable(String)
    case surfaceClosed
}

struct T4WindowsBrowserEventEnvelope: Equatable {
    let sessionID: String
    let event: T4WindowsBrowserEvent
}

enum T4WindowsBrowserAction: Equatable {
    case navigate(String)
    case back
    case forward
    case reload
    case stop
}

enum T4WindowsBrowserNativeCommand: Equatable {
    case navigate(String)
    case back
    case forward
    case reload
    case stop
}


enum T4WindowsBrowserURL {
    static let fallbackURL = "http://localhost:3000"
    static func normalize(_ input: String) -> String? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let candidate = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard var components = URLComponents(string: candidate),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = components.host,
              !host.isEmpty,
              host.rangeOfCharacter(from: .whitespacesAndNewlines) == nil
        else {
            return nil
        }

        components.scheme = scheme
        return components.url?.absoluteString
    }
}
final class T4WindowsBrowserSurfaceBridge {
    struct Activation {
        let sessionID: String
        let initialURL: String
        let fixtureHTML: String?
        let backgroundHex: UInt32
    }

    private var ownerID: ObjectIdentifier?
    private var activationHandler: ((Activation) -> Void)?
    private var commandHandler: ((String, T4WindowsBrowserNativeCommand) -> Void)?
    private var closeSessionHandler: ((String) -> Void)?
    private var eventSink: ((T4WindowsBrowserEventEnvelope) -> Void)?
    private var cleanupSink: (([String]) -> Void)?
    private var activation: Activation?

    func bind(
        eventSink: @escaping (T4WindowsBrowserEventEnvelope) -> Void,
        cleanupSink: @escaping ([String]) -> Void
    ) {
        self.eventSink = eventSink
        self.cleanupSink = cleanupSink
    }

    func attach(
        owner: AnyObject,
        onActivate: @escaping (Activation) -> Void,
        onCommand: @escaping (String, T4WindowsBrowserNativeCommand) -> Void,
        onCloseSession: @escaping (String) -> Void
    ) {
        let shouldReplayActivation = ownerID != ObjectIdentifier(owner)
        ownerID = ObjectIdentifier(owner)
        activationHandler = onActivate
        commandHandler = onCommand
        closeSessionHandler = onCloseSession
        if shouldReplayActivation, let activation {
            onActivate(activation)
        }
    }

    func detach(owner: AnyObject) {
        guard ownerID == ObjectIdentifier(owner) else { return }
        ownerID = nil
        activationHandler = nil
        commandHandler = nil
        closeSessionHandler = nil
    }

    func activate(_ activation: Activation) {
        self.activation = activation
        activationHandler?(activation)
    }

    func send(sessionID: String, command: T4WindowsBrowserNativeCommand) {
        commandHandler?(sessionID, command)
    }

    func close(sessionID: String) {
        closeSessionHandler?(sessionID)
    }

    func publish(_ envelope: T4WindowsBrowserEventEnvelope) {
        eventSink?(envelope)
    }

    func publishCleanup(_ sessionIDs: [String]) {
        cleanupSink?(sessionIDs)
    }
}


/// App-lifetime Windows browser state. Native WebView2 instances remain owned by
/// the mounted pane, while URL/title/navigation state survives normal view updates
/// and stays isolated by HostWire session identifier.
final class T4WindowsBrowserWorkspaceModel: SwiftCrossUI.ObservableObject {
    @Published private(set) var snapshots: [String: T4WindowsBrowserSnapshot] = [:]
    private(set) var mountedSessionIDs: Set<String> = []
    let surfaceBridge = T4WindowsBrowserSurfaceBridge()

    init() {
        surfaceBridge.bind(
            eventSink: { [weak self] envelope in
                _ = self?.apply(envelope)
            },
            cleanupSink: { [weak self] sessionIDs in
                guard let self else { return }
                for sessionID in sessionIDs {
                    _ = self.unmount(sessionID: sessionID)
                }
            }
        )
    }

    func currentSnapshot(
        sessionID: String,
        initialURL: String
    ) -> T4WindowsBrowserSnapshot {
        snapshots[sessionID] ?? T4WindowsBrowserSnapshot.initial(
            url: T4WindowsBrowserURL.normalize(initialURL)
                ?? T4WindowsBrowserURL.fallbackURL
        )
    }

    func snapshot(sessionID: String, initialURL: String) -> T4WindowsBrowserSnapshot {
        if let existing = snapshots[sessionID] {
            return existing
        }
        let normalized = T4WindowsBrowserURL.normalize(initialURL)
            ?? T4WindowsBrowserURL.fallbackURL
        let snapshot = T4WindowsBrowserSnapshot.initial(url: normalized)
        snapshots[sessionID] = snapshot
        return snapshot
    }

    func setAddress(_ address: String, sessionID: String, initialURL: String) {
        var snapshot = currentSnapshot(sessionID: sessionID, initialURL: initialURL)
        snapshot.address = address
        snapshot.errorMessage = nil
        snapshots[sessionID] = snapshot
    }

    @discardableResult
    func mount(sessionID: String, initialURL: String) -> T4WindowsBrowserSnapshot {
        let snapshot = snapshot(sessionID: sessionID, initialURL: initialURL)
        guard !mountedSessionIDs.contains(sessionID) else { return snapshot }
        mountedSessionIDs.insert(sessionID)
        var initializing = snapshot
        initializing.surfaceState = .initializing
        initializing.isLoading = false
        initializing.canGoBack = false
        initializing.canGoForward = false
        initializing.errorMessage = nil
        snapshots[sessionID] = initializing
        return initializing
    }

    @discardableResult
    func unmount(sessionID: String) -> T4WindowsBrowserSnapshot? {
        mountedSessionIDs.remove(sessionID)
        guard var snapshot = snapshots[sessionID] else { return nil }
        snapshot.surfaceState = .idle
        snapshot.isLoading = false
        snapshot.canGoBack = false
        snapshot.canGoForward = false
        snapshots[sessionID] = snapshot
        return snapshot
    }

    func prune(keeping sessionIDs: Set<String>) {
        let removedMounted = mountedSessionIDs.subtracting(sessionIDs)
        for sessionID in removedMounted {
            surfaceBridge.close(sessionID: sessionID)
        }
        snapshots = snapshots.filter { sessionIDs.contains($0.key) }
        mountedSessionIDs.formIntersection(sessionIDs)
    }

    @discardableResult
    func apply(_ envelope: T4WindowsBrowserEventEnvelope) -> T4WindowsBrowserSnapshot {
        var snapshot = snapshots[envelope.sessionID]
            ?? T4WindowsBrowserSnapshot.initial(url: T4WindowsBrowserURL.fallbackURL)

        switch envelope.event {
        case .surfaceInitializing:
            snapshot.surfaceState = .initializing
            snapshot.errorMessage = nil
        case .surfaceReady:
            snapshot.surfaceState = .ready
            snapshot.errorMessage = nil
        case .navigationStarted(let url):
            snapshot.surfaceState = .ready
            snapshot.currentURL = url
            snapshot.address = url
            snapshot.isLoading = true
            snapshot.errorMessage = nil
        case let .navigationState(url, title, canGoBack, canGoForward, isLoading, failure):
            snapshot.surfaceState = .ready
            if !url.isEmpty {
                snapshot.currentURL = url
                snapshot.address = url
            }
            if !title.isEmpty {
                snapshot.title = title
            }
            snapshot.canGoBack = canGoBack
            snapshot.canGoForward = canGoForward
            if let isLoading {
                snapshot.isLoading = isLoading
            }
            snapshot.errorMessage = failure
        case .commandFailed(let message):
            snapshot.errorMessage = message
        case .runtimeUnavailable(let message):
            snapshot.surfaceState = .unavailable(message)
            snapshot.isLoading = false
            snapshot.canGoBack = false
            snapshot.canGoForward = false
            snapshot.errorMessage = message
        case .surfaceClosed:
            snapshot.surfaceState = .idle
            snapshot.isLoading = false
            snapshot.canGoBack = false
            snapshot.canGoForward = false
        }

        snapshots[envelope.sessionID] = snapshot
        return snapshot
    }

    /// Resolves UI intent into one native operation. Returning nil is the
    /// capability gate: the caller must not send a command to WebView2.
    func command(
        sessionID: String,
        action: T4WindowsBrowserAction
    ) -> T4WindowsBrowserNativeCommand? {
        var snapshot = snapshots[sessionID]
            ?? T4WindowsBrowserSnapshot.initial(url: T4WindowsBrowserURL.fallbackURL)

        switch action {
        case .navigate(let input):
            guard let normalized = T4WindowsBrowserURL.normalize(input) else {
                snapshot.errorMessage = "Enter a valid HTTP or HTTPS URL."
                snapshots[sessionID] = snapshot
                return nil
            }
            snapshot.address = normalized
            snapshot.errorMessage = nil
            snapshots[sessionID] = snapshot
            return .navigate(normalized)
        case .back:
            guard snapshot.surfaceState == .ready, snapshot.canGoBack else { return nil }
            return .back
        case .forward:
            guard snapshot.surfaceState == .ready, snapshot.canGoForward else { return nil }
            return .forward
        case .reload:
            guard snapshot.surfaceState == .ready else { return nil }
            return .reload
        case .stop:
            guard snapshot.surfaceState == .ready, snapshot.isLoading else { return nil }
            return .stop
        }
    }

    @discardableResult
    func dispatch(
        sessionID: String,
        action: T4WindowsBrowserAction
    ) -> T4WindowsBrowserNativeCommand? {
        guard let command = command(sessionID: sessionID, action: action) else {
            return nil
        }
        surfaceBridge.send(sessionID: sessionID, command: command)
        return command
    }
}
