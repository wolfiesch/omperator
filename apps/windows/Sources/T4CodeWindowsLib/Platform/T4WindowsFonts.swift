import Foundation
import WinSDK

/// Registers the Linux capture fonts for this unpackaged WinUI process.
/// SwiftPM copies the font files beside the executable; private registration
/// keeps the UI deterministic without mutating the user's installed fonts.
public enum T4WindowsFonts {
    private static let bundledFonts = [
        (name: "Cantarell-Regular", extension: "otf"),
        (name: "Cantarell-Bold", extension: "otf"),
        (name: "Cantarell-Light", extension: "otf"),
        (name: "Cantarell-ExtraBold", extension: "otf"),
        (name: "Cantarell-Thin", extension: "otf"),
        (name: "DejaVuSansMono", extension: "ttf"),
        (name: "DejaVuSansMono-Bold", extension: "ttf"),
        (name: "DejaVuSansMono-Oblique", extension: "ttf"),
        (name: "DejaVuSansMono-BoldOblique", extension: "ttf"),
    ]
    @MainActor private static var registered = false

    @MainActor
    public static var areBundledFontsRegistered: Bool { registered }

    @MainActor
    public static func registerBundledFonts() {
        guard !registered else { return }

        for font in bundledFonts {
            guard let url = Bundle.module.url(forResource: font.name, withExtension: font.extension) else {
                fatalError("Missing bundled UI font: \(font.name).\(font.extension)")
            }

            let added = url.path.withCString(encodedAs: UTF16.self) { path in
                AddFontResourceExW(path, DWORD(0x10), nil)
            }
            guard added > 0 else {
                fatalError("Unable to register bundled UI font: \(font.name).\(font.extension)")
            }
        }

        registered = true
    }
}
