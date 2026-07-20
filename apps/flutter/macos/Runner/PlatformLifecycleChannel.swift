import CoreFoundation
import Darwin
import FlutterMacOS
import Foundation

private let runtimeOutputLimit = 16 * 1024
private let runtimeProbeTimeout: TimeInterval = 1.5
private let runtimeCommandTimeout: TimeInterval = 8
private let runtimeLabel = "dev.oh-my-pi.appserver"
private let authorityBridgeHelpMarkers = [
  "Expose the private OMP authority bridge used by T4 Code",
  "--stdio",
]

struct RuntimeProcessResult {
  let exitCode: Int32?
  let output: String
  let timedOut: Bool
  let overflowed: Bool
}

protocol RuntimeProcessRunning {
  func run(
    executableURL: URL,
    arguments: [String],
    environment: [String: String],
    timeout: TimeInterval,
    maxOutputBytes: Int
  ) throws -> RuntimeProcessResult
}

final class BoundedRuntimeProcessRunner: RuntimeProcessRunning {
  func run(
    executableURL: URL,
    arguments: [String],
    environment: [String: String],
    timeout: TimeInterval,
    maxOutputBytes: Int
  ) throws -> RuntimeProcessResult {
    let process = Process()
    process.executableURL = executableURL
    process.arguments = arguments
    process.environment = environment

    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe

    let lock = NSLock()
    var output = Data()
    var overflowed = false
    pipe.fileHandleForReading.readabilityHandler = { handle in
      let data = handle.availableData
      guard !data.isEmpty else { return }
      lock.lock()
      if output.count < maxOutputBytes + 1 {
        output.append(data.prefix(maxOutputBytes + 1 - output.count))
      }
      if output.count > maxOutputBytes {
        overflowed = true
      }
      lock.unlock()
      if overflowed, process.isRunning {
        process.terminate()
      }
    }

    let terminated = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in terminated.signal() }
    do {
      try process.run()
    } catch {
      pipe.fileHandleForReading.readabilityHandler = nil
      throw error
    }

    var timedOut = false
    if terminated.wait(timeout: .now() + timeout) == .timedOut {
      timedOut = true
      if process.isRunning { process.terminate() }
      if terminated.wait(timeout: .now() + 0.2) == .timedOut, process.isRunning {
        kill(process.processIdentifier, SIGKILL)
        _ = terminated.wait(timeout: .now() + 0.2)
      }
    }

    pipe.fileHandleForReading.readabilityHandler = nil
    let tail = pipe.fileHandleForReading.readDataToEndOfFile()
    lock.lock()
    if output.count < maxOutputBytes + 1 {
      output.append(tail.prefix(maxOutputBytes + 1 - output.count))
    }
    overflowed = overflowed || output.count > maxOutputBytes
    let bounded = output.prefix(maxOutputBytes)
    lock.unlock()

    return RuntimeProcessResult(
      exitCode: process.isRunning ? nil : process.terminationStatus,
      output: String(decoding: bounded, as: UTF8.self),
      timedOut: timedOut,
      overflowed: overflowed
    )
  }
}

enum RuntimeDiscovery: Equatable {
  case found(String)
  case incompatible
  case missing
}

final class OmpRuntimeDiscovery {
  private let environment: [String: String]
  private let homeDirectory: String
  private let runner: RuntimeProcessRunning

  init(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    homeDirectory: String = FileManager.default.homeDirectoryForCurrentUser.path,
    runner: RuntimeProcessRunning = BoundedRuntimeProcessRunner()
  ) {
    self.environment = environment
    self.homeDirectory = homeDirectory
    self.runner = runner
  }

  func discover() -> RuntimeDiscovery {
    var candidates: [String] = []
    if let explicit = environment["OMP_EXECUTABLE"], !explicit.isEmpty {
      candidates.append(explicit)
    }
    let pathEntries = (environment["PATH"] ?? "")
      .split(separator: ":", omittingEmptySubsequences: true)
      .prefix(64)
    candidates.append(contentsOf: pathEntries.map { "\($0)/omp" })
    candidates.append(contentsOf: [
      "\(homeDirectory)/.local/bin/omp",
      "\(homeDirectory)/bin/omp",
      "/usr/local/bin/omp",
      "/usr/bin/omp",
      "/opt/omp/bin/omp",
    ])

    var seen = Set<String>()
    var foundIncompatible = false
    for candidate in candidates {
      guard isExecutableCandidate(candidate), seen.insert(candidate).inserted else { continue }
      switch probe(candidate) {
      case .running, .stopped:
        return .found(candidate)
      case .incompatible:
        foundIncompatible = true
      case .invalid:
        continue
      }
    }
    return foundIncompatible ? .incompatible : .missing
  }

  private func isExecutableCandidate(_ path: String) -> Bool {
    guard path.utf8.count <= 4096,
      path.first == "/",
      !path.utf8.contains(0),
      URL(fileURLWithPath: path).lastPathComponent == "omp"
    else { return false }
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: path),
      attributes[.type] as? FileAttributeType == .typeRegular
    else { return false }
    return Darwin.access(path, X_OK) == 0
  }

  private enum ProbeResult { case running, stopped, incompatible, invalid }

  private func probe(_ executable: String) -> ProbeResult {
    var safeEnvironment: [String: String] = [:]
    for key in ["HOME", "PATH", "TMPDIR"] {
      if let value = environment[key] { safeEnvironment[key] = value }
    }
    safeEnvironment["OMP_PROFILE"] = "default"

    guard
      let bridge = try? runner.run(
        executableURL: URL(fileURLWithPath: executable),
        arguments: ["bridge", "--help"],
        environment: safeEnvironment,
        timeout: runtimeProbeTimeout,
        maxOutputBytes: runtimeOutputLimit
      ), bridge.exitCode == 0, !bridge.timedOut, !bridge.overflowed,
      authorityBridgeHelpMarkers.allSatisfy({ bridge.output.contains($0) }),
      let result = try? runner.run(
        executableURL: URL(fileURLWithPath: executable),
        arguments: ["appserver", "status", "--json"],
        environment: safeEnvironment,
        timeout: runtimeProbeTimeout,
        maxOutputBytes: runtimeOutputLimit
      ), !result.timedOut, !result.overflowed
    else { return .invalid }

    if isUnsupportedJSONDiagnostic(result.output) { return .incompatible }
    guard result.exitCode == 0 || result.exitCode == 1,
      let data = result.output.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data),
      let status = object as? [String: Any],
      let state = status["state"] as? String
    else { return .invalid }

    if state == "running",
      let health = status["health"] as? [String: Any],
      health["ok"] as? Bool == true,
      let hostID = health["hostId"] as? String, !hostID.isEmpty,
      let epoch = health["epoch"] as? String, !epoch.isEmpty
    {
      return .running
    }
    if state == "stopped",
      let reason = status["reason"] as? String,
      ["unreachable", "malformed", "failed"].contains(reason)
    {
      return .stopped
    }
    return .invalid
  }

  private func isUnsupportedJSONDiagnostic(_ output: String) -> Bool {
    let value = output.lowercased()
    guard value.contains("--json") || value.contains("-json") else { return false }
    return value.contains("unknown flag")
      || value.contains("unknown option")
      || value.contains("unrecognized flag")
      || value.contains("unrecognized option")
      || value.contains("flag provided but not defined")
  }
}

final class T4HostRuntimeDiscovery {
  private let environment: [String: String]
  private let homeDirectory: String
  private let packagedExecutable: String?

  init(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    homeDirectory: String = FileManager.default.homeDirectoryForCurrentUser.path,
    packagedExecutable: String? = Bundle.main.resourceURL?
      .appendingPathComponent("runtime/t4-host").path
  ) {
    self.environment = environment
    self.homeDirectory = homeDirectory
    self.packagedExecutable = packagedExecutable
  }

  func discover() -> String? {
    var candidates: [String] = []
    if let explicit = environment["T4_HOST_EXECUTABLE"], !explicit.isEmpty {
      candidates.append(explicit)
    }
    if let packagedExecutable, !packagedExecutable.isEmpty {
      candidates.append(packagedExecutable)
    }
    let pathEntries = (environment["PATH"] ?? "")
      .split(separator: ":", omittingEmptySubsequences: true)
      .prefix(64)
    candidates.append(contentsOf: pathEntries.map { "\($0)/t4-host" })
    candidates.append(contentsOf: [
      "\(homeDirectory)/.local/bin/t4-host",
      "\(homeDirectory)/bin/t4-host",
      "/usr/local/bin/t4-host",
      "/usr/bin/t4-host",
    ])

    var seen = Set<String>()
    for candidate in candidates where seen.insert(candidate).inserted {
      guard candidate.utf8.count <= 4096,
        candidate.first == "/",
        !candidate.utf8.contains(0),
        URL(fileURLWithPath: candidate).lastPathComponent == "t4-host",
        let attributes = try? FileManager.default.attributesOfItem(atPath: candidate),
        attributes[.type] as? FileAttributeType == .typeRegular,
        Darwin.access(candidate, X_OK) == 0
      else { continue }
      return candidate
    }
    return nil
  }
}

enum SecureRuntimeFileError: Error {
  case invalidPath, notFound, unsafePath
  case io(String)
}

struct RuntimeFileSnapshot {
  let content: String?
  let mode: mode_t
}

protocol RuntimeFileStoring {
  func read(_ path: String, maxBytes: Int) throws -> RuntimeFileSnapshot
  func ensureDirectory(_ path: String) throws
  func writeAtomically(_ path: String, content: String, mode: mode_t) throws
  func remove(_ path: String) throws
}

final class SecureRuntimeFileStore: RuntimeFileStoring {
  private func components(_ absolutePath: String) throws -> [String] {
    guard absolutePath.first == "/", !absolutePath.utf8.contains(0), absolutePath.utf8.count <= 4096
    else {
      throw SecureRuntimeFileError.invalidPath
    }
    let parts = absolutePath.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
    guard !parts.isEmpty, !parts.contains("."), !parts.contains("..") else {
      throw SecureRuntimeFileError.invalidPath
    }
    return parts
  }

  private func directoryDescriptor(_ parts: ArraySlice<String>, create: Bool) throws -> Int32 {
    var descriptor = Darwin.open("/", O_RDONLY | O_DIRECTORY)
    guard descriptor >= 0 else { throw SecureRuntimeFileError.io("open root") }
    do {
      for component in parts {
        if create, mkdirat(descriptor, component, 0o700) != 0, errno != EEXIST {
          throw SecureRuntimeFileError.io("create directory")
        }
        let next = openat(descriptor, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        if next < 0 {
          if errno == ENOENT { throw SecureRuntimeFileError.notFound }
          if errno == ELOOP || errno == ENOTDIR { throw SecureRuntimeFileError.unsafePath }
          throw SecureRuntimeFileError.io("open directory")
        }
        Darwin.close(descriptor)
        descriptor = next
      }
      return descriptor
    } catch {
      Darwin.close(descriptor)
      throw error
    }
  }

  func ensureDirectory(_ path: String) throws {
    let parts = try components(path)
    let descriptor = try directoryDescriptor(parts[...], create: true)
    Darwin.close(descriptor)
  }

  func read(_ path: String, maxBytes: Int = 64 * 1024) throws -> RuntimeFileSnapshot {
    let parts = try components(path)
    guard let name = parts.last else { throw SecureRuntimeFileError.invalidPath }
    let descriptor: Int32
    do {
      descriptor = try directoryDescriptor(parts.dropLast(), create: false)
    } catch SecureRuntimeFileError.notFound {
      return RuntimeFileSnapshot(content: nil, mode: 0o600)
    }
    defer { Darwin.close(descriptor) }

    let file = openat(descriptor, name, O_RDONLY | O_NOFOLLOW)
    if file < 0 {
      if errno == ENOENT { return RuntimeFileSnapshot(content: nil, mode: 0o600) }
      if errno == ELOOP { throw SecureRuntimeFileError.unsafePath }
      throw SecureRuntimeFileError.io("read definition")
    }
    defer { Darwin.close(file) }
    var info = stat()
    guard fstat(file, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else {
      throw SecureRuntimeFileError.unsafePath
    }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while data.count <= maxBytes {
      let count = Darwin.read(file, &buffer, min(buffer.count, maxBytes + 1 - data.count))
      if count < 0 { throw SecureRuntimeFileError.io("read definition") }
      if count == 0 { break }
      data.append(buffer, count: count)
    }
    guard data.count <= maxBytes else { throw SecureRuntimeFileError.io("definition too large") }
    return RuntimeFileSnapshot(
      content: String(decoding: data, as: UTF8.self),
      mode: info.st_mode & 0o777
    )
  }

  func writeAtomically(_ path: String, content: String, mode: mode_t) throws {
    let parts = try components(path)
    guard let name = parts.last, let data = content.data(using: .utf8) else {
      throw SecureRuntimeFileError.invalidPath
    }
    let descriptor = try directoryDescriptor(parts.dropLast(), create: true)
    defer { Darwin.close(descriptor) }

    let temporary = ".\(name).tmp-\(UUID().uuidString)"
    let file = openat(descriptor, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode)
    guard file >= 0 else { throw SecureRuntimeFileError.io("create temporary definition") }
    var shouldRemoveTemporary = true
    defer {
      Darwin.close(file)
      if shouldRemoveTemporary { unlinkat(descriptor, temporary, 0) }
    }
    try data.withUnsafeBytes { rawBuffer in
      guard var pointer = rawBuffer.baseAddress else { return }
      var remaining = rawBuffer.count
      while remaining > 0 {
        let count = Darwin.write(file, pointer, remaining)
        if count <= 0 { throw SecureRuntimeFileError.io("write definition") }
        remaining -= count
        pointer = pointer.advanced(by: count)
      }
    }
    guard fchmod(file, mode) == 0, fsync(file) == 0 else {
      throw SecureRuntimeFileError.io("sync definition")
    }
    guard renameat(descriptor, temporary, descriptor, name) == 0 else {
      throw SecureRuntimeFileError.io("replace definition")
    }
    shouldRemoveTemporary = false
    guard fsync(descriptor) == 0 else {
      throw SecureRuntimeFileError.io("sync definition directory")
    }
  }

  func remove(_ path: String) throws {
    let parts = try components(path)
    guard let name = parts.last else { throw SecureRuntimeFileError.invalidPath }
    let descriptor: Int32
    do {
      descriptor = try directoryDescriptor(parts.dropLast(), create: false)
    } catch SecureRuntimeFileError.notFound {
      return
    }
    defer { Darwin.close(descriptor) }

    var info = stat()
    if fstatat(descriptor, name, &info, AT_SYMLINK_NOFOLLOW) != 0 {
      if errno == ENOENT { return }
      throw SecureRuntimeFileError.io("inspect definition")
    }
    guard (info.st_mode & S_IFMT) == S_IFREG else { throw SecureRuntimeFileError.unsafePath }
    guard unlinkat(descriptor, name, 0) == 0, fsync(descriptor) == 0 else {
      throw SecureRuntimeFileError.io("remove definition")
    }
  }
}

struct RuntimeBridgeFailure: Error {
  let code: String
  let message: String
}

final class MacRuntimeLifecycle {
  private let environment: [String: String]
  private let homeDirectory: String
  private let uid: uid_t
  private let runner: RuntimeProcessRunning
  private let files: RuntimeFileStoring
  private let packagedHostExecutable: String?

  init(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    homeDirectory: String = FileManager.default.homeDirectoryForCurrentUser.path,
    uid: uid_t = getuid(),
    runner: RuntimeProcessRunning = BoundedRuntimeProcessRunner(),
    files: RuntimeFileStoring = SecureRuntimeFileStore(),
    packagedHostExecutable: String? = Bundle.main.resourceURL?
      .appendingPathComponent("runtime/t4-host").path
  ) {
    self.environment = environment
    self.homeDirectory = homeDirectory
    self.uid = uid
    self.runner = runner
    self.files = files
    self.packagedHostExecutable = packagedHostExecutable
  }

  private var definitionPath: String {
    "\(homeDirectory)/Library/LaunchAgents/\(runtimeLabel).plist"
  }

  private var logsDirectory: String {
    "\(homeDirectory)/Library/Logs/T4 Code/appserver"
  }

  private var domain: String { "gui/\(uid)" }
  private var target: String { "\(domain)/\(runtimeLabel)" }

  func inspect() -> [String: Any] {
    inspect(discovery: discovery())
  }

  func install() throws -> [String: Any] {
    let discovery = discovery()
    let ompExecutable = try requireExecutable(discovery)
    let hostExecutable = try requireHostExecutable()
    let definition = try renderDefinition(
      hostExecutable: hostExecutable,
      ompExecutable: ompExecutable
    )
    let previous = try fileSnapshotForMutation()
    let status = try launchctl(["print", target], allowMissing: true)
    let registered = !isMissingService(status)
    let changed = previous.content != definition || previous.mode != 0o600

    do {
      if changed {
        try files.ensureDirectory(logsDirectory)
        try files.writeAtomically(definitionPath, content: definition, mode: 0o600)
      }
      if registered && changed { _ = try launchctl(["bootout", target]) }
      if !registered || changed { _ = try launchctl(["bootstrap", domain, definitionPath]) }
      _ = try launchctl(["kickstart", "-k", target])
    } catch {
      if changed {
        if let old = previous.content {
          try? files.writeAtomically(definitionPath, content: old, mode: previous.mode)
        } else {
          try? files.remove(definitionPath)
        }
        _ = try? launchctl(["bootout", target], allowMissing: true)
        if registered, previous.content != nil {
          _ = try? launchctl(["bootstrap", domain, definitionPath])
          if serviceState(status) == "running" {
            _ = try? launchctl(["kickstart", "-k", target])
          }
        }
      }
      throw bridgeFailure(error, fallbackCode: "runtime_install_failed")
    }
    return inspect(discovery: discovery)
  }

  func start() throws -> [String: Any] {
    let discovery = discovery()
    let ompExecutable = try requireExecutable(discovery)
    let hostExecutable = try requireHostExecutable()
    try requireCurrentDefinition(
      hostExecutable: hostExecutable,
      ompExecutable: ompExecutable
    )
    let status = try launchctl(["print", target], allowMissing: true)
    if isMissingService(status) { _ = try launchctl(["bootstrap", domain, definitionPath]) }
    _ = try launchctl(["kickstart", "-k", target])
    return inspect(discovery: discovery)
  }

  func stop() throws -> [String: Any] {
    _ = try launchctl(["bootout", target])
    return inspect(discovery: discovery())
  }

  func restart() throws -> [String: Any] {
    let discovery = discovery()
    let ompExecutable = try requireExecutable(discovery)
    let hostExecutable = try requireHostExecutable()
    try requireCurrentDefinition(
      hostExecutable: hostExecutable,
      ompExecutable: ompExecutable
    )
    let status = try launchctl(["print", target], allowMissing: true)
    if isMissingService(status) { _ = try launchctl(["bootstrap", domain, definitionPath]) }
    _ = try launchctl(["kickstart", "-k", target])
    return inspect(discovery: discovery)
  }

  func uninstall() throws -> [String: Any] {
    let previous = try fileSnapshotForMutation()
    let status = try launchctl(["print", target], allowMissing: true)
    if !isMissingService(status) { _ = try launchctl(["bootout", target]) }
    do {
      try files.remove(definitionPath)
    } catch {
      if !isMissingService(status), previous.content != nil {
        _ = try? launchctl(["bootstrap", domain, definitionPath])
        if serviceState(status) == "running" {
          _ = try? launchctl(["kickstart", "-k", target])
        }
      }
      throw bridgeFailure(error, fallbackCode: "runtime_uninstall_failed")
    }
    return inspect(discovery: discovery())
  }

  private func discovery() -> RuntimeDiscovery {
    OmpRuntimeDiscovery(
      environment: environment,
      homeDirectory: homeDirectory,
      runner: runner
    ).discover()
  }

  private func inspect(discovery: RuntimeDiscovery) -> [String: Any] {
    var map: [String: Any] = [
      "available": false,
      "definition": "missing",
      "service": "unknown",
      "diagnostics": "",
    ]

    var ompExecutable: String?
    var hostExecutable: String?
    switch discovery {
    case .found(let path):
      ompExecutable = path
      map["executable"] = String(path.prefix(4096))
    case .incompatible:
      map["issueCode"] = "omp_authority_bridge_required"
      map["message"] = boundedDiagnostic(
        "Installed OMP is incompatible with this T4 Code build. T4 Code requires the versioned `omp bridge --stdio` authority bridge. Update OMP, then choose Check again."
      )
    case .missing:
      map["issueCode"] = "omp_not_found"
      map["message"] = "A compatible system OMP executable was not found."
    }

    if ompExecutable != nil {
      hostExecutable = hostDiscovery().discover()
      if let hostExecutable {
        map["available"] = true
        map["hostExecutable"] = String(hostExecutable.prefix(4096))
      } else {
        map["issueCode"] = "t4_host_not_found"
        map["message"] = "The standalone T4 host executable is missing from this build."
      }
    }

    do {
      let snapshot = try files.read(definitionPath, maxBytes: 64 * 1024)
      if let ompExecutable, let hostExecutable,
        let expected = try? renderDefinition(
          hostExecutable: hostExecutable,
          ompExecutable: ompExecutable
        ),
        snapshot.content == expected,
        snapshot.mode == 0o600
      {
        map["definition"] = "current"
      } else if snapshot.content == nil {
        map["definition"] = "missing"
      } else {
        map["definition"] = "drifted"
      }
    } catch {
      map["definition"] = "drifted"
      map["diagnostics"] = boundedDiagnostic("Unable to safely inspect the LaunchAgent definition.")
      if map["issueCode"] == nil {
        map["issueCode"] = "runtime_definition_unsafe"
        map["message"] = "The LaunchAgent definition path is unsafe or unreadable."
      }
    }

    do {
      let status = try launchctl(["print", target], allowMissing: true)
      map["service"] = serviceState(status)
      let diagnostic = boundedDiagnostic(status.output)
      if !diagnostic.isEmpty { map["diagnostics"] = diagnostic }
    } catch {
      map["service"] = "unknown"
      map["diagnostics"] = boundedDiagnostic("Unable to inspect the per-user LaunchAgent.")
      if map["issueCode"] == nil {
        map["issueCode"] = "runtime_status_failed"
        map["message"] = "The per-user LaunchAgent status could not be read."
      }
    }
    return map
  }

  private func fileSnapshotForMutation() throws -> RuntimeFileSnapshot {
    do {
      return try files.read(definitionPath, maxBytes: 64 * 1024)
    } catch {
      throw RuntimeBridgeFailure(
        code: "runtime_definition_unsafe",
        message: "The LaunchAgent definition path is unsafe or unreadable."
      )
    }
  }

  private func requireExecutable(_ discovery: RuntimeDiscovery) throws -> String {
    switch discovery {
    case .found(let path): return path
    case .incompatible:
      throw RuntimeBridgeFailure(
        code: "omp_authority_bridge_required",
        message:
          "Installed OMP is incompatible with this T4 Code build. T4 Code requires the versioned `omp bridge --stdio` authority bridge."
      )
    case .missing:
      throw RuntimeBridgeFailure(
        code: "omp_not_found", message: "A compatible system OMP executable was not found.")
    }
  }

  private func hostDiscovery() -> T4HostRuntimeDiscovery {
    T4HostRuntimeDiscovery(
      environment: environment,
      homeDirectory: homeDirectory,
      packagedExecutable: packagedHostExecutable
    )
  }

  private func requireHostExecutable() throws -> String {
    guard let executable = hostDiscovery().discover() else {
      throw RuntimeBridgeFailure(
        code: "t4_host_not_found",
        message: "The standalone T4 host executable is missing from this build."
      )
    }
    return executable
  }

  private func requireCurrentDefinition(hostExecutable: String, ompExecutable: String) throws {
    let snapshot = try fileSnapshotForMutation()
    let expected = try renderDefinition(
      hostExecutable: hostExecutable,
      ompExecutable: ompExecutable
    )
    guard snapshot.content == expected, snapshot.mode == 0o600 else {
      throw RuntimeBridgeFailure(
        code: "runtime_definition_not_current",
        message: "Install the current LaunchAgent definition before starting the runtime."
      )
    }
  }

  private func renderDefinition(hostExecutable: String, ompExecutable: String) throws -> String {
    let values = [hostExecutable, ompExecutable, logsDirectory]
    guard
      values.allSatisfy({ value in
        !value.isEmpty && value.utf8.count <= 4096
          && !value.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f })
      })
    else {
      throw RuntimeBridgeFailure(
        code: "runtime_path_invalid", message: "The runtime path is invalid.")
    }
    let hostExecutableXML = escapeXML(hostExecutable)
    let ompExecutableXML = escapeXML(ompExecutable)
    let logsXML = escapeXML(logsDirectory)
    return [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
      "<plist version=\"1.0\">",
      "  <dict>",
      "    <key>Label</key><string>\(runtimeLabel)</string>",
      "    <key>ProgramArguments</key>",
      "    <array>",
      "      <string>\(hostExecutableXML)</string>",
      "      <string>serve</string>",
      "      <string>--omp</string>",
      "      <string>\(ompExecutableXML)</string>",
      "      <string>--profile</string>",
      "      <string>default</string>",
      "    </array>",
      "    <key>RunAtLoad</key><true/>",
      "    <key>KeepAlive</key>",
      "    <dict><key>SuccessfulExit</key><false/></dict>",
      "    <key>Umask</key><integer>63</integer>",
      "    <key>StandardOutPath</key><string>\(logsXML)/appserver.log</string>",
      "    <key>StandardErrorPath</key><string>\(logsXML)/appserver.error.log</string>",
      "    <key>EnvironmentVariables</key>",
      "    <dict>",
      "      <key>OMP_PROFILE</key>",
      "      <string>default</string>",
      "    </dict>",
      "  </dict>",
      "</plist>",
      "",
    ].joined(separator: "\n")
  }

  private func escapeXML(_ value: String) -> String {
    value
      .replacingOccurrences(of: "&", with: "&amp;")
      .replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;")
      .replacingOccurrences(of: "\"", with: "&quot;")
      .replacingOccurrences(of: "'", with: "&apos;")
  }

  private func launchctl(_ arguments: [String], allowMissing: Bool = false) throws
    -> RuntimeProcessResult
  {
    let result = try runLaunchctl(arguments)
    if result.timedOut {
      throw RuntimeBridgeFailure(
        code: "runtime_command_timeout", message: "The LaunchAgent command timed out.")
    }
    if result.overflowed {
      throw RuntimeBridgeFailure(
        code: "runtime_command_output_limit",
        message: "The LaunchAgent command produced too much output.")
    }
    guard result.exitCode == 0 || allowMissing && isMissingService(result) else {
      let message = result.output.isEmpty ? "The LaunchAgent command failed." : result.output
      throw RuntimeBridgeFailure(
        code: "runtime_command_failed",
        message: boundedDiagnostic(message)
      )
    }
    return result
  }
  private func runLaunchctl(_ arguments: [String]) throws -> RuntimeProcessResult {
    do {
      return try runner.run(
        executableURL: URL(fileURLWithPath: "/bin/launchctl"),
        arguments: arguments,
        environment: safeEnvironment(),
        timeout: runtimeCommandTimeout,
        maxOutputBytes: runtimeOutputLimit
      )
    } catch {
      throw RuntimeBridgeFailure(
        code: "runtime_command_failed", message: "The LaunchAgent command could not be executed.")
    }
  }

  private func safeEnvironment() -> [String: String] {
    var safe: [String: String] = [:]
    for key in ["HOME", "PATH", "TMPDIR"] {
      if let value = environment[key] { safe[key] = value }
    }
    return safe
  }

  private func isMissingService(_ result: RuntimeProcessResult) -> Bool {
    let output = result.output.lowercased()
    return output.contains("could not find")
      || output.contains("not loaded")
      || output.contains("no such process")
  }

  private func serviceState(_ result: RuntimeProcessResult) -> String {
    let output = result.output.lowercased()
    if output.contains("state = running") || output.contains("state=running") { return "running" }
    if output.contains("state = starting") || output.contains("state=starting") {
      return "starting"
    }
    if output.contains("state = exited") || output.contains("state=exited")
      || isMissingService(result)
    {
      return "stopped"
    }
    if output.contains("failed") { return "failed" }
    return result.exitCode == 0 ? "running" : "unknown"
  }

  private func bridgeFailure(_ error: Error, fallbackCode: String) -> RuntimeBridgeFailure {
    if let failure = error as? RuntimeBridgeFailure { return failure }
    return RuntimeBridgeFailure(
      code: fallbackCode, message: "The runtime lifecycle operation failed safely.")
  }
}

func boundedDiagnostic(_ input: String) -> String {
  var value = input
  let patterns = [
    "(?i)(Bearer\\s+)[^\\s]+",
    "(?i)([A-Za-z0-9_-]*(?:token|secret|password|credential|authorization|api[_-]?key|private[_-]?key)[A-Za-z0-9_-]*\\s*[=:]\\s*)[^\\s,;]+",
  ]
  for (index, pattern) in patterns.enumerated() {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
    let replacement = index == 0 ? "$1[redacted]" : "$1[redacted]"
    value = regex.stringByReplacingMatches(
      in: value,
      range: NSRange(value.startIndex..., in: value),
      withTemplate: replacement
    )
  }
  value = String(
    value.unicodeScalars.map { scalar in
      scalar.value < 0x20 || scalar.value == 0x7f ? " " : Character(String(scalar))
    })
  return String(value.trimmingCharacters(in: .whitespacesAndNewlines).prefix(512))
}

private let updateManifestURL = URL(string: "https://t4code.net/releases/latest.json")!
private let updateManifestLimit = 256 * 1024

protocol UpdateManifestFetching {
  func fetch() throws -> Data
}

final class PinnedUpdateManifestFetcher: NSObject, UpdateManifestFetching, URLSessionDataDelegate,
  URLSessionTaskDelegate
{
  private let lock = NSLock()
  private var received = Data()
  private var responseError: Error?
  private var completed = DispatchSemaphore(value: 0)
  private var responseAccepted = false

  func fetch() throws -> Data {
    lock.lock()
    received = Data()
    responseError = nil
    completed = DispatchSemaphore(value: 0)
    responseAccepted = false
    lock.unlock()

    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 10
    configuration.timeoutIntervalForResource = 10
    configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    configuration.httpCookieAcceptPolicy = .never
    configuration.httpCookieStorage = nil
    configuration.urlCredentialStorage = nil
    configuration.urlCache = nil
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    var request = URLRequest(url: updateManifestURL)
    request.timeoutInterval = 10
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    let task = session.dataTask(with: request)
    task.resume()
    if completed.wait(timeout: .now() + 10.5) == .timedOut {
      task.cancel()
      session.invalidateAndCancel()
      throw RuntimeBridgeFailure(code: "update_timeout", message: "The update check timed out.")
    }
    session.finishTasksAndInvalidate()

    lock.lock()
    defer { lock.unlock() }
    if let error = responseError { throw error }
    guard responseAccepted, received.count <= updateManifestLimit else {
      throw RuntimeBridgeFailure(
        code: "update_invalid_response", message: "The update service response was invalid.")
    }
    return received
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    guard let http = response as? HTTPURLResponse,
      http.statusCode == 200,
      http.url == updateManifestURL,
      http.url?.scheme == "https",
      http.url?.host == "t4code.net",
      http.expectedContentLength <= Int64(updateManifestLimit)
        || http.expectedContentLength == -1
    else {
      lock.lock()
      responseError = RuntimeBridgeFailure(
        code: "update_invalid_response",
        message: "The update service response was invalid."
      )
      lock.unlock()
      completionHandler(.cancel)
      return
    }
    lock.lock()
    responseAccepted = true
    lock.unlock()
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    lock.lock()
    if data.count > updateManifestLimit - received.count {
      responseError = RuntimeBridgeFailure(
        code: "update_manifest_too_large",
        message: "The update manifest was too large."
      )
      lock.unlock()
      dataTask.cancel()
      return
    }
    received.append(data)
    lock.unlock()
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    lock.lock()
    if responseError == nil, let error = error {
      responseError = RuntimeBridgeFailure(
        code: "update_network_error",
        message: error is URLError && (error as? URLError)?.code == .timedOut
          ? "The update check timed out."
          : "The update service could not be reached."
      )
    }
    lock.unlock()
    completed.signal()
  }
}

struct MacReleaseManifest {
  let version: String
  let downloadURL: URL
}

final class MacUpdateLifecycle {
  private let currentVersion: String
  private let fetcher: UpdateManifestFetching
  private let openURL: (URL) -> Bool
  private var state: [String: Any]
  private var selectedDownloadURL: URL?

  init(
    currentVersion: String = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString")
      as? String
      ?? "0.0.0",
    fetcher: UpdateManifestFetching = PinnedUpdateManifestFetcher(),
    openURL: @escaping (URL) -> Bool = { url in
      if Thread.isMainThread { return NSWorkspace.shared.open(url) }
      return DispatchQueue.main.sync { NSWorkspace.shared.open(url) }
    }
  ) {
    let safeCurrentVersion = MacUpdateLifecycle.isVersion(currentVersion) ? currentVersion : "0.0.0"
    self.currentVersion = safeCurrentVersion
    self.fetcher = fetcher
    self.openURL = openURL
    state = ["currentVersion": safeCurrentVersion, "phase": "idle"]
  }

  func getState() -> [String: Any] { state }

  func check() -> [String: Any] {
    state = ["currentVersion": currentVersion, "phase": "checking"]
    selectedDownloadURL = nil
    let checkedAt = Int(Date().timeIntervalSince1970 * 1000)
    do {
      let manifest = try decodeManifest(fetcher.fetch())
      if compareVersions(manifest.version, currentVersion) <= 0 {
        state = [
          "currentVersion": currentVersion,
          "phase": "current",
          "checkedAt": checkedAt,
          "message": "T4 Code is up to date.",
        ]
      } else {
        selectedDownloadURL = manifest.downloadURL
        state = [
          "currentVersion": currentVersion,
          "phase": "manual",
          "latestVersion": manifest.version,
          "checkedAt": checkedAt,
          "message": "T4 Code \(manifest.version) is available from the official release.",
        ]
      }
    } catch let failure as RuntimeBridgeFailure {
      state = [
        "currentVersion": currentVersion,
        "phase": "error",
        "checkedAt": checkedAt,
        "error": String(failure.code.prefix(128)),
        "message": boundedDiagnostic(failure.message),
      ]
    } catch {
      state = [
        "currentVersion": currentVersion,
        "phase": "error",
        "checkedAt": checkedAt,
        "error": "update_manifest_invalid",
        "message": "The update manifest was invalid.",
      ]
    }
    return state
  }

  func download() -> [String: Any] {
    guard state["phase"] as? String == "manual", let url = selectedDownloadURL else { return state }
    guard isPinnedReleaseURL(url), openURL(url) else {
      state = [
        "currentVersion": currentVersion,
        "phase": "error",
        "checkedAt": state["checkedAt"] as? Int ?? Int(Date().timeIntervalSince1970 * 1000),
        "error": "update_open_failed",
        "message": "The official release could not be opened.",
      ]
      return state
    }
    return state
  }

  func install() -> [String: Any] {
    guard state["phase"] as? String == "manual" else { return state }
    var manual = state
    manual["message"] = "Install the downloaded signed DMG manually from the official release."
    state = manual
    return state
  }

  private func decodeManifest(_ data: Data) throws -> MacReleaseManifest {
    guard data.count <= updateManifestLimit,
      String(data: data, encoding: .utf8) != nil,
      let object = try? JSONSerialization.jsonObject(with: data),
      let root = object as? [String: Any],
      Set(root.keys)
        == Set([
          "schemaVersion", "channel", "version", "tag", "publishedAt", "releaseUrl", "assets",
        ]),
      (root["schemaVersion"] as? NSNumber)?.intValue == 1,
      !Self.isJSONBoolean(root["schemaVersion"]),
      root["channel"] as? String == "stable",
      let version = root["version"] as? String,
      Self.isVersion(version),
      root["tag"] as? String == "v\(version)",
      root["releaseUrl"] as? String
        == "https://github.com/LycaonLLC/t4-code/releases/tag/v\(version)",
      let publishedAt = root["publishedAt"] as? String,
      publishedAt.utf8.count <= 64,
      Self.isTimestamp(publishedAt),
      let assets = root["assets"] as? [Any],
      assets.count == 5
    else {
      throw RuntimeBridgeFailure(
        code: "update_manifest_invalid", message: "The update manifest was invalid.")
    }

    let canonical: [(String, String, String, String)] = [
      ("android", "apk", "universal", "T4-Code-\(version)-android.apk"),
      ("linux", "deb", "x86_64", "T4-Code-\(version)-linux-amd64.deb"),
      ("linux", "appimage", "x86_64", "T4-Code-\(version)-linux-x86_64.AppImage"),
      ("mac", "dmg", "arm64", "T4-Code-\(version)-mac-arm64.dmg"),
      ("mac", "zip", "arm64", "T4-Code-\(version)-mac-arm64.zip"),
    ]
    var decoded: [(String, String, String, String, URL)] = []
    var names = Set<String>()
    for rawAsset in assets {
      guard let asset = rawAsset as? [String: Any],
        Set(asset.keys) == Set(["platform", "kind", "arch", "name", "url", "size", "sha256"]),
        let platform = asset["platform"] as? String,
        ["android", "linux", "mac"].contains(platform),
        let kind = asset["kind"] as? String,
        ["apk", "deb", "appimage", "dmg", "zip"].contains(kind),
        let arch = asset["arch"] as? String,
        ["universal", "x86_64", "arm64"].contains(arch),
        let name = asset["name"] as? String,
        !name.isEmpty, name.utf8.count <= 160,
        names.insert(name).inserted,
        let urlString = asset["url"] as? String,
        urlString
          == "https://github.com/LycaonLLC/t4-code/releases/download/v\(version)/\(name)",
        let url = URL(string: urlString),
        isPinnedReleaseURL(url),
        let size = asset["size"] as? NSNumber,
        !Self.isJSONBoolean(size),
        size.doubleValue.rounded() == size.doubleValue,
        size.int64Value > 0, size.int64Value <= 2 * 1024 * 1024 * 1024,
        let digest = asset["sha256"] as? String,
        digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
      else {
        throw RuntimeBridgeFailure(
          code: "update_manifest_invalid", message: "The update manifest was invalid.")
      }
      decoded.append((platform, kind, arch, name, url))
    }
    for expected in canonical {
      guard
        decoded.filter({
          $0.0 == expected.0 && $0.1 == expected.1 && $0.2 == expected.2 && $0.3 == expected.3
        }).count == 1
      else {
        throw RuntimeBridgeFailure(
          code: "update_manifest_invalid", message: "The update manifest was invalid.")
      }
    }
    guard
      let dmg = decoded.first(where: {
        $0.0 == "mac" && $0.1 == "dmg" && $0.2 == "arm64"
          && $0.3 == "T4-Code-\(version)-mac-arm64.dmg"
      })
    else {
      throw RuntimeBridgeFailure(
        code: "update_manifest_invalid", message: "The update manifest was invalid.")
    }
    return MacReleaseManifest(version: version, downloadURL: dmg.4)
  }

  private static func isVersion(_ value: String) -> Bool {
    value.range(
      of: #"^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z](?:[0-9A-Za-z.-]{0,62}[0-9A-Za-z])?)?$"#,
      options: .regularExpression
    ) != nil
  }

  private func compareVersions(_ left: String, _ right: String) -> Int {
    func parsed(_ version: String) -> ([Int], [String]) {
      let pieces = version.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
      let core = pieces[0].split(separator: ".").map { Int($0) ?? 0 }
      let prerelease = pieces.count == 2 ? pieces[1].split(separator: ".").map(String.init) : []
      return (core, prerelease)
    }
    let a = parsed(left)
    let b = parsed(right)
    for index in 0..<3 {
      if a.0[index] != b.0[index] { return a.0[index] < b.0[index] ? -1 : 1 }
    }
    if a.1.isEmpty || b.1.isEmpty {
      if a.1.isEmpty == b.1.isEmpty { return 0 }
      return a.1.isEmpty ? 1 : -1
    }
    for index in 0..<max(a.1.count, b.1.count) {
      if index >= a.1.count { return -1 }
      if index >= b.1.count { return 1 }
      if a.1[index] == b.1[index] { continue }
      let leftNumber = Int(a.1[index])
      let rightNumber = Int(b.1[index])
      if let leftNumber = leftNumber, let rightNumber = rightNumber {
        return leftNumber < rightNumber ? -1 : 1
      }
      if (leftNumber != nil) != (rightNumber != nil) { return leftNumber != nil ? -1 : 1 }
      return a.1[index] < b.1[index] ? -1 : 1
    }
    return 0
  }

  private static func isTimestamp(_ value: String) -> Bool {
    let formatter = ISO8601DateFormatter()
    if formatter.date(from: value) != nil { return true }
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value) != nil
  }

  private static func isJSONBoolean(_ value: Any?) -> Bool {
    guard let number = value as? NSNumber else { return false }
    return CFGetTypeID(number) == CFBooleanGetTypeID()
  }

  private func isPinnedReleaseURL(_ url: URL) -> Bool {
    guard url.scheme == "https", url.host == "github.com", url.user == nil, url.password == nil,
      url.port == nil, url.query == nil, url.fragment == nil
    else { return false }
    return url.path.hasPrefix("/LycaonLLC/t4-code/releases/download/v")
  }
}

final class PlatformLifecycleChannel {
  static let name = "com.lycaonsolutions.t4code/platform_lifecycle"

  private let channel: FlutterMethodChannel
  private let lifecycle: MacRuntimeLifecycle
  private let updates: MacUpdateLifecycle
  private let executor = DispatchQueue(
    label: "com.lycaonsolutions.t4code.platform-lifecycle", qos: .userInitiated)

  init(
    messenger: FlutterBinaryMessenger,
    lifecycle: MacRuntimeLifecycle = MacRuntimeLifecycle(),
    updates: MacUpdateLifecycle = MacUpdateLifecycle()
  ) {
    channel = FlutterMethodChannel(name: Self.name, binaryMessenger: messenger)
    self.lifecycle = lifecycle
    self.updates = updates
    channel.setMethodCallHandler { [weak self] call, result in
      self?.handle(call, result: result)
    }
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    let operation: (() throws -> [String: Any])?
    switch call.method {
    case "runtime.inspect": operation = { self.lifecycle.inspect() }
    case "runtime.install": operation = { try self.lifecycle.install() }
    case "runtime.start": operation = { try self.lifecycle.start() }
    case "runtime.stop": operation = { try self.lifecycle.stop() }
    case "runtime.restart": operation = { try self.lifecycle.restart() }
    case "runtime.uninstall": operation = { try self.lifecycle.uninstall() }
    case "update.getState": operation = { self.updates.getState() }
    case "update.check": operation = { self.updates.check() }
    case "update.download": operation = { self.updates.download() }
    case "update.install": operation = { self.updates.install() }
    default:
      result(FlutterMethodNotImplemented)
      return
    }

    executor.async {
      do {
        let response = try operation?() ?? [:]
        DispatchQueue.main.async { result(response) }
      } catch let failure as RuntimeBridgeFailure {
        DispatchQueue.main.async {
          result(
            FlutterError(
              code: failure.code, message: boundedDiagnostic(failure.message), details: nil))
        }
      } catch {
        DispatchQueue.main.async {
          result(
            FlutterError(
              code: "platform_internal", message: "The platform lifecycle operation failed safely.",
              details: nil))
        }
      }
    }
  }
}
