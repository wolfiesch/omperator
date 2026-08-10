import Testing
@testable import T4CodeWindowsLib

@Test("Launch arguments enable deterministic demo configuration")
func demoLaunchConfiguration() {
    let configuration = T4WindowsLaunchConfiguration(arguments: [
        "T4CodeWindows.exe",
        "-T4Demo",
        "-T4BrowserFixture",
        "-T4Theme=light",
        "-T4WindowSize=1600x1000",
    ])

    #expect(configuration.demoMode)
    #expect(configuration.browserFixtureEnabled)
    #expect(configuration.themeMode == .light)
    #expect(configuration.windowWidth == 1600)
    #expect(configuration.windowHeight == 1000)
}

@Test("Malformed launch values fall back safely")
func malformedLaunchConfiguration() {
    let configuration = T4WindowsLaunchConfiguration(arguments: [
        "T4CodeWindows.exe",
        "-T4Theme=sepia",
        "-T4BrowserFixture",
        "-T4WindowSize=1600-by-1000",
    ])

    #expect(!configuration.demoMode)
    #expect(!configuration.browserFixtureEnabled)
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

@Test("Host overrides parse through the shared store credential seam")
func ephemeralConnectionCredentials() {
    let credentials = EphemeralConnectionCredentials(arguments: [
        "T4CodeWindows.exe",
        "-T4Endpoint=ws://127.0.0.1:8787/v1/ws",
        "-T4DeviceId=windows-devbox",
        "-T4DeviceToken=test-token",
    ])

    #expect(credentials == EphemeralConnectionCredentials(
        endpoint: "ws://127.0.0.1:8787/v1/ws",
        deviceId: "windows-devbox",
        deviceToken: "test-token"
    ))
    #expect(!Keychain.usesPersistentStore(arguments: ["T4CodeWindows.exe", "-T4NoRestore"]))
}
