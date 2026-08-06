//  Platform.swift (Linux)
//  Parity primitives for the SwiftUI app lineage. Views ported from
//  apps/ios/Sources use these names so the ported code reads identically.

import Foundation
import SwiftCrossUI

// MARK: - Color parity

extension Color {
    /// SwiftUI's `Color(hex:)` used throughout Theme.swift and the views.
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }

    /// SwiftUI's `.white`/`.black`/`.clear` used throughout the app.
    static let white = Color(hex: 0xFFFFFF)
    static let black = Color(hex: 0x000000)
    static let clear = Color(red: 0, green: 0, blue: 0, opacity: 0)
}

// MARK: - Font parity
//
// The macOS app's type ramp (Theme.swift). SwiftCrossUI's Font has no
// .custom() and only default/monospaced designs, so:
//   disp/labl/bodyF/num -> system with the mapped weight (+monospaced for num)
//   term (VT323)        -> monospace stand-in; upgrade via a CSS fontFamily
//                          representable once VT323 is installed on the host
//   serif (New York)    -> system stand-in; same upgrade path

extension Font {
    static func disp(_ s: CGFloat) -> Font { .system(size: s, weight: .black) }
    static func labl(_ s: CGFloat) -> Font { .system(size: s, weight: .bold) }
    static func term(_ s: CGFloat) -> Font { .system(size: s, design: .monospaced) }
    static func bodyF(_ s: CGFloat) -> Font { .system(size: s, weight: .regular) }
    static func serif(_ s: CGFloat) -> Font { .system(size: s, weight: .regular) }
    static func num(_ s: CGFloat) -> Font { .system(size: s, weight: .semibold).monospaced() }
}

// MARK: - withAnimation no-op
//
// SwiftCrossUI has no animation system yet. The macOS app wraps state changes
// in withAnimation; on Linux the change applies immediately. Keep the calls
// so a future animation system lights up without edits.

func withAnimation<Result>(_ animation: Any? = nil, _ body: () throws -> Result) rethrows -> Result {
    try body()
}
