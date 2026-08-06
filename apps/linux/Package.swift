// swift-tools-version:5.10
import PackageDescription

/// T4CodeLinux — native Linux client (SwiftCrossUI/GTK4 backend) built from
/// the same source lineage as the macOS/iOS SwiftUI app (apps/ios). See
/// docs/adr/026-native-linux-client.md and ADR 020 for the product boundary.
///
/// Layout: T4CodeLinuxLib is the library (store, views, seams — testable);
/// T4CodeLinux is a thin executable that hosts the @main entry. SwiftPM test
/// targets can only import libraries, not executables.
///
/// NOTE: depends on `GtkBackend` directly rather than `DefaultBackend`, which
/// drags the Windows-only WinUIBackend/CWinAppSDK into the build graph even
/// on Linux (platform-conditional target deps still get compiled).
let package = Package(
    name: "T4CodeLinux",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(
            url: "https://github.com/moreSwift/swift-cross-ui",
            revision: "199a85614e3b2346aa10736b12f969af14a1f1ea"
        ),
        // 1:1 Combine API clone for Linux — the store ports with minimal edits.
        .package(url: "https://github.com/OpenCombine/OpenCombine", from: "0.14.0"),
        // CryptoKit API parity (SHA256 for the cert-pin fingerprint).
        .package(url: "https://github.com/apple/swift-crypto", from: "3.12.0"),
        // Shared wire-protocol package with the iOS/macOS app.
        .package(name: "HostWire", path: "../ios/HostWire"),
    ],
    targets: [
        .executableTarget(
            name: "T4CodeLinux",
            dependencies: [
                "T4CodeLinuxLib",
                .product(name: "SwiftCrossUI", package: "swift-cross-ui"),
                .product(name: "GtkBackend", package: "swift-cross-ui"),
            ],
            path: "Sources/T4CodeLinux"
        ),
        .target(
            name: "T4CodeLinuxLib",
            dependencies: [
                .product(name: "SwiftCrossUI", package: "swift-cross-ui"),
                .product(name: "GtkBackend", package: "swift-cross-ui"),
                .product(name: "OpenCombine", package: "OpenCombine"),
                .product(name: "Crypto", package: "swift-crypto"),
                .product(name: "HostWire", package: "HostWire"),
                "CWebKit",
                "CVTE",
            ],
            path: "Sources/T4CodeLinuxLib"
        ),
        .testTarget(
            name: "T4CodeLinuxTests",
            dependencies: ["T4CodeLinuxLib"],
            path: "Tests/T4CodeLinuxTests"
        ),
        // WebKitGTK 6.0 — browser pane (WKWebView parity).
        .systemLibrary(
            name: "CWebKit",
            path: "Sources/CWebKit",
            pkgConfig: "webkitgtk-6.0",
            providers: [.apt(["libwebkitgtk-6.0-dev"])]
        ),
        // VTE 2.91 GTK4 — terminal pane (host-PTY surface; fed by wire frames,
        // user keystrokes come back through VTE's commit signal).
        .systemLibrary(
            name: "CVTE",
            path: "Sources/CVTE",
            pkgConfig: "vte-2.91-gtk4",
            providers: [.apt(["libvte-2.91-gtk4-dev"])]
        ),
    ]
)
