import { describe, expect, it } from "vite-plus/test";
import { OMP_RUNTIME_INTEGRATION } from "@t4-code/client";
import type { DesktopRuntimeController, DesktopRuntimeSnapshot } from "@t4-code/client";
import {
  commandId,
  confirmationId,
  hostId,
  projectId,
  revision,
  sessionId,
  type CatalogFrame,
  type SessionRef,
} from "@t4-code/protocol";
import {
  rendererServerEventFromFrame,
  type CommandRequest,
  type CommandResult,
  type ConfirmRequest,
  type ConfirmResult,
  type RendererServerEventEnvelope,
  type RendererServerFrame,
} from "@t4-code/protocol/desktop-ipc";

import {
  archiveLiveSession,
  deleteLiveSession,
  managementCommandSupport,
  projectRevealSupport,
  renameLiveSession,
  revealLiveProject,
  restoreLiveSession,
  sessionCreateSupport,
  sessionIsArchived,
  sessionIsClosed,
  sessionIsWorking,
  terminateLiveSession,
} from "../src/features/session-runtime/session-management.ts";
import { presentSessionControl } from "../src/features/session-runtime/session-observer.ts";
import type { LiveProjectAddress, LiveSessionAddress } from "../src/platform/live-workspace.ts";

const ADDRESS: LiveSessionAddress = {
  targetId: "target-1",
  hostId: "host-1",
  sessionId: "session-1",
};
const KEY = `${ADDRESS.hostId}\u0000${ADDRESS.sessionId}`;
const PROJECT_ADDRESS: LiveProjectAddress = {
  targetId: ADDRESS.targetId,
  hostId: ADDRESS.hostId,
  projectId: "project-1",
};

function ref(
  options: { archived?: boolean; revision?: string; status?: string; title?: string } = {},
): SessionRef {
  return {
    hostId: hostId(ADDRESS.hostId),
    sessionId: sessionId(ADDRESS.sessionId),
    project: { projectId: projectId("project-1"), name: "Working folder" },
    revision: revision(options.revision ?? "revision-1"),
    title: options.title ?? "Session title",
    status: options.status ?? "idle",
    updatedAt: "2026-07-13T00:00:00.000Z",
    liveState: { phase: options.status === "active" ? "running" : "idle" },
    ...(options.archived ? { archivedAt: "2026-07-13T01:00:00.000Z" } : {}),
  } as SessionRef;
}

function catalog(): CatalogFrame {
  return {
    v: "omp-app/1",
    type: "catalog",
    hostId: hostId(ADDRESS.hostId),
    revision: revision("catalog-1"),
    items: [
      "session.create",
      "project.reveal",
      "session.rename",
      "session.archive",
      "session.restore",
      "session.close",
      "session.delete",
    ].map((name) => ({
      id: `command-${name}` as never,
      kind: "command" as const,
      name,
      supported: true,
      capabilities: ["sessions.manage"],
    })),
  };
}

class FakeManagementController {
  readonly commands: CommandRequest["intent"][] = [];
  readonly controllerLeaseCommands: CommandRequest["intent"][] = [];
  readonly controllerLeaseAcquisitions: string[] = [];
  readonly confirms: ConfirmRequest[] = [];
  maxConcurrentChallengedCommands = 0;
  private readonly snapshotListeners = new Set<(snapshot: DesktopRuntimeSnapshot) => void>();
  private readonly eventListeners = new Set<(event: RendererServerEventEnvelope) => void>();
  private readonly sessionIndex = new Map<string, SessionRef>();
  closeRejection: NonNullable<CommandResult["error"]> | null = null;
  emitStaleCloseChallengeDuringLease = false;
  /** Marks the host inventory incomplete so the write link reads cached. */
  inventoryTruncated = false;
  /** Test hook: runs right after a destructive challenge is issued. */
  onChallenge: (() => void) | null = null;
  private pendingMutation: "rename" | "archive" | "restore" | "close" | "delete" | null = null;
  private pendingName = "";
  private challengeGate: ReturnType<typeof Promise.withResolvers<void>> | null = null;
  private activeChallengedCommands = 0;
  private sequence = 0;

  constructor(initial: SessionRef = ref()) {
    this.sessionIndex.set(KEY, initial);
  }

  /** Test hook: swap the indexed ref (e.g. a takeover landing mid-flow). */
  replaceRef(next: SessionRef): void {
    this.sessionIndex.set(KEY, next);
  }

  /** Lease shape for close acquisitions; releases are recorded below. */
  leaseRequired = false;
  onLeaseAcquire: (() => void) | null = null;
  readonly leaseReleases: string[] = [];

  controllerLeaseFor(): undefined {
    return undefined;
  }

  async releaseControllerLease(
    _targetId: string,
    _hostId: string,
    _sessionId: string,
    _expectedRevision: string,
    leaseId?: string,
  ): Promise<{ readonly required: boolean; readonly accepted: boolean }> {
    this.leaseReleases.push(leaseId ?? "");
    return { required: true, accepted: true };
  }

  getSnapshot(): DesktopRuntimeSnapshot {
    return {
      version: 1,
      integration: OMP_RUNTIME_INTEGRATION,
      platform: "linux",
      desktopVersion: "test",
      startState: "started",
      targets: new Map([
        [
          ADDRESS.targetId,
          {
            targetId: ADDRESS.targetId,
            kind: "local",
            label: "This Mac",
            state: "connected",
            paired: true,
          },
        ],
      ]),
      connections: new Map([[ADDRESS.targetId, "connected"]]),
      targetHosts: new Map([[ADDRESS.targetId, ADDRESS.hostId]]),
      hosts: new Map([
        [
          ADDRESS.hostId,
          {
            targetId: ADDRESS.targetId,
            hostId: ADDRESS.hostId,
            ompVersion: "test",
            ompBuild: "test",
            appserverVersion: "test",
            appserverBuild: "test",
            epoch: "epoch-1",
            grantedCapabilities: ["sessions.manage"],
            grantedFeatures: ["project.reveal"],
            negotiatedLimits: {},
            authentication: "local",
            resumed: false,
          },
        ],
      ]),
      catalogs: new Map([[ADDRESS.hostId, catalog()]]),
      settings: new Map(),
      projection: {
        version: 1,
        sessions: new Map(),
        sessionIndex: this.sessionIndex,
        sessionIndexMetadata: new Map([
          [
            ADDRESS.hostId,
            { truncated: this.inventoryTruncated, totalCount: this.sessionIndex.size },
          ],
        ]) as DesktopRuntimeSnapshot["projection"]["sessionIndexMetadata"],
        sessionRefArrivalOrdinals: new Map(),
        sessionDeltaCursors: new Map(),
        sessionInventoryCursors: new Map(),
        workspaces: new Map(),
        workspaceCursors: new Map(),
        lru: [],
        freshness: "fresh",
        arrivalOrdinal: 0,
      },
      runtimeErrors: [],
    };
  }

  subscribe(listener: (snapshot: DesktopRuntimeSnapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  subscribeEvents(
    _filter: unknown,
    listener: (event: RendererServerEventEnvelope) => void,
  ): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async command(_targetId: string, intent: CommandRequest["intent"]): Promise<CommandResult> {
    this.commands.push(intent);
    this.sequence += 1;
    const base = {
      targetId: ADDRESS.targetId,
      requestId: `request-${this.sequence}`,
      commandId: `command-${this.sequence}`,
      accepted: true,
    } as const;
    if (intent.command === "session.rename") {
      this.pendingMutation = "rename";
      this.pendingName = String(intent.args?.name ?? "");
      return { ...base, result: { renamed: true } };
    }
    if (intent.command === "session.archive") {
      this.pendingMutation = "archive";
      return { ...base, result: { archived: true } };
    }
    if (intent.command === "session.restore") {
      this.pendingMutation = "restore";
      return { ...base, result: { restored: true } };
    }
    if (intent.command === "project.reveal") {
      return { ...base, result: { revealed: true } };
    }
    if (intent.command === "session.close" && this.closeRejection !== null) {
      return { ...base, accepted: false, error: this.closeRejection };
    }
    if (intent.command === "session.close") {
      this.pendingMutation = "close";
      this.challengeGate = Promise.withResolvers<void>();
      this.activeChallengedCommands += 1;
      this.maxConcurrentChallengedCommands = Math.max(
        this.maxConcurrentChallengedCommands,
        this.activeChallengedCommands,
      );
      const current = this.sessionIndex.get(KEY);
      this.emitFrame({
        v: "omp-app/1",
        type: "confirmation",
        confirmationId: confirmationId("close-confirmation"),
        commandId: commandId(base.commandId),
        hostId: hostId(ADDRESS.hostId),
        sessionId: sessionId(ADDRESS.sessionId),
        commandHash: "sha256:close",
        revision: current?.revision ?? revision("missing"),
        expiresAt: "2999-01-01T00:00:00.000Z",
        summary: "session.close",
      });
      this.onChallenge?.();
      try {
        await this.challengeGate.promise;
      } finally {
        this.activeChallengedCommands -= 1;
      }
      return { ...base, result: { closed: true } };
    }
    if (intent.command === "session.delete") {
      this.pendingMutation = "delete";
      this.challengeGate = Promise.withResolvers<void>();
      this.activeChallengedCommands += 1;
      this.maxConcurrentChallengedCommands = Math.max(
        this.maxConcurrentChallengedCommands,
        this.activeChallengedCommands,
      );
      const current = this.sessionIndex.get(KEY);
      this.emitFrame({
        v: "omp-app/1",
        type: "confirmation",
        confirmationId: confirmationId("delete-confirmation"),
        commandId: commandId(base.commandId),
        hostId: hostId(ADDRESS.hostId),
        sessionId: sessionId(ADDRESS.sessionId),
        commandHash: "sha256:delete",
        revision: current?.revision ?? revision("missing"),
        expiresAt: "2999-01-01T00:00:00.000Z",
        summary: "session.delete",
      });
      this.onChallenge?.();
      try {
        await this.challengeGate.promise;
      } finally {
        this.activeChallengedCommands -= 1;
      }
      return { ...base, result: { deleted: true } };
    }
    if (intent.command === "session.list") {
      this.applyPendingMutation();
      this.emitSnapshot();
      return base;
    }
    throw new Error(`unexpected command: ${intent.command}`);
  }

  async commandWithControllerLease(
    targetId: string,
    intent: CommandRequest["intent"],
  ): Promise<CommandResult> {
    this.controllerLeaseCommands.push(intent);
    return this.command(targetId, intent);
  }

  async acquireControllerLease(
    _targetId: string,
    _hostId: string,
    _sessionId: string,
    expectedRevision: string,
  ): Promise<{ readonly required: false } | { readonly required: true; readonly leaseId: string }> {
    this.controllerLeaseAcquisitions.push(expectedRevision);
    if (this.emitStaleCloseChallengeDuringLease) {
      this.emitFrame({
        v: "omp-app/1",
        type: "confirmation",
        confirmationId: confirmationId("stale-close-confirmation"),
        commandId: commandId("stale-close-command"),
        hostId: hostId(ADDRESS.hostId),
        sessionId: sessionId(ADDRESS.sessionId),
        commandHash: "sha256:stale-close",
        revision: revision(expectedRevision),
        expiresAt: "2999-01-01T00:00:00.000Z",
        summary: "session.close",
      });
    }
    this.onLeaseAcquire?.();
    if (this.leaseRequired) return { required: true, leaseId: "close-lease-1" };
    return { required: false };
  }

  async confirm(request: ConfirmRequest): Promise<ConfirmResult> {
    this.confirms.push(request);
    this.challengeGate?.resolve();
    return {
      targetId: request.targetId,
      requestId: "confirm-request",
      confirmationId: request.confirmationId,
      commandId: request.commandId,
      accepted: true,
    };
  }

  private emitFrame(frame: RendererServerFrame): void {
    const event = {
      targetId: ADDRESS.targetId,
      event: rendererServerEventFromFrame(frame),
    };
    for (const listener of this.eventListeners) listener(event);
  }

  private emitSnapshot(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.snapshotListeners) listener(snapshot);
  }

  private applyPendingMutation(): void {
    const current = this.sessionIndex.get(KEY);
    if (current === undefined || this.pendingMutation === null) return;
    if (this.pendingMutation === "delete") {
      this.sessionIndex.delete(KEY);
    } else {
      const alreadyDesired =
        (this.pendingMutation === "archive" && sessionIsArchived(current)) ||
        (this.pendingMutation === "restore" && !sessionIsArchived(current)) ||
        (this.pendingMutation === "close" && sessionIsClosed(current));
      const nextRevision = alreadyDesired
        ? current.revision
        : revision(`${String(current.revision)}-next`);
      const next = {
        ...current,
        revision: nextRevision,
        ...(this.pendingMutation === "rename" ? { title: this.pendingName } : {}),
        ...(this.pendingMutation === "close"
          ? {
              status: "closed",
              pendingApproval: false,
              pendingUserInput: false,
              working: false,
              isWorking: false,
              turnActive: false,
              inFlight: false,
              queuedMessageCount: 0,
              queuedMessages: [],
              liveState: { phase: "idle" },
            }
          : {}),
      } as SessionRef & { archivedAt?: string };
      if (this.pendingMutation === "archive") {
        next.archivedAt = "2026-07-13T02:00:00.000Z";
      } else if (this.pendingMutation === "restore") {
        delete next.archivedAt;
      }
      this.sessionIndex.set(KEY, next);
    }
    this.pendingMutation = null;
  }
}

function controller(fake: FakeManagementController): DesktopRuntimeController {
  return fake as unknown as DesktopRuntimeController;
}

describe("session management authority helpers", () => {
  it("reveals only a negotiated local project and sends no folder path", async () => {
    const fake = new FakeManagementController();
    expect(projectRevealSupport(fake.getSnapshot(), PROJECT_ADDRESS)).toEqual({
      supported: true,
      reason: null,
    });
    await revealLiveProject(controller(fake), PROJECT_ADDRESS);
    expect(fake.commands.at(-1)).toEqual({
      hostId: hostId(ADDRESS.hostId),
      command: "project.reveal",
      args: { projectId: projectId(PROJECT_ADDRESS.projectId) },
    });
    expect(fake.commands.at(-1)).not.toHaveProperty("args.cwd");

    const remote = {
      ...fake.getSnapshot(),
      targets: new Map([
        [
          ADDRESS.targetId,
          {
            targetId: ADDRESS.targetId,
            kind: "remote",
            label: "Remote Mac",
            state: "connected",
            paired: true,
          },
        ],
      ]),
    } as DesktopRuntimeSnapshot;
    expect(projectRevealSupport(remote, PROJECT_ADDRESS)).toEqual({
      supported: false,
      reason: "Reveal in Finder is available only on this Mac",
    });
  });

  it("offers creation only when the live host catalog advertises session.create", () => {
    const snapshot = new FakeManagementController().getSnapshot();
    const address = { targetId: ADDRESS.targetId, hostId: ADDRESS.hostId, projectId: "project-1" };
    expect(sessionCreateSupport(snapshot, address)).toEqual({ supported: true, reason: null });

    const catalogWithoutCreate = catalog();
    const missing = {
      ...snapshot,
      catalogs: new Map([
        [
          ADDRESS.hostId,
          {
            ...catalogWithoutCreate,
            items: catalogWithoutCreate.items.filter((item) => item.name !== "session.create"),
          },
        ],
      ]),
    } as DesktopRuntimeSnapshot;
    expect(sessionCreateSupport(missing, address)).toEqual({
      supported: false,
      reason: "This host does not offer session creation yet",
    });

    const unbound = {
      ...snapshot,
      targetHosts: new Map(),
    } as DesktopRuntimeSnapshot;
    expect(sessionCreateSupport(unbound, address)).toEqual({
      supported: false,
      reason: "Project host binding is no longer available.",
    });

    const syncingController = new FakeManagementController();
    syncingController.inventoryTruncated = true;
    expect(sessionCreateSupport(syncingController.getSnapshot(), address)).toEqual({
      supported: false,
      reason: "This host's session list is still syncing. Try again in a moment.",
    });
  });

  it("renames through the controller lease path, then refreshes the authoritative list", async () => {
    const fake = new FakeManagementController();
    await renameLiveSession(controller(fake), ADDRESS, "  Better title  ");
    expect(fake.controllerLeaseCommands).toHaveLength(1);
    expect(fake.controllerLeaseCommands[0]).toMatchObject({
      command: "session.rename",
      expectedRevision: "revision-1",
      args: { name: "Better title" },
    });
    expect(fake.commands.map((intent) => intent.command)).toEqual([
      "session.rename",
      "session.list",
    ]);
    expect(fake.getSnapshot().projection.sessionIndex.get(KEY)?.title).toBe("Better title");
  });

  it("archives and restores directly, including already-converged idempotent states", async () => {
    const current = new FakeManagementController();
    await archiveLiveSession(controller(current), ADDRESS);
    expect(current.controllerLeaseCommands).toHaveLength(0);
    expect(sessionIsArchived(current.getSnapshot().projection.sessionIndex.get(KEY))).toBe(true);
    await restoreLiveSession(controller(current), ADDRESS);
    expect(sessionIsArchived(current.getSnapshot().projection.sessionIndex.get(KEY))).toBe(false);

    const alreadyArchived = new FakeManagementController(ref({ archived: true }));
    await expect(archiveLiveSession(controller(alreadyArchived), ADDRESS)).resolves.toBeUndefined();
    const alreadyCurrent = new FakeManagementController();
    await expect(restoreLiveSession(controller(alreadyCurrent), ADDRESS)).resolves.toBeUndefined();
  });

  it("auto-approves only the correlated delete challenge and waits for list absence", async () => {
    const fake = new FakeManagementController();
    await deleteLiveSession(controller(fake), ADDRESS);
    expect(fake.confirms).toEqual([
      expect.objectContaining({
        targetId: ADDRESS.targetId,
        confirmationId: "delete-confirmation",
        hostId: ADDRESS.hostId,
        sessionId: ADDRESS.sessionId,
        decision: "approve",
      }),
    ]);
    expect(fake.commands.map((intent) => intent.command)).toEqual([
      "session.delete",
      "session.list",
    ]);
    expect(fake.getSnapshot().projection.sessionIndex.has(KEY)).toBe(false);
  });

  it("terminates an active runtime separately, confirms it, and waits for closed host truth", async () => {
    const stuck = {
      ...ref({ status: "active" }),
      pendingApproval: true,
      pendingUserInput: true,
      working: true,
      isWorking: true,
      turnActive: true,
      inFlight: true,
      queuedMessageCount: 1,
      queuedMessages: ["next"],
      liveState: {
        phase: "compacting",
        isCompacting: true,
        pendingApproval: true,
        pendingUserInput: true,
        queuedMessageCount: 1,
        queuedMessages: ["next"],
      },
    } as SessionRef;
    const fake = new FakeManagementController(stuck);
    expect(sessionIsWorking(fake.getSnapshot().projection.sessionIndex.get(KEY))).toBe(true);
    expect(managementCommandSupport(fake.getSnapshot(), ADDRESS, "session.close")).toEqual({
      supported: true,
      reason: null,
    });
    await terminateLiveSession(controller(fake), ADDRESS);
    expect(fake.controllerLeaseAcquisitions).toEqual(["revision-1"]);
    expect(fake.confirms).toEqual([
      expect.objectContaining({
        targetId: ADDRESS.targetId,
        confirmationId: "close-confirmation",
        hostId: ADDRESS.hostId,
        sessionId: ADDRESS.sessionId,
        decision: "approve",
      }),
    ]);
    expect(fake.commands.map((intent) => intent.command)).toEqual([
      "session.close",
      "session.list",
    ]);
    const closed = fake.getSnapshot().projection.sessionIndex.get(KEY);
    expect(sessionIsClosed(closed)).toBe(true);
    expect(sessionIsWorking(closed)).toBe(false);
    expect(closed).toMatchObject({
      pendingApproval: false,
      pendingUserInput: false,
      working: false,
      isWorking: false,
      turnActive: false,
      inFlight: false,
      queuedMessageCount: 0,
      queuedMessages: [],
      liveState: { phase: "idle" },
    });
    expect(managementCommandSupport(fake.getSnapshot(), ADDRESS, "session.archive")).toEqual({
      supported: true,
      reason: null,
    });
  });

  it("gates every lifecycle mutation while another app controls the session", () => {
    const observed = {
      ...ref(),
      liveState: {
        phase: "running",
        sessionControl: { mode: "observer", lockStatus: "live", transcript: "live" },
      },
    } as SessionRef;
    const fake = new FakeManagementController(observed);
    const expectedReason = presentSessionControl({
      mode: "observer",
      lockStatus: "live",
      transcript: "live",
    }).managementReason;
    for (const command of [
      "session.rename",
      "session.archive",
      "session.restore",
      "session.close",
      "session.delete",
    ] as const) {
      expect(managementCommandSupport(fake.getSnapshot(), ADDRESS, command)).toEqual({
        supported: false,
        reason: expectedReason,
      });
    }
    // Reconciling gates the same way: the takeover has to finish first.
    const reconciling = new FakeManagementController({
      ...ref(),
      liveState: { phase: "idle", sessionControl: { mode: "reconciling", transcript: "live" } },
    } as SessionRef);
    expect(
      managementCommandSupport(reconciling.getSnapshot(), ADDRESS, "session.archive").supported,
    ).toBe(false);
  });

  const SYNCING_REASON = "This session is still syncing from the host. Try again in a moment.";
  const ALL_COMMANDS = [
    "session.rename",
    "session.archive",
    "session.restore",
    "session.close",
    "session.delete",
  ] as const;

  it("disables management honestly while the host inventory is truncated or incomplete", () => {
    // Truncated inventory: the host said the list is cut short.
    const truncated = new FakeManagementController();
    truncated.inventoryTruncated = true;
    for (const command of ALL_COMMANDS) {
      expect(managementCommandSupport(truncated.getSnapshot(), ADDRESS, command)).toEqual({
        supported: false,
        reason: SYNCING_REASON,
      });
    }

    // Incomplete inventory: the host claims more sessions than we indexed.
    const base = new FakeManagementController().getSnapshot();
    const incomplete = {
      ...base,
      projection: {
        ...base.projection,
        sessionIndexMetadata: new Map([[ADDRESS.hostId, { truncated: false, totalCount: 2 }]]),
      },
    } as DesktopRuntimeSnapshot;
    for (const command of ALL_COMMANDS) {
      expect(managementCommandSupport(incomplete, ADDRESS, command)).toEqual({
        supported: false,
        reason: SYNCING_REASON,
      });
    }

    // A complete, current live inventory keeps allowed actions enabled.
    const live = new FakeManagementController();
    expect(managementCommandSupport(live.getSnapshot(), ADDRESS, "session.rename")).toEqual({
      supported: true,
      reason: null,
    });
    expect(managementCommandSupport(live.getSnapshot(), ADDRESS, "session.archive")).toEqual({
      supported: true,
      reason: null,
    });
  });

  it("disables management while this session's warm projection is only cached", () => {
    const base = new FakeManagementController().getSnapshot();
    const warm = (freshness: string): DesktopRuntimeSnapshot => ({
      ...base,
      projection: {
        ...base.projection,
        sessions: new Map([
          [KEY, { freshness }],
        ]) as unknown as DesktopRuntimeSnapshot["projection"]["sessions"],
      },
    });
    for (const command of ALL_COMMANDS) {
      expect(managementCommandSupport(warm("cached"), ADDRESS, command)).toEqual({
        supported: false,
        reason: SYNCING_REASON,
      });
    }
    // A fresh warm projection stays live.
    expect(managementCommandSupport(warm("fresh"), ADDRESS, "session.close")).toEqual({
      supported: true,
      reason: null,
    });
  });

  it("lets the syncing reason outrank the observer reason, matching the dispatch gate", () => {
    const observed = new FakeManagementController({
      ...ref(),
      liveState: {
        phase: "running",
        sessionControl: { mode: "observer", lockStatus: "live", transcript: "live" },
      },
    } as SessionRef);
    observed.inventoryTruncated = true;
    // assertSessionWritableNow() rejects cached before it reads ownership;
    // the support gate promises the same order.
    expect(managementCommandSupport(observed.getSnapshot(), ADDRESS, "session.close")).toEqual({
      supported: false,
      reason: SYNCING_REASON,
    });
  });

  it("ignores a matching stale close challenge emitted during lease acquisition", async () => {
    const fake = new FakeManagementController(ref({ status: "active" }));
    fake.emitStaleCloseChallengeDuringLease = true;
    await terminateLiveSession(controller(fake), ADDRESS);
    expect(fake.confirms).toHaveLength(1);
    expect(fake.confirms[0]?.confirmationId).toBe("close-confirmation");
    expect(fake.confirms[0]?.commandId).not.toBe("stale-close-command");
  });

  it("serializes concurrent destructive commands for the same session", async () => {
    const fake = new FakeManagementController(ref({ status: "active" }));
    await Promise.all([
      terminateLiveSession(controller(fake), ADDRESS),
      terminateLiveSession(controller(fake), ADDRESS),
    ]);
    expect(fake.maxConcurrentChallengedCommands).toBe(1);
    expect(fake.confirms).toHaveLength(2);
    expect(fake.commands.map((intent) => intent.command)).toEqual([
      "session.close",
      "session.list",
      "session.close",
      "session.list",
    ]);
  });

  it("surfaces a stale termination rejection and does not confirm or retry it", async () => {
    const fake = new FakeManagementController(ref({ status: "active" }));
    fake.closeRejection = { code: "stale_revision", message: "revision changed" };
    await expect(terminateLiveSession(controller(fake), ADDRESS)).rejects.toThrow(
      "The session changed before the host could complete this action",
    );
    expect(fake.commands.map((intent) => intent.command)).toEqual(["session.close"]);
    expect(fake.confirms).toHaveLength(0);
  });

  it("still sends idempotent termination when projection is closed so an orphan worker can be reaped", async () => {
    const fake = new FakeManagementController(ref({ status: "closed" }));
    expect(managementCommandSupport(fake.getSnapshot(), ADDRESS, "session.close")).toEqual({
      supported: true,
      reason: null,
    });
    await terminateLiveSession(controller(fake), ADDRESS);
    expect(fake.commands.map((intent) => intent.command)).toEqual([
      "session.close",
      "session.list",
    ]);
    expect(fake.confirms).toHaveLength(1);
    expect(sessionIsClosed(fake.getSnapshot().projection.sessionIndex.get(KEY))).toBe(true);
  });

  it("keeps runtime termination off archived sessions", async () => {
    const fake = new FakeManagementController(ref({ archived: true, status: "closed" }));
    expect(managementCommandSupport(fake.getSnapshot(), ADDRESS, "session.close")).toEqual({
      supported: false,
      reason: "Restore this session before terminating its runtime",
    });
    await expect(terminateLiveSession(controller(fake), ADDRESS)).rejects.toThrow(
      "Restore this session before terminating its runtime",
    );
    expect(fake.commands).toHaveLength(0);
  });

  it("blocks destructive actions while the host reports active work", async () => {
    const fake = new FakeManagementController(ref({ status: "active" }));
    const snapshot = fake.getSnapshot();
    expect(managementCommandSupport(snapshot, ADDRESS, "session.archive")).toEqual({
      supported: false,
      reason: "Terminate the runtime before archiving or deleting it",
    });
    expect(managementCommandSupport(snapshot, ADDRESS, "session.close")).toEqual({
      supported: true,
      reason: null,
    });
    await expect(archiveLiveSession(controller(fake), ADDRESS)).rejects.toThrow(
      "Terminate the runtime before archiving or deleting it",
    );
    await expect(deleteLiveSession(controller(fake), ADDRESS)).rejects.toThrow(
      "Terminate the runtime before archiving or deleting it",
    );
    expect(fake.commands).toHaveLength(0);
  });

  it("blocks destructive actions for an idle ref with an accepted pending prompt", () => {
    const pending = {
      ...ref(),
      liveState: {
        phase: "idle",
        pendingPrompts: [
          {
            entryId: "prompt:pending",
            text: "keep going",
            attachmentCount: 0,
            at: "2026-07-13T00:00:01.000Z",
          },
        ],
      },
    } as SessionRef;
    const fake = new FakeManagementController(pending);
    expect(sessionIsWorking(pending)).toBe(true);
    expect(managementCommandSupport(fake.getSnapshot(), ADDRESS, "session.archive")).toEqual({
      supported: false,
      reason: "Terminate the runtime before archiving or deleting it",
    });
    expect(managementCommandSupport(fake.getSnapshot(), ADDRESS, "session.delete")).toEqual({
      supported: false,
      reason: "Terminate the runtime before archiving or deleting it",
    });
  });

  it("treats queued, waiting, streaming, and compacting host state as active work", () => {
    for (const candidate of [
      { ...ref(), pendingApproval: true },
      { ...ref(), pendingUserInput: true },
      { ...ref(), liveState: { isStreaming: true } },
      { ...ref(), liveState: { isCompacting: true } },
      { ...ref(), liveState: { phase: "waiting" } },
      { ...ref(), liveState: { phase: "awaiting_input" } },
      { ...ref(), liveState: { queuedMessageCount: 1 } },
      { ...ref(), liveState: { queuedMessages: ["next"] } },
      {
        ...ref(),
        liveState: {
          pendingPrompts: [
            {
              entryId: "prompt:plural",
              text: "plural",
              attachmentCount: 0,
              at: "2026-07-13T00:00:01.000Z",
            },
          ],
        },
      },
      {
        ...ref(),
        liveState: {
          pendingPrompt: {
            entryId: "prompt:legacy",
            text: "legacy",
            at: "2026-07-13T00:00:01.000Z",
          },
        },
      },
    ]) {
      expect(sessionIsWorking(candidate as SessionRef)).toBe(true);
    }
    expect(
      sessionIsWorking({
        ...ref(),
        liveState: {
          pendingPrompts: [],
          pendingPrompt: {
            entryId: "prompt:legacy-stale",
            text: "stale",
            at: "2026-07-13T00:00:01.000Z",
          },
        },
      } as SessionRef),
    ).toBe(false);
    expect(sessionIsWorking(ref())).toBe(false);
  });
});

describe("dispatch-time ownership rechecks", () => {
  const OBSERVED_REF = {
    ...ref(),
    liveState: {
      phase: "idle",
      sessionControl: { mode: "observer", lockStatus: "live", transcript: "live" },
    },
  } as SessionRef;
  const OBSERVED_REASON = presentSessionControl({
    mode: "observer",
    lockStatus: "live",
    transcript: "live",
  }).managementReason;

  it("refuses every lifecycle dispatch while another app owns the session", async () => {
    const fake = new FakeManagementController(OBSERVED_REF);
    await expect(renameLiveSession(controller(fake), ADDRESS, "New name")).rejects.toThrow(
      OBSERVED_REASON,
    );
    await expect(archiveLiveSession(controller(fake), ADDRESS)).rejects.toThrow(OBSERVED_REASON);
    await expect(restoreLiveSession(controller(fake), ADDRESS)).rejects.toThrow(OBSERVED_REASON);
    await expect(terminateLiveSession(controller(fake), ADDRESS)).rejects.toThrow(OBSERVED_REASON);
    await expect(deleteLiveSession(controller(fake), ADDRESS)).rejects.toThrow(OBSERVED_REASON);
    expect(fake.commands).toHaveLength(0);
    expect(fake.confirms).toHaveLength(0);
  });

  it("refuses malformed/unknown ownership with unclear copy, never another-app copy", async () => {
    const fake = new FakeManagementController({
      ...ref(),
      liveState: { phase: "idle", sessionControl: { mode: "someday-mode" } },
    } as unknown as SessionRef);
    const unknownReason = presentSessionControl({ mode: "unknown" }).managementReason;
    await expect(terminateLiveSession(controller(fake), ADDRESS)).rejects.toThrow(unknownReason);
    expect(unknownReason.toLowerCase()).toContain("unclear");
    expect(fake.commands).toHaveLength(0);
  });

  it("never approves a termination challenge raced by a takeover", async () => {
    const fake = new FakeManagementController();
    // The takeover lands exactly while the host's confirmation dialog round-
    // trip is pending; the recheck before confirm must refuse the approval.
    fake.onChallenge = () => fake.replaceRef(OBSERVED_REF);
    await expect(terminateLiveSession(controller(fake), ADDRESS)).rejects.toThrow(OBSERVED_REASON);
    expect(fake.confirms).toHaveLength(0);
    expect(fake.commands.filter((intent) => intent.command === "session.list")).toHaveLength(0);
  });
});

describe("close lease cleanup on takeover", () => {
  it("releases a freshly acquired close lease when the takeover lands mid-acquisition", async () => {
    const fake = new FakeManagementController();
    fake.leaseRequired = true;
    const observed = {
      ...ref(),
      liveState: {
        phase: "idle",
        sessionControl: { mode: "observer", lockStatus: "live", transcript: "live" },
      },
    } as SessionRef;
    // The takeover lands exactly during controller-lease acquisition.
    fake.onLeaseAcquire = () => fake.replaceRef(observed);
    await expect(terminateLiveSession(controller(fake), ADDRESS)).rejects.toThrow(
      presentSessionControl({ mode: "observer", lockStatus: "live", transcript: "live" })
        .managementReason,
    );
    // No session.close left, and the new lease was released best-effort.
    expect(fake.commands.filter((intent) => intent.command === "session.close")).toHaveLength(0);
    expect(fake.leaseReleases).toEqual(["close-lease-1"]);
    expect(fake.confirms).toHaveLength(0);
  });
});
