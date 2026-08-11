import { randomBytes } from "node:crypto";

/**
 * Appserver-local composer mutexes.
 *
 * The mobile/Swift composers serialize prompts through a per-session lease:
 * `prompt.lease.acquire` → `session.prompt` → `prompt.lease.release`. The
 * lease is connection-owned — the connection that acquired it is the only one
 * that may renew or release it — and expires after a TTL so a dropped client
 * cannot wedge a session. One lease per session per kind, so a second device
 * attempting to prompt the same session is told the session is busy.
 *
 * This is appserver core, independent of any remote/pairing model: it exists
 * so the composer works identically over the local gateway, the relay control
 * plane, or any future transport.
 */

export type LeaseKind = "prompt" | "controller";

export interface Lease {
	readonly leaseId: string;
	/** The appserver connection (AppWs.connectionId) that holds the lease. */
	readonly ownerConnectionId: string;
	readonly sessionId: string;
	readonly kind: LeaseKind;
	expiresAt: number;
}

const DEFAULT_TTL_MS = 30_000;
const MAX_TTL_MS = 300_000;

function leaseIdBytes(): string {
	return randomBytes(12)
		.toString("base64url")
		.replace(/=+$/u, "");
}

export class LeaseRegistry {
	private readonly leases = new Map<string, Lease>();
	private lastNow = Number.NEGATIVE_INFINITY;

	constructor(private readonly clock: () => number = () => Date.now()) {}

	private now(): number {
		const value = this.clock();
		if (!Number.isFinite(value)) throw new Error("clock invalid");
		this.lastNow = Math.max(this.lastNow, value);
		return this.lastNow;
	}

	private expire(now = this.now()): void {
		for (const [leaseId, lease] of this.leases) {
			if (lease.expiresAt <= now) this.leases.delete(leaseId);
		}
	}

	/** Per-session-per-kind single lease. Throws when the session is already held. */
	acquire(sessionId: string, kind: LeaseKind, ownerConnectionId: string, ttlMs = DEFAULT_TTL_MS): Lease {
		this.expire();
		if (
			sessionId === "" ||
			ownerConnectionId === "" ||
			ttlMs <= 0 ||
			ttlMs > MAX_TTL_MS ||
			[...this.leases.values()].some(lease => lease.sessionId === sessionId && lease.kind === kind)
		)
			throw new Error("lease held");
		const lease: Lease = {
			leaseId: leaseIdBytes(),
			ownerConnectionId,
			sessionId,
			kind,
			expiresAt: this.now() + ttlMs,
		};
		this.leases.set(lease.leaseId, lease);
		return lease;
	}

	/** Extends the holder's lease TTL. Throws when the lease is absent or not held by this connection. */
	renew(leaseId: string, ownerConnectionId: string, ttlMs = DEFAULT_TTL_MS): Lease {
		this.expire();
		const lease = this.leases.get(leaseId);
		if (!lease || lease.ownerConnectionId !== ownerConnectionId || ttlMs <= 0 || ttlMs > MAX_TTL_MS)
			throw new Error("lease verify failed");
		lease.expiresAt = this.now() + ttlMs;
		return lease;
	}

	/** Releases the lease. Throws when the lease is absent or not held by this connection. */
	release(leaseId: string, ownerConnectionId: string): void {
		this.expire();
		const lease = this.leases.get(leaseId);
		if (!lease || lease.ownerConnectionId !== ownerConnectionId) throw new Error("lease verify failed");
		this.leases.delete(leaseId);
	}

	/** Releases every lease a connection holds (disconnect cleanup). */
	releaseAllForConnection(ownerConnectionId: string): void {
		for (const [leaseId, lease] of this.leases) {
			if (lease.ownerConnectionId === ownerConnectionId) this.leases.delete(leaseId);
		}
	}

	/** Returns whether this connection currently holds the named lease. */
	verify(leaseId: string, ownerConnectionId: string): boolean {
		this.expire();
		const lease = this.leases.get(leaseId);
		return lease !== undefined && lease.ownerConnectionId === ownerConnectionId;
	}
}
