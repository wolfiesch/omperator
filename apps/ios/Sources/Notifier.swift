//  Notifier.swift
//  Local notifications for the moments you'd want off-screen: a host ask waiting
//  on your answer. These fire while the app is alive (foreground/briefly
//  backgrounded). Waking a suspended phone needs remote push from a bridge — see
//  AppDelegate for the device-token scaffold.

import UserNotifications

enum Notifier {
    static func requestAuth() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    static func post(title: String, body: String, id: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}
