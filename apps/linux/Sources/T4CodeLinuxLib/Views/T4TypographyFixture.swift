import Foundation
import SwiftCrossUI

#if os(Windows)
import WinUI
import WinUIBackend
#elseif os(Linux)
import Gtk
import CGtk
import GtkBackend
#endif

enum T4TypographyRole: String, CaseIterable, Hashable, Sendable {
    case displayTitle = "display-title"
    case assistantBody = "assistant-paragraph"
    case transcriptWide = "transcript-wide-paragraph"
    case transcriptWideNatural = "transcript-wide-natural"
    case userBody = "user-paragraph"
    case toolResult = "tool-result-paragraph"
    case railSubtitle = "rail-subtitle"
    case settingsBody = "settings-body"

    var expectedWindowsFamily: String {
        self == .toolResult ? "DejaVu Sans Mono" : "Cantarell"
    }

    var expectedWindowsFontFile: String {
        switch self {
        case .displayTitle: "Cantarell-Bold.otf"
        case .toolResult: "DejaVuSansMono.ttf"
        default: "Cantarell-Regular.otf"
        }
    }

    var expectedFontFace: String {
        switch self {
        case .displayTitle: "Bold"
        case .toolResult: "Book"
        default: "Regular"
        }
    }
}

extension Text {
    @ViewBuilder
    func t4TypographyProbe(_ role: T4TypographyRole) -> some View {
#if os(Windows)
        inspect([.afterUpdate]) { (textBlock: WinUI.TextBlock) in
            T4WindowsTypographyDiagnostics.schedule(role: role, textBlock: textBlock)
        }
#elseif os(Linux)
        inspect([.afterUpdate]) { (label: Gtk.Label) in
            T4LinuxTypographyDiagnostics.record(role: role, label: label)
        }
#else
        self
#endif
    }
}

/// Deterministic role fixture shared by GTK and WinUI. Launch with
/// `-T4TypographyFixture` at Linux 1920x1080 or Windows 1600x900; Windows fixed
/// metrics are projected through `t4PlatformMetric` so both normalize to the
/// same comparison geometry.
public struct T4TypographyFixtureView: View {
    @State private var theme = ThemeStore()

    private static let sample = "Typography parity keeps glyph size, weight, wrapping width, and line spacing aligned across Linux and Windows without replacing either platform text renderer."
    private static let transcriptWideSample = "On it. The empty usage pane was a demo-data gap, not a render bug — the pane only had a live path. Seeding a sample `UsageReadResult` for captures, then retaking all 28 stills at 1920×1080 in **dawn** and **moon**."

    public init() {}

    private var t: Theme { theme.t }

    public var body: some View {
        ZStack {
            t.bg
            VStack(alignment: .leading, spacing: t4PlatformMetric(18)) {
                Text("Typography parity fixture")
                    .t4TypographyProbe(.displayTitle)
                    .font(.system(size: 18, weight: .bold))
                    .foregroundColor(t.txt)

                fixtureSection("Assistant paragraph") {
                    Text(Self.sample)
                        .t4TypographyProbe(.assistantBody)
                        .font(.system(size: 15))
                        .foregroundColor(t.txt)
                        .frame(width: t4PlatformMetric(780), alignment: .leading)
                }

                fixtureSection("Transcript wide paragraph") {
                    Text(Self.transcriptWideSample)
                        .t4TypographyProbe(.transcriptWide)
                        .font(.system(size: 15))
                        .foregroundColor(t.txt)
                        .frame(width: t4PlatformMetric(1568), alignment: .leading)
                }

                fixtureSection("Transcript wide natural advance") {
                    Text(Self.transcriptWideSample)
                        .t4TypographyProbe(.transcriptWideNatural)
                        .font(.system(size: 15))
                        .foregroundColor(t.txt)
                        .lineLimit(1)
                        .frame(width: t4PlatformMetric(1568), alignment: .leading)
                }

                fixtureSection("User paragraph") {
                    Text(Self.sample)
                        .t4TypographyProbe(.userBody)
                        .font(.system(size: 15))
                        .foregroundColor(t.txt)
                        .frame(width: t4PlatformMetric(700), alignment: .leading)
                        .padding(.horizontal, t4PlatformMetric(12))
                        .padding(.vertical, t4PlatformMetric(9))
                        .background {
                            RoundedRectangle(cornerRadius: t4PlatformMetric(14))
                                .fill(t.glassFill)
                        }
                }

                fixtureSection("Tool result paragraph") {
                    Text(Self.sample)
                        .t4TypographyProbe(.toolResult)
                        .font(.term(12))
                        .foregroundColor(t.txt)
                        .frame(width: t4PlatformMetric(780), alignment: .leading)
                        .padding(t4PlatformMetric(10))
                        .background(t.glassFill2)
                        .cornerRadius(t4PlatformMetric(10))
                }

                HStack(alignment: .top, spacing: t4PlatformMetric(30)) {
                    fixtureSection("Rail subtitle") {
                        Text(Self.sample)
                            .t4TypographyProbe(.railSubtitle)
                            .font(.system(size: 10))
                            .foregroundColor(t.txtLabel)
                            .frame(width: t4PlatformMetric(270), alignment: .leading)
                    }

                    fixtureSection("Settings body") {
                        Text(Self.sample)
                            .t4TypographyProbe(.settingsBody)
                            .font(.system(size: 12))
                            .foregroundColor(t.txtMuted)
                            .frame(width: t4PlatformMetric(400), alignment: .leading)
                    }
                }
            }
            .padding(t4PlatformMetric(32))
            .frame(width: t4PlatformMetric(1632), alignment: .leading)
        }
        .colorScheme(theme.effective == .dark ? .dark : .light)
        .foregroundColor(t.txt)
#if os(Linux)
        .task { T4GtkTheme.apply(theme.effective) }
        .onChange(of: theme.effective) { T4GtkTheme.apply(theme.effective) }
#endif
    }

    @ViewBuilder
    private func fixtureSection<Content: View>(
        _ title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: t4PlatformMetric(6)) {
            Text(title.uppercased())
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(t.txtLabel)
            content()
        }
    }
}

#if os(Windows)
@MainActor
private enum T4WindowsTypographyDiagnostics {
    private struct NativeSample: Codable {
        let role: String
        let expectedFontFamily: String
        let expectedFontFile: String
        let expectedFontFace: String
        let resolvedFontFamily: String
        let fallbackDetected: Bool
        let fontSize: Double
        let rasterizationScale: Double
        let rasterizedFontSize: Double
        let fontWeight: Int
        let fontStyle: String
        let lineHeight: Double
        let rasterizedLineHeight: Double
        let lineStackingStrategy: String
        let characterSpacing: Int
        let wrapping: String
        let actualWidth: Double
        let actualHeight: Double
        let desiredWidth: Double
        let desiredHeight: Double
        let text: String
    }

    private struct Report: Codable {
        let fontRegistrationComplete: Bool
        let expectedSansFontFile: String
        let expectedMonospacedFontFile: String
        let fallbackDetected: Bool
        let samples: [String: NativeSample]
    }

    private static let reportURL: URL? = ProcessInfo.processInfo.arguments
        .first(where: { $0.hasPrefix("-T4TypographyReport=") })
        .map { String($0.dropFirst("-T4TypographyReport=".count)) }
        .flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) }
    private static var samples: [String: NativeSample] = [:]
    private static var scheduled: Set<T4TypographyRole> = []

    static func schedule(role: T4TypographyRole, textBlock: WinUI.TextBlock) {
        guard reportURL != nil,
              samples[role.rawValue] == nil,
              scheduled.insert(role).inserted
        else { return }

        Task { @MainActor in
            for _ in 0..<20 {
                try? await Task.sleep(nanoseconds: 50_000_000)
                if textBlock.actualWidth > 0, textBlock.actualHeight > 0 {
                    record(role: role, textBlock: textBlock)
                    scheduled.remove(role)
                    return
                }
            }
            record(role: role, textBlock: textBlock)
            scheduled.remove(role)
        }
    }

    private static func record(role: T4TypographyRole, textBlock: WinUI.TextBlock) {

        let resolvedFamily = textBlock.fontFamily.source
        let expectedFamily = role.expectedWindowsFamily
        let rasterizationScale = textBlock.xamlRoot?.rasterizationScale ?? 1
        let sample = NativeSample(
            role: role.rawValue,
            expectedFontFamily: expectedFamily,
            expectedFontFile: role.expectedWindowsFontFile,
            expectedFontFace: role.expectedFontFace,
            resolvedFontFamily: resolvedFamily,
            fallbackDetected: resolvedFamily.caseInsensitiveCompare(expectedFamily) != .orderedSame,
            fontSize: textBlock.fontSize,
            rasterizationScale: rasterizationScale,
            rasterizedFontSize: textBlock.fontSize * rasterizationScale,
            fontWeight: Int(textBlock.fontWeight.weight),
            fontStyle: textBlock.fontStyle == .italic ? "italic" : "normal",
            lineHeight: textBlock.lineHeight,
            rasterizedLineHeight: textBlock.lineHeight * rasterizationScale,
            lineStackingStrategy: lineStackingStrategy(textBlock.lineStackingStrategy),
            characterSpacing: Int(textBlock.characterSpacing),
            wrapping: wrapping(textBlock.textWrapping),
            actualWidth: textBlock.actualWidth,
            actualHeight: textBlock.actualHeight,
            desiredWidth: Double(textBlock.desiredSize.width),
            desiredHeight: Double(textBlock.desiredSize.height),
            text: textBlock.text
        )
        samples[role.rawValue] = sample
        persist()
    }

    private static func persist() {
        guard let reportURL else { return }
        let report = Report(
            fontRegistrationComplete: T4WindowsFonts.areBundledFontsRegistered,
            expectedSansFontFile: "Cantarell-Regular.otf",
            expectedMonospacedFontFile: "DejaVuSansMono.ttf",
            fallbackDetected: samples.values.contains(where: \.fallbackDetected),
            samples: samples
        )
        do {
            try FileManager.default.createDirectory(
                at: reportURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(report).write(to: reportURL, options: .atomic)
        } catch {
            fatalError("Unable to write typography diagnostics: \(error)")
        }
    }

    private static func wrapping(_ value: WinUI.TextWrapping) -> String {
        switch value {
        case .noWrap: "no-wrap"
        case .wrap: "wrap"
        case .wrapWholeWords: "wrap-whole-words"
        default: "unknown"
        }
    }

    private static func lineStackingStrategy(_ value: WinUI.LineStackingStrategy) -> String {
        switch value {
        case .maxHeight: "max-height"
        case .blockLineHeight: "block-line-height"
        case .baselineToBaseline: "baseline-to-baseline"
        default: "unknown"
        }
    }
}
#endif

#if os(Linux)
@MainActor
private enum T4LinuxTypographyDiagnostics {
    private struct NativeSample: Codable {
        let role: String
        let expectedFontFamily: String
        let fontFamilyRequest: String
        let resolvedFontDescription: String
        let resolvedFontFamily: String
        let resolvedFontStyle: String
        let resolvedFontWeight: Int
        let css: String
        let wrapping: Bool
        let lineLimit: Int
        let naturalWidth: Int
        let naturalHeight: Int
        let minimumMeasuredWidth: Int
        let naturalMeasuredWidth: Int
        let minimumMeasuredHeight: Int
        let naturalMeasuredHeight: Int
        let text: String
    }

    private struct Report: Codable {
        let expectedSansFontconfigFamily: String
        let expectedMonospacedFontconfigFamily: String
        let samples: [String: NativeSample]
    }

    private static let reportURL: URL? = ProcessInfo.processInfo.arguments
        .first(where: { $0.hasPrefix("-T4TypographyReport=") })
        .map { String($0.dropFirst("-T4TypographyReport=".count)) }
        .flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) }
    private static var samples: [String: NativeSample] = [:]
    private static var scheduled: Set<String> = []

    static func record(role: T4TypographyRole, label: Gtk.Label) {
        guard reportURL != nil,
              samples[role.rawValue] == nil,
              scheduled.insert(role.rawValue).inserted
        else { return }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 250_000_000)
            recordNow(role: role, label: label)
            scheduled.remove(role.rawValue)
        }
    }

    private static func recordNow(role: T4TypographyRole, label: Gtk.Label) {
        guard samples[role.rawValue] == nil else { return }
        let resolvedFont = resolvedFont(for: label)
        let naturalSize = label.getNaturalSize()
        let horizontal = label.measure(orientation: .horizontal, forPerpendicularSize: -1)
        let vertical = label.measure(
            orientation: .vertical,
            forPerpendicularSize: naturalSize.width
        )
        samples[role.rawValue] = NativeSample(
            role: role.rawValue,
            expectedFontFamily: role.expectedWindowsFamily,
            fontFamilyRequest: role == .toolResult ? "monospace" : "sans-serif",
            resolvedFontDescription: resolvedFont.description,
            resolvedFontFamily: resolvedFont.family,
            resolvedFontStyle: resolvedFont.style,
            resolvedFontWeight: resolvedFont.weight,
            css: label.css.stringRepresentation,
            wrapping: label.wrap,
            lineLimit: label.lines,
            naturalWidth: naturalSize.width,
            naturalHeight: naturalSize.height,
            minimumMeasuredWidth: horizontal.minimum,
            naturalMeasuredWidth: horizontal.natural,
            minimumMeasuredHeight: vertical.minimum,
            naturalMeasuredHeight: vertical.natural,
            text: label.label
        )
        persist()
    }

    private struct ResolvedFont {
        let description: String
        let family: String
        let style: String
        let weight: Int
    }

    private static func resolvedFont(for label: Gtk.Label) -> ResolvedFont {
        let layout = gtk_label_get_layout(OpaquePointer(label.widgetPointer))
        guard let iterator = pango_layout_get_iter(layout) else {
            return ResolvedFont(description: "unresolved", family: "unresolved", style: "unknown", weight: 0)
        }
        defer { pango_layout_iter_free(iterator) }
        guard let run = pango_layout_iter_get_run_readonly(iterator),
              let font = run.pointee.item.pointee.analysis.font,
              let description = pango_font_describe(font)
        else {
            return ResolvedFont(description: "unresolved", family: "unresolved", style: "unknown", weight: 0)
        }
        defer { pango_font_description_free(description) }
        let family = pango_font_description_get_family(description).map(String.init(cString:)) ?? "unresolved"
        let renderedDescription: String
        if let descriptionString = pango_font_description_to_string(description) {
            renderedDescription = String(cString: descriptionString)
            g_free(descriptionString)
        } else {
            renderedDescription = "unresolved"
        }
        let style: String = switch pango_font_description_get_style(description) {
        case PANGO_STYLE_ITALIC: "italic"
        case PANGO_STYLE_OBLIQUE: "oblique"
        default: "normal"
        }
        return ResolvedFont(
            description: renderedDescription,
            family: family,
            style: style,
            weight: Int(pango_font_description_get_weight(description).rawValue)
        )
    }
    private static func persist() {
        guard let reportURL else { return }
        let report = Report(
            expectedSansFontconfigFamily: "Cantarell",

            expectedMonospacedFontconfigFamily: "DejaVu Sans Mono",
            samples: samples
        )
        do {
            try FileManager.default.createDirectory(
                at: reportURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(report).write(to: reportURL, options: .atomic)
        } catch {
            fatalError("Unable to write Linux typography diagnostics: \(error)")
        }
    }
}
#endif
