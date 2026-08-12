import Foundation
@_spi(Backends) import SwiftCrossUI
import WinUIBackend
import WinUI
import UWP
import WindowsFoundation


@MainActor
enum T4WindowsNativeWindow {
    static func setCompact(_ compact: Bool) {
        OmperatorWindowControl.setCompact(compact)
    }
}
struct T4WindowsRichText: WinUIElementRepresentable {
    typealias WinUIElementType = WinUI.TextBlock

    let segments: [T4LinuxV2MarkdownSegment]
    let dark: Bool
    let bubble: Bool
    let maxCharacters: Int?

    init(
        segments: [T4LinuxV2MarkdownSegment],
        dark: Bool,
        bubble: Bool,
        maxCharacters: Int? = nil
    ) {
        self.segments = segments
        self.dark = dark
        self.bubble = bubble
        self.maxCharacters = maxCharacters
    }

    func makeCoordinator() -> Void {}

    func makeWinUIElement(context _: Context) -> WinUI.TextBlock {
        let block = WinUI.TextBlock()
        configure(block)
        return block
    }

    func updateWinUIElement(_ block: WinUI.TextBlock, context _: Context) {
        configure(block)
        block.foreground = brush(hex: dark ? 0xE0DEF4 : 0x575279)
        block.inlines.clear()
        for segment in segments where !segment.text.isEmpty {
            let run = WinUI.Run()
            run.text = segment.text
            apply(segment.style, to: run)
            block.inlines.append(run)
        }
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        winUIElement block: WinUI.TextBlock,
        context _: Context
    ) -> ViewSize {
        let proposed = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? 960
        let width = max(1, block.maxWidth.isFinite ? min(proposed, block.maxWidth) : proposed)
        try? block.measure(WindowsFoundation.Size(width: Float(width), height: .infinity))
        let desired = block.desiredSize
        return ViewSize(
            min(width, max(1, Double(desired.width))),
            max(1, Double(desired.height))
        )
    }

    private func configure(_ block: WinUI.TextBlock) {
        block.textWrapping = .wrap
        block.textTrimming = .none
        block.isTextSelectionEnabled = true
        block.fontFamily = WinUI.FontFamily(bubble ? "Cantarell" : "Georgia")
        block.fontSize = bubble ? 15 : 18
        block.lineHeight = bubble ? 20 : 25
        block.lineStackingStrategy = .blockLineHeight
        if let maxCharacters {
            let sample = WinUI.TextBlock()
            sample.fontFamily = block.fontFamily
            sample.fontSize = block.fontSize
            sample.text = String(repeating: "0", count: maxCharacters)
            try? sample.measure(WindowsFoundation.Size(width: .infinity, height: .infinity))
            block.maxWidth = max(1, Double(sample.desiredSize.width))
        } else {
            block.maxWidth = .infinity
        }
    }

    private func apply(_ style: T4LinuxV2MarkdownStyle, to run: WinUI.Run) {
        let gold: UInt32 = dark ? 0xF6C177 : 0xEA9D34
        let body: UInt32 = dark ? 0xE0DEF4 : 0x575279
        let code: UInt32 = dark ? 0x9CCFD8 : 0x286983
        let link: UInt32 = dark ? 0xC4A7E7 : 0x907AA9
        let quote: UInt32 = dark ? 0x908CAA : 0x6E6A8A
        let add: UInt32 = dark ? 0x9CCFD8 : 0x286983
        let remove: UInt32 = dark ? 0xEB6F92 : 0xB4637A
        var weight: UInt16 = 400
        var italic = false
        var color = body

        switch style {
        case .heading1:
            color = gold
            weight = 700
            if !bubble { run.fontSize = 15 }
        case .heading2:
            color = gold
            weight = 700
            if !bubble { run.fontSize = 13 }
        case .heading3:
            color = gold
            weight = 600
        case .bold:
            color = gold
            weight = 700
        case .boldItalic:
            color = gold
            weight = 700
            italic = true
        case .italic:
            italic = true
        case .inlineCode, .codeBlock:
            color = code
            run.fontFamily = WinUI.FontFamily("DejaVu Sans Mono")
        case .link:
            color = link
            run.textDecorations = .underline
        case .quote:
            color = quote
            italic = true
        case .diffAdd:
            color = add
        case .diffRemove:
            color = remove
        case .user:
            color = gold
            weight = 600
        case .assistant, .list:
            break
        }

        var fontWeight = UWP.FontWeight()
        fontWeight.weight = weight
        run.fontWeight = fontWeight
        if italic { run.fontStyle = .italic }
        run.foreground = brush(hex: color)
    }

    private func brush(hex: UInt32, alpha: UInt8 = 255) -> WinUI.SolidColorBrush {
        T4WindowsNativeStyle.brush(hex: hex, alpha: alpha)
    }
}

struct T4WindowsFlatButton: View {
    let glyph: String
    let automationName: String
    let dark: Bool
    let width: Int?
    let action: @MainActor @Sendable () -> Void

    init(
        _ glyph: String,
        automationName: String,
        dark: Bool,
        width: Int? = nil,
        action: @escaping @MainActor @Sendable () -> Void
    ) {
        self.glyph = glyph
        self.automationName = automationName
        self.dark = dark
        self.width = width
        self.action = action
    }

    var body: some View {
        SwiftCrossUI.Button(glyph, action: action)
            ._buttonWidth(width)
            .inspect([.onCreate, .afterUpdate]) { button in
                T4WindowsNativeStyle.configureFlatButton(
                    button,
                    automationName: automationName,
                    dark: dark
                )
            }
    }
}

@MainActor
enum T4WindowsNativeStyle {
    static func brush(hex: UInt32, alpha: UInt8 = 255) -> WinUI.SolidColorBrush {
        let brush = WinUI.SolidColorBrush()
        brush.color = UWP.Color(
            a: alpha,
            r: UInt8((hex >> 16) & 0xFF),
            g: UInt8((hex >> 8) & 0xFF),
            b: UInt8(hex & 0xFF)
        )
        return brush
    }

    static func configureFlatButton(
        _ button: WinUI.Button,
        automationName: String,
        dark _: Bool
    ) {
        button.padding = WinUI.Thickness(left: 7, top: 2, right: 7, bottom: 2)
        button.minWidth = 0
        button.minHeight = 0
        WinUI.AutomationProperties.setName(button, automationName)
    }

    static func configureInput(
        _ element: WinUI.FrameworkElement,
        automationName: String,
        dark: Bool
    ) {
        WinUI.AutomationProperties.setName(element, automationName)
        guard let control = element as? WinUI.Control else { return }
        let background = brush(hex: dark ? 0x393552 : 0xFFFFFF, alpha: dark ? 140 : 166)
        let border = brush(hex: dark ? 0x56526E : 0xCECACD, alpha: dark ? 179 : 255)
        control.padding = WinUI.Thickness(left: 12, top: 8, right: 12, bottom: 8)
        control.background = background
        control.borderBrush = border
        control.borderThickness = WinUI.Thickness(left: 1, top: 1, right: 1, bottom: 1)
        control.cornerRadius = WinUI.CornerRadius(topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0)
        control.minHeight = 0
    }
}

@MainActor
enum T4WindowsClipboard {
    static func copy(_ text: String) {
        let package = UWP.DataPackage()
        try? package.setText(text)
        UWP.Clipboard.setContent(package)
        UWP.Clipboard.flush()
    }
}
