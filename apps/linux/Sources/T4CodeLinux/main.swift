import Foundation
import CT4Gtk

/// T4 Code — pure-GTK4 Linux client. Entry point: GTK4 window driven by the
/// shared T4SessionStore (unchanged backend). The GLib main loop owns the
/// thread; installMainActorPump keeps Swift concurrency's main actor fed.

typealias ActFn = @convention(c) (UnsafeMutablePointer<GtkApplication>?, UnsafeMutableRawPointer?) -> Void

var appWindow: AppWindow?

let activate: ActFn = { appPtr, _ in
    guard let appPtr else { return }
    MainActor.assumeIsolated {
        // One window per process. GApplication delivers a second "activate"
        // when the app is launched again while it is already running (same
        // application id on the same session bus — the new process forwards
        // the launch and exits). Replacing `appWindow` here would free the
        // previous controller while its 33ms refresh timeout is still
        // registered with a pass-unretained pointer; the next tick then
        // retains the freed AppWindow and SIGSEGVs (startRefreshTimer).
        if let existing = appWindow {
            existing.present()
            return
        }
        installMainActorPump()
        // Theme the moment the display exists (Rosé Pine Moon by default).
        if let css = Bundle.module.url(forResource: "theme-moon", withExtension: "css", subdirectory: "themes") {
            shim_css_load(css.path)
        }
        appWindow = AppWindow(app: appPtr)
    }
}

// With G_APPLICATION_HANDLES_COMMAND_LINE, GLib stops rejecting the app's
// `-T4…` launch seams (restore/endpoint/rendezvous overrides) as unknown
// options and stops trying to "open" them as files. The handler just
// forwards to the regular activate flow.
typealias CommandLineFn = @convention(c) (UnsafeMutablePointer<GApplication>?, UnsafeMutableRawPointer?, UnsafeMutableRawPointer?) -> Int32

let cmdline: CommandLineFn = { appPtr, _, _ in
    guard let appPtr else { return 0 }
    g_application_activate(appPtr)
    return 0
}

// G_APPLICATION_HANDLES_COMMAND_LINE == 1 << 3 (the C enum constant isn't
// imported into Swift; documented stable in gioenums.h).
let app = gtk_application_new("sh.t4code.gtklinux", GApplicationFlags(rawValue: 1 << 3))
let fp = unsafeBitCast(activate as ActFn, to: GCallback.self)
g_signal_connect_data(app, "activate", fp, nil, nil, GConnectFlags(rawValue: 0))
let cmdFp = unsafeBitCast(cmdline as CommandLineFn, to: GCallback.self)
g_signal_connect_data(app, "command-line", cmdFp, nil, nil, GConnectFlags(rawValue: 0))
let status = app!.withMemoryRebound(to: GApplication.self, capacity: 1) { g_application_run($0, CommandLine.argc, CommandLine.unsafeArgv) }
g_object_unref(app)
exit(status)
