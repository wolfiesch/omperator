// Transcript projection invariants: cursor-gated ordering, id-keyed dedupe,
// live/durable double-render exclusion, attention states, and 10k stress
// stability with structural row sharing. Pure — no DOM.
import { describe, expect, it } from "vite-plus/test";
import {
  MAX_RETAINED_LIVE_MESSAGES,
  MAX_RETAINED_TOOL_CALLS,
  MAX_RETAINED_TRANSCRIPT_BYTES,
  ompAppV1ProtocolProvider,
  retainedJsonBytes,
} from "@t4-code/client";

import { FrameFactory } from "../src/features/session-runtime/frame-builders.ts";
import {
  buildSessionScript,
  FIXTURE_EPOCH_ISO,
  FIXTURE_NOW_MS,
} from "../src/features/session-runtime/fixtures.ts";
import {
  initialProjection,
  reduceTranscript,
  reduceTranscriptEvent,
  replayRetainedTranscriptEvents,
  type TranscriptFrame,
  type TranscriptProjection,
  type TranscriptServerEvent,
} from "../src/features/transcript/projection.ts";
import {
  computeStableRows,
  deriveAttention,
  deriveTranscriptRows,
  formatElapsed,
  initialStableRowsState,
  shouldShowAttention,
} from "../src/features/transcript/rows.ts";
import { toolDetail } from "../src/features/transcript/TranscriptRows.tsx";

function makeFactory(startSeq = 0) {
  return new FrameFactory({ host: "h", session: "s", epoch: "e1", startSeq });
}

function withSnapshot(factory: FrameFactory, count = 2): TranscriptProjection {
  const entries = Array.from({ length: count }, (_, i) =>
    factory.entryRecord({
      id: `settled-${i}`,
      kind: "message",
      timestamp: "2026-07-11T09:00:00Z",
      data: { role: i % 2 === 0 ? "user" : "assistant", text: `settled ${i}` },
    }),
  );
  return reduceTranscript(initialProjection(), factory.snapshot(entries));
}

function transcriptEvent(frame: TranscriptFrame): TranscriptServerEvent {
  const event = ompAppV1ProtocolProvider.decodeServerEvent(frame);
  if (
    event.kind !== "snapshot" &&
    event.kind !== "entry" &&
    event.kind !== "event" &&
    event.kind !== "gap"
  ) throw new Error("expected a transcript event");
  return event;
}

describe("normalized event parity", () => {
  it("projects the same transcript without wire envelope fields", () => {
    const factory = makeFactory();
    const entry = factory.entryRecord({
      id: "settled-1",
      kind: "message",
      timestamp: "2026-07-11T09:00:00Z",
      data: { role: "assistant", text: "done" },
    });
    const frames: TranscriptFrame[] = [
      factory.snapshot([]),
      factory.event({ type: "message.update", entryId: "live-1", role: "assistant", text: "working" }),
      factory.entry(entry),
      factory.gap("replay budget exceeded"),
    ];
    let fromFrames = initialProjection();
    let fromEvents = initialProjection();
    for (const frame of frames) {
      const event = transcriptEvent(frame);
      expect(event.payload).not.toHaveProperty("v");
      expect(event.payload).not.toHaveProperty("type");
      fromFrames = reduceTranscript(fromFrames, frame);
      fromEvents = reduceTranscriptEvent(fromEvents, event);
      expect(fromEvents).toEqual(fromFrames);
    }
  });
});

describe("snapshot install", () => {
  it("installs entries through the cursor and dedupes by entry id", () => {
    const factory = makeFactory(10);
    const dupe = factory.entryRecord({
      id: "same",
      kind: "message",
      timestamp: "t",
      data: { role: "user", text: "once" },
    });
    const projection = reduceTranscript(initialProjection(), factory.snapshot([dupe, dupe]));
    expect(projection.entries.length).toBe(1);
    expect(projection.cursor).toEqual({ epoch: "e1", seq: 10 });
    expect(projection.phase).toBe("active");
  });

  it("drops live buffers the snapshot already settled", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory);
    projection = reduceTranscript(
      projection,
      factory.event({ type: "message.update", entryId: "live-1", role: "assistant", text: "hi" }),
    );
    expect(projection.liveMessages.size).toBe(1);
    const settled = factory.entryRecord({
      id: "live-1",
      kind: "message",
      timestamp: "t",
      data: { role: "assistant", text: "hi there" },
    });
    projection = reduceTranscript(projection, factory.snapshot([settled]));
    expect(projection.liveMessages.size).toBe(0);
  });

  it("bounds huge tool history while preserving image references for rendered rows", () => {
    const factory = makeFactory();
    const digest = "b".repeat(64);
    const entries = Array.from({ length: 200 }, (_, index) =>
      factory.entryRecord({
        id: `large-tool-${index}`,
        kind: "tool-result",
        timestamp: "2026-07-15T09:00:00Z",
        data: {
          tool: "bash",
          title: `Large output ${index}`,
          images: [{ sha256: digest, mimeType: "image/png" }],
          result: {
            output: `head-${index}\n${"x".repeat(300_000)}\ntail-${index}`,
          },
        },
      }),
    );

    const projection = reduceTranscript(initialProjection(), factory.snapshot(entries));
    expect(projection.historyTruncated).toBe(true);
    expect(projection.entries.length).toBeLessThan(entries.length);
    expect(projection.entries.at(-1)?.id).toBe("large-tool-199");
    expect(retainedJsonBytes(projection.entries)).toBeLessThanOrEqual(
      MAX_RETAINED_TRANSCRIPT_BYTES,
    );

    const rows = deriveTranscriptRows(projection);
    const historyNotices = rows.filter(
      (row) => row.kind === "notice" && row.notice.kind === "history-truncated",
    );
    expect(historyNotices).toHaveLength(1);
    expect(rows[0]?.id).toBe("notice-history-truncated");
    expect(deriveAttention(projection).error).toBeNull();
    const lastGroup = rows.findLast((row) => row.kind === "tool-group");
    expect(lastGroup?.kind).toBe("tool-group");
    if (lastGroup?.kind !== "tool-group") throw new Error("expected a tool row");
    expect(lastGroup.calls.at(-1)?.images).toEqual([
      { entryId: "large-tool-199", sha256: digest, mimeType: "image/png" },
    ]);
  }, 15_000);

  it("clears stale in-flight state when a fresh snapshot crosses a server epoch", () => {
    const first = makeFactory();
    let projection = withSnapshot(first, 0);
    projection = reduceTranscript(projection, first.event({ type: "turn.start" }));
    projection = reduceTranscript(
      projection,
      first.event({ type: "message.update", entryId: "stale", text: "partial" }),
    );
    projection = reduceTranscript(
      projection,
      first.event({ type: "tool.start", callId: "tool-1", tool: "bash", title: "test" }),
    );

    const restarted = new FrameFactory({ host: "h", session: "s", epoch: "e2", startSeq: 0 });
    projection = reduceTranscript(projection, restarted.snapshot([]));

    expect(projection.turnActive).toBe(false);
    expect(projection.turnStartedAt).toBeNull();
    expect(projection.liveMessages.size).toBe(0);
    expect(projection.toolCalls.size).toBe(0);
    expect(projection.cursor?.epoch).toBe("e2");
  });
});

describe("sequenced frames", () => {
  it("ignores duplicate sequences and applies contiguous ones", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory);
    const event = factory.event({
      type: "message.update",
      entryId: "m1",
      role: "assistant",
      text: "a",
    });
    projection = reduceTranscript(projection, event);
    const afterFirst = projection;
    // Same frame again: duplicate seq → strict no-op, same reference.
    projection = reduceTranscript(projection, event);
    expect(projection).toBe(afterFirst);
  });

  it("keeps existing live messages and tool calls in start order while new items evict oldest", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory, 0);

    for (let index = 0; index < MAX_RETAINED_LIVE_MESSAGES; index += 1) {
      projection = reduceTranscript(
        projection,
        factory.event({
          type: "message.update",
          entryId: `live-${index}`,
          role: "assistant",
          text: `message ${index}`,
        }),
      );
    }
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "message.update",
        entryId: "live-0",
        role: "assistant",
        text: "updated in place",
      }),
    );
    expect([...projection.liveMessages.keys()]).toEqual(
      Array.from({ length: MAX_RETAINED_LIVE_MESSAGES }, (_, index) => `live-${index}`),
    );
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "message.settled",
        transientEntryId: "live-1",
        entryId: "durable-1",
      }),
    );
    expect([...projection.liveMessages.keys()]).toEqual([
      "live-0",
      "durable-1",
      ...Array.from({ length: MAX_RETAINED_LIVE_MESSAGES - 2 }, (_, index) => `live-${index + 2}`),
    ]);

    projection = reduceTranscript(
      projection,
      factory.event({
        type: "message.update",
        entryId: "live-overflow",
        role: "assistant",
        text: "new tail",
      }),
    );
    expect([...projection.liveMessages.keys()]).toEqual([
      "durable-1",
      ...Array.from({ length: MAX_RETAINED_LIVE_MESSAGES - 2 }, (_, index) => `live-${index + 2}`),
      "live-overflow",
    ]);

    for (let index = 0; index < MAX_RETAINED_TOOL_CALLS; index += 1) {
      projection = reduceTranscript(
        projection,
        factory.event({
          type: "tool.start",
          callId: `tool-${index}`,
          tool: "bash",
          title: `Tool ${index}`,
        }),
      );
    }
    projection = reduceTranscript(
      projection,
      factory.event({ type: "tool.progress", callId: "tool-0", note: "still first" }),
    );
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "tool.result",
        callId: "tool-1",
        ok: true,
        result: { output: "done" },
      }),
    );
    expect([...projection.toolCalls.keys()]).toEqual(
      Array.from({ length: MAX_RETAINED_TOOL_CALLS }, (_, index) => `tool-${index}`),
    );

    projection = reduceTranscript(
      projection,
      factory.event({
        type: "tool.start",
        callId: "tool-overflow",
        tool: "bash",
        title: "New tail",
      }),
    );
    expect([...projection.toolCalls.keys()]).toEqual([
      ...Array.from({ length: MAX_RETAINED_TOOL_CALLS - 1 }, (_, index) => `tool-${index + 1}`),
      "tool-overflow",
    ]);
  });

  it("pauses the stream on a sequence gap and applies nothing after", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory);
    factory.skip(3);
    const late = factory.event({
      type: "message.update",
      entryId: "m1",
      role: "assistant",
      text: "should not apply",
    });
    projection = reduceTranscript(projection, late);
    expect(projection.phase).toBe("paused");
    expect(projection.liveMessages.size).toBe(0);
    // Later contiguous-looking frames still do not apply while paused.
    const next = reduceTranscript(
      projection,
      factory.event({ type: "message.update", entryId: "m2", role: "assistant", text: "x" }),
    );
    expect(next).toBe(projection);
  });

  it("pauses on an epoch change", () => {
    const factory = makeFactory();
    const projection = withSnapshot(factory);
    const other = new FrameFactory({ host: "h", session: "s", epoch: "e2", startSeq: 0 });
    const crossed = reduceTranscript(projection, other.event({ type: "turn.start" }));
    expect(crossed.phase).toBe("paused");
  });

  it("recovers from a gap frame via snapshot resync", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory);
    projection = reduceTranscript(projection, factory.gap("retention window", 5));
    expect(projection.phase).toBe("resyncing");
    projection = reduceTranscript(projection, factory.snapshot(projection.entries));
    expect(projection.phase).toBe("active");
  });

  it("drops an unmatched transient user buffer on a same-epoch recovery snapshot", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory, 0);
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "message.update",
        entryId: "prompt:transient-a",
        role: "user",
        text: "prompt A",
        at: "2026-07-11T09:00:01Z",
      }),
    );
    expect(projection.liveMessages.has("prompt:transient-a")).toBe(true);

    projection = reduceTranscript(projection, factory.gap("replay_budget_exceeded"));
    const durable = factory.entryRecord({
      id: "durable:user-a",
      kind: "message",
      timestamp: "2026-07-11T09:00:01Z",
      data: { role: "user", text: "prompt A" },
    });
    projection = reduceTranscript(projection, factory.snapshot([durable]));

    expect(projection.cursor?.epoch).toBe("e1");
    expect(projection.liveMessages.has("prompt:transient-a")).toBe(false);
    expect(
      deriveTranscriptRows(projection)
        .filter((row) => row.kind === "message" && row.role === "user")
        .map((row) => row.id),
    ).toEqual(["durable:user-a"]);
  });

  it("replaces all volatile state on a recovery snapshot with different durable ids", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory, 0);
    projection = reduceTranscript(
      projection,
      factory.event({ type: "turn.start", at: "2026-07-11T09:00:00Z" }),
    );
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "message.update",
        entryId: "prompt:pre-disconnect",
        role: "user",
        text: "ship this",
        at: "2026-07-11T09:00:01Z",
      }),
    );
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "message.update",
        entryId: "assistant:pre-disconnect",
        role: "assistant",
        text: "done",
        at: "2026-07-11T09:00:02Z",
      }),
    );
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "tool.start",
        callId: "tool:pre-disconnect",
        tool: "read",
        title: "Read stale file",
        args: {},
        at: "2026-07-11T09:00:03Z",
      }),
    );

    projection = reduceTranscript(projection, factory.gap("replay_budget_exceeded"));
    expect(projection.phase).toBe("resyncing");
    expect(projection.notices.some((notice) => notice.kind === "gap")).toBe(true);

    projection = reduceTranscript(
      projection,
      factory.snapshot([
        factory.entryRecord({
          id: "durable:user-after-reconnect",
          kind: "message",
          timestamp: "2026-07-11T09:00:01Z",
          data: { role: "user", text: "ship this" },
        }),
        factory.entryRecord({
          id: "durable:assistant-after-reconnect",
          kind: "message",
          timestamp: "2026-07-11T09:00:02Z",
          data: { role: "assistant", text: "done" },
        }),
      ]),
    );

    expect(projection.phase).toBe("active");
    expect(projection.liveMessages.size).toBe(0);
    expect(projection.toolCalls.size).toBe(0);
    expect(projection.turnActive).toBe(false);
    expect(projection.contextMaintenance).toBeNull();
    expect(
      deriveTranscriptRows(projection)
        .filter((row) => row.kind === "message")
        .map((row) => row.id),
    ).toEqual(["durable:user-after-reconnect", "durable:assistant-after-reconnect"]);
  });

  it("keeps one recovery episode out of the transcript and clears it on the fresh snapshot", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory);

    projection = reduceTranscript(projection, factory.gap("replay_budget_exceeded", 5));
    const firstGap = projection.notices.find((notice) => notice.kind === "gap");
    expect(firstGap).toBeDefined();
    expect(
      deriveTranscriptRows(projection).some(
        (row) => row.kind === "notice" && row.notice.kind === "gap",
      ),
    ).toBe(false);

    // A repeated server gap while the same session is still resyncing is the
    // same recovery episode, even if its replay boundary advanced.
    const duplicate = reduceTranscript(projection, factory.gap("replay_budget_exceeded", 2));
    expect(duplicate).toBe(projection);
    expect(duplicate.notices.find((notice) => notice.kind === "gap")).toBe(firstGap);
    expect(
      deriveTranscriptRows(duplicate).some(
        (row) => row.kind === "notice" && row.notice.kind === "gap",
      ),
    ).toBe(false);

    projection = reduceTranscript(duplicate, factory.snapshot(duplicate.entries));
    expect(projection.phase).toBe("active");
    expect(projection.notices.some((notice) => notice.kind === "gap")).toBe(false);
    expect(
      deriveTranscriptRows(projection).some(
        (row) => row.kind === "notice" && row.notice.kind === "gap",
      ),
    ).toBe(false);

    // A later gap is still tracked as a new recovery episode for the banner,
    // but it never becomes a second transcript warning.
    projection = reduceTranscript(projection, factory.gap("retention window", 1));
    const nextGap = projection.notices.find((notice) => notice.kind === "gap");
    expect(nextGap).toBeDefined();
    expect(nextGap?.id).not.toBe(firstGap?.id);
    expect(
      deriveTranscriptRows(projection).some(
        (row) => row.kind === "notice" && row.notice.kind === "gap",
      ),
    ).toBe(false);
  });
});

describe("live/durable exclusion", () => {
  it("keeps an accepted pre-turn prompt visible through context preparation and settlement", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory, 0);
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "compaction.start",
        action: "compact",
        reason: "pending_prompt_size",
        at: "2026-07-11T09:00:01Z",
      }),
    );

    expect(projection.turnActive).toBe(false);
    expect(projection.contextMaintenance).toEqual({
      startedAt: "2026-07-11T09:00:01Z",
      reason: "pending_prompt_size",
    });
    let rows = deriveTranscriptRows(projection, {
      sessionActive: true,
    });
    expect(rows).toEqual([
      {
        id: "working",
        kind: "working",
        startedAt: "2026-07-11T09:00:01Z",
        activity: "preparing-context",
      },
    ]);

    projection = reduceTranscript(
      projection,
      factory.event({
        type: "message.update",
        entryId: "prompt:request-7",
        role: "user",
        text: "keep going",
        at: "2026-07-11T09:00:02Z",
      }),
    );
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "message.settled",
        transientEntryId: "prompt:request-7",
        entryId: "durable-user-7",
      }),
    );
    projection = reduceTranscript(
      projection,
      factory.entry(
        factory.entryRecord({
          id: "durable-user-7",
          kind: "message",
          timestamp: "2026-07-11T09:00:03Z",
          data: { role: "user", text: "keep going" },
        }),
      ),
    );

    rows = deriveTranscriptRows(projection, { sessionActive: true });
    expect(rows.filter((row) => row.kind === "message")).toHaveLength(1);
    expect(rows.find((row) => row.kind === "message")).toMatchObject({
      id: "durable-user-7",
      role: "user",
      live: false,
    });
    expect(rows.find((row) => row.kind === "working")).toMatchObject({
      activity: "preparing-context",
    });

    projection = reduceTranscript(
      projection,
      factory.event({ type: "compaction.end", at: "2026-07-11T09:00:04Z" }),
    );
    expect(projection.contextMaintenance).toBeNull();
    rows = deriveTranscriptRows(projection, { sessionActive: false });
    expect(rows.filter((row) => row.kind === "message")).toHaveLength(1);
    expect(rows.some((row) => row.kind === "working")).toBe(false);
  });

  it("retires context preparation when a real turn starts even if compaction.end was missed", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory, 0);
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "compaction.start",
        reason: "pending_prompt_size",
        at: "2026-07-11T09:00:01Z",
      }),
    );
    expect(projection.contextMaintenance).not.toBeNull();

    projection = reduceTranscript(
      projection,
      factory.event({ type: "turn.start", at: "2026-07-11T09:00:02Z" }),
    );
    expect(projection.turnActive).toBe(true);
    expect(projection.contextMaintenance).toBeNull();
    expect(deriveTranscriptRows(projection).find((row) => row.kind === "working")).toMatchObject({
      activity: "working",
      startedAt: "2026-07-11T09:00:02Z",
    });
  });

  it("discards an accepted transient prompt that never becomes durable", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory, 0);
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "message.update",
        entryId: "prompt:failed-request",
        role: "user",
        text: "do the thing",
        at: "2026-07-11T09:00:01Z",
      }),
    );
    expect(projection.liveMessages.has("prompt:failed-request")).toBe(true);

    projection = reduceTranscript(
      projection,
      factory.event({
        type: "message.discarded",
        transientEntryId: "prompt:failed-request",
        reason: "prompt_failed",
        at: "2026-07-11T09:00:02Z",
      }),
    );
    expect(projection.liveMessages.has("prompt:failed-request")).toBe(false);
    expect(deriveTranscriptRows(projection).some((row) => row.kind === "message")).toBe(false);
  });

  it("keeps a newer accepted prompt active when an older prompt error arrives late", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory, 0);
    projection = reduceTranscript(
      projection,
      factory.event({ type: "turn.start", at: "2026-07-11T09:00:01Z" }),
    );
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "message.update",
        entryId: "prompt:request-b",
        role: "user",
        text: "prompt B",
        at: "2026-07-11T09:00:02Z",
      }),
    );

    projection = reduceTranscript(
      projection,
      factory.event({
        type: "turn.error",
        message: "prompt A failed late",
        retryable: true,
        at: "2026-07-11T09:00:03Z",
      }),
    );

    expect(projection.turnActive).toBe(true);
    expect(projection.liveMessages.get("prompt:request-b")?.text).toBe("prompt B");
    expect(deriveAttention(projection).error).toBeNull();
    expect(projection.notices.find((notice) => notice.kind === "error")?.message).toBe(
      "prompt A failed late",
    );
    const rows = deriveTranscriptRows(projection);
    expect(rows.filter((row) => row.id === "prompt:request-b")).toHaveLength(1);
    expect(rows.find((row) => row.kind === "working")).toMatchObject({ activity: "working" });
  });

  it("keeps a newer accepted prompt active when an uncorrelated older agent end arrives late", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory, 0);
    projection = reduceTranscript(
      projection,
      factory.event({ type: "turn.start", at: "2026-07-11T09:00:01Z" }),
    );
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "message.update",
        entryId: "prompt:request-b",
        role: "user",
        text: "prompt B",
        at: "2026-07-11T09:00:02Z",
      }),
    );

    projection = reduceTranscript(
      projection,
      factory.event({
        type: "agent.end",
        status: "completed",
        messageCount: 1,
        at: "2026-07-11T09:00:03Z",
      }),
    );

    expect(projection.turnActive).toBe(true);
    expect(projection.liveMessages.get("prompt:request-b")?.text).toBe("prompt B");
    const rows = deriveTranscriptRows(projection);
    expect(rows.filter((row) => row.id === "prompt:request-b")).toHaveLength(1);
    expect(rows.find((row) => row.kind === "working")).toMatchObject({ activity: "working" });
  });

  it("deduplicates a pending ref fallback against an exact durable entry id", () => {
    const factory = makeFactory();
    const durable = factory.entryRecord({
      id: "prompt:request-same",
      kind: "message",
      timestamp: "2026-07-11T09:00:01Z",
      data: { role: "user", text: "already durable" },
    });
    const projection = reduceTranscript(initialProjection(), factory.snapshot([durable]));
    const rows = deriveTranscriptRows(projection, {
      sessionActive: true,
      pendingPrompts: [
        {
          entryId: "prompt:request-same",
          text: "already durable",
          attachmentCount: 1,
          at: "2026-07-11T09:00:01Z",
        },
      ],
    });

    const matches = rows.filter((row) => row.id === "prompt:request-same");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ kind: "message", live: false });
  });

  it("keeps authoritative prompt order when only a later prompt has a live event", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory, 0);
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "message.update",
        entryId: "prompt:later",
        role: "user",
        text: "later from live event",
        at: "2026-07-11T09:00:03Z",
      }),
    );
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "message.update",
        entryId: "assistant:unrelated",
        role: "assistant",
        text: "unrelated live output",
        at: "2026-07-11T09:00:04Z",
      }),
    );

    const rows = deriveTranscriptRows(projection, {
      sessionActive: true,
      pendingPrompts: [
        {
          entryId: "prompt:earlier",
          text: "earlier from ref",
          attachmentCount: 0,
          at: "2026-07-11T09:00:01Z",
        },
        {
          entryId: "prompt:later",
          text: "stale ref text",
          attachmentCount: 0,
          at: "2026-07-11T09:00:02Z",
        },
      ],
    });
    const messages = rows.filter((row) => row.kind === "message");

    expect(messages.map((row) => row.id)).toEqual([
      "prompt:earlier",
      "prompt:later",
      "assistant:unrelated",
    ]);
    expect(messages[1]).toMatchObject({
      text: "later from live event",
      startedAt: "2026-07-11T09:00:03Z",
    });
  });

  it("keeps earlier assistant output above a same-timestamp later pending follow-up", () => {
    const factory = makeFactory();
    const durable = factory.entryRecord({
      id: "durable:a",
      kind: "message",
      timestamp: "2026-07-11T09:00:01Z",
      data: { role: "user", text: "prompt A" },
    });
    let projection = reduceTranscript(initialProjection(), factory.snapshot([durable]));
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "message.update",
        entryId: "assistant:after-a",
        role: "assistant",
        text: "answering prompt A",
        at: "2026-07-11T09:00:02Z",
      }),
    );

    const rows = deriveTranscriptRows(projection, {
      sessionActive: true,
      pendingPrompts: [
        {
          entryId: "prompt:b",
          text: "follow-up B",
          attachmentCount: 0,
          at: "2026-07-11T09:00:02Z",
        },
      ],
    });

    expect(rows.filter((row) => row.kind === "message").map((row) => row.id)).toEqual([
      "durable:a",
      "assistant:after-a",
      "prompt:b",
    ]);
  });

  it("renders bounded singular and plural placeholders for image-only accepted prompts", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory, 0);
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "message.update",
        entryId: "prompt:image-only",
        role: "user",
        text: "",
        attachmentCount: 1,
      }),
    );
    expect(
      deriveTranscriptRows(projection).find((row) => row.id === "prompt:image-only"),
    ).toMatchObject({ kind: "message", text: "Image attached" });

    projection = reduceTranscript(
      projection,
      factory.event({
        type: "message.update",
        entryId: "prompt:image-only",
        role: "user",
        text: "",
        attachmentCount: 99,
      }),
    );
    expect(projection.liveMessages.get("prompt:image-only")?.attachmentCount).toBe(8);
    expect(
      deriveTranscriptRows(projection).find((row) => row.id === "prompt:image-only"),
    ).toMatchObject({ kind: "message", text: "8 images attached" });
  });

  it("appends canonical fixture message.delta chunks and keeps update replacement compatibility", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory, 0);
    const fixtureEntryId = "entry-stream-v1-live-1";
    projection = reduceTranscript(
      projection,
      factory.event({ type: "message.delta", entryId: fixtureEntryId, text: "Hello" }),
    );
    projection = reduceTranscript(
      projection,
      factory.event({ type: "message.delta", entryId: fixtureEntryId, text: " world" }),
    );
    expect(projection.liveMessages.get(fixtureEntryId)?.text).toBe("Hello world");

    projection = reduceTranscript(
      projection,
      factory.event({
        type: "message.update",
        entryId: fixtureEntryId,
        role: "assistant",
        text: "Hello world!",
      }),
    );
    expect(projection.liveMessages.get(fixtureEntryId)?.text).toBe("Hello world!");

    const settled = factory.entryRecord({
      id: fixtureEntryId,
      kind: "message",
      timestamp: "2026-07-11T09:00:03Z",
      data: { role: "assistant", text: "Hello world!" },
    });
    projection = reduceTranscript(projection, factory.entry(settled));
    expect(projection.liveMessages.has(fixtureEntryId)).toBe(false);
    expect(projection.entries.at(-1)?.id).toBe(fixtureEntryId);
  });

  it("full accumulating message events replace live text", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory);
    projection = reduceTranscript(
      projection,
      factory.event({ type: "message.update", entryId: "m", role: "assistant", text: "Hello" }),
    );
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "message.update",
        entryId: "m",
        role: "assistant",
        text: "Hello world",
      }),
    );
    expect(projection.liveMessages.get("m")?.text).toBe("Hello world");
    expect(projection.liveMessages.size).toBe(1);
  });

  it("a settled durable entry never double-renders with its live event", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory, 0);
    projection = reduceTranscript(
      projection,
      factory.event({ type: "message.update", entryId: "m", role: "assistant", text: "streamed" }),
    );
    const entry = factory.entryRecord({
      id: "m",
      kind: "message",
      timestamp: "t",
      data: { role: "assistant", text: "streamed final" },
    });
    projection = reduceTranscript(projection, factory.entry(entry));
    const rows = deriveTranscriptRows(projection);
    const messageRows = rows.filter((row) => row.kind === "message" && row.id === "m");
    expect(messageRows.length).toBe(1);
    expect(messageRows[0]?.kind === "message" && messageRows[0].live).toBe(false);
    // A stale live update for the settled id is ignored.
    const stale = reduceTranscript(
      projection,
      factory.event({ type: "message.update", entryId: "m", role: "assistant", text: "stale" }),
    );
    expect(stale.liveMessages.has("m")).toBe(false);
  });

  it("uses message.settled to reconcile different transient and durable ids", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory, 0);
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "message.update",
        entryId: "assistant:stream-7",
        role: "assistant",
        text: "same text can occur more than once",
      }),
    );
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "message.settled",
        transientEntryId: "assistant:stream-7",
        entryId: "durable-random-id",
      }),
    );
    expect(projection.liveMessages.has("assistant:stream-7")).toBe(false);
    expect(projection.liveMessages.get("durable-random-id")).toMatchObject({
      entryId: "durable-random-id",
      text: "same text can occur more than once",
    });

    projection = reduceTranscript(
      projection,
      factory.entry(
        factory.entryRecord({
          id: "durable-random-id",
          kind: "message",
          timestamp: "t",
          data: { role: "assistant", text: "same text can occur more than once" },
        }),
      ),
    );
    expect(projection.liveMessages.size).toBe(0);
    const rows = deriveTranscriptRows(projection).filter(
      (row) => row.kind === "message" && row.id === "durable-random-id",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind === "message" && rows[0].live).toBe(false);
  });
});

describe("attention and notice states", () => {
  it("never exposes interactive attention controls in an archived read-only transcript", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory);
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "ask.request",
        askId: "archived-question",
        question: "Choose a path",
        options: [{ id: "one", label: "One" }],
      }),
    );
    const attention = deriveAttention(projection);
    expect(shouldShowAttention(attention, null, false)).toBe(true);
    expect(shouldShowAttention(attention, null, true)).toBe(false);
  });

  it("models approval, ask, and plan requests and their resolution", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory);
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "approval.request",
        approvalId: "a1",
        command: "rm -rf /tmp/x",
        args: {},
      }),
    );
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "ask.request",
        askId: "q1",
        question: "Which?",
        options: [{ id: "o1", label: "One" }],
      }),
    );
    projection = reduceTranscript(
      projection,
      factory.event({ type: "plan.ready", planId: "p1", title: "Plan", body: "1. do" }),
    );
    let attention = deriveAttention(projection);
    expect(attention.approval?.approvalId).toBe("a1");
    expect(attention.ask?.askId).toBe("q1");
    expect(attention.plan?.planId).toBe("p1");

    projection = reduceTranscript(
      projection,
      factory.event({ type: "approval.resolved", approvalId: "a1" }),
    );
    projection = reduceTranscript(projection, factory.event({ type: "ask.resolved", askId: "q1" }));
    projection = reduceTranscript(
      projection,
      factory.event({ type: "plan.resolved", planId: "p1" }),
    );
    attention = deriveAttention(projection);
    expect(attention.approval).toBeNull();
    expect(attention.ask).toBeNull();
    expect(attention.plan).toBeNull();
  });

  it("replays retained attention events in causal order across omitted entry sequences", () => {
    const factory = makeFactory();
    const approval = factory.event({
      type: "approval.request",
      approvalId: "warm-approval",
      title: "Approve",
      message: "Continue?",
    });
    const ask = factory.event({
      type: "ask.request",
      askId: "warm-ask",
      question: "Which path?",
      options: [{ id: "one", label: "One" }],
    });
    const plan = factory.event({
      type: "plan.ready",
      planId: "warm-plan",
      title: "Plan",
      body: "1. Continue",
    });
    // Seq 4 belongs to a durable entry and is intentionally absent from the
    // retained event suffix.
    factory.skip(1);
    const wrongAskResolution = factory.event({ type: "ask.resolved", askId: "older-ask" });
    const approvalResolution = factory.event({
      type: "approval.resolved",
      approvalId: "warm-approval",
    });
    const planResolution = factory.event({ type: "plan.resolved", planId: "warm-plan" });
    const askResolution = factory.event({ type: "ask.resolved", askId: "warm-ask" });
    const baseline = factory.cursor();
    const seed = reduceTranscript(initialProjection(), factory.snapshot([]));
    const identity = { cursor: baseline, hostId: "h", sessionId: "s" };

    const partlyResolved = replayRetainedTranscriptEvents(
      seed,
      [approval, ask, plan, wrongAskResolution, approvalResolution, planResolution],
      identity,
    );
    expect(partlyResolved.cursor).toEqual(baseline);
    expect(partlyResolved.approval).toBeNull();
    expect(partlyResolved.plan).toBeNull();
    expect(partlyResolved.ask?.askId).toBe("warm-ask");

    const fullyResolved = replayRetainedTranscriptEvents(
      seed,
      [
        approval,
        ask,
        plan,
        wrongAskResolution,
        approvalResolution,
        planResolution,
        askResolution,
      ],
      identity,
    );
    expect(fullyResolved.approval).toBeNull();
    expect(fullyResolved.ask).toBeNull();
    expect(fullyResolved.plan).toBeNull();

    const outOfOrder = replayRetainedTranscriptEvents(seed, [ask, approval], identity);
    expect(outOfOrder).toBe(seed);
  });

  it("clears replayed attention when reconnect recovery installs a snapshot", () => {
    const factory = makeFactory();
    const ask = factory.event({
      type: "ask.request",
      askId: "stale-after-gap",
      question: "Choose",
      options: [],
    });
    const baseline = factory.cursor();
    let projection = reduceTranscript(initialProjection(), factory.snapshot([]));
    projection = replayRetainedTranscriptEvents(projection, [ask], {
      cursor: baseline,
      hostId: "h",
      sessionId: "s",
    });
    expect(projection.ask?.askId).toBe("stale-after-gap");

    projection = reduceTranscript(projection, factory.gap("replay_budget_exceeded"));
    expect(projection.phase).toBe("resyncing");
    projection = reduceTranscript(projection, factory.snapshot([]));
    expect(projection.phase).toBe("active");
    expect(projection.approval).toBeNull();
    expect(projection.ask).toBeNull();
    expect(projection.plan).toBeNull();
  });

  it("projects the real RPC approval shape without a blank card", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory);
    projection = reduceTranscript(
      projection,
      factory.event({
        type: "approval.request",
        approvalId: "rpc-confirm-1",
        title: "Apply migration?",
        message: "This rewrites settings.db and creates a backup.",
        responseKind: "confirmed",
        source: "rpc-ui",
      }),
    );
    expect(projection.approval).toMatchObject({
      approvalId: "rpc-confirm-1",
      title: "Apply migration?",
      message: "This rewrites settings.db and creates a backup.",
      command: "",
    });
  });

  it("ends active composer state when agent.end arrives without turn.end", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory);
    projection = reduceTranscript(projection, factory.event({ type: "turn.start" }));
    projection = reduceTranscript(
      projection,
      factory.event({ type: "message.update", entryId: "live", text: "partial" }),
    );
    projection = reduceTranscript(
      projection,
      factory.event({ type: "agent.end", status: "completed", messageCount: 1 }),
    );
    expect(projection.turnActive).toBe(false);
    expect(projection.liveMessages.size).toBe(0);
  });

  it("surfaces error/retry/compaction notices and advances past additive unknown events", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory);
    projection = reduceTranscript(
      projection,
      factory.event({ type: "turn.retry", attempt: 2, reason: "flaky network" }),
    );
    projection = reduceTranscript(
      projection,
      factory.event({ type: "compaction", summary: "folded", droppedEntries: 3 }),
    );
    projection = reduceTranscript(
      projection,
      factory.event({ type: "turn.error", message: "boom", retryable: true }),
    );
    expect(projection.notices.map((notice) => notice.kind)).toEqual([
      "retry",
      "compaction",
      "error",
    ]);
    expect(deriveAttention(projection).error?.retryable).toBe(true);

    projection = reduceTranscript(
      projection,
      factory.event({ type: "wormhole.open", detail: "??" }),
    );
    const unknownCursor = projection.cursor;
    expect(projection.phase).toBe("active");
    expect(projection.notices.map((notice) => notice.kind)).toEqual([
      "retry",
      "compaction",
      "error",
    ]);

    projection = reduceTranscript(
      projection,
      factory.event({ type: "turn.start", at: "2026-07-11T09:00:00Z" }),
    );
    expect(projection.cursor?.seq).toBe((unknownCursor?.seq ?? 0) + 1);
    expect(projection.turnActive).toBe(true);
  });

  it("does not resurrect an older turn error after a later turn succeeds", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory, 0);
    projection = reduceTranscript(
      projection,
      factory.event({ type: "turn.error", message: "old failure", retryable: true }),
    );
    expect(deriveAttention(projection).error?.message).toBe("old failure");

    projection = reduceTranscript(
      projection,
      factory.event({ type: "agent.end", status: "failed", messageCount: 0 }),
    );
    expect(deriveAttention(projection).error?.message).toBe("old failure");

    projection = reduceTranscript(projection, factory.event({ type: "turn.start" }));
    expect(deriveAttention(projection).error).toBeNull();
    projection = reduceTranscript(projection, factory.event({ type: "turn.end" }));

    expect(deriveAttention(projection).error).toBeNull();
    expect(projection.notices.some((notice) => notice.kind === "error")).toBe(false);
  });

  it("preserves a same-turn error through turn.end, then clears it after a later success", () => {
    const factory = makeFactory();
    let projection = withSnapshot(factory, 0);
    projection = reduceTranscript(projection, factory.event({ type: "turn.start" }));
    projection = reduceTranscript(
      projection,
      factory.event({ type: "turn.error", message: "failed generation", retryable: true }),
    );
    const failedGeneration = projection.turnGeneration;
    expect(deriveAttention(projection).error).toBeNull();
    expect(projection.notices.find((notice) => notice.kind === "error")?.turnGeneration).toBe(
      failedGeneration,
    );

    // Appserver emits this terminal frame after turn.error for the same turn.
    projection = reduceTranscript(projection, factory.event({ type: "turn.end" }));
    expect(deriveAttention(projection).error?.message).toBe("failed generation");

    projection = reduceTranscript(projection, factory.event({ type: "turn.start" }));
    expect(projection.turnGeneration).toBe(failedGeneration + 1);
    projection = reduceTranscript(projection, factory.event({ type: "turn.end" }));
    expect(deriveAttention(projection).error).toBeNull();
  });

  for (const status of ["failed", "cancelled"] as const) {
    it(`preserves the current error when agent.end is ${status}`, () => {
      const factory = makeFactory();
      let projection = withSnapshot(factory, 0);
      projection = reduceTranscript(projection, factory.event({ type: "turn.start" }));
      projection = reduceTranscript(
        projection,
        factory.event({ type: "turn.error", message: `${status} turn`, retryable: false }),
      );
      projection = reduceTranscript(
        projection,
        factory.event({ type: "agent.end", status, messageCount: 0 }),
      );

      expect(deriveAttention(projection).error?.message).toBe(`${status} turn`);
    });
  }
});

describe("10k stress projection", () => {
  it("installs 10k entries with at least 30k parts and stays identity-stable", () => {
    const script = buildSessionScript("sess-stream", "stress");
    let projection = initialProjection();
    for (const frame of script.initialFrames) projection = reduceTranscript(projection, frame);
    expect(projection.entries.length).toBe(10_000);

    // Renderable parts: markdown blocks per message (≥3) + tool rows.
    let parts = 0;
    for (const entry of projection.entries) {
      const text = entry.data.text;
      parts += typeof text === "string" ? text.split("\n\n").length : 1;
    }
    expect(parts).toBeGreaterThanOrEqual(30_000);

    const rows = deriveTranscriptRows(projection);
    const stable1 = computeStableRows(rows, initialStableRowsState());

    // An appended live event must not re-create untouched row objects — and
    // a projection change that touches nothing renderable keeps the array.
    if (projection.cursor === null) throw new Error("stress snapshot cursor is missing");
    const appendFactory = new FrameFactory({
      host: "host-local",
      session: "sess-stream",
      epoch: projection.cursor.epoch,
      startSeq: projection.cursor.seq,
    });
    const next = reduceTranscript(
      projection,
      appendFactory.event({
        type: "message.update",
        entryId: "tail",
        role: "assistant",
        text: "tail",
      }),
    );
    expect(next.entries).toBe(projection.entries); // entries array untouched
    const rows2 = deriveTranscriptRows(next);
    const stable2 = computeStableRows(rows2, stable1);
    for (let i = 0; i < stable1.result.length; i += 1) {
      expect(stable2.result[i]).toBe(stable1.result[i]);
    }
    expect(stable2.result.length).toBe(stable1.result.length + 1);
  });

  it("derives identical row references for an unchanged projection (no timer rerender)", () => {
    const script = buildSessionScript("sess-stream", "default");
    let projection = initialProjection();
    for (const frame of script.initialFrames) projection = reduceTranscript(projection, frame);
    // Rows carry no clock: derive twice, share structurally, expect the
    // exact same array back (the whole-list "second tick" no-op invariant).
    const state1 = computeStableRows(deriveTranscriptRows(projection), initialStableRowsState());
    const state2 = computeStableRows(deriveTranscriptRows(projection), state1);
    expect(state2).toBe(state1);
    expect(state2.result).toBe(state1.result);
  });
});

describe("deterministic clock", () => {
  it("fixtures derive every timestamp from the fixed epoch, never the wall clock", () => {
    const a = buildSessionScript("sess-stream", "default");
    const b = buildSessionScript("sess-stream", "default");
    // Wall-clock anchoring would drift between builds; fixed epoch cannot.
    expect(JSON.stringify(a.initialFrames)).toBe(JSON.stringify(b.initialFrames));
    expect(JSON.stringify(a.liveSteps)).toBe(JSON.stringify(b.liveSteps));
    let projection = initialProjection();
    for (const frame of a.initialFrames) projection = reduceTranscript(projection, frame);
    // First settled entry (the compaction fold) sits exactly 30 minutes
    // before the exported epoch — a fixed instant, byte-identical every run.
    expect(projection.entries[0]?.timestamp).toBe("2026-07-11T08:30:00.000Z");
    // The scripted "now" sits a fixed offset past the epoch.
    expect(FIXTURE_NOW_MS - Date.parse(FIXTURE_EPOCH_ISO)).toBe(750_000);
  });

  it("elapsed labels are a pure function of (fromIso, nowMs)", () => {
    expect(formatElapsed(FIXTURE_EPOCH_ISO, FIXTURE_NOW_MS)).toBe("12m 30s");
    expect(formatElapsed("2026-07-11T09:12:00Z", FIXTURE_NOW_MS)).toBe("30s");
    expect(formatElapsed("2026-07-11T09:59:00Z", FIXTURE_NOW_MS)).toBe("0s"); // future start clamps
  });
});

describe("tool transcript detail", () => {
  const call = (tool: string, title: string, args: Record<string, unknown> = {}) =>
    ({
      tool,
      title,
      args,
      callId: "c",
      state: "ok",
      startedAt: "",
      progress: [],
      result: null,
      endedAt: "",
    }) as never;

  it("suppresses raw and known-label duplicates while keeping meaningful previews", () => {
    expect(toolDetail(call("grep", "grep"))).toBe("");
    expect(toolDetail(call("inspect_image", "inspect_image"))).toBe("");
    expect(toolDetail(call("edit", "EDIT"))).toBe("");
    expect(toolDetail(call("bash", "bash", { command: "pwd" }))).toBe("pwd");
    expect(toolDetail(call("read", "read", { path: "src/file.ts", range: "1-3" }))).toBe(
      "src/file.ts:1-3",
    );
  });
});
