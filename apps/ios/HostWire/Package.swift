// swift-tools-version: 5.9
import PackageDescription

/// HostWire — Swift port of @t4-code/host-wire (protocol `omp-app/1`).
let package = Package(
    name: "HostWire",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "HostWire", targets: ["HostWire"]),
    ],
    dependencies: [
        // CryptoKit API parity for Linux builds (T4CollabWire.swift's AES-GCM).
        // On Apple platforms the `Crypto` product re-exports CryptoKit.
        .package(url: "https://github.com/apple/swift-crypto", from: "3.12.0"),
    ],
    targets: [
        .target(
            name: "HostWire",
            dependencies: [
                .product(name: "Crypto", package: "swift-crypto"),
            ],
            path: "Sources/HostWire"
        ),
        .testTarget(
            name: "HostWireTests",
            dependencies: ["HostWire"],
            path: "Tests/HostWireTests",
            resources: [.copy("Fixtures")]
        ),
    ]
)
