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
        .package(
            url: "https://github.com/OpenCombine/OpenCombine",
            from: "0.14.0"
        ),
        .package(
            url: "https://github.com/apple/swift-crypto",
            from: "3.12.0"
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
            path: "Sources/T4CodeWindows",
            // WINDOWS-GAP: Windows executables default to a 1 MiB stack.
            // SwiftCrossUI's source-aligned workspace has a deeply nested
            // generic body and exhausts that stack while materializing view
            // metadata. Match Linux's practical stack headroom explicitly.
            linkerSettings: [
                .unsafeFlags(
                    ["-Xlinker", "/STACK:8388608"],
                    .when(platforms: [.windows])
                ),
            ]
        ),
        .target(
            name: "T4CodeWindowsLib",
            dependencies: [
                .product(name: "SwiftCrossUI", package: "swift-cross-ui"),
                .product(name: "WinUIBackend", package: "swift-cross-ui"),
                .product(name: "OpenCombine", package: "OpenCombine"),
                .product(name: "Crypto", package: "swift-crypto"),
                .product(name: "HostWire", package: "HostWire"),
            ],
            path: "Sources/T4CodeWindowsLib",
            resources: [
                .process("Resources"),
            ]
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
