//  MergeTests.swift
//  The Linux-only Combine Merge compat (OpenCombine 0.14 lacks Merge; the
//  store's six-way objectWillChange chain depends on it).

import Foundation
import Testing
import OpenCombine
@testable import T4CodeLinuxLib

@Suite("Merge compat")
struct MergeTests {
    @Test
    func twoWayMergeForwardsBoth() {
        let a = PassthroughSubject<Int, Never>()
        let b = PassthroughSubject<Int, Never>()
        var got: [Int] = []
        let c = a.merge(with: b).sink { got.append($0) }

        a.send(1)
        b.send(2)
        a.send(3)
        a.send(completion: .finished)
        b.send(4)
        b.send(completion: .finished)

        #expect(got == [1, 2, 3, 4])
        c.cancel()
    }

    @Test
    func sixWayChainMatchesStoreShape() {
        let s1 = PassthroughSubject<Void, Never>()
        let s2 = PassthroughSubject<Void, Never>()
        let s3 = PassthroughSubject<Void, Never>()
        let s4 = PassthroughSubject<Void, Never>()
        let s5 = PassthroughSubject<Void, Never>()
        let s6 = PassthroughSubject<Void, Never>()
        var count = 0

        let c = s1
            .merge(with: s2)
            .merge(with: s3)
            .merge(with: s4)
            .merge(with: s5)
            .merge(with: s6)
            .sink { count += 1 }

        s2.send()
        s4.send()
        s6.send()
        s1.send()

        #expect(count == 4)
        c.cancel()
    }

    @Test
    func mergeCompletesOnlyWhenAllInputsFinish() {
        let a = PassthroughSubject<Void, Never>()
        let b = PassthroughSubject<Void, Never>()
        var finished = false

        let c = a.merge(with: b).sink(
            receiveCompletion: { _ in finished = true },
            receiveValue: { _ in }
        )

        a.send(completion: .finished)
        #expect(!finished, "must not complete until both inputs finish")
        b.send(completion: .finished)
        #expect(finished, "completes once every input finished")
        c.cancel()
    }
}
