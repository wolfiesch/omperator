import Foundation
import HostWire
import SwiftCrossUI

/// Windows terminal rendering uses the already-shipped WebView2 seam with bundled
/// xterm.js assets. xterm provides a real VT parser, cursor model, scrollback,
/// mouse protocol support, and cell measurement without creating another PTY.
/// WinUI text controls were rejected because they are transcript renderers, not
/// terminal emulators; a local ConPTY was rejected because t4-host owns the PTY.
struct T4WindowsTerminalIdentity: Hashable, Codable, Sendable {
    let sessionID: String
    let terminalID: String
}

enum T4WindowsTerminalConnection: Equatable, Sendable {
    case online
    case reconnecting
    case offline
}

struct T4WindowsTerminalCapabilities: Equatable, Sendable {
    let canOpen: Bool
    let canInput: Bool
    let canResize: Bool

    static let unavailable = Self(canOpen: false, canInput: false, canResize: false)
    static let full = Self(canOpen: true, canInput: true, canResize: true)
}

struct T4WindowsTerminalHostState: Equatable, Sendable {
    let connection: T4WindowsTerminalConnection
    let capabilities: T4WindowsTerminalCapabilities
    let detail: String?

    static let offline = Self(
        connection: .offline,
        capabilities: .unavailable,
        detail: "The host connection is offline."
    )

    var inputEnabled: Bool {
        connection == .online && capabilities.canInput
    }

    var resizeEnabled: Bool {
        connection == .online && capabilities.canResize
    }
}

struct T4WindowsTerminalTheme: Codable, Equatable, Sendable {
    let name: String
    let background: String
    let foreground: String
    let cursor: String
    let cursorAccent: String
    let selectionBackground: String
    let black: String
    let red: String
    let green: String
    let yellow: String
    let blue: String
    let magenta: String
    let cyan: String
    let white: String
    let brightBlack: String
    let brightRed: String
    let brightGreen: String
    let brightYellow: String
    let brightBlue: String
    let brightMagenta: String
    let brightCyan: String
    let brightWhite: String

    static let moon = Self(
        name: "rose-pine-moon",
        background: "#000000",
        foreground: "#bfbfbf",
        cursor: "#bfbfbf",
        cursorAccent: "#000000",
        selectionBackground: "#3f3f3f80",
        black: "#000000",
        red: "#bf0000",
        green: "#00bf00",
        yellow: "#bfbf00",
        blue: "#0000bf",
        magenta: "#bf00bf",
        cyan: "#00bfbf",
        white: "#bfbfbf",
        brightBlack: "#3f3f3f",
        brightRed: "#ff3f3f",
        brightGreen: "#3fff3f",
        brightYellow: "#ffff3f",
        brightBlue: "#3f3fff",
        brightMagenta: "#ff3fff",
        brightCyan: "#3fffff",
        brightWhite: "#ffffff"
    )

    static let dawn = Self(
        name: "rose-pine-dawn",
        background: "#000000",
        foreground: "#bfbfbf",
        cursor: "#bfbfbf",
        cursorAccent: "#000000",
        selectionBackground: "#3f3f3f80",
        black: "#000000",
        red: "#bf0000",
        green: "#00bf00",
        yellow: "#bfbf00",
        blue: "#0000bf",
        magenta: "#bf00bf",
        cyan: "#00bfbf",
        white: "#bfbfbf",
        brightBlack: "#3f3f3f",
        brightRed: "#ff3f3f",
        brightGreen: "#3fff3f",
        brightYellow: "#ffff3f",
        brightBlue: "#3f3fff",
        brightMagenta: "#ff3fff",
        brightCyan: "#3fffff",
        brightWhite: "#ffffff"
    )

    static func resolve(_ appearance: Appearance) -> Self {
        appearance == .dark ? .moon : .dawn
    }
}

struct T4WindowsTerminalKeyMap: Codable, Equatable, Sendable {
    let normal: [String: String]
    let applicationCursor: [String: String]
    let control: [String: String]

    static let vt = Self(
        normal: [
            "Enter": "\r",
            "Backspace": "\u{7f}",
            "Tab": "\t",
            "Escape": "\u{1b}",
            "ArrowUp": "\u{1b}[A",
            "ArrowDown": "\u{1b}[B",
            "ArrowRight": "\u{1b}[C",
            "ArrowLeft": "\u{1b}[D",
            "Home": "\u{1b}[H",
            "End": "\u{1b}[F",
            "PageUp": "\u{1b}[5~",
            "PageDown": "\u{1b}[6~",
            "Delete": "\u{1b}[3~",
            "Insert": "\u{1b}[2~",
        ],
        applicationCursor: [
            "ArrowUp": "\u{1b}OA",
            "ArrowDown": "\u{1b}OB",
            "ArrowRight": "\u{1b}OC",
            "ArrowLeft": "\u{1b}OD",
            "Home": "\u{1b}OH",
            "End": "\u{1b}OF",
        ],
        control: {
            var values: [String: String] = [
                "@": "\u{00}",
                "[": "\u{1b}",
                "\\": "\u{1c}",
                "]": "\u{1d}",
                "^": "\u{1e}",
                "_": "\u{1f}",
                "?": "\u{7f}",
            ]
            for value in Unicode.Scalar("A").value...Unicode.Scalar("Z").value {
                guard let scalar = Unicode.Scalar(value) else { continue }
                values[String(scalar)] = String(Unicode.Scalar(value - 64)!)
            }
            return values
        }()
    )
}

enum T4WindowsTerminalLimits {
    static let maxTerminalsPerSession = 4
    static let maxInputChunkBytes = 4_096
    static let maxBridgeInputBytes = 65_536
    static let maxBridgePasteBytes = 1_048_576
    static let maxRetainedOutputBytes = 200_000
    static let scrollbackLines = 5_000
    static let minColumns = 2
    static let maxColumns = 1_000
    static let minRows = 1
    static let maxRows = 500
}

struct T4WindowsTerminalGridSize: Codable, Equatable, Sendable {
    let columns: Int
    let rows: Int

    static func normalized(columns: Int, rows: Int) -> Self {
        Self(
            columns: min(max(columns, T4WindowsTerminalLimits.minColumns), T4WindowsTerminalLimits.maxColumns),
            rows: min(max(rows, T4WindowsTerminalLimits.minRows), T4WindowsTerminalLimits.maxRows)
        )
    }
}

enum T4WindowsTerminalInputChunker {
    static func chunks(
        _ text: String,
        maxUTF8Bytes: Int = T4WindowsTerminalLimits.maxInputChunkBytes
    ) -> [String] {
        guard !text.isEmpty else { return [] }
        let limit = max(4, maxUTF8Bytes)
        var result: [String] = []
        var current = ""
        var currentBytes = 0

        for scalar in text.unicodeScalars {
            let scalarText = String(scalar)
            let scalarBytes = scalarText.utf8.count
            if currentBytes > 0, currentBytes + scalarBytes > limit {
                result.append(current)
                current = ""
                currentBytes = 0
            }
            current.unicodeScalars.append(scalar)
            currentBytes += scalarBytes
        }
        if !current.isEmpty { result.append(current) }
        return result
    }
}

struct T4WindowsTerminalBootstrap: Codable, Equatable, Sendable {
    let v: Int
    let instanceId: String
    let scrollback: Int
    let fontSize: Int
    let fontFamily: String
    let theme: T4WindowsTerminalTheme
    let keyMap: T4WindowsTerminalKeyMap
    let interactive: Bool
}

enum T4WindowsTerminalPage {
    static let host = "terminal.omperator.invalid"
    static let path = "/TerminalHost.html"

    static func url(
        instanceID: String,
        theme: T4WindowsTerminalTheme,
        interactive: Bool
    ) -> URL? {
        let bootstrap = T4WindowsTerminalBootstrap(
            v: 1,
            instanceId: instanceID,
            scrollback: T4WindowsTerminalLimits.scrollbackLines,
            fontSize: 8,
            fontFamily: "JetBrains Mono, Cascadia Mono, Consolas, monospace",
            theme: theme,
            keyMap: .vt,
            interactive: interactive
        )
        guard let data = try? JSONEncoder().encode(bootstrap) else { return nil }
        let encoded = data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        var components = URLComponents()
        components.scheme = "https"
        components.host = host
        components.path = path
        components.queryItems = [URLQueryItem(name: "config", value: encoded)]
        return components.url
    }

    static func bootstrap(from url: URL) -> T4WindowsTerminalBootstrap? {
        guard url.scheme == "https", url.host == host, url.path == path,
              let encoded = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "config" })?.value else {
            return nil
        }
        var base64 = encoded
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padding = (4 - base64.count % 4) % 4
        base64 += String(repeating: "=", count: padding)
        guard let data = Data(base64Encoded: base64) else { return nil }
        return try? JSONDecoder().decode(T4WindowsTerminalBootstrap.self, from: data)
    }

    static func allowsNavigation(candidate: String, expected: String, isInitial: Bool) -> Bool {
        guard isInitial, let candidateURL = URL(string: candidate), let expectedURL = URL(string: expected) else {
            return false
        }
        return candidateURL.absoluteString == expectedURL.absoluteString
    }
}

enum T4WindowsTerminalBridgeMessage: Equatable, Sendable {
    case ready
    case input(String)
    case paste(String)
    case resize(T4WindowsTerminalGridSize)
    case focus(Bool)
}

enum T4WindowsTerminalBridgeMessageError: Error, Equatable, CustomStringConvertible {
    case oversized
    case malformed
    case invalidVersion
    case invalidInstance
    case invalidKeys
    case invalidPayload
    case unknownType(String)

    var description: String {
        switch self {
        case .oversized: return "Terminal bridge message exceeded its size limit."
        case .malformed: return "Terminal bridge message was not a JSON object."
        case .invalidVersion: return "Terminal bridge message used an unsupported version."
        case .invalidInstance: return "Terminal bridge message targeted the wrong renderer."
        case .invalidKeys: return "Terminal bridge message contained unknown fields."
        case .invalidPayload: return "Terminal bridge message payload was invalid."
        case .unknownType(let type): return "Unknown terminal bridge message type: \(type)"
        }
    }
}

enum T4WindowsTerminalBridgeDecoder {
    private struct Payload: Decodable {
        let v: Int
        let instanceId: String
        let type: String
        let data: String?
        let cols: Int?
        let rows: Int?
        let focused: Bool?
    }

    static func decode(
        _ json: String,
        expectedInstanceID: String
    ) throws -> T4WindowsTerminalBridgeMessage {
        guard json.utf8.count <= T4WindowsTerminalLimits.maxBridgePasteBytes + 512 else {
            throw T4WindowsTerminalBridgeMessageError.oversized
        }
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any],
              let payload = try? JSONDecoder().decode(Payload.self, from: data) else {
            throw T4WindowsTerminalBridgeMessageError.malformed
        }
        guard payload.v == 1 else { throw T4WindowsTerminalBridgeMessageError.invalidVersion }
        guard payload.instanceId == expectedInstanceID else {
            throw T4WindowsTerminalBridgeMessageError.invalidInstance
        }

        let baseKeys: Set<String> = ["v", "instanceId", "type"]
        let keys = Set(dictionary.keys)
        switch payload.type {
        case "ready":
            guard keys == baseKeys else { throw T4WindowsTerminalBridgeMessageError.invalidKeys }
            return .ready
        case "input":
            guard keys == baseKeys.union(["data"]), let input = payload.data,
                  !input.isEmpty,
                  input.utf8.count <= T4WindowsTerminalLimits.maxBridgeInputBytes else {
                throw T4WindowsTerminalBridgeMessageError.invalidPayload
            }
            return .input(input)
        case "paste":
            guard keys == baseKeys.union(["data"]), let paste = payload.data,
                  !paste.isEmpty,
                  paste.utf8.count <= T4WindowsTerminalLimits.maxBridgePasteBytes else {
                throw T4WindowsTerminalBridgeMessageError.invalidPayload
            }
            return .paste(paste)
        case "resize":
            guard keys == baseKeys.union(["cols", "rows"]),
                  let columns = payload.cols,
                  let rows = payload.rows,
                  (T4WindowsTerminalLimits.minColumns...T4WindowsTerminalLimits.maxColumns).contains(columns),
                  (T4WindowsTerminalLimits.minRows...T4WindowsTerminalLimits.maxRows).contains(rows) else {
                throw T4WindowsTerminalBridgeMessageError.invalidPayload
            }
            return .resize(.init(columns: columns, rows: rows))
        case "focus":
            guard keys == baseKeys.union(["focused"]), let focused = payload.focused else {
                throw T4WindowsTerminalBridgeMessageError.invalidPayload
            }
            return .focus(focused)
        default:
            throw T4WindowsTerminalBridgeMessageError.unknownType(payload.type)
        }
    }
}

struct T4WindowsTerminalNativeMessage: Codable, Equatable, Sendable {
    let v: Int
    let instanceId: String
    let type: String
    let data: String?
    let trimmed: Bool?
    let theme: T4WindowsTerminalTheme?
    let interactive: Bool?

    static func write(instanceID: String, data: String) -> Self {
        Self(v: 1, instanceId: instanceID, type: "write", data: data, trimmed: nil, theme: nil, interactive: nil)
    }

    static func reset(instanceID: String, data: String, trimmed: Bool) -> Self {
        Self(v: 1, instanceId: instanceID, type: "reset", data: data, trimmed: trimmed, theme: nil, interactive: nil)
    }

    static func setTheme(instanceID: String, theme: T4WindowsTerminalTheme) -> Self {
        Self(v: 1, instanceId: instanceID, type: "theme", data: nil, trimmed: nil, theme: theme, interactive: nil)
    }

    static func setInteractive(instanceID: String, interactive: Bool) -> Self {
        Self(v: 1, instanceId: instanceID, type: "interactive", data: nil, trimmed: nil, theme: nil, interactive: interactive)
    }

    static func focus(instanceID: String) -> Self {
        Self(v: 1, instanceId: instanceID, type: "focus", data: nil, trimmed: nil, theme: nil, interactive: nil)
    }

    static func dispose(instanceID: String) -> Self {
        Self(v: 1, instanceId: instanceID, type: "dispose", data: nil, trimmed: nil, theme: nil, interactive: nil)
    }

    func json() throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return String(decoding: try encoder.encode(self), as: UTF8.self)
    }
}

enum T4WindowsTerminalSurfaceState: Equatable, Sendable {
    case idle
    case initializing
    case ready
    case unavailable(String)
}

struct T4WindowsTerminalSurfaceSnapshot: Equatable, Sendable {
    var state: T4WindowsTerminalSurfaceState = .idle
    var focused = false
    var lastGridSize: T4WindowsTerminalGridSize?
    var rejectedMessages = 0
}

enum T4WindowsTerminalSurfaceEvent: Equatable, Sendable {
    case initializing
    case ready
    case message(T4WindowsTerminalBridgeMessage)
    case messageRejected(String)
    case runtimeUnavailable(String)
    case closed
}

struct T4WindowsTerminalSurfaceEventEnvelope: Equatable, Sendable {
    let identity: T4WindowsTerminalIdentity
    let event: T4WindowsTerminalSurfaceEvent
}

@MainActor
final class T4WindowsTerminalSurfaceBridge {
    struct Activation: Equatable {
        let identity: T4WindowsTerminalIdentity
        let output: String
        let exited: Int?
        let theme: T4WindowsTerminalTheme
        let interactive: Bool
        let focusEpoch: UInt64
    }

    private var ownerID: ObjectIdentifier?
    private var activationHandler: ((Activation) -> Void)?
    private var closeIdentityHandler: ((T4WindowsTerminalIdentity) -> Void)?
    private var closeSessionHandler: ((String) -> Void)?
    private var eventSink: ((T4WindowsTerminalSurfaceEventEnvelope) -> Void)?
    private var cleanupSink: (([T4WindowsTerminalIdentity]) -> Void)?
    private var activation: Activation?

    func bind(
        eventSink: @escaping (T4WindowsTerminalSurfaceEventEnvelope) -> Void,
        cleanupSink: @escaping ([T4WindowsTerminalIdentity]) -> Void
    ) {
        self.eventSink = eventSink
        self.cleanupSink = cleanupSink
    }

    func attach(
        owner: AnyObject,
        onActivate: @escaping (Activation) -> Void,
        onCloseIdentity: @escaping (T4WindowsTerminalIdentity) -> Void,
        onCloseSession: @escaping (String) -> Void
    ) {
        let shouldReplayActivation = ownerID != ObjectIdentifier(owner)
        ownerID = ObjectIdentifier(owner)
        activationHandler = onActivate
        closeIdentityHandler = onCloseIdentity
        closeSessionHandler = onCloseSession
        if shouldReplayActivation, let activation { onActivate(activation) }
    }

    func detach(owner: AnyObject) {
        guard ownerID == ObjectIdentifier(owner) else { return }
        ownerID = nil
        activationHandler = nil
        closeIdentityHandler = nil
        closeSessionHandler = nil
    }

    func activate(_ activation: Activation) {
        self.activation = activation
        activationHandler?(activation)
    }

    func close(identity: T4WindowsTerminalIdentity) {
        if activation?.identity == identity { activation = nil }
        closeIdentityHandler?(identity)
    }

    func close(sessionID: String) {
        if activation?.identity.sessionID == sessionID { activation = nil }
        closeSessionHandler?(sessionID)
    }

    func publish(_ envelope: T4WindowsTerminalSurfaceEventEnvelope) {
        eventSink?(envelope)
    }

    func publishCleanup(_ identities: [T4WindowsTerminalIdentity]) {
        cleanupSink?(identities)
    }
}

@MainActor
protocol T4WindowsTerminalHostRouting: AnyObject {
    func windowsTerminalHostState() async -> T4WindowsTerminalHostState
    func windowsOpenTerminal(sessionID: String, columns: Int, rows: Int) async throws -> String
    func windowsSendTerminalInput(identity: T4WindowsTerminalIdentity, data: String) async throws
    func windowsResizeTerminal(identity: T4WindowsTerminalIdentity, size: T4WindowsTerminalGridSize) async throws
    func windowsCloseTerminal(identity: T4WindowsTerminalIdentity, reason: String?) async throws
}

enum T4WindowsTerminalRoutingError: Error, Equatable, CustomStringConvertible {
    case unsupported(String)
    case disconnected
    case reconnecting
    case staleTerminal
    case failed(String)

    var description: String {
        switch self {
        case .unsupported(let capability): return "Host terminal capability \(capability) is unavailable."
        case .disconnected: return "The host connection is offline."
        case .reconnecting: return "The host connection is reconnecting."
        case .staleTerminal: return "The host terminal is no longer attached to this session."
        case .failed(let message): return message
        }
    }
}

@MainActor
extension T4SessionStore: T4WindowsTerminalHostRouting {
    func windowsTerminalHostState() async -> T4WindowsTerminalHostState {
        if Self.demoMode {
            return T4WindowsTerminalHostState(
                connection: .online,
                capabilities: .init(canOpen: true, canInput: false, canResize: false),
                detail: "Offline demo output is read-only."
            )
        }
        let capabilities = T4WindowsTerminalCapabilities(
            canOpen: grantedCapabilities.contains("term.open"),
            canInput: grantedCapabilities.contains("term.input"),
            canResize: grantedCapabilities.contains("term.resize")
        )
        guard connected, client != nil else {
            return .init(connection: .offline, capabilities: capabilities, detail: "The host connection is offline.")
        }
        guard await client?.isReady == true else {
            return .init(connection: .reconnecting, capabilities: capabilities, detail: "Reconnecting to the host terminal stream…")
        }
        let missing: String?
        if !capabilities.canOpen {
            missing = "The host did not grant term.open."
        } else if !capabilities.canInput && !capabilities.canResize {
            missing = "The terminal is read-only because term.input and term.resize are unavailable."
        } else if !capabilities.canInput {
            missing = "The terminal is read-only because term.input is unavailable."
        } else if !capabilities.canResize {
            missing = "PTY resizing is unavailable because term.resize was not granted."
        } else {
            missing = nil
        }
        return .init(connection: .online, capabilities: capabilities, detail: missing)
    }

    func windowsOpenTerminal(sessionID: String, columns: Int, rows: Int) async throws -> String {
        let state = await windowsTerminalHostState()
        guard state.capabilities.canOpen else { throw T4WindowsTerminalRoutingError.unsupported("term.open") }
        if !Self.demoMode {
            guard state.connection != .offline else { throw T4WindowsTerminalRoutingError.disconnected }
            guard state.connection == .online else { throw T4WindowsTerminalRoutingError.reconnecting }
        }
        guard let terminalID = await openTerminal(sessionId: sessionID, cols: columns, rows: rows) else {
            throw T4WindowsTerminalRoutingError.failed(lastError ?? "The host did not open a terminal.")
        }
        return terminalID
    }

    func windowsSendTerminalInput(identity: T4WindowsTerminalIdentity, data: String) async throws {
        guard !data.isEmpty else { return }
        let state = await windowsTerminalHostState()
        guard state.capabilities.canInput else { throw T4WindowsTerminalRoutingError.unsupported("term.input") }
        guard state.connection != .offline else { throw T4WindowsTerminalRoutingError.disconnected }
        guard state.connection == .online else { throw T4WindowsTerminalRoutingError.reconnecting }
        guard openTerminalIds[identity.sessionID]?.contains(identity.terminalID) == true,
              let client else {
            throw T4WindowsTerminalRoutingError.staleTerminal
        }
        try await client.sendFrame(TerminalInputFrame(
            hostId: hostId,
            sessionId: identity.sessionID,
            terminalId: identity.terminalID,
            data: data
        ))
    }

    func windowsResizeTerminal(identity: T4WindowsTerminalIdentity, size: T4WindowsTerminalGridSize) async throws {
        let state = await windowsTerminalHostState()
        guard state.capabilities.canResize else { throw T4WindowsTerminalRoutingError.unsupported("term.resize") }
        guard state.connection != .offline else { throw T4WindowsTerminalRoutingError.disconnected }
        guard state.connection == .online else { throw T4WindowsTerminalRoutingError.reconnecting }
        guard openTerminalIds[identity.sessionID]?.contains(identity.terminalID) == true,
              let client else {
            throw T4WindowsTerminalRoutingError.staleTerminal
        }
        try await client.sendFrame(TerminalResizeFrame(
            hostId: hostId,
            sessionId: identity.sessionID,
            terminalId: identity.terminalID,
            cols: size.columns,
            rows: size.rows
        ))
    }

    func windowsCloseTerminal(identity: T4WindowsTerminalIdentity, reason: String?) async throws {
        guard openTerminalIds[identity.sessionID]?.contains(identity.terminalID) == true else {
            throw T4WindowsTerminalRoutingError.staleTerminal
        }
        var routeError: (any Error)?
        if !Self.demoMode {
            let state = await windowsTerminalHostState()
            if !state.capabilities.canOpen {
                routeError = T4WindowsTerminalRoutingError.unsupported("term.open")
            } else if state.connection == .offline {
                routeError = T4WindowsTerminalRoutingError.disconnected
            } else if state.connection == .reconnecting {
                routeError = T4WindowsTerminalRoutingError.reconnecting
            } else if let client {
                do {
                    try await client.sendFrame(TerminalCloseFrame(
                        hostId: hostId,
                        sessionId: identity.sessionID,
                        terminalId: identity.terminalID,
                        reason: reason
                    ))
                } catch {
                    routeError = error
                }
            }
        }
        discardWindowsTerminal(identity)
        if let routeError { throw routeError }
    }

    private func discardWindowsTerminal(_ identity: T4WindowsTerminalIdentity) {
        var ids = openTerminalIds[identity.sessionID] ?? []
        guard let removed = ids.firstIndex(of: identity.terminalID) else { return }
        ids.remove(at: removed)
        terminalOutput.removeValue(forKey: identity.terminalID)
        terminalExits.removeValue(forKey: identity.terminalID)
        if ids.isEmpty {
            openTerminalIds.removeValue(forKey: identity.sessionID)
            activeTerminalId.removeValue(forKey: identity.sessionID)
        } else {
            openTerminalIds[identity.sessionID] = ids
            if activeTerminalId[identity.sessionID] == identity.terminalID {
                activeTerminalId[identity.sessionID] = ids[min(removed, ids.count - 1)]
            }
        }
    }
}

@MainActor
final class T4WindowsTerminalWorkspaceModel: SwiftCrossUI.ObservableObject {
    @Published private(set) var hostStates: [String: T4WindowsTerminalHostState] = [:]
    @Published private(set) var surfaces: [T4WindowsTerminalIdentity: T4WindowsTerminalSurfaceSnapshot] = [:]
    @Published private(set) var errors: [String: String] = [:]
    @Published private(set) var notices: [String: String] = [:]

    let surfaceBridge = T4WindowsTerminalSurfaceBridge()
    private var router: (any T4WindowsTerminalHostRouting)?
    private(set) var mountedIdentities: Set<T4WindowsTerminalIdentity> = []
    private var openingSessions: Set<String> = []
    private var focusEpochs: [String: UInt64] = [:]
    private var lastSizes: [T4WindowsTerminalIdentity: T4WindowsTerminalGridSize] = [:]

    init(router: (any T4WindowsTerminalHostRouting)? = nil) {
        self.router = router
        surfaceBridge.bind(
            eventSink: { [weak self] envelope in self?.apply(envelope) },
            cleanupSink: { [weak self] identities in
                guard let self else { return }
                for identity in identities {
                    self.mountedIdentities.remove(identity)
                    self.surfaces[identity] = nil
                    self.lastSizes[identity] = nil
                }
            }
        )
    }

    func bind(router: any T4WindowsTerminalHostRouting) {
        self.router = router
    }

    func hostState(sessionID: String) -> T4WindowsTerminalHostState {
        hostStates[sessionID] ?? .offline
    }

    @discardableResult
    func refreshHostState(sessionID: String) async -> T4WindowsTerminalHostState {
        guard let router else {
            hostStates[sessionID] = .offline
            return .offline
        }
        let previous = hostStates[sessionID]
        let current = await router.windowsTerminalHostState()
        hostStates[sessionID] = current
        if previous?.connection == .reconnecting, current.connection == .online {
            notices[sessionID] = "Reconnected — terminal identity retained; continuity awaits host activity."
            requestFocus(sessionID: sessionID)
        } else if current.connection == .reconnecting {
            notices[sessionID] = "Reconnecting — terminal input is paused."
        } else if current.connection == .offline {
            notices[sessionID] = "Disconnected — terminal input is unavailable."
        } else if let detail = current.detail {
            notices[sessionID] = detail
        } else if notices[sessionID]?.hasPrefix("Reconnected") != true {
            notices[sessionID] = nil
        }
        return current
    }

    @discardableResult
    func ensureOpen(sessionID: String, columns: Int = 80, rows: Int = 24) async -> String? {
        guard !openingSessions.contains(sessionID), let router else { return nil }
        let state = await refreshHostState(sessionID: sessionID)
        guard state.capabilities.canOpen else {
            errors[sessionID] = "Terminal unavailable: the host did not grant term.open."
            return nil
        }
        guard state.connection == .online else { return nil }
        openingSessions.insert(sessionID)
        defer { openingSessions.remove(sessionID) }
        do {
            let terminalID = try await router.windowsOpenTerminal(
                sessionID: sessionID,
                columns: columns,
                rows: rows
            )
            errors[sessionID] = nil
            requestFocus(sessionID: sessionID)
            return terminalID
        } catch {
            errors[sessionID] = String(describing: error)
            return nil
        }
    }

    func requestFocus(sessionID: String) {
        focusEpochs[sessionID, default: 0] &+= 1
    }

    func activate(
        identity: T4WindowsTerminalIdentity,
        output: String,
        exited: Int?,
        appearance: Appearance,
        requestFocus: Bool
    ) {
        if requestFocus { self.requestFocus(sessionID: identity.sessionID) }
        mountedIdentities.insert(identity)
        if surfaces[identity] == nil {
            surfaces[identity] = .init(state: .initializing)
        }
        let state = hostState(sessionID: identity.sessionID)
        surfaceBridge.activate(.init(
            identity: identity,
            output: output,
            exited: exited,
            theme: .resolve(appearance),
            interactive: state.inputEnabled && exited == nil,
            focusEpoch: focusEpochs[identity.sessionID, default: 0]
        ))
    }

    func routeInput(identity: T4WindowsTerminalIdentity, data: String) async {
        guard let router, hostState(sessionID: identity.sessionID).inputEnabled else { return }
        do {
            for chunk in T4WindowsTerminalInputChunker.chunks(data) {
                try await router.windowsSendTerminalInput(identity: identity, data: chunk)
            }
            errors[identity.sessionID] = nil
        } catch {
            errors[identity.sessionID] = String(describing: error)
            _ = await refreshHostState(sessionID: identity.sessionID)
        }
    }

    func routePaste(identity: T4WindowsTerminalIdentity, text: String) async {
        await routeInput(identity: identity, data: text)
    }

    func routeResize(identity: T4WindowsTerminalIdentity, size: T4WindowsTerminalGridSize) async {
        guard let router, hostState(sessionID: identity.sessionID).resizeEnabled,
              lastSizes[identity] != size else { return }
        lastSizes[identity] = size
        do {
            try await router.windowsResizeTerminal(identity: identity, size: size)
            errors[identity.sessionID] = nil
        } catch {
            lastSizes[identity] = nil
            errors[identity.sessionID] = String(describing: error)
            _ = await refreshHostState(sessionID: identity.sessionID)
        }
    }

    func close(identity: T4WindowsTerminalIdentity, reason: String? = nil) async {
        surfaceBridge.close(identity: identity)
        mountedIdentities.remove(identity)
        surfaces[identity] = nil
        lastSizes[identity] = nil
        do {
            try await router?.windowsCloseTerminal(identity: identity, reason: reason)
        } catch {
            errors[identity.sessionID] = String(describing: error)
        }
    }

    func unmount(sessionID: String) {
        surfaceBridge.close(sessionID: sessionID)
        for identity in mountedIdentities where identity.sessionID == sessionID {
            mountedIdentities.remove(identity)
            surfaces[identity] = nil
            lastSizes[identity] = nil
        }
    }

    func prune(keeping sessionIDs: Set<String>) -> Set<String> {
        let removed = Set(mountedIdentities.map(\.sessionID)).subtracting(sessionIDs)
        for sessionID in removed { unmount(sessionID: sessionID) }
        hostStates = hostStates.filter { sessionIDs.contains($0.key) }
        errors = errors.filter { sessionIDs.contains($0.key) }
        notices = notices.filter { sessionIDs.contains($0.key) }
        return removed
    }

    private func apply(_ envelope: T4WindowsTerminalSurfaceEventEnvelope) {
        var snapshot = surfaces[envelope.identity] ?? .init()
        switch envelope.event {
        case .initializing:
            snapshot.state = .initializing
        case .ready:
            snapshot.state = .ready
        case .message(let message):
            switch message {
            case .ready:
                snapshot.state = .ready
            case .input(let data):
                Task { await self.routeInput(identity: envelope.identity, data: data) }
            case .paste(let text):
                Task { await self.routePaste(identity: envelope.identity, text: text) }
            case .resize(let size):
                snapshot.lastGridSize = size
                Task { await self.routeResize(identity: envelope.identity, size: size) }
            case .focus(let focused):
                snapshot.focused = focused
            }
        case .messageRejected(let reason):
            snapshot.rejectedMessages += 1
            errors[envelope.identity.sessionID] = reason
        case .runtimeUnavailable(let message):
            snapshot.state = .unavailable(message)
            errors[envelope.identity.sessionID] = message
        case .closed:
            snapshot.state = .idle
            snapshot.focused = false
        }
        surfaces[envelope.identity] = snapshot
    }
}
