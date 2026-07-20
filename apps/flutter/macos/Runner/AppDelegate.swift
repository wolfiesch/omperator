import Cocoa
import FlutterMacOS

@main
class AppDelegate: FlutterAppDelegate {
  private var platformLifecycleChannel: PlatformLifecycleChannel?

  override func applicationDidFinishLaunching(_ notification: Notification) {
    super.applicationDidFinishLaunching(notification)
    guard let flutterViewController = mainFlutterWindow?.contentViewController as? FlutterViewController else {
      return
    }
    platformLifecycleChannel = PlatformLifecycleChannel(
      messenger: flutterViewController.engine.binaryMessenger
    )
  }

  override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return true
  }

  override func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
    return true
  }
}
