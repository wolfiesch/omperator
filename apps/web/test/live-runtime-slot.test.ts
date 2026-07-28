import { describe, expect, it } from "vite-plus/test";
import {
  applyPublicFrame,
  createProjectionSnapshot,
  decodeProjectionCache,
  encodeProjectionCache,
} from "@t4-code/client";

import { createLiveSessionRuntime } from "../src/features/session-runtime/live-runtime.ts";
import { buildProjectGroups } from "../src/lib/session-tree.ts";
import { deriveWorkspaceData, sessionViewId } from "../src/platform/live-workspace.ts";
import {
  acquireRuntimeController,
  startRuntimeController,
  type RuntimeSlotHolder,
} from "../src/platform/desktop-runtime.ts";
import { deferred, FakeShell, makeWelcome } from "./fake-shell.ts";
import {
  durableEntryFrame,
  entry,
  HOST,
  pendingPromptsSessionsFrame,
  SESSION,
  settle,
  snapshotFrame,
} from "./live-composer-fixtures.ts";

describe("window runtime slot", () => {
  it("StrictMode/HMR double-invocation reuses one controller and starts once", async () => {
    const shell = new FakeShell();
    const holder: RuntimeSlotHolder = {};

    const first = acquireRuntimeController(shell, holder);
    const again = acquireRuntimeController(shell, holder);
    expect(again).toBe(first);

    startRuntimeController(shell, holder);
    startRuntimeController(shell, holder);
    await first.start();
    expect(shell.bootstrapCalls).toBe(1);
    expect(shell.connectCalls).toBe(1);
    await first.stop();
  });

  it("hydrates the renderer projection from shell cache and persists later mutations", async () => {
    let warm = applyPublicFrame(
      createProjectionSnapshot(),
      snapshotFrame(1, [entry("cached", "from shell cache")]),
    );
    warm = applyPublicFrame(warm, pendingPromptsSessionsFrame([], 1, "idle"));
    const cachedValue = encodeProjectionCache(warm);
    const saves: string[] = [];
    let loads = 0;
    const cacheLoad = deferred<{ available: boolean; value: string | null }>();
    type CacheShell = FakeShell & {
      loadProjectionCache: () => Promise<{ available: boolean; value: string | null }>;
      saveProjectionCache: (request: { value: string }) => Promise<{ saved: boolean }>;
    };
    const shell = new FakeShell() as CacheShell;
    shell.loadProjectionCache = () => {
      loads += 1;
      return cacheLoad.promise;
    };
    shell.saveProjectionCache = async ({ value }) => {
      saves.push(value);
      return { saved: true };
    };
    const holder: RuntimeSlotHolder = {};
    const controller = acquireRuntimeController(shell, holder);
    const starting = controller.start();
    await settle();
    expect(loads).toBe(1);
    expect(shell.bootstrapCalls).toBe(0);
    cacheLoad.resolve({ available: true, value: cachedValue });
    await starting;

    const cachedSession = controller
      .getSnapshot()
      .projection.sessions.get(`${HOST}\u0000${SESSION}`);
    expect(cachedSession?.entries.map((item) => item.data)).toContainEqual({
      role: "assistant",
      text: "from shell cache",
    });
    const cachedGroups = buildProjectGroups(
      deriveWorkspaceData(controller.getSnapshot()),
      {},
      {},
    );
    expect(cachedGroups).toHaveLength(1);
    expect(cachedGroups[0]?.sessions.map((row) => row.session.id)).toContain(
      sessionViewId(HOST, SESSION),
    );
    expect(cachedGroups[0]?.host).toMatchObject({
      id: HOST,
      name: HOST,
      kind: "remote",
    });
    expect(cachedGroups[0]?.sessions[0]?.session.freshness).toBe("offline");

    const cachedRuntime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    expect(cachedRuntime.getSnapshot()).toMatchObject({
      link: "cached",
      canPrompt: false,
      canCancel: false,
    });
    expect(shell.commandCount("session.attach")).toBe(0);

    expect(shell.connectCalls).toBe(1);
    shell.emitFrame({
      targetId: "local",
      frame: makeWelcome(HOST, ["sessions.prompt"]),
    });
    shell.emitFrame({
      targetId: "local",
      frame: durableEntryFrame(2, entry("live", "persist this mutation")),
    });
    await settle();
    expect(shell.commandCount("session.attach")).toBe(1);
    cachedRuntime.dispose();
    expect(saves.length).toBeGreaterThan(0);
    const persisted = decodeProjectionCache(saves.at(-1)!);
    expect(
      persisted.sessions
        .get(`${HOST}\u0000${SESSION}`)
        ?.entries.map((item) => item.data),
    ).toContainEqual({
      role: "assistant",
      text: "persist this mutation",
    });
    await controller.stop();
  });

  it("skips projection cache saves when the shell reports caching unavailable", async () => {
    let loads = 0;
    let saves = 0;
    type CacheShell = FakeShell & {
      loadProjectionCache: () => Promise<{ available: boolean; value: string | null }>;
      saveProjectionCache: (request: { value: string }) => Promise<{ saved: boolean }>;
    };
    const shell = new FakeShell() as CacheShell;
    shell.loadProjectionCache = async () => {
      loads += 1;
      return { available: false, value: null };
    };
    shell.saveProjectionCache = async () => {
      saves += 1;
      return { saved: false };
    };
    const holder: RuntimeSlotHolder = {};
    const controller = acquireRuntimeController(shell, holder);

    await controller.start();
    shell.emitFrame({
      targetId: "local",
      frame: makeWelcome(HOST, ["sessions.prompt"]),
    });
    shell.emitFrame({
      targetId: "local",
      frame: durableEntryFrame(2, entry("live", "do not persist")),
    });
    await settle();
    await controller.stop();

    expect(loads).toBe(1);
    expect(saves).toBe(0);
  });

  it("retains one live controller across a persisted pagehide/pageshow", async () => {
    class FakePageLifecycleTarget {
      private readonly listeners = new Map<string, Set<EventListener>>();

      addEventListener(type: "pagehide" | "pageshow", listener: EventListener): void {
        const listeners = this.listeners.get(type) ?? new Set<EventListener>();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: "pagehide" | "pageshow", listener: EventListener): void {
        this.listeners.get(type)?.delete(listener);
      }

      dispatch(type: "pagehide" | "pageshow", persisted: boolean): void {
        const event = { type, persisted } as unknown as Event;
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    const shell = new FakeShell();
    const holder: RuntimeSlotHolder = {};
    const pageTarget = new FakePageLifecycleTarget();
    const first = acquireRuntimeController(shell, holder);
    startRuntimeController(shell, holder, pageTarget);
    await first.start();

    pageTarget.dispatch("pagehide", true);
    pageTarget.dispatch("pageshow", true);
    expect(acquireRuntimeController(shell, holder)).toBe(first);
    expect(first.getSnapshot().startState).toBe("started");

    pageTarget.dispatch("pagehide", false);
    expect(acquireRuntimeController(shell, holder)).not.toBe(first);
  });
});
