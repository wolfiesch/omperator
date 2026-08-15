import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import HostWire

/// Public bridge to the shared session store for the pure-GTK4 executable
/// target. T4SessionStore stays internal to the library (its SwiftCrossUI
/// conformances don't belong in a public API); this facade exposes only the
/// surface the GTK window needs, in public HostWire/Foundation types.
@MainActor
public final class T4GtkBridge {
    private let store = T4SessionStore()

    public init() {}

    public func restore() async { await store.restore() }

    /// True when a previous session's endpoint is persisted (restore will run).
    public var hasSavedConnection: Bool { store.hasSavedConnection }

    public var connected: Bool { store.connected }
    /// True while a connect/restore attempt is in flight.
    public var connecting: Bool { store.connecting }
    public var lastError: String? { store.lastError }
    public var sessions: [SessionRef] { store.sessions }
    public var selectedSession: SessionRef? { store.selectedSession }

    public func select(_ session: SessionRef?) { store.select(session) }

    public func createSession(projectId: String) async -> SessionRef? {
        await store.createSession(projectId: projectId)
    }

    /// Instant new session: opens a local draft immediately; the host session
    /// is created in the background on the first prompt.
    public func startDraftSession() {
        store.startDraftSession()
    }

    public func sendPrompt(sessionId: String, text: String) async {
        await store.sendPrompt(sessionId: sessionId, text: text)
    }

    // MARK: - Images (prompt attachments + transcript artifacts + captures)

    /// One composer attachment in public form (raw bytes + wire mimeType).
    public struct GtkPromptImage: Sendable {
        public let data: Data
        public let mimeType: String
        public init(data: Data, mimeType: String) {
            self.data = data
            self.mimeType = mimeType
        }
    }

    /// Send a prompt with image attachments (uploaded first via
    /// session.image.begin/chunk; formats pass through unchanged).
    public func sendPrompt(sessionId: String, text: String, images: [GtkPromptImage]) async {
        await store.sendPrompt(sessionId: sessionId, text: text,
                               images: images.map { T4SessionStore.PromptImage(data: $0.data, mimeType: $0.mimeType) })
    }

    /// Full byte read of one transcript image artifact: loops artifact.read
    /// chunks until `complete`. Returns nil when the fetch fails partway.
    public func imageArtifactBytes(sessionId: String, artifactId: String) async -> Data? {
        var bytes = Data()
        var offset = 0
        while true {
            guard let chunk = await store.artifactRead(sessionId: sessionId, artifactId: artifactId, offset: offset),
                  let part = chunk.decodedBytes else { return nil }
            bytes.append(part)
            if chunk.complete { return bytes }
            offset = chunk.nextOffset
        }
    }

    /// One preview capture row in public form (transcript image rows).
    public struct GtkCaptureRow: Sendable {
        public let captureId: String
        public let mimeType: String
        public let capturedAt: Int
    }

    /// Capture rows for a session (one per preview.capture push/command).
    public func previewCaptureRows(for sessionId: String) -> [GtkCaptureRow] {
        (store.previewCaptureRowsBySession[sessionId] ?? []).map {
            GtkCaptureRow(captureId: $0.captureId, mimeType: $0.mimeType, capturedAt: $0.capturedAt)
        }
    }

    /// Decoded bytes of a preview capture (nil until the chunked fetch lands).
    public func captureImageData(_ captureId: String) -> Data? {
        store.previewCaptureImages[captureId]?.data
    }

    /// Binary-safe file read for image thumbnails: files.read returns base64
    /// content for binary payloads (the host auto-detects), decoded here.
    public func fileImageBytes(sessionId: String, path: String) async -> Data? {
        await store.readFileBytes(sessionId: sessionId, path: path)
    }

    public func cancel(sessionId: String) async { await store.cancel(sessionId: sessionId) }

    public func transcript(for sessionId: String) -> [TranscriptEntry] {
        store.transcript(for: sessionId)
    }

    /// The assistant's in-progress streaming text for a session ("" when idle).
    /// The OMP-native host streams ordered `assistant.block.update` frames into
    /// `liveTurns` (and clears the flattened `streamingMessages` buffer), so the
    /// ordered timeline is the authoritative source; the flattened buffer is a
    /// fallback for hosts that only send `message.update`.
    public func streamingText(for sessionId: String) -> String {
        if let timeline = store.liveTurns[sessionId], !timeline.isEmpty {
            let text = timeline.blocks
                .filter { $0.kind == .text }
                .map(\.content)
                .joined()
            if !text.isEmpty { return text }
        }
        return store.streamingMessages[sessionId]?.text ?? ""
    }

    /// The assistant's in-progress THINKING for a session ("" when idle or
    /// not thinking). Same sources as streamingText: ordered thinking blocks
    /// first, flattened buffer reasoning as fallback.
    public func streamingReasoning(for sessionId: String) -> String {
        if let timeline = store.liveTurns[sessionId], !timeline.isEmpty {
            let thinking = timeline.blocks
                .filter { $0.kind == .thinking }
                .map(\.content)
                .joined()
            if !thinking.isEmpty { return thinking }
        }
        return store.streamingMessages[sessionId]?.reasoning ?? ""
    }

    // MARK: - Panes (terminal / browser / files)

    public func openTerminal(sessionId: String) async { _ = await store.openTerminal(sessionId: sessionId) }
    public func activeTerminalId(for sessionId: String) -> String? { store.activeTerminal(sessionId: sessionId) }
    public func terminalOutput(_ terminalId: String) -> String { store.terminalOutput[terminalId] ?? "" }
    public func sendTerminalInput(sessionId: String, data: String) async { await store.sendTerminalInput(sessionId: sessionId, data: data) }
    public func resizeTerminal(sessionId: String, cols: Int, rows: Int) async { await store.resizeTerminal(sessionId: sessionId, cols: cols, rows: rows) }
    public func closeTerminal(sessionId: String) async { await store.closeTerminal(sessionId: sessionId) }

    public func browserURL(for sessionId: String) -> String { store.browserURL(for: sessionId) }
    public func setBrowserURL(for sessionId: String, url: String) { store.setBrowserURL(for: sessionId, url: url) }

    public func listFiles(sessionId: String, path: String) async -> [FileListEntry]? { await store.listFiles(sessionId: sessionId, path: path) }
    public func readFile(sessionId: String, path: String) async -> String? { await store.readFile(sessionId: sessionId, path: path) }

    public struct GtkFilesDiff: Sendable {
        public let patchText: String?
        public let changedPaths: [String]
    }
    public func filesDiff(sessionId: String) async -> GtkFilesDiff? {
        guard let result = await store.filesDiff(sessionId: sessionId) else { return nil }
        return GtkFilesDiff(patchText: result.patchText, changedPaths: result.changes.map { $0.path })
    }

    // MARK: - Account sign-in (first-run onboarding)

    /// Keychain key for the signed-in account's rendezvous token.
    public static let accountTokenKey = "t4.accountToken"
    /// Keychain key for the signed-in account's username (friendly display).
    public static let accountUsernameKey = "t4.accountUsername"

    /// The rendezvous origin. Defaults to the public rendezvous
    /// (https://wickrunner.com:8445); `-T4RendezvousURL=` overrides it for QA
    /// against a local rendezvous (scripts/rendezvous.mjs, port 4195).
    public static var rendezvousURL: URL {
        if let seam = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("-T4RendezvousURL=") }),
           let url = URL(string: String(seam.dropFirst("-T4RendezvousURL=".count))) {
            return url
        }
        return URL(string: "https://wickrunner.com:8445")!
    }

    /// True when an account token was persisted (the user signed in once).
    public static var hasAccount: Bool {
        Keychain.get(accountTokenKey) != nil
    }

    /// Sign in (or create) an Omperator account at the rendezvous, then persist
    /// the account token in the Keychain. Tries /v1/accounts/login first. The
    /// rendezvous deliberately answers 401 for unknown users too (no
    /// enumeration), so any failed sign-in falls back to /v1/accounts/register
    /// to disambiguate: register 200 means the account was just created
    /// (proceed to sign in), register 409 means the name already exists and
    /// the password was wrong (invalid credentials). Throws
    /// `AccountLoginError` with a user-presentable message on failure. The
    /// workspace connect itself is `restore()` — this only establishes the
    /// account credential.
    public func login(username: String, password: String) async throws {
        let base = Self.rendezvousURL
        let credentials = ["username": username, "password": password]
        var (status, data) = try await post("/v1/accounts/login", body: credentials, base: base)
        if status == 401 || status == 404 || status == 409 {
            // Not signed in (unknown user or wrong password). 404/409 from
            // login are tolerated for older rendezvous builds.
            let (registerStatus, registerData) = try await post("/v1/accounts/register", body: credentials, base: base)
            if registerStatus == 400 {
                throw AccountLoginError.server(errorMessage(from: registerData)
                    ?? "That name or password isn't allowed — use 3–32 letters or numbers for the name, and at least 8 characters for the password.")
            }
            if registerStatus == 409 {
                // The name already exists — the failed login was a wrong password.
                throw AccountLoginError.invalidCredentials
            }
            guard registerStatus == 200 else {
                throw AccountLoginError.server(errorMessage(from: registerData)
                    ?? "Couldn't create your account right now (HTTP \(registerStatus)).")
            }
            (status, data) = try await post("/v1/accounts/login", body: credentials, base: base)
        }
        guard status == 200 else {
            if status == 401 {
                throw AccountLoginError.invalidCredentials
            }
            throw AccountLoginError.server(errorMessage(from: data)
                ?? "Couldn't sign in right now (HTTP \(status)).")
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = json["token"] as? String, !token.isEmpty else {
            throw AccountLoginError.server("The sign-in server sent an unexpected response.")
        }
        Keychain.set(token, forKey: Self.accountTokenKey)
        Keychain.set(username, forKey: Self.accountUsernameKey)
    }

    // MARK: - Account HTTP plumbing

    private func post(_ path: String, body: [String: String], base: URL) async throws -> (Int, Data) {
        let pathPart = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let origin = base.absoluteString.hasSuffix("/") ? base.absoluteString : base.absoluteString + "/"
        guard let url = URL(string: origin + pathPart) else {
            throw AccountLoginError.server("The sign-in server address is invalid.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            return (status, data)
        } catch {
            throw AccountLoginError.offline("Can't reach the sign-in server. Check your connection and try again.")
        }
    }

    private func errorMessage(from data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let message = json["error"] as? String, !message.isEmpty else { return nil }
        return message
    }
}

/// Account sign-in failures, each carrying a user-presentable message.
public enum AccountLoginError: LocalizedError {
    /// Wrong username/password (HTTP 401).
    case invalidCredentials
    /// The server rejected the request with a message.
    case server(String)
    /// The rendezvous was unreachable.
    case offline(String)

    public var errorDescription: String? {
        switch self {
        case .invalidCredentials:
            return "That username or password isn't right — try again."
        case .server(let message):
            return message
        case .offline(let message):
            return message
        }
    }
}
