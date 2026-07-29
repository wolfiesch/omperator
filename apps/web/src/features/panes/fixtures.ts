// Deterministic inspector fixtures: the sample data the five pane families
// render while no runtime connection exists. Shapes mirror what app-wire
// frames project into (see model.ts); the shell labels the whole surface as
// sample data whenever this module feeds it. The fixture controller answers
// control/review/file requests locally and visibly — it never pretends to be
// a live runtime.
import { entryId, hostId, sessionId, type DurableEntry } from "@t4-code/protocol";

import {
  createInspectorStore,
  installInspectorStoreFactory,
  type InspectorController,
  type InspectorState,
  type InspectorStoreApi,
  resolveDir,
  resolvePreview,
  resolveFileWriteOutcome,
  resolveReviewOutcome,
  resolveTurnReview,
} from "./inspector-store.ts";
import { classifySessionEvent } from "./activity-log.ts";
import type {
  ActivityEntry,
  AgentNode,
  FilePreview,
  FileTreeNode,
  ReviewFile,
  ShellInventoryRow,
} from "./model.ts";

/**
 * Fixed fixture epoch: every sample timestamp derives from this constant, so
 * seeds, controller actions, and tests are byte-identical across loads.
 */
export const FIXTURE_EPOCH_MS = Date.UTC(2026, 6, 11, 12, 0, 0);

function minutesAgo(minutes: number): string {
  return new Date(FIXTURE_EPOCH_MS - minutes * 60_000).toISOString();
}

/** Deterministic action clock: each call lands one second after the last. */
function createFixtureClock(): () => number {
  let tick = 0;
  return () => {
    tick += 1;
    return FIXTURE_EPOCH_MS + tick * 1_000;
  };
}

function agent(partial: Partial<AgentNode> & Pick<AgentNode, "id" | "title">): AgentNode {
  return {
    parentId: null,
    kind: "agent",
    state: "running",
    progress: null,
    startedAt: null,
    lastActivityAt: null,
    model: null,
    worktree: null,
    path: null,
    currentTool: null,
    contextUsed: null,
    contextLimit: null,
    evidence: null,
    transcriptEntries: [],
    transcriptReceived: false,
    transcriptFreshness: "fresh",
    transcriptHistoryTruncated: false,
    transcript: [],
    ...partial,
  };
}

function childTranscriptEntry(
  id: string,
  kind: string,
  minutes: number,
  data: Record<string, unknown>,
): DurableEntry {
  return {
    id: entryId(id),
    parentId: null,
    hostId: hostId("host-local"),
    sessionId: sessionId("agent-replay"),
    kind,
    timestamp: minutesAgo(minutes),
    data,
  };
}

// ---------------------------------------------------------------------------
// Agents: parent → batch → grandchild tree for the flagship session.
// ---------------------------------------------------------------------------

const STREAM_AGENTS: AgentNode[] = [
  agent({
    id: "agent-main",
    title: "Session agent",
    kind: "main",
    state: "running",
    startedAt: minutesAgo(190),
    lastActivityAt: minutesAgo(1),
    model: "fable-5",
    path: "Project root",
    currentTool: "read packages/client/src/replay.ts",
    transcript: [
      {
        id: "t-1",
        role: "user",
        text: "Trace duplicate stream frames after reconnect.",
        at: minutesAgo(190),
      },
      {
        id: "t-2",
        role: "assistant",
        text: "Starting with the replay cursor. I'll compare epochs across the reconnect boundary and fan the suspect modules out to helpers.",
        at: minutesAgo(188),
      },
      {
        id: "t-3",
        role: "tool",
        text: "grep 'epoch' packages/client/src — 14 matches in 3 files",
        at: minutesAgo(186),
      },
    ],
  }),
  agent({
    id: "agent-batch",
    title: "Reconnect suspects",
    kind: "batch",
    parentId: "agent-main",
    state: "running",
    progress: 0.62,
    startedAt: minutesAgo(84),
    lastActivityAt: minutesAgo(2),
    model: "fable-5",
    worktree: "worktrees/replay-batch",
  }),
  agent({
    id: "agent-replay",
    title: "Replay cursor audit",
    kind: "agent",
    parentId: "agent-batch",
    state: "running",
    progress: 0.8,
    startedAt: minutesAgo(80),
    lastActivityAt: minutesAgo(1),
    model: "fable-5",
    worktree: "worktrees/replay-batch",
    path: "packages/client/src/replay.ts",
    currentTool: "edit replay.ts",
    transcriptReceived: true,
    transcriptEntries: [
      childTranscriptEntry("agent-replay-message-1", "message", 12, {
        role: "assistant",
        text: "I reproduced the overlap: the child session installs snapshot seq 4021, then applies buffered seq 4021 again because the discard boundary uses arrival time.",
      }),
      childTranscriptEntry("agent-replay-read-1", "tool-use", 8, {
        tool: "read",
        title: "Read replay cursor boundary",
        args: { path: "packages/client/src/replay.ts", sel: "118-166" },
        ok: true,
        result: {
          lines: 49,
          preview:
            "const boundary = snapshot.receivedAt;\nfor (const frame of buffered) {\n  if (frame.receivedAt > boundary) apply(frame);\n}",
        },
      }),
      childTranscriptEntry("agent-replay-message-2", "message", 4, {
        role: "assistant",
        text: "The fix is scoped: compare epoch and sequence against the installed snapshot cursor, then add the duplicate-boundary regression case.",
      }),
    ],
    transcript: [
      {
        id: "t-r1",
        role: "assistant",
        text: "The cursor is rewound to the snapshot seq on every reattach, but live frames buffered during the handshake replay again after it.",
        at: minutesAgo(12),
      },
      {
        id: "t-r2",
        role: "tool",
        text: "vp test run client/replay — 11 passed, 1 failed (duplicate seq 4021)",
        at: minutesAgo(4),
      },
    ],
  }),
  agent({
    id: "agent-dedupe",
    title: "Frame dedupe check",
    kind: "agent",
    parentId: "agent-batch",
    state: "waiting",
    startedAt: minutesAgo(78),
    lastActivityAt: minutesAgo(9),
    model: "kimi-k2.6",
    worktree: "worktrees/replay-batch",
    evidence: "Waiting on Replay cursor audit for the seq boundary before touching dedupe.",
  }),
  agent({
    id: "agent-dedupe-probe",
    title: "Seq boundary probe",
    kind: "agent",
    parentId: "agent-dedupe",
    state: "parked",
    startedAt: minutesAgo(70),
    lastActivityAt: minutesAgo(31),
    model: "kimi-k2.6",
  }),
  agent({
    id: "agent-docs",
    title: "Reconnect notes",
    kind: "agent",
    parentId: "agent-batch",
    state: "completed",
    startedAt: minutesAgo(74),
    lastActivityAt: minutesAgo(26),
    model: "gemini-2.5-flash",
    transcript: [
      {
        id: "t-d1",
        role: "assistant",
        text: "Documented the reconnect frame lifecycle in docs/replay.md, including the epoch fence.",
        at: minutesAgo(26),
      },
    ],
  }),
  agent({
    id: "agent-soak",
    title: "Reconnect soak run",
    kind: "agent",
    parentId: "agent-main",
    state: "failed",
    startedAt: minutesAgo(60),
    lastActivityAt: minutesAgo(48),
    model: "fable-5",
    evidence: "Exited during pnpm soak: code 137 (out of memory). Last output kept in Activity.",
  }),
  agent({
    id: "agent-queued",
    title: "Regression sweep",
    kind: "agent",
    parentId: "agent-main",
    state: "queued",
    model: "fable-5",
  }),
];

// ---------------------------------------------------------------------------
// Activity: decoded wire session events, oldest first.
// ---------------------------------------------------------------------------

interface FixtureEvent {
  readonly minutesAgo: number;
  readonly event: Record<string, unknown>;
}

const STREAM_EVENTS: FixtureEvent[] = [
  {
    minutesAgo: 180,
    event: {
      type: "session.system",
      title: "Session resumed",
      detail: "Snapshot revision 41 loaded; replay caught up.",
    },
  },
  {
    minutesAgo: 172,
    event: {
      type: "tool.start",
      title: "grep epoch",
      detail: "packages/client/src",
      agentId: "agent-main",
    },
  },
  {
    minutesAgo: 171,
    event: {
      type: "tool.end",
      title: "grep epoch",
      detail: "14 matches in 3 files",
      agentId: "agent-main",
      durationMs: 400,
    },
  },
  {
    minutesAgo: 90,
    event: {
      type: "agent.spawn",
      title: "Spawned batch: Reconnect suspects",
      agentId: "agent-batch",
    },
  },
  {
    minutesAgo: 84,
    event: { type: "agent.spawn", title: "Spawned: Replay cursor audit", agentId: "agent-replay" },
  },
  {
    minutesAgo: 83,
    event: { type: "agent.spawn", title: "Spawned: Frame dedupe check", agentId: "agent-dedupe" },
  },
  {
    minutesAgo: 76,
    event: {
      type: "job.start",
      title: "Job: reconnect soak",
      detail: "pnpm soak --cycles 200",
      agentId: "agent-soak",
    },
  },
  {
    minutesAgo: 62,
    event: {
      type: "shell.output",
      title: "Agent shell",
      terminalId: "term-agent-soak",
      agentId: "agent-soak",
      data: "$ pnpm soak --cycles 200\ncycle 12/200 ok (441ms)\ncycle 13/200 ok (438ms)\ncycle 14/200 duplicate frame seq=4021 epoch=7\n",
    },
  },
  {
    minutesAgo: 49,
    event: {
      type: "shell.output",
      title: "Agent shell",
      terminalId: "term-agent-soak",
      agentId: "agent-soak",
      data: "cycle 118/200 rss=1.9GiB\nKilled\n",
    },
  },
  {
    minutesAgo: 48,
    event: {
      type: "job.end",
      title: "Job failed: reconnect soak",
      detail: "exit code 137",
      agentId: "agent-soak",
      exitCode: 137,
    },
  },
  {
    minutesAgo: 48,
    event: {
      type: "session.error",
      title: "Agent failed: Reconnect soak run",
      detail: "Process killed at cycle 118 (code 137).",
      agentId: "agent-soak",
    },
  },
  {
    minutesAgo: 33,
    event: {
      type: "tool.start",
      title: "read replay.ts",
      detail: "packages/client/src/replay.ts:120-210",
      agentId: "agent-replay",
    },
  },
  {
    minutesAgo: 32,
    event: {
      type: "tool.end",
      title: "read replay.ts",
      detail: "91 lines",
      agentId: "agent-replay",
      durationMs: 60,
    },
  },
  {
    minutesAgo: 31,
    event: {
      type: "custom.telemetry.v2",
      payload: { spanId: "b71", parent: "a09" },
      note: "emitted by a newer runtime",
    },
  },
  {
    minutesAgo: 27,
    event: {
      type: "session.compaction",
      title: "Context compacted",
      detail: "182k → 64k tokens; 3 work groups folded.",
    },
  },
  {
    minutesAgo: 26,
    event: {
      type: "agent.end",
      title: "Completed: Reconnect notes",
      agentId: "agent-docs",
      state: "completed",
    },
  },
  {
    minutesAgo: 12,
    event: {
      type: "tool.start",
      title: "edit replay.ts",
      detail: "fence live frames behind snapshot seq",
      agentId: "agent-replay",
    },
  },
  {
    minutesAgo: 11,
    event: {
      type: "tool.end",
      title: "edit replay.ts",
      detail: "2 hunks applied",
      agentId: "agent-replay",
      durationMs: 900,
    },
  },
  {
    minutesAgo: 8,
    event: {
      type: "session.system",
      title: "Host credential refreshed",
      detail: "Pairing lease renewed for 24h.",
      authToken: "wire-sample-value",
      host: "bunker-2",
    },
  },
  {
    minutesAgo: 4,
    event: { type: "tool.start", title: "vp test run client/replay", agentId: "agent-replay" },
  },
  {
    minutesAgo: 3,
    event: {
      type: "tool.error",
      title: "vp test run client/replay",
      detail: "1 of 12 failed: duplicate seq 4021 crosses the epoch fence",
      agentId: "agent-replay",
    },
  },
  {
    minutesAgo: 1,
    event: {
      type: "agent.progress",
      title: "Replay cursor audit at 80%",
      agentId: "agent-replay",
      progress: 0.8,
    },
  },
];

function buildActivity(events: readonly FixtureEvent[]): ActivityEntry[] {
  return events.map((entry, index) =>
    classifySessionEvent(
      { ...entry.event, at: minutesAgo(entry.minutesAgo) },
      index + 1,
      minutesAgo(entry.minutesAgo),
    ),
  );
}

// ---------------------------------------------------------------------------
// Review: one of each edge state, plus a real patch to read.
// ---------------------------------------------------------------------------

const REPLAY_PATCH = `@@ -128,9 +128,14 @@ export function attach(cursor: Cursor): Replay {
   const pending: Frame[] = [];
   let epoch = cursor.epoch;
-  function onFrame(frame: Frame): void {
-    pending.push(frame);
-    flush();
+  let fence = cursor.seq;
+  function onFrame(frame: Frame): void {
+    // Frames buffered during the handshake replay again after the
+    // snapshot lands; the fence drops anything at or below it.
+    if (frame.seq <= fence) return;
+    pending.push(frame);
+    flush();
   }
@@ -152,6 +157,7 @@ export function attach(cursor: Cursor): Replay {
   function onSnapshot(snapshot: Snapshot): void {
     epoch = snapshot.cursor.epoch;
+    fence = snapshot.cursor.seq;
     pending.length = 0;
   }
`;

const REPLAY_TEST_PATCH = `@@ -1,4 +1,5 @@
 import { describe, expect, it } from "vite-plus/test";
+import { attach } from "../src/replay.ts";
 
 describe("replay", () => {
@@ -18,4 +19,16 @@ describe("replay", () => {
     expect(replayed).toHaveLength(1);
   });
+
+  it("drops frames at or below the snapshot fence", () => {
+    const replay = attach({ session: "s", epoch: 7, seq: 4021 });
+    const seen: number[] = [];
+    replay.onFlush((frame) => seen.push(frame.seq));
+    replay.push({ seq: 4021, epoch: 7 });
+    replay.push({ seq: 4022, epoch: 7 });
+    expect(seen).toEqual([4022]);
+  });
 })
`;

const STREAM_REVIEW_FILES: ReviewFile[] = [
  {
    path: "packages/client/src/replay.ts",
    oldPath: null,
    status: "modified",
    kind: "text",
    additions: 8,
    deletions: 3,
    patch: REPLAY_PATCH,
    sizeBytes: null,
    applyState: "pending",
  },
  {
    path: "packages/client/test/replay-fence.test.ts",
    oldPath: null,
    status: "added",
    kind: "text",
    additions: 13,
    deletions: 0,
    patch: REPLAY_TEST_PATCH,
    sizeBytes: null,
    applyState: "pending",
  },
  {
    path: "docs/assets/reconnect-flow.png",
    oldPath: null,
    status: "modified",
    kind: "binary",
    additions: 0,
    deletions: 0,
    patch: null,
    sizeBytes: 48_231,
    applyState: "pending",
  },
  {
    path: "packages/client/src/generated/frame-table.ts",
    oldPath: null,
    status: "modified",
    kind: "huge",
    additions: 4_812,
    deletions: 4_790,
    patch: null,
    sizeBytes: 2_400_512,
    applyState: "pending",
  },
  {
    path: "packages/client/src/legacy-replay.ts",
    oldPath: null,
    status: "deleted",
    kind: "missing",
    additions: 0,
    deletions: 214,
    patch: null,
    sizeBytes: null,
    applyState: "pending",
  },
];

// ---------------------------------------------------------------------------
// Files: lazy tree listings and previews, keyed by path ("" is the root).
// ---------------------------------------------------------------------------

const DIR_LISTINGS: Readonly<Record<string, readonly FileTreeNode[]>> = {
  "": [
    { path: "packages", name: "packages", kind: "dir" },
    { path: "docs", name: "docs", kind: "dir" },
    { path: "package.json", name: "package.json", kind: "file" },
    { path: "README.md", name: "README.md", kind: "file" },
  ],
  packages: [
    { path: "packages/client", name: "client", kind: "dir" },
    { path: "packages/protocol", name: "protocol", kind: "dir" },
  ],
  "packages/client": [
    { path: "packages/client/src", name: "src", kind: "dir" },
    { path: "packages/client/test", name: "test", kind: "dir" },
  ],
  "packages/client/src": [
    { path: "packages/client/src/replay.ts", name: "replay.ts", kind: "file" },
    { path: "packages/client/src/socket.ts", name: "socket.ts", kind: "file" },
    { path: "packages/client/src/frames.bin", name: "frames.bin", kind: "file" },
  ],
  "packages/client/test": [
    {
      path: "packages/client/test/replay-fence.test.ts",
      name: "replay-fence.test.ts",
      kind: "file",
    },
  ],
  "packages/protocol": [{ path: "packages/protocol/index.ts", name: "index.ts", kind: "file" }],
  docs: [
    { path: "docs/replay.md", name: "replay.md", kind: "file" },
    { path: "docs/assets", name: "assets", kind: "dir" },
  ],
  "docs/assets": [
    { path: "docs/assets/reconnect-flow.png", name: "reconnect-flow.png", kind: "file" },
  ],
};

const REPLAY_SOURCE = `// Replay attach: snapshot first, then live frames past the fence.
import type { Cursor, Frame, Snapshot } from "@oh-my-pi/app-wire";

export interface Replay {
  push(frame: Frame): void;
  onFlush(listener: (frame: Frame) => void): () => void;
}

export function attach(cursor: Cursor): Replay {
  const pending: Frame[] = [];
  let epoch = cursor.epoch;
  let fence = cursor.seq;

  function onFrame(frame: Frame): void {
    // Frames buffered during the handshake replay again after the
    // snapshot lands; the fence drops anything at or below it.
    if (frame.seq <= fence) return;
    pending.push(frame);
    flush();
  }

  function onSnapshot(snapshot: Snapshot): void {
    epoch = snapshot.cursor.epoch;
    fence = snapshot.cursor.seq;
    pending.length = 0;
  }

  // …
}
`;

// 4x4 checker PNG, generated once; identity-free sample pixels.
const SAMPLE_IMAGE_SRC =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAF0lEQVR4nGP8//8/AwMDEwMDAwMDAwAkBgMBvR9pJAAAAABJRU5ErkJggg==";
const FIXTURE_FILE_REVISION = "fixture-revision-1";

const FILE_PREVIEWS: Readonly<Record<string, FilePreview>> = {
  "packages/client/src/replay.ts": {
    kind: "code",
    path: "packages/client/src/replay.ts",
    text: REPLAY_SOURCE,
    truncated: false,
  },
  "packages/client/src/socket.ts": {
    kind: "diagnostic",
    path: "packages/client/src/socket.ts",
    message: "The host could not read this file: EACCES (permission denied).",
  },
  "packages/client/src/frames.bin": {
    kind: "binary",
    path: "packages/client/src/frames.bin",
    sizeBytes: 1_048_576,
  },
  "packages/client/test/replay-fence.test.ts": {
    kind: "code",
    path: "packages/client/test/replay-fence.test.ts",
    text: 'import { describe, expect, it } from "vite-plus/test";\nimport { attach } from "../src/replay.ts";\n\ndescribe("replay", () => {\n  it("drops frames at or below the snapshot fence", () => {\n    const replay = attach({ session: "s", epoch: 7, seq: 4021 });\n    const seen: number[] = [];\n    replay.onFlush((frame) => seen.push(frame.seq));\n    replay.push({ seq: 4021, epoch: 7 });\n    replay.push({ seq: 4022, epoch: 7 });\n    expect(seen).toEqual([4022]);\n  });\n});\n',
    truncated: false,
  },
  "packages/protocol/index.ts": {
    kind: "code",
    path: "packages/protocol/index.ts",
    text: 'export * from "@oh-my-pi/app-wire";\n',
    truncated: false,
  },
  "docs/replay.md": {
    kind: "code",
    path: "docs/replay.md",
    text: "# Reconnect frame lifecycle\n\nSnapshot first, then live frames past the fence. The epoch fence\nguarantees a frame is applied at most once per attach.\n",
    truncated: false,
  },
  "docs/assets/reconnect-flow.png": {
    kind: "image",
    path: "docs/assets/reconnect-flow.png",
    src: SAMPLE_IMAGE_SRC,
  },
  "package.json": {
    kind: "code",
    path: "package.json",
    text: '{\n  "name": "oh-my-pi",\n  "private": true\n}\n',
    truncated: false,
  },
  "README.md": {
    kind: "code",
    path: "README.md",
    text: "# oh-my-pi\n\nRuntime for OMP sessions.\n",
    truncated: false,
  },
};

// ---------------------------------------------------------------------------
// Terminals inventory.
// ---------------------------------------------------------------------------

const STREAM_TERMINALS: ShellInventoryRow[] = [
  {
    terminalId: "term-agent-main",
    owner: "agent",
    ownerLabel: "Session agent",
    shell: "bash",
    cwd: "Project root",
    status: "running",
    exitCode: null,
    lastOutputAt: minutesAgo(1),
  },
  {
    terminalId: "term-agent-soak",
    owner: "agent",
    ownerLabel: "Reconnect soak run",
    shell: "bash",
    cwd: "Project root",
    status: "exited",
    exitCode: 137,
    lastOutputAt: minutesAgo(48),
  },
];

/** Terminal ids owned by agents; user PTYs must never collide with these. */
export const AGENT_OWNED_TERMINAL_IDS: readonly string[] = STREAM_TERMINALS.map(
  (row) => row.terminalId,
);

// ---------------------------------------------------------------------------
// Per-session assembly.
// ---------------------------------------------------------------------------

function seedForSession(sessionId: string): Partial<InspectorState> {
  if (sessionId === "sess-pagination" || sessionId === "sess-theme") {
    // Offline host: cached projections, no live agents or shells.
    return {
      activity: buildActivity([
        {
          minutesAgo: 3_121,
          event: {
            type: "session.system",
            title: "Host unreachable",
            detail: "bunker-2 stopped answering at 09:40. Showing the last synced record.",
          },
        },
      ]),
      activitySeq: 1,
      files: {
        childrenByPath: {},
        expanded: {},
        selectedPath: null,
        preview: null,
        previewRevision: null,
        draftsByPath: {},
        query: "",
        offline: true,
      },
    };
  }
  if (sessionId === "sess-stream") {
    return {
      activity: buildActivity(STREAM_EVENTS),
      activitySeq: STREAM_EVENTS.length,
      review: {
        files: STREAM_REVIEW_FILES,
        comments: [],
        selectedPath: STREAM_REVIEW_FILES[0]?.path ?? null,
        view: "unified",
        wrap: false,
        source: "legacy",
        turnId: null,
        loading: false,
        error: null,
        viewedByPath: { "packages/client/test/replay-fence.test.ts": true },
        draftAnchor: null,
      },
      terminals: STREAM_TERMINALS,
    };
  }
  // Every other sample session: a small but real slice.
  return {
    activity: buildActivity(STREAM_EVENTS.slice(0, 6)),
    activitySeq: 6,
    review: {
      files: STREAM_REVIEW_FILES.slice(0, 2),
      comments: [],
      selectedPath: null,
      view: "unified",
      wrap: false,
      source: "legacy",
      turnId: null,
      loading: false,
      error: null,
      viewedByPath: {},
      draftAnchor: null,
    },
    terminals: STREAM_TERMINALS.slice(0, 1),
  };
}

function agentsForSession(sessionId: string): readonly AgentNode[] {
  if (sessionId === "sess-pagination" || sessionId === "sess-theme") return [];
  if (sessionId === "sess-stream") return STREAM_AGENTS;
  return STREAM_AGENTS.slice(0, 3).map((node) =>
    node.id === "agent-main" ? { ...node, currentTool: null } : node,
  );
}

/** Shared deterministic agent corpus for fixture-only surfaces such as Agent View. */
export function fixtureAgentsForSession(sessionId: string): readonly AgentNode[] {
  return agentsForSession(sessionId);
}

function fixtureController(api: InspectorStoreApi, clock: () => number): InspectorController {
  const editedFiles = new Map<string, string>();
  return {
    kind: "fixture",
    performControl(scope) {
      const at = new Date(clock()).toISOString();
      const state = api.getState();
      if (scope.action === "cancel") {
        state.updateAgent(scope.agentId, {
          state: "aborted",
          progress: null,
          evidence: "Cancelled from T4 Code.",
        });
      } else if (scope.action === "wake") {
        state.updateAgent(scope.agentId, {
          state: "running",
          lastActivityAt: at,
        });
      }
      state.ingestActivity(
        classifySessionEvent(
          {
            type: "session.system",
            title:
              scope.action === "steer"
                ? `Steer sent to ${scope.agentTitle}`
                : scope.action === "cancel"
                  ? `Cancelled ${scope.agentTitle}`
                  : `Woke ${scope.agentTitle}`,
            detail: "Sample data: recorded locally, no runtime received this.",
            agentId: scope.agentId,
            at,
          },
          0,
          at,
        ),
      );
    },
    performReview(action, path) {
      const at = new Date(clock()).toISOString();
      resolveReviewOutcome(api, path, action === "apply" ? "applied" : "discarded");
      api.getState().ingestActivity(
        classifySessionEvent(
          {
            type: "session.system",
            title: `${action === "apply" ? "Kept" : "Discarded"} ${path}`,
            detail: "Sample data: recorded locally, no runtime received this.",
            at,
          },
          0,
          at,
        ),
      );
    },
    loadTurnReview(turnId) {
      queueMicrotask(() => {
        resolveTurnReview(api, turnId, {
          files: STREAM_REVIEW_FILES,
          revision: "fixture-turn-review",
        });
      });
    },
    loadDir(path) {
      queueMicrotask(() => {
        if (api.getState().files.offline) {
          resolveDir(api, path, "error");
          return;
        }
        resolveDir(api, path, DIR_LISTINGS[path] ?? []);
      });
    },
    loadPreview(path) {
      queueMicrotask(() => {
        if (api.getState().files.offline) {
          resolvePreview(api, { kind: "offline", path });
          return;
        }
        const edited = editedFiles.get(path);
        const preview =
          edited === undefined
            ? (FILE_PREVIEWS[path] ?? {
                kind: "diagnostic" as const,
                path,
                message: "The host has no readable content at this path.",
              })
            : { kind: "code" as const, path, text: edited, truncated: false };
        resolvePreview(api, preview, preview.kind === "code" ? FIXTURE_FILE_REVISION : null);
      });
    },
    writeFile(path, content) {
      queueMicrotask(() => {
        editedFiles.set(path, content);
        resolveFileWriteOutcome(api, path, "saved");
        resolvePreview(
          api,
          { kind: "code", path, text: content, truncated: false },
          FIXTURE_FILE_REVISION,
        );
      });
    },
  };
}

/** Screenshot/QA boot switches, fixture bridge only (see fixture/boot.ts). */
interface PaneBootOptions {
  readonly agent: string | null;
  readonly reviewFile: string | null;
  readonly reviewView: "unified" | "split" | null;
  readonly activityFilter: string | null;
}

function parsePaneBootOptions(search: string): PaneBootOptions {
  const params = new URLSearchParams(search);
  const reviewView = params.get("reviewview");
  return {
    agent: params.get("agent"),
    reviewFile: params.get("reviewfile"),
    reviewView: reviewView === "split" || reviewView === "unified" ? reviewView : null,
    activityFilter: params.get("activityfilter"),
  };
}

/** Wire the fixture inspector factory; the shell's fixture boot calls this. */
export function installFixtureInspector(): void {
  const boot = parsePaneBootOptions(typeof window === "undefined" ? "" : window.location.search);
  installInspectorStoreFactory((sessionId) => {
    // One deterministic clock per store: controller actions and store-authored
    // timestamps (comments) share the same second-step sequence.
    const clock = createFixtureClock();
    const store = createInspectorStore({
      sampleMode: true,
      controller: (api) => fixtureController(api, clock),
      seed: seedForSession(sessionId),
      clock,
    });
    for (const node of agentsForSession(sessionId)) {
      store.getState().ingestAgent(node);
    }
    const state = store.getState();
    if (boot.agent !== null && state.agentMap.agents[boot.agent] !== undefined) {
      state.selectAgent(boot.agent);
    }
    if (boot.reviewFile !== null) state.selectReviewFile(boot.reviewFile);
    if (boot.reviewView !== null) state.setReviewView(boot.reviewView);
    if (
      boot.activityFilter === "tools" ||
      boot.activityFilter === "agents" ||
      boot.activityFilter === "jobs" ||
      boot.activityFilter === "system" ||
      boot.activityFilter === "errors"
    ) {
      state.setActivityFilter(boot.activityFilter);
    }
    return store;
  });
}
