import type { DesktopRuntimeSnapshot } from "@t4-code/client";
import {
  Badge,
  Button,
  cn,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  StatusPill,
} from "@t4-code/ui";
import { ArrowLeft, ExternalLink, Search, UsersRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { formatElapsed, AGENT_STATE_STYLES } from "../panes/agent-tree.ts";
import type { AgentNode } from "../panes/model.ts";
import { useNowTick } from "../panes/hooks.ts";
import {
  agentCancelAvailability,
  cancelAgentFromView,
  deriveAgentViewGroups,
  filterAgentViewGroups,
  pageAgentViewGroups,
  summarizeAgentView,
  type AgentViewDisplayGroup,
  type AgentViewDisplayRow,
  type AgentViewFilter,
  type AgentViewGroup,
  type AgentViewRow,
  type AgentViewRuntime,
  type AgentViewSummary,
} from "./model.ts";

interface PendingCancel {
  readonly group: AgentViewGroup;
  readonly row: AgentViewRow;
}

function StateDot({ node }: { readonly node: AgentNode }) {
  const style = AGENT_STATE_STYLES[node.state];
  return (
    <span aria-hidden="true" className="relative flex size-2 shrink-0">
      {style.pulse && (
        <span
          className={cn(
            "absolute inline-flex size-full animate-ping rounded-full opacity-75 motion-reduce:hidden",
            style.dotClass,
          )}
        />
      )}
      <span className={cn("relative inline-flex size-2 rounded-full", style.dotClass)} />
    </span>
  );
}

function AgentCard({
  group,
  nowMs,
  row,
  sampleMode,
  snapshot,
  onCancel,
  onInspect,
}: {
  readonly group: AgentViewDisplayGroup;
  readonly nowMs: number;
  readonly row: AgentViewDisplayRow;
  readonly sampleMode: boolean;
  readonly snapshot: DesktopRuntimeSnapshot | null;
  readonly onCancel: () => void;
  readonly onInspect: () => void;
}) {
  const { node } = row;
  const style = AGENT_STATE_STYLES[node.state];
  const availability =
    sampleMode || snapshot === null
      ? { enabled: false, reason: "Sample data is local and cannot stop an agent." }
      : agentCancelAvailability(snapshot, group.viewId, node);
  const elapsed = node.state === "running" ? formatElapsed(node.startedAt, nowMs) : "";
  const contextPercent =
    node.contextUsed === null || node.contextLimit === null || node.contextLimit === 0
      ? null
      : Math.round((node.contextUsed / node.contextLimit) * 100);
  return (
    <li
      className={cn(
        "rounded-xl border border-border bg-card p-3 shadow-sm/5",
        row.depth > 0 && "border-s-2 border-s-primary/35",
      )}
      style={{ marginInlineStart: `${Math.min(row.depth, 4) * 16}px` }}
    >
      {row.parent !== null && (
        <p className="mb-1 truncate text-muted-foreground text-xs">
          Depth {row.depth} · Parent: {row.parent.title}
        </p>
      )}
      <div className="flex min-w-0 items-center gap-2">
        <StateDot node={node} />
        <h3 className="min-w-0 flex-1 truncate font-medium text-sm">{node.title}</h3>
        {row.resumable === true && node.state === "parked" && (
          <Badge variant="outline">Resumable</Badge>
        )}
        <span className={cn("shrink-0 text-xs", style.textClass)}>{style.label}</span>
      </div>
      {row.task !== null && (
        <p className="mt-1 [overflow-wrap:anywhere] text-foreground/90 text-sm leading-snug">
          {row.task}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
        {node.model !== null && <span className="font-mono">{node.model}</span>}
        {elapsed !== "" && (
          <span aria-label={`Running for ${elapsed}`} className="font-mono tabular-nums">
            {elapsed}
          </span>
        )}
        {node.currentTool !== null && <span className="font-mono">Tool: {node.currentTool}</span>}
        {contextPercent !== null && (
          <span aria-label={`Context ${contextPercent}% used`}>Context {contextPercent}%</span>
        )}
      </div>
      {node.progress !== null && (
        <div className="mt-2">
          <div className="mb-1 flex items-center justify-between text-muted-foreground text-xs">
            <span>Progress</span>
            <span>{Math.round(node.progress * 100)}%</span>
          </div>
          <div
            aria-label={`${Math.round(node.progress * 100)}% done`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.round(node.progress * 100)}
            className="h-1.5 overflow-hidden rounded-full bg-secondary"
            role="progressbar"
          >
            <span
              className="block h-full rounded-full bg-primary transition-[width] duration-(--motion-duration-slow)"
              style={{ width: `${Math.round(node.progress * 100)}%` }}
            />
          </div>
        </div>
      )}
      {node.evidence !== null && (
        <p className="mt-2 [overflow-wrap:anywhere] rounded-md bg-secondary/60 px-2 py-1.5 text-muted-foreground text-xs">
          {node.evidence}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-border border-t pt-2">
        <Button
          aria-label={`Inspect ${node.title} in ${group.session.title}`}
          className="min-h-11 sm:min-h-8"
          onClick={onInspect}
          size="sm"
          variant="outline"
        >
          Inspect
          <ExternalLink aria-hidden="true" />
        </Button>
        <Button
          className="min-h-11 sm:min-h-8"
          disabled={!availability.enabled}
          onClick={onCancel}
          size="sm"
          title={availability.reason ?? undefined}
          variant="destructive-outline"
        >
          Cancel agent
        </Button>
      </div>
    </li>
  );
}

function SummaryStrip({ summary }: { readonly summary: AgentViewSummary }) {
  const metrics = [
    { label: "Loaded sessions", value: summary.sessions },
    { label: "Loaded agents", value: summary.agents },
    { label: "Running now", value: summary.running },
    { label: "Need attention", value: summary.attention },
  ];
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {metrics.map((metric) => (
        <div className="rounded-lg border border-border bg-card px-3 py-2" key={metric.label}>
          <dt className="text-muted-foreground text-xs">{metric.label}</dt>
          <dd className="font-semibold text-lg tabular-nums">{metric.value}</dd>
        </div>
      ))}
    </dl>
  );
}

type AgentViewFixtureProps =
  | {
      readonly fixtureGroups?: never;
      readonly fixtureNowMs?: never;
    }
  | {
      readonly fixtureGroups: readonly AgentViewGroup[];
      readonly fixtureNowMs: number;
    };

interface AgentViewScreenProps {
  readonly controller: AgentViewRuntime | null;
  readonly snapshot: DesktopRuntimeSnapshot | null;
  readonly onBack: () => void;
  readonly onOpenSession: (sessionId: string, agentId?: string) => void;
}

export const AGENT_VIEW_PAGE_SIZE = 100;

export function reconcileAgentViewPageIndex(pageIndex: number, pageCount: number): number {
  return Math.min(Math.max(0, pageIndex), Math.max(0, pageCount - 1));
}

export function AgentViewScreen({
  controller,
  fixtureGroups,
  fixtureNowMs,
  snapshot,
  onBack,
  onOpenSession,
}: AgentViewScreenProps & AgentViewFixtureProps) {
  const groups = useMemo(
    () => (snapshot === null ? (fixtureGroups ?? []) : deriveAgentViewGroups(snapshot)),
    [fixtureGroups, snapshot],
  );
  const sampleMode = snapshot === null && fixtureGroups !== undefined;
  const summary = useMemo(() => summarizeAgentView(groups), [groups]);
  const liveNowMs = useNowTick(summary.running > 0 && !sampleMode);
  const nowMs = sampleMode && fixtureNowMs !== undefined ? fixtureNowMs : liveNowMs;
  const [filter, setFilter] = useState<AgentViewFilter>("all");
  const [query, setQuery] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [pending, setPending] = useState<PendingCancel | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const filteredGroups = useMemo(
    () => filterAgentViewGroups(groups, filter, query),
    [filter, groups, query],
  );
  const filteredCount = filteredGroups.reduce((sum, group) => sum + group.agents.length, 0);
  const pageCount = Math.max(1, Math.ceil(filteredCount / AGENT_VIEW_PAGE_SIZE));
  const currentPageIndex = reconcileAgentViewPageIndex(pageIndex, pageCount);
  useEffect(() => {
    setPageIndex((current) => reconcileAgentViewPageIndex(current, pageCount));
  }, [pageCount]);
  const page = useMemo(
    () =>
      pageAgentViewGroups(
        filteredGroups,
        AGENT_VIEW_PAGE_SIZE,
        currentPageIndex * AGENT_VIEW_PAGE_SIZE,
      ),
    [currentPageIndex, filteredGroups],
  );
  const pageStart =
    page.visibleAgents === 0 ? 0 : currentPageIndex * AGENT_VIEW_PAGE_SIZE + 1;
  const pageEnd = currentPageIndex * AGENT_VIEW_PAGE_SIZE + page.visibleAgents;
  const filterOptions: ReadonlyArray<{
    id: AgentViewFilter;
    label: string;
    count: number;
  }> = [
    { id: "all", label: "All", count: summary.agents },
    { id: "active", label: "Active", count: summary.agents - summary.finished },
    { id: "attention", label: "Attention", count: summary.attention },
    { id: "finished", label: "Finished", count: summary.finished },
  ];

  const closeDialog = () => {
    if (sending) return;
    setPending(null);
    setError(null);
  };

  const confirmCancel = async () => {
    if (pending === null || controller === null || sending) return;
    setSending(true);
    setError(null);
    try {
      await cancelAgentFromView(controller, pending.group.viewId, pending.row.node);
      setAnnouncement(`Cancellation requested for ${pending.row.node.title}.`);
      setPending(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Cancellation failed.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="surface-subheader flex min-h-14 shrink-0 items-center gap-2 px-3">
        <Button
          aria-label="Back to sessions"
          className="min-h-11 sm:min-h-8"
          onClick={onBack}
          size="sm"
          variant="ghost"
        >
          <ArrowLeft aria-hidden="true" />
          Sessions
        </Button>
        <span aria-hidden="true" className="h-5 w-px bg-border" />
        <UsersRound aria-hidden="true" className="size-4 text-primary" />
        <span className="min-w-0">
          <h1 className="truncate font-semibold text-sm">Agent View</h1>
          <p className="truncate text-muted-foreground text-xs">
            {summary.agents} loaded {summary.agents === 1 ? "agent" : "agents"} ·{" "}
            {summary.running} running
          </p>
        </span>
      </header>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {snapshot === null && fixtureGroups === undefined ? (
        <Empty className="flex-1 border-0">
          <EmptyHeader>
            <EmptyTitle>Agent View requires the desktop runtime</EmptyTitle>
            <EmptyDescription>
              Open T4 Code on your desktop to monitor and control agents running on connected hosts.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={onBack} variant="outline">
              Back to sessions
            </Button>
          </EmptyContent>
        </Empty>
      ) : groups.length === 0 ? (
        <Empty className="flex-1 border-0">
          <EmptyHeader>
            <EmptyTitle>No agents in loaded sessions</EmptyTitle>
            <EmptyDescription>
              Agent View shows agents from the sessions currently loaded by the runtime. Start an
              agent or open its session to load it here.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={onBack} variant="outline">
              Back to sessions
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
            <SummaryStrip summary={summary} />

            <div className="grid gap-3 rounded-xl border border-border bg-card p-3 md:grid-cols-[minmax(16rem,1fr)_auto] md:items-end">
              <label className="grid gap-1 text-muted-foreground text-xs">
                Search loaded agents
                <span className="relative block">
                  <Search
                    aria-hidden="true"
                    className="absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  />
                  <input
                    aria-label="Search loaded agents"
                    className="min-h-11 w-full rounded-md border border-input bg-background pe-3 ps-9 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9"
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setPageIndex(0);
                    }}
                    placeholder="Task, model, tool, path, session"
                    type="search"
                    value={query}
                  />
                </span>
              </label>
              <div
                aria-label="Filter agents"
                className="flex flex-wrap gap-2"
                role="group"
              >
                {filterOptions.map((option) => (
                  <Button
                    aria-pressed={filter === option.id}
                    className="min-h-11 sm:min-h-9"
                    key={option.id}
                    onClick={() => {
                      setFilter(option.id);
                      setPageIndex(0);
                    }}
                    size="sm"
                    variant={filter === option.id ? "default" : "outline"}
                  >
                    {option.label}
                    <span className="tabular-nums">{option.count}</span>
                  </Button>
                ))}
              </div>
            </div>

            {filteredCount === 0 ? (
              <Empty className="min-h-64 border border-border">
                <EmptyHeader>
                  <EmptyTitle>No agents match these filters</EmptyTitle>
                  <EmptyDescription>Change the search or show all loaded agents.</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button
                    onClick={() => {
                      setFilter("all");
                      setQuery("");
                      setPageIndex(0);
                    }}
                    variant="outline"
                  >
                    Clear filters
                  </Button>
                </EmptyContent>
              </Empty>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground text-xs">
                  <p aria-live="polite">
                    Showing {pageStart}-{pageEnd} of {page.totalAgents} matching agents
                  </p>
                  {pageCount > 1 && (
                    <div className="flex items-center gap-2">
                      <Button
                        className="min-h-11 sm:min-h-8"
                        disabled={currentPageIndex === 0}
                        onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
                        size="sm"
                        variant="outline"
                      >
                        Previous
                      </Button>
                      <span className="min-w-16 text-center tabular-nums">
                        {currentPageIndex + 1} / {pageCount}
                      </span>
                      <Button
                        className="min-h-11 sm:min-h-8"
                        disabled={currentPageIndex >= pageCount - 1}
                        onClick={() =>
                          setPageIndex((current) => Math.min(pageCount - 1, current + 1))
                        }
                        size="sm"
                        variant="outline"
                      >
                        Next
                      </Button>
                    </div>
                  )}
                </div>

                {page.groups.map((group) => (
                  <section aria-labelledby={`agent-session-${group.viewId}`} key={group.viewId}>
                    <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2">
                      <span className="min-w-48 flex-1">
                        <h2
                          className="truncate font-semibold text-sm"
                          id={`agent-session-${group.viewId}`}
                        >
                          {group.session.title}
                        </h2>
                        <p className="truncate text-muted-foreground text-xs">
                          {group.projectName} · {group.session.model} · {group.session.freshness}
                        </p>
                        {group.session.ci !== undefined && (
                          <p className="flex flex-wrap gap-x-2 text-muted-foreground text-xs">
                            <span>{group.session.ci.status}</span>
                            <span>{group.session.ci.currentStage ?? "CI stage unknown"}</span>
                            <span>{group.session.ci.branch ?? group.session.ci.ref ?? "CI branch unknown"}</span>
                            <span className="font-mono">
                              {group.session.ci.commit ?? "CI commit unknown"}
                            </span>
                          </p>
                        )}
                      </span>
                      {group.session.status !== null && (
                        <StatusPill className="shrink-0" status={group.session.status} />
                      )}
                      <Button
                        aria-label={`Open ${group.session.title}`}
                        className="min-h-11 sm:min-h-8"
                        onClick={() => onOpenSession(group.viewId)}
                        size="sm"
                        variant="outline"
                      >
                        Open session
                        <ExternalLink aria-hidden="true" />
                      </Button>
                    </div>
                    <ul className="grid grid-cols-1 gap-2 xl:grid-cols-2">
                      {group.agents.map((row) => (
                        <AgentCard
                          group={group}
                          key={row.node.id}
                          nowMs={nowMs}
                          onCancel={() => {
                            setError(null);
                            setPending({ group, row });
                          }}
                          onInspect={() => onOpenSession(group.viewId, row.node.id)}
                          row={row}
                          sampleMode={sampleMode}
                          snapshot={snapshot}
                        />
                      ))}
                    </ul>
                  </section>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      <Dialog onOpenChange={(open) => (open ? undefined : closeDialog())} open={pending !== null}>
        <DialogPopup aria-label="Cancel agent" className="max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-base">Cancel “{pending?.row.node.title}”?</DialogTitle>
            <DialogDescription>
              This stops the agent and its descendants in “{pending?.group.session.title}”. Work
              already written to disk stays intact. The host remains the lifecycle authority.
            </DialogDescription>
            {error !== null && (
              <p className="text-destructive-foreground text-xs" role="alert">
                {error}
              </p>
            )}
          </DialogHeader>
          <DialogFooter>
            <Button disabled={sending} onClick={closeDialog} size="sm" variant="ghost">
              Keep running
            </Button>
            <Button
              disabled={sending}
              onClick={() => void confirmCancel()}
              size="sm"
              variant="destructive"
            >
              {sending ? "Requesting…" : "Cancel agent"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
