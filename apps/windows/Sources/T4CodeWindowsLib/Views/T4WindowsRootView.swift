import Foundation
import SwiftCrossUI

public struct T4WindowsRootView: View {
    private let configuration: T4WindowsLaunchConfiguration
    @Environment(\.colorScheme) private var systemColorScheme

    public init(configuration: T4WindowsLaunchConfiguration = T4WindowsLaunchConfiguration()) {
        self.configuration = configuration
    }

    private var isDark: Bool {
        switch configuration.themeMode {
        case .system:
            systemColorScheme == .dark
        case .dark:
            true
        case .light:
            false
        }
    }

    public var body: some View {
        let theme = T4WindowsTheme(isDark: isDark)
        Group {
            if configuration.demoMode {
                T4WindowsDemoWorkspace(theme: theme)
            } else {
                onboarding(theme: theme)
            }
        }
        .colorScheme(isDark ? .dark : .light)
        .foregroundColor(theme.text)
        .frame(
            minWidth: 900,
            maxWidth: .infinity,
            minHeight: 600,
            maxHeight: .infinity
        )
    }

    private func onboarding(theme: T4WindowsTheme) -> some View {
        ZStack {
            theme.background
            VStack(spacing: 16) {
                Text("Omperator")
                    .font(.system(size: 36, weight: .black))
                    .foregroundColor(theme.accent)
                Text("Native Windows client")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(theme.text)
                Text("Connect this client to an existing t4-host. OMP remains the runtime authority.")
                    .font(.system(size: 13))
                    .foregroundColor(theme.mutedText)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 420)
                Button("Pair a host") {}
                    .padding(.top, 8)
            }
            .padding(32)
        }
    }
}

private struct T4WindowsDemoWorkspace: View {
    let theme: T4WindowsTheme

    @State private var query = ""
    @State private var selectedSessionID = T4WindowsDemoContent.sessions[0].id
    @State private var composerText = ""
    @State private var lastSentMessage = ""

    private var filteredSessions: [T4WindowsDemoSession] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return T4WindowsDemoContent.sessions }
        return T4WindowsDemoContent.sessions.filter {
            $0.title.lowercased().contains(needle)
                || $0.project.lowercased().contains(needle)
                || $0.status.lowercased().contains(needle)
        }
    }

    private var selectedSession: T4WindowsDemoSession {
        T4WindowsDemoContent.sessions.first { $0.id == selectedSessionID }
            ?? T4WindowsDemoContent.sessions[0]
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                theme.background
                HStack(spacing: 0) {
                    rail(height: geometry.size.height)
                    Divider(theme.line)
                        .frame(width: 1, height: geometry.size.height)
                    detail(
                        width: max(geometry.size.width - 301, 0),
                        height: geometry.size.height
                    )
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
        }
    }

    private func rail(height: Double) -> some View {
        HStack(spacing: 0) {
            Rectangle()
                .fill(theme.accent)
                .frame(width: 3)

            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Text("Omperator")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(theme.text)
                    Spacer()
                    HStack(spacing: 5) {
                        Circle()
                            .fill(theme.success)
                            .frame(width: 7, height: 7)
                        Text("Demo")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(theme.success)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(height: 40)

                TextField("Search sessions", text: $query)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 10)
                    .frame(height: 44)

                Divider(theme.faintLine)
                    .frame(height: 1)

                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Text("Current · \(filteredSessions.count)")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(theme.text)
                            .lineLimit(1)
                            .padding(.horizontal, 10)
                            .padding(.top, 12)
                            .padding(.bottom, 6)

                        ForEach(filteredSessions) { session in
                            sessionRow(session)
                        }

                        if filteredSessions.isEmpty {
                            Text("No matching sessions")
                                .font(.system(size: 12))
                                .foregroundColor(theme.mutedText)
                                .frame(maxWidth: .infinity, alignment: .center)
                                .padding(.vertical, 24)
                        }
                    }
                    .padding(.horizontal, 8)
                }
                .frame(height: max(height - 145, 0))

                Divider(theme.faintLine)
                    .frame(height: 1)

                HStack(spacing: 10) {
                    Circle()
                        .fill(theme.success)
                        .frame(width: 8, height: 8)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("WinUI")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(theme.text)
                            .frame(width: 120, alignment: .leading)
                        Text("HostWire client boundary")
                            .font(.system(size: 10))
                            .foregroundColor(theme.mutedText)
                            .lineLimit(1)
                    }
                    .frame(width: 240, alignment: .leading)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .frame(height: 59)
            }
        }
        .frame(width: 300, height: height, alignment: .topLeading)
        .background(theme.surface)
    }

    private func sessionRow(_ session: T4WindowsDemoSession) -> some View {
        let selected = session.id == selectedSessionID
        return VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Text(session.project)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(selected ? theme.accent : theme.labelText)
                    .lineLimit(1)
                Spacer()
                Text(session.updated)
                    .font(.system(size: 10))
                    .foregroundColor(theme.labelText)
            }
            Text(session.title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(selected ? theme.accent : theme.text)
                .lineLimit(1)
            HStack(spacing: 7) {
                Circle()
                    .fill(statusColor(session.status))
                    .frame(width: 6, height: 6)
                Text(session.status)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(statusColor(session.status))
                Spacer()
                Text(session.model)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(theme.mutedText)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .background {
            if selected {
                RoundedRectangle(cornerRadius: 2)
                    .fill(theme.accentDim)
            }
        }
        .onTapGesture {
            selectedSessionID = session.id
        }
    }

    private func statusColor(_ status: String) -> Color {
        status == "Working" ? theme.accent : theme.success
    }

    private func detail(width: Double, height: Double) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(selectedSession.title)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(theme.text)
                        .lineLimit(1)
                    Text("\(selectedSession.project) · \(selectedSession.model)")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(theme.mutedText)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Spacer()
                HStack(spacing: 6) {
                    toolbarLabel("Agents")
                    toolbarLabel("Files")
                    toolbarLabel("Review")
                }
                .layoutPriority(1)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(width: width, height: 58)

            Divider(theme.line)
                .frame(width: width, height: 1)

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    HStack(spacing: 8) {
                        Circle()
                            .fill(statusColor(selectedSession.status))
                            .frame(width: 7, height: 7)
                        Text(selectedSession.status)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(statusColor(selectedSession.status))
                        Text("Native WinUI session")
                            .font(.system(size: 11))
                            .foregroundColor(theme.labelText)
                    }

                    ForEach(T4WindowsDemoContent.transcript) { item in
                        transcriptRow(item)
                    }

                    if !lastSentMessage.isEmpty {
                        transcriptRow(T4WindowsDemoTranscriptItem(
                            id: "local-message",
                            kind: .user,
                            title: "You · local demo",
                            body: lastSentMessage
                        ))
                    }
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 20)
                .frame(maxWidth: 720, alignment: .leading)
            }
            .frame(width: width, height: max(height - 122, 0))

            Divider(theme.faintLine)
                .frame(width: width, height: 1)

            HStack(spacing: 10) {
                TextField("Message the selected session", text: $composerText)
                    .frame(maxWidth: .infinity)
                Button("Send") {
                    let message = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !message.isEmpty else { return }
                    lastSentMessage = message
                    composerText = ""
                }
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
            .frame(width: width, height: 62)
            .background(theme.surface)
        }
        .frame(width: width, height: height, alignment: .topLeading)
        .background(theme.background)
    }

    private func toolbarLabel(_ label: String) -> some View {
        Text(label)
            .font(.system(size: 11, weight: .semibold))
            .foregroundColor(theme.bodyText)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background {
                RoundedRectangle(cornerRadius: 2)
                    .fill(theme.faintLine)
            }
    }

    private func transcriptRow(_ item: T4WindowsDemoTranscriptItem) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(item.title)
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(item.kind == .tool ? theme.tool : theme.bodyText)
            Text(item.body)
                .font(item.kind == .tool
                    ? .system(size: 12, design: .monospaced)
                    : .system(size: 13))
                .foregroundColor(theme.text)
                .lineLimit(nil)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: item.kind == .tool ? 6 : 10)
                .fill(item.kind == .tool ? theme.accentDim : theme.surface)
        }
    }
}
