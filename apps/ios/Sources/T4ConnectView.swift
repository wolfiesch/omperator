//  T4ConnectView.swift
//  Connect to a T4 host over host-wire. The new-user path comes first: enter
//  the host hint and the 6-digit pairing code shown by the host, tap Pair &
//  Connect, and the store runs the pair.start handshake and persists the
//  granted device token. Already-paired devices (or local/open hosts) can use
//  the Advanced section to connect with raw endpoint + credentials, or just a
//  raw endpoint. t4-code://pair/... deep links prefill the pair fields via the
//  optional `pendingPair` parameter.

import SwiftUI
import HostWire

struct T4ConnectView: View {
    @EnvironmentObject var theme: ThemeStore
    @ObservedObject var store: T4SessionStore
    @Environment(\.dismiss) private var dismiss

    /// Optional deep-link prefill (t4-code://pair/<hostHint>/<code>).
    var pendingPair: PendingPair? = nil

    @State private var pairHost: String = ""
    @State private var pairCode: String = ""
    @State private var showAdvanced = false

    // Advanced (raw) form — the original connect path.
    @State private var endpoint = "wss://"
    @State private var deviceId = ""
    @State private var deviceToken = ""

    private var t: Theme { theme.t }

    private var trimmedHost: String { pairHost.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedCode: String { pairCode.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var pairValid: Bool { !trimmedHost.isEmpty && trimmedCode.count == 6 }

    private var trimmedEndpoint: String { endpoint.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var endpointValid: Bool {
        URL(string: trimmedEndpoint)?.scheme == "ws" || URL(string: trimmedEndpoint)?.scheme == "wss"
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
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
                } header: {
                    Text("Pair a new device")
                } footer: {
                    Text("Enter the host hint and the 6-digit code shown by the host. The port defaults to 8787 when not specified.")
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
            }
            .onAppear { applyPendingPair() }
        }
    }

    /// Prefill the pair fields from a deep link on first appearance — then
    /// pair immediately: opening the link IS the consent gesture.
    private func applyPendingPair() {
        guard let pair = pendingPair, pairHost.isEmpty, pairCode.isEmpty else { return }
        pairHost = pair.hostHint
        pairCode = pair.code
        Task { await pairAndConnect() }
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
