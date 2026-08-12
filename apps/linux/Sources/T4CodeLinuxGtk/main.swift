import Foundation
import CT4Gtk

/// T4 Code — pure-GTK4 Linux client. Entry point: GTK4 window driven by the
/// shared T4SessionStore (unchanged backend). The GLib main loop owns the
/// thread; installMainActorPump keeps Swift concurrency's main actor fed.

typealias ActFn = @convention(c) (UnsafeMutablePointer<GtkApplication>?, UnsafeMutableRawPointer?) -> Void

var appWindow: AppWindow?

let activate: ActFn = { appPtr, _ in
    guard let appPtr else { return }
    installMainActorPump()
    // Theme the moment the display exists (Rosé Pine Moon by default).
    shim_css_load("/home/alexis/dev/omperator/spike-gtk-linux/theme-moon.css")
    MainActor.assumeIsolated {
        appWindow = AppWindow(app: appPtr)
    }
}

let app = gtk_application_new("sh.t4code.gtklinux", GApplicationFlags(rawValue: 0))
let fp = unsafeBitCast(activate as ActFn, to: GCallback.self)
g_signal_connect_data(app, "activate", fp, nil, nil, GConnectFlags(rawValue: 0))
let status = app!.withMemoryRebound(to: GApplication.self, capacity: 1) { g_application_run($0, CommandLine.argc, CommandLine.unsafeArgv) }
g_object_unref(app)
exit(status)
