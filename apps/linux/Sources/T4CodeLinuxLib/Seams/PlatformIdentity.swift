//  PlatformIdentity.swift (Linux)
//  Device-identity parity for apps/ios/Sources/Platform.swift. The shared
//  store sends these to the host during pairing/hello.

import Foundation

public let platformClientName = "t4-linux"
public let platformClientPlatform = "linux"
public let platformDeviceIdPrefix = "linux"

/// Human-readable device name sent to the host during pairing. On Linux we
/// report the machine's hostname when available, falling back to the distro
/// id — the Apple side reports the device name from UIKit/AppKit.
public func platformDeviceName() -> String {
    if let hostname = ProcessInfo.processInfo.environment["HOSTNAME"],
       !hostname.isEmpty
    {
        return hostname
    }
    return ProcessInfo.processInfo.hostName
}
