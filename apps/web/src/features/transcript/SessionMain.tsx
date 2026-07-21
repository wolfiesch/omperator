// Center session surface: the streaming transcript with the floating
// composer and its attention stack (approval / question / plan / error).
// State flows one way: the session runtime controller projects app-wire
// frames into a TranscriptProjection; rows derive from the projection; user
// actions leave through typed SessionIntents. The shell's outer scroll
// container stays inert — this surface owns its own virtualized scroller.
import {
  Badge,
  cn,
  StatusPill,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  useReducedMotion,
} from "@t4-code/ui";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";

import { useActionRegistry } from "../../actions/index.ts";
import { captureTranscriptContext } from "../context-packet/context-packet.ts";
import type { WorkspaceProject, WorkspaceSession } from "../../lib/workspace-data.ts";
import { useDesktopRuntimeSnapshot } from "../../platform/desktop-runtime.ts";
import { resolveLiveSession } from "../../platform/live-workspace.ts";
import { Composer } from "../composer/Composer.tsx";
import { flattenFileIndex } from "../composer/file-refs.ts";
import { getInspectorStore, type FileChildren } from "../panes/inspector-store.ts";
import { useNowTick } from "../panes/hooks.ts";
import {
  ApprovalPanel,
  AskPanel,
  AttentionStack,
  PlanPanel,
  TurnErrorBanner,
} from "../composer/panels.tsx";
import type { SessionIntent } from "../session-runtime/intents.ts";
import { ProviderTransportDiagnostics } from "../session-runtime/ProviderTransportDiagnostics.tsx";
import {
  advanceRecordArrival,
  initialControlAnnouncerState,
  presentSessionControl,
  presentSessionControlKind,
  recordArrivalBaseline,
  reduceControlAnnouncement,
  type ControlAnnouncerState,
  type SessionControlPresentation,
  type SessionControlState,
} from "../session-runtime/session-observer.ts";
import { useSessionRuntime } from "../session-runtime/useSessionRuntime.ts";
import {
  computeStableRows,
  deriveAttention,
  deriveTranscriptRows,
  formatElapsed,
  initialStableRowsState,
  shouldShowAttention,
  type StableRowsState,
} from "./rows.ts";
import type { ExportContent } from "./export.ts";
import { getReadAloudController } from "./ReadAloud.tsx";
import { TranscriptTimeline } from "./TranscriptTimeline.tsx";
import type { ToolRenderHost } from "./tool-render/types.ts";

export interface SessionMainProps {
  /** Route-owned identity, passed explicitly through the whole session surface. */
  readonly sessionId: string;
  readonly session: WorkspaceSession;
  readonly project: WorkspaceProject;
  readonly nowMs: number;
  readonly onOpenHostHealth: () => void;
  /** Export hook: registered with the current rows so the header menu can serialize them. */
  readonly exportRowsRef: RefObject<(() => ExportContent) | null>;
}

const NO_FILE_CHILDREN: Readonly<Record<string, FileChildren>> = {};

export function FreshnessBadge({ session }: { readonly session: WorkspaceSession }) {
  if (session.freshness === "cached") {
    return (
      <Tooltip>
        <TooltipTrigger render={<Badge variant="outline">Cached</Badge>} />
        <TooltipPopup side="bottom">
          Showing the last synced copy. It refreshes when the connection returns.
        </TooltipPopup>
      </Tooltip>
    );
  }
  if (session.freshness === "offline") {
    return (
      <Tooltip>
        <TooltipTrigger render={<Badge variant="outline">Offline</Badge>} />
        <TooltipPopup side="bottom">
          This session's host is unreachable. Its record stays put until the host returns.
        </TooltipPopup>
      </Tooltip>
    );
  }
  return null;
}

/** Plain lifecycle badge for sessions that have no richer live status pill. */
export function SessionLifecycleBadge({ session }: { readonly session: WorkspaceSession }) {
  if (session.freshness !== "live" || session.status !== null || session.control !== undefined)
    return null;

  const label =
    session.lifecycle === "idle"
      ? "Idle"
      : session.lifecycle === "closed"
        ? "Stopped"
        : "Status unknown";
  const detail =
    label === "Status unknown"
      ? "T4 has saved history for this task, but the runtime did not report whether it is running, idle, or stopped."
      : label === "Stopped"
        ? "The runtime reports that this task has stopped."
        : "The runtime reports that this task is waiting and has no work in progress.";

  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="outline">{label}</Badge>} />
      <TooltipPopup side="bottom">{detail}</TooltipPopup>
    </Tooltip>
  );
}

/** Subheader ownership badge; mirrors FreshnessBadge, which wins when set. */
export function SessionOwnershipBadge({ session }: { readonly session: WorkspaceSession }) {
  if (session.freshness !== "live" || session.control === undefined) return null;
  if (session.control === "reconciling") {
    return (
      <Tooltip>
        <TooltipTrigger render={<Badge variant="outline">Taking over</Badge>} />
        <TooltipPopup side="bottom">
          Input returns once the transcript is confirmed complete.
        </TooltipPopup>
      </Tooltip>
    );
  }
  if (session.control === "observer") {
    return (
      <Tooltip>
        <TooltipTrigger render={<Badge variant="outline">Active elsewhere</Badge>} />
        <TooltipPopup side="bottom">
          Another app is running this session. You can read along here — run /continue-in-t4 there
          to move it, or just exit it.
        </TooltipPopup>
      </Tooltip>
    );
  }
  // Waiting (quiet owner) or unclear (malformed/unrecognized control): the
  // badge never claims another app is active — reuse the shared copy source.
  const presentation = presentSessionControlKind(session.control);
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="outline">{presentation.railLabel}</Badge>} />
      <TooltipPopup side="bottom">{presentation.composerReason}</TooltipPopup>
    </Tooltip>
  );
}

/** Stable-row derivation hook: unchanged rows keep their references. */
function useStableTranscriptRows(rows: ReturnType<typeof deriveTranscriptRows>) {
  const stateRef = useRef<StableRowsState>(initialStableRowsState());
  return useMemo(() => {
    const next = computeStableRows(rows, stateRef.current);
    stateRef.current = next;
    return next.result;
  }, [rows]);
}

type SessionActivity = "compacting" | "working" | null;

function activityLabel(activity: SessionActivity): string {
  if (activity === "compacting") return "Compacting context";
  if (activity === "working") return "Working";
  return "";
}

/**
 * A quiet, continuously moving confirmation that this task is genuinely
 * running here. The separate announcer below owns screen-reader updates so
 * this visual timer can tick without speaking every second.
 */
export function SessionActivityBanner({
  activity,
  nowMs,
  startedAt,
}: {
  readonly activity: SessionActivity;
  readonly nowMs: number;
  readonly startedAt: string | null;
}) {
  if (activity === null) return null;

  return (
    <div
      aria-hidden="true"
      className="flex min-h-9 shrink-0 items-center justify-center gap-2 border-border/60 border-b bg-secondary/60 px-3 text-muted-foreground text-xs"
      data-session-activity-banner={activity}
    >
      <StatusPill labelHidden status="working" />
      <span className="font-medium text-foreground">{activityLabel(activity)}</span>
      {startedAt !== null && (
        <>
          <span className="text-border" aria-hidden="true">
            ·
          </span>
          <SessionActivityElapsed fromIso={startedAt} nowMs={nowMs} />
        </>
      )}
    </div>
  );
}

function SessionActivityElapsed({
  fromIso,
  nowMs,
}: {
  readonly fromIso: string;
  readonly nowMs: number;
}) {
  const tickMs = useNowTick();
  const baselineRef = useRef({ nowMs, tickMs });
  if (baselineRef.current.nowMs !== nowMs) baselineRef.current = { nowMs, tickMs };
  const elapsedNowMs = baselineRef.current.nowMs + tickMs - baselineRef.current.tickMs;
  return <span className="font-mono tabular-nums">{formatElapsed(fromIso, elapsedNowMs)}</span>;
}

/**
 * One stable live region owns session activity announcements. Transcript rows
 * remain visual-only so the surrounding role=log cannot announce the same
 * transition a second time.
 */
function SessionActivityAnnouncer({ activity }: { readonly activity: SessionActivity }) {
  const previousRef = useRef<SessionActivity>(activity);
  const [announcement, setAnnouncement] = useState(() => activityLabel(activity));

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = activity;
    if (previous === "compacting" && activity !== "compacting") {
      setAnnouncement(
        activity === "working"
          ? "Context compaction complete. Working"
          : "Context compaction complete",
      );
      return;
    }
    setAnnouncement(activityLabel(activity));
  }, [activity]);

  return (
    <p
      aria-atomic="true"
      aria-live="polite"
      className="sr-only"
      data-session-activity-announcer
      role="status"
    >
      {announcement}
    </p>
  );
}

/**
 * Polite announcements for ownership transitions: entering observer or
 * reconciling states, and input returning when the field clears. Separate
 * from the activity announcer so "Working" and "Read-only" never race in
 * one region. "Input is back" is announced only when a previously observed
 * or reconciling session reaches a confirmed live AND writable state; a
 * drop to cached/offline holds the pending transition silently and lets
 * the freshness copy speak. An ownership blip too short to read clears the
 * region silently instead — the reducer owns that timing, gates never wait.
 */
function SessionControlAnnouncer({
  control,
  link,
  writable,
}: {
  readonly control: SessionControlState | null;
  readonly link: "live" | "cached" | "offline";
  readonly writable: boolean;
}) {
  const stateRef = useRef<ControlAnnouncerState | null>(null);
  stateRef.current ??= initialControlAnnouncerState(control, Date.now());
  const [announcement, setAnnouncement] = useState(stateRef.current.lastAnnouncement);

  useEffect(() => {
    if (stateRef.current === null) return;
    const next = reduceControlAnnouncement(stateRef.current, {
      control,
      link,
      writable,
      nowMs: Date.now(),
    });
    stateRef.current = next.state;
    if (next.announcement !== null) setAnnouncement(next.announcement);
  }, [control, link, writable]);

  return (
    <p
      aria-atomic="true"
      aria-live="polite"
      className="sr-only"
      data-session-control-announcer
      role="status"
    >
      {announcement}
    </p>
  );
}

/** How long one durable record arrival keeps the observer dot lit. */
export const RECORD_ARRIVAL_PULSE_MS = 1200;

/**
 * Deterministic core of the record-arrival pulse. `observe` is called once
 * per committed render (the hook's effect body) with that render's inputs;
 * `dispose` is the unmount cleanup. Exported so the lifecycle — rerender
 * during a pulse, reduced-motion toggles, timer supersession — can be
 * regression-tested without a DOM renderer.
 */
export interface RecordArrivalPulseController {
  observe(
    active: boolean,
    entries: readonly { readonly id: string }[],
    reducedMotion: boolean,
  ): void;
  dispose(): void;
}

export function createRecordArrivalPulseController(
  initialEntries: readonly { readonly id: string }[],
  onPulseChange: (pulsing: boolean) => void,
): RecordArrivalPulseController {
  let baseline = recordArrivalBaseline(initialEntries);
  // The in-flight pulse timer. It survives observe() calls that carry no
  // arrival (clearing it there would leave the pulse stuck on forever) and
  // is only replaced by a newer pulse, settled on deactivation, or dropped
  // on dispose. The identity check in the callback keeps a superseded
  // timer's callback from clearing a newer pulse early.
  let timer: ReturnType<typeof setTimeout> | undefined;

  function settle(): void {
    clearTimeout(timer);
    timer = undefined;
    onPulseChange(false);
  }

  return {
    observe(active, entries, reducedMotion) {
      // The baseline always advances, even while inactive or under reduced
      // motion: an entry that landed during a disabled phase must not pulse
      // retroactively when the pulse is re-enabled.
      const step = advanceRecordArrival(baseline, entries);
      baseline = step.baseline;
      if (!active || reducedMotion) {
        // Settle outright so toggling active/reduced-motion back can never
        // reveal the remainder of an old pulse.
        settle();
        return;
      }
      if (!step.arrived) return;
      clearTimeout(timer);
      onPulseChange(true);
      const current = setTimeout(() => {
        if (timer !== current) return;
        timer = undefined;
        onPulseChange(false);
      }, RECORD_ARRIVAL_PULSE_MS);
      timer = current;
    },
    dispose() {
      settle();
    },
  };
}

/**
 * Quiet activity pulse for the observed-session banner: lights the working
 * dot briefly when a new durable entry lands from the owner's saved
 * transcript, and for nothing else. Poll-derived churn (transcript
 * live/snapshot, lock freshness) never reaches this hook, and reduced
 * motion disables the pulse entirely.
 */
function useRecordArrivalPulse(
  active: boolean,
  entries: readonly { readonly id: string }[],
): boolean {
  const reducedMotion = useReducedMotion();
  const [pulsing, setPulsing] = useState(false);
  const controllerRef = useRef<RecordArrivalPulseController | null>(null);
  controllerRef.current ??= createRecordArrivalPulseController(entries, setPulsing);

  useEffect(() => {
    controllerRef.current?.observe(active, entries, reducedMotion);
  }, [active, entries, reducedMotion]);

  useEffect(() => () => controllerRef.current?.dispose(), []);

  return pulsing && active && !reducedMotion;
}

/**
 * The one persistent ownership region. It stays mounted for as long as a
 * control state exists, renders byte-identical copy across transcript
 * live/snapshot churn, and never carries a writable affordance. The dot
 * slot is always present in observer mode (opacity only) so a pulse never
 * shifts the text.
 */
export function SessionControlBanner({
  mode,
  presentation,
  pulse,
}: {
  readonly mode: SessionControlState["mode"];
  readonly presentation: SessionControlPresentation;
  readonly pulse: boolean;
}) {
  return (
    <div
      className="flex min-h-9 shrink-0 items-center justify-center gap-2 border-border/60 border-b bg-secondary px-3 text-center text-muted-foreground text-xs"
      data-session-control-banner={mode}
      role="status"
    >
      {(presentation.bannerBusy || mode === "observer") && (
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full bg-status-working-dot transition-opacity duration-(--motion-duration-base)",
            !presentation.bannerBusy && !pulse && "opacity-0",
          )}
        />
      )}
      <span>
        <span className="font-medium text-foreground">{presentation.bannerTitle}</span>
        {" · "}
        {presentation.bannerDetail}
      </span>
    </div>
  );
}

export function SessionMain({
  onOpenHostHealth,
  session,
  sessionId,
  exportRowsRef,
}: SessionMainProps) {
  const archived = session.archivedAt !== undefined;
  const actionRegistry = useActionRegistry();
  const { snapshot, runtime } = useSessionRuntime(sessionId, session.freshness);
  const projection = snapshot.projection;
  const desktopSnapshot = useDesktopRuntimeSnapshot();
  // The composer "@" picker rides the session's lazy file index; no
  // inspector store (fixture hosts without a factory) means no entries.
  const inspectorApi = getInspectorStore(sessionId);
  const fileChildren = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => inspectorApi?.subscribe(onStoreChange) ?? (() => {}),
      [inspectorApi],
    ),
    useCallback(
      () => inspectorApi?.getState().files.childrenByPath ?? NO_FILE_CHILDREN,
      [inspectorApi],
    ),
  );
  const fileEntries = useMemo(() => flattenFileIndex(fileChildren), [fileChildren]);
  const ensureFileDir = useCallback(
    (dir: string) => getInspectorStore(sessionId)?.getState().requestDir(dir),
    [sessionId],
  );
  const liveAddress = useMemo(
    () => (desktopSnapshot === null ? null : resolveLiveSession(desktopSnapshot, sessionId)),
    [desktopSnapshot, sessionId],
  );
  const previews =
    desktopSnapshot === null || liveAddress === null
      ? []
      : [
          ...(desktopSnapshot.projection.sessions
            .get(`${liveAddress.hostId}\u0000${liveAddress.sessionId}`)
            ?.previews.values() ?? []),
        ];
  const previewFreshness = previews.some((preview) => preview.freshness !== "fresh")
    ? "Cached"
    : "Ready";
  const toolHost = useMemo<ToolRenderHost>(
    () => ({
      hasAgent: (agentId) =>
        getInspectorStore(sessionId)?.getState().agentMap.agents[agentId] !== undefined,
      openAgent: (agentId) => {
        actionRegistry.execute({ id: "agent.open", args: { sessionId, agentId } });
      },
      openTurnReview: (turnId) => {
        actionRegistry.execute({ id: "review.open", args: { sessionId, turnId } });
      },
      openPreview: () => {
        actionRegistry.execute({ id: "preview.open", args: { sessionId } });
      },
    }),
    [actionRegistry, sessionId],
  );

  // Leaving this session surface (switch or unmount) ends any read-aloud
  // playback: speech only ever belongs to a response the user can see.
  useEffect(() => () => getReadAloudController().stop(), [sessionId]);

  const rawRows = useMemo(
    () =>
      deriveTranscriptRows(projection, {
        sessionActive: snapshot.sessionActive,
        pendingPrompts: snapshot.pendingPrompts,
      }),
    [projection, snapshot.pendingPrompts, snapshot.sessionActive],
  );
  const rows = useStableTranscriptRows(rawRows);
  const captureMessageContext = useCallback(
    (row: Extract<(typeof rows)[number], { kind: "message" }>) => {
      const item = captureTranscriptContext(sessionId, row);
      if (item !== null) {
        actionRegistry.execute({ id: "context.capture", args: { sessionId, item } });
      }
    },
    [actionRegistry, sessionId],
  );
  // The export menu lives in the header; rows live here. Hand the menu a
  // getter instead of subscribing to the runtime a second time.
  useEffect(() => {
    exportRowsRef.current = () => ({
      rows: rawRows,
      historyTruncated: projection.historyTruncated,
      turnActive: projection.turnActive,
    });
    return () => {
      exportRowsRef.current = null;
    };
  }, [exportRowsRef, rawRows, projection]);
  const attention = useMemo(() => deriveAttention(projection), [projection]);

  const [revisingPlanId, setRevisingPlanId] = useState<string | null>(null);
  const onIntent = useCallback(
    (intent: SessionIntent) => {
      if (!archived) runtime.dispatch(intent);
    },
    [archived, runtime],
  );
  const submitPrompt = useCallback(
    (intent: SessionIntent) =>
      archived
        ? Promise.resolve({ kind: "rejected" as const, reason: "Archived sessions are read-only." })
        : runtime.submitPrompt(intent),
    [archived, runtime],
  );

  // Composer dock height feeds the timeline's end inset so following content
  // never hides under the floating composer.
  const dockRef = useRef<HTMLDivElement | null>(null);
  const [dockHeight, setDockHeight] = useState(120);
  useEffect(() => {
    const element = dockRef.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => {
      const next = Math.ceil(element.getBoundingClientRect().height);
      setDockHeight((current) => (Math.abs(current - next) < 1 ? current : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const catchingUp = projection.phase === "resyncing" || projection.phase === "paused";
  const sessionControl = archived ? null : snapshot.sessionControl;
  const controlPresentation =
    sessionControl === null ? null : presentSessionControl(sessionControl);
  const observerPulse = useRecordArrivalPulse(
    sessionControl?.mode === "observer",
    projection.entries,
  );
  const sessionActivity: SessionActivity =
    !archived &&
    sessionControl === null &&
    snapshot.link === "live" &&
    !catchingUp &&
    snapshot.sessionActive
      ? projection.contextMaintenance === null
        ? "working"
        : "compacting"
      : null;
  const showAttention = shouldShowAttention(
    attention,
    revisingPlanId,
    archived || snapshot.link !== "live" || catchingUp || sessionControl !== null,
  );

  const retryIntent = useMemo(() => {
    if (attention.error === null || !attention.error.retryable) return null;
    return () => onIntent({ kind: "prompt", text: "/retry", attachments: [] });
  }, [attention.error, onIntent]);

  const empty = rows.length === 0 && !snapshot.sessionActive;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <SessionActivityAnnouncer activity={sessionActivity} key={sessionId} />
      <SessionControlAnnouncer
        control={sessionControl}
        key={`${sessionId}:control`}
        link={snapshot.link}
        writable={!archived && snapshot.canPrompt}
      />
      {catchingUp && (
        <div
          className="flex h-7 shrink-0 items-center justify-center gap-2 border-border/60 border-b bg-secondary text-muted-foreground text-xs"
          role="status"
        >
          <span aria-hidden="true" className="size-1.5 rounded-full bg-status-working-dot" />
          Catching up — refreshing this transcript from a snapshot
        </div>
      )}
      <SessionActivityBanner
        activity={sessionActivity}
        nowMs={snapshot.nowMs}
        startedAt={projection.turnStartedAt}
      />
      {controlPresentation !== null && sessionControl !== null && (
        <SessionControlBanner
          mode={sessionControl.mode}
          presentation={controlPresentation}
          pulse={observerPulse}
        />
      )}
      {archived && (
        <div
          className="flex min-h-9 shrink-0 items-center justify-center border-border/60 border-b bg-secondary px-3 text-center text-muted-foreground text-xs"
          role="status"
        >
          Archived · read-only. Restore this session before continuing work.
        </div>
      )}
      {previews.length > 0 && (
        <div className="flex min-h-9 shrink-0 items-center justify-center border-border/60 border-b bg-secondary px-3 text-xs">
          <button
            aria-label={`Open browser preview for this session${previews.length > 1 ? ` (${previews.length} previews)` : ""}`}
            className="inline-flex min-h-11 items-center gap-2 rounded-md px-3 font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
            onClick={toolHost.openPreview}
            type="button"
          >
            Browser preview
            <Badge variant="outline">
              {previews.length > 1 ? previews.length : previewFreshness}
            </Badge>
          </button>
        </div>
      )}
      {snapshot.providerTransport !== null && (
        <ProviderTransportDiagnostics
          onOpenHostHealth={onOpenHostHealth}
          state={snapshot.providerTransport}
        />
      )}
      <div aria-label="Transcript" className="relative min-h-0 flex-1" role="log">
        {empty ? (
          <div className="flex h-full items-center justify-center px-6">
            <p className="max-w-sm text-center text-muted-foreground text-sm">
              Nothing here yet. Say what you need and the work lands in this transcript.
            </p>
          </div>
        ) : (
          <TranscriptTimeline
            bottomInset={archived ? 16 : dockHeight + 16}
            history={snapshot.transcriptHistory}
            imageSource={runtime.transcriptImages}
            key={sessionId}
            nowMs={snapshot.nowMs}
            onLoadEarlier={runtime.loadEarlierTranscript}
            onCaptureMessage={archived ? undefined : captureMessageContext}
            rows={rows}
            sessionId={sessionId}
            streaming={snapshot.sessionActive}
            toolHost={toolHost}
          />
        )}
        {!archived && (
          <div
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 mx-auto w-full max-w-(--transcript-measure) overflow-x-hidden pr-[max(1rem,var(--app-safe-area-right))] pb-[max(1rem,var(--app-safe-area-bottom))] pl-[max(1rem,var(--app-safe-area-left))] sm:px-6",
            )}
            ref={dockRef}
          >
            {showAttention && (
              <div className="pointer-events-auto mb-2">
                <AttentionStack>
                  {attention.error !== null && (
                    <TurnErrorBanner error={attention.error} onRetry={retryIntent} />
                  )}
                  {attention.approval !== null && (
                    <ApprovalPanel approval={attention.approval} onIntent={onIntent} />
                  )}
                  {attention.ask !== null && <AskPanel ask={attention.ask} onIntent={onIntent} />}
                  {attention.plan !== null && revisingPlanId === null && (
                    <PlanPanel
                      onIntent={onIntent}
                      onRevise={() => setRevisingPlanId(attention.plan?.planId ?? null)}
                      plan={attention.plan}
                    />
                  )}
                </AttentionStack>
              </div>
            )}
            <Composer
              canCancel={snapshot.canCancel}
              cancelDisabledReason={snapshot.cancelDisabledReason}
              canPrompt={snapshot.canPrompt}
              contextUsedTokens={snapshot.contextUsedTokens}
              contextWindowTokens={snapshot.contextWindowTokens}
              controls={snapshot.controls}
              fileEntries={fileEntries}
              link={snapshot.link}
              onEnsureFileDir={ensureFileDir}
              onCancelRevise={() => setRevisingPlanId(null)}
              onIntent={onIntent}
              queuedFollowUps={snapshot.queuedFollowUps}
              readOnlyReason={controlPresentation?.composerReason ?? null}
              revisingPlanId={revisingPlanId}
              sessionId={sessionId}
              slashCommands={snapshot.slashCommands}
              submitPrompt={submitPrompt}
              turnActive={snapshot.sessionActive}
            />
          </div>
        )}
      </div>
    </div>
  );
}
