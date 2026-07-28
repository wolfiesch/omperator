// Live session runtime: the desktop implementation of the SessionRuntime
// seam, backed by a DesktopRuntimeController. Frames flow one way — the
// controller's typed subscription feeds the same transcript reducer the
// fixture uses — and every user action leaves as a typed command through
// the controller. Nothing here scrapes terminal output, parses logs, or
// invents runtime truth; what the frames do not say, the UI does not show.
// Live session runtime: the desktop implementation of the SessionRuntime
// seam, backed by a DesktopRuntimeController. Frames flow one way — the
// controller's typed subscription feeds the same transcript reducer the
// fixture uses — and every user action leaves as a typed command through
// the controller. Nothing here scrapes terminal output, parses logs, or
// invents runtime truth; what the frames do not say, the UI does not show.
import type { DesktopRuntimeController, DesktopRuntimeSnapshot, SessionProjection } from "@t4-code/client";
import { hostId as brandHostId, PROTOCOL_VERSION, revision as brandRevision, sessionId as brandSessionId, type SessionEvent, type SessionSnapshotFrame } from "@t4-code/protocol";

import { initialProjection, reduceTranscript, reduceTranscriptEvent, replayRetainedTranscriptEvents, retainedTranscriptEventsAreValid, settleTranscriptTurn, transcriptIsActive, type TranscriptServerEvent, type TranscriptProjection } from "../transcript/projection.ts";
import { slashCommandsFromCatalog } from "../composer/slash.ts";
import type { SessionLink, SessionRuntime, SessionRuntimeSnapshot } from "./controller.ts";
import { pendingPromptsFromRef } from "./pending-prompts.ts";
import { createTranscriptArtifactSource, type TranscriptImageAvailability, type TranscriptMediaReference } from "./transcript-images.ts";
import { deriveComposerControls } from "./session-controls.ts";
import { CACHED_WRITE_REASON, gateComposerControls, OFFLINE_WRITE_REASON, presentSessionControl, readSessionControl, sessionControlForLink } from "./session-observer.ts";
import { sessionWriteLink } from "./session-inventory.ts";
import { findCancelCommand } from "./live-controls.ts";
import { createLiveAttachmentController } from "./live-attachment.ts";
import { createLivePromptDispatcher } from "./live-prompt-dispatcher.ts";
import { activePendingPromptId, authoritativeWorkingState, getQueuedFollowUps, isTranscriptEvent, retiredPendingPromptId, sessionRefIsCompacting, sessionIsWorkingWithPendingPrompts } from "./live-session-state.ts";
import { createLiveTranscriptPager } from "./live-transcript-history.ts";

export interface LiveRuntimeOptions {
  readonly controller: DesktopRuntimeController;
  readonly targetId: string;
  readonly hostId: string;
  readonly sessionId: string;
}

const MAX_RETIRED_PENDING_PROMPTS = 128;

export function createLiveSessionRuntime(options: LiveRuntimeOptions): SessionRuntime {
  const { controller, targetId } = options;
  const projectionKey = `${options.hostId}\u0000${options.sessionId}`;
  const wireHostId = brandHostId(options.hostId);
  const wireSessionId = brandSessionId(options.sessionId);

  let transcript = initialProjection();
  let snapshot: SessionRuntimeSnapshot | null = null;
  let disposed = false;
  const retiredPendingPromptIds = new Set<string>();
  const retirePendingPrompt = (entryId: string) => {
    if (retiredPendingPromptIds.has(entryId)) return;
    retiredPendingPromptIds.add(entryId);
    while (retiredPendingPromptIds.size > MAX_RETIRED_PENDING_PROMPTS) {
      const oldest = retiredPendingPromptIds.values().next().value;
      if (oldest === undefined) break;
      retiredPendingPromptIds.delete(oldest);
    }
  };
  const applyPendingPromptLifecycle = (event: SessionEvent) => {
    const activeId = activePendingPromptId(event);
    if (activeId !== null) retiredPendingPromptIds.delete(activeId);
    const retiredId = retiredPendingPromptId(event);
    if (retiredId !== null) retirePendingPrompt(retiredId);
  };
  // Composer control command state: which control awaits the host, and the
  // last failure. Values themselves always come from server state — the
  // label never swaps optimistically.
  const listeners = new Set<() => void>();
  let transcriptImagesAttached = false;

  const transcriptImages = createTranscriptArtifactSource({
    hostId: options.hostId,
    sessionId: options.sessionId,
    availability: {
      available: false,
      reason: "Waiting for this session to finish connecting.",
    },
    // The controller command is not abortable. Keep the cache load slot held
    // until it actually settles; the source checks its cancellation token
    // immediately afterward and discards the response. This prevents rapid
    // unmounts from creating unbounded detached RPC reads.
    readChunk: (reference, offset) =>
      controller.command(targetId, {
        hostId: wireHostId,
        sessionId: wireSessionId,
        command: "source" in reference ? "artifact.read" : "session.image.read",
        args:
          "source" in reference
            ? { artifactId: reference.artifactId, offset }
            : { entryId: reference.entryId, sha256: reference.sha256, offset },
      }),
  });

  const transcriptImageAvailability = (
    runtime: DesktopRuntimeSnapshot,
    reference: TranscriptMediaReference,
  ): TranscriptImageAvailability => {
    if (runtime.connections.get(targetId) !== "connected") {
      return { available: false, reason: "Reconnect to this host to load transcript media." };
    }
    const host = runtime.hosts.get(options.hostId);
    const noun = "source" in reference ? "artifact" : "transcript image";
    if (host === undefined || !host.grantedCapabilities.includes("sessions.read")) {
      return {
        available: false,
        reason: `This target does not grant ${noun} access.`,
      };
    }
    if (
      "source" in reference
        ? !host.grantedFeatures.includes("artifacts.read")
        : !host.grantedFeatures.includes("transcript.images")
    ) {
      return {
        available: false,
        reason:
          "source" in reference
            ? "This host does not offer artifact reads."
            : "This OMP host does not offer transcript image reads.",
      };
    }
    if (!transcriptImagesAttached) {
      return { available: false, reason: "Waiting for this session to finish connecting." };
    }
    return { available: true };
  };

  const syncTranscriptImageAvailability = (runtime: DesktopRuntimeSnapshot) => {
    transcriptImages.setAvailability((reference) => transcriptImageAvailability(runtime, reference));
  };


  const warmSession = (runtime: DesktopRuntimeSnapshot): SessionProjection | undefined =>
    runtime.projection.sessions.get(projectionKey);

  /**
   * Fail-closed write gate, evaluated against CURRENT truth immediately
   * before every mutating dispatch — including after awaits, control
   * barriers, and confirmation dialogs. Freshness precedence: offline
   * always refuses; a present ownership field refuses with the cached
   * copy on a cached link (freshness copy wins over observer copy) and
   * with the honest observer copy on a live link. Strict dispatch also
   * refuses on a bare cached link. The single narrow exception
   * ("queued-prompt"): a `session.prompt` that was invoked against a live
   * link and only waited out the control barrier may cross a bare cached
   * blip — revision and lease protection fence that race, and the server
   * remains final authority. Null means writable.
   */
  const writeGate = (
    phase: "strict" | "queued-prompt" = "strict",
  ): { readonly kind: "rejected"; readonly reason: string } | null => {
    const runtime = controller.getSnapshot();
    const link = sessionWriteLink(runtime, targetId, options.hostId, options.sessionId);
    if (link === "offline") return { kind: "rejected", reason: OFFLINE_WRITE_REASON };
    const state = readSessionControl(
      warmSession(runtime)?.ref ?? runtime.projection.sessionIndex.get(projectionKey),
    );
    if (state !== null) {
      if (sessionControlForLink(link, state) === null) {
        return { kind: "rejected", reason: CACHED_WRITE_REASON };
      }
      return { kind: "rejected", reason: presentSessionControl(state).composerReason };
    }
    if (link === "cached" && phase !== "queued-prompt") {
      return { kind: "rejected", reason: CACHED_WRITE_REASON };
    }
    return null;
  };

  const withWarmHistoryTruncation = (
    projection: TranscriptProjection,
    runtime: DesktopRuntimeSnapshot,
  ): TranscriptProjection =>
    warmSession(runtime)?.historyTruncated === true && !projection.historyTruncated
      ? { ...projection, historyTruncated: true }
      : projection;

  const notify = () => {
    snapshot = null;
    for (const listener of listeners) listener();
  };

  const transcriptPager = createLiveTranscriptPager({
    controller,
    targetId,
    hostId: options.hostId,
    sessionId: options.sessionId,
    isDisposed: () => disposed,
    notify,
  });

  // Seed from the controller's warm projection. Durable entries install at the
  // authoritative warm cursor; the bounded event suffix is then folded in its
  // original order to restore requests and other event-derived state. Event
  // sequence gaps are expected because durable entry frames live separately.
  const warm = warmSession(controller.getSnapshot());
  if (warm !== undefined && warm.cursor !== undefined) {
    const seed: SessionSnapshotFrame = {
      v: PROTOCOL_VERSION,
      type: "snapshot",
      cursor: warm.cursor,
      revision: brandRevision(warm.revision ?? "rev-unknown"),
      hostId: wireHostId,
      sessionId: wireSessionId,
      entries: [...warm.entries],
    };
    transcript = withWarmHistoryTruncation(
      reduceTranscript(transcript, seed),
      controller.getSnapshot(),
    );
    const baseline = {
      cursor: warm.cursor,
      hostId: options.hostId,
      sessionId: options.sessionId,
    };
    const validWarmEvents = retainedTranscriptEventsAreValid(transcript, warm.events, baseline);
    if (validWarmEvents) {
      for (const frame of warm.events) applyPendingPromptLifecycle(frame.event);
    }
    if (warm.gap === undefined && validWarmEvents) {
      transcript = replayRetainedTranscriptEvents(transcript, warm.events, baseline);
    }
  }

  const promptDispatcher = createLivePromptDispatcher({
    controller,
    targetId,
    hostId: options.hostId,
    sessionId: options.sessionId,
    projectionKey,
    wireHostId,
    wireSessionId,
    warmSession,
    writeGate,
    notify,
  });

  const applyServerEvent = (event: TranscriptServerEvent) => {
    // Renderer events are sanitized to their global retention budget before
    // delivery. Preserve the shared client's smaller/custom retention truth,
    // which is otherwise not representable on the server snapshot itself.
    const reduced = reduceTranscriptEvent(transcript, event);
    // Subscribers still receive stale/duplicate/gapped events that
    // the reducer correctly refuses. Only advance prompt retirement state when
    // the transcript actually accepted this event at its advertised cursor.
    if (
      event.kind === "event" &&
      reduced !== transcript &&
      reduced.cursor?.epoch === event.payload.cursor.epoch &&
      reduced.cursor.seq === event.payload.cursor.seq
    ) {
      applyPendingPromptLifecycle(event.payload.event);
    }
    const next = withWarmHistoryTruncation(reduced, controller.getSnapshot());
    if (next !== transcript) {
      transcript = next;
      notify();
    }
  };

  const initialAuthoritativeWorking = authoritativeWorkingState(
    controller.getSnapshot(),
    targetId,
    options.hostId,
    options.sessionId,
    projectionKey,
    retiredPendingPromptIds,
  );
  const initialProjectionSnapshot = controller.getSnapshot().projection;
  const warmTranscriptEventOrdinal = warm?.transcriptEventArrivalOrdinal ?? 0;
  const authoritativeRefOrdinal =
    initialProjectionSnapshot.sessionRefArrivalOrdinals.get(projectionKey) ?? 0;
  if (
    initialAuthoritativeWorking === false &&
    authoritativeRefOrdinal > warmTranscriptEventOrdinal
  ) {
    // Transcript and session-index cursors are independent. Settle warm
    // volatile UI only when this process observed complete idle ref truth
    // after the last accepted transcript event. This preserves a current
    // turn/compaction whose active ref delta has not arrived yet.
    transcript = settleTranscriptTurn(transcript);
  }
  const attachment = createLiveAttachmentController({
    controller,
    targetId,
    hostId: options.hostId,
    sessionId: options.sessionId,
    projectionKey,
    cursor: () => transcript.cursor,
    isDisposed: () => disposed,
    notify,
    primeTranscriptTail: () => transcriptPager.prime(),
    setTranscriptImagesAttached: (nextAttached, runtime) => {
      transcriptImagesAttached = nextAttached;
      syncTranscriptImageAvailability(runtime);
    },
  });
  const unsubscribeEvents = controller.subscribeEvents(
    {
      targetId,
      hostId: options.hostId,
      sessionId: options.sessionId,
      // session.delta belongs to the host-wide session-index cursor domain,
      // not this session's transcript cursor domain. The shared desktop
      // projection already consumes it for ref/revision/control truth.
      kinds: ["snapshot", "entry", "event", "gap"],
    },
    (event) => {
      if (isTranscriptEvent(event.event)) {
        applyServerEvent(event.event);
      }
    },
  );
  // Connection state, catalog, confirmation, and freshness changes all
  // surface through the controller snapshot; re-derive on every change.
  const unsubscribeRuntime = controller.subscribe((runtime) => {
    const retainedTranscript = withWarmHistoryTruncation(transcript, runtime);
    if (retainedTranscript !== transcript) transcript = retainedTranscript;
    attachment.attachIfAuthoritative(runtime);
    const authoritativeWorking = authoritativeWorkingState(
      runtime,
      targetId,
      options.hostId,
      options.sessionId,
      projectionKey,
      retiredPendingPromptIds,
    );
    const warmNow = runtime.projection.sessions.get(projectionKey);
    const newestTranscriptEventOrdinal = warmNow?.transcriptEventArrivalOrdinal ?? 0;
    const newestRefOrdinal = runtime.projection.sessionRefArrivalOrdinals.get(projectionKey) ?? 0;
    if (authoritativeWorking === false && newestRefOrdinal > newestTranscriptEventOrdinal) {
      // Settle on receive order, not a working true -> false edge. A mounted
      // runtime may miss the active ref entirely (null -> idle) or receive two
      // idle refs around newer transcript activity (idle -> idle). The newer
      // complete ref is the proof; stale metadata/ref generations are fenced
      // by authoritativeWorkingState above.
      const next = settleTranscriptTurn(transcript, {
        // turn.error is diagnostic until terminal lifecycle or ref proof.
        // Generation filtering preserves the current turn's explanation
        // while allowing this idle proof to retire an older turn's error.
        supersedeTransientErrors: transcript.turnActive,
      });
      if (next !== transcript) transcript = next;
    }
    syncTranscriptImageAvailability(runtime);
    notify();
  });
  // Subscribe before issuing attach. OMP may synchronously replay frames as
  // part of the attach round-trip; no replay frame may land in the gap between
  // runtime construction and listener registration.
  syncTranscriptImageAvailability(controller.getSnapshot());
  attachment.attachIfAuthoritative(controller.getSnapshot());


  return {
    transcriptImages,
    getSnapshot(): SessionRuntimeSnapshot {
      if (snapshot === null) {
        const runtime = controller.getSnapshot();
        const warmNow = warmSession(runtime);
        const indexedRef = runtime.projection.sessionIndex.get(projectionKey);
        const link: SessionLink = sessionWriteLink(
          runtime,
          targetId,
          options.hostId,
          options.sessionId,
        );
        const granted = promptDispatcher.grantedFor(runtime);
        const catalog = runtime.catalogs.get(options.hostId);
        // Session control truth: warm ref first, session index second.
        const ref = warmNow?.ref ?? indexedRef;
        const pendingPrompts = pendingPromptsFromRef(ref).filter(
          (prompt) => !retiredPendingPromptIds.has(prompt.entryId),
        );
        const sessionActive =
          link === "live" &&
          (transcriptIsActive(transcript) ||
            pendingPrompts.length > 0 ||
            sessionIsWorkingWithPendingPrompts(ref, pendingPrompts));
        const sessionControl = sessionControlForLink(link, readSessionControl(ref));
        const controlGate = sessionControl === null ? null : presentSessionControl(sessionControl);
        const cancelItem = catalog === undefined ? undefined : findCancelCommand(catalog.items);
        const cancelSupported = cancelItem !== undefined && cancelItem.supported !== false;
        const canCancel =
          link === "live" && sessionActive && cancelSupported && controlGate === null;
        const cancelDisabledReason =
          controlGate !== null
            ? controlGate.cancelReason
            : cancelSupported
              ? null
              : catalog === undefined
                ? "Waiting for this host's command list"
                : (cancelItem?.reason ?? "This host does not offer a stop command");
        const challenge = promptDispatcher.pendingChallenge(runtime);
        let projection: TranscriptProjection =
          transcript.approval === null && challenge !== null
            ? { ...transcript, approval: challenge.approval }
            : transcript;
        if (
          link === "live" &&
          projection.contextMaintenance === null &&
          sessionRefIsCompacting(indexedRef) &&
          (runtime.projection.sessionRefArrivalOrdinals.get(projectionKey) ?? 0) >
            (warmNow?.contextMaintenanceEventArrivalOrdinal ?? 0)
        ) {
          projection = {
            ...projection,
            contextMaintenance: {
              startedAt: null,
              reason: "Restored from current session state",
            },
          };
        }
        const contextUsage = runtime.projection.sessionIndex.get(projectionKey)?.contextUsage;

        const canPrompt =
          link === "live" &&
          granted.includes("sessions.prompt") &&
          ref?.status !== "closed" &&
          controlGate === null;
        const queuedFollowUps = getQueuedFollowUps(ref);
        const derivedControls = deriveComposerControls({
          catalog,
          settings: runtime.settings.get(options.hostId),
          ref,
          granted,
          pendingControl: promptDispatcher.pendingControl,
          controlError: promptDispatcher.controlError,
        });
        projection = transcriptPager.present(projection);

        snapshot = {
          projection,
          link,
          sessionActive,
          pendingPrompts,
          canPrompt,
          canCancel,
          cancelDisabledReason,
          slashCommands:
            catalog === undefined
              ? []
              : slashCommandsFromCatalog(
                  catalog.items,
                  {
                    link,
                    turnActive: sessionActive,
                    readOnlyReason: controlGate === null ? null : controlGate.slashReason,
                  },
                  granted,
                  catalog.operations,
                ),
          contextUsedTokens: contextUsage?.used ?? 0,
          contextWindowTokens: contextUsage?.limit ?? 0,
          queuedFollowUps,
          controls:
            controlGate === null
              ? derivedControls
              : gateComposerControls(derivedControls, controlGate.controlReason),
          sessionControl,
          providerTransport: ref?.liveState?.providerTransport ?? null,
          ...(transcriptPager.history === undefined
            ? {}
            : { transcriptHistory: transcriptPager.history }),
          nowMs: Date.now(),
        };
      }
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch(intent) {
      void promptDispatcher.submitPrompt(intent);
    },
    submitPrompt: promptDispatcher.submitPrompt,
    async loadEarlierTranscript() {
      await transcriptPager.loadEarlier();
    },
    pause() {
      // Live frames keep applying in the background so switch-back is warm.
      // Image bytes do not: every inactive runtime releases its object URLs
      // and cancels reads so the eight-session projection LRU cannot become
      // eight independent 64 MiB renderer caches.
      transcriptImages.pause();
    },
    resume() {
      if (disposed) return;
      transcriptImages.resume();
      // Re-activate this session in the shared projection LRU.
      controller.activateSession(options.hostId, options.sessionId);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeEvents();
      unsubscribeRuntime();
      transcriptImages.dispose();
      listeners.clear();
    },
  };
}
