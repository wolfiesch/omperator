import Crypto
import Foundation
import WinSDK

struct WindowsSavedHostCredential: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    static let maximumEndpointBytes = 2_048
    static let maximumDeviceIdentityBytes = 512
    static let maximumDeviceTokenBytes = 1_024

    let endpoint: String
    let deviceID: String
    let deviceToken: String
    let certificatePin: String?

    init(
        endpoint: String,
        deviceID: String,
        deviceToken: String,
        certificatePin: String?
    ) throws {
        self.endpoint = try Self.normalizeEndpoint(endpoint)
        self.deviceID = try Self.validateSecretField(
            deviceID,
            missing: .missingDeviceIdentity,
            maximumBytes: Self.maximumDeviceIdentityBytes
        )
        self.deviceToken = try Self.validateSecretField(
            deviceToken,
            missing: .missingDeviceToken,
            maximumBytes: Self.maximumDeviceTokenBytes
        )
        self.certificatePin = try Self.normalizeCertificatePin(
            certificatePin,
            requiresPin: self.endpoint.hasPrefix("wss://")
        )
    }

    var id: String {
        let digest = SHA256.hash(data: Data(endpoint.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    var displayEndpoint: String { endpoint }

    var description: String {
        "WindowsSavedHostCredential(endpoint: \(displayEndpoint), deviceID: <redacted>, deviceToken: <redacted>, certificatePin: <redacted>)"
    }

    var debugDescription: String { description }

    private static func normalizeEndpoint(_ value: String) throws -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              trimmed.utf8.count <= maximumEndpointBytes,
              var components = URLComponents(string: trimmed),
              let rawScheme = components.scheme,
              let rawHost = components.host,
              !rawHost.isEmpty,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil
        else {
            throw WindowsSavedHostCredentialError.invalidEndpoint
        }
        let scheme = rawScheme.lowercased()
        guard scheme == "ws" || scheme == "wss" else {
            throw WindowsSavedHostCredentialError.invalidEndpoint
        }
        components.scheme = scheme
        components.host = rawHost.lowercased()
        if components.path.isEmpty { components.path = "/v1/ws" }
        guard components.path.hasPrefix("/"),
              let normalized = components.url?.absoluteString,
              normalized.utf8.count <= maximumEndpointBytes
        else {
            throw WindowsSavedHostCredentialError.invalidEndpoint
        }
        return normalized
    }

    private static func validateSecretField(
        _ value: String,
        missing: WindowsSavedHostCredentialError,
        maximumBytes: Int
    ) throws -> String {
        guard !value.isEmpty else { throw missing }
        guard value.utf8.count <= maximumBytes,
              value.unicodeScalars.allSatisfy({
                  !CharacterSet.controlCharacters.contains($0)
              })
        else {
            throw WindowsSavedHostCredentialError.invalidCredential
        }
        return value
    }

    private static func normalizeCertificatePin(
        _ value: String?,
        requiresPin: Bool
    ) throws -> String? {
        let normalized = value?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: ":", with: "")
            .lowercased()
        guard requiresPin else {
            if normalized?.isEmpty == false {
                throw WindowsSavedHostCredentialError.unexpectedCertificatePin
            }
            return nil
        }
        guard let normalized, !normalized.isEmpty else {
            throw WindowsSavedHostCredentialError.missingCertificatePin
        }
        guard normalized.count == 64,
              normalized.unicodeScalars.allSatisfy({
                  ("0"..."9").contains(Character(String($0)))
                      || ("a"..."f").contains(Character(String($0)))
              })
        else {
            throw WindowsSavedHostCredentialError.invalidCertificatePin
        }
        return normalized
    }
}

struct WindowsSavedHostSummary: Equatable, Identifiable, Sendable {
    let id: String
    let endpoint: String
}

enum WindowsSavedHostCredentialError: Error, Equatable, LocalizedError {
    enum Operation: String, Equatable, Sendable {
        case list
        case read
        case save
        case delete
    }

    case invalidEndpoint
    case missingDeviceIdentity
    case missingDeviceToken
    case missingCertificatePin
    case invalidCertificatePin
    case unexpectedCertificatePin
    case invalidCredential
    case payloadTooLarge
    case malformedCredential
    case notFound
    case credentialManager(operation: Operation, code: UInt32)

    var errorDescription: String? {
        switch self {
        case .invalidEndpoint:
            return "The saved host endpoint is invalid."
        case .missingDeviceIdentity:
            return "The host did not provide a device identity."
        case .missingDeviceToken:
            return "The host did not provide a device token."
        case .missingCertificatePin:
            return "A wss host requires its 64-character certificate fingerprint."
        case .invalidCertificatePin:
            return "The certificate fingerprint must contain exactly 64 hexadecimal characters."
        case .unexpectedCertificatePin:
            return "Certificate fingerprints apply only to wss hosts."
        case .invalidCredential:
            return "The host returned an invalid credential."
        case .payloadTooLarge:
            return "The saved host credential is too large for Windows Credential Manager."
        case .malformedCredential:
            return "A saved host credential is damaged or unsupported. Forget and pair that host again."
        case .notFound:
            return "That saved host is no longer available."
        case .credentialManager(let operation, let code):
            return "Windows Credential Manager could not \(operation.rawValue) saved host credentials (error \(code))."
        }
    }
}

protocol WindowsSavedHostCredentialStoring: AnyObject, Sendable {
    func allCredentials() throws -> [WindowsSavedHostCredential]
    func credential(id: String) throws -> WindowsSavedHostCredential?
    func save(_ credential: WindowsSavedHostCredential) throws
    func remove(id: String) throws
}

final class WindowsInMemorySavedHostCredentialStore: WindowsSavedHostCredentialStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var credentialsByID: [String: WindowsSavedHostCredential] = [:]
    private var order: [String] = []

    func allCredentials() -> [WindowsSavedHostCredential] {
        lock.lock()
        defer { lock.unlock() }
        return order.compactMap { credentialsByID[$0] }
    }

    func credential(id: String) -> WindowsSavedHostCredential? {
        lock.lock()
        defer { lock.unlock() }
        return credentialsByID[id]
    }

    func save(_ credential: WindowsSavedHostCredential) {
        lock.lock()
        defer { lock.unlock() }
        credentialsByID[credential.id] = credential
        order.removeAll { $0 == credential.id }
        order.insert(credential.id, at: 0)
    }

    func remove(id: String) {
        lock.lock()
        defer { lock.unlock() }
        credentialsByID.removeValue(forKey: id)
        order.removeAll { $0 == id }
    }
}

enum WindowsCredentialAccessPolicy {
    static func allowsPersistentCredentials(arguments: [String]) -> Bool {
        guard !arguments.contains("-T4Demo"),
              !arguments.contains("-T4NoRestore"),
              EphemeralConnectionCredentials(arguments: arguments) == nil,
              !arguments.contains("-T4PairCode"),
              !arguments.contains("-T4PairEndpoint"),
              !arguments.contains(where: {
                  $0.hasPrefix("-T4") && $0.localizedCaseInsensitiveContains("fixture")
              })
        else {
            return false
        }
        return true
    }
}

enum WindowsSavedHostCredentialStoreFactory {
    static func make(
        arguments: [String] = ProcessInfo.processInfo.arguments
    ) -> any WindowsSavedHostCredentialStoring {
        if WindowsCredentialAccessPolicy.allowsPersistentCredentials(arguments: arguments) {
            return WindowsCredentialManagerSavedHostStore()
        }
        return WindowsInMemorySavedHostCredentialStore()
    }
}

final class WindowsCredentialManagerSavedHostStore: WindowsSavedHostCredentialStoring, @unchecked Sendable {
    static let productionNamespace = "net.t4code.app/Omperator/SavedHost/v1"

    private static let genericCredentialType = DWORD(CRED_TYPE_GENERIC)
    private static let localMachinePersistence = DWORD(CRED_PERSIST_LOCAL_MACHINE)
    private static let maximumBlobSize = Int(CRED_MAX_CREDENTIAL_BLOB_SIZE)

    private let namespace: String
    private var targetPrefix: String { "\(namespace)/" }

    init(namespace: String = productionNamespace) {
        precondition(!namespace.isEmpty && !namespace.contains("*"))
        self.namespace = namespace
    }

    func allCredentials() throws -> [WindowsSavedHostCredential] {
        try rawCredentials()
            .sorted { $0.lastWritten > $1.lastWritten }
            .map { raw in
                let decoded = try WindowsSavedHostCredentialCodec.decode(raw.blob)
                guard targetName(for: decoded.id) == raw.targetName else {
                    throw WindowsSavedHostCredentialError.malformedCredential
                }
                return decoded
            }
    }

    func credential(id: String) throws -> WindowsSavedHostCredential? {
        try validateIdentifier(id)
        var target = wideString(targetName(for: id))
        var pointer: PCREDENTIALW?
        let found = target.withUnsafeMutableBufferPointer { targetBuffer in
            CredReadW(
                targetBuffer.baseAddress,
                Self.genericCredentialType,
                0,
                &pointer
            )
        }
        guard found else {
            let code = GetLastError()
            if code == DWORD(ERROR_NOT_FOUND) { return nil }
            throw WindowsSavedHostCredentialError.credentialManager(
                operation: .read,
                code: code
            )
        }
        guard let pointer else {
            throw WindowsSavedHostCredentialError.malformedCredential
        }
        defer { CredFree(pointer) }
        let credential = pointer.pointee
        guard credential.Type == Self.genericCredentialType else {
            throw WindowsSavedHostCredentialError.malformedCredential
        }
        let decoded = try WindowsSavedHostCredentialCodec.decode(blob(from: credential))
        guard decoded.id == id else {
            throw WindowsSavedHostCredentialError.malformedCredential
        }
        return decoded
    }

    func save(_ credential: WindowsSavedHostCredential) throws {
        var target = wideString(targetName(for: credential.id))
        var blob = try WindowsSavedHostCredentialCodec.encode(credential)
        guard blob.count <= Self.maximumBlobSize else {
            throw WindowsSavedHostCredentialError.payloadTooLarge
        }
        let written = target.withUnsafeMutableBufferPointer { targetBuffer in
            blob.withUnsafeMutableBytes { blobBuffer in
                var value = CREDENTIALW()
                value.Flags = 0
                value.Type = Self.genericCredentialType
                value.TargetName = targetBuffer.baseAddress
                value.Comment = nil
                value.CredentialBlobSize = DWORD(blobBuffer.count)
                value.CredentialBlob = blobBuffer.baseAddress?.assumingMemoryBound(to: BYTE.self)
                value.Persist = Self.localMachinePersistence
                value.AttributeCount = 0
                value.Attributes = nil
                value.TargetAlias = nil
                value.UserName = nil
                return CredWriteW(&value, 0)
            }
        }
        guard written else {
            throw WindowsSavedHostCredentialError.credentialManager(
                operation: .save,
                code: GetLastError()
            )
        }
    }

    func remove(id: String) throws {
        try validateIdentifier(id)
        var target = wideString(targetName(for: id))
        let removed = target.withUnsafeMutableBufferPointer { targetBuffer in
            CredDeleteW(targetBuffer.baseAddress, Self.genericCredentialType, 0)
        }
        guard removed else {
            let code = GetLastError()
            if code == DWORD(ERROR_NOT_FOUND) { return }
            throw WindowsSavedHostCredentialError.credentialManager(
                operation: .delete,
                code: code
            )
        }
    }

    func removeAll() throws {
        for raw in try rawCredentials() {
            var target = wideString(raw.targetName)
            let removed = target.withUnsafeMutableBufferPointer { targetBuffer in
                CredDeleteW(targetBuffer.baseAddress, Self.genericCredentialType, 0)
            }
            if !removed {
                let code = GetLastError()
                guard code == DWORD(ERROR_NOT_FOUND) else {
                    throw WindowsSavedHostCredentialError.credentialManager(
                        operation: .delete,
                        code: code
                    )
                }
            }
        }
    }

    private struct RawCredential {
        let targetName: String
        let blob: Data
        let lastWritten: UInt64
    }

    private func rawCredentials() throws -> [RawCredential] {
        var filter = wideString("\(targetPrefix)*")
        var count: DWORD = 0
        var pointers: UnsafeMutablePointer<PCREDENTIALW?>?
        let listed = filter.withUnsafeMutableBufferPointer { filterBuffer in
            CredEnumerateW(filterBuffer.baseAddress, 0, &count, &pointers)
        }
        guard listed else {
            let code = GetLastError()
            if code == DWORD(ERROR_NOT_FOUND) { return [] }
            throw WindowsSavedHostCredentialError.credentialManager(
                operation: .list,
                code: code
            )
        }
        guard let pointers else {
            throw WindowsSavedHostCredentialError.malformedCredential
        }
        defer { CredFree(pointers) }

        var results: [RawCredential] = []
        results.reserveCapacity(Int(count))
        for index in 0..<Int(count) {
            guard let pointer = pointers[index],
                  pointer.pointee.Type == Self.genericCredentialType,
                  let targetPointer = pointer.pointee.TargetName
            else {
                throw WindowsSavedHostCredentialError.malformedCredential
            }
            let targetName = String(decodingCString: targetPointer, as: UTF16.self)
            guard targetName.hasPrefix(targetPrefix) else { continue }
            let written = pointer.pointee.LastWritten
            let timestamp = UInt64(written.dwHighDateTime) << 32
                | UInt64(written.dwLowDateTime)
            results.append(RawCredential(
                targetName: targetName,
                blob: blob(from: pointer.pointee),
                lastWritten: timestamp
            ))
        }
        return results
    }

    private func blob(from credential: CREDENTIALW) -> Data {
        guard credential.CredentialBlobSize > 0,
              let bytes = credential.CredentialBlob
        else {
            return Data()
        }
        return Data(bytes: bytes, count: Int(credential.CredentialBlobSize))
    }

    private func targetName(for id: String) -> String { "\(targetPrefix)\(id)" }

    private func validateIdentifier(_ id: String) throws {
        guard id.count == 64,
              id.unicodeScalars.allSatisfy({
                  ("0"..."9").contains(Character(String($0)))
                      || ("a"..."f").contains(Character(String($0)))
              })
        else {
            throw WindowsSavedHostCredentialError.notFound
        }
    }

    private func wideString(_ value: String) -> [WCHAR] {
        Array(value.utf16) + [0]
    }
}

enum WindowsSavedHostCredentialCodec {
    private static let magic = Array("OMPHOST1".utf8)
    private static let fieldCount = 4

    static func encode(_ credential: WindowsSavedHostCredential) throws -> Data {
        let fields = [
            credential.endpoint,
            credential.deviceID,
            credential.deviceToken,
            credential.certificatePin ?? "",
        ]
        let fieldByteCount = fields.reduce(into: 0) { $0 += $1.utf8.count }
        var data = Data(capacity: magic.count + fieldCount * 4 + fieldByteCount)
        data.append(contentsOf: magic)
        for field in fields {
            guard field.utf8.count <= Int(UInt32.max) else {
                throw WindowsSavedHostCredentialError.payloadTooLarge
            }
            var length = UInt32(field.utf8.count).bigEndian
            withUnsafeBytes(of: &length) { data.append(contentsOf: $0) }
            data.append(contentsOf: field.utf8)
        }
        guard data.count <= Int(CRED_MAX_CREDENTIAL_BLOB_SIZE) else {
            throw WindowsSavedHostCredentialError.payloadTooLarge
        }
        return data
    }

    static func decode(_ data: Data) throws -> WindowsSavedHostCredential {
        let bytes = [UInt8](data)
        guard bytes.count >= magic.count + fieldCount * 4,
              Array(bytes.prefix(magic.count)) == magic
        else {
            throw WindowsSavedHostCredentialError.malformedCredential
        }
        var offset = magic.count
        var fields: [String] = []
        fields.reserveCapacity(fieldCount)
        for _ in 0..<fieldCount {
            guard offset + 4 <= bytes.count else {
                throw WindowsSavedHostCredentialError.malformedCredential
            }
            let length = Int(UInt32(bytes[offset]) << 24
                | UInt32(bytes[offset + 1]) << 16
                | UInt32(bytes[offset + 2]) << 8
                | UInt32(bytes[offset + 3]))
            offset += 4
            guard length <= bytes.count - offset,
                  let field = String(bytes: bytes[offset..<(offset + length)], encoding: .utf8)
            else {
                throw WindowsSavedHostCredentialError.malformedCredential
            }
            fields.append(field)
            offset += length
        }
        guard offset == bytes.count else {
            throw WindowsSavedHostCredentialError.malformedCredential
        }
        do {
            return try WindowsSavedHostCredential(
                endpoint: fields[0],
                deviceID: fields[1],
                deviceToken: fields[2],
                certificatePin: fields[3].isEmpty ? nil : fields[3]
            )
        } catch {
            throw WindowsSavedHostCredentialError.malformedCredential
        }
    }
}
