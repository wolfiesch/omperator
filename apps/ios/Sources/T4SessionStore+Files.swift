import Foundation
import HostWire

@MainActor
extension T4SessionStore {
    // MARK: - Files (read-only workspace browser)

    func listFiles(sessionId: String, path: String) async -> [FileListEntry]? {
        guard let client, connected, !hostId.isEmpty else {
            lastError = "Not connected to a host."
            return nil
        }
        var args: [String: JSONValue] = [:]
        if !path.isEmpty { args["path"] = .string(path) }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "files.list", args: args, sessionId: sessionId))
            return try result.filesListResult()
        } catch {
            t4log.error("files.list failed: \(error)")
            lastError = "This host has no files bridge (desktop hosts only)."
            return nil
        }
    }

    func readFile(sessionId: String, path: String) async -> String? {
        guard let client, connected, !hostId.isEmpty else {
            lastError = "Not connected to a host."
            return nil
        }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "files.read",
                args: ["path": .string(path)], sessionId: sessionId))
            let (content, _) = try result.filesReadResult()
            return content
        } catch {
            t4log.error("files.read failed: \(error)")
            lastError = "\(error)"
            return nil
        }
    }

    func filesSearch(sessionId: String, query: String) async -> FilesSearchResult? {
        guard let client, connected, !hostId.isEmpty else {
            lastError = "Not connected to a host."
            return nil
        }
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return FilesSearchResult(matches: [], truncated: false) }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "files.search",
                args: ["query": .string(trimmed)], sessionId: sessionId))
            return Self.decodeFilesSearchResult(result)
        } catch {
            t4log.error("files.search failed: \(error)")
            lastError = "This host has no files bridge (desktop hosts only)."
            return nil
        }
    }

    func filesDiff(sessionId: String, turnId: String? = nil) async -> FilesDiffResult? {
        guard let client, connected, !hostId.isEmpty else {
            lastError = "Not connected to a host."
            return nil
        }
        var args: [String: JSONValue] = [:]
        if let turnId, !turnId.isEmpty { args["turnId"] = .string(turnId) }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId, command: "files.diff", args: args, sessionId: sessionId))
            guard result.ok, let body = result.result, case .object(let o) = body else {
                lastError = "files.diff returned no result."
                return nil
            }
            if case .string(let diff) = o["diff"] ?? .null {
                return FilesDiffResult(patchText: diff, changes: [])
            }
            let changes = Self.parseTurnChanges(o["changes"] ?? .null)
            var patchText: String?
            if case .object(let pd) = o["patch"] ?? .null,
               case .string(let artifactId) = pd["artifactId"] ?? .null {
                if let chunk = await artifactRead(sessionId: sessionId, artifactId: artifactId),
                   let data = chunk.decodedBytes {
                    patchText = String(data: data, encoding: .utf8)
                }
            }
            return FilesDiffResult(patchText: patchText, changes: changes)
        } catch {
            t4log.error("files.diff failed: \(error)")
            lastError = "This host has no files bridge (desktop hosts only)."
            return nil
        }
    }

    private static func decodeFilesSearchResult(_ result: ResultFrame) -> FilesSearchResult? {
        guard result.ok, let body = result.result, case .object(let o) = body else { return nil }
        let truncated = (o["truncated"] ?? .null) == .bool(true)
        let matches: [FilesSearchMatch] = {
            guard case .array(let arr) = o["matches"] ?? .null else { return [] }
            return arr.compactMap { value in
                guard case .object(let match) = value,
                      case .string(let path) = match["path"] ?? .null else { return nil }
                return FilesSearchMatch(path: path)
            }
        }()
        return FilesSearchResult(matches: matches, truncated: truncated)
    }

    private static func parseTurnChanges(_ value: JSONValue) -> [TurnFileChange] {
        guard case .array(let changes) = value else { return [] }
        return changes.compactMap { value in
            guard case .object(let change) = value,
                  case .string(let path) = change["path"] ?? .null,
                  case .string(let status) = change["status"] ?? .null,
                  case .string(let kind) = change["kind"] ?? .null else { return nil }
            return TurnFileChange(
                path: path,
                status: status,
                kind: kind,
                additions: intField(change["additions"]),
                deletions: intField(change["deletions"])
            )
        }
    }

    private static func intField(_ value: JSONValue?) -> Int {
        if case .number(let number) = value, number.isFinite, number >= 0 {
            return Int(number)
        }
        return 0
    }
}
