//  TestSupport.swift
//  Shared helpers for the Linux client's test suite: spawn the workspace
//  fixture server on an ephemeral port and wait for its URL line.

import Foundation
import Testing

/// A running fixture server process (workspace fixture-server, bun-driven).
/// stdout is captured to a temp file rather than a Pipe because
/// swift-corelibs' Pipe readabilityHandler doesn't fire reliably on Linux.
final class FixtureServer {
    let process: Process
    private let outFile: URL
    private let outHandle: FileHandle
    private(set) var url: URL

    /// Start the fixture server for `scenario` on an ephemeral port.
    /// Requires `bun` on PATH and the repo at the path passed in.
    static func spawn(scenario: String, repoPath: String) async throws -> FixtureServer {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["bun", "\(repoPath)/scripts/run-fixture-host.mts", "0", scenario]

        let outFile = FileManager.default.temporaryDirectory
            .appendingPathComponent("t4-fixture-\(UUID().uuidString).log")
        FileManager.default.createFile(atPath: outFile.path, contents: nil)
        let outHandle = try FileHandle(forWritingTo: outFile)
        process.standardOutput = outHandle
        process.standardError = outHandle
        try process.run()

        let server = FixtureServer(process: process, url: URL(string: "ws://127.0.0.1:0")!, outFile: outFile, outHandle: outHandle)
        let url = try await server.waitForURL(timeout: 20)
        server.url = url
        return server
    }

    private init(process: Process, url: URL, outFile: URL, outHandle: FileHandle) {
        self.process = process
        self.url = url
        self.outFile = outFile
        self.outHandle = outHandle
    }

    private func waitForURL(timeout: TimeInterval) async throws -> URL {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let data = (try? Data(contentsOf: outFile)) ?? Data()
            let text = String(decoding: data, as: UTF8.self)
            // "fixture host listening: ws://127.0.0.1:PORT/fixture (scenario=...)"
            if let range = text.range(of: "fixture host listening: "),
               let end = text[range.upperBound...].firstIndex(of: " ") {
                let candidate = String(text[range.upperBound..<end])
                if let url = URL(string: candidate) {
                    return url
                }
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        let tail = String(decoding: (try? Data(contentsOf: outFile)) ?? Data(), as: UTF8.self)
        throw TestError.fixtureDidNotStart(tail)
    }

    func stop() {
        if process.isRunning { process.terminate() }
        try? outHandle.close()
        try? FileManager.default.removeItem(at: outFile)
    }

    deinit {
        if process.isRunning { process.terminate() }
        try? outHandle.close()
    }
}

enum TestError: Error {
    case fixtureDidNotStart(String)
    case timeout(String)
}

/// Repo root, derived from this file's path: apps/linux/Tests/T4CodeLinuxTests.
/// dropLast(5): TestSupport.swift, T4CodeLinuxTests, Tests, linux, apps.
let t4RepoRoot: String = {
    var path = #filePath
    for _ in 0..<5 { path = (path as NSString).deletingLastPathComponent }
    return path
}()

/// Await an async condition with a timeout, polling every 50ms.
@MainActor
func waitUntil(
    _ description: String,
    timeout: TimeInterval = 10,
    condition: @MainActor () -> Bool
) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return }
        try await Task.sleep(for: .milliseconds(50))
    }
    throw TestError.timeout(description)
}
