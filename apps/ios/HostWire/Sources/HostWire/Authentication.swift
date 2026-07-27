import Foundation

/// `{ deviceId, deviceToken }` — a paired device's credentials, sent in the
/// hello frame (guards.DeviceAuthentication). Exactly two keys.
public struct DeviceAuthentication: Codable, Equatable, Sendable {
    public let deviceId: DeviceId
    public let deviceToken: String

    public init(deviceId: DeviceId, deviceToken: String) {
        self.deviceId = deviceId
        self.deviceToken = deviceToken
    }

    private enum CodingKeys: String, CodingKey { case deviceId, deviceToken }

    public init(from decoder: Decoder) throws {
        // Reject surplus keys, mirroring guards.decodeAuthentication (exactly
        // deviceId + deviceToken). Decode the raw object first, then validate.
        let raw = try decoder.singleValueContainer().decode([String: JSONValue].self)
        guard Set(raw.keys) == Set(["deviceId", "deviceToken"]) else {
            throw T4WireError.invalidFrame(path: "authentication", reason: "authentication must contain only deviceId and deviceToken")
        }
        guard case .string(let did) = raw["deviceId"], case .string(let dt) = raw["deviceToken"] else {
            throw T4WireError.invalidFrame(path: "authentication", reason: "deviceId and deviceToken must be strings")
        }
        deviceId = try IDs.opaque(did, path: "authentication.deviceId", maxBytes: 256)
        deviceToken = try Bounded.deviceToken(dt, path: "authentication.deviceToken")
    }
}
