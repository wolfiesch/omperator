import { describe, expect, it } from "vite-plus/test";
import {
  hostId,
  revision,
  sessionId,
  type SessionsFrame,
} from "@t4-code/protocol";

import {
  catalogFrame,
  commandItem,
  HOST,
  PROMPT,
  SESSION,
  startedRuntime,
  V,
} from "./live-composer-fixtures.ts";

describe("authoritative live runtime protocol", () => {
  it("uses prompt-lease for prompt, steer, followUp and response, and controller-lease for cancel", async () => {
    const { shell, controller, runtime } = await startedRuntime(
      ["sessions.prompt", "sessions.control"],
      ["prompt.lease"],
    );
    shell.emitFrame({
      targetId: "local",
      frame: catalogFrame("rev-2", [commandItem("session.cancel")]),
    });

    let promptLeaseCalled = false;
    let promptLeaseRevision: string | undefined;
    let controllerLeaseCalled = false;
    const originalPromptLease = controller.commandWithPromptLease;
    controller.commandWithPromptLease = async function (
      targetId,
      intent,
      leaseRevision,
    ) {
      promptLeaseCalled = true;
      promptLeaseRevision = leaseRevision;
      return originalPromptLease.call(this, targetId, intent, leaseRevision);
    };
    const originalControllerLease = controller.commandWithControllerLease;
    controller.commandWithControllerLease = async function (targetId, intent) {
      controllerLeaseCalled = true;
      return originalControllerLease.call(this, targetId, intent);
    };

    await runtime.submitPrompt(PROMPT);
    expect(promptLeaseCalled).toBe(true);
    const prompt = shell.commands.find((request) => request.intent.command === "session.prompt");
    expect(prompt?.intent.args).toEqual({
      message: "ship it",
      leaseId: "prompt-lease-fixture",
    });
    expect(prompt?.intent.expectedRevision).toBeUndefined();
    expect(promptLeaseRevision).toBe("rev-1");

    promptLeaseCalled = false;
    await runtime.submitPrompt({ kind: "steer", text: "steer message" });
    expect(promptLeaseCalled).toBe(true);
    expect(
      shell.commands.find((request) => request.intent.command === "session.steer")
        ?.intent.args,
    ).toEqual({
      message: "steer message",
      leaseId: "prompt-lease-fixture",
    });

    promptLeaseCalled = false;
    await runtime.submitPrompt({ kind: "followUp", text: "followup message" });
    expect(promptLeaseCalled).toBe(true);
    expect(
      shell.commands.find((request) => request.intent.command === "session.followUp")
        ?.intent.args,
    ).toEqual({
      message: "followup message",
      leaseId: "prompt-lease-fixture",
    });

    controllerLeaseCalled = false;
    await runtime.submitPrompt({ kind: "cancel" });
    expect(controllerLeaseCalled).toBe(true);
    expect(
      shell.commands.find((request) => request.intent.command === "session.cancel")
        ?.intent.expectedRevision,
    ).toBeUndefined();
  });

  it("omits volatile revisions from prompt, steer, and follow-up commands", async () => {
    const { shell, runtime } = await startedRuntime();
    await runtime.submitPrompt(PROMPT);
    await runtime.submitPrompt({ kind: "steer", text: "steer message" });
    await runtime.submitPrompt({ kind: "followUp", text: "followup message" });

    for (const command of ["session.prompt", "session.steer", "session.followUp"]) {
      expect(
        shell.commands.find((request) => request.intent.command === command)
          ?.intent.expectedRevision,
      ).toBeUndefined();
    }
  });

  it("projects queuedFollowUps from host liveState and performs no local queue mutation", async () => {
    const { shell, runtime } = await startedRuntime();
    expect(runtime.getSnapshot().queuedFollowUps).toEqual([]);

    await runtime.submitPrompt({ kind: "followUp", text: "local-followup" });
    expect(runtime.getSnapshot().queuedFollowUps).toEqual([]);

    const sessions = (queuedMessages: unknown, seq: number): SessionsFrame => ({
      v: V,
      type: "sessions",
      cursor: { epoch: "epoch-1", seq },
      sessions: [
        {
          hostId: hostId(HOST),
          sessionId: sessionId(SESSION),
          project: {
            projectId: "project-1" as SessionsFrame["sessions"][number]["project"]["projectId"],
          },
          revision: revision("rev-1"),
          title: "Session Title",
          status: "active",
          updatedAt: "2026-07-11T10:00:00Z",
          liveState: { queuedMessages },
        },
      ],
    });

    shell.emitFrame({
      targetId: "local",
      frame: sessions({ followUp: ["host-queued-1", "host-queued-2"] }, 2),
    });
    expect(runtime.getSnapshot().queuedFollowUps).toEqual([
      "host-queued-1",
      "host-queued-2",
    ]);

    shell.emitFrame({
      targetId: "local",
      frame: sessions("not-an-object", 3),
    });
    expect(runtime.getSnapshot().queuedFollowUps).toEqual([]);
  });

  it("routes ask/approval and plan responses through session.ui.respond", async () => {
    const { shell, runtime } = await startedRuntime();
    const cases = [
      {
        intent: {
          kind: "ask",
          askId: "ask-question-1",
          optionIds: ["opt-1", "opt-2"],
          text: "User input text",
        } as const,
        args: { requestId: "ask-question-1", value: "User input text" },
      },
      {
        intent: {
          kind: "ask",
          askId: "ask-question-2",
          optionIds: ["opt-choice"],
          text: "",
        } as const,
        args: { requestId: "ask-question-2", value: "opt-choice" },
      },
      {
        intent: {
          kind: "approval",
          approvalId: "rpc-approval-1",
          decision: "approve",
        } as const,
        args: { requestId: "rpc-approval-1", confirmed: true },
      },
      {
        intent: {
          kind: "approval",
          approvalId: "rpc-approval-2",
          decision: "deny",
        } as const,
        args: { requestId: "rpc-approval-2", confirmed: false },
      },
      {
        intent: { kind: "plan", planId: "plan-1", action: "approve", note: "" } as const,
        args: { requestId: "plan-1", confirmed: true },
      },
      {
        intent: { kind: "plan", planId: "plan-2", action: "reject", note: "" } as const,
        args: { requestId: "plan-2", confirmed: false },
      },
      {
        intent: {
          kind: "plan",
          planId: "plan-3",
          action: "revise",
          note: "Revision notes",
        } as const,
        args: { requestId: "plan-3", value: "Revision notes" },
      },
    ];

    for (const { intent, args } of cases) {
      await runtime.submitPrompt(intent);
      expect(shell.commands.at(-1)?.intent.command).toBe("session.ui.respond");
      expect(shell.commands.at(-1)?.intent.args).toEqual(args);
    }
  });
});
