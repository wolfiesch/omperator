//  Theme.swift
//  Enclave design tokens — Vertical Rectangle brutalist-glass. Dark = VR mono +
//  amber. Light = Rosé Pine Dawn (gold accent). Sharp-ish corners, hairline depth,
//  restrained frost. Terminal voice = VT323 in the accent. Everything keys off Theme.

import SwiftUI

let sessionCardMaxWidth: CGFloat = 340

enum Appearance: String { case system, dark, light }

@MainActor
final class ThemeStore: ObservableObject {
    // Default off the bat: follow the system appearance (persisted once the user toggles).
    @Published var mode: Appearance = {
        Appearance(rawValue: UserDefaults.standard.string(forKey: "enclave.theme") ?? "system") ?? .system
    }() {
        didSet { UserDefaults.standard.set(mode.rawValue, forKey: "enclave.theme") }
    }
    /// The live OS appearance, fed from the environment by RootView; used when mode == .system.
    @Published var systemDark = true

    /// Resolved dark/light after applying the system default.
    var effective: Appearance { mode == .system ? (systemDark ? .dark : .light) : mode }
    /// nil = follow the OS; otherwise force the chosen appearance.
    var preferredScheme: ColorScheme? { mode == .system ? nil : (mode == .dark ? .dark : .light) }

    func toggle() { withAnimation(.easeInOut(duration: 0.35)) { mode = effective == .dark ? .light : .dark } }
    var t: Theme { Theme(effective) }
}

struct Theme {
    let mode: Appearance
    init(_ m: Appearance) { mode = m }
    private var dark: Bool { mode == .dark }

    // ground / figure
    var bg:   Color { dark ? Color(hex: 0x000000) : Color(hex: 0xFAF4ED) }
    var bg2:  Color { dark ? Color(hex: 0x060606) : Color(hex: 0xFFFAF3) }
    var ink:  Color { dark ? .white : Color(hex: 0x575279) }

    // alpha-white / Rosé Pine ramp
    var txt:      Color { dark ? .white                       : Color(hex: 0x575279) }
    var txtBody:  Color { dark ? .white.opacity(0.80)         : Color(hex: 0x6E6A8A) }
    var txtMuted: Color { dark ? .white.opacity(0.58)         : Color(hex: 0x797593) }
    var txtLabel: Color { dark ? .white.opacity(0.40)         : Color(hex: 0x9893A5) }
    var txtGhost: Color { dark ? .white.opacity(0.25)         : Color(hex: 0xB6B1C0) }

    var lineFaint:  Color { dark ? .white.opacity(0.06) : Color(hex: 0xF4EDE8) }
    var line:       Color { dark ? .white.opacity(0.15) : Color(hex: 0xDFDAD9) }
    var lineStrong: Color { dark ? .white.opacity(0.22) : Color(hex: 0xCECACD) }
    var lineHover:  Color { dark ? .white.opacity(0.50) : Color(hex: 0x9893A5) }

    // accent — ice blue-silver (dark, goth Frutiger Aero) / gold (light): the live/terminal voice
    var accent:     Color { dark ? Color(hex: 0xC8D6E5) : Color(hex: 0xEA9D34) }
    var accentDim:  Color { accent.opacity(dark ? 0.16 : 0.14) }
    var accentLine: Color { accent.opacity(dark ? 0.45 : 0.50) }

    // glass fill for popovers (near-opaque frost)
    var panel: Color { dark ? Color(hex: 0x0C0C0E).opacity(0.92) : Color(hex: 0xFFFBF3).opacity(0.93) }
    var glassFill:  Color { dark ? .white.opacity(0.05) : .white.opacity(0.42) }
    var glassFill2: Color { dark ? .white.opacity(0.03) : .white.opacity(0.28) }
    var glassBorder: Color { dark ? .white.opacity(0.16) : .white.opacity(0.75) }

    // tool-kind semantics (Rosé Pine: pine/foam/iris/love)
    var cEdit:    Color { accent }
    var cBash:    Color { dark ? Color(hex: 0x7FD6C8) : Color(hex: 0x56949F) }  // foam
    var cLsp:     Color { dark ? Color(hex: 0xB9A3E3) : Color(hex: 0x907AA9) }  // iris
    var cTask:    Color { dark ? Color(hex: 0x7BB8D4) : Color(hex: 0x286983) }  // pine
    var cAdvisor: Color { dark ? Color(hex: 0xE8919F) : Color(hex: 0xB4637A) }  // love
    var cOk:      Color { dark ? Color(hex: 0x86E0B0) : Color(hex: 0x56949F) }

    var lockFg: Color { dark ? .white : Color(hex: 0x575279) }

    // syntax coloring (Rosé Pine dark / dawn) — the palette the whole theme draws from
    var synKeyword:  Color { dark ? Color(hex: 0xC4A7E7) : Color(hex: 0x907AA9) }  // iris — control/keywords
    var synString:   Color { dark ? Color(hex: 0x9CCFD8) : Color(hex: 0x56949F) }  // foam — strings
    var synNumber:   Color { dark ? Color(hex: 0xF6C177) : Color(hex: 0xEA9D34) }  // gold — numbers/consts
    var synType:     Color { dark ? Color(hex: 0x3E8FB0) : Color(hex: 0x286983) }  // pine — types/builtins
    var synFunction: Color { dark ? Color(hex: 0xEBBCBA) : Color(hex: 0xD7827E) }  // rose — function calls
    var synComment:  Color { dark ? Color(hex: 0x6E6A86) : Color(hex: 0x9893A5) }  // muted — comments
    // diff line tints
    var diffAdd:   Color { dark ? Color(hex: 0x86E0B0) : Color(hex: 0x56949F) }
    var diffAddBG: Color { diffAdd.opacity(0.14) }
    var diffDel:   Color { dark ? Color(hex: 0xE8919F) : Color(hex: 0xB4637A) }
    var diffDelBG: Color { diffDel.opacity(0.14) }
    // ==highlight== marker background (accent-tinted, switches with mode)
    var highlightBG: Color { accent.opacity(dark ? 0.22 : 0.18) }
    // radii — sharp-ish
    let r: CGFloat = 16
    let rLg: CGFloat = 22
}

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB,
                  red:   Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue:  Double(hex & 0xFF) / 255)
    }
}

// MARK: - Type ramp (Inter stand-in via system; VT323 for terminal voice)

extension Font {
    static func disp(_ s: CGFloat) -> Font { .system(size: s, weight: .black) }      // 900 uppercase display
    static func labl(_ s: CGFloat) -> Font { .system(size: s, weight: .bold) }        // wide-tracked labels
    static func term(_ s: CGFloat) -> Font { .custom("VT323-Regular", size: s) }      // amber terminal voice
    static func bodyF(_ s: CGFloat) -> Font { .system(size: s, weight: .regular) }
    static func serif(_ s: CGFloat) -> Font { .system(size: s, design: .serif) }      // New York — agent prose
    static func num(_ s: CGFloat) -> Font { .system(size: s, weight: .semibold).monospacedDigit() }
}

// MARK: - Glass material — restrained frost, hairline, sharp-ish

struct GlassBG: ViewModifier {
    let t: Theme
    var radius: CGFloat = 22
    var flat = false
    var active = false
    var panel = false
    var border = true
    var interactive: Bool? = nil
    func body(content: Content) -> some View {
        // flat/panel/border are kept for backward compatibility; native Liquid Glass
        // does not expose equivalent variants and renders its own edge.
        let isInteractive = interactive ?? active
        let glass: Glass = active
            ? .regular.tint(t.accent.opacity(0.15)).interactive(isInteractive)
            : .regular
        content
            .glassEffect(glass, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
    }
}

extension View {
    func glass(_ t: Theme, _ radius: CGFloat = 22, flat: Bool = false, active: Bool = false, panel: Bool = false, border: Bool = true, interactive: Bool? = nil) -> some View {
        modifier(GlassBG(t: t, radius: radius, flat: flat, active: active, panel: panel, border: border, interactive: interactive))
    }
    func press() -> some View { buttonStyle(PressStyle()) }
    func etched(_ t: Theme, tint: Color? = nil, radius: CGFloat = 2) -> some View {
        modifier(EtchedBG(t: t, tint: tint, radius: radius))
    }
}

/// Etched-glass chip: no border stroke. A translucent fill creates a shallow
/// depression; inner top-edge highlight + bottom-edge shadow sell the illusion
/// that the label was die-stamped into the glass — not a sticker on top of it.
/// `tint` sets the fill (accentDim for active chips); omit for a neutral recess.
struct EtchedBG: ViewModifier {
    let t: Theme
    var tint: Color? = nil
    var radius: CGFloat = 2
    func body(content: Content) -> some View {
        let dark = t.mode == .dark
        let fill = tint ?? (dark ? Color.white.opacity(0.035) : Color.black.opacity(0.035))
        content
            .background(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(fill)
            )
            .overlay(
                // top inner-edge highlight
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .stroke(LinearGradient(colors: [
                        dark ? Color.white.opacity(0.10) : Color.white.opacity(0.7),
                        .clear
                    ], startPoint: .top, endPoint: .bottom), lineWidth: 0.5)
            )
            .overlay(
                // bottom inner-edge shadow
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .stroke(LinearGradient(colors: [
                        .clear,
                        dark ? Color.black.opacity(0.20) : Color.black.opacity(0.08)
                    ], startPoint: .top, endPoint: .bottom), lineWidth: 0.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
    }
}

struct PressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.975 : 1)
            .brightness(configuration.isPressed ? 0.05 : 0)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

// pulsing live dot
struct LiveDot: View {
    let t: Theme
    var size: CGFloat = 7
    @State private var on = false
    var body: some View {
        Circle().fill(t.accent).frame(width: size, height: size)
            .overlay(Circle().stroke(t.accentLine, lineWidth: 2).scaleEffect(on ? 2.2 : 1).opacity(on ? 0 : 1))
            .animation(.easeOut(duration: 1.8).repeatForever(autoreverses: false), value: on)
            .onAppear { on = true }
    }
}

// hairline spec grid cell
struct SpecCell: View {
    let t: Theme; let k: String; let v: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(k.uppercased()).font(.labl(9)).tracking(1.6).foregroundStyle(t.txtLabel)
            Text(v).font(.num(13)).foregroundStyle(t.txt)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(11)
        .overlay(Rectangle().stroke(t.line, lineWidth: 0.5))
    }
}
