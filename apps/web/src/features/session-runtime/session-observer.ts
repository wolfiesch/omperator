// Observer/reconciling truth for one session, read strictly from
// `SessionRef.liveState.sessionControl` (feature `session.observer`).
// Absence means the normal writable, appserver-owned state. When another
// app owns the session, the renderer keeps reading — transcript, panes,
// images — and every write affordance gates with an honest reason. The
// server remains final authority: these gates only stop the UI from
// offering commands the host would refuse anyway. Nothing here names the
// owner, guesses at lock internals, or leaks engine vocabulary into copy.
import type { SessionRef } from "@t4-code/protocol";

import type { ComposerControlsSnapshot } from "./session-controls.ts";

export type ObserverLockStatus = "live" | "suspect" | "malformed";
export type ObserverTranscript = "live" | "snapshot";

/**
 * Typed mirror of the wire union, plus a local "unknown" arm: a present but
 * unrecognized shape gates writes with stale/unknown-safe copy instead of
 * pretending the session is writable. Null (from the reader) means the
 * field is absent and the session behaves normally.
 */
export type SessionControlState =
  | {
      readonly mode: "observer";
      readonly lockStatus: ObserverLockStatus;
      readonly transcript: ObserverTranscript;
    }
  | { readonly mode: "reconciling"; readonly transcript: ObserverTranscript }
  | { readonly mode: "unverified"; readonly transcript: ObserverTranscript }
  | { readonly mode: "unknown" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const OBSERVER_KEYS: Record<string, true> = { mode: true, lockStatus: true, transcript: true };
const RECONCILING_KEYS: Record<string, true> = { mode: true, transcript: true };
const UNVERIFIED_KEYS: Record<string, true> = { mode: true, transcript: true };

/**
 * Strict reader for `liveState.sessionControl`. Only a truly absent
 * `liveState` or `sessionControl` field means writable. A malformed live-state
 * container or any present control value — explicit null, extra keys, missing
 * keys, unknown values — becomes the read-only "unknown" arm: a missing lock
 * alone never enables writes, and neither does a shape this client cannot
 * prove it understands.
 */
export function readSessionControl(ref: SessionRef | undefined): SessionControlState | null {
  if (ref === undefined || !Object.hasOwn(ref, "liveState")) {
    return null;
  }
  if (!isRecord(ref.liveState)) return { mode: "unknown" };
  if (!Object.hasOwn(ref.liveState, "sessionControl")) return null;
  const raw = ref.liveState.sessionControl;
  if (!isRecord(raw)) return { mode: "unknown" };
  if (raw.mode === "observer") {
    if (Object.keys(raw).some((key) => OBSERVER_KEYS[key] !== true)) return { mode: "unknown" };
    const { lockStatus, transcript } = raw;
    if (lockStatus !== "live" && lockStatus !== "suspect" && lockStatus !== "malformed") {
      return { mode: "unknown" };
    }
    if (transcript !== "live" && transcript !== "snapshot") return { mode: "unknown" };
    return { mode: "observer", lockStatus, transcript };
  }
  if (raw.mode === "reconciling") {
    if (Object.keys(raw).some((key) => RECONCILING_KEYS[key] !== true)) {
      return { mode: "unknown" };
    }
    const { transcript } = raw;
    if (transcript !== "live" && transcript !== "snapshot") return { mode: "unknown" };
    return { mode: "reconciling", transcript };
  }
  if (raw.mode === "unverified") {
    if (Object.keys(raw).some((key) => UNVERIFIED_KEYS[key] !== true)) {
      return { mode: "unknown" };
    }
    const { transcript } = raw;
    if (transcript !== "live" && transcript !== "snapshot") return { mode: "unknown" };
    return { mode: "unverified", transcript };
  }
  return { mode: "unknown" };
}

/**
 * Freshness precedence: cached/offline surfaces already explain themselves
 * (stale copy, unreachable host) and their copy wins. Observer presentation
 * only applies to a live connection, where the projection is current enough
 * to make "active in another app" an honest claim.
 */
export function sessionControlForLink(
  link: "live" | "cached" | "offline",
  state: SessionControlState | null,
): SessionControlState | null {
  return link === "live" ? state : null;
}

/** Label plus explanation for the continue-in-a-copy affordance. */
export interface SessionControlForkAction {
  /** Action label. */
  readonly label: string;
  /** One-line explanation rendered with the affordance. */
  readonly explanation: string;
}

/** Everything the surfaces render for one control state; no nulls, no holes. */
export interface SessionControlPresentation {
  /** Rail state text; shown where Idle/Cached/Offline appear today. */
  readonly railLabel: string;
  /** Transcript banner, `title · detail`. */
  readonly bannerTitle: string;
  readonly bannerDetail: string;
  /** Show the persistent working dot beside the banner (takeover only). */
  readonly bannerBusy: boolean;
  /** Composer disabled reason (the read-only explanation under the field). */
  readonly composerReason: string;
  /** Disabled Stop affordance tooltip. */
  readonly cancelReason: string;
  /** Model/thinking/fast unsupported reason. */
  readonly controlReason: string;
  /** Slash palette disabled reason (short; the menu stays honest). */
  readonly slashReason: string;
  /** Rail lifecycle actions (rename/terminate/archive/delete) reason. */
  readonly managementReason: string;
  /**
   * Continue-in-a-copy affordance for read-only dead ends (observer with any
   * lock status, and unverified). Null when the state resolves on its own
   * (reconciling) or when no ownership truth exists at all (unknown).
   * Rendering additionally gates on the host having negotiated the
   * `session.fork` protocol feature (see `sessionForkAction`); without it
   * every surface renders exactly as it did before this field existed.
   */
  readonly forkAction: SessionControlForkAction | null;
  /** Screen-reader announcement on entering this state. */
  readonly announcement: string;
}

/** Announced when a watched session reaches confirmed live + writable. */
export const SESSION_CONTROL_RETURNED_ANNOUNCEMENT =
  "Session is now available in T4. Input is back.";

/** Freshness copy always wins over ownership copy on non-live links. */
export const CACHED_WRITE_REASON =
  "This is the last synced copy. Writing resumes when the connection returns.";
export const OFFLINE_WRITE_REASON =
  "The host is unreachable. Your transcript stays readable; input returns with the host.";

const TRANSFER_HINT = "To continue here, run /continue-in-t4 in the other app — or just exit it.";

// Forking never touches the source: the copy is a NEW session this app owns,
// and the original transcript is only ever read. The copy promises exactly
// that — no takeover, and no claims about what the other writer is doing.
const FORK_ACTION: SessionControlForkAction = Object.freeze({
  label: "Continue in a copy",
  explanation:
    "Starts a new session with this history. The original stays where it is and is never modified.",
});

const OBSERVER_COMPOSER_REASON =
  "This session is active in another app. You can read everything here; input returns when the session is released. Run /continue-in-t4 there to move it here.";

// A malformed lock or an unrecognized future shape never claims another app
// controls the session — ownership is simply unclear, so T4 stays read-only.
const UNCLEAR_DETAIL =
  "Ownership of this session is unclear right now. You can read everything here; T4 stays read-only until it's safe.";

const UNCLEAR_PRESENTATION: Omit<
  SessionControlPresentation,
  "bannerDetail" | "bannerBusy" | "forkAction"
> = {
  railLabel: "Read-only",
  bannerTitle: "Read-only right now",
  composerReason: UNCLEAR_DETAIL,
  cancelReason: "Stopping is unavailable while ownership of this session is unclear.",
  controlReason: "This session is read-only while its ownership is unclear.",
  slashReason: "Read-only right now",
  managementReason:
    "Ownership of this session is unclear right now. T4 stays read-only until it's safe.",
  announcement: "Read-only: ownership of this session is unclear.",
};

export function presentSessionControl(state: SessionControlState): SessionControlPresentation {
  if (state.mode === "observer") {
    // Observer copy is byte-identical for transcript "live" and "snapshot":
    // that field reports how the follower happens to be reading right now
    // and can churn while the owner's app saves. Copy that flapped with it
    // read as an ownership change that never happened. Ownership motion is
    // likewise never derived from it — the banner's quiet record-arrival
    // pulse keys on durable entry progression instead (SessionMain).
    if (state.lockStatus === "live") {
      return {
        railLabel: "Active elsewhere",
        bannerTitle: "Active in another app",
        bannerDetail: `Following saved output, not a token-by-token stream. Finished steps appear here as the other app saves them. ${TRANSFER_HINT}`,
        bannerBusy: false,
        forkAction: FORK_ACTION,
        composerReason: OBSERVER_COMPOSER_REASON,
        cancelReason: "Only the app running this session can stop it.",
        controlReason: "This session is active in another app right now.",
        slashReason: "Active in another app",
        managementReason:
          "This session is active in another app. Move it here first (run /continue-in-t4 there) or exit it.",
        announcement: "Read-only: this session is active in another app.",
      };
    }
    if (state.lockStatus === "suspect") {
      // Only a live lock may claim the session is active in another app;
      // a quiet lock only supports "the other app has gone quiet".
      return {
        railLabel: "Waiting to take over",
        bannerTitle: "Waiting to take over",
        bannerDetail:
          "The other app has gone quiet. T4 waits, then takes over on its own once the session settles.",
        bannerBusy: false,
        forkAction: FORK_ACTION,
        composerReason:
          "The app running this session has gone quiet. T4 takes over on its own once the session settles; input returns then.",
        cancelReason: "Only the app running this session can stop it.",
        controlReason: "This session is read-only while T4 waits to take over.",
        slashReason: "Waiting to take over",
        managementReason: "T4 is waiting to take over this session. Try again in a moment.",
        announcement: "Read-only: the app running this session has gone quiet. T4 takes over once it settles.",
      };
    }
    return {
      ...UNCLEAR_PRESENTATION,
      bannerDetail: UNCLEAR_DETAIL,
      bannerBusy: false,
      forkAction: FORK_ACTION,
    };
  }
  if (state.mode === "reconciling") {
    return {
      railLabel: "Taking over",
      bannerTitle: "Taking over",
      bannerDetail:
        state.transcript === "live"
          ? "Confirming the transcript is complete. Input returns in a moment."
          : "Catching up from the last saved copy. Input returns once the transcript is confirmed complete.",
      bannerBusy: true,
      forkAction: null,
      composerReason:
        "Taking over this session — input returns once the transcript is confirmed complete.",
      cancelReason: "Stopping returns when input does.",
      controlReason: "This app is taking over this session.",
      slashReason: "Taking over this session",
      managementReason: "This app is taking over this session. Try again in a moment.",
      announcement: "Taking over this session. Input returns in a moment.",
    };
  }
  if (state.mode === "unverified") {
    return {
      railLabel: "Read-only · use t4-omp",
      bannerTitle: "Read-only terminal session",
      bannerDetail:
        "This session did not publish a T4-compatible handoff signal. Keep using it in the terminal if it is still running. Start future terminal sessions with t4-omp to move them safely into T4 Code.",
      bannerBusy: false,
      forkAction: FORK_ACTION,
      composerReason:
        "This session has no T4-compatible handoff signal. Start future terminal sessions with t4-omp.",
      cancelReason: "Only the terminal process that started this session can stop it.",
      controlReason: "This session is read-only because T4 cannot verify its writer.",
      slashReason: "Read-only terminal session",
      managementReason:
        "T4 cannot safely manage this session because its terminal writer did not publish a compatible handoff signal.",
      announcement: "Read-only terminal session. Use t4-omp for future terminal handoff.",
    };
  }
  return {
    ...UNCLEAR_PRESENTATION,
    bannerDetail: UNCLEAR_DETAIL,
    bannerBusy: false,
    forkAction: null,
  };
}

/**
 * Categorical display kind for compact surfaces (rail rows, session-header
 * badge) that carry workspace display data instead of the full control
 * state. Only a confirmed live lock may claim another app is active; a
 * quiet lock reads as waiting, and a malformed lock or an unrecognized
 * shape stays an unclear read-only state that never names an owner.
 */
export type SessionControlDisplayKind = "observer" | "suspect" | "reconciling" | "unverified" | "unclear";

export function sessionControlDisplayKind(state: SessionControlState): SessionControlDisplayKind {
  if (state.mode === "reconciling") return "reconciling";
  if (state.mode === "unverified") return "unverified";
  if (state.mode === "observer") {
    if (state.lockStatus === "live") return "observer";
    if (state.lockStatus === "suspect") return "suspect";
  }
  return "unclear";
}

// Canonical state per display kind. Compact surfaces never render the
// transcript-dependent fields (bannerDetail/bannerBusy), so one canonical
// transcript per kind keeps presentSessionControl the single copy source.
const DISPLAY_KIND_STATE: Record<SessionControlDisplayKind, SessionControlState> = {
  observer: { mode: "observer", lockStatus: "live", transcript: "live" },
  suspect: { mode: "observer", lockStatus: "suspect", transcript: "live" },
  reconciling: { mode: "reconciling", transcript: "live" },
  unverified: { mode: "unverified", transcript: "live" },
  unclear: { mode: "unknown" },
};

/** Presentation for a display kind; same copy/policy as presentSessionControl. */
export function presentSessionControlKind(
  kind: SessionControlDisplayKind,
): SessionControlPresentation {
  return presentSessionControl(DISPLAY_KIND_STATE[kind]);
}

/** The additive protocol feature that must be negotiated before forking. */
export const SESSION_FORK_FEATURE = "session.fork";

/**
 * The continue-in-a-copy affordance for the current control state, gated on
 * the host having negotiated `session.fork`. Without the feature this
 * returns null for every state, so the UI renders exactly as it does today.
 */
export function sessionForkAction(
  state: SessionControlState | null,
  grantedFeatures: readonly string[],
): SessionControlForkAction | null {
  if (state === null || !grantedFeatures.includes(SESSION_FORK_FEATURE)) return null;
  return presentSessionControl(state).forkAction;
}

/**
 * Read-only overlay for the composer's model/thinking/fast controls while
 * the session is observed or reconciling. Values keep showing host truth —
 * the labels never lie — only the ability to change them gates.
 */
export function gateComposerControls(
  controls: ComposerControlsSnapshot,
  reason: string,
): ComposerControlsSnapshot {
  return {
    ...controls,
    modelSupported: false,
    modelUnsupportedReason: reason,
    thinkingSupported: false,
    thinkingUnsupportedReason: reason,
    fastSupported: false,
    fastUnsupportedReason: reason,
    modeSupported: false,
    attachmentsSupported: false,
    attachmentsUnsupportedReason: reason,
  };
}

/**
 * Screen-reader transition state for ownership announcements. A session that
 * was observed or reconciling owes exactly one "input is back" announcement —
 * but only once the session is confirmed live AND writable again. Dropping to
 * a cached/offline link hides ownership truth, so the pending transition is
 * retained silently (the freshness copy speaks) instead of announcing a
 * return that was never proven. An ownership blip too short to read never
 * earns the return announcement either: the write gates lift immediately —
 * only the narration is suppressed.
 */
export interface ControlAnnouncerState {
  /** Ownership copy last announced; "" when none. */
  readonly lastAnnouncement: string;
  /** An observed/reconciling state still owes a confirmed-return announcement. */
  readonly pendingReturn: boolean;
  /** When the current observed/reconciling episode began; null when none. */
  readonly observedAtMs: number | null;
}

/**
 * An ownership episode shorter than this never announces "input is back":
 * nobody could have finished reading the entering announcement, so the
 * return would narrate a blip that was never an ownership change. Gates are
 * untouched — they follow the control state itself, never this timer.
 */
export const SESSION_CONTROL_RETURN_BLIP_MS = 1500;

export function initialControlAnnouncerState(
  control: SessionControlState | null,
  nowMs: number,
): ControlAnnouncerState {
  return {
    lastAnnouncement: control === null ? "" : presentSessionControl(control).announcement,
    pendingReturn: control !== null,
    observedAtMs: control === null ? null : nowMs,
  };
}

export function reduceControlAnnouncement(
  state: ControlAnnouncerState,
  input: {
    readonly control: SessionControlState | null;
    readonly link: "live" | "cached" | "offline";
    readonly writable: boolean;
    readonly nowMs: number;
  },
): { readonly state: ControlAnnouncerState; readonly announcement: string | null } {
  if (input.control !== null) {
    const announcement = presentSessionControl(input.control).announcement;
    return {
      state: {
        lastAnnouncement: announcement,
        pendingReturn: true,
        // One episode, one start: state changes within it keep the clock.
        observedAtMs: state.pendingReturn ? state.observedAtMs : input.nowMs,
      },
      announcement: announcement === state.lastAnnouncement ? null : announcement,
    };
  }
  if (!state.pendingReturn) return { state, announcement: null };
  if (input.link !== "live" || !input.writable) return { state, announcement: null };
  const blip =
    state.observedAtMs !== null &&
    input.nowMs - state.observedAtMs < SESSION_CONTROL_RETURN_BLIP_MS;
  return {
    state: { lastAnnouncement: "", pendingReturn: false, observedAtMs: null },
    // A suppressed blip returns "" (not null): the live region clears
    // silently so a later identical entering announcement re-fires.
    announcement: blip ? "" : SESSION_CONTROL_RETURNED_ANNOUNCEMENT,
  };
}

/**
 * Durable record-arrival tracking for the observer banner's quiet activity
 * pulse. The only trusted progress signal is the projection's durable entry
 * list (deduped by entry id, arrival order): it grows exactly when a
 * finished line lands from the owner's saved transcript. Poll-derived state
 * (transcript live/snapshot, lock freshness) never reaches this — churn
 * there must not read as activity.
 */
export interface RecordArrivalBaseline {
  readonly count: number;
  readonly lastId: string | null;
}

export function recordArrivalBaseline(
  entries: readonly { readonly id: string }[],
): RecordArrivalBaseline {
  return { count: entries.length, lastId: entries.at(-1)?.id ?? null };
}

/**
 * Advance the baseline and report whether a new durable entry arrived.
 * Growth is arrival; same-length rotation under the retention cap (new tail
 * id) is arrival; shrink or reorder-only is not — a snapshot reinstall that
 * drops history must never pulse.
 */
export function advanceRecordArrival(
  baseline: RecordArrivalBaseline,
  entries: readonly { readonly id: string }[],
): { readonly baseline: RecordArrivalBaseline; readonly arrived: boolean } {
  const next = recordArrivalBaseline(entries);
  const arrived =
    next.count > baseline.count ||
    (next.count === baseline.count && next.count > 0 && next.lastId !== baseline.lastId);
  return { baseline: next, arrived };
}

/**
 * Thrown by dispatch-time write gates injected into the client's lease
 * helpers (`beforeDispatch`): the lease acquisition wait can span a
 * takeover or freshness change, and the command must not leave after it.
 */
export class WriteGateError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "WriteGateError";
    this.reason = reason;
  }
}
