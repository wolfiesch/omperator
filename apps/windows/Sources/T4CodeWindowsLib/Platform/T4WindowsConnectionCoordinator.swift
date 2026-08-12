import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import OpenCombine
import SwiftCrossUI

enum T4WindowsOnboardingScreen: Equatable, Sendable {
    case booting
    case signIn
    case pairComputer
    case hidden
}

enum T4WindowsAccountError: LocalizedError, Equatable {
    case invalidCredentials
    case invalidInput(String)
    case offline
    case server(String)
    case invalidResponse
    case credentialPersistence

    var errorDescription: String? {
        switch self {
        case .invalidCredentials:
            return "That username or password isn't right — try again."
        case .invalidInput(let message):
            return message
        case .offline:
            return "Can't reach the sign-in server. Check your connection and try again."
        case .server(let message):
            return message
        case .invalidResponse:
            return "The sign-in server sent an unexpected response."
        case .credentialPersistence:
            return "Windows Credential Manager couldn't save your sign-in. Try again."
        }
    }
}

struct T4RendezvousAccountClient: @unchecked Sendable {
    typealias Post = @Sendable (URL, [String: String]) async throws -> (Int, Data)

    private let baseURL: URL
    private let postRequest: Post

    init(
        baseURL: URL = T4DiscoveryClient.rendezvousBaseURL(),
        postRequest: Post? = nil
    ) {
        self.baseURL = baseURL
        self.postRequest = postRequest ?? Self.livePost
    }

    /// Login first, then register only when the rendezvous deliberately gives
    /// the non-enumerating authentication response. A successful registration
    /// is followed by a second login so only bearer tokens are persisted.
    func loginOrRegister(username: String, password: String) async throws -> String {
        let credentials = ["username": username, "password": password]
        var (status, data) = try await request("v1/accounts/login", body: credentials)
        if status == 401 || status == 404 || status == 409 {
            let (registerStatus, registerData) = try await request("v1/accounts/register", body: credentials)
            switch registerStatus {
            case 200:
                (status, data) = try await request("v1/accounts/login", body: credentials)
            case 400:
                throw T4WindowsAccountError.invalidInput(
                    Self.registrationValidationMessage(from: registerData)
                        ?? "Use 3–32 letters, numbers, periods, underscores, or hyphens for the name, and 8–128 characters for the password."
                )
            case 409:
                throw T4WindowsAccountError.invalidCredentials
            default:
                throw T4WindowsAccountError.server("Couldn't create your account right now (HTTP \(registerStatus)).")
            }
        }
        guard status == 200 else {
            if status == 401 { throw T4WindowsAccountError.invalidCredentials }
            throw T4WindowsAccountError.server("Couldn't sign in right now (HTTP \(status)).")
        }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = object["token"] as? String,
              !token.isEmpty
        else {
            throw T4WindowsAccountError.invalidResponse
        }
        return token
    }

    private func request(_ path: String, body: [String: String]) async throws -> (Int, Data) {
        let origin = baseURL.absoluteString.hasSuffix("/") ? baseURL.absoluteString : baseURL.absoluteString + "/"
        guard let url = URL(string: origin + path) else {
            throw T4WindowsAccountError.invalidResponse
        }
        do {
            return try await postRequest(url, body)
        } catch let error as T4WindowsAccountError {
            throw error
        } catch {
            throw T4WindowsAccountError.offline
        }
    }

    private static func livePost(_ url: URL, _ body: [String: String]) async throws -> (Int, Data) {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }

    private static func registrationValidationMessage(from data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = object["error"] as? String
        else {
            return nil
        }
        switch raw {
        case "username is invalid":
            return "Use 3–32 letters, numbers, periods, underscores, or hyphens for the name."
        case "password is invalid":
            return "Use 8–128 characters for the password."
        case "registration is invalid":
            return "Enter a valid username and password."
        default:
            // Never project arbitrary rendezvous payloads: a compromised or
            // misconfigured service could echo submitted credentials.
            return nil
        }
    }
}

struct T4WindowsAccountCredentialAccess: Sendable {
    let value: @Sendable (String) -> String?
    let set: @Sendable (String, String) throws -> Void

    static let live = Self(
        value: { Keychain.get($0) },
        set: { value, key in try Keychain.setOrThrow(value, forKey: key) }
    )

    init(store: any WindowsSecretStoring) {
        value = { key in try? store.value(forKey: key) }
        set = { value, key in try store.set(value, forKey: key) }
    }

    private init(
        value: @escaping @Sendable (String) -> String?,
        set: @escaping @Sendable (String, String) throws -> Void
    ) {
        self.value = value
        self.set = set
    }
}


@MainActor
final class T4WindowsConnectionCoordinator: OpenCombine.ObservableObject {
    static let accountTokenKey = "t4.accountToken"
    static let accountUsernameKey = "t4.accountUsername"

    @OpenCombine.Published private(set) var screen: T4WindowsOnboardingScreen = .booting
    @OpenCombine.Published private(set) var hosts: [T4DiscoveryHost] = []
    @OpenCombine.Published var username = ""
    @OpenCombine.Published var password = ""
    @OpenCombine.Published var pairingCode = ""
    @OpenCombine.Published var selectedHostID = ""
    @OpenCombine.Published private(set) var status = ""
    @OpenCombine.Published private(set) var statusIsError = false
    @OpenCombine.Published private(set) var isSubmitting = false

    private let store: T4SessionStore
    private let accountClient: T4RendezvousAccountClient
    private let credentials: T4WindowsAccountCredentialAccess

    init(
        store: T4SessionStore,
        accountClient: T4RendezvousAccountClient = T4RendezvousAccountClient(),
        credentials: T4WindowsAccountCredentialAccess = .live
    ) {
        self.store = store
        self.accountClient = accountClient
        self.credentials = credentials
        username = credentials.value(Self.accountUsernameKey) ?? ""
    }

    var selectedHost: T4DiscoveryHost? {
        hosts.first(where: { $0.hostId == selectedHostID }) ?? hosts.first
    }

    func start(forceOnboarding: Bool = false) async {
        screen = .booting
        if forceOnboarding {
            screen = .signIn
            return
        }
        await store.restore()
        if store.connected || T4SessionStore.demoMode {
            screen = .hidden
            return
        }
        guard let token = credentials.value(Self.accountTokenKey), !token.isEmpty else {
            screen = .signIn
            return
        }
        await discoverAndConnect(token: token)
    }

    func submitLogin() async {
        guard !isSubmitting else { return }
        let normalizedUsername = username.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedPassword = password.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedUsername.isEmpty, !normalizedPassword.isEmpty else {
            setStatus("Enter your username and password to sign in.", isError: true)
            return
        }

        isSubmitting = true
        setStatus("Signing in…", isError: false)
        defer { isSubmitting = false }
        do {
            let token = try await accountClient.loginOrRegister(
                username: normalizedUsername,
                password: normalizedPassword
            )
            do {
                try credentials.set(token, Self.accountTokenKey)
                try credentials.set(normalizedUsername, Self.accountUsernameKey)
            } catch {
                throw T4WindowsAccountError.credentialPersistence
            }
            username = normalizedUsername
            password = ""
            await discoverAndConnect(token: token)
        } catch {
            setStatus(Self.friendlyMessage(for: error), isError: true)
            screen = .signIn
        }
    }

    func refreshComputers() async {
        guard !isSubmitting,
              let token = credentials.value(Self.accountTokenKey),
              !token.isEmpty
        else {
            screen = .signIn
            return
        }
        isSubmitting = true
        setStatus("Looking for your computer…", isError: false)
        defer { isSubmitting = false }
        await discoverAndConnect(token: token)
    }

    func submitPairingCode() async {
        guard !isSubmitting, let host = selectedHost else { return }
        let code = pairingCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard code.count == 6, code.allSatisfy(\.isNumber) else {
            setStatus("Enter the 6-digit pairing code shown on your computer.", isError: true)
            return
        }
        isSubmitting = true
        setStatus("Connecting…", isError: false)
        await store.connectPublicHost(hostId: host.hostId, code: code, name: platformDeviceName())
        isSubmitting = false
        pairingCode = ""
        if store.connected {
            screen = .hidden
            setStatus("", isError: false)
        } else {
            setStatus(Self.friendlyConnectionMessage(store.lastError), isError: true)
        }
    }

    func showPairingIfDisconnected() async {
        guard !store.connected else { return }
        await refreshComputers()
    }

    private func discoverAndConnect(token: String) async {
        setStatus("Looking for your computer…", isError: false)
        hosts = await T4DiscoveryClient.discoverHosts(accountToken: token)
        if selectedHostID.isEmpty || !hosts.contains(where: { $0.hostId == selectedHostID }) {
            selectedHostID = hosts.first?.hostId ?? ""
        }

        for host in hosts where store.savedRelayLink(for: host.hostId) != nil {
            await store.connectPublicHost(hostId: host.hostId, code: nil, name: platformDeviceName())
            if store.connected {
                screen = .hidden
                setStatus("", isError: false)
                return
            }
        }

        screen = .pairComputer
        if hosts.isEmpty {
            setStatus("Signed in — but your computer isn't reachable yet. Try again in a moment.", isError: true)
        } else {
            setStatus("Enter the pairing code shown on your computer.", isError: false)
        }
    }

    private func setStatus(_ message: String, isError: Bool) {
        status = message
        statusIsError = isError
    }

    private static func friendlyMessage(for error: Error) -> String {
        if let error = error as? LocalizedError, let message = error.errorDescription {
            return message
        }
        return "Couldn't sign in right now. Try again."
    }

    private static func friendlyConnectionMessage(_ message: String?) -> String {
        guard let message, !message.isEmpty else {
            return "Couldn't connect to that computer. Check the code and try again."
        }
        if message.localizedCaseInsensitiveContains("pairing code")
            || message.localizedCaseInsensitiveContains("host is running")
            || message.localizedCaseInsensitiveContains("room") {
            return "Couldn't connect to that computer. Check the pairing code and try again."
        }
        return "Couldn't connect to that computer. Try again in a moment."
    }
}

extension T4WindowsConnectionCoordinator: SwiftCrossUI.ObservableObject {
    var didChange: SwiftCrossUI.Publisher { T4UIObservation.publisher(for: self) }
}
