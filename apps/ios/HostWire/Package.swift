// swift-tools-version: 5.9
import PackageDescription

/// HostWire — Swift port of @t4-code/host-wire (protocol `omp-app/1`).
///
/// Pure Foundation model layer + bounded decoders. Builds for macOS (so it can
/// run under `swift test`) and iOS (the app target). The WebSocket client lives
/// here too (URLSessionWebSocketTask); it is added in a later step.
let package = Package(
    name: "HostWire",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "HostWire", targets: ["HostWire"]),
    ],
    targets: [
        .target(name: "HostWire", path: "Sources/HostWire"),
        .testTarget(
            name: "HostWireTests",
            dependencies: ["HostWire"],
            path: "Tests/HostWireTests",
            resources: [.copy("Fixtures")]
        ),
    ]
)
