import { describe, expect, test } from "bun:test";
import { type DurableEntry, hostId, projectId, sessionId } from "@t4-code/host-wire";
import { completeAttachOutput, prepareAttachOutput } from "../src/attach-output.ts";
import { IdempotencyStore } from "../src/idempotency.ts";
import { SessionProjection } from "../src/projection.ts";
import { SubagentProjection } from "../src/subagent-projection.ts";
import type { SessionRecord } from "../src/types.ts";

const host = hostId("host-test");

function record(id: string): SessionRecord {
  return {
    sessionId: sessionId(id),
    path: `/tmp/${id}.jsonl`,
    cwd: "/tmp",
    projectId: projectId("project-test"),
    title: id,
    updatedAt: new Date(0).toISOString(),
    status: "idle",
    entries: [],
  };
}

function entry(id: string): DurableEntry {
  return {
    id: id as DurableEntry["id"],
    parentId: null,
    hostId: host,
    sessionId: sessionId("s"),
    kind: "message",
    timestamp: new Date(0).toISOString(),
    data: { id },
  };
}

describe("appserver projection and replay", () => {
  test("completes attach output across the pre-subscription transcript and subagent gap", () => {
    const projection = new SessionProjection(host, record("s"), "epoch-a");
    const subagents = new SubagentProjection(host, sessionId("s"), () => 100);
    const prepared = prepareAttachOutput(projection);
    const appended = projection.appendEntry(entry("during-attach"));
    const agent = subagents.applyFrame({
      type: "subagent_lifecycle",
      payload: {
        id: "AttachWorker",
        index: 0,
        agent: "task",
        description: "Attach race worker",
        status: "started",
        lastUpdate: 100,
      },
    });
    if (!appended || !agent) throw new Error("expected attach-gap projection frames");
    const frames = completeAttachOutput(prepared, projection, subagents);

    expect(frames.map((frame) => frame.type)).toEqual(["snapshot", "entry", "agent"]);
    expect(frames[0]).toMatchObject({ type: "snapshot", entries: [] });
    expect(frames[1]).toEqual(appended);
    expect(frames[2]).toMatchObject({ type: "agent", agentId: "AttachWorker", state: "started" });
  });

  test("deduplicates durable IDs and emits gap on ring eviction", () => {
    const projection = new SessionProjection(host, record("s"), "epoch-a", 1);
    expect(projection.appendEntry(entry("a"))).toBeDefined();
    expect(projection.appendEntry(entry("a"))).toBeUndefined();
    projection.appendEvent({ type: "live" });
    const replay = projection.replay({ epoch: "epoch-a", seq: 0 });
    expect(replay[0]?.type).toBe("gap");
    expect(projection.value.entries.map((value) => String(value.id))).toEqual(["a"]);
  });

  test("publishes title changes and safely fills discovery metadata", () => {
    const source = { ...record("s"), title: "Session" };
    const projection = new SessionProjection(host, source, "epoch-a");
    const discovered = {
      ...source,
      projectName: "tmp",
      title: "First substantive request",
      updatedAt: new Date(1).toISOString(),
    };
    const reconciled = projection.reconcileRecord(discovered);
    expect(reconciled).toMatchObject({
      type: "session.delta",
      cursor: { epoch: "epoch-a", seq: 1 },
      upsert: {
        project: { projectId: "project-test", name: "tmp" },
        title: "First substantive request",
      },
    });
    if (!reconciled) throw new Error("expected discovery metadata delta");
    expect(projection.reconcileRecord(discovered)).toBeUndefined();

    const titled = projection.updateTitle("Explicit title");
    expect(titled).toMatchObject({
      type: "session.delta",
      cursor: { epoch: "epoch-a", seq: 2 },
      upsert: { title: "Explicit title" },
    });
    if (!titled) throw new Error("expected explicit title delta");
    expect(projection.updateTitle("Explicit title")).toBeUndefined();
    expect(
      projection.reconcileRecord({
        ...discovered,
        projectName: "stale-project-name",
        title: "Stale discovered title",
      }),
    ).toBeUndefined();
    expect(projection.value.ref).toMatchObject({
      project: { projectId: "project-test", name: "tmp" },
      title: "Explicit title",
    });
    expect(projection.replay({ epoch: "epoch-a", seq: 0 })).toEqual([]);
    expect(projection.value.cursor.seq).toBe(0);
    expect(projection.value.indexCursor.seq).toBe(2);
  });

  test("keeps transcript replay contiguous across independent index deltas", () => {
    const projection = new SessionProjection(host, record("s"), "epoch-a");
    const first = projection.appendEvent({ type: "before_delta" });
    const delta = projection.updateStatus("active");
    const second = projection.appendEvent({ type: "after_delta" });
    expect(first).toMatchObject({ type: "event", cursor: { epoch: "epoch-a", seq: 1 } });
    expect(delta).toMatchObject({ type: "session.delta", cursor: { epoch: "epoch-a", seq: 1 } });
    expect(second).toMatchObject({ type: "event", cursor: { epoch: "epoch-a", seq: 2 } });
    expect(projection.value.cursor.seq).toBe(2);
    expect(projection.value.indexCursor.seq).toBe(1);
    expect(projection.replay({ epoch: "epoch-a", seq: 0 })).toEqual([first, second]);
  });

  test("projects bounded pending attention and the latest root outcome", () => {
    const projection = new SessionProjection(host, record("s"), "epoch-a");
    for (let index = 0; index < 10; index++)
      projection.setPendingAttention({
        kind: index % 2 === 0 ? "approval" : "plan",
        id: `pending-${index}`,
        title: `Pending ${index}`,
        summary: "Safe summary",
        requestedAt: new Date(index).toISOString(),
      });
    expect(projection.value.ref).toMatchObject({
      pendingApproval: true,
      attention: { pendingCount: 10, truncated: true },
    });
    expect(projection.value.ref.attention?.pending).toHaveLength(8);

    projection.removePendingAttention("pending-0");
    expect(projection.value.ref.attention).toMatchObject({ pendingCount: 9, truncated: true });
    const outcome = {
      id: "agent:completed:2026-07-18T12:00:00.000Z",
      kind: "completed" as const,
      at: "2026-07-18T12:00:00.000Z",
      summary: "Agent completed work.",
    };
    projection.settleAttentionOutcome(outcome);
    expect(projection.value.ref).toMatchObject({
      attention: { pending: [], pendingCount: 0, truncated: false, latestOutcome: outcome },
    });
    expect(projection.value.ref.pendingApproval).toBeUndefined();
  });

  test("clears live attention on lifecycle loss but retains the latest outcome", () => {
    const projection = new SessionProjection(host, record("s"), "epoch-a");
    projection.setLatestOutcome({
      id: "agent:failed:2026-07-18T12:00:00.000Z",
      kind: "failed",
      at: "2026-07-18T12:00:00.000Z",
      summary: "Agent stopped with an error.",
    });
    projection.setPendingAttention({
      kind: "question",
      id: "question-1",
      question: "Continue?",
      options: [],
      allowText: true,
      requestedAt: "2026-07-18T12:01:00.000Z",
    });
    projection.markRuntimeCrashed();
    expect(projection.value.ref).toMatchObject({
      status: "closed",
      attention: {
        pending: [],
        pendingCount: 0,
        truncated: false,
        latestOutcome: { kind: "failed" },
      },
    });
    expect(projection.value.ref.pendingUserInput).toBeUndefined();
  });
});

describe("appserver idempotency", () => {
  test("same payload replays and changed payload conflicts", () => {
    const store = new IdempotencyStore();
    const id = "command-a" as never;
    expect(store.begin(id, { value: 1 }).kind).toBe("new");
    const outcome = { frame: { v: "omp-app/1", type: "error", code: "x", message: "x" } as never };
    store.complete(id, { value: 1 }, outcome);
    expect(store.begin(id, { value: 1 })).toMatchObject({ kind: "replay" });
    expect(store.begin(id, { value: 2 })).toMatchObject({ kind: "conflict" });
  });
});
