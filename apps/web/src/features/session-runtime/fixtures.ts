// Deterministic transcript fixtures. Every scripted session produces the
// same frames in the same order on every run — fixed timestamps, allocated
// sequence numbers, no wall clock — so tests and screenshots are exactly
// reproducible. The shell titlebar already labels this whole surface as
// sample data; nothing here pretends to be live runtime truth.
import type { DurableEntry } from "@t4-code/protocol";

import type { TranscriptFrame } from "../transcript/projection.ts";
import { FrameFactory } from "./frame-builders.ts";
import type { SessionIntent } from "./intents.ts";
import type { ModelChoice } from "./session-controls.ts";

export type TranscriptVariant = "default" | "stress" | "gap" | "compaction";

export interface SessionScript {
  readonly link: "live" | "cached" | "offline";
  readonly contextUsedTokens: number;
  readonly contextWindowTokens: number;
  /** Applied synchronously on attach (snapshot plus any pending attention). */
  readonly initialFrames: readonly TranscriptFrame[];
  /** Drained one frame per tick after attach; models an in-flight stream. */
  readonly liveSteps: readonly TranscriptFrame[];
  readonly factory: FrameFactory;
  /** Deterministic model menu for the fixture runtime's controls. */
  readonly modelChoices: readonly ModelChoice[];
}

/**
 * The scripted host's model menu: two cycle roles and one concrete model,
 * mirroring the live shape (roles carry a role id; models a selector).
 */
export const FIXTURE_MODEL_CHOICES: readonly ModelChoice[] = [
  {
    id: "role:default",
    kind: "role",
    label: "Default",
    detail: "anthropic/fable-5",
    selector: "anthropic/fable-5",
    role: "default",
  },
  {
    id: "role:smol",
    kind: "role",
    label: "Fast",
    detail: "moonshotai/kimi-k2.6",
    selector: "moonshotai/kimi-k2.6",
    role: "smol",
  },
  {
    id: "model:google/gemini-2.5-flash",
    kind: "model",
    label: "gemini-2.5-flash",
    detail: "google/gemini-2.5-flash",
    selector: "google/gemini-2.5-flash",
    role: null,
  },
];

/** Fixed epoch every scripted timestamp derives from. Never wall clock. */
export const FIXTURE_EPOCH_ISO = "2026-07-11T09:00:00Z";
const T0 = Date.parse(FIXTURE_EPOCH_ISO);

/**
 * The scripted timeline's "now": just past the last live step (at(12)).
 * The fixture runtime reports this as the elapsed-label time base, so
 * "Working for …" reads minutes into the scripted session — identical on
 * every run. A real bridge runtime reports the wall clock instead.
 */
export const FIXTURE_NOW_MS = T0 + 12 * 60_000 + 30_000;

function at(minutes: number, seconds = 0): string {
  return new Date(T0 + minutes * 60_000 + seconds * 1000).toISOString();
}

interface EntrySeed {
  readonly kind: string;
  readonly data: Record<string, unknown>;
  readonly timestamp: string;
}

function makeEntries(factory: FrameFactory, seeds: readonly EntrySeed[]): DurableEntry[] {
  return seeds.map((seed) =>
    factory.entryRecord({
      id: factory.nextEntryId(),
      kind: seed.kind,
      timestamp: seed.timestamp,
      data: seed.data,
    }),
  );
}

// ---------------------------------------------------------------------------
// Shared settled history: a believable OMP debugging session that exercises
// every renderer treatment — markdown, code, links, all known tools, an
// unknown entry kind, and a compaction fold.
// ---------------------------------------------------------------------------

function historySeeds(): EntrySeed[] {
  return [
    {
      kind: "compaction",
      timestamp: at(-30),
      data: {
        summary:
          "Compacted 42 earlier entries: initial reproduction attempts and two dead-end hypotheses about the websocket keepalive.",
        droppedEntries: 42,
      },
    },
    {
      kind: "message",
      timestamp: at(0),
      data: {
        role: "user",
        text: "After a reconnect I sometimes see the same assistant message twice in the transcript. Trace where duplicate stream frames get through and fix the replay path.",
      },
    },
    {
      kind: "message",
      timestamp: at(1),
      data: {
        role: "assistant",
        reasoning:
          "Duplicates after reconnect usually mean the replay window overlaps the live stream. The client buffers events while the snapshot request is in flight; if the discard boundary uses timestamps instead of the cursor, frames straddling the snapshot land twice. I should confirm how `replay.ts` picks its discard boundary before touching anything.",
        text: "I'll start from the replay path. The suspect is the buffered-event discard boundary after a snapshot install — if it compares timestamps instead of cursors, a frame that raced the snapshot lands twice.",
      },
    },
    {
      kind: "tool-use",
      timestamp: at(2),
      data: {
        tool: "search",
        title: "grep installSnapshot",
        args: { pattern: "installSnapshot|discardBuffered", path: "packages/client/src" },
        ok: true,
        result: {
          matches: 7,
          files: ["packages/client/src/replay.ts", "packages/client/src/session-stream.ts"],
        },
      },
    },
    {
      kind: "tool-use",
      timestamp: at(3),
      data: {
        tool: "read",
        title: "read replay.ts",
        args: { path: "packages/client/src/replay.ts", range: "118-166" },
        ok: true,
        result: {
          lines: 49,
          preview:
            "const boundary = snapshot.receivedAt;\nfor (const frame of buffered) {\n  if (frame.receivedAt > boundary) apply(frame);\n}",
        },
      },
    },
    {
      kind: "message",
      timestamp: at(4),
      data: {
        role: "assistant",
        text: "Found it. `replay.ts:139` discards buffered frames by **arrival time**, not by cursor:\n\n```ts\nconst boundary = snapshot.receivedAt;\nfor (const frame of buffered) {\n  if (frame.receivedAt > boundary) apply(frame);\n}\n```\n\nA frame emitted before the snapshot but delivered after it passes the time check and re-applies on top of the snapshot that already contains it. The fix is to compare against `snapshot.cursor`:\n\n- keep frames with `frame.cursor.seq > snapshot.cursor.seq`\n- drop everything at or below the snapshot cursor\n- same epoch only; an epoch change already forces a resync\n\nRelevant background: the [cursor contract](https://github.com/oh-my-pi/app-wire/blob/main/docs/cursors.md) requires exactly this ordering.",
      },
    },
    {
      kind: "tool-use",
      timestamp: at(5),
      data: {
        tool: "edit",
        title: "edit replay.ts",
        args: { path: "packages/client/src/replay.ts" },
        ok: true,
        result: {
          additions: 6,
          deletions: 4,
          diff: "-  const boundary = snapshot.receivedAt;\n-  for (const frame of buffered) {\n-    if (frame.receivedAt > boundary) apply(frame);\n-  }\n+  const boundary = snapshot.cursor;\n+  for (const frame of buffered) {\n+    if (frame.cursor.epoch !== boundary.epoch) continue;\n+    if (frame.cursor.seq > boundary.seq) apply(frame);\n+  }",
        },
      },
    },
    {
      kind: "tool-use",
      timestamp: at(6),
      data: {
        tool: "bash",
        title: "pnpm test replay",
        args: { command: "pnpm --filter @t4-code/client test replay" },
        ok: true,
        result: {
          exitCode: 0,
          output:
            "RUN  replay.test.ts\n ✓ discards buffered frames at or before the snapshot cursor (12ms)\n ✓ applies contiguous frames after the cursor (4ms)\n ✓ epoch change forces resync (3ms)\n\nTest Files  1 passed (1)\nTests  3 passed (3)",
        },
      },
    },
    {
      kind: "tool-use",
      timestamp: at(7),
      data: {
        tool: "subagent",
        title: "ReplayAudit subagent",
        args: {
          agent: "ReplayAudit",
          task: "Audit remaining time-based comparisons in packages/client",
        },
        ok: true,
        result: {
          status: "completed",
          summary:
            "No other time-based ordering found. Two comments referenced the old behavior; both updated.",
        },
      },
    },
    {
      kind: "tool-use",
      timestamp: at(8),
      data: {
        tool: "browser",
        title: "verify in dev shell",
        args: { url: "http://localhost:5173/#/sessions/sess-stream" },
        ok: true,
        result: {
          title: "T4 Code",
          note: "Reconnected 20 times under packet loss; zero duplicate rows.",
        },
        artifacts: [
          {
            artifactId: "1001",
            kind: "image",
            mediaType: "image/png",
            size: 28_412,
            sha256: "a".repeat(64),
            name: "reconnect-soak.png",
            disposition: "attachment",
            retention: "session",
          },
        ],
      },
    },
    {
      kind: "telemetry.sample",
      timestamp: at(9),
      data: {
        probe: "reconnect-soak",
        reconnects: 20,
        duplicates: 0,
        p95ReplayMs: 184,
      },
    },
    {
      kind: "turn-review",
      timestamp: at(9, 10),
      data: {
        turnId: "turn-reconnect-fix",
        baseTree: "1".repeat(40),
        headTree: "2".repeat(40),
        changes: [
          {
            path: "packages/client/src/replay.ts",
            status: "modified",
            kind: "text",
            state: "pending",
            additions: 5,
            deletions: 4,
            size: 4_218,
          },
          {
            path: "packages/client/test/replay-fence.test.ts",
            status: "untracked",
            kind: "text",
            state: "pending",
            additions: 47,
            deletions: 0,
            size: 2_806,
          },
        ],
        artifacts: [],
      },
    },
    {
      kind: "message",
      timestamp: at(10),
      data: {
        role: "user",
        text: "Nice. Run the full client suite before we call it done.",
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Live continuation: streamed on ticks after attach (sess-stream).
// ---------------------------------------------------------------------------

function streamingSteps(factory: FrameFactory): TranscriptFrame[] {
  const frames: TranscriptFrame[] = [];
  frames.push(factory.event({ type: "turn.start", at: at(11) }));
  frames.push(
    factory.event({
      type: "tool.start",
      at: at(11, 2),
      callId: "call-suite",
      tool: "bash",
      title: "pnpm --filter @t4-code/client test",
      args: { command: "pnpm --filter @t4-code/client test" },
    }),
  );
  frames.push(
    factory.event({
      type: "tool.progress",
      at: at(11, 6),
      callId: "call-suite",
      note: "RUN  session-stream.test.ts",
    }),
  );
  frames.push(
    factory.event({
      type: "tool.progress",
      at: at(11, 9),
      callId: "call-suite",
      note: " ✓ session-stream.test.ts (18 tests) 412ms",
    }),
  );
  frames.push(
    factory.event({
      type: "tool.result",
      at: at(11, 14),
      callId: "call-suite",
      ok: true,
      result: {
        exitCode: 0,
        output: "Test Files  6 passed (6)\nTests  84 passed (84)\nDuration  3.9s",
      },
    }),
  );
  const answerId = "entry-live-answer";
  const answer = [
    "Full suite is green — 84 tests across 6 files.",
    "Full suite is green — 84 tests across 6 files, including the three new replay-boundary cases.\n\nWhat changed:",
    "Full suite is green — 84 tests across 6 files, including the three new replay-boundary cases.\n\nWhat changed:\n\n- `replay.ts` now discards buffered frames by **cursor**, not arrival time\n- an epoch mismatch drops the buffer and forces a snapshot resync",
    "Full suite is green — 84 tests across 6 files, including the three new replay-boundary cases.\n\nWhat changed:\n\n- `replay.ts` now discards buffered frames by **cursor**, not arrival time\n- an epoch mismatch drops the buffer and forces a snapshot resync\n- the soak probe reconnected 20 times with zero duplicates\n\nI'd still like a second pass on `session-stream.ts` backpressure before merging — the queue high-water mark is untested.",
  ];
  const reasoning =
    "The suite passed on the first run. Remaining risk is concentrated in backpressure handling, which the suite does not exercise; flag it rather than claim completeness.";
  for (const [index, text] of answer.entries()) {
    frames.push(
      factory.event({
        type: "message.update",
        at: at(12, index * 3),
        entryId: answerId,
        role: "assistant",
        text,
        reasoning: index >= 1 ? reasoning : "",
      }),
    );
  }
  return frames;
}

// ---------------------------------------------------------------------------
// 10k stress history: 10,000 durable entries, ≥30,000 renderable parts.
// Messages carry three markdown blocks each; every eighth pair is a tool
// call so grouping stays exercised at depth.
// ---------------------------------------------------------------------------

const STRESS_ENTRY_COUNT = 10_000;

function stressSeeds(): EntrySeed[] {
  const seeds: EntrySeed[] = [];
  for (let i = 0; seeds.length < STRESS_ENTRY_COUNT; i += 1) {
    const stamp = at(-14_400 + i);
    if (i % 8 === 6) {
      seeds.push({
        kind: "tool-use",
        timestamp: stamp,
        data: {
          tool: i % 16 === 6 ? "bash" : "read",
          title: i % 16 === 6 ? `pnpm test shard-${i}` : `read src/module-${i % 97}.ts`,
          args:
            i % 16 === 6
              ? { command: `pnpm test --shard ${i % 12}/12` }
              : { path: `src/module-${i % 97}.ts`, range: "1-80" },
          ok: i % 40 !== 26,
          result:
            i % 40 === 26
              ? { exitCode: 1, output: `shard ${i % 12} failed: timeout in fixture ${i}` }
              : { exitCode: 0, output: `ok (${(i % 7) + 1} files, ${(i % 300) + 40}ms)` },
        },
      });
      continue;
    }
    const user = i % 2 === 0;
    seeds.push({
      kind: "message",
      timestamp: stamp,
      data: {
        role: user ? "user" : "assistant",
        // Three parts per message: paragraph, fenced code, list.
        text: user
          ? `Batch ${i}: verify the projection stays stable when frame ${i} lands out of band.\n\nThe duplicate arrives with the same cursor twice, so the reducer must return the identical state object.\n\n\`\`\`ts\nexpect(reduce(state, frame${i})).toBe(state);\n\`\`\`\n\n- duplicate seq must be a no-op\n- epoch change must pause`
          : `Verified batch ${i}. The reducer ignored the duplicate and kept every untouched row reference.\n\nDerivation stayed allocation-free for the settled prefix; only the tail row was rebuilt.\n\n\`\`\`txt\ncursor: {epoch: e1, seq: ${i}}\nrows reused: ${100 + (i % 400)}/${100 + (i % 400)}\n\`\`\`\n\n1. dedupe by entry id held\n2. no live/durable double render\n3. gap counter unchanged`,
        reasoning: user
          ? ""
          : `Spot-check ${i}: identity preserved across ${(i % 9) + 2} derivations.`,
      },
    });
  }
  return seeds;
}

// ---------------------------------------------------------------------------
// Per-session scripts
// ---------------------------------------------------------------------------

function scriptFor(
  sessionKey: string,
  variant: TranscriptVariant,
): Omit<SessionScript, "modelChoices"> {
  const factory = new FrameFactory({
    host: "host-local",
    session: sessionKey,
    epoch: "epoch-1",
    startSeq: 100,
  });

  if (variant === "stress") {
    const entries = makeEntries(factory, stressSeeds());
    return {
      link: "live",
      contextUsedTokens: 148_000,
      contextWindowTokens: 200_000,
      initialFrames: [factory.snapshot(entries)],
      liveSteps: streamingSteps(factory),
      factory,
    };
  }

  if (variant === "gap") {
    const entries = makeEntries(factory, historySeeds());
    const snapshot = factory.snapshot(entries);
    const beforeGap = factory.event({ type: "turn.start", at: at(11) });
    factory.skip(3); // three lost frames → strict discontinuity
    const afterGap = factory.event({
      type: "message.update",
      at: at(12),
      entryId: "entry-after-gap",
      role: "assistant",
      text: "This frame arrives after a sequence gap and must not apply.",
    });
    return {
      link: "live",
      contextUsedTokens: 61_000,
      contextWindowTokens: 200_000,
      initialFrames: [snapshot],
      liveSteps: [beforeGap, afterGap],
      factory,
    };
  }

  if (variant === "compaction") {
    const entries = makeEntries(factory, historySeeds().slice(1, 2));
    return {
      link: "live",
      contextUsedTokens: 119_000,
      contextWindowTokens: 200_000,
      initialFrames: [
        factory.snapshot(entries),
        factory.event({
          type: "compaction.start",
          action: "compact",
          reason: "pending_prompt_size",
          at: at(11),
        }),
      ],
      // Keeps the keyed working row mounted while its activity and start time
      // change, exercising the exact compaction -> turn handoff in the UI.
      liveSteps: [factory.event({ type: "turn.start", at: at(12) })],
      factory,
    };
  }

  switch (sessionKey) {
    case "sess-stream": {
      const entries = makeEntries(factory, historySeeds());
      return {
        link: "live",
        contextUsedTokens: 61_000,
        contextWindowTokens: 200_000,
        initialFrames: [factory.snapshot(entries)],
        liveSteps: streamingSteps(factory),
        factory,
      };
    }
    case "sess-settings": {
      const entries = makeEntries(factory, [
        {
          kind: "message",
          timestamp: at(0),
          data: {
            role: "user",
            text: "Migrate the settings store to schema v3 and apply the migration here.",
          },
        },
        {
          kind: "message",
          timestamp: at(2),
          data: {
            role: "assistant",
            text: "Migration script is written and dry-run clean: 214 rows map onto schema v3 with no lossy coercions. Applying it rewrites `settings.db`, so I need your go-ahead for the write.",
          },
        },
      ]);
      return {
        link: "live",
        contextUsedTokens: 38_000,
        contextWindowTokens: 200_000,
        initialFrames: [
          factory.snapshot(entries),
          factory.event({ type: "turn.start", at: at(3) }),
          factory.event({
            type: "approval.request",
            at: at(3, 5),
            approvalId: "approval-migrate",
            command: "pnpm migrate --apply",
            args: { cwd: ".", writes: "settings.db", backup: "settings.db.bak" },
          }),
        ],
        liveSteps: [],
        factory,
      };
    }
    case "sess-fixtures": {
      const entries = makeEntries(factory, [
        {
          kind: "message",
          timestamp: at(0),
          data: { role: "user", text: "Pin the protocol fixtures for desktop CI." },
        },
        {
          kind: "message",
          timestamp: at(1),
          data: {
            role: "assistant",
            text: "There are three fixture scenario sets checked in. Pinning all of them doubles CI time; pinning one risks losing coverage. Which set should CI keep?",
          },
        },
      ]);
      return {
        link: "live",
        contextUsedTokens: 22_000,
        contextWindowTokens: 200_000,
        initialFrames: [
          factory.snapshot(entries),
          factory.event({ type: "turn.start", at: at(2) }),
          factory.event({
            type: "ask.request",
            at: at(2, 4),
            askId: "ask-scenarios",
            question: "Which fixture scenario set should desktop CI pin?",
            multiple: false,
            allowText: true,
            options: [
              {
                id: "stream",
                label: "stream-v1",
                detail: "Deterministic streaming and tool deltas — fastest, 40s",
              },
              {
                id: "faults",
                label: "faults-v1",
                detail: "Malformed frames, gaps, reordering — broadest, 3m",
              },
              {
                id: "multi",
                label: "multi-client-v1",
                detail: "Concurrent client convergence — 90s",
              },
            ],
          }),
        ],
        liveSteps: [],
        factory,
      };
    }
    case "sess-bundle": {
      const entries = makeEntries(factory, [
        {
          kind: "message",
          timestamp: at(0),
          data: {
            role: "user",
            text: "Split the renderer bundle so cold start stops shipping xterm and markdown to the splash screen.",
          },
        },
      ]);
      return {
        link: "live",
        contextUsedTokens: 47_000,
        contextWindowTokens: 200_000,
        initialFrames: [
          factory.snapshot(entries),
          factory.event({ type: "turn.start", at: at(1) }),
          factory.event({
            type: "plan.ready",
            at: at(4),
            planId: "plan-bundle",
            title: "Split the renderer bundle",
            body: "1. **Measure first.** Add `rollup-plugin-visualizer` to the dev build and record the current chunk graph (xterm is 214 kB gzipped, markdown stack 96 kB).\n2. **Lazy-load the terminal.** Move xterm and its addons behind a dynamic import that resolves when the first terminal mounts.\n3. **Split markdown.** Load the react-markdown pipeline with the first transcript render instead of at boot.\n4. **Verify.** Assert the entry chunk stays under 180 kB gzipped in CI and cold start improves on the 840×620 baseline machine.",
          }),
        ],
        liveSteps: [],
        factory,
      };
    }
    case "sess-resize": {
      const entries = makeEntries(factory, [
        {
          kind: "message",
          timestamp: at(0),
          data: { role: "user", text: "Bisect the flaky terminal resize test." },
        },
        {
          kind: "tool-use",
          timestamp: at(2),
          data: {
            tool: "bash",
            title: "pnpm test resize --repeat 50",
            args: { command: "pnpm test resize --repeat 50" },
            ok: false,
            result: {
              exitCode: 137,
              output:
                "run 34/50\nFAIL resize.test.ts > refits within 50ms after release\nKilled (OOM): exit 137",
            },
          },
        },
      ]);
      return {
        link: "live",
        contextUsedTokens: 15_000,
        contextWindowTokens: 200_000,
        initialFrames: [
          factory.snapshot(entries),
          factory.event({ type: "turn.start", at: at(3) }),
          factory.event({
            type: "turn.retry",
            at: at(3, 10),
            attempt: 1,
            reason: "Runner exited during pnpm test (code 137)",
          }),
          factory.event({
            type: "turn.error",
            at: at(3, 40),
            message:
              "The test runner was killed twice at repeat 34 (exit 137, out of memory). The turn stopped before the bisect finished.",
            retryable: true,
          }),
        ],
        liveSteps: [],
        factory,
      };
    }
    default: {
      // Completed / cached / offline sessions: settled history only.
      const entries = makeEntries(factory, historySeeds().slice(1, 7));
      const link =
        sessionKey === "sess-notes"
          ? ("cached" as const)
          : sessionKey === "sess-pagination" || sessionKey === "sess-theme"
            ? ("offline" as const)
            : ("live" as const);
      return {
        link,
        contextUsedTokens: 12_000,
        contextWindowTokens: 200_000,
        initialFrames: [factory.snapshot(entries)],
        liveSteps: [],
        factory,
      };
    }
  }
}

export function buildSessionScript(sessionKey: string, variant: TranscriptVariant): SessionScript {
  return { ...scriptFor(sessionKey, variant), modelChoices: FIXTURE_MODEL_CHOICES };
}

// ---------------------------------------------------------------------------
// Intent responses: deterministic frame batches the fixture runtime emits in
// reply to renderer intents. Each inner array is one tick's worth of frames.
// ---------------------------------------------------------------------------

export function framesForIntent(factory: FrameFactory, intent: SessionIntent): TranscriptFrame[][] {
  const stamp = at(20);
  switch (intent.kind) {
    case "prompt": {
      const userEntry = factory.entryRecord({
        id: factory.nextEntryId("user"),
        kind: "message",
        timestamp: stamp,
        data: {
          role: "user",
          text: intent.text,
          attachments: intent.attachments.map((attachment) => attachment.name),
        },
      });
      const answerId = factory.nextEntryId("live");
      const finalText = "Understood — picking that up now.";
      const settled = factory.entryRecord({
        id: answerId,
        kind: "message",
        timestamp: at(21),
        data: { role: "assistant", text: finalText },
      });
      return [
        [factory.entry(userEntry), factory.event({ type: "turn.start", at: stamp })],
        [
          factory.event({
            type: "message.update",
            at: at(20, 2),
            entryId: answerId,
            role: "assistant",
            text: "Understood — picking that up",
          }),
        ],
        [
          factory.event({
            type: "message.update",
            at: at(20, 4),
            entryId: answerId,
            role: "assistant",
            text: finalText,
          }),
        ],
        [factory.entry(settled), factory.event({ type: "turn.end", at: at(21) })],
      ];
    }
    case "steer": {
      const entry = factory.entryRecord({
        id: factory.nextEntryId("steer"),
        kind: "message",
        timestamp: stamp,
        data: { role: "user", text: intent.text, steer: true },
      });
      return [[factory.entry(entry)]];
    }
    case "followUp": {
      const entry = factory.entryRecord({
        id: factory.nextEntryId("follow"),
        kind: "message",
        timestamp: stamp,
        data: { role: "user", text: intent.text, queued: true },
      });
      return [[factory.entry(entry)]];
    }
    case "cancel": {
      const entry = factory.entryRecord({
        id: factory.nextEntryId("abort"),
        kind: "error",
        timestamp: stamp,
        data: { message: "Stopped at your request.", retryable: false },
      });
      return [[factory.event({ type: "turn.end", at: stamp }), factory.entry(entry)]];
    }
    case "approval": {
      const resolved = factory.event({
        type: "approval.resolved",
        at: stamp,
        approvalId: intent.approvalId,
        outcome: intent.decision,
      });
      if (intent.decision === "deny") {
        const entry = factory.entryRecord({
          id: factory.nextEntryId("deny"),
          kind: "message",
          timestamp: at(20, 2),
          data: {
            role: "assistant",
            text: "Holding off. The migration script stays staged; nothing was written. Tell me what should change before we apply it.",
          },
        });
        return [
          [resolved],
          [factory.entry(entry), factory.event({ type: "turn.end", at: at(20, 3) })],
        ];
      }
      return [
        [resolved],
        [
          factory.event({
            type: "tool.start",
            at: at(20, 2),
            callId: "call-approved",
            tool: "bash",
            title: "pnpm migrate --apply",
            args: { command: "pnpm migrate --apply" },
          }),
        ],
        [
          factory.event({
            type: "tool.result",
            at: at(20, 8),
            callId: "call-approved",
            ok: true,
            result: {
              exitCode: 0,
              output: "214 rows migrated to schema v3\nbackup written to settings.db.bak",
            },
          }),
        ],
        [
          factory.entry(
            factory.entryRecord({
              id: factory.nextEntryId("applied"),
              kind: "message",
              timestamp: at(20, 10),
              data: {
                role: "assistant",
                text: "Migration applied: 214 rows on schema v3, backup at `settings.db.bak`. Reads verified against the new shape.",
              },
            }),
          ),
          factory.event({ type: "turn.end", at: at(20, 11) }),
        ],
      ];
    }
    case "ask": {
      const resolved = factory.event({ type: "ask.resolved", at: stamp, askId: intent.askId });
      const answerText = intent.optionIds.length > 0 ? intent.optionIds.join(", ") : intent.text;
      const userEntry = factory.entryRecord({
        id: factory.nextEntryId("answer"),
        kind: "message",
        timestamp: stamp,
        data: { role: "user", text: answerText, answersAsk: intent.askId },
      });
      const ack = factory.entryRecord({
        id: factory.nextEntryId("ack"),
        kind: "message",
        timestamp: at(20, 4),
        data: {
          role: "assistant",
          text: `Pinning ${answerText} for desktop CI. I'll wire the fixture checksums into the workflow next.`,
        },
      });
      return [
        [resolved, factory.entry(userEntry)],
        [factory.entry(ack), factory.event({ type: "turn.end", at: at(20, 5) })],
      ];
    }
    case "plan": {
      const resolved = factory.event({
        type: "plan.resolved",
        at: stamp,
        planId: intent.planId,
        outcome: intent.action,
      });
      if (intent.action === "approve") {
        return [
          [resolved],
          [
            factory.event({
              type: "tool.start",
              at: at(20, 2),
              callId: "call-plan",
              tool: "bash",
              title: "pnpm add -D rollup-plugin-visualizer",
              args: { command: "pnpm add -D rollup-plugin-visualizer" },
            }),
          ],
          [
            factory.event({
              type: "tool.result",
              at: at(20, 6),
              callId: "call-plan",
              ok: true,
              result: { exitCode: 0, output: "+ rollup-plugin-visualizer 6.1.0" },
            }),
          ],
        ];
      }
      const text =
        intent.action === "revise"
          ? `Revising the plan with your note: ${intent.note || "(no note)"} — I'll post the updated steps shortly.`
          : "Plan set aside. Nothing was changed; tell me how you'd like to approach it instead.";
      return [
        [resolved],
        [
          factory.entry(
            factory.entryRecord({
              id: factory.nextEntryId("plan-followup"),
              kind: "message",
              timestamp: at(20, 3),
              data: { role: "assistant", text },
            }),
          ),
          factory.event({ type: "turn.end", at: at(20, 4) }),
        ],
      ];
    }
    case "setModel":
    case "setThinking":
    case "setFast":
    case "setMode":
      // Control changes are runtime state, not transcript frames; the
      // fixture runtime applies them before frames are ever requested.
      return [];
  }
}
