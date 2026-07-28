import {
  createDesktopRuntimeController,
  type DesktopRuntimeController,
} from "@t4-code/client";
import {
  catalogId,
  entryId,
  hostId,
  revision,
  sessionId,
  type CatalogFrame,
  type CatalogItem,
  type DurableEntry,
  type DurableEntryFrame,
  type LiveEventFrame,
  type OperationCapability,
  type SessionSnapshotFrame,
  type SessionsFrame,
} from "@t4-code/protocol";

import { createLiveSessionRuntime } from "../src/features/session-runtime/live-runtime.ts";
import type { SessionRuntime } from "../src/features/session-runtime/controller.ts";
import {
  bindProjectionInventoryResults,
  FakeShell,
  makeWelcome,
} from "./fake-shell.ts";

export const V = "omp-app/1" as const;
export const HOST = "host-a";
export const SESSION = "session-a";

export function entry(id: string, text: string): DurableEntry {
  return {
    id: entryId(id),
    parentId: null,
    hostId: hostId(HOST),
    sessionId: sessionId(SESSION),
    kind: "message",
    timestamp: "2026-07-11T10:00:00Z",
    data: { role: "assistant", text },
  };
}

export function snapshotFrame(
  seq: number,
  entries: DurableEntry[],
): SessionSnapshotFrame {
  return {
    v: V,
    type: "snapshot",
    cursor: { epoch: "epoch-1", seq },
    revision: revision("rev-1"),
    hostId: hostId(HOST),
    sessionId: sessionId(SESSION),
    entries,
  };
}

export function turnStart(seq: number): LiveEventFrame {
  return {
    v: V,
    type: "event",
    cursor: { epoch: "epoch-1", seq },
    hostId: hostId(HOST),
    sessionId: sessionId(SESSION),
    event: { type: "turn.start", at: "2026-07-11T10:00:01Z" },
  };
}

export function turnError(seq: number, message: string): LiveEventFrame {
  return {
    v: V,
    type: "event",
    cursor: { epoch: "epoch-1", seq },
    hostId: hostId(HOST),
    sessionId: sessionId(SESSION),
    event: {
      type: "turn.error",
      message,
      retryable: true,
      at: "2026-07-11T10:00:02Z",
    },
  };
}

export function eventFrame(
  seq: number,
  event: LiveEventFrame["event"],
): LiveEventFrame {
  return {
    v: V,
    type: "event",
    cursor: { epoch: "epoch-1", seq },
    hostId: hostId(HOST),
    sessionId: sessionId(SESSION),
    event,
  };
}

export function durableEntryFrame(
  seq: number,
  value: DurableEntry,
): DurableEntryFrame {
  return {
    v: V,
    type: "entry",
    cursor: { epoch: "epoch-1", seq },
    revision: revision(`rev-${seq}`),
    hostId: hostId(HOST),
    sessionId: sessionId(SESSION),
    entry: value,
  };
}

export function commandItem(
  name: string,
  capabilities?: readonly string[],
  slashCommand = false,
): CatalogItem {
  return {
    id: catalogId(`cmd-${name}`),
    kind: "command",
    name,
    description: `${name} command`,
    ...(capabilities === undefined ? {} : { capabilities: [...capabilities] }),
    ...(slashCommand ? { metadata: { slashCommand: true } } : {}),
  };
}

export function catalogFrame(
  rev: string,
  items: CatalogItem[],
  operations?: OperationCapability[],
): CatalogFrame {
  return {
    v: V,
    type: "catalog",
    hostId: hostId(HOST),
    revision: revision(rev),
    items,
    ...(operations === undefined ? {} : { operations }),
  };
}

export function pendingPromptSessionsFrame(
  entryIdValue: string,
  text: string,
  attachmentCount = 0,
): SessionsFrame {
  return {
    v: V,
    type: "sessions",
    cursor: { epoch: "session-index-1", seq: 1 },
    sessions: [
      {
        hostId: hostId(HOST),
        sessionId: sessionId(SESSION),
        project: {
          projectId: "project-1" as SessionsFrame["sessions"][number]["project"]["projectId"],
        },
        revision: revision("rev-pending"),
        title: "Session",
        status: "active",
        updatedAt: "2026-07-11T10:00:00Z",
        liveState: {
          pendingPrompt: {
            entryId: entryIdValue,
            text,
            attachmentCount,
            at: "2026-07-11T10:00:01Z",
          },
        },
      },
    ],
    totalCount: 1,
    truncated: false,
  };
}

export function pendingPromptsSessionsFrame(
  prompts: readonly {
    readonly entryId: string;
    readonly text: string;
    readonly attachmentCount?: number;
    readonly at?: string;
  }[],
  seq = 1,
  status: "active" | "idle" = prompts.length > 0 ? "active" : "idle",
): SessionsFrame {
  return {
    v: V,
    type: "sessions",
    cursor: { epoch: "session-index-1", seq },
    sessions: [
      {
        hostId: hostId(HOST),
        sessionId: sessionId(SESSION),
        project: {
          projectId: "project-1" as SessionsFrame["sessions"][number]["project"]["projectId"],
        },
        revision: revision(`rev-pending-${seq}`),
        title: "Session",
        status,
        updatedAt: `2026-07-11T10:00:${String(seq).padStart(2, "0")}Z`,
        liveState: {
          pendingPrompts: prompts.map((prompt, index) => ({
            entryId: prompt.entryId,
            text: prompt.text,
            attachmentCount: prompt.attachmentCount ?? 0,
            at: prompt.at ?? `2026-07-11T10:01:${String(index).padStart(2, "0")}Z`,
          })),
        },
      },
    ],
    totalCount: 1,
    truncated: false,
  };
}

export interface ControllerSetup {
  readonly shell: FakeShell;
  readonly controller: DesktopRuntimeController;
}

export async function startedController(
  capabilities: readonly string[] = ["sessions.prompt"],
  features: readonly string[] = [],
): Promise<ControllerSetup> {
  const shell = new FakeShell();
  const controller = createDesktopRuntimeController({ shell });
  await controller.start();
  shell.emitFrame({
    targetId: "local",
    frame: makeWelcome(HOST, capabilities, features),
  });
  shell.emitFrame({ targetId: "local", frame: snapshotFrame(1, []) });
  shell.emitFrame({
    targetId: "local",
    frame: {
      v: V,
      type: "sessions",
      cursor: { epoch: "session-index-1", seq: 0 },
      sessions: [
        {
          hostId: hostId(HOST),
          sessionId: sessionId(SESSION),
          project: {
            projectId: "project-1" as SessionsFrame["sessions"][number]["project"]["projectId"],
          },
          revision: revision("rev-1"),
          title: "Session",
          status: "idle",
          updatedAt: "2026-07-11T09:59:00Z",
          liveState: { isStreaming: false },
        },
      ],
      totalCount: 1,
      truncated: false,
    } satisfies SessionsFrame,
  });
  bindProjectionInventoryResults(shell, controller);
  return { shell, controller };
}

export async function settle(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

export interface LiveSetup extends ControllerSetup {
  readonly runtime: SessionRuntime;
}

export async function startedRuntime(
  capabilities: readonly string[] = ["sessions.prompt"],
  features: readonly string[] = [],
): Promise<LiveSetup> {
  const { shell, controller } = await startedController(capabilities, features);
  const runtime = createLiveSessionRuntime({
    controller,
    targetId: "local",
    hostId: HOST,
    sessionId: SESSION,
  });
  return { shell, controller, runtime };
}

export const PROMPT = {
  kind: "prompt",
  text: "ship it",
  attachments: [],
} as const;
