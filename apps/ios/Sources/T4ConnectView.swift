//  T4ConnectView.swift
//  Connect to a T4 host over host-wire. The new-user path comes first: enter
//  the host hint and, when required, the 6-digit pairing code shown by the
//  host, tap Pair & Connect, and the store runs the pair.start handshake and
//  persists the granted device token. Same-tailnet owner hosts auto-approve
//  pairing with an empty code. Already-paired devices (or local/open hosts)
//  can use the Advanced section to connect with raw endpoint + credentials,
//  or just a raw endpoint. t4-code://pair/... deep links prefill the pair
//  fields via the optional `pendingPair` parameter.

import SwiftUI
import HostWire

struct T4ConnectView: View {
    @EnvironmentObject var theme: ThemeStore
    @ObservedObject var store: T4SessionStore
    @Environment(\.dismiss) private var dismiss

    /// Optional deep-link prefill (t4-code://pair/<hostHint>[/<code>]).
    var pendingPair: PendingPair? = nil

    @State private var pairHost: String = ""
    @State private var pairCode: String = ""
    @State private var showAdvanced = false

    // Advanced (raw) form — the original connect path.
    @State private var endpoint = "wss://"
    @State private var deviceId = ""
    @State private var deviceToken = ""
    // Collab entry point: a tailnet gateway URL discovers rooms to join as
    // a collab guest (GET <gateway>/v1/rooms).
    @State private var gatewayURL = ""

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

    private var trimmedGateway: String { gatewayURL.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var gatewayValid: Bool {
        URL(string: trimmedGateway)?.scheme == "http" || URL(string: trimmedGateway)?.scheme == "https"
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Computer (e.g. macbookpro.my-tailnet.ts.net)", text: $pairHost)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                    Button {
                        Task { await connectPlugAndPlay() }
                    } label: {
                        HStack {
                            if store.connecting { ProgressView().tint(.white) }
                            Text("Connect").fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(t.interactiveAccent)
                    .disabled(!pairValid || store.connecting)
                } header: {
                    Text("Connect to your computer")
                } footer: {
                    Text("Enter your computer's Tailnet name, or tap a link shared from it. No code needed — your own devices are trusted automatically.")
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

                    Divider().padding(.vertical, 6)
                    TextField("https://gateway.my-tailnet.ts.net", text: $gatewayURL)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        #endif
                    Button {
                        Task { await connectCollabGateway() }
                    } label: {
                        HStack {
                            if store.connecting { ProgressView().tint(.white) }
                            Text("Join collab rooms").fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(t.interactiveAccent)
                    .disabled(!gatewayValid || store.connecting)
                    Text("A tailnet gateway URL discovers rooms hosted by the collab /enclave plugin and joins them as a guest.")
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

    /// Plug-and-play connect: host hint -> tailnet gateway
    /// (https://<host>:8445) -> /v1/rooms -> collab guest join. No PIN, no
    /// port/IP typing; the daemon auto-approves your own Tailnet devices.
    private func connectPlugAndPlay() async {
        let host = trimmedHost
        guard !host.isEmpty else { return }
        let gateway: URL
        if host.hasPrefix("http://") || host.hasPrefix("https://") {
            gateway = URL(string: host)!
        } else {
            gateway = URL(string: "https://\(host):8445")!
        }
        let name = platformDeviceName()
        await store.connectCollab(gatewayURL: gateway, name: name)
        if store.connected { dismiss() }
    }

    /// Prefill the connect fields from a deep link on first appearance — then
    /// connect immediately: opening the link IS the consent gesture.
    private func applyPendingPair() {
        guard let pair = pendingPair, pairHost.isEmpty, pairCode.isEmpty else { return }
        pairHost = pair.hostHint
        pairCode = pair.code
        Task { await connectPlugAndPlay() }
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

    private func connectCollabGateway() async {
        guard let url = URL(string: trimmedGateway) else { return }
        await store.connectCollab(gatewayURL: url, name: platformClientName)
        if store.connected { dismiss() }
    }
}
