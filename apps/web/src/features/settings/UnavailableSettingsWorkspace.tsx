import { Badge, Button, IconButton, Spinner } from "@t4-code/ui";
import { ArrowLeft, Cable, CircleAlert } from "lucide-react";

import { RAIL_OVERLAY_QUERY, useMediaQuery } from "../../hooks/useMediaQuery.ts";
import { updateIsAvailable, type AppUpdateState } from "../updates/update-model.ts";
import { UpdateSettingsPanel } from "../updates/UpdateSettingsPanel.tsx";
import { HostSelector, type HostSelection } from "./HostSelector.tsx";
import { CatalogExplorerBlock } from "./CatalogExplorerBlock.tsx";
import type { CatalogExplorerInput } from "./settings-presentation.ts";

export interface UnavailableSettingsCopy {
  readonly title: string;
  readonly detail: string;
  readonly spin: boolean;
  readonly error: boolean;
}

/** App-owned settings stay usable while host-owned OMP settings are unavailable. */
export function UnavailableSettingsWorkspace({
  copy,
  onBack,
  onOpenHosts,
  update,
  hostSelection,
  catalogExplorer,
}: {
  readonly copy: UnavailableSettingsCopy;
  readonly onBack: () => void;
  readonly onOpenHosts: () => void;
  readonly update: AppUpdateState;
  /** Other connected hosts to switch to while this one is out. */
  readonly hostSelection?: HostSelection;
  /** The active host's read-only catalog state, when its identity is known. */
  readonly catalogExplorer?: CatalogExplorerInput;
}) {
  const railOverlaid = useMediaQuery(RAIL_OVERLAY_QUERY);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-border border-b px-4 py-2">
        <IconButton aria-label="Back to sessions" onClick={onBack} size="icon-sm">
          <ArrowLeft />
        </IconButton>
        <h1 className="font-heading font-semibold text-base">Settings</h1>
        <Badge variant="outline">Application</Badge>
        <HostSelector fallbackLabel={null} selection={hostSelection} />
        <span className="min-w-0 flex-1" />
        <Button onClick={onOpenHosts} size="sm" variant="outline">
          <Cable />
          Hosts
        </Button>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1">
        {!railOverlaid && (
          <nav aria-label="Settings sections" className="flex w-52 shrink-0 flex-col overflow-y-auto border-border border-e py-2">
            <ul className="px-2">
              <li>
                <div
                  aria-current="true"
                  className="relative flex h-8 items-center gap-2 rounded-md bg-secondary px-2.5 font-medium text-foreground text-sm"
                >
                  <span aria-hidden="true" className="absolute inset-y-1.5 start-0 w-0.5 rounded-full bg-primary" />
                  <span className="min-w-0 flex-1 truncate">Updates</span>
                  {updateIsAvailable(update.phase) && (
                    <span aria-label="T4 Code update available" className="size-1.5 rounded-full bg-primary" />
                  )}
                </div>
              </li>
            </ul>
          </nav>
        )}

        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-4">
            {railOverlaid && (
              <label className="flex flex-col gap-1">
                <span className="font-medium text-muted-foreground text-xs">Section</span>
                <select
                  className="h-8 rounded-md border border-input bg-popover px-2 text-foreground text-sm"
                  onChange={() => undefined}
                  value="t4-updates"
                >
                  <option value="t4-updates">
                    Updates{updateIsAvailable(update.phase) ? " · Update available" : ""}
                  </option>
                </select>
              </label>
            )}
            <UpdateSettingsPanel state={update} />
            {catalogExplorer !== undefined && <CatalogExplorerBlock input={catalogExplorer} />}

            <section aria-labelledby="host-settings-unavailable">
              <div className="mb-2 flex flex-col gap-0.5">
                <h2 className="font-heading font-semibold text-foreground text-sm" id="host-settings-unavailable">
                  Host settings
                </h2>
                <p className="max-w-[70ch] text-muted-foreground text-xs">
                  OMP settings appear here after a host publishes its settings catalog.
                </p>
              </div>
              <div className="flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-3 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-start gap-2.5">
                  {copy.spin ? (
                    <Spinner className="mt-0.5 shrink-0" />
                  ) : (
                    <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0">
                    <p className="font-medium text-sm">{copy.title}</p>
                    <p className="mt-0.5 max-w-[60ch] text-muted-foreground text-xs" role={copy.error ? "alert" : "status"}>
                      {copy.detail}
                    </p>
                  </div>
                </div>
                <Button className="min-h-11 w-full shrink-0 sm:min-h-8 sm:w-auto" onClick={onOpenHosts} size="sm" variant="outline">
                  Manage hosts
                </Button>
              </div>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}
