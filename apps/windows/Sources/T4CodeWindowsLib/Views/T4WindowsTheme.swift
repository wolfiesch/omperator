import SwiftCrossUI

extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

/// Rosé Pine Moon/Dawn tokens copied from the Linux SwiftCrossUI client.
struct T4WindowsTheme {
    let isDark: Bool

    var background: Color { isDark ? Color(hex: 0x232136) : Color(hex: 0xFAF4ED) }
    var surface: Color { isDark ? Color(hex: 0x2A273F) : Color(hex: 0xFFFAF3) }
    var text: Color { isDark ? Color(hex: 0xE0DEF4) : Color(hex: 0x575279) }
    var bodyText: Color { isDark ? Color(hex: 0x908CAA) : Color(hex: 0x6E6A8A) }
    var mutedText: Color { isDark ? Color(hex: 0x6E6A86) : Color(hex: 0x797593) }
    var labelText: Color { isDark ? Color(hex: 0x56526E) : Color(hex: 0x9893A5) }
    var faintLine: Color { isDark ? Color(hex: 0x2A283E) : Color(hex: 0xF4EDE8) }
    var line: Color { isDark ? Color(hex: 0x393552) : Color(hex: 0xDFDAD9) }
    var strongLine: Color { isDark ? Color(hex: 0x44415A) : Color(hex: 0xCECACD) }
    var accent: Color { isDark ? Color(hex: 0xF6C177) : Color(hex: 0xEA9D34) }
    var accentDim: Color { accent.opacity(isDark ? 0.16 : 0.14) }
    var success: Color { isDark ? Color(hex: 0x9CCFD8) : Color(hex: 0x56949F) }
    var tool: Color { isDark ? Color(hex: 0xC4A7E7) : Color(hex: 0x907AA9) }
}
