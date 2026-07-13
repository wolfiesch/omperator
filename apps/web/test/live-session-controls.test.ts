// Composer session controls against the real DesktopRuntimeController and
// the concrete fake shell: the model/thinking/fast controls derive from live
// host catalog + settings + session state only, control intents leave as
// immediate session commands with exact payloads, reconciliation follows
// server frames (never a local echo), failures surface as bounded errors
// with no rollback needed (the label never lied), and hosts that do not
// offer the commands get honest disabled reasons instead of fake controls.
import { describe, expect, it } from "vite-plus/test";
import {
  catalogId,
  hostId,
  revision,
  sessionId,
  type CatalogFrame,
  type CatalogItem,
  type SessionsFrame,
  type SettingsFrame,
} from "@t4-code/protocol";
import { createDesktopRuntimeController } from "@t4-code/client";

import { createLiveSessionRuntime } from "../src/features/session-runtime/live-runtime.ts";
import type { SessionRuntime } from "../src/features/session-runtime/controller.ts";
import { deferred, FakeShell, makeWelcome } from "./fake-shell.ts";

const V = "omp-app/1" as const;
const HOST = "host-a";
const SESSION = "session-a";

function commandItem(name: string, capabilities?: readonly string[]): CatalogItem {
  return {
    id: catalogId(`cmd-${name}`),
    kind: "command",
    name,
    description: `${name} command`,
    ...(capabilities === undefined ? {} : { capabilities: [...capabilities] }),
  };
}

function modelItem(name: string, provider: string, modelId: string): CatalogItem {
  return {
    id: catalogId(`model-${provider}-${modelId}`),
    kind: "model",
    name,
    metadata: { provider, modelId },
  };
}

function catalogFrame(rev: string, items: CatalogItem[]): CatalogFrame {
  return { v: V, type: "catalog", hostId: hostId(HOST), revision: revision(rev), items };
}

function settingsFrame(rev: string, settings: Record<string, unknown>): SettingsFrame {
  return { v: V, type: "settings", hostId: hostId(HOST), revision: revision(rev), settings };
}

/** The real default-profile shapes: renamed default role, auto thinking. */
const PROFILE_SETTINGS: Record<string, unknown> = {
  modelRoles: {
    effective: {
      default: "anthropic/luna-5.6",
      smol: "google/gemini-3.5-flash:high",
      "Opus 4.6": "anthropic/claude-opus-4-6",
    },
    effectiveSource: "global",
    configured: true,
  },
  cycleOrder: { effective: ["smol", "default", "Opus 4.6"], default: ["smol", "default", "slow"] },
  modelTags: { effective: { default: { name: "Luna 5.6" } } },
  defaultThinkingLevel: { effective: "auto", default: "high" },
};

const CONTROL_COMMANDS = [
  commandItem("session.model.set"),
  commandItem("session.thinking.set"),
  commandItem("session.fast.set"),
];

interface Setup {
  readonly shell: FakeShell;
  readonly runtime: SessionRuntime;
}

async function startedRuntime(options?: {
  readonly items?: CatalogItem[];
  readonly settings?: Record<string, unknown>;
  readonly skipCatalog?: boolean;
}): Promise<Setup> {
  const shell = new FakeShell();
  const controller = createDesktopRuntimeController({ shell });
  await controller.start();
  shell.emitFrame({
    targetId: "local",
    frame: makeWelcome(HOST, ["sessions.prompt", "sessions.manage"]),
  });
  shell.emitFrame({
    targetId: "local",
    frame: {
      v: V,
      type: "snapshot",
      cursor: { epoch: "epoch-1", seq: 1 },
      revision: revision("rev-1"),
      hostId: hostId(HOST),
      sessionId: sessionId(SESSION),
      entries: [],
    },
  });
  if (options?.skipCatalog !== true) {
    shell.emitFrame({
      targetId: "local",
      frame: catalogFrame("rev-cat", options?.items ?? CONTROL_COMMANDS),
    });
    shell.emitFrame({
      targetId: "local",
      frame: settingsFrame("rev-set", options?.settings ?? PROFILE_SETTINGS),
    });
  }
  const runtime = createLiveSessionRuntime({
    controller,
    targetId: "local",
    hostId: HOST,
    sessionId: SESSION,
  });
  return { shell, runtime };
}

function sessionsUpsert(seq: number, extra: Record<string, unknown>): SessionsFrame {
  return {
    v: V,
    type: "sessions",
    cursor: { epoch: "epoch-1", seq },
    sessions: [
      {
        hostId: hostId(HOST),
        sessionId: sessionId(SESSION),
        project: { projectId: "project-1" as SessionsFrame["sessions"][number]["project"]["projectId"] },
        revision: revision("rev-1"),
        title: "Session",
        status: "active",
        updatedAt: "2026-07-12T10:00:00Z",
        ...extra,
      },
    ],
  };
}

describe("defaults from live host settings", () => {
  it("shows the renamed default role and auto thinking before session state arrives", async () => {
    const { runtime } = await startedRuntime();
    const controls = runtime.getSnapshot().controls;
    // modelTags renames default → "Luna 5.6"; the label follows the host.
    expect(controls.modelLabel).toBe("Luna 5.6");
    expect(controls.modelSelectedId).toBe("role:default");
    expect(controls.thinking).toBe("auto");
    expect(controls.fast).toBe(false);
    expect(controls.modelSupported).toBe(true);
    expect(controls.thinkingSupported).toBe(true);
    expect(controls.fastSupported).toBe(true);
  });

  it("limits the primary picker to configured Ctrl-P roles in exact cycle order", async () => {
    const { runtime } = await startedRuntime({
      items: [
        ...CONTROL_COMMANDS,
        modelItem("Luna 5.6", "anthropic", "luna-5.6"),
        modelItem("Gemini 3.5 Flash", "google", "gemini-3.5-flash"),
        modelItem("Claude Opus 4.6", "anthropic", "claude-opus-4-6"),
        ...Array.from({ length: 184 }, (_, index) =>
          modelItem(`catalog-${index}`, "catalog", `model-${index}`),
        ),
      ],
    });
    const choices = runtime.getSnapshot().controls.modelChoices;
    expect(choices.map((choice) => choice.id)).toEqual([
      "role:smol",
      "role:default",
      "role:Opus 4.6",
    ]);
    const smol = choices[0];
    expect(smol?.kind).toBe("role");
    expect(smol?.label).toBe("Fast");
    expect(smol?.selector).toBe("google/gemini-3.5-flash:high");
    // Custom cycle-role names keep their exact configured selector.
    const custom = choices[2];
    expect(custom?.label).toBe("Opus 4.6");
    expect(custom?.selector).toBe("anthropic/claude-opus-4-6");
    expect(custom?.detail).toBe("anthropic/claude-opus-4-6");
  });

  it("skips cycle roles that are unconfigured or unavailable to this host", async () => {
    const { runtime } = await startedRuntime({
      items: [
        ...CONTROL_COMMANDS,
        modelItem("Luna 5.6", "anthropic", "luna-5.6"),
        modelItem("Gemini 3.5 Flash", "google", "gemini-3.5-flash"),
      ],
      settings: {
        ...PROFILE_SETTINGS,
        modelRoles: {
          effective: {
            default: "anthropic/luna-5.6",
            smol: "google/gemini-3.5-flash:high",
            "Opus 4.6": "anthropic/not-installed",
          },
        },
        cycleOrder: { effective: ["missing", "Opus 4.6", "smol", "default"] },
      },
    });
    expect(runtime.getSnapshot().controls.modelChoices.map((choice) => choice.id)).toEqual([
      "role:smol",
      "role:default",
    ]);
  });

  it("honors an explicitly empty Ctrl-P cycle instead of exposing the catalog", async () => {
    const { runtime } = await startedRuntime({
      items: [...CONTROL_COMMANDS, modelItem("Luna 5.6", "anthropic", "luna-5.6")],
      settings: { ...PROFILE_SETTINGS, cycleOrder: { effective: [] } },
    });
    expect(runtime.getSnapshot().controls.modelChoices).toEqual([]);
  });

  it("falls back to available catalog models when an older host publishes no cycle settings", async () => {
    const { runtime } = await startedRuntime({
      items: [...CONTROL_COMMANDS, modelItem("gpt-6", "openai", "gpt-6")],
      settings: {},
    });
    expect(runtime.getSnapshot().controls.modelChoices).toEqual([
      {
        id: "model:openai/gpt-6",
        kind: "model",
        label: "gpt-6",
        detail: "openai/gpt-6",
        selector: "openai/gpt-6",
        role: null,
      },
    ]);
  });

  it("offers the full thinking ladder", async () => {
    const { runtime } = await startedRuntime();
    expect(runtime.getSnapshot().controls.thinkingLevels).toEqual([
      "auto",
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});

describe("control commands leave immediately with exact payloads", () => {
  it("setModel sends session.model.set with role/selector and session persistence", async () => {
    const { shell, runtime } = await startedRuntime();
    const roleOutcome = await runtime.submitPrompt({ kind: "setModel", selector: null, role: "smol" });
    expect(roleOutcome.kind).toBe("accepted");
    const roleCommand = shell.commands.find((request) => request.intent.command === "session.model.set");
    expect(roleCommand?.intent.args).toEqual({ role: "smol", persistence: "session" });
    expect(roleCommand?.intent.expectedRevision).toBeDefined();

    await runtime.submitPrompt({ kind: "setModel", selector: "openai/gpt-6", role: null });
    const selectorCommand = shell.commands.findLast(
      (request) => request.intent.command === "session.model.set",
    );
    expect(selectorCommand?.intent.args).toEqual({ selector: "openai/gpt-6", persistence: "session" });

    // The wire takes role XOR selector: a cycle-role pick that also knows
    // its resolved selector still sends only the role.
    await runtime.submitPrompt({
      kind: "setModel",
      selector: "google/gemini-3.5-flash:high",
      role: "smol",
    });
    const bothCommand = shell.commands.findLast(
      (request) => request.intent.command === "session.model.set",
    );
    expect(bothCommand?.intent.args).toEqual({ role: "smol", persistence: "session" });
  });

  it("setThinking sends session.thinking.set with the level", async () => {
    const { shell, runtime } = await startedRuntime();
    await runtime.submitPrompt({ kind: "setThinking", level: "xhigh" });
    const sent = shell.commands.find((request) => request.intent.command === "session.thinking.set");
    expect(sent?.intent.args).toEqual({ level: "xhigh" });
  });

  it("setFast sends session.fast.set with the toggle", async () => {
    const { shell, runtime } = await startedRuntime();
    await runtime.submitPrompt({ kind: "setFast", enabled: true });
    const sent = shell.commands.find((request) => request.intent.command === "session.fast.set");
    expect(sent?.intent.args).toEqual({ enabled: true });
  });

  it("holds the control while in flight and never swaps the label optimistically", async () => {
    const { shell, runtime } = await startedRuntime();
    const gate = deferred<boolean>();
    shell.commandBehavior = { kind: "defer", gate };
    const settled = runtime.submitPrompt({ kind: "setModel", selector: null, role: "smol" });
    const midFlight = runtime.getSnapshot().controls;
    expect(midFlight.pendingControl).toBe("model");
    expect(midFlight.modelLabel).toBe("Luna 5.6"); // still the server's word
    gate.resolve(true);
    await settled;
    const after = runtime.getSnapshot().controls;
    expect(after.pendingControl).toBeNull();
    expect(after.controlError).toBeNull();
    // The label still shows server truth until a frame confirms the switch.
    expect(after.modelLabel).toBe("Luna 5.6");
  });

  it("holds a fast prompt behind an in-flight model revision", async () => {
    const { shell, runtime } = await startedRuntime();
    const gate = deferred<boolean>();
    shell.commandBehavior = { kind: "defer", gate };

    runtime.dispatch({ kind: "setModel", selector: null, role: "smol" });
    const prompt = runtime.submitPrompt({
      kind: "prompt",
      text: "send after the model switch",
      attachments: [],
    });

    expect(runtime.getSnapshot().controls.pendingControl).toBe("model");
    expect(shell.commandCount("session.prompt")).toBe(0);

    gate.resolve(true);
    expect((await prompt).kind).toBe("accepted");
    const commands = shell.commands.map((request) => request.intent.command);
    expect(commands.indexOf("session.model.set")).toBeGreaterThanOrEqual(0);
    expect(commands.indexOf("session.prompt")).toBeGreaterThan(commands.indexOf("session.model.set"));
    expect(runtime.getSnapshot().controls.pendingControl).toBeNull();
  });
});

describe("server reconciliation", () => {
  it("follows session state for model, thinking, and fast from the session index", async () => {
    const { shell, runtime } = await startedRuntime();
    shell.emitFrame({
      targetId: "local",
      frame: sessionsUpsert(2, {
        model: "google/gemini-3.5-flash",
        thinking: "high",
        liveState: { fast: true },
      }),
    });
    const controls = runtime.getSnapshot().controls;
    // Session state beats the settings default and marks the matching role
    // (the :high suffix on the configured selector does not break matching).
    expect(controls.modelSelectedId).toBe("role:smol");
    expect(controls.modelLabel).toBe("Fast · google/gemini-3.5-flash");
    expect(controls.thinking).toBe("high");
    expect(controls.fast).toBe(true);
  });

  it("reads the canonical nested model shape: selector and role inside liveState.model", async () => {
    const { shell, runtime } = await startedRuntime();
    shell.emitFrame({
      targetId: "local",
      frame: sessionsUpsert(2, {
        liveState: {
          model: {
            id: "gemini-3.5-flash",
            provider: "google",
            selector: "google/gemini-3.5-flash:high",
            role: "smol",
          },
          thinking: "high",
          fast: true,
        },
      }),
    });
    const controls = runtime.getSnapshot().controls;
    // model.role wins directly — no selector matching required.
    expect(controls.modelSelectedId).toBe("role:smol");
    expect(controls.modelLabel).toBe("Fast · google/gemini-3.5-flash");
    expect(controls.thinking).toBe("high");
    expect(controls.fast).toBe(true);
  });

  it("a nested displayName is the label verbatim; nested selector beats id/provider", async () => {
    const { shell, runtime } = await startedRuntime();
    shell.emitFrame({
      targetId: "local",
      frame: sessionsUpsert(2, {
        liveState: {
          model: {
            id: "wrong-if-used",
            provider: "wrong",
            selector: "openai/gpt-6",
            displayName: "GPT-6",
          },
        },
      }),
    });
    const controls = runtime.getSnapshot().controls;
    expect(controls.modelLabel).toBe("GPT-6");
    expect(controls.modelSelectedId).toBeNull(); // no matching role or catalog model
  });

  it("keeps the legacy top-level modelRole fallback when the model object has no role", async () => {
    const { shell, runtime } = await startedRuntime();
    shell.emitFrame({
      targetId: "local",
      frame: sessionsUpsert(2, {
        model: "anthropic/luna-5.6",
        liveState: { modelRole: "default" },
      }),
    });
    expect(runtime.getSnapshot().controls.modelSelectedId).toBe("role:default");
  });

  it("a rejected control command sets a bounded error and keeps server truth", async () => {
    const { shell, runtime } = await startedRuntime();
    shell.commandBehavior = { kind: "reject" };
    const outcome = await runtime.submitPrompt({ kind: "setThinking", level: "max" });
    expect(outcome.kind).toBe("rejected");
    const controls = runtime.getSnapshot().controls;
    expect(controls.pendingControl).toBeNull();
    expect(controls.controlError).toBe(
      "The host declined the thinking change. The session keeps its current level.",
    );
    // No rollback needed: the value never left server truth.
    expect(controls.thinking).toBe("auto");

    // The next attempt clears the stale error before it settles.
    shell.commandBehavior = { kind: "accept" };
    await runtime.submitPrompt({ kind: "setThinking", level: "low" });
    expect(runtime.getSnapshot().controls.controlError).toBeNull();
  });

  it("a dead transport surfaces the unknown-outcome copy", async () => {
    const { shell, runtime } = await startedRuntime();
    shell.commandBehavior = { kind: "throw" };
    const outcome = await runtime.submitPrompt({ kind: "setFast", enabled: true });
    expect(outcome.kind).toBe("unknown");
    expect(runtime.getSnapshot().controls.controlError).toBe(
      "The connection dropped before the host answered. The control shows the host's last confirmed value.",
    );
    expect(runtime.getSnapshot().controls.fast).toBe(false);
  });
});

describe("honest unsupported controls", () => {
  it("reports waiting before any catalog arrives and sends nothing", async () => {
    const { shell, runtime } = await startedRuntime({ skipCatalog: true });
    const controls = runtime.getSnapshot().controls;
    expect(controls.modelSupported).toBe(false);
    expect(controls.modelUnsupportedReason).toBe("Waiting for this host's command list");
    const outcome = await runtime.submitPrompt({ kind: "setModel", selector: null, role: "smol" });
    expect(outcome.kind).toBe("rejected");
    expect(shell.commandCount("session.model.set")).toBe(0);
  });

  it("a catalog without the commands disables each control with a reason", async () => {
    const { shell, runtime } = await startedRuntime({ items: [commandItem("session.cancel")] });
    const controls = runtime.getSnapshot().controls;
    expect(controls.modelSupported).toBe(false);
    expect(controls.thinkingSupported).toBe(false);
    expect(controls.fastSupported).toBe(false);
    expect(controls.modelUnsupportedReason).toContain("use the terminal");
    const outcome = await runtime.submitPrompt({ kind: "setFast", enabled: true });
    expect(outcome.kind).toBe("rejected");
    expect(shell.commandCount("session.fast.set")).toBe(0);
  });

  it("a refused catalog item carries the host's own reason", async () => {
    const { runtime } = await startedRuntime({
      items: [
        { ...commandItem("session.model.set"), supported: false, reason: "Model is pinned by policy" },
      ],
    });
    const controls = runtime.getSnapshot().controls;
    expect(controls.modelSupported).toBe(false);
    expect(controls.modelUnsupportedReason).toBe("Model is pinned by policy");
  });

  it("mode and attachments stay off for live hosts until a protocol exists", async () => {
    const { runtime } = await startedRuntime();
    const controls = runtime.getSnapshot().controls;
    expect(controls.modeSupported).toBe(false);
    expect(controls.attachmentsSupported).toBe(false);
    const outcome = await runtime.submitPrompt({ kind: "setMode", mode: "plan" });
    expect(outcome.kind).toBe("rejected");
  });
});
