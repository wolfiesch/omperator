import type { DesktopRuntimeController, DesktopRuntimeSnapshot } from "@t4-code/client";

import type { TranscriptProjection } from "../transcript/projection.ts";

interface LiveAttachmentOptions {
  readonly controller: DesktopRuntimeController;
  readonly targetId: string;
  readonly hostId: string;
  readonly sessionId: string;
  readonly projectionKey: string;
  readonly cursor: () => TranscriptProjection["cursor"];
  readonly isDisposed: () => boolean;
  readonly notify: () => void;
  readonly primeTranscriptTail: () => Promise<void>;
  readonly setTranscriptImagesAttached: (
    attached: boolean,
    runtime: DesktopRuntimeSnapshot,
  ) => void;
}

export interface LiveAttachmentController {
  attachIfAuthoritative(runtime: DesktopRuntimeSnapshot): void;
}

export function createLiveAttachmentController(
  options: LiveAttachmentOptions,
): LiveAttachmentController {
  let attached = false;
  let attaching = false;
  let retryAfterAttach = false;
  let connectionGeneration = 0;
  const initial = options.controller.getSnapshot();
  let previousAttachAuthority =
    initial.connections.get(options.targetId) === "connected" &&
    initial.targetHosts.get(options.targetId) === options.hostId;

  const attachIfAuthoritative = (runtime: DesktopRuntimeSnapshot) => {
    if (options.isDisposed()) return;
    const hasAttachAuthority =
      runtime.connections.get(options.targetId) === "connected" &&
      runtime.targetHosts.get(options.targetId) === options.hostId;
    if (hasAttachAuthority !== previousAttachAuthority) {
      previousAttachAuthority = hasAttachAuthority;
      connectionGeneration += 1;
      if (!hasAttachAuthority) {
        attached = false;
        options.setTranscriptImagesAttached(false, runtime);
      }
    }
    if (!hasAttachAuthority) return;
    if (
      attached &&
      !attaching &&
      runtime.projection.sessions.get(options.projectionKey)?.freshness !== "fresh"
    ) {
      // A replacement host can publish its welcome before the renderer sees
      // the transient disconnected state. The welcome correctly invalidates
      // the old live projection; treat that loss of freshness as a new attach
      // boundary instead of leaving the composer cached forever.
      attached = false;
      options.setTranscriptImagesAttached(false, runtime);
    }
    if (attached) return;
    if (attaching) {
      retryAfterAttach = true;
      return;
    }
    attaching = true;
    retryAfterAttach = false;
    const generation = connectionGeneration;
    attached = true;
    const tailPrime = options.primeTranscriptTail();
    const startAttach = () =>
      options.controller.attachSession(
        options.targetId,
        options.hostId,
        options.sessionId,
        options.cursor() ?? undefined,
      );
    const attachRequest = options.cursor() === null ? tailPrime.then(startAttach) : startAttach();
    void attachRequest
      .then((result) => {
        const current = options.controller.getSnapshot();
        const imagesAttached = result.accepted === true && generation === connectionGeneration;
        if (!imagesAttached) attached = false;
        options.setTranscriptImagesAttached(imagesAttached, current);
        options.notify();
      })
      .catch(() => {
        attached = false;
        options.setTranscriptImagesAttached(false, options.controller.getSnapshot());
        options.notify();
      })
      .finally(() => {
        attaching = false;
        if (options.isDisposed()) return;
        if (retryAfterAttach && generation !== connectionGeneration) {
          retryAfterAttach = false;
          attachIfAuthoritative(options.controller.getSnapshot());
        } else {
          retryAfterAttach = false;
        }
      });
  };

  return { attachIfAuthoritative };
}
