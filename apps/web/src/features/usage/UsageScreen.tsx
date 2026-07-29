import {
  Badge,
  Button,
  cn,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  IconButton,
  Skeleton,
} from "@t4-code/ui";
import {
  ArrowLeft,
  Cable,
  CircleAlert,
  Gauge,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { useEffect, useState } from "react";

import { ToneBadge } from "../onboarding/bits.tsx";
import { FIELD_CLASS } from "../settings/controls.tsx";
import type { UsageAvailability, UsageRuntimePort } from "./controller.ts";
import {
  ageLabel,
  capacityLabel,
  limitDisplayName,
  reportIdentityDetail,
  resetLabel,
  savedResetLabel,
  usageAmountLabel,
} from "./format.ts";
import {
  accountIdentityLabel,
  providerDisplayName,
  reportAccountLabel,
  reportStatus,
  resolveUsedFraction,
  resolvedUsageStatus,
  usageProviderGroups,
  type UsageLimit,
  type UsageProviderGroup,
  type UsageReport,
  type UsageSnapshot,
  type UsageStatus,
} from "./model.ts";
import {
  createUsageStore,
  selectedUsageState,
  useUsage,
  type UsageStoreApi,
} from "./store.ts";

const STALE_AFTER_MS = 5 * 60_000;

const STATUS_PRESENTATION: Readonly<
  Record<
    UsageStatus,
    {
      readonly label: string;
      readonly tone: "success" | "warning" | "error" | "muted";
      readonly badge: "success" | "warning" | "error" | "outline";
      readonly fill: string;
    }
  >
> = {
  ok: { label: "Available", tone: "success", badge: "success", fill: "bg-success" },
  warning: { label: "Running low", tone: "warning", badge: "warning", fill: "bg-warning" },
  exhausted: { label: "Exhausted", tone: "error", badge: "error", fill: "bg-destructive" },
  unknown: { label: "Unknown", tone: "muted", badge: "outline", fill: "bg-muted-foreground" },
};

function UsageHeader({
  api,
  onBack,
}: {
  readonly api: UsageStoreApi;
  readonly onBack: () => void;
}) {
  const targets = useUsage(api, (state) => state.targets);
  const selectedTargetId = useUsage(api, (state) => state.selectedTargetId);
  const entry = useUsage(api, selectedUsageState);
  const announcement = useUsage(api, (state) => state.announcement);

  return (
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-border border-b px-4 py-2">
      <IconButton aria-label="Back to sessions" onClick={onBack} size="icon-sm">
        <ArrowLeft />
      </IconButton>
      <Gauge aria-hidden="true" className="size-4 text-muted-foreground" />
      <h1 className="font-heading font-semibold text-base">Usage</h1>
      <p aria-live="polite" className="sr-only" role="status">
        {announcement}
      </p>
      {targets.length > 0 && selectedTargetId !== null && (
        <div className="order-last flex w-full min-w-0 items-center gap-1.5 sm:order-none sm:ms-auto sm:w-auto">
          <label className="min-w-0 flex-1 sm:w-60 sm:flex-none" htmlFor="usage-target">
            <span className="sr-only">OMP profile or host</span>
            <select
              className={cn(FIELD_CLASS, "w-full")}
              id="usage-target"
              onChange={(event) => api.getState().selectTarget(event.target.value)}
              value={selectedTargetId}
            >
              {targets.map((target) => (
                <option key={target.targetId} value={target.targetId}>
                  {target.label} · {target.detail}
                </option>
              ))}
            </select>
          </label>
          <IconButton
            aria-label={entry?.loading ? "Refreshing usage" : "Refresh usage"}
            disabled={entry?.loading}
            onClick={() => void api.getState().refresh()}
            size="icon-sm"
          >
            <RefreshCw
              className={cn(entry?.loading && "animate-spin motion-reduce:animate-none")}
            />
          </IconButton>
        </div>
      )}
    </header>
  );
}

function StaticUsageHeader({ onBack }: { readonly onBack: () => void }) {
  return (
    <header className="flex min-h-12 shrink-0 items-center gap-3 border-border border-b px-4 py-2">
      <IconButton aria-label="Back to sessions" onClick={onBack} size="icon-sm">
        <ArrowLeft />
      </IconButton>
      <Gauge aria-hidden="true" className="size-4 text-muted-foreground" />
      <h1 className="font-heading font-semibold text-base">Usage</h1>
    </header>
  );
}

const AVAILABILITY_COPY: Readonly<
  Record<Exclude<UsageAvailability, "ready">, { readonly title: string; readonly detail: string }>
> = {
  "no-host": {
    title: "No OMP host is connected",
    detail: "Connect a local profile or paired host, then T4 Code can read the same account usage OMP shows.",
  },
  connecting: {
    title: "Connecting to OMP",
    detail: "Usage will load when the profile finishes connecting and publishes its command list.",
  },
  "waiting-catalog": {
    title: "Waiting for OMP's command list",
    detail: "The host is connected. T4 Code is waiting to confirm that this OMP build offers account usage.",
  },
  unsupported: {
    title: "Usage is not available from this host",
    detail: "This OMP build has not published account usage to T4 Code, or this device does not have permission to read it.",
  },
};

function UnavailableUsage({
  availability,
  onOpenHosts,
  browserOnly = false,
}: {
  readonly availability: Exclude<UsageAvailability, "ready">;
  readonly onOpenHosts: () => void;
  readonly browserOnly?: boolean;
}) {
  const copy = browserOnly
    ? {
        title: "Usage is available in the desktop app",
        detail: "This browser view has no OMP runtime connection. Open T4 Code on a desktop to see account limits.",
      }
    : AVAILABILITY_COPY[availability];
  return (
    <Empty className="flex-1 border-0 px-4">
      <EmptyHeader>
        <EmptyTitle>{copy.title}</EmptyTitle>
        <EmptyDescription>{copy.detail}</EmptyDescription>
      </EmptyHeader>
      {!browserOnly && (
        <EmptyContent>
          <Button onClick={onOpenHosts} variant="outline">
            <Cable />
            Manage hosts
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
}

function UsageLoading() {
  return (
    <div aria-busy="true" aria-label="Loading account usage" className="flex flex-col gap-4" role="status">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-3 w-56 max-w-full" />
        </div>
        <Skeleton className="h-5 w-20" />
      </div>
      {[0, 1].map((item) => (
        <section className="overflow-hidden rounded-lg border border-border" key={item}>
          <div className="flex items-center justify-between border-border border-b px-4 py-3">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-16" />
          </div>
          <div className="flex flex-col gap-3 px-4 py-3">
            <Skeleton className="h-3 w-44" />
            <Skeleton className="h-2 w-full" />
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
        </section>
      ))}
    </div>
  );
}

function ErrorNotice({ message }: { readonly message: string }) {
  return (
    <div
      className="flex items-start gap-2.5 rounded-lg bg-destructive/8 px-3 py-2.5 text-destructive-foreground dark:bg-destructive/16"
      role="alert"
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <p className="font-medium text-sm">Usage refresh failed</p>
        <p className="mt-0.5 text-xs">{message}</p>
      </div>
    </div>
  );
}

function AccountNotes({ notes }: { readonly notes: readonly string[] | undefined }) {
  if (notes === undefined || notes.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-muted-foreground text-xs">
      {notes.map((note, index) => (
        <li className="flex items-start gap-1.5" key={`${note}-${index}`}>
          <span aria-hidden="true" className="mt-[0.45rem] size-1 shrink-0 rounded-full bg-muted-foreground" />
          <span className="min-w-0 break-words">{note}</span>
        </li>
      ))}
    </ul>
  );
}

function UsageMeter({ limit, nowMs }: { readonly limit: UsageLimit; readonly nowMs: number }) {
  const status = resolvedUsageStatus(limit);
  const presentation = STATUS_PRESENTATION[status];
  const fraction = resolveUsedFraction(limit);
  const clamped = fraction === undefined ? 0 : Math.min(1, Math.max(0, fraction));
  const reset = resetLabel(limit, nowMs);
  return (
    <li className="flex flex-col gap-1.5 py-2.5 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
        <p className="min-w-0 flex-1 font-medium text-sm">{limitDisplayName(limit)}</p>
        <Badge size="sm" variant={presentation.badge}>
          {presentation.label}
        </Badge>
      </div>
      <div
        {...(fraction === undefined
          ? { "aria-label": `${limitDisplayName(limit)} usage was not reported` }
          : {
              "aria-label": `${limitDisplayName(limit)} ${(fraction * 100).toFixed(1)} percent used`,
              "aria-valuemax": 100,
              "aria-valuemin": 0,
              "aria-valuenow": Math.round(clamped * 100),
              role: "progressbar",
            })}
        className="h-1.5 overflow-hidden rounded-full bg-secondary"
      >
        {fraction !== undefined && (
          <div
            aria-hidden="true"
            className={cn("h-full rounded-full transition-[width] duration-(--motion-duration-slow)", presentation.fill)}
            style={{ width: `${clamped * 100}%` }}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground text-xs tabular-nums">
        <span>{usageAmountLabel(limit)}</span>
        {reset !== null && (
          <>
            <span aria-hidden="true">·</span>
            <span>{reset}</span>
          </>
        )}
      </div>
      <AccountNotes notes={limit.notes} />
    </li>
  );
}

function UsageAccount({
  report,
  index,
  nowMs,
}: {
  readonly report: UsageReport;
  readonly index: number;
  readonly nowMs: number;
}) {
  const account = reportAccountLabel(report, index);
  const identityDetail = reportIdentityDetail(report, account);
  const savedReset = savedResetLabel(report, nowMs);
  const status = STATUS_PRESENTATION[reportStatus(report)];
  return (
    <li className="flex flex-col gap-3 px-4 py-3.5">
      <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <ToneBadge label={status.label} tone={status.tone} />
            <h3 className="min-w-0 truncate font-medium text-sm" title={account}>
              {account}
            </h3>
          </div>
          {identityDetail !== null && (
            <p className="mt-0.5 truncate text-muted-foreground text-xs" title={identityDetail}>
              {identityDetail}
            </p>
          )}
        </div>
        <time
          className="shrink-0 text-muted-foreground text-xs tabular-nums"
          dateTime={new Date(report.fetchedAt).toISOString()}
        >
          Fetched {ageLabel(report.fetchedAt, nowMs)}
        </time>
      </div>
      {savedReset !== null && (
        <div className="flex items-center gap-1.5 text-info-foreground text-xs">
          <RotateCcw aria-hidden="true" className="size-3.5" />
          <span>{savedReset}</span>
        </div>
      )}
      <AccountNotes notes={report.notes} />
      {report.limits.length === 0 ? (
        <p className="rounded-md bg-secondary px-3 py-2 text-muted-foreground text-xs">
          This account returned no limit windows.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {report.limits.map((limit, limitIndex) => (
            <UsageMeter key={`${limit.id}-${limitIndex}`} limit={limit} nowMs={nowMs} />
          ))}
        </ul>
      )}
    </li>
  );
}

function ProviderSection({
  group,
  index,
  nowMs,
}: {
  readonly group: UsageProviderGroup;
  readonly index: number;
  readonly nowMs: number;
}) {
  const totalAccounts = group.reports.length + group.accountsWithoutUsage.length;
  const headingId = `usage-provider-${index}`;
  return (
    <section aria-labelledby={headingId} className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex min-w-0 flex-col gap-2 border-border border-b px-4 py-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="font-heading font-semibold text-sm" id={headingId}>
            {providerDisplayName(group.provider)}
          </h2>
          <Badge variant="outline">
            {totalAccounts} {totalAccounts === 1 ? "account" : "accounts"}
          </Badge>
        </div>
        {group.capacity.length > 0 && (
          <ul className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-muted-foreground text-xs tabular-nums sm:ms-auto sm:justify-end">
            {group.capacity.map((stat, index) => (
              <li className="whitespace-nowrap" key={`${stat.window}-${index}`}>
                <span className="font-medium text-foreground">{stat.window}</span>
                <span aria-hidden="true"> · </span>
                {capacityLabel(stat)}
              </li>
            ))}
          </ul>
        )}
      </div>
      <ol className="divide-y divide-border">
        {group.reports.map((report, index) => (
          <UsageAccount index={index} key={`${report.fetchedAt}-${index}`} nowMs={nowMs} report={report} />
        ))}
        {group.accountsWithoutUsage.map((account, index) => {
          const label = accountIdentityLabel(account);
          const organization = account.orgName ?? account.orgId;
          return (
            <li className="flex min-w-0 items-start gap-2.5 px-4 py-3" key={`${account.type}-${label}-${index}`}>
              <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-sm" title={label}>
                  {label}
                </p>
                <p className="break-words text-muted-foreground text-xs">
                  {organization === undefined ? "No usage data returned" : `${organization} · No usage data returned`}
                </p>
              </div>
              <Badge variant="outline">Not reported</Badge>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function UsageContent({ snapshot, nowMs }: { readonly snapshot: UsageSnapshot; readonly nowMs: number }) {
  const groups = usageProviderGroups(snapshot);
  const stale = nowMs - snapshot.generatedAt > STALE_AFTER_MS;
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <h2 className="font-heading font-semibold text-sm">Connected account capacity</h2>
          <p className="mt-0.5 max-w-[70ch] text-muted-foreground text-xs">
            Live provider windows from OMP's account broker. A profile only shows the accounts available to that profile.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {stale && <Badge variant="warning">Stale</Badge>}
          <time
            className="text-muted-foreground text-xs tabular-nums"
            dateTime={new Date(snapshot.generatedAt).toISOString()}
          >
            Updated {ageLabel(snapshot.generatedAt, nowMs)}
          </time>
        </div>
      </div>
      {groups.length === 0 ? (
        <Empty className="rounded-lg border border-border py-12">
          <EmptyHeader>
            <EmptyTitle>No usage-capable accounts found</EmptyTitle>
            <EmptyDescription>
              OMP returned no provider reports or unmatched accounts for this profile. Add an account with OMP's login flow, then refresh.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((group, index) => (
            <ProviderSection group={group} index={index} key={group.provider} nowMs={nowMs} />
          ))}
        </div>
      )}
    </>
  );
}

function LiveUsageScreen({
  controller,
  onBack,
  onOpenHosts,
}: {
  readonly controller: UsageRuntimePort;
  readonly onBack: () => void;
  readonly onOpenHosts: () => void;
}) {
  const [api] = useState(() => createUsageStore(controller));
  const availability = useUsage(api, (state) => state.availability);
  const entry = useUsage(api, selectedUsageState);
  const [nowMs, setNowMs] = useState(Date.now);

  useEffect(() => {
    const sync = () => api.getState().syncTargets();
    const unsubscribe = controller.subscribe(sync);
    sync();
    void api.getState().refresh();
    const interval = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => {
      clearInterval(interval);
      unsubscribe();
    };
  }, [api, controller]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground">
      <UsageHeader api={api} onBack={onBack} />
      {availability !== "ready" ? (
        <UnavailableUsage availability={availability} onOpenHosts={onOpenHosts} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-4xl flex-col gap-4 pt-4 pr-[max(1rem,var(--app-safe-area-right))] pb-[calc(1rem+var(--app-safe-area-bottom))] pl-[max(1rem,var(--app-safe-area-left))]">
            {entry.error !== null && entry.snapshot !== null && <ErrorNotice message={entry.error} />}
            {entry.snapshot === null ? (
              entry.loading ? (
                <UsageLoading />
              ) : entry.error === null ? (
                <UsageLoading />
              ) : (
                <Empty className="rounded-lg border border-border py-12">
                  <EmptyHeader>
                    <EmptyTitle>Account usage couldn't load</EmptyTitle>
                    <EmptyDescription>{entry.error}</EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button onClick={() => void api.getState().refresh()} variant="outline">
                      Try again
                    </Button>
                  </EmptyContent>
                </Empty>
              )
            ) : (
              <UsageContent nowMs={nowMs} snapshot={entry.snapshot} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function UsageScreen({
  controller,
  onBack,
  onOpenHosts,
}: {
  readonly controller: UsageRuntimePort | null;
  readonly onBack: () => void;
  readonly onOpenHosts: () => void;
}) {
  if (controller === null) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground">
        <StaticUsageHeader onBack={onBack} />
        <UnavailableUsage availability="no-host" browserOnly onOpenHosts={onOpenHosts} />
      </div>
    );
  }
  return <LiveUsageScreen controller={controller} onBack={onBack} onOpenHosts={onOpenHosts} />;
}
