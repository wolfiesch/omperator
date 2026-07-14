// Composer control truth for one session, derived from live host authority:
// the catalog (which commands and models exist), the settings frames (role
// routing, display names, default thinking), and the session index / warm
// ref (what this session is running right now). Nothing here persists or
// invents state — what the host does not say, the controls do not claim.
import type { CatalogFrame, CatalogItem, SessionRef, SettingsFrame } from "@t4-code/protocol";

import {
  isThinkingLevel,
  THINKING_LEVELS,
  type SessionMode,
  type ThinkingLevel,
} from "./intents.ts";

/** Wire commands the composer's controls ride on. */
export const MODEL_SET_COMMAND = "session.model.set";
export const THINKING_SET_COMMAND = "session.thinking.set";
export const FAST_SET_COMMAND = "session.fast.set";

/** Human names for OMP's built-in model roles (mirrors the TUI's tags). */
const ROLE_LABEL: Readonly<Record<string, string>> = {
  default: "Default",
  smol: "Fast",
  slow: "Thinking",
  vision: "Vision",
  plan: "Architect",
  designer: "Designer",
  commit: "Commit",
  tiny: "Tiny",
  task: "Subtask",
  advisor: "Advisor",
};

export type PendingControl = "model" | "thinking" | "fast";

export interface ModelChoice {
  /** Stable menu id: `role:<roleId>` or `model:<selector>`. */
  readonly id: string;
  readonly kind: "role" | "model";
  readonly label: string;
  readonly detail: string | null;
  /** Concrete `provider/model[:level]` selector when one is known. */
  readonly selector: string | null;
  /** OMP role id when this choice is a cycle role. */
  readonly role: string | null;
}

export interface ComposerControlsSnapshot {
  readonly modelSupported: boolean;
  /** Why model switching is off; null when `modelSupported`. */
  readonly modelUnsupportedReason: string | null;
  /** Current model label, or null while no authority has spoken. */
  readonly modelLabel: string | null;
  /** Menu choice matching the current model; null when none matches. */
  readonly modelSelectedId: string | null;
  readonly modelChoices: readonly ModelChoice[];
  readonly thinkingSupported: boolean;
  readonly thinkingUnsupportedReason: string | null;
  /** Current thinking level (session state, else the host default). */
  readonly thinking: string | null;
  readonly thinkingLevels: readonly ThinkingLevel[];
  readonly fastSupported: boolean;
  readonly fastUnsupportedReason: string | null;
  readonly fast: boolean;
  /** No live protocol exists for mode; only the fixture supports it. */
  readonly modeSupported: boolean;
  readonly mode: SessionMode | null;
  /** The host negotiated the bounded `prompt.images` upload protocol. */
  readonly attachmentsSupported: boolean;
  /** Which control has a command in flight; the UI holds, never lies. */
  readonly pendingControl: PendingControl | null;
  /** Bounded message from the last failed control command. */
  readonly controlError: string | null;
}

// ─── Guarded readers (host shapes are external input) ───────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The current value the settings frame reports for a path: the per-path
 * record's `effective`, else its `default`. Undefined when the frame has
 * nothing well-formed to say.
 */
export function settingCurrentValue(
  settings: SettingsFrame | undefined,
  path: string,
): unknown {
  if (settings === undefined) return undefined;
  const entry = settings.settings[path];
  if (!isRecord(entry)) return undefined;
  return entry.effective !== undefined ? entry.effective : entry.default;
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string" || entry === "") continue;
    out[key] = entry;
  }
  return out;
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) if (typeof entry === "string" && entry !== "") out.push(entry);
  return out;
}

/** Display name for a role from `modelTags` (string or `{ name }`). */
function roleTagName(modelTags: unknown, role: string): string | null {
  if (!isRecord(modelTags)) return null;
  const entry = modelTags[role];
  if (typeof entry === "string" && entry !== "") return entry;
  if (isRecord(entry) && typeof entry.name === "string" && entry.name !== "") return entry.name;
  return null;
}

/** `provider/model` with any trailing `:level` thinking suffix removed. */
function baseSelector(selector: string): string {
  const colon = selector.lastIndexOf(":");
  return colon > selector.indexOf("/") && colon !== -1 ? selector.slice(0, colon) : selector;
}

export interface SessionControlState {
  readonly modelSelector: string | null;
  readonly modelDisplayName: string | null;
  readonly modelRole: string | null;
  readonly thinking: string | null;
  readonly fast: boolean | null;
}

/**
 * What the host says this session is running right now, read from the
 * session ref. Canonical wire shape is `liveState.model:
 * { id, provider, displayName?, selector?, role? }` with top-level
 * `thinking`/`fast`; legacy shapes (selector string on `ref.model` or
 * `liveState.model`, top-level `liveState.modelRole`) stay readable.
 */
export function readSessionControlState(ref: SessionRef | undefined): SessionControlState {
  let modelSelector: string | null = null;
  let modelDisplayName: string | null = null;
  let modelRole: string | null = null;
  let thinking: string | null = null;
  let fast: boolean | null = null;
  if (ref !== undefined) {
    if (typeof ref.model === "string" && ref.model !== "") modelSelector = ref.model;
    if (typeof ref.thinking === "string" && ref.thinking !== "") thinking = ref.thinking;
    const live = ref.liveState;
    if (isRecord(live)) {
      const model = live.model;
      if (typeof model === "string" && model !== "") {
        modelSelector ??= model;
      } else if (isRecord(model)) {
        // Canonical: the host publishes the resolved selector itself.
        if (typeof model.selector === "string" && model.selector !== "") {
          modelSelector = model.selector;
        } else if (modelSelector === null) {
          const provider = typeof model.provider === "string" ? model.provider : null;
          const id = typeof model.id === "string" ? model.id : null;
          if (provider !== null && id !== null) modelSelector = `${provider}/${id}`;
        }
        if (typeof model.role === "string" && model.role !== "") modelRole = model.role;
        if (typeof model.displayName === "string" && model.displayName !== "") {
          modelDisplayName = model.displayName;
        }
      }
      // Legacy top-level role, only when the model object carried none.
      if (modelRole === null && typeof live.modelRole === "string" && live.modelRole !== "") {
        modelRole = live.modelRole;
      }
      if (thinking === null && typeof live.thinking === "string" && live.thinking !== "") {
        thinking = live.thinking;
      }
      if (typeof live.fast === "boolean") fast = live.fast;
    }
  }
  return { modelSelector, modelDisplayName, modelRole, thinking, fast };
}

// ─── Command support ────────────────────────────────────────────────────────

interface CommandSupport {
  readonly supported: boolean;
  readonly reason: string | null;
}

/**
 * Whether the host's catalog offers a command this connection may send.
 * Mirrors the cancel-command and slash-palette precedents: absent, refused,
 * and ungranted are three different honest reasons — never a fake control.
 */
export function commandSupport(
  catalog: CatalogFrame | undefined,
  granted: readonly string[],
  name: string,
): CommandSupport {
  if (catalog === undefined) {
    return { supported: false, reason: "Waiting for this host's command list" };
  }
  const item = catalog.items.find(
    (candidate) => candidate.kind === "command" && (candidate.name === name || String(candidate.id) === name),
  );
  if (item === undefined) {
    return {
      supported: false,
      reason: "This host can't change this from here yet — use the terminal",
    };
  }
  if (item.supported === false) {
    return { supported: false, reason: item.reason ?? "Not available on this host" };
  }
  const missing = (item.capabilities ?? []).find((capability) => !granted.includes(capability));
  if (missing !== undefined) return { supported: false, reason: "Not granted on this host" };
  return { supported: true, reason: null };
}

// ─── Choice assembly ────────────────────────────────────────────────────────

function modelChoicesFrom(
  catalog: CatalogFrame | undefined,
  settings: SettingsFrame | undefined,
): readonly ModelChoice[] {
  const roleSettings = stringRecord(settingCurrentValue(settings, "modelRoles"));
  const roles = roleSettings ?? {};
  const modelTags = settingCurrentValue(settings, "modelTags");
  const configuredCycle = stringArray(settingCurrentValue(settings, "cycleOrder"));
  const cycle = configuredCycle ?? Object.keys(roles);
  const hasCycleAuthority = configuredCycle !== null || roleSettings !== null;
  const catalogHasModelAuthority = catalog?.items.some((item) => item.kind === "model") ?? false;
  const availableSelectors = new Set<string>();
  if (catalogHasModelAuthority && catalog !== undefined) {
    for (const item of catalog.items) {
      if (item.kind !== "model" || item.supported === false) continue;
      const selector = modelItemSelector(item);
      if (selector !== null) availableSelectors.add(baseSelector(selector));
    }
  }
  const choices: ModelChoice[] = [];
  const seenRoles = new Set<string>();
  for (const role of cycle) {
    if (seenRoles.has(role)) continue;
    seenRoles.add(role);
    const selector = roles[role] ?? null;
    // Ctrl-P skips roles with no assignment and assignments that do not
    // resolve to an available model. Sending either role through
    // session.model.set would be rejected by OMP, so never advertise it.
    if (selector === null) continue;
    if (catalogHasModelAuthority && !availableSelectors.has(baseSelector(selector))) continue;
    choices.push({
      id: `role:${role}`,
      kind: "role",
      label: roleTagName(modelTags, role) ?? ROLE_LABEL[role] ?? role,
      detail: selector,
      selector,
      role,
    });
  }

  // OMP's configured cycle is the authority for the primary model picker.
  // It is the same ordered role list the TUI walks for Ctrl+P. The catalog is
  // intentionally much broader (often hundreds of models) and belongs in the
  // advanced model settings surface, not this high-frequency session control.
  // An explicitly empty cycle is still authoritative. Catalog fallback is
  // only for legacy hosts that publish no cycle or role settings at all.
  if (hasCycleAuthority) return choices;

  // Older hosts may publish a model catalog without settings metadata. Keep a
  // bounded compatibility fallback so those hosts can still switch models.
  if (catalog !== undefined) {
    const seenSelectors = new Set<string>();
    for (const item of catalog.items) {
      if (item.kind !== "model" || item.supported === false) continue;
      const selector = modelItemSelector(item);
      if (selector === null || seenSelectors.has(selector)) continue;
      seenSelectors.add(selector);
      choices.push({
        id: `model:${selector}`,
        kind: "model",
        label: item.name,
        detail: selector,
        selector,
        role: null,
      });
    }
  }
  return choices;
}

/** `provider/modelId` from a catalog model item's metadata, guarded. */
function modelItemSelector(item: CatalogItem): string | null {
  const metadata = item.metadata;
  if (isRecord(metadata)) {
    const provider = metadata.provider;
    const modelId = metadata.modelId;
    if (typeof provider === "string" && provider !== "" && typeof modelId === "string" && modelId !== "") {
      return `${provider}/${modelId}`;
    }
  }
  return item.name.includes("/") ? item.name : null;
}

// ─── Entry point ────────────────────────────────────────────────────────────

export interface DeriveControlsInput {
  readonly catalog: CatalogFrame | undefined;
  readonly settings: SettingsFrame | undefined;
  readonly ref: SessionRef | undefined;
  readonly granted: readonly string[];
  readonly pendingControl: PendingControl | null;
  readonly controlError: string | null;
}

export function deriveComposerControls(input: DeriveControlsInput): ComposerControlsSnapshot {
  const { catalog, settings, ref, granted, pendingControl, controlError } = input;
  const state = readSessionControlState(ref);
  const choices = modelChoicesFrom(catalog, settings);

  // Session state is authority; the host's configured default role fills in
  // only until the session has spoken (new sessions start on it anyway).
  const roles = stringRecord(settingCurrentValue(settings, "modelRoles")) ?? {};
  const modelTags = settingCurrentValue(settings, "modelTags");
  let selector = state.modelSelector;
  // Labels drop any trailing `:level` thinking suffix — that directive
  // belongs to the Thinking control; matching still uses the raw selector.
  let label =
    state.modelDisplayName ?? (state.modelSelector === null ? null : baseSelector(state.modelSelector));
  if (selector === null) {
    const fallback = roles.default ?? null;
    if (fallback !== null) {
      selector = fallback;
      label = roleTagName(modelTags, "default") ?? fallback;
    }
  }

  let selectedId: string | null = null;
  if (selector !== null) {
    const base = baseSelector(selector);
    const byRole =
      (state.modelRole !== null
        ? choices.find((choice) => choice.role === state.modelRole)
        : undefined) ??
      choices.find((choice) => choice.kind === "role" && choice.selector !== null && baseSelector(choice.selector) === base);
    const byModel = choices.find(
      (choice) => choice.kind === "model" && choice.selector !== null && baseSelector(choice.selector) === base,
    );
    selectedId = byRole?.id ?? byModel?.id ?? null;
    // The role-name prefix reads "Fast · google/gemini-3.5-flash" and only
    // applies to session-reported selectors; the settings-default fallback
    // already carries the role's display name as its whole label.
    if (byRole !== undefined && state.modelSelector !== null && state.modelDisplayName === null) {
      label = `${byRole.label} · ${label ?? base}`;
    }
  }

  const thinkingDefault = settingCurrentValue(settings, "defaultThinkingLevel");
  const thinking =
    state.thinking ?? (typeof thinkingDefault === "string" && thinkingDefault !== "" ? thinkingDefault : null);

  const model = commandSupport(catalog, granted, MODEL_SET_COMMAND);
  const think = commandSupport(catalog, granted, THINKING_SET_COMMAND);
  const fast = commandSupport(catalog, granted, FAST_SET_COMMAND);

  return {
    modelSupported: model.supported,
    modelUnsupportedReason: model.reason,
    modelLabel: label,
    modelSelectedId: selectedId,
    modelChoices: choices,
    thinkingSupported: think.supported,
    thinkingUnsupportedReason: think.reason,
    thinking,
    thinkingLevels: THINKING_LEVELS,
    fastSupported: fast.supported,
    fastUnsupportedReason: fast.reason,
    fast: state.fast === true,
    modeSupported: false,
    mode: null,
    attachmentsSupported:
      granted.includes("sessions.prompt") && granted.includes("prompt.images"),
    pendingControl,
    controlError,
  };
}

/** Trigger/menu label for a thinking level (known ladder or verbatim). */
export function thinkingLabel(level: string | null): string {
  if (level === null) return "Thinking";
  if (!isThinkingLevel(level)) return level;
  switch (level) {
    case "auto":
      return "Auto";
    case "off":
      return "Thinking off";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "X-High";
    case "max":
      return "Max";
  }
}
