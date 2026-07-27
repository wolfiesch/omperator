import Foundation

/// Files frame family (host-wire/src/additive.ts, files.* additive frames).
/// Host → client: directory listings, reads, writes, patches, and diffs for the
/// session workspace. Paths are safe relative POSIX paths; file content is
/// bounded UTF-8 text (or standard base64 when `encoding == "base64"`).

/// `MAX_FILE_BYTES` (host-wire/src/limits.ts): the byte budget for a single
/// file's text/base64 content, and (× 1024) the upper bound on a listed size.
private let maxFileBytes = 768 * 1024

/// One row of a `files.list` frame (additive.ts `decodeFileListEntry`).
/// The entry is a bounded object: `path`/`kind`/`size`/`revision` are typed and
/// validated; any remaining keys round-trip as `extra`.
public struct FileListEntry: Decodable, Equatable, Sendable {
    public let path: String
    public let kind: String
    public let size: Int?
    public let revision: Revision?
    public let extra: [String: JSONValue]

    public init(from decoder: Decoder) throws {
        try self.init(from: try JSONValue(from: decoder), at: "entry")
    }

    /// Validate a list entry from its raw JSON object at `path`
    /// (e.g. `entries[3]`). Mirrors `decodeFileListEntry`.
    public init(from value: JSONValue, at path: String) throws {
        guard case let .object(obj) = value else {
            throw T4WireError.invalidFrame(path: path, reason: "file list entry must be an object")
        }
        if obj.count > Limits.maxMapKeys {
            throw T4WireError.bounds(path: path, reason: "too many object keys")
        }
        guard case let .string(p) = obj["path"] ?? .null else {
            throw T4WireError.invalidFrame(path: "\(path).path", reason: "expected a string")
        }
        self.path = try Files.safeRelativePath(p, path: "\(path).path")
        guard case let .string(k) = obj["kind"] ?? .null else {
            throw T4WireError.invalidFrame(path: "\(path).kind", reason: "expected a string")
        }
        guard k == "file" || k == "directory" || k == "symlink" else {
            throw T4WireError.invalidFrame(path: "\(path).kind", reason: "expected file, directory, or symlink")
        }
        kind = k
        if let s = obj["size"] {
            guard case let .number(n) = s else {
                throw T4WireError.invalidFrame(path: "\(path).size", reason: "expected a number")
            }
            // Number.isSafeInteger: finite, integral, within ±2^53-1.
            guard n.isFinite, n.rounded() == n, abs(n) <= 9_007_199_254_740_991 else {
                throw T4WireError.unsafeSequence(path: "\(path).size")
            }
            var sizeValue = Int(n)
            sizeValue = try Bounded.seq(sizeValue, path: "\(path).size")
            if sizeValue > maxFileBytes * 1024 {
                throw T4WireError.bounds(path: "\(path).size", reason: "file size exceeds limit")
            }
            size = sizeValue
        } else { size = nil }
        if let r = obj["revision"] {
            guard case let .string(rv) = r else {
                throw T4WireError.invalidFrame(path: "\(path).revision", reason: "expected a string")
            }
            revision = try IDs.opaque(rv, path: "\(path).revision")
        } else { revision = nil }
        var ex = obj
        ex.removeValue(forKey: "path")
        ex.removeValue(forKey: "kind")
        ex.removeValue(forKey: "size")
        ex.removeValue(forKey: "revision")
        extra = ex
    }
}

/// Shared (hostId, sessionId, path) header for the files.* additive frames.
private struct FilesHeader: Decodable {
    let hostId: HostId
    let sessionId: SessionId
    let path: String
    private enum CodingKeys: String, CodingKey { case hostId, sessionId, path }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hostId = try IDs.opaque(try c.decode(String.self, forKey: .hostId), path: "hostId")
        sessionId = try IDs.opaque(try c.decode(String.self, forKey: .sessionId), path: "sessionId")
        path = try Files.safeRelativePath(try c.decode(String.self, forKey: .path), path: "path")
    }
}

/// files.list — a directory listing at `path`.
public struct FilesListFrame: Decodable, Equatable, Sendable {
    public let v: String, type: String, hostId: HostId, sessionId: SessionId
    public let path: String
    public let entries: [FileListEntry]
    public let cursor: Cursor?
    public let revision: Revision?
    private enum CodingKeys: String, CodingKey { case v, type, hostId, sessionId, path, entries, cursor, revision }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try Files.check(c, type: "files.list")
        v = Wire.protocolVersion; type = "files.list"
        let h = try FilesHeader(from: decoder)
        hostId = h.hostId; sessionId = h.sessionId; path = h.path
        let raw = try c.decode([JSONValue].self, forKey: .entries)
        if raw.count > Limits.maxArrayItems {
            throw T4WireError.bounds(path: "entries", reason: "expected bounded array")
        }
        entries = try raw.enumerated().map { (i, value) in
            try FileListEntry(from: value, at: "entries[\(i)]")
        }
        cursor = try c.decodeIfPresent(Cursor.self, forKey: .cursor)
        revision = try c.decodeIfPresent(String.self, forKey: .revision).map { try IDs.opaque($0, path: "revision") }
    }
}

/// files.read — file contents at `path`. `content` is bounded UTF-8 text, or
/// standard base64 when `encoding == "base64"`.
public struct FilesReadFrame: Decodable, Equatable, Sendable {
    public let v: String, type: String, hostId: HostId, sessionId: SessionId
    public let path: String
    public let content: String
    public let encoding: String?
    public let revision: Revision?
    private enum CodingKeys: String, CodingKey { case v, type, hostId, sessionId, path, content, encoding, revision }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try Files.check(c, type: "files.read")
        v = Wire.protocolVersion; type = "files.read"
        let h = try FilesHeader(from: decoder)
        hostId = h.hostId; sessionId = h.sessionId; path = h.path
        let enc = try c.decodeIfPresent(String.self, forKey: .encoding)
        if let e = enc {
            guard e == "utf8" || e == "base64" else {
                throw T4WireError.invalidFrame(path: "encoding", reason: "expected utf8 or base64")
            }
            encoding = e
        } else { encoding = nil }
        let raw = try c.decode(String.self, forKey: .content)
        content = try Files.fileContent(raw, encoding: encoding, path: "content")
        revision = try c.decodeIfPresent(String.self, forKey: .revision).map { try IDs.opaque($0, path: "revision") }
    }
}

/// files.write — file contents written at `path`, pinned to a `revision`.
public struct FilesWriteFrame: Decodable, Equatable, Sendable {
    public let v: String, type: String, hostId: HostId, sessionId: SessionId
    public let path: String
    public let content: String
    public let encoding: String?
    public let revision: Revision
    private enum CodingKeys: String, CodingKey { case v, type, hostId, sessionId, path, content, encoding, revision }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try Files.check(c, type: "files.write")
        v = Wire.protocolVersion; type = "files.write"
        let h = try FilesHeader(from: decoder)
        hostId = h.hostId; sessionId = h.sessionId; path = h.path
        let enc = try c.decodeIfPresent(String.self, forKey: .encoding)
        if let e = enc {
            guard e == "utf8" || e == "base64" else {
                throw T4WireError.invalidFrame(path: "encoding", reason: "expected utf8 or base64")
            }
            encoding = e
        } else { encoding = nil }
        let raw = try c.decode(String.self, forKey: .content)
        content = try Files.fileContent(raw, encoding: encoding, path: "content")
        revision = try IDs.opaque(try c.decode(String.self, forKey: .revision), path: "revision")
    }
}

/// files.patch — a text patch applied at `path`, pinned to a `revision`.
public struct FilesPatchFrame: Decodable, Equatable, Sendable {
    public let v: String, type: String, hostId: HostId, sessionId: SessionId
    public let path: String
    public let patch: String
    public let revision: Revision
    private enum CodingKeys: String, CodingKey { case v, type, hostId, sessionId, path, patch, revision }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try Files.check(c, type: "files.patch")
        v = Wire.protocolVersion; type = "files.patch"
        let h = try FilesHeader(from: decoder)
        hostId = h.hostId; sessionId = h.sessionId; path = h.path
        patch = try Files.boundedText(try c.decode(String.self, forKey: .patch), path: "patch", maxBytes: maxFileBytes)
        revision = try IDs.opaque(try c.decode(String.self, forKey: .revision), path: "revision")
    }
}

/// files.diff — a text diff for `path`, optionally between two revisions.
public struct FilesDiffFrame: Decodable, Equatable, Sendable {
    public let v: String, type: String, hostId: HostId, sessionId: SessionId
    public let path: String
    public let diff: String
    public let fromRevision: Revision?
    public let toRevision: Revision?
    private enum CodingKeys: String, CodingKey { case v, type, hostId, sessionId, path, diff, fromRevision, toRevision }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try Files.check(c, type: "files.diff")
        v = Wire.protocolVersion; type = "files.diff"
        let h = try FilesHeader(from: decoder)
        hostId = h.hostId; sessionId = h.sessionId; path = h.path
        diff = try Files.boundedText(try c.decode(String.self, forKey: .diff), path: "diff", maxBytes: maxFileBytes)
        fromRevision = try c.decodeIfPresent(String.self, forKey: .fromRevision).map { try IDs.opaque($0, path: "fromRevision") }
        toRevision = try c.decodeIfPresent(String.self, forKey: .toRevision).map { try IDs.opaque($0, path: "toRevision") }
    }
}

/// Helpers mirroring host-wire/src/guards.ts for the files family.
enum Files {
    /// `boundedText` (guards.ts): a string whose UTF-8 byte length is <= max.
    /// Unlike `Bounded.string`, empty strings are permitted (an empty file is
    /// a valid payload).
    static func boundedText(_ s: String, path: String, maxBytes: Int) throws -> String {
        if s.utf8.count > maxBytes {
            throw T4WireError.bounds(path: path, reason: "expected bounded UTF-8 text")
        }
        return s
    }

    /// `boundedBase64` (guards.ts): a standard base64 string whose decoded byte
    /// length is <= maxDecodedBytes. The encoded form is first bounded as text
    /// at `ceil(maxDecoded * 4 / 3) + 4` chars, then alphabet/padding validated.
    static func boundedBase64(_ s: String, path: String, maxDecodedBytes: Int) throws -> String {
        let maxChars = Int((Double(maxDecodedBytes) * 4.0 / 3.0).rounded(.up)) + 4
        let text = try boundedText(s, path: path, maxBytes: maxChars)
        if text.count % 4 != 0 {
            throw T4WireError.bounds(path: path, reason: "invalid base64 payload")
        }
        guard text.wholeMatch(of: #/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/#) != nil else {
            throw T4WireError.bounds(path: path, reason: "invalid base64 payload")
        }
        guard let data = Data(base64Encoded: text) else {
            throw T4WireError.bounds(path: path, reason: "invalid base64 payload")
        }
        if data.count > maxDecodedBytes {
            throw T4WireError.bounds(path: path, reason: "decoded payload exceeds protocol limit")
        }
        return text
    }

    /// Bounds a `content` field the way `decodeFilesAdditive` does: base64 when
    /// `encoding == "base64"`, otherwise bounded UTF-8 text.
    static func fileContent(_ s: String, encoding: String?, path: String) throws -> String {
        if encoding == "base64" {
            return try boundedBase64(s, path: path, maxDecodedBytes: maxFileBytes)
        }
        return try boundedText(s, path: path, maxBytes: maxFileBytes)
    }

    /// `safeRelativePath` (guards.ts): a control-free non-empty POSIX relative
    /// path (<= 4096 bytes) with no backslash, drive letter, home prefix, or
    /// empty/`.`/`..` segments.
    static func safeRelativePath(_ value: String, path: String, maxBytes: Int = 4096) throws -> String {
        let result = try Bounded.controlFree(value, path: path, maxBytes: maxBytes)
        if result.contains("\\") ||
            result.hasPrefix("/") || result.hasPrefix("//") ||
            result.wholeMatch(of: #/^[A-Za-z]:/#) != nil ||
            result.hasPrefix("~") {
            throw T4WireError.invalidFrame(path: path, reason: "path must be a safe relative POSIX path")
        }
        for part in result.split(separator: "/", omittingEmptySubsequences: false) {
            if part.isEmpty || part == "." || part == ".." {
                throw T4WireError.invalidFrame(path: path, reason: "path contains an unsafe segment")
            }
        }
        return result
    }

    /// Shared `v` + `type` guard for the files.* additive frames.
    static func check<K: CodingKey>(_ c: KeyedDecodingContainer<K>, type expected: String) throws {
        let version = try c.decode(String.self, forKey: K(stringValue: "v")!)
        guard version == Wire.protocolVersion else { throw T4WireError.missingVersion(path: "v", expected: Wire.protocolVersion) }
        guard try c.decode(String.self, forKey: K(stringValue: "type")!) == expected else {
            throw T4WireError.invalidFrame(path: "type", reason: "expected \(expected) frame")
        }
    }
}
