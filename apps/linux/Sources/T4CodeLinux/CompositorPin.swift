import Foundation
import CT4Gtk

/// Compositor-aware always-on-top pinning for mini mode.
///
/// Detection order:
///  - `XDG_SESSION_TYPE` = x11/xorg → `.x11`: EWMH `_NET_WM_STATE_ABOVE` via
///    the shim (works on every EWMH-compliant WM: KWin, Mutter, i3, …).
///  - Wayland (`XDG_SESSION_TYPE` or `WAYLAND_DISPLAY`) → `XDG_CURRENT_DESKTOP`,
///    falling back to the compositor's process name from /proc when the desktop
///    name is unset or unrecognised.
///  - No session info but `DISPLAY` set → `.x11`.
///
/// Per-compositor pin mechanism:
///  - X11        → EWMH `_NET_WM_STATE_ABOVE` (shim, synchronous Xlib).
///  - niri       → `niri msg action move-window-to-floating` (floating windows
///                 stack above the tiled layout; idempotent) / `-to-tiling`.
///  - Hyprland   → `hyprctl dispatch pin active` (pin toggles, so the focused
///                 window's state is read first via `hyprctl activewindow -j`
///                 and only the dispatches that move it toward the requested
///                 state are issued; tiled windows get floated before pin).
///  - Sway       → `swaymsg floating enable, sticky enable` / `disable` pair.
///  - KDE/KWin   → KWin scripting over D-Bus: load a tiny snippet that sets
///                 `keepAbove` on the window whose caption matches our GTK
///                 title, run it, stop and unload it. On pin with no caption
///                 match, falls back to `workspace.slotWindowAbove()` (the
///                 focused window — which is ours when the toggle is clicked).
///  - GNOME, unknown → no supported mechanism: `canPin == false`, no-op.
///
/// All CLI spawning is fire-and-forget: launched via Process on a background
/// thread, never blocks the UI, never throws. A missing CLI degrades to a
/// silent no-op.

/// The detected windowing environment.
enum Environment: String {
    case x11
    case niri
    case hyprland
    case sway
    case kde
    case gnome
    case unknown
}

/// Always-on-top pinning for the mini-mode window.
enum CompositorPin {

    // MARK: Detection

    /// The detected windowing environment (computed once; the session cannot
    /// change while the app runs).
    static var environment: Environment { cachedEnvironment }

    private static let cachedEnvironment: Environment = detectEnvironment()

    /// Whether always-on-top is achievable in this environment.
    static var canPin: Bool {
        switch environment {
        case .x11, .niri, .hyprland, .sway, .kde:
            return true
        case .gnome, .unknown:
            return false
        }
    }

    private static func detectEnvironment() -> Environment {
        let env = ProcessInfo.processInfo.environment
        let sessionType = env["XDG_SESSION_TYPE"]?.lowercased() ?? ""

        if sessionType.contains("x11") || sessionType.contains("xorg") {
            return .x11
        }
        if sessionType.contains("wayland") || env["WAYLAND_DISPLAY"] != nil {
            return waylandEnvironment(desktop: env["XDG_CURRENT_DESKTOP"])
        }
        // No session type recorded: whatever display is set decides.
        if env["DISPLAY"] != nil {
            return .x11
        }
        return .unknown
    }

    private static func waylandEnvironment(desktop: String?) -> Environment {
        let name = (desktop ?? "").lowercased()
        if name.contains("niri") { return .niri }
        if name.contains("hyprland") { return .hyprland }
        if name.contains("sway") { return .sway }
        if name.contains("kde") || name.contains("plasma") { return .kde }
        if name.contains("gnome") { return .gnome }

        // Desktop name unset or unknown: identify the compositor by process.
        let procs = runningProcessNames()
        if procs.contains("niri") { return .niri }
        if procs.contains("Hyprland") || procs.contains("hyprland") { return .hyprland }
        if procs.contains("sway") { return .sway }
        if procs.contains("kwin_wayland") { return .kde }
        if procs.contains("gnome-shell") || procs.contains("mutter") { return .gnome }
        return .unknown
    }

    /// Snapshot of process names from /proc (`comm` files) — no spawning.
    private static func runningProcessNames() -> Set<String> {
        var names = Set<String>()
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: "/proc") else {
            return names
        }
        for entry in entries where entry.allSatisfy({ $0.isNumber }) {
            if let comm = try? String(contentsOfFile: "/proc/\(entry)/comm", encoding: .utf8) {
                let name = comm.trimmingCharacters(in: .whitespacesAndNewlines)
                if !name.isEmpty { names.insert(name) }
            }
        }
        return names
    }

    // MARK: Pin / unpin

    /// Pin or unpin the given GTK window on top. Safe no-op when unsupported.
    static func setPinned(_ pinned: Bool, window: UnsafeMutablePointer<GtkWidget>?) {
        switch environment {
        case .x11:
            pinViaEwmh(pinned, window: window)
        case .niri:
            spawn("niri", ["msg", "action", pinned ? "move-window-to-floating" : "move-window-to-tiling"])
        case .hyprland:
            pinViaHyprctl(pinned)
        case .sway:
            spawn("swaymsg", pinned
                ? ["floating", "enable", ",", "sticky", "enable"]
                : ["floating", "disable", ",", "sticky", "disable"])
        case .kde:
            pinViaKWin(pinned, window: window)
        case .gnome, .unknown:
            break // No supported always-on-top mechanism.
        }
    }

    /// X11: EWMH `_NET_WM_STATE_ABOVE` on the window's XID (shim).
    private static func pinViaEwmh(_ pinned: Bool, window: UnsafeMutablePointer<GtkWidget>?) {
        guard let window else { return }
        let xid = shim_x11_xid(window)
        guard xid != 0 else { return } // Wayland surface, or not realized yet.
        _ = shim_x11_set_above(xid, pinned ? 1 : 0)
    }

    /// Hyprland: `dispatch pin` toggles, so read the focused window's state
    /// first (async), then issue only the dispatches that move it toward the
    /// requested state.
    private static func pinViaHyprctl(_ pinned: Bool) {
        spawn("hyprctl", ["activewindow", "-j"]) { output in
            let state = parseJsonBools(output)
            if pinned {
                if state["pinned"] == true { return }
                if state["floating"] == true {
                    spawn("hyprctl", ["dispatch", "pin", "active"])
                } else {
                    // Hyprland ignores `pin` on tiled windows: float first.
                    spawnShell("hyprctl dispatch togglefloating active && hyprctl dispatch pin active")
                }
            } else {
                if state["pinned"] == true {
                    spawn("hyprctl", ["dispatch", "pin", "active"]) // toggles it off
                }
            }
        }
    }

    private static func parseJsonBools(_ json: String) -> [String: Bool] {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        var result: [String: Bool] = [:]
        for (key, value) in object {
            if let bool = value as? Bool { result[key] = bool }
        }
        return result
    }

    /// KDE: KWin scripting over D-Bus, caption-matched `keepAbove` set.
    private static func pinViaKWin(_ pinned: Bool, window: UnsafeMutablePointer<GtkWidget>?) {
        guard let window, let cTitle = shim_window_title(window) else { return }
        let title = String(cString: cTitle)
        guard !title.isEmpty else { return }
        let escaped = title
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        let script: String
        if pinned {
            script = """
            var clients;
            try { clients = workspace.windowList(); } catch (e) { clients = workspace.clientList(); }
            var t = null;
            for (var i = 0; i < clients.length; i++) {
                if (clients[i].caption === "\(escaped)") { t = clients[i]; break; }
            }
            if (t) { t.keepAbove = true; } else { workspace.slotWindowAbove(); }
            """
        } else {
            script = """
            var clients;
            try { clients = workspace.windowList(); } catch (e) { clients = workspace.clientList(); }
            for (var i = 0; i < clients.length; i++) {
                if (clients[i].caption === "\(escaped)") { clients[i].keepAbove = false; }
            }
            """
        }
        let path = NSTemporaryDirectory() + "omperator-kwin-pin.js"
        guard (try? script.write(toFile: path, atomically: true, encoding: .utf8)) != nil else { return }
        let shell = """
        Q=$(command -v qdbus6 || command -v qdbus || command -v qdbus-qt5) || exit 0
        ID=$("$Q" org.kde.KWin /Scripting org.kde.kwin.Scripting.loadScript "\(path)" omperator_pin 2>/dev/null | grep -oE '[0-9]+' | head -n 1)
        [ -n "$ID" ] || exit 0
        "$Q" org.kde.KWin "/Scripting/Script$ID" org.kde.kwin.Script.run
        "$Q" org.kde.KWin "/Scripting/Script$ID" org.kde.kwin.Script.stop
        "$Q" org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript omperator_pin
        """
        spawnShell(shell)
    }

    // MARK: Process plumbing (fire-and-forget, never throws)

    /// Retains running processes so their handlers can't be deallocated
    /// early; entries are dropped when the process exits.
    private static var activeProcesses: [Process] = []
    private static let processLock = NSLock()

    /// Spawn `command` (resolved via PATH with `/usr/bin/env`). Missing
    /// binaries and any other launch failure are silently ignored.
    private static func spawn(_ command: String, _ args: [String], onOutput: ((String) -> Void)? = nil) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [command] + args

        var outputPipe: Pipe?
        if onOutput != nil {
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            outputPipe = pipe
        }

        register(process) { finished in
            if let outputPipe {
                // Blocks only this background queue until the child closes the
                // pipe; the UI thread is never touched.
                let data = outputPipe.fileHandleForReading.readDataToEndOfFile()
                if let text = String(data: data, encoding: .utf8), !text.isEmpty {
                    onOutput?(text)
                }
            }
        }

        do {
            try process.run()
        } catch {
            deregister(process) // Never ran; the exit handler won't fire.
        }
    }

    /// Spawn a `/bin/sh -c` script (compositor command sequences).
    private static func spawnShell(_ script: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", script]
        register(process) { _ in }
        do {
            try process.run()
        } catch {
            deregister(process)
        }
    }

    private static func register(_ process: Process, onExit: @escaping (Process) -> Void) {
        processLock.lock()
        activeProcesses.append(process)
        processLock.unlock()
        process.terminationHandler = { finished in
            onExit(finished)
            processLock.lock()
            activeProcesses.removeAll { $0 === finished }
            processLock.unlock()
            finished.terminationHandler = nil
        }
    }

    private static func deregister(_ process: Process) {
        processLock.lock()
        activeProcesses.removeAll { $0 === process }
        processLock.unlock()
    }
}
