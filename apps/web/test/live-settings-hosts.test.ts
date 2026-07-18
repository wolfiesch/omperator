// Explicit host selection + account-broker status for the live settings
// screen: the user's host choice is explicit and sticky, every target+host
// keeps its own drafts across A→B→A switching, a vanished or disconnected
// selection reports honest waiting state instead of silently opening another
// host, and `broker.status` is queried only where it is advertised AND
// granted — strict decode, safe endpoints only, late replies after a host
// switch dropped, older hosts honestly "unsupported" instead of "local".
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import type { CatalogFrame, SettingsFrame } from "@t4-code/protocol";
import {
  rendererServerEventFromFrame,
  type CommandRequest,
  type CommandResult,
  type ConfirmRequest,
  type ConfirmResult,
  type RendererServerEventEnvelope,
  type RendererServerFrame,
} from "@t4-code/protocol/desktop-ipc";

import {
  brokerStatusCopy,
  brokerStatusSupported,
  decodeBrokerStatus,
  type BrokerStatus,
} from "../src/features/settings/broker-status.ts";
import type { LiveSettingsRuntimePort } from "../src/features/settings/live-controller.ts";
import {
  connectedHostChoices,
  createLiveSettingsScreenModel,
} from "../src/features/settings/live-screen-model.ts";

const SRC_ROOT = join(import.meta.dirname, "../src");

// Every async hop in these tests is a microtask: the fake runtime emits
// response frames synchronously inside command(), so a bounded microtask
// flush settles the broker model deterministically — no wall-clock waits.
const tick = async () => {
  for (let hop = 0; hop < 25; hop += 1) await Promise.resolve();
};

// ─── Frame builders ─────────────────────────────────────────────────────────

function settingItem(path: string): Record<string, unknown> {
  return {
    id: `setting:${path}`,
    kind: "setting",
    name: path,
    metadata: {
      path,
      label: path,
      controlType: "boolean",
      default: false,
      effectiveSource: "default",
      configured: false,
      sensitive: false,
      tab: "appearance",
    },
  };
}

const BROKER_ITEM = { id: "command:broker.status", kind: "command", name: "broker.status" };

// Test seam: fixture frames are hand-built rather than wire-decoded.
function catalogFrame(
  hostId: string,
  items: readonly Record<string, unknown>[],
  revision = "rev-1",
): CatalogFrame {
  return { v: "omp-app/1", type: "catalog", hostId, revision, items } as unknown as CatalogFrame;
}

function settingsFrame(hostId: string, revision = "rev-1"): SettingsFrame {
  return { v: "omp-app/1", type: "settings", hostId, revision, settings: {} } as unknown as SettingsFrame;
}

// ─── Fake runtime ───────────────────────────────────────────────────────────

type BrokerMode =
  | { readonly kind: "result"; readonly result: unknown }
  | { readonly kind: "fail" }
  | { readonly kind: "reject-unknown" }
  | { readonly kind: "hold" };

interface MutableSnapshot {
  targets: Map<string, { targetId: string; label: string; state: string }>;
  connections: Map<string, string>;
  targetHosts: Map<string, string>;
  hosts: Map<string, { grantedCapabilities: readonly string[] }>;
  catalogs: Map<string, CatalogFrame>;
  settings: Map<string, SettingsFrame>;
  runtimeErrors: { targetId?: string; code: string; message: string }[];
}

class FakeRuntime implements LiveSettingsRuntimePort {
  readonly commands: { targetId: string; command: string }[] = [];
  readonly snapshot: MutableSnapshot = {
    targets: new Map(),
    connections: new Map(),
    targetHosts: new Map(),
    hosts: new Map(),
    catalogs: new Map(),
    settings: new Map(),
    runtimeErrors: [],
  };
  readonly brokerModes = new Map<string, BrokerMode>();
  readonly heldBroker: { requestId: string; hostId: string; targetId: string }[] = [];
  private listeners = new Set<(snapshot: never) => void>();
  private eventListeners = new Set<(event: RendererServerEventEnvelope) => void>();
  private requestSeq = 0;

  connect(targetId: string, hostId: string, label: string, options: { broker?: boolean; capability?: boolean } = {}): void {
    this.snapshot.targets.set(targetId, { targetId, label, state: "connected" });
    this.snapshot.connections.set(targetId, "connected");
    this.snapshot.targetHosts.set(targetId, hostId);
    this.snapshot.hosts.set(hostId, {
      grantedCapabilities: options.capability === false ? ["config.write"] : ["config.write", "broker.read"],
    });
    const items = [settingItem("appearance.compact"), ...(options.broker === false ? [] : [BROKER_ITEM])];
    this.snapshot.catalogs.set(hostId, catalogFrame(hostId, items));
    this.snapshot.settings.set(hostId, settingsFrame(hostId));
  }
  disconnect(targetId: string): void {
    this.snapshot.connections.set(targetId, "disconnected");
    const target = this.snapshot.targets.get(targetId);
    if (target !== undefined) target.state = "disconnected";
  }
  notify(): void {
    for (const listener of this.listeners) listener(this.getSnapshot());
  }
  // Test seam: only the fields the model reads exist on this snapshot.
  getSnapshot(): never {
    return this.snapshot as unknown as never;
  }
  subscribe(listener: (snapshot: never) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  subscribeEvents(
    _filter: { readonly targetId: string },
    listener: (event: RendererServerEventEnvelope) => void,
  ): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  private emitResponse(targetId: string, hostId: string, requestId: string, body: Record<string, unknown>): void {
    const frame = {
      v: "omp-app/1",
      type: "response",
      requestId,
      hostId,
      command: "broker.status",
      ...body,
    };
    for (const listener of this.eventListeners) {
      listener({
        targetId,
        event: rendererServerEventFromFrame(frame as unknown as RendererServerFrame),
      });
    }
  }
  releaseHeldBroker(result: unknown): void {
    const held = this.heldBroker.shift();
    if (held === undefined) throw new Error("no held broker.status request");
    this.emitResponse(held.targetId, held.hostId, held.requestId, { ok: true, result });
  }
  async command(targetId: string, intent: CommandRequest["intent"]): Promise<CommandResult> {
    this.commands.push({ targetId, command: intent.command });
    this.requestSeq += 1;
    const requestId = `req-${this.requestSeq}`;
    const done: CommandResult = { targetId, requestId, commandId: `cmd-${this.requestSeq}`, accepted: true };
    if (intent.command !== "broker.status") return done;
    const hostId = String(intent.hostId);
    const mode = this.brokerModes.get(hostId) ?? { kind: "result", result: { state: "local", generation: 0 } };
    switch (mode.kind) {
      case "reject-unknown":
        throw new Error("unknown command");
      case "hold":
        this.heldBroker.push({ requestId, hostId, targetId });
        return done;
      case "fail":
        this.emitResponse(targetId, hostId, requestId, {
          ok: false,
          error: { code: "broker_error", message: "boom at /home/user/.omp/auth.json token=secret-value" },
        });
        return done;
      case "result":
        this.emitResponse(targetId, hostId, requestId, { ok: true, result: mode.result });
        return done;
    }
  }
  async confirm(request: ConfirmRequest): Promise<ConfirmResult> {
    return {
      targetId: request.targetId,
      requestId: "req-confirm",
      confirmationId: request.confirmationId,
      commandId: request.commandId,
      accepted: true,
    };
  }
}

function attachedModel(runtime: FakeRuntime) {
  const model = createLiveSettingsScreenModel({
    runtime,
    onChallenge: async () => "approve",
    brokerTimeoutMs: 500,
  });
  const detach = model.subscribe(() => {});
  return { model, detach };
}

function twoHosts(): FakeRuntime {
  const runtime = new FakeRuntime();
  runtime.connect("local", "host-1", "This computer");
  runtime.connect("mac", "host-2", "Work Mac");
  return runtime;
}

// ─── Explicit host selection ────────────────────────────────────────────────

describe("explicit host selection", () => {
  it("lists every connected host, local first, and defaults to local", () => {
    const runtime = twoHosts();
    const { model } = attachedModel(runtime);
    const state = model.getState();
    expect(state.phase).toBe("ready");
    if (state.phase !== "ready") return;
    expect(state.hosts.map((choice) => choice.targetId)).toEqual(["local", "mac"]);
    expect(state.hosts[0]).toMatchObject({ label: "This computer", isLocal: true });
    expect(state.active.targetId).toBe("local");
  });

  it("opens the explicitly chosen host and sticks to it", () => {
    const runtime = twoHosts();
    const { model } = attachedModel(runtime);
    model.selectHost("mac");
    const state = model.getState();
    expect(state.phase).toBe("ready");
    if (state.phase !== "ready") return;
    expect(state.active).toMatchObject({ targetId: "mac", hostId: "host-2", hostLabel: "Work Mac", isLocal: false });

    // A snapshot churn does not silently revert to the local default.
    runtime.notify();
    const after = model.getState();
    expect(after.phase).toBe("ready");
    if (after.phase !== "ready") return;
    expect(after.active.targetId).toBe("mac");
  });

  it("ignores a selection that names no known target", () => {
    const runtime = twoHosts();
    const { model } = attachedModel(runtime);
    model.selectHost("ghost");
    const state = model.getState();
    expect(state.phase).toBe("ready");
    if (state.phase !== "ready") return;
    expect(state.active.targetId).toBe("local");
  });

  it("reports the chosen host's disconnect honestly instead of switching silently", () => {
    const runtime = twoHosts();
    const { model } = attachedModel(runtime);
    model.selectHost("mac");
    runtime.disconnect("mac");
    runtime.notify();
    const state = model.getState();
    expect(state).toMatchObject({ phase: "waiting", detail: "disconnected", hostLabel: "Work Mac" });
    if (state.phase !== "waiting") return;
    // The other hosts stay offered so the user can deliberately move on.
    expect(state.hosts.map((choice) => choice.targetId)).toEqual(["local"]);
    expect(state.activeTargetId).toBe("mac");
  });

  it("falls back to the default only when the chosen target is removed", () => {
    const runtime = twoHosts();
    const { model } = attachedModel(runtime);
    model.selectHost("mac");
    runtime.snapshot.targets.delete("mac");
    runtime.snapshot.connections.delete("mac");
    runtime.snapshot.targetHosts.delete("mac");
    runtime.notify();
    const state = model.getState();
    expect(state.phase).toBe("ready");
    if (state.phase !== "ready") return;
    expect(state.active.targetId).toBe("local");
  });

  it("bounds the choice list", () => {
    const runtime = new FakeRuntime();
    for (let index = 0; index < 24; index += 1) {
      runtime.connect(`t-${index}`, `h-${index}`, `Host ${index}`);
    }
    expect(connectedHostChoices(runtime.getSnapshot()).length).toBeLessThanOrEqual(16);
  });
});

// ─── Per-host draft continuity ──────────────────────────────────────────────

describe("per-host draft continuity", () => {
  it("keeps each host's store — and staged drafts — across A→B→A", () => {
    const runtime = twoHosts();
    const { model } = attachedModel(runtime);

    const first = model.getState();
    expect(first.phase).toBe("ready");
    if (first.phase !== "ready") return;
    first.api.getState().stageValue("appearance.compact", true);
    expect(first.api.getState().drafts["appearance.compact"]).toBeDefined();

    model.selectHost("mac");
    const second = model.getState();
    expect(second.phase).toBe("ready");
    if (second.phase !== "ready") return;
    expect(second.api).not.toBe(first.api);
    expect(second.api.getState().drafts["appearance.compact"]).toBeUndefined();

    model.selectHost("local");
    const third = model.getState();
    expect(third.phase).toBe("ready");
    if (third.phase !== "ready") return;
    expect(third.api).toBe(first.api);
    expect(third.api.getState().drafts["appearance.compact"]).toMatchObject({ action: "set", value: true });
  });

  it("keeps the store and waits honestly when the active host's frames vanish", () => {
    const runtime = twoHosts();
    const { model } = attachedModel(runtime);
    const first = model.getState();
    expect(first.phase).toBe("ready");
    if (first.phase !== "ready") return;
    first.api.getState().stageValue("appearance.compact", true);

    // Reconnect wipe: the frames disappear, the drafts must not.
    runtime.snapshot.catalogs.delete("host-1");
    runtime.snapshot.settings.delete("host-1");
    runtime.notify();
    expect(model.getState()).toMatchObject({ phase: "waiting", detail: "not-published" });

    runtime.snapshot.catalogs.set("host-1", catalogFrame("host-1", [settingItem("appearance.compact"), BROKER_ITEM]));
    runtime.snapshot.settings.set("host-1", settingsFrame("host-1"));
    runtime.notify();
    const recovered = model.getState();
    expect(recovered.phase).toBe("ready");
    if (recovered.phase !== "ready") return;
    expect(recovered.api).toBe(first.api);
    expect(recovered.api.getState().drafts["appearance.compact"]).toMatchObject({ action: "set", value: true });
  });
});

// ─── Broker status: support gate ────────────────────────────────────────────

describe("broker status support gate", () => {
  it("treats a host without the catalog command as unsupported and never queries it", async () => {
    const runtime = new FakeRuntime();
    runtime.connect("local", "host-1", "This computer", { broker: false });
    const { model } = attachedModel(runtime);
    await tick();
    const state = model.getState();
    expect(state.phase).toBe("ready");
    if (state.phase !== "ready") return;
    expect(state.broker).toEqual({ kind: "unsupported" });
    expect(runtime.commands.some((entry) => entry.command === "broker.status")).toBe(false);
  });

  it("treats a host without the broker.read grant as unsupported and never queries it", async () => {
    const runtime = new FakeRuntime();
    runtime.connect("local", "host-1", "This computer", { capability: false });
    const { model } = attachedModel(runtime);
    await tick();
    const state = model.getState();
    expect(state.phase).toBe("ready");
    if (state.phase !== "ready") return;
    expect(state.broker).toEqual({ kind: "unsupported" });
    expect(runtime.commands.some((entry) => entry.command === "broker.status")).toBe(false);
  });

  it("treats a client that cannot route the command as unsupported, never local", async () => {
    const runtime = new FakeRuntime();
    runtime.connect("local", "host-1", "This computer");
    runtime.brokerModes.set("host-1", { kind: "reject-unknown" });
    const { model } = attachedModel(runtime);
    await tick();
    const state = model.getState();
    expect(state.phase).toBe("ready");
    if (state.phase !== "ready") return;
    expect(state.broker).toEqual({ kind: "unsupported" });
  });

  it("stays unsupported for a snapshot that predates host metadata", () => {
    expect(
      brokerStatusSupported({ connections: new Map([["local", "connected"]]) }, { targetId: "local", hostId: "host-1" }),
    ).toBe(false);
  });
});

// ─── Broker status: states and refresh ──────────────────────────────────────

describe("broker status states", () => {
  async function readyBroker(result: unknown) {
    const runtime = new FakeRuntime();
    runtime.connect("local", "host-1", "This computer");
    runtime.brokerModes.set("host-1", { kind: "result", result });
    const { model } = attachedModel(runtime);
    await tick();
    const state = model.getState();
    expect(state.phase).toBe("ready");
    return { runtime, model, broker: state.phase === "ready" ? state.broker : { kind: "unsupported" as const } };
  }

  it("reports loading while the reply is outstanding", () => {
    const runtime = new FakeRuntime();
    runtime.connect("local", "host-1", "This computer");
    runtime.brokerModes.set("host-1", { kind: "hold" });
    const { model } = attachedModel(runtime);
    const state = model.getState();
    expect(state.phase).toBe("ready");
    if (state.phase !== "ready") return;
    expect(state.broker).toEqual({ kind: "loading", last: null });
  });

  it("reports local storage", async () => {
    const { broker } = await readyBroker({ state: "local", generation: 3 });
    expect(broker).toEqual({ kind: "ready", status: { state: "local", generation: 3 } });
    expect(brokerStatusCopy(broker).text).toBe("Accounts are stored on this host.");
  });

  it("reports a connected broker with only the safe endpoint", async () => {
    const { broker } = await readyBroker({
      state: "connected",
      endpoint: "https://broker.example.com/base",
      generation: 7,
    });
    expect(broker).toMatchObject({
      kind: "ready",
      status: { state: "connected", endpoint: "https://broker.example.com/base", generation: 7 },
    });
    expect(brokerStatusCopy(broker).text).toContain("https://broker.example.com/base");
  });

  it("reports a missing token with and without an endpoint", async () => {
    const withEndpoint = await readyBroker({
      state: "missing-token",
      endpoint: "https://broker.example.com",
      generation: 2,
    });
    expect(withEndpoint.broker).toMatchObject({ kind: "ready", status: { state: "missing-token" } });
    expect(brokerStatusCopy(withEndpoint.broker)).toMatchObject({ tone: "warning" });
    expect(brokerStatusCopy(withEndpoint.broker).text).toContain("https://broker.example.com");

    const without = await readyBroker({ state: "missing-token", generation: 2 });
    expect(without.broker).toEqual({ kind: "ready", status: { state: "missing-token", generation: 2 } });
    expect(brokerStatusCopy(without.broker).text).toContain("needs a new sign-in");
  });

  it("reports an unreachable broker", async () => {
    const { broker } = await readyBroker({
      state: "unreachable",
      endpoint: "https://broker.example.com",
      generation: 4,
    });
    expect(broker).toMatchObject({ kind: "ready", status: { state: "unreachable" } });
    expect(brokerStatusCopy(broker)).toMatchObject({ tone: "warning" });
    expect(brokerStatusCopy(broker).text).toContain("can't reach");
  });

  it("turns a failed reply into an error state that never leaks host error text", async () => {
    const runtime = new FakeRuntime();
    runtime.connect("local", "host-1", "This computer");
    runtime.brokerModes.set("host-1", { kind: "fail" });
    const { model } = attachedModel(runtime);
    await tick();
    const state = model.getState();
    expect(state.phase).toBe("ready");
    if (state.phase !== "ready") return;
    expect(state.broker).toEqual({ kind: "error", last: null });
    const copy = brokerStatusCopy(state.broker);
    expect(copy.text).not.toContain("boom");
    expect(copy.text).not.toContain("token");
    expect(copy.text).not.toContain("/home/");
  });

  it("turns an undecodable result into an error, not a guess", async () => {
    const { broker } = await readyBroker({ state: "local", generation: 3, extra: "nope" });
    expect(broker).toEqual({ kind: "error", last: null });
  });

  it("re-queries on a deliberate refresh and marks a failed refresh as stale", async () => {
    const runtime = new FakeRuntime();
    runtime.connect("local", "host-1", "This computer");
    runtime.brokerModes.set("host-1", { kind: "result", result: { state: "local", generation: 1 } });
    const { model } = attachedModel(runtime);
    await tick();

    runtime.brokerModes.set("host-1", { kind: "result", result: { state: "local", generation: 2 } });
    model.refreshBrokerStatus();
    await tick();
    let state = model.getState();
    expect(state.phase).toBe("ready");
    if (state.phase !== "ready") return;
    expect(state.broker).toEqual({ kind: "ready", status: { state: "local", generation: 2 } });
    expect(runtime.commands.filter((entry) => entry.command === "broker.status")).toHaveLength(2);

    // The next refresh fails: the old answer stays visible, marked stale.
    runtime.brokerModes.set("host-1", { kind: "fail" });
    model.refreshBrokerStatus();
    await tick();
    state = model.getState();
    expect(state.phase).toBe("ready");
    if (state.phase !== "ready") return;
    expect(state.broker).toEqual({ kind: "error", last: { state: "local", generation: 2 } });
    expect(brokerStatusCopy(state.broker).text).toContain("may be out of date");
  });

  it("drops a late reply that lands after a host switch", async () => {
    const runtime = new FakeRuntime();
    runtime.connect("local", "host-1", "This computer");
    runtime.connect("mac", "host-2", "Work Mac", { broker: false });
    runtime.brokerModes.set("host-1", { kind: "hold" });
    const { model } = attachedModel(runtime);
    expect(model.getState()).toMatchObject({ phase: "ready", broker: { kind: "loading" } });

    model.selectHost("mac");
    let state = model.getState();
    expect(state).toMatchObject({ phase: "ready", broker: { kind: "unsupported" } });

    // Host-1's answer arrives late; it must not describe host-2.
    runtime.releaseHeldBroker({ state: "local", generation: 9 });
    await tick();
    state = model.getState();
    expect(state.phase).toBe("ready");
    if (state.phase !== "ready") return;
    expect(state.active.targetId).toBe("mac");
    expect(state.broker).toEqual({ kind: "unsupported" });
  });

  it("queries the newly selected host on switch", async () => {
    const runtime = twoHosts();
    runtime.brokerModes.set("host-1", { kind: "result", result: { state: "local", generation: 1 } });
    runtime.brokerModes.set("host-2", {
      kind: "result",
      result: { state: "connected", endpoint: "https://broker.example.com", generation: 5 },
    });
    const { model } = attachedModel(runtime);
    await tick();
    model.selectHost("mac");
    await tick();
    const state = model.getState();
    expect(state.phase).toBe("ready");
    if (state.phase !== "ready") return;
    expect(state.broker).toEqual({
      kind: "ready",
      status: { state: "connected", endpoint: "https://broker.example.com", generation: 5 },
    });
    const queried = runtime.commands.filter((entry) => entry.command === "broker.status");
    expect(queried.map((entry) => entry.targetId)).toEqual(["local", "mac"]);
  });
});

// ─── Strict decoding and endpoint safety ────────────────────────────────────

describe("broker.status decoding", () => {
  it("decodes every legal state", () => {
    expect(decodeBrokerStatus({ state: "local", generation: 0 })).toEqual({ state: "local", generation: 0 });
    expect(
      decodeBrokerStatus({ state: "connected", endpoint: "https://b.example.com", generation: 1 }),
    ).toEqual({ state: "connected", endpoint: "https://b.example.com", generation: 1 });
    expect(decodeBrokerStatus({ state: "missing-token", generation: 1 })).toEqual({
      state: "missing-token",
      generation: 1,
    });
    expect(
      decodeBrokerStatus({ state: "unreachable", endpoint: "http://10.0.0.5:8443", generation: 2 }),
    ).toEqual({ state: "unreachable", endpoint: "http://10.0.0.5:8443", generation: 2 });
  });

  it("normalizes a bare trailing slash but keeps a real path", () => {
    const bare = decodeBrokerStatus({ state: "connected", endpoint: "https://b.example.com/", generation: 1 });
    expect(bare).toMatchObject({ endpoint: "https://b.example.com" });
    const path = decodeBrokerStatus({ state: "connected", endpoint: "https://b.example.com/auth", generation: 1 });
    expect(path).toMatchObject({ endpoint: "https://b.example.com/auth" });
  });

  const REJECTED: readonly [string, unknown][] = [
    ["a non-object", "local"],
    ["an unknown state", { state: "proxy", generation: 1 }],
    ["a missing generation", { state: "local" }],
    ["a negative generation", { state: "local", generation: -1 }],
    ["a fractional generation", { state: "local", generation: 1.5 }],
    ["an unsafe generation", { state: "local", generation: Number.MAX_SAFE_INTEGER + 2 }],
    ["an unknown extra field", { state: "local", generation: 1, note: "hi" }],
    ["local with an endpoint", { state: "local", generation: 1, endpoint: "https://b.example.com" }],
    ["connected without an endpoint", { state: "connected", generation: 1 }],
    ["unreachable without an endpoint", { state: "unreachable", generation: 1 }],
    ["a non-HTTP endpoint", { state: "connected", endpoint: "file:///etc/passwd", generation: 1 }],
    ["an endpoint with credentials", { state: "connected", endpoint: "https://user:pw@b.example.com", generation: 1 }],
    ["an endpoint with a query", { state: "connected", endpoint: "https://b.example.com/?token=x", generation: 1 }],
    ["an endpoint with a fragment", { state: "connected", endpoint: "https://b.example.com/#x", generation: 1 }],
    ["an unparseable endpoint", { state: "connected", endpoint: "not a url", generation: 1 }],
    ["an oversized endpoint", { state: "connected", endpoint: `https://b.example.com/${"a".repeat(600)}`, generation: 1 }],
  ];

  for (const [name, payload] of REJECTED) {
    it(`rejects ${name}`, () => {
      expect(() => decodeBrokerStatus(payload)).toThrow();
    });
  }

  it("copy never repeats decoder failure details", () => {
    const copy = brokerStatusCopy({ kind: "error", last: null });
    expect(copy.text).toBe("Account status couldn't be read. Refresh to try again.");
  });

  it("copy renders only decoded-safe endpoints", () => {
    const status: BrokerStatus = decodeBrokerStatus({
      state: "connected",
      endpoint: "https://broker.example.com/base",
      generation: 1,
    });
    const copy = brokerStatusCopy({ kind: "ready", status });
    expect(copy.text).toBe("Accounts come from https://broker.example.com/base.");
  });
});

// ─── Source invariants ──────────────────────────────────────────────────────

describe("host selection and broker surfaces stay fixture- and secret-free", () => {
  const LIVE_FILES = [
    "features/settings/broker-status.ts",
    "features/settings/live-screen-model.ts",
    "features/settings/HostSelector.tsx",
  ];

  it("never imports fixture modules or reads token fields", () => {
    for (const file of LIVE_FILES) {
      const content = readFileSync(join(SRC_ROOT, file), "utf8");
      expect(content, `${file} imports fixtures`).not.toMatch(/from "[^"]*fixtures\.ts"/);
      expect(content, `${file} touches a token field`).not.toMatch(/\.token\b/);
    }
  });

  it("never reads the host's response error, so its text cannot render", () => {
    const content = readFileSync(join(SRC_ROOT, "features/settings/broker-status.ts"), "utf8");
    // A failed response collapses to `ok`; the frame's error object — code,
    // message, details — is never dereferenced.
    expect(content).not.toMatch(/response\.error|\.error\?\./);
  });
});
