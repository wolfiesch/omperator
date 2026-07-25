import { cn } from "@t4-code/ui";
import { Popover } from "@base-ui/react/popover";
import { RotateCcw, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { type ProjectGroup, type RailOrganization, type RailSort } from "../../lib/session-tree.ts";
import { workspaceStore } from "../../state/store-instance.ts";

export function RailOptionsMenu({
  hiddenGroups,
  organization,
  sort,
}: {
  hiddenGroups: readonly ProjectGroup[];
  organization: RailOrganization;
  sort: RailSort;
}) {
  const [open, setOpen] = useState(false);
  const option = (selected: boolean, label: string, onSelect: () => void) => (
    <button
      aria-pressed={selected}
      className={cn(
        "flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8",
        selected && "bg-secondary font-medium",
      )}
      onClick={() => {
        onSelect();
        setOpen(false);
      }}
      type="button"
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", selected ? "bg-brand" : "bg-transparent")}
      />
      {label}
    </button>
  );

  return (
    <Popover.Root onOpenChange={setOpen} open={open}>
      <Popover.Trigger
        aria-label="Organize sessions"
        className="flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <SlidersHorizontal aria-hidden="true" className="size-3.5" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" className="z-50" side="bottom" sideOffset={4}>
          <Popover.Popup className="w-[min(15rem,calc(100vw-1rem))] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-(--overlay-shadow) outline-none">
            <Popover.Title className="px-2 pt-1 pb-1 font-medium text-muted-foreground text-xs">
              Organize sidebar
            </Popover.Title>
            {option(organization === "by-project", "By project", () =>
              workspaceStore.getState().setRailOrganization("by-project"),
            )}
            {option(organization === "flat", "In one list", () =>
              workspaceStore.getState().setRailOrganization("flat"),
            )}
            <div className="my-1 border-border border-t" />
            <p className="px-2 pt-1 pb-1 font-medium text-muted-foreground text-xs">Sort by</p>
            {option(sort === "priority", "Priority", () =>
              workspaceStore.getState().setRailSort("priority"),
            )}
            {option(sort === "updated", "Last updated", () =>
              workspaceStore.getState().setRailSort("updated"),
            )}
            {option(sort === "manual", "Manual order", () =>
              workspaceStore.getState().setRailSort("manual"),
            )}
            {hiddenGroups.length > 0 && (
              <>
                <div className="my-1 border-border border-t" />
                <p className="px-2 pt-1 pb-1 font-medium text-muted-foreground text-xs">
                  Hidden projects
                </p>
                {hiddenGroups.map((group) => (
                  <button
                    className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
                    key={group.project.id}
                    onClick={() => {
                      workspaceStore.getState().setProjectHidden(group.project.id, false);
                      setOpen(false);
                    }}
                    type="button"
                  >
                    <RotateCcw aria-hidden="true" className="size-4" />
                    <span className="min-w-0 flex-1 truncate">Show {group.displayName}</span>
                  </button>
                ))}
              </>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
