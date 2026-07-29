// The settings surface: a searchable section rail beside progressive
// sections of schema-driven rows, a staged-edit save bar, and banners for
// host conflicts and pending restarts. Standalone by design — it mounts
// anywhere with a store api and owns no routing.
import { Badge, Button, cn, IconButton, Spinner } from "@t4-code/ui";
import { ArrowLeft, Cable, Download, RotateCcw, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { RAIL_OVERLAY_QUERY, useMediaQuery } from "../../hooks/useMediaQuery.ts";
import { updateIsAvailable } from "../updates/update-model.ts";
import {
  consumeUpdateSettingsRequest,
  getUpdateSettingsRequest,
  subscribeUpdateSettingsRequest,
} from "../updates/update-navigation.ts";
import { UpdateSettingsPanel } from "../updates/UpdateSettingsPanel.tsx";
import { useAppUpdateState } from "../updates/update-store.ts";
import { AccentRow } from "./AccentRow.tsx";
import { CatalogExplorerBlock } from "./CatalogExplorerBlock.tsx";
import type { CatalogExplorerInput } from "./settings-presentation.ts";
import { FIELD_CLASS } from "./controls.tsx";
import { BrokerStatusLine, HostSelector, type BrokerStatusAction, type HostSelection } from "./HostSelector.tsx";
import { buildDiagnosticsExport } from "./diagnostics.ts";
import { railFocusTarget, type RailKey } from "./keyboard.ts";
import type { AgentCatalog, ModelChoice } from "./live-catalog.ts";
import { CYCLE_SETTING_ID, ModelRolesBlock, ROLES_SETTING_ID } from "./ModelRolesBlock.tsx";
import { listValue, recordValue } from "./roles-model.ts";
import type { EditableScope } from "./schema.ts";
import { EDITABLE_SCOPES } from "./schema.ts";
import { modelRoutingSearchText, NO_ROLE_TAGS, type RoleTags } from "./settings-presentation.ts";
import type { SettingsStoreApi } from "./settings-store.ts";
import { useSettings } from "./settings-store.ts";
import { SettingRowView } from "./SettingRow.tsx";
import { DISABLED_SETTING_ID, OVERRIDES_SETTING_ID, TaskAgentsBlock } from "./TaskAgentsBlock.tsx";
import { filterSections, type SettingsSection } from "./view-model.ts";

/** The wire "session" scope is a host-process runtime override, not a
 * per-session setting. The tab says what it really is: this run of OMP. */
export const SCOPE_TAB_LABEL: Record<EditableScope, string> = {
  global: "This machine",
  project: "This project",
  session: "This run",
};

export const UPDATE_SECTION_ID = "t4-updates";

interface SettingsRailEntry {
  readonly id: string;
  readonly label: string;
}

export interface SettingsRailGroup {
  readonly id: string;
  readonly label: string;
  readonly sections: readonly SettingsRailEntry[];
}

const SETTINGS_RAIL_GROUPS = [
  {
    id: "personal",
    label: "Personal",
    sectionIds: ["general", "appearance", "interaction", "keybindings", "notifications", "speech"],
  },
  {
    id: "intelligence",
    label: "AI & agents",
    sectionIds: ["model", "models", "providers", "roles", "context", "tasks", "agents", "memory"],
  },
  {
    id: "tools",
    label: "Tools",
    sectionIds: ["files", "shell", "tools", "browser", "terminal"],
  },
  {
    id: "integrations",
    label: "Integrations",
    sectionIds: ["mcp", "extensions", "remote-hosts"],
  },
] as const;

export function buildSettingsRailSections(sections: readonly SettingsSection[]): readonly SettingsRailEntry[] {
  const entries = sections.map(({ id, label }) => ({ id, label }));
  const diagnostics = entries.findIndex((section) => section.id === "diagnostics");
  const index = diagnostics < 0 ? entries.length : diagnostics;
  return [
    ...entries.slice(0, index),
    { id: UPDATE_SECTION_ID, label: "Updates" },
    ...entries.slice(index),
  ];
}

export function buildSettingsRailGroups(
  sections: readonly SettingsSection[],
): readonly SettingsRailGroup[] {
  return groupSettingsRailEntries(buildSettingsRailSections(sections));
}

function groupSettingsRailEntries(
  entries: readonly SettingsRailEntry[],
): readonly SettingsRailGroup[] {
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const used = new Set<string>();
  const groups: SettingsRailGroup[] = [];

  for (const definition of SETTINGS_RAIL_GROUPS) {
    const grouped = definition.sectionIds.flatMap((id) => {
      const entry = entryById.get(id);
      if (entry === undefined) return [];
      used.add(id);
      return [entry];
    });
    if (grouped.length > 0) {
      groups.push({ id: definition.id, label: definition.label, sections: grouped });
    }
  }

  const systemIds = new Set([UPDATE_SECTION_ID, "diagnostics"]);
  const hostSections = entries.filter((entry) => !used.has(entry.id) && !systemIds.has(entry.id));
  if (hostSections.length > 0) {
    groups.push({ id: "host", label: "Host settings", sections: hostSections });
  }
  const systemSections = entries.filter((entry) => systemIds.has(entry.id));
  if (systemSections.length > 0) {
    groups.push({ id: "system", label: "System", sections: systemSections });
  }
  return groups;
}

function ScopeTabs({
  api,
  scopes,
}: {
  readonly api: SettingsStoreApi;
  readonly scopes: readonly EditableScope[];
}) {
  const editScope = useSettings(api, (state) => state.editScope);
  if (scopes.length < 2) return null;
  return (
    <div
      aria-label="Where changes apply"
      className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border p-0.5"
      role="group"
    >
      {scopes.map((scope) => (
        <button
          aria-pressed={scope === editScope}
          className={cn(
            "h-6.5 cursor-pointer whitespace-nowrap rounded-md px-2 font-medium text-xs outline-none transition-colors duration-(--motion-duration-fast) focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            scope === editScope
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
          key={scope}
          onClick={() => api.getState().setEditScope(scope)}
          type="button"
        >
          {SCOPE_TAB_LABEL[scope]}
        </button>
      ))}
    </div>
  );
}

function SectionRail({
  api,
  sections,
  activeSectionId,
  onSelect,
  matchedIds,
  updateAvailable,
}: {
  readonly api: SettingsStoreApi;
  readonly sections: readonly SettingsRailEntry[];
  readonly activeSectionId: string;
  readonly onSelect: (id: string) => void;
  readonly matchedIds: ReadonlySet<string> | null;
  readonly updateAvailable: boolean;
}) {
  const drafts = useSettings(api, (state) => state.drafts);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const groups = useMemo(() => groupSettingsRailEntries(sections), [sections]);
  const orderedSections = groups.flatMap((group) => group.sections);

  const dirtyBySection = useMemo(() => {
    const counts = new Map<string, number>();
    const { rowsById } = api.getState().viewModel;
    for (const id of Object.keys(drafts)) {
      const sectionId = rowsById.get(id)?.sectionId;
      if (sectionId !== undefined) counts.set(sectionId, (counts.get(sectionId) ?? 0) + 1);
    }
    return counts;
  }, [api, drafts]);

  return (
    <nav aria-label="Settings sections" className="flex w-56 shrink-0 flex-col overflow-y-auto border-border border-e bg-(--sidebar-background)/40 px-2 py-3">
      {groups.map((group, groupIndex) => (
        <div className={cn(groupIndex > 0 && "mt-3")} key={group.id}>
          <p className="px-2.5 pb-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            {group.label}
          </p>
          <ul className="flex flex-col gap-px">
            {group.sections.map((section) => {
          const active = section.id === activeSectionId;
          const dimmed = matchedIds !== null && !matchedIds.has(section.id);
          const dirtyCount = dirtyBySection.get(section.id) ?? 0;
          return (
            <li key={section.id}>
              <button
                aria-current={active ? "true" : undefined}
                className={cn(
                  "relative flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-start text-sm outline-none transition-colors duration-(--motion-duration-fast) focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                  active
                    ? "bg-secondary font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  dimmed && "opacity-64",
                )}
                onClick={() => onSelect(section.id)}
                onKeyDown={(event) => {
                  if (
                    event.key !== "ArrowDown" &&
                    event.key !== "ArrowUp" &&
                    event.key !== "Home" &&
                    event.key !== "End"
                  ) {
                    return;
                  }
                  const target = railFocusTarget(
                    orderedSections.map((entry) => entry.id),
                    section.id,
                    event.key as RailKey,
                  );
                  if (target === null) return;
                  event.preventDefault();
                  onSelect(target);
                  itemRefs.current.get(target)?.focus();
                }}
                ref={(node) => {
                  if (node === null) itemRefs.current.delete(section.id);
                  else itemRefs.current.set(section.id, node);
                }}
                tabIndex={active ? 0 : -1}
                type="button"
              >
                {active && (
                  <span aria-hidden="true" className="absolute inset-y-1.5 start-0 w-0.5 rounded-full bg-primary" />
                )}
                <span className="min-w-0 flex-1 truncate">{section.label}</span>
                {section.id === UPDATE_SECTION_ID && updateAvailable && (
                  <span aria-label="T4 Code update available" className="size-1.5 rounded-full bg-primary" />
                )}
                {dirtyCount > 0 && (
                  <Badge aria-label={`${dirtyCount} unsaved`} size="sm" variant="secondary">
                    {dirtyCount}
                  </Badge>
                )}
              </button>
            </li>
          );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function SectionRows({
  api,
  section,
  hiddenIds,
}: {
  readonly api: SettingsStoreApi;
  readonly section: SettingsSection;
  readonly hiddenIds: ReadonlySet<string>;
}) {
  const editScope = useSettings(api, (state) => state.editScope);
  const drafts = useSettings(api, (state) => state.drafts);
  const draftErrors = useSettings(api, (state) => state.draftErrors);
  const state = api.getState();
  const rows = section.rows.filter((row) => !hiddenIds.has(row.id));
  if (rows.length === 0) return null;
  return (
    <div className="divide-y divide-border rounded-xl border border-border bg-card">
      {rows.map((row) =>
        row.control.kind === "nested" ? (
          <div key={row.id}>
            <div className="flex flex-col gap-0.5 px-4 pt-3 pb-1">
              <span className="font-medium text-foreground text-sm">{row.label}</span>
              <p className="max-w-[70ch] text-muted-foreground text-xs leading-relaxed">{row.help}</p>
            </div>
            <div className="divide-y divide-border/60">
              {row.control.children.map((child) => (
                <SettingRowView
                  draft={drafts[child.id]}
                  draftError={draftErrors[child.id]}
                  editScope={editScope}
                  key={child.id}
                  nested
                  onClear={state.stageClear}
                  onDiscard={state.discardDraft}
                  onStage={state.stageValue}
                  row={child}
                />
              ))}
            </div>
          </div>
        ) : (
          <SettingRowView
            draft={drafts[row.id]}
            draftError={draftErrors[row.id]}
            editScope={editScope}
            key={row.id}
            onClear={state.stageClear}
            onDiscard={state.discardDraft}
            onStage={state.stageValue}
            row={row}
          />
        ),
      )}
    </div>
  );
}

function DiagnosticsActions({ api }: { readonly api: SettingsStoreApi }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3">
      <p className="max-w-[70ch] text-muted-foreground text-xs leading-relaxed">
        Download the current configuration as JSON for a bug report. Anything marked sensitive is
        left out, and secret values are never included.
      </p>
      <Button
        onClick={() => {
          const payload = buildDiagnosticsExport(api.getState().viewModel, new Date().toISOString());
          const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = "t4-code-settings-diagnostics.json";
          anchor.click();
          URL.revokeObjectURL(url);
        }}
        size="sm"
        variant="outline"
      >
        <Download />
        Export diagnostics
      </Button>
    </div>
  );
}

/** Restart affordance the shell wires up for the local host only. */
export interface RestartAction {
  readonly label: string;
  readonly busy: boolean;
  /** Honest one-liner: last inspected status or the failure, never a guess. */
  readonly notice: string | null;
  readonly onRestart: () => void;
}

/** Live model/agent catalog choices the specialized blocks offer. */
export interface SettingsCatalogChoices {
  readonly models: readonly ModelChoice[];
  readonly agents: AgentCatalog;
  /** Role names/colors from the host's `modelTags` setting. */
  readonly roleTags?: RoleTags;
}

const NO_CHOICES: SettingsCatalogChoices = { models: [], agents: { agents: [], unavailableReason: null } };

const NO_HIDDEN: ReadonlySet<string> = new Set();

export function SettingsWorkspace({
  api,
  onBack,
  onOpenHosts,
  scopes = EDITABLE_SCOPES,
  restartAction,
  catalogChoices = NO_CHOICES,
  catalogExplorer,
  hostSelection,
  brokerStatus,
}: {
  readonly api: SettingsStoreApi;
  /** Renders a back control in the header; the host shell owns navigation. */
  readonly onBack?: () => void;
  /** Renders a "Hosts" control in the header; the host shell owns routing. */
  readonly onOpenHosts?: () => void;
  /** Layers this host accepts writes for; defaults to every editable layer. */
  readonly scopes?: readonly EditableScope[];
  /** Offered in the restart banner when the runtime is locally managed. */
  readonly restartAction?: RestartAction;
  /** Models and agents the host advertises, for the roles/agents editors. */
  readonly catalogChoices?: SettingsCatalogChoices;
  /** The active host's read-only capability catalog. */
  readonly catalogExplorer?: CatalogExplorerInput;
  /** Connected hosts to switch between; the shell owns the selection. */
  readonly hostSelection?: HostSelection;
  /** The active host's account-broker status, when the shell tracks it. */
  readonly brokerStatus?: BrokerStatusAction;
}) {
  const viewModel = useSettings(api, (state) => state.viewModel);
  const query = useSettings(api, (state) => state.query);
  const activeSectionId = useSettings(api, (state) => state.activeSectionId);
  const drafts = useSettings(api, (state) => state.drafts);
  const draftErrors = useSettings(api, (state) => state.draftErrors);
  const saving = useSettings(api, (state) => state.saving);
  const announcement = useSettings(api, (state) => state.announcement);
  const incoming = useSettings(api, (state) => state.incoming);
  const restartIds = useSettings(api, (state) => state.restartIds);
  const railOverlaid = useMediaQuery(RAIL_OVERLAY_QUERY);
  const editScope = useSettings(api, (state) => state.editScope);
  const update = useAppUpdateState();
  const updateRequest = useSyncExternalStore(
    subscribeUpdateSettingsRequest,
    getUpdateSettingsRequest,
    getUpdateSettingsRequest,
  );
  const [appSectionActive, setAppSectionActive] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const searching = query.trim().length > 0;
  const normalizedQuery = query.trim().toLowerCase();
  const updateMatches =
    searching &&
    "updates version release download install restart".includes(normalizedQuery);
  const roleTags = catalogChoices.roleTags ?? NO_ROLE_TAGS;
  // The specialized editors show friendly names beside the raw values, so
  // search must hit both spellings on the rows those editors own.
  const routingSearch = useMemo(() => {
    const rowValue = (id: string) => viewModel.rowsById.get(id)?.effective?.value;
    const text = modelRoutingSearchText({
      roles: recordValue(rowValue(ROLES_SETTING_ID)) ?? {},
      cycle: listValue(rowValue(CYCLE_SETTING_ID)) ?? [],
      overrides: recordValue(rowValue(OVERRIDES_SETTING_ID)) ?? {},
      disabledAgents: listValue(rowValue(DISABLED_SETTING_ID)) ?? [],
      models: catalogChoices.models,
      agentNames: catalogChoices.agents.agents.map((agent) => agent.name),
      tags: roleTags,
    });
    return new Map([
      [ROLES_SETTING_ID, text.roles],
      [CYCLE_SETTING_ID, text.cycle],
      [OVERRIDES_SETTING_ID, text.overrides],
      [DISABLED_SETTING_ID, text.disabled],
    ]);
  }, [viewModel, catalogChoices, roleTags]);
  const matchedSections = useMemo(
    () => (searching ? filterSections(viewModel.sections, query, routingSearch) : null),
    [searching, viewModel, query, routingSearch],
  );
  const matchedIds = useMemo(
    () =>
      matchedSections === null
        ? null
        : new Set([
            ...matchedSections.map((section) => section.id),
            ...(updateMatches ? [UPDATE_SECTION_ID] : []),
          ]),
    [matchedSections, updateMatches],
  );
  const activeSection = viewModel.sections.find((section) => section.id === activeSectionId);
  const shownSections: readonly SettingsSection[] =
    matchedSections ?? (appSectionActive || activeSection === undefined ? [] : [activeSection]);
  const shownUpdate = searching ? updateMatches : appSectionActive;
  const selectedSectionId = appSectionActive ? UPDATE_SECTION_ID : activeSectionId;
  const sectionsForRail = useMemo(() => buildSettingsRailSections(viewModel.sections), [viewModel.sections]);
  const railGroups = useMemo(() => buildSettingsRailGroups(viewModel.sections), [viewModel.sections]);

  const dirtyCount = Object.keys(drafts).length;
  const errorCount = Object.keys(draftErrors).length;

  // The specialized blocks own these rows wherever the host filed them; the
  // generic list hides them so the same value never renders twice.
  const rolesHome =
    viewModel.rowsById.get(ROLES_SETTING_ID)?.sectionId ??
    viewModel.rowsById.get(CYCLE_SETTING_ID)?.sectionId ??
    null;
  const tasksHome =
    viewModel.rowsById.get(OVERRIDES_SETTING_ID)?.sectionId ??
    viewModel.rowsById.get(DISABLED_SETTING_ID)?.sectionId ??
    null;
  const hiddenIds = useMemo(() => {
    if (rolesHome === null && tasksHome === null) return NO_HIDDEN;
    const ids = new Set<string>();
    if (rolesHome !== null) {
      ids.add(ROLES_SETTING_ID);
      ids.add(CYCLE_SETTING_ID);
    }
    if (tasksHome !== null) {
      ids.add(OVERRIDES_SETTING_ID);
      ids.add(DISABLED_SETTING_ID);
    }
    return ids;
  }, [rolesHome, tasksHome]);

  // Section changes land the reader at the top of the new section.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll reset keyed on the section
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [selectedSectionId]);

  useEffect(() => {
    if (!consumeUpdateSettingsRequest(updateRequest)) return;
    setAppSectionActive(true);
    requestAnimationFrame(() => document.getElementById("section-t4-updates")?.focus());
  }, [updateRequest]);

  function selectSection(id: string) {
    if (id === UPDATE_SECTION_ID) {
      setAppSectionActive(true);
      return;
    }
    setAppSectionActive(false);
    api.getState().setActiveSection(id);
  }

  async function handleSave() {
    await api.getState().save();
    // The save bar unmounts when the last draft applies; don't strand focus
    // on the removed button.
    if (document.activeElement === document.body) headingRef.current?.focus();
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-border border-b px-4 py-2">
        {onBack !== undefined && (
          <IconButton aria-label="Back to sessions" onClick={onBack} size="icon-sm">
            <ArrowLeft />
          </IconButton>
        )}
        <h1 className="font-heading font-semibold text-base" ref={headingRef} tabIndex={-1}>
          Settings
        </h1>
        {appSectionActive ? (
          <Badge variant="outline">Application</Badge>
        ) : (
          <HostSelector fallbackLabel={viewModel.hostLabel} selection={hostSelection} />
        )}
        <p aria-live="polite" className="min-w-0 flex-1 truncate text-end text-muted-foreground text-xs" role="status">
          {announcement}
        </p>
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            aria-label="Search settings"
            className={cn(FIELD_CLASS, "h-7 w-56 ps-7")}
            onChange={(event) => api.getState().setQuery(event.target.value)}
            placeholder="Search settings"
            type="search"
            value={query}
          />
        </div>
        {onOpenHosts !== undefined && (
          <Button onClick={onOpenHosts} size="sm" variant="outline">
            <Cable />
            Hosts
          </Button>
        )}
        {!appSectionActive && <ScopeTabs api={api} scopes={scopes} />}
      </header>
      {!appSectionActive && brokerStatus !== undefined && <BrokerStatusLine {...brokerStatus} />}
      {!appSectionActive && editScope === "session" && scopes.includes("session") && (
        <p className="shrink-0 border-border border-b bg-secondary/40 px-4 py-1.5 text-muted-foreground text-xs" role="note">
          Changes here apply to everything on {viewModel.hostLabel} until OMP restarts. They are
          not saved to disk.
        </p>
      )}

      <div className="flex min-h-0 min-w-0 flex-1">
        {!railOverlaid && (
          <SectionRail
            activeSectionId={selectedSectionId}
            api={api}
            matchedIds={matchedIds}
            onSelect={selectSection}
            sections={sectionsForRail}
            updateAvailable={updateIsAvailable(update.phase)}
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          {incoming !== null && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-border border-b bg-warning/8 px-4 py-2 dark:bg-warning/16">
              <p className="min-w-0 flex-1 text-sm text-warning-foreground">
                Settings changed on {viewModel.hostLabel} while you were editing.
              </p>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button onClick={() => api.getState().loadIncoming()} size="xs" variant="outline">
                  Load latest values
                </Button>
                <Button onClick={() => void api.getState().saveOverIncoming()} size="xs" variant="outline">
                  Save mine anyway
                </Button>
              </div>
            </div>
          )}
          {restartIds.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-border border-b bg-info/8 px-4 py-2 dark:bg-info/16">
              <p className="min-w-0 flex-1 text-info-foreground text-sm">
                {restartIds.length === 1
                  ? "1 saved change takes effect after OMP restarts."
                  : `${restartIds.length} saved changes take effect after OMP restarts.`}
              </p>
              {restartAction !== undefined && restartAction.notice !== null && (
                <span className="shrink-0 text-muted-foreground text-xs" role="status">
                  {restartAction.notice}
                </span>
              )}
              {restartAction !== undefined && (
                <Button
                  disabled={restartAction.busy}
                  onClick={restartAction.onRestart}
                  size="xs"
                  variant="outline"
                >
                  {restartAction.busy ? <Spinner /> : <RotateCcw />}
                  {restartAction.label}
                </Button>
              )}
              <Button onClick={() => api.getState().dismissRestart()} size="xs" variant="ghost">
                Dismiss
              </Button>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto" ref={contentRef}>
            <div className="mx-auto flex max-w-4xl flex-col gap-8 pt-6 pr-[max(1rem,var(--app-safe-area-right))] pb-[calc(1rem+var(--app-safe-area-bottom))] pl-[max(1rem,var(--app-safe-area-left))] max-sm:gap-6 max-sm:pt-4">
              {railOverlaid && (
                <label className="flex flex-col gap-1">
                  <span className="font-medium text-muted-foreground text-xs">Settings category</span>
                  <select
                    className={cn(FIELD_CLASS, "w-full")}
                    onChange={(event) => selectSection(event.target.value)}
                    value={selectedSectionId}
                  >
                    {railGroups.map((group) => (
                      <optgroup key={group.id} label={group.label}>
                        {group.sections.map((section) => (
                          <option key={section.id} value={section.id}>
                            {section.label}
                            {section.id === UPDATE_SECTION_ID && updateIsAvailable(update.phase) ? " · Update available" : ""}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
              )}

              {catalogExplorer !== undefined && <CatalogExplorerBlock input={catalogExplorer} />}

              {searching && shownSections.length === 0 && !shownUpdate && (
                <p className="py-8 text-center text-muted-foreground text-sm">
                  Nothing matches “{query.trim()}”. Try a setting name or a word from its
                  description.
                </p>
              )}

              {shownUpdate && <UpdateSettingsPanel state={update} />}

              {shownSections.map((section) => (
                <section aria-labelledby={`section-${section.id}`} key={section.id}>
                  <div className="mb-4 flex flex-col gap-1">
                    <h2
                      className="font-heading font-semibold text-foreground text-xl tracking-tight"
                      id={`section-${section.id}`}
                      tabIndex={-1}
                    >
                      {section.label}
                    </h2>
                    <p className="max-w-[70ch] text-muted-foreground text-sm leading-relaxed">{section.summary}</p>
                  </div>
                  <SectionRows api={api} hiddenIds={hiddenIds} section={section} />
                  {section.id === rolesHome && (
                    <ModelRolesBlock api={api} hostLabel={viewModel.hostLabel} models={catalogChoices.models} roleTags={roleTags} />
                  )}
                  {section.id === tasksHome && (
                    <TaskAgentsBlock
                      agents={catalogChoices.agents}
                      api={api}
                      hostLabel={viewModel.hostLabel}
                      models={catalogChoices.models}
                    />
                  )}
                  {section.id === "appearance" && (
                    <div className="mt-3 rounded-lg border border-border bg-card">
                      <AccentRow />
                    </div>
                  )}
                  {section.id === "diagnostics" && (
                    <div className="mt-3">
                      <DiagnosticsActions api={api} />
                    </div>
                  )}
                </section>
              ))}
            </div>
          </div>

          {(dirtyCount > 0 || saving) && (
            <footer className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-border border-t bg-background pt-2 pr-[max(1rem,var(--app-safe-area-right))] pb-[calc(0.5rem+var(--app-safe-area-bottom))] pl-[max(1rem,var(--app-safe-area-left))]">
              <p className="text-sm">
                {dirtyCount === 1 ? "1 unsaved change" : `${dirtyCount} unsaved changes`}
                {errorCount > 0 && (
                  <span className="text-destructive-foreground">
                    {" "}
                    · {errorCount === 1 ? "1 field needs attention" : `${errorCount} fields need attention`}
                  </span>
                )}
              </p>
              <div className="ms-auto flex shrink-0 items-center gap-1.5">
                <Button
                  disabled={saving}
                  onClick={() => api.getState().discardAll()}
                  size="sm"
                  variant="outline"
                >
                  Discard all
                </Button>
                <Button disabled={saving || errorCount > 0} onClick={() => void handleSave()} size="sm">
                  {saving && <Spinner />}
                  Save changes
                </Button>
              </div>
            </footer>
          )}
        </div>
      </div>
    </div>
  );
}
