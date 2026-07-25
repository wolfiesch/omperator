import type { Cursor, WorkspaceInfrastructureProjection } from "@t4-code/protocol";
import {
  decodeProjectionCacheValue,
  encodeProjectionCache,
  type ProjectionCacheStore,
} from "./projection-cache.ts";
import type {
  ProjectionOptions,
  ProjectionSnapshot,
  ProjectionSubscription,
  ProjectionFrame,
  SessionIndexMetadata,
} from "./projection-contract.ts";
import { resolveProjectionOptions } from "./projection-options.ts";
import { retainRestoredSessionResources } from "./projection-retention.ts";
import {
  applyPublicEvent,
  applyPublicFrame,
  applyWorkspaceInventory,
  createProjectionSnapshot,
  immutableMap,
  key,
  mapWithout,
  touch,
  withoutHostRefOrdinals,
} from "./projection-reducer.ts";
import { boundedIdentity } from "./projection-sanitize.ts";
import type { PublicOmpServerEvent } from "./omp-protocol-provider.ts";

export class ProjectionStore {
  private current: ProjectionSnapshot;
  private mutationGeneration = 0;
  private disposed = false;
  private readonly options: Required<ProjectionOptions>;
  private readonly listeners = new Set<ProjectionSubscription>();
  private readonly cacheStore: ProjectionCacheStore | undefined;
  private cacheSave: Promise<void> | undefined;
  private pendingSnapshot: ProjectionSnapshot | undefined;
  private cacheReadyPromise: Promise<void>;
  get hydrated(): Promise<void> {
    return this.cacheReadyPromise;
  }
  constructor(options: ProjectionOptions & { readonly cacheStore?: ProjectionCacheStore } = {}) {
    this.options = resolveProjectionOptions(options);
    this.current = createProjectionSnapshot();
    this.cacheStore = options.cacheStore;
    this.cacheReadyPromise = this.restoreCache();
  }
  get snapshot(): ProjectionSnapshot {
    return this.current;
  }
  getSnapshot(): ProjectionSnapshot {
    return this.current;
  }
  async ready(): Promise<void> {
    await this.cacheReadyPromise;
  }
  applyPublicFrame(frame: ProjectionFrame): ProjectionSnapshot {
    if (this.disposed) return this.current;
    const next = applyPublicFrame(this.current, frame, this.options);
    if (next === this.current) return next;
    this.mutationGeneration += 1;
    this.current = next;
    this.queueCacheSave();
    // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
    for (const listener of [...this.listeners]) {
      try {
        listener(next, frame);
      } catch {
        /* listener isolation */
      }
    }
    return next;
  }
  applyPublicEvent(event: PublicOmpServerEvent): ProjectionSnapshot {
    if (this.disposed) return this.current;
    const next = applyPublicEvent(this.current, event, this.options);
    if (next === this.current) return next;
    this.mutationGeneration += 1;
    this.current = next;
    this.queueCacheSave();
    // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
    for (const listener of [...this.listeners]) {
      try {
        listener(next, event);
      } catch {
        /* listener isolation */
      }
    }
    return next;
  }
  replaceWorkspaceInventory(
    hostId: string,
    workspaces: readonly WorkspaceInfrastructureProjection[],
    cursor?: Cursor,
  ): ProjectionSnapshot {
    if (this.disposed) return this.current;
    const host = boundedIdentity(hostId);
    if (host === undefined) return this.current;
    const next = applyWorkspaceInventory(
      this.current,
      host,
      workspaces,
      cursor,
      this.options.maxWorkspaces,
    );
    if (next === this.current) return next;
    this.mutationGeneration += 1;
    this.current = next;
    this.queueCacheSave();
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(next);
      } catch {
        /* listener isolation */
      }
    }
    return next;
  }
  invalidateWorkspaceInventory(hostId: string): ProjectionSnapshot {
    if (this.disposed || !this.current.workspaceCursors.has(hostId)) return this.current;
    const next = Object.freeze({
      ...this.current,
      workspaceCursors: mapWithout(this.current.workspaceCursors, hostId),
    });
    this.mutationGeneration += 1;
    this.current = next;
    this.queueCacheSave();
    return next;
  }
  clearWorkspaceInventory(hostId?: string): ProjectionSnapshot {
    if (this.disposed) return this.current;
    const host = hostId === undefined ? undefined : boundedIdentity(hostId);
    if (hostId !== undefined && host === undefined) return this.current;
    let workspaces = this.current.workspaces;
    let workspaceCursors = this.current.workspaceCursors;
    if (host === undefined) {
      if (workspaces.size === 0 && workspaceCursors.size === 0) return this.current;
      workspaces = immutableMap<string, WorkspaceInfrastructureProjection>();
      workspaceCursors = immutableMap<string, Cursor>();
    } else {
      const prefix = `${host}\u0000`;
      let retained: Map<string, WorkspaceInfrastructureProjection> | undefined;
      for (const itemKey of workspaces.keys()) {
        if (!itemKey.startsWith(prefix)) continue;
        retained ??= new Map(workspaces);
        retained.delete(itemKey);
      }
      const hasCursor = workspaceCursors.has(host);
      if (retained === undefined && !hasCursor) return this.current;
      if (retained !== undefined) workspaces = immutableMap(retained);
      if (hasCursor) workspaceCursors = mapWithout(workspaceCursors, host);
    }
    const next = Object.freeze({ ...this.current, workspaces, workspaceCursors });
    this.mutationGeneration += 1;
    this.current = next;
    this.queueCacheSave();
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(next);
      } catch {
        /* listener isolation */
      }
    }
    return next;
  }
  activateSession(hostId: string, sessionId: string): ProjectionSnapshot {
    if (this.disposed) return this.current;
    const next = Object.freeze({
      ...touch(this.current, key(hostId, sessionId), this.options),
      activeSessionKey: key(hostId, sessionId),
    });
    if (next === this.current) return next;
    this.mutationGeneration += 1;
    this.current = next;
    this.queueCacheSave();
    return next;
  }
  /**
   * Mark one host's (or every host's) retained session list as historical.
   * Connection generations are independent from app-wire session cursors, so
   * callers must invalidate completeness rather than cursor-reject a fresh
   * list whose host-wide cursor may legitimately restart at sequence zero.
   */
  invalidateSessionInventory(hostId?: string): ProjectionSnapshot {
    if (this.disposed) return this.current;
    const sessionIndexMetadata =
      hostId === undefined
        ? immutableMap<string, SessionIndexMetadata>()
        : mapWithout(this.current.sessionIndexMetadata, hostId);
    const sessionInventoryCursors =
      hostId === undefined
        ? immutableMap<string, Cursor>()
        : mapWithout(this.current.sessionInventoryCursors, hostId);
    const sessionRefArrivalOrdinals =
      hostId === undefined
        ? immutableMap<string, number>()
        : withoutHostRefOrdinals(this.current.sessionRefArrivalOrdinals, hostId);
    if (
      sessionIndexMetadata === this.current.sessionIndexMetadata &&
      sessionInventoryCursors === this.current.sessionInventoryCursors &&
      sessionRefArrivalOrdinals === this.current.sessionRefArrivalOrdinals
    )
      return this.current;
    const next = Object.freeze({
      ...this.current,
      sessionIndexMetadata,
      sessionInventoryCursors,
      sessionRefArrivalOrdinals,
    });
    this.mutationGeneration += 1;
    this.current = next;
    this.queueCacheSave();
    // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch {
        /* listener isolation */
      }
    }
    return next;
  }
  subscribe(listener: ProjectionSubscription): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }
  private queueCacheSave(): void {
    if (this.cacheStore === undefined || this.disposed) return;
    this.pendingSnapshot = this.current;
    if (this.cacheSave === undefined) this.cacheSave = this.drainCacheSaves();
  }
  private async drainCacheSaves(): Promise<void> {
    try {
      // Disposal blocks new mutations, but already-coalesced snapshots must still drain.
      while (this.pendingSnapshot !== undefined) {
        const snapshot = this.pendingSnapshot;
        this.pendingSnapshot = undefined;
        let serialized: string;
        try {
          serialized = encodeProjectionCache(snapshot);
        } catch {
          continue;
        }
        try {
          await Promise.resolve(this.cacheStore?.save(serialized));
        } catch {
          /* persistence cannot block live state */
        }
      }
    } finally {
      this.cacheSave = undefined;
      if (this.pendingSnapshot !== undefined && !this.disposed)
        this.cacheSave = this.drainCacheSaves();
    }
  }
  async flush(): Promise<void> {
    while (this.cacheSave !== undefined) await this.cacheSave;
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    await this.flush();
  }
  private async restoreCache(): Promise<void> {
    const loadGeneration = this.mutationGeneration;
    if (this.cacheStore === undefined) return;
    try {
      const value = await this.cacheStore.load();
      const restored = decodeProjectionCacheValue(value);
      if (
        restored !== undefined &&
        this.mutationGeneration === loadGeneration &&
        loadGeneration === 0
      ) {
        const sessions = immutableMap(
          [...restored.sessions].map(
            ([sessionKey, session]) =>
              [sessionKey, retainRestoredSessionResources(session, this.options)] as const,
          ),
        );
        this.current = Object.freeze({ ...restored, sessions });
        // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
        for (const listener of [...this.listeners]) {
          try {
            listener(this.current);
          } catch {
            /* listener isolation */
          }
        }
      }
    } catch {
      /* corrupt, old, or oversized cache fails closed */
    }
  }
}

export function createProjectionStore(
  options: ProjectionOptions & { readonly cacheStore?: ProjectionCacheStore } = {},
): ProjectionStore {
  return new ProjectionStore(options);
}
