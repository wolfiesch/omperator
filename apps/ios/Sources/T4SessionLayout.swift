//  T4SessionLayout.swift
//  Per-session region/tile layout: a cmux-like region model where the
//  transcript is the center, a right dock hosts any pane (browser, files,
//  agents, review, searchDiff, artifacts), and a bottom terminal runs
//  concurrently with both. Layout state persists per session across launches
//  (UserDefaults JSON keyed by session id). On macOS a pane can additionally
//  "pop out" into a floating NSPanel and snap back to its dock slot.

import SwiftUI

/// One pane that can dock into the right region. The right dock shows a tab
/// row when 2+ of these are assigned; a single pane renders borderless.
///
/// `usage` is intentionally absent — it stays a modal sheet (settings/inbox/
/// usage are the only sheets left after the region migration).
enum DockPane: String, CaseIterable, Identifiable, Codable, Hashable {
    case browser, files, agents, review, searchDiff, artifacts

    var id: String { rawValue }

    /// Human label for the dock tab + floating window title.
    var label: String {
        switch self {
        case .browser:    return "Browser"
        case .files:      return "Files"
        case .agents:     return "Agents"
        case .review:     return "Review"
        case .searchDiff: return "Search & Diff"
        case .artifacts:  return "Artifacts"
        }
    }

    /// SF Symbol for the dock tab icon.
    var systemImage: String {
        switch self {
        case .browser:    return "safari"
        case .files:      return "folder"
        case .agents:     return "person.3.sequence"
        case .review:     return "checkmark.shield"
        case .searchDiff: return "magnifyingglass.and.list.bullet.indent"
        case .artifacts:  return "paperclip"
        }
    }
}

/// Per-session layout state, persisted in UserDefaults as JSON keyed by
/// session id (see `T4SessionStore.layoutBySession`). Mutated through the
/// store so persistence is centralized.
struct T4SessionLayout: Codable, Equatable {
    /// Panes assigned to the right dock, in tab order. A pane appears here
    /// when opened and is removed when its tile is closed.
    var dockedPanes: [DockPane] = []
    /// The active dock tab. Nil hides the dock entirely (no panes assigned).
    /// Kept consistent with `dockedPanes` by the store mutators.
    var activePane: DockPane? = nil
    /// Whether the bottom terminal drawer is open (concurrent with center +
    /// right dock). Persisted so a relaunch restores the terminal too.
    var terminalOpen: Bool = false
    /// macOS right-dock width in points (resizable via the drag divider).
    /// Ignored on iOS, where the dock is a fixed-width slide-over.
    var dockWidth: CGFloat = 360
    /// macOS only: panes popped out into floating NSPanels. A pane in this
    /// list is NOT in `dockedPanes` (pop-out removes it from the dock; dock
    /// back re-appends it). Order is float-open order.
    var floatingPanes: [DockPane] = []

    /// A sensible starting layout: browser docked + active, terminal closed.
    static var `default`: T4SessionLayout {
        T4SessionLayout(dockedPanes: [.browser], activePane: .browser)
    }

    /// True when the right dock should render at all (≥1 docked pane + an
    /// active pane that's actually docked).
    var dockVisible: Bool {
        guard let active = activePane else { return false }
        return dockedPanes.contains(active)
    }

    /// Codable stable across additions: missing fields decode to defaults via
    /// the synthesized init, so older payloads upgrade cleanly.
}

// MARK: - Store integration

extension T4SessionStore {
    private static let layoutStorageKey = "t4.layoutBySession.v1"

    /// Load persisted layouts once at init (called from `T4SessionStore.init`).
    func loadLayouts() {
        guard let data = UserDefaults.standard.data(forKey: Self.layoutStorageKey),
              let map = try? JSONDecoder().decode([String: T4SessionLayout].self, from: data)
        else { return }
        layoutBySession = map
    }

    /// Encode + write the whole layout map. Called after every mutation.
    private func persistLayouts() {
        guard let data = try? JSONEncoder().encode(layoutBySession) else { return }
        UserDefaults.standard.set(data, forKey: Self.layoutStorageKey)
    }

    /// Read a session's layout, defaulting to `.default` for new sessions so
    /// the browser dock is present on first open.
    func layout(for sessionId: String) -> T4SessionLayout {
        layoutBySession[sessionId] ?? .default
    }

    /// Replace a session's layout and persist. The single write path — all
    /// mutators below funnel through here so persistence can't be skipped.
    func setLayout(_ layout: T4SessionLayout, for sessionId: String) {
        layoutBySession[sessionId] = layout
        persistLayouts()
    }

    // MARK: Dock mutators

    /// Open a pane into the right dock: append if not already docked, make it
    /// active. A pane that was floating is docked back first (removed from
    /// `floatingPanes`) so it can't be in two places at once.
    func openDockPane(_ pane: DockPane, for sessionId: String) {
        var layout = layout(for: sessionId)
        if let idx = layout.floatingPanes.firstIndex(of: pane) {
            layout.floatingPanes.remove(at: idx)
        }
        if !layout.dockedPanes.contains(pane) {
            layout.dockedPanes.append(pane)
        }
        layout.activePane = pane
        setLayout(layout, for: sessionId)
    }

    /// Close a pane's dock tile (remove from dock + clear active if it was
    /// active). Does not touch floating state.
    func closeDockPane(_ pane: DockPane, for sessionId: String) {
        var layout = layout(for: sessionId)
        layout.dockedPanes.removeAll { $0 == pane }
        if layout.activePane == pane {
            layout.activePane = layout.dockedPanes.last
        }
        setLayout(layout, for: sessionId)
    }

    /// Switch the active dock tab. No-op if the pane isn't docked.
    func selectDockPane(_ pane: DockPane, for sessionId: String) {
        var layout = layout(for: sessionId)
        guard layout.dockedPanes.contains(pane) else { return }
        layout.activePane = pane
        setLayout(layout, for: sessionId)
    }

    /// Select a dock tab by 1-based index (⌘⌥1…⌘⌥6). No-op out of range.
    func selectDockPane(at index: Int, for sessionId: String) {
        var layout = layout(for: sessionId)
        guard index > 0, index <= layout.dockedPanes.count else { return }
        layout.activePane = layout.dockedPanes[index - 1]
        setLayout(layout, for: sessionId)
    }

    /// Persist the terminal-open flag for a session.
    func setTerminalOpen(_ open: Bool, for sessionId: String) {
        var layout = layout(for: sessionId)
        guard layout.terminalOpen != open else { return }
        layout.terminalOpen = open
        setLayout(layout, for: sessionId)
    }

    /// Persist the macOS dock width (drag divider).
    func setDockWidth(_ width: CGFloat, for sessionId: String) {
        var layout = layout(for: sessionId)
        let clamped = min(560, max(280, width))
        guard abs(layout.dockWidth - clamped) > 0.5 else { return }
        layout.dockWidth = clamped
        setLayout(layout, for: sessionId)
    }

    // MARK: Floating (macOS pop-out)

    /// Pop a pane out of the dock into a floating NSPanel: remove from
    /// `dockedPanes`, append to `floatingPanes`, and reassign active to the
    /// next remaining docked pane (if any).
    func floatDockPane(_ pane: DockPane, for sessionId: String) {
        var layout = layout(for: sessionId)
        guard layout.dockedPanes.contains(pane) else { return }
        layout.dockedPanes.removeAll { $0 == pane }
        if layout.activePane == pane {
            layout.activePane = layout.dockedPanes.last
        }
        if !layout.floatingPanes.contains(pane) {
            layout.floatingPanes.append(pane)
        }
        setLayout(layout, for: sessionId)
    }

    /// Dock a floating pane back into the right dock: remove from
    /// `floatingPanes`, append to `dockedPanes`, make it active.
    func dockFloatingPane(_ pane: DockPane, for sessionId: String) {
        var layout = layout(for: sessionId)
        guard layout.floatingPanes.contains(pane) else { return }
        layout.floatingPanes.removeAll { $0 == pane }
        if !layout.dockedPanes.contains(pane) {
            layout.dockedPanes.append(pane)
        }
        layout.activePane = pane
        setLayout(layout, for: sessionId)
    }
}
