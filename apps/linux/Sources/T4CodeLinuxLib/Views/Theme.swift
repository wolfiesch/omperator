//  Theme.swift (Linux)
//  Port of apps/ios/Sources/Theme.swift — design tokens only (token struct +
//  store). Glass modifiers are view-layer work (wave 2). Values copied
//  verbatim from the Apple source; interactiveAccent falls back to the
//  brand accent on Linux (no system accent API).

import Foundation
import OpenCombine
import SwiftCrossUI

enum Appearance: String { case system, dark, light }

@MainActor
final class ThemeStore: OpenCombine.ObservableObject {
    // Default off the bat: follow the system appearance (persisted once the user toggles).
    @OpenCombine.Published var mode: Appearance = {
        // UI-test seam: -T4Theme=dark|light|system forces the appearance for
        // headless screenshot sweeps without touching the persisted pref.
        if let raw = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("-T4Theme=") }),
           let forced = Appearance(rawValue: String(raw.dropFirst("-T4Theme=".count))) {
            return forced
        }
        return Appearance(rawValue: UserDefaults.standard.string(forKey: "enclave.theme") ?? "system") ?? .system
    }() {
        didSet { UserDefaults.standard.set(mode.rawValue, forKey: "enclave.theme") }
    }
    /// The live OS appearance, fed from the environment by RootView; used when mode == .system.
    @OpenCombine.Published var systemDark = true

    /// Resolved dark/light after applying the system default.
    var effective: Appearance { mode == .system ? (systemDark ? .dark : .light) : mode }
    /// nil = follow the OS; otherwise force the chosen appearance.
    var preferredScheme: ColorScheme? { mode == .system ? nil : (mode == .dark ? .dark : .light) }

    func toggle() { mode = effective == .dark ? .light : .dark }
    var t: Theme { Theme(effective) }
}

struct Theme {
    let mode: Appearance
    init(_ m: Appearance) { mode = m }
    private var dark: Bool { mode == .dark }

    // ground / figure
    // Dark = Rosé Pine Moon; Light = Rosé Pine Dawn. The gold "voice"
    // (terminal/live accent) is the identity line across both modes.
    var bg:   Color { dark ? Color(hex: 0x232136) : Color(hex: 0xFAF4ED) }  // base
    var bg2:  Color { dark ? Color(hex: 0x2A273F) : Color(hex: 0xFFFAF3) }  // surface
    var ink:  Color { dark ? Color(hex: 0xE0DEF4) : Color(hex: 0x575279) }  // text

    // text ramp — fades toward the base in both modes
    var txt:      Color { dark ? Color(hex: 0xE0DEF4) : Color(hex: 0x575279) }  // text
    var txtBody:  Color { dark ? Color(hex: 0x908CAA) : Color(hex: 0x6E6A8A) }  // subtle
    var txtMuted: Color { dark ? Color(hex: 0x6E6A86) : Color(hex: 0x797593) }  // muted
    var txtLabel: Color { dark ? Color(hex: 0x56526E) : Color(hex: 0x9893A5) }  // highlightHigh / muted
    var txtGhost: Color { dark ? Color(hex: 0x44415A) : Color(hex: 0xB6B1C0) }  // highlightMed

    // hairlines — Moon overlay/highlight ramp in dark, Dawn in light
    var lineFaint:  Color { dark ? Color(hex: 0x2A283E) : Color(hex: 0xF4EDE8) }  // highlightLow
    var line:       Color { dark ? Color(hex: 0x393552) : Color(hex: 0xDFDAD9) }  // overlay
    var lineStrong: Color { dark ? Color(hex: 0x44415A) : Color(hex: 0xCECACD) }  // highlightMed
    var lineHover:  Color { dark ? Color(hex: 0x56526E) : Color(hex: 0x9893A5) }  // highlightHigh

    // accent — the gold voice: Moon gold (dark) / Dawn gold (light).
    // Terminal/live voice is always warm gold — that's the identity.
    var accent:     Color { dark ? Color(hex: 0xF6C177) : Color(hex: 0xEA9D34) }
    /// Interactive accents (buttons, tints): brand accent on Linux — there is
    /// no public system-accent API equivalent to macOS controlAccentColor.
    var interactiveAccent: Color { accent }
    var accentDim:  Color { accent.opacity(dark ? 0.16 : 0.14) }
    var accentLine: Color { accent.opacity(dark ? 0.45 : 0.50) }

    // glass fill for popovers (near-opaque frost)
    var panel: Color { dark ? Color(hex: 0x2A273F).opacity(0.94) : Color(hex: 0xFFFBF3).opacity(0.93) }
    var glassFill:  Color { dark ? Color(hex: 0x393552).opacity(0.55) : .white.opacity(0.42) }
    var glassFill2: Color { dark ? Color(hex: 0x393552).opacity(0.35) : .white.opacity(0.28) }
    var glassBorder: Color { dark ? Color(hex: 0x56526E).opacity(0.70) : .white.opacity(0.75) }

    // tool-kind semantics (Rosé Pine: pine/foam/iris/rose)
    var cEdit:    Color { accent }
    var cBash:    Color { dark ? Color(hex: 0x9CCFD8) : Color(hex: 0x56949F) }  // foam
    var cLsp:     Color { dark ? Color(hex: 0xC4A7E7) : Color(hex: 0x907AA9) }  // iris
    var cTask:    Color { dark ? Color(hex: 0x3E8FB0) : Color(hex: 0x286983) }  // pine
    var cAdvisor: Color { dark ? Color(hex: 0xEA9A97) : Color(hex: 0xB4637A) }  // rose / love
    var cOk:      Color { dark ? Color(hex: 0x9CCFD8) : Color(hex: 0x56949F) }  // foam

    var lockFg: Color { dark ? Color(hex: 0xE0DEF4) : Color(hex: 0x575279) }

    // syntax coloring (Rosé Pine dark / dawn) — the palette the whole theme draws from
    var synKeyword:  Color { dark ? Color(hex: 0xC4A7E7) : Color(hex: 0x907AA9) }  // iris — control/keywords
    var synString:   Color { dark ? Color(hex: 0x9CCFD8) : Color(hex: 0x56949F) }  // foam — strings
    var synNumber:   Color { dark ? Color(hex: 0xF6C177) : Color(hex: 0xEA9D34) }  // gold — numbers/consts
    var synType:     Color { dark ? Color(hex: 0x3E8FB0) : Color(hex: 0x286983) }  // pine — types/builtins
    var synFunction: Color { dark ? Color(hex: 0xEA9A97) : Color(hex: 0xD7827E) }  // rose — function calls
    var synComment:  Color { dark ? Color(hex: 0x6E6A86) : Color(hex: 0x9893A5) }  // muted — comments

    // diff line tints
    var diffAdd:   Color { dark ? Color(hex: 0x9CCFD8) : Color(hex: 0x56949F) }  // foam
    var diffAddBG: Color { diffAdd.opacity(0.14) }
    var diffDel:   Color { dark ? Color(hex: 0xEB6F92) : Color(hex: 0xB4637A) }  // love
    var diffDelBG: Color { diffDel.opacity(0.14) }

    // ==highlight== marker background (accent-tinted, switches with mode)
    var highlightBG: Color { accent.opacity(dark ? 0.22 : 0.18) }

    // radii — sharp-ish
    let r: Double = 16
    let rLg: Double = 22
}
