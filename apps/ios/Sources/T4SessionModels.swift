import SwiftUI
import HostWire

@MainActor
final class T4ConnectionInventoryModel: ObservableObject {
    @Published var sessions: [SessionRef] = []
    @Published var connecting = false
    @Published var connected = false
    @Published var lastError: String?
    @Published var pairedEndpoint: String?
    @Published var hostInfo: T4SessionStore.HostInfo?
    @Published var hasLiveInventory = false
}

@MainActor
final class T4TranscriptProjectionModel: ObservableObject {
    @Published var entries: [String: [TranscriptEntry]] = [:]
    @Published var streamingMessages: [String: StreamingAssistantBuffer] = [:]
    @Published var liveTurns: [String: LiveTurnTimeline] = [:]
    @Published var liveTools: [String: LiveToolProjection] = [:]
    @Published var activeTurns: Set<String> = []
    @Published var todoPhasesBySession: [String: [PlanPhase]] = [:]
    @Published var pagingState: [String: T4SessionStore.TranscriptPaging] = [:]
    @Published var prependingSession: String?
}

@MainActor
final class T4PromptLeaseModel: ObservableObject {
    @Published var pendingConfirmation: ConfirmationChallenge?
    @Published var pendingAsk: T4SessionStore.PendingAsk?
    @Published var fastBySession: [String: Bool] = [:]
}

@MainActor
final class T4AgentInventoryModel: ObservableObject {
    @Published var agentsBySession: [String: [T4SessionStore.AgentState]] = [:]
}

@MainActor
final class T4TerminalModel: ObservableObject {
    @Published var output: [String: String] = [:]
    @Published var exits: [String: Int] = [:]
    @Published var openIdsBySession: [String: [String]] = [:]
    @Published var activeIdBySession: [String: String] = [:]
    @Published var errors: [String: String] = [:]
}

@MainActor
final class T4PreviewBrowserModel: ObservableObject {
    @Published var urlBySession: [String: String] = [:]
    @Published var previewIdBySession: [String: String] = [:]
    @Published var captureImages: [String: PlatformImage] = [:]
    @Published var captureRowsBySession: [String: [T4SessionStore.PreviewCaptureRow]] = [:]
}

@MainActor
final class T4FilesReviewModel: ObservableObject {
    @Published var reviewsBySession: [String: [ReviewFrame]] = [:]
    @Published var artifactChunks: [String: ArtifactReadChunk] = [:]
}

@MainActor
final class T4CatalogSettingsModel: ObservableObject {
    @Published var catalog: [CatalogItem] = []
    @Published var usageSnapshot: UsageReadResult?
    @Published var settingsSnapshot: [String: JSONValue]?
    @Published var settingsRevision: String?
}
