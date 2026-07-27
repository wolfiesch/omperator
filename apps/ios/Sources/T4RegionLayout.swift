//  T4RegionLayout.swift
//  Region/tile containers for the cmux-like layout: a right dock that hosts
//  any pane (browser, files, agents, review, searchDiff, artifacts) alongside
//  the center transcript, concurrent with the bottom terminal. On macOS the
//  dock is a true concurrent region (resizable via a drag divider) and any
//  tile can pop out into a floating NSPanel. On iOS the dock is a right-edge
//  slide-over overlay mirroring the left session rail in T4WorkspaceView.
//
//  Pane views themselves are reused unchanged — only hosted in new containers.

import SwiftUI
import HostWire
#if os(macOS)
import AppKit
#endif

// MARK: - Shared pane renderer

/// Renders one dock pane's existing view, unchanged, with an `isPresented`
/// binding the pane's own Done button flips to close. Used by both the dock
/// tile and the floating panel. Browser is wrapped in a NavigationStack
/// because (unlike the other panes) it doesn't provide its own — its
/// `.toolbar`/`.navigationTitle` need an ancestor to attach to.
struct T4DockPaneContent: View {
    let pane: DockPane
    let session: SessionRef
    @ObservedObject var store: T4SessionStore
    @Binding var isPresented: Bool
    @EnvironmentObject var theme: ThemeStore

    var body: some View {
        switch pane {
        case .browser:
            NavigationStack {
                T4BrowserPane(session: session, store: store, isPresented: $isPresented)
                    .environmentObject(theme)
            }
        case .files:
            T4FilesPane(session: session, store: store, isPresented: $isPresented)
                .environmentObject(theme)
        case .agents:
            T4AgentsPane(session: session, store: store, isPresented: $isPresented)
                .environmentObject(theme)
        case .review:
            T4ReviewPane(session: session, store: store, isPresented: $isPresented)
                .environmentObject(theme)
        case .searchDiff:
            T4SearchPane(session: session, store: store, isPresented: $isPresented)
                .environmentObject(theme)
        case .artifacts:
            T4ArtifactsPane(session: session, store: store, isPresented: $isPresented)
                .environmentObject(theme)
        }
    }
}

// MARK: - Dock tab row (shared header)

/// The dock's top bar: tab buttons when 2+ panes are docked (else just the
/// active pane's label), with trailing close (×) and — on macOS — pop-out.
/// Tabs switch `store.activePane`; close removes the pane from the dock;
/// pop-out floats it into its own panel.
struct T4DockTabBar: View {
    let session: SessionRef
    @ObservedObject var store: T4SessionStore
    @EnvironmentObject var theme: ThemeStore
    /// macOS-only: float the active pane into a panel. Ignored on iOS.
    var onPopOut: ((DockPane) -> Void)? = nil
    private var t: Theme { theme.t }

    var body: some View {
        let layout = store.layout(for: session.sessionId)
        let panes = layout.dockedPanes
        let active = layout.activePane
        HStack(spacing: 6) {
            if panes.count > 1 {
                ForEach(panes) { pane in
                    tab(pane, isActive: pane == active)
                }
            } else if let active {
                Label(active.label, systemImage: active.systemImage)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(t.txtMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            if let active {
                #if os(macOS)
                if let onPopOut {
                    Button { onPopOut(active) } label: {
                        Image(systemName: "arrow.up.right.and.arrow.down.left.rectangle")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(t.txtMuted)
                            .frame(width: 24, height: 24)
                    }
                    .press()
                    .accessibilityLabel("Pop out \(active.label) into a floating window")
                }
                #endif
                Button { store.closeDockPane(active, for: session.sessionId) } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(t.txtMuted)
                        .frame(width: 24, height: 24)
                }
                .press()
                .accessibilityLabel("Close \(active.label) tile")
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .overlay(alignment: .bottom) { Rectangle().fill(t.line).frame(height: 0.5) }
        .background(t.bg)
    }

    /// One dock tab: icon + 1-based index hint, active accent tint. Tapping
    /// switches `store.activePane` instantly.
    private func tab(_ pane: DockPane, isActive: Bool) -> some View {
        HStack(spacing: 5) {
            Image(systemName: pane.systemImage)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(isActive ? t.accent : t.txtMuted)
            Text(pane.label)
                .font(.system(size: 11, weight: isActive ? .semibold : .regular))
                .foregroundStyle(isActive ? t.txt : t.txtMuted)
                .lineLimit(1)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(isActive ? t.accent.opacity(0.14) : .clear)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(isActive ? t.accentLine : t.line, lineWidth: 0.5)
        )
        .contentShape(Rectangle())
        .onTapGesture { store.selectDockPane(pane, for: session.sessionId) }
        .accessibilityLabel("Switch to \(pane.label)")
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }
}

// MARK: - macOS right dock (concurrent region)

/// macOS right dock: a fixed-width column (resizable via a leading drag
/// divider) hosting the active pane's tile. Renders only when the layout has
/// a visible docked pane. The terminal is separate (bottom, full width) and
/// runs concurrently.
struct T4RightDockRegion: View {
    let session: SessionRef
    @ObservedObject var store: T4SessionStore
    @EnvironmentObject var theme: ThemeStore
    /// Persisted dock width, seeded into `liveWidth` on appear / layout change.
    var dockWidth: CGFloat
    /// Float the active pane into a panel (macOS pop-out).
    var onPopOut: (DockPane) -> Void
    /// Persist the dock width on drag end.
    var onResize: (CGFloat) -> Void
    @State private var liveWidth: CGFloat = 360
    private var t: Theme { theme.t }

    var body: some View {
        let layout = store.layout(for: session.sessionId)
        let active = layout.activePane
        // isPresented → close the active tile (remove from dock).
        let isPresented = closeBinding(for: active)

        VStack(spacing: 0) {
            T4DockTabBar(session: session, store: store, onPopOut: onPopOut)
            if let active {
                T4DockPaneContent(pane: active, session: session, store: store, isPresented: isPresented)
            } else {
                Spacer()
            }
        }
        .frame(width: liveWidth)
        .frame(maxHeight: .infinity)
        .background(t.bg2)
        .overlay(alignment: .leading) {
            // Drag divider: a hairline + a wider hit zone. Leftward drag
            // widens the dock (clamped 280…560); the live value updates
            // in-memory, persistence lands on release via `onResize`.
            Rectangle().fill(t.line).frame(width: 1)
                .overlay {
                    Rectangle().fill(.clear).frame(width: 8)
                        .contentShape(Rectangle())
                        .gesture(
                            DragGesture(minimumDistance: 1)
                                .onChanged { value in
                                    liveWidth = min(560, max(280, liveWidth - value.translation.width))
                                }
                                .onEnded { _ in onResize(liveWidth) }
                        )
                        .onHover { inside in
                            // Resize cursor over the divider hit zone (macOS).
                            #if os(macOS)
                            if inside { NSCursor.resizeLeftRight.set() }
                            else { NSCursor.arrow.set() }
                            #endif
                        }
                }
        }
        .onAppear { liveWidth = dockWidth }
        .onChange(of: dockWidth) { _, w in liveWidth = w }
    }

    /// Binding that closes the active pane's tile when set to false (the
    /// pane's Done button + the tab bar's × both flow through here).
    private func closeBinding(for pane: DockPane?) -> Binding<Bool> {
        Binding(
            get: { pane != nil },
            set: { if !$0, let pane { store.closeDockPane(pane, for: session.sessionId) } }
        )
    }
}

// MARK: - iOS right dock (right-edge slide-over)

/// iOS right dock: a slide-over overlay from the RIGHT edge — the mirror of
/// T4WorkspaceView's left session rail. One source of truth (`progress`
/// 0…1) drives the panel offset + scrim. Right-edge swipe opens; scrim tap
/// or left-swipe closes. Opening a pane from the toolbar auto-reveals it
/// (progress → 1 when the layout gains a visible docked pane).
struct T4RightDockSlideOver: View {
    let session: SessionRef
    @ObservedObject var store: T4SessionStore
    @EnvironmentObject var theme: ThemeStore
    @State private var progress: CGFloat = 0   // 0 = closed, 1 = open
    private var t: Theme { theme.t }

    private var layout: T4SessionLayout { store.layout(for: session.sessionId) }
    private var dockVisible: Bool { layout.dockVisible }
    private var dockWidth: CGFloat { 360 }

    var body: some View {
        // Only mount the slide-over machinery when a pane is docked; with no
        // docked pane there's nothing to reveal.
        if dockVisible {
            GeometryReader { geo in
                let width = min(dockWidth, geo.size.width * 0.92)
                ZStack(alignment: .trailing) {
                    // Scrim tracks the panel; hit-testable only when visible.
                    Color.black.opacity(0.5 * progress)
                        .ignoresSafeArea()
                        .allowsHitTesting(progress > 0.02)
                        .onTapGesture { close() }
                        .gesture(closeDrag(width: width))

                    // Right-edge hot zone: only hit-testable while closed.
                    if progress == 0 {
                        Color.clear
                            .frame(width: 28)
                            .frame(maxHeight: .infinity)
                            .contentShape(Rectangle())
                            .gesture(openDrag(width: width))
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    }

                    panel(width: width)
                        .offset(x: (1 - progress) * width)
                        .gesture(closeDrag(width: width))
                        .accessibilityHidden(progress == 0)
                }
            }
            // Auto-reveal when a pane becomes docked (toolbar open) OR when a
            // new pane is opened while the slide-over was gesture-dismissed
            // (activePane changes without dockVisible flipping). Collapse when
            // the last pane closes (dockVisible → false removes the view).
            .onChange(of: dockVisible) { _, visible in
                withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) {
                    progress = visible ? 1 : 0
                }
            }
            .onChange(of: layout.activePane) { _, _ in
                // A new pane was opened or tab-switched — make sure it's seen.
                withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) {
                    progress = 1
                }
            }
            .onAppear {
                if dockVisible { progress = 1 }
            }
        }
    }

    /// The slide-over panel: tab bar + active pane content (no pop-out on iOS).
    private func panel(width: CGFloat) -> some View {
        let active = layout.activePane
        let isPresented = Binding<Bool>(
            get: { active != nil },
            set: { if !$0, let active { store.closeDockPane(active, for: session.sessionId) } }
        )
        return VStack(spacing: 0) {
            T4DockTabBar(session: session, store: store)
            if let active {
                T4DockPaneContent(pane: active, session: session, store: store, isPresented: isPresented)
            } else {
                Spacer()
            }
        }
        .frame(width: width)
        .frame(maxHeight: .infinity)
        .background(t.bg2)
        .overlay(alignment: .leading) {
            Rectangle().fill(t.line).frame(width: 1)
        }
        .shadow(color: .black.opacity(0.18 * progress), radius: 12, x: -4, y: 0)
        .ignoresSafeArea(.container, edges: .bottom)
    }

    // MARK: Gestures (mirror T4WorkspaceView's rail mechanics, right-edge)

    private func settle(velocity: CGFloat, width: CGFloat) {
        // Right dock: a leftward fling closes, a slow release past 40% stays open.
        let target: CGFloat = progress - velocity / width * 0.12 < 0.6 ? 0 : 1
        withAnimation(.interpolatingSpring(mass: 1, stiffness: 170, damping: 22, initialVelocity: velocity / width)) {
            progress = target
        }
    }

    /// Right-edge open: drag leftward from the right edge scrubs progress 0→1.
    private func openDrag(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                guard value.translation.width < 0,
                      abs(value.translation.width) > abs(value.translation.height) else { return }
                progress = min(1, max(0, 1 + value.translation.width / width))
            }
            .onEnded { value in settle(velocity: value.velocity.width, width: width) }
    }

    /// Close: drag leftward past the panel scrubs progress 1→0.
    private func closeDrag(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                guard value.translation.width < 0,
                      abs(value.translation.width) > abs(value.translation.height) else { return }
                progress = min(1, max(0, 1 + value.translation.width / width))
            }
            .onEnded { value in settle(velocity: value.velocity.width, width: width) }
    }

    private func close() {
        withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) { progress = 0 }
    }
}

// MARK: - macOS floating pane (pop-out)

#if os(macOS)
/// Manages one NSPanel per popped-out pane for a session. The session detail
/// view owns one instance as a @StateObject and calls `sync(with:)` whenever
/// the layout's `floatingPanes` changes; this opens/closes panels to match.
/// Each panel hosts the pane view (unchanged) with a dock-back affordance.
@MainActor
final class T4FloatingPaneManager: ObservableObject {
    let session: SessionRef
    let store: T4SessionStore
    /// Theme from the environment — set by the owner before `sync` so panels
    /// host panes with the real theme (unavailable in `init`).
    var theme: ThemeStore?
    private var panels: [DockPane: NSPanel] = [:]
    /// Retained close delegates (NSWindow.delegate is weak) so the titlebar ×
    /// docks the pane back instead of orphaning it.
    private var closeDelegates: [DockPane: PanelCloseDelegate] = [:]

    init(session: SessionRef, store: T4SessionStore) {
        self.session = session
        self.store = store
    }

    /// Reconcile open panels with `layout.floatingPanes`. Idempotent — safe
    /// to call on every layout change.
    func sync(with layout: T4SessionLayout, theme: ThemeStore) {
        self.theme = theme
        let want = Set(layout.floatingPanes)
        let have = Set(panels.keys)
        for pane in have.subtracting(want) {
            panels[pane]?.orderOut(nil)
            panels.removeValue(forKey: pane)
            closeDelegates.removeValue(forKey: pane)
        }
        for pane in layout.floatingPanes where panels[pane] == nil {
            let panel = makePanel(for: pane)
            panels[pane] = panel
            panel.makeKeyAndOrderFront(nil)
        }
    }

    func closeAll() {
        for panel in panels.values { panel.orderOut(nil) }
        panels.removeAll()
        closeDelegates.removeAll()
    }

    // No deinit panel teardown: the owner calls closeAll() from .onDisappear
    // (which fires before the @StateObject is released), and app termination
    // tears down NSPanels regardless. A nonisolated deinit touching AppKit
    // here would be a concurrency hazard for no real safety gain.

    /// Build a floating, always-on-top-ish panel hosting the pane view with a
    /// dock-back header button. The pane's own Done button also docks back
    /// (isPresented → false → dockFloatingPane → sync closes the panel).
    private func makePanel(for pane: DockPane) -> NSPanel {
        let sessionId = session.sessionId
        let onDockBack = { [weak store] in store?.dockFloatingPane(pane, for: sessionId) }
        let content = T4FloatingPaneContent(pane: pane, session: session, store: store, onDockBack: onDockBack)
            .environmentObject(theme ?? ThemeStore())
            .environmentObject(store)
        let hosting = NSHostingController(rootView: content)
        let panel = NSPanel(contentViewController: hosting,
                            styleMask: [.titled, .closable, .resizable, .miniaturizable],
                            backing: .buffered, defer: false)
        panel.title = pane.label
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.setFrame(NSRect(x: 220, y: 220, width: 760, height: 540), display: true)
        // Closing the panel via its titlebar × docks the pane back (restores
        // it to the dock instead of orphaning it). Retained in
        // `closeDelegates` since NSWindow.delegate is weak.
        let closeDelegate = PanelCloseDelegate(onClose: onDockBack)
        panel.delegate = closeDelegate
        closeDelegates[pane] = closeDelegate
        return panel
    }
}

/// Bridges NSPanel's titlebar close to a dock-back so the × doesn't orphan
/// the pane (it returns to the right dock instead).
private final class PanelCloseDelegate: NSObject, NSWindowDelegate {
    let onClose: () -> Void
    init(onClose: @escaping () -> Void) { self.onClose = onClose }
    func windowWillClose(_ notification: Notification) { onClose() }
}

/// Floating panel content: a compact header (label + Dock Back button) above
/// the unchanged pane view. The pane's Done button is bound to dock-back too.
struct T4FloatingPaneContent: View {
    let pane: DockPane
    let session: SessionRef
    @ObservedObject var store: T4SessionStore
    let onDockBack: () -> Void
    @EnvironmentObject var theme: ThemeStore
    private var t: Theme { theme.t }

    /// isPresented for the hosted pane: always reads true; setting false
    /// (the pane's Done button) docks the pane back, which closes the panel.
    private var dockBackBinding: Binding<Bool> {
        Binding(get: { true }, set: { if !$0 { onDockBack() } })
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: pane.systemImage)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(t.txtMuted)
                Text(pane.label)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(t.txt)
                Spacer()
                Button { onDockBack() } label: {
                    Label("Dock Back", systemImage: "arrow.down.right.and.arrow.up.left")
                        .font(.system(size: 12, weight: .semibold))
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("Dock \(pane.label) back into the right region")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .overlay(alignment: .bottom) { Rectangle().fill(t.line).frame(height: 0.5) }
            T4DockPaneContent(pane: pane, session: session, store: store, isPresented: dockBackBinding)
        }
        .background(t.bg2)
    }
}
#endif
