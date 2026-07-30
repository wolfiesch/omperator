import type { Cursor } from "./cursor.js";
import { fail } from "./errors.js";
import { boundedArray, boundedMap, boundedMetadata, boundedSettings, boundedText, controlFree, isSecretLikeKey } from "./guards.js";
import { type CatalogId, catalogId, type HostId, hostId, type OperationId, operationId, type Revision, revision, type SessionId, sessionId } from "./ids.js";
import { PROTOCOL_VERSION } from "./limits.js";
import { cur, frame, known } from "./additive-codec.js";

export interface AuditEvent {
	eventId: OperationId;
	hostId: HostId;
	sessionId?: SessionId;
	action: string;
	actor: string;
	timestamp: string;
	detail?: Record<string, unknown>;
	[key: string]: unknown;
}
export interface AuditTailFrame {
	v: typeof PROTOCOL_VERSION;
	type: "audit.tail";
	hostId: HostId;
	cursor: Cursor;
	events: AuditEvent[];
	[key: string]: unknown;
}
export interface AuditEventFrame {
	v: typeof PROTOCOL_VERSION;
	type: "audit.event";
	hostId: HostId;
	event: AuditEvent;
	cursor: Cursor;
	[key: string]: unknown;
}
export function decodeAuditEvent(value: unknown, path: string): AuditEvent {
	const x = boundedMap(value, path),
		result = {
			...x,
			eventId: operationId(x.eventId),
			hostId: hostId(x.hostId),
			action: controlFree(x.action, `${path}.action`, 128),
			actor: controlFree(x.actor, `${path}.actor`, 256),
			timestamp: controlFree(x.timestamp, `${path}.timestamp`, 128),
		} as AuditEvent;
	if (x.sessionId !== undefined) result.sessionId = sessionId(x.sessionId);
	if (x.detail !== undefined) result.detail = boundedMetadata(x.detail, `${path}.detail`, isSecretLikeKey);
	return result;
}
export function decodeAuditAdditive(input: unknown): AuditTailFrame | AuditEventFrame {
	const x = frame(input, ["audit.tail", "audit.event"]),
		type = x.type as string;
	if (type === "audit.tail") {
		const host = hostId(x.hostId),
			events = boundedArray(x.events, "events").map((v, i) => decodeAuditEvent(v, `events[${i}]`));
		for (const event of events)
			if (event.hostId !== host) fail("INVALID_FRAME", "audit event belongs to another host", "events");
		return { ...x, type, hostId: host, cursor: cur(x.cursor), events } as AuditTailFrame;
	}
	const host = hostId(x.hostId),
		event = decodeAuditEvent(x.event, "event");
	if (event.hostId !== host) fail("INVALID_FRAME", "audit event belongs to another host", "event.hostId");
	return { ...x, type, hostId: host, event, cursor: cur(x.cursor) } as AuditEventFrame;
}

export const OPERATION_EXECUTIONS = ["typed", "headless", "terminal-only", "unavailable"] as const;
export type OperationExecution = (typeof OPERATION_EXECUTIONS)[number];

export const OPERATION_DISABLED_REASON_CODES = {
	terminalOnly: "terminal_only",
	capabilityUnavailable: "capability_unavailable",
} as const;

export interface OperationDisabledReason {
	code: string;
	message: string;
	[key: string]: unknown;
}

export interface OperationCapability {
	operationId: OperationId;
	label: string;
	description?: string;
	execution: OperationExecution;
	supported: boolean;
	disabledReason?: OperationDisabledReason;
	capabilities?: string[];
	[key: string]: unknown;
}

export type CatalogKind = "tool" | "model" | "command" | "setting" | "skill" | "agent" | "provider" | "mode";
export interface CatalogItem {
	id: CatalogId;
	kind: CatalogKind;
	name: string;
	description?: string;
	capabilities?: string[];
	supported?: boolean;
	reason?: string;
	metadata?: Record<string, unknown>;
	[key: string]: unknown;
}
export interface CatalogFrame {
	v: typeof PROTOCOL_VERSION;
	type: "catalog";
	hostId: HostId;
	revision: Revision;
	items: CatalogItem[];
	operations?: OperationCapability[];
	[key: string]: unknown;
}
export interface SettingsFrame {
	v: typeof PROTOCOL_VERSION;
	type: "settings";
	hostId: HostId;
	revision: Revision;
	settings: Record<string, unknown>;
	[key: string]: unknown;
}
function metadata(value: unknown, path: string): Record<string, unknown> {
	return boundedMetadata(value, path, isSecretLikeKey);
}
function decodeOperationDisabledReason(value: unknown, path: string): OperationDisabledReason {
	const x = boundedMap(value, path);
	return {
		...x,
		code: controlFree(x.code, `${path}.code`, 128),
		message: boundedText(x.message, `${path}.message`, 2048),
	};
}

export function decodeOperationCapability(value: unknown, path: string): OperationCapability {
	const x = boundedMap(value, path);
	const execution = known(x.execution, `${path}.execution`, OPERATION_EXECUTIONS) as OperationExecution;
	if (typeof x.supported !== "boolean")
		fail("INVALID_FRAME", "supported must be boolean", `${path}.supported`);
	const disabledReason =
		x.disabledReason === undefined
			? undefined
			: decodeOperationDisabledReason(x.disabledReason, `${path}.disabledReason`);
	if (!x.supported && !disabledReason)
		fail("INVALID_FRAME", "unsupported operation requires disabledReason", `${path}.disabledReason`);
	if (x.supported && disabledReason)
		fail("INVALID_FRAME", "supported operation cannot have disabledReason", `${path}.disabledReason`);
	if ((execution === "terminal-only" || execution === "unavailable") && x.supported)
		fail("INVALID_FRAME", `${execution} operation cannot be supported`, `${path}.supported`);
	const result: OperationCapability = {
		...x,
		operationId: operationId(x.operationId, `${path}.operationId`),
		label: controlFree(x.label, `${path}.label`, 256),
		execution,
		supported: x.supported,
	};
	if (x.description !== undefined)
		result.description = boundedText(x.description, `${path}.description`, 4096);
	if (disabledReason) result.disabledReason = disabledReason;
	if (x.capabilities !== undefined)
		result.capabilities = boundedArray(x.capabilities, `${path}.capabilities`, 128).map((v, i) =>
			controlFree(v, `${path}.capabilities[${i}]`, 128),
		);
	return result;
}

export function decodeCatalogItem(value: unknown, path: string): CatalogItem {
	const x = boundedMap(value, path),
		result = {
			...x,
			id: catalogId(x.id),
			kind: known(x.kind, `${path}.kind`, [
				"tool",
				"model",
				"command",
				"setting",
				"skill",
				"agent",
				"provider",
				"mode",
			]) as CatalogKind,
			name: controlFree(x.name, `${path}.name`, 256),
		} as CatalogItem;
	if (x.description !== undefined) result.description = boundedText(x.description, `${path}.description`, 4096);
	if (x.capabilities !== undefined)
		result.capabilities = boundedArray(x.capabilities, `${path}.capabilities`, 128).map((v, i) =>
			controlFree(v, `${path}.capabilities[${i}]`, 128),
		);
	if (x.supported !== undefined) {
		if (typeof x.supported !== "boolean") fail("INVALID_FRAME", "supported must be boolean", `${path}.supported`);
		result.supported = x.supported;
	}
	if (x.reason !== undefined) result.reason = boundedText(x.reason, `${path}.reason`, 2048);
	if (x.metadata !== undefined) result.metadata = metadata(x.metadata, `${path}.metadata`);
	return result;
}
export function decodeCatalog(input: unknown): CatalogFrame | SettingsFrame {
	const x = frame(input, ["catalog", "settings"]),
		type = x.type as string,
		host = hostId(x.hostId),
		rev = revision(x.revision);
	if (type === "catalog") {
		const result = {
			...x,
			type,
			hostId: host,
			revision: rev,
			items: boundedArray(x.items, "items").map((v, i) => decodeCatalogItem(v, `items[${i}]`)),
		} as CatalogFrame;
		if (x.operations !== undefined)
			result.operations = boundedArray(x.operations, "operations").map((v, i) =>
				decodeOperationCapability(v, `operations[${i}]`),
			);
		return result;
	}
	return {
		...x,
		type,
		hostId: host,
		revision: rev,
		settings: boundedSettings(x.settings, "settings"),
	} as SettingsFrame;
}
