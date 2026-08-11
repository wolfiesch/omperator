//  T4ConnectView.swift
//  Connect to a T4 host over host-wire. The new-user path comes first: pick
//  your computer from the rendezvous discovery list and tap it — the store
//  resolves the host gateway's /v1/discovery wsUrl and connects through the
//  gateway (the welcome is .local, so no pairing round-trip). Already-paired
//  devices (or local/open hosts) can use the Advanced section to connect with
//  raw endpoint + credentials, or just a raw endpoint. t4-code://pair/...
//  deep links prefill the pair fields via the optional `pendingPair`
//  parameter.

import SwiftUI
import HostWire

struct T4ConnectView: View {
    /// Git commit baked into the bundle (build script writes commit.txt).
    private static let buildStamp: String? = {
        guard let url = Bundle.main.url(forResource: "commit", withExtension: "txt"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }()

    @EnvironmentObject var theme: ThemeStore
    @ObservedObject var store: T4SessionStore
    @Environment(\.dismiss) private var dismiss

    /// Optional deep-link prefill (t4-code://pair/<hostHint>[/<code>]).
    var pendingPair: PendingPair? = nil

    @State private var pairHost: String = ""
    @State private var pairCode: String = ""
    @State private var showAdvanced = false

    // Rendezvous discovery: computers this device can reach, listed by the
    // registry and filtered by a healthz probe.
    @State private var discoveryHosts: [T4DiscoveryHost] = []
    @State private var isLoadingHosts = false

    // Public (rendezvous) pairing-code prompt for a tapped host. Prefilled
    // from the deep link's code when one came in with the sheet.
    @State private var codePromptHost: T4DiscoveryHost?
    @State private var codePromptCode: String = ""

    // Advanced (raw) form — the original connect path.
    @State private var endpoint = "wss://"
    @State private var deviceId = ""
    @State private var deviceToken = ""

    private var t: Theme { theme.t }

    private var trimmedHost: String { pairHost.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedCode: String { pairCode.trimmingCharacters(in: .whitespacesAndNewlines) }
    // The code is optional: same-tailnet owner hosts auto-approve an empty
    // code; non-owners still need the 6-digit ticket.
    private var pairValid: Bool { !trimmedHost.isEmpty }

    private var trimmedEndpoint: String { endpoint.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var endpointValid: Bool {
        URL(string: trimmedEndpoint)?.scheme == "ws" || URL(string: trimmedEndpoint)?.scheme == "wss"
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if isLoadingHosts {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text("Looking for computers…")
                                .font(.system(size: 13))
                                .foregroundStyle(t.txtMuted)
                        }
                    } else if discoveryHosts.isEmpty {
                        Text("No computers found — make sure Omperator is running on your computer")
                            .font(.system(size: 13))
                            .foregroundStyle(t.txtMuted)
                    } else {
                        ForEach(discoveryHosts) { host in
                            Button {
                                Task { await tapHost(host) }
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(host.label)
                                        .fontWeight(.medium)
                                        .foregroundStyle(t.txt)
                                    Text(host.hostname)
                                        .font(.system(size: 12))
                                        .foregroundStyle(t.txtMuted)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(store.connecting)
                        }
                    }
                } header: {
                    Text("Connect to your computer")
                } footer: {
                    Text("Tap a computer — a computer on your private network connects automatically; anything else shows a pairing code.")
                }

                // Build stamp: the git commit baked into the bundle by the
                // device-build script — the ground truth for which binary runs.
                if let stamp = Self.buildStamp {
                    Text("build \(stamp)")
                        .font(.system(size: 10))
                        .foregroundStyle(t.txtLabel)
                        .frame(maxWidth: .infinity)
                }

                DisclosureGroup("Advanced", isExpanded: $showAdvanced) {
                    Text("Legacy pairing (code required only for devices outside your Tailnet):")
                        .font(.system(size: 12))
                        .foregroundStyle(t.txtMuted)
                    TextField("Host (e.g. macbookpro.my-tailnet.ts.net)", text: $pairHost)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                    TextField("6-digit code", text: $pairCode)
                        .autocorrectionDisabled()
                        .font(.system(.body, design: .monospaced))
                        #if os(iOS)
                        .keyboardType(.numberPad)
                        .textInputAutocapitalization(.never)
                        #endif
                    Button {
                        Task { await pairAndConnect() }
                    } label: {
                        HStack {
                            if store.connecting { ProgressView().tint(.white) }
                            Text("Pair & Connect").fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(t.interactiveAccent)
                    .disabled(!pairValid || store.connecting)

                    TextField("wss://host:port/v1/ws", text: $endpoint)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                    TextField("Device ID", text: $deviceId)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                    SecureField("Device token", text: $deviceToken)
                    Button {
                        Task { await connectRaw() }
                    } label: {
                        HStack {
                            if store.connecting { ProgressView().tint(.white) }
                            Text("Connect").fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(t.interactiveAccent)
                    .disabled(!endpointValid || store.connecting)
                    Text("Use raw endpoint + device credentials for an already-paired host. Credentials are optional for an open host.")
                        .font(.system(size: 12))
                        .foregroundStyle(t.txtMuted)
                }

                if let error = store.lastError {
                    Section {
                        Text(error).font(.system(size: 12)).foregroundStyle(t.diffDel)
                    }
                }
            }
            .formStyle(.grouped)
            // Proper margins everywhere: macOS Forms otherwise run edge-to-edge.
            .frame(maxWidth: 460)
            .padding(.horizontal, 24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(t.bg)
            .navigationTitle("Connect")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        Task { await loadDiscoveryHosts() }
                    } label: {
                        if isLoadingHosts {
                            ProgressView()
                        } else {
                            Image(systemName: "arrow.clockwise")
                        }
                    }
                    .disabled(isLoadingHosts)
                    .accessibilityLabel("Refresh")
                }
            }
            .onAppear {
                applyPendingPair()
                Task { await loadDiscoveryHosts() }
            }
            .sheet(item: $codePromptHost) { host in
                codePrompt(host: host)
            }
        }
    }

    /// Tap a discovered computer. A saved public relay link rejoins silently
    /// (the link is the credential — no code); otherwise the pairing-code
    /// prompt appears, prefilled from the deep link when one arrived.
    private func tapHost(_ host: T4DiscoveryHost) async {
        if store.savedRelayLink(for: host.hostId) != nil {
            await store.connectPublicHost(hostId: host.hostId, code: nil, name: platformDeviceName())
            if store.connected { dismiss() }
        } else {
            codePromptHost = host
            codePromptCode = pendingPair?.code ?? ""
        }
    }

    /// The pairing-code sheet for a discovered host. A non-empty code goes
    /// through the rendezvous (public path); an empty code first tries the
    /// host's gateway (tailnet owner auto-approval) and keeps the prompt up
    /// when that origin is unreachable, so the code stays reachable.
    private func codePrompt(host: T4DiscoveryHost) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Connect to \(host.label)")
                .font(.headline)
            Text("Omperator on \(host.label) shows a 6-digit pairing code. Your own computer — reachable over your private network — connects without one.")
                .font(.system(size: 12))
                .foregroundStyle(t.txtMuted)
            TextField("6-digit pairing code", text: $codePromptCode)
                .autocorrectionDisabled()
                #if os(iOS)
                .keyboardType(.numberPad)
                .textInputAutocapitalization(.never)
                #endif
                .font(.system(.body, design: .monospaced))
            if let error = store.lastError {
                Text(error)
                    .font(.system(size: 12))
                    .foregroundStyle(t.diffDel)
            }
            HStack {
                Button("Cancel") { codePromptHost = nil }
                Spacer()
                Button("Connect over private network") {
                    Task { await connectViaTailnet(host) }
                }
                Button {
                    Task { await connectWithCode(host) }
                } label: {
                    HStack {
                        if store.connecting { ProgressView().tint(.white) }
                        Text("Connect").fontWeight(.semibold)
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(t.interactiveAccent)
                .disabled(store.connecting)
            }
        }
        .padding(20)
        .frame(width: 400)
    }

    /// Connect with the entered code: non-empty goes through the rendezvous;
    /// empty falls back to the tailnet gateway (and keeps the prompt open —
    /// with `lastError` explaining — when that origin is unreachable).
    private func connectWithCode(_ host: T4DiscoveryHost) async {
        let code = codePromptCode.trimmingCharacters(in: .whitespacesAndNewlines)
        if code.isEmpty {
            await store.connectDiscoveryHost(host, name: platformDeviceName())
        } else {
            await store.connectPublicHost(hostId: host.hostId, code: code, name: platformDeviceName())
        }
        if store.connected {
            codePromptHost = nil
            dismiss()
        }
    }

    /// Secondary prompt action: the tailnet gateway path (owner
    /// auto-approval) without entering a pairing code.
    private func connectViaTailnet(_ host: T4DiscoveryHost) async {
        await store.connectDiscoveryHost(host, name: platformDeviceName())
        if store.connected {
            codePromptHost = nil
            dismiss()
        }
    }

    /// Connect to a discovered computer through its gateway.
    private func connect(_ host: T4DiscoveryHost) async {
        await store.connectDiscoveryHost(host, name: platformDeviceName())
        if store.connected { dismiss() }
    }

    /// Load the rendezvous discovery list (on appear and via Refresh).
    private func loadDiscoveryHosts() async {
        guard !isLoadingHosts else { return }
        isLoadingHosts = true
        defer { isLoadingHosts = false }
        discoveryHosts = await T4DiscoveryClient.discoverHosts()
    }

    /// Prefill the connect fields from a deep link on first appearance — then
    /// connect immediately: opening the link IS the consent gesture. Links
    /// with a host hint connect through discovery when the host is known (a
    /// fresh fetch — the on-appear list may still be loading); otherwise the
    /// hint pairs directly, the pre-discovery path.
    private func applyPendingPair() {
        guard let pair = pendingPair, pairHost.isEmpty, pairCode.isEmpty else { return }
        pairHost = pair.hostHint
        pairCode = pair.code
        guard !trimmedHost.isEmpty else { return }
        if trimmedHost.hasPrefix("sha256:") {
            // A rendezvous hostId: the public (relay) connect path. The
            // code is optional — an empty one means rejoin-if-saved, and
            // connectPublicHost explains when neither exists.
            Task {
                await store.connectPublicHost(
                    hostId: trimmedHost,
                    code: trimmedCode.isEmpty ? nil : trimmedCode,
                    name: platformDeviceName()
                )
                if store.connected { dismiss() }
            }
            return
        }
        Task {
            let hosts = await T4DiscoveryClient.discoverHosts()
            if let host = hosts.first(where: { $0.hostname.lowercased() == trimmedHost.lowercased() }) {
                await connect(host)
            } else {
                await pairAndConnect()
            }
        }
    }

    /// Build the endpoint from the host hint. Explicit schemes pass through;
    /// a bare hint defaults to the plain ws port (8787). Port 8788 (the
    /// host's --remote-tls-port) implies wss so a bare `host:8788` "just
    /// works" — no scheme typing for the common case.
    private func pairEndpoint() -> URL? {
        let host = trimmedHost
        guard !host.isEmpty else { return nil }
        if host.hasPrefix("ws://") || host.hasPrefix("wss://") {
            return URL(string: host.hasSuffix("/v1/ws") ? host : "\(host)/v1/ws")
        }
        let withPort = host.contains(":") ? host : "\(host):8787"
        let scheme = withPort.hasSuffix(":8788") ? "wss" : "ws"
        return URL(string: "\(scheme)://\(withPort)/v1/ws")
    }

    private func pairAndConnect() async {
        guard let url = pairEndpoint() else { return }
        let name = platformDeviceName()
        await store.pairAndConnect(endpoint: url, code: trimmedCode, deviceName: name)
        if store.connected { dismiss() }
    }

    private func connectRaw() async {
        guard let url = URL(string: trimmedEndpoint) else { return }
        let auth: DeviceAuthentication? = (!deviceId.isEmpty && !deviceToken.isEmpty)
            ? DeviceAuthentication(deviceId: deviceId, deviceToken: deviceToken) : nil
        await store.connect(
            endpoint: url,
            identity: ClientIdentity(
                name: platformClientName,
                version: "0.1",
                build: "dev",
                platform: platformClientPlatform
            ),
            authentication: auth
        )
        if store.connected { dismiss() }
    }
}
