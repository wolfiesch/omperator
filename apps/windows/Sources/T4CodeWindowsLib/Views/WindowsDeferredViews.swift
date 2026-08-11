import Foundation
import SwiftCrossUI
import HostWire

private struct WindowsDeferredPane: View {
    let title: String
    let detail: String
    let theme: ThemeStore
    let isPresented: Binding<Bool>

    var body: some View {
        let t = theme.t
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Text(title)
                    .font(.disp(16))
                    .foregroundColor(t.txt)
                Spacer()
                T4TextButton("Close") {
                    isPresented.wrappedValue = false
                }
                .font(.bodyF(12))
                .foregroundColor(t.txtBody)
            }
            Divider(t.line)
            Text(detail)
                .font(.bodyF(13))
                .foregroundColor(t.txtMuted)
                .multilineTextAlignment(.leading)
            Spacer()
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(t.bg2)
    }
}

struct T4ConnectView: View {
    let store: T4SessionStore
    let theme: ThemeStore
    let isPresented: Binding<Bool>
    let pendingPair: PendingPair?

    @State private var endpoint = ""
    @State private var pairingCode = ""
    @State private var certificatePin = ""
    @State private var deviceName = platformDeviceName()
    @State private var formError = ""
    @State private var isWorking = false

    private var t: Theme { theme.t }
    private var visibleSavedHosts: [WindowsSavedHostSummary] {
        if store.savedHosts.isEmpty,
           T4SessionStore.demoMode,
           ProcessInfo.processInfo.arguments.contains("-T4ShowSavedHosts") {
            return [
                WindowsSavedHostSummary(
                    id: "capture-saved-host",
                    endpoint: "wss://studio-host.example.test/v1/ws"
                )
            ]
        }
        return store.savedHosts
    }


    var body: some View {
        VStack(alignment: .leading, spacing: t4PlatformMetric(10)) {
            HStack(spacing: t4PlatformMetric(8)) {
                VStack(alignment: .leading, spacing: t4PlatformMetric(2)) {
                    Text("Hosts")
                        .font(.disp(18))
                        .foregroundColor(t.txt)
                    Text("Reconnect a saved host or pair a new one.")
                        .font(.bodyF(12))
                        .foregroundColor(t.txtMuted)
                }
                Spacer()
                T4TextButton("Close") {
                    isPresented.wrappedValue = false
                }
                .font(.bodyF(12))
                .foregroundColor(t.txtBody)
            }

            Divider(t.line)

            ScrollView {
                VStack(alignment: .leading, spacing: t4PlatformMetric(12)) {
                    savedHosts
                    Divider(t.lineFaint)
                    pairForm
                }
                .frame(maxWidth: .infinity)
            }

            if !formError.isEmpty {
                Text(formError)
                    .font(.bodyF(12))
                    .foregroundColor(t.diffDel)
                    .multilineTextAlignment(.leading)
            }
        }
        .padding(t4PlatformMetric(18))
        .frame(width: t4PlatformMetric(600), height: t4PlatformMetric(680))
        .background(t.bg2)
        .onAppear {
            guard let pendingPair else { return }
            if endpoint.isEmpty { endpoint = pendingPair.hostHint }
            if pairingCode.isEmpty { pairingCode = pendingPair.code }
        }
    }

    private var savedHosts: some View {
        VStack(alignment: .leading, spacing: t4PlatformMetric(8)) {
            Text("Saved hosts")
                .font(.bodyF(13))
                .foregroundColor(t.txt)
            if visibleSavedHosts.isEmpty {
                Text("No saved hosts yet.")
                    .font(.bodyF(12))
                    .foregroundColor(t.txtMuted)
            } else {
                ForEach(visibleSavedHosts) { host in
                    VStack(alignment: .leading, spacing: t4PlatformMetric(8)) {
                        HStack(spacing: t4PlatformMetric(8)) {
                            Circle()
                                .fill(store.activeSavedHostID == host.id ? t.diffAdd : t.txtGhost)
                                .frame(width: t4PlatformMetric(7), height: t4PlatformMetric(7))
                            Text(host.endpoint)
                                .font(.term(11))
                                .foregroundColor(t.txtBody)
                                .lineLimit(1)
                            Spacer()
                        }
                        HStack(spacing: t4PlatformMetric(12)) {
                            T4TextButton("Reconnect") {
                                reconnect(host.id)
                            }
                            .font(.bodyF(12))
                            .foregroundColor(t.accent)
                            .disabled(isWorking || host.id == "capture-saved-host")
                            T4TextButton("Forget") {
                                forget(host.id)
                            }
                            .font(.bodyF(12))
                            .foregroundColor(t.diffDel)
                            .disabled(isWorking || host.id == "capture-saved-host")
                            Spacer()
                        }
                    }
                    .padding(t4PlatformMetric(8))
                    .background {
                        RoundedRectangle(cornerRadius: t4PlatformMetric(8))
                            .fill(t.bg)
                    }
                }
            }
        }
    }

    private var pairForm: some View {
        VStack(alignment: .leading, spacing: t4PlatformMetric(8)) {
            Text("Pair a new host")
                .font(.bodyF(13))
                .foregroundColor(t.txt)
            TextField("Host or ws(s) endpoint", text: $endpoint)
                .font(.bodyF(12))
                .padding(t4PlatformMetric(6))
                .background {
                    RoundedRectangle(cornerRadius: t4PlatformMetric(8)).fill(t.bg)
                }
            SecureField("6-digit pairing code", text: $pairingCode)
                .font(.bodyF(12))
                .padding(t4PlatformMetric(6))
                .background {
                    RoundedRectangle(cornerRadius: t4PlatformMetric(8)).fill(t.bg)
                }
            TextField("Device name", text: $deviceName)
                .font(.bodyF(12))
                .padding(t4PlatformMetric(6))
                .background {
                    RoundedRectangle(cornerRadius: t4PlatformMetric(8)).fill(t.bg)
                }
            TextField("TLS certificate fingerprint for wss", text: $certificatePin)
                .font(.term(11))
                .padding(t4PlatformMetric(6))
                .background {
                    RoundedRectangle(cornerRadius: t4PlatformMetric(8)).fill(t.bg)
                }
            Text("The device token stays in Windows Credential Manager and is never shown here.")
                .font(.bodyF(11))
                .foregroundColor(t.txtMuted)
            HStack(spacing: t4PlatformMetric(8)) {
                T4TextButton(isWorking ? "Connecting\u{2026}" : "Pair and connect") {
                    pair()
                }
                .font(.bodyF(12))
                .foregroundColor(t.accent)
                .disabled(isWorking)
                Spacer()
            }
        }
    }

    private func pair() {
        guard let url = pairEndpoint() else {
            formError = "Enter a valid ws or wss host endpoint."
            return
        }
        let trimmedPin = certificatePin.trimmingCharacters(in: .whitespacesAndNewlines)
        if url.scheme?.lowercased() == "wss" && trimmedPin.isEmpty {
            formError = "Enter the host's SHA-256 TLS certificate fingerprint."
            return
        }
        let trimmedName = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else {
            formError = "Enter a device name."
            return
        }
        isWorking = true
        formError = ""
        Task {
            await store.pairAndConnect(
                endpoint: url,
                code: pairingCode.trimmingCharacters(in: .whitespacesAndNewlines),
                deviceName: trimmedName,
                certificatePin: trimmedPin.isEmpty ? nil : trimmedPin
            )
            isWorking = false
            if store.connected {
                isPresented.wrappedValue = false
            } else {
                formError = store.lastError ?? "The host could not be reached."
            }
        }
    }

    private func reconnect(_ id: String) {
        isWorking = true
        formError = ""
        Task {
            await store.connectSavedHost(id: id)
            isWorking = false
            if store.connected {
                isPresented.wrappedValue = false
            } else {
                formError = store.lastError ?? "The saved host could not be reached."
            }
        }
    }

    private func forget(_ id: String) {
        isWorking = true
        formError = ""
        Task {
            await store.forgetSavedHost(id: id)
            isWorking = false
            if let error = store.lastError {
                formError = error
            }
        }
    }

    private func pairEndpoint() -> URL? {
        let host = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty else { return nil }
        if host.hasPrefix("ws://") || host.hasPrefix("wss://") {
            return URL(string: host.hasSuffix("/v1/ws") ? host : "\(host)/v1/ws")
        }
        let withPort = host.contains(":") ? host : "\(host):8787"
        let scheme = withPort.hasSuffix(":8788") ? "wss" : "ws"
        return URL(string: "\(scheme)://\(withPort)/v1/ws")
    }
}


/// WINDOWS-GAP: only the native terminal surface remains deferred.
/// Every requested non-terminal pane uses a real shared or Windows-owned view.


struct T4TerminalDrawer: View {
    let session: SessionRef
    let store: T4SessionStore
    let theme: ThemeStore
    let isOpen: Bool

    var body: some View {
        Group {
            if isOpen {
                Text("Terminal support is deferred")
                    .font(.term(12))
                    .foregroundColor(theme.t.txtMuted)
                    .padding(12)
                    .frame(maxWidth: .infinity)
                    .background(theme.t.bg2)
            }
        }
    }
}
