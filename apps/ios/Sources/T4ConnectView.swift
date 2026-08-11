//  T4ConnectView.swift
//  Connect to a T4 host over host-wire. The new-user path comes first: pick
//  your computer from the rendezvous discovery list and tap it, enter the
//  6-digit pairing code shown on the computer, and the store redeems it at
//  the rendezvous for a control-room link joined through the public relay.
//  Already-paired devices (or local/open hosts) can use the Advanced section
//  to connect with raw endpoint + credentials, or just a raw endpoint.
//  t4-code://pair/... deep links prefill the pairing code via the optional
//  `pendingPair` parameter.

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

    @State private var showAdvanced = false

    // Rendezvous discovery: computers running Omperator, listed by the
    // registry (connectivity is via the public relay, not the host's address).
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
                    Text("Tap a computer and enter the 6-digit pairing code shown on it. An already-paired computer reconnects automatically.")
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

    /// The pairing-code sheet for a discovered host. The code is redeemed at
    /// the rendezvous for the host's control-room link (the public path).
    private func codePrompt(host: T4DiscoveryHost) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Connect to \(host.label)")
                .font(.headline)
            Text("Omperator on \(host.label) shows a 6-digit pairing code. Enter it here to connect.")
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

    /// Connect with the entered code: the code is redeemed at the rendezvous
    /// for the host's control-room link. An empty code with no saved link
    /// keeps the prompt open — `lastError` explains that a code is required.
    private func connectWithCode(_ host: T4DiscoveryHost) async {
        let code = codePromptCode.trimmingCharacters(in: .whitespacesAndNewlines)
        await store.connectPublicHost(hostId: host.hostId, code: code.isEmpty ? nil : code, name: platformDeviceName())
        if store.connected {
            codePromptHost = nil
            dismiss()
        }
    }

    /// Load the rendezvous discovery list (on appear and via Refresh).
    private func loadDiscoveryHosts() async {
        guard !isLoadingHosts else { return }
        isLoadingHosts = true
        defer { isLoadingHosts = false }
        discoveryHosts = await T4DiscoveryClient.discoverHosts()
    }

    /// Connect from a deep link on first appearance — opening the link IS the
    /// consent gesture. A `sha256:` hostId is a rendezvous identity and goes
    /// straight through the public (relay) path (an empty code means
    /// rejoin-if-saved). A plain hostname hint resolves through the
    /// rendezvous discovery list — a fresh fetch, since the on-appear list
    /// may still be loading; if no registered host matches, the sheet stays
    /// up and explains that the host was not found.
    private func applyPendingPair() {
        guard let pair = pendingPair else { return }
        if pair.hostHint.hasPrefix("sha256:") {
            Task {
                await store.connectPublicHost(
                    hostId: pair.hostHint,
                    code: pair.code.isEmpty ? nil : pair.code,
                    name: platformDeviceName()
                )
                if store.connected { dismiss() }
            }
            return
        }
        Task {
            let hosts = await T4DiscoveryClient.discoverHosts()
            if let host = hosts.first(where: { $0.hostname.lowercased() == pair.hostHint.lowercased() }) {
                await store.connectPublicHost(
                    hostId: host.hostId,
                    code: pair.code.isEmpty ? nil : pair.code,
                    name: platformDeviceName()
                )
                if store.connected { dismiss() }
            } else {
                store.lastError = "Couldn't find \(pair.hostHint) in the rendezvous list — open Omperator on that computer and use its pairing code."
            }
        }
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
