import Foundation

/// Typed command-result decoders (host-wire/src/command.ts
/// `COMMAND_RESULT_DECODERS`). The client receives a result body for each
/// command it sends; this file ports the field shapes + bounds of the most-used
/// commands into typed `Decodable` structs and dispatches them via
/// `CommandResult.decode(command:from:)`.
///
/// The result body carries no `v` field — validation starts from the raw result
/// JSON object. Following the existing port convention (Sessions.swift,
/// Entry.swift), unknown object keys are tolerated rather than rejected, and
/// deeply nested optional sub-structures that have no typed decoder yet are
/// carried as opaque `JSONValue` objects. Identifier, cursor, and entry types
/// are reused from the rest of the module.

// MARK: - Session create / attach

/// `session.create` / `session.fork` result (command.ts `decodeCreate`):
/// `{ session: SessionRef }`.
public struct SessionCreateResult: Decodable, Equatable, Sendable {
    public let session: SessionRef

    private enum CodingKeys: String, CodingKey { case session }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        session = try c.decode(SessionRef.self, forKey: .session)
    }
}

/// `session.attach` result (command.ts `decodeAttach`):
/// `{ attached: Bool, cursor: Cursor }`.
public struct SessionAttachResult: Decodable, Equatable, Sendable {
    public let attached: Bool
    public let cursor: Cursor

    private enum CodingKeys: String, CodingKey { case attached, cursor }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        attached = try c.decode(Bool.self, forKey: .attached)
        cursor = try c.decode(Cursor.self, forKey: .cursor)
    }
}

// MARK: - Runtime list

/// `runtime.list` result (command.ts): `{ runtimes: [RuntimeItem] }` (<= 64).
public struct RuntimeListResult: Decodable, Equatable, Sendable {
    public let runtimes: [RuntimeItem]

    private enum CodingKeys: String, CodingKey { case runtimes }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let items = try c.decode([RuntimeItem].self, forKey: .runtimes)
        if items.count > 64 {
            throw T4WireError.bounds(path: "result.runtimes", reason: "runtimes exceed 64 items")
        }
        runtimes = items
    }
}

/// `native | emulated | unavailable` (command.ts `runtimeSupports`).
public enum RuntimeSupport: String, Decodable, Equatable, Sendable {
    case native, emulated, unavailable
}

/// `available | unavailable | unknown` (command.ts runtime availability state).
public enum RuntimeAvailabilityState: String, Decodable, Equatable, Sendable {
    case available, unavailable, unknown
}

/// One runtime adapter (command.ts `decodeRuntimeResultItem`).
public struct RuntimeItem: Decodable, Equatable, Sendable {
    public let id: String
    public let displayName: String
    public let command: RuntimeCommand
    public let capabilities: [String: RuntimeSupport]
    public let availability: RuntimeAvailability

    private enum CodingKeys: String, CodingKey {
        case id, displayName, command, capabilities, availability
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let idValue = try Bounded.controlFree(try c.decode(String.self, forKey: .id), path: "id", maxBytes: 64)
        guard idValue.wholeMatch(of: #/^[a-z][a-z0-9-]{0,63}$/#) != nil else {
            throw T4WireError.invalidFrame(path: "id", reason: "invalid runtime adapter id")
        }
        id = idValue
        displayName = try Bounded.controlFree(try c.decode(String.self, forKey: .displayName), path: "displayName", maxBytes: 128)
        command = try c.decode(RuntimeCommand.self, forKey: .command)
        let caps = try c.decode([String: RuntimeSupport].self, forKey: .capabilities)
        if caps.count > Limits.maxMapKeys {
            throw T4WireError.bounds(path: "capabilities", reason: "too many capability keys")
        }
        for key in caps.keys {
            _ = try Bounded.controlFree(key, path: "capabilities", maxBytes: 128)
        }
        capabilities = caps
        availability = try c.decode(RuntimeAvailability.self, forKey: .availability)
    }
}

/// `command` sub-object of a runtime adapter (command.ts `decodeRuntimeResultItem`).
public struct RuntimeCommand: Decodable, Equatable, Sendable {
    public let executable: String
    public let arguments: [String]
    public let cwdArgument: String?

    private enum CodingKeys: String, CodingKey { case executable, arguments, cwdArgument }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        executable = try Bounded.controlFree(try c.decode(String.self, forKey: .executable), path: "command.executable", maxBytes: 512)
        let args = try c.decode([String].self, forKey: .arguments)
        if args.count > 64 {
            throw T4WireError.bounds(path: "command.arguments", reason: "arguments exceed 64 items")
        }
        for (i, arg) in args.enumerated() {
            _ = try CR.boundedText(arg, path: "command.arguments[\(i)]", maxBytes: 4096)
        }
        arguments = args
        cwdArgument = try c.decodeIfPresent(String.self, forKey: .cwdArgument).map {
            try Bounded.controlFree($0, path: "command.cwdArgument", maxBytes: 128)
        }
    }
}

/// `availability` sub-object of a runtime adapter. `executable` is present
/// exactly when `state == .unavailable`.
public struct RuntimeAvailability: Decodable, Equatable, Sendable {
    public let state: RuntimeAvailabilityState
    public let executable: String?

    private enum CodingKeys: String, CodingKey { case state, executable }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = try c.decode(RuntimeAvailabilityState.self, forKey: .state)
        let exe = try c.decodeIfPresent(String.self, forKey: .executable)
        switch state {
        case .unavailable:
            guard let exe else {
                throw T4WireError.invalidFrame(path: "availability.executable", reason: "unavailable runtime must name an executable")
            }
            executable = try Bounded.controlFree(exe, path: "availability.executable", maxBytes: 512)
        case .available, .unknown:
            if exe != nil {
                throw T4WireError.invalidFrame(path: "availability.executable", reason: "runtime availability must not carry an executable")
            }
            executable = nil
        }
    }
}

// MARK: - Workspace list

/// `workspace.list` result (command.ts): `{ workspaces: [WorkspaceItem],
/// cursor?: Cursor }` (workspaces <= 256).
public struct WorkspaceListResult: Decodable, Equatable, Sendable {
    public let workspaces: [WorkspaceItem]
    public let cursor: Cursor?

    private enum CodingKeys: String, CodingKey { case workspaces, cursor }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let items = try c.decode([WorkspaceItem].self, forKey: .workspaces)
        if items.count > 256 {
            throw T4WireError.bounds(path: "result.workspaces", reason: "workspaces exceed 256 items")
        }
        workspaces = items
        cursor = try c.decodeIfPresent(Cursor.self, forKey: .cursor)
    }
}

/// A workspace row is either a repository workspace (the common rail case) or a
/// cluster infrastructure projection (carries `id`). Discriminated by the
/// presence of `id` (command.ts `decodeWorkspaceResultItem`).
public enum WorkspaceItem: Decodable, Equatable, Sendable {
    case repository(RepositoryWorkspace)
    case infrastructure(InfrastructureWorkspace)

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyCodingKey.self)
        if c.contains(AnyCodingKey(stringValue: "id")!) {
            self = .infrastructure(try InfrastructureWorkspace(from: decoder))
        } else {
            self = .repository(try RepositoryWorkspace(from: decoder))
        }
    }
}

/// `managed | imported-user | detected-external | repository-root`.
public enum WorkspaceOwnership: String, Decodable, Equatable, Sendable {
    case managed
    case importedUser = "imported-user"
    case detectedExternal = "detected-external"
    case repositoryRoot = "repository-root"
}

/// `creating | active | archiving | archived | recovery-required`.
public enum WorkspaceLifecycle: String, Decodable, Equatable, Sendable {
    case creating, active, archiving, archived
    case recoveryRequired = "recovery-required"
}

/// Repository workspace projection (command.ts `decodeWorkspaceResultItem`
/// non-infrastructure branch). `createdAt`/`updatedAt`/`archivedAt` are finite
/// non-negative numbers (epoch milliseconds).
public struct RepositoryWorkspace: Decodable, Equatable, Sendable {
    public let repositoryId: ProjectId
    public let instanceId: String
    public let ownership: WorkspaceOwnership
    public let branch: String
    public let sourceCommit: String
    public let expectedHead: String
    public let lifecycle: WorkspaceLifecycle
    public let createdAt: Double
    public let updatedAt: Double
    public let archivedAt: Double?

    private enum CodingKeys: String, CodingKey {
        case repositoryId, instanceId, ownership, branch, sourceCommit, expectedHead, lifecycle
        case createdAt, updatedAt, archivedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        repositoryId = try IDs.opaque(try c.decode(String.self, forKey: .repositoryId), path: "repositoryId")
        instanceId = try Bounded.controlFree(try c.decode(String.self, forKey: .instanceId), path: "instanceId", maxBytes: 128)
        ownership = try c.decode(WorkspaceOwnership.self, forKey: .ownership)
        branch = try Bounded.controlFree(try c.decode(String.self, forKey: .branch), path: "branch", maxBytes: 256)
        sourceCommit = try Bounded.controlFree(try c.decode(String.self, forKey: .sourceCommit), path: "sourceCommit", maxBytes: 256)
        expectedHead = try Bounded.controlFree(try c.decode(String.self, forKey: .expectedHead), path: "expectedHead", maxBytes: 256)
        lifecycle = try c.decode(WorkspaceLifecycle.self, forKey: .lifecycle)
        let created = try CR.finite(try c.decode(Double.self, forKey: .createdAt), path: "createdAt")
        let updated = try CR.finite(try c.decode(Double.self, forKey: .updatedAt), path: "updatedAt")
        guard created >= 0, updated >= 0 else {
            throw T4WireError.invalidFrame(path: "createdAt", reason: "workspace timestamps must be non-negative")
        }
        createdAt = created
        updatedAt = updated
        if let archived = try c.decodeIfPresent(Double.self, forKey: .archivedAt) {
            let value = try CR.finite(archived, path: "archivedAt")
            guard value >= 0 else {
                throw T4WireError.invalidFrame(path: "archivedAt", reason: "workspace archivedAt must be non-negative")
            }
            archivedAt = value
        } else {
            archivedAt = nil
        }
    }
}

/// `Pending | Ready | Failed | Terminating | Unknown` (cluster.ts WORKSPACE_PHASES).
public enum WorkspacePhase: String, Decodable, Equatable, Sendable {
    case Pending, Ready, Failed, Terminating, Unknown
}

/// `Retain | Delete` (cluster.ts WORKSPACE_RETENTION_POLICIES).
public enum WorkspaceRetentionPolicy: String, Decodable, Equatable, Sendable {
    case Retain, Delete
}

/// Cluster infrastructure workspace projection (cluster.ts
/// `decodeWorkspaceInfrastructureProjection`). `accessMode` is always
/// `ReadWriteMany`; `condition` is carried as an opaque object until its typed
/// decoder is ported.
public struct InfrastructureWorkspace: Decodable, Equatable, Sendable {
    public let id: String
    public let displayName: String
    public let phase: WorkspacePhase
    public let retentionPolicy: WorkspaceRetentionPolicy
    public let storageClass: String?
    public let capacity: String?
    public let accessMode: String
    public let revision: Revision
    public let condition: JSONValue?

    private enum CodingKeys: String, CodingKey {
        case id, displayName, phase, retentionPolicy, storageClass, capacity, accessMode, revision, condition
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let idValue = try Bounded.controlFree(try c.decode(String.self, forKey: .id), path: "id", maxBytes: 253)
        guard idValue.wholeMatch(of: #/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/#) != nil else {
            throw T4WireError.invalidFrame(path: "id", reason: "invalid Kubernetes resource name")
        }
        id = idValue
        let name = try Bounded.controlFree(try c.decode(String.self, forKey: .displayName), path: "displayName", maxBytes: 128)
        guard !name.isEmpty else {
            throw T4WireError.invalidFrame(path: "displayName", reason: "value must not be empty")
        }
        displayName = name
        phase = try c.decode(WorkspacePhase.self, forKey: .phase)
        retentionPolicy = try c.decode(WorkspaceRetentionPolicy.self, forKey: .retentionPolicy)
        storageClass = try c.decodeIfPresent(String.self, forKey: .storageClass).map { sc in
            let value = try Bounded.controlFree(sc, path: "storageClass", maxBytes: 63)
            guard value.wholeMatch(of: #/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/#) != nil else {
                throw T4WireError.invalidFrame(path: "storageClass", reason: "invalid Kubernetes resource name")
            }
            return value
        }
        capacity = try c.decodeIfPresent(String.self, forKey: .capacity).map { cap in
            let value = try Bounded.controlFree(cap, path: "capacity", maxBytes: 32)
            guard !value.isEmpty, value.wholeMatch(of: #/^[1-9][0-9]*(?:Ei|Pi|Ti|Gi|Mi|Ki|E|P|T|G|M|K)$/#) != nil else {
                throw T4WireError.invalidFrame(path: "capacity", reason: "invalid positive Kubernetes storage quantity")
            }
            return value
        }
        let access = try c.decode(String.self, forKey: .accessMode)
        guard access == "ReadWriteMany" else {
            throw T4WireError.invalidFrame(path: "accessMode", reason: "workspace access mode must be ReadWriteMany")
        }
        accessMode = access
        revision = try IDs.opaque(try c.decode(String.self, forKey: .revision), path: "revision")
        if let cond = try c.decodeIfPresent(JSONValue.self, forKey: .condition) {
            guard case .object = cond else {
                throw T4WireError.invalidFrame(path: "condition", reason: "condition must be an object")
            }
            condition = cond
        } else {
            condition = nil
        }
    }
}

// MARK: - Transcript page

/// `transcript.page` result (transcript-page.ts `decodeTranscriptPageResult`):
/// `{ entries: [DurableEntry], nextCursor?: String, hasMore: Bool,
/// generation: String }`. `hasMore` must agree with `nextCursor` presence.
public struct TranscriptPageResult: Decodable, Equatable, Sendable {
    public let entries: [DurableEntry]
    public let nextCursor: String?
    public let hasMore: Bool
    public let generation: String

    private enum CodingKeys: String, CodingKey { case entries, nextCursor, hasMore, generation }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let entryValues = try c.decode([DurableEntry].self, forKey: .entries)
        if entryValues.count > 128 {
            throw T4WireError.bounds(path: "result.entries", reason: "transcript page exceeds 128 entries")
        }
        entries = entryValues
        let cursor = try c.decodeIfPresent(String.self, forKey: .nextCursor).map {
            try Bounded.controlFree($0, path: "result.nextCursor", maxBytes: 2048)
        }
        let more = try c.decode(Bool.self, forKey: .hasMore)
        guard more == (cursor != nil) else {
            throw T4WireError.invalidFrame(path: "result.nextCursor", reason: "nextCursor must be present exactly when hasMore is true")
        }
        nextCursor = cursor
        hasMore = more
        generation = try Bounded.controlFree(try c.decode(String.self, forKey: .generation), path: "result.generation", maxBytes: 128)
    }
}

// MARK: - Usage read

/// `usage.read` result (usage.ts `decodeUsageReadResult`): `{ generatedAt,
/// reports, accountsWithoutUsage, capacity }`.
public struct UsageReadResult: Decodable, Equatable, Sendable {
    public let generatedAt: Int
    public let reports: [UsageReport]
    public let accountsWithoutUsage: [UsageAccountWithoutReport]
    public let capacity: [String: [UsageCapacityWindow]]

    private enum CodingKeys: String, CodingKey { case generatedAt, reports, accountsWithoutUsage, capacity }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        generatedAt = try CR.timestamp(try c.decode(Int.self, forKey: .generatedAt), path: "result.generatedAt")
        let reportValues = try c.decode([UsageReport].self, forKey: .reports)
        if reportValues.count > 64 {
            throw T4WireError.bounds(path: "result.reports", reason: "usage reports exceed 64 items")
        }
        reports = reportValues
        let accounts = try c.decode([UsageAccountWithoutReport].self, forKey: .accountsWithoutUsage)
        if accounts.count > 128 {
            throw T4WireError.bounds(path: "result.accountsWithoutUsage", reason: "accounts exceed 128 items")
        }
        accountsWithoutUsage = accounts
        let cap = try c.decode([String: [UsageCapacityWindow]].self, forKey: .capacity)
        if cap.count > 64 {
            throw T4WireError.bounds(path: "result.capacity", reason: "capacity providers exceed 64")
        }
        for provider in cap.keys {
            _ = try Bounded.controlFree(provider, path: "result.capacity", maxBytes: 128)
        }
        capacity = cap
    }
}

/// `percent | tokens | requests | usd | minutes | bytes | unknown` (usage.ts USAGE_UNITS).
public enum UsageUnit: String, Decodable, Equatable, Sendable {
    case percent, tokens, requests, usd, minutes, bytes, unknown
}

/// `ok | warning | exhausted | unknown` (usage.ts USAGE_STATUSES).
public enum UsageStatus: String, Decodable, Equatable, Sendable {
    case ok, warning, exhausted, unknown
}

/// `api_key | oauth` (usage.ts USAGE_ACCOUNT_TYPES).
public enum UsageAccountType: String, Decodable, Equatable, Sendable {
    case apiKey = "api_key"
    case oauth
}

/// One usage report (usage.ts `decodeReport`). `limits` ids must be unique
/// within the report and each limit's `scope.provider` must match `provider`.
public struct UsageReport: Decodable, Equatable, Sendable {
    public let provider: String
    public let fetchedAt: Int
    public let limits: [UsageLimit]
    public let resetCredits: UsageResetCredits?
    public let notes: [String]?
    public let metadata: JSONValue?

    private enum CodingKeys: String, CodingKey { case provider, fetchedAt, limits, resetCredits, notes, metadata }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let providerValue = try Bounded.controlFree(try c.decode(String.self, forKey: .provider), path: "result.provider", maxBytes: 128)
        provider = providerValue
        fetchedAt = try CR.timestamp(try c.decode(Int.self, forKey: .fetchedAt), path: "result.fetchedAt")
        let limitValues = try c.decode([UsageLimit].self, forKey: .limits)
        if limitValues.count > 32 {
            throw T4WireError.bounds(path: "result.limits", reason: "usage limits exceed 32 per report")
        }
        var seen = Set<String>()
        for (i, limit) in limitValues.enumerated() {
            if seen.contains(limit.id) {
                throw T4WireError.invalidFrame(path: "result.limits[\(i)].id", reason: "duplicate usage limit id")
            }
            seen.insert(limit.id)
            guard limit.scope.provider == providerValue else {
                throw T4WireError.invalidFrame(path: "result.limits[\(i)].scope.provider", reason: "usage limit provider does not match its report")
            }
        }
        limits = limitValues
        resetCredits = try c.decodeIfPresent(UsageResetCredits.self, forKey: .resetCredits)
        if let rawNotes = try c.decodeIfPresent([String].self, forKey: .notes) {
            if rawNotes.count > 8 {
                throw T4WireError.bounds(path: "result.notes", reason: "provider notes exceed 8 items")
            }
            for (i, note) in rawNotes.enumerated() {
                _ = try Bounded.controlFree(note, path: "result.notes[\(i)]", maxBytes: 1024)
            }
            notes = rawNotes
        } else {
            notes = nil
        }
        if let md = try c.decodeIfPresent(JSONValue.self, forKey: .metadata) {
            guard case .object = md else {
                throw T4WireError.invalidFrame(path: "result.metadata", reason: "metadata must be an object")
            }
            metadata = md
        } else {
            metadata = nil
        }
    }
}

/// One usage limit (usage.ts `decodeLimit`).
public struct UsageLimit: Decodable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let scope: UsageScope
    public let window: UsageWindow?
    public let amount: UsageAmount
    public let status: UsageStatus?
    public let notes: [String]?

    private enum CodingKeys: String, CodingKey { case id, label, scope, window, amount, status, notes }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try Bounded.controlFree(try c.decode(String.self, forKey: .id), path: "id", maxBytes: 256)
        label = try Bounded.controlFree(try c.decode(String.self, forKey: .label), path: "label", maxBytes: 512)
        scope = try c.decode(UsageScope.self, forKey: .scope)
        window = try c.decodeIfPresent(UsageWindow.self, forKey: .window)
        amount = try c.decode(UsageAmount.self, forKey: .amount)
        status = try c.decodeIfPresent(UsageStatus.self, forKey: .status)
        if let rawNotes = try c.decodeIfPresent([String].self, forKey: .notes) {
            if rawNotes.count > 8 {
                throw T4WireError.bounds(path: "notes", reason: "limit notes exceed 8 items")
            }
            for (i, note) in rawNotes.enumerated() {
                _ = try Bounded.controlFree(note, path: "notes[\(i)]", maxBytes: 1024)
            }
            notes = rawNotes
        } else {
            notes = nil
        }
    }
}

/// Limit scope (usage.ts `decodeScope`).
public struct UsageScope: Decodable, Equatable, Sendable {
    public let provider: String
    public let accountId: String?
    public let projectId: String?
    public let orgId: String?
    public let modelId: String?
    public let tier: String?
    public let windowId: String?
    public let shared: Bool?

    private enum CodingKeys: String, CodingKey {
        case provider, accountId, projectId, orgId, modelId, tier, windowId, shared
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = try Bounded.controlFree(try c.decode(String.self, forKey: .provider), path: "scope.provider", maxBytes: 128)
        accountId = try c.decodeIfPresent(String.self, forKey: .accountId).map { try Bounded.controlFree($0, path: "scope.accountId", maxBytes: 512) }
        projectId = try c.decodeIfPresent(String.self, forKey: .projectId).map { try Bounded.controlFree($0, path: "scope.projectId", maxBytes: 512) }
        orgId = try c.decodeIfPresent(String.self, forKey: .orgId).map { try Bounded.controlFree($0, path: "scope.orgId", maxBytes: 512) }
        modelId = try c.decodeIfPresent(String.self, forKey: .modelId).map { try Bounded.controlFree($0, path: "scope.modelId", maxBytes: 512) }
        tier = try c.decodeIfPresent(String.self, forKey: .tier).map { try Bounded.controlFree($0, path: "scope.tier", maxBytes: 256) }
        windowId = try c.decodeIfPresent(String.self, forKey: .windowId).map { try Bounded.controlFree($0, path: "scope.windowId", maxBytes: 256) }
        shared = try c.decodeIfPresent(Bool.self, forKey: .shared)
    }
}

/// Reset/rolling window (usage.ts `decodeWindow`).
public struct UsageWindow: Decodable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let durationMs: Int?
    public let resetsAt: Int?

    private enum CodingKeys: String, CodingKey { case id, label, durationMs, resetsAt }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try Bounded.controlFree(try c.decode(String.self, forKey: .id), path: "window.id", maxBytes: 256)
        label = try Bounded.controlFree(try c.decode(String.self, forKey: .label), path: "window.label", maxBytes: 512)
        durationMs = try c.decodeIfPresent(Int.self, forKey: .durationMs).map { try CR.duration($0, path: "window.durationMs") }
        resetsAt = try c.decodeIfPresent(Int.self, forKey: .resetsAt).map { try CR.timestamp($0, path: "window.resetsAt") }
    }
}

/// Amount snapshot (usage.ts `decodeAmount`). Numeric fields are finite doubles
/// bounded to ±1e15; `unit` is required.
public struct UsageAmount: Decodable, Equatable, Sendable {
    public let used: Double?
    public let limit: Double?
    public let remaining: Double?
    public let usedFraction: Double?
    public let remainingFraction: Double?
    public let unit: UsageUnit

    private enum CodingKeys: String, CodingKey {
        case used, limit, remaining, usedFraction, remainingFraction, unit
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        used = try c.decodeIfPresent(Double.self, forKey: .used).map { try CR.boundedNumber($0, path: "amount.used", min: -1_000_000_000_000_000, max: 1_000_000_000_000_000) }
        limit = try c.decodeIfPresent(Double.self, forKey: .limit).map { try CR.boundedNumber($0, path: "amount.limit", min: -1_000_000_000_000_000, max: 1_000_000_000_000_000) }
        remaining = try c.decodeIfPresent(Double.self, forKey: .remaining).map { try CR.boundedNumber($0, path: "amount.remaining", min: -1_000_000_000_000_000, max: 1_000_000_000_000_000) }
        usedFraction = try c.decodeIfPresent(Double.self, forKey: .usedFraction).map { try CR.boundedNumber($0, path: "amount.usedFraction", min: -1_000_000_000_000_000, max: 1_000_000_000_000_000) }
        remainingFraction = try c.decodeIfPresent(Double.self, forKey: .remainingFraction).map { try CR.boundedNumber($0, path: "amount.remainingFraction", min: -1_000_000_000_000_000, max: 1_000_000_000_000_000) }
        unit = try c.decode(UsageUnit.self, forKey: .unit)
    }
}

/// Reset-credit summary (usage.ts `decodeResetCredits`).
public struct UsageResetCredits: Decodable, Equatable, Sendable {
    public let availableCount: Int
    public let credits: [UsageResetCredit]?

    private enum CodingKeys: String, CodingKey { case availableCount, credits }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        availableCount = try CR.count(try c.decode(Int.self, forKey: .availableCount), path: "resetCredits.availableCount", max: 64)
        if let rawCredits = try c.decodeIfPresent([UsageResetCredit].self, forKey: .credits) {
            if rawCredits.count > 64 {
                throw T4WireError.bounds(path: "resetCredits.credits", reason: "reset credits exceed 64 items")
            }
            credits = rawCredits
        } else {
            credits = nil
        }
    }
}

/// One reset credit (usage.ts `decodeResetCredit`).
public struct UsageResetCredit: Decodable, Equatable, Sendable {
    public let grantedAt: String?
    public let expiresAt: String?
    public let status: String?

    private enum CodingKeys: String, CodingKey { case grantedAt, expiresAt, status }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        grantedAt = try c.decodeIfPresent(String.self, forKey: .grantedAt).map { try CR.isoTimestamp($0, path: "grantedAt") }
        expiresAt = try c.decodeIfPresent(String.self, forKey: .expiresAt).map { try CR.isoTimestamp($0, path: "expiresAt") }
        status = try c.decodeIfPresent(String.self, forKey: .status).map { try Bounded.controlFree($0, path: "status", maxBytes: 64) }
    }
}

/// An account with no usage report (usage.ts `decodeAccountWithoutUsage`).
public struct UsageAccountWithoutReport: Decodable, Equatable, Sendable {
    public let provider: String
    public let type: UsageAccountType
    public let email: String?
    public let accountId: String?
    public let projectId: String?
    public let enterpriseUrl: String?
    public let orgId: String?
    public let orgName: String?

    private enum CodingKeys: String, CodingKey {
        case provider, type, email, accountId, projectId, enterpriseUrl, orgId, orgName
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = try Bounded.controlFree(try c.decode(String.self, forKey: .provider), path: "provider", maxBytes: 128)
        type = try c.decode(UsageAccountType.self, forKey: .type)
        email = try c.decodeIfPresent(String.self, forKey: .email).map { try Bounded.controlFree($0, path: "email", maxBytes: 512) }
        accountId = try c.decodeIfPresent(String.self, forKey: .accountId).map { try Bounded.controlFree($0, path: "accountId", maxBytes: 512) }
        projectId = try c.decodeIfPresent(String.self, forKey: .projectId).map { try Bounded.controlFree($0, path: "projectId", maxBytes: 512) }
        enterpriseUrl = try c.decodeIfPresent(String.self, forKey: .enterpriseUrl).map { try CR.enterpriseUrl($0, path: "enterpriseUrl") }
        orgId = try c.decodeIfPresent(String.self, forKey: .orgId).map { try Bounded.controlFree($0, path: "orgId", maxBytes: 512) }
        orgName = try c.decodeIfPresent(String.self, forKey: .orgName).map { try Bounded.controlFree($0, path: "orgName", maxBytes: 512) }
    }
}

/// One capacity window (usage.ts `decodeCapacityWindow`).
public struct UsageCapacityWindow: Decodable, Equatable, Sendable {
    public let window: String
    public let durationMs: Int?
    public let accounts: Int
    public let usedAccounts: Double
    public let remainingAccounts: Double

    private enum CodingKeys: String, CodingKey {
        case window, durationMs, accounts, usedAccounts, remainingAccounts
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        window = try Bounded.controlFree(try c.decode(String.self, forKey: .window), path: "window", maxBytes: 256)
        durationMs = try c.decodeIfPresent(Int.self, forKey: .durationMs).map { try CR.duration($0, path: "durationMs") }
        let accountsValue = try CR.count(try c.decode(Int.self, forKey: .accounts), path: "accounts", max: 2048)
        accounts = accountsValue
        usedAccounts = try CR.boundedNumber(try c.decode(Double.self, forKey: .usedAccounts), path: "usedAccounts", min: 0, max: Double(accountsValue))
        remainingAccounts = try CR.boundedNumber(try c.decode(Double.self, forKey: .remainingAccounts), path: "remainingAccounts", min: 0, max: Double(accountsValue))
    }
}

// MARK: - Host / session watch

/// `host.watch` / `session.watch` result (command.ts `decodeWatchResult`):
/// `{ watchId: String, cursor: Cursor }`.
public struct HostWatchResult: Decodable, Equatable, Sendable {
    public let watchId: String
    public let cursor: Cursor

    private enum CodingKeys: String, CodingKey { case watchId, cursor }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        watchId = try Bounded.controlFree(try c.decode(String.self, forKey: .watchId), path: "result.watchId", maxBytes: 256)
        cursor = try c.decode(Cursor.self, forKey: .cursor)
    }
}

// MARK: - Session state get

/// `all | one-at-a-time` (session-state.ts queue mode).
public enum SessionQueueMode: String, Decodable, Equatable, Sendable {
    case all
    case oneAtATime = "one-at-a-time"
}

/// `immediate | wait` (session-state.ts interrupt mode).
public enum SessionInterruptMode: String, Decodable, Equatable, Sendable {
    case immediate, wait
}

/// Configured model (session-state.ts `SessionModel`).
public struct SessionStateModel: Decodable, Equatable, Sendable {
    public let id: String
    public let provider: String
    public let displayName: String?
    public let selector: String?
    public let role: String?

    private enum CodingKeys: String, CodingKey { case id, provider, displayName, selector, role }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try Bounded.controlFree(try c.decode(String.self, forKey: .id), path: "model.id", maxBytes: 256)
        provider = try Bounded.controlFree(try c.decode(String.self, forKey: .provider), path: "model.provider", maxBytes: 256)
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName).map { try Bounded.controlFree($0, path: "model.displayName", maxBytes: 256) }
        selector = try c.decodeIfPresent(String.self, forKey: .selector).map { try Bounded.controlFree($0, path: "model.selector", maxBytes: 512) }
        role = try c.decodeIfPresent(String.self, forKey: .role).map { try Bounded.controlFree($0, path: "model.role", maxBytes: 256) }
    }
}

/// Queued steering/follow-up messages (session-state.ts `QueuedMessages`).
public struct SessionQueuedMessages: Decodable, Equatable, Sendable {
    public let steering: [String]
    public let followUp: [String]

    private enum CodingKeys: String, CodingKey { case steering, followUp }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        steering = try CR.queue(try c.decode([String].self, forKey: .steering), path: "queuedMessages.steering")
        followUp = try CR.queue(try c.decode([String].self, forKey: .followUp), path: "queuedMessages.followUp")
    }
}

/// `session.state.get` result (session-state.ts `decodeSessionStateResult`).
/// Thinking values are validated against their allowed level sets; the deeply
/// nested model/queues are typed, context usage reuses `ContextUsage`.
public struct SessionStateGetResult: Decodable, Equatable, Sendable {
    public let isStreaming: Bool
    public let isCompacting: Bool
    public let isPaused: Bool
    public let messageCount: Int
    public let queuedMessageCount: Int
    public let steeringMode: SessionQueueMode
    public let followUpMode: SessionQueueMode
    public let interruptMode: SessionInterruptMode
    public let model: SessionStateModel?
    public let thinking: String?
    public let thinkingEffective: String?
    public let thinkingResolved: String?
    public let thinkingLevels: [String]?
    public let thinkingSupported: Bool?
    public let thinkingOffFloored: Bool?
    public let fast: Bool?
    public let fastAvailable: Bool?
    public let fastActive: Bool?
    public let sessionName: String?
    public let contextUsage: ContextUsage?
    public let queuedMessages: SessionQueuedMessages?

    private enum CodingKeys: String, CodingKey {
        case isStreaming, isCompacting, isPaused, messageCount, queuedMessageCount
        case steeringMode, followUpMode, interruptMode, model, thinking, thinkingEffective
        case thinkingResolved, thinkingLevels, thinkingSupported, thinkingOffFloored
        case fast, fastAvailable, fastActive, sessionName, contextUsage, queuedMessages
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        isStreaming = try c.decode(Bool.self, forKey: .isStreaming)
        isCompacting = try c.decode(Bool.self, forKey: .isCompacting)
        isPaused = try c.decode(Bool.self, forKey: .isPaused)
        messageCount = try Bounded.seq(try c.decode(Int.self, forKey: .messageCount), path: "result.messageCount")
        queuedMessageCount = try Bounded.seq(try c.decode(Int.self, forKey: .queuedMessageCount), path: "result.queuedMessageCount")
        steeringMode = try c.decode(SessionQueueMode.self, forKey: .steeringMode)
        followUpMode = try c.decode(SessionQueueMode.self, forKey: .followUpMode)
        interruptMode = try c.decode(SessionInterruptMode.self, forKey: .interruptMode)
        model = try c.decodeIfPresent(SessionStateModel.self, forKey: .model)
        thinking = try c.decodeIfPresent(String.self, forKey: .thinking).map { try CR.thinkingLevel($0, path: "result.thinking", allowed: CR.configuredThinkingLevels) }
        thinkingEffective = try c.decodeIfPresent(String.self, forKey: .thinkingEffective).map { try CR.thinkingLevel($0, path: "result.thinkingEffective", allowed: CR.effectiveThinkingLevels) }
        thinkingResolved = try c.decodeIfPresent(String.self, forKey: .thinkingResolved).map { try CR.thinkingLevel($0, path: "result.thinkingResolved", allowed: CR.thinkingEfforts) }
        if let levels = try c.decodeIfPresent([String].self, forKey: .thinkingLevels) {
            if levels.count > CR.thinkingEfforts.count {
                throw T4WireError.bounds(path: "result.thinkingLevels", reason: "too many thinking levels")
            }
            for (i, level) in levels.enumerated() {
                _ = try CR.thinkingLevel(level, path: "result.thinkingLevels[\(i)]", allowed: CR.thinkingEfforts)
            }
            if Set(levels).count != levels.count {
                throw T4WireError.invalidFrame(path: "result.thinkingLevels", reason: "duplicate thinking level")
            }
            thinkingLevels = levels
        } else {
            thinkingLevels = nil
        }
        thinkingSupported = try c.decodeIfPresent(Bool.self, forKey: .thinkingSupported)
        thinkingOffFloored = try c.decodeIfPresent(Bool.self, forKey: .thinkingOffFloored)
        fast = try c.decodeIfPresent(Bool.self, forKey: .fast)
        fastAvailable = try c.decodeIfPresent(Bool.self, forKey: .fastAvailable)
        fastActive = try c.decodeIfPresent(Bool.self, forKey: .fastActive)
        sessionName = try c.decodeIfPresent(String.self, forKey: .sessionName).map { try Bounded.controlFree($0, path: "result.sessionName", maxBytes: 512) }
        contextUsage = try c.decodeIfPresent(ContextUsage.self, forKey: .contextUsage)
        queuedMessages = try c.decodeIfPresent(SessionQueuedMessages.self, forKey: .queuedMessages)
    }
}

// MARK: - Terminal open

/// `term.open` result (command.ts `decodeTerminalResult`):
/// `{ terminalId, ... }`. The host returns the opaque id of the newly opened
/// pty; the rest of the result object is carried opaquely.
public struct TerminalOpenResult: Decodable, Equatable, Sendable {
    public let terminalId: TerminalId

    private enum CodingKeys: String, CodingKey { case terminalId }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        terminalId = try IDs.opaque(try c.decode(String.self, forKey: .terminalId), path: "result.terminalId")
    }
}

// MARK: - Artifact read

/// `artifact.read` result (command.ts `decodeArtifactReadChunk`): one
/// canonical base64 chunk of a session-retained artifact. `kind` is one of
/// image/text/patch/binary; `content` is standard base64; `complete` agrees
/// with `nextOffset == size`. The host bounds chunks to
/// `Limits.artifactChunkBytes` and total size to `Limits.artifactMaxBytes`.
public struct ArtifactReadChunk: Decodable, Equatable, Sendable {
    public let artifactId: ArtifactId
    public let kind: String
    public let mediaType: String
    public let size: Int
    public let offset: Int
    public let nextOffset: Int
    public let complete: Bool
    public let content: String

    private enum CodingKeys: String, CodingKey {
        case artifactId, kind, mediaType, size, offset, nextOffset, complete, content
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        artifactId = try IDs.artifact(try c.decode(String.self, forKey: .artifactId))
        kind = try Bounded.controlFree(try c.decode(String.self, forKey: .kind), path: "result.kind", maxBytes: 16)
        mediaType = try Bounded.controlFree(try c.decode(String.self, forKey: .mediaType), path: "result.mediaType", maxBytes: 128)
        size = try CR.count(try c.decode(Int.self, forKey: .size), path: "result.size", max: Limits.artifactMaxBytes)
        offset = try CR.count(try c.decode(Int.self, forKey: .offset), path: "result.offset", max: Limits.artifactMaxBytes)
        nextOffset = try CR.count(try c.decode(Int.self, forKey: .nextOffset), path: "result.nextOffset", max: Limits.artifactMaxBytes)
        complete = try c.decode(Bool.self, forKey: .complete)
        content = try Bounded.controlFree(try c.decode(String.self, forKey: .content), path: "result.content", maxBytes: Limits.artifactChunkBytes * 2)
    }

    /// Decode the base64 `content` into raw bytes. Returns nil if the content
    /// is not canonical base64 (defensive — the host validates this, but the
    /// client may be paired with an older host).
    public var decodedBytes: Data? {
        Data(base64Encoded: content)
    }
}

// MARK: - Review read

/// `review.read` result (command.ts: the decoder is the generic `result`, so
/// the body is the review object itself). Mirrors the additive `ReviewFrame`
/// shape: `reviewId`, `status`, optional `path`, and `findings` (opaque
/// objects). Findings are carried as `JSONValue` until a typed per-finding
/// decoder is ported; the UI reads `severity`/`message`/`line` opaquely.
public struct ReviewReadResult: Decodable, Equatable, Sendable {
    public let reviewId: String
    public let status: String
    public let path: String?
    public let findings: [JSONValue]

    private enum CodingKeys: String, CodingKey { case reviewId, status, path, findings }

    /// Memberwise init for client-side synthesis (e.g. offline preview from a
    /// `ReviewFrame`). Bypasses host validation — callers must pass already-
    /// bounded values.
    public init(reviewId: String, status: String, path: String?, findings: [JSONValue]) {
        self.reviewId = reviewId
        self.status = status
        self.path = path
        self.findings = findings
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        reviewId = try Bounded.controlFree(try c.decode(String.self, forKey: .reviewId), path: "result.reviewId", maxBytes: 256)
        status = try Bounded.controlFree(try c.decode(String.self, forKey: .status), path: "result.status", maxBytes: 64)
        path = try c.decodeIfPresent(String.self, forKey: .path).map { try Bounded.controlFree($0, path: "result.path", maxBytes: 4096) }
        let findingValues = try c.decode([JSONValue].self, forKey: .findings)
        if findingValues.count > Limits.maxArrayItems {
            throw T4WireError.bounds(path: "result.findings", reason: "review findings exceed bounded array")
        }
        for (i, finding) in findingValues.enumerated() {
            guard case .object = finding else {
                throw T4WireError.invalidFrame(path: "result.findings[\(i)]", reason: "finding must be an object")
            }
        }
        findings = findingValues
    }
}

// MARK: - Settings read

/// `settings.read` result (command.ts `decodeSettingsResult`): `{ revision,
/// settings }` where `settings` is a bounded settings map. The map is carried
/// opaquely; the UI renders key/value rows.
public struct SettingsReadResult: Decodable, Equatable, Sendable {
    public let revision: Revision
    public let settings: [String: JSONValue]

    private enum CodingKeys: String, CodingKey { case revision, settings }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        revision = try IDs.opaque(try c.decode(String.self, forKey: .revision), path: "result.revision")
        let s = try c.decode(JSONValue.self, forKey: .settings)
        guard case .object(let obj) = s else {
            throw T4WireError.invalidFrame(path: "result.settings", reason: "settings must be an object")
        }
        settings = obj
    }
}

// MARK: - CommandResult dispatch

/// A typed command result. One case per result shape; the command name selects
/// the decoder (command.ts `decodeCommandResult`). Simple `{key: Bool}` ack
/// results collapse to `.accepted` / `.boolean`; the caller knows the field
/// name from the command it issued.
public enum CommandResult: Equatable, Sendable {
    /// `host.list` / `session.list`.
    case sessionList(SessionListResult)
    /// `session.create` / `session.fork`.
    case sessionCreate(SessionCreateResult)
    /// `session.attach`.
    case sessionAttach(SessionAttachResult)
    /// `runtime.list`.
    case runtimeList(RuntimeListResult)
    /// `workspace.list`.
    case workspaceList(WorkspaceListResult)
    /// `transcript.page`.
    case transcriptPage(TranscriptPageResult)
    /// `usage.read`.
    case usageRead(UsageReadResult)
    /// `host.watch` / `session.watch`.
    case hostWatch(HostWatchResult)
    /// `session.state.get`.
    case sessionState(SessionStateGetResult)
    /// `term.open`.
    case termOpen(TerminalOpenResult)
    /// `artifact.read`.
    case artifactRead(ArtifactReadChunk)
    /// `review.read`.
    case reviewRead(ReviewReadResult)
    /// `settings.read`.
    case settingsRead(SettingsReadResult)
    /// `settings.write` — opaque metadata map (boundedMetadata), carried as
    /// an object so the UI can confirm the written values.
    case settingsWrite([String: JSONValue])
    /// `{ accepted: Bool }` — `session.steer`, `session.followUp`,
    /// `session.model.set`, `session.thinking.set`, `session.fast.set`,
    /// `session.ui.respond`, `session.prompt`.
    case accepted(Bool)
    /// A single boolean ack whose key varies by command — `session.rename`,
    /// `session.retry`, `session.compact`, `session.archive`,
    /// `session.restore`, `session.delete`, `session.image.discard`,
    /// `project.reveal`, `session.cancel`, `agent.cancel`, `session.close`.
    case boolean(Bool)

    /// Decode a typed result body for `command` from raw JSON `data`. The body
    /// has no `v` field; validation starts from the result object. Unknown
    /// commands throw `invalidFrame`.
    public static func decode(command: String, from data: Data) throws -> CommandResult {
        let decoder = JSONDecoder()
        switch command {
        case "host.list", "session.list":
            return .sessionList(try decoder.decode(SessionListResult.self, from: data))
        case "session.create", "session.fork":
            return .sessionCreate(try decoder.decode(SessionCreateResult.self, from: data))
        case "session.attach":
            return .sessionAttach(try decoder.decode(SessionAttachResult.self, from: data))
        case "runtime.list":
            return .runtimeList(try decoder.decode(RuntimeListResult.self, from: data))
        case "workspace.list":
            return .workspaceList(try decoder.decode(WorkspaceListResult.self, from: data))
        case "transcript.page":
            return .transcriptPage(try decoder.decode(TranscriptPageResult.self, from: data))
        case "usage.read":
            return .usageRead(try decoder.decode(UsageReadResult.self, from: data))
        case "host.watch", "session.watch":
            return .hostWatch(try decoder.decode(HostWatchResult.self, from: data))
        case "term.open":
            return .termOpen(try decoder.decode(TerminalOpenResult.self, from: data))
        case "session.state.get":
            return .sessionState(try decoder.decode(SessionStateGetResult.self, from: data))
        case "artifact.read":
            return .artifactRead(try decoder.decode(ArtifactReadChunk.self, from: data))
        case "review.read":
            return .reviewRead(try decoder.decode(ReviewReadResult.self, from: data))
        case "settings.read":
            return .settingsRead(try decoder.decode(SettingsReadResult.self, from: data))
        case "settings.write":
            let value = try decoder.decode(JSONValue.self, from: data)
            guard case .object(let obj) = value else {
                throw T4WireError.invalidFrame(path: "result", reason: "settings.write result must be an object")
            }
            return .settingsWrite(obj)
        case "session.steer", "session.followUp", "session.model.set", "session.thinking.set",
             "session.fast.set", "session.ui.respond", "session.prompt":
            return .accepted(try decodeBooleanField(data, key: "accepted"))
        case "session.rename":
            return .boolean(try decodeBooleanField(data, key: "renamed"))
        case "session.retry":
            return .boolean(try decodeBooleanField(data, key: "retried"))
        case "session.compact":
            return .boolean(try decodeBooleanField(data, key: "compacted"))
        case "session.archive":
            return .boolean(try decodeBooleanField(data, key: "archived"))
        case "session.restore":
            return .boolean(try decodeBooleanField(data, key: "restored"))
        case "session.delete":
            return .boolean(try decodeBooleanField(data, key: "deleted"))
        case "session.image.discard":
            return .boolean(try decodeBooleanField(data, key: "discarded"))
        case "project.reveal":
            return .boolean(try decodeBooleanField(data, key: "revealed"))
        case "session.cancel", "agent.cancel":
            return .boolean(try decodeBooleanField(data, key: "cancelled"))
        case "session.close":
            return .boolean(try decodeBooleanField(data, key: "closed"))
        default:
            throw T4WireError.invalidFrame(path: "command", reason: "no typed result decoder for \(command)")
        }
    }

    /// Convenience: decode a typed result from a `JSONValue` (e.g.
    /// `ResultFrame.result`). Re-encodes to JSON then dispatches, mirroring
    /// `ResultFrame.sessionListResult()`.
    public static func decode(command: String, from result: JSONValue) throws -> CommandResult {
        let data = try JSONEncoder().encode(result)
        return try decode(command: command, from: data)
    }

    /// Extract a single named boolean field from a result object (the
    /// `boolField` / `decodeBooleanResult` shape). Tolerates sibling keys, like
    /// `boolField`; the named field must be present and boolean.
    private static func decodeBooleanField(_ data: Data, key: String) throws -> Bool {
        let value = try JSONDecoder().decode(JSONValue.self, from: data)
        guard case let .object(obj) = value else {
            throw T4WireError.invalidFrame(path: "result", reason: "result must be an object")
        }
        guard let v = obj[key] else {
            throw T4WireError.invalidFrame(path: "result.\(key)", reason: "missing field \(key)")
        }
        guard case let .bool(b) = v else {
            throw T4WireError.invalidFrame(path: "result.\(key)", reason: "\(key) must be boolean")
        }
        return b
    }
}

// MARK: - Helpers

/// A coding key that accepts any string, for peeking at discriminator keys.
private struct AnyCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

/// Validators mirroring host-wire/src/guards.ts + usage.ts utilities not already
/// in `Bounded`.
private enum CR {
    /// `boundedText` (guards.ts): a string whose UTF-8 byte length is <= max
    /// (empty strings permitted).
    static func boundedText(_ s: String, path: String, maxBytes: Int) throws -> String {
        if s.utf8.count > maxBytes {
            throw T4WireError.bounds(path: path, reason: "expected bounded UTF-8 text")
        }
        return s
    }

    /// `finiteNumber` (guards.ts): a finite number.
    static func finite(_ n: Double, path: String) throws -> Double {
        guard n.isFinite else {
            throw T4WireError.invalidFrame(path: path, reason: "expected finite number")
        }
        return n
    }

    /// `boundedNumber` (usage.ts): a finite number within [min, max].
    static func boundedNumber(_ n: Double, path: String, min: Double, max: Double) throws -> Double {
        let value = try finite(n, path: path)
        guard value >= min, value <= max else {
            throw T4WireError.bounds(path: path, reason: "usage number is outside its allowed range")
        }
        return value
    }

    /// `timestamp` (usage.ts): a safe integer in [0, 8.64e15].
    static func timestamp(_ n: Int, path: String) throws -> Int {
        try safeInt(n, path: path, min: 0, max: 8_640_000_000_000_000)
    }

    /// `duration` (usage.ts): a safe integer in [0, 315_576_000_000] ms.
    static func duration(_ n: Int, path: String) throws -> Int {
        try safeInt(n, path: path, min: 0, max: 315_576_000_000)
    }

    /// `count` (usage.ts): a safe integer in [0, max].
    static func count(_ n: Int, path: String, max: Int) throws -> Int {
        try safeInt(n, path: path, min: 0, max: max)
    }

    /// Shared safe-integer check: must be a JS safe integer and within range.
    static func safeInt(_ n: Int, path: String, min: Int, max: Int) throws -> Int {
        guard abs(n) <= 9_007_199_254_740_991 else {
            throw T4WireError.bounds(path: path, reason: "must be a safe integer")
        }
        guard n >= min, n <= max else {
            throw T4WireError.bounds(path: path, reason: "out of allowed range")
        }
        return n
    }

    /// `isoTimestamp` (usage.ts): control-free (<= 64) parseable ISO text.
    static func isoTimestamp(_ s: String, path: String) throws -> String {
        let value = try Bounded.controlFree(s, path: path, maxBytes: 64)
        guard ISO8601DateFormatter.canonical.date(from: value) != nil else {
            throw T4WireError.invalidFrame(path: path, reason: "timestamp must be parseable ISO text")
        }
        return value
    }

    /// `safeEnterpriseUrl` (usage.ts): an http(s) URL without credentials,
    /// query, or fragment.
    static func enterpriseUrl(_ s: String, path: String) throws -> String {
        let value = try Bounded.controlFree(s, path: path, maxBytes: 2048)
        guard let comps = URLComponents(string: value) else {
            throw T4WireError.invalidFrame(path: path, reason: "enterpriseUrl must be a valid URL")
        }
        let scheme = comps.scheme?.lowercased()
        guard scheme == "http" || scheme == "https",
              (comps.user?.isEmpty ?? true),
              (comps.password?.isEmpty ?? true),
              (comps.query?.isEmpty ?? true),
              comps.fragment == nil || comps.fragment?.isEmpty == true
        else {
            throw T4WireError.invalidFrame(path: path, reason: "enterpriseUrl must be an http(s) URL without credentials or parameters")
        }
        return value
    }

    /// `SESSION_THINKING_EFFORTS` (session-state.ts).
    static let thinkingEfforts: Set<String> = ["minimal", "low", "medium", "high", "xhigh", "max"]
    /// Configured thinking levels: `inherit | off | auto | <effort>`.
    static let configuredThinkingLevels: Set<String> = thinkingEfforts.union(["inherit", "off", "auto"])
    /// Effective thinking levels: `off | <effort>`.
    static let effectiveThinkingLevels: Set<String> = thinkingEfforts.union(["off"])

    /// `thinkingValue` (session-state.ts): a control-free (<= 64) level within
    /// `allowed`.
    static func thinkingLevel(_ s: String, path: String, allowed: Set<String>) throws -> String {
        let value = try Bounded.controlFree(s, path: path, maxBytes: 64)
        guard allowed.contains(value) else {
            throw T4WireError.invalidFrame(path: path, reason: "invalid thinking level")
        }
        return value
    }

    /// Queued message list (session-state.ts `queues`): <= 128 items, each
    /// bounded text (<= 65536 bytes).
    static func queue(_ items: [String], path: String) throws -> [String] {
        if items.count > 128 {
            throw T4WireError.bounds(path: path, reason: "queue exceeds 128 items")
        }
        for (i, item) in items.enumerated() {
            _ = try boundedText(item, path: "\(path)[\(i)]", maxBytes: 65_536)
        }
        return items
    }
}
