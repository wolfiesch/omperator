//  ThemeBridges.swift (Linux)
//  Observation conformance for the ThemeStore via the T4UIObservation
//  registry (see Store/T4UIObservation.swift). Views hold
//  `@State var theme = ThemeStore()` and re-render on every published change.

import SwiftCrossUI

extension ThemeStore: SwiftCrossUI.ObservableObject {
    var didChange: SwiftCrossUI.Publisher { T4UIObservation.publisher(for: self) }
}
