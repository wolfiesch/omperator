import type { Cursor } from "./cursor.js";
import { fail } from "./errors.js";
import { controlFree } from "./guards.js";
import {
	type DeviceId,
	deviceId,
	type HostId,
	hostId,
	type LeaseId,
	leaseId,
	type Revision,
	revision,
	type SessionId,
	sessionId,
	type WatchId,
	watchId,
} from "./ids.js";
import { PROTOCOL_VERSION } from "./limits.js";
import { decodeSessionRef, type SessionRef } from "./session-index.js";
import { cur, frame, known, own } from "./additive-codec.js";

export interface HostWatchFrame {
	v: typeof PROTOCOL_VERSION;
	type: "host.watch";
	watchId: WatchId;
	hostId: HostId;
	cursor: Cursor;
	state: "started" | "stopped" | "ready";
	revision: Revision;
	[key: string]: unknown;
}
export interface SessionWatchFrame {
	v: typeof PROTOCOL_VERSION;
	type: "session.watch";
	watchId: WatchId;
	hostId: HostId;
	sessionId: SessionId;
	cursor: Cursor;
	state: "started" | "stopped" | "ready";
	revision: Revision;
	[key: string]: unknown;
}
export interface SessionStateFrame {
	v: typeof PROTOCOL_VERSION;
	type: "session.state";
	hostId: HostId;
	sessionId: SessionId;
	cursor: Cursor;
	revision: Revision;
	state: string;
	[key: string]: unknown;
}
export interface SessionDeltaFrame {
	v: typeof PROTOCOL_VERSION;
	type: "session.delta";
	hostId: HostId;
	sessionId: SessionId;
	cursor: Cursor;
	revision: Revision;
	upsert?: SessionRef;
	remove?: SessionId;
	[key: string]: unknown;
}
export type WatchFrame = HostWatchFrame | SessionWatchFrame | SessionStateFrame | SessionDeltaFrame;
export function decodeWatch(input: unknown): WatchFrame {
	const x = frame(input, ["host.watch", "session.watch", "session.state", "session.delta"]);
	const type = x.type as string;
	if (type === "host.watch")
		return {
			...x,
			type,
			watchId: watchId(x.watchId),
			hostId: hostId(x.hostId),
			cursor: cur(x.cursor),
			state: known(x.state, "state", ["started", "stopped", "ready"]) as HostWatchFrame["state"],
			revision: revision(x.revision),
		} as HostWatchFrame;
	const ids = own(x),
		cursor = cur(x.cursor),
		rev = revision(x.revision);
	if (type === "session.watch")
		return {
			...x,
			type,
			watchId: watchId(x.watchId),
			...ids,
			cursor,
			state: known(x.state, "state", ["started", "stopped", "ready"]) as SessionWatchFrame["state"],
			revision: rev,
		} as SessionWatchFrame;
	if (type === "session.state")
		return {
			...x,
			type,
			...ids,
			cursor,
			revision: rev,
			state: controlFree(x.state, "state", 128),
		} as SessionStateFrame;
	const result: Record<string, unknown> = { ...x, type, ...ids, cursor, revision: rev };
	if (x.upsert !== undefined) result.upsert = decodeSessionRef(x.upsert, "upsert");
	if (x.remove !== undefined) result.remove = sessionId(x.remove, "remove");
	if (result.upsert === undefined && result.remove === undefined)
		fail("INVALID_FRAME", "session delta requires upsert or remove", "delta");
	if (result.upsert !== undefined && result.remove !== undefined)
		fail("INVALID_FRAME", "session delta cannot upsert and remove", "delta");
	if (result.upsert !== undefined) {
		const upsert = result.upsert as SessionRef;
		if (upsert.hostId !== ids.hostId || upsert.sessionId !== ids.sessionId)
			fail("INVALID_FRAME", "upsert belongs to another session", "upsert");
	}
	if (result.remove !== undefined && result.remove !== ids.sessionId)
		fail("INVALID_FRAME", "remove belongs to another session", "remove");
	return result as unknown as SessionDeltaFrame;
}

export type LeaseKind = "controller" | "prompt";
export type LeaseState = "acquired" | "renewed" | "released" | "expired";
export interface LeaseFrame {
	v: typeof PROTOCOL_VERSION;
	type: "lease" | "prompt.lease";
	hostId: HostId;
	sessionId: SessionId;
	leaseId: LeaseId;
	cursor: Cursor;
	kind: LeaseKind;
	state: LeaseState;
	owner: DeviceId;
	expiresAt: string;
	revision?: Revision;
	[key: string]: unknown;
}
export interface PromptLeaseFrame extends LeaseFrame {
	type: "prompt.lease";
	kind: "prompt";
}
export function decodeLease(input: unknown): LeaseFrame | PromptLeaseFrame {
	const x = frame(input, ["lease", "prompt.lease"]);
	const type = x.type as "lease" | "prompt.lease",
		ids = own(x),
		expected = type === "lease" ? "controller" : "prompt";
	if (x.kind !== expected) fail("INVALID_FRAME", "lease kind does not match type", "kind");
	const result = {
		...x,
		type,
		...ids,
		leaseId: leaseId(x.leaseId),
		cursor: cur(x.cursor),
		kind: expected,
		state: known(x.state, "state", ["acquired", "renewed", "released", "expired"]) as LeaseState,
		owner: deviceId(x.owner),
		expiresAt: controlFree(x.expiresAt, "expiresAt", 128),
	} as LeaseFrame;
	if (x.revision !== undefined) result.revision = revision(x.revision);
	return type === "prompt.lease" ? (result as PromptLeaseFrame) : result;
}
