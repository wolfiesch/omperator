import { decodeCursor, hostId, sessionId, type Cursor } from "@t4-code/protocol";
import type { CursorRecord, CursorStore, OmpClientError } from "./omp-client-contracts.ts";
import { MAX_SAVED, sessionKey } from "./omp-client-contracts.ts";

interface SaveQueue {
  latest: CursorRecord | undefined;
  running: boolean;
}
type EmitError = (error: OmpClientError) => void;
type ErrorFactory = (message: string, retryable?: boolean) => OmpClientError;
/** Durable cursor journal: bounded in-memory resume state plus serialized saves. */
export class CursorJournal {
  readonly records = new Map<string, CursorRecord>();
  readonly bySession = new Map<string, Cursor>();
  private readonly queues = new Map<string, SaveQueue>();
  private readonly drains = new Set<Promise<void>>();
  private readonly saved = new Map<string, Cursor>();
  private loading: Promise<void> | undefined;
  private readonly store: CursorStore | undefined;
  private readonly emitError: EmitError;
  private readonly storageError: ErrorFactory;
  constructor(store: CursorStore | undefined, emitError: EmitError, storageError: ErrorFactory) {
    this.store = store;
    this.emitError = emitError;
    this.storageError = storageError;
  }
  get pendingSaves(): number {
    return this.drains.size;
  }
  resetForEpoch(epoch: string): void {
    for (const [key, record] of this.records) {
      if (record.cursor.epoch === epoch) continue;
      this.records.delete(key);
      this.bySession.delete(key);
      this.saved.delete(key);
    }
  }
  remember(record: CursorRecord): void {
    let cursor: Cursor;
    try {
      cursor = decodeCursor(record.cursor);
    } catch {
      return;
    }
    const host = hostId(record.hostId);
    const session = sessionId(record.sessionId);
    const key = sessionKey(String(host), String(session));
    const normalized = { hostId: String(host), sessionId: String(session), cursor };
    // Map order is the journal's LRU order. Advancing an existing session must
    // protect it from the next bounded eviction just like adding a new one.
    this.records.delete(key);
    this.records.set(key, normalized);
    this.bySession.set(key, cursor);
    if (this.records.size > MAX_SAVED) {
      const oldest = this.records.keys().next().value;
      if (typeof oldest === "string") {
        this.records.delete(oldest);
        this.bySession.delete(oldest);
        this.saved.delete(oldest);
      }
    }
    if (this.store === undefined) return;
    const queue = this.queues.get(key) ?? { latest: undefined, running: false };
    queue.latest = normalized;
    this.queues.set(key, queue);
    if (!queue.running) this.drain(key, queue);
  }
  load(): Promise<void> {
    if (this.store === undefined) return Promise.resolve();
    if (this.loading !== undefined) return this.loading;
    let load!: Promise<void>;
    load = Promise.resolve()
      .then(() => this.store?.load() ?? [])
      .then((records) => {
        if (!Array.isArray(records)) throw new Error("invalid cursor store");
        for (const record of records.slice(0, MAX_SAVED)) {
          try {
            const host = hostId(record.hostId);
            const session = sessionId(record.sessionId);
            const cursor = decodeCursor(record.cursor);
            const key = sessionKey(String(host), String(session));
            this.records.set(key, { hostId: String(host), sessionId: String(session), cursor });
            this.bySession.set(key, cursor);
          } catch {
            continue;
          }
        }
      })
      .catch(() => this.emitError(this.storageError("cursor could not be loaded", true)))
      .finally(() => {
        if (this.loading === load) this.loading = undefined;
      });
    this.loading = load;
    return load;
  }
  waitForSaves(): Promise<void> {
    return Promise.all(this.drains).then(() => undefined);
  }
  private drain(key: string, queue: SaveQueue): void {
    queue.running = true;
    let drain!: Promise<void>;
    drain = (async () => {
      try {
        while (queue.latest !== undefined) {
          const record = queue.latest;
          queue.latest = undefined;
          const saved = this.saved.get(key);
          if (
            saved !== undefined &&
            saved.epoch === record.cursor.epoch &&
            saved.seq >= record.cursor.seq
          )
            continue;
          try {
            await Promise.resolve(this.store?.save(record));
            this.saved.set(key, record.cursor);
          } catch {
            this.emitError(this.storageError("cursor could not be saved", true));
          }
        }
      } finally {
        queue.running = false;
        this.drains.delete(drain);
        if (queue.latest === undefined) this.queues.delete(key);
        else this.drain(key, queue);
      }
    })();
    this.drains.add(drain);
  }
}
