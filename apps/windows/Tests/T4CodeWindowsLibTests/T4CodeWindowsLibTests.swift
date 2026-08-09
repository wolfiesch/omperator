import Testing
@testable import T4CodeWindowsLib

@Test("Launch arguments enable deterministic demo configuration")
func demoLaunchConfiguration() {
    let configuration = T4WindowsLaunchConfiguration(arguments: [
        "T4CodeWindows.exe",
        "-T4Demo",
        "-T4Theme=light",
        "-T4WindowSize=1600x1000",
    ])

    #expect(configuration.demoMode)
    #expect(configuration.themeMode == .light)
    #expect(configuration.windowWidth == 1600)
    #expect(configuration.windowHeight == 1000)
}

@Test("Malformed launch values fall back safely")
func malformedLaunchConfiguration() {
    let configuration = T4WindowsLaunchConfiguration(arguments: [
        "T4CodeWindows.exe",
        "-T4Theme=sepia",
        "-T4WindowSize=1600-by-1000",
    ])

    #expect(!configuration.demoMode)
    #expect(configuration.themeMode == .system)
    #expect(configuration.windowWidth == T4WindowsLaunchConfiguration.defaultWindowWidth)
    #expect(configuration.windowHeight == T4WindowsLaunchConfiguration.defaultWindowHeight)
}

@Test("Windows identity uses the existing HostWire client contract")
func windowsHostWireIdentity() {
    let identity = T4WindowsPlatform.clientIdentity(version: "0.2.0", build: "test")

    #expect(identity.name == "t4-windows")
    #expect(identity.version == "0.2.0")
    #expect(identity.build == "test")
    #expect(identity.platform == "windows")
    #expect(T4WindowsPlatform.deviceIdPrefix == "windows")
    #expect(T4WindowsPlatform.deviceName(environment: ["COMPUTERNAME": "DEVBOX"], fallback: "fallback") == "DEVBOX")
}

@Test("Demo data is explicit and internally consistent")
func demoContentConsistency() {
    let ids = T4WindowsDemoContent.sessions.map(\.id)

    #expect(!T4WindowsDemoContent.sessions.isEmpty)
    #expect(Set(ids).count == ids.count)
    #expect(!T4WindowsDemoContent.transcript.isEmpty)
}
