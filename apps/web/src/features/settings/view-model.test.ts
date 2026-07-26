// Adapter contract: schema metadata maps to renderable rows, layering
// resolves in the documented order, secrets never carry values past the
// adapter, unknown controls degrade visibly, and unsafe metadata is refused.
import { describe, expect, it } from "vite-plus/test";

import { buildDiagnosticsExport } from "./diagnostics.ts";
import { SETTINGS_CATALOG_FIXTURE, SETTINGS_SECTIONS_FIXTURE } from "./fixtures.ts";
import type { SettingMetadata } from "./schema.ts";
import {
  buildSettingsViewModel,
  filterSections,
  readScope,
  SettingsMetadataError,
  validateDraft,
  valueAtScope,
} from "./view-model.ts";

function catalogWith(...settings: SettingMetadata[]) {
  return {
    revision: "rev-1",
    hostId: "host-1",
    hostLabel: "test-host",
    groups: [{ id: "fixture", label: "Fixture", summary: "Test group." }],
    sections: [{ id: "general", label: "General", summary: "Test section.", group: "fixture", groups: ["Basics"] }],
    settings,
  };
}

const VM = buildSettingsViewModel(SETTINGS_CATALOG_FIXTURE);

describe("schema mapping", () => {
  it("renders every declared section in declaration order", () => {
    expect(VM.sections.map((section) => section.id)).toEqual(
      SETTINGS_SECTIONS_FIXTURE.map((section) => section.id),
    );
    expect(VM.sections).toHaveLength(SETTINGS_SECTIONS_FIXTURE.length);
  });

  it("maps each declared control kind to its editor model", () => {
    const kinds = new Map(
      [...VM.rowsById.values()].map((row) => [row.id, row.control.kind] as const),
    );
    expect(kinds.get("session.autoResume")).toBe("boolean");
    expect(kinds.get("appearance.theme")).toBe("enum");
    expect(kinds.get("appearance.fontSize")).toBe("number");
    expect(kinds.get("bash.timeout")).toBe("duration");
    expect(kinds.get("terminal.shell")).toBe("text");
    expect(kinds.get("memory.dbPath")).toBe("path");
    expect(kinds.get("tools.allowlist")).toBe("list");
    expect(kinds.get("terminal.env")).toBe("map");
    expect(kinds.get("provider.openai.apiKey")).toBe("secret");
    expect(kinds.get("agents.defaults")).toBe("nested");
  });

  it("indexes nested children as first-class rows", () => {
    const child = VM.rowsById.get("agents.defaults.timeout");
    expect(child?.control.kind).toBe("duration");
    expect(child?.sectionId).toBe("agents");
  });

  it("keeps an unknown control kind visible as an unsupported row", () => {
    const row = VM.rowsById.get("diagnostics.samplingMatrix");
    expect(row?.control.kind).toBe("unsupported");
    if (row?.control.kind !== "unsupported") throw new Error("expected unsupported");
    expect(row.control.declaredKind).toBe("sampling-matrix");
    expect(row.label).toBe("Sampling matrix");
  });

  it("degrades a malformed known control to the unsupported fallback instead of dropping it", () => {
    const vm = buildSettingsViewModel(
      catalogWith({
        id: "broken.enum",
        section: "general",
        sectionGroup: "Basics",
        label: "Broken enum",
        help: "Options are missing.",
        control: { kind: "enum" },
      }),
    );
    const row = vm.rowsById.get("broken.enum");
    expect(row?.control.kind).toBe("unsupported");
  });
});

describe("layer precedence", () => {
  it("resolves cli over session over project over global over default", () => {
    expect(VM.rowsById.get("memory.enabled")?.effective).toEqual({ value: false, source: "cli" });
    expect(VM.rowsById.get("role.smol")?.effective).toEqual({ value: "kimi-k2.7", source: "session" });
    expect(VM.rowsById.get("editor.command")?.effective).toEqual({ value: "code --wait", source: "project" });
    expect(VM.rowsById.get("appearance.theme")?.effective).toEqual({ value: "dark", source: "global" });
    expect(VM.rowsById.get("session.autoResume")?.effective).toEqual({ value: false, source: "default" });
  });

  it("reports what shadows the edited layer and what shows through it", () => {
    const memory = VM.rowsById.get("memory.enabled");
    if (memory === undefined) throw new Error("missing row");
    expect(readScope(memory, "global")).toEqual({
      setHere: true,
      fallbackSource: null,
      shadowedBy: "cli",
    });
    const editorCommand = VM.rowsById.get("editor.command");
    if (editorCommand === undefined) throw new Error("missing row");
    expect(readScope(editorCommand, "session")).toEqual({
      setHere: false,
      fallbackSource: "project",
      shadowedBy: null,
    });
    expect(valueAtScope(editorCommand, "session")).toBe("code --wait");
    expect(valueAtScope(editorCommand, "global")).toBe("zed");
    const autoResume = VM.rowsById.get("session.autoResume");
    if (autoResume === undefined) throw new Error("missing row");
    expect(readScope(autoResume, "project")).toEqual({
      setHere: false,
      fallbackSource: "default",
      shadowedBy: null,
    });
  });
});

describe("secret safety", () => {
  it("never lets a secret value into the view model or the export", () => {
    const serialized = JSON.stringify([...VM.rowsById.values()]);
    // Secret rows expose status, reference, and source — and nothing else.
    const secret = VM.rowsById.get("provider.openai.apiKey");
    if (secret?.control.kind !== "secret") throw new Error("expected secret control");
    expect(secret.control.status).toEqual({
      state: "set",
      reference: "keychain:omp/openai",
      source: "~/.omp/auth.json",
    });
    expect(secret.effective).toBeUndefined();
    expect(secret.defaultValue).toBeUndefined();
    expect(serialized).not.toContain('"value":"sk-');

    const exported = JSON.stringify(buildDiagnosticsExport(VM, "2026-07-11T00:00:00.000Z"));
    expect(exported).toContain('"secretReference":"keychain:omp/openai"');
    expect(exported).not.toContain("effectiveValue\":\"keychain");
  });

  it("rejects a secret-reference that ships a raw layer value", () => {
    expect(() =>
      buildSettingsViewModel(
        catalogWith({
          id: "provider.test.apiKey",
          section: "general",
          sectionGroup: "Basics",
          label: "Key",
          help: "Help.",
          control: { kind: "secret-reference" },
          layers: { global: { value: "sk-live-hunter2" } },
        }),
      ),
    ).toThrowError(/SECRET_VALUE/);
  });

  it("rejects a sensitive setting that ships a default value", () => {
    expect(() =>
      buildSettingsViewModel(
        catalogWith({
          id: "general.pin",
          section: "general",
          sectionGroup: "Basics",
          label: "PIN",
          help: "Help.",
          control: { kind: "text" },
          sensitive: true,
          default: "1234",
        }),
      ),
    ).toThrowError(/SECRET_VALUE/);
  });

  it("rejects a credential-looking id that is not a secret reference", () => {
    expect(() =>
      buildSettingsViewModel(
        catalogWith({
          id: "provider.custom.apiKey",
          section: "general",
          sectionGroup: "Basics",
          label: "Key",
          help: "Help.",
          control: { kind: "text" },
          default: "plain",
        }),
      ),
    ).toThrowError(/SECRET_VALUE/);
  });
});

describe("unsafe metadata rejection", () => {
  it("rejects control characters in copy", () => {
    expect(() =>
      buildSettingsViewModel(
        catalogWith({
          id: "general.a",
          section: "general",
          sectionGroup: "Basics",
          label: "Bad\u0007label",
          help: "Help.",
          control: { kind: "boolean" },
        }),
      ),
    ).toThrowError(/UNSAFE_TEXT/);
  });

  it("rejects duplicate ids", () => {
    const row: SettingMetadata = {
      id: "general.a",
      section: "general",
      sectionGroup: "Basics",
      label: "A",
      help: "Help.",
      control: { kind: "boolean" },
    };
    expect(() => buildSettingsViewModel(catalogWith(row, row))).toThrowError(/DUPLICATE_ID/);
  });

  it("rejects a setting pointing at an undeclared section", () => {
    expect(() =>
      buildSettingsViewModel(
        catalogWith({
          id: "general.a",
          section: "ghost",
          sectionGroup: "Basics",
          label: "A",
          help: "Help.",
          control: { kind: "boolean" },
        }),
      ),
    ).toThrowError(/UNKNOWN_SECTION/);
  });

  it("rejects nesting past the depth limit", () => {
    const leaf: SettingMetadata = {
      id: "n.leaf",
      section: "general",
      sectionGroup: "Basics",
      label: "Leaf",
      help: "Help.",
      control: { kind: "boolean" },
    };
    const nest = (id: string, children: SettingMetadata[]): SettingMetadata => ({
      id,
      section: "general",
      sectionGroup: "Basics",
      label: id,
      help: "Help.",
      control: { kind: "nested", children },
    });
    let error: unknown;
    try {
      buildSettingsViewModel(catalogWith(nest("n1", [nest("n2", [nest("n3", [leaf])])])));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SettingsMetadataError);
    expect((error as SettingsMetadataError).code).toBe("LIMIT");
  });
});

describe("draft validation and search", () => {
  it("checks bounds, membership, and map keys", () => {
    const scrollback = VM.rowsById.get("terminal.scrollback");
    const theme = VM.rowsById.get("appearance.theme");
    const env = VM.rowsById.get("terminal.env");
    if (scrollback === undefined || theme === undefined || env === undefined) {
      throw new Error("missing rows");
    }
    expect(validateDraft(scrollback.control, 500)).toMatch(/at least 1000/);
    expect(validateDraft(scrollback.control, 2000)).toBeNull();
    expect(validateDraft(theme.control, "sepia")).toMatch(/listed choices/);
    expect(validateDraft(theme.control, "dark")).toBeNull();
    expect(validateDraft(env.control, { "": "x" })).toMatch(/needs a name/);
  });

  it("filters sections by id, label, and help text", () => {
    const hits = filterSections(VM.sections, "scrollback");
    expect(hits.map((section) => section.id)).toEqual(["terminal"]);
    expect(hits[0]?.rows.map((row) => row.id)).toEqual(["terminal.scrollback"]);
    // Nested children keep their parent group visible.
    const nested = filterSections(VM.sections, "time limit");
    expect(nested.some((section) => section.rows.some((row) => row.id === "agents.defaults"))).toBe(true);
    expect(filterSections(VM.sections, "zzz-no-match")).toHaveLength(0);
  });
});
