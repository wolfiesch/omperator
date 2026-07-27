// Composer control truth for one session, derived from live host authority:
// the catalog (which commands and models exist), the settings frames (role
// routing, display names, default thinking), and the session index / warm
// ref (what this session is running right now). Nothing here persists or
// invents state — what the host does not say, the controls do not claim.
import type { CatalogFrame, CatalogItem, SessionRef, SettingsFrame } from "@t4-code/protocol";

import {
  isSessionMode,
  isThinkingLevel,
  type SessionMode,
  type ThinkingLevel,
} from "./intents.ts";

/** Wire commands the composer's controls ride on. */
export const MODEL_SET_COMMAND = "session.model.set";
export const THINKING_SET_COMMAND = "session.thinking.set";
export const FAST_SET_COMMAND = "session.fast.set";
export const MODE_SET_COMMAND = "session.mode.set";

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

export type PendingControl = "model" | "thinking" | "fast" | "mode";

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
  /** Configured selector: fixed level, Off, or per-prompt Auto. */
  readonly thinking: ThinkingLevel | null;
  /** Concrete level currently applied to the model; Auto is never published here. */
  readonly thinkingEffective: ThinkingLevel | null;
  /** Auto's classified result for the current turn; null while unresolved/not Auto. */
  readonly thinkingResolved: ThinkingLevel | null;
  /** Exact model-aware menu order: Off, Auto, then host-reported concrete efforts. */
  readonly thinkingLevels: readonly ThinkingLevel[];
  /** Off maps to the provider's minimum rather than disabling reasoning. */
  readonly thinkingOffFloored: boolean;
  readonly fastSupported: boolean;
  readonly fastUnsupportedReason: string | null;
  /** The current model family exposes the `/fast` toggle. */
  readonly fastAvailable: boolean;
  /** `/fast` is enabled for the current model family. */
  readonly fast: boolean;
  /** Priority will actually be encoded for the next request. */
  readonly fastActive: boolean;
  /** The host offers `session.mode.set`; the control renders when mode is known. */
  readonly modeSupported: boolean;
  readonly mode: SessionMode | null;
  /** The host negotiated the bounded `prompt.images` upload protocol. */
  readonly attachmentsSupported: boolean;
  /** Why attaching gates right now; null falls back to the generic host copy. */
  readonly attachmentsUnsupportedReason: string | null;
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
  readonly thinking: ThinkingLevel | null;
  readonly thinkingEffective: ThinkingLevel | null;
  readonly thinkingResolved: ThinkingLevel | null;
  /** Concrete efforts only; Off and Auto are added by the client. */
  readonly thinkingLevels: readonly ThinkingLevel[] | null;
  readonly thinkingSupported: boolean | null;
  readonly thinkingOffFloored: boolean | null;
  readonly fast: boolean | null;
  readonly fastAvailable: boolean | null;
  readonly fastActive: boolean | null;
  /** Working mode reported on the session ref; null until the host speaks. */
  readonly mode: SessionMode | null;
}

const CONCRETE_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function isConcreteThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    typeof value === "string" &&
    CONCRETE_THINKING_LEVELS.some((level) => level === value)
  );
}

/**
 * New hosts publish the exact concrete ladder for the active model. A
 * malformed or partial shape is unknown, not permission to guess a global
 * ladder. Empty is valid for reasoning models with no configurable effort.
 */
function readThinkingLevels(value: unknown): readonly ThinkingLevel[] | null {
  if (!Array.isArray(value)) return null;
  const levels: ThinkingLevel[] = [];
  const seen = new Set<ThinkingLevel>();
  for (const entry of value) {
    if (!isConcreteThinkingLevel(entry) || seen.has(entry)) return null;
    seen.add(entry);
    levels.push(entry);
  }
  return levels;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readEffectiveThinking(value: unknown): ThinkingLevel | null {
  return value === "off" || isConcreteThinkingLevel(value) ? value : null;
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
  let thinking: ThinkingLevel | null = null;
  let thinkingEffective: ThinkingLevel | null = null;
  let thinkingResolved: ThinkingLevel | null = null;
  let thinkingLevels: readonly ThinkingLevel[] | null = null;
  let thinkingSupported: boolean | null = null;
  let thinkingOffFloored: boolean | null = null;
  let fast: boolean | null = null;
  let fastAvailable: boolean | null = null;
  let fastActive: boolean | null = null;
  // OMP's default is build. Older/current refs may omit the field until the
  // user changes it, but omission on an existing ref does not mean unknown.
  let mode: SessionMode | null = ref === undefined ? null : "build";
  if (ref !== undefined) {
    if (typeof ref.model === "string" && ref.model !== "") modelSelector = ref.model;
    if (isThinkingLevel(ref.thinking)) thinking = ref.thinking;
    if (isSessionMode(ref.mode)) mode = ref.mode;
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
      if (thinking === null && isThinkingLevel(live.thinking)) {
        thinking = live.thinking;
      }
      thinkingEffective = readEffectiveThinking(live.thinkingEffective);
      thinkingResolved = isConcreteThinkingLevel(live.thinkingResolved)
        ? live.thinkingResolved
        : null;
      thinkingLevels = readThinkingLevels(live.thinkingLevels);
      thinkingSupported = readBoolean(live.thinkingSupported);
      thinkingOffFloored = readBoolean(live.thinkingOffFloored);
      fast = readBoolean(live.fast);
      fastAvailable = readBoolean(live.fastAvailable);
      fastActive = readBoolean(live.fastActive);
    }
  }
  return {
    modelSelector,
    modelDisplayName,
    modelRole,
    thinking,
    thinkingEffective,
    thinkingResolved,
    thinkingLevels,
    thinkingSupported,
    thinkingOffFloored,
    fast,
    fastAvailable,
    fastActive,
    mode,
  };
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
    state.thinking ?? (isThinkingLevel(thinkingDefault) ? thinkingDefault : null);

  const model = commandSupport(catalog, granted, MODEL_SET_COMMAND);
  const think = commandSupport(catalog, granted, THINKING_SET_COMMAND);
  const fast = commandSupport(catalog, granted, FAST_SET_COMMAND);
  const mode = commandSupport(catalog, granted, MODE_SET_COMMAND);

  const thinkingSupported =
    think.supported && state.thinkingSupported === true && state.thinkingLevels !== null;
  const thinkingUnsupportedReason = !think.supported
    ? think.reason
    : state.thinkingSupported === false
      ? "The current model does not support thinking."
      : state.thinkingSupported !== true || state.thinkingLevels === null
        ? "This host does not report this model's thinking levels yet."
        : null;
  const thinkingLevels: readonly ThinkingLevel[] = thinkingSupported
    ? ["off", "auto", ...(state.thinkingLevels ?? [])]
    : [];

  const fastAvailable = state.fastAvailable === true;
  const fastActive = state.fastActive === true;
  const fastSupported = fast.supported && fastAvailable;
  const fastUnsupportedReason = !fast.supported
    ? fast.reason
    : state.fastAvailable === null
      ? "This host does not report Fast support for the current model yet."
      : !fastAvailable && fastActive
        ? "Provider priority is active through this model's provider settings."
        : !fastAvailable
          ? "Fast mode is unavailable for the current model."
          : null;

  return {
    modelSupported: model.supported,
    modelUnsupportedReason: model.reason,
    modelLabel: label,
    modelSelectedId: selectedId,
    modelChoices: choices,
    thinkingSupported,
    thinkingUnsupportedReason,
    thinking,
    thinkingEffective: state.thinkingEffective,
    thinkingResolved: state.thinkingResolved,
    thinkingLevels,
    thinkingOffFloored: state.thinkingOffFloored === true,
    fastSupported,
    fastUnsupportedReason,
    fastAvailable,
    fast: state.fast === true,
    fastActive,
    modeSupported: mode.supported,
    mode: state.mode,
    attachmentsSupported:
      granted.includes("sessions.prompt") && granted.includes("prompt.images"),
    attachmentsUnsupportedReason: null,
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
      return "Off";
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

/** Compact configured/effective truth for the composer trigger and phone summary. */
export function thinkingValueLabel(
  controls: Pick<ComposerControlsSnapshot, "thinking"> &
    Partial<
      Pick<
        ComposerControlsSnapshot,
        "thinkingEffective" | "thinkingResolved" | "thinkingOffFloored"
      >
    >,
): string {
  const configured = thinkingLabel(controls.thinking);
  const effective = controls.thinkingEffective ?? null;
  const resolved = controls.thinkingResolved ?? null;
  if (controls.thinking === "auto") {
    return resolved === null ? configured : `${configured} · ${thinkingLabel(resolved)}`;
  }
  if (
    effective !== null &&
    effective !== controls.thinking &&
    (controls.thinking !== "off" || controls.thinkingOffFloored === true)
  ) {
    return `${configured} · ${thinkingLabel(effective)} active`;
  }
  return configured;
}
