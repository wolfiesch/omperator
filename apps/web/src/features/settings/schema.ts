// Wire-level settings metadata contracts. The OMP appserver publishes its
// typed settings schema (settings-schema.ts + supplemental catalogs) over the
// app-wire `settings.metadata` feature; this module names the shape the
// renderer accepts. It is a projection contract, never a second settings
// store: values, defaults, sections, and constraints all arrive from the
// host, and the adapter in view-model.ts refuses anything unsafe.

/** Configuration layers, broadest first. Later layers shadow earlier ones. */
export const SETTING_LAYER_SCOPES = ["global", "project", "session", "cli"] as const;
export type SettingLayerScope = (typeof SETTING_LAYER_SCOPES)[number];

/** Where an effective value comes from: a layer, or the schema default. */
export type ValueSource = SettingLayerScope | "default";

/** Layers this surface may write. CLI is read-only by definition. */
export const EDITABLE_SCOPES = ["global", "project", "session"] as const;
export type EditableScope = (typeof EDITABLE_SCOPES)[number];

/** JSON-shaped setting values as they travel on the wire. */
export type SettingValue =
  | boolean
  | number
  | string
  | readonly string[]
  | Readonly<Record<string, string>>;

/** Control kinds this renderer has a dedicated editor for. */
export const SUPPORTED_CONTROL_KINDS = [
  "boolean",
  "enum",
  "number",
  "duration",
  "text",
  "path",
  "list",
  "map",
  "secret-reference",
  "nested",
] as const;
export type SupportedControlKind = (typeof SUPPORTED_CONTROL_KINDS)[number];

export interface EnumOptionMetadata {
  readonly value: string;
  readonly label: string;
  readonly help?: string;
}

/**
 * Control descriptors as published by the host. `kind` is an open string on
 * the wire; unknown kinds map to the unsupported fallback instead of
 * disappearing.
 */
export type ControlMetadata =
  | { readonly kind: "boolean" }
  | { readonly kind: "enum"; readonly options: readonly EnumOptionMetadata[] }
  | {
      readonly kind: "number";
      readonly min?: number;
      readonly max?: number;
      readonly step?: number;
      readonly unit?: string;
    }
  | {
      readonly kind: "duration";
      readonly unit: "ms" | "s" | "m";
      readonly min?: number;
      readonly max?: number;
    }
  | { readonly kind: "text"; readonly placeholder?: string; readonly maxLength?: number }
  | { readonly kind: "path"; readonly target: "file" | "directory" }
  | { readonly kind: "list"; readonly itemLabel?: string; readonly maxItems?: number }
  | { readonly kind: "map"; readonly keyLabel?: string; readonly valueLabel?: string }
  | { readonly kind: "secret-reference" }
  | { readonly kind: "nested"; readonly children: readonly SettingMetadata[] };

/** Secret rows carry status, reference, and source — never a value. */
export interface SecretStatusMetadata {
  readonly state: "set" | "missing" | "expired";
  /** Opaque handle the runtime resolves, e.g. `env:OPENAI_API_KEY`. */
  readonly reference: string;
  /** Human-readable storage location, e.g. `~/.omp/auth.json`. */
  readonly source: string;
}

/** One layer's contribution to a setting. */
export interface SettingLayerMetadata {
  readonly value?: SettingValue;
  /** Present instead of `value` on secret-reference settings. */
  readonly secret?: SecretStatusMetadata;
  /** File (or flag) this layer's value lives in; shown, never opened here. */
  readonly sourcePath?: string;
}

export interface SettingMetadata {
  /** Stable dot-path id, e.g. `terminal.scrollback`. */
  readonly id: string;
  /** Page id from the route map, e.g. `agent/models`; must exist in the catalog's section list. */
  readonly section: string;
  /** Heading this row sits under inside its page, e.g. `Roles`. */
  readonly sectionGroup: string;
  readonly label: string;
  readonly help: string;
  readonly control: ControlMetadata | { readonly kind: string };
  readonly default?: SettingValue;
  readonly layers?: Partial<Record<SettingLayerScope, SettingLayerMetadata>>;
  /** Changing this setting only takes effect after the runtime restarts. */
  readonly restartRequired?: boolean;
  /** Redact this setting's values in exports; secret-reference implies it. */
  readonly sensitive?: boolean;
  /** Cannot be changed on this host/platform; reason is human-readable. */
  readonly unavailable?: { readonly reason: string };
  /** Host-side validation rejected the stored value. */
  readonly invalid?: { readonly message: string };
}

/** One page in the rail. Ordering and grouping come from the route map, not the host. */
export interface SettingsSectionMetadata {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
  /** Rail group this page belongs to, e.g. `agent`. */
  readonly group: string;
  /** Ordered heading labels for this page; rows carry a matching `sectionGroup`. */
  readonly groups: readonly string[];
  /** Named runtime predicate gating this page's appearance in the rail. */
  readonly visibleWhen?: string;
  /**
   * The predicate is currently false. The page stays in the catalog so search
   * can reach it; only the rail's normal presentation drops it.
   */
  readonly hidden?: boolean;
}

/** One rail group heading. */
export interface SettingsGroupMetadata {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
}

/** The full catalog frame payload the adapter consumes. */
export interface SettingsCatalogMetadata {
  readonly revision: string;
  readonly hostId: string;
  /** Display name for the host, used in conflict copy. */
  readonly hostLabel: string;
  readonly groups: readonly SettingsGroupMetadata[];
  readonly sections: readonly SettingsSectionMetadata[];
  readonly settings: readonly SettingMetadata[];
}

/** One staged change, keyed by setting id and target layer. */
export interface SettingsChange {
  readonly id: string;
  readonly scope: EditableScope;
  /** `clear` removes the layer's value so the broader layer shows through. */
  readonly action: "set" | "clear";
  readonly value?: SettingValue;
}

export interface SettingsSaveRequest {
  readonly revision: string;
  readonly changes: readonly SettingsChange[];
}

export type SettingsSaveResult =
  | { readonly outcome: "applied"; readonly catalog: SettingsCatalogMetadata }
  | { readonly outcome: "conflict"; readonly catalog: SettingsCatalogMetadata }
  | { readonly outcome: "rejected"; readonly message: string };

/** The write seam. Fixtures implement it today; the wire client later. */
export interface SettingsController {
  save(request: SettingsSaveRequest): Promise<SettingsSaveResult>;
}
