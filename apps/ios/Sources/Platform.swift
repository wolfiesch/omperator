//  Platform.swift
//  Cross-platform shims so Sources/ compiles unchanged for both the iOS
//  (T4Code) and macOS (T4CodeMac) targets from one source tree. UIKit on iOS,
//  AppKit on macOS — this is the ONLY file that branches on os(iOS)/os(macOS)
//  for platform framework types. Call sites use the `Platform*` aliases and
//  helpers below so they stay platform-neutral.

import SwiftUI
import Foundation

#if canImport(UIKit)
import UIKit
public typealias PlatformImage = UIImage
public typealias PlatformColor = UIColor
public typealias PlatformFont = UIFont
#elseif canImport(AppKit)
import AppKit
public typealias PlatformImage = NSImage
public typealias PlatformColor = NSColor
public typealias PlatformFont = NSFont
#endif

// MARK: - Device identity

/// The human-readable device name sent to the host during pairing.
/// `UIDevice.current.name` on iOS; the Mac's Bonjour/local host name on macOS.
@MainActor
public func platformDeviceName() -> String {
    #if os(iOS)
    return UIDevice.current.name
    #else
    return Host.current().localizedName ?? "Mac"
    #endif
}

// MARK: - Pasteboard

/// Copy a string onto the system pasteboard (UIPasteboard on iOS,
/// NSPasteboard on macOS).
public func platformCopy(_ string: String) {
    #if os(iOS)
    UIPasteboard.general.string = string
    #else
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(string, forType: .string)
    #endif
}

// MARK: - Image from Data

/// Construct a platform image from raw bytes (UIImage(data:) / NSImage(data:)).
public func platformImage(data: Data) -> PlatformImage? {
    #if os(iOS)
    return UIImage(data: data)
    #else
    return NSImage(data: data)
    #endif
}

// MARK: - SwiftUI Image bridge

extension Image {
    /// Wrap a platform image in SwiftUI's `Image` (uiImage: on iOS, nsImage: on macOS).
    init(platformImage: PlatformImage) {
        #if os(iOS)
        self.init(uiImage: platformImage)
        #else
        self.init(nsImage: platformImage)
        #endif
    }
}

// MARK: - Downscaled JPEG (composer photo attachments)

/// Returns the image downscaled to fit `maxBytes` as JPEG (quality 0.85) plus
/// the JPEG payload, halving the source until it fits. Mirrors the iOS UIImage
/// flow on macOS via NSImage + NSBitmapImageRep. Returns nil if the source
/// cannot be encoded or shrinks below 32px.
public func platformJPEGFitting(_ image: PlatformImage, maxBytes: Int) -> (image: PlatformImage, jpeg: Data)? {
    #if os(iOS)
    var scale: CGFloat = 1
    var candidate = image
    while true {
        if let jpeg = candidate.jpegData(compressionQuality: 0.85), jpeg.count <= maxBytes {
            return (candidate, jpeg)
        }
        scale *= 0.5
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        guard size.width > 32, let resized = image.preparingThumbnail(of: size) else { return nil }
        candidate = resized
    }
    #else
    return macJPEGFitting(image, maxBytes: maxBytes)
    #endif
}

#if os(macOS)
private func macJPEGFitting(_ image: NSImage, maxBytes: Int) -> (image: NSImage, jpeg: Data)? {
    guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
    let srcW = CGFloat(cg.width), srcH = CGFloat(cg.height)
    var scale: CGFloat = 1
    while true {
        let size = CGSize(width: srcW * scale, height: srcH * scale)
        guard size.width > 32 else { return nil }
        guard let resized = resizeNSImage(image, to: size),
              let jpeg = nsJPEG(resized, quality: 0.85) else { return nil }
        if jpeg.count <= maxBytes {
            return (resized, jpeg)
        }
        scale *= 0.5
    }
}

private func resizeNSImage(_ image: NSImage, to size: CGSize) -> NSImage? {
    let result = NSImage(size: size)
    result.lockFocus()
    image.draw(in: NSRect(origin: .zero, size: size))
    result.unlockFocus()
    return result
}

private func nsJPEG(_ image: NSImage, quality: CGFloat) -> Data? {
    guard let tiff = image.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff) else { return nil }
    return rep.representation(using: .jpeg, properties: [.compressionFactor: quality])
}
#endif
