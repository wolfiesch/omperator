// swift-tools-version:5.10
import PackageDescription

/// T4CodeLinux — native Linux client (pure GTK4) built from the same source
/// lineage as the macOS/iOS SwiftUI app (apps/ios). See
/// docs/adr/026-native-linux-client.md and ADR 020 for the product boundary.
///
/// Layout: T4CodeLinuxLib is the library (store, seams — testable);
/// T4CodeLinux is the pure-GTK4 executable that hosts the window. SwiftPM
/// test targets can only import libraries, not executables.
///
/// The UI is imperative GTK4 via the CT4Gtk shim — no SwiftCrossUI in the
/// graph. The lib keeps OpenCombine for the store's reactive layer and the
/// CWebKit/CVTE system libraries for the browser/terminal panes.
let package = Package(
    name: "T4CodeLinux",
    platforms: [.macOS(.v13)],
    dependencies: [
        // 1:1 Combine API clone for Linux — the store ports with minimal edits.
        .package(url: "https://github.com/OpenCombine/OpenCombine", from: "0.14.0"),
        // CryptoKit API parity (SHA256 for the cert-pin fingerprint).
        .package(url: "https://github.com/apple/swift-crypto", from: "3.12.0"),
        // Shared wire-protocol package with the iOS/macOS app.
        .package(name: "HostWire", path: "../ios/HostWire"),
    ],
    targets: [
        .target(
            name: "T4CodeLinuxLib",
            dependencies: [
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
        // GTK4 — the pure-GTK UI surface (the production Linux app).
        .systemLibrary(
            name: "CT4Gtk",
            path: "Sources/CT4Gtk",
            pkgConfig: "gtk4",
            providers: [.apt(["libgtk-4-dev"])]
        ),
        // Pure-GTK4 Linux app — imperative widgets over the shared store.
        .executableTarget(
            name: "T4CodeLinux",
            dependencies: [
                "T4CodeLinuxLib",
                "CT4Gtk",
            ],
            path: "Sources/T4CodeLinux",
            resources: [.copy("themes")],
            linkerSettings: [.linkedLibrary("X11")]
        ),
    ]
)
