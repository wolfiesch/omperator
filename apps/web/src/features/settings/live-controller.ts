// Live settings.write seam. One save = one `settings.write` command carrying
// `{ edits, expectedRevision }` in its args and the same revision on the
// CommandFrame itself. The host's response frame decides the outcome:
// accepted responses trigger a re-read before the store clears its drafts,
// stale revisions surface as conflicts with the host's fresh catalog, and a
// dropped connection reports an unknown outcome — drafts always survive
// anything short of a confirmed apply.
import { redactedMessage, type DesktopRuntimeSnapshot } from "@t4-code/client";
import {
  hostId as brandHostId,
  revision as brandRevision,
  type ConfirmationChallenge,
  type ResultFrame,
} from "@t4-code/protocol";
import type {
  CommandRequest,
  CommandResult,
  ConfirmRequest,
  ConfirmResult,
  RendererServerEventEnvelope,
} from "@t4-code/protocol/desktop-ipc";

import { buildLiveSettingsCatalog, type LiveSettingsCatalog } from "./live-catalog.ts";
import type {
  SettingsController,
  SettingsSaveRequest,
  SettingsSaveResult,
} from "./schema.ts";

/** The slice of the desktop runtime controller this seam consumes. */
export interface LiveSettingsRuntimePort {
  getSnapshot(): DesktopRuntimeSnapshot;
  subscribe(listener: (snapshot: DesktopRuntimeSnapshot) => void): () => void;
  subscribeEvents(
    filter: { readonly targetId: string; readonly hostId?: string; readonly kinds?: readonly string[] },
    listener: (event: RendererServerEventEnvelope) => void,
  ): () => void;
  command(targetId: string, intent: CommandRequest["intent"]): Promise<CommandResult>;
  confirm(request: ConfirmRequest): Promise<ConfirmResult>;
}

/** What the confirmation prompt shows; token- and path-free host copy. */
export interface SaveChallenge {
  readonly summary: string;
  readonly preview: string | null;
  readonly expiresAt: string;
}

export interface LiveSettingsControllerOptions {
  readonly runtime: LiveSettingsRuntimePort;
  readonly targetId: string;
  readonly hostId: string;
  readonly hostLabel: string;
  /**
   * The host challenged this save; resolve with the user's decision.
   * Resolving after `expiresAt` is a denial on the host side.
   */
  readonly onChallenge: (challenge: SaveChallenge) => Promise<"approve" | "deny">;
  /** How long to wait for the host's response / re-read before giving up. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
type ResultPayload = Omit<ResultFrame, "v" | "type">;
type ConfirmationPayload = Omit<ConfirmationChallenge, "v" | "type">;

const UNKNOWN_OUTCOME_MESSAGE =
  "The connection dropped before the host confirmed this save. Your changes are still staged — check the host before saving again.";

/** One wire edit inside settings.write args. */
export interface SettingsWriteEdit {
  readonly path: string;
  readonly scope: "global" | "session";
  readonly value?: unknown;
  readonly reset?: true;
}

function sanitized(message: string): string {
  return redactedMessage(message).slice(0, 300).trim();
}

export function createLiveSettingsController(options: LiveSettingsControllerOptions): SettingsController {
  const { runtime, targetId, hostId, hostLabel } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const wireHostId = brandHostId(hostId);

  const catalogNow = (): LiveSettingsCatalog | null => {
    const snapshot = runtime.getSnapshot();
    const catalog = snapshot.catalogs.get(hostId);
    const settings = snapshot.settings.get(hostId);
    if (catalog === undefined || settings === undefined) return null;
    return buildLiveSettingsCatalog({ catalog, settings, hostLabel });
  };

  /** Ask the host to republish, then wait for the settings frame to move. */
  async function refresh(previousRevision: string): Promise<LiveSettingsCatalog | null> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const unsubscribe = runtime.subscribe((snapshot) => {
      const settings = snapshot.settings.get(hostId);
      if (settings !== undefined && String(settings.revision) !== previousRevision) resolve();
    });
    const timer = setTimeout(resolve, timeoutMs);
    try {
      await Promise.allSettled([
        runtime.command(targetId, { hostId: wireHostId, command: "settings.read", args: {} }),
        runtime.command(targetId, { hostId: wireHostId, command: "catalog.get", args: {} }),
      ]);
      const settled = runtime.getSnapshot().settings.get(hostId);
      if (settled === undefined || String(settled.revision) === previousRevision) await promise;
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
    return catalogNow();
  }

  async function save(request: SettingsSaveRequest): Promise<SettingsSaveResult> {
    const edits: SettingsWriteEdit[] = [];
    for (const change of request.changes) {
      if (change.scope !== "global" && change.scope !== "session") {
        return {
          outcome: "rejected",
          message: "This host only accepts changes for this machine or this run.",
        };
      }
      edits.push(
        change.action === "clear"
          ? { path: change.id, scope: change.scope, reset: true }
          : { path: change.id, scope: change.scope, value: change.value },
      );
    }

    // Collect the response before sending: the frame can beat the invoke
    // round-trip back to the renderer, and correlation is by requestId.
    const responses = new Map<string, ResultPayload>();
    let notifyResponse: (() => void) | null = null;
    let challenged = false;
    const unsubscribe = runtime.subscribeEvents(
      { targetId, hostId, kinds: ["response", "confirmation"] },
      (event) => {
        if (event.event.kind === "response") {
          const frame = event.event.payload as ResultPayload;
          if (frame.command === "settings.write" || frame.command === undefined) {
            responses.set(String(frame.requestId), frame);
            notifyResponse?.();
          }
          return;
        }
        if (event.event.kind !== "confirmation") return;
        // A host-scoped challenge while our write is pending is this save's
        // confirmation; the host holds the response until it is decided.
        const challenge = event.event.payload as ConfirmationPayload;
        if (challenge.sessionId !== undefined || challenged) return;
        challenged = true;
        void options
          .onChallenge({
            summary: challenge.summary,
            preview: challenge.preview ?? null,
            expiresAt: challenge.expiresAt,
          })
          .then((decision) =>
            runtime.confirm({
              targetId,
              confirmationId: challenge.confirmationId,
              commandId: challenge.commandId,
              hostId: challenge.hostId,
              decision,
            }),
          )
          .catch(() => {
            // A failed confirm round-trip times the command out; the save
            // reports an unknown outcome and the drafts stay staged.
          });
      },
    );

    try {
      let sent: CommandResult;
      try {
        sent = await runtime.command(targetId, {
          hostId: wireHostId,
          command: "settings.write",
          expectedRevision: brandRevision(request.revision),
          args: { edits, expectedRevision: request.revision },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        return {
          outcome: "rejected",
          message: /outcome is unknown/iu.test(message)
            ? UNKNOWN_OUTCOME_MESSAGE
            : message.length > 0
              ? sanitized(message)
              : "The host did not accept this save.",
        };
      }

      // The invoke resolved, so the host answered; wait (bounded) for that
      // response frame to reach this renderer.
      const deadline = Date.now() + timeoutMs;
      let response = responses.get(sent.requestId);
      while (response === undefined && Date.now() < deadline) {
        const remaining = deadline - Date.now();
        const { promise: next, resolve: arm } = Promise.withResolvers<void>();
        notifyResponse = arm;
        const timer = setTimeout(arm, Math.max(1, remaining));
        await next;
        clearTimeout(timer);
        notifyResponse = null;
        response = responses.get(sent.requestId);
      }
      if (response === undefined) {
        return { outcome: "rejected", message: UNKNOWN_OUTCOME_MESSAGE };
      }

      if (response.ok) {
        const refreshed = await refresh(request.revision);
        const fallback = catalogNow();
        const catalog = refreshed ?? fallback;
        if (catalog === null) return { outcome: "rejected", message: UNKNOWN_OUTCOME_MESSAGE };
        return { outcome: "applied", catalog: catalog.catalog };
      }

      const code = response.error?.code ?? "";
      if (/stale[_-]?revision/iu.test(code)) {
        const refreshed = await refresh(request.revision);
        if (refreshed === null) return { outcome: "rejected", message: UNKNOWN_OUTCOME_MESSAGE };
        return { outcome: "conflict", catalog: refreshed.catalog };
      }
      const message = response.error?.message;
      return {
        outcome: "rejected",
        message: message === undefined || message.length === 0
          ? "The host did not accept this save."
          : sanitized(message),
      };
    } finally {
      unsubscribe();
    }
  }

  return { save };
}
