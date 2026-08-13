//  T4Perf.swift (Linux)
//  Perf probe: set T4PERF=1 to log slow observation/render paths.
//  Formerly part of Store/T4UIObservation.swift (removed with the
//  SwiftCrossUI observation bridge; the store still marks phases).

import Foundation

public enum T4Perf {
    public static let measure = ProcessInfo.processInfo.environment["T4PERF"] == "1"

    /// Log a timestamped phase marker (only when T4PERF=1).
    public static func mark(_ label: String) {
        guard measure else { return }
        FileHandle.standardError.write(Data("[perf] \(label) \(ContinuousClock.now)\n".utf8))
    }
}
