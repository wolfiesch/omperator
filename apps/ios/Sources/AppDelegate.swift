//  AppDelegate.swift
//  Notification permission + remote-push scaffolding. Live Activities and local
//  notifications work today with no server. Remote push (waking a suspended
//  phone, push-to-start Live Activities) needs a relay→APNs bridge that isn't
//  built yet — this registers for the token and hands off where that bridge will
//  plug in. Enabling it on device also needs the `aps-environment` entitlement
//  and a push-capable App ID (paid team).

import UIKit
import UserNotifications

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        if ProcessInfo.processInfo.environment["ENCLAVE_SCREENSHOT"] == "1" { return true }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async { application.registerForRemoteNotifications() }
        }
        return true
    }

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        // SCAFFOLD: deliver this token to the relay→APNs bridge (not built yet),
        // which would push approval/ask events and Live Activity updates.
        print("[enclave] APNs device token: \(token)")
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Expected until aps-environment is enabled + a bridge exists.
        print("[enclave] remote notifications unavailable: \(error.localizedDescription)")
    }

    // Show ask notifications even while the app is foreground.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
