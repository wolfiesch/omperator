// swift-tools-version: 5.10
import PackageDescription

/// Native Windows client for Omperator. The executable owns WinUI startup;
/// testable product logic and SwiftCrossUI views live in T4CodeWindowsLib.
let package = Package(
    name: "T4CodeWindows",
    products: [
        .executable(name: "T4CodeWindows", targets: ["T4CodeWindows"]),
        .library(name: "T4CodeWindowsLib", targets: ["T4CodeWindowsLib"]),
    ],
    dependencies: [
        .package(
            url: "https://github.com/moreSwift/swift-cross-ui",
            revision: "199a85614e3b2346aa10736b12f969af14a1f1ea"
        ),
        .package(name: "HostWire", path: "../ios/HostWire"),
    ],
    targets: [
        .executableTarget(
            name: "T4CodeWindows",
            dependencies: [
                "T4CodeWindowsLib",
                .product(name: "SwiftCrossUI", package: "swift-cross-ui"),
                .product(name: "WinUIBackend", package: "swift-cross-ui"),
            ],
            path: "Sources/T4CodeWindows"
        ),
        .target(
            name: "T4CodeWindowsLib",
            dependencies: [
                .product(name: "SwiftCrossUI", package: "swift-cross-ui"),
                .product(name: "HostWire", package: "HostWire"),
            ],
            path: "Sources/T4CodeWindowsLib"
        ),
        .testTarget(
            name: "T4CodeWindowsLibTests",
            dependencies: [
                "T4CodeWindowsLib",
                .product(name: "HostWire", package: "HostWire"),
            ],
            path: "Tests/T4CodeWindowsLibTests"
        ),
    ]
)
