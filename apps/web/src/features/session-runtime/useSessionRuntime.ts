// React binding for session runtimes. Keeps a small LRU of paused runtimes
// so A→B→A switching restores a session's projection from memory instantly
// (DESIGN_PLAN continuity: LRU of eight sessions). Desktop mode builds live
// controller-backed runtimes; browser mode builds deterministic fixtures.
import type { DesktopRuntimeController } from "@t4-code/client";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import {
  desktopRuntime,
  useDesktopRuntimeSelector,
} from "../../platform/desktop-runtime.ts";
import { resolveLiveSession } from "../../platform/live-workspace.ts";
import {
  createFixtureSessionRuntime,
  type SessionLink,
  type SessionRuntime,
  type SessionRuntimeSnapshot,
} from "./controller.ts";
import type { TranscriptVariant } from "./fixtures.ts";
import { createLiveSessionRuntime } from "./live-runtime.ts";

const RUNTIME_LRU_LIMIT = 8;
const runtimeCache = new Map<string, SessionRuntime>();

/** QA/screenshot switch: pin a scripted transcript variant. */
export function parseTranscriptVariant(search: string): TranscriptVariant {
  const value = new URLSearchParams(search).get("transcript");
  return value === "stress" || value === "gap" || value === "compaction"
    ? value
    : "default";
}

function rememberRuntime(
  cache: Map<string, SessionRuntime>,
  cacheKey: string,
  runtime: SessionRuntime,
): void {
  cache.set(cacheKey, runtime);
  if (cache.size > RUNTIME_LRU_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.get(oldestKey)?.dispose();
      cache.delete(oldestKey);
    }
  }
}

function refreshRecency(
  cache: Map<string, SessionRuntime>,
  cacheKey: string,
): SessionRuntime | undefined {
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    // Refresh recency: Map iteration order is insertion order.
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
  }
  return cached;
}

/**
 * Obtain (or reuse) the live runtime for a session view id. Selecting a
 * session reuses the cached runtime; attachment is owned by that runtime so
 * it follows controller connection state.
 */
export function obtainLiveRuntime(
  controller: DesktopRuntimeController,
  sessionKey: string,
  cache: Map<string, SessionRuntime> = runtimeCache,
  targetIdOverride?: string,
): SessionRuntime {
  const address = resolveLiveSession(controller.getSnapshot(), sessionKey);
  const separator = sessionKey.indexOf("/");
  const hostId =
    address?.hostId ?? decodeURIComponent(separator > 0 ? sessionKey.slice(0, separator) : sessionKey);
  const sessionId =
    address?.sessionId ?? decodeURIComponent(separator > 0 ? sessionKey.slice(separator + 1) : "");
  const targetId = targetIdOverride ?? address?.targetId ?? "local";
  // Link changes on one target must reuse the same runtime and transcript.
  // A restored route may mount before a named profile reconnects, however;
  // once that host binds to its real target, replace the fallback runtime.
  const cacheKey = `live\u0000${sessionKey}\u0000${targetId}`;
  const cached = refreshRecency(cache, cacheKey);
  if (cached !== undefined) return cached;
  const runtime = createLiveSessionRuntime({
    controller,
    targetId,
    hostId,
    sessionId,
  });
  rememberRuntime(cache, cacheKey, runtime);
  return runtime;
}

function obtainRuntime(sessionKey: string, link: SessionLink, targetId?: string): SessionRuntime {
  const controller = desktopRuntime();
  if (controller !== null) return obtainLiveRuntime(controller, sessionKey, runtimeCache, targetId);
  const variant =
    typeof window !== "undefined" ? parseTranscriptVariant(window.location.search) : "default";
  const cacheKey = `${sessionKey}\u0000${variant}\u0000${link}`;
  const cached = refreshRecency(runtimeCache, cacheKey);
  if (cached !== undefined) return cached;
  const runtime = createFixtureSessionRuntime({ sessionKey, variant, link });
  rememberRuntime(runtimeCache, cacheKey, runtime);
  return runtime;
}

export interface UseSessionRuntimeResult {
  readonly runtime: SessionRuntime;
  readonly snapshot: SessionRuntimeSnapshot;
}

export function useSessionRuntime(sessionKey: string, link: SessionLink): UseSessionRuntimeResult {
  const controller = desktopRuntime();
  const selectedTargetId = useDesktopRuntimeSelector(
    (snapshot) => resolveLiveSession(snapshot, sessionKey)?.targetId,
  );
  const targetId = controller === null ? undefined : (selectedTargetId ?? undefined);
  const runtime = useMemo(
    () => obtainRuntime(sessionKey, link, targetId),
    [sessionKey, link, targetId],
  );

  useEffect(() => {
    runtime.resume();
    return () => runtime.pause();
  }, [runtime]);

  const snapshot = useSyncExternalStore(
    (listener) => runtime.subscribe(listener),
    () => runtime.getSnapshot(),
  );

  return { runtime, snapshot };
}
