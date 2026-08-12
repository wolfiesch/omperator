//  ViewExtras.swift (Linux)
//  Shared view-layer helpers replacing SwiftUI-only Theme.swift machinery
//  (GlassBG / EtchedBG / PressStyle). This is the SINGLE declaration point —
//  view ports call these names; nobody else defines them.
//
//  GTK4 has no materials/glass effects, so these are faithful approximations:
//  translucent fills + hairline borders + rounded corners using the theme
//  tokens, matching the macOS fallback (macOS 15) path of GlassBG.

import SwiftCrossUI

extension View {
    /// Glass card: translucent fill (panel for popovers, glassFill otherwise),
    /// hairline border, rounded corners. Approximates macOS GlassBG.
    func glass(
        _ t: Theme,
        _ radius: Double = 22,
        flat: Bool = false,
        active: Bool = false,
        panel: Bool = false,
        border: Bool = true,
        interactive: Bool? = nil
    ) -> some View {
        let fill = panel ? t.panel : t.glassFill
        let r = radius
        // LINUX-FIX: the border must NOT be an .overlay stroke — GtkBackend
        // stacks overlay children above the content and the stroked shape's
        // DrawingArea has can-target=true, so it swallows clicks and wrapped
        // entries (composer, palette search) can never take focus. Draw the
        // hairline as a background ring instead: border fill + inset fill.
        return self.background {
            ZStack {
                RoundedRectangle(cornerRadius: r)
                    .fill(border ? t.glassBorder.opacity(0.6) : .clear)
                RoundedRectangle(cornerRadius: r)
                    .fill(active ? t.accent.opacity(0.15) : fill)
                    .padding(border ? 1 : 0)
            }
        }
    }

    /// Press feedback: no-op on Linux (SwiftCrossUI has no button-style
    /// system). Kept so ported call sites stay identical to the macOS source.
    func press() -> some View {
        self
    }

    /// Etched chip: translucent recessed fill + hairline, no border stroke.
    /// Approximates macOS EtchedBG.
    func etched(_ t: Theme, tint: Color? = nil, radius: Double = 2) -> some View {
        let dark = t.mode == .dark
        let fill = tint ?? (dark ? Color.white.opacity(0.035) : Color.black.opacity(0.035))
        let r = radius
        // LINUX-FIX: same overlay click-eating hazard as glass() — hairline
        // is a background ring, never an overlay stroke.
        return self.background {
            ZStack {
                RoundedRectangle(cornerRadius: r).fill(t.line)
                RoundedRectangle(cornerRadius: r).fill(fill).padding(1)
            }
        }
    }
}

/// Pulsing live dot: static accent dot on Linux (no animation system).
struct LiveDot: View {
    let t: Theme
    var size: Double = 7

    var body: some View {
        Circle()
            .fill(t.accent)
            .frame(width: size, height: size)
            .overlay {
                Circle().stroke(t.accentLine)
            }
    }
}

/// A plain-text action that avoids GTK's grey Button chrome. SwiftCrossUI's
/// `Button` maps to a native Gtk.Button which always draws a grey box; this
/// renders the label as text with a tap gesture instead. Styling (font,
/// foregroundColor, background) is applied at the call site on the Text.
struct T4TextButton: View {
    let label: String
    let action: () -> Void

    @Environment(\.isEnabled) private var isEnabled

    init(_ label: String, action: @escaping () -> Void = {}) {
        self.label = label
        self.action = action
    }

    var body: some View {
        Text(label)
            .onTapGesture {
                if isEnabled { action() }
            }
    }
}
