//  T4ConnectView.swift
//  Connect to a T4 host over host-wire. The endpoint is a wss URL to a running
//  t4-host (e.g. the Tailnet address /v1/ws); optional device credentials attach
//  an already-paired device. (t4-code://pair deep-link pairing comes later.)

import SwiftUI
import HostWire

struct T4ConnectView: View {
    @EnvironmentObject var theme: ThemeStore
    @ObservedObject var store: T4SessionStore
    @Environment(\.dismiss) private var dismiss
    @State private var endpoint = "wss://"
    @State private var deviceId = ""
    @State private var deviceToken = ""
    @State private var working = false
    private var t: Theme { theme.t }

    private var trimmed: String { endpoint.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var valid: Bool { URL(string: trimmed)?.scheme == "ws" || URL(string: trimmed)?.scheme == "wss" }

    var body: some View {
        NavigationStack {
            Form {
                Section("Host") {
                    TextField("wss://host:port/v1/ws", text: $endpoint)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section {
                    TextField("Device ID", text: $deviceId).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Device token", text: $deviceToken)
                } header: {
                    Text("Device credentials")
                } footer: {
                    Text("Optional — only for an already-paired host.")
                }
                if let error = store.lastError {
                    Section { Text(error).font(.system(size: 12)).foregroundStyle(t.diffDel) }
                }
            }
            .navigationTitle("Connect")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Connect") { Task { await connect() } }
                        .disabled(!valid || working)
                }
            }
        }
    }

    private func connect() async {
        guard let url = URL(string: trimmed) else { return }
        working = true
        defer { working = false }
        let auth: DeviceAuthentication? = (!deviceId.isEmpty && !deviceToken.isEmpty)
            ? DeviceAuthentication(deviceId: deviceId, deviceToken: deviceToken) : nil
        await store.connect(
            endpoint: url,
            identity: ClientIdentity(name: "t4-ios", version: "0.1", build: "dev", platform: "ios"),
            authentication: auth
        )
        if store.connected { dismiss() }
    }
}
