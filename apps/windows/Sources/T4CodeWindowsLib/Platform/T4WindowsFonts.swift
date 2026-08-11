import Foundation
import WinSDK

/// Registers the Linux capture fonts for this unpackaged WinUI process.
/// SwiftPM copies the font files beside the executable; private registration
/// keeps the UI deterministic without mutating the user's installed fonts.
public enum T4WindowsFonts {
    private static let bundledFonts = [
        "DejaVuSans",
        "DejaVuSans-Bold",
        "DejaVuSansMono",
        "DejaVuSansMono-Bold",
        "DejaVuSansMono-Oblique",
        "DejaVuSansMono-BoldOblique",
    ]
    @MainActor private static var registered = false

    @MainActor
    public static var areBundledFontsRegistered: Bool { registered }

    @MainActor
    public static func registerBundledFonts() {
        guard !registered else { return }

        for font in bundledFonts {
            guard let url = Bundle.module.url(forResource: font, withExtension: "ttf") else {
                fatalError("Missing bundled UI font: \(font).ttf")
            }

            let added = url.path.withCString(encodedAs: UTF16.self) { path in
                AddFontResourceExW(path, DWORD(0x10), nil)
            }
            guard added > 0 else {
                fatalError("Unable to register bundled UI font: \(font).ttf")
            }
        }

        registered = true
    }
}
