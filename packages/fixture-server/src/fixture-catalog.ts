import { COMMAND_DESCRIPTORS, DESKTOP_CATALOG_COMMANDS } from "@t4-code/protocol";

const FIXTURE_CYCLE_ROLES = Array.from({ length: 12 }, (_, index) =>
  index === 0 ? "default" : `cycle-${String(index + 1).padStart(2, "0")}`,
);

/** A production-shaped profile large enough to exercise phone popup scrolling. */
export function fixtureSettings(): Record<string, unknown> {
  const modelRoles = Object.fromEntries(
    FIXTURE_CYCLE_ROLES.map((role, index) => [
      role,
      `fixture/model-${String(index + 1).padStart(3, "0")}`,
    ]),
  );
  const modelTags = Object.fromEntries(
    FIXTURE_CYCLE_ROLES.map((role, index) => [
      role,
      { name: `Fixture ${String(index + 1).padStart(2, "0")}` },
    ]),
  );
  return {
    cycleOrder: { effective: FIXTURE_CYCLE_ROLES, configured: true },
    modelRoles: { effective: modelRoles, configured: true },
    modelTags: { effective: modelTags, configured: true },
    defaultThinkingLevel: { effective: "medium", configured: true },
    "session.autoResume": {
      effective: true,
      effectiveSource: "global",
      configured: true,
    },
    "general.maxRetries": {
      effective: 3,
      effectiveSource: "default",
      configured: false,
      default: 3,
    },
    "appearance.mode": {
      effective: "system",
      effectiveSource: "global",
      configured: true,
      default: "system",
    },
    "shell.envAllowlist": {
      effective: ["TERM", "LANG"],
      effectiveSource: "global",
      configured: true,
      default: [],
    },
    "tools.aliases": {
      effective: { qa: "quality-assurance" },
      effectiveSource: "session",
      configured: true,
      default: {},
    },
    "provider.apiKey": { configured: true, sensitive: true },
    "preview.experimental": {
      effective: false,
      effectiveSource: "default",
      configured: false,
      default: false,
      availability: false,
    },
  };
}

/** Mirrors tonight's live ratio: a short Ctrl-P cycle over a much larger catalog. */
export function fixtureCatalogItems(): Record<string, unknown>[] {
  const commands = DESKTOP_CATALOG_COMMANDS.map((name) => {
    const descriptor = COMMAND_DESCRIPTORS[name];
    if (descriptor === undefined) throw new Error(`desktop catalog command has no descriptor: ${name}`);
    return {
      id: `cmd-${name.replaceAll(".", "-")}`,
      kind: "command",
      name,
      description: `${name} fixture command`,
      capabilities: [descriptor.capability],
      supported: true,
    };
  });
  const models = Array.from({ length: 184 }, (_, index) => {
    const ordinal = String(index + 1).padStart(3, "0");
    return {
      id: `model-fixture-${ordinal}`,
      kind: "model",
      name: `Fixture model ${ordinal}`,
      metadata: { provider: "fixture", modelId: `model-${ordinal}` },
      supported: true,
    };
  });
  const modes = FIXTURE_CYCLE_ROLES.map((role, index) => ({
    id: `mode-role-${role}`,
    kind: "mode",
    name: role,
    description: `Fixture ${String(index + 1).padStart(2, "0")}`,
    metadata: {
      role,
      modelId: `fixture/model-${String(index + 1).padStart(3, "0")}`,
      cycle: true,
      cycleIndex: index,
    },
  }));
  const settings = [
    {
      id: "setting-session-auto-resume",
      kind: "setting",
      name: "session.autoResume",
      metadata: {
        path: "session.autoResume",
        label: "Resume sessions automatically",
        description: "Reconnect active sessions when this client returns to the foreground.",
        controlType: "boolean",
        scopes: ["global", "session"],
        tab: "general",
        group: "lifecycle",
      },
    },
    {
      id: "setting-general-max-retries",
      kind: "setting",
      name: "general.maxRetries",
      metadata: {
        path: "general.maxRetries",
        label: "Retry limit",
        description: "Maximum reconnect attempts before the runtime waits for manual action.",
        controlType: "number",
        min: 0,
        max: 12,
        step: 1,
        scopes: ["global"],
        tab: "general",
        group: "lifecycle",
      },
    },
    {
      id: "setting-appearance-mode",
      kind: "setting",
      name: "appearance.mode",
      metadata: {
        path: "appearance.mode",
        label: "Runtime appearance",
        description: "Appearance used by OMP-owned surfaces.",
        controlType: "enum",
        options: ["system", "light", "dark"],
        scopes: ["global"],
        restartRequired: true,
        tab: "appearance",
        group: "display",
      },
    },
    {
      id: "setting-shell-env-allowlist",
      kind: "setting",
      name: "shell.envAllowlist",
      metadata: {
        path: "shell.envAllowlist",
        label: "Environment allowlist",
        description: "Environment names OMP may pass to shell tools.",
        controlType: "array",
        maxItems: 16,
        scopes: ["global", "session"],
        tab: "shell",
        group: "environment",
      },
    },
    {
      id: "setting-tools-aliases",
      kind: "setting",
      name: "tools.aliases",
      metadata: {
        path: "tools.aliases",
        label: "Tool aliases",
        description: "Short names mapped to canonical tool identifiers.",
        controlType: "record",
        maxEntries: 16,
        scopes: ["global", "session"],
        tab: "tools",
        group: "routing",
      },
    },
    {
      id: "setting-provider-api-key",
      kind: "setting",
      name: "provider.apiKey",
      metadata: {
        path: "provider.apiKey",
        label: "Provider API key",
        description: "Managed by the host. This app can see status, never the value.",
        controlType: "string",
        scopes: ["global"],
        sensitive: true,
        tab: "providers",
        group: "credentials",
      },
    },
    {
      id: "setting-preview-experimental",
      kind: "setting",
      name: "preview.experimental",
      metadata: {
        path: "preview.experimental",
        label: "Experimental preview",
        description: "Unavailable in this deterministic fixture.",
        controlType: "boolean",
        scopes: ["global"],
        availability: false,
        tab: "appearance",
        group: "preview",
      },
    },
  ];
  return [...commands, ...models, ...modes, ...settings];
}
