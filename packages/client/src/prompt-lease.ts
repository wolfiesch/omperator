import { hostId, revision, sessionId } from "@t4-code/protocol";
import type { CommandRequest, CommandResult } from "@t4-code/protocol/desktop-ipc";
import { DesktopRuntimeError, asRecord, freezeClone } from "./desktop-runtime-contracts.ts";
import { boundedText, commandFailure, leasePayload } from "./desktop-runtime-policy.ts";

const DEFAULT_OWNER_ID = "t4-code-client";
const DEFAULT_FALLBACK_TTL_MS = 20_000;
const MAX_CACHE_TTL_MS = 20_000;
const EXPIRY_SAFETY_MS = 1_000;
const UNCERTAIN_ACQUIRE_CODES = new Set(["aborted", "outcome_unknown", "timeout"]);

interface PromptLeaseCommandRequest {
  readonly targetId: string;
  readonly hostId: string;
  readonly sessionId: string;
  readonly expectedRevision: string;
  readonly command: "prompt.lease.acquire" | "prompt.lease.release";
  readonly args: Readonly<Record<string, unknown>>;
}

export interface PromptLeaseStoreOptions {
  readonly issue: (request: CommandRequest) => Promise<unknown>;
  readonly clock: { now(): number };
  readonly ownerId?: string;
  readonly fallbackTtlMs?: number;
  readonly invalidateTarget?: (targetId: string) => Promise<void> | void;
}

interface PromptLease {
  readonly targetId: string;
  readonly hostId: string;
  readonly sessionId: string;
  readonly expectedRevision: string;
  readonly generation: number;
  readonly leaseId: string;
  readonly expiresAt: number;
}

interface PromptLeaseEntry {
  readonly key: string;
  readonly expectedRevision: string;
  readonly lease?: PromptLease;
  readonly pending?: Promise<PromptLease>;
}

function sessionKey(targetId: string, hostId: string, sessionId: string, generation: number): string {
  return `${targetId}\u0000${hostId}\u0000${sessionId}\u0000${generation}`;
}

export class PromptLeaseStore {
  private readonly entries = new Map<string, PromptLeaseEntry>();
  private readonly issue: PromptLeaseStoreOptions["issue"];
  private readonly clock: PromptLeaseStoreOptions["clock"];
  private readonly invalidateTargetOnUncertainAcquire: PromptLeaseStoreOptions["invalidateTarget"];
  private readonly ownerId: string;
  private readonly fallbackTtlMs: number;

  constructor(options: PromptLeaseStoreOptions) {
    this.issue = options.issue;
    this.clock = options.clock;
    this.invalidateTargetOnUncertainAcquire = options.invalidateTarget;
    this.ownerId = options.ownerId ?? DEFAULT_OWNER_ID;
    this.fallbackTtlMs = Math.max(1_000, Math.min(options.fallbackTtlMs ?? DEFAULT_FALLBACK_TTL_MS, MAX_CACHE_TTL_MS));
  }

  async command(
    targetId: string,
    intent: CommandRequest["intent"],
    generation: number,
    featureEnabled: boolean,
    dispatch: (targetId: string, intent: CommandRequest["intent"]) => Promise<CommandResult>,
    leaseRevision?: string,
  ): Promise<CommandResult> {
    const revisionValue = intent.expectedRevision ?? leaseRevision;
    if (intent.sessionId === undefined || revisionValue === undefined || !featureEnabled) return dispatch(targetId, intent);
    const leaseId = await this.acquire(targetId, String(intent.hostId), String(intent.sessionId), String(revisionValue), generation);
    return dispatch(targetId, { ...intent, args: { ...intent.args, leaseId } });
  }

  async acquire(targetId: string, hostId: string, sessionId: string, expectedRevision: string, generation: number): Promise<string> {
    const key = sessionKey(targetId, hostId, sessionId, generation);
    const existing = this.entries.get(key);
    if (existing?.pending !== undefined) {
      if (existing.expectedRevision === expectedRevision) return (await existing.pending).leaseId;
      try { await existing.pending; } catch { /* a failed acquisition removes itself */ }
      return this.acquire(targetId, hostId, sessionId, expectedRevision, generation);
    }
    const now = this.clock.now();
    if (existing?.lease !== undefined && existing.expectedRevision === expectedRevision && existing.lease.expiresAt > now + EXPIRY_SAFETY_MS) return existing.lease.leaseId;
    const pending = this.rotate(existing?.lease, { targetId, hostId, sessionId, expectedRevision, generation });
    this.entries.set(key, { key, expectedRevision, pending });
    void pending.then((lease) => {
      if (this.entries.get(key)?.pending === pending) this.entries.set(key, { key, expectedRevision, lease });
    }, () => {
      if (this.entries.get(key)?.pending === pending) this.entries.delete(key);
    });
    return (await pending).leaseId;
  }

  invalidateTarget(targetId: string): void {
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(`${targetId}\u0000`)) continue;
      this.entries.delete(key);
      void this.releaseEntry(entry);
    }
  }

  async close(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => this.releaseEntry(entry)));
  }

  private async rotate(previous: PromptLease | undefined, next: Omit<PromptLease, "leaseId" | "expiresAt">): Promise<PromptLease> {
    if (previous !== undefined && previous.expiresAt > this.clock.now()) await this.release(previous);
    try {
      const raw = await this.send({
        targetId: next.targetId,
        hostId: next.hostId,
        sessionId: next.sessionId,
        expectedRevision: next.expectedRevision,
        command: "prompt.lease.acquire",
        args: { ownerId: this.ownerId },
      });
      const payload = leasePayload(raw);
      if (payload?.accepted === false) throw new DesktopRuntimeError("stale", "prompt lease acquisition was rejected");
      const leaseId = boundedText(payload?.leaseId);
      if (leaseId === undefined) throw new DesktopRuntimeError("protocol", "prompt lease acquisition did not return a bounded lease id");
      return { ...next, leaseId, expiresAt: this.expiry(payload) };
    } catch (error) {
      if (UNCERTAIN_ACQUIRE_CODES.has(String(asRecord(error)?.code))) {
        try { await this.invalidateTargetOnUncertainAcquire?.(next.targetId); } catch { /* preserve the original uncertain outcome */ }
      }
      if (error instanceof DesktopRuntimeError) throw error;
      throw commandFailure(error, "prompt lease acquisition failed");
    }
  }

  private expiry(payload: Record<string, unknown> | undefined): number {
    const now = this.clock.now();
    const value = payload?.expiresAt;
    if (value === undefined) return now + this.fallbackTtlMs;
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
    if (!Number.isFinite(parsed)) throw new DesktopRuntimeError("protocol", "prompt lease expiry is invalid");
    if (parsed <= now || parsed - now > MAX_CACHE_TTL_MS) return now + this.fallbackTtlMs;
    return Math.min(parsed, now + this.fallbackTtlMs);
  }

  private async release(lease: PromptLease): Promise<void> {
    try {
      const raw = await this.send({
        targetId: lease.targetId,
        hostId: lease.hostId,
        sessionId: lease.sessionId,
        expectedRevision: lease.expectedRevision,
        command: "prompt.lease.release",
        args: { leaseId: lease.leaseId },
      });
      if (leasePayload(raw)?.accepted === false) throw new DesktopRuntimeError("stale", "prompt lease release was rejected");
    } catch (error) {
      if (error instanceof DesktopRuntimeError) throw error;
      throw commandFailure(error, "prompt lease release failed");
    }
  }

  private send(request: PromptLeaseCommandRequest): Promise<unknown> {
    return this.issue(freezeClone({
      targetId: request.targetId,
      intent: {
        hostId: hostId(request.hostId),
        sessionId: sessionId(request.sessionId),
        command: request.command,
        expectedRevision: revision(request.expectedRevision),
        args: request.args,
      },
    }));
  }

  private async releaseEntry(entry: PromptLeaseEntry): Promise<void> {
    if (entry.lease !== undefined) {
      if (entry.lease.expiresAt > this.clock.now()) await this.releaseBestEffort(entry.lease);
      return;
    }
    if (entry.pending === undefined) return;
    try {
      const lease = await entry.pending;
      if (lease.expiresAt > this.clock.now()) await this.releaseBestEffort(lease);
    } catch {
      /* failed acquisitions do not hold a lease */
    }
  }

  private async releaseBestEffort(lease: PromptLease): Promise<void> {
    try { await this.release(lease); } catch { /* teardown and disconnect cleanup are best effort */ }
  }
}
