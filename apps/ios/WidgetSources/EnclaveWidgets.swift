//  EnclaveWidgets.swift
//  The EnclaveWidgets app-extension: the omp session Live Activity, rendered on
//  the lock screen and in the Dynamic Island from EnclaveActivityAttributes.
//  Variant C — "Breath": minimal. Pulsing ring + one status word; ask prompt in serif.

import WidgetKit
import SwiftUI
import ActivityKit

@main
struct EnclaveWidgets: WidgetBundle {
    var body: some Widget { EnclaveLiveActivity() }
}

private func statusColor(_ s: EnclaveActivityAttributes.ContentState) -> Color {
    switch EnclaveStatus.from(phase: s.phase, working: s.working, waiting: s.waiting) {
    case .needsYou: .enclaveLove
    case .working: .enclaveAccent
    default: .white.opacity(0.5)
    }
}

private func isNotable(_ s: EnclaveActivityAttributes.ContentState) -> Bool {
    let st = EnclaveStatus.from(phase: s.phase, working: s.working, waiting: s.waiting)
    return st == .needsYou || st == .ended
}

private func statusWord(_ s: EnclaveActivityAttributes.ContentState) -> String {
    EnclaveStatus.from(phase: s.phase, working: s.working, waiting: s.waiting).label.uppercased()
}

struct EnclaveLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: EnclaveActivityAttributes.self) { context in
            LockScreenView(state: context.state)
                .activityBackgroundTint(Color.black.opacity(0.92))
                .activitySystemActionForegroundColor(.enclaveAccent)
        } dynamicIsland: { context in
            let s = context.state
            let notable = isNotable(s)
            let status = EnclaveStatus.from(phase: s.phase, working: s.working, waiting: s.waiting)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    RingMark(size: 24, pulse: s.working)
                        .foregroundStyle(statusColor(s))
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(s.tokens.isEmpty ? " " : s.tokens)
                        .font(.caption2).monospaced()
                        .foregroundStyle(.white.opacity(0.6))
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if status == .needsYou {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(s.prompt.isEmpty ? "The host is asking for your input." : s.prompt)
                                .font(.system(size: 14, design: .serif))
                                .foregroundStyle(.white)
                                .lineLimit(3)
                                .minimumScaleFactor(0.8)
                            Text("NEEDS YOUR ANSWER")
                                .font(.system(size: 9, weight: .bold))
                                .tracking(1.6)
                                .foregroundStyle(Color.enclaveLove)
                        }
                    } else {
                        Text(statusWord(s))
                            .font(.system(size: 14, weight: .heavy))
                            .tracking(1)
                            .foregroundStyle(statusColor(s))
                    }
                }
            } compactLeading: {
                if notable {
                    RingMark(size: 18).foregroundStyle(statusColor(s))
                } else {
                    EmptyView()
                }
            } compactTrailing: {
                if status == .needsYou {
                    Text("ask")
                        .font(.caption2).bold()
                        .foregroundStyle(Color.enclaveLove)
                } else {
                    EmptyView()
                }
            } minimal: {
                if notable {
                    RingMark(size: 18).foregroundStyle(statusColor(s))
                } else {
                    EmptyView()
                }
            }
            .keylineTint(.enclaveAccent)
        }
    }
}

private struct LockScreenView: View {
    let state: EnclaveActivityAttributes.ContentState
    var body: some View {
        HStack(spacing: 12) {
            RingMark(size: 26, pulse: state.working)
                .foregroundStyle(statusColor(state))
            VStack(alignment: .leading, spacing: 3) {
                Text(state.title.isEmpty ? "session" : state.title)
                    .font(.subheadline).bold()
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Text(state.action.isEmpty ? "live" : state.action)
                    .font(.caption)
                    .foregroundStyle(statusColor(state))
                    .lineLimit(1)
            }
            Spacer()
            Text(state.tokens.isEmpty ? " " : state.tokens)
                .font(.caption).monospaced()
                .foregroundStyle(.white.opacity(0.6))
                .lineLimit(1)
        }
        .padding(16)
    }
}

// The Enclave ring + sealed-slit mark. Fixed-frame (no greedy GeometryReader).
private struct RingMark: View {
    var size: CGFloat
    var pulse: Bool = false
    @State private var on = false
    var body: some View {
        let s = size * 0.9
        ZStack {
            Circle().stroke(lineWidth: s * 0.08)
            if pulse {
                Circle().stroke(lineWidth: s * 0.08)
                    .scaleEffect(on ? 1.9 : 1).opacity(on ? 0 : 0.6)
                    .animation(.easeOut(duration: 1.8).repeatForever(autoreverses: false), value: on)
            }
            EnclaveSlit().stroke(style: StrokeStyle(lineWidth: s * 0.065, lineCap: .round, lineJoin: .round))
        }
        .frame(width: size, height: size)
        .onAppear { if pulse { on = true } }
    }
}
