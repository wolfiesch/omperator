// Live settings + targets behavior: the schema adapter's strictness, the
// exact settings.write command a save produces, draft preservation on
// stale/unknown outcomes, pair-code handling, target add requests, and the
// serialized local service actions. Fakes stand in for the desktop runtime;
// every assertion is against the wire shapes the desktop contract names.
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
  type DesktopTarget,
  type LocalProfile,
  type RendererServerEventEnvelope,
  type RendererServerFrame,
  type TargetAddRequest,
} from "@t4-code/protocol/desktop-ipc";

import { buildLiveSettingsCatalog } from "../src/features/settings/live-catalog.ts";
import {
  createLiveSettingsController,
  type LiveSettingsRuntimePort,
} from "../src/features/settings/live-controller.ts";
import { createSettingsStore } from "../src/features/settings/settings-store.ts";
import {
  capabilitiesForGroups,
  capabilityDiff,
  EMPTY_TARGET_DRAFT,
  pairCommandForTarget,
  selectTargetCapabilityGroups,
  validateTargetDraft,
} from "../src/features/targets/model.ts";
import {
  createTargetsStore,
  EMPTY_PROFILE_DRAFT,
  type ProfilesPort,
  type TargetActionsPort,
} from "../src/features/targets/targets-store.ts";
import { deferred } from "./fake-shell.ts";

const SRC_ROOT = join(import.meta.dirname, "../src");

// ─── Frame builders ─────────────────────────────────────────────────────────

function settingItem(path: string, metadata: Record<string, unknown>): Record<string, unknown> {
  return { id: `setting:${path}`, kind: "setting", name: path, metadata: { path, ...metadata } };
}

// Test seam: fixture frames are hand-built rather than wire-decoded.
function catalogFrame(items: readonly Record<string, unknown>[]): CatalogFrame {
  return {
    v: "omp-app/1",
    type: "catalog",
    hostId: "host-1",
    revision: "rev-1",
    items,
  } as unknown as CatalogFrame;
}

function settingsFrame(settings: Record<string, unknown>, revision = "rev-1"): SettingsFrame {
  return {
    v: "omp-app/1",
    type: "settings",
    hostId: "host-1",
    revision,
    settings,
  } as unknown as SettingsFrame;
}

function build(
  items: readonly Record<string, unknown>[],
  values: Record<string, unknown> = {},
  revision = "rev-1",
) {
  return buildLiveSettingsCatalog({
    catalog: catalogFrame(items),
    settings: settingsFrame(values, revision),
    hostLabel: "This computer",
  });
}

// ─── Adapter ────────────────────────────────────────────────────────────────

describe("live settings catalog adapter", () => {
  it("maps every supported control type onto an editor", () => {
    const { catalog, issues } = build([
      settingItem("appearance.compact", {
        label: "Compact",
        controlType: "boolean",
        default: false,
        effective: true,
        effectiveSource: "global",
        configured: true,
        sensitive: false,
        tab: "appearance",
      }),
      settingItem("terminal.scrollback", {
        label: "Scrollback",
        controlType: "number",
        min: 100,
        max: 100000,
        default: 10000,
        effectiveSource: "default",
        configured: false,
        sensitive: false,
        tab: "shell",
      }),
      settingItem("appearance.theme", {
        label: "Theme",
        controlType: "enum",
        options: ["dark", "light"],
        default: "dark",
        effectiveSource: "default",
        configured: false,
        sensitive: false,
        tab: "appearance",
      }),
      settingItem("editor.command", {
        label: "Editor",
        controlType: "string",
        effectiveSource: "default",
        configured: false,
        sensitive: false,
      }),
      settingItem("extensions", {
        label: "Extensions",
        controlType: "array",
        maxItems: 32,
        effectiveSource: "default",
        configured: false,
        sensitive: false,
        tab: "tools",
      }),
      settingItem("modelRoles", {
        label: "Model roles",
        controlType: "record",
        effectiveSource: "default",
        configured: false,
        sensitive: false,
        tab: "model",
      }),
    ]);
    expect(issues).toEqual([]);
    const kinds = [
      "appearance.compact",
      "terminal.scrollback",
      "appearance.theme",
      "editor.command",
      "extensions",
      "modelRoles",
    ].map((id) => catalog.settings.find((row) => row.id === id)?.control.kind);
    expect(kinds).toEqual(["boolean", "number", "enum", "text", "list", "map"]);
    const compact = catalog.settings.find((row) => row.id === "appearance.compact");
    expect(compact?.layers?.global?.value).toBe(true);
    expect(compact?.default).toBe(false);
  });

  it("maps wire provenance onto layers: override→session, configOverlay→cli", () => {
    const { catalog } = build([
      settingItem("a.session", {
        label: "A",
        controlType: "boolean",
        effective: true,
        effectiveSource: "override",
        configured: true,
        sensitive: false,
      }),
      settingItem("b.cli", {
        label: "B",
        controlType: "boolean",
        effective: false,
        effectiveSource: "configOverlay",
        configured: false,
        sensitive: false,
      }),
    ]);
    expect(catalog.settings.find((row) => row.id === "a.session")?.layers?.session?.value).toBe(
      true,
    );
    expect(catalog.settings.find((row) => row.id === "b.cli")?.layers?.cli?.value).toBe(false);
  });

  it("degrades unrecognized metadata, control types, and value sources to read-only rows", () => {
    const { catalog, issues } = build([
      settingItem("mystery.key", {
        label: "Mystery",
        controlType: "boolean",
        effectiveSource: "default",
        configured: false,
        sensitive: false,
        surprise: 1,
      }),
      settingItem("novel.control", {
        label: "Novel",
        controlType: "hologram",
        effectiveSource: "default",
        configured: false,
        sensitive: false,
      }),
      settingItem("weird.source", {
        label: "Weird",
        controlType: "boolean",
        effective: true,
        effectiveSource: "quantum",
        configured: true,
        sensitive: false,
      }),
    ]);
    // All three stay visible; none is editable; nothing was guessed.
    expect(catalog.settings).toHaveLength(3);
    expect(catalog.settings.find((row) => row.id === "mystery.key")?.control.kind).toBe(
      "unvalidated-metadata",
    );
    expect(catalog.settings.find((row) => row.id === "novel.control")?.control.kind).toBe(
      "hologram",
    );
    expect(catalog.settings.find((row) => row.id === "weird.source")?.control.kind).toBe(
      "unvalidated-metadata",
    );
    // The unknown control kind needs no adapter issue — the view model
    // renders its unsupported fallback; the other two are metadata refusals.
    expect(issues).toHaveLength(2);
  });

  it("shows sensitive settings as configured/unconfigured only, never a value", () => {
    const { catalog } = build([
      settingItem("providers.apiKey", {
        label: "API key",
        controlType: "string",
        effectiveSource: "global",
        configured: true,
        sensitive: true,
      }),
      settingItem("providers.authToken", {
        label: "Auth token",
        controlType: "string",
        effectiveSource: "default",
        configured: false,
        sensitive: true,
      }),
    ]);
    const set = catalog.settings.find((row) => row.id === "providers.apiKey");
    const missing = catalog.settings.find((row) => row.id === "providers.authToken");
    expect(set?.control).toEqual({ kind: "secret-reference" });
    expect(set?.layers?.global?.secret?.state).toBe("set");
    expect(missing?.layers?.global?.secret?.state).toBe("missing");
    expect(JSON.stringify(set)).not.toContain("effective");
  });

  it("refuses a sensitive setting that arrives with a value", () => {
    const { catalog, issues } = build([
      settingItem("providers.apiKey", {
        label: "API key",
        controlType: "string",
        effective: "sk-oops",
        effectiveSource: "global",
        configured: true,
        sensitive: true,
      }),
    ]);
    const row = catalog.settings.find((entry) => entry.id === "providers.apiKey");
    expect(row?.control.kind).toBe("unvalidated-metadata");
    expect(JSON.stringify(catalog)).not.toContain("sk-oops");
    expect(issues[0]).toMatch(/sensitive/);
  });

  it("disables platform-unavailable settings with a reason", () => {
    const { catalog } = build([
      settingItem("power.sleepPrevention", {
        label: "Keep awake",
        controlType: "boolean",
        effectiveSource: "default",
        configured: false,
        sensitive: false,
        platform: "linux",
        availability: false,
      }),
    ]);
    const row = catalog.settings.find((entry) => entry.id === "power.sleepPrevention");
    expect(row?.unavailable?.reason).toBe("Not available on this computer.");
  });

  it("groups rows by tab and restricts editable scopes to what the host writes", () => {
    const result = build([
      settingItem("appearance.compact", {
        label: "Compact",
        controlType: "boolean",
        effectiveSource: "default",
        configured: false,
        sensitive: false,
        tab: "appearance",
        scopes: ["global", "session"],
      }),
    ]);
    expect(result.catalog.sections.map((section) => section.id)).toEqual(["appearance"]);
    expect(result.editableScopes).toEqual(["global", "session"]);
    expect(result.catalog.revision).toBe("rev-1");
    expect(result.catalog.hostId).toBe("host-1");
  });
});

// ─── Live controller ────────────────────────────────────────────────────────

interface FakeRuntimeOptions {
  /** How the settings.write response answers. */
  readonly write: "ok" | "stale" | "reject" | "outcome-unknown" | "challenge-then-ok";
}

const BASE_ITEMS = [
  settingItem("appearance.compact", {
    label: "Compact",
    controlType: "boolean",
    default: false,
    effectiveSource: "default",
    configured: false,
    sensitive: false,
    tab: "appearance",
  }),
];

class FakeRuntime implements LiveSettingsRuntimePort {
  readonly commands: CommandRequest["intent"][] = [];
  readonly confirms: ConfirmRequest[] = [];
  private snapshotListeners = new Set<(snapshot: never) => void>();
  private eventListeners = new Set<(event: RendererServerEventEnvelope) => void>();
  private revision = "rev-1";
  private requestSeq = 0;

  private readonly options: FakeRuntimeOptions;

  constructor(options: FakeRuntimeOptions) {
    this.options = options;
  }

  private snapshotValue(): {
    catalogs: Map<string, CatalogFrame>;
    settings: Map<string, SettingsFrame>;
  } {
    return {
      catalogs: new Map([["host-1", catalogFrame(BASE_ITEMS)]]),
      settings: new Map([["host-1", settingsFrame({}, this.revision)]]),
    };
  }
  // Test seam: only the fields the controller reads exist on this snapshot.
  getSnapshot(): never {
    return this.snapshotValue() as unknown as never;
  }
  subscribe(listener: (snapshot: never) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }
  subscribeEvents(
    _filter: { readonly targetId: string },
    listener: (event: RendererServerEventEnvelope) => void,
  ): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  private emitFrame(frame: Record<string, unknown>): void {
    for (const listener of this.eventListeners) {
      listener({
        targetId: "local",
        event: rendererServerEventFromFrame(frame as unknown as RendererServerFrame),
      });
    }
  }
  private respond(requestId: string, ok: boolean, error?: { code: string; message: string }): void {
    const frame: Record<string, unknown> = {
      v: "omp-app/1",
      type: "response",
      requestId,
      hostId: "host-1",
      ok,
      command: "settings.write",
      ...(ok ? { result: { accepted: true, revision: "rev-2" } } : { error }),
    };
    this.emitFrame(frame);
  }
  async command(_targetId: string, intent: CommandRequest["intent"]): Promise<CommandResult> {
    this.commands.push(intent);
    this.requestSeq += 1;
    const requestId = `req-${this.requestSeq}`;
    if (intent.command === "settings.read" || intent.command === "catalog.get") {
      this.revision = "rev-2";
      for (const listener of this.snapshotListeners) listener(this.getSnapshot());
      return { targetId: "local", requestId, commandId: `cmd-${this.requestSeq}`, accepted: true };
    }
    const mode = this.options.write;
    if (mode === "outcome-unknown") {
      throw new Error("request outcome is unknown; inspect server state before retrying");
    }
    if (mode === "challenge-then-ok") {
      const gate = Promise.withResolvers<void>();
      this.confirmGate = gate;
      this.emitFrame({
        v: "omp-app/1",
        type: "confirmation",
        confirmationId: "confirm-1",
        commandId: `cmd-${this.requestSeq}`,
        hostId: "host-1",
        commandHash: "hash",
        revision: this.revision,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        summary: "Apply 1 settings change?",
      });
      // The host holds the response until the confirm decision arrives.
      await gate.promise;
      this.respond(requestId, true);
      return { targetId: "local", requestId, commandId: `cmd-${this.requestSeq}`, accepted: true };
    }
    if (mode === "ok") this.respond(requestId, true);
    if (mode === "stale")
      this.respond(requestId, false, {
        code: "stale_revision",
        message: "settings revision conflict",
      });
    if (mode === "reject")
      this.respond(requestId, false, { code: "invalid", message: "unknown setting path: nope" });
    return { targetId: "local", requestId, commandId: `cmd-${this.requestSeq}`, accepted: true };
  }
  private confirmGate: { resolve: () => void } | null = null;
  async confirm(request: ConfirmRequest): Promise<ConfirmResult> {
    this.confirms.push(request);
    this.confirmGate?.resolve();
    return {
      targetId: request.targetId,
      requestId: "req-confirm",
      confirmationId: request.confirmationId,
      commandId: request.commandId,
      accepted: true,
    };
  }
}

function liveStore(
  runtime: FakeRuntime,
  onChallenge: () => Promise<"approve" | "deny"> = async () => "approve",
) {
  const built = build(BASE_ITEMS);
  const controller = createLiveSettingsController({
    runtime,
    targetId: "local",
    hostId: "host-1",
    hostLabel: "This computer",
    onChallenge,
    timeoutMs: 500,
  });
  return createSettingsStore(built.catalog, controller);
}

describe("live settings.write", () => {
  it("sends exactly one settings.write with {edits, expectedRevision} and frame revision, then re-reads before clearing dirty", async () => {
    const runtime = new FakeRuntime({ write: "ok" });
    const store = liveStore(runtime);
    store.getState().stageValue("appearance.compact", true);
    await store.getState().save();

    const writes = runtime.commands.filter((intent) => intent.command === "settings.write");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      hostId: "host-1",
      command: "settings.write",
      expectedRevision: "rev-1",
      args: {
        edits: [{ path: "appearance.compact", scope: "global", value: true }],
        expectedRevision: "rev-1",
      },
    });
    // Accepted → re-read happened before drafts cleared.
    const followUps = runtime.commands.map((intent) => intent.command);
    expect(followUps).toContain("settings.read");
    expect(followUps).toContain("catalog.get");
    expect(store.getState().drafts).toEqual({});
    expect(store.getState().viewModel.revision).toBe("rev-2");
  });

  it("sends reset:true for a cleared layer value", async () => {
    const runtime = new FakeRuntime({ write: "ok" });
    const built = build([
      settingItem("appearance.compact", {
        label: "Compact",
        controlType: "boolean",
        default: false,
        effective: true,
        effectiveSource: "global",
        configured: true,
        sensitive: false,
      }),
    ]);
    const store = createSettingsStore(
      built.catalog,
      createLiveSettingsController({
        runtime,
        targetId: "local",
        hostId: "host-1",
        hostLabel: "This computer",
        onChallenge: async () => "approve",
        timeoutMs: 500,
      }),
    );
    store.getState().stageClear("appearance.compact");
    await store.getState().save();
    const write = runtime.commands.find((intent) => intent.command === "settings.write");
    expect(write?.args).toMatchObject({
      edits: [{ path: "appearance.compact", scope: "global", reset: true }],
    });
  });

  it("preserves dirty values on a stale revision and raises the conflict", async () => {
    const runtime = new FakeRuntime({ write: "stale" });
    const store = liveStore(runtime);
    store.getState().stageValue("appearance.compact", true);
    await store.getState().save();
    expect(store.getState().drafts["appearance.compact"]).toBeDefined();
    expect(store.getState().incoming?.revision).toBe("rev-2");
  });

  it("preserves dirty values on an unknown outcome and says so", async () => {
    const runtime = new FakeRuntime({ write: "outcome-unknown" });
    const store = liveStore(runtime);
    store.getState().stageValue("appearance.compact", true);
    await store.getState().save();
    expect(store.getState().drafts["appearance.compact"]).toBeDefined();
    expect(store.getState().announcement).toMatch(/still staged/);
  });

  it("preserves dirty values on a host rejection with the host's reason", async () => {
    const runtime = new FakeRuntime({ write: "reject" });
    const store = liveStore(runtime);
    store.getState().stageValue("appearance.compact", true);
    await store.getState().save();
    expect(store.getState().drafts["appearance.compact"]).toBeDefined();
    expect(store.getState().announcement).toMatch(/unknown setting path/);
  });

  it("routes a host confirmation challenge through the prompt and confirms the decision", async () => {
    const runtime = new FakeRuntime({ write: "challenge-then-ok" });
    let promptedSummary: string | null = null;
    const store = liveStore(runtime, async () => {
      promptedSummary = "prompted";
      return "approve";
    });
    store.getState().stageValue("appearance.compact", true);
    await store.getState().save();
    expect(promptedSummary).toBe("prompted");
    expect(runtime.confirms).toHaveLength(1);
    expect(runtime.confirms[0]).toMatchObject({ confirmationId: "confirm-1", decision: "approve" });
  });
});

// ─── Targets ────────────────────────────────────────────────────────────────

class FakeTargetsPort implements TargetActionsPort {
  readonly calls: Array<{ readonly kind: string; readonly payload: unknown }> = [];
  pairResult: { paired: boolean } | Error = { paired: true };
  targets: DesktopTarget[] = [
    { targetId: "local", label: "This computer", kind: "local", state: "connected", paired: true },
  ];
  async listTargets(): Promise<readonly DesktopTarget[]> {
    return this.targets;
  }
  async addTarget(request: TargetAddRequest): Promise<DesktopTarget> {
    this.calls.push({ kind: "add", payload: request });
    return {
      targetId: request.target.targetId,
      label: request.target.label,
      kind: "remote",
      state: "disconnected",
      paired: false,
    };
  }
  async removeTarget(targetId: string): Promise<{ targetId: string; removed: boolean }> {
    this.calls.push({ kind: "remove", payload: targetId });
    return { targetId, removed: true };
  }
  async connect(
    targetId: string,
  ): Promise<{ targetId: string; state: "connecting" | "connected" }> {
    this.calls.push({ kind: "connect", payload: targetId });
    return { targetId, state: "connecting" };
  }
  async disconnect(targetId: string): Promise<{ targetId: string; state: "disconnected" }> {
    this.calls.push({ kind: "disconnect", payload: targetId });
    return { targetId, state: "disconnected" };
  }
  async pair(targetId: string, code: string): Promise<{ targetId: string; paired: boolean }> {
    this.calls.push({ kind: "pair", payload: { targetId, code } });
    if (this.pairResult instanceof Error) throw this.pairResult;
    return { targetId, paired: this.pairResult.paired };
  }
}

describe("target add validation", () => {
  it("accepts a Tailscale IP and derives an exact add request", () => {
    const result = validateTargetDraft(
      { ...EMPTY_TARGET_DRAFT, label: "Work Mac", address: "100.64.0.12", port: "4400" },
      new Set(["local"]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toMatchObject({
        targetId: "work-mac",
        label: "Work Mac",
        mode: "direct",
        address: "100.64.0.12",
        port: 4400,
        grantedCapabilities: [],
        status: "unknown",
      });
      expect(result.target.requestedCapabilities).toContain("sessions.read");
      expect(result.target.requestedCapabilities).not.toContain("config.write");
    }
  });

  it("rejects non-tailnet direct addresses and malformed serve URLs", () => {
    const direct = validateTargetDraft(
      { ...EMPTY_TARGET_DRAFT, label: "X", address: "example.com", port: "4400" },
      new Set(),
    );
    expect(direct.ok).toBe(false);
    const serve = validateTargetDraft(
      {
        ...EMPTY_TARGET_DRAFT,
        label: "X",
        mode: "serve",
        address: "http://host.tail.ts.net/",
        port: "",
      },
      new Set(),
    );
    expect(serve.ok).toBe(false);
    const good = validateTargetDraft(
      {
        ...EMPTY_TARGET_DRAFT,
        label: "X",
        mode: "serve",
        address: "https://host.tail.ts.net/",
        port: "",
      },
      new Set(),
    );
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.target.port).toBe(443);
  });

  it("diffs requested against granted capabilities", () => {
    const diff = capabilityDiff(["sessions.read", "term.open"], ["sessions.read", "files.read"]);
    expect(diff.granted).toEqual(["sessions.read"]);
    expect(diff.missing).toEqual(["term.open"]);
    expect(diff.extra).toEqual(["files.read"]);
  });
});

describe("target capability groups", () => {
  it("hides cluster sessions unless the app explicitly opts in", () => {
    for (const enabled of [undefined, false]) {
      expect(selectTargetCapabilityGroups(enabled).map((group) => group.id)).toEqual([
        "observe",
        "control",
        "shell",
        "files",
        "settings",
      ]);
    }
  });

  it("exposes the exact cluster-session capabilities for an explicit opt-in", () => {
    const groups = selectTargetCapabilityGroups(true);
    expect(groups.map((group) => group.id)).toEqual([
      "observe",
      "control",
      "shell",
      "files",
      "settings",
      "cluster",
    ]);
    const cluster = groups.find((group) => group.id === "cluster");
    expect(cluster?.label).toBe("Cluster sessions");
    expect(cluster?.capabilities).toEqual([
      "ci.trigger",
      "preview.read",
      "preview.control",
      "preview.input",
    ]);
  });

  it("orders observe, control, and cluster capabilities without extras", () => {
    const capabilities = capabilitiesForGroups(new Set(["cluster", "control", "observe"]));
    expect(capabilities).toEqual([
      "sessions.read",
      "catalog.read",
      "config.read",
      "audit.read",
      "sessions.prompt",
      "sessions.control",
      "sessions.manage",
      "agents.control",
      "ci.trigger",
      "preview.read",
      "preview.control",
      "preview.input",
    ]);
    expect(pairCommandForTarget(capabilities).capabilities).toEqual(capabilities);
  });
});

describe("pair command", () => {
  it("emits one --capability flag per requested capability from the selected groups", () => {
    const requested = capabilitiesForGroups(new Set(["observe", "settings", "control"]));
    const pair = pairCommandForTarget(requested);
    expect(pair.observeFallback).toBe(false);
    expect(pair.command).toBe(
      "omp appserver pair" +
        " --capability sessions.read --capability catalog.read --capability config.read --capability audit.read" +
        " --capability sessions.prompt --capability sessions.control --capability sessions.manage --capability agents.control" +
        " --capability config.write",
    );
  });

  it("orders capabilities by catalog position no matter the request order", () => {
    const shuffled = [
      "config.write",
      "audit.read",
      "sessions.prompt",
      "sessions.read",
      "sessions.read",
    ];
    const pair = pairCommandForTarget(shuffled);
    expect(pair.capabilities).toEqual([
      "sessions.read",
      "audit.read",
      "sessions.prompt",
      "config.write",
    ]);
    expect(pair.command).toBe(pairCommandForTarget([...shuffled].reverse()).command);
  });

  it("falls back to observe-only when the request record is missing or unusable", () => {
    const observe = capabilitiesForGroups(new Set(["observe"]));
    for (const requested of [undefined, [], ["not.a.capability"], ["rm -rf /; sessions.read"]]) {
      const pair = pairCommandForTarget(requested);
      expect(pair.observeFallback).toBe(true);
      expect(pair.capabilities).toEqual(observe);
      expect(pair.command).toBe(
        "omp appserver pair --capability sessions.read --capability catalog.read --capability config.read --capability audit.read",
      );
      expect(pair.capabilities).not.toContain("config.write");
      expect(pair.capabilities).not.toContain("bash.run");
      expect(pair.capabilities).not.toContain("files.write");
    }
  });

  it("never lets non-catalog input reach the command string", () => {
    const hostile = [
      "sessions.read",
      "$(cat /etc/passwd)",
      "--capability evil",
      "100.64.0.12",
      "123456",
    ];
    const pair = pairCommandForTarget(hostile);
    expect(pair.observeFallback).toBe(false);
    expect(pair.capabilities).toEqual(["sessions.read"]);
    expect(pair.command).toBe("omp appserver pair --capability sessions.read");
    // The command is catalog constants joined with spaces — nothing else.
    expect(pair.command).toMatch(/^omp appserver pair(?: --capability [a-z]+\.[a-z]+)*$/);
  });
});

describe("pairing", () => {
  it("rejects a bad code locally without calling the desktop", async () => {
    const port = new FakeTargetsPort();
    const store = createTargetsStore(port, {});
    store.getState().setPairCode("mac", "12 34");
    expect(store.getState().pairCodes.mac).toBe("1234");
    await store.getState().submitPair("mac");
    expect(port.calls.filter((call) => call.kind === "pair")).toHaveLength(0);
    expect(store.getState().pairErrors.mac).toMatch(/six digits/);
    expect(store.getState().pairCodes.mac).toBe("1234");
  });

  it("retains the code on a pair error and clears it on success", async () => {
    const port = new FakeTargetsPort();
    port.pairResult = new Error("pairing is not required");
    const store = createTargetsStore(port, {});
    store.getState().setPairCode("mac", "123456");
    await store.getState().submitPair("mac");
    expect(store.getState().pairCodes.mac).toBe("123456");
    expect(store.getState().pairErrors.mac).toMatch(/pairing is not required/);

    port.pairResult = { paired: true };
    await store.getState().submitPair("mac");
    expect(port.calls.filter((call) => call.kind === "pair")).toHaveLength(2);
    expect(store.getState().pairCodes.mac).toBeUndefined();
    expect(store.getState().pairErrors.mac).toBeUndefined();
  });
});

describe("target actions", () => {
  it("adds then connects, recording requested capabilities for the grant diff", async () => {
    const port = new FakeTargetsPort();
    const store = createTargetsStore(port, {});
    store
      .getState()
      .setDraft({ ...EMPTY_TARGET_DRAFT, label: "Work Mac", address: "100.64.0.12", port: "4400" });
    await store.getState().submitAdd();
    expect(port.calls.map((call) => call.kind)).toEqual(["add", "connect"]);
    expect(store.getState().requestedCapabilities["work-mac"]).toContain("sessions.read");
    expect(store.getState().draft.label).toBe("");
  });

  it("removes only after confirmation and never implies server-side revocation", async () => {
    const port = new FakeTargetsPort();
    const store = createTargetsStore(port, {});
    store.getState().askRemove("work-mac");
    expect(port.calls).toHaveLength(0);
    await store.getState().confirmRemove();
    expect(port.calls).toEqual([{ kind: "remove", payload: "work-mac" }]);
    expect(store.getState().announcement).toMatch(/credential stored on this computer/);
    expect(store.getState().announcement).not.toMatch(/revoked on the host/);
  });
});

describe("local service actions", () => {
  it("serializes actions and reports status only from a fresh inspection", async () => {
    const order: string[] = [];
    let serviceState: "stopped" | "running" = "stopped";
    const service = {
      inspect: async () => {
        order.push("inspect");
        return { definition: "current" as const, service: serviceState, diagnostics: "" };
      },
      start: async () => {
        order.push("start");
        serviceState = "running";
        return { completed: true as const };
      },
      restart: async () => {
        order.push("restart");
        return { completed: true as const };
      },
    };
    const store = createTargetsStore(new FakeTargetsPort(), service);
    const first = store.getState().runServiceAction("start");
    // A second action while the first runs is refused, not queued twice.
    const second = store.getState().runServiceAction("restart");
    await Promise.all([first, second]);
    expect(order).toEqual(["start", "inspect"]);
    expect(store.getState().service.inspection?.service).toBe("running");
    expect(store.getState().service.pending).toBeNull();
  });

  it("reports a failed action honestly and still re-inspects", async () => {
    const service = {
      inspect: async () => ({
        definition: "current" as const,
        service: "stopped" as const,
        diagnostics: "exit 1",
      }),
      start: async () => {
        throw new Error("unit failed");
      },
    };
    const store = createTargetsStore(new FakeTargetsPort(), service);
    await store.getState().runServiceAction("start");
    expect(store.getState().service.error).toMatch(/unit failed/);
    expect(store.getState().service.inspection?.service).toBe("stopped");
  });
});

// ─── Local profiles ────────────────────────────────────────────────────────

function profile(profileId: string, options: Partial<LocalProfile> = {}): LocalProfile {
  return {
    profileId,
    label: profileId === "default" ? "Default" : "Fable Swarm",
    targetId: profileId === "default" ? "local" : `local:${profileId}`,
    autoStart: profileId === "default",
    isDefault: profileId === "default",
    service: { definition: "current", service: "stopped", diagnostics: "" },
    ...options,
  };
}

class FakeProfilesPort implements ProfilesPort {
  readonly calls: Array<{ readonly kind: string; readonly profileId: string }> = [];
  profiles: LocalProfile[] = [profile("fable-swarm"), profile("default")];

  async list(): Promise<readonly LocalProfile[]> {
    this.calls.push({ kind: "list", profileId: "" });
    return this.profiles;
  }
  async add(input: {
    readonly profileId: string;
    readonly label?: string;
    readonly autoStart?: boolean;
  }): Promise<LocalProfile> {
    this.calls.push({ kind: "add", profileId: input.profileId });
    const added = profile(input.profileId, {
      label: input.label ?? input.profileId,
      autoStart: input.autoStart ?? false,
    });
    this.profiles.push(added);
    return added;
  }
  async update(
    profileId: string,
    changes: { readonly autoStart?: boolean },
  ): Promise<LocalProfile> {
    this.calls.push({ kind: "update", profileId });
    const current = this.profiles.find((candidate) => candidate.profileId === profileId);
    if (current === undefined) throw new Error("missing profile");
    const updated = { ...current, ...changes };
    this.profiles = this.profiles.map((candidate) =>
      candidate.profileId === profileId ? updated : candidate,
    );
    return updated;
  }
  async remove(profileId: string): Promise<{ readonly profileId: string; readonly removed: true }> {
    this.calls.push({ kind: "remove", profileId });
    this.profiles = this.profiles.filter((candidate) => candidate.profileId !== profileId);
    return { profileId, removed: true };
  }
  async status(profileId: string): Promise<LocalProfile> {
    return this.act("status", profileId, "stopped");
  }
  async start(profileId: string): Promise<LocalProfile> {
    return this.act("start", profileId, "running");
  }
  async stop(profileId: string): Promise<LocalProfile> {
    return this.act("stop", profileId, "stopped");
  }
  async restart(profileId: string): Promise<LocalProfile> {
    return this.act("restart", profileId, "running");
  }
  private async act(
    kind: string,
    profileId: string,
    service: "running" | "stopped",
  ): Promise<LocalProfile> {
    this.calls.push({ kind, profileId });
    const current = this.profiles.find((candidate) => candidate.profileId === profileId);
    if (current === undefined) throw new Error("missing profile");
    const updated = { ...current, service: { ...current.service, service } };
    this.profiles = this.profiles.map((candidate) =>
      candidate.profileId === profileId ? updated : candidate,
    );
    return updated;
  }
}

describe("local profile actions", () => {
  it("loads real profile truth, keeps default first, and serializes same-profile actions", async () => {
    const profiles = new FakeProfilesPort();
    const store = createTargetsStore(new FakeTargetsPort(), {}, profiles);
    await store.getState().loadProfiles();
    expect(store.getState().profiles.map((entry) => entry.profileId)).toEqual([
      "default",
      "fable-swarm",
    ]);

    const first = store.getState().runProfileAction("fable-swarm", "start");
    const duplicate = store.getState().runProfileAction("fable-swarm", "start");
    await Promise.all([first, duplicate]);
    expect(profiles.calls.filter((call) => call.kind === "start")).toHaveLength(1);
    expect(
      store.getState().profiles.find((entry) => entry.profileId === "fable-swarm")?.service.service,
    ).toBe("running");
  });

  it("does not let a stale list response overwrite a newer lifecycle result", async () => {
    const profiles = new FakeProfilesPort();
    const store = createTargetsStore(new FakeTargetsPort(), {}, profiles);
    await store.getState().loadProfiles();

    const stale = profiles.profiles.map((entry) => ({
      ...entry,
      service: { ...entry.service, service: "stopped" as const },
    }));
    const listGate = deferred<readonly LocalProfile[]>();
    profiles.list = async () => listGate.promise;

    const refresh = store.getState().loadProfiles();
    await store.getState().runProfileAction("fable-swarm", "start");
    listGate.resolve(stale);
    await refresh;

    expect(
      store.getState().profiles.find((entry) => entry.profileId === "fable-swarm")?.service.service,
    ).toBe("running");
  });

  it("validates IDs locally, registers a profile, and updates automatic startup from backend truth", async () => {
    const profiles = new FakeProfilesPort();
    const store = createTargetsStore(new FakeTargetsPort(), {}, profiles);
    await store.getState().loadProfiles();
    store.getState().setProfileDraft({ ...EMPTY_PROFILE_DRAFT, profileId: "Bad Profile" });
    await store.getState().submitProfile();
    expect(store.getState().profileDraftErrors.profileId).toMatch(/lowercase/);
    expect(profiles.calls.filter((call) => call.kind === "add")).toHaveLength(0);

    store.getState().setProfileDraft({
      profileId: "opus-lab",
      label: "Opus Lab",
      autoStart: true,
    });
    await store.getState().submitProfile();
    expect(store.getState().profiles.some((entry) => entry.profileId === "opus-lab")).toBe(true);
    await store.getState().setProfileAutoStart("opus-lab", false);
    expect(
      store.getState().profiles.find((entry) => entry.profileId === "opus-lab")?.autoStart,
    ).toBe(false);
  });

  it("removes only the T4 registration after confirmation and says profile data remains", async () => {
    const profiles = new FakeProfilesPort();
    const store = createTargetsStore(new FakeTargetsPort(), {}, profiles);
    await store.getState().loadProfiles();
    store.getState().askRemoveProfile("default");
    expect(store.getState().removingProfile).toBeNull();
    store.getState().askRemoveProfile("fable-swarm");
    await store.getState().confirmRemoveProfile();
    expect(profiles.calls.filter((call) => call.kind === "remove")).toEqual([
      { kind: "remove", profileId: "fable-swarm" },
    ]);
    expect(store.getState().announcement).toMatch(/profile data was left in place/);
  });
});

// ─── Source invariants ──────────────────────────────────────────────────────

describe("desktop live surfaces stay fixture- and secret-free", () => {
  const LIVE_FILES = [
    "features/settings/live-catalog.ts",
    "features/settings/live-controller.ts",
    "features/settings/LiveSettingsScreen.tsx",
    "features/targets/model.ts",
    "features/targets/targets-store.ts",
    "features/targets/TargetsScreen.tsx",
  ];

  it("never imports fixture modules or reads token fields", () => {
    for (const file of LIVE_FILES) {
      const content = readFileSync(join(SRC_ROOT, file), "utf8");
      expect(content, `${file} imports fixtures`).not.toMatch(/from "[^"]*fixtures\.ts"/);
      expect(content, `${file} touches a token field`).not.toMatch(/\.token\b/);
    }
  });

  it("keeps the remove copy on local credential deletion, not device revocation", () => {
    const content = readFileSync(join(SRC_ROOT, "features/targets/TargetsScreen.tsx"), "utf8");
    expect(content).toContain("deletes the credential stored on this computer");
    expect(content).toMatch(/still lists this device as paired until you revoke\s+it there/);
  });

  it("renders the pair command only through the model helper and keeps the grant diff", () => {
    const content = readFileSync(join(SRC_ROOT, "features/targets/TargetsScreen.tsx"), "utf8");
    // The copyable command comes from pairCommandForTarget's catalog
    // constants; the screen never assembles it from target fields.
    expect(content).toContain("pairCommandForTarget(requested)");
    expect(content).not.toContain("omp appserver pair");
    expect(content).toContain("<CapabilityGrantSummary");
  });

  it("routes the browser fixture store only through the browser branch", () => {
    const instance = readFileSync(join(SRC_ROOT, "state/settings-instance.ts"), "utf8");
    expect(instance).toMatch(/fixtureSettingsStore/);
    const live = readFileSync(join(SRC_ROOT, "features/settings/LiveSettingsScreen.tsx"), "utf8");
    expect(live).not.toMatch(/settings-instance/);
    expect(live).not.toMatch(/SETTINGS_CATALOG_FIXTURE/);
  });
});
