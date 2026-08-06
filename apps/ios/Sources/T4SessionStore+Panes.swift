import Foundation
import HostWire

@MainActor
extension T4SessionStore {
    // MARK: - Usage, reviews, artifacts, and settings

    @discardableResult
    func usageRead() async -> UsageReadResult? {
        guard let client, connected, !hostId.isEmpty else {
            lastError = "Not connected to a host."
            return nil
        }
        guard grantedCapabilities.contains("usage.read") else { return nil }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId,
                command: "usage.read"
            ))
            let snapshot = try result.usageReadResult()
            usageSnapshot = snapshot
            return snapshot
        } catch {
            t4log.error("usage.read failed: \(error)")
            lastError = "\(error)"
            return nil
        }
    }

    @discardableResult
    func reviewRead(sessionId: String, reviewId: String? = nil) async -> ReviewReadResult? {
        guard let client, connected, !hostId.isEmpty else {
            lastError = "Not connected to a host."
            return nil
        }
        let requestedReviewId = reviewId ?? reviewsBySession[sessionId]?.last?.reviewId
        guard let requestedReviewId else {
            lastError = "No review available for this session."
            return nil
        }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId,
                command: "review.read",
                args: ["reviewId": .string(requestedReviewId)],
                sessionId: sessionId
            ))
            return try result.reviewReadResult()
        } catch {
            t4log.error("review.read failed: \(error)")
            lastError = "\(error)"
            return nil
        }
    }

    @discardableResult
    func artifactRead(
        sessionId: String,
        artifactId: String,
        offset: Int = 0
    ) async -> ArtifactReadChunk? {
        guard let client, connected, !hostId.isEmpty else {
            lastError = "Not connected to a host."
            return nil
        }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId,
                command: "artifact.read",
                args: [
                    "artifactId": .string(artifactId),
                    "offset": .number(Double(offset)),
                ],
                sessionId: sessionId
            ))
            let chunk = try result.artifactReadResult()
            artifactChunks[artifactId] = chunk
            return chunk
        } catch {
            t4log.error("artifact.read failed: \(error)")
            lastError = "\(error)"
            return nil
        }
    }

    private static func unwrapSettingsMetadata(
        _ settings: [String: JSONValue]
    ) -> [String: JSONValue] {
        settings.mapValues { value in
            guard case .object(let entry) = value,
                  entry["type"] != nil,
                  let effective = entry["effective"] else {
                return value
            }
            return effective
        }
    }

    @discardableResult
    func settingsRead() async -> [String: JSONValue]? {
        guard let client, connected, !hostId.isEmpty else {
            if Self.demoMode {
                settingsSnapshot = Self.sampleSettings
                return Self.sampleSettings
            }
            lastError = "Not connected to a host."
            return nil
        }
        guard grantedCapabilities.contains("config.read") else { return nil }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId,
                command: "settings.read"
            ))
            let read = try result.settingsReadResult()
            let settings = Self.unwrapSettingsMetadata(read.settings)
            settingsSnapshot = settings
            settingsRevision = read.revision
            return settings
        } catch {
            t4log.error("settings.read failed: \(error)")
            lastError = "\(error)"
            return nil
        }
    }

    @discardableResult
    func settingsWrite(patch: [String: JSONValue]) async -> Bool {
        guard let client, connected, !hostId.isEmpty else {
            if Self.demoMode {
                // Offline demo: apply the patch locally so pane pickers don't
                // surface a write failure banner in captures.
                var merged = settingsSnapshot ?? [:]
                for (key, value) in patch { merged[key] = value }
                settingsSnapshot = merged
                return true
            }
            lastError = "Not connected to a host."
            return false
        }
        guard grantedCapabilities.contains("config.write") else {
            lastError = "Settings writes require the config.write capability."
            return false
        }
        guard let revision = settingsRevision else {
            lastError = "Settings revision unknown — load settings first."
            return false
        }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId,
                command: "settings.write",
                args: patch,
                expectedRevision: revision
            ))
            if let echo = try result.settingsWriteResult(),
               case .string(let newRevision) = echo["revision"] ?? .null,
               !newRevision.isEmpty {
                settingsRevision = newRevision
            }
            await settingsRead()
            return true
        } catch {
            t4log.error("settings.write failed: \(error)")
            lastError = "\(error)"
            return false
        }
    }

    func reviews(for sessionId: String) -> [ReviewFrame] {
        if connected { return reviewsBySession[sessionId] ?? [] }
        return Self.sampleReviews
    }

    func artifacts(for sessionId: String) -> [ArtifactDescriptor] {
        let entries = transcript(for: sessionId)
        var seen = Set<String>()
        var artifacts: [ArtifactDescriptor] = []
        for entry in entries {
            guard let values = entry.data.array("artifacts") else { continue }
            for value in values {
                guard case .object(let object) = value,
                      case .string(let artifactId) = object["artifactId"] ?? .null,
                      !seen.contains(artifactId) else { continue }
                seen.insert(artifactId)
                if let descriptor = ArtifactDescriptor(from: value) {
                    artifacts.append(descriptor)
                }
            }
        }
        return artifacts
    }
}


// MARK: - Demo settings (offline captures)

extension T4SessionStore {
    /// Settings snapshot for the demo settings pane: model roles, thinking
    /// level, approval mode, and masked provider keys.
    static let sampleSettings: [String: JSONValue] = [
        "modelRoles": .object([
            "default": .string("kimi-code/k3"),
            "smol": .string("deepseek-v4-flash"),
            "slow": .string("gpt-5.2"),
            "designer": .string("gpt-5.2"),
            "task": .string("devin/swe-1-7"),
        ]),
        "defaultThinkingLevel": .string("medium"),
        "tools.approvalMode": .string("write"),
        "providerKeys": .object([
            "deepseek": .string("sk-…77e0"),
            "kimi-code": .string("sk-…9f2c"),
            "openai": .string("sk-…41bd"),
        ]),
    ]
}
