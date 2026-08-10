import SwiftCrossUI

/// Windows-owned visual tokens for the core workspace. The shared Linux views
/// retain their Rosé Pine palette; the Windows shell matches the neutral macOS
/// reference without changing Linux or Apple source files.
struct WindowsCorePalette {
    let isDark: Bool

    init(_ appearance: Appearance) {
        isDark = appearance == .dark
    }

    var appBar: Color { isDark ? Color(hex: 0x151517) : Color(hex: 0xFAFAFB) }
    var rail: Color { isDark ? Color(hex: 0x151517) : Color(hex: 0xF7F7F8) }
    var canvas: Color { isDark ? Color(hex: 0x0F0F11) : Color(hex: 0xFFFFFF) }
    var surface: Color { isDark ? Color(hex: 0x1E1E20) : Color(hex: 0xF4F4F5) }
    var surfaceSubtle: Color { isDark ? Color(hex: 0x18181A) : Color(hex: 0xFAFAFA) }
    var rowSelected: Color { isDark ? Color(hex: 0x202023) : Color(hex: 0xECECEF) }
    var hover: Color { isDark ? Color(hex: 0x242427) : Color(hex: 0xE8E8EA) }

    var text: Color { isDark ? Color(hex: 0xF2F2F3) : Color(hex: 0x19191C) }
    var textBody: Color { isDark ? Color(hex: 0xD1D1D4) : Color(hex: 0x36363A) }
    var textMuted: Color { isDark ? Color(hex: 0x9A9AA0) : Color(hex: 0x68686E) }
    var textFaint: Color { isDark ? Color(hex: 0x6F6F76) : Color(hex: 0x929299) }

    var line: Color { isDark ? Color(hex: 0x29292C) : Color(hex: 0xE4E4E6) }
    var lineStrong: Color { isDark ? Color(hex: 0x36363A) : Color(hex: 0xD4D4D7) }

    var accent: Color { isDark ? Color(hex: 0xBC4E75) : Color(hex: 0xB33F6E) }
    var accentMuted: Color { isDark ? Color(hex: 0x6E344B) : Color(hex: 0xE8B7C9) }
    var banner: Color { isDark ? Color(hex: 0x1F161B) : Color(hex: 0xFFF3F7) }

    var working: Color { Color(hex: 0x63B7D7) }
    var success: Color { isDark ? Color(hex: 0x70C7A6) : Color(hex: 0x218A66) }
    var warning: Color { isDark ? Color(hex: 0xE0AE55) : Color(hex: 0xA86A09) }
    var violet: Color { isDark ? Color(hex: 0xA99AE8) : Color(hex: 0x6754C4) }
    var danger: Color { isDark ? Color(hex: 0xE06470) : Color(hex: 0xB42331) }
}
