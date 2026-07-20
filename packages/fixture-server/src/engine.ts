import {
  AppWireError,
  COMMAND_DESCRIPTORS,
  decodeClientFrame,
  decodeServerFrame,
  type ClientFrame,
  type AgentId,
  type CommandFrame,
  type ConfirmationId,
  type DurableEntry,
  type EntryId,
  type HostId,
  type Revision,
  type ServerFrame,
  type PreviewId,
  type SessionId,
  type SessionRef,
} from "@t4-code/protocol";
import {
  buildCommandSideFrames,
  FIXTURE_PREVIEW_CAPTURE_BASE64,
  fixturePreviewSnapshot,
  isPreviewEventCommand,
} from "./fixture-command-frames.ts";
import {
  applyCreatedSessionManagementMutation,
  applyCreatedSessionModelMutation,
  branded,
  buildEntry,
  buildHistory,
  buildHistoryParts,
  createCreatedFixtureSession,
  type CreatedFixtureSession,
  type Cursor,
  decodeCursor,
  derivedRevision,
  type JournalFrame,
  scheduleFixturePrompt,
  sessionCursor,
  sessionRef,
  snapshotEntries,
} from "./fixture-sessions.ts";
import { canonicalSha256, type ScenarioSeed } from "./seeds.ts";
import { fixtureCatalogItems, fixtureSettings } from "./fixture-catalog.ts";
import { VirtualScheduler } from "./virtual-scheduler.ts";

export { VirtualScheduler } from "./virtual-scheduler.ts";
export { buildHistory, buildHistoryParts };

const V = "omp-app/1" as const;
export const MAX_QUEUE = 128;
export const MAX_JOURNAL = 256;
const MAX_HISTORY_SNAPSHOT = 900;
const SESSION_LIFECYCLE_COMMANDS = new Set([
  "session.archive",
  "session.restore",
  "session.delete",
]);

function isSessionLifecycleCommand(command: string): boolean {
  return SESSION_LIFECYCLE_COMMANDS.has(command);
}

type SavedCommand = { payloadHash: string; response: Extract<ServerFrame, { type: "response" }> };
type SavedChallenge = { command: CommandFrame };

interface ClientState {
  id: string;
  queue: ServerFrame[];
  closed: boolean;
  attached: boolean;
  hello: boolean;
  cursor: Cursor;
  commands: Map<string, SavedCommand>;
  challenges: Map<string, SavedChallenge>;
}
export interface FixtureClient {
  readonly id: string;
  readonly closed: boolean;
  readonly queued: number;
  readonly attached: boolean;
}

export class FixtureEngine {
  readonly scheduler: VirtualScheduler;
  readonly seed: ScenarioSeed;
  private clients = new Map<string, ClientState>();
  private nextClient = 1;
  private seq = 0;
  private previewSeq = 0;
  private sessionIndexSeq = 0;
  private durableCount = 0;
  private epoch: string;
  private revision: Revision;
  private journal: JournalFrame[] = [];
  private settingsRevision: Revision;
  private settingsRevisionSeq = 0;
  private settings: Record<string, unknown>;
  private durableEntries: DurableEntry[];
  private closed = false;
  private nextLiveEntry = 1;
  private archivedAt: string | undefined;
  private sessionDeleted = false;
  private sessionTitle: string;
  private sessionModel = "fixture-model";
  private managementRevision = 0;
  private controlRevision = 0;
  private createdSessions = new Map<string, CreatedFixtureSession>();
  private nextCreatedSession = 1;
  constructor(seed: ScenarioSeed, scheduler = new VirtualScheduler()) {
    this.seed = seed;
    this.scheduler = scheduler;
    this.epoch = seed.epoch;
    this.revision = branded<Revision>(seed.revision);
    this.settingsRevision = branded<Revision>(seed.revision);
    this.settings = fixtureSettings();
    this.sessionTitle = `${seed.id} fixture`;
    this.durableEntries = snapshotEntries(seed);
  }
  get virtualTime(): number {
    return this.scheduler.now;
  }
  get currentCursor(): Cursor {
    return sessionCursor(this.seed, this.seq, this.epoch);
  }
  get currentRevision(): Revision {
    return this.revision;
  }
  get journalSize(): number {
    return this.journal.length;
  }
  get clientCount(): number {
    return this.clients.size;
  }
  /** Snapshot of the sessions currently visible to connected clients. */
  get sessions(): readonly SessionRef[] {
    return this.currentSessionRefs();
  }
  get stateHash(): string {
    return canonicalSha256({
      seed: this.seed,
      epoch: this.epoch,
      seq: this.seq,
      sessionIndexSeq: this.sessionIndexSeq,
      revision: this.revision,
      sessions: this.currentSessionRefs(),
      journal: this.journal.map((frame) => frame.cursor),
      durableEntries: this.durableEntries.map((entry) => entry.id),
      clients: [...this.clients].map(([id, state]) => ({
        id,
        closed: state.closed,
        hello: state.hello,
        attached: state.attached,
        cursor: state.cursor,
      })),
    });
  }
  connect(id = `client-${this.nextClient++}`): FixtureClient {
    if (this.closed) throw new Error("fixture engine is closed");
    if (this.clients.has(id)) throw new Error(`client already exists: ${id}`);
    this.clients.set(id, {
      id,
      queue: [],
      closed: false,
      attached: false,
      hello: false,
      cursor: sessionCursor(this.seed, 0, this.epoch),
      commands: new Map(),
      challenges: new Map(),
    });
    return this.clientInfo(id);
  }
  clientInfo(id: string): FixtureClient {
    const state = this.requireClient(id);
    return { id, closed: state.closed, queued: state.queue.length, attached: state.attached };
  }
  receive(id: string, input: unknown): readonly ServerFrame[] {
    const state = this.requireClient(id);
    if (state.closed) return [];
    let frame: ClientFrame;
    try {
      frame = decodeClientFrame(input);
    } catch (error) {
      this.emit(state, this.errorFrom(error));
      return this.drain(id);
    }
    if (frame.type === "hello") {
      if (state.hello)
        this.emit(state, {
          v: V,
          type: "error",
          code: "INVALID_FRAME",
          message: "hello may only be sent once",
        });
      else this.onHello(state, frame);
      return this.drain(id);
    }
    if (!state.hello) {
      this.emit(state, {
        v: V,
        type: "error",
        code: "HELLO_REQUIRED",
        message: "hello is required before other frames",
      });
      return this.drain(id);
    }
    switch (frame.type) {
      case "ping":
        this.emit(state, { v: V, type: "pong", nonce: frame.nonce, timestamp: frame.timestamp });
        break;
      case "command":
        this.onCommand(state, frame);
        break;
      case "pair.start":
        this.emit(state, {
          v: V,
          type: "pair.ok",
          requestId: frame.requestId,
          pairingId: "pairing-fixture",
          deviceId: frame.deviceId,
          deviceName: frame.deviceName,
          platform: frame.platform,
          requestedCapabilities: frame.requestedCapabilities,
          grantedCapabilities: frame.requestedCapabilities,
          deviceToken: "fixture-device-token",
          expiresAt: new Date(Date.parse(this.seed.baseTime) + 3_600_000).toISOString(),
        } as unknown as ServerFrame);
        break;
      case "confirm":
        this.onConfirm(state, frame);
        break;
      case "terminal.input":
        this.emitTerminalOutput(state, frame);
        break;
      case "terminal.resize":
        break;
      case "terminal.close":
        this.emitTerminalExit(state, frame);
        break;
      default:
        this.emit(state, {
          v: V,
          type: "error",
          code: "INVALID_FRAME",
          message: "unsupported fixture client frame",
        });
    }
    return this.drain(id);
  }
  restart(epoch: string): void {
    if (epoch.length === 0 || epoch === this.epoch) throw new Error("restart requires a new epoch");
    this.epoch = epoch;
    this.seq = 0;
    this.sessionIndexSeq = 0;
    this.durableCount = 0;
    this.revision = branded<Revision>(this.seed.revision);
    this.settingsRevision = branded<Revision>(this.seed.revision);
    this.settingsRevisionSeq = 0;
    this.settings = fixtureSettings();
    this.managementRevision = 0;
    this.controlRevision = 0;
    this.archivedAt = undefined;
    this.sessionDeleted = false;
    this.sessionTitle = `${this.seed.id} fixture`;
    this.sessionModel = "fixture-model";
    this.createdSessions.clear();
    this.nextCreatedSession = 1;
    this.journal = [];
    for (const state of this.clients.values()) {
      state.queue = [];
      state.attached = false;
      state.cursor = sessionCursor(this.seed, 0, this.epoch);
      state.commands.clear();
      state.challenges.clear();
    }
  }
  attach(id: string, saved?: Cursor): readonly ServerFrame[] {
    const state = this.requireClient(id);
    if (!state.hello || state.closed) return [];
    this.attachState(state, saved);
    return this.drain(id);
  }
  executeFaults(): readonly { id: string; code: string; message: string }[] {
    return this.seed.faults.map((fault) => {
      try {
        decodeClientFrame(fault.frame);
        return { id: fault.id, code: "UNEXPECTED_SUCCESS", message: "fault unexpectedly decoded" };
      } catch (error) {
        const protocolCode = error instanceof AppWireError ? error.code : "INVALID_FRAME";
        return {
          id: fault.id,
          code: protocolCode,
          message: error instanceof Error ? error.message : "invalid frame",
        };
      }
    });
  }
  advanceBy(ms: number): void {
    this.scheduler.advanceBy(ms);
  }
  advanceTo(ms: number): void {
    this.scheduler.advanceTo(ms);
  }
  drain(id: string): readonly ServerFrame[] {
    const state = this.requireClient(id);
    return state.queue.splice(0);
  }
  closeClient(
    id: string,
    code = "fixture_shutdown",
    reason = "fixture closed",
  ): readonly ServerFrame[] {
    const state = this.requireClient(id);
    if (!state.closed) {
      state.queue = [];
      this.emit(state, { v: V, type: "bye", code, reason, retryable: false });
      state.closed = true;
      state.attached = false;
    }
    return this.drain(id);
  }
  disconnect(id: string): void {
    this.clients.delete(id);
  }
  close(): void {
    if (this.closed) return;
    for (const id of this.clients.keys()) this.closeClient(id);
    this.scheduler.clear();
    this.clients.clear();
    this.closed = true;
  }
  inspect(clientId: string): FixtureClient {
    return this.clientInfo(clientId);
  }
  private requireClient(id: string): ClientState {
    const state = this.clients.get(id);
    if (!state) throw new Error(`unknown fixture client: ${id}`);
    return state;
  }
  private currentSessionRef() {
    return sessionRef(this.seed, {
      ...(this.archivedAt === undefined ? {} : { archivedAt: this.archivedAt }),
      model: this.sessionModel,
      revision: this.revision,
      title: this.sessionTitle,
    });
  }
  private createdSessionRef(session: CreatedFixtureSession): SessionRef {
    return sessionRef(this.seed, {
      ...(session.archivedAt === undefined ? {} : { archivedAt: session.archivedAt }),
      model: session.model,
      projectId: session.projectId,
      revision: session.revision,
      sessionId: session.sessionId,
      title: session.title,
      updatedAt: session.updatedAt,
    });
  }
  private sessionRefFor(sessionId: SessionId): SessionRef {
    const created = this.createdSessions.get(String(sessionId));
    return created === undefined ? this.currentSessionRef() : this.createdSessionRef(created);
  }
  private currentSessionRefs(): SessionRef[] {
    return [
      ...(this.sessionDeleted ? [] : [this.currentSessionRef()]),
      ...[...this.createdSessions.values()]
        .filter((session) => !session.deleted)
        .map((session) => this.createdSessionRef(session)),
    ];
  }
  private isKnownSession(sessionId: SessionId | undefined): boolean {
    if (sessionId === undefined) return false;
    return sessionId === this.seed.sessionId || this.createdSessions.has(String(sessionId));
  }
  private revisionFor(sessionId: SessionId | undefined): Revision {
    if (sessionId === undefined || sessionId === this.seed.sessionId) return this.revision;
    return this.createdSessions.get(String(sessionId))?.revision ?? this.revision;
  }
  private cursorFor(sessionId: SessionId | undefined): Cursor {
    if (sessionId === undefined || sessionId === this.seed.sessionId) return this.currentCursor;
    const created = this.createdSessions.get(String(sessionId));
    return sessionCursor(this.seed, created?.seq ?? 0, this.epoch);
  }
  private journalFor(sessionId: SessionId): JournalFrame[] {
    return sessionId === this.seed.sessionId
      ? this.journal
      : (this.createdSessions.get(String(sessionId))?.journal ?? []);
  }
  private entriesFor(sessionId: SessionId): DurableEntry[] {
    return sessionId === this.seed.sessionId
      ? this.durableEntries
      : (this.createdSessions.get(String(sessionId))?.durableEntries ?? []);
  }
  private previewCursorFor(sessionId: SessionId | undefined): Cursor {
    const isDefault = sessionId === undefined || sessionId === this.seed.sessionId;
    const seq = isDefault
      ? this.previewSeq
      : (this.createdSessions.get(String(sessionId))?.previewSeq ?? 0);
    return sessionCursor(this.seed, seq, `${this.epoch}-preview`);
  }
  private previewRevisionFor(sessionId: SessionId | undefined): Revision {
    const isDefault = sessionId === undefined || sessionId === this.seed.sessionId;
    if (isDefault) {
      return derivedRevision(this.seed, `preview-${this.previewSeq}`);
    }
    const created = this.createdSessions.get(String(sessionId));
    const seq = created?.previewSeq ?? 0;
    const ordinal = created?.ordinal ?? 0;
    return derivedRevision(this.seed, `created-${ordinal}-preview-${seq}`);
  }
  private incrementPreviewSeq(command: string, sessionId: SessionId | undefined): void {
    if (isPreviewEventCommand(command)) {
      const session = sessionId ?? branded<SessionId>(this.seed.sessionId);
      const created = this.createdSessions.get(String(session));
      if (created === undefined) {
        this.previewSeq += 1;
      } else {
        created.previewSeq += 1;
      }
    }
  }
  private currentSessionIndexCursor(): Cursor {
    return sessionCursor(this.seed, this.sessionIndexSeq, this.epoch);
  }
  private emit(state: ClientState, frame: ServerFrame): void {
    decodeServerFrame(frame);
    if (state.closed) return;
    if (state.queue.length >= MAX_QUEUE) {
      state.closed = true;
      state.attached = false;
      state.queue = [
        { v: V, type: "bye", code: "backpressure", reason: "fixture queue limit", retryable: true },
      ];
      return;
    }
    state.queue.push(frame);
  }
  private broadcast(frame: JournalFrame): void {
    for (const state of this.clients.values())
      if (state.hello && state.attached && !state.closed) this.emit(state, frame);
  }
  private errorFrom(error: unknown): ServerFrame {
    const code = error instanceof AppWireError ? error.code : "INVALID_FRAME";
    const message = error instanceof Error ? error.message : "invalid frame";
    return { v: V, type: "error", code, message };
  }
  private onHello(state: ClientState, frame: Extract<ClientFrame, { type: "hello" }>): void {
    state.hello = true;
    const saved = frame.savedCursors.find(
      (value) => value.hostId === this.seed.hostId && value.sessionId === this.seed.sessionId,
    );
    const resumed =
      saved !== undefined && saved.cursor.epoch === this.epoch && saved.cursor.seq === this.seq;
    this.emit(state, {
      v: V,
      type: "welcome",
      selectedProtocol: V,
      hostId: branded<HostId>(this.seed.hostId),
      ompVersion: "fixture",
      ompBuild: "deterministic",
      appserverVersion: "fixture",
      appserverBuild: "deterministic",
      epoch: this.epoch,
      grantedCapabilities: [
        "audit.read",
        "agents.control",
        "catalog.read",
        "config.read",
        "config.write",
        "files.diff",
        "files.list",
        "files.read",
        "files.write",
        "preview.control",
        "broker.read",
        "preview.input",
        "preview.read",
        "term.input",
        "term.open",
        "term.resize",
        "usage.read",
        "sessions.read",
        "sessions.prompt",
        "sessions.control",
        "sessions.manage",
      ],
      grantedFeatures: ["catalog.metadata", "preview.control", "resume", "settings.metadata"],
      negotiatedLimits: { maxInputBytes: 1_048_576 },
      authentication: "local",
      resumed,
    });
    this.emit(state, {
      v: V,
      type: "sessions",
      cursor: this.currentSessionIndexCursor(),
      sessions: this.currentSessionRefs(),
    });
    if (saved === undefined) this.emitSnapshot(state);
    else state.cursor = { epoch: saved.cursor.epoch, seq: saved.cursor.seq };
    this.emit(state, {
      v: V,
      type: "agent",
      hostId: branded<HostId>(this.seed.hostId),
      sessionId: branded<SessionId>(this.seed.sessionId),
      agentId: branded<AgentId>("agent-parent"),
      state: "running",
      progress: 0.65,
      detail: {
        title: "Fixture coordinator",
        kind: "main",
        model: "fixture-model",
      },
    });
    this.emit(state, {
      v: V,
      type: "agent",
      hostId: branded<HostId>(this.seed.hostId),
      sessionId: branded<SessionId>(this.seed.sessionId),
      agentId: branded<AgentId>("agent-fixture"),
      state: "running",
      progress: 0.4,
      detail: {
        title: "Fixture child",
        parentId: "agent-parent",
        description: "Exercises mobile agent hierarchy and cancellation.",
        model: "fixture-model",
        currentTool: "read",
      },
    });
    this.emit(state, {
      v: V,
      type: "review",
      hostId: branded<HostId>(this.seed.hostId),
      sessionId: branded<SessionId>(this.seed.sessionId),
      reviewId: "review-fixture",
      status: "pending",
      path: "src/fixture.ts",
      findings: [
        {
          severity: "warning",
          message: "Fixture review finding for the mobile application flow.",
          line: 12,
        },
      ],
    });
  }
  private emitSnapshot(
    state: ClientState,
    sessionId = branded<SessionId>(this.seed.sessionId),
  ): void {
    this.emit(state, {
      v: V,
      type: "snapshot",
      cursor: this.cursorFor(sessionId),
      revision: this.revisionFor(sessionId),
      hostId: branded<HostId>(this.seed.hostId),
      sessionId,
      entries: this.entriesFor(sessionId).slice(-MAX_HISTORY_SNAPSHOT),
    });
    state.cursor = this.cursorFor(sessionId);
  }
  private emitGap(state: ClientState, reason: string, sessionId: SessionId): void {
    this.emit(state, {
      v: V,
      type: "gap",
      hostId: branded<HostId>(this.seed.hostId),
      sessionId,
      from: sessionCursor(this.seed, 0, this.epoch),
      to: this.cursorFor(sessionId),
      reason,
    });
  }
  private attachState(state: ClientState, saved?: Cursor, requestedSessionId?: SessionId): void {
    const sessionId = requestedSessionId ?? branded<SessionId>(this.seed.sessionId);
    state.attached = true;
    if (saved === undefined) {
      this.emitSnapshot(state, sessionId);
      return;
    }
    if (saved.epoch !== this.epoch) {
      this.emitGap(state, "epoch_changed", sessionId);
      this.emitSnapshot(state, sessionId);
      return;
    }
    const journal = this.journalFor(sessionId);
    const current = this.cursorFor(sessionId);
    const oldest = journal[0]?.cursor.seq ?? current.seq + 1;
    if (saved.seq > current.seq || saved.seq < oldest - 1) {
      this.emitGap(state, "journal_gap", sessionId);
      this.emitSnapshot(state, sessionId);
      return;
    }
    for (const frame of journal) if (frame.cursor.seq > saved.seq) this.emit(state, frame);
    state.cursor = current;
  }
  private onCommand(state: ClientState, frame: CommandFrame): void {
    const descriptor = COMMAND_DESCRIPTORS[frame.command];
    if (!descriptor) {
      this.emit(state, {
        v: V,
        type: "error",
        code: "INVALID_FRAME",
        message: "unsupported command",
      });
      return;
    }
    const base = {
      v: V,
      type: "response" as const,
      requestId: frame.requestId,
      commandId: frame.commandId,
      command: frame.command,
      hostId: branded<HostId>(this.seed.hostId),
      ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
    };
    if (
      frame.hostId !== this.seed.hostId ||
      (descriptor.scope === "session" && !this.isKnownSession(frame.sessionId))
    ) {
      this.emit(state, {
        ...base,
        ok: false,
        error: { code: "not_found", message: "fixture host or session not found" },
      });
      return;
    }
    const key = String(frame.commandId);
    const payloadHash = canonicalSha256({
      command: frame.command,
      hostId: frame.hostId,
      ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
      ...(frame.expectedRevision === undefined ? {} : { expectedRevision: frame.expectedRevision }),
      ...(frame.confirmationId === undefined ? {} : { confirmationId: frame.confirmationId }),
      args: frame.args,
    });
    if (descriptor.confirmation === "challenge") {
      if (frame.confirmationId !== undefined) {
        this.emit(state, {
          ...base,
          ok: false,
          error: {
            code: "confirmation_invalid",
            message: "command confirmation must be approved through a confirm frame",
          },
        });
        return;
      }
      const confirmationId = branded<ConfirmationId>(`confirmation-${String(frame.commandId)}`);
      state.challenges.set(String(confirmationId), { command: frame });
      this.emit(state, {
        v: V,
        type: "confirmation",
        confirmationId,
        commandId: frame.commandId,
        hostId: branded<HostId>(this.seed.hostId),
        ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
        commandHash: payloadHash,
        revision: frame.command === "settings.write" ? this.settingsRevision : this.revision,
        expiresAt: "2999-01-01T00:00:00.000Z",
        summary: frame.command,
      });
      return;
    }
    const saved = state.commands.get(key);
    if (saved !== undefined) {
      if (saved.payloadHash === payloadHash) this.emit(state, saved.response);
      else
        this.emit(state, {
          ...base,
          ok: false,
          error: {
            code: "idempotency_conflict",
            message: "commandId was already used with a different payload",
            details: { commandId: key, payloadHash },
          },
        });
      return;
    }
    this.incrementPreviewSeq(frame.command, frame.sessionId);
    const response = this.makeCommandResponse(frame, base);
    state.commands.set(key, { payloadHash, response });
    this.emit(state, response);
    if (response.ok) this.emitCommandSideFrames(state, frame, response);
    if (response.ok && frame.command === "session.attach") {
      const args = frame.args;
      const savedCursor = "cursor" in args ? decodeCursor(args.cursor) : undefined;
      this.attachState(state, savedCursor, frame.sessionId);
    }
  }
  private onConfirm(state: ClientState, frame: Extract<ClientFrame, { type: "confirm" }>): void {
    const saved = state.challenges.get(String(frame.confirmationId));
    const valid =
      saved !== undefined &&
      saved.command.commandId === frame.commandId &&
      saved.command.hostId === frame.hostId &&
      saved.command.sessionId === frame.sessionId;
    if (!valid || saved === undefined) {
      this.emit(state, {
        v: V,
        type: "response",
        requestId: frame.requestId,
        commandId: frame.commandId,
        hostId: branded<HostId>(this.seed.hostId),
        ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
        ok: false,
        error: { code: "confirmation_invalid", message: "confirmation is invalid or expired" },
      });
      return;
    }

    state.challenges.delete(String(frame.confirmationId));
    const command = saved.command;
    const base = {
      v: V,
      type: "response" as const,
      requestId: command.requestId,
      commandId: command.commandId,
      command: command.command,
      hostId: branded<HostId>(this.seed.hostId),
      ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
    };
    if (frame.decision === "approve") {
      this.incrementPreviewSeq(command.command, command.sessionId);
    }
    const response =
      frame.decision === "deny"
        ? {
            ...base,
            ok: false as const,
            error: { code: "confirmation_denied", message: "command was denied" },
          }
        : this.makeCommandResponse(command, base);
    const payloadHash = canonicalSha256({
      command: command.command,
      hostId: command.hostId,
      ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
      ...(command.expectedRevision === undefined
        ? {}
        : { expectedRevision: command.expectedRevision }),
      confirmationId: frame.confirmationId,
      args: command.args,
    });
    state.commands.set(String(command.commandId), { payloadHash, response });
    this.emit(state, response);
    if (frame.decision === "approve" && response.ok)
      this.emitCommandSideFrames(state, command, response);
  }
  private emitTerminalOutput(
    state: ClientState,
    frame: Extract<ClientFrame, { type: "terminal.input" }>,
  ): void {
    this.emit(state, {
      v: V,
      type: "terminal.output",
      hostId: frame.hostId,
      sessionId: frame.sessionId,
      terminalId: frame.terminalId,
      cursor: this.currentCursor,
      stream: "stdout",
      data: frame.data,
      ...(frame.encoding === undefined ? {} : { encoding: frame.encoding }),
    } as unknown as ServerFrame);
  }
  private emitTerminalExit(
    state: ClientState,
    frame: Extract<ClientFrame, { type: "terminal.close" }>,
  ): void {
    this.emit(state, {
      v: V,
      type: "terminal.exit",
      hostId: frame.hostId,
      sessionId: frame.sessionId,
      terminalId: frame.terminalId,
      cursor: this.currentCursor,
      exitCode: 0,
    } as unknown as ServerFrame);
  }
  private emitCommandSideFrames(
    state: ClientState,
    frame: CommandFrame,
    response: Extract<ServerFrame, { type: "response" }>,
  ): void {
    if (frame.command === "session.create") {
      const result = response.result as { session?: SessionRef } | undefined;
      if (result?.session !== undefined)
        this.publishSessionIndexDelta(result.session.sessionId, false);
      return;
    }
    if (frame.command === "session.rename" || isSessionLifecycleCommand(frame.command)) {
      this.applySessionManagementMutation(frame);
      this.publishSessionIndexDelta(
        frame.sessionId ?? branded<SessionId>(this.seed.sessionId),
        frame.command === "session.delete",
      );
      return;
    }
    if (frame.command === "session.model.set") {
      this.applyModelMutation(frame);
      this.publishSessionIndexDelta(
        frame.sessionId ?? branded<SessionId>(this.seed.sessionId),
        false,
      );
      return;
    }
    if (frame.command === "settings.write") this.applySettingsMutation(frame);
    if (frame.command === "settings.read" || frame.command === "settings.write") {
      this.emit(state, {
        v: V,
        type: "settings",
        hostId: branded<HostId>(this.seed.hostId),
        revision: this.settingsRevision,
        settings: this.settings,
      });
      return;
    }
    const targetSessionId = frame.sessionId ?? branded<SessionId>(this.seed.sessionId);
    const isPreview = isPreviewEventCommand(frame.command);
    const ids = {
      v: V,
      hostId: branded<HostId>(this.seed.hostId),
      sessionId: targetSessionId,
      cursor: isPreview ? this.previewCursorFor(targetSessionId) : this.cursorFor(targetSessionId),
      revision: isPreview
        ? this.previewRevisionFor(targetSessionId)
        : this.revisionFor(targetSessionId),
    };
    if (frame.command === "session.list") {
      this.emit(state, {
        v: V,
        type: "sessions",
        cursor: this.currentSessionIndexCursor(),
        sessions: this.currentSessionRefs(),
      });
      return;
    }
    for (const additive of buildCommandSideFrames(
      frame,
      ids,
      this.sessionRefFor(targetSessionId),
      this.seed,
    ))
      this.emit(state, additive);
  }
  private applySessionManagementMutation(frame: CommandFrame): void {
    const targetSessionId = frame.sessionId ?? branded<SessionId>(this.seed.sessionId);
    const created = this.createdSessions.get(String(targetSessionId));
    if (created !== undefined) {
      applyCreatedSessionManagementMutation(this.seed, created, frame, this.scheduler.now);
      return;
    }
    this.managementRevision += 1;
    this.revision = branded<Revision>(
      `${this.seed.revision}-management-${this.managementRevision}`,
    );
    if (frame.command === "session.rename") {
      this.sessionTitle = String(frame.args.name);
      return;
    }
    if (frame.command === "session.archive") {
      this.archivedAt = new Date(Date.parse(this.seed.baseTime) + this.scheduler.now).toISOString();
      return;
    }
    if (frame.command === "session.restore") {
      this.archivedAt = undefined;
      return;
    }
    if (frame.command === "session.delete") this.sessionDeleted = true;
  }
  private applyModelMutation(frame: CommandFrame): void {
    const targetSessionId = frame.sessionId ?? branded<SessionId>(this.seed.sessionId);
    const created = this.createdSessions.get(String(targetSessionId));
    if (created !== undefined) {
      applyCreatedSessionModelMutation(this.seed, created, frame, this.scheduler.now);
      return;
    }
    this.controlRevision += 1;
    this.revision = branded<Revision>(`${this.seed.revision}-control-${this.controlRevision}`);
    if (typeof frame.args.selector === "string") {
      this.sessionModel = frame.args.selector;
      return;
    }
    const role = String(frame.args.role);
    const index = role === "default" ? 1 : Number.parseInt(role.replace(/^cycle-/u, ""), 10);
    if (Number.isInteger(index) && index >= 1 && index <= 12) {
      this.sessionModel = `fixture/model-${String(index).padStart(3, "0")}`;
    }
  }
  private publishSessionIndexDelta(sessionId: SessionId, remove: boolean): void {
    this.sessionIndexSeq += 1;
    const frame = {
      v: V,
      type: "session.delta" as const,
      hostId: branded<HostId>(this.seed.hostId),
      sessionId,
      cursor: this.currentSessionIndexCursor(),
      revision: this.revisionFor(sessionId),
      ...(remove ? { remove: sessionId } : { upsert: this.sessionRefFor(sessionId) }),
    } as ServerFrame;
    for (const state of this.clients.values()) {
      if (state.hello && !state.closed) this.emit(state, frame);
    }
  }
  private settingsWriteEdits(frame: CommandFrame): Record<string, unknown>[] | null {
    if (
      frame.command !== "settings.write" ||
      frame.args.expectedRevision !== frame.expectedRevision ||
      !Array.isArray(frame.args.edits) ||
      frame.args.edits.length === 0 ||
      frame.args.edits.length > 32
    )
      return null;
    const edits: Record<string, unknown>[] = [];
    for (const candidate of frame.args.edits) {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate))
        return null;
      const edit = candidate as Record<string, unknown>;
      const path = edit.path;
      const scope = edit.scope;
      if (
        typeof path !== "string" ||
        path.length === 0 ||
        path.length > 128 ||
        (scope !== "global" && scope !== "session")
      )
        return null;
      const current = this.settings[path];
      if (current === null || typeof current !== "object" || Array.isArray(current)) return null;
      const record = current as Record<string, unknown>;
      if (record.sensitive === true || record.availability === false) return null;
      const hasValue = Object.hasOwn(edit, "value");
      const resets = edit.reset === true;
      if (
        hasValue === resets ||
        Object.keys(edit).some((key) => !["path", "scope", "value", "reset"].includes(key))
      )
        return null;
      edits.push(edit);
    }
    return edits;
  }
  private applySettingsMutation(frame: CommandFrame): void {
    const edits = this.settingsWriteEdits(frame);
    if (edits === null) return;
    const next = { ...this.settings };
    for (const edit of edits) {
      const path = String(edit.path);
      const current = { ...(next[path] as Record<string, unknown>) };
      if (edit.reset === true) {
        current.configured = false;
        if (Object.hasOwn(current, "default")) {
          current.effective = current.default;
          current.effectiveSource = "default";
        } else {
          delete current.effective;
          delete current.effectiveSource;
        }
      } else {
        current.effective = edit.value;
        current.effectiveSource = edit.scope === "session" ? "override" : "global";
        current.configured = true;
      }
      next[path] = current;
    }
    this.settings = next;
    this.settingsRevisionSeq += 1;
    this.settingsRevision = branded<Revision>(
      `${this.seed.revision}-settings-${this.settingsRevisionSeq}`,
    );
  }
  private makeCommandResponse(
    frame: CommandFrame,
    base: Omit<Extract<ServerFrame, { type: "response" }>, "ok" | "result" | "error">,
  ): Extract<ServerFrame, { type: "response" }> {
    const actualRevision =
      frame.command === "settings.write"
        ? this.settingsRevision
        : this.revisionFor(frame.sessionId);
    if (frame.command === "settings.write" && this.settingsWriteEdits(frame) === null)
      return {
        ...base,
        ok: false,
        error: {
          code: "invalid_args",
          message: "settings write edits are invalid or unavailable",
        },
      };
    const targetSessionId = frame.sessionId ?? branded<SessionId>(this.seed.sessionId);
    if (
      frame.expectedRevision !== undefined &&
      frame.expectedRevision !== actualRevision &&
      (frame.command === "session.prompt" ||
        frame.command === "session.rename" ||
        isSessionLifecycleCommand(frame.command) ||
        frame.command === "files.write" ||
        frame.command === "review.apply" ||
        frame.command === "settings.write")
    )
      return {
        ...base,
        ok: false,
        error: {
          code: "stale_revision",
          message: "expected revision does not match fixture revision",
          details: { expectedRevision: frame.expectedRevision, actualRevision },
        },
      };
    if (frame.command === "session.attach")
      return {
        ...base,
        ok: true,
        result: { attached: true, cursor: this.cursorFor(frame.sessionId) },
      };
    if (frame.command === "session.prompt") {
      this.schedulePrompt(frame.sessionId ?? branded<SessionId>(this.seed.sessionId));
      return { ...base, ok: true, result: { accepted: true } };
    }
    if (frame.command === "session.create") {
      const session = this.createSession(frame);
      return { ...base, ok: true, result: { session: this.createdSessionRef(session) } };
    }
    if (frame.command === "project.reveal") {
      return { ...base, ok: true, result: { revealed: true } };
    }
    if (frame.command === "session.list")
      return {
        ...base,
        ok: true,
        result: { cursor: this.currentSessionIndexCursor(), sessions: this.currentSessionRefs() },
      };
    if (frame.command === "transcript.search")
      return {
        ...base,
        ok: true,
        result: {
          items: [
            {
              sessionId: this.seed.sessionId,
              projectId: this.seed.projectId,
              sessionTitle: this.sessionTitle,
              ...(this.archivedAt === undefined ? {} : { archivedAt: this.archivedAt }),
              anchorId: "entry-fixture-search",
              role: "assistant",
              timestamp: this.seed.baseTime,
              snippet: "Fixture transcript search result",
              highlights: [{ start: 8, end: 18 }],
            },
          ],
          incomplete: false,
          index: {
            state: "ready",
            indexedSessions: 1,
            knownSessions: 1,
            generation: `${this.epoch}:${this.sessionIndexSeq}`,
          },
        },
      };
    if (frame.command === "transcript.context") {
      const anchorId = String(frame.args.anchorId);
      return {
        ...base,
        ok: true,
        result: {
          anchorId,
          rows: [
            {
              anchorId: "entry-fixture-before",
              role: "user",
              timestamp: this.seed.baseTime,
              text: "Find the previous fixture decision.",
            },
            {
              anchorId,
              role: "assistant",
              timestamp: this.seed.baseTime,
              text: "Fixture transcript search result",
            },
          ],
          anchorIndex: 1,
          hasBefore: false,
          hasAfter: false,
          generation: `${this.epoch}:${this.sessionIndexSeq}`,
        },
      };
    }
    if (frame.command === "usage.read")
      return {
        ...base,
        ok: true,
        result: {
          generatedAt: Date.parse(this.seed.baseTime),
          reports: [
            {
              provider: "fixture-provider",
              fetchedAt: Date.parse(this.seed.baseTime),
              limits: [
                {
                  id: "fixture-requests",
                  label: "Fixture requests",
                  scope: { provider: "fixture-provider" },
                  amount: { used: 4, limit: 10, unit: "requests" },
                  status: "ok",
                  notes: [],
                },
              ],
              notes: ["Deterministic fixture usage"],
              metadata: { plan: "fixture" },
            },
          ],
          accountsWithoutUsage: [],
          capacity: {},
        },
      };
    if (frame.command === "broker.status")
      return {
        ...base,
        ok: true,
        result: {
          state: "connected",
          endpoint: "https://broker.fixture.invalid",
          generation: 1,
        },
      };
    if (frame.command === "host.list")
      return {
        ...base,
        ok: true,
        result: { cursor: this.currentCursor, sessions: this.currentSessionRefs() },
      };
    if (frame.command === "session.cancel" || frame.command === "agent.cancel")
      return { ...base, ok: true, result: { cancelled: true } };
    if (frame.command === "session.close") return { ...base, ok: true, result: { closed: true } };
    if (frame.command === "session.rename") return { ...base, ok: true, result: { renamed: true } };
    if (frame.command === "session.archive")
      return { ...base, ok: true, result: { archived: true } };
    if (frame.command === "session.restore")
      return { ...base, ok: true, result: { restored: true } };
    if (frame.command === "session.delete") return { ...base, ok: true, result: { deleted: true } };
    if (frame.command === "files.read")
      return { ...base, ok: true, result: { content: "", revision: this.revision } };
    if (
      frame.command === "files.write" ||
      frame.command === "files.patch" ||
      frame.command.startsWith("review.")
    )
      return { ...base, ok: true, result: {} };
    if (frame.command === "files.list") return { ...base, ok: true, result: { entries: [] } };
    if (frame.command === "files.diff") return { ...base, ok: true, result: { diff: "" } };
    if (frame.command === "term.open")
      return { ...base, ok: true, result: { terminalId: "terminal-fixture" } };
    if (frame.command === "audit.read" || frame.command === "audit.tail")
      return { ...base, ok: true, result: { events: [] } };
    if (frame.command === "catalog.get")
      return {
        ...base,
        ok: true,
        result: {
          revision: this.settingsRevision,
          items: fixtureCatalogItems(),
        },
      };
    if (frame.command === "settings.read")
      return {
        ...base,
        ok: true,
        result: { revision: this.settingsRevision, settings: this.settings },
      };
    if (frame.command === "settings.write") return { ...base, ok: true, result: { applied: true } };
    if (frame.command.startsWith("host.watch") || frame.command.startsWith("session.watch"))
      return {
        ...base,
        ok: true,
        result: { watchId: "watch-fixture", cursor: this.currentCursor },
      };
    if (frame.command === "preview.policy.check")
      return {
        ...base,
        ok: true,
        result: { allowed: true, confirmationRequired: false },
      };
    if (frame.command === "preview.lease.acquire" || frame.command === "preview.lease.renew") {
      return {
        ...base,
        ok: true,
        result: {
          previewId: branded<PreviewId>("preview-fixture"),
          leaseId: "lease-fixture",
          expiresAt: Date.parse("2999-01-01T00:00:00.000Z"),
        },
      };
    }
    if (frame.command === "preview.lease.release")
      return {
        ...base,
        ok: true,
        result: { previewId: branded<PreviewId>("preview-fixture"), released: true },
      };
    if (frame.command === "preview.state") {
      const previewIds = {
        v: V,
        hostId: branded<HostId>(this.seed.hostId),
        sessionId: targetSessionId,
        cursor: this.previewCursorFor(targetSessionId),
        revision: this.previewRevisionFor(targetSessionId),
      };
      const preview = fixturePreviewSnapshot(previewIds, this.seed, {
        capture: true,
        state: "ready",
        url: "http://127.0.0.1/fixture",
      });
      return { ...base, ok: true, result: { previews: [preview] } };
    }
    if (frame.command === "preview.capture.read") {
      const previewIds = {
        v: V,
        hostId: branded<HostId>(this.seed.hostId),
        sessionId: targetSessionId,
        cursor: this.previewCursorFor(targetSessionId),
        revision: this.previewRevisionFor(targetSessionId),
      };
      const preview = fixturePreviewSnapshot(previewIds, this.seed, {
        capture: true,
        state: "ready",
        url: "http://127.0.0.1/fixture",
      });
      const bytes = Buffer.from(FIXTURE_PREVIEW_CAPTURE_BASE64, "base64");
      const offset = Number(frame.args.offset);
      const nextOffset = Math.min(bytes.byteLength, offset + bytes.byteLength);
      return {
        ...base,
        ok: true,
        result: {
          previewId: preview.previewId,
          captureId: preview.capture?.captureId ?? "capture-fixture",
          size: bytes.byteLength,
          offset,
          nextOffset,
          complete: nextOffset === bytes.byteLength,
          content: bytes.subarray(offset, nextOffset).toString("base64"),
        },
      };
    }
    if (frame.command.startsWith("preview.")) {
      const previewIds = {
        v: V,
        hostId: branded<HostId>(this.seed.hostId),
        sessionId: targetSessionId,
        cursor: this.previewCursorFor(targetSessionId),
        revision: this.previewRevisionFor(targetSessionId),
      };
      const preview = fixturePreviewSnapshot(previewIds, this.seed, {
        capture: frame.command === "preview.capture",
        state: frame.command === "preview.close" ? "stopped" : "ready",
        url: typeof frame.args.url === "string" ? frame.args.url : "http://127.0.0.1/fixture",
      });
      return { ...base, ok: true, result: { preview } };
    }
    if (frame.command.includes(".lease."))
      return {
        ...base,
        ok: true,
        result: { leaseId: "lease-fixture", cursor: this.currentCursor },
      };
    return { ...base, ok: true, result: { accepted: true } };
  }
  private createSession(frame: CommandFrame): CreatedFixtureSession {
    const ordinal = this.nextCreatedSession++;
    const session = createCreatedFixtureSession(this.seed, frame, ordinal, this.scheduler.now);
    this.createdSessions.set(String(session.sessionId), session);
    return session;
  }
  private schedulePrompt(sessionId: SessionId): void {
    const created = this.createdSessions.get(String(sessionId));
    if (created !== undefined) {
      scheduleFixturePrompt({
        seed: this.seed,
        scheduler: this.scheduler,
        hostId: branded<HostId>(this.seed.hostId),
        sessionId: created.sessionId,
        epoch: this.epoch,
        isUnavailable: () => this.closed || created.deleted,
        currentSeq: () => created.seq,
        nextLiveEntryId: () =>
          `entry-${this.seed.id}-created-${created.ordinal}-live-${created.nextLiveEntry++}`,
        commitDurable: (text, parentId) => {
          created.durableCount += 1;
          created.revision = derivedRevision(
            this.seed,
            `created-${created.ordinal}-durable-${created.durableCount}`,
          );
          created.updatedAt = new Date(
            Date.parse(this.seed.baseTime) + this.scheduler.now + created.ordinal,
          ).toISOString();
          const entryId = `entry-${this.seed.id}-created-${created.ordinal}-durable-${created.durableCount}`;
          return {
            revision: created.revision,
            entry: {
              id: branded<EntryId>(entryId),
              parentId: parentId === null ? null : branded<EntryId>(parentId),
              hostId: branded<HostId>(this.seed.hostId),
              sessionId: created.sessionId,
              kind: "message",
              timestamp: new Date(
                Date.parse(this.seed.baseTime) + this.scheduler.now,
              ).toISOString(),
              data: { role: "assistant", text: text ?? `entry-${created.seq + 1}` },
            },
          };
        },
        publish: (frame) => this.publishCreated(created, frame),
        onDurablePublished: () => this.publishSessionIndexDelta(created.sessionId, false),
      });
      return;
    }
    scheduleFixturePrompt({
      seed: this.seed,
      scheduler: this.scheduler,
      hostId: branded<HostId>(this.seed.hostId),
      sessionId: branded<SessionId>(this.seed.sessionId),
      epoch: this.epoch,
      isUnavailable: () => this.closed,
      currentSeq: () => this.seq,
      nextLiveEntryId: () => `entry-${this.seed.id}-live-${this.nextLiveEntry++}`,
      commitDurable: (text, parentId) => {
        this.durableCount += 1;
        const suffix = `-${this.durableCount}`;
        this.revision = branded<Revision>(
          `${this.seed.revision.slice(0, Math.max(1, 128 - suffix.length))}${suffix}`,
        );
        const durableEntryId = `entry-${this.seed.id}-durable-${this.durableCount}`;
        const entry = buildEntry(
          this.seed,
          this.seq + 1,
          text ?? `entry-${this.seq + 1}`,
          parentId,
          durableEntryId,
        );
        return { entry, revision: this.revision };
      },
      publish: (frame) => this.publish(frame),
    });
  }
  private publishCreated(session: CreatedFixtureSession, frame: JournalFrame): void {
    session.seq = frame.cursor.seq;
    if (frame.type === "entry") {
      const existing = session.durableEntries.findIndex((entry) => entry.id === frame.entry.id);
      if (existing === -1) session.durableEntries.push(frame.entry);
      else session.durableEntries[existing] = frame.entry;
    }
    session.journal.push(frame);
    if (session.journal.length > MAX_JOURNAL)
      session.journal.splice(0, session.journal.length - MAX_JOURNAL);
    this.broadcast(frame);
  }
  private publish(frame: JournalFrame): void {
    this.seq = frame.cursor.seq;
    if (frame.type === "entry") {
      const existing = this.durableEntries.findIndex((entry) => entry.id === frame.entry.id);
      if (existing === -1) this.durableEntries.push(frame.entry);
      else this.durableEntries[existing] = frame.entry;
    }
    this.journal.push(frame);
    if (this.journal.length > MAX_JOURNAL)
      this.journal.splice(0, this.journal.length - MAX_JOURNAL);
    this.broadcast(frame);
  }
}
