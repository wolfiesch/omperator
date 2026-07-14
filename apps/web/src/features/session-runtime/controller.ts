// Session runtime controller: the seam between the transcript surface and
// whatever produces server frames. The renderer only ever sees this
// interface; today the deterministic fixture implementation drives it, and
// the Electron bridge replaces `createFixtureSessionRuntime` with an
// AppClient-backed implementation without touching a single component.
import {
  initialProjection,
  reduceTranscript,
  type TranscriptFrame,
  type TranscriptProjection,
} from "../transcript/projection.ts";
import {
  buildSessionScript,
  FIXTURE_NOW_MS,
  framesForIntent,
  type SessionScript,
  type TranscriptVariant,
} from "./fixtures.ts";
import type { SlashCommand } from "../composer/slash.ts";
import {
  isThinkingLevel,
  THINKING_LEVELS,
  type SessionIntent,
  type SessionMode,
  type ThinkingLevel,
} from "./intents.ts";
import type { ComposerControlsSnapshot } from "./session-controls.ts";
import {
  createTranscriptImageSource,
  TRANSCRIPT_IMAGE_FIXTURE_REASON,
  type TranscriptImageSource,
} from "./transcript-images.ts";

/** How current this session's connection is; mirrors shell freshness. */
export type SessionLink = "live" | "cached" | "offline";

export interface SessionRuntimeSnapshot {
  readonly projection: TranscriptProjection;
  readonly link: SessionLink;
  /** Commands this connection may send; gates composer affordances. */
  readonly canPrompt: boolean;
  readonly canCancel: boolean;
  /** Why stopping is unavailable right now; null when `canCancel`. */
  readonly cancelDisabledReason: string | null;
  /**
   * Runtime-advertised slash commands, or null when the runtime has no
   * catalog of its own and the composer's built-in browser catalog applies.
   */
  readonly slashCommands: readonly SlashCommand[] | null;
  readonly contextUsedTokens: number;
  readonly contextWindowTokens: number;
  /** Follow-ups queued while a turn streams; sent when the turn ends. */
  readonly queuedFollowUps: readonly string[];
  /** Model / thinking / fast / mode truth for the composer's controls. */
  readonly controls: ComposerControlsSnapshot;
  /**
   * Time base for elapsed labels. The fixture runtime reports the fixed
   * scripted "now" so renders are reproducible; a real bridge runtime
   * reports the wall clock at snapshot time.
   */
  readonly nowMs: number;
}

/** Verdict for a submitted prompt-shaped intent. */
export type PromptOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

export interface SessionRuntime {
  /** Bounded, metadata-authorized reads for durable transcript images. */
  readonly transcriptImages: TranscriptImageSource;
  getSnapshot(): SessionRuntimeSnapshot;
  subscribe(listener: () => void): () => void;
  dispatch(intent: SessionIntent): void;
  /**
   * Submit a prompt or steer and learn its fate: the composer clears the
   * draft only on "accepted" and keeps it otherwise.
   */
  submitPrompt(intent: SessionIntent): Promise<PromptOutcome>;
  /** Stop timers; the runtime keeps its state for A→B→A switch-back. */
  pause(): void;
  /** Resume draining scripted live steps. */
  resume(): void;
  dispose(): void;
}

export interface FixtureRuntimeOptions {
  readonly sessionKey: string;
  readonly variant: TranscriptVariant;
  /** Milliseconds between scripted stream ticks. */
  readonly tickMs?: number;
  /** Freshness override from the shell fixture (cached/offline sessions). */
  readonly link?: SessionLink;
}

const DEFAULT_TICK_MS = 700;

export function createFixtureSessionRuntime(options: FixtureRuntimeOptions): SessionRuntime {
  const script: SessionScript = buildSessionScript(options.sessionKey, options.variant);
  const link = options.link ?? script.link;
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;

  let projection = initialProjection();
  let queuedFollowUps: readonly string[] = [];
  // Fixture control state lives in the runtime — never in the renderer —
  // so the browser shell exercises the same authority seam the live
  // desktop runtime provides. Deterministic defaults, no persistence.
  let model = script.modelChoices[0] ?? null;
  let thinking: ThinkingLevel = "medium";
  let fast = false;
  let mode: SessionMode = "build";
  let snapshot: SessionRuntimeSnapshot | null = null;
  const listeners = new Set<() => void>();
  // Pending stream work: one inner array of frames applies per tick.
  const pendingTicks: TranscriptFrame[][] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let paused = false;
  const transcriptImages = createTranscriptImageSource({
    availability: { available: false, reason: TRANSCRIPT_IMAGE_FIXTURE_REASON },
    readChunk: async () => ({ accepted: false }),
  });

  const notify = () => {
    snapshot = null;
    for (const listener of listeners) listener();
  };

  const applyFrames = (frames: readonly TranscriptFrame[]) => {
    let next = projection;
    for (const frame of frames) next = reduceTranscript(next, frame);
    if (next !== projection) {
      projection = next;
      notify();
    }
  };

  const drainQueuedFollowUps = () => {
    if (projection.turnActive || queuedFollowUps.length === 0) return;
    const [head, ...rest] = queuedFollowUps;
    queuedFollowUps = rest;
    if (head !== undefined) {
      for (const batch of framesForIntent(script.factory, { kind: "followUp", text: head })) {
        pendingTicks.push([...batch]);
      }
    }
    notify();
  };

  const ensureTimer = () => {
    if (timer !== null || paused || pendingTicks.length === 0) return;
    timer = setInterval(() => {
      const batch = pendingTicks.shift();
      if (batch !== undefined) applyFrames(batch);
      if (!projection.turnActive) drainQueuedFollowUps();
      if (pendingTicks.length === 0 && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    }, tickMs);
  };

  // Attach: install the snapshot (and pending attention) synchronously so
  // switch-in paints settled content immediately, then stream live steps.
  applyFrames(script.initialFrames);
  for (const step of script.liveSteps) pendingTicks.push([step]);
  ensureTimer();

  return {
    transcriptImages,
    getSnapshot() {
      if (snapshot === null) {
        const controls: ComposerControlsSnapshot = {
          modelSupported: link === "live",
          modelUnsupportedReason: link === "live" ? null : "This session is read-only right now.",
          modelLabel: model?.label ?? null,
          modelSelectedId: model?.id ?? null,
          modelChoices: script.modelChoices,
          thinkingSupported: link === "live",
          thinkingUnsupportedReason: link === "live" ? null : "This session is read-only right now.",
          thinking,
          thinkingLevels: THINKING_LEVELS,
          fastSupported: link === "live",
          fastUnsupportedReason: link === "live" ? null : "This session is read-only right now.",
          fast,
          modeSupported: link === "live",
          mode,
          attachmentsSupported: true,
          pendingControl: null,
          controlError: null,
        };
        snapshot = {
          projection,
          link,
          canPrompt: link === "live",
          canCancel: link === "live" && projection.turnActive,
          cancelDisabledReason: null,
          slashCommands: null,
          contextUsedTokens: script.contextUsedTokens,
          contextWindowTokens: script.contextWindowTokens,
          queuedFollowUps,
          controls,
          nowMs: FIXTURE_NOW_MS,
        };
      }
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch(intent) {
      if (link !== "live") return; // disabled truth is enforced in UI too
      if (intent.kind === "setModel") {
        model =
          script.modelChoices.find(
            (choice) =>
              (intent.role !== null && choice.role === intent.role) ||
              (intent.selector !== null && choice.selector === intent.selector),
          ) ?? model;
        notify();
        return;
      }
      if (intent.kind === "setThinking") {
        if (isThinkingLevel(intent.level)) thinking = intent.level;
        notify();
        return;
      }
      if (intent.kind === "setFast") {
        fast = intent.enabled;
        notify();
        return;
      }
      if (intent.kind === "setMode") {
        mode = intent.mode;
        notify();
        return;
      }
      if (intent.kind === "followUp") {
        if (projection.turnActive) {
          queuedFollowUps = [...queuedFollowUps, intent.text];
          notify();
          return;
        }
        // No running turn: a follow-up is just a prompt-shaped message.
      }
      if (intent.kind === "cancel") {
        // Cancellation clears any scripted stream still pending.
        pendingTicks.length = 0;
      }
      const batches = framesForIntent(script.factory, intent);
      const [first, ...rest] = batches;
      if (first !== undefined) applyFrames(first); // echo lands immediately
      for (const batch of rest) pendingTicks.push([...batch]);
      ensureTimer();
    },
    async submitPrompt(intent) {
      if (link !== "live") {
        return { kind: "rejected", reason: "This session is read-only right now." };
      }
      this.dispatch(intent);
      return { kind: "accepted" };
    },
    pause() {
      paused = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    resume() {
      paused = false;
      ensureTimer();
    },
    dispose() {
      paused = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      transcriptImages.dispose();
      listeners.clear();
    },
  };
}
