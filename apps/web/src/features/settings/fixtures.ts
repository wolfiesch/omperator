// Deterministic settings fixtures. One catalog exercises every control kind
// and every row state the workspace can render: default, inherited,
// overridden (session and CLI), invalid, restart-required, unavailable,
// sensitive (set / missing / expired secrets), nested, and an unsupported
// vNext control. Values mirror real OMP settings so screenshots read true.
// The fixture controller is the deterministic stand-in for `settings.write`.
import type {
  SettingMetadata,
  SettingsCatalogMetadata,
  SettingsChange,
  SettingsController,
  SettingsSaveRequest,
  SettingsSaveResult,
} from "./schema.ts";

export const SETTINGS_SECTIONS_FIXTURE = [
  { id: "general", label: "General", summary: "Startup, sessions, and everyday behavior.", group: "fixture", groups: ["Basics", "More"] },
  { id: "appearance", label: "Appearance", summary: "Theme, type size, and motion.", group: "fixture", groups: ["Basics", "More"] },
  { id: "models", label: "Models & Providers", summary: "Model routing and provider credentials.", group: "fixture", groups: ["Basics", "More"] },
  { id: "roles", label: "Roles", summary: "Which model handles each kind of work.", group: "fixture", groups: ["Basics", "More"] },
  { id: "tools", label: "Tools & Discovery", summary: "Tool access, timeouts, and lookup.", group: "fixture", groups: ["Basics", "More"] },
  { id: "mcp", label: "MCP", summary: "Model Context Protocol servers.", group: "fixture", groups: ["Basics", "More"] },
  { id: "extensions", label: "Extensions", summary: "Installed extensions and how they update.", group: "fixture", groups: ["Basics", "More"] },
  { id: "agents", label: "Agents & Skills", summary: "Subagent limits and skill loading.", group: "fixture", groups: ["Basics", "More"] },
  { id: "memory", label: "Memory", summary: "Long-term memory storage and retention.", group: "fixture", groups: ["Basics", "More"] },
  { id: "keybindings", label: "Keybindings", summary: "Shortcut profiles and custom bindings.", group: "fixture", groups: ["Basics", "More"] },
  { id: "notifications", label: "Notifications", summary: "When and how the app interrupts you.", group: "fixture", groups: ["Basics", "More"] },
  { id: "speech", label: "Speech", summary: "Voice input and read-aloud output.", group: "fixture", groups: ["Basics", "More"] },
  { id: "browser", label: "Browser", summary: "The browser OMP drives for web tasks.", group: "fixture", groups: ["Basics", "More"] },
  { id: "terminal", label: "Terminal", summary: "Your terminal inside sessions.", group: "fixture", groups: ["Basics", "More"] },
  { id: "remote-hosts", label: "Remote Hosts", summary: "Machines this app can pair with.", group: "fixture", groups: ["Basics", "More"] },
  { id: "diagnostics", label: "Diagnostics", summary: "Logs, health checks, and exports.", group: "fixture", groups: ["Basics", "More"] },
] as const;

const SETTINGS_FIXTURE_ROWS: readonly SettingMetadata[] = [
  // ── General ──────────────────────────────────────────────────────────────
  {
    id: "session.autoResume",
    section: "general",
    sectionGroup: "Basics",
    label: "Resume last session",
    help: "Reopen the most recent session for a project when you return to it, instead of starting fresh.",
    control: { kind: "boolean" },
    default: false,
  },
  {
    id: "editor.command",
    section: "general",
    sectionGroup: "More",
    label: "External editor",
    help: "Command used to open files outside the app. The file path is appended to whatever you enter here.",
    control: { kind: "text", placeholder: "code --wait" },
    default: "",
    layers: {
      global: { value: "zed", sourcePath: "~/.omp/config.yml" },
      project: { value: "code --wait", sourcePath: ".omp/config.yml" },
    },
  },
  {
    id: "power.sleepPrevention",
    section: "general",
    sectionGroup: "Basics",
    label: "Keep the machine awake",
    help: "Stop the computer from sleeping while a session is running. Each level includes the ones before it.",
    control: {
      kind: "enum",
      options: [
        { value: "off", label: "Off" },
        { value: "idle", label: "While a session is open" },
        { value: "display", label: "Also keep the display on" },
        { value: "system", label: "Block all sleep" },
      ],
    },
    default: "idle",
    unavailable: { reason: "Only available on macOS." },
  },
  // ── Appearance ────────────────────────────────────────────────────────────
  {
    id: "appearance.theme",
    section: "appearance",
    sectionGroup: "Basics",
    label: "Theme",
    help: "Follow the system, or pin the app to light or dark.",
    control: {
      kind: "enum",
      options: [
        { value: "system", label: "System" },
        { value: "light", label: "Light" },
        { value: "dark", label: "Dark" },
      ],
    },
    default: "system",
    layers: { global: { value: "dark", sourcePath: "~/.omp/config.yml" } },
  },
  {
    id: "appearance.fontSize",
    section: "appearance",
    sectionGroup: "More",
    label: "Interface text size",
    help: "Base size in pixels for interface text. Transcript and terminal text scale with it.",
    control: { kind: "number", min: 12, max: 20, step: 1, unit: "px" },
    default: 14,
  },
  {
    id: "statusLine.preset",
    section: "appearance",
    sectionGroup: "Basics",
    label: "Status line layout",
    help: "What the status line under the composer shows.",
    control: {
      kind: "enum",
      options: [
        { value: "minimal", label: "Minimal", help: "Model and path only." },
        { value: "standard", label: "Standard", help: "Adds token counts and cost." },
        { value: "full", label: "Everything", help: "All segments, including cache and timing." },
      ],
    },
    default: "standard",
  },
  // ── Models & Providers ────────────────────────────────────────────────────
  {
    id: "model.default",
    section: "models",
    sectionGroup: "Basics",
    label: "Default model",
    help: "The model new sessions start with. Sessions can switch at any time without changing this.",
    control: {
      kind: "enum",
      options: [
        { value: "claude-fable-5", label: "Claude Fable 5" },
        { value: "gpt-5.6-codex", label: "GPT-5.6 Codex" },
        { value: "kimi-k2.7", label: "Kimi K2.7" },
      ],
    },
    default: "claude-fable-5",
  },
  {
    id: "model.thinkingEffort",
    section: "models",
    sectionGroup: "More",
    label: "Thinking effort",
    help: "How much reasoning the model spends before answering. Higher levels are slower and cost more.",
    control: {
      kind: "enum",
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ],
    },
    default: "medium",
    layers: { global: { value: "high", sourcePath: "~/.omp/config.yml" } },
  },
  {
    id: "provider.openai.apiKey",
    section: "models",
    sectionGroup: "Basics",
    label: "OpenAI API key",
    help: "Read from your keychain when a request needs it.",
    control: { kind: "secret-reference" },
    layers: {
      global: {
        secret: { state: "set", reference: "keychain:omp/openai", source: "~/.omp/auth.json" },
        sourcePath: "~/.omp/auth.json",
      },
    },
  },
  {
    id: "provider.anthropic.apiKey",
    section: "models",
    sectionGroup: "More",
    label: "Anthropic API key",
    help: "No key is configured. Add one with `omp auth login anthropic` in a terminal.",
    control: { kind: "secret-reference" },
    layers: {
      global: {
        secret: { state: "missing", reference: "env:ANTHROPIC_API_KEY", source: "environment" },
      },
    },
  },
  // ── Roles ─────────────────────────────────────────────────────────────────
  {
    id: "role.smol",
    section: "roles",
    sectionGroup: "Basics",
    label: "Quick-task model",
    help: "Handles small, fast work: titles, summaries, and short lookups.",
    control: {
      kind: "enum",
      options: [
        { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
        { value: "kimi-k2.7", label: "Kimi K2.7" },
      ],
    },
    default: "gemini-2.5-flash",
    layers: {
      global: { value: "gemini-2.5-flash", sourcePath: "~/.omp/config.yml" },
      session: { value: "kimi-k2.7", sourcePath: "session override" },
    },
  },
  {
    id: "role.reviewer",
    section: "roles",
    sectionGroup: "More",
    label: "Review model",
    help: "Runs independent review passes over finished work.",
    control: {
      kind: "enum",
      options: [
        { value: "claude-fable-5", label: "Claude Fable 5" },
        { value: "gpt-5.6-codex", label: "GPT-5.6 Codex" },
      ],
    },
    default: "claude-fable-5",
  },
  // ── Tools & Discovery ─────────────────────────────────────────────────────
  {
    id: "tools.allowlist",
    section: "tools",
    sectionGroup: "Basics",
    label: "Always-allowed commands",
    help: "Commands that run without asking. One entry per command name; everything else still prompts.",
    control: { kind: "list", itemLabel: "command", maxItems: 64 },
    default: [],
    layers: { project: { value: ["pnpm", "git", "cargo"], sourcePath: ".omp/config.yml" } },
  },
  {
    id: "tools.discovery",
    section: "tools",
    sectionGroup: "More",
    label: "Discover project tools",
    help: "Scan the project for runnable scripts and test commands when a session starts.",
    control: { kind: "boolean" },
    default: true,
    restartRequired: true,
  },
  {
    id: "bash.timeout",
    section: "tools",
    sectionGroup: "Basics",
    label: "Command timeout",
    help: "How long a shell command may run before it is stopped.",
    control: { kind: "duration", unit: "s", min: 10, max: 3600 },
    default: 120,
  },
  // ── MCP ───────────────────────────────────────────────────────────────────
  {
    id: "mcp.registry",
    section: "mcp",
    sectionGroup: "Basics",
    label: "Server registry",
    help: "Where the app looks up available MCP servers.",
    control: { kind: "text", placeholder: "https://…" },
    default: "https://registry.modelcontextprotocol.io",
    layers: { global: { value: "htp://registry.local", sourcePath: "~/.omp/config.yml" } },
    invalid: { message: "This isn't a valid URL. Check the address and save again." },
  },
  {
    id: "mcp.autostart",
    section: "mcp",
    sectionGroup: "More",
    label: "Start servers with sessions",
    help: "Launch configured MCP servers automatically when a session that uses them opens.",
    control: { kind: "boolean" },
    default: true,
  },
  // ── Extensions ────────────────────────────────────────────────────────────
  {
    id: "extensions.dir",
    section: "extensions",
    sectionGroup: "Basics",
    label: "Extensions folder",
    help: "Where installed extensions live on this machine.",
    control: { kind: "path", target: "directory" },
    default: "~/.omp/extensions",
  },
  {
    id: "extensions.autoUpdate",
    section: "extensions",
    sectionGroup: "More",
    label: "Update extensions automatically",
    help: "Check for extension updates daily and install them in the background.",
    control: { kind: "boolean" },
    default: true,
  },
  // ── Agents & Skills ───────────────────────────────────────────────────────
  {
    id: "agents.maxConcurrent",
    section: "agents",
    sectionGroup: "Basics",
    label: "Parallel subagents",
    help: "The most subagents one session may run at the same time.",
    control: { kind: "number", min: 1, max: 16, step: 1 },
    default: 4,
  },
  {
    id: "agents.defaults",
    section: "agents",
    sectionGroup: "More",
    label: "Subagent defaults",
    help: "Starting configuration for every spawned subagent. Individual tasks can still override these.",
    control: {
      kind: "nested",
      children: [
        {
          id: "agents.defaults.model",
          section: "agents",
          sectionGroup: "Basics",
          label: "Model",
          help: "Model subagents start with unless the task names one.",
          control: {
            kind: "enum",
            options: [
              { value: "inherit", label: "Same as the session" },
              { value: "gpt-5.6-codex", label: "GPT-5.6 Codex" },
            ],
          },
          default: "inherit",
        },
        {
          id: "agents.defaults.timeout",
          section: "agents",
          sectionGroup: "More",
          label: "Time limit",
          help: "A subagent past this limit is asked to wrap up.",
          control: { kind: "duration", unit: "m", min: 1, max: 240 },
          default: 30,
        },
      ],
    },
  },
  {
    id: "skills.autoload",
    section: "agents",
    sectionGroup: "Basics",
    label: "Load matching skills",
    help: "When a task matches an installed skill, load it without asking.",
    control: { kind: "boolean" },
    default: true,
  },
  // ── Memory ────────────────────────────────────────────────────────────────
  {
    id: "memory.enabled",
    section: "memory",
    sectionGroup: "Basics",
    label: "Long-term memory",
    help: "Keep durable facts, decisions, and preferences across sessions.",
    control: { kind: "boolean" },
    default: true,
    layers: {
      global: { value: true, sourcePath: "~/.omp/config.yml" },
      cli: { value: false, sourcePath: "--no-memory" },
    },
  },
  {
    id: "memory.dbPath",
    section: "memory",
    sectionGroup: "More",
    label: "Memory database",
    help: "File that stores long-term memory for this machine.",
    control: { kind: "path", target: "file" },
    default: "~/.omp/memory.db",
  },
  {
    id: "memory.retention",
    section: "memory",
    sectionGroup: "Basics",
    label: "Keep unused memories for",
    help: "Memories not recalled within this window are archived.",
    control: { kind: "duration", unit: "m", min: 1440, max: 525600 },
    default: 129600,
  },
  // ── Keybindings ───────────────────────────────────────────────────────────
  {
    id: "keybindings.profile",
    section: "keybindings",
    sectionGroup: "Basics",
    label: "Shortcut profile",
    help: "The base set of keyboard shortcuts. Custom bindings below win over the profile.",
    control: {
      kind: "enum",
      options: [
        { value: "default", label: "OMP defaults" },
        { value: "vim", label: "Vim-style" },
        { value: "emacs", label: "Emacs-style" },
      ],
    },
    default: "default",
  },
  {
    id: "keybindings.custom",
    section: "keybindings",
    sectionGroup: "More",
    label: "Custom bindings",
    help: "Action names paired with the shortcut that triggers them.",
    control: { kind: "map", keyLabel: "action", valueLabel: "shortcut" },
    default: {},
    layers: {
      global: { value: { "session.new": "mod+n", "palette.open": "mod+k" }, sourcePath: "~/.omp/config.yml" },
    },
  },
  // ── Notifications ─────────────────────────────────────────────────────────
  {
    id: "notifications.level",
    section: "notifications",
    sectionGroup: "Basics",
    label: "Notify me about",
    help: "Which events raise a system notification when the window is in the background.",
    control: {
      kind: "enum",
      options: [
        { value: "none", label: "Nothing" },
        { value: "attention", label: "Needs my input", help: "Approvals, questions, and errors." },
        { value: "all", label: "Every finished task" },
      ],
    },
    default: "attention",
  },
  {
    id: "notifications.sound",
    section: "notifications",
    sectionGroup: "More",
    label: "Play a sound",
    help: "A short tone alongside each notification.",
    control: { kind: "boolean" },
    default: false,
  },
  // ── Speech ────────────────────────────────────────────────────────────────
  {
    id: "speech.voiceInput",
    section: "speech",
    sectionGroup: "Basics",
    label: "Voice input",
    help: "Hold the microphone shortcut to dictate into the composer.",
    control: { kind: "boolean" },
    default: false,
  },
  {
    id: "speech.voice",
    section: "speech",
    sectionGroup: "More",
    label: "Read-aloud voice",
    help: "Kokoro voice used when replies are read aloud. Sound plays on the computer running the session.",
    control: {
      kind: "enum",
      options: [
        { value: "af_heart", label: "Heart (American female)" },
        { value: "af_nicole", label: "Nicole (American female)" },
        { value: "am_michael", label: "Michael (American male)" },
        { value: "bf_emma", label: "Emma (British female)" },
        { value: "bm_george", label: "George (British male)" },
      ],
    },
    default: "af_heart",
  },
  {
    id: "speech.xai.apiKey",
    section: "speech",
    sectionGroup: "Basics",
    label: "xAI API key",
    help: "Used by Grok Voice speech synthesis. The stored key has expired; run `omp auth login xai` in a terminal to refresh it.",
    control: { kind: "secret-reference" },
    layers: {
      global: {
        secret: { state: "expired", reference: "keychain:omp/xai", source: "~/.omp/auth.json" },
        sourcePath: "~/.omp/auth.json",
      },
    },
  },
  // ── Browser ───────────────────────────────────────────────────────────────
  {
    id: "browser.executable",
    section: "browser",
    sectionGroup: "Basics",
    label: "Browser binary",
    help: "The browser OMP launches for web tasks. Leave empty to use the bundled one.",
    control: { kind: "path", target: "file" },
    default: "",
  },
  {
    id: "browser.headless",
    section: "browser",
    sectionGroup: "More",
    label: "Run without a window",
    help: "Keep browser work invisible. Turn this off to watch pages as the agent drives them.",
    control: { kind: "boolean" },
    default: true,
    layers: {
      session: { value: false, sourcePath: "session override" },
    },
  },
  // ── Terminal ──────────────────────────────────────────────────────────────
  {
    id: "terminal.scrollback",
    section: "terminal",
    sectionGroup: "Basics",
    label: "Scrollback lines",
    help: "Lines each terminal keeps in memory. Larger values use more memory per open terminal.",
    control: { kind: "number", min: 1000, max: 100000, step: 1000 },
    default: 10000,
    restartRequired: true,
  },
  {
    id: "terminal.shell",
    section: "terminal",
    sectionGroup: "More",
    label: "Shell",
    help: "Shell for new terminals. Leave empty to use your login shell.",
    control: { kind: "text", placeholder: "/bin/bash" },
    default: "",
  },
  {
    id: "terminal.env",
    section: "terminal",
    sectionGroup: "Basics",
    label: "Extra environment",
    help: "Variables added to every terminal this app opens.",
    control: { kind: "map", keyLabel: "variable", valueLabel: "value" },
    default: {},
    layers: { project: { value: { NODE_ENV: "development" }, sourcePath: ".omp/config.yml" } },
  },
  // ── Remote Hosts ──────────────────────────────────────────────────────────
  {
    id: "remote.connectTimeout",
    section: "remote-hosts",
    sectionGroup: "Basics",
    label: "Connection timeout",
    help: "How long to wait for a host before reporting it unreachable.",
    control: { kind: "duration", unit: "s", min: 5, max: 120 },
    default: 15,
  },
  {
    id: "remote.knownHosts",
    section: "remote-hosts",
    sectionGroup: "More",
    label: "Known hosts",
    help: "Hosts this app has paired with. Remove one to require pairing again.",
    control: { kind: "list", itemLabel: "host", maxItems: 32 },
    default: [],
    layers: { global: { value: ["build-linux", "studio-mac"], sourcePath: "~/.omp/hosts.yml" } },
  },
  // ── Diagnostics ───────────────────────────────────────────────────────────
  {
    id: "diagnostics.verboseLogs",
    section: "diagnostics",
    sectionGroup: "Basics",
    label: "Verbose logging",
    help: "Write detailed logs for troubleshooting. Slows things down slightly; leave off unless asked.",
    control: { kind: "boolean" },
    default: false,
  },
  {
    id: "diagnostics.logDir",
    section: "diagnostics",
    sectionGroup: "More",
    label: "Log folder",
    help: "Where log files are written on this machine.",
    control: { kind: "path", target: "directory" },
    default: "~/.omp/logs",
  },
  {
    id: "diagnostics.samplingMatrix",
    section: "diagnostics",
    sectionGroup: "Basics",
    label: "Sampling matrix",
    help: "Arrived from a newer OMP release. You can manage it with `omp config` in a terminal.",
    control: { kind: "sampling-matrix" },
  },
];

export const SETTINGS_CATALOG_FIXTURE: SettingsCatalogMetadata = {
  revision: "rev-7",
  hostId: "host-build-linux",
  hostLabel: "build-linux",
  groups: [{ id: "fixture", label: "Fixture", summary: "Deterministic catalog used by tests and the dev harness." }],
  sections: SETTINGS_SECTIONS_FIXTURE,
  settings: SETTINGS_FIXTURE_ROWS,
};

// ─── Applying changes (fixture stand-in for the appserver) ─────────────────

function applyToRows(
  rows: readonly SettingMetadata[],
  changes: readonly SettingsChange[],
): readonly SettingMetadata[] {
  return rows.map((row) => {
    const control = row.control;
    if (control.kind === "nested" && "children" in control) {
      return {
        ...row,
        control: { ...control, children: applyToRows(control.children, changes) },
      };
    }
    const change = changes.find((entry) => entry.id === row.id);
    if (change === undefined) return row;
    const layers = { ...row.layers };
    if (change.action === "clear" || change.value === undefined) {
      delete layers[change.scope];
    } else {
      layers[change.scope] = { ...layers[change.scope], value: change.value };
    }
    return { ...row, layers };
  });
}

export function applyChangesToCatalog(
  catalog: SettingsCatalogMetadata,
  changes: readonly SettingsChange[],
  nextRevision: string,
): SettingsCatalogMetadata {
  return { ...catalog, revision: nextRevision, settings: applyToRows(catalog.settings, changes) };
}

/** The catalog after someone else changed the theme on the host. */
export const SETTINGS_CATALOG_REVISED_FIXTURE: SettingsCatalogMetadata = applyChangesToCatalog(
  SETTINGS_CATALOG_FIXTURE,
  [{ id: "appearance.theme", scope: "global", action: "set", value: "light" }],
  "rev-8",
);

// ─── Fixture controller ────────────────────────────────────────────────────

export interface FixtureControllerOptions {
  /** First save reports an external revision conflict instead of applying. */
  readonly conflictOnFirstSave?: boolean;
  /** Reject every save with this message (validation failure path). */
  readonly rejectWith?: string;
}

export function createFixtureSettingsController(
  options: FixtureControllerOptions = {},
): SettingsController {
  let catalog = SETTINGS_CATALOG_FIXTURE;
  let saves = 0;
  return {
    save(request: SettingsSaveRequest): Promise<SettingsSaveResult> {
      saves += 1;
      if (options.rejectWith !== undefined) {
        return Promise.resolve({ outcome: "rejected", message: options.rejectWith });
      }
      if (options.conflictOnFirstSave === true && saves === 1) {
        catalog = SETTINGS_CATALOG_REVISED_FIXTURE;
        return Promise.resolve({ outcome: "conflict", catalog });
      }
      if (request.revision !== catalog.revision) {
        return Promise.resolve({ outcome: "conflict", catalog });
      }
      catalog = applyChangesToCatalog(catalog, request.changes, `${catalog.revision}-s${saves}`);
      return Promise.resolve({ outcome: "applied", catalog });
    },
  };
}
