// Rendered contract for the friendly model-routing presentation: the roles
// and task-agent editors lead with friendly model/provider/role/agent names,
// keep the raw selectors and ids visible as mono metadata, normalize the
// default alias display to @default while legacy pi/default stays stored,
// keep save payloads byte-identical, surface friendly and raw forms in
// search, and give controls clear accessible names. Everything renders over
// the real live-built catalog and settings store.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { CatalogFrame, SettingsFrame } from "@t4-code/protocol";

import { applyChangesToCatalog } from "../src/features/settings/fixtures.ts";
import {
  agentChoicesFromCatalog,
  buildLiveSettingsCatalog,
  modelChoicesFromCatalog,
} from "../src/features/settings/live-catalog.ts";
import { ModelRolesBlock } from "../src/features/settings/ModelRolesBlock.tsx";
import { recordValue } from "../src/features/settings/roles-model.ts";
import type {
  SettingsCatalogMetadata,
  SettingsController,
  SettingsSaveRequest,
  SettingsSaveResult,
} from "../src/features/settings/schema.ts";
import {
  modelRoutingSearchText,
  roleTagsFromFrames,
} from "../src/features/settings/settings-presentation.ts";
import { createSettingsStore } from "../src/features/settings/settings-store.ts";
import { TaskAgentsBlock } from "../src/features/settings/TaskAgentsBlock.tsx";
import { filterSections } from "../src/features/settings/view-model.ts";

// ─── Wire-shaped fixtures ───────────────────────────────────────────────────

function settingItem(path: string, metadata: Record<string, unknown>): Record<string, unknown> {
  return { id: `setting:${path}`, kind: "setting", name: path, metadata: { path, ...metadata } };
}

const ROLES = {
  default: "anthropic/claude-fable-5:high",
  slow: "pi/default",
  task: "openrouter/moonshotai/kimi-k2.7",
};

const ITEMS = [
  settingItem("modelRoles", {
    label: "Model roles",
    controlType: "record",
    effective: ROLES,
    effectiveSource: "global",
    configured: true,
    sensitive: false,
    tab: "model",
  }),
  settingItem("cycleOrder", {
    label: "Quick-switch cycle",
    controlType: "array",
    effective: ["smol", "default", "review"],
    effectiveSource: "global",
    configured: true,
    sensitive: false,
    tab: "model",
  }),
  settingItem("task.agentModelOverrides", {
    label: "Agent model overrides",
    controlType: "record",
    effective: { "gemini-executor": "google/gemini-3-pro" },
    effectiveSource: "global",
    configured: true,
    sensitive: false,
    tab: "tasks",
  }),
  settingItem("task.disabledAgents", {
    label: "Disabled agents",
    controlType: "array",
    effective: ["scribe"],
    effectiveSource: "global",
    configured: true,
    sensitive: false,
    tab: "tasks",
  }),
  {
    id: "model:anthropic/claude-fable-5",
    kind: "model",
    name: "Claude Fable 5",
    metadata: { provider: "anthropic", modelId: "claude-fable-5", contextWindow: 200_000 },
  },
  {
    id: "agent:gemini-executor",
    kind: "agent",
    name: "gemini-executor",
    description: "Runs delegated Gemini tasks.",
  },
];

// Test seam: fixture frames are hand-built rather than wire-decoded.
const CATALOG_FRAME = {
  v: "omp-app/1",
  type: "catalog",
  hostId: "host-1",
  revision: "rev-1",
  items: ITEMS,
} as unknown as CatalogFrame;
const SETTINGS_FRAME = {
  v: "omp-app/1",
  type: "settings",
  hostId: "host-1",
  revision: "rev-1",
  settings: { modelTags: { effective: { review: { name: "Reviewer", color: "accent" } } } },
} as unknown as SettingsFrame;

function localController(
  getCatalog: () => SettingsCatalogMetadata,
  apply: (next: SettingsCatalogMetadata) => void,
): SettingsController {
  let saves = 0;
  return {
    save(request: SettingsSaveRequest): Promise<SettingsSaveResult> {
      saves += 1;
      const catalog = getCatalog();
      if (request.revision !== catalog.revision) return Promise.resolve({ outcome: "conflict", catalog });
      const next = applyChangesToCatalog(catalog, request.changes, `${catalog.revision}-s${saves}`);
      apply(next);
      return Promise.resolve({ outcome: "applied", catalog: next });
    },
  };
}

function builtFixture() {
  const built = buildLiveSettingsCatalog({
    catalog: CATALOG_FRAME,
    settings: SETTINGS_FRAME,
    hostLabel: "build-linux",
  });
  expect(built.issues).toEqual([]);
  let catalog = built.catalog;
  const store = createSettingsStore(
    catalog,
    localController(
      () => catalog,
      (next) => {
        catalog = next;
      },
    ),
  );
  return {
    store,
    models: modelChoicesFromCatalog(CATALOG_FRAME),
    agents: agentChoicesFromCatalog(CATALOG_FRAME),
    roleTags: roleTagsFromFrames(CATALOG_FRAME, SETTINGS_FRAME),
    saved: () => catalog,
  };
}

// ─── Model roles ─────────────────────────────────────────────────────────────

describe("ModelRolesBlock presentation", () => {
  const { store, models, roleTags } = builtFixture();
  const markup = renderToStaticMarkup(
    <ModelRolesBlock api={store} hostLabel="build-linux" models={models} roleTags={roleTags} />,
  );

  it("leads with the catalog label and friendly provider; the raw selector stays as mono metadata", () => {
    expect(markup).toContain("Claude Fable 5");
    expect(markup).toContain("Anthropic");
    expect(markup).toContain("anthropic/claude-fable-5");
    // Thinking suffix renders as a badge, and the stored selector survives in tooltips.
    expect(markup).toContain(">high<");
    expect(markup).toContain('title="anthropic/claude-fable-5:high"');
  });

  it("humanizes a catalog miss deterministically and keeps its raw selector visible", () => {
    expect(markup).toContain("Kimi K2.7");
    expect(markup).toContain("OpenRouter");
    expect(markup).toContain("openrouter/moonshotai/kimi-k2.7");
  });

  it("shows the legacy pi/default alias as @default with the stored form in the tooltip", () => {
    expect(markup).toContain("@default");
    expect(markup).toContain("Follows Default");
    expect(markup).toContain('title="pi/default"');
    // Presentation only: the raw legacy spelling is not shown as the primary value.
    expect(markup).not.toContain(">pi/default<");
  });

  it("names custom roles from modelTags and keeps clear accessible names on cycle controls", () => {
    expect(markup).toContain("Reviewer");
    expect(markup).toContain('aria-label="Move Fast earlier in the cycle"');
    expect(markup).toContain('aria-label="Remove Reviewer from the cycle"');
    expect(markup).toContain('aria-label="Clear the model for Subtask"');
  });
});

describe("save payloads stay byte-identical under friendly presentation", () => {
  it("round-trips the legacy alias and raw selectors unchanged through a save", async () => {
    const { store, saved } = builtFixture();
    const row = store.getState().viewModel.rowsById.get("modelRoles");
    expect(row).toBeDefined();
    const current = recordValue(row?.effective?.value);
    expect(current).not.toBeNull();
    if (current === null) return;
    store.getState().stageValue("modelRoles", { ...current });
    await store.getState().save();
    const persisted = saved().settings.find((setting) => setting.id === "modelRoles");
    expect(persisted?.layers?.global?.value).toEqual(ROLES);
  });
  it("preserves canonical @role aliases exactly when staged and saved", async () => {
    const { store, saved } = builtFixture();
    store.getState().stageValue("modelRoles", { ...ROLES, review: "@review" });
    await store.getState().save();
    const persisted = saved().settings.find((setting) => setting.id === "modelRoles");
    expect(persisted?.layers?.global?.value).toEqual({ ...ROLES, review: "@review" });
  });
});

// ─── Task agents ─────────────────────────────────────────────────────────────

describe("TaskAgentsBlock presentation", () => {
  const { store, models, agents } = builtFixture();
  const markup = renderToStaticMarkup(
    <TaskAgentsBlock agents={agents} api={store} hostLabel="build-linux" models={models} />,
  );

  it("humanizes agent ids while the configured id stays visible as mono metadata", () => {
    expect(markup).toContain("Gemini Executor");
    expect(markup).toContain(">gemini-executor<");
    expect(markup).toContain("Scribe");
    expect(markup).toContain(">scribe<");
  });

  it("shows a friendly single-override model beside its raw selector", () => {
    expect(markup).toContain("Gemini 3 Pro");
    expect(markup).toContain("google/gemini-3-pro");
  });

  it("gives switches and clear buttons friendly accessible names", () => {
    expect(markup).toContain('aria-label="Gemini Executor enabled"');
    expect(markup).toContain('aria-label="Clear the model override for Gemini Executor"');
  });
});

// ─── Search ──────────────────────────────────────────────────────────────────

describe("settings search over friendly and raw routing forms", () => {
  const { store, models, agents, roleTags } = builtFixture();
  const sections = store.getState().viewModel.sections;
  const search = (query: string) => {
    const text = modelRoutingSearchText({
      roles: ROLES,
      cycle: ["smol", "default", "review"],
      overrides: { "gemini-executor": "google/gemini-3-pro" },
      disabledAgents: ["scribe"],
      models,
      agentNames: agents.agents.map((agent) => agent.name),
      tags: roleTags,
    });
    const extra = new Map([
      ["modelRoles", text.roles],
      ["cycleOrder", text.cycle],
      ["task.agentModelOverrides", text.overrides],
      ["task.disabledAgents", text.disabled],
    ]);
    return filterSections(sections, query, extra).map((section) => section.id);
  };

  it("matches friendly model, provider, alias, role, and agent names", () => {
    expect(search("Claude Fable")).toContain("agent/models");
    expect(search("Anthropic")).toContain("agent/models");
    expect(search("@default")).toContain("agent/models");
    expect(search("Reviewer")).toContain("agent/models");
    expect(search("Gemini Executor")).toContain("agent/subagents");
  });

  it("still matches the raw stored forms", () => {
    expect(search("anthropic/claude-fable-5")).toContain("agent/models");
    expect(search("pi/default")).toContain("agent/models");
    expect(search("gemini-executor")).toContain("agent/subagents");
    expect(search("google/gemini-3-pro")).toContain("agent/subagents");
  });

  it("does not match nonsense", () => {
    expect(search("zzz-not-a-model")).toEqual([]);
  });
});
