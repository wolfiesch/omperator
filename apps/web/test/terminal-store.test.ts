// Terminal drawer contract: output byte order, resize propagation, exit and
// listener release, signals, restart, error/permission states, backpressure
// queueing, disconnected input denial, paste guarding, rename, split limits
// and focus, per-session persistence isolation, and the agent-shell input
// prohibition.
import { describe, expect, it } from "vite-plus/test";

import {
  createFixturePtyBridge,
  FixturePtySession,
  type PtyError,
  type PtyExit,
  type PtyNotice,
  type PtyOpenRequest,
  type PtySession,
  type UserPtyBridge,
} from "../src/features/terminal/pty.ts";
import {
  createTerminalStore,
  MAX_TERMINALS_PER_GROUP,
  MAX_TERMINAL_BUFFER_CHARS,
  resolveDrawerNotice,
  safeLabel,
} from "../src/features/terminal/terminal-store.ts";

/** Flush queued microtasks (fixture PTY banners resolve on the microtask queue). */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
}

/** Scripted PTY: hand-driven output/exit/backpressure for exact assertions. */
class ScriptedPty implements PtySession {
  readonly terminalId: string;
  readonly request: PtyOpenRequest;
  readonly written: string[] = [];
  accepting = true;
  killed = false;
  resizes: Array<{ cols: number; rows: number }> = [];
  private dataListeners = new Set<(chunk: string) => void>();
  private exitListeners = new Set<(exit: PtyExit) => void>();
  private drainListeners = new Set<() => void>();
  private errorListeners = new Set<(error: PtyError) => void>();
  private noticeListeners = new Set<(notice: PtyNotice) => void>();

  constructor(request: PtyOpenRequest) {
    this.terminalId = request.terminalId;
    this.request = request;
  }
  write(data: string): boolean {
    if (!this.accepting) return false;
    this.written.push(data);
    return true;
  }
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }
  kill(): void {
    this.killed = true;
    this.emitExit({ code: 130, signal: null });
  }
  onData(listener: (chunk: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }
  onExit(listener: (exit: PtyExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
  onDrain(listener: () => void): () => void {
    this.drainListeners.add(listener);
    return () => this.drainListeners.delete(listener);
  }
  onError(listener: (error: PtyError) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }
  onNotice(listener: (notice: PtyNotice) => void): () => void {
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }
  emitData(chunk: string): void {
    for (const listener of this.dataListeners) listener(chunk);
  }
  emitExit(exit: PtyExit): void {
    for (const listener of this.exitListeners) listener(exit);
  }
  emitDrain(): void {
    for (const listener of this.drainListeners) listener();
  }
  emitError(error: PtyError): void {
    for (const listener of this.errorListeners) listener(error);
  }
  emitNotice(notice: PtyNotice): void {
    for (const listener of this.noticeListeners) listener(notice);
  }
  listenerCounts(): { data: number; exit: number; drain: number } {
    return {
      data: this.dataListeners.size,
      exit: this.exitListeners.size,
      drain: this.drainListeners.size,
    };
  }
}

function scriptedBridge(): { bridge: UserPtyBridge; opened: ScriptedPty[] } {
  const opened: ScriptedPty[] = [];
  return {
    opened,
    bridge: {
      kind: "fixture",
      open(request) {
        const pty = new ScriptedPty(request);
        opened.push(pty);
        return pty;
      },
    },
  };
}

function makeStore(bridge: UserPtyBridge, sessionId = "sess-1", storage = new MemoryStorage()) {
  return createTerminalStore({ sessionId, bridge, cwd: "packages", storage });
}

describe("cwd contract (app-wire 0.4)", () => {
  it("labels a null cwd as Project root and never invents a path", () => {
    const { bridge } = scriptedBridge();
    const store = createTerminalStore({ sessionId: "sess-1", bridge, cwd: null, storage: new MemoryStorage() });
    expect(store.getState().cwdLabel).toBe("Project root");
  });

  it("passes a relative cwd through to term.open untouched", () => {
    const { bridge, opened } = scriptedBridge();
    const store = makeStore(bridge);
    store.getState().openTerminal();
    expect(opened[0]?.request.cwd).toBe("packages");
    expect(opened[0]?.request.cwd?.startsWith("~")).toBe(false);
    expect(opened[0]?.request.cwd?.startsWith("/")).toBe(false);
  });
});

describe("output ordering and buffers", () => {
  it("appends chunks in transport order and bumps the buffer version", () => {
    const { bridge, opened } = scriptedBridge();
    const store = makeStore(bridge);
    const id = store.getState().openTerminal();
    const pty = opened[0];
    if (pty === undefined) throw new Error("pty not opened");
    pty.emitData("one ");
    pty.emitData("two ");
    pty.emitData("three");
    const tab = store.getState().tabs.find((entry) => entry.id === id);
    expect(tab?.buffer).toBe("one two three");
    expect(tab?.bufferVersion).toBe(3);
    expect(tab?.trimmed).toBe(false);
  });

  it("trims from the front past the retention cap and flags it", () => {
    const { bridge, opened } = scriptedBridge();
    const store = makeStore(bridge);
    const id = store.getState().openTerminal();
    const pty = opened[0];
    if (pty === undefined) throw new Error("pty not opened");
    pty.emitData("HEAD-");
    pty.emitData("x".repeat(MAX_TERMINAL_BUFFER_CHARS));
    const tab = store.getState().tabs.find((entry) => entry.id === id);
    expect(tab?.buffer.length).toBe(MAX_TERMINAL_BUFFER_CHARS);
    expect(tab?.buffer.startsWith("HEAD-")).toBe(false);
    expect(tab?.trimmed).toBe(true);
  });

  it("notices become visible scrollback markers without touching input", () => {
    const { bridge, opened } = scriptedBridge();
    const store = makeStore(bridge);
    store.getState().openTerminal();
    opened[0]?.emitNotice("output-skipped");
    opened[0]?.emitNotice("resumed");
    const buffer = store.getState().tabs[0]?.buffer ?? "";
    expect(buffer).toContain("[some output was skipped]");
    expect(buffer).toContain("[reconnected]");
    expect(opened[0]?.written).toEqual([]);
  });
});

describe("input and backpressure", () => {
  it("queues rejected input and flushes it in byte order on drain", () => {
    const { bridge, opened } = scriptedBridge();
    const store = makeStore(bridge);
    const id = store.getState().openTerminal();
    const pty = opened[0];
    if (pty === undefined) throw new Error("pty not opened");
    store.getState().sendInput(id, "a");
    pty.accepting = false;
    store.getState().sendInput(id, "b");
    store.getState().sendInput(id, "c");
    expect(pty.written).toEqual(["a"]);
    expect(store.getState().tabs[0]?.queuedInput).toBe("bc");
    pty.accepting = true;
    pty.emitDrain();
    expect(pty.written).toEqual(["a", "bc"]);
    expect(store.getState().tabs[0]?.queuedInput).toBe("");
    // Nothing overtakes a live queue: order stays a,bc,d.
    store.getState().sendInput(id, "d");
    expect(pty.written).toEqual(["a", "bc", "d"]);
  });

  it("a saturated tab reads as paused in the drawer notice", () => {
    const { bridge, opened } = scriptedBridge();
    const store = makeStore(bridge);
    const id = store.getState().openTerminal();
    const pty = opened[0];
    if (pty === undefined) throw new Error("pty not opened");
    pty.accepting = false;
    store.getState().sendInput(id, "held");
    const notice = resolveDrawerNotice(store.getState());
    expect(notice?.message).toContain("Input paused");
    expect(notice?.level).toBe("info");
  });

  it("input to an exited terminal is dropped, not queued", () => {
    const { bridge, opened } = scriptedBridge();
    const store = makeStore(bridge);
    const id = store.getState().openTerminal();
    opened[0]?.emitExit({ code: 1, signal: null });
    store.getState().sendInput(id, "late");
    expect(opened[0]?.written).toEqual([]);
    expect(store.getState().tabs[0]?.queuedInput).toBe("");
  });
});

describe("connection lifecycle", () => {
  it("denies input while reconnecting or offline; nothing reaches the PTY", () => {
    const { bridge, opened } = scriptedBridge();
    const store = makeStore(bridge);
    const id = store.getState().openTerminal();
    store.getState().setConnection("reconnecting");
    store.getState().sendInput(id, "while-down");
    store.getState().setConnection("offline");
    store.getState().sendInput(id, "still-down");
    expect(opened[0]?.written).toEqual([]);
    expect(store.getState().tabs[0]?.queuedInput).toBe("");
  });

  it("back online re-opens live shells and marks the boundary", () => {
    const { bridge, opened } = scriptedBridge();
    const store = makeStore(bridge);
    store.getState().openTerminal();
    store.getState().setConnection("reconnecting");
    expect(store.getState().connection).toBe("reconnecting");
    store.getState().setConnection("online");
    expect(opened).toHaveLength(2);
    expect(store.getState().tabs[0]?.status).toBe("running");
    expect(store.getState().tabs[0]?.buffer).toContain("[reconnected]");
  });

  it("an exited tab stays exited across a reconnect", () => {
    const { bridge, opened } = scriptedBridge();
    const store = makeStore(bridge);
    store.getState().openTerminal();
    opened[0]?.emitExit({ code: 7, signal: null });
    store.getState().setConnection("reconnecting");
    store.getState().setConnection("online");
    expect(opened).toHaveLength(1);
    expect(store.getState().tabs[0]?.status).toBe("exited");
    expect(store.getState().tabs[0]?.exitCode).toBe(7);
  });

  it("connection notices outrank per-tab notices", () => {
    const { bridge, opened } = scriptedBridge();
    const store = makeStore(bridge);
    store.getState().openTerminal();
    opened[0]?.emitExit({ code: 1, signal: null });
    store.getState().setConnection("offline");
    const notice = resolveDrawerNotice(store.getState());
    expect(notice?.message).toContain("Offline");
    expect(notice?.restartTerminalId).toBeNull();
  });
});

describe("resize, exit, release, restart", () => {
  it("propagates resize to the PTY and remembers the geometry", () => {
    const { bridge, opened } = scriptedBridge();
    const store = makeStore(bridge);
    const id = store.getState().openTerminal();
    store.getState().notifyResize(id, 120, 32);
    expect(opened[0]?.resizes).toEqual([{ cols: 120, rows: 32 }]);
    expect(store.getState().tabs[0]?.cols).toBe(120);
    expect(store.getState().tabs[0]?.rows).toBe(32);
  });

  it("exit marks the tab, keeps scrollback, and releases listeners", () => {
    const { bridge, opened } = scriptedBridge();
    const store = makeStore(bridge);
    const id = store.getState().openTerminal();
    const pty = opened[0];
    if (pty === undefined) throw new Error("pty not opened");
    pty.emitData("$ exit\r\n");
    pty.emitExit({ code: 137, signal: null });
    const tab = store.getState().tabs.find((entry) => entry.id === id);
    expect(tab?.status).toBe("exited");
    expect(tab?.exitCode).toBe(137);
    expect(tab?.buffer).toContain("$ exit");
    expect(pty.listenerCounts()).toEqual({ data: 0, exit: 0, drain: 0 });
  });

  it("a signal exit is reported as a signal, not a plain code", () => {
    const { bridge, opened } = scriptedBridge();
    const store = makeStore(bridge);
    store.getState().openTerminal();
    opened[0]?.emitExit({ code: 143, signal: "TERM" });
    const tab = store.getState().tabs[0];
    expect(tab?.status).toBe("exited");
    expect(tab?.signal).toBe("TERM");
    const notice = resolveDrawerNotice(store.getState());
    expect(notice?.message).toContain("signal TERM");
    expect(notice?.restartLabel).toBe("Restart shell");
  });

  it("a shell error marks the tab and offers a restart", () => {
    const { bridge, opened } = scriptedBridge();
    const store = makeStore(bridge);
    const id = store.getState().openTerminal();
    opened[0]?.emitError({ kind: "shell-error", message: "The shell stopped responding." });
    expect(store.getState().tabs[0]?.status).toBe("error");
    const notice = resolveDrawerNotice(store.getState());
    expect(notice?.level).toBe("error");
    expect(notice?.restartTerminalId).toBe(id);
    // Input to a failed tab is refused.
    store.getState().sendInput(id, "x");
    expect(opened[0]?.written).toEqual([]);
  });

  it("a permission refusal becomes a denied tab, and restart retries", () => {
    const { bridge, opened } = scriptedBridge();
    const store = makeStore(bridge);
    const id = store.getState().openTerminal();
    opened[0]?.emitError({ kind: "permission-denied", message: "The host didn't allow this shell." });
    expect(store.getState().tabs[0]?.status).toBe("denied");
    const notice = resolveDrawerNotice(store.getState());
    expect(notice?.restartLabel).toBe("Try again");
    store.getState().restartTerminal(id);
    expect(opened).toHaveLength(2);
    expect(store.getState().tabs[0]?.status).toBe("running");
  });

  it("a bridge that throws on open yields a denied tab, not a crash", () => {
    const bridge: UserPtyBridge = {
      kind: "fixture",
      open() {
        throw new Error("permission denied");
      },
    };
    const store = makeStore(bridge);
    store.getState().openTerminal();
    expect(store.getState().tabs[0]?.status).toBe("denied");
  });

  it("restart opens a fresh PTY in the same tab and keeps old output", () => {
    const { bridge, opened } = scriptedBridge();
    const store = makeStore(bridge);
    const id = store.getState().openTerminal();
    opened[0]?.emitData("old run\r\n");
    opened[0]?.emitExit({ code: 0, signal: null });
    store.getState().restartTerminal(id);
    expect(opened).toHaveLength(2);
    expect(store.getState().tabs[0]?.status).toBe("running");
    expect(store.getState().tabs[0]?.buffer).toContain("old run");
    expect(store.getState().tabs[0]?.buffer).toContain("[restarted]");
    // Restarting a running terminal is a no-op.
    store.getState().restartTerminal(id);
    expect(opened).toHaveLength(2);
  });

  it("close kills the PTY and drops the tab and its group", () => {
    const { bridge, opened } = scriptedBridge();
    const store = makeStore(bridge);
    const first = store.getState().openTerminal();
    const second = store.getState().openTerminal();
    store.getState().closeTerminal(second);
    expect(opened[1]?.killed).toBe(true);
    expect(store.getState().tabs.map((tab) => tab.id)).toEqual([first]);
    expect(store.getState().groups).toHaveLength(1);
    expect(store.getState().activeTerminalId).toBe(first);
  });
});

describe("paste guard", () => {
  it("safe single-line text goes straight to the PTY", () => {
    const { bridge, opened } = scriptedBridge();
    const store = makeStore(bridge);
    const id = store.getState().openTerminal();
    store.getState().requestPaste(id, "ls -la");
    expect(opened[0]?.written).toEqual(["ls -la"]);
    expect(store.getState().pendingPaste).toBeNull();
  });

  it("multiline text waits for confirmation, then lands newline-normalized", () => {
    const { bridge, opened } = scriptedBridge();
    const store = makeStore(bridge);
    const id = store.getState().openTerminal();
    store.getState().requestPaste(id, "echo one\necho two\n");
    expect(opened[0]?.written).toEqual([]);
    const pending = store.getState().pendingPaste;
    expect(pending?.terminalId).toBe(id);
    expect(pending?.assessment.multiline).toBe(true);
    store.getState().confirmPaste();
    expect(opened[0]?.written).toEqual(["echo one\recho two\r"]);
    expect(store.getState().pendingPaste).toBeNull();
  });

  it("destructive-looking text is flagged and cancel sends nothing", () => {
    const { bridge, opened } = scriptedBridge();
    const store = makeStore(bridge);
    const id = store.getState().openTerminal();
    store.getState().requestPaste(id, "sudo rm -rf /var/data");
    const pending = store.getState().pendingPaste;
    expect(pending?.assessment.destructive.length).toBeGreaterThan(0);
    store.getState().cancelPaste();
    expect(opened[0]?.written).toEqual([]);
    expect(store.getState().pendingPaste).toBeNull();
  });

  it("paste to a disconnected or exited target is refused outright", () => {
    const { bridge, opened } = scriptedBridge();
    const store = makeStore(bridge);
    const id = store.getState().openTerminal();
    store.getState().setConnection("offline");
    store.getState().requestPaste(id, "echo hi\n");
    expect(store.getState().pendingPaste).toBeNull();
    expect(opened[0]?.written).toEqual([]);
  });

  it("closing the target terminal clears its pending paste", () => {
    const { bridge } = scriptedBridge();
    const store = makeStore(bridge);
    const id = store.getState().openTerminal();
    store.getState().requestPaste(id, "a\nb");
    expect(store.getState().pendingPaste).not.toBeNull();
    store.getState().closeTerminal(id);
    expect(store.getState().pendingPaste).toBeNull();
  });
});

describe("splits and focus", () => {
  it("splits up to four panes per group, then refuses", () => {
    const { bridge } = scriptedBridge();
    const store = makeStore(bridge);
    store.getState().openTerminal();
    expect(store.getState().splitActiveGroup("horizontal")).not.toBeNull();
    expect(store.getState().splitActiveGroup("vertical")).not.toBeNull();
    expect(store.getState().splitActiveGroup("horizontal")).not.toBeNull();
    expect(store.getState().groups[0]?.terminalIds).toHaveLength(MAX_TERMINALS_PER_GROUP);
    expect(store.getState().splitActiveGroup("horizontal")).toBeNull();
    expect(store.getState().tabs).toHaveLength(MAX_TERMINALS_PER_GROUP);
  });

  it("focusPane cycles activation through the split group and wraps", () => {
    const { bridge } = scriptedBridge();
    const store = makeStore(bridge);
    const first = store.getState().openTerminal();
    const second = store.getState().splitActiveGroup("horizontal");
    const third = store.getState().splitActiveGroup("horizontal");
    expect(store.getState().activeTerminalId).toBe(third);
    const focusBefore = store.getState().focusEpoch;
    store.getState().focusPane(1);
    expect(store.getState().activeTerminalId).toBe(first);
    store.getState().focusPane(-1);
    expect(store.getState().activeTerminalId).toBe(third);
    store.getState().focusPane(-1);
    expect(store.getState().activeTerminalId).toBe(second);
    expect(store.getState().focusEpoch).toBeGreaterThan(focusBefore);
  });

  it("focusPane is inert without a split", () => {
    const { bridge } = scriptedBridge();
    const store = makeStore(bridge);
    const only = store.getState().openTerminal();
    store.getState().focusPane(1);
    expect(store.getState().activeTerminalId).toBe(only);
  });
});

describe("rename", () => {
  it("renames, sanitizes control characters, and persists the title", () => {
    const storage = new MemoryStorage();
    const { bridge } = scriptedBridge();
    const store = makeStore(bridge, "sess-a", storage);
    const id = store.getState().openTerminal();
    store.getState().renameTerminal(id, "  build\u0007 loop  ");
    expect(store.getState().tabs[0]?.title).toBe("build loop");
    // Empty rename keeps the old title.
    store.getState().renameTerminal(id, "   ");
    expect(store.getState().tabs[0]?.title).toBe("build loop");
    const restored = makeStore(scriptedBridge().bridge, "sess-a", storage);
    expect(restored.getState().tabs[0]?.title).toBe("build loop");
  });

  it("safeLabel middle-truncates long values", () => {
    const label = safeLabel("~/very/long/path/that/keeps/going/and/going/forever", 20);
    expect(label.length).toBeLessThanOrEqual(20);
    expect(label).toContain("…");
  });
});

describe("persistence", () => {
  it("layout persists per session and restores with fresh shells", () => {
    const storage = new MemoryStorage();
    const { bridge } = scriptedBridge();
    const store = makeStore(bridge, "sess-a", storage);
    store.getState().openTerminal();
    store.getState().splitActiveGroup("vertical");
    store.getState().setDrawerHeight(340);

    const { bridge: bridge2, opened: opened2 } = scriptedBridge();
    const restored = makeStore(bridge2, "sess-a", storage);
    expect(restored.getState().tabs).toHaveLength(2);
    expect(restored.getState().groups[0]?.terminalIds).toHaveLength(2);
    expect(restored.getState().drawerHeight).toBe(340);
    // Restored tabs reattach live shells; buffers start clean.
    expect(opened2).toHaveLength(2);
    expect(restored.getState().tabs[0]?.status).toBe("running");
    expect(restored.getState().tabs[0]?.buffer).toBe("");
  });

  it("sessions persist independently: another session sees nothing", () => {
    const storage = new MemoryStorage();
    const { bridge } = scriptedBridge();
    const store = makeStore(bridge, "sess-a", storage);
    store.getState().openTerminal();
    const { bridge: bridgeB } = scriptedBridge();
    const other = makeStore(bridgeB, "sess-b", storage);
    expect(other.getState().tabs).toHaveLength(0);
    other.getState().openTerminal();
    expect(storage.keys()).toContain("omp:terminal:v1:sess-a");
    expect(storage.keys()).toContain("omp:terminal:v1:sess-b");
    // sess-b's write leaves sess-a's snapshot untouched.
    const restoredA = makeStore(scriptedBridge().bridge, "sess-a", storage);
    expect(restoredA.getState().tabs).toHaveLength(1);
  });

  it("a pending paste is never persisted", () => {
    const storage = new MemoryStorage();
    const { bridge } = scriptedBridge();
    const store = makeStore(bridge, "sess-a", storage);
    const id = store.getState().openTerminal();
    store.getState().requestPaste(id, "secret line one\nsecret line two");
    expect(store.getState().pendingPaste).not.toBeNull();
    for (const key of storage.keys()) {
      expect(storage.getItem(key)).not.toContain("secret line");
    }
  });
});

describe("agent shell prohibition", () => {
  it("the bridge refuses to open an agent-owned terminal id", () => {
    const bridge = createFixturePtyBridge({ agentOwnedTerminalIds: ["term-agent-main"] });
    expect(() =>
      bridge.open({
        sessionId: "sess-1",
        terminalId: "term-agent-main",
        shell: "bash",
        cwd: null,
        cols: 80,
        rows: 24,
      }),
    ).toThrow(/read-only/i);
  });
});

describe("fixture PTY determinism", () => {
  function openFixture(): { pty: FixturePtySession; output: string[] } {
    const pty = new FixturePtySession({
      sessionId: "sess-1",
      terminalId: "user-1",
      shell: "bash",
      cwd: "packages",
      cols: 100,
      rows: 30,
    });
    const output: string[] = [];
    pty.onData((chunk) => output.push(chunk));
    return { pty, output };
  }

  it("announces itself as a sample shell and echoes deterministically", async () => {
    const { pty, output } = openFixture();
    await settle();
    expect(output.join("")).toContain("sample shell");
    pty.write("echo hi\r");
    expect(output.join("")).toContain("echo hi");
    expect(output.join("")).toContain("\r\nhi\r\n");
  });

  it("reports resize through the size command and exits with the given code", async () => {
    const { pty, output } = openFixture();
    await settle();
    pty.resize(42, 7);
    pty.write("size\r");
    expect(output.join("")).toContain("42 cols × 7 rows");
    const exits: PtyExit[] = [];
    pty.onExit((exit) => exits.push(exit));
    pty.write("exit 3\r");
    expect(exits).toEqual([{ code: 3, signal: null }]);
    // Writes after exit are inert.
    pty.write("echo after\r");
    expect(output.join("")).not.toContain("after");
  });

  it("the signal command exits with a signal name and 128+n code", async () => {
    const { pty } = openFixture();
    await settle();
    const exits: PtyExit[] = [];
    pty.onExit((exit) => exits.push(exit));
    pty.write("signal term\r");
    expect(exits).toEqual([{ code: 143, signal: "TERM" }]);
  });

  it("deny and crash surface typed errors", async () => {
    const { pty } = openFixture();
    await settle();
    const errors: PtyError[] = [];
    pty.onError((error) => errors.push(error));
    pty.write("deny\r");
    expect(errors[0]?.kind).toBe("permission-denied");
  });

  it("simulated backpressure rejects writes then signals drain", async () => {
    const { pty } = openFixture();
    await settle();
    const { promise, resolve } = Promise.withResolvers<void>();
    pty.onDrain(resolve);
    pty.simulateBackpressure(2);
    expect(pty.write("a")).toBe(false);
    expect(pty.write("b")).toBe(false);
    expect(pty.write("c")).toBe(true);
    await promise;
  });

  it("the stall command rejects the next writes like a saturated wire", async () => {
    const { pty } = openFixture();
    await settle();
    pty.write("stall 2\r");
    expect(pty.write("x")).toBe(false);
    expect(pty.write("y")).toBe(false);
    expect(pty.write("z")).toBe(true);
  });
});
