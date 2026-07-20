import Darwin
import Foundation
import XCTest
@testable import t4code

private final class StubRuntimeRunner: RuntimeProcessRunning {
  struct Invocation {
    let executable: String
    let arguments: [String]
    let environment: [String: String]
  }

  var probeOutput: String
  var probeExitCode: Int32
  var bridgeOutput = "Expose the private OMP authority bridge used by T4 Code\n--stdio\n"
  var registered = false
  var invocations: [Invocation] = []

  init(probeOutput: String, probeExitCode: Int32 = 0) {
    self.probeOutput = probeOutput
    self.probeExitCode = probeExitCode
  }

  func run(
    executableURL: URL,
    arguments: [String],
    environment: [String: String],
    timeout: TimeInterval,
    maxOutputBytes: Int
  ) throws -> RuntimeProcessResult {
    invocations.append(Invocation(
      executable: executableURL.path,
      arguments: arguments,
      environment: environment
    ))
    if executableURL.path != "/bin/launchctl" {
      if arguments == ["bridge", "--help"] {
        return RuntimeProcessResult(
          exitCode: 0,
          output: bridgeOutput,
          timedOut: false,
          overflowed: false
        )
      }
      return RuntimeProcessResult(
        exitCode: probeExitCode,
        output: probeOutput,
        timedOut: false,
        overflowed: false
      )
    }
    switch arguments.first {
    case "print":
      return RuntimeProcessResult(
        exitCode: registered ? 0 : 113,
        output: registered ? "state = running" : "Could not find service",
        timedOut: false,
        overflowed: false
      )
    case "bootstrap":
      registered = true
    case "bootout":
      registered = false
    case "kickstart":
      registered = true
    default:
      XCTFail("unexpected launchctl command: \(arguments)")
    }
    return RuntimeProcessResult(exitCode: 0, output: "", timedOut: false, overflowed: false)
  }
}

private struct StubManifestFetcher: UpdateManifestFetching {
  let data: Data
  func fetch() throws -> Data { data }
}

final class RunnerTests: XCTestCase {
  private var temporaryDirectories: [URL] = []

  override func tearDownWithError() throws {
    for directory in temporaryDirectories {
      try? FileManager.default.removeItem(at: directory)
    }
    temporaryDirectories.removeAll()
  }

  func testDiscoveryAcceptsExactRunningStatusWithCredentialFreeEnvironment() throws {
    let home = try temporaryDirectory()
    let executable = try makeExecutable(home: home)
    let runner = StubRuntimeRunner(
      probeOutput: #"{"state":"running","health":{"ok":true,"hostId":"host-a","epoch":"epoch-a"}}"#
    )
    let discovery = OmpRuntimeDiscovery(
      environment: [
        "HOME": home.path,
        "PATH": "\(home.path)/bin",
        "TMPDIR": home.path,
        "OMP_EXECUTABLE": executable,
        "OPENAI_API_KEY": "must-not-leak",
      ],
      homeDirectory: home.path,
      runner: runner
    ).discover()

    XCTAssertEqual(discovery, .found(executable))
    XCTAssertEqual(runner.invocations.count, 2)
    XCTAssertEqual(
      Set(runner.invocations[0].environment.keys),
      Set(["HOME", "PATH", "TMPDIR", "OMP_PROFILE"])
    )
    XCTAssertEqual(runner.invocations[0].environment["OMP_PROFILE"], "default")
    XCTAssertNil(runner.invocations[0].environment["OPENAI_API_KEY"])
    XCTAssertEqual(runner.invocations[0].arguments, ["bridge", "--help"])
    XCTAssertEqual(runner.invocations[1].arguments, ["appserver", "status", "--json"])
  }

  func testDiscoveryAcceptsExactStoppedStatus() throws {
    let home = try temporaryDirectory()
    let executable = try makeExecutable(home: home)
    let runner = StubRuntimeRunner(
      probeOutput: #"{"state":"stopped","reason":"unreachable"}"#,
      probeExitCode: 1
    )
    let result = OmpRuntimeDiscovery(
      environment: ["OMP_EXECUTABLE": executable],
      homeDirectory: home.path,
      runner: runner
    ).discover()
    XCTAssertEqual(result, .found(executable))
  }

  func testDiscoveryReportsUnsupportedJSONDistinctly() throws {
    let home = try temporaryDirectory()
    let executable = try makeExecutable(home: home)
    let runner = StubRuntimeRunner(probeOutput: "unknown flag: --json", probeExitCode: 2)
    let result = OmpRuntimeDiscovery(
      environment: ["OMP_EXECUTABLE": executable],
      homeDirectory: home.path,
      runner: runner
    ).discover()
    XCTAssertEqual(result, .incompatible)
  }

  func testDiscoveryRejectsMalformedAndMissingCandidates() throws {
    let home = try temporaryDirectory()
    let executable = try makeExecutable(home: home)
    let runner = StubRuntimeRunner(probeOutput: #"{"state":"stopped","reason":"other"}"#)
    let malformed = OmpRuntimeDiscovery(
      environment: ["OMP_EXECUTABLE": executable],
      homeDirectory: home.path,
      runner: runner
    ).discover()
    XCTAssertEqual(malformed, .missing)

    let missing = OmpRuntimeDiscovery(
      environment: ["OMP_EXECUTABLE": "\(home.path)/missing/omp", "PATH": ""],
      homeDirectory: home.path,
      runner: runner
    ).discover()
    XCTAssertEqual(missing, .missing)
  }

  func testT4HostDiscoveryRequiresAnExecutableWithTheExactName() throws {
    let home = try temporaryDirectory()
    let hostExecutable = try makeExecutable(home: home, name: "t4-host")
    XCTAssertEqual(
      T4HostRuntimeDiscovery(
        environment: ["T4_HOST_EXECUTABLE": hostExecutable, "PATH": ""],
        homeDirectory: home.path,
        packagedExecutable: nil
      ).discover(),
      hostExecutable
    )

    let wrongHome = try temporaryDirectory()
    let wrongExecutable = try makeExecutable(home: wrongHome, name: "not-t4-host")
    XCTAssertNil(
      T4HostRuntimeDiscovery(
        environment: ["T4_HOST_EXECUTABLE": wrongExecutable, "PATH": ""],
        homeDirectory: wrongHome.path,
        packagedExecutable: nil
      ).discover()
    )
  }

  func testLaunchAgentInstallInspectAndUninstallLifecycle() throws {
    let home = try temporaryDirectory()
    let executable = try makeExecutable(home: home)
    let hostExecutable = try makeExecutable(home: home, name: "t4-host")
    let runner = StubRuntimeRunner(probeOutput: #"{"state":"stopped","reason":"unreachable"}"#)
    let files = SecureRuntimeFileStore()
    let lifecycle = MacRuntimeLifecycle(
      environment: [
        "HOME": home.path,
        "OMP_EXECUTABLE": executable,
        "T4_HOST_EXECUTABLE": hostExecutable,
      ],
      homeDirectory: home.path,
      uid: 501,
      runner: runner,
      files: files
    )

    let installed = try lifecycle.install()
    XCTAssertEqual(installed["definition"] as? String, "current")
    XCTAssertEqual(installed["service"] as? String, "running")
    let definitionPath = "\(home.path)/Library/LaunchAgents/dev.oh-my-pi.appserver.plist"
    let snapshot = try files.read(definitionPath, maxBytes: 64 * 1024)
    XCTAssertEqual(snapshot.mode, 0o600)
    XCTAssertTrue(snapshot.content?.contains("<string>\(hostExecutable)</string>") == true)
    XCTAssertTrue(snapshot.content?.contains("<string>\(executable)</string>") == true)
    XCTAssertTrue(snapshot.content?.contains("<string>serve</string>") == true)
    XCTAssertTrue(snapshot.content?.contains("<string>--omp</string>") == true)
    XCTAssertTrue(snapshot.content?.contains("<string>--profile</string>") == true)
    XCTAssertTrue(snapshot.content?.contains("<key>OMP_PROFILE</key>") == true)
    XCTAssertTrue(snapshot.content?.contains("<string>default</string>") == true)
    XCTAssertTrue(snapshot.content?.contains("Library/Logs/T4 Code/appserver/appserver.log") == true)
    XCTAssertFalse(snapshot.content?.contains("must-not-leak") == true)
    XCTAssertTrue(runner.invocations.contains(where: {
      $0.executable == "/bin/launchctl"
        && $0.arguments == ["bootstrap", "gui/501", definitionPath]
    }))
    XCTAssertTrue(runner.invocations.contains(where: {
      $0.executable == "/bin/launchctl"
        && $0.arguments == ["kickstart", "-k", "gui/501/dev.oh-my-pi.appserver"]
    }))

    let uninstalled = try lifecycle.uninstall()
    XCTAssertEqual(uninstalled["definition"] as? String, "missing")
    XCTAssertEqual(uninstalled["service"] as? String, "stopped")
    XCTAssertNil(try files.read(definitionPath, maxBytes: 1024).content)
  }

  func testSecureStoreRefusesSymlinkDefinition() throws {
    let home = try temporaryDirectory()
    let launchAgents = home.appendingPathComponent("Library/LaunchAgents", isDirectory: true)
    try FileManager.default.createDirectory(at: launchAgents, withIntermediateDirectories: true)
    let target = home.appendingPathComponent("elsewhere.plist")
    try Data("safe".utf8).write(to: target)
    let definition = launchAgents.appendingPathComponent("dev.oh-my-pi.appserver.plist")
    try FileManager.default.createSymbolicLink(at: definition, withDestinationURL: target)

    XCTAssertThrowsError(try SecureRuntimeFileStore().read(definition.path, maxBytes: 1024))
    XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "safe")
  }

  func testMacUpdateCheckSelectsCanonicalDMGAndOnlyOpensValidatedURL() throws {
    let manifest = try releaseManifest(version: "0.1.25")
    var opened: URL?
    let updates = MacUpdateLifecycle(
      currentVersion: "0.1.24",
      fetcher: StubManifestFetcher(data: manifest),
      openURL: { url in opened = url; return true }
    )

    let checked = updates.check()
    XCTAssertEqual(checked["phase"] as? String, "manual")
    XCTAssertEqual(checked["latestVersion"] as? String, "0.1.25")
    XCTAssertNil(checked["revision"])
    let downloaded = updates.download()
    XCTAssertEqual(downloaded["phase"] as? String, "manual")
    XCTAssertEqual(
      opened?.absoluteString,
      "https://github.com/LycaonLLC/t4-code/releases/download/v0.1.25/T4-Code-0.1.25-mac-arm64.dmg"
    )
    let installed = updates.install()
    XCTAssertEqual(installed["phase"] as? String, "manual")
    XCTAssertTrue((installed["message"] as? String)?.contains("signed DMG") == true)
  }

  func testMacUpdateRejectsNonCanonicalReleaseURL() throws {
    var object = try XCTUnwrap(
      JSONSerialization.jsonObject(with: releaseManifest(version: "0.1.25")) as? [String: Any]
    )
    var assets = try XCTUnwrap(object["assets"] as? [[String: Any]])
    assets[3]["url"] = "https://evil.example/T4-Code-0.1.25-mac-arm64.dmg"
    object["assets"] = assets
    let updates = MacUpdateLifecycle(
      currentVersion: "0.1.24",
      fetcher: StubManifestFetcher(data: try JSONSerialization.data(withJSONObject: object)),
      openURL: { _ in XCTFail("invalid URL must not open"); return true }
    )
    let result = updates.check()
    XCTAssertEqual(result["phase"] as? String, "error")
    XCTAssertEqual(result["error"] as? String, "update_manifest_invalid")
  }

  private func temporaryDirectory() throws -> URL {
    let base = FileManager.default.homeDirectoryForCurrentUser
    let directory = base.appendingPathComponent(".t4-macos-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    temporaryDirectories.append(directory)
    return directory
  }

  private func makeExecutable(home: URL, name: String = "omp") throws -> String {
    let directory = home.appendingPathComponent("bin", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let executable = directory.appendingPathComponent(name)
    XCTAssertTrue(FileManager.default.createFile(atPath: executable.path, contents: Data()))
    XCTAssertEqual(chmod(executable.path, 0o700), 0)
    return executable.path
  }

  private func releaseManifest(version: String) throws -> Data {
    func asset(_ platform: String, _ kind: String, _ arch: String, _ name: String) -> [String: Any] {
      [
        "platform": platform,
        "kind": kind,
        "arch": arch,
        "name": name,
        "url": "https://github.com/LycaonLLC/t4-code/releases/download/v\(version)/\(name)",
        "size": 1024,
        "sha256": String(repeating: "a", count: 64),
      ]
    }
    return try JSONSerialization.data(withJSONObject: [
      "schemaVersion": 1,
      "channel": "stable",
      "version": version,
      "tag": "v\(version)",
      "publishedAt": "2026-07-19T12:00:00.000Z",
      "releaseUrl": "https://github.com/LycaonLLC/t4-code/releases/tag/v\(version)",
      "assets": [
        asset("android", "apk", "universal", "T4-Code-\(version)-android.apk"),
        asset("linux", "deb", "x86_64", "T4-Code-\(version)-linux-amd64.deb"),
        asset("linux", "appimage", "x86_64", "T4-Code-\(version)-linux-x86_64.AppImage"),
        asset("mac", "dmg", "arm64", "T4-Code-\(version)-mac-arm64.dmg"),
        asset("mac", "zip", "arm64", "T4-Code-\(version)-mac-arm64.zip"),
      ],
    ])
  }
}
