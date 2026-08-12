import Foundation
import HostWire
#if canImport(SwiftUI)
import SwiftUI
#endif
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

@MainActor
extension T4SessionStore {
    // MARK: - Browser and preview

    static let defaultBrowserURL = "http://localhost:3000"

    func browserURL(for sessionId: String) -> String {
        browserURLBySession[sessionId] ?? Self.defaultBrowserURL
    }

    func setBrowserURL(for sessionId: String, url: String) {
        browserURLBySession[sessionId] = url
    }

    func openPreview(sessionId: String, url: String) async {
        guard let client, connected, !hostId.isEmpty else { return }
        let priorError = lastError
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId,
                command: "preview.launch",
                args: ["url": .string(url)],
                sessionId: sessionId
            ))
            let snapshot = try result.previewMutationResult()
            previewIdBySession[sessionId] = snapshot.previewId
        } catch {
            lastError = priorError
        }
    }

    @discardableResult
    func previewCapture(sessionId: String, previewId: String? = nil) async -> PlatformImage? {
        guard let client, connected, !hostId.isEmpty else {
            lastError = "Not connected to a host."
            return nil
        }
        let requestedPreviewId = previewId ?? previewIdBySession[sessionId]
        guard let requestedPreviewId else {
            lastError = "No preview available for this session."
            return nil
        }
        do {
            let result = try await client.sendCommand(CommandIntent(
                hostId: hostId,
                command: "preview.capture",
                args: ["previewId": .string(requestedPreviewId)],
                sessionId: sessionId
            ))
            let snapshot = try result.previewMutationResult()
            previewIdBySession[sessionId] = snapshot.previewId
            guard let metadata = snapshot.capture else {
                lastError = "Preview returned no capture."
                return nil
            }
            recordCapture(
                sessionId: sessionId,
                metadata: metadata,
                previewId: snapshot.previewId
            )
            return await fetchCaptureBytes(
                sessionId: sessionId,
                previewId: snapshot.previewId,
                metadata: metadata
            )
        } catch {
            t4log.error("preview.capture failed: \(error)")
            lastError = "\(error)"
            return nil
        }
    }

    func latestCaptureImage(for sessionId: String) -> PlatformImage? {
        guard let row = previewCaptureRowsBySession[sessionId]?.last else { return nil }
        return row.image ?? previewCaptureImages[row.captureId]
    }

    func recordCapture(
        sessionId: String,
        metadata: PreviewCaptureMetadata,
        previewId: String
    ) {
        upsertCaptureRow(
            sessionId: sessionId,
            metadata: metadata,
            previewId: previewId,
            image: nil
        )
        appendCaptureTranscriptRow(
            sessionId: sessionId,
            metadata: metadata,
            previewId: previewId
        )
    }

    private func upsertCaptureRow(
        sessionId: String,
        metadata: PreviewCaptureMetadata,
        previewId: String,
        image: PlatformImage?
    ) {
        var rows = previewCaptureRowsBySession[sessionId] ?? []
        if let index = rows.firstIndex(where: { $0.captureId == metadata.captureId }) {
            rows[index].image = image
        } else {
            rows.append(PreviewCaptureRow(
                metadata: metadata,
                previewId: previewId,
                image: image
            ))
        }
        previewCaptureRowsBySession[sessionId] = rows
    }

    private func appendCaptureTranscriptRow(
        sessionId: String,
        metadata: PreviewCaptureMetadata,
        previewId: String
    ) {
        let entryId = metadata.captureId
        let payload: JSONValue = .object([
            "id": .string(entryId),
            "hostId": .string(hostId),
            "sessionId": .string(sessionId),
            "kind": .string("preview-capture"),
            "timestamp": .string("\(metadata.capturedAt)"),
            "data": .object([
                "captureId": .string(metadata.captureId),
                "previewId": .string(previewId),
                "mimeType": .string(metadata.mimeType.rawValue),
                "width": .number(Double(metadata.width)),
                "height": .number(Double(metadata.height)),
            ]),
        ])
        guard let data = try? JSONEncoder().encode(payload),
              let entry = try? TranscriptEntry.decode(data) else { return }
        var entries = liveEntries[sessionId] ?? []
        if !entries.contains(where: { $0.id == entryId }) {
            entries.append(entry)
            liveEntries[sessionId] = entries
        }
    }

    func fetchCaptureBytes(
        sessionId: String,
        previewId: String,
        metadata: PreviewCaptureMetadata
    ) async -> PlatformImage? {
        guard let client else { return nil }
        do {
            var bytes = Data()
            bytes.reserveCapacity(metadata.size)
            var offset = 0
            while offset < metadata.size {
                let result = try await client.sendCommand(CommandIntent(
                    hostId: hostId,
                    command: "preview.capture.read",
                    args: [
                        "previewId": .string(previewId),
                        "captureId": .string(metadata.captureId),
                        "offset": .number(Double(offset)),
                    ],
                    sessionId: sessionId
                ))
                let chunk = try result.previewCaptureReadResult()
                guard chunk.previewId == previewId,
                      chunk.captureId == metadata.captureId,
                      chunk.offset == offset,
                      chunk.size == metadata.size else {
                    throw T4WireError.invalidFrame(
                        path: "result",
                        reason: "preview capture chunk identity or offset mismatch"
                    )
                }
                guard let part = chunk.decodedBytes,
                      part.count == chunk.nextOffset - offset else {
                    throw T4WireError.invalidFrame(
                        path: "result.content",
                        reason: "preview capture chunk size mismatch"
                    )
                }
                bytes.append(part)
                offset = chunk.nextOffset
            }
            guard bytes.count == metadata.size else {
                throw T4WireError.bounds(path: "result", reason: "preview capture size mismatch")
            }
            let digest = SHA256.hash(data: bytes)
            let hex = digest.map { String(format: "%02x", $0) }.joined()
            guard hex == metadata.sha256 else {
                throw T4WireError.invalidFrame(
                    path: "capture.sha256",
                    reason: "preview capture hash mismatch"
                )
            }
            guard let image = platformImage(data: bytes) else {
                lastError = "Preview capture bytes did not decode to an image."
                return nil
            }
            previewCaptureImages[metadata.captureId] = image
            upsertCaptureRow(
                sessionId: sessionId,
                metadata: metadata,
                previewId: previewId,
                image: image
            )
            return image
        } catch {
            t4log.error("preview.capture.read failed: \(error)")
            lastError = "\(error)"
            return nil
        }
    }
}
