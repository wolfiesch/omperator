import {
  OMP_RUNTIME_INTEGRATION,
  ProjectionStore,
  type DesktopRuntimeController,
  type DesktopRuntimeSnapshot,
} from "@t4-code/client";
import { hostId, revision, sessionId, type SessionRef } from "@t4-code/protocol";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  attentionResponseArgs,
  respondToAttentionItem,
} from "../src/features/session-runtime/attention-actions.ts";

function liveSnapshot(pending: readonly Record<string, unknown>[]): DesktopRuntimeSnapshot {
  const host = "host-attention";
  const session = "session-attention";
  const ref = {
    hostId: hostId(host),
    sessionId: sessionId(session),
    project: { projectId: "project-attention", name: "T4 Code" },
    revision: revision("revision-attention"),
    title: "Attention session",
    status: "idle",
    updatedAt: "2030-01-02T11:00:00.000Z",
    attention: { pending, pendingCount: pending.length, truncated: false },
  } as unknown as SessionRef;
  const projection = new ProjectionStore();
  projection.applyPublicFrame({
    v: "omp-app/1",
    type: "sessions",
    cursor: { epoch: "attention-actions", seq: 1 },
    sessions: [ref],
    totalCount: 1,
    truncated: false,
  } as never);
  return {
    version: 1,
    integration: OMP_RUNTIME_INTEGRATION,
    platform: "darwin",
    desktopVersion: "test",
    startState: "started",
    targets: new Map([
      [
        "target-attention",
        {
          targetId: "target-attention",
          label: "Test host",
          kind: "remote",
          state: "connected",
          paired: true,
        },
      ],
    ]),
    connections: new Map([["target-attention", "connected"]]),
    targetHosts: new Map([["target-attention", host]]),
    hosts: new Map(),
    catalogs: new Map(),
    settings: new Map(),
    projection: projection.getSnapshot(),
    runtimeErrors: [],
  };
}

describe("attentionResponseArgs", () => {
  it("maps approval and plan decisions to host confirmations", () => {
    expect(
      attentionResponseArgs({ kind: "approval", requestId: "approval-1", decision: "approve" }),
    ).toEqual({ requestId: "approval-1", confirmed: true });
    expect(
      attentionResponseArgs({ kind: "plan", requestId: "plan-1", decision: "reject" }),
    ).toEqual({ requestId: "plan-1", confirmed: false });
    expect(
      attentionResponseArgs({
        kind: "plan",
        requestId: "plan-2",
        decision: "revise",
        note: "Keep the migration reversible",
      }),
    ).toEqual({ requestId: "plan-2", value: "Keep the migration reversible" });
  });

  it("prefers question text and otherwise sends selected option ids", () => {
    expect(
      attentionResponseArgs({
        kind: "question",
        requestId: "question-1",
        optionIds: ["one", "two"],
        text: "A custom answer",
      }),
    ).toEqual({ requestId: "question-1", value: "A custom answer" });
    expect(
      attentionResponseArgs({
        kind: "question",
        requestId: "question-2",
        optionIds: ["one", "two"],
        text: "",
      }),
    ).toEqual({ requestId: "question-2", value: "one, two" });
  });

  it("dispatches against the current indexed request and revision", async () => {
    const snapshot = liveSnapshot([
      {
        kind: "approval",
        id: "approval-current",
        title: "Approve migration",
        summary: "Run the migration",
        requestedAt: "2030-01-02T10:00:00.000Z",
      },
    ]);
    const commandWithPromptLease = vi.fn(
      async (
        _targetId: string,
        _intent: unknown,
        _leaseRevision: string | undefined,
        beforeDispatch: (() => void) | undefined,
      ) => {
        beforeDispatch?.();
        return { accepted: true };
      },
    );
    const controller = {
      getSnapshot: () => snapshot,
      commandWithPromptLease,
    } as unknown as DesktopRuntimeController;

    await expect(
      respondToAttentionItem(
        controller,
        {
          targetId: "target-attention",
          hostId: "host-attention",
          sessionId: "session-attention",
        },
        { kind: "approval", requestId: "approval-current", decision: "approve" },
      ),
    ).resolves.toEqual({ kind: "accepted" });
    expect(commandWithPromptLease).toHaveBeenCalledWith(
      "target-attention",
      expect.objectContaining({
        command: "session.ui.respond",
        expectedRevision: "revision-attention",
        args: { requestId: "approval-current", confirmed: true },
      }),
      undefined,
      expect.any(Function),
    );
  });

  it("refuses an item that the host already resolved or replaced", async () => {
    const snapshot = liveSnapshot([]);
    const commandWithPromptLease = vi.fn();
    const controller = {
      getSnapshot: () => snapshot,
      commandWithPromptLease,
    } as unknown as DesktopRuntimeController;

    await expect(
      respondToAttentionItem(
        controller,
        {
          targetId: "target-attention",
          hostId: "host-attention",
          sessionId: "session-attention",
        },
        { kind: "approval", requestId: "approval-old", decision: "deny" },
      ),
    ).resolves.toEqual({
      kind: "rejected",
      reason: "This request was already resolved or replaced.",
    });
    expect(commandWithPromptLease).not.toHaveBeenCalled();
  });

  it("fails closed when a security confirmation expires before dispatch", async () => {
    const base = liveSnapshot([]);
    const snapshot = {
      ...base,
      projection: {
        ...base.projection,
        sessions: new Map([
          [
            "host-attention\u0000session-attention",
            {
              freshness: "fresh",
              confirmations: new Map([
                [
                  "confirmation-expired",
                  {
                    confirmationId: "confirmation-expired",
                    commandId: "command-expired",
                    hostId: "host-attention",
                    sessionId: "session-attention",
                    expiresAt: new Date(Date.now() - 1_000).toISOString(),
                  },
                ],
              ]),
            },
          ],
        ]),
      },
    } as unknown as DesktopRuntimeSnapshot;
    const confirm = vi.fn();
    const controller = {
      getSnapshot: () => snapshot,
      confirm,
    } as unknown as DesktopRuntimeController;

    await expect(
      respondToAttentionItem(
        controller,
        {
          targetId: "target-attention",
          hostId: "host-attention",
          sessionId: "session-attention",
        },
        { kind: "confirmation", requestId: "confirmation-expired", decision: "approve" },
      ),
    ).resolves.toEqual({
      kind: "rejected",
      reason: "This security confirmation expired. Open the session to request it again.",
    });
    expect(confirm).not.toHaveBeenCalled();
  });
});
