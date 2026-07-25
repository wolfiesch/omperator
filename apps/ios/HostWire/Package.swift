// swift-tools-version: 5.9
import PackageDescription

/// HostWire — Swift port of @t4-code/host-wire (protocol `omp-app/1`).
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
