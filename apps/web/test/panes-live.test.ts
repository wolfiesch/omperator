// Live inspector contract: protocol frames populate the Agents, Activity,
// Review, and Files pane families; cross-session frames never leak; replays
// stay stable; reconnects preserve prior safe projection; unsafe paths are
// hidden; and every pane action leaves as an exact, gated typed command.
import { OMP_RUNTIME_INTEGRATION, applyPublicFrame, createProjectionSnapshot } from "@t4-code/client";
import type {
  DesktopHostMetadata,
  DesktopRuntimeSnapshot,
  ProjectionFrame,
  ProjectionSnapshot,
} from "@t4-code/client";
import {
  agentId as brandAgentId,
  catalogId as brandCatalogId,
  commandId as brandCommandId,
  hostId as brandHostId,
  requestId as brandRequestId,
  revision as brandRevision,
  sessionId as brandSessionId,
  PROTOCOL_VERSION,
  type AgentFrame,
  type AgentTranscriptFrame,
  type AuditFrame,
  type CatalogFrame,
  type FileFrame,
  type GapFrame,
  type LiveEventFrame,
  type ResultFrame,
  type ReviewFrame,
  type SessionEvent,
  type SessionSnapshotFrame,
  type DurableEntry,
} from "@t4-code/protocol";
import {
  rendererServerEventFromFrame,
  type CommandIntent,
  type CommandResult,
  type ConfirmRequest,
  type ConfirmResult,
  type RendererServerEventEnvelope,
} from "@t4-code/protocol/desktop-ipc";
import { describe, expect, it } from "vite-plus/test";
import {
  agentCancelAvailability,
  cancelAgentFromView,
  deriveAgentViewGroups,
} from "../src/features/agent-view/model.ts";

import {
  createLiveInspectorStore,
  type LiveInspectorRuntime,
} from "../src/features/panes/live-inspector.ts";
import {
  agentNodeFromFrame,
  isSafeRelativePath,
} from "../src/features/panes/live-projection.ts";

const HOST = "host-a";
const SESSION = "sess-1";
const VIEW_ID = `${HOST}/${SESSION}`;
const OTHER_SESSION = "sess-2";

// ---------------------------------------------------------------------------
// Frame builders (typed protocol shapes; no decoding shortcuts).
// ---------------------------------------------------------------------------

function agentFrame(
  id: string,
  over: Partial<Pick<AgentFrame, "state" | "progress" | "detail" | "sessionId">> = {},
): AgentFrame {
  return {
    v: PROTOCOL_VERSION,
    type: "agent",
    hostId: brandHostId(HOST),
    sessionId: over.sessionId ?? brandSessionId(SESSION),
    agentId: brandAgentId(id),
    state: over.state ?? "running",
    ...(over.progress === undefined ? {} : { progress: over.progress }),
    ...(over.detail === undefined ? {} : { detail: over.detail }),
  };
}

function eventFrame(seq: number, event: SessionEvent, session = SESSION): LiveEventFrame {
  return {
    v: PROTOCOL_VERSION,
    type: "event",
    cursor: { epoch: "epoch-1", seq },
    hostId: brandHostId(HOST),
    sessionId: brandSessionId(session),
    event,
  };
}

function durableChildEntry(id: string, text: string): DurableEntry {
  return {
    id: id as never,
    parentId: null,
    hostId: brandHostId(HOST),
    sessionId: brandSessionId(SESSION),
    kind: "message",
    timestamp: "2026-07-15T00:00:00.000Z",
    data: { role: "assistant", text },
  };
}

function agentTranscriptFrame(
  seq: number,
  entries: readonly DurableEntry[],
  epoch = "agent-epoch-1",
): AgentTranscriptFrame {
  return {
    v: PROTOCOL_VERSION,
    type: "agent.transcript",
    hostId: brandHostId(HOST),
    sessionId: brandSessionId(SESSION),
    agentId: brandAgentId("agent-child"),
    cursor: { epoch, seq },
    entries: [...entries],
    revision: brandRevision(`agent-rev-${seq}`),
  };
}

function auditFrame(action: string, timestamp: string): AuditFrame {
  return {
    v: PROTOCOL_VERSION,
    type: "audit",
    hostId: brandHostId(HOST),
    sessionId: brandSessionId(SESSION),
    action,
    actor: "device-1",
    timestamp,
  };
}

function reviewFrame(
  reviewId: string,
  over: Partial<Pick<ReviewFrame, "status" | "path" | "findings">> = {},
): ReviewFrame {
  return {
    v: PROTOCOL_VERSION,
    type: "review",
    hostId: brandHostId(HOST),
    sessionId: brandSessionId(SESSION),
    reviewId,
    status: over.status ?? "pending",
    ...(over.path === undefined ? {} : { path: over.path }),
    findings: over.findings ?? [],
  };
}

function fileFrame(path: string, content?: string, session = SESSION): FileFrame {
  return {
    v: PROTOCOL_VERSION,
    type: "files",
    hostId: brandHostId(HOST),
    sessionId: brandSessionId(session),
    path,
    ...(content === undefined ? {} : { content }),
  };
}

function snapshotFrame(revision: string, seq = 0): SessionSnapshotFrame {
  return {
    v: PROTOCOL_VERSION,
    type: "snapshot",
    cursor: { epoch: "epoch-1", seq },
    revision: brandRevision(revision),
    hostId: brandHostId(HOST),
    sessionId: brandSessionId(SESSION),
    entries: [],
  };
}

function responseFrame(
  requestId: string,
  ok: boolean,
  result?: Record<string, unknown>,
  errorCode = "denied",
): ResultFrame {
  return {
    v: PROTOCOL_VERSION,
    type: "response",
    requestId: brandRequestId(requestId),
    commandId: brandCommandId(`cmd:${requestId}`),
    hostId: brandHostId(HOST),
    sessionId: brandSessionId(SESSION),
    ok,
    ...(result === undefined ? {} : { result }),
    ...(ok ? {} : { error: { code: errorCode, message: "The host said no." } }),
  };
}

function previewFrame(
  type: "preview.launch" | "preview.navigation",
  seq: number,
  url: string,
): ProjectionFrame {
  return {
    v: PROTOCOL_VERSION,
    type,
    hostId: brandHostId(HOST),
    sessionId: brandSessionId(SESSION),
    previewId: "preview-1",
    state: "ready",
    url,
    revision: brandRevision(`preview-${seq}`),
    cursor: { epoch: "preview-epoch", seq },
  } as ProjectionFrame;
}

function gapFrame(): GapFrame {
  return {
    v: PROTOCOL_VERSION,
    type: "gap",
    hostId: brandHostId(HOST),
    sessionId: brandSessionId(SESSION),
    from: { epoch: "epoch-1", seq: 1 },
    to: { epoch: "epoch-1", seq: 9 },
    reason: "resume window exceeded",
  };
}

function project(frames: readonly ProjectionFrame[], base?: ProjectionSnapshot): ProjectionSnapshot {
  let snapshot = base ?? createProjectionSnapshot();
  for (const frame of frames) snapshot = applyPublicFrame(snapshot, frame);
  return snapshot;
}

// ---------------------------------------------------------------------------
// Fake runtime: recorded snapshots in, recorded typed commands out.
// ---------------------------------------------------------------------------

interface FakeRuntimeOptions {
  readonly capabilities?: readonly string[];
  readonly features?: readonly string[];
  readonly catalog?: CatalogFrame;
  readonly connected?: boolean;
}

const DEFAULT_CAPABILITIES = [
  "sessions.read",
  "agents.control",
  "files.read",
  "files.list",
  "files.write",
] as const;

function hostMetadata(capabilities: readonly string[], features: readonly string[]): DesktopHostMetadata {
  return {
    targetId: "local",
    hostId: HOST,
    ompVersion: "0.0.0",
    ompBuild: "test",
    appserverVersion: "0.0.0",
    appserverBuild: "test",
    epoch: "epoch-1",
    grantedCapabilities: [...capabilities],
    grantedFeatures: [...features],
    negotiatedLimits: {},
    authentication: "local",
    resumed: false,
  };
}

/**
 * Dispatch-time write freshness requires this process to have received the
 * session's indexed ref; graft the ref, its arrival marker, and inventory
 * metadata onto fake projections.
 */
function withInventory(projection: ProjectionSnapshot): ProjectionSnapshot {
  const key = `${HOST}\u0000${SESSION}`;
  const sessionIndex = new Map(projection.sessionIndex);
  if (!sessionIndex.has(key)) {
    sessionIndex.set(key, {
      hostId: HOST,
      sessionId: SESSION,
      project: { projectId: "project-1" },
      revision: "rev-3",
      title: "Session",
      status: "active",
      updatedAt: "2026-07-11T10:00:00Z",
    } as never);
  }
  const sessionIndexMetadata = new Map(projection.sessionIndexMetadata);
  sessionIndexMetadata.set(HOST, { truncated: false, totalCount: sessionIndex.size } as never);
  const sessionRefArrivalOrdinals = new Map(projection.sessionRefArrivalOrdinals);
  sessionRefArrivalOrdinals.set(key, 1);
  return { ...projection, sessionIndex, sessionIndexMetadata, sessionRefArrivalOrdinals };
}

interface VoidDeferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

class FakeRuntime implements LiveInspectorRuntime {
  commands: CommandIntent[] = [];
  targets: string[] = [];
  confirms: ConfirmRequest[] = [];
  failCommands = false;
  commandResult: Pick<CommandResult, "accepted" | "result" | "error"> = { accepted: true };
  challengeAgentCancellation = false;
  holdAgentCancelConfirmations = false;
  onAgentCancelChallenge: (() => void) | null = null;
  private snapshotValue: DesktopRuntimeSnapshot;
  private readonly listeners = new Set<(snapshot: DesktopRuntimeSnapshot) => void>();
  private readonly eventListeners = new Set<(event: RendererServerEventEnvelope) => void>();
  private readonly settled: Promise<unknown>[] = [];
  private requestCounter = 0;
  private readonly pendingAgentCancels = new Map<
    string,
    {
      readonly gate: VoidDeferred;
      readonly targetId: string;
      readonly requestId: string;
      readonly commandId: string;
      readonly hostId: string;
      readonly sessionId: string;
    }
  >();
  private readonly heldAgentCancelConfirmations = new Map<string, VoidDeferred>();
  private readonly agentCancelConfirmationStarted: VoidDeferred = Promise.withResolvers<void>();

  constructor(options: FakeRuntimeOptions = {}) {
    this.snapshotValue = {
      version: 1,
      integration: OMP_RUNTIME_INTEGRATION,
      platform: "linux",
      desktopVersion: "test",
      startState: "started",
      targets: new Map(),
      connections: new Map([["local", options.connected === false ? "disconnected" : "connected"]]),
      targetHosts: new Map([["local", HOST]]),
      hosts: new Map([
        [HOST, hostMetadata(options.capabilities ?? DEFAULT_CAPABILITIES, options.features ?? ["files.list"])],
      ]),
      catalogs: options.catalog === undefined ? new Map() : new Map([[HOST, options.catalog]]),
      settings: new Map(),
      projection: withInventory(createProjectionSnapshot()),
      runtimeErrors: [],
    };
  }

  getSnapshot(): DesktopRuntimeSnapshot {
    return this.snapshotValue;
  }

  subscribe(listener: (snapshot: DesktopRuntimeSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeEvents(
    _filter: unknown,
    listener: (event: RendererServerEventEnvelope) => void,
  ): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  command(targetId: string, intent: CommandIntent): Promise<CommandResult> {
    this.targets.push(targetId);
    this.commands.push(intent);
    if (this.failCommands) {
      const failure = Promise.reject<CommandResult>(new Error("transport gone"));
      this.settled.push(failure.catch(() => undefined));
      return failure;
    }
    this.requestCounter += 1;
    const requestId = `req-${this.requestCounter}`;
    const commandId = `cmd-${this.requestCounter}`;
    if (this.challengeAgentCancellation && intent.command === "agent.cancel") {
      if (intent.sessionId === undefined) throw new Error("agent.cancel requires a session");
      const gate = Promise.withResolvers<void>();
      const confirmationId = `confirm-agent-cancel-${this.requestCounter}`;
      this.pendingAgentCancels.set(confirmationId, {
        gate,
        targetId,
        requestId,
        commandId,
        hostId: String(intent.hostId),
        sessionId: String(intent.sessionId),
      });
      const result = gate.promise.then<CommandResult>(() => ({
        targetId,
        requestId,
        commandId,
        ...this.commandResult,
      }));
      this.settled.push(result);
      this.emitServerFrame({
        v: PROTOCOL_VERSION,
        type: "confirmation",
        confirmationId: confirmationId as never,
        commandId: brandCommandId(commandId),
        hostId: intent.hostId,
        sessionId: intent.sessionId,
        commandHash: "sha256:agent-cancel",
        revision: intent.expectedRevision ?? brandRevision("missing"),
        expiresAt: "2999-01-01T00:00:00.000Z",
        summary: "agent.cancel",
      });
      this.onAgentCancelChallenge?.();
      return result;
    }
    const result = Promise.resolve<CommandResult>({
      targetId,
      requestId,
      commandId,
      ...this.commandResult,
    });
    this.settled.push(result);
    return result;
  }

  async confirm(request: ConfirmRequest): Promise<ConfirmResult> {
    this.confirms.push(request);
    const confirmationId = String(request.confirmationId);
    const pending = this.pendingAgentCancels.get(confirmationId);
    if (
      pending === undefined ||
      pending.targetId !== request.targetId ||
      pending.commandId !== String(request.commandId) ||
      pending.hostId !== String(request.hostId) ||
      pending.sessionId !== String(request.sessionId)
    ) {
      throw new Error("confirmation did not match a pending agent cancellation");
    }
    this.agentCancelConfirmationStarted.resolve();
    if (this.holdAgentCancelConfirmations) {
      const held = Promise.withResolvers<void>();
      this.heldAgentCancelConfirmations.set(confirmationId, held);
      await held.promise;
    }
    this.pendingAgentCancels.delete(confirmationId);
    pending.gate.resolve();
    return {
      targetId: request.targetId,
      requestId: "confirm-request",
      confirmationId: request.confirmationId,
      commandId: request.commandId,
      accepted: true,
    };
  }

  setProjection(projection: ProjectionSnapshot, options: { inventory?: boolean } = {}): void {
    this.snapshotValue = {
      ...this.snapshotValue,
      projection: options.inventory === false ? projection : withInventory(projection),
    };
    this.emit();
  }

  setConnection(state: "connected" | "disconnected"): void {
    this.snapshotValue = {
      ...this.snapshotValue,
      connections: new Map([["local", state]]),
    };
    this.emit();
  }

  /** Deterministic flush: awaits every issued command's own promise chain. */
  async settle(): Promise<void> {
    await Promise.allSettled(this.settled);
    await Promise.resolve();
    await Promise.resolve();
  }

  releaseAgentCancelConfirmations(): void {
    for (const held of this.heldAgentCancelConfirmations.values()) held.resolve();
    this.heldAgentCancelConfirmations.clear();
  }

  waitForAgentCancelConfirmation(): Promise<void> {
    return this.agentCancelConfirmationStarted.promise;
  }

  private emitServerFrame(
    frame: Parameters<typeof rendererServerEventFromFrame>[0],
  ): void {
    const event = { targetId: "local", event: rendererServerEventFromFrame(frame) };
    for (const listener of this.eventListeners) listener(event);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.snapshotValue);
  }
}

const AGENT_CATALOG: CatalogFrame = {
  v: PROTOCOL_VERSION,
  type: "catalog",
  hostId: brandHostId(HOST),
  revision: brandRevision("cat-1"),
  items: [
    { id: brandCatalogId("agent.cancel"), kind: "command", name: "agent.cancel" },
    { id: brandCatalogId("review.apply"), kind: "command", name: "review.apply" },
    { id: brandCatalogId("files.write"), kind: "command", name: "files.write" },
  ],
};

// ---------------------------------------------------------------------------
// Population from protocol frames.
// ---------------------------------------------------------------------------

describe("live projection populates each family", () => {
  it("agents come from agent frames with honest unknowns", () => {
    const fake = new FakeRuntime();
    fake.setProjection(
      project([
        agentFrame("agent-root", {
          detail: {
            title: "Refactor imports",
            kind: "main",
            model: "fable-5",
            currentTool: "search",
            contextUsage: { used: 4200, limit: 16000 },
          },
          progress: 0.25,
        }),
        agentFrame("agent-child", { detail: { parentId: "agent-root" } }),
      ]),
    );
    const store = createLiveInspectorStore(fake, VIEW_ID);
    const { agentMap } = store.getState();
    expect(agentMap.order).toEqual(["agent-root", "agent-child"]);
    const root = agentMap.agents["agent-root"];
    expect(root?.title).toBe("Refactor imports");
    expect(root?.kind).toBe("main");
    expect(root?.state).toBe("running");
    expect(root?.progress).toBe(0.25);
    expect(root?.model).toBe("fable-5");
    expect(root?.currentTool).toBe("search");
    expect(root?.contextUsed).toBe(4200);
    expect(root?.contextLimit).toBe(16000);
    expect(root?.evidence).toBeNull();
    const child = agentMap.agents["agent-child"];
    expect(child?.parentId).toBe("agent-root");
    expect(child?.title).toBe("agent-child");
  });

  it("hydrates durable child-session content into the matching agent", () => {
    const fake = new FakeRuntime({ features: ["agent.transcript"] });
    const first = durableChildEntry("child-entry-1", "I inspected the failing tests.");
    let projection = project([
      snapshotFrame("rev-1"),
      agentFrame("agent-child", { detail: { title: "CI reviewer" } }),
      agentTranscriptFrame(5, [first]),
    ]);
    fake.setProjection(projection);
    const store = createLiveInspectorStore(fake, VIEW_ID);
    let child = store.getState().agentMap.agents["agent-child"];
    expect(child?.transcriptReceived).toBe(true);
    expect(child?.transcriptEntries).toHaveLength(1);
    expect(child?.transcriptEntries[0]?.data.text).toBe("I inspected the failing tests.");

    const second = durableChildEntry("child-entry-2", "The focused suite is green.");
    projection = project([agentTranscriptFrame(6, [second])], projection);
    fake.setProjection(projection);
    child = store.getState().agentMap.agents["agent-child"];
    expect(child?.transcriptEntries.map((entry) => entry.id)).toEqual([
      "child-entry-1",
      "child-entry-2",
    ]);

    const replaced = durableChildEntry("child-entry-2", "Replacement after child restart.");
    projection = project([agentTranscriptFrame(1, [replaced], "agent-epoch-2")], projection);
    fake.setProjection(projection);
    child = store.getState().agentMap.agents["agent-child"];
    expect(child?.transcriptEntries).toHaveLength(1);
    expect(child?.transcriptEntries[0]?.data.text).toBe("Replacement after child restart.");
  });

  it("activity carries events, audit records, and command results without duplicates", () => {
    const fake = new FakeRuntime();
    const projection = project([
      eventFrame(1, { type: "tool.start", title: "Reading files", at: "2026-07-11T12:00:00Z" }),
      auditFrame("session.attach", "2026-07-11T12:00:01Z"),
      responseFrame("req-9", false),
    ]);
    fake.setProjection(projection);
    const store = createLiveInspectorStore(fake, VIEW_ID);
    const titles = store.getState().activity.map((entry) => entry.title);
    expect(titles).toEqual(["Reading files", "session.attach", "The host said no."]);
    // Re-emitting the same projection must not append anything.
    fake.setProjection(projection);
    expect(store.getState().activity).toHaveLength(3);
    const kinds = store.getState().activity.map((entry) => entry.kind);
    expect(kinds).toEqual(["tool", "system", "error"]);
  });

  it("adds sanitized preview activity once across projection replays", () => {
    const fake = new FakeRuntime();
    const projection = project([
      previewFrame("preview.launch", 1, "https://preview.test/launch?token=never#secret"),
      previewFrame("preview.navigation", 2, "https://preview.test/next?token=never#secret"),
    ]);
    fake.setProjection(projection);
    const store = createLiveInspectorStore(fake, VIEW_ID);
    expect(store.getState().activity.map((entry) => entry.title)).toEqual([
      "Browser preview launched",
      "Browser preview navigated",
    ]);
    const exported = JSON.stringify(store.getState().activity);
    expect(exported).not.toContain("token=never");
    expect(exported).not.toContain("#secret");

    fake.setProjection(projection);
    expect(store.getState().activity).toHaveLength(2);
  });

  it("review rows come from review frames and never fabricate a diff", () => {
    const fake = new FakeRuntime();
    fake.setProjection(
      project([
        reviewFrame("review-1", {
          status: "pending",
          path: "src/app.ts",
          findings: [{ path: "src/app.ts", status: "modified", additions: 3, deletions: 1 }],
        }),
      ]),
    );
    const store = createLiveInspectorStore(fake, VIEW_ID);
    const files = store.getState().review.files;
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("src/app.ts");
    expect(files[0]?.status).toBe("modified");
    expect(files[0]?.additions).toBe(3);
    expect(files[0]?.deletions).toBe(1);
    expect(files[0]?.applyState).toBe("pending");
    // No diff on the wire → no diff in the row.
    expect(files[0]?.patch).toBeNull();
  });

  it("file frames build the tree and answer previews", async () => {
    // No files.list capability: the pushed frames are the whole tree.
    const fake = new FakeRuntime({ capabilities: ["sessions.read", "files.read"], features: [] });
    fake.setProjection(
      project([
        fileFrame("src/main.ts", "export {};\n"),
        fileFrame("README.md", "# Hello\n"),
      ]),
    );
    const store = createLiveInspectorStore(fake, VIEW_ID);
    store.getState().setFileExpanded("", true);
    const root = store.getState().files.childrenByPath[""];
    expect(root).toEqual([
      { path: "src", name: "src", kind: "dir" },
      { path: "README.md", name: "README.md", kind: "file" },
    ]);
    store.getState().selectFile("README.md");
    await fake.settle();
    expect(store.getState().files.preview).toEqual({
      kind: "code",
      path: "README.md",
      text: "# Hello\n",
      truncated: false,
    });
  });

  it("files.list answers resolve directories and drop unsafe entries", async () => {
    const fake = new FakeRuntime();
    fake.setProjection(project([snapshotFrame("rev-1")]));
    const store = createLiveInspectorStore(fake, VIEW_ID);
    store.getState().setFileExpanded("", true);
    await fake.settle();
    expect(fake.commands).toEqual([
      {
        hostId: HOST,
        sessionId: SESSION,
        command: "files.list",
        args: {},
      },
    ]);
    fake.setProjection(
      project(
        [
          responseFrame("req-1", true, {
            entries: [
              { path: "src", kind: "dir" },
              { path: "notes.md", kind: "file" },
              { path: "/etc/passwd", kind: "file" },
              { path: "../secrets", kind: "file" },
            ],
          }),
        ],
        fake.getSnapshot().projection,
      ),
    );
    expect(store.getState().files.childrenByPath[""]).toEqual([
      { path: "src", name: "src", kind: "dir" },
      { path: "notes.md", name: "notes.md", kind: "file" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Isolation, stability, reconnect, and path safety.
// ---------------------------------------------------------------------------

describe("live projection isolation and stability", () => {
  it("frames for another session never leak into this store", () => {
    const fake = new FakeRuntime();
    fake.setProjection(
      project([
        agentFrame("foreign-agent", { sessionId: brandSessionId(OTHER_SESSION) }),
        eventFrame(1, { type: "tool.start", title: "Foreign" }, OTHER_SESSION),
        fileFrame("foreign.ts", "x", OTHER_SESSION),
      ]),
    );
    const store = createLiveInspectorStore(fake, VIEW_ID);
    expect(store.getState().agentMap.order).toEqual([]);
    expect(store.getState().activity).toEqual([]);
    expect(store.getState().review.files).toEqual([]);
  });

  it("duplicate and out-of-order event frames leave one stable entry", () => {
    const fake = new FakeRuntime();
    const first = project([
      eventFrame(2, { type: "tool.start", title: "Run tests" }),
    ]);
    fake.setProjection(first);
    const store = createLiveInspectorStore(fake, VIEW_ID);
    // Same cursor replayed and an older cursor arriving late: both ignored.
    fake.setProjection(
      project(
        [
          eventFrame(2, { type: "tool.start", title: "Run tests" }),
          eventFrame(1, { type: "tool.start", title: "Stale" }),
        ],
        first,
      ),
    );
    const titles = store.getState().activity.map((entry) => entry.title);
    expect(titles).toEqual(["Run tests"]);
  });

  it("agent frame replays do not duplicate or reorder the tree", () => {
    const fake = new FakeRuntime();
    const base = project([
      agentFrame("a", { detail: { title: "First" } }),
      agentFrame("b", { detail: { title: "Second" } }),
    ]);
    fake.setProjection(base);
    const store = createLiveInspectorStore(fake, VIEW_ID);
    fake.setProjection(project([agentFrame("a", { detail: { title: "First" }, state: "running" })], base));
    expect(store.getState().agentMap.order).toEqual(["a", "b"]);
    expect(store.getState().agentMap.agents.a?.title).toBe("First");
  });

  it("gaps and reconnects keep prior safe projection and only change status", () => {
    const fake = new FakeRuntime();
    const base = project([
      agentFrame("a", { detail: { title: "Worker" } }),
      eventFrame(1, { type: "tool.start", title: "Step one" }),
    ]);
    fake.setProjection(base);
    const store = createLiveInspectorStore(fake, VIEW_ID);
    expect(store.getState().files.offline).toBe(false);

    // A gap marks the stream catching-up; nothing already shown is cleared.
    fake.setProjection(project([gapFrame()], base));
    expect(store.getState().agentMap.agents.a?.title).toBe("Worker");
    expect(store.getState().activity).toHaveLength(1);

    // A dropped connection flips the honest offline flag, nothing more.
    fake.setConnection("disconnected");
    expect(store.getState().files.offline).toBe(true);
    expect(store.getState().agentMap.agents.a?.title).toBe("Worker");
    expect(store.getState().activity).toHaveLength(1);
    expect(store.getState().actions.agentCancel.enabled).toBe(false);

    fake.setConnection("connected");
    expect(store.getState().files.offline).toBe(false);
    expect(store.getState().activity).toHaveLength(1);
  });

  it("unsafe file and review paths are hidden everywhere", () => {
    expect(isSafeRelativePath("src/app.ts")).toBe(true);
    expect(isSafeRelativePath("/etc/passwd")).toBe(false);
    expect(isSafeRelativePath("../up")).toBe(false);
    expect(isSafeRelativePath("a/../b")).toBe(false);
    expect(isSafeRelativePath("~home")).toBe(false);
    expect(isSafeRelativePath("C:evil")).toBe(false);
    expect(isSafeRelativePath("dir\\file")).toBe(false);

    const fake = new FakeRuntime({ capabilities: ["sessions.read"], features: [] });
    fake.setProjection(
      project([
        fileFrame("/etc/passwd", "root"),
        fileFrame("../../escape.txt", "x"),
        fileFrame("safe/kept.ts", "ok"),
        reviewFrame("review-1", {
          findings: [{ path: "/abs/target.ts", patch: "@@ -1 +1 @@" }],
        }),
      ]),
    );
    const store = createLiveInspectorStore(fake, VIEW_ID);
    store.getState().setFileExpanded("", true);
    expect(store.getState().files.childrenByPath[""]).toEqual([
      { path: "safe", name: "safe", kind: "dir" },
    ]);
    expect(store.getState().review.files).toEqual([]);

    // Agent worktree/path claims outside the project are dropped too.
    const node = agentNodeFromFrame(
      agentFrame("a", { detail: { worktree: "/home/user/project", path: "../elsewhere" } }),
      [],
    );
    expect(node.worktree).toBeNull();
    expect(node.path).toBeNull();
  });

  it("a desktop store starts with zero fixture content", () => {
    const fake = new FakeRuntime();
    const store = createLiveInspectorStore(fake, VIEW_ID);
    const state = store.getState();
    expect(state.sampleMode).toBe(false);
    expect(state.agentMap.order).toEqual([]);
    expect(state.activity).toEqual([]);
    expect(state.review.files).toEqual([]);
    expect(state.files.childrenByPath).toEqual({});
    expect(state.terminals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Typed commands, gating, and unknown outcomes.
// ---------------------------------------------------------------------------

describe("live pane actions", () => {
  it("agent cancel sends the exact typed intent with the session revision", async () => {
    const fake = new FakeRuntime({ catalog: AGENT_CATALOG });
    fake.challengeAgentCancellation = true;
    fake.setProjection(
      project([snapshotFrame("rev-7"), agentFrame("agent-1", { detail: { title: "Worker" } })]),
    );
    const store = createLiveInspectorStore(fake, VIEW_ID);
    expect(store.getState().actions.agentCancel.enabled).toBe(true);
    store.getState().requestControl({
      sessionId: VIEW_ID,
      agentId: "agent-1",
      agentTitle: "Worker",
      action: "cancel",
    });
    store.getState().confirmControl();
    await fake.settle();
    expect(fake.targets).toEqual(["local"]);
    expect(fake.commands).toEqual([
      {
        hostId: HOST,
        sessionId: SESSION,
        command: "agent.cancel",
        args: { agentId: "agent-1" },
        expectedRevision: "rev-7",
      },
    ]);
    expect(fake.confirms).toEqual([
      {
        targetId: "local",
        confirmationId: "confirm-agent-cancel-1",
        commandId: "cmd-1",
        hostId: HOST,
        sessionId: SESSION,
        decision: "approve",
      },
    ]);
  });

  it("cancel without the capability is disabled with a reason and sends nothing", async () => {
    const fake = new FakeRuntime({ capabilities: ["sessions.read"], features: [] });
    fake.setProjection(project([agentFrame("agent-1")]));
    const store = createLiveInspectorStore(fake, VIEW_ID);
    const cancel = store.getState().actions.agentCancel;
    expect(cancel.enabled).toBe(false);
    expect(cancel.reason).not.toBeNull();
    store.getState().requestControl({
      sessionId: VIEW_ID,
      agentId: "agent-1",
      agentTitle: "agent-1",
      action: "cancel",
    });
    store.getState().confirmControl();
    await fake.settle();
    expect(fake.commands).toEqual([]);
  });

  it("offline and stale pane cancellation paths send nothing", async () => {
    const offline = new FakeRuntime({ catalog: AGENT_CATALOG, connected: false });
    offline.setProjection(project([snapshotFrame("rev-7"), agentFrame("agent-1")]));
    const offlineStore = createLiveInspectorStore(offline, VIEW_ID);
    offlineStore.getState().requestControl({
      sessionId: VIEW_ID,
      agentId: "agent-1",
      agentTitle: "Worker",
      action: "cancel",
    });
    offlineStore.getState().confirmControl();
    await offline.settle();
    expect(offline.commands).toEqual([]);

    const stale = new FakeRuntime({ catalog: AGENT_CATALOG });
    stale.setProjection(project([agentFrame("agent-1")]), { inventory: false });
    const staleStore = createLiveInspectorStore(stale, VIEW_ID);
    staleStore.getState().requestControl({
      sessionId: VIEW_ID,
      agentId: "agent-1",
      agentTitle: "Worker",
      action: "cancel",
    });
    staleStore.getState().confirmControl();
    await stale.settle();
    expect(stale.commands).toEqual([]);
  });

  it("a host catalog veto disables the action with the host's own reason", () => {
    const catalog: CatalogFrame = {
      ...AGENT_CATALOG,
      items: [
        {
          id: brandCatalogId("agent.cancel"),
          kind: "command",
          name: "agent.cancel",
          supported: false,
          reason: "Cancel is off on this host.",
        },
      ],
    };
    const fake = new FakeRuntime({ catalog });
    fake.setProjection(project([agentFrame("agent-1")]));
    const store = createLiveInspectorStore(fake, VIEW_ID);
    expect(store.getState().actions.agentCancel).toEqual({
      enabled: false,
      reason: "Cancel is off on this host.",
    });
  });

  it("cached session inventory disables pane writes with a syncing reason", () => {
    const fake = new FakeRuntime({ catalog: AGENT_CATALOG });
    fake.setProjection(
      project([
        snapshotFrame("rev-3"),
        agentFrame("agent-1"),
        reviewFrame("review-1", { path: "src/app.ts", findings: [] }),
      ]),
      { inventory: false },
    );
    const store = createLiveInspectorStore(fake, VIEW_ID);
    const expected = {
      enabled: false,
      reason: "This session is still syncing from the host. Try again in a moment.",
    };
    expect(store.getState().actions.agentCancel).toEqual(expected);
    expect(store.getState().actions.reviewApply).toEqual(expected);
    expect(store.getState().actions.fileWrite).toEqual(expected);
  });

  it("steer, wake, and discard have no wire command: disabled, honest, silent", async () => {
    const fake = new FakeRuntime({ catalog: AGENT_CATALOG });
    fake.setProjection(project([snapshotFrame("rev-1"), agentFrame("agent-1")]));
    const store = createLiveInspectorStore(fake, VIEW_ID);
    const { agentSteer, agentWake, reviewDiscard } = store.getState().actions;
    for (const action of [agentSteer, agentWake, reviewDiscard]) {
      expect(action.enabled).toBe(false);
      expect(action.reason).not.toBeNull();
    }
    store.getState().requestControl({
      sessionId: VIEW_ID,
      agentId: "agent-1",
      agentTitle: "agent-1",
      action: "steer",
      message: "note",
    });
    store.getState().confirmControl();
    store.getState().discardReviewFile("src/app.ts");
    await fake.settle();
    expect(fake.commands).toEqual([]);
  });

  it("review apply sends the exact intent and settles only on an ok response", async () => {
    const fake = new FakeRuntime({ catalog: AGENT_CATALOG });
    const base = project([
      snapshotFrame("rev-3"),
      reviewFrame("review-1", { path: "src/app.ts", findings: [] }),
    ]);
    fake.setProjection(base);
    const store = createLiveInspectorStore(fake, VIEW_ID);
    expect(store.getState().actions.reviewApply.enabled).toBe(true);
    store.getState().applyReviewFile("src/app.ts");
    await fake.settle();
    expect(fake.commands).toEqual([
      {
        hostId: HOST,
        sessionId: SESSION,
        command: "review.apply",
        args: { reviewId: "review-1" },
        expectedRevision: "rev-3",
      },
    ]);
    // Accepted is not applied: the row stays pending until the host says ok.
    expect(store.getState().review.files[0]?.applyState).toBe("pending");
    fake.setProjection(project([responseFrame("req-1", true, { applied: true })], base));
    expect(store.getState().review.files[0]?.applyState).toBe("applied");
  });

  it("file save sends revision-gated text and settles from its final command result", async () => {
    const fake = new FakeRuntime({ catalog: AGENT_CATALOG });
    const base = project([
      snapshotFrame("rev-3"),
      fileFrame("src/app.ts", "const value = 1;\n"),
    ]);
    fake.setProjection(base);
    const store = createLiveInspectorStore(fake, VIEW_ID);
    expect(store.getState().actions.fileWrite.enabled).toBe(true);

    store.getState().selectFile("src/app.ts");
    store.getState().startFileEdit("src/app.ts");
    store.getState().updateFileDraft("src/app.ts", "const value = 2;\n");
    store.getState().saveFile("src/app.ts");
    await fake.settle();

    expect(fake.commands).toEqual([
      {
        hostId: HOST,
        sessionId: SESSION,
        command: "files.write",
        args: { path: "src/app.ts", content: "const value = 2;\n" },
        expectedRevision: "rev-3",
      },
    ]);
    expect(store.getState().files.draftsByPath["src/app.ts"]).toBeUndefined();
    expect(store.getState().files.preview).toBe("loading");

    fake.setProjection(
      project(
        [snapshotFrame("rev-4", 1), fileFrame("src/app.ts", "const value = 2;\n")],
        base,
      ),
    );
    expect(store.getState().files.preview).toMatchObject({ text: "const value = 2;\n" });

    store.getState().startFileEdit("src/app.ts");
    store.getState().updateFileDraft("src/app.ts", "const value = 3;\n");
    store.getState().saveFile("src/app.ts");
    await fake.settle();
    expect(fake.commands[1]?.expectedRevision).toBe("rev-4");
  });

  it("pins a file save to the revision that produced its draft", async () => {
    const fake = new FakeRuntime({ catalog: AGENT_CATALOG });
    const base = project([
      snapshotFrame("rev-3"),
      fileFrame("src/app.ts", "const value = 1;\n"),
    ]);
    fake.setProjection(base);
    const store = createLiveInspectorStore(fake, VIEW_ID);

    store.getState().selectFile("src/app.ts");
    store.getState().startFileEdit("src/app.ts");
    store.getState().updateFileDraft("src/app.ts", "const value = 2;\n");
    fake.setProjection(project([snapshotFrame("rev-4")], base));
    store.getState().saveFile("src/app.ts");
    await fake.settle();

    expect(fake.commands[0]?.expectedRevision).toBe("rev-3");
  });

  it("a stale file save preserves the draft as a conflict", async () => {
    const fake = new FakeRuntime({ catalog: AGENT_CATALOG });
    const base = project([
      snapshotFrame("rev-3"),
      fileFrame("src/app.ts", "before\n"),
    ]);
    fake.setProjection(base);
    const store = createLiveInspectorStore(fake, VIEW_ID);
    fake.commandResult = {
      accepted: false,
      error: { code: "stale_revision", message: "revision changed" },
    };
    store.getState().selectFile("src/app.ts");
    store.getState().startFileEdit("src/app.ts");
    store.getState().updateFileDraft("src/app.ts", "mine\n");
    store.getState().saveFile("src/app.ts");
    await fake.settle();

    expect(store.getState().files.draftsByPath["src/app.ts"]).toMatchObject({
      text: "mine\n",
      status: "conflict",
    });
    expect(fake.commands).toHaveLength(1);
  });

  it("a denied review apply keeps the row pending", async () => {
    const fake = new FakeRuntime({ catalog: AGENT_CATALOG });
    const base = project([
      snapshotFrame("rev-3"),
      reviewFrame("review-1", { path: "src/app.ts", findings: [] }),
    ]);
    fake.setProjection(base);
    const store = createLiveInspectorStore(fake, VIEW_ID);
    store.getState().applyReviewFile("src/app.ts");
    await fake.settle();
    fake.setProjection(project([responseFrame("req-1", false)], base));
    expect(store.getState().review.files[0]?.applyState).toBe("pending");
  });

  it("an unknown outcome never replays and keeps user state", async () => {
    const fake = new FakeRuntime({ catalog: AGENT_CATALOG });
    fake.setProjection(
      project([
        snapshotFrame("rev-3"),
        reviewFrame("review-1", { path: "src/app.ts", findings: [] }),
      ]),
    );
    const store = createLiveInspectorStore(fake, VIEW_ID);
    store.getState().setReviewViewed("src/app.ts", true);
    fake.failCommands = true;
    store.getState().applyReviewFile("src/app.ts");
    await fake.settle();
    // Exactly one attempt; the row and the user's viewed mark both survive.
    expect(fake.commands).toHaveLength(1);
    expect(store.getState().review.files[0]?.applyState).toBe("pending");
    expect(store.getState().review.viewedByPath["src/app.ts"]).toBe(true);
    store.getState().confirmControl();
    await fake.settle();
    expect(fake.commands).toHaveLength(1);
  });

  it("review apply waits for a known session revision", () => {
    const fake = new FakeRuntime({ catalog: AGENT_CATALOG });
    // No grafted inventory: this session's indexed revision stays unknown.
    fake.setProjection(project([reviewFrame("review-1", { path: "src/app.ts", findings: [] })]), {
      inventory: false,
    });
    const store = createLiveInspectorStore(fake, VIEW_ID);
    const apply = store.getState().actions.reviewApply;
    expect(apply.enabled).toBe(false);
    expect(apply.reason).toBe("Waiting for this session's latest state.");
  });
});

describe("global Agent View", () => {
  it("groups loaded agents and preserves lifecycle corpus detail", () => {
    const fake = new FakeRuntime({ catalog: AGENT_CATALOG });
    fake.setProjection(
      project([
        snapshotFrame("rev-7"),
        agentFrame("agent-1", {
          state: "parked",
          progress: 0.5,
          detail: {
            title: "Research worker",
            description: "Compare persistence architectures",
            resumable: true,
            model: "test-model",
            contextUsage: { used: 4_000, limit: 8_000 },
          },
        }),
      ]),
    );

    const groups = deriveAgentViewGroups(fake.getSnapshot());
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      viewId: VIEW_ID,
      projectName: "project-1",
      session: { title: "Session" },
    });
    expect(groups[0]?.agents[0]).toMatchObject({
      task: "Compare persistence architectures",
      resumable: true,
      node: {
        id: "agent-1",
        title: "Research worker",
        state: "parked",
        progress: 0.5,
        model: "test-model",
        contextUsed: 4_000,
        contextLimit: 8_000,
      },
    });
  });

  it("rechecks gates and confirms the revision-bound cancellation challenge", async () => {
    const fake = new FakeRuntime({ catalog: AGENT_CATALOG });
    fake.challengeAgentCancellation = true;
    fake.setProjection(
      project([snapshotFrame("rev-7"), agentFrame("agent-1", { detail: { title: "Worker" } })]),
    );
    const group = deriveAgentViewGroups(fake.getSnapshot())[0];
    const node = group?.agents[0]?.node;
    expect(group).toBeDefined();
    expect(node).toBeDefined();
    if (group === undefined || node === undefined) return;
    expect(agentCancelAvailability(fake.getSnapshot(), group.viewId, node).enabled).toBe(true);

    await cancelAgentFromView(fake, group.viewId, node);
    expect(fake.targets).toEqual(["local"]);
    expect(fake.commands).toEqual([
      {
        hostId: HOST,
        sessionId: SESSION,
        command: "agent.cancel",
        args: { agentId: "agent-1" },
        expectedRevision: "rev-7",
      },
    ]);
    expect(fake.confirms).toEqual([
      {
        targetId: "local",
        confirmationId: "confirm-agent-cancel-1",
        commandId: "cmd-1",
        hostId: HOST,
        sessionId: SESSION,
        decision: "approve",
      },
    ]);

    fake.setConnection("disconnected");
    await expect(cancelAgentFromView(fake, group.viewId, node)).rejects.toThrow(
      "This host is offline right now.",
    );
    expect(fake.commands).toHaveLength(1);
  });

  it("does not approve after the revision advances while the agent still runs", async () => {
    const fake = new FakeRuntime({ catalog: AGENT_CATALOG });
    fake.challengeAgentCancellation = true;
    fake.setProjection(
      project([snapshotFrame("rev-7"), agentFrame("agent-1", { detail: { title: "Worker" } })]),
    );
    const group = deriveAgentViewGroups(fake.getSnapshot())[0];
    const node = group?.agents[0]?.node;
    if (group === undefined || node === undefined) throw new Error("expected a projected agent");
    fake.onAgentCancelChallenge = () =>
      fake.setProjection(
        project([snapshotFrame("rev-8"), agentFrame("agent-1", { detail: { title: "Worker" } })]),
      );

    await expect(cancelAgentFromView(fake, group.viewId, node)).rejects.toThrow(
      "The session changed before agent cancellation could be confirmed.",
    );
    expect(fake.commands).toHaveLength(1);
    expect(fake.confirms).toHaveLength(0);
  });

  it("does not approve after the connection drops during confirmation", async () => {
    const fake = new FakeRuntime({ catalog: AGENT_CATALOG });
    fake.challengeAgentCancellation = true;
    fake.setProjection(
      project([snapshotFrame("rev-7"), agentFrame("agent-1", { detail: { title: "Worker" } })]),
    );
    const group = deriveAgentViewGroups(fake.getSnapshot())[0];
    const node = group?.agents[0]?.node;
    if (group === undefined || node === undefined) throw new Error("expected a projected agent");
    fake.onAgentCancelChallenge = () => fake.setConnection("disconnected");

    await expect(cancelAgentFromView(fake, group.viewId, node)).rejects.toThrow(
      "This host is offline right now.",
    );
    expect(fake.commands).toHaveLength(1);
    expect(fake.confirms).toHaveLength(0);
  });

  it("rejects when the confirmed cancellation command is not accepted", async () => {
    const fake = new FakeRuntime({ catalog: AGENT_CATALOG });
    fake.challengeAgentCancellation = true;
    fake.commandResult = {
      accepted: false,
      error: { code: "operation_failed", message: "cancellation failed" },
    };
    fake.setProjection(
      project([snapshotFrame("rev-7"), agentFrame("agent-1", { detail: { title: "Worker" } })]),
    );
    const group = deriveAgentViewGroups(fake.getSnapshot())[0];
    const node = group?.agents[0]?.node;
    if (group === undefined || node === undefined) throw new Error("expected a projected agent");

    await expect(cancelAgentFromView(fake, group.viewId, node)).rejects.toThrow(
      "The host did not accept this cancellation request.",
    );
    expect(fake.commands).toHaveLength(1);
    expect(fake.confirms).toHaveLength(1);
  });

  it("serializes concurrent same-session cancellations around their own challenges", async () => {
    const fake = new FakeRuntime({ catalog: AGENT_CATALOG });
    fake.challengeAgentCancellation = true;
    fake.holdAgentCancelConfirmations = true;
    fake.setProjection(
      project([
        snapshotFrame("rev-7"),
        agentFrame("agent-1", { detail: { title: "First" } }),
        agentFrame("agent-2", { detail: { title: "Second" } }),
      ]),
    );
    const group = deriveAgentViewGroups(fake.getSnapshot())[0];
    const first = group?.agents[0]?.node;
    const second = group?.agents[1]?.node;
    if (group === undefined || first === undefined || second === undefined) {
      throw new Error("expected two projected agents");
    }

    const firstCancel = cancelAgentFromView(fake, group.viewId, first);
    const secondCancel = cancelAgentFromView(fake, group.viewId, second);
    try {
      await fake.waitForAgentCancelConfirmation();
      expect(fake.commands).toHaveLength(1);
      expect(fake.confirms).toHaveLength(1);
    } finally {
      fake.holdAgentCancelConfirmations = false;
      fake.releaseAgentCancelConfirmations();
    }
    await Promise.all([firstCancel, secondCancel]);

    expect(fake.commands.map((intent) => intent.args)).toEqual([
      { agentId: "agent-1" },
      { agentId: "agent-2" },
    ]);
    expect(fake.confirms.map((request) => [request.confirmationId, request.commandId])).toEqual([
      ["confirm-agent-cancel-1", "cmd-1"],
      ["confirm-agent-cancel-2", "cmd-2"],
    ]);
  });

  it("rejects a stale row after its agent leaves the live projection", async () => {
    const fake = new FakeRuntime({ catalog: AGENT_CATALOG });
    fake.setProjection(
      project([snapshotFrame("rev-7"), agentFrame("agent-1", { detail: { title: "Worker" } })]),
    );
    const group = deriveAgentViewGroups(fake.getSnapshot())[0];
    const node = group?.agents[0]?.node;
    if (group === undefined || node === undefined) throw new Error("expected a projected agent");

    fake.setProjection(
      project([
        snapshotFrame("rev-8"),
        agentFrame("agent-1", { detail: { title: "Worker" }, state: "cancelled" }),
      ]),
    );
    expect(agentCancelAvailability(fake.getSnapshot(), group.viewId, node)).toEqual({
      enabled: false,
      reason: "This agent has already stopped.",
    });

    fake.setProjection(project([snapshotFrame("rev-9")]));
    expect(agentCancelAvailability(fake.getSnapshot(), group.viewId, node)).toEqual({
      enabled: false,
      reason: "This agent is no longer available.",
    });
    await expect(cancelAgentFromView(fake, group.viewId, node)).rejects.toThrow(
      "This agent is no longer available.",
    );
    expect(fake.commands).toHaveLength(0);
  });
});
