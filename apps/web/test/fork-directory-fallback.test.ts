import { describe, expect, it } from "vite-plus/test";
import { DesktopRuntimeError } from "@t4-code/client";
import type { DesktopRuntimeController } from "@t4-code/client";
import type { LiveSessionAddress } from "../src/platform/live-workspace.ts";
import {
  forkLiveSessionWithDirectoryFallback,
  targetIsLocal,
} from "../src/features/session-runtime/session-management.ts";

const address: LiveSessionAddress = { targetId: "local", hostId: "host-a", sessionId: "session-a" };

/**
 * `forkLiveSession` resolves through the controller and then waits for the copy
 * to appear in a refreshed inventory. Only the fork call matters here, so the
 * refresh is satisfied immediately by a snapshot already naming the copy.
 */
function controllerStub(
  forks: (cwd: string | undefined) => Promise<{ hostId: string; sessionId: string }>,
  calls: (string | undefined)[],
): DesktopRuntimeController {
  return {
    forkSession: async (_target: string, _host: string, _session: string, cwd?: string) => {
      calls.push(cwd);
      return (await forks(cwd)) as never;
    },
    // session.list refresh: the copy is already in the snapshot below, so the
    // convergence wait finishes on its first synchronous inspection.
    command: async () => ({ accepted: true, result: {} }),
    // The copy is already present, so the convergence wait finishes on its
    // first synchronous inspection and no timer is involved.
    getSnapshot: () => snapshotWithCopy,
    subscribe: () => () => undefined,
  } as unknown as DesktopRuntimeController;
}

const copy = { hostId: "host-a", sessionId: "copy-a" };
const snapshotWithCopy = {
  projection: {
    sessionIndex: new Map([[`host-a\u0000copy-a`, { hostId: "host-a", sessionId: "copy-a" }]]),
  },
} as never;

describe("fork directory fallback", () => {
  it("does not ask for a directory when the fork succeeds", async () => {
    const calls: (string | undefined)[] = [];
    let asked = 0;
    const controller = controllerStub(async () => copy, calls);
    await forkLiveSessionWithDirectoryFallback(controller, address, async () => {
      asked += 1;
      return "/tmp/unused";
    });
    expect(calls).toEqual([undefined]);
    expect(asked).toBe(0);
  });

  it("retries exactly once with the chosen directory", async () => {
    const calls: (string | undefined)[] = [];
    const controller = controllerStub(async (cwd) => {
      if (cwd === undefined) throw new DesktopRuntimeError("command", "gone", "session_cwd_missing");
      return copy;
    }, calls);
    const result = await forkLiveSessionWithDirectoryFallback(controller, address, async () => "/tmp/chosen");
    expect(calls).toEqual([undefined, "/tmp/chosen"]);
    expect(result).not.toBe("cancelled");
  });

  it("does not retry when the chooser is dismissed", async () => {
    const calls: (string | undefined)[] = [];
    const controller = controllerStub(async () => {
      throw new DesktopRuntimeError("command", "gone", "session_cwd_missing");
    }, calls);
    const result = await forkLiveSessionWithDirectoryFallback(controller, address, async () => undefined);
    expect(result).toBe("cancelled");
    expect(calls).toEqual([undefined]);
  });

  it("does not offer a directory for an unrelated failure", async () => {
    const calls: (string | undefined)[] = [];
    let asked = 0;
    const controller = controllerStub(async () => {
      throw new DesktopRuntimeError("command", "no model", "session_start_failed");
    }, calls);
    await expect(
      forkLiveSessionWithDirectoryFallback(controller, address, async () => {
        asked += 1;
        return "/tmp/chosen";
      }),
    ).rejects.toThrow("no model");
    expect(asked).toBe(0);
    expect(calls).toEqual([undefined]);
  });

  it("refuses rather than guessing a directory for a remote target", async () => {
    const calls: (string | undefined)[] = [];
    const controller = controllerStub(async () => {
      throw new DesktopRuntimeError("command", "gone", "session_cwd_missing");
    }, calls);
    // A path chosen on this machine says nothing about a remote filesystem.
    await expect(
      forkLiveSessionWithDirectoryFallback(controller, address, undefined),
    ).rejects.toThrow("gone");
    expect(calls).toEqual([undefined]);
  });

  it("offers the chooser only for local targets", () => {
    expect(targetIsLocal("local")).toBe(true);
    expect(targetIsLocal("local:secondary")).toBe(true);
    expect(targetIsLocal("remote-laptop")).toBe(false);
  });
});
