import type { SessionId } from "@t4-code/host-wire";

/**
 * Owns the concurrency fences shared by close, transfer, archive, restore, and
 * delete operations. The appserver coordinates the operations themselves;
 * this registry keeps their mutual-exclusion contract in one domain.
 */
export class SessionLifecycleRegistry {
	readonly mutations = new Set<SessionId>();
	readonly operations = new Map<SessionId, number>();
	readonly closed = new Set<SessionId>();

	beginOperation(sessionId: SessionId, acceptingWork: boolean): boolean {
		if (!acceptingWork || this.mutations.has(sessionId)) return false;
		this.operations.set(sessionId, (this.operations.get(sessionId) ?? 0) + 1);
		return true;
	}

	endOperation(sessionId: SessionId): void {
		const count = this.operations.get(sessionId) ?? 0;
		if (count <= 1) this.operations.delete(sessionId);
		else this.operations.set(sessionId, count - 1);
	}

	operationCount(): number {
		let count = 0;
		for (const current of this.operations.values()) count += current;
		return count;
	}

	clear(): void {
		this.mutations.clear();
		this.operations.clear();
		this.closed.clear();
	}
}
