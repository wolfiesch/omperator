import Dispatch
import Foundation
import OpenCombine
import SwiftCrossUI

/// Linux observation bridge: maps each OpenCombine model instance to a
/// valueless SwiftCrossUI publisher that mirrors objectWillChange.
/// App-lifetime singletons only (store, domain models, ThemeStore).
@MainActor
enum T4UIObservation {
    private static var table: [ObjectIdentifier: Forwarder] = [:]

    /// Returns the shared SwiftCrossUI publisher for `object`, creating it on
    /// first access and keeping it alive (with its OpenCombine subscription)
    /// for the process lifetime.
    static func publisher<Object: OpenCombine.ObservableObject>(
        for object: Object
    ) -> SwiftCrossUI.Publisher where Object.ObjectWillChangePublisher.Output == Void, Object.ObjectWillChangePublisher.Failure == Never {
        let key = ObjectIdentifier(object)
        if let forwarder = table[key] { return forwarder.pub }
        let forwarder = Forwarder(source: object.objectWillChange, label: String(describing: type(of: object)))
        table[key] = forwarder
        return forwarder.pub
    }
}

/// Forwards OpenCombine `objectWillChange` to a SwiftCrossUI publisher with
/// producer-side burst coalescing: a run of emissions (streaming transcript
/// tokens, inventory churn) collapses into one UI update per main-loop pass
/// instead of one re-render per emission. SwiftCrossUI's consumer side
/// already merges (`observeOnMainThreadAvoidingStarvation`); this kills the
/// per-node scheduling churn upstream of it.
private final class Forwarder {
    let pub = SwiftCrossUI.Publisher()
    private var keep: AnyCancellable?
    private let label: String

    /// Quiet window per model, measured from the last SEND. Emissions inside
    /// the window are dropped: the send's UI pass runs synchronously right
    /// after it, and the pass itself re-enters GTK machinery that re-publishes
    /// observed models (verified against a live session: the layout's own
    /// emissions schedule the next pass, and the main thread livelocks — the
    /// app "freezes" on connected session views). Dropping is safe because the
    /// running pass reads the models live, and every real change (host frame,
    /// interaction) re-publishes once the window lapses. The window tracks the
    /// pass's MEASURED duration (see the send block), so fast hardware paints
    /// at the floor and slow passes cover themselves — no heuristic growth.
    private static var quietWindow: [String: Duration] = [:]
    private static var lastSendAt: [String: ContinuousClock.Instant] = [:]
    private static let quietWindowCap: Duration = .seconds(2)

    init<P: OpenCombine.Publisher>(source: P, label: String) where P.Output == Void, P.Failure == Never {
        self.label = label
        keep = source.sink { [weak self] _ in
            self?.schedule()
        }
    }

    /// The store's @Published setters are @MainActor, so emissions arrive on
    /// the main thread. Coalesce a burst of emissions into one send per
    /// quiet window: live sessions stream transcript updates continuously,
    /// and without a ceiling every stream event triggers a full workspace
    /// re-layout, which is what makes scrolling a slideshow.
    private func schedule() {
        // 100ms floor: when passes are cheap (real hardware) streaming paints
        // at ~10Hz and reads as continuous flow. When a pass is slower than
        // the floor the measured send cost below widens the window to match,
        // so a pass's own re-entrant emissions always land inside it.
        let minimum: Duration = .milliseconds(100)
        let now = ContinuousClock.now
        let window = Self.quietWindow[label] ?? minimum
        let last = Self.lastSendAt[label] ?? (now - window)
        let elapsed = now - last

        guard elapsed >= window else {
            // Emission inside the quiet window: the previous send's UI pass
            // is (likely) still running, or a real stream burst is mid-flight.
            // Either way the next pass reads the models live — dropping loses
            // nothing. No growth here: growing on edge drops spirals to the
            // 2s cap within a second of any continuous stream (drops at
            // 16-50ms intervals always land near the edge eventually), which
            // turned live transcripts into 2-second jump cuts.
            if T4Perf.measure {
                FileHandle.standardError.write(Data("[fwd] \(label) DROP \(elapsed) win=\(window)\n".utf8))
            }
            return
        }

        if T4Perf.measure {
            FileHandle.standardError.write(Data("[fwd] \(label) SEND win=\(window)\n".utf8))
        }
        Self.lastSendAt[label] = now
        let dispatchedAt = now
        DispatchQueue.main.async(qos: .userInitiated) { [weak self] in
            guard let self else { return }
            // The pass itself is deferred (pub.send() returns in µs; the
            // SwiftCrossUI update + GTK layout run later on the main loop),
            // so size the window from the main-thread BACKLOG instead: the
            // dispatch→run delay of this block. Idle main thread (real GPUs)
            // → delay ≈ 0 → the 100ms floor paints streams at ~10Hz. A
            // saturated main thread (software GL) → delay tracks the real
            // pass cost → the window widens to match and leaves GTK room to
            // draw, instead of queueing updates faster than they drain.
            let queueDelay = ContinuousClock.now - dispatchedAt
            self.pub.send()
            let fitted = min(
                max(queueDelay + queueDelay / 2, .milliseconds(100)),
                Self.quietWindowCap
            )
            Self.quietWindow[self.label] = fitted
            if T4Perf.measure {
                FileHandle.standardError.write(Data("[fwd] \(self.label) PASS delay=\(queueDelay) win=\(fitted)\n".utf8))
            }
        }
    }
}

/// Perf probe: set T4PERF=1 to log slow observation/render paths.
public enum T4Perf {
    public static let measure = ProcessInfo.processInfo.environment["T4PERF"] == "1"

    /// Log a timestamped phase marker (only when T4PERF=1).
    public static func mark(_ label: String) {
        guard measure else { return }
        FileHandle.standardError.write(Data("[perf] \(label) \(ContinuousClock.now)\n".utf8))
    }
}

extension T4SessionStore: SwiftCrossUI.ObservableObject {
    var didChange: SwiftCrossUI.Publisher { T4UIObservation.publisher(for: self) }
}

extension T4ConnectionInventoryModel: SwiftCrossUI.ObservableObject {
    var didChange: SwiftCrossUI.Publisher { T4UIObservation.publisher(for: self) }
}

extension T4TranscriptProjectionModel: SwiftCrossUI.ObservableObject {
    var didChange: SwiftCrossUI.Publisher { T4UIObservation.publisher(for: self) }
}

extension T4PromptLeaseModel: SwiftCrossUI.ObservableObject {
    var didChange: SwiftCrossUI.Publisher { T4UIObservation.publisher(for: self) }
}

extension T4AgentInventoryModel: SwiftCrossUI.ObservableObject {
    var didChange: SwiftCrossUI.Publisher { T4UIObservation.publisher(for: self) }
}

extension T4TerminalModel: SwiftCrossUI.ObservableObject {
    var didChange: SwiftCrossUI.Publisher { T4UIObservation.publisher(for: self) }
}

extension T4PreviewBrowserModel: SwiftCrossUI.ObservableObject {
    var didChange: SwiftCrossUI.Publisher { T4UIObservation.publisher(for: self) }
}

extension T4FilesReviewModel: SwiftCrossUI.ObservableObject {
    var didChange: SwiftCrossUI.Publisher { T4UIObservation.publisher(for: self) }
}

extension T4CatalogSettingsModel: SwiftCrossUI.ObservableObject {
    var didChange: SwiftCrossUI.Publisher { T4UIObservation.publisher(for: self) }
}
