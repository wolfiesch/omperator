import Foundation

final class WindowsFixtureServer {
    let process: Process
    private let outputFile: URL
    private let outputHandle: FileHandle
    private let inputHandle: FileHandle
    private(set) var url: URL

    static func spawn(
        scenario: String,
        repoPath: String = windowsFixtureRepoRoot
    ) async throws -> WindowsFixtureServer {
        let process = Process()
        process.executableURL = try bunExecutable()
        process.arguments = [
            URL(fileURLWithPath: repoPath)
                .appendingPathComponent("scripts/run-fixture-host.mts")
                .path,
            "0",
            scenario,
        ]
        process.currentDirectoryURL = URL(fileURLWithPath: repoPath)
        let inputPipe = Pipe()
        process.standardInput = inputPipe

        let outputFile = FileManager.default.temporaryDirectory
            .appendingPathComponent("t4-windows-fixture-\(UUID().uuidString).log")
        _ = FileManager.default.createFile(atPath: outputFile.path, contents: nil)
        let outputHandle = try FileHandle(forWritingTo: outputFile)
        process.standardOutput = outputHandle
        process.standardError = outputHandle
        try process.run()

        let server = WindowsFixtureServer(
            process: process,
            url: URL(string: "ws://127.0.0.1:0")!,
            outputFile: outputFile,
            outputHandle: outputHandle,
            inputHandle: inputPipe.fileHandleForWriting,
        )
        do {
            server.url = try await server.waitForURL(timeout: 20)
            return server
        } catch {
            server.stop()
            throw error
        }
    }

    private static func bunExecutable() throws -> URL {
        let environment = ProcessInfo.processInfo.environment
        if let override = environment["BUN_EXE"],
           FileManager.default.fileExists(atPath: override) {
            return URL(fileURLWithPath: override)
        }

        let pathEntries = (environment["PATH"] ?? "")
            .split(separator: ";", omittingEmptySubsequences: true)
            .map {
                String($0).trimmingCharacters(in: CharacterSet(charactersIn: " \t\""))
            }
        for directory in pathEntries {
            let root = URL(fileURLWithPath: directory, isDirectory: true)
            let candidates = [
                root.appendingPathComponent("bun.exe"),
                root.appendingPathComponent("node_modules/bun/bin/bun.exe"),
            ]
            if let executable = candidates.first(where: {
                FileManager.default.fileExists(atPath: $0.path)
            }) {
                return executable
            }
        }
        throw WindowsFixtureProbeError.bunNotFound
    }

    private init(
        process: Process,
        url: URL,
        outputFile: URL,
        outputHandle: FileHandle,
        inputHandle: FileHandle
    ) {
        self.process = process
        self.url = url
        self.outputFile = outputFile
        self.outputHandle = outputHandle
        self.inputHandle = inputHandle
    }

    private func waitForURL(timeout: TimeInterval) async throws -> URL {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let data = (try? Data(contentsOf: outputFile)) ?? Data()
            let text = String(decoding: data, as: UTF8.self)
            if let range = text.range(of: "fixture host listening: ") {
                let suffix = text[range.upperBound...]
                let candidate = String(suffix.prefix { !$0.isWhitespace })
                if let url = URL(string: candidate) {
                    return url
                }
            }
            if !process.isRunning {
                throw WindowsFixtureProbeError.fixtureExited(
                    process.terminationStatus,
                    text
                )
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        let output = String(
            decoding: (try? Data(contentsOf: outputFile)) ?? Data(),
            as: UTF8.self
        )
        throw WindowsFixtureProbeError.fixtureDidNotStart(output)
    }

    func dropConnections() async throws {
        let requestId = try sendControl("drop")
        _ = try await waitForControlLine(
            containing: "fixture control: dropped \(requestId)",
            timeout: 5
        )
    }

    func waitForConnectionCount(
        atLeast expected: Int,
        timeout: TimeInterval = 15
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if try await connectionCount() >= expected {
                return
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        throw WindowsFixtureProbeError.timeout(
            "fixture connection count to reach \(expected)"
        )
    }

    private func connectionCount() async throws -> Int {
        let requestId = try sendControl("status")
        let line = try await waitForControlLine(
            containing: "fixture control: status \(requestId) ",
            timeout: 5
        )
        guard let field = line
            .split(whereSeparator: \.isWhitespace)
            .first(where: { $0.hasPrefix("connections=") }),
              let count = Int(field.dropFirst("connections=".count))
        else {
            throw WindowsFixtureProbeError.invalidControlResponse(line)
        }
        return count
    }

    private func sendControl(_ command: String) throws -> String {
        let requestId = UUID().uuidString
        try inputHandle.write(
            contentsOf: Data("\(command) \(requestId)\n".utf8)
        )
        return requestId
    }

    private func waitForControlLine(
        containing marker: String,
        timeout: TimeInterval
    ) async throws -> String {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let data = (try? Data(contentsOf: outputFile)) ?? Data()
            let text = String(decoding: data, as: UTF8.self)
            if let line = text
                .split(whereSeparator: \.isNewline)
                .first(where: { $0.contains(marker) }) {
                return String(line)
            }
            if !process.isRunning {
                throw WindowsFixtureProbeError.fixtureExited(
                    process.terminationStatus,
                    text
                )
            }
            try await Task.sleep(for: .milliseconds(25))
        }
        throw WindowsFixtureProbeError.timeout(marker)
    }

    func stop() {
        if process.isRunning {
            process.terminate()
            process.waitUntilExit()
        }
        try? outputHandle.close()
        try? inputHandle.close()
        try? FileManager.default.removeItem(at: outputFile)
    }

    deinit {
        stop()
    }
}

enum WindowsFixtureProbeError: Error, CustomStringConvertible {
    case bunNotFound
    case fixtureExited(Int32, String)
    case fixtureDidNotStart(String)
    case timeout(String)
    case invalidControlResponse(String)

    var description: String {
        switch self {
        case .bunNotFound:
            return "bun.exe was not found on PATH; set BUN_EXE to its absolute path"
        case .fixtureExited(let status, let output):
            return "fixture server exited with status \(status): \(output)"
        case .fixtureDidNotStart(let output):
            return "fixture server did not report its URL: \(output)"
        case .timeout(let operation):
            return "timed out waiting for \(operation)"
        case .invalidControlResponse(let response):
            return "fixture server returned an invalid control response: \(response)"
        }
    }
}

let windowsFixtureRepoRoot: String = {
    var path = #filePath
    for _ in 0..<5 {
        path = (path as NSString).deletingLastPathComponent
    }
    return path
}()

func waitForWindowsFixture(
    _ operation: String,
    timeout: TimeInterval = 10,
    condition: @Sendable () async -> Bool
) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() {
            return
        }
        try await Task.sleep(for: .milliseconds(50))
    }
    throw WindowsFixtureProbeError.timeout(operation)
}
