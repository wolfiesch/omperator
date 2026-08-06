//  T4ConnectView.swift (Linux port of apps/ios/Sources/T4ConnectView.swift)
//  Connect to a T4 host over host-wire. The new-user path comes first: enter
//  the host hint and the 6-digit pairing code shown by the host, tap Pair &
//  Connect, and the store runs the pair.start handshake and persists the
//  granted device token. Already-paired devices (or local/open hosts) can use
//  the Advanced section to connect with raw endpoint + credentials, or just a
//  raw endpoint. t4-code://pair/... deep links prefill the pair fields via the
//  optional `pendingPair` parameter.
//
//  Linux port notes:
//  • SwiftUI Form / DisclosureGroup / .borderedProminent don't exist in
//    SwiftCrossUI: plain sections in a VStack, Advanced behind a Toggle, and
//    the prominent action is a filled button.
//  • @Environment(\.dismiss) → isPresented binding.

import Foundation
import SwiftCrossUI
import HostWire

struct T4ConnectView: View {
    let store: T4SessionStore
    let theme: ThemeStore
    @Binding var isPresented: Bool

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

    init(
        store: T4SessionStore,
        theme: ThemeStore,
        isPresented: Binding<Bool>,
        pendingPair: PendingPair? = nil
    ) {
        self.store = store
        self.theme = theme
        self._isPresented = isPresented
        self.pendingPair = pendingPair
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header (replaces the navigation toolbar + Cancel item).
            HStack(spacing: 10) {
                Text("Connect")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(t.txt)
                Spacer()
                T4TextButton("Cancel") { isPresented = false }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 14)

            Divider(t.line)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("PAIR A NEW DEVICE")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(t.txtBody)
                        .padding(.top, 14)

                    TextField("Host (e.g. macbookpro.my-tailnet.ts.net)", text: $pairHost)
                        .padding(8)
                        .background { RoundedRectangle(cornerRadius: 8).fill(t.glassFill) }
                    TextField("6-digit code", text: $pairCode)
                        .font(.system(size: 14, design: .monospaced))
                        .padding(8)
                        .background { RoundedRectangle(cornerRadius: 8).fill(t.glassFill) }

                    // LINUX-GAP: the macOS button hosts a spinner next to its
                    // label; SwiftCrossUI Buttons take a String label only.
                    T4TextButton(store.connecting ? "Connecting…" : "Pair & Connect") {
                        Task { await pairAndConnect() }
                    }
                    .disabled(!pairValid || store.connecting)
                    .padding(10)
                    .frame(maxWidth: .infinity)
                    .background { RoundedRectangle(cornerRadius: 10).fill(t.interactiveAccent) }
                    .foregroundColor(t.bg)

                    Text("Enter the host hint and the 6-digit code shown by the host. The port defaults to 8787 when not specified.")
                        .font(.system(size: 12))
                        .foregroundColor(t.txtMuted)

                    Divider(t.line)

                    // LINUX-GAP: DisclosureGroup → Toggle with conditional body.
                    Toggle("Advanced", isOn: $showAdvanced)

                    if showAdvanced {
                        VStack(alignment: .leading, spacing: 10) {
                            TextField("wss://host:port/v1/ws", text: $endpoint)
                                .padding(8)
                                .background { RoundedRectangle(cornerRadius: 8).fill(t.glassFill) }
                            TextField("Device ID", text: $deviceId)
                                .padding(8)
                                .background { RoundedRectangle(cornerRadius: 8).fill(t.glassFill) }
                            SecureField("Device token", text: $deviceToken)
                                .padding(8)
                                .background { RoundedRectangle(cornerRadius: 8).fill(t.glassFill) }
                            T4TextButton(store.connecting ? "Connecting…" : "Connect") {
                                Task { await connectRaw() }
                            }
                            .disabled(!endpointValid || store.connecting)
                            .padding(10)
                            .frame(maxWidth: .infinity)
                            .background { RoundedRectangle(cornerRadius: 10).fill(t.interactiveAccent) }
                            .foregroundColor(t.bg)
                            Text("Use raw endpoint + device credentials for an already-paired host. Credentials are optional for an open host.")
                                .font(.system(size: 12))
                                .foregroundColor(t.txtMuted)
                        }
                    }

                    if let error = store.lastError {
                        Text(error)
                            .font(.system(size: 12))
                            .foregroundColor(t.diffDel)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
        }
        .frame(width: 480, height: 540)
        .background(t.bg)
        .onAppear { applyPendingPair() }
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
        if store.connected { isPresented = false }
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
        if store.connected { isPresented = false }
    }
}
