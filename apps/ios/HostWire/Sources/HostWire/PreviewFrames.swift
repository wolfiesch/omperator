import Foundation

/// Preview frame family (host-wire/src/additive.ts, the `decodePreview`
/// dispatch). Host → client: a live preview's state, navigation, captures, and
/// errors for a session preview. Every frame carries the `(hostId, sessionId)`
/// locator; snapshot frames additionally carry the full `PreviewSnapshot` and
/// advance a per-session `Cursor`/`Revision`.
///
/// Wire types decoded by `decodePreview`:
/// `preview.launch`, `preview.state`, `preview.navigation`,
/// `preview.capture`, `preview.error`.

/// `PREVIEW_CAPTURE_MIME_TYPES` — strict enum; an unknown raw value fails
/// decode, mirroring `previewCaptureMimeType(...)` in additive.ts.
public enum PreviewCaptureMimeType: String, Codable, Equatable, Sendable {
    case png = "image/png"
    case jpeg = "image/jpeg"
    case webp = "image/webp"
}

/// `PreviewState` (additive.ts): the lifecycle state of a preview.
public enum PreviewState: String, Codable, Equatable, Sendable {
    case launching, ready, running, stopped, failed
}

/// `PREVIEW_AUTHORITY_KINDS` = ["isolated-session","authenticated-profile"].
/// Decoded strictly via `known(...)`; an unknown raw value fails decode.
public enum PreviewAuthorityKind: String, Codable, Equatable, Sendable {
    case isolatedSession = "isolated-session"
    case authenticatedProfile = "authenticated-profile"
}

/// `PREVIEW_ACTIONS` (additive.ts) — the closed set of actions a preview
/// advertises via `availableActions`. Decoded strictly via `known(...)`.
public enum PreviewAction: String, Codable, Equatable, Sendable {
    case activate, navigate, back, forward, reload, close, capture
    case click, fill, type, press, scroll, select, upload, handoff
}

/// `PreviewAuthorityDescriptor` (additive.ts `decodePreviewAuthority`).
/// `id` is control-free (<= 128); `label` is bounded text (<= 256); `kind` is a
/// strict `PreviewAuthorityKind`; `requiresExplicitOptIn` must be a boolean.
public struct PreviewAuthorityDescriptor: Decodable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let kind: PreviewAuthorityKind
    public let requiresExplicitOptIn: Bool

    private enum CodingKeys: String, CodingKey { case id, label, kind, requiresExplicitOptIn }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try Bounded.controlFree(try c.decode(String.self, forKey: .id), path: "authority.id", maxBytes: 128)
        label = try Previews.boundedText(try c.decode(String.self, forKey: .label), path: "authority.label", maxBytes: 256)
        kind = try c.decode(PreviewAuthorityKind.self, forKey: .kind)
        requiresExplicitOptIn = try c.decode(Bool.self, forKey: .requiresExplicitOptIn)
    }
}

/// `PreviewViewport` (additive.ts `decodePreviewViewport`). `width`/`height`
/// are safe non-negative integers, both non-zero, with `width * height` ≤
/// `PREVIEW_CAPTURE_MAX_PIXELS`. `deviceScaleFactor`, when present, is a finite
/// number in (0, 8].
public struct PreviewViewport: Decodable, Equatable, Sendable {
    public let width: Int
    public let height: Int
    public let deviceScaleFactor: Double?

    private enum CodingKeys: String, CodingKey { case width, height, deviceScaleFactor }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let w = try Bounded.seq(try c.decode(Int.self, forKey: .width), path: "viewport.width")
        let h = try Bounded.seq(try c.decode(Int.self, forKey: .height), path: "viewport.height")
        if w == 0 || h == 0 {
            throw T4WireError.bounds(path: "viewport", reason: "preview viewport dimensions exceed limit")
        }
        if w > Previews.captureMaxPixels || h > Previews.captureMaxPixels || w > Previews.captureMaxPixels / h {
            throw T4WireError.bounds(path: "viewport", reason: "preview viewport dimensions exceed limit")
        }
        width = w
        height = h
        if let raw = try c.decodeIfPresent(Double.self, forKey: .deviceScaleFactor) {
            guard raw.isFinite, raw > 0, raw <= 8 else {
                throw T4WireError.bounds(path: "viewport.deviceScaleFactor", reason: "preview device scale factor exceeds limit")
            }
            deviceScaleFactor = raw
        } else {
            deviceScaleFactor = nil
        }
    }
}

/// `PreviewCaptureMetadata` (additive.ts `decodePreviewCaptureMetadata`).
/// `captureId` is an opaque id; `mimeType` is a strict
/// `PreviewCaptureMimeType`; `size`/`width`/`height`/`capturedAt` are safe
/// non-negative integers; `size` is non-zero and ≤ `PREVIEW_CAPTURE_MAX_BYTES`;
/// `width * height` ≤ `PREVIEW_CAPTURE_MAX_PIXELS` (both non-zero); `sha256`
/// is a control-free (<= 64) lowercase hex digest matching `^[0-9a-f]{64}$`.
public struct PreviewCaptureMetadata: Decodable, Equatable, Sendable {
    public let captureId: PreviewCaptureId
    public let mimeType: PreviewCaptureMimeType
    public let size: Int
    public let width: Int
    public let height: Int
    public let capturedAt: Int
    public let sha256: String

    private enum CodingKeys: String, CodingKey {
        case captureId, mimeType, size, width, height, capturedAt, sha256
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        captureId = try IDs.opaque(try c.decode(String.self, forKey: .captureId), path: "capture.captureId")
        mimeType = try c.decode(PreviewCaptureMimeType.self, forKey: .mimeType)
        let s = try Bounded.seq(try c.decode(Int.self, forKey: .size), path: "capture.size")
        if s == 0 || s > Previews.captureMaxBytes {
            throw T4WireError.bounds(path: "capture.size", reason: "preview capture size exceeds limit")
        }
        size = s
        let w = try Bounded.seq(try c.decode(Int.self, forKey: .width), path: "capture.width")
        let h = try Bounded.seq(try c.decode(Int.self, forKey: .height), path: "capture.height")
        if w == 0 || h == 0 || w > Previews.captureMaxPixels || h > Previews.captureMaxPixels
            || w > Previews.captureMaxPixels / h {
            throw T4WireError.bounds(path: "capture", reason: "preview capture dimensions exceed limit")
        }
        width = w
        height = h
        capturedAt = try Bounded.seq(try c.decode(Int.self, forKey: .capturedAt), path: "capture.capturedAt")
        let digest = try Bounded.controlFree(try c.decode(String.self, forKey: .sha256), path: "capture.sha256", maxBytes: 64)
        guard digest.wholeMatch(of: #/^[0-9a-f]{64}$/#) != nil else {
            throw T4WireError.invalidFrame(path: "capture.sha256", reason: "preview capture digest must be lowercase sha256")
        }
        sha256 = digest
    }
}

/// `PreviewSnapshot` (additive.ts `decodePreviewSnapshot`) — the common
/// preview state shared by `preview.launch`/`state`/`navigation`/`capture`.
/// `previewId` is an opaque id; `state` is a strict `PreviewState`; `url` is an
/// http(s) URL without credentials (control-free <= 4096); `revision` is an
/// opaque id; `cursor` is a per-session `Cursor`. Optional fields: `title`
/// (bounded text <= 512), `canGoBack`/`canGoForward` (booleans), `viewport`,
/// `capture`, `authority`, and `availableActions` (a bounded, unique array of
/// `PreviewAction`, <= `PREVIEW_ACTIONS.length`).
public struct PreviewSnapshot: Decodable, Equatable, Sendable {
    public let previewId: PreviewId
    public let state: PreviewState
    public let url: String
    public let revision: Revision
    public let cursor: Cursor
    public let title: String?
    public let canGoBack: Bool?
    public let canGoForward: Bool?
    public let viewport: PreviewViewport?
    public let capture: PreviewCaptureMetadata?
    public let authority: PreviewAuthorityDescriptor?
    public let availableActions: [PreviewAction]?

    private enum CodingKeys: String, CodingKey {
        case previewId, state, url, revision, cursor, title, canGoBack, canGoForward
        case viewport, capture, authority, availableActions
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        previewId = try IDs.opaque(try c.decode(String.self, forKey: .previewId), path: "preview.previewId")
        state = try c.decode(PreviewState.self, forKey: .state)
        url = try Previews.httpUrl(try c.decode(String.self, forKey: .url), path: "preview.url")
        revision = try IDs.opaque(try c.decode(String.self, forKey: .revision), path: "preview.revision")
        cursor = try c.decode(Cursor.self, forKey: .cursor)
        if let t = try c.decodeIfPresent(String.self, forKey: .title) {
            title = try Previews.boundedText(t, path: "preview.title", maxBytes: 512)
        } else { title = nil }
        canGoBack = try c.decodeIfPresent(Bool.self, forKey: .canGoBack)
        canGoForward = try c.decodeIfPresent(Bool.self, forKey: .canGoForward)
        viewport = try c.decodeIfPresent(PreviewViewport.self, forKey: .viewport)
        capture = try c.decodeIfPresent(PreviewCaptureMetadata.self, forKey: .capture)
        authority = try c.decodeIfPresent(PreviewAuthorityDescriptor.self, forKey: .authority)
        if let actions = try c.decodeIfPresent([PreviewAction].self, forKey: .availableActions) {
            try Previews.checkArray(actions, path: "preview.availableActions", max: Previews.actionMax)
            try Previews.checkUnique(actions, path: "preview.availableActions")
            availableActions = actions
        } else { availableActions = nil }
    }
}

/// `preview.launch` — a preview has been launched (full snapshot).
public struct PreviewLaunchFrame: Decodable, Equatable, Sendable {
    public let v: String, type: String, hostId: HostId, sessionId: SessionId
    public let previewId: PreviewId, state: PreviewState, url: String, revision: Revision, cursor: Cursor
    public let title: String?, canGoBack: Bool?, canGoForward: Bool?
    public let viewport: PreviewViewport?, capture: PreviewCaptureMetadata?
    public let authority: PreviewAuthorityDescriptor?, availableActions: [PreviewAction]?

    private enum CodingKeys: String, CodingKey {
        case v, type, hostId, sessionId
        case previewId, state, url, revision, cursor, title, canGoBack, canGoForward
        case viewport, capture, authority, availableActions
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try Previews.check(c, type: "preview.launch")
        v = Wire.protocolVersion; type = "preview.launch"
        let ids = try Previews.Ids(from: decoder)
        hostId = ids.hostId; sessionId = ids.sessionId
        let snap = try PreviewSnapshot(from: decoder)
        previewId = snap.previewId; state = snap.state; url = snap.url; revision = snap.revision
        cursor = snap.cursor; title = snap.title; canGoBack = snap.canGoBack; canGoForward = snap.canGoForward
        viewport = snap.viewport; capture = snap.capture; authority = snap.authority
        availableActions = snap.availableActions
    }
}

/// `preview.state` — a preview's state has changed (full snapshot + optional
/// `error` bounded text <= 2048).
public struct PreviewStateFrame: Decodable, Equatable, Sendable {
    public let v: String, type: String, hostId: HostId, sessionId: SessionId
    public let previewId: PreviewId, state: PreviewState, url: String, revision: Revision, cursor: Cursor
    public let title: String?, canGoBack: Bool?, canGoForward: Bool?
    public let viewport: PreviewViewport?, capture: PreviewCaptureMetadata?
    public let authority: PreviewAuthorityDescriptor?, availableActions: [PreviewAction]?
    public let error: String?

    private enum CodingKeys: String, CodingKey {
        case v, type, hostId, sessionId, error
        case previewId, state, url, revision, cursor, title, canGoBack, canGoForward
        case viewport, capture, authority, availableActions
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try Previews.check(c, type: "preview.state")
        v = Wire.protocolVersion; type = "preview.state"
        let ids = try Previews.Ids(from: decoder)
        hostId = ids.hostId; sessionId = ids.sessionId
        let snap = try PreviewSnapshot(from: decoder)
        previewId = snap.previewId; state = snap.state; url = snap.url; revision = snap.revision
        cursor = snap.cursor; title = snap.title; canGoBack = snap.canGoBack; canGoForward = snap.canGoForward
        viewport = snap.viewport; capture = snap.capture; authority = snap.authority
        availableActions = snap.availableActions
        if let e = try c.decodeIfPresent(String.self, forKey: .error) {
            error = try Previews.boundedText(e, path: "error", maxBytes: 2048)
        } else { error = nil }
    }
}

/// `preview.navigation` — a preview has navigated (full snapshot).
public struct PreviewNavigationFrame: Decodable, Equatable, Sendable {
    public let v: String, type: String, hostId: HostId, sessionId: SessionId
    public let previewId: PreviewId, state: PreviewState, url: String, revision: Revision, cursor: Cursor
    public let title: String?, canGoBack: Bool?, canGoForward: Bool?
    public let viewport: PreviewViewport?, capture: PreviewCaptureMetadata?
    public let authority: PreviewAuthorityDescriptor?, availableActions: [PreviewAction]?

    private enum CodingKeys: String, CodingKey {
        case v, type, hostId, sessionId
        case previewId, state, url, revision, cursor, title, canGoBack, canGoForward
        case viewport, capture, authority, availableActions
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try Previews.check(c, type: "preview.navigation")
        v = Wire.protocolVersion; type = "preview.navigation"
        let ids = try Previews.Ids(from: decoder)
        hostId = ids.hostId; sessionId = ids.sessionId
        let snap = try PreviewSnapshot(from: decoder)
        previewId = snap.previewId; state = snap.state; url = snap.url; revision = snap.revision
        cursor = snap.cursor; title = snap.title; canGoBack = snap.canGoBack; canGoForward = snap.canGoForward
        viewport = snap.viewport; capture = snap.capture; authority = snap.authority
        availableActions = snap.availableActions
    }
}

/// `preview.capture` — a preview screenshot was captured. Carries the full
/// snapshot and requires `capture` metadata (non-optional here).
public struct PreviewCaptureFrame: Decodable, Equatable, Sendable {
    public let v: String, type: String, hostId: HostId, sessionId: SessionId
    public let previewId: PreviewId, state: PreviewState, url: String, revision: Revision, cursor: Cursor
    public let title: String?, canGoBack: Bool?, canGoForward: Bool?
    public let viewport: PreviewViewport?
    public let capture: PreviewCaptureMetadata
    public let authority: PreviewAuthorityDescriptor?, availableActions: [PreviewAction]?

    private enum CodingKeys: String, CodingKey {
        case v, type, hostId, sessionId
        case previewId, state, url, revision, cursor, title, canGoBack, canGoForward
        case viewport, capture, authority, availableActions
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try Previews.check(c, type: "preview.capture")
        v = Wire.protocolVersion; type = "preview.capture"
        let ids = try Previews.Ids(from: decoder)
        hostId = ids.hostId; sessionId = ids.sessionId
        let snap = try PreviewSnapshot(from: decoder)
        previewId = snap.previewId; state = snap.state; url = snap.url; revision = snap.revision
        cursor = snap.cursor; title = snap.title; canGoBack = snap.canGoBack; canGoForward = snap.canGoForward
        viewport = snap.viewport; authority = snap.authority; availableActions = snap.availableActions
        guard let cap = snap.capture else {
            throw T4WireError.invalidFrame(path: "capture", reason: "preview capture frame requires capture metadata")
        }
        capture = cap
    }
}

/// `preview.error` — a preview reported an error. Does not carry a snapshot;
/// only the locator plus `previewId`, `cursor`, `revision`, `code`
/// (control-free <= 128), and `message` (bounded text <= 2048).
public struct PreviewErrorFrame: Decodable, Equatable, Sendable {
    public let v: String, type: String, hostId: HostId, sessionId: SessionId
    public let previewId: PreviewId, cursor: Cursor, revision: Revision
    public let code: String, message: String

    private enum CodingKeys: String, CodingKey {
        case v, type, hostId, sessionId, previewId, cursor, revision, code, message
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try Previews.check(c, type: "preview.error")
        v = Wire.protocolVersion; type = "preview.error"
        let ids = try Previews.Ids(from: decoder)
        hostId = ids.hostId; sessionId = ids.sessionId
        previewId = try IDs.opaque(try c.decode(String.self, forKey: .previewId), path: "previewId")
        cursor = try c.decode(Cursor.self, forKey: .cursor)
        revision = try IDs.opaque(try c.decode(String.self, forKey: .revision), path: "revision")
        code = try Bounded.controlFree(try c.decode(String.self, forKey: .code), path: "code", maxBytes: 128)
        message = try Previews.boundedText(try c.decode(String.self, forKey: .message), path: "message", maxBytes: 2048)
    }
}

/// Helpers mirroring host-wire/src/guards.ts + additive.ts for the preview
/// family. Limits (`PREVIEW_CAPTURE_MAX_BYTES`, `PREVIEW_CAPTURE_MAX_PIXELS`)
/// come from host-wire/src/limits.ts; defined locally pending a Limits entry.
enum Previews {
    /// `PREVIEW_CAPTURE_MAX_BYTES` (limits.ts): max byte size of one capture.
    static let captureMaxBytes = 8 * 1024 * 1024
    /// `PREVIEW_CAPTURE_MAX_PIXELS` (limits.ts): max `width * height` product.
    static let captureMaxPixels = 16 * 1024 * 1024
    /// `PREVIEW_ACTIONS.length` — the closed action set's size, used as the
    /// upper bound on `availableActions` (boundedArray).
    static let actionMax = 15

    /// Shared `v` + `type` guard for the preview.* additive frames.
    static func check<K: CodingKey>(_ c: KeyedDecodingContainer<K>, type expected: String) throws {
        let version = try c.decode(String.self, forKey: K(stringValue: "v")!)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: K(stringValue: "type")!) == expected else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected \(expected) frame")
        }
    }

    /// `boundedText` (guards.ts): bounded UTF-8 text — allows empty and control
    /// characters, only enforces a byte-length ceiling.
    static func boundedText(_ s: String, path: String, maxBytes: Int) throws -> String {
        if s.utf8.count > maxBytes {
            throw T4WireError.bounds(path: path, reason: "expected bounded UTF-8 text")
        }
        return s
    }

    /// `boundedArray` (guards.ts): rejects arrays exceeding `max` items.
    static func checkArray<T>(_ array: [T], path: String, max: Int) throws {
        if array.count > max {
            throw T4WireError.bounds(path: path, reason: "expected bounded array")
        }
    }

    /// `decodePreviewActions` uniqueness check (additive.ts): actions must not
    /// repeat. Equality is by raw value.
    static func checkUnique(_ actions: [PreviewAction], path: String) throws {
        if Set(actions).count != actions.count {
            throw T4WireError.invalidFrame(path: path, reason: "preview actions must be unique")
        }
    }

    /// `httpUrl` (additive.ts): a control-free (<= 4096) string that parses as
    /// an http/https URL with no username or password.
    static func httpUrl(_ value: String, path: String) throws -> String {
        let text = try Bounded.controlFree(value, path: path, maxBytes: 4096)
        guard let comps = URLComponents(string: text) else {
            throw T4WireError.invalidFrame(path: path, reason: "invalid preview URL")
        }
        let scheme = comps.scheme ?? ""
        guard scheme == "http" || scheme == "https" else {
            throw T4WireError.invalidFrame(path: path, reason: "preview URL must be http(s) without credentials")
        }
        if let u = comps.user, !u.isEmpty {
            throw T4WireError.invalidFrame(path: path, reason: "preview URL must be http(s) without credentials")
        }
        if let p = comps.password, !p.isEmpty {
            throw T4WireError.invalidFrame(path: path, reason: "preview URL must be http(s) without credentials")
        }
        return text
    }

    /// Shared (hostId, sessionId) locator for every preview.* frame.
    struct Ids: Decodable {
        let hostId: HostId
        let sessionId: SessionId
        private enum CodingKeys: String, CodingKey { case hostId, sessionId }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "hostId")
            sessionId = try IDs.opaque(try c.decode(String.self, forKey: .sessionId), path: "sessionId")
        }
    }
}
