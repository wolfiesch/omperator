import { describe, expect, it, vi } from "vite-plus/test";
import {
  createLiveSession,
  type LiveCreateController,
} from "../src/features/session-runtime/live-create.ts";
import type { RendererServerEventEnvelope } from "@t4-code/protocol/desktop-ipc";
import {
  requiresProfileChoiceForCreate,
  resolveLiveProject,
  resolveLiveProjectCreateTargets,
} from "../src/platform/live-workspace.ts";

const address = { targetId: "target-1", hostId: "host-1", projectId: "project-1" } as const;
function controller() {
  const events: Array<(event: RendererServerEventEnvelope) => void> = [];
  const snapshot: {
    connections: Map<string, string>;
    targetHosts: Map<string, string>;
    projection: {
      sessionIndex: Map<
        string,
        { hostId: string; sessionId: string; project: { projectId: string } }
      >;
      sessionIndexMetadata: Map<string, { truncated: boolean; totalCount: number }>;
    };
  } = {
    connections: new Map([[address.targetId, "connected"]]),
    targetHosts: new Map([[address.targetId, address.hostId]]),
    projection: {
      sessionIndex: new Map(),
      sessionIndexMetadata: new Map([[address.hostId, { truncated: false, totalCount: 0 }]]),
    },
  };
  const commands: Array<{ command: string; requestId: string; args: Record<string, unknown> }> = [];
  let unsubscribed = 0;
  let next = 1;
  const fake: LiveCreateController = {
    getSnapshot: () => snapshot,
    subscribeEvents: (_filter, listener) => {
      events.push(listener);
      return () => {
        unsubscribed++;
      };
    },
    command: async (_target, request) => {
      const requestId = `req-${next++}`;
      commands.push({ command: request.command, requestId, args: request.args });
      return { accepted: true, requestId };
    },
  };
  return {
    fake,
    snapshot,
    commands,
    emit(frame: unknown) {
      for (const listener of events) {
        listener({
          targetId: address.targetId,
          event: { kind: "response", payload: frame as Record<string, unknown> } as never,
        });
      }
    },
    get unsubscribed() {
      return unsubscribed;
    },
  };
}
function sessionFrame(
  requestId: string,
  sessionId = "session-1",
  command = "session.create",
  extra: Record<string, unknown> = {},
) {
  return {
    requestId,
    command,
    ok: true,
    result: {
      session: {
        hostId: address.hostId,
        sessionId,
        project: { projectId: address.projectId },
        ...extra,
      },
    },
  };
}

describe("resolveLiveProject", () => {
  const snapshot = {
    connections: new Map([["target-1", "connected"]]),
    targetHosts: new Map([["target-1", "host-1"]]),
  } as never;
  it.each([
    ["%", null],
    ["host-1/project-1/extra", null],
    ["/project-1", null],
    ["host-1/", null],
    ["host-2/project-1", null],
    ["host-1/project-1", { targetId: "target-1", hostId: "host-1", projectId: "project-1" }],
  ])("resolves %s", (id, expected) => expect(resolveLiveProject(snapshot, id)).toEqual(expected));
  it("rejects empty decoded ids", () =>
    expect(resolveLiveProject(snapshot, "host-1/")).toEqual(null));
  it("prefers a connected duplicate over the first disconnected binding", () => {
    const duplicate = {
      connections: new Map([
        ["disconnected", "disconnected"],
        ["connected", "connected"],
      ]),
      targetHosts: new Map([
        ["disconnected", "host-1"],
        ["connected", "host-1"],
      ]),
    } as never;
    expect(resolveLiveProject(duplicate, "host-1/project-1")).toEqual({
      targetId: "connected",
      hostId: "host-1",
      projectId: "project-1",
    });
  });
  it("skips the first binding when its target was removed", () => {
    const removedFirst = {
      connections: new Map([["current", "connected"]]),
      targetHosts: new Map([
        ["removed", "host-1"],
        ["current", "host-1"],
      ]),
    } as never;
    expect(resolveLiveProject(removedFirst, "host-1/project-1")).toEqual({
      targetId: "current",
      hostId: "host-1",
      projectId: "project-1",
    });
  });
});

describe("resolveLiveProjectCreateTargets", () => {
  it("offers every connected local profile with the current profile first", () => {
    const snapshot = {
      connections: new Map([
        ["local", "connected"],
        ["local:fable-swarm", "connected"],
        ["local:offline", "disconnected"],
        ["tailnet", "connected"],
      ]),
      targetHosts: new Map([
        ["local", "host-default"],
        ["local:fable-swarm", "host-fable"],
        ["local:offline", "host-offline"],
        ["tailnet", "host-remote"],
      ]),
      targets: new Map([
        ["local", { targetId: "local", kind: "local", label: "Default" }],
        [
          "local:fable-swarm",
          { targetId: "local:fable-swarm", kind: "local", label: "Fable Swarm" },
        ],
        ["local:offline", { targetId: "local:offline", kind: "local", label: "Offline" }],
        ["tailnet", { targetId: "tailnet", kind: "remote", label: "Tailnet" }],
      ]),
    } as never;

    expect(resolveLiveProjectCreateTargets(snapshot, "host-default/project-1")).toEqual([
      {
        address: { targetId: "local", hostId: "host-default", projectId: "project-1" },
        label: "Default",
        profileId: "default",
        current: true,
      },
      {
        address: {
          targetId: "local:fable-swarm",
          hostId: "host-fable",
          projectId: "project-1",
        },
        label: "Fable Swarm",
        profileId: "fable-swarm",
        current: false,
      },
    ]);
  });

  it("keeps a remote project pinned to its original target", () => {
    const snapshot = {
      connections: new Map([
        ["local", "connected"],
        ["tailnet", "connected"],
      ]),
      targetHosts: new Map([
        ["local", "host-local"],
        ["tailnet", "host-remote"],
      ]),
      targets: new Map([
        ["local", { targetId: "local", kind: "local", label: "Default" }],
        ["tailnet", { targetId: "tailnet", kind: "remote", label: "Tailnet" }],
      ]),
    } as never;

    expect(resolveLiveProjectCreateTargets(snapshot, "host-remote/project-1")).toEqual([
      {
        address: { targetId: "tailnet", hostId: "host-remote", projectId: "project-1" },
        label: "Tailnet",
        current: true,
      },
    ]);
  });

  it("requires an explicit choice when only an alternate profile is reachable", () => {
    expect(
      requiresProfileChoiceForCreate([
        {
          address: {
            targetId: "local:fable-swarm",
            hostId: "host-fable",
            projectId: "project-1",
          },
          label: "Fable Swarm",
          profileId: "fable-swarm",
          current: false,
        },
      ]),
    ).toBe(true);
    expect(
      requiresProfileChoiceForCreate([
        {
          address: { targetId: "local", hostId: "host-default", projectId: "project-1" },
          label: "Default",
          profileId: "default",
          current: true,
        },
      ]),
    ).toBe(false);
  });
});

describe("createLiveSession", () => {
  it("correlates synchronous response, bounds unrelated frames, then waits for list projection", async () => {
    const c = controller();
    const result = createLiveSession(c.fake, address, undefined, 1000);
    for (let i = 0; i < 80; i++) c.emit({ requestId: `noise-${i}`, command: "noise", ok: true });
    c.emit(sessionFrame("req-1"));
    await vi.waitFor(() => expect(c.commands).toHaveLength(2));
    c.snapshot.projection.sessionIndex.set("session-1", {
      hostId: address.hostId,
      sessionId: "session-1",
      project: { projectId: address.projectId },
    });
    c.emit({ requestId: "req-2", command: "session.list", ok: true });
    await expect(result).resolves.toEqual({ viewId: "host-1/session-1" });
    expect(c.commands.map((x) => x.command)).toEqual(["session.create", "session.list"]);
    expect(c.unsubscribed).toBe(1);
  });
  it("rejects malformed, rejected, mismatched, and unbound workflows and always cleans up", async () => {
    const cases = [
      async () => {
        const c = controller();
        const p = createLiveSession(c.fake, address, undefined, 50);
        c.emit({ requestId: "req-1", command: "session.create", ok: false });
        await expect(p).rejects.toThrow("Host rejected session.create");
        expect(c.unsubscribed).toBe(1);
      },
      async () => {
        const c = controller();
        const p = createLiveSession(c.fake, address, undefined, 50);
        c.emit(sessionFrame("req-1", "session-1", "wrong"));
        await expect(p).rejects.toThrow("response command");
        expect(c.unsubscribed).toBe(1);
      },
      async () => {
        const c = controller();
        const p = createLiveSession(c.fake, address, undefined, 50);
        c.emit(sessionFrame("req-1", "session-1", "session.create", { hostId: "other" }));
        await expect(p).rejects.toThrow("mismatched");
        expect(c.unsubscribed).toBe(1);
      },
      async () => {
        const c = controller();
        c.snapshot.targetHosts.set(address.targetId, "other");
        await expect(createLiveSession(c.fake, address)).rejects.toThrow("binding");
        expect(c.unsubscribed).toBe(0);
      },
    ];
    for (const run of cases) await run();
  });
  it("times out unresolved commands and does not return before list updates projection", async () => {
    const c = controller();
    const pending = createLiveSession(c.fake, address, undefined, 5);
    await expect(pending).rejects.toThrow("Timed out");
    expect(c.unsubscribed).toBe(1);
  });
});
