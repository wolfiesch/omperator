import Foundation
import OpenCombine

// Linux compatibility shims for Apple-only symbols referenced by the shared
// store sources (symlinked from apps/ios/Sources). Everything here mirrors the
// Apple-side declarations so the shared code compiles unchanged; no logic
// differences beyond what each seam documents.

// MARK: - OpenCombine gaps (0.14 lacks Merge/MergeMany)

/// Combine-compatible `merge(with:)` for the store's objectWillChange chains
/// (T4SessionStore.init merges six model publishers). OpenCombine 0.14 does
/// not ship Merge/MergeMany; this mirrors Combine's semantics: emissions
/// from all inputs are forwarded, first failure wins, completion waits for
/// every input.
extension Publisher {
    func merge<P>(with other: P) -> Publishers.Merge<Self, P>
        where P: Publisher, P.Output == Output, P.Failure == Failure
    {
        Publishers.Merge(first: self, second: other)
    }
}

extension Publishers {
    struct Merge<A: Publisher, B: Publisher>: Publisher where A.Output == B.Output, A.Failure == B.Failure {
        typealias Output = A.Output
        typealias Failure = A.Failure

        let first: A
        let second: B

        func receive<S: Subscriber>(subscriber: S) where S.Input == Output, S.Failure == Failure {
            let inner = Inner(downstream: subscriber)
            subscriber.receive(subscription: inner)
            inner.first = Inner.Half(parent: inner, isLeft: true)
            inner.second = Inner.Half(parent: inner, isLeft: false)
            first.subscribe(inner.first!)
            second.subscribe(inner.second!)
        }

        private final class Inner<Downstream: Subscriber>: Subscription
            where Downstream.Input == Output, Downstream.Failure == Failure {
            private var downstream: Downstream?
            var first: Half?
            var second: Half?
            private var firstSub: Subscription?
            private var secondSub: Subscription?
            private var firstDone = false
            private var secondDone = false
            private var demand: Subscribers.Demand = .none
            private let lock = NSLock()

            init(downstream: Downstream) {
                self.downstream = downstream
            }

            final class Half: Subscriber {
                typealias Input = A.Output
                typealias Failure = A.Failure
                private let parent: Inner
                private let isLeft: Bool
                init(parent: Inner, isLeft: Bool) {
                    self.parent = parent
                    self.isLeft = isLeft
                }
                func receive(subscription: Subscription) {
                    parent.setSubscription(subscription, left: isLeft)
                }
                func receive(_ input: Input) -> Subscribers.Demand {
                    parent.forward(input)
                }
                func receive(completion: Subscribers.Completion<Failure>) {
                    parent.complete(completion, left: isLeft)
                }
            }

            func request(_ demand: Subscribers.Demand) {
                lock.lock()
                self.demand += demand
                let first = firstSub
                let second = secondSub
                lock.unlock()
                first?.request(demand)
                second?.request(demand)
            }

            func cancel() {
                lock.lock()
                let first = firstSub
                let second = secondSub
                firstSub = nil
                secondSub = nil
                downstream = nil
                lock.unlock()
                first?.cancel()
                second?.cancel()
            }

            fileprivate func setSubscription(_ s: Subscription, left isLeft: Bool) {
                lock.lock()
                if isLeft { firstSub = s } else { secondSub = s }
                let demand = self.demand
                lock.unlock()
                s.request(demand)
            }

            fileprivate func forward(_ input: Output) -> Subscribers.Demand {
                lock.lock()
                let downstream = self.downstream
                lock.unlock()
                return downstream?.receive(input) ?? .none
            }

            fileprivate func complete(_ completion: Subscribers.Completion<Failure>, left isLeft: Bool) {
                lock.lock()
                if isLeft { firstDone = true } else { secondDone = true }
                let allDone = firstDone && secondDone
                let downstream = self.downstream
                if allDone { self.downstream = nil }
                lock.unlock()
                switch completion {
                case .finished:
                    if allDone { downstream?.receive(completion: .finished) }
                case .failure(let e):
                    downstream?.receive(completion: .failure(e))
                }
            }
        }
    }
}

/// Linux stand-in for Apple's `PlatformImage` (UIImage on iOS, NSImage on
/// macOS; see apps/ios/Sources/Platform.swift). The shared store layer only
/// carries capture bytes opaquely — it stores, passes, and compares these
/// values, never decodes them. Decoding/rendering is the wave-2 view layer's
/// job (GdkPixbuf over the bytes).
public struct PlatformImage: Equatable {
    public let data: Data

    public init(data: Data) {
        self.data = data
    }
}

/// Mirror of apps/ios/Sources/Platform.swift's `platformImage(data:)` factory.
/// Apple's version validates decodability via UIImage/NSImage; without a
/// decoder in the store layer the Linux seam only rejects empty payloads
/// (the host already SHA-256-verified the bytes before they arrive here).
public func platformImage(data: Data) -> PlatformImage? {
    data.isEmpty ? nil : PlatformImage(data: data)
}
