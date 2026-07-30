import { decodeAuditEvent, decodeCatalogItem, decodeFileListEntry, decodeOperationCapability } from "../additive.js";
import { decodeCursor } from "../cursor.js";
import { fail } from "../errors.js";
import { boundedArray, boundedMap, boundedMetadata, boundedSettings, boundedText, controlFree, isSecretLikeKey } from "../guards.js";
import { leaseId, revision, terminalId } from "../ids.js";
import { MAX_STRING_BYTES } from "../limits.js";
import { decodeSessionListResult, decodeSessionRef, type SessionListResult } from "../session-index.js";
import { decodeSessionStateResult } from "../session-state.js";
import type { CommandArguments, CommandResult } from "./types.js";

export function args(value: unknown, path = "args"): Record<string, unknown> {
	return boundedMap(value, path);
}
export function result(value: unknown): Record<string, unknown> {
	return boundedMap(value, "result");
}
export function strictArgs(value: unknown, allowed: readonly string[]): Record<string, unknown> {
	const out = args(value);
	const expected = new Set(allowed);
	for (const key of Object.keys(out))
		if (!expected.has(key)) fail("INVALID_FRAME", "unknown command argument", `args.${key}`);
	return out;
}
export function strictMap(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
	const out = boundedMap(value, path);
	const expected = new Set(allowed);
	for (const key of Object.keys(out))
		if (!expected.has(key)) fail("INVALID_FRAME", "unknown object field", `${path}.${key}`);
	return out;
}
export function strictResult(value: unknown, allowed: readonly string[]): Record<string, unknown> {
	return strictMap(value, "result", allowed);
}
export function leasedArgs(value: unknown, allowed: readonly string[]): Record<string, unknown> {
	const x = strictArgs(value, [...allowed, "leaseId"]);
	if (x.leaseId !== undefined) leaseId(x.leaseId, "args.leaseId");
	return x;
}
export function noArgs(value: unknown): CommandArguments {
	return strictArgs(value, []);
}
export function decodeMessage(value: unknown): CommandArguments {
	const x = leasedArgs(value, ["message"]);
	boundedText(x.message, "args.message", MAX_STRING_BYTES);
	return x;
}
export function decodeSessionUiResponse(value: unknown): CommandArguments {
	const x = args(value);
	const keys = Object.keys(x);
	if (
		!Object.hasOwn(x, "requestId") ||
		(keys.length !== 2 && keys.length !== 3) ||
		(keys.length === 3 && !Object.hasOwn(x, "leaseId"))
	)
		fail("INVALID_FRAME", "ui response requires requestId and exactly one payload", "args");
	if (x.leaseId !== undefined) leaseId(x.leaseId, "args.leaseId");
	controlFree(x.requestId, "args.requestId", 256);
	const payload = keys.filter(key => key !== "requestId" && key !== "leaseId");
	const key = payload[0];
	if (key === "value") boundedText(x.value, "args.value", MAX_STRING_BYTES);
	else if (key === "confirmed") {
		if (typeof x.confirmed !== "boolean") fail("INVALID_FRAME", "confirmed must be boolean", "args.confirmed");
	} else if (key === "cancelled") {
		if (x.cancelled !== true) fail("INVALID_FRAME", "cancelled must be true", "args.cancelled");
	} else fail("INVALID_FRAME", "unknown ui response payload", `args.${key}`);
	return x;
}
export function metadata(value: unknown, path: string): Record<string, unknown> {
	return boundedMetadata(value, path, isSecretLikeKey);
}
export function decodeSessions(value: unknown): CommandResult {
	const result: SessionListResult = decodeSessionListResult(value);
	return result as unknown as CommandResult;
}
export function decodeCreate(value: unknown): CommandResult {
	const x = result(value);
	return { ...x, session: decodeSessionRef(x.session, "result.session") };
}
export function decodeAttach(value: unknown): CommandResult {
	const x = result(value);
	if (typeof x.attached !== "boolean") fail("INVALID_FRAME", "attached must be boolean", "result.attached");
	return { ...x, attached: x.attached, cursor: decodeCursor(x.cursor, "result.cursor") };
}
export function boolField(value: unknown, key: string): CommandResult {
	const x = result(value);
	if (typeof x[key] !== "boolean") fail("INVALID_FRAME", `${key} must be boolean`, `result.${key}`);
	return { ...x, [key]: x[key] };
}
export function decodeEntries(value: unknown): CommandResult {
	const x = result(value),
		values = boundedArray(x.entries, "result.entries").map((value, i) =>
			decodeFileListEntry(value, `result.entries[${i}]`),
		);
	return { ...x, entries: values };
}
export function decodeAuditResult(value: unknown): CommandResult {
	const x = result(value),
		events = boundedArray(x.events, "result.events").map((event, i) =>
			decodeAuditEvent(event, `result.events[${i}]`),
		);
	return { ...x, events };
}
export function decodeCatalogResult(value: unknown): CommandResult {
	const x = result(value);
	const decoded: CommandResult = {
		...x,
		revision: revision(x.revision, "result.revision"),
		items: boundedArray(x.items, "result.items").map((item, i) => decodeCatalogItem(item, `result.items[${i}]`)),
	};
	if (x.operations !== undefined)
		decoded.operations = boundedArray(x.operations, "result.operations").map((item, i) =>
			decodeOperationCapability(item, `result.operations[${i}]`),
		);
	return decoded;
}
export function decodeTerminalResult(value: unknown): CommandResult {
	const x = result(value);
	terminalId(x.terminalId, "result.terminalId");
	return x;
}
export function decodeLeaseResult(value: unknown): CommandResult {
	const x = result(value);
	leaseId(x.leaseId, "result.leaseId");
	if (x.cursor !== undefined) decodeCursor(x.cursor, "result.cursor");
	return x;
}
export function decodeWatchResult(value: unknown): CommandResult {
	const x = result(value);
	controlFree(x.watchId, "result.watchId", 256);
	decodeCursor(x.cursor, "result.cursor");
	return x;
}
export function decodeSettingsResult(value: unknown): CommandResult {
	const x = result(value);
	revision(x.revision, "result.revision");
	return { ...x, settings: boundedSettings(x.settings, "result.settings") };
}
export function decodeBooleanResult(value: unknown, key: string): CommandResult {
	const x = result(value);
	const keys = Object.keys(x);
	if (keys.length !== 1 || keys[0] !== key || typeof x[key] !== "boolean")
		fail("INVALID_FRAME", "invalid command result", `result.${key}`);
	return { [key]: x[key] };
}
export function decodeAcceptedResult(value: unknown): CommandResult {
	return decodeBooleanResult(value, "accepted");
}
export function decodeSessionState(value: unknown): CommandResult {
	return decodeSessionStateResult(value) as unknown as CommandResult;
}
export function decodePauseResult(value: unknown): CommandResult {
	const x = result(value);
	if (Object.keys(x).length !== 2 || typeof x.paused !== "boolean" || typeof x.changed !== "boolean")
		fail("INVALID_FRAME", "invalid pause result", "result");
	return { paused: x.paused, changed: x.changed };
}
