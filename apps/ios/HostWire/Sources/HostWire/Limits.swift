import Foundation

/// Protocol-wide constants (host-wire/src/limits.ts). Kept as a namespace.
public enum Wire {
    /// The single protocol id carried by every frame's `v` field.
    public static let protocolVersion = "omp-app/1"
    /// Schema compatibility version, independent of the T4 package version.
    public static let appWireVersion = "0.7.0"
}

/// Numeric limits from host-wire/src/limits.ts. Names mirror the TS constants.
public enum Limits {
    public static let maxInputBytes = 1_048_576
    public static let maxStringBytes = 65_536
    public static let maxIdBytes = 256
    public static let maxArrayItems = 1_000
    public static let maxMapKeys = 512
    public static let maxCapabilities = 128
    public static let maxSavedCursors = 128
    public static let maxEpochBytes = 128

    public static let imageUploadChunkBytes = 256 * 1024
    public static let imageUploadMaxBytes = 20 * 1024 * 1024
    public static let promptImageMaxCount = 8

    public static let transcriptImageChunkBytes = 256 * 1024
    public static let transcriptImageMaxCount = 64

    public static let maxArtifactsPerEntry = 64
    public static let maxTurnFileChanges = 4_096

    public static let artifactChunkBytes = 256 * 1024
    public static let artifactMaxBytes = 20 * 1024 * 1024

    public static let previewCaptureChunkBytes = 256 * 1024
    public static let previewCaptureMaxBytes = 8 * 1024 * 1024
    public static let previewCaptureMaxPixels = 16 * 1024 * 1024
    public static let previewMaxPerSession = 8
    public static let previewLeaseTtlMaxMs = 10 * 60 * 1000
}
