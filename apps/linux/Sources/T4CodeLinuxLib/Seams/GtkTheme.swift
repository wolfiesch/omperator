//  GtkTheme.swift (Linux)
//  Applies the Rosé Pine theme to NATIVE Gtk widgets (entries, buttons,
//  popovers/menus, scrollbars, tooltips, switches) via a display-wide CSS
//  provider. SwiftCrossUI views theme themselves from Theme tokens; this seam
//  covers everything Gtk draws itself — the search field, composer entry,
//  connect-sheet fields, native buttons, and the model menu popover.
//
//  Token values mirror Views/Theme.swift (source of truth): dark = Rosé Pine
//  Moon, light = Rosé Pine Dawn; the gold "voice" is the accent in both.

import Foundation
import Gtk
import SwiftCrossUI

@MainActor
enum T4GtkTheme {
    private static var provider: CSSProvider?

    /// (Re)apply the palette for the given appearance. Safe to call on every
    /// theme change: the previous provider is removed when replaced.
    static func apply(_ appearance: Appearance) {
        // USER priority: SwiftCrossUI sets per-widget inline CSS at
        // APPLICATION priority, which would otherwise stomp this theme.
        let p = CSSProvider(priority: 800)
        p.loadCss(from: css(for: appearance))
        provider = p
    }

    // Palette mirrors Theme.swift — keep in sync.
    private struct Palette {
        let base, surface, ink, subtle, muted, label: String
        let lineFaint, line, lineStrong, lineHover: String
        let accent, accentDim, accentLine, panel: String
        let foam, iris, love: String

        static let moon = Palette(
            base: "#232136", surface: "#2A273F", ink: "#E0DEF4",
            subtle: "#908CAA", muted: "#6E6A86", label: "#56526E",
            lineFaint: "#2A283E", line: "#393552", lineStrong: "#44415A", lineHover: "#56526E",
            accent: "#F6C177", accentDim: "rgba(246,193,119,0.25)", accentLine: "rgba(246,193,119,0.45)",
            panel: "#2A273F",
            foam: "#9CCFD8", iris: "#C4A7E7", love: "#EB6F92"
        )
        static let dawn = Palette(
            base: "#FAF4ED", surface: "#FFFAF3", ink: "#575279",
            subtle: "#6E6A8A", muted: "#797593", label: "#9893A5",
            lineFaint: "#F4EDE8", line: "#DFDAD9", lineStrong: "#CECACD", lineHover: "#9893A5",
            accent: "#EA9D34", accentDim: "rgba(234,157,52,0.22)", accentLine: "rgba(234,157,52,0.50)",
            panel: "#FFFBF3",
            foam: "#56949F", iris: "#907AA9", love: "#B4637A"
        )
    }

    private static func css(for appearance: Appearance) -> String {
        let dark = appearance == .dark
        let p = dark ? Palette.moon : Palette.dawn
        // NOTE: keep this CSS pure ASCII — CSSProvider.loadCss passes
        // String.count (characters) as the byte length, so any non-ASCII
        // scalar truncates the parse ("Unterminated block" warnings).
        return """
        /* T4 Code - Rose Pine \(dark ? "Moon" : "Dawn") native-widget theme */
        entry {
          background-color: \(p.surface);
          background-image: none;
          color: \(p.ink);
          caret-color: \(p.accent);
          border: 1px solid \(p.line);
          border-radius: 10px;
          padding: 4px 8px;
          box-shadow: none;
        }
        entry:focus { border-color: \(p.accentLine); }
        entry:disabled { color: \(p.muted); background-color: \(p.base); }
        entry placeholder { color: \(p.label); }
        entry selection { background-color: \(p.accentDim); color: \(p.ink); }
        label selection { background-color: \(p.accentDim); color: \(p.ink); }
        textview, textview text {
          background-color: \(p.surface);
          color: \(p.ink);
          caret-color: \(p.accent);
        }
        textview selection { background-color: \(p.accentDim); }

        button {
          background-image: none;
          background-color: \(p.surface);
          color: \(p.ink);
          border: 1px solid \(p.line);
          border-radius: 10px;
          padding: 4px 12px;
          box-shadow: none;
          text-shadow: none;
        }
        button:hover { background-color: \(p.lineFaint); }
        button:active, button:checked { background-color: \(p.accentDim); }
        button:disabled { color: \(p.label); }

        popover, popover.menu, popover > contents, popover > arrow {
          background-color: \(p.panel);
          color: \(p.ink);
          border: 1px solid \(p.line);
          border-radius: 12px;
        }
        popover menuitem, popover modelbutton, popover button {
          background-color: transparent;
          border: none;
          border-radius: 8px;
          color: \(p.ink);
        }
        popover menuitem:hover, popover modelbutton:hover, popover button:hover {
          background-color: \(p.accentDim);
        }
        menubar, menu { background-color: \(p.panel); color: \(p.ink); }

        scrollbar { background: transparent; }
        scrollbar slider {
          background-color: \(p.lineStrong);
          border-radius: 4px;
          min-width: 6px;
          min-height: 6px;
        }
        scrollbar slider:hover { background-color: \(p.lineHover); }
        scrollbar slider:active { background-color: \(p.accent); }

        tooltip, tooltip > box, tooltip label {
          background-color: \(p.panel);
          color: \(p.ink);
        }
        tooltip { border: 1px solid \(p.line); border-radius: 8px; }

        switch { background-color: \(p.lineStrong); border-radius: 14px; }
        switch slider { background-color: \(p.ink); }
        switch:checked { background-color: \(p.accent); }

        checkbutton check, radio {
          background-color: \(p.surface);
          border: 1px solid \(p.lineStrong);
          color: \(p.ink);
        }
        checkbutton check:checked { background-color: \(p.accent); border-color: \(p.accent); }

        separator { background-color: \(p.line); }

        window { background-color: \(p.base); color: \(p.ink); }
        """
    }
}
