// Host connection menu: local and remote hosts grouped, each row naming
// its exact state, why it is in it, and the one safe action available from
// here. A cached host never claims to be connected; a skewed host says what
// still works. Standalone: state in, intents out.
import { Badge, Button, cn } from "@t4-code/ui";

import { GroupLabel, ToneBadge } from "./bits.tsx";
import {
  groupHosts,
  HOST_STATE_META,
  type HostActionId,
  type HostRow,
} from "./hosts.ts";

export interface HostConnectionMenuProps {
  readonly hosts: readonly HostRow[];
  /** Open a usable host (row activation). */
  readonly onOpenHost: (hostId: string) => void;
  /** The row's one safe action (retry, diagnostics, update…). */
  readonly onHostAction: (hostId: string, action: HostActionId) => void;
  /** Entry point for pairing another computer; hidden when omitted. */
  readonly onAddHost?: (() => void) | undefined;
}

function HostMenuRow({
  host,
  onOpenHost,
  onHostAction,
}: {
  readonly host: HostRow;
  readonly onOpenHost: HostConnectionMenuProps["onOpenHost"];
  readonly onHostAction: HostConnectionMenuProps["onHostAction"];
}) {
  const meta = HOST_STATE_META[host.state];
  const action = meta.action;
  const openable = host.state === "ready" || host.state === "read-only" || host.state === "version-skew";
  return (
    <li
      className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2.5"
      data-host-state={host.state}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium text-sm">{host.name}</span>
        {host.identity !== null && (
          <span className="hidden shrink-0 truncate text-muted-foreground text-xs sm:inline">
            {host.identity.account}
          </span>
        )}
        {host.protocolLabel !== null && (
          <Badge className="font-mono" size="sm" variant="outline">
            {host.protocolLabel}
          </Badge>
        )}
        <ToneBadge label={meta.label} live={meta.live} tone={meta.tone} />
      </div>
      <p className="text-muted-foreground text-xs">{host.reason}</p>
      {(openable || action !== null || host.sessionCount !== null) && (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {openable && (
            <Button onClick={() => onOpenHost(host.id)} size="xs" variant="outline">
              {host.state === "read-only" ? "Open (view only)" : "Open sessions"}
            </Button>
          )}
          {action !== null && (
            <Button
              onClick={() => onHostAction(host.id, action.id)}
              size="xs"
              variant={openable ? "ghost" : "outline"}
            >
              {action.label}
            </Button>
          )}
          {host.sessionCount !== null && (
            <span
              className={cn(
                "ms-auto text-muted-foreground text-xs tabular-nums",
                host.state === "offline-cache" && "italic",
              )}
            >
              {host.sessionCount} {host.sessionCount === 1 ? "session" : "sessions"}
              {host.state === "offline-cache" && " (cached)"}
            </span>
          )}
        </div>
      )}
    </li>
  );
}

export function HostConnectionMenu({
  hosts,
  onOpenHost,
  onHostAction,
  onAddHost,
}: HostConnectionMenuProps) {
  const groups = groupHosts(hosts);
  return (
    <div aria-label="Hosts" className="flex min-w-0 flex-col gap-4" role="group">
      {groups.length === 0 && (
        <p className="rounded-lg border border-border border-dashed px-3 py-4 text-center text-muted-foreground text-sm">
          No hosts yet. Sessions live on a host — this computer counts once its T4 host runs.
        </p>
      )}
      {groups.map((group) => (
        <section aria-labelledby={`host-group-${group.kind}`} key={group.kind}>
          <GroupLabel id={`host-group-${group.kind}`}>{group.label}</GroupLabel>
          <ul className="flex flex-col gap-1.5">
            {group.hosts.map((host) => (
              <HostMenuRow
                host={host}
                key={host.id}
                onHostAction={onHostAction}
                onOpenHost={onOpenHost}
              />
            ))}
          </ul>
        </section>
      ))}
      {onAddHost !== undefined && (
        <div>
          <Button onClick={onAddHost} size="sm" variant="outline">
            Pair another computer…
          </Button>
        </div>
      )}
    </div>
  );
}
