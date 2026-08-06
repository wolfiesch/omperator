//  ObservationBridge.swift
//  The load-bearing bridge between OpenCombine (the store's reactive layer,
//  API-identical to Apple Combine) and SwiftCrossUI's view observation.
//
//  Pattern (proven — BRIDGE-OK probe, docs/adr/026): every Combine
//  ObservableObject in the Linux app dual-conforms:
//
//    @MainActor
//    final class Model: OpenCombine.ObservableObject {
//        @OpenCombine.Published var x = 0
//        let t4Bridge = ObservationBridge()
//        init() { t4Bridge.attach(objectWillChange) }
//        // ... ported body otherwise unchanged ...
//    }
//    extension Model: SwiftCrossUI.ObservableObject {
//        nonisolated var didChange: SwiftCrossUI.Publisher { t4Bridge.publisher }
//    }
//
//  The bridge forwards every `objectWillChange` emission to a valueless
//  SwiftCrossUI publisher, which @State/@Environment observation consumes.

import OpenCombine
import SwiftCrossUI

/// Forwards an OpenCombine `objectWillChange` stream to SwiftCrossUI
/// observation. Create on the main actor alongside its model (it reads
/// `objectWillChange`), then the conformance may expose `publisher`
/// nonisolated — SwiftCrossUI's publisher is internally synchronized.
@MainActor
final class ObservationBridge {
    nonisolated(unsafe) let publisher = SwiftCrossUI.Publisher()
    private var cancellable: AnyCancellable?

    init() {}

    /// Start forwarding. Call once from the model's init.
    func attach(_ source: ObservableObjectPublisher) {
        let pub = publisher
        cancellable = source.sink { pub.send() }
    }
}
