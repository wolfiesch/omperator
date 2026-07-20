import { createHash } from "node:crypto";
import {
	type ArtifactDescriptor,
	ATTENTION_MAX_PENDING_ITEMS,
	type AttentionOutcome,
	type DurableEntry,
	decodeArtifactDescriptorList,
	decodeTranscriptImageMetadataList,
	type EntryId,
	type HostId,
	type PendingAttentionItem,
	type ProviderTransportState,
	revision,
	type ServerFrame,
	type SessionControlState,
	type SessionEvent,
	type SessionRef,
	type SessionStateResult,
	type TranscriptImageMetadata,
} from "@t4-code/host-wire";
import { boundSnapshotEntries } from "./snapshot-limits.ts";
import type { Projection, SessionRecord } from "./types.ts";

const MAX_REPLAY_BYTES = 512 * 1024;
const MAX_REBASE_FRAMES = 128;
const encoder = new TextEncoder();

export interface PendingPromptProjection {
	entryId: string;
	text: string;
	attachmentCount: number;
	at: string;
}

function replayBytes(frames: readonly ServerFrame[]): number {
	return frames.reduce((bytes, frame) => bytes + encoder.encode(JSON.stringify(frame)).byteLength, 0);
}

function frameCursor(frame: ServerFrame): { epoch: string; seq: number } | undefined {
	if (frame.type === "gap") return { epoch: frame.to.epoch, seq: frame.to.seq };
	if (!("cursor" in frame) || !frame.cursor || typeof frame.cursor !== "object") return undefined;
	const cursor = frame.cursor;
	if (!("epoch" in cursor) || typeof cursor.epoch !== "string" || !("seq" in cursor) || typeof cursor.seq !== "number")
		return undefined;
	return { epoch: cursor.epoch, seq: cursor.seq };
}

function placeholderTitle(title: string): boolean {
	return title === "Session" || title === "Untitled" || title.trim() === "";
}

function settledRuntimeRef(current: SessionRef, status: SessionRef["status"]): SessionRef {
	const next: SessionRef = { ...current, status };
	delete next.pendingApproval;
	delete next.pendingUserInput;
	if (current.attention) {
		const attention = { ...current.attention, pending: [], pendingCount: 0, truncated: false };
		if (attention.latestOutcome) next.attention = attention;
		else delete next.attention;
	}
	if (current.liveState) {
		const liveState: Record<string, unknown> = {
			...current.liveState,
			isStreaming: false,
			isCompacting: false,
			queuedMessageCount: 0,
		};
		delete liveState.pendingPrompt;
		delete liveState.pendingPrompts;
		delete liveState.queuedMessages;
		delete liveState.pendingApproval;
		delete liveState.pendingUserInput;
		delete liveState.runtimeCrashed;
		next.liveState = liveState;
	}
	return next;
}

export class SessionProjection {
	readonly value: Projection;
	#byId = new Map<string, DurableEntry>();
	#ringSize: number;
	#revisionHash = createHash("sha256");
	#pendingAttention = new Map<string, PendingAttentionItem>();
	constructor(host: HostId, record: SessionRecord, epoch: string, ringSize = 256) {
		this.#ringSize = ringSize;
		for (const entry of record.entries) {
			const rebound = { ...entry, hostId: host, sessionId: record.sessionId };
			this.#byId.set(rebound.id, rebound);
		}
		const entries = [...this.#byId.values()];
		for (const entry of entries) this.#revisionHash.update(`${JSON.stringify(entry)}\n`);
		const currentRevision = revision(`r-${this.#revisionHash.copy().digest("hex").slice(0, 24)}`);
		this.value = {
			hostId: host,
			sessionId: record.sessionId,
			revision: currentRevision,
			cursor: { epoch, seq: 0 },
			entries,
			ref: {
				hostId: host,
				sessionId: record.sessionId,
				project: { projectId: record.projectId, ...(record.projectName ? { name: record.projectName } : {}) },
				revision: currentRevision,
				title: record.title,
				status: record.status,
				updatedAt: record.updatedAt,
				...(record.archivedAt ? { archivedAt: record.archivedAt } : {}),
				...(record.model ? { model: record.model } : {}),
				...(record.thinking ? { thinking: record.thinking } : {}),
				...(record.runtime ? { runtime: record.runtime } : {}),
			},
			indexCursor: { epoch, seq: 0 },
			ring: [],
		};
	}
	transcriptImage(entryId: EntryId, sha256: string): TranscriptImageMetadata | undefined {
		const entry = this.#byId.get(entryId);
		if (!entry || entry.data.images === undefined) return undefined;
		try {
			return decodeTranscriptImageMetadataList(entry.data.images, "entry.data.images").find(
				image => image.sha256 === sha256,
			);
		} catch {
			return undefined;
		}
	}
	artifact(artifactId: string): ArtifactDescriptor | undefined {
		for (const entry of this.#byId.values()) {
			if (entry.data.artifacts === undefined) continue;
			try {
				const artifact = decodeArtifactDescriptorList(entry.data.artifacts, "entry.data.artifacts").find(
					candidate => candidate.artifactId === artifactId,
				);
				if (artifact) return artifact;
			} catch {}
		}
		return undefined;
	}
	updateStatus(status: SessionRef["status"]): ServerFrame | undefined {
		const current = this.value.ref;
		if (status === "closed") this.#pendingAttention.clear();
		const next: SessionRef = status === "closed" ? settledRuntimeRef(current, status) : { ...current, status };
		if (status === "idle" && current.liveState?.isStreaming === true) {
			next.liveState = { ...current.liveState, isStreaming: false };
		} else if (status === "active" && current.liveState?.runtimeCrashed === true) {
			const liveState = { ...current.liveState };
			delete liveState.runtimeCrashed;
			next.liveState = liveState;
		}
		if (JSON.stringify(next) === JSON.stringify(current)) return undefined;
		return this.updateRef(next, `status:${status}`);
	}
	markRuntimeCrashed(outcome?: AttentionOutcome): ServerFrame | undefined {
		const current = this.value.ref;
		this.#pendingAttention.clear();
		const next = settledRuntimeRef(current, "closed");
		if (outcome) next.attention = { pending: [], pendingCount: 0, truncated: false, latestOutcome: outcome };
		next.liveState = { ...next.liveState, runtimeCrashed: true };
		if (JSON.stringify(next) === JSON.stringify(current)) return undefined;
		return this.updateRef(next, "runtime:crashed");
	}
	markRuntimeRestartable(): ServerFrame | undefined {
		const current = this.value.ref;
		if (current.liveState?.runtimeCrashed !== true) return undefined;
		const next: SessionRef = { ...current, status: "idle" };
		if (JSON.stringify(next) === JSON.stringify(current)) return undefined;
		return this.updateRef(next, "runtime:restartable");
	}
	updateTitle(title: string): ServerFrame | undefined {
		if (!title || this.value.ref.title === title) return undefined;
		return this.updateRef({ ...this.value.ref, title }, `title:${title}`);
	}
	reconcileRecord(record: SessionRecord): ServerFrame | undefined {
		const current = this.value.ref;
		const sameProject = current.project.projectId === record.projectId;
		const projectName =
			sameProject && !current.project.name && record.projectName ? record.projectName : current.project.name;
		const project =
			sameProject && projectName !== current.project.name
				? { projectId: current.project.projectId, ...(projectName ? { name: projectName } : {}) }
				: current.project;
		const title = placeholderTitle(current.title) && !placeholderTitle(record.title) ? record.title : current.title;
		const archivedAt = record.archivedAt;
		if (project === current.project && title === current.title && archivedAt === current.archivedAt) return undefined;
		const next = { ...current, project, title };
		if (archivedAt) next.archivedAt = archivedAt;
		else delete next.archivedAt;
		return this.updateRef(next, `record:${record.updatedAt}:${archivedAt ?? "restored"}`);
	}
	reconcileObserverRecord(record: SessionRecord): ServerFrame | undefined {
		const current = this.value.ref;
		const project =
			current.project.projectId === record.projectId && record.projectName !== current.project.name
				? { projectId: current.project.projectId, ...(record.projectName ? { name: record.projectName } : {}) }
				: current.project;
		const title =
			placeholderTitle(record.title) && !placeholderTitle(current.title)
				? current.title
				: record.title || current.title;
		const next: SessionRef = {
			...current,
			project,
			title,
			updatedAt: record.updatedAt > current.updatedAt ? record.updatedAt : current.updatedAt,
		};
		if (record.model !== undefined) next.model = record.model;
		if (record.thinking !== undefined) next.thinking = record.thinking;
		if (JSON.stringify(next) === JSON.stringify(current)) return undefined;
		return this.updateRef(next, `observer-record:${record.updatedAt}`);
	}
	updateArchivedAt(archivedAt?: string): ServerFrame | undefined {
		if (this.value.ref.archivedAt === archivedAt) return undefined;
		const next = { ...this.value.ref };
		if (archivedAt) next.archivedAt = archivedAt;
		else delete next.archivedAt;
		return this.updateRef(next, `archived:${archivedAt ?? "restored"}`);
	}
	indexUpsert(): ServerFrame {
		return {
			v: "omp-app/1",
			type: "session.delta",
			cursor: this.nextIndexCursor(),
			revision: this.value.revision,
			hostId: this.value.hostId,
			sessionId: this.value.sessionId,
			upsert: this.value.ref,
		};
	}
	remove(): ServerFrame {
		this.#revisionHash.update("deleted\n");
		const nextRevision = revision(`r-${this.#revisionHash.copy().digest("hex").slice(0, 24)}`);
		this.value.revision = nextRevision;
		return {
			v: "omp-app/1",
			type: "session.delta",
			cursor: this.nextIndexCursor(),
			revision: nextRevision,
			hostId: this.value.hostId,
			sessionId: this.value.sessionId,
			remove: this.value.sessionId,
		};
	}
	setSessionControl(control?: SessionControlState): ServerFrame | undefined {
		const current = this.value.ref;
		const liveState = { ...current.liveState };
		if (control) liveState.sessionControl = control;
		else delete liveState.sessionControl;
		const next: SessionRef = { ...current };
		if (Object.keys(liveState).length > 0) next.liveState = liveState;
		else delete next.liveState;
		if (JSON.stringify(next) === JSON.stringify(current)) return undefined;
		return this.updateRef(next, `session-control:${control?.mode ?? "clear"}`);
	}
	rebaseEntries(entries: readonly DurableEntry[]): ServerFrame[] {
		const current = this.value.entries;
		const prefix =
			entries.length >= current.length &&
			current.every((entry, index) => JSON.stringify(entry) === JSON.stringify(entries[index]));
		if (prefix) {
			const previous = { ...this.value.cursor };
			const frames: ServerFrame[] = [];
			let frameBytes = 0;
			let budgetExceeded = false;
			for (const entry of entries.slice(current.length)) {
				const frame = this.appendEntry(entry);
				if (!frame || budgetExceeded) continue;
				const bytes = encoder.encode(JSON.stringify(frame)).byteLength;
				if (frames.length >= MAX_REBASE_FRAMES || frameBytes + bytes > MAX_REPLAY_BYTES) {
					budgetExceeded = true;
					continue;
				}
				frames.push(frame);
				frameBytes += bytes;
			}
			if (!budgetExceeded) return frames;
			const gap: ServerFrame = {
				v: "omp-app/1",
				type: "gap",
				hostId: this.value.hostId,
				sessionId: this.value.sessionId,
				from: { epoch: previous.epoch, seq: previous.seq + 1 },
				to: this.value.cursor,
				reason: "rebase_budget_exceeded",
			};
			const snapshot = this.snapshot();
			this.value.ring.length = 0;
			this.appendFrame(gap);
			this.appendFrame(snapshot);
			return [gap, snapshot];
		}
		const previous = this.value.cursor;
		this.#byId.clear();
		this.#revisionHash = createHash("sha256");
		this.value.entries = [];
		for (const entry of entries) {
			this.#byId.set(entry.id, entry);
			this.value.entries.push(entry);
			this.#revisionHash.update(`${JSON.stringify(entry)}\n`);
		}
		this.value.revision = revision(`r-${this.#revisionHash.copy().digest("hex").slice(0, 24)}`);
		const last = entries.at(-1);
		this.value.ref = {
			...this.value.ref,
			revision: this.value.revision,
			...(last ? { updatedAt: last.timestamp } : {}),
		};
		const cursor = this.nextCursor();
		const gap: ServerFrame = {
			v: "omp-app/1",
			type: "gap",
			hostId: this.value.hostId,
			sessionId: this.value.sessionId,
			from: { epoch: previous.epoch, seq: previous.seq + 1 },
			to: cursor,
			reason: "projection_rebase",
		};
		const snapshot = this.snapshot();
		this.value.ring.length = 0;
		this.appendFrame(gap);
		this.appendFrame(snapshot);
		return [gap, snapshot];
	}

	appendEntry(entry: DurableEntry): ServerFrame | undefined {
		const previous = this.#byId.get(entry.id);
		if (previous)
			return JSON.stringify(previous) === JSON.stringify(entry)
				? undefined
				: this.appendEvent({ type: "entry_conflict", entryId: entry.id });
		this.#byId.set(entry.id, entry);
		this.value.entries.push(entry);
		this.#revisionHash.update(`${JSON.stringify(entry)}\n`);
		this.value.revision = revision(`r-${this.#revisionHash.copy().digest("hex").slice(0, 24)}`);
		this.value.ref = { ...this.value.ref, revision: this.value.revision, updatedAt: entry.timestamp };
		return this.appendFrame({
			v: "omp-app/1",
			type: "entry",
			cursor: this.nextCursor(),
			revision: this.value.revision,
			hostId: this.value.hostId,
			sessionId: this.value.sessionId,
			entry,
		});
	}
	updateState(
		state: SessionStateResult,
		statusOverride?: SessionRef["status"],
		recoverClosedStatus = false,
		providerTransport?: ProviderTransportState,
	): ServerFrame | undefined {
		const next: SessionRef = { ...this.value.ref };
		const liveState = { ...next.liveState };
		delete liveState.modelId;
		delete liveState.modelProvider;
		delete liveState.modelDisplayName;
		delete liveState.runtimeCrashed;
		delete liveState.thinkingEffective;
		delete liveState.thinkingResolved;
		delete liveState.thinkingLevels;
		delete liveState.thinkingSupported;
		delete liveState.thinkingOffFloored;
		delete liveState.fast;
		delete liveState.fastAvailable;
		delete liveState.fastActive;
		delete liveState.providerTransport;
		if (providerTransport) liveState.providerTransport = providerTransport;
		if (state.queuedMessages) liveState.queuedMessages = state.queuedMessages;
		else delete liveState.queuedMessages;
		if (state.sessionName !== undefined) next.title = state.sessionName;
		if (state.model !== undefined) {
			next.model = `${state.model.provider}/${state.model.id}`;
			liveState.modelId = state.model.id;
			liveState.modelProvider = state.model.provider;
			if (state.model.displayName) liveState.modelDisplayName = state.model.displayName;
		} else delete next.model;
		if (state.thinking !== undefined) next.thinking = state.thinking;
		else delete next.thinking;
		if (state.thinkingEffective !== undefined) liveState.thinkingEffective = state.thinkingEffective;
		if (state.thinkingResolved !== undefined) liveState.thinkingResolved = state.thinkingResolved;
		if (state.thinkingLevels !== undefined) liveState.thinkingLevels = state.thinkingLevels;
		if (state.thinkingSupported !== undefined) liveState.thinkingSupported = state.thinkingSupported;
		if (state.thinkingOffFloored !== undefined) liveState.thinkingOffFloored = state.thinkingOffFloored;
		if (state.fast !== undefined) liveState.fast = state.fast;
		if (state.fastAvailable !== undefined) liveState.fastAvailable = state.fastAvailable;
		if (state.fastActive !== undefined) liveState.fastActive = state.fastActive;
		if (state.contextUsage !== undefined) next.contextUsage = state.contextUsage;
		else delete next.contextUsage;
		if (next.status !== "closed" || recoverClosedStatus)
			next.status = statusOverride ?? (state.isStreaming ? "active" : "idle");
		next.liveState = {
			...liveState,
			isStreaming: state.isStreaming,
			isCompacting: state.isCompacting,
			isPaused: state.isPaused,
			messageCount: state.messageCount,
			queuedMessageCount: state.queuedMessageCount,
			steeringMode: state.steeringMode,
			followUpMode: state.followUpMode,
			interruptMode: state.interruptMode,
		};
		if (JSON.stringify(next) === JSON.stringify(this.value.ref)) return undefined;
		this.#revisionHash.update(`state:${JSON.stringify(next)}\n`);
		const nextRevision = revision(`r-${this.#revisionHash.copy().digest("hex").slice(0, 24)}`);
		next.revision = nextRevision;
		this.value.revision = nextRevision;
		this.value.ref = next;
		return {
			v: "omp-app/1",
			type: "session.delta",
			cursor: this.nextIndexCursor(),
			revision: nextRevision,
			hostId: this.value.hostId,
			sessionId: this.value.sessionId,
			upsert: next,
		};
	}
	updatePendingPrompts(pendingPrompts: readonly PendingPromptProjection[]): ServerFrame | undefined {
		const current = this.value.ref;
		const liveState = { ...current.liveState };
		delete liveState.pendingPrompt;
		if (pendingPrompts.length > 0) liveState.pendingPrompts = [...pendingPrompts];
		else delete liveState.pendingPrompts;
		const next: SessionRef = { ...current };
		if (Object.keys(liveState).length > 0) next.liveState = liveState;
		else delete next.liveState;
		if (JSON.stringify(next) === JSON.stringify(current)) return undefined;
		return this.updateRef(next, `pending-prompts:${pendingPrompts.map(pending => pending.entryId).join(",")}`);
	}
	setPendingAttention(item: PendingAttentionItem): ServerFrame | undefined {
		const previous = this.#pendingAttention.get(item.id);
		if (previous && JSON.stringify(previous) === JSON.stringify(item)) return undefined;
		this.#pendingAttention.set(item.id, item);
		return this.#updateAttentionRef(`attention:pending:${item.kind}:${item.id}`);
	}
	removePendingAttention(id: string): ServerFrame | undefined {
		if (!this.#pendingAttention.delete(id)) return undefined;
		return this.#updateAttentionRef(`attention:resolved:${id}`);
	}
	clearPendingAttention(): ServerFrame | undefined {
		if (this.#pendingAttention.size === 0) return undefined;
		this.#pendingAttention.clear();
		return this.#updateAttentionRef("attention:pending:clear");
	}
	setLatestOutcome(outcome: AttentionOutcome): ServerFrame | undefined {
		if (JSON.stringify(this.value.ref.attention?.latestOutcome) === JSON.stringify(outcome)) return undefined;
		return this.#updateAttentionRef(`attention:outcome:${outcome.id}`, outcome);
	}
	settleAttentionOutcome(outcome: AttentionOutcome): ServerFrame | undefined {
		const unchangedOutcome = JSON.stringify(this.value.ref.attention?.latestOutcome) === JSON.stringify(outcome);
		if (this.#pendingAttention.size === 0 && unchangedOutcome) return undefined;
		this.#pendingAttention.clear();
		return this.#updateAttentionRef(`attention:settled:${outcome.id}`, outcome);
	}
	#updateAttentionRef(marker: string, latestOutcome = this.value.ref.attention?.latestOutcome): ServerFrame {
		const current = this.value.ref;
		const allPending = [...this.#pendingAttention.values()].sort(
			(a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.id.localeCompare(b.id),
		);
		const pending = allPending.slice(0, ATTENTION_MAX_PENDING_ITEMS);
		const pendingCount = this.#pendingAttention.size;
		const next: SessionRef = { ...current };
		if (pendingCount > 0 || latestOutcome) {
			next.attention = {
				pending,
				pendingCount,
				truncated: pendingCount > pending.length,
				...(latestOutcome ? { latestOutcome } : {}),
			};
		} else delete next.attention;
		if (allPending.some(item => item.kind === "approval")) next.pendingApproval = true;
		else delete next.pendingApproval;
		if (allPending.some(item => item.kind === "question")) next.pendingUserInput = true;
		else delete next.pendingUserInput;
		return this.updateRef(next, marker);
	}
	addPendingPrompt(pending: PendingPromptProjection): ServerFrame | undefined {
		const current = this.pendingPrompts();
		if (current.some(candidate => candidate.entryId === pending.entryId)) return undefined;
		return this.updatePendingPrompts([...current, pending]);
	}
	clearPendingPrompt(entryId: string): ServerFrame | undefined {
		const current = this.pendingPrompts();
		const next = current.filter(pending => pending.entryId !== entryId);
		if (next.length === current.length) return undefined;
		return this.updatePendingPrompts(next);
	}
	private pendingPrompts(): PendingPromptProjection[] {
		const value = this.value.ref.liveState?.pendingPrompts;
		if (!Array.isArray(value)) return [];
		return value.filter((pending): pending is PendingPromptProjection => {
			if (!pending || typeof pending !== "object" || Array.isArray(pending)) return false;
			const candidate = pending as Record<string, unknown>;
			return (
				typeof candidate.entryId === "string" &&
				typeof candidate.text === "string" &&
				typeof candidate.attachmentCount === "number" &&
				typeof candidate.at === "string"
			);
		});
	}
	appendEvent(event: SessionEvent): ServerFrame {
		return this.appendFrame({
			v: "omp-app/1",
			type: "event",
			cursor: this.nextCursor(),
			hostId: this.value.hostId,
			sessionId: this.value.sessionId,
			event,
		});
	}
	private updateRef(next: SessionRef, marker: string): ServerFrame {
		this.#revisionHash.update(`${marker}:${JSON.stringify(next)}\n`);
		const nextRevision = revision(`r-${this.#revisionHash.copy().digest("hex").slice(0, 24)}`);
		next.revision = nextRevision;
		this.value.revision = nextRevision;
		this.value.ref = next;
		return {
			v: "omp-app/1",
			type: "session.delta",
			cursor: this.nextIndexCursor(),
			revision: nextRevision,
			hostId: this.value.hostId,
			sessionId: this.value.sessionId,
			upsert: next,
		};
	}
	snapshot(): ServerFrame {
		return {
			v: "omp-app/1",
			type: "snapshot",
			cursor: this.value.cursor,
			revision: this.value.revision,
			hostId: this.value.hostId,
			sessionId: this.value.sessionId,
			entries: boundSnapshotEntries(
				this.value.entries,
				this.value.hostId,
				this.value.sessionId,
				this.value.ref.updatedAt,
			),
		};
	}
	private nextCursor() {
		this.value.cursor = { epoch: this.value.cursor.epoch, seq: this.value.cursor.seq + 1 };
		return this.value.cursor;
	}
	private nextIndexCursor() {
		this.value.indexCursor = { epoch: this.value.indexCursor.epoch, seq: this.value.indexCursor.seq + 1 };
		return this.value.indexCursor;
	}
	private appendFrame(frame: ServerFrame): ServerFrame {
		this.value.ring.push(frame);
		if (this.value.ring.length > this.#ringSize) this.value.ring.shift();
		return frame;
	}
	replay(cursor: { epoch: string; seq: number }): ServerFrame[] {
		if (cursor.epoch !== this.value.cursor.epoch)
			return [
				{
					v: "omp-app/1",
					type: "gap",
					hostId: this.value.hostId,
					sessionId: this.value.sessionId,
					from: { epoch: this.value.cursor.epoch, seq: 0 },
					to: this.value.cursor,
					reason: "epoch_mismatch",
				},
				this.snapshot(),
			];
		const oldest = this.value.ring[0];
		const oldestSeq = oldest ? (frameCursor(oldest)?.seq ?? this.value.cursor.seq + 1) : this.value.cursor.seq + 1;
		if (cursor.seq < oldestSeq - 1)
			return [
				{
					v: "omp-app/1",
					type: "gap",
					hostId: this.value.hostId,
					sessionId: this.value.sessionId,
					from: { epoch: cursor.epoch, seq: cursor.seq + 1 },
					to: this.value.cursor,
					reason: "ring_evicted",
				},
				this.snapshot(),
			];
		const frames = this.value.ring.filter(frame => (frameCursor(frame)?.seq ?? 0) > cursor.seq);
		if (replayBytes(frames) <= MAX_REPLAY_BYTES) return frames;
		return [
			{
				v: "omp-app/1",
				type: "gap",
				hostId: this.value.hostId,
				sessionId: this.value.sessionId,
				from: { epoch: cursor.epoch, seq: cursor.seq + 1 },
				to: this.value.cursor,
				reason: "replay_budget_exceeded",
			},
			this.snapshot(),
		];
	}
}
