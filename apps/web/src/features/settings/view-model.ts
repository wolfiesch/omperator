// Schema-to-view-model adapter. Takes an untrusted settings catalog payload
// and produces the exact shapes SettingsWorkspace renders. Two hard rules:
// unsafe metadata (raw values on sensitive settings, control characters,
// unbounded payloads, duplicate ids) is rejected with a typed error, while
// merely-unknown control kinds degrade to a visible unsupported row so new
// OMP settings never silently disappear.
import type {
  SettingsGroupMetadata,
  ControlMetadata,
  EnumOptionMetadata,
  SecretStatusMetadata,
  SettingLayerScope,
  SettingValue,
  ValueSource,
} from "./schema.ts";
import { SETTING_LAYER_SCOPES } from "./schema.ts";

// ─── Limits ────────────────────────────────────────────────────────────────

const MAX_ID_LENGTH = 128;
const MAX_LABEL_LENGTH = 200;
const MAX_HELP_LENGTH = 2000;
const MAX_SETTINGS = 2000;
const MAX_SECTIONS = 64;
const MAX_OPTIONS = 128;
const MAX_LIST_ITEMS = 512;
const MAX_TEXT_VALUE = 8192;
const MAX_NESTED_DEPTH = 2;

/** Ids that smell like credentials must arrive as secret references. */
const SECRET_LIKE_ID = /(?:^|[._-])(?:token|secret|password|passphrase|credential|api[._-]?key)s?(?:$|[._-])/i;

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
const CONTROL_CHARS = /\p{Cc}/u;

// ─── Errors ────────────────────────────────────────────────────────────────

export type SettingsMetadataErrorCode =
  | "INVALID_SHAPE"
  | "UNSAFE_TEXT"
  | "SECRET_VALUE"
  | "DUPLICATE_ID"
  | "UNKNOWN_SECTION"
  | "LIMIT";

export class SettingsMetadataError extends Error {
  readonly code: SettingsMetadataErrorCode;
  readonly path: string;

  constructor(code: SettingsMetadataErrorCode, path: string, message: string) {
    super(`${code} at ${path}: ${message}`);
    this.name = "SettingsMetadataError";
    this.code = code;
    this.path = path;
  }
}

function fail(code: SettingsMetadataErrorCode, path: string, message: string): never {
  throw new SettingsMetadataError(code, path, message);
}

// ─── View-model shapes ─────────────────────────────────────────────────────

export type ControlModel =
  | { readonly kind: "boolean" }
  | { readonly kind: "enum"; readonly options: readonly EnumOptionMetadata[] }
  | {
      readonly kind: "number";
      readonly min: number | null;
      readonly max: number | null;
      readonly step: number | null;
      readonly unit: string | null;
    }
  | {
      readonly kind: "duration";
      readonly unit: "ms" | "s" | "m";
      readonly min: number | null;
      readonly max: number | null;
    }
  | { readonly kind: "text"; readonly placeholder: string | null; readonly maxLength: number | null }
  | { readonly kind: "path"; readonly target: "file" | "directory" }
  | { readonly kind: "list"; readonly itemLabel: string | null; readonly maxItems: number | null }
  | { readonly kind: "map"; readonly keyLabel: string | null; readonly valueLabel: string | null }
  | { readonly kind: "secret"; readonly status: SecretStatusMetadata; readonly sourcePath: string | null }
  | { readonly kind: "nested"; readonly children: readonly SettingRow[] }
  | { readonly kind: "unsupported"; readonly declaredKind: string; readonly reason: string };

export interface LayerModel {
  readonly value?: SettingValue;
  readonly sourcePath: string | null;
}

export interface SettingRow {
  readonly id: string;
  readonly sectionId: string;
  /** Heading this row sits under inside its page. */
  readonly sectionGroup: string;
  readonly label: string;
  readonly help: string;
  readonly control: ControlModel;
  readonly defaultValue?: SettingValue;
  readonly layers: Partial<Record<SettingLayerScope, LayerModel>>;
  /** Resolved value after layering; absent on secret/nested/unsupported rows. */
  readonly effective?: { readonly value: SettingValue; readonly source: ValueSource };
  readonly restartRequired: boolean;
  readonly sensitive: boolean;
  readonly unavailableReason: string | null;
  readonly invalidMessage: string | null;
  /** Lowercased id+label+help, precomputed for search. */
  readonly searchText: string;
}

export interface SettingsSection {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
  /** Rail group this page belongs to. */
  readonly group: string;
  /** Ordered heading labels inside this page. */
  readonly groups: readonly string[];
  /** Gated off by its `visibleWhen` predicate; reachable by search, not by the rail. */
  readonly hidden: boolean;
  readonly rows: readonly SettingRow[];
}

export interface SettingsViewModel {
  readonly revision: string;
  readonly hostId: string;
  readonly hostLabel: string;
  readonly groups: readonly SettingsGroupMetadata[];
  readonly sections: readonly SettingsSection[];
  /** Flat index including nested children, keyed by id. */
  readonly rowsById: ReadonlyMap<string, SettingRow>;
}

// ─── Field validators ──────────────────────────────────────────────────────

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("INVALID_SHAPE", path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string") fail("INVALID_SHAPE", path, "expected a string");
  if (value.length > maxLength) fail("LIMIT", path, `longer than ${maxLength} characters`);
  if (CONTROL_CHARS.test(value)) fail("UNSAFE_TEXT", path, "contains control characters");
  return value;
}

function optionalText(value: unknown, path: string, maxLength: number): string | null {
  if (value === undefined) return null;
  return text(value, path, maxLength);
}

function optionalNumber(value: unknown, path: string): number | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("INVALID_SHAPE", path, "expected a finite number");
  }
  return value;
}

function settingValue(value: unknown, path: string): SettingValue {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("INVALID_SHAPE", path, "expected a finite number");
    return value;
  }
  if (typeof value === "string") return text(value, path, MAX_TEXT_VALUE);
  if (Array.isArray(value)) {
    if (value.length > MAX_LIST_ITEMS) fail("LIMIT", path, `more than ${MAX_LIST_ITEMS} items`);
    return value.map((item, index) => text(item, `${path}[${index}]`, MAX_TEXT_VALUE));
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.length > MAX_LIST_ITEMS) fail("LIMIT", path, `more than ${MAX_LIST_ITEMS} entries`);
    const out: Record<string, string> = {};
    for (const [key, entry] of entries) {
      out[text(key, `${path}.${key}`, MAX_ID_LENGTH)] = text(entry, `${path}.${key}`, MAX_TEXT_VALUE);
    }
    return out;
  }
  fail("INVALID_SHAPE", path, "unsupported value shape");
}

function secretStatus(value: unknown, path: string): SecretStatusMetadata {
  const x = record(value, path);
  const state = x.state;
  if (state !== "set" && state !== "missing" && state !== "expired") {
    fail("INVALID_SHAPE", `${path}.state`, "expected set | missing | expired");
  }
  return {
    state,
    reference: text(x.reference, `${path}.reference`, MAX_LABEL_LENGTH),
    source: text(x.source, `${path}.source`, MAX_LABEL_LENGTH),
  };
}

function enumOptions(value: unknown, path: string): readonly EnumOptionMetadata[] {
  if (!Array.isArray(value)) fail("INVALID_SHAPE", path, "expected an option array");
  if (value.length === 0) fail("INVALID_SHAPE", path, "an enum needs at least one option");
  if (value.length > MAX_OPTIONS) fail("LIMIT", path, `more than ${MAX_OPTIONS} options`);
  return value.map((raw, index) => {
    const x = record(raw, `${path}[${index}]`);
    const help = optionalText(x.help, `${path}[${index}].help`, MAX_HELP_LENGTH);
    return {
      value: text(x.value, `${path}[${index}].value`, MAX_LABEL_LENGTH),
      label: text(x.label, `${path}[${index}].label`, MAX_LABEL_LENGTH),
      ...(help === null ? {} : { help }),
    };
  });
}

// ─── Control mapping ───────────────────────────────────────────────────────

interface BuildContext {
  readonly sectionIds: ReadonlySet<string>;
  readonly seenIds: Set<string>;
  readonly rowsById: Map<string, SettingRow>;
}

/**
 * Map a declared control to its model. Unknown kinds and malformed payloads
 * of known kinds both become the unsupported fallback: the row stays visible
 * and read-only instead of vanishing or half-rendering.
 */
function controlModel(
  raw: Record<string, unknown>,
  path: string,
  context: BuildContext,
  depth: number,
  layerHolder: { secret: SecretStatusMetadata | null; sourcePath: string | null },
): ControlModel {
  const declaredKind = typeof raw.kind === "string" ? raw.kind : "";
  if (declaredKind.length === 0) fail("INVALID_SHAPE", `${path}.kind`, "expected a control kind");
  const unsupported = (reason: string): ControlModel => ({ kind: "unsupported", declaredKind, reason });
  try {
    switch (declaredKind as ControlMetadata["kind"]) {
      case "boolean":
        return { kind: "boolean" };
      case "enum":
        return { kind: "enum", options: enumOptions(raw.options, `${path}.options`) };
      case "number":
        return {
          kind: "number",
          min: optionalNumber(raw.min, `${path}.min`),
          max: optionalNumber(raw.max, `${path}.max`),
          step: optionalNumber(raw.step, `${path}.step`),
          unit: optionalText(raw.unit, `${path}.unit`, 16),
        };
      case "duration": {
        const unit = raw.unit;
        if (unit !== "ms" && unit !== "s" && unit !== "m") {
          fail("INVALID_SHAPE", `${path}.unit`, "expected ms | s | m");
        }
        return {
          kind: "duration",
          unit,
          min: optionalNumber(raw.min, `${path}.min`),
          max: optionalNumber(raw.max, `${path}.max`),
        };
      }
      case "text":
        return {
          kind: "text",
          placeholder: optionalText(raw.placeholder, `${path}.placeholder`, MAX_LABEL_LENGTH),
          maxLength: optionalNumber(raw.maxLength, `${path}.maxLength`),
        };
      case "path": {
        const target = raw.target;
        if (target !== "file" && target !== "directory") {
          fail("INVALID_SHAPE", `${path}.target`, "expected file | directory");
        }
        return { kind: "path", target };
      }
      case "list":
        return {
          kind: "list",
          itemLabel: optionalText(raw.itemLabel, `${path}.itemLabel`, MAX_LABEL_LENGTH),
          maxItems: optionalNumber(raw.maxItems, `${path}.maxItems`),
        };
      case "map":
        return {
          kind: "map",
          keyLabel: optionalText(raw.keyLabel, `${path}.keyLabel`, MAX_LABEL_LENGTH),
          valueLabel: optionalText(raw.valueLabel, `${path}.valueLabel`, MAX_LABEL_LENGTH),
        };
      case "secret-reference": {
        if (layerHolder.secret === null) {
          fail("INVALID_SHAPE", path, "secret-reference settings need a secret status layer");
        }
        return { kind: "secret", status: layerHolder.secret, sourcePath: layerHolder.sourcePath };
      }
      case "nested": {
        if (depth >= MAX_NESTED_DEPTH) fail("LIMIT", path, "nested settings exceed the depth limit");
        if (!Array.isArray(raw.children)) fail("INVALID_SHAPE", `${path}.children`, "expected children");
        const children = raw.children.map((child, index) =>
          settingRow(child, `${path}.children[${index}]`, context, depth + 1),
        );
        return { kind: "nested", children };
      }
      default:
        return unsupported("This app doesn't have an editor for this kind of setting yet.");
    }
  } catch (error) {
    // A malformed payload for a *known* kind is a host bug, but hiding the
    // setting would be worse: degrade to the read-only fallback. Safety
    // errors (secret values, unsafe text, limits) keep propagating.
    if (
      error instanceof SettingsMetadataError &&
      error.code === "INVALID_SHAPE" &&
      declaredKind !== "secret-reference"
    ) {
      return unsupported("The description this setting arrived with is incomplete.");
    }
    throw error;
  }
}

// ─── Row mapping ───────────────────────────────────────────────────────────

function settingRow(
  input: unknown,
  path: string,
  context: BuildContext,
  depth: number,
): SettingRow {
  const raw = record(input, path);
  const id = text(raw.id, `${path}.id`, MAX_ID_LENGTH);
  if (id.length === 0) fail("INVALID_SHAPE", `${path}.id`, "expected a non-empty id");
  if (context.seenIds.has(id)) fail("DUPLICATE_ID", `${path}.id`, `"${id}" appears twice`);
  context.seenIds.add(id);
  const sectionId = text(raw.section, `${path}.section`, MAX_ID_LENGTH);
  const sectionGroup = text(raw.sectionGroup, `${path}.sectionGroup`, MAX_LABEL_LENGTH);
  if (!context.sectionIds.has(sectionId)) {
    fail("UNKNOWN_SECTION", `${path}.section`, `"${sectionId}" is not a declared section`);
  }

  const controlRaw = record(raw.control, `${path}.control`);
  const declaredKind = typeof controlRaw.kind === "string" ? controlRaw.kind : "";
  const sensitive = raw.sensitive === true || declaredKind === "secret-reference";

  // Secret safety first: a sensitive setting carrying raw values anywhere in
  // its metadata is rejected outright — it never reaches the render tree.
  if (sensitive) {
    if (raw.default !== undefined) {
      fail("SECRET_VALUE", `${path}.default`, "sensitive settings must not ship values");
    }
  } else if (SECRET_LIKE_ID.test(id)) {
    fail("SECRET_VALUE", `${path}.id`, `"${id}" looks like a credential but is not a secret reference`);
  }

  const layers: Partial<Record<SettingLayerScope, LayerModel>> = {};
  const layerHolder: { secret: SecretStatusMetadata | null; sourcePath: string | null } = {
    secret: null,
    sourcePath: null,
  };
  if (raw.layers !== undefined) {
    const layersRaw = record(raw.layers, `${path}.layers`);
    for (const scope of SETTING_LAYER_SCOPES) {
      const layerRaw = layersRaw[scope];
      if (layerRaw === undefined) continue;
      const layer = record(layerRaw, `${path}.layers.${scope}`);
      const sourcePath = optionalText(layer.sourcePath, `${path}.layers.${scope}.sourcePath`, 512);
      if (layer.secret !== undefined) {
        layerHolder.secret = secretStatus(layer.secret, `${path}.layers.${scope}.secret`);
        layerHolder.sourcePath = sourcePath;
        layers[scope] = { sourcePath };
        continue;
      }
      if (layer.value !== undefined) {
        if (sensitive) {
          fail("SECRET_VALUE", `${path}.layers.${scope}.value`, "sensitive settings must not ship values");
        }
        layers[scope] = { value: settingValue(layer.value, `${path}.layers.${scope}.value`), sourcePath };
        continue;
      }
      layers[scope] = { sourcePath };
    }
  }

  const control = controlModel(controlRaw, `${path}.control`, context, depth, layerHolder);
  const defaultValue = raw.default === undefined ? undefined : settingValue(raw.default, `${path}.default`);

  // Effective value: narrowest layer wins, schema default is the floor.
  let effective: SettingRow["effective"];
  if (control.kind !== "secret" && control.kind !== "nested" && control.kind !== "unsupported") {
    for (let index = SETTING_LAYER_SCOPES.length - 1; index >= 0; index -= 1) {
      const scope = SETTING_LAYER_SCOPES[index] as SettingLayerScope;
      const layer = layers[scope];
      if (layer?.value !== undefined) {
        effective = { value: layer.value, source: scope };
        break;
      }
    }
    if (effective === undefined && defaultValue !== undefined) {
      effective = { value: defaultValue, source: "default" };
    }
  }

  const label = text(raw.label, `${path}.label`, MAX_LABEL_LENGTH);
  const help = text(raw.help, `${path}.help`, MAX_HELP_LENGTH);
  const unavailableReason =
    raw.unavailable === undefined
      ? null
      : text(record(raw.unavailable, `${path}.unavailable`).reason, `${path}.unavailable.reason`, MAX_LABEL_LENGTH);
  const invalidMessage =
    raw.invalid === undefined
      ? null
      : text(record(raw.invalid, `${path}.invalid`).message, `${path}.invalid.message`, MAX_LABEL_LENGTH);

  const row: SettingRow = {
    id,
    sectionId,
    sectionGroup,
    label,
    help,
    control,
    ...(defaultValue === undefined ? {} : { defaultValue }),
    layers,
    ...(effective === undefined ? {} : { effective }),
    restartRequired: raw.restartRequired === true,
    sensitive,
    unavailableReason,
    invalidMessage,
    searchText: `${id} ${label} ${help}`.toLowerCase(),
  };
  context.rowsById.set(id, row);
  return row;
}

// ─── Catalog entry point ───────────────────────────────────────────────────

export function buildSettingsViewModel(input: unknown): SettingsViewModel {
  const raw = record(input, "catalog");
  const revision = text(raw.revision, "catalog.revision", MAX_ID_LENGTH);
  const hostId = text(raw.hostId, "catalog.hostId", MAX_ID_LENGTH);
  const hostLabel = text(raw.hostLabel, "catalog.hostLabel", MAX_LABEL_LENGTH);

  if (!Array.isArray(raw.sections)) fail("INVALID_SHAPE", "catalog.sections", "expected an array");
  if (raw.sections.length > MAX_SECTIONS) fail("LIMIT", "catalog.sections", "too many sections");
  const sectionMeta = raw.sections.map((entry, index) => {
    const x = record(entry, `catalog.sections[${index}]`);
    return {
      id: text(x.id, `catalog.sections[${index}].id`, MAX_ID_LENGTH),
      label: text(x.label, `catalog.sections[${index}].label`, MAX_LABEL_LENGTH),
      summary: text(x.summary, `catalog.sections[${index}].summary`, MAX_HELP_LENGTH),
      group: text(x.group, `catalog.sections[${index}].group`, MAX_ID_LENGTH),
      groups: (Array.isArray(x.groups) ? x.groups : []).map((label, groupIndex) =>
        text(label, `catalog.sections[${index}].groups[${groupIndex}]`, MAX_LABEL_LENGTH),
      ),
      hidden: x.hidden === true,
    };
  });

  const groupMeta: SettingsGroupMetadata[] = (Array.isArray(raw.groups) ? raw.groups : []).map((entry, index) => {
    const x = record(entry, `catalog.groups[${index}]`);
    return {
      id: text(x.id, `catalog.groups[${index}].id`, MAX_ID_LENGTH),
      label: text(x.label, `catalog.groups[${index}].label`, MAX_LABEL_LENGTH),
      summary: text(x.summary, `catalog.groups[${index}].summary`, MAX_HELP_LENGTH),
    };
  });
  const sectionIds = new Set(sectionMeta.map((section) => section.id));
  if (sectionIds.size !== sectionMeta.length) {
    fail("DUPLICATE_ID", "catalog.sections", "section ids must be unique");
  }

  if (!Array.isArray(raw.settings)) fail("INVALID_SHAPE", "catalog.settings", "expected an array");
  if (raw.settings.length > MAX_SETTINGS) fail("LIMIT", "catalog.settings", "too many settings");

  const context: BuildContext = { sectionIds, seenIds: new Set(), rowsById: new Map() };
  const rows = raw.settings.map((entry, index) => settingRow(entry, `catalog.settings[${index}]`, context, 0));

  const sections: SettingsSection[] = sectionMeta.map((section) => ({
    ...section,
    rows: rows.filter((row) => row.sectionId === section.id),
  }));

  return { revision, hostId, hostLabel, groups: groupMeta, sections, rowsById: context.rowsById };
}

// ─── Scope reading helpers ─────────────────────────────────────────────────

const SCOPE_INDEX: Readonly<Record<SettingLayerScope, number>> = {
  global: 0,
  project: 1,
  session: 2,
  cli: 3,
};

export interface ScopeReading {
  /** Whether the edited layer itself holds a value. */
  readonly setHere: boolean;
  /** Where the value shown at this layer comes from when not set here. */
  readonly fallbackSource: ValueSource | null;
  /** Narrowest layer shadowing the edited one, if any. */
  readonly shadowedBy: SettingLayerScope | null;
}

/**
 * How a row reads from a given editable layer: is a value set at that layer,
 * what shows through when it isn't, and which narrower layer (if any) wins
 * over whatever is saved here.
 */
export function readScope(row: SettingRow, scope: SettingLayerScope): ScopeReading {
  const editIndex = SCOPE_INDEX[scope];
  const setHere = row.layers[scope]?.value !== undefined;
  let fallbackSource: ValueSource | null = null;
  if (!setHere) {
    for (let index = editIndex - 1; index >= 0; index -= 1) {
      const candidate = SETTING_LAYER_SCOPES[index] as SettingLayerScope;
      if (row.layers[candidate]?.value !== undefined) {
        fallbackSource = candidate;
        break;
      }
    }
    if (fallbackSource === null && row.defaultValue !== undefined) fallbackSource = "default";
  }
  let shadowedBy: SettingLayerScope | null = null;
  for (let index = SETTING_LAYER_SCOPES.length - 1; index > editIndex; index -= 1) {
    const candidate = SETTING_LAYER_SCOPES[index] as SettingLayerScope;
    if (row.layers[candidate]?.value !== undefined) {
      shadowedBy = candidate;
      break;
    }
  }
  return { setHere, fallbackSource, shadowedBy };
}

/** Value a control shows when editing a row at a layer (before drafts). */
export function valueAtScope(row: SettingRow, scope: SettingLayerScope): SettingValue | undefined {
  const own = row.layers[scope]?.value;
  if (own !== undefined) return own;
  const reading = readScope(row, scope);
  if (reading.fallbackSource === null) return undefined;
  if (reading.fallbackSource === "default") return row.defaultValue;
  return row.layers[reading.fallbackSource]?.value;
}

// ─── Draft validation ──────────────────────────────────────────────────────

/** Validate a drafted value against its control. Returns a human message or null. */
export function validateDraft(control: ControlModel, value: SettingValue): string | null {
  switch (control.kind) {
    case "boolean":
      return typeof value === "boolean" ? null : "Expected on or off.";
    case "enum": {
      if (typeof value !== "string") return "Pick one of the listed choices.";
      return control.options.some((option) => option.value === value)
        ? null
        : "Pick one of the listed choices.";
    }
    case "number":
    case "duration": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "Enter a number.";
      if (control.min !== null && value < control.min) return `Must be at least ${control.min}.`;
      if (control.max !== null && value > control.max) return `Must be at most ${control.max}.`;
      return null;
    }
    case "text": {
      if (typeof value !== "string") return "Enter text.";
      if (control.maxLength !== null && value.length > control.maxLength) {
        return `Keep it under ${control.maxLength} characters.`;
      }
      return null;
    }
    case "path": {
      if (typeof value !== "string") return "Enter a path.";
      if (value.trim().length === 0) return "Enter a path.";
      return null;
    }
    case "list": {
      if (!Array.isArray(value)) return "Expected a list.";
      if (control.maxItems !== null && value.length > control.maxItems) {
        return `Keep it to ${control.maxItems} entries or fewer.`;
      }
      return null;
    }
    case "map": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return "Expected name and value pairs.";
      }
      for (const key of Object.keys(value)) {
        if (key.trim().length === 0) return "Every entry needs a name.";
      }
      return null;
    }
    case "secret":
    case "nested":
    case "unsupported":
      return "This setting can't be edited here.";
  }
}

// ─── Search ────────────────────────────────────────────────────────────────

/** `extraText` lets owners of specialized editors (model roles, task
 * agents) contribute friendly-form search terms per row id. */
export function rowMatches(row: SettingRow, query: string, extraText?: ReadonlyMap<string, string>): boolean {
  if (query.length === 0) return true;
  if (row.searchText.includes(query)) return true;
  if (extraText?.get(row.id)?.includes(query) === true) return true;
  if (row.control.kind === "nested") {
    return row.control.children.some((child) => rowMatches(child, query, extraText));
  }
  return false;
}

/** Rows per section for a normalized query; sections without hits drop out. */
export function filterSections(
  sections: readonly SettingsSection[],
  query: string,
  extraText?: ReadonlyMap<string, string>,
): readonly SettingsSection[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return sections;
  return sections
    .map((section) => ({ ...section, rows: section.rows.filter((row) => rowMatches(row, normalized, extraText)) }))
    .filter((section) => section.rows.length > 0);
}
